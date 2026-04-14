export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withCORSHeaders({
      'Content-Type': 'application/json'
    })
  });
}

export function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: withCORSHeaders({
      'Access-Control-Max-Age': '86400'
    })
  });
}

export function withCORSHeaders(headers = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Access-Control-Allow-Origin', '*');
  responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  responseHeaders.set('Access-Control-Allow-Headers', '*');
  return responseHeaders;
}

export function proxyUpstreamResponse(upstreamResponse, extraHeaders = {}) {
  const headers = new Headers(upstreamResponse.headers);
  headers.delete('Content-Length');
  headers.delete('Transfer-Encoding');
  headers.delete('Connection');

  const responseHeaders = withCORSHeaders(headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    responseHeaders.set(key, value);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  });
}
