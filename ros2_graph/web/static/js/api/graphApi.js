import { HttpClient } from './httpClient.js';

export class GraphApi {
  constructor(client = new HttpClient()) {
    this.client = client;
  }

  async fetchGraph() {
    const timestamp = Date.now();
    return this.client.request(`/graph?ts=${timestamp}`, { cache: 'no-store' });
  }
}
