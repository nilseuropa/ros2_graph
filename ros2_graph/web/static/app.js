const canvas = document.getElementById('graphCanvas');
const ctx = canvas.getContext('2d');
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
const DESIRED_LABEL_SCALE = 0.5;
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
const BASE_FONT_FAMILY = '"Times New Roman", serif';
const BASE_FONT_SIZE = 14;
const BASE_LINE_HEIGHT = 18;

function resetViewState() {
  viewState.scale = 1;
  viewState.offsetX = 0;
  viewState.offsetY = 0;
  userAdjustedView = false;
}

resetViewState();

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

  const scaleBoost = Math.max(0, (DESIRED_LABEL_SCALE ?? 1) - 1);
  const maxFactor = Math.max(3.5, 1 + scaleBoost * 2.4);
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
canvas.addEventListener('dblclick', handleDoubleClick);

const HIDDEN_NAME_PATTERNS = [/\/rosout\b/i];

function isHiddenGraphName(name) {
  if (!name) {
    return false;
  }
  return HIDDEN_NAME_PATTERNS.some(pattern => pattern.test(name));
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
    return;
  }

  if (fingerprint !== undefined && fingerprint !== null) {
    if (fingerprint !== lastFingerprint && !userAdjustedView) {
      resetViewState();
    }
    lastFingerprint = fingerprint;
  }

  lastGraph = graph;
  const width = canvas.width;
  const height = canvas.height;
  const nodeNames = (graph.nodes || []).filter(name => !isHiddenGraphName(name));
  const topicNames = Object.keys(graph.topics || {}).filter(name => !isHiddenGraphName(name));

  if (!graph.graphviz?.plain) {
    currentScene = {
      nodes: new Map(),
      edges: [],
    };
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

    const desiredFontScale = DESIRED_LABEL_SCALE;
    if (metrics.width > 0 && Number.isFinite(desiredFontScale) && desiredFontScale > 0) {
      const desiredTextWidth = metrics.width * desiredFontScale;
      finalWidthPx = Math.max(finalWidthPx, desiredTextWidth + 12);
    }
    if (metrics.height > 0 && Number.isFinite(desiredFontScale) && desiredFontScale > 0) {
      const desiredTextHeight = metrics.height * desiredFontScale;
      finalHeightPx = Math.max(finalHeightPx, desiredTextHeight + 12);
    }

    const availableWidth = Math.max(finalWidthPx - 8, 4);
    const availableHeight = Math.max(finalHeightPx - 8, 4);
    const widthScale = metrics.width > 0 ? availableWidth / metrics.width : Infinity;
    const heightScale = metrics.height > 0 ? availableHeight / metrics.height : Infinity;
    const maxScale = Math.min(widthScale, heightScale);

    geometryEntries.push({
      name,
      info: nodeInfo,
      center,
      labelLines,
      metrics,
      width: finalWidthPx,
      height: finalHeightPx,
      availableWidth,
      availableHeight,
      maxScale,
      type: topicSet.has(name) || (nodeInfo.shape || '').toLowerCase().includes('box') ? 'topic' : 'node',
    });
  });

  if (!geometryEntries.length) {
    currentScene = {
      nodes: new Map(),
      edges: [],
    };
    ctx.save();
    ctx.fillStyle = '#c9d1d9';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GraphViz layout empty', width / 2, height / 2);
    ctx.restore();
    return;
  }

  let uniformScale = DESIRED_LABEL_SCALE;
  let limitingScale = Infinity;
  geometryEntries.forEach(entry => {
    if (Number.isFinite(entry.maxScale) && entry.maxScale > 0) {
      limitingScale = Math.min(limitingScale, entry.maxScale);
    }
  });
  if (Number.isFinite(limitingScale)) {
    uniformScale = Math.min(uniformScale, limitingScale);
  }
  if (!Number.isFinite(uniformScale) || uniformScale <= 0) {
    if (Number.isFinite(limitingScale) && limitingScale > 0) {
      uniformScale = limitingScale;
    } else {
      uniformScale = 1;
    }
  }

  geometryEntries.forEach(entry => {
    const fontScale = Number.isFinite(entry.maxScale) && entry.maxScale > 0
      ? Math.min(uniformScale, entry.maxScale)
      : uniformScale;
    const fontSize = BASE_FONT_SIZE * fontScale;
    const lineHeight = (entry.metrics.lineHeight || BASE_LINE_HEIGHT) * fontScale;
    const textWidth = entry.metrics.width * fontScale;
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

function drawEdgeWithPath(points, highlightState) {
  if (!points || points.length < 2) {
    return;
  }
  ctx.save();
  const baseStroke = getStrokeWidth();
  let stroke = '#1f2328';
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
  ctx.font = `${fontSize}px ${BASE_FONT_FAMILY}`;
  let maxWidth = 0;
  lines.forEach(line => {
    const metrics = ctx.measureText(line.text);
    maxWidth = Math.max(maxWidth, metrics.width);
  });
  ctx.restore();
  const lineHeight = (fontSize / BASE_FONT_SIZE) * BASE_LINE_HEIGHT;
  const height = Math.max(lines.length * lineHeight, lineHeight);
  return { width: maxWidth, height, lineHeight };
}

function drawGraphvizLabel(lines, center, boxWidth, options) {
  const fontSize = options.fontSize || BASE_FONT_SIZE;
  const lineHeight = options.lineHeight || (fontSize / BASE_FONT_SIZE) * BASE_LINE_HEIGHT;
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
