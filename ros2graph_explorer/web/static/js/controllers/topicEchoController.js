import { formatHz, formatBytesPerSecond } from '../utils/format.js';
import { DEFAULT_GENERAL_SETTINGS } from '../state/generalSettingsManager.js';

const buildEchoKey = (topicName, peerName) => [topicName, peerName || ''].join('@');
const buildEchoOverlayId = (topicName, peerName) =>
  ['topic-echo', topicName, peerName].filter(Boolean).join(':');

export class TopicEchoController {
  constructor({ streamManager, overlay, statusBar, generalSettings }) {
    this.streams = streamManager;
    this.overlay = overlay;
    this.statusBar = statusBar;
    this.generalSettings = generalSettings ?? null;
    this.generalSettingsState = generalSettings?.getState?.() ?? { ...DEFAULT_GENERAL_SETTINGS };
    this.settingsUnsubscribe =
      typeof generalSettings?.subscribe === 'function'
        ? generalSettings.subscribe(state => {
            this.generalSettingsState = state;
            this.applyGeneralSettings();
          })
        : null;
    this.overlays = new Map(); // key -> context
  }

  async toggle(topicName, peerName) {
    if (!topicName) {
      return;
    }
    const key = buildEchoKey(topicName, peerName);
    if (this.overlays.has(key)) {
      this.closeOverlay(key);
      return;
    }
    this.openOverlay(topicName, peerName);
  }

  openOverlay(topicName, peerName) {
    const key = buildEchoKey(topicName, peerName);
    if (this.overlays.has(key)) {
      this.closeOverlay(key);
    }
    const overlayId = buildEchoOverlayId(topicName, peerName);
    const context = {
      key,
      topicName,
      peerName,
      overlayId,
      unsubscribe: null,
      closeAttached: false,
      latestPayload: null,
      refreshTimer: null,
      lastRenderAt: 0,
      lastFingerprint: null,
    };
    const unsubscribe = this.streams.subscribe(topicName, peerName, payload => {
      this.handlePayload(context, payload);
    });
    context.unsubscribe = unsubscribe;
    this.overlays.set(key, context);
    this.statusBar?.setStatus(`Echoing ${topicName}…`);
  }

  closeOverlay(key) {
    const context = this.overlays.get(key);
    if (!context) {
      return;
    }
    context.unsubscribe?.();
    if (context.refreshTimer) {
      window.clearTimeout(context.refreshTimer);
      context.refreshTimer = null;
    }
    context.latestPayload = null;
    context.lastFingerprint = null;
    this.overlay?.hide({ id: context.overlayId });
    this.overlays.delete(key);
    this.statusBar?.setStatus(`Echo stopped on ${context.topicName}`);
  }

  async stopAll({ quiet = false } = {}) {
    const keys = Array.from(this.overlays.keys());
    keys.forEach(key => this.closeOverlay(key));
    if (!quiet) {
      this.statusBar?.setStatus('All echo streams stopped');
    }
  }

  handlePayload(context, payload) {
    if (!context || !payload) {
      return;
    }
    if (payload.error) {
      this.statusBar?.setStatus(`Echo error on ${context.topicName}: ${payload.error}`);
      this.closeOverlay(context.key);
      return;
    }
    const fingerprint = buildEchoFingerprint(payload);
    if (fingerprint && fingerprint === context.lastFingerprint) {
      return;
    }
    context.latestPayload = payload;
    if (this.shouldAutoRefresh()) {
      this.renderOverlayPayload(context, payload, fingerprint);
      return;
    }
    this.scheduleEchoRefresh(context, fingerprint);
  }

  renderOverlayPayload(context, payload, fingerprint) {
    if (!payload) {
      return;
    }
    const topicName = payload.topic ?? context.topicName;
    const subtitleParts = [];
    if (payload.type) {
      subtitleParts.push(payload.type);
    }
    const messages = payload.count ?? 0;
    subtitleParts.push(`Messages: ${messages}`);
    this.overlay?.show(
      {
        title: `Echo: ${topicName}`,
        subtitle: subtitleParts.join(' • '),
        sections: buildEchoSections(payload),
      },
      { id: context.overlayId },
    );
    context.lastRenderAt = Date.now();
    if (fingerprint) {
      context.lastFingerprint = fingerprint;
    }
    this.attachOverlayCloseHandler(context);
    if (payload.sample) {
      const timestamp = extractTimestamp(payload.sample);
      this.statusBar?.setStatus(
        `Echoing ${topicName}: ${messages} messages (last update ${timestamp.toLocaleTimeString()})`,
      );
    } else {
      this.statusBar?.setStatus(`Listening on ${topicName}…`);
    }
  }

