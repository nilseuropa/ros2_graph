import { DEFAULT_GENERAL_SETTINGS } from '../state/generalSettingsManager.js';

const MAX_SERIES = 4;
const WINDOW_MS = 60000;
const MAX_POINTS = 480;
const SAMPLE_TIMEOUT_MS = 4000;
const MAX_SCHEMA_ARRAY_FIELDS = 12;
const MAX_SAMPLE_ARRAY_FIELDS = 16;
const SERIES_COLORS = ['#58a6ff', '#f778ba', '#ffab3d', '#3fb950', '#a371f7', '#fb8d62'];
const EXCLUDED_TYPES = new Set([
  'sensor_msgs/msg/PointCloud2',
  'sensor_msgs/msg/PointCloud',
  'sensor_msgs/msg/Image',
  'sensor_msgs/msg/CompressedImage',
  'sensor_msgs/msg/PointCloud2Iterator',
]);

export class TopicPlotController {
  constructor({ topicApi, streamManager, overlay, statusBar, generalSettings }) {
    this.topicApi = topicApi;
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
    this.contexts = new Map(); // topic -> context
  }

  async toggle(topicName) {
    if (!topicName) {
      return;
    }
    if (this.contexts.has(topicName)) {
      await this.stop(topicName);
      return;
    }
    await this.start(topicName);
  }

  async start(topicName) {
    const existing = this.contexts.get(topicName);
    if (existing) {
      await this.stop(topicName);
    }
    const context = createContext(topicName);
    this.contexts.set(topicName, context);
    this.statusBar?.setStatus(`Loading schema for ${topicName}…`);
    try {
      const payload = await this.topicApi.getSchema(topicName, { timeout: 5000 });
      const schemas = Array.isArray(payload?.schemas) ? payload.schemas : [];
      const sampleInfo = await this.collectSampleFields(context);
      const sampleType = normalizeTypeName(sampleInfo?.type);
      const entries = schemas
        .map(entry => ({
          type: entry.type,
          fields: mergeFields(
            buildFieldList(entry.fields, entry.example),
            sampleInfo &&
              (!sampleType || normalizeTypeName(entry.type) === sampleType || schemas.length === 1)
              ? sampleInfo.fields
              : [],
          ),
        }))
        .filter(entry => entry.fields.length > 0);
      if (!entries.length) {
        this.showInfoOverlay(context, ['No numeric fields available for plotting.']);
        await this.stop(topicName);
        this.statusBar?.setStatus(`Nothing to plot for ${topicName}`);
        return;
      }
      context.schemas = entries;
      this.showSelectorOverlay(context);
      this.statusBar?.setStatus(`Select fields to plot for ${topicName}`);
    } catch (error) {
      const message = error?.message || String(error);
      this.statusBar?.setStatus(`Failed to load schema: ${message}`);
      await this.stop(topicName);
    }
  }

  async stop(topicName) {
    const context = this.contexts.get(topicName);
    if (!context) {
      return;
    }
    context.subscription?.();
    context.subscription = null;
    if (context.refreshTimer) {
      window.clearTimeout(context.refreshTimer);
      context.refreshTimer = null;
    }
    context.pendingPayload = null;
    context.latestPayload = null;
    context.lastSampleStamp = null;
    if (context.selectorOverlayId) {
      this.overlay?.hide({ id: context.selectorOverlayId });
      context.selectorOverlayId = null;
    }
    if (context.chartOverlayId) {
      this.overlay?.hide({ id: context.chartOverlayId });
      context.chartOverlayId = null;
    }
    this.contexts.delete(topicName);
  }

  async stopAll() {
    const topics = Array.from(this.contexts.keys());
    await Promise.all(topics.map(topic => this.stop(topic)));
  }

  async collectSampleFields(context) {
    try {
      const payload = await this.streams.requestSample(context.topicName, null, {
        timeout: SAMPLE_TIMEOUT_MS,
      });
      const sampleData = payload?.sample?.message ?? payload?.sample?.data;
      if (!sampleData) {
        return null;
      }
      return {
        type: payload?.type,
        fields: buildFieldsFromSample(sampleData),
      };
    } catch {
      return null;
    }
  }

