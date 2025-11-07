const MAX_SERIES = 4;
const POLL_INTERVAL_MS = 750;
const SAMPLE_POLL_INTERVAL_MS = 400;
const SAMPLE_FETCH_TIMEOUT_MS = 3000;
const MAX_SCHEMA_ARRAY_FIELDS = 12;
const MAX_SAMPLE_ARRAY_FIELDS = 16;
const WINDOW_MS = 60000;
const MAX_POINTS = 480;
const SERIES_COLORS = ['#58a6ff', '#f778ba', '#ffab3d', '#3fb950', '#a371f7', '#fb8d62'];
const EXCLUDED_TYPES = new Set([
  'sensor_msgs/msg/PointCloud2',
  'sensor_msgs/msg/PointCloud',
  'sensor_msgs/msg/Image',
  'sensor_msgs/msg/CompressedImage',
  'sensor_msgs/msg/PointCloud2Iterator',
]);

export class TopicPlotController {
  constructor({ topicApi, overlay, statusBar }) {
    this.topicApi = topicApi;
    this.overlay = overlay;
    this.statusBar = statusBar;
    this.state = new Map();
    this.boundDraw = () => this.drawChart();
    this.previewStreams = new Map();
  }

  async toggle(topicName) {
    const key = buildOverlayIdForTopic(topicName);
    if (this.state.has(key)) {
      await this.stop(topicName);
      return;
    }
    await this.start(topicName);
  }

  async start(topicName) {
    await this.stop(topicName);
    const context = createPlotContext(topicName);
    this.state.set(context.id, context);
    this.statusBar?.setStatus(`Loading schema for ${topicName}…`);
    try {
      const payload = await this.topicApi.getSchema(topicName, { timeout: 5000 });
      const schemas = Array.isArray(payload?.schemas) ? payload.schemas : [];
      let sampleInfo = null;
      try {
        sampleInfo = await this.collectSampleFields(topicName);
      } catch (error) {
        const message = error?.message || String(error);
        this.statusBar?.setStatus(`Sample unavailable: ${message}`);
      }
      const sampleType = normalizeTypeName(sampleInfo?.type);
      const entries = schemas
        .map(entry => ({
          type: entry.type,
          fields: mergeFieldCandidates(
            buildPlotFieldList(entry.fields, entry.example),
            sampleInfo &&
              (!sampleType || normalizeTypeName(entry.type) === sampleType || schemas.length === 1)
              ? sampleInfo.fields
              : [],
          ),
        }))
        .filter(entry => entry.fields.length > 0);
      if (!entries.length) {
        this.showInfoOverlay(context);
        this.statusBar?.setStatus(`Nothing to plot for ${topicName}`);
        this.state.delete(context.id);
        return;
      }
      context.schemas = entries;
      this.showSelectionOverlay(context);
      this.statusBar?.setStatus(`Select fields to plot for ${topicName}`);
    } catch (error) {
      const message = error?.message || String(error);
      this.statusBar?.setStatus(`Failed to load schema: ${message}`);
      this.state.delete(context.id);
    }
  }

  async stop(topicName) {
    const contextId = topicName ? buildOverlayIdForTopic(topicName) : null;
    if (contextId && this.state.has(contextId)) {
      const context = this.state.get(contextId);
      await this.stopStreaming(context);
      await this.stopPreviewStream(context);
      this.overlay?.hide({ id: context.selectionOverlayId });
      this.overlay?.hide({ id: context.chartOverlayId });
      this.state.delete(contextId);
      return;
    }
    const entries = Array.from(this.state.values());
    await Promise.all(entries.map(entry => this.stop(entry.topicName)));
  }

  showInfoOverlay(context) {
    const overlayId = buildSelectionOverlayId(context.topicName);
    this.overlay?.show(
      {
        title: 'Plot',
        subtitle: context.topicName,
        sections: [
          {
            type: 'text',
            text: ['No numeric fields available for plotting.'],
          },
        ],
      },
      { id: overlayId },
    );
    this.attachOverlayCloseHandler(overlayId, () => {
      this.state.delete(context.id);
    });
    context.selectionOverlayId = overlayId;
  }

