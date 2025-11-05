import { formatHz, formatBytesPerSecond } from '../utils/format.js';

const POLL_INTERVAL_MS = 1000;

export class TopicEchoController {
  constructor({ topicApi, overlay, statusBar }) {
    this.topicApi = topicApi;
    this.overlay = overlay;
    this.statusBar = statusBar;
    this.state = {
      active: false,
      topicName: null,
      peerName: null,
      streamId: null,
      timer: null,
    };
  }

  async start(topicName, peerName) {
    if (!topicName) {
      return;
    }
    await this.stop({ quiet: true });
    this.statusBar?.setStatus(`Starting echo for ${topicName}…`);
    this.state = {
      active: true,
      topicName,
      peerName: peerName || null,
      streamId: null,
      timer: null,
    };
    try {
      const payload = await this.topicApi.echo(topicName, {
        mode: 'start',
        peer: peerName,
      });
      this.handlePayload(payload);
      this.schedulePoll();
    } catch (error) {
      this.statusBar?.setStatus(`Failed to start echo: ${error?.message || error}`);
      await this.stop({ quiet: true });
    }
  }

  async stop({ quiet = false } = {}) {
    if (!this.state.active) {
      return;
    }
    if (this.state.timer) {
      window.clearTimeout(this.state.timer);
      this.state.timer = null;
    }
    if (this.state.streamId) {
      try {
        await this.topicApi.echo(this.state.topicName, {
          mode: 'stop',
          stream: this.state.streamId,
          peer: this.state.peerName,
        });
      } catch (error) {
        /* ignore stop errors */
      }
    }
    this.state = {
      active: false,
      topicName: null,
      peerName: null,
      streamId: null,
      timer: null,
    };
    this.overlay?.hide();
    if (!quiet) {
      this.statusBar?.setStatus('Echo stopped');
    }
  }

  schedulePoll() {
    if (!this.state.active || !this.state.streamId) {
      return;
    }
    this.state.timer = window.setTimeout(() => {
      this.poll().catch(error => {
        const message = error?.message || String(error);
        this.statusBar?.setStatus(`Echo failed: ${message}`);
        this.stop({ quiet: true });
      });
    }, POLL_INTERVAL_MS);
  }

  async poll() {
    if (!this.state.active || !this.state.streamId) {
      return;
    }
    try {
      const payload = await this.topicApi.echo(this.state.topicName, {
        mode: 'poll',
        stream: this.state.streamId,
        peer: this.state.peerName,
      });
      this.handlePayload(payload);
      this.schedulePoll();
    } catch (error) {
      throw error;
    }
  }

  handlePayload(payload) {
    if (!payload || !this.state.active) {
      return;
    }
    if (payload.stopped) {
      this.stop();
      return;
    }
    if (payload.stream_id) {
      this.state.streamId = payload.stream_id;
    }
    const topicName = payload.topic ?? this.state.topicName;
    const subtitleParts = [];
    if (payload.type) {
      subtitleParts.push(payload.type);
    }
    const messages = payload.count ?? 0;
    subtitleParts.push(`Messages: ${messages}`);
    this.overlay?.show({
      title: `Echo: ${topicName}`,
      subtitle: subtitleParts.join(' • '),
      sections: buildEchoSections(payload),
    });
    if (payload.sample) {
      const timestampSource = payload.sample.received_at;
      const iso = payload.sample.received_iso;
      let timestamp = Number.isFinite(timestampSource)
        ? new Date(timestampSource * 1000)
        : iso
        ? new Date(iso)
        : new Date();
      if (Number.isNaN(timestamp.getTime())) {
        timestamp = new Date();
      }
      this.statusBar?.setStatus(
        `Echoing ${topicName}: ${messages} messages (last update ${timestamp.toLocaleTimeString()})`,
      );
    } else {
      this.statusBar?.setStatus(`Listening on ${topicName}…`);
    }
  }
}

function buildEchoSections(payload) {
  const sections = [];
  if (payload.sample) {
    sections.push({
      type: 'code',
      title: 'Latest message',
      code: payload.sample.data ?? payload.sample,
    });
  }
  const stats = [];
  if (Number.isFinite(payload.average_hz)) {
    stats.push(['Average rate', formatHz(payload.average_hz)]);
  }
  if (Number.isFinite(payload.average_bps)) {
    stats.push(['Average bandwidth', formatBytesPerSecond(payload.average_bps)]);
  }
  if (stats.length) {
    sections.push({
      type: 'table',
      title: 'Stream stats',
      headers: ['Metric', 'Value'],
      rows: stats.map(([label, value]) => ({ cells: [label, value] })),
    });
  }
  if (!sections.length) {
    sections.push({
      type: 'text',
      text: ['Waiting for samples…'],
    });
  }
  return sections;
}
