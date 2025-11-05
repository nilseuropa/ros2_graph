import { parseGraphvizPlain, createLayoutScaler, computeFontSizePx, decodeLabelLines } from '../layout/graphviz.js';
import { BASE_FONT_SIZE, BASE_LINE_HEIGHT_RATIO, BASE_FONT_FAMILY } from '../constants/index.js';

const HIDDEN_NAME_PATTERNS = [/\/rosout\b/i];

const createEmptyScene = () => ({
  nodes: new Map(),
  topics: new Map(),
  edges: [],
  layout: null,
});

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

  const scaler = createLayoutScaler(effectiveLayout, canvasWidth, canvasHeight);
  if (!scaler) {
    return createEmptyScene();
  }

  const topicNames = new Set(Object.keys(graph.topics || {}));
  const nodes = new Map();
  const topics = new Map();
  const lookup = new Map();

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
  });

  const visibleNames = new Set([...nodes.keys(), ...topics.keys()]);
  const edges = effectiveLayout.edges
    .filter(edge => visibleNames.has(edge.tail) && visibleNames.has(edge.head))
    .map(edge => {
      const points = orthogonalizePoints(edge.points.map(point => scaler.toCanvas(point)));
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

  return {
    nodes,
    topics,
    edges,
    layout: effectiveLayout,
    scaler,
    lookup,
  };
}

function orthogonalizePoints(points) {
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
  const mid = dx >= dy ? { x: end.x, y: start.y } : { x: start.x, y: end.y };
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

function dedupeConsecutive(points) {
  if (points.length <= 1) {
    return points;
  }
  const deduped = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    if (!isSame(points[i], deduped[deduped.length - 1])) {
      deduped.push(points[i]);
    }
  }
  if (deduped.length < 2) {
    return points.slice(0, 2);
  }
  return deduped;
}