  showSelectionOverlay(context) {
    const { topicName, schemas } = context;
    const overlayId = buildSelectionOverlayId(topicName);
    const form = document.createElement('form');
    form.className = 'topic-plot-selector';

    const typeControl = document.createElement('div');
    typeControl.className = 'topic-plot-selector__control';
    const typeLabel = document.createElement('label');
    typeLabel.textContent = 'Message type';
    const typeSelect = document.createElement('select');
    typeSelect.className = 'topic-plot-selector__select';
    entries.forEach(entry => {
      const option = document.createElement('option');
      option.value = entry.type;
      option.textContent = entry.type;
      typeSelect.appendChild(option);
    });
    typeLabel.appendChild(typeSelect);
    typeControl.appendChild(typeLabel);
    if (entries.length > 1) {
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
    });
    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);

    const renderFields = typeName => {
      const entry = entries.find(item => item.type === typeName) || entries[0];
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
        const label = document.createElement('label');
        label.className = 'topic-plot-selector__option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'plot-field';
        input.value = field.path;
        label.appendChild(input);

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
        label.appendChild(content);
        fieldList.appendChild(label);
      });
      updateSelectionState();
    };

    const updateSelectionState = () => {
      const inputs = Array.from(fieldList.querySelectorAll('input[type="checkbox"]'));
      const selectedCount = inputs.filter(input => input.checked).length;
      countLabel.textContent = `Select up to ${MAX_SERIES} field${MAX_SERIES > 1 ? 's' : ''} (${selectedCount} chosen)`;
      submitBtn.disabled = selectedCount === 0;
      inputs.forEach(input => {
        if (input.checked) {
          input.parentElement?.classList.add('topic-plot-selector__option--selected');
        } else {
          input.parentElement?.classList.remove('topic-plot-selector__option--selected');
        }
        if (!input.checked) {
          input.disabled = selectedCount >= MAX_SERIES;
        } else {
          input.disabled = false;
        }
      });
    };

    fieldList.addEventListener('change', event => {
      if (event.target?.matches('input[type="checkbox"]')) {
        updateSelectionState();
      }
    });

    form.addEventListener('submit', event => {
      event.preventDefault();
      const typeName = typeSelect.value || (entries[0] && entries[0].type);
      const entry = entries.find(item => item.type === typeName) || entries[0];
      if (!entry) {
        return;
      }
      const inputs = Array.from(fieldList.querySelectorAll('input[type="checkbox"]:checked'));
      const selected = inputs
        .map(input => entry.fields.find(field => field.path === input.value))
        .filter(Boolean);
      if (!selected.length) {
        return;
      }
      this.beginPlot(entry.type, selected);
    });

    typeSelect.addEventListener('change', () => {
      renderFields(typeSelect.value);
    });

    renderFields(typeSelect.value || entries[0].type);

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
    this.attachOverlayCloseHandler(overlayId, () => {
      if (this.state.selectionOverlayId === overlayId) {
        this.state.selectionOverlayId = null;
      }
    });
    this.state.selectionOverlayId = overlayId;
  }

  async collectSampleFields(topicName) {
    await this.stopPreviewStream();
    this.statusBar?.setStatus(`Waiting for sample from ${topicName}…`);
    let payload;
    try {
      payload = await this.topicApi.echo(topicName, { mode: 'start' });
    } catch (error) {
      throw error;
    }
    const streamId = payload?.stream_id;
    if (!streamId) {
      throw new Error('sample stream unavailable');
    }
    this.preview.streamId = streamId;
    this.preview.topic = topicName;
    this.preview.type = payload?.type || null;
    try {
      const sample = await this.waitForSample(topicName, payload);
      const fields = buildFieldsFromSample(sample?.message ?? sample?.data);
      const sampleType = this.preview.type;
      if (!fields.length) {
        return null;
      }
      return {
        type: sampleType,
        fields,
      };
    } finally {
      await this.stopPreviewStream();
    }
  }

  async waitForSample(topicName, initialPayload) {
    let payload = initialPayload;
    const deadline = Date.now() + SAMPLE_FETCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const sample = payload?.sample;
      if (sample && (sample.message || sample.data)) {
        return sample;
      }
      if (!this.preview.streamId) {
        break;
      }
      await delay(SAMPLE_POLL_INTERVAL_MS);
      payload = await this.topicApi.echo(topicName, {
        mode: 'poll',
        stream: this.preview.streamId,
      });
    }
    return payload?.sample || null;
  }

  async beginPlot(typeName, fields) {
    const topicName = this.state.topicName;
    if (!topicName) {
      return;
    }
    await this.stopPreviewStream();
    if (this.state.selectionOverlayId) {
      this.overlay?.hide({ id: this.state.selectionOverlayId });
      this.state.selectionOverlayId = null;
    }
    await this.stopStreaming({ skipOverlay: true });
    this.state.selectedType = typeName;
    this.state.datasets = fields.map((field, index) => ({
      path: field.path,
      pathSegments: pathToSegments(field.path),
      label: field.displayName,
      rawPath: field.path,
      type: field.type,
      color: SERIES_COLORS[index % SERIES_COLORS.length],
      points: [],
      lastValue: null,
      valueEl: null,
    }));

    try {
      const payload = await this.topicApi.echo(topicName, { mode: 'start' });
      const streamId = payload?.stream_id;
      if (!streamId) {
        throw new Error('stream unavailable');
      }
      this.state.streamId = streamId;
      this.state.active = true;
      this.statusBar?.setStatus(`Plotting ${fields.length} field(s) from ${topicName}`);
      this.showPlotOverlay();
      this.handlePayload(payload);
      this.schedulePoll();
    } catch (error) {
      await this.stopStreaming({ skipOverlay: true });
      const message = error?.message || String(error);
      this.statusBar?.setStatus(`Failed to start plot: ${message}`);
    }
  }

  async stopStreaming({ skipOverlay = false } = {}) {
    if (this.state.pollTimer) {
      window.clearTimeout(this.state.pollTimer);
      this.state.pollTimer = null;
    }
    if (this.state.streamId && this.state.topicName) {
      try {
        await this.topicApi.echo(this.state.topicName, {
          mode: 'stop',
          stream: this.state.streamId,
        });
      } catch {
        /* ignore stop errors */
      }
    }
    this.state.streamId = null;
    this.state.active = false;
    this.state.datasets = [];
    this.state.selectedType = null;
    await this.stopPreviewStream();
    if (!skipOverlay && this.state.chartOverlayId) {
      this.overlay?.hide({ id: this.state.chartOverlayId });
      this.state.chartOverlayId = null;
    } else if (skipOverlay && this.state.chartOverlayId) {
      this.state.chartOverlayId = null;
    }
    this.detachChartView();
  }

  schedulePoll() {
    if (!this.state.active || !this.state.streamId) {
      return;
    }
    this.state.pollTimer = window.setTimeout(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
  }

  async poll() {
    if (!this.state.active || !this.state.streamId || !this.state.topicName) {
      return;
    }
    try {
      const payload = await this.topicApi.echo(this.state.topicName, {
        mode: 'poll',
        stream: this.state.streamId,
      });
      this.handlePayload(payload);
      this.schedulePoll();
    } catch (error) {
      const message = error?.message || String(error);
      this.statusBar?.setStatus(`Plot stream failed: ${message}`);
      await this.stopStreaming();
    }
  }

  handlePayload(payload) {
    if (!payload || !this.state.active) {
      return;
    }
    if (payload.stream_id) {
      this.state.streamId = payload.stream_id;
    }
    if (payload.stopped) {
      void this.stopStreaming();
      this.statusBar?.setStatus('Plot stopped');
      return;
    }
    const sample = payload.sample;
    if (!sample) {
      if (this.chartView?.statusEl) {
        this.chartView.statusEl.textContent = 'Waiting for samples…';
      }
      return;
    }
    const message = sample.message ?? sample.data;
    if (!message) {
      return;
    }
    const timestampSeconds = typeof sample.received_at === 'number' ? sample.received_at : Date.now() / 1000;
    const timestamp = timestampSeconds * 1000;
    const updated = this.appendSample(timestamp, message);
    if (updated) {
      this.updateLegend();
      this.drawChart();
      if (this.chartView?.statusEl) {
        const iso = sample.received_iso || new Date(timestamp).toLocaleTimeString();
        this.chartView.statusEl.textContent = `Last update: ${iso}`;
      }
    }
  }

  appendSample(timestamp, message) {
    if (!this.state.datasets.length) {
      return false;
    }
    let changed = false;
    const cutoff = timestamp - WINDOW_MS;
    this.state.datasets.forEach(dataset => {
      const value = getValueAtPath(message, dataset.pathSegments);
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) {
        return;
      }
      dataset.points.push({ t: timestamp, v: numericValue });
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

  showPlotOverlay() {
    const topicName = this.state.topicName;
    if (!topicName || !this.state.datasets.length) {
      return;
    }
    const overlayId = buildPlotOverlayId(topicName);
    const container = document.createElement('div');
    container.className = 'topic-plot';

    const legend = document.createElement('div');
    legend.className = 'topic-plot__legend';
    container.appendChild(legend);

    const canvasWrapper = document.createElement('div');
    canvasWrapper.className = 'topic-plot__canvas-wrapper';
    const canvas = document.createElement('canvas');
    canvas.className = 'topic-plot__canvas';
    canvasWrapper.appendChild(canvas);
    container.appendChild(canvasWrapper);

    const status = document.createElement('div');
    status.className = 'topic-plot__status';
    status.textContent = 'Awaiting samples…';
    container.appendChild(status);

    this.overlay?.show(
      {
        title: 'Plot',
        subtitle: `${topicName} (${this.state.selectedType})`,
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
    this.state.chartOverlayId = overlayId;
    this.attachOverlayCloseHandler(overlayId, () => {
      void this.stopStreaming({ skipOverlay: true });
    });
    this.chartView = {
      canvas,
      legendEl: legend,
      statusEl: status,
      wrapper: canvasWrapper,
      resizeObserver: null,
      resizeHandler: null,
    };
    this.renderLegend();
    this.observeCanvas();
    this.drawChart();
  }

  detachChartView() {
    if (this.chartView?.resizeObserver) {
      this.chartView.resizeObserver.disconnect();
    }
    if (this.chartView?.resizeHandler) {
      window.removeEventListener('resize', this.chartView.resizeHandler);
    }
    this.chartView = null;
    this.state.datasets.forEach(dataset => {
      dataset.valueEl = null;
    });
  }

  async stopPreviewStream() {
    if (!this.preview.streamId) {
      return;
    }
    const topicName = this.preview.topic || this.state.topicName;
    try {
      if (topicName) {
        await this.topicApi.echo(topicName, {
          mode: 'stop',
          stream: this.preview.streamId,
        });
      }
    } catch {
      /* ignore */
    }
    this.preview.streamId = null;
    this.preview.topic = null;
    this.preview.type = null;
    this.preview.fields = [];
  }

  observeCanvas() {
    if (!this.chartView) {
      return;
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.chartView.resizeObserver = new ResizeObserver(() => this.drawChart());
      this.chartView.resizeObserver.observe(this.chartView.wrapper);
    } else {
      this.chartView.resizeHandler = () => this.drawChart();
      window.addEventListener('resize', this.chartView.resizeHandler);
    }
  }

  renderLegend() {
    if (!this.chartView) {
      return;
    }
    const legend = this.chartView.legendEl;
    legend.innerHTML = '';
    this.state.datasets.forEach(dataset => {
      const item = document.createElement('div');
      item.className = 'topic-plot__legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'topic-plot__legend-swatch';
      swatch.style.backgroundColor = dataset.color;
      const label = document.createElement('div');
      label.className = 'topic-plot__legend-label';
      label.textContent = dataset.label;
      const hint = document.createElement('div');
      hint.className = 'topic-plot__legend-hint';
      hint.textContent = dataset.rawPath;
      const value = document.createElement('div');
      value.className = 'topic-plot__legend-value';
      value.textContent = '—';
      dataset.valueEl = value;

      const text = document.createElement('div');
      text.className = 'topic-plot__legend-text';
      text.appendChild(label);
      text.appendChild(hint);

      item.appendChild(swatch);
      item.appendChild(text);
      item.appendChild(value);
      legend.appendChild(item);
    });
  }

  updateLegend() {
    this.state.datasets.forEach(dataset => {
      if (dataset.valueEl) {
        dataset.valueEl.textContent = formatValue(dataset.lastValue);
      }
    });
  }

  drawChart() {
    if (!this.chartView) {
      return;
    }
    const { canvas, wrapper } = this.chartView;
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
    const datasets = this.state.datasets.filter(dataset => dataset.points.length);
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

    const rootStyles = getComputedStyle(document.body);
    const textRgb = rootStyles.getPropertyValue('--text-rgb')?.trim() || '255,255,255';
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
        const x =
          padding + ((point.t - timeMin) / timeRange) * Math.max(1, width - padding * 2);
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
      ctx.lineWidth = 1.8;
      ctx.stroke();
    });
  }

  attachOverlayCloseHandler(id, handler) {
    if (!id || !handler) {
      return;
    }
    const root = findOverlayRoot(id);
    if (!root) {
      return;
    }
    const listener = event => {
      if (event?.detail?.id === id) {
        handler();
      }
    };
    root.addEventListener('overlaypanel:close', listener, { once: true });
  }
}

function buildPlotOverlayId(topicName) {
  return topicName ? `topic-plot:${topicName}` : 'topic-plot';
}

function buildSelectionOverlayId(topicName) {
  return topicName ? `topic-plot-select:${topicName}` : 'topic-plot-select';
}

function buildPlotFieldList(fields, example) {
  const map = new Map();
  const nodes = Array.isArray(fields) ? fields : [];
  const walkSchema = (target, prefix) => {
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
          appendNumericField(map, `${path}[${i}]`, elementType);
        }
        return;
      }
      const baseType = entry.base_type || entry.type || '';
      if (isNumericType(baseType)) {
        appendNumericField(map, path, baseType);
        return;
      }
      if (EXCLUDED_TYPES.has(baseType)) {
        return;
      }
      if (entry.children && entry.children.length) {
        walkSchema(entry.children, path);
      }
    });
  };
  walkSchema(nodes, '');
  if (example && typeof example === 'object') {
    traverseSample(example, '', (path, value) => {
      appendNumericField(map, path, typeof value === 'number' ? 'number' : 'unknown');
    });
  }
  return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function mergeFieldCandidates(baseFields, sampleFields) {
  const map = new Map();
  [...baseFields, ...sampleFields].forEach(field => {
    if (!field?.path) {
      return;
    }
    if (!map.has(field.path)) {
      map.set(field.path, field);
    }
  });
  return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function buildFieldsFromSample(sample) {
  const map = new Map();
  traverseSample(sample, '', (path, value) => {
    appendNumericField(map, path, typeof value === 'number' ? 'number' : 'unknown');
  });
  return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
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

function isNumericType(typeName = '') {
  return /^(u?int(8|16|32|64)|float(32|64)?|double|float)$/.test(String(typeName).toLowerCase());
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
      if (typeof step === 'string') {
        if (Array.isArray(value)) {
          const index = Number(step);
          value = Number.isInteger(index) ? value[index] : undefined;
        } else {
          value = value[step];
        }
      } else if (typeof step === 'number') {
        if (!Array.isArray(value)) {
          return undefined;
        }
        value = value[step];
      }
    }
    return value;
  }, obj);
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

function findOverlayRoot(id) {
  if (!id) {
    return null;
  }
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
  return document.querySelector(`[data-overlay-id="${escaped}"]`);
}

function delay(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function normalizeTypeName(typeName) {
  if (!typeName || typeof typeName !== 'string') {
    return '';
  }
  return typeName.replace(/^\/+/, '').toLowerCase();
}

function appendNumericField(map, path, type) {
  if (!path || map.has(path)) {
    return;
  }
  map.set(path, {
    path,
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

function pathToSegments(path) {
  if (!path) {
    return [];
  }
  return path.split('.').filter(Boolean);
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