  showSelectorOverlay(context) {
    const { topicName, schemas } = context;
    const overlayId = buildSelectorId(topicName);
    const form = document.createElement('form');
    form.className = 'topic-plot-selector';

    const typeControl = document.createElement('div');
    typeControl.className = 'topic-plot-selector__control';
    const typeLabel = document.createElement('label');
    typeLabel.textContent = 'Message type';
    const typeSelect = document.createElement('select');
    typeSelect.className = 'topic-plot-selector__select';
    schemas.forEach(entry => {
      const option = document.createElement('option');
      option.value = entry.type;
      option.textContent = entry.type;
      typeSelect.appendChild(option);
    });
    typeLabel.appendChild(typeSelect);
    typeControl.appendChild(typeLabel);
    if (schemas.length > 1) {
      form.appendChild(typeControl);
    }

    const countLabel = document.createElement('div');
    countLabel.className = 'topic-plot-selector__count';
    form.appendChild(countLabel);

    const fieldList = document.createElement('div');
    fieldList.className = 'topic-plot-selector__fields';
    form.appendChild(fieldList);

    const actions = document.createElement('div');
    actions.className = 'topic-plot-selector__actions';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.textContent = 'Plot';
    submitBtn.disabled = true;
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      this.overlay?.hide({ id: overlayId });
      this.stop(context.topicName).catch(() => {});
    });
    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);

    const renderFields = typeName => {
      const entry = schemas.find(item => item.type === typeName) || schemas[0];
      fieldList.innerHTML = '';
      if (!entry || !entry.fields.length) {
        const empty = document.createElement('p');
        empty.textContent = 'No numeric fields available.';
        fieldList.appendChild(empty);
        submitBtn.disabled = true;
        countLabel.textContent = 'Select up to 0 fields';
        return;
      }
      entry.fields.forEach(field => {
        const option = document.createElement('label');
        option.className = 'topic-plot-selector__option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'plot-field';
        input.value = field.path;
        option.appendChild(input);
        const content = document.createElement('div');
        content.className = 'topic-plot-selector__option-content';
        const title = document.createElement('div');
        title.className = 'topic-plot-selector__option-label';
        title.textContent = field.displayName;
        const hint = document.createElement('div');
        hint.className = 'topic-plot-selector__option-hint';
        hint.textContent = `${field.path} • ${field.type}`;
        content.appendChild(title);
        content.appendChild(hint);
        option.appendChild(content);
        fieldList.appendChild(option);
      });
      updateSelectionState();
    };

    const updateSelectionState = () => {
      const inputs = Array.from(fieldList.querySelectorAll('input[type="checkbox"]'));
      const selectedCount = inputs.filter(input => input.checked).length;
      countLabel.textContent = `Select up to ${MAX_SERIES} field${MAX_SERIES > 1 ? 's' : ''} (${selectedCount} chosen)`;
      submitBtn.disabled = selectedCount === 0;
      inputs.forEach(input => {
        input.parentElement?.classList.toggle('topic-plot-selector__option--selected', input.checked);
        input.disabled = !input.checked && selectedCount >= MAX_SERIES;
      });
    };

    fieldList.addEventListener('change', event => {
      if (event.target?.matches('input[type="checkbox"]')) {
        updateSelectionState();
      }
    });

    form.addEventListener('submit', event => {
      event.preventDefault();
      const typeName = typeSelect.value || schemas[0]?.type;
      const entry = schemas.find(item => item.type === typeName) || schemas[0];
      if (!entry) {
        return;
      }
      const selected = Array.from(fieldList.querySelectorAll('input[type="checkbox"]:checked'))
        .map(input => entry.fields.find(field => field.path === input.value))
        .filter(Boolean);
      if (!selected.length) {
        return;
      }
      this.beginPlot(context, entry.type, selected).catch(error => {
        const message = error?.message || String(error);
        this.statusBar?.setStatus(`Unable to start plot: ${message}`);
      });
    });

    renderFields(typeSelect.value || schemas[0].type);

    this.overlay?.show(
      {
        title: 'Plot',
        subtitle: topicName,
        sections: [
          {
            type: 'custom',
            render: container => {
              container.classList.add('topic-plot-selector__section');
              container.appendChild(form);
            },
          },
        ],
      },
      { id: overlayId },
    );
    context.selectorOverlayId = overlayId;
    context.ignoreSelectorClose = false;
    this.attachOverlayCloseHandler(overlayId, () => {
      if (context.ignoreSelectorClose) {
        context.ignoreSelectorClose = false;
        return;
      }
      if (!context.subscription) {
        this.stop(context.topicName).catch(() => {});
      }
    });
    typeSelect.addEventListener('change', () => renderFields(typeSelect.value));
  }

  async beginPlot(context, typeName, fields) {
    if (context.selectorOverlayId) {
      context.ignoreSelectorClose = true;
      this.overlay?.hide({ id: context.selectorOverlayId });
    }
    context.selectorOverlayId = null;
    context.subscription?.();
    context.subscription = null;
    context.datasets = fields.map((field, index) => ({
      path: field.path,
      segments: parseSegments(field.path),
      label: field.displayName,
      rawPath: field.path,
      type: field.type,
      color: SERIES_COLORS[index % SERIES_COLORS.length],
      points: [],
      lastValue: null,
      valueEl: null,
    }));
    context.pendingPayload = null;
    context.latestPayload = null;
    context.lastRenderAt = 0;
    context.lastSampleStamp = null;
    if (context.refreshTimer) {
      window.clearTimeout(context.refreshTimer);
      context.refreshTimer = null;
    }
    context.selectedType = typeName;
    this.showPlotOverlay(context);
    context.subscription = this.streams.subscribe(context.topicName, null, payload => {
      this.handleStreamPayload(context, payload);
    });
  }

  handleStreamPayload(context, payload) {
    if (!context) {
      return;
    }
    const nextPayload = payload ?? null;
    context.pendingPayload = nextPayload;
    if (nextPayload) {
      context.latestPayload = nextPayload;
    }
    if (this.shouldAutoRefresh()) {
      this.flushPendingPayload(context);
      return;
    }
    this.schedulePlotRefresh(context);
  }

  flushPendingPayload(context) {
    if (!context) {
      return;
    }
    const payload = context.pendingPayload ?? context.latestPayload;
    context.pendingPayload = null;
    if (payload) {
      this.renderStreamPayload(context, payload);
    }
  }

  renderStreamPayload(context, payload) {
    if (!payload?.sample) {
      this.statusBar?.setStatus(`Waiting for samples on ${context.topicName}…`);
      return;
    }
    const message = payload.sample.message ?? payload.sample.data;
    if (!message) {
      return;
    }
    const sampleStamp = buildSampleStamp(payload.sample);
    if (sampleStamp && sampleStamp === context.lastSampleStamp) {
      return;
    }
    const timestamp = extractTimestamp(payload.sample);
    this.statusBar?.setStatus(
      `Plotting ${context.topicName}: last update ${timestamp.toLocaleTimeString()}`,
    );
    const updated = this.appendSample(context, timestamp.getTime(), message);
    context.lastSampleStamp = sampleStamp ?? context.lastSampleStamp;
    if (updated) {
      this.updateLegend(context);
      this.drawChart(context);
    }
    context.lastRenderAt = Date.now();
  }

  schedulePlotRefresh(context) {
    if (!context?.pendingPayload) {
      return;
    }
    const interval = this.getPlotRefreshInterval();
    const elapsed = Date.now() - (context.lastRenderAt ?? 0);
    if (elapsed >= interval) {
      this.flushPendingPayload(context);
      return;
    }
    if (context.refreshTimer) {
      return;
    }
    const delay = Math.max(0, interval - elapsed);
    context.refreshTimer = window.setTimeout(() => {
      context.refreshTimer = null;
      this.flushPendingPayload(context);
    }, delay);
  }

  shouldAutoRefresh() {
    return Boolean(this.generalSettingsState?.streamAutoRefresh ?? true);
  }

  getPlotRefreshInterval() {
    const value =
      this.generalSettingsState?.plotRefreshIntervalMs ?? DEFAULT_GENERAL_SETTINGS.plotRefreshIntervalMs;
    const numeric = Number(value);
    const clamped = Number.isFinite(numeric) ? numeric : DEFAULT_GENERAL_SETTINGS.plotRefreshIntervalMs;
    return Math.max(250, clamped);
  }

  applyGeneralSettings() {
    if (!this.contexts.size) {
      return;
    }
    this.contexts.forEach(context => {
      if (context.refreshTimer) {
        window.clearTimeout(context.refreshTimer);
        context.refreshTimer = null;
      }
    });
    if (this.shouldAutoRefresh()) {
      this.contexts.forEach(context => {
        this.flushPendingPayload(context);
      });
      return;
    }
    this.contexts.forEach(context => {
      if (context.pendingPayload) {
        this.schedulePlotRefresh(context);
      }
    });
  }

  appendSample(context, timestampMs, message) {
    if (!context.datasets.length) {
      return false;
    }
    let changed = false;
    const cutoff = timestampMs - WINDOW_MS;
    context.datasets.forEach(dataset => {
      const value = getValueAtPath(message, dataset.segments);
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) {
        return;
      }
      dataset.points.push({ t: timestampMs, v: numericValue });
      if (dataset.points.length > MAX_POINTS) {
        dataset.points.splice(0, dataset.points.length - MAX_POINTS);
      }
      while (dataset.points.length && dataset.points[0].t < cutoff) {
        dataset.points.shift();
      }
      dataset.lastValue = numericValue;
      changed = true;
    });
    return changed;
  }

  showPlotOverlay(context) {
    const overlayId = buildChartId(context.topicName);
    const legend = document.createElement('div');
    legend.className = 'topic-plot__legend';
    const canvasWrapper = document.createElement('div');
    canvasWrapper.className = 'topic-plot__canvas-wrapper';
    const canvas = document.createElement('canvas');
    canvas.className = 'topic-plot__canvas';
    canvasWrapper.appendChild(canvas);
    const status = document.createElement('div');
    status.className = 'topic-plot__status';
    status.textContent = 'Awaiting samples…';
    const container = document.createElement('div');
    container.className = 'topic-plot';
    container.appendChild(legend);
    container.appendChild(canvasWrapper);
    container.appendChild(status);

    this.overlay?.show(
      {
        title: 'Plot',
        subtitle: `${context.topicName} (${context.selectedType})`,
        sections: [
          {
            type: 'custom',
            render: wrapper => {
              wrapper.classList.add('topic-plot__section');
              wrapper.appendChild(container);
            },
          },
        ],
      },
      { id: overlayId },
    );
    context.chartOverlayId = overlayId;
    context.chart = { legendEl: legend, canvas, wrapper: canvasWrapper, statusEl: status };
    this.renderLegend(context);
    this.attachOverlayCloseHandler(overlayId, () => {
      this.stop(context.topicName).catch(() => {});
    });
    this.drawChart(context);
  }

  renderLegend(context) {
    const chart = context.chart;
    if (!chart) {
      return;
    }
    chart.legendEl.innerHTML = '';
    context.datasets.forEach(dataset => {
      const item = document.createElement('div');
      item.className = 'topic-plot__legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'topic-plot__legend-swatch';
      swatch.style.backgroundColor = dataset.color;
      const text = document.createElement('div');
      text.className = 'topic-plot__legend-text';
      const label = document.createElement('div');
      label.className = 'topic-plot__legend-label';
      label.textContent = dataset.label;
      const hint = document.createElement('div');
      hint.className = 'topic-plot__legend-hint';
      hint.textContent = dataset.rawPath;
      text.appendChild(label);
      text.appendChild(hint);
      const value = document.createElement('div');
      value.className = 'topic-plot__legend-value';
      value.textContent = '—';
      dataset.valueEl = value;
      item.appendChild(swatch);
      item.appendChild(text);
      item.appendChild(value);
      chart.legendEl.appendChild(item);
    });
  }

  updateLegend(context) {
    context.datasets.forEach(dataset => {
      if (dataset.valueEl) {
        dataset.valueEl.textContent = formatValue(dataset.lastValue);
      }
    });
  }

  drawChart(context) {
    const chart = context.chart;
    if (!chart) {
      return;
    }
    const canvas = chart.canvas;
    const wrapper = chart.wrapper;
    const width = Math.max(320, wrapper.clientWidth || 0);
    const height = Math.max(220, wrapper.clientHeight || 0);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, width, height);
    const datasets = context.datasets.filter(ds => ds.points.length);
    if (!datasets.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '14px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for samples…', width / 2, height / 2);
      return;
    }
    const padding = 32;
    const timeMin = Math.min(...datasets.map(ds => ds.points[0].t));
    const timeMax = Math.max(...datasets.map(ds => ds.points[ds.points.length - 1].t));
    const valueMin = Math.min(...datasets.map(ds => Math.min(...ds.points.map(pt => pt.v))));
    const valueMax = Math.max(...datasets.map(ds => Math.max(...ds.points.map(pt => pt.v))));
    const timeRange = Math.max(1, timeMax - timeMin);
    const valueRange = Math.max(1e-6, valueMax - valueMin);
    const textRgb = getComputedStyle(document.body).getPropertyValue('--text-rgb')?.trim() || '255,255,255';
    const axisColor = `rgba(${textRgb}, 0.35)`;
    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, height - padding);
    ctx.lineTo(width - padding, height - padding);
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, height - padding);
    ctx.stroke();

    datasets.forEach(dataset => {
      ctx.beginPath();
      dataset.points.forEach((point, index) => {
        const x = padding + ((point.t - timeMin) / timeRange) * Math.max(1, width - padding * 2);
        const y =
          height -
          padding -
          ((point.v - valueMin) / valueRange) * Math.max(1, height - padding * 2);
        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.strokeStyle = dataset.color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    });
  }

  attachOverlayCloseHandler(overlayId, handler) {
    if (!overlayId || !handler) {
      return;
    }
    const root = findOverlayRoot(overlayId);
    if (!root) {
      return;
    }
    const listener = event => {
      if (event?.detail?.id === overlayId) {
        handler();
      }
    };
    root.addEventListener('overlaypanel:close', listener, { once: true });
  }
}

