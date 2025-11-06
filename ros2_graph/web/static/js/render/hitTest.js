const NODE_HIT_PADDING = 6;
const EDGE_HIT_THRESHOLD = 8;

export function hitTestScene(scene, point) {
  if (!scene || !point) {
    return null;
  }

  const nodeHit = hitNodes(scene, point);
  if (nodeHit) {
    return nodeHit;
  }
  const topicHit = hitTopics(scene, point);
  if (topicHit) {
    return topicHit;
  }
  const edgeHit = hitEdges(scene, point);
  if (edgeHit) {
    return edgeHit;
  }
  return null;
}

export function hitNodes(scene, point) {
  if (!scene?.nodes) {
    return null;
  }
  for (const [name, geometry] of scene.nodes) {
    if (isPointInEllipse(point, geometry, NODE_HIT_PADDING)) {
      return { type: 'node', name, geometry };
    }
  }
  return null;
}

export function hitTopics(scene, point) {
  if (!scene?.topics) {
    return null;
  }
  for (const [name, geometry] of scene.topics) {
    if (isPointInRoundedRect(point, geometry, NODE_HIT_PADDING)) {
      return { type: 'topic', name, geometry };
    }
  }
  return null;
}

export function hitEdges(scene, point) {
  if (!scene?.edges) {
    return null;
  }
  let best = null;
  let bestDistance = Infinity;
  for (const edge of scene.edges) {
    const points = edge.__renderPoints ?? edge.points;
    const distance = distanceToPolyline(point, points);
    if (distance < bestDistance && distance <= EDGE_HIT_THRESHOLD) {
      bestDistance = distance;
      best = {
        type: 'edge',
        name: `${edge.tail}->${edge.head}`,
        edge,
      };
    }
  }
  return best;
}

function isPointInEllipse(point, geometry, padding = 0) {
  if (!geometry?.center) {
    return false;
  }
  const rx = Math.max(geometry.width / 2 + padding, 1);
  const ry = Math.max(geometry.height / 2 + padding, 1);
  const dx = point.x - geometry.center.x;
  const dy = point.y - geometry.center.y;
  const normalized = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  return normalized <= 1;
}

function isPointInRoundedRect(point, geometry, padding = 0) {
  if (!geometry?.center) {
    return false;
  }
  const halfWidth = geometry.width / 2 + padding;
  const halfHeight = geometry.height / 2 + padding;
  const left = geometry.center.x - halfWidth;
  const right = geometry.center.x + halfWidth;
  const top = geometry.center.y - halfHeight;
  const bottom = geometry.center.y + halfHeight;
  if (point.x < left || point.x > right || point.y < top || point.y > bottom) {
    return false;
  }
  return true;
}

function distanceToPolyline(point, points) {
  if (!points || points.length < 2) {
    return Infinity;
  }
  let minDistance = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    const distance = distanceToSegment(point, start, end);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }
  return minDistance;
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const projX = start.x + t * dx;
  const projY = start.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}
