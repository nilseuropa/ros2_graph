import { BASE_STROKE_WIDTH, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH, BASE_FONT_FAMILY } from '../constants/index.js';
import { arrowHeadSize, drawLabel } from '../layout/graphviz.js';
import { computeFitView } from './sceneBuilder.js';

const DEFAULT_GRAPH_PALETTE = {
  edge: '#3a4b5e',
  edgeHover: '#5cb2ff',
  edgeSelect: '#ffab3d',
  node: {
    baseFill: '#2b4a65',
    hoverFill: '#3f6d90',
    selectFill: '#4b7da1',
  },
  topic: {
    baseFill: '#14202c',
    hoverFill: '#162331',
    selectFill: '#1f2e41',
  },
  labelText: '#f0f6fc',
};

function cloneGraphPalette(palette) {
  const source = palette || DEFAULT_GRAPH_PALETTE;
  return {
    edge: source.edge,
    edgeHover: source.edgeHover,
    edgeSelect: source.edgeSelect,
    node: {
      baseFill: source.node?.baseFill,
      hoverFill: source.node?.hoverFill,
      selectFill: source.node?.selectFill,
    },
    topic: {
      baseFill: source.topic?.baseFill,
      hoverFill: source.topic?.hoverFill,
      selectFill: source.topic?.selectFill,
    },
    labelText: source.labelText,
  };
}

function normalizeGraphPalette(palette) {
  const source = cloneGraphPalette(palette);
  return {
    edge: source.edge ?? DEFAULT_GRAPH_PALETTE.edge,
    edgeHover: source.edgeHover ?? DEFAULT_GRAPH_PALETTE.edgeHover,
    edgeSelect: source.edgeSelect ?? DEFAULT_GRAPH_PALETTE.edgeSelect,
    node: {
      baseFill: source.node.baseFill ?? DEFAULT_GRAPH_PALETTE.node.baseFill,
      hoverFill: source.node.hoverFill ?? DEFAULT_GRAPH_PALETTE.node.hoverFill,
      selectFill: source.node.selectFill ?? DEFAULT_GRAPH_PALETTE.node.selectFill,
    },
    topic: {
      baseFill: source.topic.baseFill ?? DEFAULT_GRAPH_PALETTE.topic.baseFill,
      hoverFill: source.topic.hoverFill ?? DEFAULT_GRAPH_PALETTE.topic.hoverFill,
      selectFill: source.topic.selectFill ?? DEFAULT_GRAPH_PALETTE.topic.selectFill,
    },
    labelText: source.labelText ?? DEFAULT_GRAPH_PALETTE.labelText,
  };
}

