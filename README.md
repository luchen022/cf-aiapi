# Cloudflare Workers - OpenAI 格式多厂商 AI 代理

完全兼容 OpenAI API 格式的多厂商 AI 代理，支持透明转发到 DeepSeek、智谱、OpenAI 等任意兼容 OpenAI 格式的 AI 服务商。

## 功能特性

- ✅ 完全兼容 OpenAI API 格式
- ✅ 支持 `/v1/models`、`/v1/chat/completions`、`/v1/embeddings` 接口
- ✅ 支持流式响应（SSE）
- ✅ 支持跨域（CORS）
- ✅ 统一鉴权管理
- ✅ 灵活的模型路由配置
- ✅ 多账号负载均衡（同一模型可配置多个账号，自动轮询）
- ✅ 纯原生 JS，无依赖
- ✅ 开箱即用

## 快速部署

### 1. 创建 Cloudflare Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 `Workers & Pages`
3. 点击 `Create Application` → `Create Worker`
4. 将 `worker.js` 的内容复制到编辑器中
5. 点击 `Save and Deploy`

### 2. 配置环境变量

在 Worker 设置页面，进入 `Settings` → `Variables`，添加以下环境变量：

#### 必需的环境变量

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `API_KEY` | 统一鉴权密钥 | `your-secret-api-key-here` |
| `PROVIDERS` | 厂商和模型配置（JSON 字符串） | 见下方示例 |

#### 各厂商 API Key（按需配置）

| 变量名 | 说明 |
|--------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 |
| `ZHIPU_API_KEY` | 智谱 API 密钥 |
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `MOONSHOT_API_KEY` | 月之暗面 API 密钥 |
| `QWEN_API_KEY` | 通义千问 API 密钥 |

### 3. PROVIDERS 配置示例

#### 基础配置

```json
{
  "deepseek": {
    "baseURL": "https://api.deepseek.com/v1",
    "apiKey": "DEEPSEEK_API_KEY",
    "models": ["deepseek-chat", "deepseek-coder"]
  },
  "zhipu": {
    "baseURL": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "ZHIPU_API_KEY",
    "models": ["glm-4", "glm-4-plus", "glm-4-flash"]
  },
  "openai": {
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "OPENAI_API_KEY",
    "models": ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"]
  }
}
```

#### 多账号负载均衡配置

同一个厂商有多个账号时，可以配置为数组，Worker 会自动随机选择：

```json
{
  "deepseek": {
    "baseURL": "https://api.deepseek.com/v1",
    "apiKey": ["DEEPSEEK_API_KEY_1", "DEEPSEEK_API_KEY_2", "DEEPSEEK_API_KEY_3"],
    "models": ["deepseek-chat", "deepseek-coder"]
  },
  "zhipu": {
    "baseURL": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": ["ZHIPU_API_KEY_1", "ZHIPU_API_KEY_2"],
    "models": ["glm-4", "glm-4-plus", "glm-4-flash"]
  }
}
```

#### 多 baseURL 配置（支持不同区域）

```json
{
  "openai": {
    "baseURL": ["https://api.openai.com/v1", "https://api.openai-proxy.com/v1"],
    "apiKey": "OPENAI_API_KEY",
    "models": ["gpt-4", "gpt-3.5-turbo"]
  }
}
```

#### 完整示例（混合配置）

```json
{
  "deepseek": {
    "baseURL": "https://api.deepseek.com/v1",
    "apiKey": ["DEEPSEEK_API_KEY_1", "DEEPSEEK_API_KEY_2"],
    "models": ["deepseek-chat", "deepseek-coder"]
  },
  "zhipu": {
    "baseURL": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "ZHIPU_API_KEY",
    "models": ["glm-4", "glm-4-plus", "glm-4-flash", "glm-4-air"]
  },
  "openai": {
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "OPENAI_API_KEY",
    "models": ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo", "text-embedding-3-small"]
  },
  "moonshot": {
    "baseURL": "https://api.moonshot.cn/v1",
    "apiKey": "MOONSHOT_API_KEY",
    "models": ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"]
  }
}
```

**配置说明**：
- `baseURL`: 厂商 API 地址，支持字符串或数组（多个地址）
- `apiKey`: API 密钥，支持字符串、环境变量名或数组（多个账号）
- `models`: 该厂商支持的模型列表
- 当 `apiKey` 为全大写时（如 `DEEPSEEK_API_KEY`），Worker 会自动从环境变量读取
- 多账号配置时，Worker 使用随机选择策略实现负载均衡
- `/v1/models` 接口会返回所有配置的模型列表

## 使用方法

### 获取模型列表

