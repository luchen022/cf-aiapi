import { getModelConfig } from "../providers/parser.js";
import { proxyUpstreamResponse } from "../utils/response.js";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  streamOpenAIToAnthropic,
  anthropicError,
  anthropicJsonHeaders,
  anthropicStreamHeaders
} from "../utils/anthropicHelpers.js";

export async function handleAnthropicMessages(request, env) {
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
    if (!upstreamResponse.ok) {
      return proxyUpstreamResponse(upstreamResponse);
    }
    if (isStream) {
      const { readable, writable } = new TransformStream();
      streamOpenAIToAnthropic(upstreamResponse.body, writable, anthropicBody);
      return new Response(readable, { status: 200, headers: anthropicStreamHeaders() });
    }
    const openaiData = await upstreamResponse.json();
    const anthropicData = openAIToAnthropic(openaiData, anthropicBody.model);
    return new Response(JSON.stringify(anthropicData), { status: 200, headers: anthropicJsonHeaders() });
  } catch (e) {
    return anthropicError(e.message, 'server_error', 500);
  }
}
