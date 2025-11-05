import {
  BASE_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  MAX_STROKE_WIDTH,
  SELECT_EDGE_COLOR,
  SELECT_NODE,
  SELECT_TOPIC,
  HOVER_NODE,
  HOVER_TOPIC,
  HOVER_EDGE_COLOR,
} from '../constants/index.js';
import { arrowHeadSize, drawLabel } from '../layout/graphviz.js';
import { BASE_FONT_FAMILY } from '../constants/index.js';

export class GraphRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = null;
    this.view = { scale: 1, offsetX: 0, offsetY: 0 };
    this.selection = { nodes: new Set(), topics: new Set(), edges: new Set() };
    this.hover = null;
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

    this.drawEdges();
    this.drawNodes();

    ctx.restore();
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

    for (const edge of this.scene.edges) {
      const key = `${edge.tail}->${edge.head}`;
      const isSelected = selectedEdges.has(key);
      const isHover = hoverEdges.has(key);
      ctx.save();
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = isSelected
        ? SELECT_EDGE_COLOR
        : isHover
        ? HOVER_EDGE_COLOR
        : '#2c3846';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      const [first, ...rest] = edge.points;
      ctx.moveTo(first.x, first.y);
      rest.forEach(point => ctx.lineTo(point.x, point.y));
      ctx.stroke();
      this.drawArrow(edge.points);
      ctx.restore();
    }
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

    this.scene.nodes.forEach((geometry, name) => {
      this.ensureLabelFits(geometry, 16, true);
      const highlight = selectedNodes.has(name)
        ? { stroke: SELECT_NODE.stroke, fill: SELECT_NODE.fill }
        : hoverNodes.has(name)
        ? { stroke: HOVER_NODE.stroke, fill: HOVER_NODE.fill }
        : { stroke: geometry.strokeColor || '#1f2328', fill: geometry.fillColor || '#9ebaff' };
      this.drawEllipse(geometry, highlight);
    });

    this.scene.topics.forEach((geometry, name) => {
      this.ensureLabelFits(geometry, 20, false);
      const highlight = selectedTopics.has(name)
        ? { stroke: SELECT_TOPIC.stroke, fill: SELECT_TOPIC.fill }
        : hoverTopics.has(name)
        ? { stroke: HOVER_TOPIC.stroke, fill: HOVER_TOPIC.fill }
        : { stroke: geometry.strokeColor || '#1f2328', fill: geometry.fillColor || '#b8e1b3' };
      this.drawRoundedRect(geometry, highlight);
    });
  }

  drawEllipse(geometry, highlight) {
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
    });
    ctx.restore();
  }

  drawRoundedRect(geometry, highlight) {
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
  }
}
