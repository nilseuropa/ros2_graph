import {
  parseGraphvizPlain,
  createLayoutScaler,
  computeFontSizePx,
  decodeLabelLines,
} from '../layout/graphviz.js';
import {
  BASE_FONT_SIZE,
  BASE_LINE_HEIGHT_RATIO,
  BASE_FONT_FAMILY,
  VIEW_MAX_SCALE,
} from '../constants/index.js';

const HIDDEN_NAME_PATTERNS = [/\/rosout\b/i];

const createEmptyScene = () => ({
  nodes: new Map(),
  topics: new Map(),
  edges: [],
  layout: null,
  scaler: null,
  lookup: new Map(),
  bounds: {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    width: 0,
    height: 0,
    centerX: 0,
    centerY: 0,
  },
  fitView: {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  },
});

function createBoundsTracker() {
  return {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
}

function updateBoundsWithRect(bounds, center, width, height) {
  if (!center || !Number.isFinite(width) || !Number.isFinite(height)) {
    return;
  }
  const halfWidth = Math.max(width / 2, 0);
  const halfHeight = Math.max(height / 2, 0);
  const left = center.x - halfWidth;
  const right = center.x + halfWidth;
  const top = center.y - halfHeight;
  const bottom = center.y + halfHeight;
  updateBoundsWithPoint(bounds, { x: left, y: top });
  updateBoundsWithPoint(bounds, { x: right, y: bottom });
}

function updateBoundsWithPoint(bounds, point) {
  if (!point) {
    return;
  }
  if (Number.isFinite(point.x)) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
  }
  if (Number.isFinite(point.y)) {
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }
}

function finalizeBounds(bounds, dimensions) {
  if (bounds.minX === Infinity || bounds.minY === Infinity) {
    const width = dimensions?.width ?? 0;
    const height = dimensions?.height ?? 0;
    return {
      minX: 0,
      minY: 0,
      maxX: width,
      maxY: height,
      width,
      height,
      centerX: width / 2,
      centerY: height / 2,
    };
  }
  const width = Math.max(bounds.maxX - bounds.minX, 0);
  const height = Math.max(bounds.maxY - bounds.minY, 0);
  return {
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    width,
    height,
    centerX: bounds.minX + width / 2,
    centerY: bounds.minY + height / 2,
  };
}