  scheduleEchoRefresh(context, fingerprint) {
    if (!context?.latestPayload) {
      return;
    }
    const interval = this.getEchoRefreshInterval();
    const lastRender = context.lastRenderAt ?? 0;
    const elapsed = Date.now() - lastRender;
    if (elapsed >= interval) {
      this.renderOverlayPayload(context, context.latestPayload, fingerprint ?? buildEchoFingerprint(context.latestPayload));
      return;
    }
    if (context.refreshTimer) {
      return;
    }
    const delay = Math.max(0, interval - elapsed);
    context.refreshTimer = window.setTimeout(() => {
      context.refreshTimer = null;
      if (context.latestPayload) {
        this.renderOverlayPayload(
          context,
          context.latestPayload,
          buildEchoFingerprint(context.latestPayload),
        );
      }
    }, delay);
  }

  shouldAutoRefresh() {
    return Boolean(this.generalSettingsState?.streamAutoRefresh ?? true);
  }

  getEchoRefreshInterval() {
    const value =
      this.generalSettingsState?.echoRefreshIntervalMs ?? DEFAULT_GENERAL_SETTINGS.echoRefreshIntervalMs;
    const numeric = Number(value);
    const clamped = Number.isFinite(numeric) ? numeric : DEFAULT_GENERAL_SETTINGS.echoRefreshIntervalMs;
    return Math.max(250, clamped);
  }

  applyGeneralSettings() {
    if (!this.overlays.size) {
      return;
    }
    this.overlays.forEach(context => {
      if (context.refreshTimer) {
        window.clearTimeout(context.refreshTimer);
        context.refreshTimer = null;
      }
    });
    if (this.shouldAutoRefresh()) {
      this.overlays.forEach(context => {
        if (context.latestPayload) {
          this.renderOverlayPayload(
            context,
            context.latestPayload,
            buildEchoFingerprint(context.latestPayload),
          );
        }
      });
      return;
    }
    this.overlays.forEach(context => {
      this.scheduleEchoRefresh(context, null);
    });
  }

  attachOverlayCloseHandler(context) {
    if (!context.overlayId || context.closeAttached) {
      return;
    }
    const root = findOverlayRoot(context.overlayId);
    if (!root) {
      return;
    }
    context.closeAttached = true;
    const listener = event => {
      if (event?.detail?.id === context.overlayId) {
        this.closeOverlay(context.key);
      }
    };
    root.addEventListener('overlaypanel:close', listener, { once: true });
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

function extractTimestamp(sample) {
  const timestampSource = sample.received_at;
  const iso = sample.received_iso;
  let timestamp = Number.isFinite(timestampSource)
    ? new Date(timestampSource * 1000)
    : iso
    ? new Date(iso)
    : new Date();
  if (Number.isNaN(timestamp.getTime())) {
    timestamp = new Date();
  }
  return timestamp;
}

function findOverlayRoot(id) {
  if (!id) {
    return null;
  }
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
  return document.querySelector(`[data-overlay-id="${escaped}"]`);
}

function buildEchoFingerprint(payload) {
  if (!payload) {
    return null;
  }
  const countPart = Number.isFinite(payload.count) ? payload.count : 'n/a';
  const stamp = buildSampleStamp(payload.sample);
  return `${countPart}|${stamp}`;
}

function buildSampleStamp(sample) {
  if (!sample) {
    return 'none';
  }
  if (Number.isFinite(sample.received_at)) {
    return `at:${sample.received_at}`;
  }
  if (sample.received_iso) {
    return `iso:${sample.received_iso}`;
  }
  if (typeof sample.sequence === 'number') {
    return `seq:${sample.sequence}`;
  }
  if (sample.header?.stamp) {
    const { sec, nanosec } = sample.header.stamp;
    if (Number.isFinite(sec) || Number.isFinite(nanosec)) {
      return `hdr:${sec ?? 0}:${nanosec ?? 0}`;
    }
  }
  if (sample.hash) {
    return `hash:${sample.hash}`;
  }
  try {
    return `json:${JSON.stringify(sample).slice(0, 120)}`;
  } catch {
    return 'sample';
  }
}
