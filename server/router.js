'use strict';

function createRouter() {
  const routes = [];

  function compile(pattern) {
    const keys = [];
    const source = pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    return { regex: new RegExp('^' + source + '/?$'), keys };
  }

  function add(method, pattern, handler, options = {}) {
    const { regex, keys } = compile(pattern);
    routes.push({ method, pattern, regex, keys, handler, auth: options.auth !== false });
  }

  return {
    get: (p, h, o) => add('GET', p, h, o),
    post: (p, h, o) => add('POST', p, h, o),
    put: (p, h, o) => add('PUT', p, h, o),
    patch: (p, h, o) => add('PATCH', p, h, o),
    delete: (p, h, o) => add('DELETE', p, h, o),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = route.regex.exec(pathname);
        if (!m) continue;
        const params = {};
        route.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(m[i + 1]);
        });
        return { route, params };
      }
      return null;
    },
  };
}

module.exports = { createRouter };
