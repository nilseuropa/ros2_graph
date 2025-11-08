import { HttpClient } from './httpClient.js';

export class NodeToolsApi {
  constructor(client = new HttpClient()) {
    this.client = client;
  }

  async get(action, node, params = {}) {
    const search = new URLSearchParams({ action, node });
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        search.set(key, String(value));
      }
    });
    return this.client.request(`/node_tool?${search.toString()}`);
  }

  async post(action, node, body = {}) {
    const payload = { action, node, ...body };
    return this.client.request('/node_tool', { method: 'POST', body: payload });
  }
}
