/** Helper functions for Anthropic ↔ OpenAI conversion */

function invalidAnthropicRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.type = 'invalid_request_error';
  return error;
}

export function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const systemText = Array.isArray(body.system)
      ? body.system.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : body.system;
    messages.push({ role: 'system', content: systemText });
  }
  const rawMessages = (body.messages || []).flatMap(convertAnthropicMessage);
  for (const msg of rawMessages) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && msg.role === 'user' && typeof last.content === 'string' && typeof msg.content === 'string') {
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
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') openaiBody.tool_choice = 'auto';
    else if (body.tool_choice.type === 'any') openaiBody.tool_choice = 'required';
    else if (body.tool_choice.type === 'tool') {
      openaiBody.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    }
  }
  return openaiBody;
}

function convertAnthropicMessage(msg) {
  const { role, content } = msg;
  if (typeof content === 'string') {
    return { role, content };
  }
  if (Array.isArray(content)) {
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
          function: { name: b.name, arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input) }
        }));
      }
      return result;
    }
    if (role === 'user') {
      const messages = [];
      let userParts = [];

      const flushUserParts = () => {
        if (userParts.length === 0) return;
        if (userParts.length === 1 && userParts[0].type === 'text') {
          messages.push({ role: 'user', content: userParts[0].text });
        } else {
          messages.push({ role: 'user', content: userParts });
        }
        userParts = [];
      };

      for (const block of content) {
        if (block.type === 'tool_result') {
          flushUserParts();
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: stringifyToolResultContent(block.content)
          });
          continue;
        }

        userParts.push(convertAnthropicUserContentBlock(block));
      }

      flushUserParts();
      return messages;
    }
  }
  return { role, content: String(content) };
}

function convertAnthropicUserContentBlock(block) {
  if (block.type === 'text') {
    return { type: 'text', text: block.text || '' };
  }

  if (block.type === 'image') {
    return {
      type: 'image_url',
      image_url: {
        url: resolveAnthropicImageURL(block.source)
      }
    };
  }

  throw invalidAnthropicRequest(`Unsupported Anthropic content block type: ${block.type}`);
}

function resolveAnthropicImageURL(source) {
  if (!source || typeof source !== 'object') {
    throw invalidAnthropicRequest('Invalid Anthropic image source');
  }

  if (source.type === 'base64') {
    if (!source.media_type || !source.data) {
      throw invalidAnthropicRequest('Anthropic base64 image source requires media_type and data');
    }
    return `data:${source.media_type};base64,${source.data}`;
  }

  if (source.type === 'url') {
    if (!source.url) {
      throw invalidAnthropicRequest('Anthropic url image source requires url');
    }
    return source.url;
  }

  throw invalidAnthropicRequest(`Unsupported Anthropic image source type: ${source.type}`);
}

function stringifyToolResultContent(content) {
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  }

  if (content == null) {
    return '';
  }

  return typeof content === 'string' ? content : JSON.stringify(content);
}

export function openAIToAnthropic(openaiResp, model) {
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
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: inputObj });
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

export function mapStopReason(reason) {
  const map = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'stop_sequence' };
  return map[reason] || 'end_turn';
}

export async function streamOpenAIToAnthropic(readable, writable, originalBody) {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const write = data => writer.write(encoder.encode(data));
  const sseEvent = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let messageId = `msg_${Date.now()}`;
  let headerSent = false;
  let textBlockIndex = -1;
  const toolIndexMap = {};
  const blockState = {};
  let nextBlockIndex = 0;
  let outputTokens = 0;
  try {
    const reader = readable.getReader();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(raw); } catch { continue; }
        if (!headerSent) {
          messageId = chunk.id || messageId;
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
        if (delta.content) {
          if (textBlockIndex === -1) {
            textBlockIndex = nextBlockIndex++;
            blockState[textBlockIndex] = { type: 'text' };
            write(sseEvent('content_block_start', { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } }));
          }
          write(sseEvent('content_block_delta', { type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: delta.content } }));
          outputTokens++;
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const tcIndex = tc.index ?? 0;
            if (!(tcIndex in toolIndexMap)) {
              const blockIdx = nextBlockIndex++;
              toolIndexMap[tcIndex] = blockIdx;
              blockState[blockIdx] = { type: 'tool_use', id: tc.id, name: tc.function?.name || '' };
              write(sseEvent('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: tc.id || `toolu_${Date.now()}_${tcIndex}`, name: tc.function?.name || '', input: {} } }));
            }
            const blockIdx = toolIndexMap[tcIndex];
            if (tc.id) blockState[blockIdx].id = tc.id;
            if (tc.function?.name) blockState[blockIdx].name += tc.function.name;
            if (tc.function?.arguments) {
              write(sseEvent('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }));
            }
          }
        }
        if (choice.finish_reason) {
          const allBlocks = [
            ...(textBlockIndex >= 0 ? [textBlockIndex] : []),
            ...Object.values(toolIndexMap)
          ].sort((a, b) => a - b);
          for (const idx of allBlocks) {
            write(sseEvent('content_block_stop', { type: 'content_block_stop', index: idx }));
            delete blockState[idx];
          }
          write(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: mapStopReason(choice.finish_reason), stop_sequence: null }, usage: { output_tokens: outputTokens } }));
          write(sseEvent('message_stop', { type: 'message_stop' }));
          return;
        }
      }
    }
  } catch (err) {
    write(sseEvent('error', { type: 'error', error: { type: 'server_error', message: err.message } }));
  } finally {
    await writer.close();
  }
}

export function anthropicError(message, type, status) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: anthropicJsonHeaders()
  });
}

export function anthropicJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
}

export function anthropicStreamHeaders() {
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
