import { GraphApi } from './api/graphApi.js';
import { buildScene, computeFitView } from './render/sceneBuilder.js';
import { GraphRenderer } from './render/graphRenderer.js';
import { ViewController } from './interaction/viewController.js';
import { InteractionController } from './interaction/interactionController.js';
import { StatusBar } from './ui/statusBar.js';
import { Store } from './state/store.js';
import { GRAPH_REFRESH_INTERVAL_MS } from './constants/index.js';
import { setText } from './utils/dom.js';
import { ContextMenu } from './ui/contextMenu.js';
import { OverlayPanel } from './ui/overlayPanel.js';
import { ParameterEditor } from './ui/modals/parameterEditor.js';
import { ServiceCaller } from './ui/modals/serviceCaller.js';
import { NodeToolsApi } from './api/nodeToolsApi.js';
import { TopicToolsApi } from './api/topicToolsApi.js';
import { ActionController } from './controllers/actionController.js';
import { TopicEchoController } from './controllers/topicEchoController.js';

const canvas = document.getElementById('graphCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const metaEl = document.getElementById('meta');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');
const contextMenuEl = document.getElementById('contextMenu');
const canvasContainer = document.getElementById('canvasContainer');

const store = new Store();
const renderer = new GraphRenderer(canvas);
const viewController = new ViewController(store);
const api = new GraphApi();
const statusBar = new StatusBar({
  metaEl,
  statusEl,
  refreshBtn,
  onRefresh: () => loadGraph({ manual: true }),
});
const overlayPanel = new OverlayPanel(canvasContainer);
const parameterEditor = new ParameterEditor();
const serviceCaller = new ServiceCaller();
const nodeApi = new NodeToolsApi();
const topicApi = new TopicToolsApi();
const topicEchoController = new TopicEchoController({
  topicApi,
  overlay: overlayPanel,
  statusBar,
});
const actionController = new ActionController({
  store,
  overlay: overlayPanel,
  statusBar,
  nodeApi,
  topicApi,
  parameterEditor,
  serviceCaller,
  topicEcho: topicEchoController,
});
const contextMenu = new ContextMenu(contextMenuEl, {
  getItems: target => getContextMenuItems(target),
  onSelect: (action, target) => handleContextMenuAction(action, target),
});
const interactionController = new InteractionController(canvas, store, viewController, {
  contextMenu,
  overlay: overlayPanel,
  topicEcho: topicEchoController,
});

let refreshTimer = null;

function resizeCanvas() {
  const header = document.querySelector('header');
  const headerHeight = header ? header.offsetHeight : 0;
  const newWidth = window.innerWidth;
  const newHeight = Math.max(240, window.innerHeight - headerHeight - 40);
  [canvas, overlayCanvas].forEach(el => {
    el.width = newWidth;
    el.height = newHeight;
  });
  const scene = store.getScene();
  if (scene) {
    const nextFit = computeFitView(scene.bounds, newWidth, newHeight);
    scene.fitView = nextFit;
    store.updateView(nextFit);
    return;
  }
  renderer.draw();
}

function viewsAlmostEqual(a, b, epsilon = 0.75) {
  if (!a || !b) {
    return false;
  }
  const scaleA = Number.isFinite(a.scale) ? a.scale : 1;
  const scaleB = Number.isFinite(b.scale) ? b.scale : 1;
  const scaleDiff = Math.abs(scaleA - scaleB);
  const offsetDiff = Math.hypot(
    (a.offsetX ?? 0) - (b.offsetX ?? 0),
    (a.offsetY ?? 0) - (b.offsetY ?? 0),
  );
  return scaleDiff < 1e-3 && offsetDiff < epsilon;
}

window.addEventListener('resize', resizeCanvas);

store.subscribe('view', view => {
  renderer.setView(view);
});

store.subscribe('scene', scene => {
  renderer.setScene(scene);
});

store.subscribe('status', message => statusBar.setStatus(message));
store.subscribe('meta', text => statusBar.setMeta(text));
store.subscribe('selection', selection => renderer.setSelection(selection));
store.subscribe('hover', hover => renderer.setHover(hover));

function getContextMenuItems(target) {
  if (!target) {
    return [];
  }
  if (target.kind === 'node') {
    return [
      { action: 'node-info', label: 'Info' },
      { action: 'node-parameters', label: 'Parameters' },
      { action: 'node-services', label: 'Services' },
    ];
  }
  if (target.kind === 'topic' || target.kind === 'topic-edge') {
    return [
      { action: 'topic-info', label: 'Info' },
      { action: 'topic-stats', label: 'Statistics' },
      { action: 'topic-echo', label: 'Echo' },
    ];
  }
  return [];
}

function handleContextMenuAction(action, target) {
  if (!action) {
    return;
  }
  void actionController.handleAction(action, target);
}

function scheduleNextRefresh() {
  if (refreshTimer) {
    window.clearTimeout(refreshTimer);
  }
  refreshTimer = window.setTimeout(() => {
    void loadGraph({ silent: true });
  }, GRAPH_REFRESH_INTERVAL_MS);
}

async function loadGraph({ manual = false, silent = false } = {}) {
  if (!silent) {
    statusBar.setBusy(true);
    store.setStatus(manual ? 'Refreshing graph…' : 'Fetching graph…');
  }
  try {
    const payload = await api.fetchGraph();
    const graph = payload.graph ?? payload;
    const changed = store.setGraph(graph, payload.fingerprint);
    const nodeCount = graph.nodes?.length ?? 0;
    const topicCount = Object.keys(graph.topics || {}).length;
    const edgeCount = graph.edges?.length ?? 0;
    const layoutEngine = graph.graphviz?.engine ? `graphviz/${graph.graphviz.engine}` : 'unavailable';
    const meta = `nodes: ${nodeCount} | topics: ${topicCount} | edges: ${edgeCount} | layout: ${layoutEngine} | fingerprint: ${payload.fingerprint ?? 'n/a'}`;
    store.setMeta(meta);
    const timestamp = new Date((payload.generated_at ?? Date.now() / 1000) * 1000);
    store.setStatus(`Last update: ${timestamp.toLocaleTimeString()}`);
    const previousScene = store.getScene();
    const scene = buildScene(graph, canvas.width, canvas.height);
    store.setScene(scene);
    const currentView = store.getView();
    const shouldAutoFit =
      changed || !previousScene || viewsAlmostEqual(currentView, previousScene?.fitView);
    if (scene.fitView && shouldAutoFit) {
      store.updateView(scene.fitView);
    }
    if (changed) {
      store.resetSelection();
      store.setHover(null);
      overlayPanel.hide();
      await topicEchoController.stop({ quiet: true });
      interactionController.clearActiveSelections();
    }
  } catch (err) {
    const message = err?.message || 'Unable to fetch graph';
    store.setStatus(`Error: ${message}`);
  } finally {
    statusBar.setBusy(false);
    scheduleNextRefresh();
  }
}

function init() {
  if (!canvas || !overlayCanvas) {
    setText(statusEl, 'Canvas elements missing from DOM.');
    return;
  }
  renderer.setView(store.getView());
  renderer.setSelection(store.getSelection());
  resizeCanvas();
  void loadGraph();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
