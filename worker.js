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

    // Anthropic Claude → OpenAI 反向代理
    if (path === '/v1/messages' && request.method === 'POST') {
      return handleAnthropicMessages(request, env);
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

// ============================================================
// Anthropic Claude ↔ OpenAI 协议转换层
// ============================================================

/**
 * 入口：处理 POST /v1/messages (Anthropic 格式)
 */
async function handleAnthropicMessages(request, env) {
  try {
    const anthropicBody = await request.json();
    const model = anthropicBody.model;

    if (!model) {
      return anthropicError('Missing required parameter: model', 'invalid_request_error', 400);
    }

    const config = getModelConfig(model, env);
    if (!config) {
      return anthropicError(`Model '${model}' not found in configuration`, 'invalid_request_error', 404);
    }

    // 转换请求体
    const openaiBody = anthropicToOpenAI(anthropicBody);
    const isStream = anthropicBody.stream === true;

    const upstreamURL = `${config.baseURL}/chat/completions`;
    const upstreamResponse = await fetch(upstreamURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(openaiBody)
    });

    if (!upstreamResponse.ok && !isStream) {
      const errText = await upstreamResponse.text();
      return anthropicError(`Upstream error: ${errText}`, 'api_error', upstreamResponse.status);
    }

    if (isStream) {
      // 将 OpenAI SSE 流转换为 Anthropic SSE 流
      const { readable, writable } = new TransformStream();
      streamOpenAIToAnthropic(upstreamResponse.body, writable, anthropicBody);
      return new Response(readable, {
        status: 200,
        headers: anthropicStreamHeaders()
      });
    }

    // 非流式：转换响应
    const openaiData = await upstreamResponse.json();
    const anthropicData = openAIToAnthropic(openaiData, anthropicBody.model);
    return new Response(JSON.stringify(anthropicData), {
      status: 200,
      headers: anthropicJsonHeaders()
    });

  } catch (error) {
    return anthropicError(error.message, 'server_error', 500);
  }
}

/**
 * 将 Anthropic 请求体转换为 OpenAI 格式
 */
function anthropicToOpenAI(body) {
  const messages = [];

  // system prompt → 首条 system 消息
  if (body.system) {
    const systemText = Array.isArray(body.system)
      ? body.system.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : body.system;
    messages.push({ role: 'system', content: systemText });
  }

  // 转换消息列表，展开 tool_result 数组，并合并连续 user 文本消息
  const rawMessages = (body.messages || []).flatMap(convertAnthropicMessage);
  for (const msg of rawMessages) {
    const last = messages[messages.length - 1];
    // 只合并连续的纯文本 user 消息
    if (last && last.role === 'user' && msg.role === 'user'
        && typeof last.content === 'string' && typeof msg.content === 'string') {
      last.content += '\n' + msg.content;
    } else {
      messages.push(msg);
    }
  }

  const openaiBody = {
    model: body.model,
    messages,
    stream: body.stream || false
  };

  if (body.max_tokens) openaiBody.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) openaiBody.temperature = body.temperature;
  if (body.top_p !== undefined) openaiBody.top_p = body.top_p;
  if (body.stop_sequences) openaiBody.stop = body.stop_sequences;

  // 工具定义转换
  if (body.tools && body.tools.length > 0) {
    openaiBody.tools = body.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} }
      }
    }));
  }

  // tool_choice 映射
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') openaiBody.tool_choice = 'auto';
    else if (body.tool_choice.type === 'any') openaiBody.tool_choice = 'required';
    else if (body.tool_choice.type === 'tool') {
      openaiBody.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    }
  }

  return openaiBody;
}

/**
 * 转换单条 Anthropic 消息为 OpenAI 格式
 */
function convertAnthropicMessage(msg) {
  const { role, content } = msg;

  // content 是字符串，直接用
  if (typeof content === 'string') {
    return { role, content };
  }

  // content 是块数组
  if (Array.isArray(content)) {
    // assistant 消息：可能含 text + tool_use
    if (role === 'assistant') {
      const textBlocks = content.filter(b => b.type === 'text');
      const toolBlocks = content.filter(b => b.type === 'tool_use');

      const result = { role: 'assistant', content: null };

      if (textBlocks.length > 0) {
        result.content = textBlocks.map(b => b.text).join('');
      }

      if (toolBlocks.length > 0) {
        result.tool_calls = toolBlocks.map(b => ({
          id: b.id,
          type: 'function',
          function: {
            name: b.name,
            arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input)
          }
        }));
      }

      return result;
    }

    // user 消息：可能含 text + tool_result
    if (role === 'user') {
      const toolResults = content.filter(b => b.type === 'tool_result');
      const textBlocks = content.filter(b => b.type === 'text');

      // 如果有 tool_result，每个都变成独立的 tool 角色消息
      // 但 OpenAI 要求 tool 消息紧跟 assistant，这里返回数组标记
      if (toolResults.length > 0) {
        // 将 tool_result 转为 OpenAI tool 消息列表
        // 用特殊标记让调用方展开
        return toolResults.map(tr => ({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: Array.isArray(tr.content)
            ? tr.content.filter(b => b.type === 'text').map(b => b.text).join('')
            : (tr.content || '')
        }));
      }

      // 纯文本 user 消息
      return { role: 'user', content: textBlocks.map(b => b.text).join('') };
    }
  }

  return { role, content: String(content) };
}

