export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      const userAgent = request.headers.get('user-agent') || '';
      const isTouchDevice = /android|iphone|ipod|ipad|mobile|windows phone|iemobile|opera mini/i.test(userAgent);
      url.pathname = isTouchDevice ? '/mobile.html' : '/desktop.html';
    }

    return env.ASSETS.fetch(new Request(url, request));
  },
};
