import { state } from './state.js';

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, silent = false } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  };
  if (state.currentUnitIds.length) options.headers['X-Unit-Id'] = state.currentUnitIds.join(',');
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(path, options);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  if (lastErr) {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !silent) {
      window.dispatchEvent(new CustomEvent('abmdas:session-expired'));
    }
    throw new ApiError((data && data.error) || `Request failed (${res.status}).`, res.status, data && data.details);
  }
  return data;
}

export const api = {
  get: (path, opts) => request(path, opts),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
};

export function queryString(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '' && value !== false) qs.set(key, value);
  }
  const str = qs.toString();
  return str ? `?${str}` : '';
}
