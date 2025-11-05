const DEFAULT_VIEW = Object.freeze({
  scale: 1,
  offsetX: 0,
  offsetY: 0,
});

const createSelectionState = () => ({
  nodes: new Set(),
  topics: new Set(),
  edges: new Set(),
});

export class Store {
  constructor() {
    this.view = { ...DEFAULT_VIEW };
    this.graph = null;
    this.fingerprint = null;
    this.scene = null;
    this.status = '';
    this.meta = '';
    this.selection = createSelectionState();
    this.hover = null;
    this.overlay = null;
    this.listeners = new Map();
  }

  subscribe(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(handler);
    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  emit(event, payload) {
    const listeners = this.listeners.get(event);
    if (!listeners) {
      return;
    }
    listeners.forEach(cb => {
      try {
        cb(payload);
      } catch {
        // Ignore subscriber errors to avoid cascading failures.
      }
    });
  }

  setGraph(graph, fingerprint) {
    const previous = this.fingerprint;
    this.graph = graph;
    this.fingerprint = fingerprint ?? graph?.fingerprint ?? null;
    const changed = this.fingerprint !== previous;
    this.emit('graph', {
      graph: this.graph,
      fingerprint: this.fingerprint,
      changed,
    });
    return changed;
  }

  setScene(scene) {
    this.scene = scene;
    this.emit('scene', scene);
  }

  getView() {
    return { ...this.view };
  }

  getSelection() {
    return {
      nodes: new Set(this.selection.nodes),
      topics: new Set(this.selection.topics),
      edges: new Set(this.selection.edges),
    };
  }

  resetSelection() {
    this.selection = createSelectionState();
    this.emit('selection', this.getSelection());
  }

  setSelection(next) {
    if (!next) {
      this.resetSelection();
      return;
    }
    const previous = this.selection;
    const equal =
      setsEqual(previous.nodes, next.nodes) &&
      setsEqual(previous.topics, next.topics) &&
      setsEqual(previous.edges, next.edges);
    if (equal) {
      return;
    }
    this.selection = {
      nodes: new Set(next.nodes || []),
      topics: new Set(next.topics || []),
      edges: new Set(next.edges || []),
    };
    this.emit('selection', this.getSelection());
  }

  setHover(hover) {
    if (!hover) {
      this.hover = null;
      this.emit('hover', this.hover);
      return;
    }
    const cloneSet = source => {
      if (!source) {
        return new Set();
      }
      if (source instanceof Set) {
        return new Set(source);
      }
      return new Set(Array.isArray(source) ? source : []);
    };
    const next = {
      primary: hover.primary ?? null,
      nodes: cloneSet(hover.nodes),
      topics: cloneSet(hover.topics),
      edges: cloneSet(hover.edges),
    };
    this.hover = next;
    this.emit('hover', this.hover);
  }

  setOverlay(overlay) {
    this.overlay = overlay || null;
    this.emit('overlay', this.overlay);
  }

  resetView() {
    this.view = { ...DEFAULT_VIEW };
    this.emit('view', this.view);
  }

  updateView(updater) {
    const next = typeof updater === 'function' ? updater({ ...this.view }) : updater;
    if (!next) {
      return;
    }
    this.view = {
      scale: Number.isFinite(next.scale) ? next.scale : this.view.scale,
      offsetX: Number.isFinite(next.offsetX) ? next.offsetX : this.view.offsetX,
      offsetY: Number.isFinite(next.offsetY) ? next.offsetY : this.view.offsetY,
    };
    this.emit('view', this.view);
  }

  setStatus(message) {
    this.status = message;
    this.emit('status', message);
  }

  setMeta(text) {
    this.meta = text;
    this.emit('meta', text);
  }

  getFingerprint() {
    return this.fingerprint;
  }

  getGraph() {
    return this.graph;
  }
}

function setsEqual(a, b) {
  if (!a || !b) {
    return !a && !b;
  }
  if (a.size !== (b?.size ?? 0)) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}
