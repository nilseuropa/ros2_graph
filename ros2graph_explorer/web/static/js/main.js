import { GraphApi } from './api/graphApi.js';
import { buildScene, computeFitView } from './render/sceneBuilder.js';
import { GraphRenderer } from './render/graphRenderer.js';
import { ViewController } from './interaction/viewController.js';
import { InteractionController } from './interaction/interactionController.js';
import { StatusBar } from './ui/statusBar.js';
import { Store } from './state/store.js';
import { GRAPH_REFRESH_INTERVAL_MS } from './constants/index.js';
import { GeneralSettingsManager, DEFAULT_GENERAL_SETTINGS } from './state/generalSettingsManager.js';
import { setText } from './utils/dom.js';
import { ContextMenu } from './ui/contextMenu.js';
import { OverlayPanel } from './ui/overlayPanel.js';
import { ParameterEditor } from './ui/modals/parameterEditor.js';
import { ServiceCaller } from './ui/modals/serviceCaller.js';
import { NodeToolsApi } from './api/nodeToolsApi.js';
import { TopicToolsApi } from './api/topicToolsApi.js';
import { ActionController } from './controllers/actionController.js';
import { TopicEchoController } from './controllers/topicEchoController.js';
import { TopicStreamManager } from './controllers/topicStreamManager.js';
import { TopicPlotController } from './controllers/topicPlotController.js';
import { ThemeManager } from './ui/themeManager.js';

