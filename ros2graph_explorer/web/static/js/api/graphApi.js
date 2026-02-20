import { HttpClient } from './httpClient.js';

export class GraphApi {
  constructor(client = new HttpClient()) {
    this.client = client;
  }

  async fetchGraph({ layoutMode } = {}) {
    const mode = normalizeLayoutMode(layoutMode);
    const timestamp = Date.now();
    const query = new URLSearchParams({ ts: String(timestamp), layout: mode });
    return this.client.request(`/graph?${query.toString()}`, { cache: 'no-store' });
  }
}

function normalizeLayoutMode(value) {
  if (value === 'rqt' || value === 'simple') {
    return value;
  }
  return 'auto';
}