function createContext(topicName) {
  return {
    topicName,
    schemas: [],
    datasets: [],
    selectedType: null,
    selectorOverlayId: null,
    ignoreSelectorClose: false,
    chartOverlayId: null,
    chart: null,
    subscription: null,
    pendingPayload: null,
    latestPayload: null,
    lastRenderAt: 0,
    refreshTimer: null,
    lastSampleStamp: null,
  };
}

function buildFieldList(fields, example) {
  const map = new Map();
  const nodes = Array.isArray(fields) ? fields : [];
  const walk = (target, prefix) => {
    target.forEach(entry => {
      if (!entry?.name) {
        return;
      }
      const path = prefix ? `${prefix}.${entry.name}` : entry.name;
      if (entry.is_array) {
        const elementType = entry.element_type || entry.base_type || entry.type || '';
        if (!isNumericType(elementType)) {
          return;
        }
        const countHint = resolveArrayCount(entry);
        if (!countHint) {
          return;
        }
        const limit = Math.min(countHint, MAX_SCHEMA_ARRAY_FIELDS);
        for (let i = 0; i < limit; i += 1) {
          appendField(map, `${path}[${i}]`, elementType);
        }
        return;
      }
      const baseType = entry.base_type || entry.type || '';
      if (isNumericType(baseType)) {
        appendField(map, path, baseType);
        return;
      }
      if (EXCLUDED_TYPES.has(baseType)) {
        return;
      }
      if (entry.children && entry.children.length) {
        walk(entry.children, path);
      }
    });
  };
  walk(nodes, '');
  if (example && typeof example === 'object') {
    traverseSample(example, '', (path, value) => {
      appendField(map, path, typeof value === 'number' ? 'number' : 'unknown');
    });
  }
  return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function buildFieldsFromSample(sample) {
  const map = new Map();
  traverseSample(sample, '', (path, value) => {
    appendField(map, path, typeof value === 'number' ? 'number' : 'unknown');
  });
  return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function mergeFields(baseFields, sampleFields) {
  const map = new Map();
  [...(baseFields || []), ...(sampleFields || [])].forEach(field => {
    if (!field?.path || map.has(field.path)) {
      return;
    }
    map.set(field.path, field);
  });
  return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function appendField(map, path, type) {
  if (!path || map.has(path)) {
    return;
  }
  map.set(path, {
    path,
    segments: parseSegments(path),
    displayName: formatDisplayName(path),
    type: type || 'number',
  });
}

function resolveArrayCount(entry) {
  if (Number.isFinite(entry.array_size) && entry.array_size > 0) {
    return entry.array_size;
  }
  if (Number.isFinite(entry.max_size) && entry.max_size > 0) {
    return entry.max_size;
  }
  return null;
}

function parseSegments(path) {
  if (!path) {
    return [];
  }
  return path.split('.').filter(Boolean);
}

function traverseSample(value, prefix, onValue) {
  if (value == null) {
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (prefix) {
      onValue(prefix, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_SAMPLE_ARRAY_FIELDS);
    for (let i = 0; i < limit; i += 1) {
      const path = prefix ? `${prefix}[${i}]` : `[${i}]`;
      traverseSample(value[i], path, onValue);
    }
    return;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      traverseSample(child, path, onValue);
    });
  }
}

function getValueAtPath(obj, segments) {
  return segments.reduce((current, segment) => {
    if (current == null) {
      return undefined;
    }
    const steps = parseSegmentSteps(segment);
    let value = current;
    for (const step of steps) {
      if (value == null) {
        return undefined;
      }
      if (typeof step === 'number') {
        value = Array.isArray(value) ? value[step] : undefined;
      } else {
        value = value[step];
      }
    }
    return value;
  }, obj);
}

function parseSegmentSteps(segment) {
  const steps = [];
  const pattern = /([^\[\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = pattern.exec(segment || ''))) {
    if (match[1]) {
      steps.push(match[1]);
    } else if (match[2]) {
      steps.push(Number(match[2]));
    }
  }
  return steps.length ? steps : segment ? [segment] : [];
}

function formatDisplayName(path) {
  return path
    .split('.')
    .map(chunk =>
      chunk
        .split('_')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' '),
    )
    .join(' · ');
}

function formatValue(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  if (Math.abs(value) >= 1000 || Math.abs(value) < 0.01) {
    return value.toExponential(2);
  }
  return value.toFixed(3);
}

function extractTimestamp(sample) {
  const source = sample?.received_at;
  const iso = sample?.received_iso;
  let timestamp = Number.isFinite(source) ? new Date(source * 1000) : iso ? new Date(iso) : new Date();
  if (Number.isNaN(timestamp.getTime())) {
    timestamp = new Date();
  }
  return timestamp;
}

function buildSelectorId(topicName) {
  return `topic-plot-select:${topicName}`;
}

function buildChartId(topicName) {
  return `topic-plot:${topicName}`;
}

function normalizeTypeName(typeName) {
  if (!typeName || typeof typeName !== 'string') {
    return '';
  }
  return typeName.replace(/^\/+/, '').toLowerCase();
}

function isNumericType(typeName = '') {
  return /^(u?int(8|16|32|64)|float(32|64)?|double|float)$/.test(String(typeName).toLowerCase());
}

function findOverlayRoot(id) {
  if (!id) {
    return null;
  }
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
  return document.querySelector(`[data-overlay-id="${escaped}"]`);
}

function buildSampleStamp(sample) {
  if (!sample) {
    return null;
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
