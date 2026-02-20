const STORAGE_GENERAL_SETTINGS_KEY = 'ros2graph_explorer.settings.general';

export const DEFAULT_GENERAL_SETTINGS = Object.freeze({
  graphRefreshIntervalMs: 2000,
  streamAutoRefresh: true,
  echoRefreshIntervalMs: 1000,
  plotRefreshIntervalMs: 1000,
  layoutMode: 'auto',
  edgeLineStyle: 'orthogonal',
  bezierSmoothness: 35,
});

const LIMITS = Object.freeze({
  graphRefreshIntervalMs: { min: 500, max: 60000 },
  echoRefreshIntervalMs: { min: 250, max: 10000 },
  plotRefreshIntervalMs: { min: 250, max: 10000 },
  bezierSmoothness: { min: 5, max: 100 },
});

export class GeneralSettingsManager {
  constructor({ storage } = {}) {
    this.storage = storage ?? getStorage();
    this.state = { ...DEFAULT_GENERAL_SETTINGS };
    this.listeners = new Set();
  }

  init() {
    this.loadFromStorage();
  }

  getState() {
    return { ...this.state };
  }

  subscribe(handler) {
    if (typeof handler !== 'function') {
      return () => {};
    }
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  update(patch) {
    if (!patch || typeof patch !== 'object') {
      return;
    }
    const next = sanitizeState({ ...this.state, ...patch });
    if (statesEqual(this.state, next)) {
      return;
    }
    this.state = next;
    this.persist();
    this.notify();
  }

  loadFromStorage() {
    const storage = this.storage;
    if (!storage) {
      return;
    }
    const raw = safeGet(storage, STORAGE_GENERAL_SETTINGS_KEY);
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.state = sanitizeState({ ...DEFAULT_GENERAL_SETTINGS, ...parsed });
      }
    } catch {
      // Ignore corrupted payloads.
    }
  }

  persist() {
    if (!this.storage) {
      return;
    }
    try {
      this.storage.setItem(STORAGE_GENERAL_SETTINGS_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore persistence failures (private browsing, storage quota, etc.).
    }
  }

  notify() {
    const snapshot = this.getState();
    this.listeners.forEach(handler => {
      try {
        handler(snapshot);
      } catch {
        // Ignore subscriber errors.
      }
    });
  }
}

function sanitizeState(state) {
  const sanitized = { ...DEFAULT_GENERAL_SETTINGS };
  sanitized.graphRefreshIntervalMs = clampInterval(
    toInteger(state.graphRefreshIntervalMs, DEFAULT_GENERAL_SETTINGS.graphRefreshIntervalMs),
    LIMITS.graphRefreshIntervalMs,
  );
  sanitized.streamAutoRefresh = Boolean(state.streamAutoRefresh);
  sanitized.echoRefreshIntervalMs = clampInterval(
    toInteger(state.echoRefreshIntervalMs, DEFAULT_GENERAL_SETTINGS.echoRefreshIntervalMs),
    LIMITS.echoRefreshIntervalMs,
  );
  sanitized.plotRefreshIntervalMs = clampInterval(
    toInteger(state.plotRefreshIntervalMs, DEFAULT_GENERAL_SETTINGS.plotRefreshIntervalMs),
    LIMITS.plotRefreshIntervalMs,
  );
  sanitized.layoutMode = sanitizeLayoutMode(state.layoutMode);
  sanitized.edgeLineStyle = sanitizeEdgeLineStyle(state.edgeLineStyle);
  sanitized.bezierSmoothness = clampInterval(
    toInteger(state.bezierSmoothness, DEFAULT_GENERAL_SETTINGS.bezierSmoothness),
    LIMITS.bezierSmoothness,
  );
  return sanitized;
}

function sanitizeLayoutMode(value) {
  if (value === 'rqt' || value === 'simple') {
    return value;
  }
  return DEFAULT_GENERAL_SETTINGS.layoutMode;
}

function sanitizeEdgeLineStyle(value) {
  if (value === 'bezier') {
    return value;
  }
  return DEFAULT_GENERAL_SETTINGS.edgeLineStyle;
}

function toInteger(value, fallback) {
  const number = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.trunc(number);
}

function clampInterval(value, { min, max }) {
  const lower = Number.isFinite(min) ? min : Number.MIN_SAFE_INTEGER;
  const upper = Number.isFinite(max) ? max : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(value, lower), upper);
}

function statesEqual(a, b) {
  return (
    a.graphRefreshIntervalMs === b.graphRefreshIntervalMs &&
    a.streamAutoRefresh === b.streamAutoRefresh &&
    a.echoRefreshIntervalMs === b.echoRefreshIntervalMs &&
    a.plotRefreshIntervalMs === b.plotRefreshIntervalMs &&
    a.layoutMode === b.layoutMode &&
    a.edgeLineStyle === b.edgeLineStyle &&
    a.bezierSmoothness === b.bezierSmoothness
  );
}

function getStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeGet(storage, key) {
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