export class GraphRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = null;
    this.view = { scale: 1, offsetX: 0, offsetY: 0 };
    this.selection = { nodes: new Set(), topics: new Set(), edges: new Set() };
    this.hover = null;
    this.palette = normalizeGraphPalette();
  }

  setScene(scene) {
    this.scene = scene;
    this.draw();
  }

  setView(view) {
    this.view = view;
    this.draw();
  }

  setSelection(selection) {
    this.selection = selection ?? { nodes: new Set(), topics: new Set(), edges: new Set() };
    this.draw();
  }

  setHover(hover) {
    this.hover = hover;
    this.draw();
  }

  setPalette(palette) {
    this.palette = normalizeGraphPalette(palette);
    this.draw();
  }

  clear() {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  }

  draw() {
    this.clear();
    if (!this.scene) {
      return;
    }
    const { ctx } = this;
    const { scale, offsetX, offsetY } = this.view;
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    this.prepareGeometryForDraw();

    this.drawEdges();
    this.drawNodes();

    ctx.restore();
  }

  prepareGeometryForDraw() {
    if (!this.scene) {
      return;
    }
    const bounds = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    const updateRectBounds = geometry => {
      if (!geometry?.center) {
        return;
      }
      const halfWidth = Math.max(geometry.width, 0) / 2;
      const halfHeight = Math.max(geometry.height, 0) / 2;
      const left = geometry.center.x - halfWidth;
      const right = geometry.center.x + halfWidth;
      const top = geometry.center.y - halfHeight;
      const bottom = geometry.center.y + halfHeight;
      bounds.minX = Math.min(bounds.minX, left);
      bounds.maxX = Math.max(bounds.maxX, right);
      bounds.minY = Math.min(bounds.minY, top);
      bounds.maxY = Math.max(bounds.maxY, bottom);
    };
    const updatePointBounds = point => {
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
    };
    this.scene.nodes.forEach(geometry => {
      this.ensureLabelFits(geometry, 16, true);
      updateRectBounds(geometry);
    });
    this.scene.topics.forEach(geometry => {
      this.ensureLabelFits(geometry, 20, false);
      updateRectBounds(geometry);
    });
    this.scene.edges.forEach(edge => {
      const adjustedPoints = this.adjustEdgePoints(edge);
      edge.__renderPoints = adjustedPoints;
      adjustedPoints.forEach(updatePointBounds);
    });
    if (bounds.minX !== Infinity && bounds.minY !== Infinity) {
      const width = Math.max(bounds.maxX - bounds.minX, 0);
      const height = Math.max(bounds.maxY - bounds.minY, 0);
      this.scene.bounds = {
        minX: bounds.minX,
        minY: bounds.minY,
        maxX: bounds.maxX,
        maxY: bounds.maxY,
        width,
        height,
        centerX: bounds.minX + width / 2,
        centerY: bounds.minY + height / 2,
      };
      this.scene.fitView = computeFitView(this.scene.bounds, this.canvas.width, this.canvas.height);
    }
  }

  getStrokeWidth() {
    const width = BASE_STROKE_WIDTH / this.view.scale;
    return Math.max(MIN_STROKE_WIDTH, Math.min(width, MAX_STROKE_WIDTH));
  }

  drawEdges() {
    const { ctx } = this;
    const strokeWidth = this.getStrokeWidth();
    const selectedEdges = this.selection?.edges ?? new Set();
    const hoverEdges = this.hover?.edges ?? new Set();
    const palette = this.palette;

    for (const edge of this.scene.edges) {
      const key = `${edge.tail}->${edge.head}`;
      const isSelected = selectedEdges.has(key);
      const isHover = hoverEdges.has(key);
      const points = edge.__renderPoints ?? this.adjustEdgePoints(edge);
      ctx.save();
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = isSelected
        ? palette.edgeSelect
        : isHover
        ? palette.edgeHover
        : palette.edge;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      const [first, ...rest] = points;
      ctx.moveTo(first.x, first.y);
      rest.forEach(point => ctx.lineTo(point.x, point.y));
      ctx.stroke();
      this.drawArrow(points);
      ctx.restore();
    }
  }

  // Re-project edge endpoints so they stay anchored to the resized node/topic geometry.
  adjustEdgePoints(edge) {
    if (!edge?.points || edge.points.length < 2) {
      return edge?.points ?? [];
    }
    const original = edge.points;
    const adjusted = original.map(point => ({ ...point }));
    this.adjustTailEndpoint(edge, adjusted, original);
    this.adjustHeadEndpoint(edge, adjusted, original);
    return adjusted;
  }

  resolveEndpointGeometry(name) {
    if (!name || !this.scene) {
      return null;
    }
    if (this.scene.nodes.has(name)) {
      return { geometry: this.scene.nodes.get(name), shape: 'ellipse' };
    }
    if (this.scene.topics.has(name)) {
      return { geometry: this.scene.topics.get(name), shape: 'rect' };
    }
    return null;
  }

  adjustTailEndpoint(edge, adjusted, original) {
    const info = this.resolveEndpointGeometry(edge.tail);
    if (!info?.geometry) {
      return;
    }
    if (!original.length) {
      return;
    }
    const basePoint = original[0];
    const neighborPoint = original[1];
    const candidate = this.computeEndpointCandidate(info, basePoint, neighborPoint);
    if (!candidate || this.pointsAlmostEqual(candidate, basePoint)) {
      return;
    }
    const deltaX = candidate.x - basePoint.x;
    const deltaY = candidate.y - basePoint.y;
    adjusted[0] = candidate;
    if (original.length < 2) {
      return;
    }
    const axis = this.computeAxis(candidate, neighborPoint);
    this.shiftForward(adjusted, original, 0, deltaX, deltaY, axis);
  }

  adjustHeadEndpoint(edge, adjusted, original) {
    const info = this.resolveEndpointGeometry(edge.head);
    if (!info?.geometry) {
      return;
    }
    const lastIndex = original.length - 1;
    if (lastIndex < 0) {
      return;
    }
    const basePoint = original[lastIndex];
    const neighborPoint = original[lastIndex - 1];
    const candidate = this.computeEndpointCandidate(info, basePoint, neighborPoint);
    if (!candidate || this.pointsAlmostEqual(candidate, basePoint)) {
      return;
    }
    const deltaX = candidate.x - basePoint.x;
    const deltaY = candidate.y - basePoint.y;
    adjusted[lastIndex] = candidate;
    if (neighborPoint === undefined) {
      return;
    }
    const axis = this.computeAxis(neighborPoint, candidate);
    this.shiftBackward(adjusted, original, lastIndex, deltaX, deltaY, axis);
  }

  computeEndpointCandidate(info, basePoint, neighborPoint) {
    if (!info?.geometry) {
      return null;
    }
    const { geometry, shape } = info;
    const center = geometry.center;
    if (!center) {
      return null;
    }
    let direction = null;
    if (basePoint) {
      direction = {
        x: basePoint.x - center.x,
        y: basePoint.y - center.y,
      };
    }
    const isDegenerate =
      !direction ||
      (Math.abs(direction.x) < 1e-3 && Math.abs(direction.y) < 1e-3);
    if (isDegenerate && neighborPoint) {
      direction = {
        x: neighborPoint.x - center.x,
        y: neighborPoint.y - center.y,
      };
    }
    if (!direction) {
      return null;
    }
    if (Math.abs(direction.x) < 1e-3 && Math.abs(direction.y) < 1e-3) {
      return null;
    }
    return shape === 'ellipse'
      ? this.computeEllipseIntersection(geometry, direction)
      : this.computeRectIntersection(geometry, direction);
  }

  computeEllipseIntersection(geometry, direction) {
    const center = geometry.center;
    if (!center) {
      return null;
    }
    const rx = Math.max(geometry.width / 2, 1e-3);
    const ry = Math.max(geometry.height / 2, 1e-3);
    const dx = direction.x;
    const dy = direction.y;
    const denom = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
    if (!Number.isFinite(denom) || denom === 0) {
      return null;
    }
    const scale = 1 / denom;
    return {
      x: center.x + dx * scale,
      y: center.y + dy * scale,
    };
  }

  computeRectIntersection(geometry, direction) {
    const center = geometry.center;
    if (!center) {
      return null;
    }
    const halfWidth = Math.max(geometry.width / 2, 1e-3);
    const halfHeight = Math.max(geometry.height / 2, 1e-3);
    const dx = direction.x;
    const dy = direction.y;
    const scaleX = Math.abs(dx) > 1e-6 ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY;
    const scaleY = Math.abs(dy) > 1e-6 ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY;
    const scale = Math.min(scaleX, scaleY);
    if (!Number.isFinite(scale) || scale <= 0) {
      return null;
    }
    return {
      x: center.x + dx * scale,
      y: center.y + dy * scale,
    };
  }

  computeAxis(fromPoint, toPoint) {
    if (!fromPoint || !toPoint) {
      return 'none';
    }
    const dx = toPoint.x - fromPoint.x;
    const dy = toPoint.y - fromPoint.y;
    if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) {
      return 'none';
    }
    return Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
  }

  shiftForward(adjusted, original, startIndex, deltaX, deltaY, axis) {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return;
    }
    const EPS = 1e-3;
    let index = startIndex + 1;
    if (axis === 'horizontal') {
      const baseY = original[startIndex].y;
      while (index < original.length && Math.abs(original[index].y - baseY) < EPS) {
        adjusted[index] = {
          x: original[index].x + deltaX,
          y: original[index].y + deltaY,
        };
        index += 1;
      }
      if (index >= original.length) {
        return;
      }
      const anchorX = original[index - 1].x;
      while (index < original.length && Math.abs(original[index].x - anchorX) < EPS) {
        adjusted[index] = {
          x: original[index].x + deltaX,
          y: original[index].y + deltaY,
        };
        index += 1;
      }
      return;
    }
    if (axis === 'vertical') {
      const baseX = original[startIndex].x;
      while (index < original.length && Math.abs(original[index].x - baseX) < EPS) {
        adjusted[index] = {
          x: original[index].x + deltaX,
          y: original[index].y + deltaY,
        };
        index += 1;
      }
      if (index >= original.length) {
        return;
      }
      const anchorY = original[index - 1].y;
      while (index < original.length && Math.abs(original[index].y - anchorY) < EPS) {
        adjusted[index] = {
          x: original[index].x + deltaX,
          y: original[index].y + deltaY,
        };
        index += 1;
      }
      return;
    }
    if (index < original.length) {
      adjusted[index] = {
        x: original[index].x + deltaX,
        y: original[index].y + deltaY,
      };
    }
  }

  shiftBackward(adjusted, original, startIndex, deltaX, deltaY, axis) {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return;
    }
    const EPS = 1e-3;
    let index = startIndex - 1;
    if (axis === 'horizontal') {
      const baseY = original[startIndex].y;
      while (index >= 0 && Math.abs(original[index].y - baseY) < EPS) {
        adjusted[index] = {
          x: original[index].x + deltaX,
          y: original[index].y + deltaY,
        };
        index -= 1;
      }
      if (index < 0) {
        return;
      }
      const anchorX = original[index + 1].x;
      while (index >= 0 && Math.abs(original[index].x - anchorX) < EPS) {
        adjusted[index] = {
          x: original[index].x + deltaX,
          y: original[index].y + deltaY,
        };
        index -= 1;
      }
      return;
    }
    if (axis === 'vertical') {
      const baseX = original[startIndex].x;
      while (index >= 0 && Math.abs(original[index].x - baseX) < EPS) {
        adjusted[index] = {
          x: original[index].x + deltaX,
          y: original[index].y + deltaY,
        };
        index -= 1;
      }
      if (index < 0) {
        return;
      }
      const anchorY = original[index + 1].y;
      while (index >= 0 && Math.abs(original[index].y - anchorY) < EPS) {
        adjusted[index] = {
          x: original[index].x + deltaX,
          y: original[index].y + deltaY,
        };
        index -= 1;
      }
      return;
    }
    if (index >= 0) {
      adjusted[index] = {
        x: original[index].x + deltaX,
        y: original[index].y + deltaY,
      };
    }
  }

  pointsAlmostEqual(a, b, epsilon = 0.1) {
    if (!a || !b) {
      return false;
    }
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy < epsilon * epsilon;
  }

  drawArrow(points) {
    if (!points || points.length < 2) {
      return;
    }
    const { ctx } = this;
    const tail = points[points.length - 2];
    const head = points[points.length - 1];
    const angle = Math.atan2(head.y - tail.y, head.x - tail.x);
    const size = arrowHeadSize(this.view.scale);
    ctx.beginPath();
    ctx.moveTo(head.x, head.y);
    ctx.lineTo(
      head.x - size * Math.cos(angle - Math.PI / 6),
      head.y - size * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      head.x - size * Math.cos(angle + Math.PI / 6),
      head.y - size * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  }

  drawNodes() {
    const { ctx } = this;
    const selectedNodes = this.selection?.nodes ?? new Set();
    const selectedTopics = this.selection?.topics ?? new Set();
    const hoverNodes = this.hover?.nodes ?? new Set();
    const hoverTopics = this.hover?.topics ?? new Set();
    const palette = this.palette;

    this.scene.nodes.forEach((geometry, name) => {
      const highlight = selectedNodes.has(name)
        ? { stroke: palette.edgeSelect, fill: palette.node.selectFill }
        : hoverNodes.has(name)
        ? { stroke: palette.edgeHover, fill: palette.node.hoverFill }
        : {
            stroke: palette.edge,
            fill: palette.node.baseFill,
          };
      this.drawEllipse(geometry, highlight, palette.labelText);
    });

    this.scene.topics.forEach((geometry, name) => {
      const highlight = selectedTopics.has(name)
        ? { stroke: palette.edgeSelect, fill: palette.topic.selectFill }
        : hoverTopics.has(name)
        ? { stroke: palette.edgeHover, fill: palette.topic.hoverFill }
        : {
            stroke: palette.edge,
            fill: palette.topic.baseFill,
          };
      this.drawRoundedRect(geometry, highlight, palette.labelText);
    });
  }

  drawEllipse(geometry, highlight, textColor) {
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = this.getStrokeWidth();
    ctx.strokeStyle = highlight.stroke;
    ctx.fillStyle = highlight.fill;
    ctx.beginPath();
    ctx.ellipse(
      geometry.center.x,
      geometry.center.y,
      Math.max(geometry.width / 2, 4),
      Math.max(geometry.height / 2, 4),
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.stroke();
    drawLabel(ctx, geometry.labelLines, geometry.center, geometry.width, {
      fontSize: geometry.fontSize,
      lineHeight: geometry.lineHeight,
      color: textColor,
    });
    ctx.restore();
  }

  drawRoundedRect(geometry, highlight, textColor) {
    const { ctx } = this;
    const radius = Math.min(12, Math.min(geometry.width, geometry.height) / 4);
    const x = geometry.center.x - geometry.width / 2;
    const y = geometry.center.y - geometry.height / 2;
    ctx.save();
    ctx.lineWidth = this.getStrokeWidth();
    ctx.strokeStyle = highlight.stroke;
    ctx.fillStyle = highlight.fill;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + geometry.width - radius, y);
    ctx.quadraticCurveTo(x + geometry.width, y, x + geometry.width, y + radius);
    ctx.lineTo(x + geometry.width, y + geometry.height - radius);
    ctx.quadraticCurveTo(
      x + geometry.width,
      y + geometry.height,
      x + geometry.width - radius,
      y + geometry.height,
    );
    ctx.lineTo(x + radius, y + geometry.height);
    ctx.quadraticCurveTo(x, y + geometry.height, x, y + geometry.height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    drawLabel(ctx, geometry.labelLines, geometry.center, geometry.width, {
      fontSize: geometry.fontSize,
      lineHeight: geometry.lineHeight,
      color: textColor,
    });
    ctx.restore();
  }

  ensureLabelFits(geometry, padding = 16, isEllipse = true) {
    if (!geometry || !Array.isArray(geometry.labelLines) || !geometry.labelLines.length) {
      return;
    }
    const { ctx } = this;
    const fontSize = Math.max(geometry.fontSize || 14, 8);
    const lineHeight = Math.max(geometry.lineHeight || fontSize * 1.4, fontSize);
    const fontFamily = geometry.fontFamily || BASE_FONT_FAMILY;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${fontSize}px ${fontFamily}`;
    let maxWidth = 0;
    geometry.labelLines.forEach(line => {
      const text = typeof line.text === 'string' ? line.text : '';
      const metrics = ctx.measureText(text);
      maxWidth = Math.max(maxWidth, metrics.width);
    });
    ctx.restore();

    const desiredWidth = maxWidth + padding;
    if (!Number.isFinite(geometry.width) || geometry.width < desiredWidth) {
      geometry.width = desiredWidth;
    }
    const desiredHeight = lineHeight * geometry.labelLines.length + (isEllipse ? padding * 0.5 : padding * 0.6);
    if (!Number.isFinite(geometry.height) || geometry.height < desiredHeight) {
      geometry.height = desiredHeight;
    }
    geometry.fontFamily = fontFamily;
    geometry.lineHeight = lineHeight;
    geometry.fontSize = fontSize;
  }
}
