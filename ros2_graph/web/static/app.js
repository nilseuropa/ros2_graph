const canvas = document.getElementById('graphCanvas');
const ctx = canvas.getContext('2d');
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d');
const metaEl = document.getElementById('meta');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');
let lastGraph = null;
let lastFingerprint = null;
const viewState = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};
const VIEW_MIN_SCALE = 0.25;
const VIEW_MAX_SCALE = 6;
const ZOOM_SENSITIVITY = 0.0015;
const BASE_STROKE_WIDTH = 1.5;
const MIN_STROKE_WIDTH = 0.75;
const MAX_STROKE_WIDTH = 2.5;
const SELECT_EDGE_COLOR = '#ff9800';
const SELECT_NODE_STROKE = '#ff9800';
const SELECT_NODE_FILL = '#ffe6bf';
const SELECT_TOPIC_STROKE = '#ff9800';
const SELECT_TOPIC_FILL = '#d8f5d0';
const HOVER_EDGE_COLOR = '#42a5f5';
const HOVER_NODE_STROKE = '#42a5f5';
const HOVER_NODE_FILL = '#d6ecff';
const HOVER_TOPIC_STROKE = '#42a5f5';
const HOVER_TOPIC_FILL = '#cbe8ff';
const MIN_ARROW_HEAD = 4;
const MAX_ARROW_HEAD = 18;
let userAdjustedView = false;
const panState = {
  active: false,
  pointerId: null,
  lastX: 0,
  lastY: 0,
};
let currentScene = {
  nodes: new Map(),
  edges: [],
};
let currentSelection = {
  key: '',
  nodes: new Set(),
  edges: new Set(),
};
let hoverHighlight = {
  key: '',
  nodes: new Set(),
  edges: new Set(),
};
let nodeDescriptions = new Map();
const overlayState = {
  visible: false,
  nodeName: '',
  description: '',
  auto: false,
};
const contextMenu = document.getElementById('contextMenu');
const contextMenuState = {
  visible: false,
  target: null,
  position: { x: 0, y: 0 },
};
const canvasContainer = document.getElementById('canvasContainer');
const BASE_FONT_FAMILY = '"Times New Roman", serif';
const BASE_FONT_SIZE = 14;
const BASE_LINE_HEIGHT = 18;
const POINTS_PER_INCH = 72;
const MIN_FONT_SIZE_PX = 7;
const BASE_LINE_HEIGHT_RATIO = BASE_LINE_HEIGHT / BASE_FONT_SIZE;
const OVERLAY_FONT = '13px "Segoe UI", system-ui, -apple-system, sans-serif';
const OVERLAY_LINE_HEIGHT = 18;
const OVERLAY_PADDING = 12;
const OVERLAY_MAX_WIDTH = 320;
const OVERLAY_MARGIN = 12;
const TOPIC_TOOL_TIMEOUT = 15000;

function resetViewState() {
  viewState.scale = 1;
  viewState.offsetX = 0;
  viewState.offsetY = 0;
  userAdjustedView = false;
}

resetViewState();

function layoutToView(point) {
  const scale = viewState.scale || 1;
  return {
    x: point.x * scale + viewState.offsetX,
    y: point.y * scale + viewState.offsetY,
  };
}

function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(decimals);
}

function formatHz(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }
  if (value >= 1000) {
    return value.toFixed(0) + ' Hz';
  }
  if (value >= 10) {
    return value.toFixed(1) + ' Hz';
  }
  return value.toFixed(2) + ' Hz';
}

function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }
  const abs = Math.abs(value);
  if (abs >= 1024 * 1024) {
    return (value / (1024 * 1024)).toFixed(2) + ' MiB';
  }
  if (abs >= 1024) {
    return (value / 1024).toFixed(2) + ' KiB';
  }
  return value.toFixed(0) + ' B';
}

function formatBytesPerSecond(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }
  const abs = Math.abs(value);
  if (abs >= 1024 * 1024) {
    return (value / (1024 * 1024)).toFixed(2) + ' MiB/s';
  }
  if (abs >= 1024) {
    return (value / 1024).toFixed(2) + ' KiB/s';
  }
  return value.toFixed(0) + ' B/s';
}

function clearOverlayCanvas() {
  overlayCtx.save();
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCtx.restore();
}

function hideOverlay() {
  if (!overlayState.visible) {
    clearOverlayCanvas();
    return;
  }
  overlayState.visible = false;
  overlayState.nodeName = '';
  overlayState.description = '';
  overlayState.auto = false;
  clearOverlayCanvas();
}

function hideContextMenu() {
  if (!contextMenuState.visible) {
    return;
  }
  contextMenuState.visible = false;
  contextMenuState.target = null;
  if (contextMenu) {
    contextMenu.classList.remove('visible');
  }
}

function showContextMenu(clientPoint, target) {
  if (!contextMenu) {
    return;
  }
  contextMenuState.visible = true;
  contextMenuState.target = target;
  contextMenuState.position = { x: clientPoint.x, y: clientPoint.y };
  contextMenu.classList.add('visible');
  contextMenu.style.visibility = 'hidden';
  contextMenu.style.left = '0px';
  contextMenu.style.top = '0px';

  const containerRect = canvasContainer?.getBoundingClientRect();
  const menuRect = contextMenu.getBoundingClientRect();
  const margin = 8;
  let left = clientPoint.x;
  let top = clientPoint.y;

  if (containerRect) {
    left -= containerRect.left;
    top -= containerRect.top;
    if (left + menuRect.width > containerRect.width - margin) {
      left = containerRect.width - margin - menuRect.width;
    }
    if (top + menuRect.height > containerRect.height - margin) {
      top = containerRect.height - margin - menuRect.height;
    }
    if (left < margin) {
      left = margin;
    }
    if (top < margin) {
      top = margin;
    }
  }

  contextMenu.style.left = `${left}px`;
  contextMenu.style.top = `${top}px`;
  contextMenu.style.visibility = 'visible';
}

async function handleContextMenuAction(action, target) {
  hideContextMenu();
  if (!target || (target.type !== 'topic-edge' && target.type !== 'topic-node')) {
    return;
  }
  const topicGeometry = currentScene.nodes?.get(target.topicName);
  if (!topicGeometry) {
    statusEl.textContent = `Topic ${target.topicName} not visible in current layout`;
    return;
  }

  if (action === 'info') {
    showOverlayForNode(target.topicName, topicGeometry);
    const peerInfo = target.peerName ? ` (connection with ${target.peerName})` : '';
    statusEl.textContent = `Details shown for ${target.topicName}${peerInfo}`;
    return;
  }

  if (action !== 'stats') {
    statusEl.textContent = `Unsupported topic action: ${action}`;
    return;
  }

  const peerInfo = target.peerName ? ` ↔ ${target.peerName}` : '';
  const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
  const measuringText =
    `Topic: ${target.topicName}\n` +
    (target.peerName ? `Peer: ${target.peerName}\n` : '') +
    'Collecting stats…';
  showOverlayWithDescription(target.topicName, measuringText, false);
  statusEl.textContent = `Collecting ${action} for ${target.topicName}${peerInfo}…`;
  try {
    const payload = await requestTopicTool(action, target.topicName, target.peerName);
    showTopicMeasurementOverlay(action, target, payload);
  } catch (err) {
    let message;
    if (err?.name === 'AbortError') {
      message = 'request timed out';
    } else {
      message = err?.message || String(err);
    }
    statusEl.textContent = `Failed to collect ${action} for ${target.topicName}: ${message}`;
    showOverlayWithDescription(
      target.topicName,
      `Topic: ${target.topicName}\n${actionLabel} measurement failed.\n${message}`,
    );
  }
}

function handleContextMenuClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) {
    return;
  }
  const action = button.dataset.action;
  if (!action) {
    return;
  }
  const target = contextMenuState.target;
  void handleContextMenuAction(action, target);
}

function handleDocumentPointerDown(event) {
  if (!contextMenuState.visible) {
    return;
  }
  if (contextMenu && contextMenu.contains(event.target)) {
    return;
  }
  hideContextMenu();
}

