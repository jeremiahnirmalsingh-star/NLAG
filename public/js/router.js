export function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { path: '/' + parts.join('/'), parts, query, raw };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : '/' + path}`;
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  if (replace) {
    const url = `${window.location.pathname}${window.location.search}${target}`;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export function reloadPage() {
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function withQuery(path, params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const q = qs.toString();
  return q ? `${path}?${q}` : path;
}