```bash
curl https://your-worker.workers.dev/v1/models \
  -H "Authorization: Bearer your-secret-api-key-here"
```

### 对话补全（非流式）

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-api-key-here" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {"role": "user", "content": "你好"}
    ]
  }'
```

### 对话补全（流式）

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-api-key-here" \
  -d '{
    "model": "glm-4",
    "messages": [
      {"role": "user", "content": "讲个笑话"}
    ],
    "stream": true
  }'
```

### 文本嵌入

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-api-key-here" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "Hello, world!"
  }'
```

## 客户端集成

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-secret-api-key-here",
    base_url="https://your-worker.workers.dev/v1"
)

response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[
        {"role": "user", "content": "你好"}
    ]
)

print(response.choices[0].message.content)
```

### Node.js (OpenAI SDK)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'your-secret-api-key-here',
  baseURL: 'https://your-worker.workers.dev/v1'
});

const response = await client.chat.completions.create({
  model: 'glm-4',
  messages: [
    { role: 'user', content: '你好' }
  ]
});

console.log(response.choices[0].message.content);
```

### Curl

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-api-key-here" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

## 支持的 AI 厂商

理论上支持所有兼容 OpenAI API 格式的厂商，包括但不限于：

- DeepSeek (https://api.deepseek.com/v1)
- 智谱 AI (https://open.bigmodel.cn/api/paas/v4)
- OpenAI (https://api.openai.com/v1)
- 月之暗面 (https://api.moonshot.cn/v1)
- 通义千问 (https://dashscope.aliyuncs.com/compatible-mode/v1)
- 硅基流动 (https://api.siliconflow.cn/v1)
- 其他兼容 OpenAI 格式的服务

## 环境变量配置清单

### Cloudflare Workers 环境变量

#### 基础配置示例

```
# 必需
API_KEY=your-secret-api-key-here
PROVIDERS={"deepseek":{"baseURL":"https://api.deepseek.com/v1","apiKey":"DEEPSEEK_API_KEY","models":["deepseek-chat","deepseek-coder"]},"zhipu":{"baseURL":"https://open.bigmodel.cn/api/paas/v4","apiKey":"ZHIPU_API_KEY","models":["glm-4","glm-4-plus"]}}

# 各厂商密钥
DEEPSEEK_API_KEY=sk-xxxxx
ZHIPU_API_KEY=xxxxx.xxxxx
```

#### 多账号负载均衡配置示例

```
# 必需
API_KEY=your-secret-api-key-here
PROVIDERS={"deepseek":{"baseURL":"https://api.deepseek.com/v1","apiKey":["DEEPSEEK_API_KEY_1","DEEPSEEK_API_KEY_2"],"models":["deepseek-chat","deepseek-coder"]},"zhipu":{"baseURL":"https://open.bigmodel.cn/api/paas/v4","apiKey":"ZHIPU_API_KEY","models":["glm-4"]}}

# 各厂商密钥
DEEPSEEK_API_KEY_1=sk-xxxxx
DEEPSEEK_API_KEY_2=sk-yyyyy
ZHIPU_API_KEY=xxxxx.xxxxx
```

## 注意事项

1. 所有上游厂商必须已经兼容 OpenAI API 格式
2. Worker 只做透明转发，不做任何格式转换
3. 确保 `PROVIDERS` 配置中的 `baseURL` 不包含尾部斜杠
4. 流式响应需要上游厂商支持 SSE
5. 建议使用 Cloudflare Workers 的加密环境变量存储敏感信息
6. 多账号负载均衡使用随机选择策略，每次请求随机选择一个账号
7. 一个厂商可以配置多个模型，共享同一个 baseURL 和 apiKey
8. `/v1/models` 接口直接返回配置中的所有模型，不会请求上游
9. 多账号配置适用于：
   - 提高并发能力（绕过单账号限流）
   - 增加可用性（某个账号失败时还有其他账号）
   - 分散成本（多个账号分摊费用）

## 故障排查

### 401 Unauthorized
- 检查客户端请求头中的 `Authorization: Bearer {API_KEY}` 是否正确
- 确认 Worker 环境变量 `API_KEY` 已正确配置

### 404 Model Not Found
- 检查 `PROVIDERS` 环境变量是否为有效的 JSON 格式
- 确认请求的 model 名称在 `PROVIDERS` 配置的 models 列表中存在
- 确认厂商配置包含 baseURL、apiKey 和 models 字段

### 500 Server Error
- 检查上游厂商的 API Key 是否有效
- 确认上游厂商的 baseURL 是否正确
- 查看 Worker 日志获取详细错误信息

## 许可证

MIT License