const canvas = document.getElementById('graphCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const metaEl = document.getElementById('meta');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');
const contextMenuEl = document.getElementById('contextMenu');
const canvasContainer = document.getElementById('canvasContainer');
const settingsBtn = document.getElementById('settingsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsOverlayDialog = document.getElementById('settingsOverlayDialog');
const settingsOverlayClose = document.getElementById('settingsOverlayClose');
const settingsOverlayBody = document.getElementById('settingsOverlayBody');

const {
  form: settingsForm,
  customSection: customThemeSection,
  schemeSelect: customThemeScheme,
  resetButton: customThemeResetBtn,
  colorInputs: customThemeInputs,
  generalInputs,
  tabs: settingsTabs,
} = ensureSettingsForm(settingsOverlayBody);

const themeManager = new ThemeManager();
themeManager.init();

const generalSettings = new GeneralSettingsManager();
generalSettings.init();
let generalSettingsState = generalSettings.getState() ?? { ...DEFAULT_GENERAL_SETTINGS };
generalSettings.subscribe(state => {
  const previous = generalSettingsState;
  generalSettingsState = state;
  updateSettingsForm({ generalState: generalSettingsState });
  if (state.graphRefreshIntervalMs !== previous.graphRefreshIntervalMs) {
    scheduleNextRefresh();
  }
});

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
const streamManager = new TopicStreamManager({ topicApi });
const topicEchoController = new TopicEchoController({
  streamManager,
  overlay: overlayPanel,
  statusBar,
  generalSettings,
});
const topicPlotController = new TopicPlotController({
  topicApi,
  streamManager,
  overlay: overlayPanel,
  statusBar,
  generalSettings,
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
  topicPlot: topicPlotController,
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

function handleThemeChange(state) {
  updateSettingsForm({ themeState: state });
  if (state?.graphPalette) {
    renderer.setPalette(state.graphPalette);
  }
}

themeManager.subscribe(handleThemeChange);
handleThemeChange(themeManager.getState());

let refreshTimer = null;

function ensureSettingsForm(container) {
  if (!container) {
    return {
      form: null,
      customSection: null,
      schemeSelect: null,
      resetButton: null,
      colorInputs: {},
      generalInputs: {},
      tabs: null,
    };
  }
  container.innerHTML = `
    <form id="settingsForm" class="settings-form" autocomplete="off">
      <div class="settings-tabs" role="tablist" aria-label="Settings categories">
        <button
          type="button"
          class="settings-tabs__tab"
          id="settingsTabGeneral"
          role="tab"
          data-settings-tab="general"
          aria-controls="settingsPanelGeneral"
          aria-selected="true"
          tabindex="0"
        >
          General
        </button>
        <button
          type="button"
          class="settings-tabs__tab"
          id="settingsTabTheme"
          role="tab"
          data-settings-tab="theme"
          aria-controls="settingsPanelTheme"
          aria-selected="false"
          tabindex="-1"
        >
          Theme
        </button>
      </div>
      <div class="settings-tabs__panels">
        <section
          class="settings-tabs__panel"
          id="settingsPanelGeneral"
          role="tabpanel"
          data-settings-panel="general"
          aria-labelledby="settingsTabGeneral"
        >
          <div class="settings-form__group">
            <div class="settings-form__field">
              <label for="generalGraphRefresh">Graph refresh rate (ms)</label>
              <input type="number" id="generalGraphRefresh" min="500" max="60000" step="100">
              <p class="settings-form__hint">Controls how often the graph data is fetched automatically.</p>
            </div>
            <label class="settings-form__toggle">
              <input type="checkbox" id="generalStreamAuto">
              <div class="settings-form__toggle-content">
                <span>Refresh echoes & plots on every update</span>
                <p class="settings-form__hint">Disable to refresh overlays at a fixed rate.</p>
              </div>
            </label>
            <div class="settings-form__split">
              <div class="settings-form__field">
                <label for="generalEchoRefresh">Echo refresh interval (ms)</label>
                <input type="number" id="generalEchoRefresh" min="250" max="10000" step="50">
                <p class="settings-form__hint">Applied when automatic refresh is disabled.</p>
              </div>
              <div class="settings-form__field">
                <label for="generalPlotRefresh">Plot refresh interval (ms)</label>
                <input type="number" id="generalPlotRefresh" min="250" max="10000" step="50">
                <p class="settings-form__hint">Applied when automatic refresh is disabled.</p>
              </div>
            </div>
          </div>
        </section>
        <section
          class="settings-tabs__panel"
          id="settingsPanelTheme"
          role="tabpanel"
          data-settings-panel="theme"
          aria-labelledby="settingsTabTheme"
          hidden
        >
          <fieldset class="settings-form__fieldset">
            <legend>Theme</legend>
            <label class="settings-form__option">
              <input type="radio" name="settingsTheme" value="dark">
              <span>Dark</span>
            </label>
            <label class="settings-form__option">
              <input type="radio" name="settingsTheme" value="light">
              <span>Light</span>
            </label>
            <label class="settings-form__option">
              <input type="radio" name="settingsTheme" value="custom">
              <span>Custom</span>
            </label>
          </fieldset>
          <section id="customThemeSection" class="settings-form__custom" hidden>
            <p class="settings-form__note">
              Adjust the palette to build a custom theme. Changes apply instantly while custom mode is active.
            </p>
            <div class="settings-form__field">
              <label for="customThemeScheme">Base variant</label>
              <select id="customThemeScheme">
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>
            <div class="settings-form__group">
              <h3 class="settings-form__group-title">Interface</h3>
              <div class="settings-form__colors">
                <label class="settings-form__color" for="customBg">
                  <span>Background</span>
                  <input type="color" id="customBg" name="customBg" value="#0d1117">
                </label>
                <label class="settings-form__color" for="customPanel">
                  <span>Panel</span>
                  <input type="color" id="customPanel" name="customPanel" value="#161b22">
                </label>
                <label class="settings-form__color" for="customText">
                  <span>Text</span>
                  <input type="color" id="customText" name="customText" value="#e6edf3">
                </label>
                <label class="settings-form__color" for="customAccent">
                  <span>Accent</span>
                  <input type="color" id="customAccent" name="customAccent" value="#3fb950">
                </label>
                <label class="settings-form__color" for="customAccentSecondary">
                  <span>Accent Secondary</span>
                  <input type="color" id="customAccentSecondary" name="customAccentSecondary" value="#58a6ff">
                </label>
              </div>
            </div>
            <div class="settings-form__group">
              <h3 class="settings-form__group-title">Graph Edges</h3>
              <div class="settings-form__colors">
                <label class="settings-form__color" for="customGraphEdge">
                  <span>Base</span>
                  <input type="color" id="customGraphEdge" name="customGraphEdge" value="#3a4b5e">
                </label>
                <label class="settings-form__color" for="customGraphEdgeHover">
                  <span>Hover</span>
                  <input type="color" id="customGraphEdgeHover" name="customGraphEdgeHover" value="#5cb2ff">
                </label>
                <label class="settings-form__color" for="customGraphEdgeSelect">
                  <span>Select</span>
                  <input type="color" id="customGraphEdgeSelect" name="customGraphEdgeSelect" value="#ffab3d">
                </label>
              </div>
            </div>
            <div class="settings-form__group">
              <h3 class="settings-form__group-title">Graph Nodes</h3>
              <div class="settings-form__colors">
                <label class="settings-form__color" for="customGraphNodeFill">
                  <span>Base Fill</span>
                  <input type="color" id="customGraphNodeFill" name="customGraphNodeFill" value="#2b4a65">
                </label>
                <label class="settings-form__color" for="customGraphNodeHover">
                  <span>Hover Fill</span>
                  <input type="color" id="customGraphNodeHover" name="customGraphNodeHover" value="#3f6d90">
                </label>
                <label class="settings-form__color" for="customGraphNodeSelect">
                  <span>Select Fill</span>
                  <input type="color" id="customGraphNodeSelect" name="customGraphNodeSelect" value="#4b7da1">
                </label>
              </div>
            </div>
            <div class="settings-form__group">
              <h3 class="settings-form__group-title">Graph Topics</h3>
              <div class="settings-form__colors">
                <label class="settings-form__color" for="customGraphTopicFill">
                  <span>Base Fill</span>
                  <input type="color" id="customGraphTopicFill" name="customGraphTopicFill" value="#14202c">
                </label>
                <label class="settings-form__color" for="customGraphTopicHover">
                  <span>Hover Fill</span>
                  <input type="color" id="customGraphTopicHover" name="customGraphTopicHover" value="#162331">
                </label>
                <label class="settings-form__color" for="customGraphTopicSelect">
                  <span>Select Fill</span>
                  <input type="color" id="customGraphTopicSelect" name="customGraphTopicSelect" value="#1f2e41">
                </label>
              </div>
            </div>
            <div class="settings-form__group">
              <h3 class="settings-form__group-title">Graph Labels</h3>
              <div class="settings-form__colors">
                <label class="settings-form__color" for="customGraphLabelText">
                  <span>Text</span>
                  <input type="color" id="customGraphLabelText" name="customGraphLabelText" value="#f0f6fc">
                </label>
              </div>
            </div>
            <div class="settings-form__actions">
              <button type="button" id="customThemeReset" class="secondary">Reset custom theme</button>
            </div>
          </section>
        </section>
      </div>
    </form>
  `;
  const form = container.querySelector('#settingsForm');
  const customSection = container.querySelector('#customThemeSection');
  const schemeSelect = container.querySelector('#customThemeScheme');
  const resetButton = container.querySelector('#customThemeReset');
  const colorInputs = {
    bg: container.querySelector('#customBg'),
    panel: container.querySelector('#customPanel'),
    text: container.querySelector('#customText'),
    accent: container.querySelector('#customAccent'),
    accentSecondary: container.querySelector('#customAccentSecondary'),
    graphEdge: container.querySelector('#customGraphEdge'),
    graphEdgeHover: container.querySelector('#customGraphEdgeHover'),
    graphEdgeSelect: container.querySelector('#customGraphEdgeSelect'),
    graphNodeFill: container.querySelector('#customGraphNodeFill'),
    graphNodeHover: container.querySelector('#customGraphNodeHover'),
    graphNodeSelect: container.querySelector('#customGraphNodeSelect'),
    graphTopicFill: container.querySelector('#customGraphTopicFill'),
    graphTopicHover: container.querySelector('#customGraphTopicHover'),
    graphTopicSelect: container.querySelector('#customGraphTopicSelect'),
    graphLabelText: container.querySelector('#customGraphLabelText'),
  };
  const generalInputs = {
    graphRefresh: container.querySelector('#generalGraphRefresh'),
    streamAuto: container.querySelector('#generalStreamAuto'),
    echoRefresh: container.querySelector('#generalEchoRefresh'),
    plotRefresh: container.querySelector('#generalPlotRefresh'),
  };
  const tabButtons = Array.from(container.querySelectorAll('[data-settings-tab]'));
  const tabPanels = new Map();
  container.querySelectorAll('[data-settings-panel]').forEach(panel => {
    const id = panel.dataset.settingsPanel;
    if (id) {
      tabPanels.set(id, panel);
    }
  });
  let activeTab = 'general';
  const activate = targetId => {
    if (!targetId || !tabPanels.has(targetId)) {
      return;
    }
    activeTab = targetId;
    tabButtons.forEach(button => {
      const isActive = button.dataset.settingsTab === targetId;
      button.classList.toggle('settings-tabs__tab--active', isActive);
      button.setAttribute('aria-selected', String(isActive));
      button.tabIndex = isActive ? 0 : -1;
    });
    tabPanels.forEach((panel, id) => {
      const isActive = id === targetId;
      panel.hidden = !isActive;
      panel.setAttribute('aria-hidden', String(!isActive));
    });
  };
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      activate(button.dataset.settingsTab);
    });
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const index = tabButtons.indexOf(button);
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const nextIndex = (index + delta + tabButtons.length) % tabButtons.length;
        const next = tabButtons[nextIndex];
        if (next) {
          activate(next.dataset.settingsTab);
          next.focus();
        }
      }
    });
  });
  activate(activeTab);
  const tabs = {
    buttons: tabButtons,
    activate,
    getActive: () => activeTab,
  };
  return { form, customSection, schemeSelect, resetButton, colorInputs, generalInputs, tabs };
}

