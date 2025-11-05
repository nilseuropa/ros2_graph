import { bindEvent } from '../utils/dom.js';
import { toScenePoint } from '../render/coordinateSystem.js';
import { hitTestScene } from '../render/hitTest.js';

export class InteractionController {
  constructor(canvas, store, viewController, options = {}) {
    this.canvas = canvas;
    this.store = store;
    this.view = viewController;
    this.options = options;
    this.scene = null;
    this.activeSelections = new Map();

    this.unsubscribeStore = store.subscribe('scene', scene => {
      this.scene = scene;
    });

    this.eventUnsubscribers = [
      bindEvent(canvas, 'pointerdown', this.handlePointerDown.bind(this)),
      bindEvent(canvas, 'pointermove', this.handlePointerMove.bind(this)),
      bindEvent(canvas, 'pointerup', this.handlePointerUp.bind(this)),
      bindEvent(canvas, 'pointercancel', this.handlePointerUp.bind(this)),
      bindEvent(canvas, 'pointerleave', this.handlePointerLeave.bind(this)),
      bindEvent(canvas, 'wheel', this.handleWheel.bind(this), { passive: false }),
      bindEvent(canvas, 'dblclick', this.handleDoubleClick.bind(this)),
      bindEvent(canvas, 'contextmenu', this.handleContextMenu.bind(this)),
    ];

    this.docUnsubscribers = [
      bindEvent(document, 'keydown', this.handleKeyDown.bind(this)),
      bindEvent(document, 'pointerdown', this.handleDocumentPointerDown.bind(this)),
    ];
  }

  destroy() {
    this.unsubscribeStore?.();
    this.eventUnsubscribers.forEach(off => off());
    this.docUnsubscribers.forEach(off => off());
  }

  clearActiveSelections() {
    this.activeSelections.clear();
  }

  getCanvasPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  resolveTarget(event) {
    if (!this.scene) {
      return null;
    }
    const canvasPoint = this.getCanvasPoint(event);
    const scenePoint = toScenePoint(this.store.getView(), canvasPoint);
    const hit = hitTestScene(this.scene, scenePoint);
    if (!hit) {
      return null;
    }
    if (hit.type === 'node') {
      return {
        type: 'node',
        kind: 'node',
        name: hit.name,
        nodeName: hit.name,
        geometry: hit.geometry,
      };
    }
    if (hit.type === 'topic') {
      return {
        type: 'topic',
        kind: 'topic',
        name: hit.name,
        topicName: hit.name,
        geometry: hit.geometry,
      };
    }
    if (hit.type === 'edge') {
      const topicEdge = this.describeTopicEdge(hit.edge);
      if (topicEdge) {
        return topicEdge;
      }
      return {
        type: 'edge',
        kind: 'edge',
        name: hit.name,
        edge: hit.edge,
      };
    }
    return hit;
  }

  describeTopicEdge(edge) {
    if (!edge || !this.scene) {
      return null;
    }
    const topics = this.scene.topics || new Map();
    const nodes = this.scene.nodes || new Map();
    const tailIsTopic = topics.has(edge.tail);
    const headIsTopic = topics.has(edge.head);
    if (tailIsTopic && nodes.has(edge.head)) {
      return {
        type: 'edge',
        kind: 'topic-edge',
        name: `${edge.tail} ↔ ${edge.head}`,
        topicName: edge.tail,
        peerName: edge.head,
        edge,
      };
    }
    if (headIsTopic && nodes.has(edge.tail)) {
      return {
        type: 'edge',
        kind: 'topic-edge',
        name: `${edge.head} ↔ ${edge.tail}`,
        topicName: edge.head,
        peerName: edge.tail,
        edge,
      };
    }
    if (tailIsTopic && headIsTopic) {
      return {
        type: 'edge',
        kind: 'topic-edge',
        name: `${edge.tail} ↔ ${edge.head}`,
        topicName: edge.tail,
        peerName: edge.head,
        edge,
      };
    }
    return null;
  }

