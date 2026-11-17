'use strict';

/**
 * The one HTTP client for outbound app traffic.
 *
 * Node's global fetch (undici) knows nothing about Chromium's proxy settings,
 * so every model/web/download request goes through the session's fetch instead:
 * it uses the same network stack as the renderer and therefore the proxy the
 * user configured. Before the app is ready — and in plain-Node unit tests —
 * this falls back to the built-in fetch.
 */

let bound = null;

function bindSession(session) {
  bound = session;
}

function appFetch(input, init) {
  if (bound?.fetch) return bound.fetch(input, init);
  try {
    const { session } = require('electron');
    if (session?.defaultSession?.fetch) {
      bound = session.defaultSession;
      return bound.fetch(input, init);
    }
  } catch {
    /* not running inside Electron */
  }
  return fetch(input, init);
}

module.exports = { appFetch, bindSession };
