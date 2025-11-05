import { BASE_FONT_SIZE, BASE_FONT_FAMILY, BASE_LINE_HEIGHT_RATIO, MIN_FONT_SIZE_PX, MIN_ARROW_HEAD, MAX_ARROW_HEAD } from '../constants/index.js';
import { clamp } from '../utils/dom.js';

const POINTS_PER_INCH = 72;
const CANVAS_MARGIN = 40;

function stripQuotes(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.replace(/^"+|"+$/g, '');
}

export function parseGraphvizPlain(text) {
  if (!text) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const nodes = new Map();
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
    const tag = parts[0];
    if (tag === 'graph') {
      const [, rawScale, rawWidth, rawHeight] = parts;
      const parsedScale = parseFloat(rawScale);
      if (Number.isFinite(parsedScale) && parsedScale > 0) {
        scale = parsedScale;
      }
      const parsedWidth = parseFloat(rawWidth);
      if (Number.isFinite(parsedWidth) && parsedWidth > 0) {
        width = parsedWidth;
      }
      const parsedHeight = parseFloat(rawHeight);
      if (Number.isFinite(parsedHeight) && parsedHeight > 0) {
        height = parsedHeight;
      }
    } else if (tag === 'node' && parts.length >= 6) {
      const name = stripQuotes(parts[1]);
      const x = parseFloat(parts[2]);
      const y = parseFloat(parts[3]);
      const nodeWidth = parseFloat(parts[4]);
      const nodeHeight = parseFloat(parts[5]);
      if ([x, y, nodeWidth, nodeHeight].some(v => Number.isNaN(v))) {
        continue;
      }
      const labelToken = stripQuotes(parts[6] ?? '');
      const label =
        labelToken && labelToken.length ? labelToken.replace(/\\[nlr]/g, '\n') : name;
      const shape = stripQuotes(parts[8] ?? '');
      const strokeColor = stripQuotes(parts[9] ?? '');
      const fillColor = stripQuotes(parts[10] ?? '');
      let fontSizePt;
      if (parts.length >= 12) {
        const maybeFontSize = parseFloat(parts[parts.length - 1]);
        if (Number.isFinite(maybeFontSize) && maybeFontSize > 0) {
          fontSizePt = maybeFontSize;
        }
      }
      nodes.set(name, {
        name,
        x,
        y,
        width: nodeWidth,
        height: nodeHeight,
        label,
        rawLabel: labelToken,
        shape,
        strokeColor,
        fillColor,
        fontSizePt,
      });
    } else if (tag === 'edge' && parts.length >= 4) {
      const tail = stripQuotes(parts[1]);
      const head = stripQuotes(parts[2]);
      const pointCount = parseInt(parts[3], 10);
      if (!Number.isFinite(pointCount) || pointCount <= 0) {
        continue;
      }
      const points = [];
      for (let i = 0; i < pointCount; i += 1) {
        const idx = 4 + i * 2;
        const x = parseFloat(parts[idx]);
        const y = parseFloat(parts[idx + 1]);
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

  if (!nodes.size || !width || !height) {
    return null;
  }

  return { scale, width, height, nodes, edges };
}

export function createLayoutScaler(layout, canvasWidth, canvasHeight) {
  const layoutScale = layout.scale && layout.scale > 0 ? layout.scale : 1;
  const scaledWidth = layout.width * layoutScale;
  const scaledHeight = layout.height * layoutScale;
  if (!scaledWidth || !scaledHeight) {
    return null;
  }
  const scaleX = (canvasWidth - CANVAS_MARGIN * 2) / scaledWidth;
  const scaleY = (canvasHeight - CANVAS_MARGIN * 2) / scaledHeight;
  const scale = Math.min(scaleX, scaleY);
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  const scaledCanvasWidth = scaledWidth * scale;
  const scaledCanvasHeight = scaledHeight * scale;
  const offsetX = (canvasWidth - scaledCanvasWidth) / 2;
  const offsetY = (canvasHeight - scaledCanvasHeight) / 2;

  const nodeHeights = Array.from(
    layout.nodes instanceof Map ? layout.nodes.values() : Object.values(layout.nodes || {}),
  ).map(node => Number(node.height) || 0);
  const avgNodeHeight = nodeHeights.length ? nodeHeights.reduce((sum, h) => sum + h, 0) / nodeHeights.length : 0;
  const averagePixelHeight = avgNodeHeight * layoutScale * scale;
  const verticalMultiplier = averagePixelHeight > 0 ? 1 + Math.min(1.6, 0.5 * (averagePixelHeight / 20)) : 1.35;

  return {
    scale,
    toCanvas({ x, y }) {
      const baseY = offsetY + y * layoutScale * scale;
      const offsetFromCenter = y - layout.height / 2;
      const extra = offsetFromCenter * layoutScale * scale * (verticalMultiplier - 1);
      return {
        x: offsetX + x * layoutScale * scale,
        y: canvasHeight - baseY - extra,
      };
    },
    scaleLength(value) {
      return value * layoutScale * scale;
    },
  };
}

export function computeFontSizePx(nodeInfo, scaler) {
  const fontSizePt = Number.isFinite(nodeInfo?.fontSizePt)
    ? nodeInfo.fontSizePt
    : BASE_FONT_SIZE;
  if (!scaler) {
    return Math.max(fontSizePt, MIN_FONT_SIZE_PX);
  }
  const inches = fontSizePt / POINTS_PER_INCH;
  const px = scaler.scaleLength(inches);
  if (Number.isFinite(px) && px > 0) {
    return Math.max(px, MIN_FONT_SIZE_PX);
  }
  return Math.max(fontSizePt, MIN_FONT_SIZE_PX);
}

export function decodeLabelLines(rawLabel, fallback, nodeName) {
  const text = rawLabel && rawLabel.length ? rawLabel : fallback ?? '';
  if (!text) {
    return [{ text: '', align: 'center' }];
  }
  const lines = [];
  let buffer = '';
  let align = 'center';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      const code = text[++i];
      if (code === 'N') {
        buffer += nodeName ?? '';
        continue;
      }
      if (code === 'n' || code === 'l' || code === 'r') {
        lines.push({ text: buffer, align });
        buffer = '';
        align = code === 'l' ? 'left' : code === 'r' ? 'right' : 'center';
        continue;
      }
      buffer += code;
      continue;
    }
    buffer += ch;
  }
  lines.push({ text: buffer, align });
  return lines;
}

export function drawLabel(ctx, lines, center, width, { fontSize, lineHeight }) {
  const effectiveFontSize = clamp(fontSize || BASE_FONT_SIZE, MIN_FONT_SIZE_PX, 48);
  const effectiveLineHeight = lineHeight ?? effectiveFontSize * BASE_LINE_HEIGHT_RATIO;
  ctx.save();
  ctx.font = `${effectiveFontSize}px ${BASE_FONT_FAMILY}`;
  ctx.fillStyle = '#0d1117';
  ctx.textBaseline = 'middle';
  const totalHeight = Math.max(lines.length * effectiveLineHeight, effectiveLineHeight);
  const leftX = center.x - width / 2 + 6;
  const rightX = center.x + width / 2 - 6;
  lines.forEach((line, idx) => {
    const y =
      center.y - totalHeight / 2 + effectiveLineHeight * idx + effectiveLineHeight / 2;
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

export function arrowHeadSize(scale) {
  return clamp(9 / scale, MIN_ARROW_HEAD, MAX_ARROW_HEAD);
}
