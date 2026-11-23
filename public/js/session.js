/* Idle-session handling. The server also enforces the same timeout; this module
   makes the UI log out automatically and keeps tabs in sync. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const ACTIVITY_KEY = 'abmdas:last-activity';
const LOGOUT_KEY = 'abmdas:force-logout';
const BROADCAST_INTERVAL_MS = 5000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];

let idleMs = DEFAULT_IDLE_MS;
let timer = null;
let started = false;
let lastActivityAt = 0;
let lastBroadcastAt = 0;

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* Storage can be disabled; timer still works in this tab. */
  }
}

function schedule() {
  clearTimer();
  timer = setTimeout(() => {
    if (!started) return;
    /* Clear the server-side session too, then let app.js render the login page. */
    fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    }).catch(() => {});
    finish('idle', true);
  }, idleMs);
}

function finish(reason, broadcast) {
  if (!started && reason !== 'remote') return;
  started = false;
  clearTimer();
  if (broadcast) store(LOGOUT_KEY, `${Date.now()}:${reason}`);
  window.dispatchEvent(new CustomEvent('abmdas:session-expired', { detail: { reason } }));
}

export function noteActivity() {
  const now = Date.now();
  lastActivityAt = now;
  if (started) schedule();
  if (now - lastBroadcastAt >= BROADCAST_INTERVAL_MS) {
    lastBroadcastAt = now;
    store(ACTIVITY_KEY, now);
  }
}

export function startSessionTimeout(timeoutMs = DEFAULT_IDLE_MS) {
  idleMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_IDLE_MS;
  started = true;
  lastActivityAt = Date.now();
  lastBroadcastAt = 0;
  store(ACTIVITY_KEY, lastActivityAt);
  schedule();
}

export function stopSessionTimeout() {
  started = false;
  clearTimer();
}

export function broadcastLogout() {
  store(LOGOUT_KEY, `${Date.now()}:manual`);
}

export function getLastActivityAt() {
  return lastActivityAt;
}

for (const type of ACTIVITY_EVENTS) {
  window.addEventListener(type, noteActivity, { passive: true });
}
window.addEventListener('focus', noteActivity);
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') noteActivity();
});
window.addEventListener('beforeunload', stopSessionTimeout);
window.addEventListener('storage', (event) => {
  if (event.key === ACTIVITY_KEY && started) {
    const at = Number(event.newValue);
    if (Number.isFinite(at) && at > lastActivityAt) {
      lastActivityAt = at;
      schedule();
    }
  } else if (event.key === LOGOUT_KEY && event.newValue && started) {
    finish('remote', false);
  }
});