function isSettingsOverlayOpen() {
  return Boolean(settingsOverlay?.classList.contains('active'));
}

function updateSettingsForm({ themeState = themeManager.getState(), generalState = generalSettingsState } = {}) {
  if (!settingsForm) {
    return;
  }
  const theme = themeState?.theme ?? themeManager.getTheme();
  const custom = themeState?.custom ?? themeManager.getState().custom;
  const themeRadios = settingsForm.querySelectorAll("input[name='settingsTheme']");
  themeRadios.forEach(radio => {
    radio.checked = radio.value === theme;
  });
  const isCustom = theme === 'custom';
  if (customThemeSection) {
    customThemeSection.hidden = !isCustom;
  }
  if (customThemeScheme) {
    customThemeScheme.value = custom?.scheme ?? 'dark';
    customThemeScheme.disabled = !isCustom;
  }
  if (customThemeResetBtn) {
    customThemeResetBtn.disabled = !isCustom;
  }
  for (const [key, input] of Object.entries(customThemeInputs)) {
    if (!input) {
      continue;
    }
    input.disabled = !isCustom;
    const value = custom?.colors?.[key];
    if (value) {
      input.value = value;
    }
  }
  if (generalInputs) {
    const generalStateSafe = generalState ?? DEFAULT_GENERAL_SETTINGS;
    const manualDisabled = Boolean(generalStateSafe.streamAutoRefresh);
    if (generalInputs.graphRefresh) {
      generalInputs.graphRefresh.value =
        generalStateSafe.graphRefreshIntervalMs ?? DEFAULT_GENERAL_SETTINGS.graphRefreshIntervalMs;
    }
    if (generalInputs.streamAuto) {
      generalInputs.streamAuto.checked = Boolean(generalStateSafe.streamAutoRefresh);
    }
    if (generalInputs.echoRefresh) {
      generalInputs.echoRefresh.value =
        generalStateSafe.echoRefreshIntervalMs ?? DEFAULT_GENERAL_SETTINGS.echoRefreshIntervalMs;
      generalInputs.echoRefresh.disabled = manualDisabled;
    }
    if (generalInputs.plotRefresh) {
      generalInputs.plotRefresh.value =
        generalStateSafe.plotRefreshIntervalMs ?? DEFAULT_GENERAL_SETTINGS.plotRefreshIntervalMs;
      generalInputs.plotRefresh.disabled = manualDisabled;
    }
  }
}

