export function scalePoint(point, factor, origin = { x: 0, y: 0 }) {
  return {
    x: origin.x + (point.x - origin.x) * factor,
    y: origin.y + (point.y - origin.y) * factor,
  };
}

export function midpoint(points) {
  if (!points?.length) {
    return null;
  }
  if (points.length === 1) {
    return points[0];
  }

  let total = 0;
  const segments = [];
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    segments.push({ start, end, length });
    total += length;
  }
  if (total <= 0) {
    return points[0];
  }
  const half = total / 2;
  let traversed = 0;
  for (const segment of segments) {
    if (traversed + segment.length >= half) {
      const ratio = (half - traversed) / segment.length;
      return {
        x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        y: segment.start.y + (segment.end.y - segment.start.y) * ratio,
      };
    }
    traversed += segment.length;
  }
  return points[points.length - 1];
}

export function isPointInRect(point, rect) {
  if (!point || !rect) {
    return false;
  }
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}
