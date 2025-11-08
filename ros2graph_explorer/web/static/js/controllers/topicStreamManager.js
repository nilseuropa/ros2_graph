const POLL_INTERVAL_MS = 1000;
const buildStreamKey = (topicName, peerName) =>
  [topicName, peerName || ''].join('@');

export class TopicStreamManager {
  constructor({ topicApi }) {
    this.topicApi = topicApi;
    this.sessions = new Map(); // key -> session
  }

  subscribe(topicName, peerName, handler) {
    if (!topicName || typeof handler !== 'function') {
      return () => {};
    }
    const key = buildStreamKey(topicName, peerName);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.createSession(topicName, peerName);
      this.sessions.set(key, session);
      this.startSession(session).catch(error => {
        this.notifyError(session, error);
      });
    }
    session.subscribers.add(handler);
    if (session.lastPayload) {
      handler(session.lastPayload);
    }
    return () => {
      const current = this.sessions.get(key);
      if (!current) {
        return;
      }
      current.subscribers.delete(handler);
      if (!current.subscribers.size) {
        this.stopSession(current).catch(() => {});
        this.sessions.delete(key);
      }
    };
  }

  async requestSample(topicName, peerName, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const key = buildStreamKey(topicName, peerName);
      const existing = this.sessions.get(key);
      if (existing?.lastPayload?.sample) {
        resolve(existing.lastPayload);
        return;
      }
      let settled = false;
      let unsubscribe = () => {};
      let timer = null;
      const cleanup = () => {
        if (timer !== null) {
          window.clearTimeout(timer);
        }
        unsubscribe();
      };
      unsubscribe = this.subscribe(topicName, peerName, payload => {
        if (settled) {
          return;
        }
        if (payload?.sample) {
          settled = true;
          cleanup();
          resolve(payload);
        } else if (payload?.error) {
          settled = true;
          cleanup();
          reject(new Error(payload.error));
        }
      });
      timer = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error('sample timeout'));
      }, timeout);
    });
  }

  async startSession(session) {
    try {
      const payload = await this.topicApi.echo(session.topicName, {
        mode: 'start',
        peer: session.peerName,
      });
      this.handlePayload(session, payload);
      this.schedulePoll(session);
    } catch (error) {
      this.notifyError(session, error);
      await this.stopSession(session);
    }
  }

  schedulePoll(session) {
    if (!session.subscribers.size || !session.streamId) {
      return;
    }
    session.timer = window.setTimeout(() => {
      this.poll(session).catch(error => {
        this.notifyError(session, error);
        this.stopSession(session).catch(() => {});
        this.sessions.delete(buildStreamKey(session.topicName, session.peerName));
      });
    }, POLL_INTERVAL_MS);
  }

  async poll(session) {
    if (!session.streamId) {
      return;
    }
    try {
      const payload = await this.topicApi.echo(session.topicName, {
        mode: 'poll',
        stream: session.streamId,
        peer: session.peerName,
      });
      this.handlePayload(session, payload);
      this.schedulePoll(session);
    } catch (error) {
      throw error;
    }
  }

  handlePayload(session, payload) {
    if (!payload) {
      return;
    }
    if (payload.stream_id) {
      session.streamId = payload.stream_id;
    }
    session.lastPayload = payload;
    session.subscribers.forEach(handler => {
      try {
        handler(payload);
      } catch {
        /* ignore subscriber errors */
      }
    });
  }

  notifyError(session, error) {
    const message = error?.message || String(error);
    session.subscribers.forEach(handler => {
      try {
        handler({ error: message });
      } catch {
        /* ignore */
      }
    });
  }

  async stopSession(session) {
    if (session.timer) {
      window.clearTimeout(session.timer);
      session.timer = null;
    }
    if (session.streamId) {
      try {
        await this.topicApi.echo(session.topicName, {
          mode: 'stop',
          stream: session.streamId,
          peer: session.peerName,
        });
      } catch {
        /* ignore */
      }
    }
    session.streamId = null;
  }

  createSession(topicName, peerName) {
    return {
      topicName,
      peerName: peerName || null,
      streamId: null,
      timer: null,
      subscribers: new Set(),
      lastPayload: null,
    };
  }
}