function handleGeneralSettingsControl(target) {
  if (!target || !generalInputs) {
    return false;
  }
  if (target === generalInputs.streamAuto) {
    generalSettings.update({ streamAutoRefresh: Boolean(target.checked) });
    return true;
  }
  if (target === generalInputs.graphRefresh) {
    const value = readIntegerInput(target);
    if (value !== null) {
      generalSettings.update({ graphRefreshIntervalMs: value });
    } else {
      target.value =
        generalSettingsState.graphRefreshIntervalMs ?? DEFAULT_GENERAL_SETTINGS.graphRefreshIntervalMs;
    }
    return true;
  }
  if (target === generalInputs.echoRefresh) {
    const value = readIntegerInput(target);
    if (value !== null) {
      generalSettings.update({ echoRefreshIntervalMs: value });
    } else {
      target.value =
        generalSettingsState.echoRefreshIntervalMs ?? DEFAULT_GENERAL_SETTINGS.echoRefreshIntervalMs;
    }
    return true;
  }
  if (target === generalInputs.plotRefresh) {
    const value = readIntegerInput(target);
    if (value !== null) {
      generalSettings.update({ plotRefreshIntervalMs: value });
    } else {
      target.value =
        generalSettingsState.plotRefreshIntervalMs ?? DEFAULT_GENERAL_SETTINGS.plotRefreshIntervalMs;
    }
    return true;
  }
  return false;
}

