import { FETCH_TIMEOUT_MS } from '../constants/index.js';
import { createAbortableTimeout } from '../utils/async.js';

export class HttpClient {
  constructor({ baseUrl = '' } = {}) {
    this.baseUrl = baseUrl;
  }

  async request(path, { method = 'GET', body, headers = {}, timeout = FETCH_TIMEOUT_MS, signal, cache = 'no-store' } = {}) {
    const url = this.baseUrl + path;
    const init = {
      method,
      cache,
      headers: { ...headers },
      signal,
    };
    if (body !== undefined) {
      if (typeof body === 'object' && !(body instanceof FormData)) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      } else {
        init.body = body;
      }
    }

    let timeoutController = null;
    if (!signal && timeout) {
      timeoutController = createAbortableTimeout(timeout);
      init.signal = timeoutController.signal;
    }

    try {
      const response = await fetch(url, init);
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch (err) {
        payload = text;
      }
      if (!response.ok) {
        const message = payload?.error || payload || `HTTP ${response.status}`;
        const error = new Error(typeof message === 'string' ? message : 'Request failed');
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } finally {
      if (timeoutController) {
        timeoutController.clear();
      }
    }
  }
}