export function computeFitView(bounds, canvasWidth, canvasHeight) {
  if (
    !bounds ||
    !Number.isFinite(canvasWidth) ||
    !Number.isFinite(canvasHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const width = bounds.width || 1;
  const height = bounds.height || 1;
  const widthScale = canvasWidth / width;
  const heightScale = canvasHeight / height;
  const desiredScale = Math.min(widthScale, heightScale);
  const scale =
    Number.isFinite(desiredScale) && desiredScale > 0
      ? Math.min(desiredScale, VIEW_MAX_SCALE)
      : 1;
  const offsetX = (canvasWidth - width * scale) / 2 - bounds.minX * scale;
  const offsetY = (canvasHeight - height * scale) / 2 - bounds.minY * scale;
  return { scale, offsetX, offsetY };
}

function isHiddenName(name) {
  if (!name) {
    return false;
  }
  return HIDDEN_NAME_PATTERNS.some(pattern => pattern.test(name));
}

function remapLayout(layout, idMapping) {
  if (!idMapping) {
    return layout;
  }
  const remappedNodes = new Map();
  layout.nodes.forEach((info, graphvizId) => {
    const actualName = idMapping[graphvizId] ?? graphvizId;
    remappedNodes.set(actualName, { ...info, name: actualName });
  });
  const remappedEdges = layout.edges.map(edge => ({
    tail: idMapping[edge.tail] ?? edge.tail,
    head: idMapping[edge.head] ?? edge.head,
    points: edge.points,
  }));
  return {
    ...layout,
    nodes: remappedNodes,
    edges: remappedEdges,
  };
}

function computeIdMapping(graph) {
  const mapping = graph?.graphviz?.ids;
  if (!mapping) {
    return null;
  }
  // Mapping arrives as { "<actual>" : "<graphvizId>" }
  const reverse = {};
  Object.entries(mapping).forEach(([actual, graphvizId]) => {
    if (graphvizId) {
      reverse[graphvizId] = actual;
    }
  });
  if (!Object.keys(reverse).length) {
    return null;
  }
  return reverse;
}

export function buildScene(graph, canvasWidth, canvasHeight) {
  if (!graph?.graphviz?.plain) {
    return createEmptyScene();
  }
  const layout = parseGraphvizPlain(graph.graphviz.plain);
  if (!layout) {
    return createEmptyScene();
  }

  const reverseIds = computeIdMapping(graph);
  let effectiveLayout = layout;
  const layoutWithMaps =
    layout.nodes instanceof Map
      ? layout
      : {
          ...layout,
          nodes: new Map(Object.entries(layout.nodes)),
        };

  effectiveLayout = reverseIds ? remapLayout(layoutWithMaps, reverseIds) : layoutWithMaps;

  const scaler = createLayoutScaler(effectiveLayout);
  if (!scaler) {
    return createEmptyScene();
  }

  const topicNames = new Set(Object.keys(graph.topics || {}));
  const nodes = new Map();
  const topics = new Map();
  const lookup = new Map();
  const boundsTracker = createBoundsTracker();

  effectiveLayout.nodes.forEach(nodeInfo => {
    const name = nodeInfo.name ?? nodeInfo.id ?? nodeInfo.label;
    if (!name || isHiddenName(name)) {
      return;
    }
    const center = scaler.toCanvas({ x: nodeInfo.x, y: nodeInfo.y });
    const width = scaler.scaleLength(nodeInfo.width);
    const height = scaler.scaleLength(nodeInfo.height);
    const labelLines = decodeLabelLines(nodeInfo.rawLabel, nodeInfo.label || name, name);
    const fontSize = computeFontSizePx(nodeInfo, scaler);
    const lineHeight = Math.max(fontSize * BASE_LINE_HEIGHT_RATIO, fontSize);
    const approxCharWidth = fontSize * 0.6;
    const estimatedTextWidth = labelLines.reduce((max, line) => {
      const length = typeof line.text === 'string' ? line.text.length : 0;
      return Math.max(max, length * approxCharWidth);
    }, fontSize);
    const isTopic = topicNames.has(name);
    const padding = isTopic ? 20 : 16;
    const estimatedWidth = Math.max(width, estimatedTextWidth + padding);
    const estimatedHeight = Math.max(
      height,
      lineHeight * labelLines.length + (isTopic ? padding * 0.6 : padding * 0.5),
    );
    const geometry = {
      center,
      width: Math.max(width, 24),
      height: Math.max(height, 24),
      labelLines,
      fontSize,
      lineHeight,
      strokeColor: nodeInfo.strokeColor || '#1f2328',
      fillColor: nodeInfo.fillColor && nodeInfo.fillColor !== 'none' ? nodeInfo.fillColor : undefined,
      shape: nodeInfo.shape || '',
      fontFamily: BASE_FONT_FAMILY,
      name,
    };
    if (topicNames.has(name)) {
      topics.set(name, geometry);
      lookup.set(name, { type: 'topic', geometry });
    } else {
      nodes.set(name, geometry);
      lookup.set(name, { type: 'node', geometry });
    }
    updateBoundsWithRect(
      boundsTracker,
      center,
      Math.max(geometry.width, estimatedWidth),
      Math.max(geometry.height, estimatedHeight),
    );
  });

  const visibleNames = new Set([...nodes.keys(), ...topics.keys()]);
  const edges = effectiveLayout.edges
    .filter(edge => visibleNames.has(edge.tail) && visibleNames.has(edge.head))
    .map(edge => {
      const tailType = topics.has(edge.tail) ? 'topic' : nodes.has(edge.tail) ? 'node' : 'other';
      const headType = topics.has(edge.head) ? 'topic' : nodes.has(edge.head) ? 'node' : 'other';
      const scaledPoints = edge.points.map(point => scaler.toCanvas(point));
      scaledPoints.forEach(point => updateBoundsWithPoint(boundsTracker, point));
      const points = orthogonalizePoints(scaledPoints, tailType, headType);
      points.forEach(point => updateBoundsWithPoint(boundsTracker, point));
      return {
        tail: edge.tail,
        head: edge.head,
        key: `${edge.tail}->${edge.head}`,
        points,
      };
  });
  edges.forEach(edge => {
    lookup.set(edge.key, { type: 'edge', edge });
  });

  const bounds = finalizeBounds(boundsTracker, scaler.dimensions);
  const fitView = computeFitView(bounds, canvasWidth, canvasHeight);

  return {
    nodes,
    topics,
    edges,
    layout: effectiveLayout,
    scaler,
    lookup,
    bounds,
    fitView,
  };
}

function orthogonalizePoints(points, tailType, headType) {
  if (!Array.isArray(points) || points.length < 2) {
    return points || [];
  }
  const start = points[0];
  const end = points[points.length - 1];
  if (isSame(start, end)) {
    return [start];
  }
  const result = [start];
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  if (dx < 1e-2 || dy < 1e-2) {
    result.push(end);
    return result;
  }
  let mid;
  if (headType === 'topic') {
    mid = { x: start.x, y: end.y };
  } else if (tailType === 'topic') {
    mid = { x: end.x, y: start.y };
  } else {
    mid = dx >= dy ? { x: end.x, y: start.y } : { x: start.x, y: end.y };
  }
  if (!isSame(start, mid)) {
    result.push(mid);
  }
  if (!isSame(mid, end)) {
    result.push(end);
  }
  return result;
}

function isSame(a, b) {
  if (!a || !b) {
    return false;
  }
  return Math.abs(a.x - b.x) < 1e-2 && Math.abs(a.y - b.y) < 1e-2;
}