function readIntegerInput(input) {
  if (!input) {
    return null;
  }
  const value = Number.parseInt(input.value, 10);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

function isGeneralNumberInput(target) {
  if (!generalInputs) {
    return false;
  }
  return (
    target === generalInputs.graphRefresh ||
    target === generalInputs.echoRefresh ||
    target === generalInputs.plotRefresh
  );
}

function openSettingsOverlay() {
  if (!settingsOverlay) {
    return;
  }
  updateSettingsForm();
  if (settingsTabs?.activate) {
    settingsTabs.activate('general');
  }
  settingsOverlay.classList.add('active');
  settingsOverlay.setAttribute('aria-hidden', 'false');
  if (settingsBtn) {
    settingsBtn.setAttribute('aria-expanded', 'true');
  }
  window.setTimeout(() => {
    settingsOverlayDialog?.focus();
  }, 0);
}

function closeSettingsOverlay() {
  if (!settingsOverlay) {
    return;
  }
  if (!settingsOverlay.classList.contains('active')) {
    return;
  }
  settingsOverlay.classList.remove('active');
  settingsOverlay.setAttribute('aria-hidden', 'true');
  if (settingsBtn) {
    settingsBtn.setAttribute('aria-expanded', 'false');
    settingsBtn.focus();
  }
}

function handleSettingsFormChange(event) {
  const target = event.target;
  if (!target) {
    return;
  }
  if (handleGeneralSettingsControl(target)) {
    return;
  }
  if (target instanceof HTMLInputElement && target.name === 'settingsTheme') {
    themeManager.setTheme(target.value);
    return;
  }
  if (target === customThemeScheme) {
    if (themeManager.getTheme() !== 'custom') {
      themeManager.setTheme('custom');
    }
    themeManager.setCustomScheme(customThemeScheme.value);
  }
}

function handleSettingsFormInput(event) {
  const target = event.target;
  if (!target) {
    return;
  }
  if (isGeneralNumberInput(target)) {
    return;
  }
  if (handleGeneralSettingsControl(target)) {
    return;
  }
  if (!(target instanceof HTMLInputElement) || target.type !== 'color') {
    return;
  }
  for (const [key, input] of Object.entries(customThemeInputs)) {
    if (input === target) {
      if (themeManager.getTheme() !== 'custom') {
        themeManager.setTheme('custom');
      }
      themeManager.setCustomColor(key, target.value);
      break;
    }
  }
}

function handleCustomThemeReset() {
  themeManager.resetCustomTheme();
}

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
      { action: 'topic-plot', label: 'Plot' },
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
  const interval =
    generalSettingsState?.graphRefreshIntervalMs ??
    DEFAULT_GENERAL_SETTINGS.graphRefreshIntervalMs ??
    GRAPH_REFRESH_INTERVAL_MS;
  const numericInterval = Number(interval);
  const delay = Math.max(500, Number.isFinite(numericInterval) ? numericInterval : GRAPH_REFRESH_INTERVAL_MS);
  refreshTimer = window.setTimeout(() => {
    void loadGraph({ silent: true });
  }, delay);
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
  if (settingsBtn && settingsOverlay) {
    settingsBtn.addEventListener('click', () => {
      openSettingsOverlay();
    });
    settingsOverlay.addEventListener('click', event => {
      if (event.target === settingsOverlay) {
        closeSettingsOverlay();
      }
    });
  }
  if (settingsOverlayClose) {
    settingsOverlayClose.addEventListener('click', () => {
      closeSettingsOverlay();
    });
  }
  if (settingsForm) {
    settingsForm.addEventListener('change', handleSettingsFormChange);
    settingsForm.addEventListener('input', handleSettingsFormInput);
  }
  if (customThemeResetBtn) {
    customThemeResetBtn.addEventListener('click', handleCustomThemeReset);
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

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && isSettingsOverlayOpen()) {
    closeSettingsOverlay();
  }
});
