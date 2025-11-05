import { HttpClient } from './httpClient.js';

export class TopicToolsApi {
  constructor(client = new HttpClient()) {
    this.client = client;
  }

  async request(action, topic, { peer, params = {}, timeout } = {}) {
    const search = new URLSearchParams({ action, topic });
    if (peer) {
      search.set('peer', peer);
    }
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        search.set(key, String(value));
      }
    });
    return this.client.request(`/topic_tool?${search.toString()}`, { timeout });
  }

  async echo(topic, { mode, stream, peer, timeout } = {}) {
    const params = {};
    if (mode) params.mode = mode;
    if (stream) params.stream = stream;
    return this.request('echo', topic, { peer, params, timeout });
  }
}