  selectTarget(target, mode = 'replace') {
    if (!target) {
      if (mode === 'replace') {
        this.clearActiveSelections();
        this.store.resetSelection();
      }
      return;
    }
    const key = getTargetKey(target);
    if (mode === 'replace') {
      this.clearActiveSelections();
      this.activeSelections.set(key, this.expandSelection(target));
    } else if (mode === 'add') {
      this.activeSelections.set(key, this.expandSelection(target));
    } else if (mode === 'toggle') {
      if (this.activeSelections.has(key)) {
        this.activeSelections.delete(key);
      } else {
        this.activeSelections.set(key, this.expandSelection(target));
      }
    } else {
      this.clearActiveSelections();
      this.activeSelections.set(key, this.expandSelection(target));
    }

    if (this.activeSelections.size === 0) {
      this.store.resetSelection();
      return;
    }
    const aggregate = createEmptySelection();
    this.activeSelections.forEach(selection => {
      selection.nodes.forEach(value => aggregate.nodes.add(value));
      selection.topics.forEach(value => aggregate.topics.add(value));
      selection.edges.forEach(value => aggregate.edges.add(value));
    });
    this.store.setSelection(aggregate);
  }

  expandSelection(target) {
    if (!target) {
      return createEmptySelection();
    }
    const scene = this.scene;
    const graph = this.store.getGraph();
    if (!scene || !graph) {
      return createEmptySelection();
    }
    const selection = createEmptySelection();
    const visibleNodes = scene.nodes || new Map();
    const visibleTopics = scene.topics || new Map();
    const visibleEdges = new Set((scene.edges || []).map(edge => edge.key));
    const edges = Array.isArray(graph.edges) ? graph.edges : [];

    const addNode = name => {
      if (visibleNodes.has(name)) {
        selection.nodes.add(name);
      }
    };
    const addTopic = name => {
      if (visibleTopics.has(name)) {
        selection.topics.add(name);
      }
    };
    const addEdge = edge => {
      const key = `${edge.start}->${edge.end}`;
      if (visibleEdges.has(key)) {
        selection.edges.add(key);
      }
    };

    const visitTopic = topicName => {
      addTopic(topicName);
      edges.forEach(edge => {
        if (edge.start === topicName || edge.end === topicName) {
          addEdge(edge);
          if (edge.start !== topicName) {
            addNode(edge.start);
          }
          if (edge.end !== topicName) {
            addNode(edge.end);
          }
        }
      });
    };

    const visitNode = nodeName => {
      addNode(nodeName);
      const relatedTopics = new Set();
      edges.forEach(edge => {
        if (edge.start === nodeName) {
          addEdge(edge);
          if (visibleTopics.has(edge.end)) {
            relatedTopics.add(edge.end);
          }
          if (visibleNodes.has(edge.end)) {
            addNode(edge.end);
          }
        } else if (edge.end === nodeName) {
          addEdge(edge);
          if (visibleTopics.has(edge.start)) {
            relatedTopics.add(edge.start);
          }
          if (visibleNodes.has(edge.start)) {
            addNode(edge.start);
          }
        }
      });
      relatedTopics.forEach(topicName => {
        if (visibleTopics.has(topicName)) {
          visitTopic(topicName);
        }
      });
    };

    if (target.kind === 'node') {
      visitNode(target.nodeName ?? target.name);
    } else if (target.kind === 'topic') {
      visitTopic(target.topicName ?? target.name);
    } else if (target.kind === 'topic-edge') {
      if (target.edge?.key) {
        selection.edges.add(target.edge.key);
      }
      if (target.topicName) {
        visitTopic(target.topicName);
      }
      if (target.peerName) {
        visitNode(target.peerName);
      }
    } else if (target.type === 'edge') {
      const data = target.edge;
      if (data) {
        if (data.key) {
          selection.edges.add(data.key);
        }
        if (visibleNodes.has(data.tail)) {
          visitNode(data.tail);
        } else if (visibleTopics.has(data.tail)) {
          visitTopic(data.tail);
        }
        if (visibleTopics.has(data.head)) {
          visitTopic(data.head);
        } else if (visibleNodes.has(data.head)) {
          visitNode(data.head);
        }
      }
    }

    return selection;
  }

  expandHover(target) {
    if (!target) {
      return null;
    }
    const normalized = normalizeTarget(target);
    const selection = this.expandSelection(target);
    return {
      primary: normalized,
      nodes: new Set(selection.nodes),
      topics: new Set(selection.topics),
      edges: new Set(selection.edges),
    };
  }