function resolveTopicEdgeTarget(edge) {
  if (!edge || !currentScene?.nodes) {
    return null;
  }
  const startGeom = currentScene.nodes.get(edge.start);
  const endGeom = currentScene.nodes.get(edge.end);
  if (startGeom?.type === 'topic') {
    return {
      type: 'topic-edge',
      topicName: edge.start,
      peerName: edge.end,
      edgeId: edge.id,
      edge,
    };
  }
  if (endGeom?.type === 'topic') {
    return {
      type: 'topic-edge',
      topicName: edge.end,
      peerName: edge.start,
      edgeId: edge.id,
      edge,
    };
  }
  return null;
}

function resolveTopicNodeTarget(nodeHit) {
  if (!nodeHit?.geometry || nodeHit.geometry.type !== 'topic') {
    return null;
  }
  return {
    type: 'topic-node',
    topicName: nodeHit.name,
    edgeId: null,
  };
}

function validateContextMenuTarget() {
  if (!contextMenuState.visible || !contextMenuState.target) {
    return;
  }
  if (contextMenuState.target.type === 'topic-edge') {
    const stillExists = currentScene.edges?.some(edge => edge.id === contextMenuState.target.edgeId);
    if (!stillExists) {
      hideContextMenu();
    }
    return;
  }
  if (contextMenuState.target.type === 'topic-node') {
    if (!currentScene.nodes?.has(contextMenuState.target.topicName)) {
      hideContextMenu();
    }
  }
}

