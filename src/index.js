/**
 * MOS - Cloudflare Workers Service
 * Entry point
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Simple router
    const routes = {
      '/': () => handleHome(request),
      '/api/health': () => handleHealth(request),
      '/api/echo': () => handleEcho(request),
    };

    const handler = routes[url.pathname];
    if (handler) {
      return handler();
    }

    return new Response('Not Found', { status: 404 });
  },
};

/**
 * Home page
 */
function handleHome(request) {
  return new Response('hi', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Health check
 */
function handleHealth(request) {
  return new Response(JSON.stringify({ ok: true, timestamp: Date.now() }), {
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Echo request info
 */
async function handleEcho(request) {
  const headers = Object.fromEntries(request.headers);
  let body = null;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      body = await request.text();
    } catch (e) {
      body = null;
    }
  }

  const data = {
    method: request.method,
    url: request.url,
    headers,
    body,
    cf: request.cf || null,
  };

  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'content-type': 'application/json' },
  });
}