  handlePointerDown(event) {
    if (event.button === 0) {
      event.preventDefault();
      if (this.options.contextMenu) {
        this.options.contextMenu.toggle(false);
      }
      const target = this.resolveTarget(event);
      if (target) {
        const mode = event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'add' : 'replace';
        this.selectTarget(target, mode);
        this.store.setHover(this.expandHover(target));
        this.options.overlay?.hide?.();
        this.options.topicEcho?.stop?.({ quiet: true });
      } else {
        this.store.resetSelection();
        this.options.overlay?.hide?.();
        this.options.topicEcho?.stop?.({ quiet: true });
        const point = this.getCanvasPoint(event);
        this.view.beginPan(event.pointerId, point);
        try {
          this.canvas.setPointerCapture(event.pointerId);
        } catch {
          /* ignore pointer capture failures */
        }
      }
      return;
    }
  }

  handlePointerMove(event) {
    if (this.view.isPanning()) {
      const point = this.getCanvasPoint(event);
      this.view.updatePan(event.pointerId, point);
      return;
    }
    const target = this.resolveTarget(event);
    if (target) {
      this.store.setHover(this.expandHover(target));
    } else {
      this.store.setHover(null);
    }
  }

  handlePointerUp(event) {
    if (this.view.isPanning()) {
      this.view.endPan(event.pointerId);
      try {
        this.canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* noop */
      }
      return;
    }
  }

  handlePointerLeave(event) {
    if (this.view.isPanning()) {
      this.view.endPan(event.pointerId);
    }
    this.store.setHover(null);
  }

  handleWheel(event) {
    event.preventDefault();
    const point = this.getCanvasPoint(event);
    this.view.zoomAt(point, event.deltaY);
  }

  handleDoubleClick(event) {
    event.preventDefault();
    this.store.resetSelection();
    this.store.setHover(null);
    this.options.overlay?.hide?.();
    this.options.topicEcho?.stop?.({ quiet: true });
    this.clearActiveSelections();
  }

  handleContextMenu(event) {
    event.preventDefault();
    const target = this.resolveTarget(event);
    if (target) {
      this.selectTarget(target, event.ctrlKey || event.metaKey ? 'toggle' : event.shiftKey ? 'add' : 'replace');
      this.store.setHover(this.expandHover(target));
    }
    const contextMenu = this.options.contextMenu;
    if (contextMenu) {
      const point = {
        clientX: event.clientX,
        clientY: event.clientY,
        pageX: event.pageX,
        pageY: event.pageY,
      };
      contextMenu.toggle(true, point, target);
    }
  }

  handleKeyDown(event) {
    if (event.key === 'Escape') {
      this.options.overlay?.hide?.();
      this.store.resetSelection();
      this.options.topicEcho?.stop?.({ quiet: true });
      if (this.options.contextMenu) {
        this.options.contextMenu.toggle(false);
      }
      this.clearActiveSelections();
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      this.store.resetView();
    }
  }

  handleDocumentPointerDown(event) {
    const contextMenu = this.options.contextMenu;
    if (!contextMenu) {
      return;
    }
    if (!this.canvas.contains(event.target) && !contextMenu.contains(event.target)) {
      contextMenu.toggle(false);
    }
  }
}

function normalizeTarget(target) {
  if (!target) {
    return null;
  }
  if (target.type === 'edge') {
    const key = target.edge?.key ?? target.name;
    const name = target.topicName ?? target.name;
    return {
      type: 'edge',
      kind: target.kind ?? 'edge',
      name,
      key,
      topicName: target.topicName,
      peerName: target.peerName,
    };
  }
  return {
    type: target.type,
    kind: target.kind ?? target.type,
    name: target.nodeName ?? target.topicName ?? target.name,
    key: target.nodeName ?? target.topicName ?? target.name,
  };
}

function getTargetKey(target) {
  if (!target) {
    return '';
  }
  const kind = target.kind ?? target.type ?? 'unknown';
  if (target.kind === 'topic-edge' && target.edge?.key) {
    return `${kind}:${target.edge.key}`;
  }
  const primary = target.nodeName ?? target.topicName ?? target.name ?? target.edge?.key ?? 'unknown';
  return `${kind}:${primary}`;
}

function createEmptySelection() {
  return {
    nodes: new Set(),
    topics: new Set(),
    edges: new Set(),
  };
}
