/**
 * Cloudflare Workers - OpenAI 格式多厂商 AI 代理
 * 完全兼容 OpenAI API 格式，支持多个 AI 厂商透明转发
 */

export default {
  async fetch(request, env) {
    // CORS 预检请求
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 鉴权检查
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: { message: 'Missing or invalid Authorization header', type: 'invalid_request_error' } }, 401);
    }

    const token = authHeader.substring(7);
    if (token !== env.API_KEY) {
      return jsonResponse({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }, 401);
    }

    // 路由处理
    if (path === '/v1/models' && request.method === 'GET') {
      return handleModels(env);
    }

    if (path === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletions(request, env);
    }

    if (path === '/v1/embeddings' && request.method === 'POST') {
      return handleEmbeddings(request, env);
    }

    return jsonResponse({ error: { message: 'Not found', type: 'invalid_request_error' } }, 404);
  }
};

/**
 * 解析 PROVIDERS 配置，构建模型映射表
 */
function parseProviders(env) {
  try {
    const providers = JSON.parse(env.PROVIDERS || '{}');
    const modelMap = {};

    for (const [providerName, providerConfig] of Object.entries(providers)) {
      const { baseURL, apiKey, models } = providerConfig;

      if (!baseURL || !apiKey || !models || !Array.isArray(models)) {
        continue;
      }

      // 支持多账号配置
      const accounts = Array.isArray(apiKey) ? apiKey : [apiKey];
      const baseURLs = Array.isArray(baseURL) ? baseURL : [baseURL];

      // 为每个模型创建映射
      for (const model of models) {
        if (!modelMap[model]) {
          modelMap[model] = [];
        }

        // 为每个账号创建配置
        for (let i = 0; i < Math.max(accounts.length, baseURLs.length); i++) {
          const account = accounts[i % accounts.length];
          const url = baseURLs[i % baseURLs.length];

          // 解析 apiKey，支持环境变量引用
          let resolvedApiKey = account;
          if (account && account.match(/^[A-Z_]+$/)) {
            resolvedApiKey = env[account] || account;
          }

          modelMap[model].push({
            baseURL: url,
            apiKey: resolvedApiKey,
            provider: providerName
          });
        }
      }
    }

    return modelMap;
  } catch (error) {
    return {};
  }
}

/**
 * 处理 /v1/models 接口
 */
function handleModels(env) {
  try {
    const modelMap = parseProviders(env);
    const modelList = Object.keys(modelMap).map(id => {
      const configs = modelMap[id];
      const accountCount = configs.length;
      const provider = configs[0]?.provider || 'system';

      return {
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: accountCount > 1 ? `${provider} (${accountCount} accounts)` : provider
      };
    });

    return jsonResponse({
      object: 'list',
      data: modelList
    });
  } catch (error) {
    return jsonResponse({ error: { message: 'Failed to parse PROVIDERS configuration', type: 'server_error' } }, 500);
  }
}

/**
 * 处理 /v1/chat/completions 接口
 */
async function handleChatCompletions(request, env) {
  try {
    const body = await request.json();
    const model = body.model;

    if (!model) {
      return jsonResponse({ error: { message: 'Missing required parameter: model', type: 'invalid_request_error' } }, 400);
    }

    const config = getModelConfig(model, env);
    if (!config) {
      return jsonResponse({ error: { message: `Model '${model}' not found in configuration`, type: 'invalid_request_error' } }, 404);
    }

    // 转发请求到上游
    const upstreamURL = `${config.baseURL}/chat/completions`;
    const upstreamResponse = await fetch(upstreamURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body)
    });

    // 处理流式响应
    if (body.stream) {
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

    // 非流式响应
    const data = await upstreamResponse.json();
    return jsonResponse(data, upstreamResponse.status);

  } catch (error) {
    return jsonResponse({ error: { message: error.message, type: 'server_error' } }, 500);
  }
}

/**
 * 处理 /v1/embeddings 接口
 */
async function handleEmbeddings(request, env) {
  try {
    const body = await request.json();
    const model = body.model;

    if (!model) {
      return jsonResponse({ error: { message: 'Missing required parameter: model', type: 'invalid_request_error' } }, 400);
    }

    const config = getModelConfig(model, env);
    if (!config) {
      return jsonResponse({ error: { message: `Model '${model}' not found in configuration`, type: 'invalid_request_error' } }, 404);
    }

    // 转发请求到上游
    const upstreamURL = `${config.baseURL}/embeddings`;
    const upstreamResponse = await fetch(upstreamURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body)
    });

    const data = await upstreamResponse.json();
    return jsonResponse(data, upstreamResponse.status);

  } catch (error) {
    return jsonResponse({ error: { message: error.message, type: 'server_error' } }, 500);
  }
}

/**
 * 获取模型配置（支持负载均衡）
 */
function getModelConfig(model, env) {
  const modelMap = parseProviders(env);
  const configs = modelMap[model];

  if (!configs || configs.length === 0) {
    return null;
  }

  // 如果有多个配置，使用基于时间的轮询（每秒切换）
  // 确保一分钟内均匀分配到各个账号
  const index = Math.floor(Date.now() / 1000) % configs.length;
  return configs[index];
}

/**
 * 返回 JSON 响应
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    }
  });
}

/**
 * 处理 CORS 预检请求
 */
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    }
  });
}