async function requestTopicTool(action, topicName, peerName) {
  const params = new URLSearchParams();
  params.set('action', action);
  params.set('topic', topicName);
  if (peerName) {
    params.set('peer', peerName);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOPIC_TOOL_TIMEOUT);
  let response;
  let payload = {};
  try {
    response = await fetch(`/topic_tool?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    try {
      payload = await response.json();
    } catch (err) {
      payload = {};
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!response?.ok) {
    const message = payload?.error || `HTTP ${response?.status ?? 'error'}`;
    throw new Error(message);
  }
  return payload;
}

function showTopicMeasurementOverlay(action, target, payload) {
  if (!payload || typeof payload !== 'object') {
    statusEl.textContent = `No data returned for ${action} on ${target.topicName}`;
    return;
  }
  const geometry = currentScene.nodes?.get(target.topicName);
  if (!geometry) {
    statusEl.textContent = `Received data for ${target.topicName}, but it is not visible.`;
    return;
  }

  const lines = [];
  const topicName = payload.topic || target.topicName;
  lines.push(`Topic: ${topicName}`);
  if (payload.type) {
    lines.push(`Type: ${payload.type}`);
  }
  lines.push(`Cached: ${payload.cached ? 'yes' : 'no'}`);
  if (payload.message_count !== undefined) {
    lines.push(`Messages observed: ${payload.message_count}`);
  }
  if (payload.duration !== undefined) {
    lines.push(`Window: ${formatNumber(payload.duration, 2)} s`);
  }
  lines.push('');

  if (payload.warning) {
    lines.push(`Warning: ${payload.warning}`);
  }

  if (payload.average_hz !== undefined || payload.min_hz !== undefined || payload.max_hz !== undefined) {
    lines.push('Frequency:');
    lines.push(`  avg: ${formatHz(payload.average_hz)}`);
    lines.push(`  min: ${formatHz(payload.min_hz)}`);
    lines.push(`  max: ${formatHz(payload.max_hz)}`);
  }

  if (payload.average_bps !== undefined || payload.average_bytes_per_msg !== undefined) {
    lines.push('');
    lines.push('Bandwidth:');
    lines.push(`  avg: ${formatBytesPerSecond(payload.average_bps)}`);
    lines.push(`  msg size: ${formatBytes(payload.average_bytes_per_msg)}`);
    lines.push(`  max size: ${formatBytes(payload.max_bytes)}`);
    lines.push(`  min size: ${formatBytes(payload.min_bytes)}`);
  }

  showOverlayWithDescription(topicName, lines.join('\n'));

  const peerInfo = target.peerName ? ` ↔ ${target.peerName}` : '';
  const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
  if (payload.warning) {
    statusEl.textContent = `${actionLabel} collection for ${topicName}${peerInfo}: ${payload.warning}`;
  } else {
    const freq = formatHz(payload.average_hz);
    const bw = formatBytesPerSecond(payload.average_bps);
    if (freq === 'n/a' && bw === 'n/a') {
      statusEl.textContent = `${actionLabel} for ${topicName}${peerInfo}: no traffic observed`;
    } else {
      statusEl.textContent = `${actionLabel} for ${topicName}${peerInfo}: avg ${freq}, ${bw}`;
      if (payload.cached) {
        statusEl.textContent += ' (cached)';
      }
    }
  }
}

function toGraphSpace(point) {
  const scale = viewState.scale || 1;
  return {
    x: (point.x - viewState.offsetX) / scale,
    y: (point.y - viewState.offsetY) / scale,
  };
}

function makeHighlightKey(nodes, edges) {
  const nodeKey = nodes.length ? nodes.slice().sort().join('|') : '';
  const edgeKey = edges.length ? edges.slice().sort().join('|') : '';
  return nodeKey + '||' + edgeKey;
}

function normaliseHighlight(highlight) {
  if (!highlight) {
    return {
      key: '',
      nodes: new Set(),
      edges: new Set(),
    };
  }
  const nodeList = Array.from(highlight.nodes ?? []);
  const edgeList = Array.from(highlight.edges ?? []);
  const uniqueNodes = Array.from(new Set(nodeList.filter(Boolean))).sort();
  const uniqueEdges = Array.from(new Set(edgeList.filter(Boolean))).sort();
  return {
    key: makeHighlightKey(uniqueNodes, uniqueEdges),
    nodes: new Set(uniqueNodes),
    edges: new Set(uniqueEdges),
  };
}

function setSelection(highlight, mode = 'replace') {
  let newNodes;
  let newEdges;
  if (mode === 'clear' || !highlight) {
    newNodes = new Set();
    newEdges = new Set();
  } else if (mode === 'toggle') {
    const normalised = normaliseHighlight(highlight);
    newNodes = new Set(currentSelection.nodes);
    newEdges = new Set(currentSelection.edges);
    normalised.nodes.forEach(node => {
      if (newNodes.has(node)) {
        newNodes.delete(node);
      } else {
        newNodes.add(node);
      }
    });
    normalised.edges.forEach(edge => {
      if (newEdges.has(edge)) {
        newEdges.delete(edge);
      } else {
        newEdges.add(edge);
      }
    });
  } else {
    const normalised = normaliseHighlight(highlight);
    newNodes = normalised.nodes;
    newEdges = normalised.edges;
  }

  const key = makeHighlightKey(Array.from(newNodes).sort(), Array.from(newEdges).sort());
  if (key === currentSelection.key) {
    return;
  }
  currentSelection = {
    key,
    nodes: newNodes,
    edges: newEdges,
  };
  if (lastGraph) {
    renderGraph(lastGraph, lastFingerprint);
  }
}

function clearHoverHighlight() {
  setHoverHighlight(null);
}

function setHoverHighlight(highlight) {
  const normalised = normaliseHighlight(highlight);
  if (normalised.key === hoverHighlight.key) {
    return;
  }
  hoverHighlight = normalised;
  if (lastGraph) {
    renderGraph(lastGraph, lastFingerprint);
  }
}

function wrapOverlayText(description, maxWidth) {
  if (!description || !description.length) {
    return ['No description available.'];
  }
  const rawLines = description.split(/\r?\n/);
  const result = [];
  rawLines.forEach(line => {
    if (line.length === 0) {
      result.push('');
      return;
    }
    const indentMatch = line.match(/^(\s+)/);
    const indent = indentMatch ? indentMatch[1] : '';
    const trimmed = line.trim();
    if (!trimmed) {
      result.push(indent);
      return;
    }
    const words = trimmed.split(/\s+/);
    let current = indent + words[0];
    for (let i = 1; i < words.length; i += 1) {
      const word = words[i];
      const candidate = current + ' ' + word;
      if (overlayCtx.measureText(candidate).width <= maxWidth || current === indent) {
        current = candidate;
      } else {
        result.push(current);
        current = indent + word;
      }
    }
    result.push(current);
  });
  return result;
}

function drawOverlayTextbox(anchorPoint, nodeName, description) {
  overlayCtx.save();
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.font = OVERLAY_FONT;
  overlayCtx.textBaseline = 'top';
  overlayCtx.textAlign = 'left';
  const maxTextWidth = OVERLAY_MAX_WIDTH - OVERLAY_PADDING * 2;
  const lines = wrapOverlayText(description, maxTextWidth);
  let maxWidth = 0;
  lines.forEach(line => {
    const width = overlayCtx.measureText(line).width;
    if (width > maxWidth) {
      maxWidth = width;
    }
  });
  const boxWidth = Math.min(OVERLAY_MAX_WIDTH, Math.max(maxWidth, 120) + OVERLAY_PADDING * 2);
  const boxHeight = OVERLAY_PADDING * 2 + lines.length * OVERLAY_LINE_HEIGHT;
  let boxX = anchorPoint.x + OVERLAY_MARGIN;
  let boxY = anchorPoint.y - boxHeight - OVERLAY_MARGIN;
  if (boxX + boxWidth > overlayCanvas.width - OVERLAY_MARGIN) {
    boxX = overlayCanvas.width - OVERLAY_MARGIN - boxWidth;
  }
  if (boxX < OVERLAY_MARGIN) {
    boxX = OVERLAY_MARGIN;
  }
  if (boxY < OVERLAY_MARGIN) {
    boxY = anchorPoint.y + OVERLAY_MARGIN;
    if (boxY + boxHeight > overlayCanvas.height - OVERLAY_MARGIN) {
      boxY = overlayCanvas.height - OVERLAY_MARGIN - boxHeight;
    }
  }
  const radius = 10;
  overlayCtx.fillStyle = 'rgba(13, 17, 23, 0.95)';
  overlayCtx.strokeStyle = '#58a6ff';
  overlayCtx.lineWidth = 2;
  overlayCtx.beginPath();
  overlayCtx.moveTo(boxX + radius, boxY);
  overlayCtx.lineTo(boxX + boxWidth - radius, boxY);
  overlayCtx.quadraticCurveTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + radius);
  overlayCtx.lineTo(boxX + boxWidth, boxY + boxHeight - radius);
  overlayCtx.quadraticCurveTo(
    boxX + boxWidth,
    boxY + boxHeight,
    boxX + boxWidth - radius,
    boxY + boxHeight
  );
  overlayCtx.lineTo(boxX + radius, boxY + boxHeight);
  overlayCtx.quadraticCurveTo(boxX, boxY + boxHeight, boxX, boxY + boxHeight - radius);
  overlayCtx.lineTo(boxX, boxY + radius);
  overlayCtx.quadraticCurveTo(boxX, boxY, boxX + radius, boxY);
  overlayCtx.closePath();
  overlayCtx.fill();
  overlayCtx.stroke();

  lines.forEach((line, idx) => {
    const textX = boxX + OVERLAY_PADDING;
    const textY = boxY + OVERLAY_PADDING + idx * OVERLAY_LINE_HEIGHT;
    overlayCtx.fillStyle = idx === 0 ? '#58a6ff' : '#e6edf3';
    overlayCtx.fillText(line, textX, textY);
  });
  overlayCtx.restore();
}

function refreshOverlay() {
  clearOverlayCanvas();
  if (!overlayState.visible) {
    return;
  }
  const geometry = currentScene.nodes?.get(overlayState.nodeName);
  if (!geometry) {
    hideOverlay();
    return;
  }
  if (overlayState.auto) {
    overlayState.description = resolveOverlayDescription(overlayState.nodeName, geometry);
  }
  const anchorPoint = layoutToView(geometry.center);
  drawOverlayTextbox(anchorPoint, overlayState.nodeName, overlayState.description);
}

function resolveOverlayDescription(nodeName, geometry) {
  let description = nodeDescriptions.get(nodeName);
  if (!description) {
    if (geometry?.type === 'topic') {
      description = buildTopicDescription(lastGraph, nodeName);
    } else {
      description = buildDefaultNodeDescription(nodeName);
    }
  }
  return description;
}

function showOverlayForNode(nodeName, geometry) {
  const description = resolveOverlayDescription(nodeName, geometry);
  showOverlayWithDescription(nodeName, description, true);
}

function showOverlayWithDescription(nodeName, description, auto = false) {
  overlayState.visible = true;
  overlayState.nodeName = nodeName;
  overlayState.description = description;
  overlayState.auto = auto;
  refreshOverlay();
}

function stripQuotes(value) {
  if (!value) {
    return value;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function parseGraphvizPlain(plainText) {
  if (!plainText) {
    return null;
  }
  const lines = plainText.trim().split(/\r?\n/);
  if (!lines.length) {
    return null;
  }

  const nodes = {};
  const edges = [];
  let width = 0;
  let height = 0;
  let scale = 1;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    const kind = parts[0];
    if (kind === 'graph' && parts.length >= 4) {
      const maybeScale = parseFloat(parts[1]);
      if (!Number.isNaN(maybeScale) && maybeScale > 0) {
        scale = maybeScale;
      }
      const maybeWidth = parseFloat(parts[2]);
      const maybeHeight = parseFloat(parts[3]);
      if (!Number.isNaN(maybeWidth)) {
        width = maybeWidth;
      }
      if (!Number.isNaN(maybeHeight)) {
        height = maybeHeight;
      }
    } else if (kind === 'node' && parts.length >= 6) {
      const name = stripQuotes(parts[1]);
      const x = parseFloat(parts[2]);
      const y = parseFloat(parts[3]);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        continue;
      }
      const labelToken = stripQuotes(parts[6] ?? '');
      const label =
        labelToken && labelToken.length
          ? labelToken.replace(/\\[nlr]/g, '\n')
          : name;
      const style = stripQuotes(parts[7] ?? '');
      const shape = stripQuotes(parts[8] ?? '');
      const strokeColor = stripQuotes(parts[9] ?? '');
      const fillColor = stripQuotes(parts[10] ?? '');
      let fontSize = undefined;
      if (parts.length >= 12) {
        const maybeFontSize = parseFloat(parts[parts.length - 1]);
        if (!Number.isNaN(maybeFontSize) && maybeFontSize > 0) {
          fontSize = maybeFontSize;
        }
      }
      nodes[name] = {
        x,
        y,
        width: parseFloat(parts[4]),
        height: parseFloat(parts[5]),
        label,
        rawLabel: labelToken,
        style,
        shape,
        strokeColor,
        fillColor,
        fontSize,
      };
    } else if (kind === 'edge' && parts.length >= 4) {
      const tail = stripQuotes(parts[1]);
      const head = stripQuotes(parts[2]);
      const pointCount = parseInt(parts[3], 10);
      if (Number.isNaN(pointCount) || pointCount <= 0) {
        continue;
      }
      const points = [];
      let idx = 4;
      for (let i = 0; i < pointCount && idx + 1 < parts.length; i += 1) {
        const x = parseFloat(parts[idx]);
        const y = parseFloat(parts[idx + 1]);
        idx += 2;
        if (Number.isNaN(x) || Number.isNaN(y)) {
          continue;
        }
        points.push({ x, y });
      }
      if (points.length >= 2) {
        edges.push({ tail, head, points });
      }
    }
  }

  if (!width || !height || !Object.keys(nodes).length) {
    return null;
  }

  return { scale, width, height, nodes, edges };
}

function createGraphvizScaler(layout, canvasWidth, canvasHeight) {
  const margin = 40;
  const layoutScale = layout.scale && Number.isFinite(layout.scale) && layout.scale > 0 ? layout.scale : 1;
  const scaledWidth = layout.width * layoutScale;
  const scaledHeight = layout.height * layoutScale;
  if (!scaledWidth || !scaledHeight) {
    return null;
  }

  const scaleX = (canvasWidth - margin * 2) / scaledWidth;
  const scaleY = (canvasHeight - margin * 2) / scaledHeight;
  const scale = Math.min(scaleX, scaleY);
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  const scaledCanvasWidth = scaledWidth * scale;
  const scaledCanvasHeight = scaledHeight * scale;
  const offsetX = (canvasWidth - scaledCanvasWidth) / 2;
  const offsetY = (canvasHeight - scaledCanvasHeight) / 2;

  return {
    scale,
    toCanvas(point) {
      return {
        x: offsetX + point.x * layoutScale * scale,
        y: canvasHeight - (offsetY + point.y * layoutScale * scale),
      };
    },
    scaleLength(length) {
      return length * layoutScale * scale;
    },
  };
}

function computeGraphvizFontSizePx(nodeInfo, scaler) {
  if (!scaler || typeof scaler.scaleLength !== 'function') {
    return BASE_FONT_SIZE;
  }
  const fontSizePt = Number.isFinite(nodeInfo?.fontSize)
    ? nodeInfo.fontSize
    : BASE_FONT_SIZE;
  const inches = fontSizePt / POINTS_PER_INCH;
  const pixels = scaler.scaleLength(inches);
  if (Number.isFinite(pixels) && pixels > 0) {
    return Math.max(MIN_FONT_SIZE_PX, pixels);
  }
  return Math.max(MIN_FONT_SIZE_PX, fontSizePt);
}

function buildGraphvizEdgeLookup(layout, scaler) {
  const map = new Map();
  layout.edges.forEach(edge => {
    if (!edge.points || edge.points.length < 2) {
      return;
    }
    const transformed = edge.points.map(point => scaler.toCanvas(point));
    const key = edge.tail + '->' + edge.head;
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(transformed);
  });
  return map;
}

function computePolylineMidpoint(points) {
  if (!points || points.length === 0) {
    return null;
  }
  if (points.length === 1) {
    return points[0];
  }
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (total === 0) {
    return points[0];
  }
  const half = total / 2;
  let traversed = 0;
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    const segment = Math.hypot(end.x - start.x, end.y - start.y);
    if (segment === 0) {
      continue;
    }
    if (traversed + segment >= half) {
      const ratio = (half - traversed) / segment;
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      };
    }
    traversed += segment;
  }
  return points[points.length - 1];
}

function scalePointAround(point, origin, factor) {
  return {
    x: origin.x + (point.x - origin.x) * factor,
    y: origin.y + (point.y - origin.y) * factor,
  };
}

function isRectangularShape(geometry) {
  const shape = (geometry?.info?.shape || '').toLowerCase();
  if (geometry?.type === 'topic') {
    return true;
  }
  return shape === 'box' || shape === 'rectangle' || shape === 'rect' || shape === 'record';
}

function computeRectangleBoundaryPoint(geometry, targetPoint) {
  const center = geometry.center;
  const halfWidth = Math.max(geometry.width / 2, 1);
  const halfHeight = Math.max(geometry.height / 2, 1);
  const dx = targetPoint.x - center.x;
  const dy = targetPoint.y - center.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return { x: center.x, y: center.y };
  }
  let t = Infinity;
  if (dx !== 0) {
    t = Math.min(t, halfWidth / Math.abs(dx));
  }
  if (dy !== 0) {
    t = Math.min(t, halfHeight / Math.abs(dy));
  }
  if (!Number.isFinite(t) || t <= 0) {
    t = 1;
  }
  return {
    x: center.x + dx * t,
    y: center.y + dy * t,
  };
}

function computeEllipseBoundaryPoint(geometry, targetPoint) {
  const center = geometry.center;
  const rx = Math.max(geometry.width / 2, 1);
  const ry = Math.max(geometry.height / 2, 1);
  const dx = targetPoint.x - center.x;
  const dy = targetPoint.y - center.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return { x: center.x + rx, y: center.y };
  }
  const length = Math.hypot(dx / rx, dy / ry);
  if (!Number.isFinite(length) || length === 0) {
    return { x: center.x + rx, y: center.y };
  }
  return {
    x: center.x + dx / length,
    y: center.y + dy / length,
  };
}

function computeBoundaryPoint(geometry, directionPoint) {
  if (!geometry || !directionPoint) {
    return null;
  }
  if (isRectangularShape(geometry)) {
    return computeRectangleBoundaryPoint(geometry, directionPoint);
  }
  return computeEllipseBoundaryPoint(geometry, directionPoint);
}

function adjustEdgePath(points, tailGeometry, headGeometry) {
  if (!points || points.length < 2) {
    return points;
  }
  const adjusted = points.map(pt => ({ x: pt.x, y: pt.y }));
  if (tailGeometry) {
    const reference = adjusted[1] ?? tailGeometry.center;
    const replacement = computeBoundaryPoint(tailGeometry, reference);
    if (replacement) {
      adjusted[0] = replacement;
    }
  }
  if (headGeometry) {
    const reference = adjusted[adjusted.length - 2] ?? headGeometry.center;
    const replacement = computeBoundaryPoint(headGeometry, reference);
    if (replacement) {
      adjusted[adjusted.length - 1] = replacement;
    }
  }
  return adjusted;
}

function buildOrthogonalPath(tailGeometry, headGeometry) {
  if (!tailGeometry || !headGeometry) {
    return null;
  }
  if (tailGeometry === headGeometry) {
    const center = tailGeometry.center;
    const rightRef = { x: center.x + 1, y: center.y };
    const topRef = { x: center.x, y: center.y - 1 };
    const start = computeBoundaryPoint(tailGeometry, rightRef);
    const end = computeBoundaryPoint(headGeometry, topRef);
    if (!start || !end) {
      return null;
    }
    const offsetX = Math.max(tailGeometry.width * 0.8, 32);
    const offsetY = Math.max(tailGeometry.height * 1.2, 48);
    const path = [
      start,
      { x: start.x + offsetX, y: start.y },
      { x: start.x + offsetX, y: start.y - offsetY },
      { x: end.x, y: start.y - offsetY },
      end,
    ];
    return path;
  }

  const startCenter = tailGeometry.center;
  const endCenter = headGeometry.center;
  const dx = endCenter.x - startCenter.x;
  const dy = endCenter.y - startCenter.y;
  const horizontalFirst = Math.abs(dx) >= Math.abs(dy);
  const signX = dx === 0 ? 1 : Math.sign(dx);
  const signY = dy === 0 ? 1 : Math.sign(dy);

  const startReference = horizontalFirst
    ? { x: startCenter.x + signX, y: startCenter.y }
    : { x: startCenter.x, y: startCenter.y + signY };
  const endReference = horizontalFirst
    ? { x: endCenter.x - signX, y: endCenter.y }
    : { x: endCenter.x, y: endCenter.y - signY };

  const start = computeBoundaryPoint(tailGeometry, startReference);
  const end = computeBoundaryPoint(headGeometry, endReference);
  if (!start || !end) {
    return null;
  }

  const points = [start];
  if (horizontalFirst) {
    const midX = (start.x + end.x) / 2;
    if (!Number.isFinite(midX)) {
      return [start, end];
    }
    if (Math.abs(midX - start.x) > 1e-3) {
      points.push({ x: midX, y: start.y });
    }
    if (Math.abs(end.y - start.y) > 1e-3) {
      points.push({ x: midX, y: end.y });
    }
  } else {
    const midY = (start.y + end.y) / 2;
    if (!Number.isFinite(midY)) {
      return [start, end];
    }
    if (Math.abs(midY - start.y) > 1e-3) {
      points.push({ x: start.x, y: midY });
    }
    if (Math.abs(end.x - start.x) > 1e-3) {
      points.push({ x: end.x, y: midY });
    }
  }

  points.push(end);

  return points;
}

function isPointInsideGeometry(geometry, point) {
  if (!geometry || !point) {
    return false;
  }
  const tolerance = 6 / (viewState.scale || 1);
  const center = geometry.center;
  if (!center) {
    return false;
  }
  if (isRectangularShape(geometry)) {
    const halfWidth = Math.max(geometry.width / 2, 1) + tolerance;
    const halfHeight = Math.max(geometry.height / 2, 1) + tolerance;
    const dx = Math.abs(point.x - center.x);
    const dy = Math.abs(point.y - center.y);
    return dx <= halfWidth && dy <= halfHeight;
  }
  const rx = Math.max(geometry.width / 2, 1) + tolerance;
  const ry = Math.max(geometry.height / 2, 1) + tolerance;
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
}

function distancePointToSegment(point, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = point.x - a.x;
  const wy = point.y - a.y;
  const segmentLengthSquared = vx * vx + vy * vy;
  let t = 0;
  if (segmentLengthSquared > 0) {
    t = (wx * vx + wy * vy) / segmentLengthSquared;
    t = Math.max(0, Math.min(1, t));
  }
  const projX = a.x + vx * t;
  const projY = a.y + vy * t;
  return Math.hypot(point.x - projX, point.y - projY);
}

function findNodeAt(point) {
  if (!currentScene.nodes || !currentScene.nodes.size) {
    return null;
  }
  for (const [name, geometry] of currentScene.nodes.entries()) {
    if (isPointInsideGeometry(geometry, point)) {
      return { name, geometry };
    }
  }
  return null;
}

function findEdgeAt(point) {
  if (!currentScene.edges || !currentScene.edges.length) {
    return null;
  }
  const threshold = 8 / (viewState.scale || 1);
  let best = null;
  let bestDistance = Infinity;
  currentScene.edges.forEach(edge => {
    const pts = edge.points;
    if (!pts || pts.length < 2) {
      return;
    }
    for (let i = 1; i < pts.length; i += 1) {
      const distance = distancePointToSegment(point, pts[i - 1], pts[i]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = edge;
      }
    }
  });
  if (best && bestDistance <= threshold) {
    return best;
  }
  return null;
}

function computeNodeHoverHighlight(name, geometry) {
  const nodes = new Set([name]);
  const edges = new Set();
  if (!currentScene.edges) {
    return { nodes, edges };
  }
  currentScene.edges.forEach(edge => {
    if (edge.start === name || edge.end === name) {
      edges.add(edge.id);
      const other = edge.start === name ? edge.end : edge.start;
      const otherGeom = currentScene.nodes.get(other);
      if (!otherGeom) {
        return;
      }
      if (geometry?.type === 'node') {
        if (otherGeom.type === 'topic') {
          nodes.add(other);
        }
      } else if (geometry?.type === 'topic') {
        nodes.add(other);
      } else {
        nodes.add(other);
      }
    }
  });
  return { nodes, edges };
}

function computeEdgeHoverHighlight(edge) {
  const nodes = new Set();
  nodes.add(edge.start);
  nodes.add(edge.end);
  const edges = new Set([edge.id]);
  return { nodes, edges };
}

function updateHoverHighlight(event) {
  if (!lastGraph || panState.active) {
    return;
  }
  const canvasPoint = getCanvasPoint(event);
  const graphPoint = toGraphSpace(canvasPoint);
  const nodeHit = findNodeAt(graphPoint);
  if (nodeHit) {
    const highlight = computeNodeHoverHighlight(nodeHit.name, nodeHit.geometry);
    setHoverHighlight(highlight);
    return;
  }
  const edgeHit = findEdgeAt(graphPoint);
  if (edgeHit) {
    const highlight = computeEdgeHoverHighlight(edgeHit);
    setHoverHighlight(highlight);
    return;
  }
  clearHoverHighlight();
}

function clamp(value, min, max) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function getStrokeWidth() {
  const scale = viewState.scale || 1;
  return clamp(BASE_STROKE_WIDTH / scale, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH);
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width ? canvas.width / rect.width : 1;
  const scaleY = rect.height ? canvas.height / rect.height : 1;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

function computeLayoutOrigin(geometries) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  geometries.forEach(geom => {
    minX = Math.min(minX, geom.center.x);
    maxX = Math.max(maxX, geom.center.x);
    minY = Math.min(minY, geom.center.y);
    maxY = Math.max(maxY, geom.center.y);
  });
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return { x: 0, y: 0 };
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function computeSpreadRequirements(geometries) {
  let overlaps = false;
  let requiredFactor = 1;
  for (let i = 0; i < geometries.length; i += 1) {
    const a = geometries[i];
    const centerA = a.center;
    const halfWidthA = a.width / 2;
    const halfHeightA = a.height / 2;
    for (let j = i + 1; j < geometries.length; j += 1) {
      const b = geometries[j];
      const centerB = b.center;
      const halfWidthB = b.width / 2;
      const halfHeightB = b.height / 2;
      const sizeHint = Math.max(a.width, a.height, b.width, b.height);
      const margin = 6 + Math.min(24, sizeHint * 0.05);
      const widthThreshold = halfWidthA + halfWidthB + margin;
      const heightThreshold = halfHeightA + halfHeightB + margin;
      const deltaX = Math.abs(centerA.x - centerB.x);
      const deltaY = Math.abs(centerA.y - centerB.y);
      const overlapX = deltaX < widthThreshold;
      const overlapY = deltaY < heightThreshold;
      if (!overlapX || !overlapY) {
        continue;
      }
      overlaps = true;
      const candidates = [];
      if (deltaX > 0) {
        candidates.push(widthThreshold / deltaX);
      }
      if (deltaY > 0) {
        candidates.push(heightThreshold / deltaY);
      }
      if (!candidates.length) {
        return { overlaps: true, factor: Infinity };
      }
      const needed = Math.max(1, Math.min(...candidates));
      if (Number.isFinite(needed) && needed > requiredFactor) {
        requiredFactor = needed;
      }
    }
  }
  return { overlaps, factor: requiredFactor };
}

function applySpreadAdjustment(nodeGeometry, edgeLookup) {
  const entries = Object.values(nodeGeometry);
  if (entries.length < 2) {
    return;
  }

  const origin = computeLayoutOrigin(entries);
  const { overlaps, factor: requiredFactor } = computeSpreadRequirements(entries);
  if (!overlaps) {
    return;
  }

  const maxFactor = 3.5;
  const safeFactor = Math.min(Math.max(requiredFactor + 0.05, 1.05), maxFactor);
  if (!Number.isFinite(safeFactor) || safeFactor <= 1.0001) {
    return;
  }

  entries.forEach(geom => {
    geom.center = scalePointAround(geom.center, origin, safeFactor);
  });

  if (edgeLookup) {
    edgeLookup.forEach(paths => {
      paths.forEach(path => {
        for (let i = 0; i < path.length; i += 1) {
          path[i] = scalePointAround(path[i], origin, safeFactor);
        }
      });
    });
  }
}

function resizeCanvas() {
  const headerHeight = document.querySelector('header').offsetHeight;
  canvas.width = window.innerWidth;
  canvas.height = Math.max(240, window.innerHeight - headerHeight - 40);
  overlayCanvas.width = canvas.width;
  overlayCanvas.height = canvas.height;
  hideContextMenu();
  renderGraph(lastGraph, lastFingerprint);
}

window.addEventListener('resize', resizeCanvas);
refreshBtn.addEventListener('click', fetchGraph);
canvas.addEventListener('wheel', handleWheel, { passive: false });
canvas.addEventListener('pointerdown', handlePointerDown);
canvas.addEventListener('pointermove', handlePointerMove);
canvas.addEventListener('pointerup', handlePointerUp);
canvas.addEventListener('pointercancel', handlePointerCancel);
canvas.addEventListener('pointerleave', handlePointerCancel);
canvas.addEventListener('contextmenu', handleContextMenu);
canvas.addEventListener('dblclick', handleDoubleClick);
document.addEventListener('keydown', handleKeyDown);
document.addEventListener('pointerdown', handleDocumentPointerDown);
if (contextMenu) {
  contextMenu.addEventListener('click', handleContextMenuClick);
}

const HIDDEN_NAME_PATTERNS = [/\/rosout\b/i];

function isHiddenGraphName(name) {
  if (!name) {
    return false;
  }
  return HIDDEN_NAME_PATTERNS.some(pattern => pattern.test(name));
}

function splitNodeName(nodeName) {
  if (!nodeName) {
    return { namespace: '/', basename: '' };
  }
  const slashIndex = nodeName.lastIndexOf('/');
  if (slashIndex <= 0) {
    const cleaned = nodeName.replace(/^\//, '');
    return { namespace: '/', basename: cleaned || nodeName };
  }
  const namespace = slashIndex === 0 ? '/' : nodeName.slice(0, slashIndex);
  const basename = nodeName.slice(slashIndex + 1) || '/';
  return { namespace, basename };
}

function buildDefaultNodeDescription(nodeName) {
  const parts = splitNodeName(nodeName);
  const lines = [`Node: ${nodeName}`];
  if (parts.basename && parts.basename !== nodeName) {
    lines.push(`Base name: ${parts.basename}`);
  }
  if (parts.namespace && parts.namespace !== nodeName) {
    lines.push(`Namespace: ${parts.namespace}`);
  } else if (!parts.namespace) {
    lines.push('Namespace: /');
  }
  if (lines.length === 1) {
    lines.push('Namespace: /');
  }
  lines.push('');
  lines.push('No description available.');
  return lines.join('\n');
}

function buildNodeDescriptions(graph) {
  const result = new Map();
  if (!graph || !graph.nodes || !graph.nodes.length) {
    return result;
  }
  graph.nodes.forEach(node => {
    result.set(node, buildDefaultNodeDescription(node));
  });
  return result;
}

function buildTopicDescription(graph, topicName) {
  if (!graph) {
    return `Topic: ${topicName}\nNo additional information available.`;
  }
  const topics = graph.topics || {};
  const types = topics[topicName] || [];
  const nodes = new Set(graph.nodes || []);
  const edges = graph.edges || [];
  const publishers = new Map();
  const subscribers = new Map();

  const addEntry = (map, name, qos) => {
    if (!map.has(name)) {
      map.set(name, new Set());
    }
    if (qos && qos.length) {
      map.get(name).add(qos);
    }
  };

  edges.forEach(edge => {
    if (edge.end === topicName && nodes.has(edge.start)) {
      addEntry(publishers, edge.start, edge.qos || '');
    } else if (edge.start === topicName && nodes.has(edge.end)) {
      addEntry(subscribers, edge.end, edge.qos || '');
    }
  });

  const lines = [`Topic: ${topicName}`, ''];
  if (types.length) {
    lines.push('Type(s):');
    types.forEach(type => {
      lines.push(`  - ${type}`);
    });
  } else {
    lines.push('Type(s): (unknown)');
  }
  lines.push('');
  lines.push('Publishers:');
  if (publishers.size) {
    Array.from(publishers.keys())
      .sort()
      .forEach(name => {
        const qosSet = publishers.get(name) ?? new Set();
      const qosSuffix = qosSet.size ? ` [${Array.from(qosSet).join(' | ')}]` : '';
      lines.push(`  - ${name}${qosSuffix}`);
    });
  } else {
    lines.push('  (none)');
  }
  lines.push('');
  lines.push('Subscribers:');
  if (subscribers.size) {
    Array.from(subscribers.keys())
      .sort()
      .forEach(name => {
        const qosSet = subscribers.get(name) ?? new Set();
      const qosSuffix = qosSet.size ? ` [${Array.from(qosSet).join(' | ')}]` : '';
      lines.push(`  - ${name}${qosSuffix}`);
    });
  } else {
    lines.push('  (none)');
  }

  return lines.join('\n');
}

function renderGraph(graph, fingerprint = lastFingerprint) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  if (!graph) {
    currentScene = {
      nodes: new Map(),
      edges: [],
    };
    hideOverlay();
    hideContextMenu();
    return;
  }

  if (fingerprint !== undefined && fingerprint !== null) {
    if (fingerprint !== lastFingerprint && !userAdjustedView) {
      resetViewState();
    }
    lastFingerprint = fingerprint;
  }

  lastGraph = graph;
  nodeDescriptions = buildNodeDescriptions(graph);
  const width = canvas.width;
  const height = canvas.height;
  const nodeNames = (graph.nodes || []).filter(name => !isHiddenGraphName(name));
  const topicNames = Object.keys(graph.topics || {}).filter(name => !isHiddenGraphName(name));

  if (!graph.graphviz?.plain) {
    currentScene = {
      nodes: new Map(),
      edges: [],
    };
    hideOverlay();
    hideContextMenu();
    ctx.save();
    ctx.fillStyle = '#c9d1d9';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Graphviz layout not available', width / 2, height / 2);
    ctx.restore();
    return;
  }

  const layout = parseGraphvizPlain(graph.graphviz.plain);
  if (!layout) {
    currentScene = {
      nodes: new Map(),
      edges: [],
    };
    hideOverlay();
    hideContextMenu();
    ctx.save();
    ctx.fillStyle = '#c9d1d9';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Graphviz layout could not be parsed', width / 2, height / 2);
    ctx.restore();
    return;
  }

  const idMap = graph.graphviz?.ids || {};
  const reverseIdMap = {};
  Object.keys(idMap).forEach(actualName => {
    const graphvizId = idMap[actualName];
    if (graphvizId) {
      reverseIdMap[graphvizId] = actualName;
    }
  });

  if (Object.keys(reverseIdMap).length) {
    const remappedNodes = {};
    Object.entries(layout.nodes).forEach(([graphvizId, info]) => {
      const actual = reverseIdMap[graphvizId] ?? graphvizId;
      remappedNodes[actual] = info;
    });
    layout.nodes = remappedNodes;
    layout.edges = layout.edges.map(edge => ({
      tail: reverseIdMap[edge.tail] ?? edge.tail,
      head: reverseIdMap[edge.head] ?? edge.head,
      points: edge.points,
    }));
  }

  const scaler = createGraphvizScaler(layout, width, height);
  if (!scaler) {
    currentScene = {
      nodes: new Map(),
      edges: [],
    };
    hideOverlay();
    hideContextMenu();
    ctx.save();
    ctx.fillStyle = '#c9d1d9';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Failed to scale Graphviz layout', width / 2, height / 2);
    ctx.restore();
    return;
  }

  const nodeGeometry = {};
  const topicSet = new Set(topicNames);
  const geometryEntries = [];
  Object.entries(layout.nodes).forEach(([name, nodeInfo]) => {
    if (isHiddenGraphName(name)) {
      return;
    }
    const center = scaler.toCanvas(nodeInfo);
    const labelLines = decodeGraphvizLabel(nodeInfo.rawLabel, nodeInfo.label || name, name);
    const metrics = measureLabel(labelLines);

    const baseWidthPx = Number.isFinite(nodeInfo.width) ? scaler.scaleLength(nodeInfo.width) : 0;
    const baseHeightPx = Number.isFinite(nodeInfo.height) ? scaler.scaleLength(nodeInfo.height) : 0;
    const fallbackWidthPx = Math.max(metrics.width + 12, 24);
    const fallbackHeightPx = Math.max(metrics.height + 12, 24);
    let finalWidthPx = baseWidthPx > 0 ? baseWidthPx : fallbackWidthPx;
    let finalHeightPx = baseHeightPx > 0 ? baseHeightPx : fallbackHeightPx;

    const availableWidth = Math.max(finalWidthPx - 8, 4);
    const availableHeight = Math.max(finalHeightPx - 8, 4);

    geometryEntries.push({
      name,
      info: nodeInfo,
      center,
      labelLines,
      width: finalWidthPx,
      height: finalHeightPx,
      availableWidth,
      availableHeight,
      type: topicSet.has(name) || (nodeInfo.shape || '').toLowerCase().includes('box') ? 'topic' : 'node',
    });
  });

  if (!geometryEntries.length) {
    currentScene = {
      nodes: new Map(),
      edges: [],
    };
    hideOverlay();
    hideContextMenu();
    ctx.save();
    ctx.fillStyle = '#c9d1d9';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GraphViz layout empty', width / 2, height / 2);
    ctx.restore();
    return;
  }

  geometryEntries.forEach(entry => {
    let fontSize = computeGraphvizFontSizePx(entry.info, scaler);
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
      fontSize = BASE_FONT_SIZE;
    }
    let lineHeight = Math.max(fontSize * BASE_LINE_HEIGHT_RATIO, fontSize);
    let labelMetrics = measureLabel(entry.labelLines, fontSize);
    if (
      (labelMetrics.width > entry.availableWidth && entry.availableWidth > 0) ||
      (labelMetrics.height > entry.availableHeight && entry.availableHeight > 0)
    ) {
      const widthScale = labelMetrics.width > 0 ? entry.availableWidth / labelMetrics.width : 1;
      const heightScale = labelMetrics.height > 0 ? entry.availableHeight / labelMetrics.height : 1;
      const limiter = Math.min(widthScale, heightScale, 1);
      if (Number.isFinite(limiter) && limiter > 0 && limiter < 1) {
        fontSize *= limiter;
        lineHeight *= limiter;
        labelMetrics = measureLabel(entry.labelLines, fontSize);
      }
    }
    lineHeight = labelMetrics.lineHeight ?? lineHeight;
    const textWidth = labelMetrics.width;
    const paddingX = Math.max((entry.width - textWidth) / 2, 4);
    nodeGeometry[entry.name] = {
      center: entry.center,
      width: entry.width,
      height: entry.height,
      info: entry.info,
      labelLines: entry.labelLines,
      fontSize,
      lineHeight,
      paddingX,
      type: entry.type,
    };
  });

  const edgeLookup = buildGraphvizEdgeLookup(layout, scaler);

  applySpreadAdjustment(nodeGeometry, edgeLookup);

  ctx.save();
  ctx.translate(viewState.offsetX, viewState.offsetY);
  ctx.scale(viewState.scale, viewState.scale);

  ctx.lineWidth = getStrokeWidth();
  ctx.strokeStyle = '#1f2328';
  ctx.fillStyle = '#1f2328';

  const edgeUsage = new Map();
  const sceneEdges = [];
  const selectedNodes = currentSelection.nodes;
  const hoverNodes = hoverHighlight.nodes;
  const selectedEdges = currentSelection.edges;
  const hoverEdges = hoverHighlight.edges;

  (graph.edges || []).forEach(edge => {
    const key = edge.start + '->' + edge.end;
    const idx = edgeUsage.get(key) ?? 0;
    const tailGeom = nodeGeometry[edge.start];
    const headGeom = nodeGeometry[edge.end];
    if (!tailGeom || !headGeom) {
      return;
    }

    let points = buildOrthogonalPath(tailGeom, headGeom);
    if (!points || points.length < 2) {
      if (edgeLookup && edgeLookup.has(key)) {
        const variants = edgeLookup.get(key);
        points = variants[Math.min(idx, variants.length - 1)];
      }
    }
    if (!points || points.length < 2) {
      const start = tailGeom?.center;
      const end = headGeom?.center;
      if (start && end) {
        points = [start, end];
      }
    }
    if (!points || points.length < 2) {
      return;
    }
    if (!edgeLookup || !edgeLookup.has(key)) {
      points = adjustEdgePath(points, tailGeom, headGeom);
    }
    edgeUsage.set(key, idx + 1);
    const edgeId = key + '#' + idx;
    const storedPoints = points.map(pt => ({ x: pt.x, y: pt.y }));
    let highlightState = 'none';
    if (selectedEdges.has(edgeId) ||
        (selectedNodes.has(edge.start) && selectedNodes.has(edge.end))) {
      highlightState = 'selected';
    } else if (hoverEdges.has(edgeId) ||
        (hoverNodes.has(edge.start) && hoverNodes.has(edge.end))) {
      highlightState = 'hover';
    }
    sceneEdges.push({
      id: edgeId,
      start: edge.start,
      end: edge.end,
      points: storedPoints,
    });
    drawEdgeWithPath(points, highlightState);
  });

  nodeNames.forEach(name => {
    let highlightState = 'none';
    if (selectedNodes.has(name)) {
      highlightState = 'selected';
    } else if (hoverNodes.has(name)) {
      highlightState = 'hover';
    }
    drawNode(name, nodeGeometry[name], highlightState);
  });
  topicNames.forEach(name => {
    let highlightState = 'none';
    if (selectedNodes.has(name)) {
      highlightState = 'selected';
    } else if (hoverNodes.has(name)) {
      highlightState = 'hover';
    }
    drawTopic(name, nodeGeometry[name], highlightState);
  });
  ctx.restore();

  const nodesMap = new Map(Object.entries(nodeGeometry));
  currentScene = {
    nodes: nodesMap,
    edges: sceneEdges,
  };
  validateContextMenuTarget();
  refreshOverlay();
}

function handleWheel(event) {
  if (!lastGraph) {
    return;
  }
  event.preventDefault();
  const point = getCanvasPoint(event);
  const delta = -event.deltaY;
  const factor = Math.exp(delta * ZOOM_SENSITIVITY);
  if (!Number.isFinite(factor) || factor <= 0) {
    return;
  }
  const targetScale = clamp(viewState.scale * factor, VIEW_MIN_SCALE, VIEW_MAX_SCALE);
  if (Math.abs(targetScale - viewState.scale) < 1e-6) {
    return;
  }
  const baseX = (point.x - viewState.offsetX) / viewState.scale;
  const baseY = (point.y - viewState.offsetY) / viewState.scale;
  viewState.scale = targetScale;
  viewState.offsetX = point.x - baseX * targetScale;
  viewState.offsetY = point.y - baseY * targetScale;
  userAdjustedView = true;
  renderGraph(lastGraph, lastFingerprint);
  updateHoverHighlight(event);
}

function handlePointerDown(event) {
  if (event.button !== 0 || !lastGraph) {
    return;
  }
  event.preventDefault();
  hideOverlay();
  hideContextMenu();
  const point = getCanvasPoint(event);
  const graphPoint = toGraphSpace(point);
  const nodeHit = findNodeAt(graphPoint);
  const edgeHit = nodeHit ? null : findEdgeAt(graphPoint);

  if (nodeHit || edgeHit) {
    const highlight = nodeHit
      ? computeNodeHoverHighlight(nodeHit.name, nodeHit.geometry)
      : computeEdgeHoverHighlight(edgeHit);
    setSelection(highlight, 'toggle');
    setHoverHighlight(highlight);
    return;
  }

  setHoverHighlight(null);
  panState.active = true;
  panState.pointerId = event.pointerId;
  panState.lastX = point.x;
  panState.lastY = point.y;
  userAdjustedView = true;
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch (err) {
    // Ignore errors from pointer capture on unsupported browsers.
  }
}

function handlePointerMove(event) {
  if (!lastGraph) {
    return;
  }
  if (panState.active && event.pointerId === panState.pointerId) {
    event.preventDefault();
    const point = getCanvasPoint(event);
    const dx = point.x - panState.lastX;
    const dy = point.y - panState.lastY;
    if (dx === 0 && dy === 0) {
      return;
    }
    panState.lastX = point.x;
    panState.lastY = point.y;
    viewState.offsetX += dx;
    viewState.offsetY += dy;
    renderGraph(lastGraph, lastFingerprint);
    return;
  }
  updateHoverHighlight(event);
}

function endPan(pointerId) {
  if (!panState.active || panState.pointerId !== pointerId) {
    return;
  }
  panState.active = false;
  panState.pointerId = null;
  try {
    canvas.releasePointerCapture(pointerId);
  } catch (err) {
    // Ignore release errors when capture was not set.
  }
}

function handlePointerUp(event) {
  if (panState.active && event.pointerId === panState.pointerId) {
    event.preventDefault();
    endPan(event.pointerId);
    updateHoverHighlight(event);
    return;
  }
}

function handlePointerCancel(event) {
  endPan(event.pointerId);
  clearHoverHighlight();
}

function handleContextMenu(event) {
  event.preventDefault();
  if (!lastGraph) {
    return;
  }
  const canvasPoint = getCanvasPoint(event);
  const graphPoint = toGraphSpace(canvasPoint);
  const nodeHit = findNodeAt(graphPoint);
  if (nodeHit && nodeHit.geometry?.type === 'topic') {
    hideOverlay();
    const target = resolveTopicNodeTarget(nodeHit);
    if (target) {
      showContextMenu({ x: event.clientX, y: event.clientY }, target);
      return;
    }
  }
  const edgeHit = findEdgeAt(graphPoint);
  if (edgeHit) {
    const target = resolveTopicEdgeTarget(edgeHit);
    if (target) {
      hideOverlay();
      showContextMenu({ x: event.clientX, y: event.clientY }, target);
      return;
    }
  }
  if (nodeHit) {
    hideContextMenu();
    showOverlayForNode(nodeHit.name, nodeHit.geometry);
    return;
  }
  hideOverlay();
  hideContextMenu();
}

function handleDoubleClick(event) {
  if (!lastGraph) {
    return;
  }
  event.preventDefault();
  const point = getCanvasPoint(event);
  const graphPoint = toGraphSpace(point);
  const nodeHit = findNodeAt(graphPoint);
  const edgeHit = nodeHit ? null : findEdgeAt(graphPoint);
  if (nodeHit || edgeHit) {
    return;
  }
  setSelection(null, 'clear');
  setHoverHighlight(null);
}

function handleKeyDown(event) {
  if (event.key === 'Escape') {
    hideOverlay();
    hideContextMenu();
  }
}

function drawEdgeWithPath(points, highlightState) {
  if (!points || points.length < 2) {
    return;
  }
  ctx.save();
  const baseStroke = getStrokeWidth();
  let stroke = '#24303a';
  let width = baseStroke;
  if (highlightState === 'selected') {
    stroke = SELECT_EDGE_COLOR;
    width = Math.min(MAX_STROKE_WIDTH * 1.8, baseStroke * 1.8 + 1);
  } else if (highlightState === 'hover') {
    stroke = HOVER_EDGE_COLOR;
    width = Math.min(MAX_STROKE_WIDTH * 1.4, baseStroke * 1.4 + 0.5);
  }
  ctx.strokeStyle = stroke;
  ctx.fillStyle = stroke;
  ctx.lineWidth = width;
  drawPolyline(points);
  drawArrowHead(points[points.length - 2], points[points.length - 1]);
  ctx.restore();
}

function drawPolyline(points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
}

function drawArrowHead(start, end) {
  if (!start || !end) {
    return;
  }
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const scale = viewState.scale || 1;
  const headLen = clamp(9 / scale, MIN_ARROW_HEAD, MAX_ARROW_HEAD);
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(
    end.x - headLen * Math.cos(angle - Math.PI / 6),
    end.y - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    end.x - headLen * Math.cos(angle + Math.PI / 6),
    end.y - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

function decodeGraphvizLabel(rawLabel, fallbackText, nodeName) {
  const lines = [];
  const text = rawLabel && rawLabel.length ? rawLabel : fallbackText ?? '';
  if (!text) {
    return [{ text: '', align: 'center' }];
  }

  let buffer = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      const code = text[i + 1];
      if (code === 'n' || code === 'l' || code === 'r') {
        const align = code === 'l' ? 'left' : code === 'r' ? 'right' : 'center';
        lines.push({ text: buffer, align });
        buffer = '';
        i += 2;
        continue;
      }
      if (code === 'N') {
        buffer += nodeName ?? '';
        i += 2;
        continue;
      }
      if (code === '\\') {
        buffer += '\\';
        i += 2;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  lines.push({ text: buffer, align: 'center' });

  if (!lines.length) {
    return [{ text: fallbackText ?? '', align: 'center' }];
  }
  return lines;
}

function measureLabel(lines, fontSize = BASE_FONT_SIZE) {
  ctx.save();
  const effectiveFontSize = Math.max(fontSize, MIN_FONT_SIZE_PX);
  ctx.font = `${effectiveFontSize}px ${BASE_FONT_FAMILY}`;
  let maxWidth = 0;
  lines.forEach(line => {
    const metrics = ctx.measureText(line.text);
    maxWidth = Math.max(maxWidth, metrics.width);
  });
  ctx.restore();
  const lineHeight = effectiveFontSize * BASE_LINE_HEIGHT_RATIO;
  const height = Math.max(lines.length * lineHeight, lineHeight);
  return { width: maxWidth, height, lineHeight };
}

function drawGraphvizLabel(lines, center, boxWidth, options) {
  const fontSize = Math.max(options.fontSize || BASE_FONT_SIZE, MIN_FONT_SIZE_PX);
  const lineHeight = options.lineHeight ?? fontSize * BASE_LINE_HEIGHT_RATIO;
  const paddingX = options.paddingX;
  ctx.save();
  ctx.font = `${fontSize}px ${BASE_FONT_FAMILY}`;
  ctx.fillStyle = '#0d1117';
  ctx.textBaseline = 'middle';
  const effectiveLineHeight = lineHeight;
  const totalHeight = Math.max(lines.length * effectiveLineHeight, effectiveLineHeight);
  const halfBoxWidth = boxWidth / 2;
  const rawPadding = Number.isFinite(paddingX) ? paddingX : 6;
  const innerPadding = Math.min(Math.max(rawPadding, 4), boxWidth / 2);
  const leftX = center.x - halfBoxWidth + innerPadding;
  const rightX = center.x + halfBoxWidth - innerPadding;
  lines.forEach((line, idx) => {
    const y = center.y - totalHeight / 2 + effectiveLineHeight * idx + effectiveLineHeight / 2;
    if (line.align === 'left') {
      ctx.textAlign = 'left';
      ctx.fillText(line.text, leftX, y);
    } else if (line.align === 'right') {
      ctx.textAlign = 'right';
      ctx.fillText(line.text, rightX, y);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(line.text, center.x, y);
    }
  });
  ctx.restore();
}

function drawNode(name, geometry, highlightState) {
  if (!geometry) {
    return;
  }
  const { center, width, height, info, labelLines, fontSize, lineHeight, paddingX } = geometry;
  const rx = Math.max(width / 2, 4);
  const ry = Math.max(height / 2, 4);
  ctx.save();
  const baseStroke = getStrokeWidth();
  let stroke = info.strokeColor || '#1f2328';
  let fill = info.fillColor && info.fillColor !== 'none' ? info.fillColor : '#9ebaff';
  let lineWidth = baseStroke;
  if (highlightState === 'selected') {
    stroke = SELECT_NODE_STROKE;
    fill = SELECT_NODE_FILL;
    lineWidth = Math.min(MAX_STROKE_WIDTH * 1.6, baseStroke * 1.6 + 1);
  } else if (highlightState === 'hover') {
    stroke = HOVER_NODE_STROKE;
    fill = HOVER_NODE_FILL;
    lineWidth = Math.min(MAX_STROKE_WIDTH * 1.3, baseStroke * 1.3 + 0.5);
  }
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(center.x, center.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  drawGraphvizLabel(labelLines, center, width, { fontSize, lineHeight, paddingX });
  ctx.restore();
}

function drawTopic(name, geometry, highlightState) {
  if (!geometry) {
    return;
  }
  const { center, width, height, info, labelLines, fontSize, lineHeight, paddingX } = geometry;
  const boxWidth = Math.max(width, 12);
  const boxHeight = Math.max(height, 12);
  ctx.save();
  const baseStroke = getStrokeWidth();
  let stroke = info.strokeColor || '#1f2328';
  let fill = info.fillColor && info.fillColor !== 'none' ? info.fillColor : '#b8e1b3';
  let lineWidth = baseStroke;
  if (highlightState === 'selected') {
    stroke = SELECT_TOPIC_STROKE;
    fill = SELECT_TOPIC_FILL;
    lineWidth = Math.min(MAX_STROKE_WIDTH * 1.6, baseStroke * 1.6 + 1);
  } else if (highlightState === 'hover') {
    stroke = HOVER_TOPIC_STROKE;
    fill = HOVER_TOPIC_FILL;
    lineWidth = Math.min(MAX_STROKE_WIDTH * 1.3, baseStroke * 1.3 + 0.5);
  }
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;
  const x = center.x - boxWidth / 2;
  const y = center.y - boxHeight / 2;
  const radius = Math.min(12, Math.min(boxWidth, boxHeight) / 4);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + boxWidth - radius, y);
  ctx.quadraticCurveTo(x + boxWidth, y, x + boxWidth, y + radius);
  ctx.lineTo(x + boxWidth, y + boxHeight - radius);
  ctx.quadraticCurveTo(x + boxWidth, y + boxHeight, x + boxWidth - radius, y + boxHeight);
  ctx.lineTo(x + radius, y + boxHeight);
  ctx.quadraticCurveTo(x, y + boxHeight, x, y + boxHeight - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  drawGraphvizLabel(labelLines, center, boxWidth, { fontSize, lineHeight, paddingX });
  ctx.restore();
}

async function fetchGraph() {
  refreshBtn.disabled = true;
  try {
    const response = await fetch('/graph?ts=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const payload = await response.json();
    const graph = payload.graph;
    const nodes = graph.nodes?.length ?? 0;
    const topics = Object.keys(graph.topics || {}).length;
    const edges = graph.edges?.length ?? 0;
    const layoutEngine = graph.graphviz?.engine ? 'graphviz/' + graph.graphviz.engine : 'unavailable';
    metaEl.textContent =
      'nodes: ' + nodes +
      ' | topics: ' + topics +
      ' | edges: ' + edges +
      ' | layout: ' + layoutEngine +
      ' | fingerprint: ' + payload.fingerprint;
    statusEl.textContent = 'Last update: ' + new Date(payload.generated_at * 1000).toLocaleTimeString();
    renderGraph(graph, payload.fingerprint);
  } catch (err) {
    statusEl.textContent = 'Error fetching data: ' + err.message;
  } finally {
    refreshBtn.disabled = false;
  }
}

resizeCanvas();
fetchGraph();
setInterval(fetchGraph, 2000);