/**
 * 将 OpenAI 非流式响应转换为 Anthropic 格式
 */
function openAIToAnthropic(openaiResp, model) {
  const choice = openaiResp.choices?.[0];
  if (!choice) {
    return { type: 'error', error: { type: 'api_error', message: 'No choices in response' } };
  }

  const msg = choice.message;
  const content = [];

  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let inputObj;
      try { inputObj = JSON.parse(tc.function.arguments); } catch { inputObj = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: inputObj
      });
    }
  }

  const stopReason = mapStopReason(choice.finish_reason);

  return {
    id: openaiResp.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: model || openaiResp.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0
    }
  };
}

/**
 * 将 OpenAI finish_reason 映射为 Anthropic stop_reason
 */
function mapStopReason(reason) {
  const map = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'stop_sequence' };
  return map[reason] || 'end_turn';
}

/**
 * 流式转换：将 OpenAI SSE 流转为 Anthropic SSE 流
 */
async function streamOpenAIToAnthropic(readable, writable, originalBody) {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const write = (data) => writer.write(encoder.encode(data));
  const sseEvent = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  let messageId = `msg_${Date.now()}`;
  let inputTokens = 0;
  let outputTokens = 0;
  let headerSent = false;

  // 当前正在处理的 content block 索引和类型
  // index → { type, id?, name? }
  const blockState = {};
  let textBlockIndex = -1;
  // tool_call index → content block index
  const toolIndexMap = {};
  let nextBlockIndex = 0;

  try {
    const reader = readable.getReader();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留不完整的最后一行

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;

        let chunk;
        try { chunk = JSON.parse(raw); } catch { continue; }

        if (!headerSent) {
          messageId = chunk.id || messageId;
          // 发送 message_start
          write(sseEvent('message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: originalBody.model,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 }
            }
          }));
          write('event: ping\ndata: {"type":"ping"}\n\n');
          headerSent = true;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};

        // --- 文本 delta ---
        if (delta.content) {
          if (textBlockIndex === -1) {
            textBlockIndex = nextBlockIndex++;
            blockState[textBlockIndex] = { type: 'text' };
            write(sseEvent('content_block_start', {
              type: 'content_block_start',
              index: textBlockIndex,
              content_block: { type: 'text', text: '' }
            }));
          }
          write(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: delta.content }
          }));
          outputTokens++;
        }

        // --- tool_calls delta ---
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const tcIndex = tc.index ?? 0;

            if (!(tcIndex in toolIndexMap)) {
              // 新工具调用块开始
              const blockIdx = nextBlockIndex++;
              toolIndexMap[tcIndex] = blockIdx;
              blockState[blockIdx] = { type: 'tool_use', id: tc.id, name: tc.function?.name || '' };
              write(sseEvent('content_block_start', {
                type: 'content_block_start',
                index: blockIdx,
                content_block: {
                  type: 'tool_use',
                  id: tc.id || `toolu_${Date.now()}_${tcIndex}`,
                  name: tc.function?.name || '',
                  input: {}
                }
              }));
            }

            const blockIdx = toolIndexMap[tcIndex];

            // 更新 id/name（可能分片到达）
            if (tc.id) blockState[blockIdx].id = tc.id;
            if (tc.function?.name) blockState[blockIdx].name += tc.function.name;

            // 参数 JSON 片段
            if (tc.function?.arguments) {
              write(sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIdx,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
              }));
            }
          }
        }

        // --- usage ---
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || outputTokens;
        }

        // --- finish ---
        if (choice.finish_reason) {
          const allBlocks = [
            ...(textBlockIndex >= 0 ? [textBlockIndex] : []),
            ...Object.values(toolIndexMap)
          ].sort((a, b) => a - b);

          for (const idx of allBlocks) {
            write(sseEvent('content_block_stop', { type: 'content_block_stop', index: idx }));
            delete blockState[idx];
          }

          write(sseEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: mapStopReason(choice.finish_reason), stop_sequence: null },
            usage: { output_tokens: outputTokens }
          }));

          write(sseEvent('message_stop', { type: 'message_stop' }));
          return; // 收到结束信号，直接退出，不再处理后续 chunk
        }
      }
    }

    // 流异常截断兜底（正常情况不会走到这里）
    for (const idx of Object.keys(blockState)) {
      write(sseEvent('content_block_stop', { type: 'content_block_stop', index: Number(idx) }));
      delete blockState[idx];
    }
    if (headerSent) {
      write(sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens }
      }));
      write(sseEvent('message_stop', { type: 'message_stop' }));
    }

  } catch (err) {
    write(sseEvent('error', { type: 'error', error: { type: 'server_error', message: err.message } }));
  } finally {
    await writer.close();
  }
}

/**
 * Anthropic 错误响应
 */
function anthropicError(message, type, status) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: anthropicJsonHeaders()
  });
}

function anthropicJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
}

function anthropicStreamHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'anthropic-version': '2023-06-01',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
}
