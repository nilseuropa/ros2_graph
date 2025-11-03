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
const nodeFeatureInfo = new Map();
const overlayState = {
  visible: false,
  nodeName: '',
  description: '',
  auto: false,
  maxWidth: 0,
  table: null,
  hoverRow: null,
  layout: null,
};

const PARAMETER_NOT_SET = 0;
const PARAMETER_BOOL = 1;
const PARAMETER_INTEGER = 2;
const PARAMETER_DOUBLE = 3;
const PARAMETER_STRING = 4;
const PARAMETER_BYTE_ARRAY = 5;
const PARAMETER_BOOL_ARRAY = 6;
const PARAMETER_INTEGER_ARRAY = 7;
const PARAMETER_DOUBLE_ARRAY = 8;
const PARAMETER_STRING_ARRAY = 9;

const parameterEditor = document.getElementById('parameterEditor');
const parameterEditorForm = document.getElementById('parameterEditorForm');
const parameterEditorTitle = document.getElementById('parameterEditorTitle');
const parameterEditorSubtitle = document.getElementById('parameterEditorSubtitle');
const parameterEditorBody = document.getElementById('parameterEditorBody');
const parameterEditorMessage = document.getElementById('parameterEditorMessage');
const parameterEditorClose = document.getElementById('parameterEditorClose');
const parameterEditorCancel = document.getElementById('parameterEditorCancel');
const parameterEditorApply = document.getElementById('parameterEditorApply');
const parameterEditorBackdrop = parameterEditor?.querySelector('.parameter-editor__backdrop');

const parameterEditorState = {
  visible: false,
  nodeName: '',
  parameterName: '',
  typeId: null,
  descriptor: null,
  entry: null,
  getSubmitValue: null,
  focusTarget: null,
  readOnly: false,
  submitting: false,
  metadataWarning: null,
};

function setOverlayPointerCapture(enabled) {
  if (!overlayCanvas) {
    return;
  }
  overlayCanvas.style.pointerEvents = enabled ? 'auto' : 'none';
}

setOverlayPointerCapture(false);

function pointInRect(x, y, rect) {
  if (!rect) {
    return false;
  }
  return (
    x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height
  );
}

function setOverlayHover(nextHover) {
  const prev = overlayState.hoverRow;
  const unchanged =
    (prev === null && nextHover === null) ||
    (prev &&
      nextHover &&
      prev.tableIndex === nextHover.tableIndex &&
      prev.rowType === nextHover.rowType &&
      prev.rowIndex === nextHover.rowIndex);
  if (unchanged) {
    return;
  }
  overlayState.hoverRow = nextHover;
  if (overlayState.visible && overlayState.table) {
    refreshOverlay();
  }
}

function updateOverlayHoverPosition(x, y) {
  if (!overlayState.visible || !overlayState.table || !overlayState.layout) {
    if (overlayCanvas) {
      overlayCanvas.style.cursor = 'default';
    }
    setOverlayHover(null);
    return;
  }
  const { box, tables } = overlayState.layout;
  if (!box || !pointInRect(x, y, box)) {
    if (overlayCanvas) {
      overlayCanvas.style.cursor = 'default';
    }
    setOverlayHover(null);
    return;
  }
  let hover = null;
  if (Array.isArray(tables)) {
    for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
      const info = tables[tableIndex];
      if (!info) {
        continue;
      }
      if (info.header && pointInRect(x, y, info.header)) {
        hover = { tableIndex, rowType: 'header', rowIndex: -1 };
        break;
      }
      if (Array.isArray(info.rows)) {
        for (let rowIndex = 0; rowIndex < info.rows.length; rowIndex += 1) {
          const rect = info.rows[rowIndex];
          if (pointInRect(x, y, rect)) {
            hover = { tableIndex, rowType: 'body', rowIndex };
            break;
          }
        }
      }
      if (hover) {
        break;
      }
    }
  }
  if (overlayCanvas) {
    const parameterIndex = findParameterRowIndexAtPosition(x, y);
    overlayCanvas.style.cursor = parameterIndex !== null ? 'pointer' : 'default';
  }
  setOverlayHover(hover);
}

function handleOverlayPointerMove(event) {
  if (!overlayCanvas) {
    return;
  }
  const rect = overlayCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    setOverlayHover(null);
    return;
  }
  const scaleX = overlayCanvas.width / rect.width;
  const scaleY = overlayCanvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  updateOverlayHoverPosition(x, y);
}

function handleOverlayPointerLeave() {
  setOverlayHover(null);
  if (overlayCanvas) {
    overlayCanvas.style.cursor = 'default';
  }
}

if (overlayCanvas) {
  overlayCanvas.addEventListener('pointermove', handleOverlayPointerMove);
  overlayCanvas.addEventListener('pointerleave', handleOverlayPointerLeave);
  overlayCanvas.addEventListener('pointerdown', handleOverlayPointerDown);
  overlayCanvas.addEventListener('dblclick', handleOverlayDoubleClick);
}
const contextMenu = document.getElementById('contextMenu');
const contextMenuState = {
  visible: false,
  target: null,
  position: { x: 0, y: 0 },
  items: [],
};

if (parameterEditorForm) {
  parameterEditorForm.addEventListener('submit', handleParameterEditorSubmit);
}
if (parameterEditorCancel) {
  parameterEditorCancel.addEventListener('click', event => {
    event.preventDefault();
    closeParameterEditor();
  });
}
if (parameterEditorClose) {
  parameterEditorClose.addEventListener('click', event => {
    event.preventDefault();
    closeParameterEditor();
  });
}
if (parameterEditor) {
  parameterEditor.addEventListener('click', event => {
    if (
      !parameterEditorState.submitting &&
      (event.target === parameterEditor || event.target === parameterEditorBackdrop)
    ) {
      closeParameterEditor();
    }
  });
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && parameterEditorState.visible && !parameterEditorState.submitting) {
    event.preventDefault();
    closeParameterEditor();
  }
});
const canvasContainer = document.getElementById('canvasContainer');
const BASE_FONT_FAMILY = '"Times New Roman", serif';
const BASE_FONT_SIZE = 14;
const BASE_LINE_HEIGHT = 18;
const POINTS_PER_INCH = 72;
const MIN_FONT_SIZE_PX = 7;
const BASE_LINE_HEIGHT_RATIO = BASE_LINE_HEIGHT / BASE_FONT_SIZE;
const OVERLAY_FONT = '14.3px "Segoe UI", system-ui, -apple-system, sans-serif';
const OVERLAY_LINE_HEIGHT = 18;
const OVERLAY_PADDING = 12;
const OVERLAY_MAX_WIDTH = 320;
const OVERLAY_MARGIN = 12;
const TOPIC_TOOL_TIMEOUT = 15000;
const FEATURE_PARAM_ORDER = ['name', 'class', 'version', 'gui_version', 'state'];
const FEATURE_LABELS = {
  name: 'Name',
  class: 'Class',
  version: 'Version',
  gui_version: 'GUI Version',
  state: 'State',
};

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

function computeBandwidthValue(frequency, size) {
  if (!Number.isFinite(frequency) || frequency <= 0) {
    return null;
  }
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }
  return frequency * size;
}

function getContextMenuItemsForTarget(target) {
  if (!target) {
    return [];
  }
  if (target.type === 'topic-edge' || target.type === 'topic-node') {
    return [
      { action: 'info', label: 'Info' },
      { action: 'stats', label: 'Stats' },
    ];
  }
  if (target.type === 'node') {
    return [
      { action: 'info', label: 'Info' },
      { action: 'services', label: 'Services' },
      { action: 'parameters', label: 'Parameters' },
    ];
  }
  return [];
}

function configureContextMenu(target) {
  if (!contextMenu) {
    return false;
  }
  const items = getContextMenuItemsForTarget(target);
  if (!items.length) {
    contextMenuState.items = [];
    return false;
  }
  contextMenu.innerHTML = '';
  items.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = item.action;
    button.textContent = item.label;
    contextMenu.appendChild(button);
  });
  contextMenuState.items = items;
  return true;
}

function clearOverlayCanvas() {
  overlayCtx.save();
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCtx.restore();
}

function drawOverlayTables(anchorPoint, data) {
  const tables = Array.isArray(data?.tables) ? data.tables.filter(Boolean) : [];
  const titleLines = Array.isArray(data?.titleLines) ? data.titleLines : [];
  const layoutInfo = { box: null, tables: [] };
  if (!tables.length && !titleLines.length) {
    overlayState.layout = null;
    return;
  }

  overlayCtx.save();
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.font = OVERLAY_FONT;
  overlayCtx.textBaseline = 'middle';
  overlayCtx.textAlign = 'left';

  const rowHeight = OVERLAY_LINE_HEIGHT;
  const paddingX = OVERLAY_PADDING;
  const paddingY = OVERLAY_PADDING;
  const tableSpacing = rowHeight * 0.8;
  const tableTitleGap = rowHeight * 0.4;
  const headerBodyGap = rowHeight * 0.3;
  const columnSpacing = 24;

  const viewportWidthRaw = typeof window !== 'undefined' ? window.innerWidth : overlayCanvas.width;
  const viewportWidth = Number.isFinite(viewportWidthRaw) ? viewportWidthRaw : 0;
  const canvasWidthRaw = overlayCanvas?.width;
  const canvasWidth = Number.isFinite(canvasWidthRaw) ? canvasWidthRaw : viewportWidth;
  const containerWidthRaw = canvasContainer?.clientWidth;
  const containerWidth = Number.isFinite(containerWidthRaw) ? containerWidthRaw : 0;
  const maxContainerWidth = Math.max(viewportWidth, canvasWidth, containerWidth);
  const maxAllowedWidth = Math.max(OVERLAY_PADDING * 2 + 160, maxContainerWidth - OVERLAY_MARGIN * 2);

  let maxTitleWidth = 0;
  titleLines.forEach(line => {
    const width = overlayCtx.measureText(line).width;
    if (width > maxTitleWidth) {
      maxTitleWidth = width;
    }
  });

  const processedTables = tables.map(table => {
    const tableTitle = typeof table.title === 'string' ? table.title : '';
    const headers = Array.isArray(table.headers) ? table.headers.map(text => text ?? '') : [];
    const rawRows = Array.isArray(table.rows) ? table.rows : [];
    const columnCount = headers.length || (rawRows[0] ? rawRows[0].length : 0);
    const rows = rawRows.map(row => {
      const arr = [];
      for (let i = 0; i < columnCount; i += 1) {
        arr.push(row?.[i] ?? '');
      }
      return arr;
    });

    const columnWidths = new Array(columnCount).fill(0);
    headers.forEach((text, idx) => {
      const width = overlayCtx.measureText(text).width;
      columnWidths[idx] = Math.max(columnWidths[idx], width);
    });
    rows.forEach(row => {
      row.forEach((text, idx) => {
        const width = overlayCtx.measureText(text).width;
        if (width > columnWidths[idx]) {
          columnWidths[idx] = width;
        }
      });
    });

    const tableTitleWidth = tableTitle ? overlayCtx.measureText(tableTitle).width : 0;
    const rawWidth = columnCount
      ? columnWidths.reduce((sum, width) => sum + width, 0) + columnSpacing * Math.max(0, columnCount - 1)
      : 0;

    return {
      title: tableTitle,
      headers: headers.length ? headers : new Array(columnCount).fill(''),
      rows,
      columnCount,
      columnWidths,
      rawWidth,
      titleWidth: tableTitleWidth,
      spacing: columnSpacing,
    };
  });

  let contentWidth = maxTitleWidth;
  processedTables.forEach(info => {
    contentWidth = Math.max(contentWidth, info.titleWidth, info.rawWidth);
  });

  let boxWidth = Math.max(contentWidth + paddingX * 2, 200);
  if (boxWidth > maxAllowedWidth) {
    boxWidth = maxAllowedWidth;
  }

  const innerWidth = boxWidth - paddingX * 2;
  processedTables.forEach(info => {
    if (info.columnCount && info.rawWidth > innerWidth) {
      const scale = Math.max(0.3, innerWidth / Math.max(info.rawWidth, 1));
      info.columnWidths = info.columnWidths.map(width => width * scale);
      info.spacing = info.spacing * scale;
      info.rawWidth = info.columnWidths.reduce((sum, width) => sum + width, 0) + info.spacing * Math.max(0, info.columnCount - 1);
    }
  });

  const titleHeight = titleLines.length ? titleLines.length * rowHeight : 0;
  const titleGap = tables.length ? Math.max(rowHeight * 0.35, 6) : 0;

  let totalTablesHeight = 0;
  processedTables.forEach((info, idx) => {
    if (!info.columnCount) {
      return;
    }
    const tableTitleHeight = info.title ? rowHeight : 0;
    const preHeaderGap = info.title ? tableTitleGap : 0;
    const headerHeight = rowHeight;
    const bodyHeight = info.rows.length * rowHeight;
    totalTablesHeight += tableTitleHeight + preHeaderGap + headerHeight + headerBodyGap + bodyHeight;
    if (idx < processedTables.length - 1) {
      totalTablesHeight += tableSpacing;
    }
  });
  const bottomPadding = processedTables.length ? Math.max(rowHeight * 0.6, 10) : 0;
  totalTablesHeight += bottomPadding + rowHeight;

  const boxHeight = paddingY * 2 + titleHeight + titleGap + totalTablesHeight;

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

  layoutInfo.box = {
    x: boxX,
    y: boxY,
    width: boxWidth,
    height: boxHeight,
  };

  const radius = 10;
  overlayCtx.fillStyle = 'rgba(13, 17, 23, 0.95)';
  overlayCtx.strokeStyle = '#58a6ff';
  overlayCtx.lineWidth = 2;
  overlayCtx.beginPath();
  overlayCtx.moveTo(boxX + radius, boxY);
  overlayCtx.lineTo(boxX + boxWidth - radius, boxY);
  overlayCtx.quadraticCurveTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + radius);
  overlayCtx.lineTo(boxX + boxWidth, boxY + boxHeight - radius);
  overlayCtx.quadraticCurveTo(boxX + boxWidth, boxY + boxHeight, boxX + boxWidth - radius, boxY + boxHeight);
  overlayCtx.lineTo(boxX + radius, boxY + boxHeight);
  overlayCtx.quadraticCurveTo(boxX, boxY + boxHeight, boxX, boxY + boxHeight - radius);
  overlayCtx.lineTo(boxX, boxY + radius);
  overlayCtx.quadraticCurveTo(boxX, boxY, boxX + radius, boxY);
  overlayCtx.closePath();
  overlayCtx.fill();
  overlayCtx.stroke();

  let cursorY = boxY + paddingY + (titleLines.length ? rowHeight / 2 : 0);
  overlayCtx.fillStyle = '#e6edf3';
  titleLines.forEach(line => {
    overlayCtx.fillText(line, boxX + paddingX, cursorY);
    cursorY += rowHeight;
  });

  if (titleHeight) {
    cursorY += titleGap;
  }

  processedTables.forEach((info, idx) => {
    const tableLayout = { header: null, rows: [], columnBounds: [], columnPositions: [], headers: info.headers };
    layoutInfo.tables[idx] = tableLayout;
    if (!info.columnCount) {
      return;
    }

    if (info.title) {
      overlayCtx.fillStyle = '#58a6ff';
      overlayCtx.fillText(info.title, boxX + paddingX, cursorY + rowHeight / 2);
      cursorY += rowHeight + tableTitleGap;
    }

    const headerY = cursorY + rowHeight / 2;
    const headerRect = {
      x: boxX + 1,
      y: headerY - rowHeight / 2,
      width: boxWidth - 2,
      height: rowHeight + headerBodyGap / 2,
    };
    tableLayout.header = headerRect;
    const isHeaderHovered =
      overlayState.hoverRow &&
      overlayState.hoverRow.tableIndex === idx &&
      overlayState.hoverRow.rowType === 'header';
    overlayCtx.fillStyle = isHeaderHovered ? 'rgba(88, 166, 255, 0.35)' : 'rgba(88, 166, 255, 0.18)';
    overlayCtx.fillRect(headerRect.x, headerRect.y, headerRect.width, headerRect.height);
    overlayCtx.strokeStyle = 'rgba(88, 166, 255, 0.35)';
    overlayCtx.beginPath();
    overlayCtx.moveTo(boxX, headerY + rowHeight / 2 + headerBodyGap / 4);
    overlayCtx.lineTo(boxX + boxWidth, headerY + rowHeight / 2 + headerBodyGap / 4);
    overlayCtx.stroke();

    const baseX = boxX + paddingX;
    const columnPositions = [];
    let cursorX = baseX;
    info.columnWidths.forEach(width => {
      columnPositions.push(cursorX);
      cursorX += width + info.spacing;
    });
    tableLayout.columnPositions = columnPositions.slice();
    const columnBounds = columnPositions.map((pos, colIdx) => {
      const prevEdge = colIdx === 0 ? baseX : (columnPositions[colIdx - 1] + pos) / 2;
      const nextEdge =
        colIdx === columnPositions.length - 1
          ? boxX + boxWidth - paddingX
          : (pos + columnPositions[colIdx + 1]) / 2;
      return {
        start: Math.max(boxX, prevEdge),
        end: Math.min(boxX + boxWidth, nextEdge),
      };
    });
    tableLayout.columnBounds = columnBounds;

    overlayCtx.fillStyle = '#58a6ff';
    info.headers.forEach((text, colIdx) => {
      overlayCtx.fillText(text, columnPositions[colIdx], headerY);
    });

    cursorY = headerY + rowHeight + headerBodyGap;
    info.rows.forEach((row, rowIdx) => {
      const rowRect = {
        x: boxX + 1,
        y: cursorY,
        width: boxWidth - 2,
        height: rowHeight,
      };
      tableLayout.rows.push(rowRect);
      const isRowHovered =
        overlayState.hoverRow &&
        overlayState.hoverRow.tableIndex === idx &&
        overlayState.hoverRow.rowType === 'body' &&
        overlayState.hoverRow.rowIndex === rowIdx;
      if (isRowHovered) {
        overlayCtx.fillStyle = 'rgba(88, 166, 255, 0.25)';
        overlayCtx.fillRect(rowRect.x, rowRect.y, rowRect.width, rowRect.height);
      }
      overlayCtx.fillStyle = '#e6edf3';
      row.forEach((text, colIdx) => {
        overlayCtx.fillText(text, columnPositions[colIdx], cursorY + rowHeight / 2);
      });
      cursorY += rowHeight;
    });

    if (idx < processedTables.length - 1) {
      cursorY += tableSpacing;
    }
  });

  cursorY += bottomPadding;

  overlayState.layout = layoutInfo;
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
  overlayState.maxWidth = 0;
  overlayState.table = null;
  overlayState.layout = null;
  overlayState.hoverRow = null;
  if (overlayCanvas) {
    overlayCanvas.style.cursor = 'default';
  }
  clearOverlayCanvas();
  setOverlayPointerCapture(false);
}

function handleOverlayPointerDown(event) {
  if (!overlayCanvas) {
    return;
  }
  event.stopPropagation();
  if (!overlayState.visible || !overlayState.layout) {
    return;
  }
  const { box } = overlayState.layout;
  if (!box) {
    hideOverlay();
    return;
  }
  const rect = overlayCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }
  const scaleX = overlayCanvas.width / rect.width;
  const scaleY = overlayCanvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  if (!pointInRect(x, y, box)) {
    event.preventDefault();
    hideOverlay();
  }
}

function findParameterRowIndexAtPosition(x, y) {
  const parameterEntries = overlayState.table?.context?.parameters;
  if (!Array.isArray(parameterEntries) || parameterEntries.length === 0) {
    return null;
  }
  const tables = Array.isArray(overlayState.layout?.tables) ? overlayState.layout.tables : [];
  const dataTables = Array.isArray(overlayState.table.tables) ? overlayState.table.tables : [];
  if (!tables.length || !dataTables.length) {
    return null;
  }
  let rowOffset = 0;
  for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
    const layout = tables[tableIndex];
    const tableData = dataTables[tableIndex];
    if (!layout || !tableData) {
      continue;
    }
    const headers = Array.isArray(tableData.headers) ? tableData.headers : [];
    const isParameterTable =
      headers.length >= 2 &&
      String(headers[0]).toLowerCase() === 'name' &&
      String(headers[1]).toLowerCase() === 'value';
    if (!isParameterTable) {
      continue;
    }
    const columnBounds = Array.isArray(layout.columnBounds) ? layout.columnBounds : [];
    const valueBounds = columnBounds[1];
    const rowRects = Array.isArray(layout.rows) ? layout.rows : [];
    const rowCount = rowRects.length;
    if (!valueBounds || x < valueBounds.start || x > valueBounds.end) {
      rowOffset += rowCount;
      continue;
    }
    for (let rowIndex = 0; rowIndex < rowRects.length; rowIndex += 1) {
      const rowRect = rowRects[rowIndex];
      if (pointInRect(x, y, rowRect)) {
        const entryIndex = rowOffset + rowIndex;
        if (entryIndex >= 0 && entryIndex < parameterEntries.length) {
          return entryIndex;
        }
        return null;
      }
    }
    rowOffset += rowCount;
  }
  return null;
}

function isArrayParameterType(typeId) {
  return (
    typeId === PARAMETER_BYTE_ARRAY ||
    typeId === PARAMETER_BOOL_ARRAY ||
    typeId === PARAMETER_INTEGER_ARRAY ||
    typeId === PARAMETER_DOUBLE_ARRAY ||
    typeId === PARAMETER_STRING_ARRAY
  );
}

function updateParameterEditorMessage(text, isError = false) {
  if (!parameterEditorMessage) {
    return;
  }
  parameterEditorMessage.textContent = text || '';
  parameterEditorMessage.classList.toggle('error', Boolean(isError && text));
}

function setParameterEditorBusy(isBusy) {
  if (parameterEditorApply) {
    if (parameterEditorState.readOnly) {
      parameterEditorApply.disabled = true;
    } else {
      parameterEditorApply.disabled = Boolean(isBusy);
    }
  }
  if (parameterEditorCancel) {
    parameterEditorCancel.disabled = Boolean(isBusy);
  }
  if (parameterEditorClose) {
    parameterEditorClose.disabled = Boolean(isBusy);
  }
}

function resetParameterEditorState() {
  parameterEditorState.visible = false;
  parameterEditorState.nodeName = '';
  parameterEditorState.parameterName = '';
  parameterEditorState.typeId = null;
  parameterEditorState.descriptor = null;
  parameterEditorState.entry = null;
  parameterEditorState.getSubmitValue = null;
  parameterEditorState.focusTarget = null;
  parameterEditorState.readOnly = false;
  parameterEditorState.submitting = false;
  parameterEditorState.metadataWarning = null;
}

function closeParameterEditor() {
  if (!parameterEditorState.visible) {
    resetParameterEditorState();
    return;
  }
  if (parameterEditorState.submitting) {
    return;
  }
  if (parameterEditor) {
    parameterEditor.classList.remove('active');
    parameterEditor.classList.add('hidden');
    parameterEditor.setAttribute('aria-hidden', 'true');
  }
  if (parameterEditorBody) {
    parameterEditorBody.innerHTML = '';
  }
  updateParameterEditorMessage('');
  if (parameterEditorApply) {
    parameterEditorApply.disabled = false;
  }
  if (parameterEditorCancel) {
    parameterEditorCancel.disabled = false;
  }
  if (parameterEditorClose) {
    parameterEditorClose.disabled = false;
  }
  resetParameterEditorState();
}

function createHintElement(text) {
  const element = document.createElement('div');
  element.className = 'parameter-editor__hint';
  element.textContent = text;
  return element;
}

function formatParameterDisplayValue(value) {
  if (value === null || value === undefined) {
    return '(empty)';
  }
  const text = String(value);
  if (!text.length) {
    return '(empty)';
  }
  if (text.length > 512) {
    return `${text.slice(0, 512)}…`;
  }
  return text;
}

function formatRangeHint(range, isInteger) {
  if (!range) {
    return '';
  }
  const from = range.from_value;
  const to = range.to_value;
  if (from === undefined || to === undefined) {
    return '';
  }
  const formatter = value => {
    if (value === null || value === undefined) {
      return '';
    }
    return isInteger ? String(Math.trunc(value)) : String(value);
  };
  let text = `Allowed range: ${formatter(from)} – ${formatter(to)}`;
  const step = range.step;
  if (step !== undefined && step !== null && Number(step) > 0) {
    text += ` (step ${formatter(step)})`;
  }
  return text;
}

function buildParameterEditorControl(typeId, entry, descriptor) {
  const field = document.createElement('div');
  field.className = 'parameter-editor__field';
  const label = document.createElement('label');
  label.setAttribute('for', 'parameterEditorInput');
  label.textContent = 'New value';
  field.append(label);

  const rawValue = entry && entry.raw_value !== undefined ? entry.raw_value : entry?.value;
  const valueString = rawValue === undefined || rawValue === null ? '' : String(rawValue);
  let focusTarget = null;
  let getValue = null;

  if (typeId === PARAMETER_BOOL) {
    const toggleWrapper = document.createElement('label');
    toggleWrapper.className = 'parameter-editor__toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'parameterEditorInput';
    const normalized = valueString.trim().toLowerCase();
    checkbox.checked = ['true', '1', 'yes', 'on'].includes(normalized);
    const toggleText = document.createElement('span');
    const updateToggleText = () => {
      toggleText.textContent = checkbox.checked ? 'True' : 'False';
    };
    updateToggleText();
    checkbox.addEventListener('change', updateToggleText);
    toggleWrapper.append(checkbox, toggleText);
    field.append(toggleWrapper);
    focusTarget = checkbox;
    getValue = () => ({ value: checkbox.checked ? 'true' : 'false' });
    return { element: field, focusTarget, getValue };
  }

  if (typeId === PARAMETER_INTEGER || typeId === PARAMETER_DOUBLE) {
    const input = document.createElement('input');
    input.type = 'number';
    input.id = 'parameterEditorInput';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.inputMode = typeId === PARAMETER_INTEGER ? 'numeric' : 'decimal';
    if (valueString.length) {
      input.value = valueString;
    }
    if (typeId === PARAMETER_INTEGER) {
      input.step = '1';
    } else {
      input.step = 'any';
    }

    const ranges = typeId === PARAMETER_INTEGER
      ? (Array.isArray(descriptor?.integer_ranges) ? descriptor.integer_ranges : [])
      : (Array.isArray(descriptor?.floating_point_ranges) ? descriptor.floating_point_ranges : []);
    if (Array.isArray(ranges) && ranges.length) {
      const range = ranges[0];
      if (range) {
        if (Number.isFinite(range.from_value)) {
          input.min = String(range.from_value);
        }
        if (Number.isFinite(range.to_value)) {
          input.max = String(range.to_value);
        }
        if (Number.isFinite(range.step) && range.step > 0) {
          input.step = String(range.step);
        }
        const rangeHint = formatRangeHint(range, typeId === PARAMETER_INTEGER);
        if (rangeHint) {
          field.append(createHintElement(rangeHint));
        }
      }
    }

    field.append(input);
    focusTarget = input;
    getValue = () => {
      const nextValue = input.value.trim();
      if (!nextValue.length) {
        return { error: 'Enter a value' };
      }
      if (typeId === PARAMETER_INTEGER && !/^[-+]?\d+$/.test(nextValue)) {
        return { error: 'Enter a valid integer' };
      }
      if (typeId === PARAMETER_DOUBLE) {
        const parsed = Number(nextValue);
        if (!Number.isFinite(parsed)) {
          return { error: 'Enter a valid number' };
        }
      }
      return { value: nextValue };
    };
    return { element: field, focusTarget, getValue };
  }

  if (typeId === PARAMETER_STRING) {
    const useTextarea = valueString.includes('\n') || valueString.length > 120;
    if (useTextarea) {
      const textarea = document.createElement('textarea');
      textarea.id = 'parameterEditorInput';
      textarea.value = valueString;
      textarea.autocomplete = 'off';
      textarea.spellcheck = false;
      textarea.rows = Math.min(Math.max(valueString.split('\n').length, 3), 10);
      field.append(textarea);
      focusTarget = textarea;
      getValue = () => ({ value: textarea.value });
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'parameterEditorInput';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = 'Enter string value';
      input.value = valueString;
      field.append(input);
      focusTarget = input;
      getValue = () => ({ value: input.value });
    }
    return { element: field, focusTarget, getValue };
  }

  if (isArrayParameterType(typeId)) {
    const textarea = document.createElement('textarea');
    textarea.id = 'parameterEditorInput';
    textarea.autocomplete = 'off';
    textarea.spellcheck = false;
    textarea.rows = valueString.includes('\n') ? Math.min(Math.max(valueString.split('\n').length, 3), 12) : 6;
    textarea.value = valueString || '[]';

    let placeholder = '[1, 2, 3]';
    let hintText = 'Enter a JSON array value.';
    if (typeId === PARAMETER_BOOL_ARRAY) {
      placeholder = '[true, false]';
      hintText = 'Enter a JSON array of boolean values.';
    } else if (typeId === PARAMETER_INTEGER_ARRAY) {
      placeholder = '[1, 2, 3]';
      hintText = 'Enter a JSON array of integers.';
    } else if (typeId === PARAMETER_DOUBLE_ARRAY) {
      placeholder = '[0.1, 0.2]';
      hintText = 'Enter a JSON array of numbers.';
    } else if (typeId === PARAMETER_STRING_ARRAY) {
      placeholder = '["alpha", "beta"]';
      hintText = 'Enter a JSON array of strings.';
    } else if (typeId === PARAMETER_BYTE_ARRAY) {
      placeholder = '[0, 127, 255]';
      hintText = 'Enter a JSON array of bytes (0-255).';
    }
    textarea.placeholder = placeholder;
    field.append(textarea);
    field.append(createHintElement(hintText));
    focusTarget = textarea;
    getValue = () => {
      const nextValue = textarea.value.trim();
      if (!nextValue.length) {
        return { error: 'Enter a JSON array value' };
      }
      try {
        const parsed = JSON.parse(nextValue);
        if (!Array.isArray(parsed)) {
          return { error: 'Value must be a JSON array' };
        }
      } catch (err) {
        return { error: 'Value must be a valid JSON array' };
      }
      return { value: nextValue };
    };
    return { element: field, focusTarget, getValue };
  }

  const fallback = document.createElement('input');
  fallback.type = 'text';
  fallback.id = 'parameterEditorInput';
  fallback.autocomplete = 'off';
  fallback.spellcheck = false;
  fallback.placeholder = 'Enter value';
  fallback.value = valueString;
  field.append(fallback);
  focusTarget = fallback;
  getValue = () => ({ value: fallback.value });
  return { element: field, focusTarget, getValue };
}

function openParameterEditor(nodeName, entry, parameterDetail, warningMessage) {
  if (!parameterEditor) {
    return;
  }
  let typeId = Number(parameterDetail?.type_id);
  if (!Number.isFinite(typeId)) {
    typeId = Number(entry?.type_id);
  }
  if (!Number.isFinite(typeId)) {
    typeId = PARAMETER_STRING;
  }
  const descriptor = parameterDetail?.descriptor || null;
  const typeLabel = parameterDetail?.type || (entry?.type ? String(entry.type) : '');
  const paramName = typeof entry?.name === 'string' ? entry.name : '';

  parameterEditorState.visible = true;
  parameterEditorState.nodeName = nodeName;
  parameterEditorState.parameterName = paramName;
  parameterEditorState.typeId = typeId;
  parameterEditorState.descriptor = descriptor;
  parameterEditorState.entry = entry;
  parameterEditorState.metadataWarning = warningMessage || null;
  parameterEditorState.readOnly = Boolean(descriptor?.read_only);
  parameterEditorState.submitting = false;
  parameterEditorState.getSubmitValue = null;
  parameterEditorState.focusTarget = null;

  if (parameterEditorTitle) {
    parameterEditorTitle.textContent = paramName || 'Parameter';
  }
  if (parameterEditorSubtitle) {
    const subtitleParts = [`Node: ${nodeName}`];
    if (typeLabel) {
      subtitleParts.push(`Type: ${typeLabel}`);
    }
    parameterEditorSubtitle.textContent = subtitleParts.join(' • ');
  }

  if (parameterEditorBody) {
    parameterEditorBody.innerHTML = '';
    if (descriptor?.description) {
      const descriptionText = String(descriptor.description).trim();
      if (descriptionText) {
        const descriptionBlock = document.createElement('div');
        descriptionBlock.className = 'parameter-editor__description';
        descriptionBlock.textContent = descriptionText;
        parameterEditorBody.append(descriptionBlock);
      }
    }
    if (warningMessage) {
      parameterEditorBody.append(createHintElement(`Metadata limited: ${warningMessage}`));
    }
    const currentField = document.createElement('div');
    currentField.className = 'parameter-editor__field';
    const currentLabel = document.createElement('label');
    currentLabel.textContent = 'Current value';
    currentField.append(currentLabel);
    const currentValueEl = document.createElement('div');
    currentValueEl.className = 'parameter-editor__current';
    const rawValue = entry && entry.raw_value !== undefined ? entry.raw_value : entry?.value;
    currentValueEl.textContent = formatParameterDisplayValue(rawValue);
    currentField.append(currentValueEl);
    parameterEditorBody.append(currentField);

    const control = buildParameterEditorControl(typeId, entry, descriptor);
    if (control) {
      parameterEditorBody.append(control.element);
      parameterEditorState.getSubmitValue = control.getValue;
      parameterEditorState.focusTarget = control.focusTarget;
    }

    if (descriptor?.additional_constraints) {
      parameterEditorBody.append(createHintElement(String(descriptor.additional_constraints)));
    }
    if (descriptor?.dynamic_typing) {
      parameterEditorBody.append(createHintElement('Dynamic typing is enabled for this parameter.'));
    }
  }

  parameterEditor.classList.remove('hidden');
  parameterEditor.classList.add('active');
  parameterEditor.setAttribute('aria-hidden', 'false');

  setParameterEditorBusy(false);
  if (!parameterEditorState.getSubmitValue || parameterEditorState.readOnly) {
    if (parameterEditorApply) {
      parameterEditorApply.disabled = true;
    }
  }

  const initialMessage = parameterEditorState.readOnly
    ? 'Parameter is read-only; updates are disabled.'
    : warningMessage
    ? `Editing with limited metadata: ${warningMessage}`
    : '';
  updateParameterEditorMessage(initialMessage, parameterEditorState.readOnly);

  const focusTarget =
    parameterEditorState.focusTarget ||
    parameterEditorApply ||
    parameterEditorCancel ||
    parameterEditorClose;
  if (focusTarget && typeof focusTarget.focus === 'function') {
    setTimeout(() => focusTarget.focus(), 0);
  }
}

async function handleParameterEditorSubmit(event) {
  event.preventDefault();
  if (!parameterEditorState.visible || parameterEditorState.submitting) {
    return;
  }
  if (parameterEditorState.readOnly) {
    closeParameterEditor();
    return;
  }
  if (typeof parameterEditorState.getSubmitValue !== 'function') {
    updateParameterEditorMessage('Editor not ready for submission.', true);
    return;
  }
  const result = parameterEditorState.getSubmitValue();
  if (!result || typeof result !== 'object') {
    updateParameterEditorMessage('Unable to read editor value.', true);
    return;
  }
  if (result.error) {
    updateParameterEditorMessage(String(result.error), true);
    return;
  }
  const nextValue = result.value !== undefined ? result.value : '';
  updateParameterEditorMessage('Applying update…');
  parameterEditorState.submitting = true;
  setParameterEditorBusy(true);
  const nodeName = parameterEditorState.nodeName;
  const paramName = parameterEditorState.parameterName;
  const typeId = parameterEditorState.typeId;

  try {
    await requestNodeTool('set_parameter', nodeName, {
      method: 'POST',
      body: {
        name: paramName,
        type_id: typeId,
        value: nextValue,
      },
    });
  } catch (err) {
    const message = err?.message || String(err);
    updateParameterEditorMessage(`Failed to update: ${message}`, true);
    parameterEditorState.submitting = false;
    setParameterEditorBusy(false);
    return;
  }

  parameterEditorState.submitting = false;
  closeParameterEditor();
  statusEl.textContent = `Updated ${paramName} on ${nodeName}`;
  try {
    const payload = await requestNodeTool('parameters', nodeName);
    showNodeParametersOverlay(nodeName, payload);
  } catch (err) {
    const message = err?.message || String(err);
    statusEl.textContent = `Updated ${paramName}, but refresh failed: ${message}`;
  }
}

function handleOverlayDoubleClick(event) {
  if (!overlayCanvas) {
    return;
  }
  event.stopPropagation();
  if (!overlayState.visible || !overlayState.layout || !overlayState.table) {
    return;
  }
  const rect = overlayCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }
  const scaleX = overlayCanvas.width / rect.width;
  const scaleY = overlayCanvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const parameterIndex = findParameterRowIndexAtPosition(x, y);
  if (parameterIndex === null) {
    return;
  }
  event.preventDefault();
  void editParameterValue(parameterIndex);
}

async function editParameterValue(rowIndex) {
  const nodeName = overlayState.nodeName;
  const parameters = overlayState.table?.context?.parameters;
  if (!nodeName || !Array.isArray(parameters) || rowIndex < 0 || rowIndex >= parameters.length) {
    return;
  }
  const entry = parameters[rowIndex];
  const paramName = typeof entry?.name === 'string' ? entry.name : '';
  let typeId = Number(entry?.type_id);
  if (!paramName) {
    statusEl.textContent = `Unable to edit parameter for row ${rowIndex + 1}`;
    return;
  }
  if (!Number.isFinite(typeId)) {
    typeId = PARAMETER_STRING;
  }

  statusEl.textContent = `Loading details for ${paramName} on ${nodeName}…`;
  let detail = null;
  let warning = null;
  try {
    const payload = await requestNodeTool('describe_parameter', nodeName, {
      method: 'POST',
      body: {
        name: paramName,
      },
    });
    if (payload?.parameter) {
      detail = payload.parameter;
      if (!Number.isFinite(Number(detail.type_id))) {
        detail.type_id = typeId;
      }
    }
  } catch (err) {
    warning = err?.message || String(err);
  }

  openParameterEditor(nodeName, entry, detail, warning);
  if (warning) {
    statusEl.textContent = `Editing ${paramName} on ${nodeName} (metadata limited: ${warning})`;
  } else {
    statusEl.textContent = `Editing ${paramName} on ${nodeName}`;
  }
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
  contextMenuState.items = [];
}

function showContextMenu(clientPoint, target) {
  if (!contextMenu) {
    return;
  }
  if (!configureContextMenu(target)) {
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
  if (!target) {
    return;
  }

  if (target.type === 'topic-edge' || target.type === 'topic-node') {
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
    return;
  }

  if (target.type === 'node') {
    const nodeGeometry = currentScene.nodes?.get(target.nodeName);
    if (!nodeGeometry) {
      statusEl.textContent = `Node ${target.nodeName} not visible in current layout`;
      return;
    }

    if (action === 'info') {
      const cachedFeatureTable = nodeFeatureInfo.get(target.nodeName);
      if (cachedFeatureTable) {
        showOverlayWithTables(target.nodeName, cachedFeatureTable);
      } else {
        showOverlayForNode(target.nodeName, nodeGeometry);
      }
      statusEl.textContent = `Details shown for ${target.nodeName}`;
      if (!nodeFeatureInfo.has(target.nodeName)) {
        void enrichNodeInfoOverlay(target.nodeName);
      }
      return;
    }

    if (action === 'services') {
      const placeholder =
        `Node: ${target.nodeName}\n` +
        'Collecting services…';
      showOverlayWithDescription(target.nodeName, placeholder, false);
      statusEl.textContent = `Collecting services for ${target.nodeName}…`;
      try {
        const payload = await requestNodeTool('services', target.nodeName);
        showNodeServicesOverlay(target.nodeName, payload);
      } catch (err) {
        const message = err?.message || String(err);
        statusEl.textContent = `Failed to fetch services for ${target.nodeName}: ${message}`;
        showOverlayWithDescription(
          target.nodeName,
          `Node: ${target.nodeName}\nService query failed.\n${message}`,
          false,
        );
      }
      return;
    }

    if (action === 'parameters') {
      const placeholder =
        `Node: ${target.nodeName}\n` +
        'Collecting parameters…';
      showOverlayWithDescription(target.nodeName, placeholder, false);
      statusEl.textContent = `Collecting parameters for ${target.nodeName}…`;
      try {
        const payload = await requestNodeTool('parameters', target.nodeName);
        showNodeParametersOverlay(target.nodeName, payload);
      } catch (err) {
        const message = err?.message || String(err);
        statusEl.textContent = `Failed to fetch parameters for ${target.nodeName}: ${message}`;
        showOverlayWithDescription(
          target.nodeName,
          `Node: ${target.nodeName}\nParameter query failed.\n${message}`,
          false,
        );
      }
      return;
    }

    statusEl.textContent = `Unsupported node action: ${action}`;
    return;
  }

  statusEl.textContent = `Unsupported context action: ${action}`;
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

function resolveNodeTarget(nodeHit) {
  if (!nodeHit?.geometry || nodeHit.geometry.type !== 'node') {
    return null;
  }
  return {
    type: 'node',
    nodeName: nodeHit.name,
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
    return;
  }
  if (contextMenuState.target.type === 'node') {
    if (!currentScene.nodes?.has(contextMenuState.target.nodeName)) {
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

async function requestNodeTool(action, nodeName, options = {}) {
  const method = (options?.method || 'GET').toUpperCase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOPIC_TOOL_TIMEOUT);
  let response;
  let payload = {};
  try {
    if (method === 'GET') {
      const params = new URLSearchParams();
      params.set('action', action);
      params.set('node', nodeName);
      const extraParams = options?.params;
      if (extraParams && typeof extraParams === 'object') {
        Object.entries(extraParams).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            params.set(key, String(value));
          }
        });
      }
      response = await fetch(`/node_tool?${params.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
    } else if (method === 'POST') {
      const body = Object.assign({}, options?.body || {});
      if (!Object.prototype.hasOwnProperty.call(body, 'action')) {
        body.action = action;
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'node')) {
        body.node = nodeName;
      }
      response = await fetch('/node_tool', {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } else {
      throw new Error(`unsupported method ${method}`);
    }
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

  const topicName = payload.topic || target.topicName;
  const titleLines = [];
  titleLines.push(`Topic: ${topicName}`);
  if (payload.type) {
    titleLines.push(`Type: ${payload.type}`);
  }
  const samplesLineParts = [];
  if (payload.message_count !== undefined) {
    samplesLineParts.push(`Samples: ${payload.message_count}`);
  }
  if (payload.duration !== undefined) {
    samplesLineParts.push(`Window: ${formatNumber(payload.duration, 2)} s`);
  }
  if (samplesLineParts.length) {
    titleLines.push(samplesLineParts.join(' | '));
  }
  titleLines.push(`Cached: ${payload.cached ? 'yes' : 'no'}`);
  if (payload.warning) {
    titleLines.push(`Warning: ${payload.warning}`);
  }

  const frequencyTable = {
    title: 'Frequency (Hz)',
    headers: ['Min', 'Avg', 'Max'],
    rows: [[
      formatHz(payload.min_hz),
      formatHz(payload.average_hz),
      formatHz(payload.max_hz),
    ]],
  };

  const messageSizeTable = {
    title: 'Message Size',
    headers: ['Min', 'Avg', 'Max'],
    rows: [[
      formatBytes(payload.min_bytes),
      formatBytes(payload.average_bytes_per_msg),
      formatBytes(payload.max_bytes),
    ]],
  };

  const minBps = computeBandwidthValue(payload.min_hz, payload.min_bytes);
  const avgBps = payload.average_bps ?? computeBandwidthValue(payload.average_hz, payload.average_bytes_per_msg);
  const maxBps = computeBandwidthValue(payload.max_hz, payload.max_bytes);

  const bandwidthTable = {
    title: 'Bandwidth (B/s)',
    headers: ['Min', 'Avg', 'Max'],
    rows: [[
      formatBytesPerSecond(minBps),
      formatBytesPerSecond(avgBps),
      formatBytesPerSecond(maxBps),
    ]],
  };

  showOverlayWithTables(topicName, {
    titleLines,
    tables: [frequencyTable, messageSizeTable, bandwidthTable],
  });

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

function showNodeServicesOverlay(nodeName, payload) {
  if (!payload || typeof payload !== 'object') {
    statusEl.textContent = `No data returned for services on ${nodeName}`;
    return;
  }
  const geometry = currentScene.nodes?.get(nodeName);
  if (!geometry) {
    statusEl.textContent = `Received services for ${nodeName}, but it is not visible.`;
    return;
  }

  const titleLines = [`Node: ${nodeName}`];
  if (payload.namespace) {
    titleLines.push(`Namespace: ${payload.namespace}`);
  }
  const rows = Array.isArray(payload.services)
    ? payload.services.map(entry => {
        const name = entry?.name ?? '(unknown)';
        const types = Array.isArray(entry?.types) && entry.types.length
          ? entry.types.join(', ')
          : 'unknown type';
        return [name, types];
      })
    : [];
  const count = rows.length;

  if (!rows.length) {
    const lines = [...titleLines, 'No services available.'];
    showOverlayWithDescription(nodeName, lines.join('\n'), false);
  } else {
    showOverlayWithTables(nodeName, {
      titleLines,
      tables: [
        {
          title: 'Services',
          headers: ['Service', 'Type'],
          rows,
        },
      ],
    });
  }
  statusEl.textContent = `Services for ${nodeName}: ${count} found`;
}

function updateNodeFeatureInfoFromParameters(nodeName, parameters) {
  if (!nodeName) {
    return null;
  }
  const featureMap = new Map();
  const entries = Array.isArray(parameters) ? parameters : [];
  entries.forEach(entry => {
    const paramName = entry?.name;
    if (typeof paramName !== 'string') {
      return;
    }
    const match = paramName.match(/^feature(?:\.([^.]+))?\.(name|class|version|gui_version|state)$/i);
    if (!match) {
      return;
    }
    const featureKey = match[1] ? match[1] : '';
    const field = match[2].toLowerCase();
    if (!FEATURE_PARAM_ORDER.includes(field)) {
      return;
    }
    if (!featureMap.has(featureKey)) {
      featureMap.set(featureKey, new Map());
    }
    const value = entry?.value !== undefined ? String(entry.value) : '';
    featureMap.get(featureKey).set(field, value);
  });

  const tables = [];
  const keys = Array.from(featureMap.keys()).sort((a, b) => a.localeCompare(b));
  keys.forEach(key => {
    const fieldMap = featureMap.get(key);
    if (!fieldMap) {
      return;
    }
    const rows = [];
    FEATURE_PARAM_ORDER.forEach(field => {
      if (!fieldMap.has(field)) {
        return;
      }
      const label = FEATURE_LABELS[field] || field;
      rows.push([label, fieldMap.get(field)]);
    });
    if (!rows.length) {
      return;
    }
    const title = key ? `Feature: ${key}` : 'Feature';
    tables.push({
      title,
      headers: ['Field', 'Value'],
      rows,
    });
  });

  if (!tables.length) {
    nodeFeatureInfo.delete(nodeName);
    return null;
  }

  const data = {
    titleLines: buildNodeTitleLines(nodeName),
    tables,
  };
  nodeFeatureInfo.set(nodeName, data);
  return data;
}

async function enrichNodeInfoOverlay(nodeName) {
  if (!nodeName || !overlayState.visible || overlayState.nodeName !== nodeName) {
    return;
  }
  if (nodeFeatureInfo.has(nodeName)) {
    const cached = nodeFeatureInfo.get(nodeName);
    if (cached && overlayState.visible && overlayState.nodeName === nodeName) {
      showOverlayWithTables(nodeName, cached);
    }
    return;
  }

  try {
    const payload = await requestNodeTool('parameters', nodeName);
    const tableData = updateNodeFeatureInfoFromParameters(nodeName, payload?.parameters);
    if (tableData && overlayState.visible && overlayState.nodeName === nodeName) {
      showOverlayWithTables(nodeName, tableData);
      statusEl.textContent = `Details shown for ${nodeName}`;
    }
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.debug('Failed to enrich node info overlay', err);
    }
  }
}

function showNodeParametersOverlay(nodeName, payload) {
  if (!payload || typeof payload !== 'object') {
    statusEl.textContent = `No data returned for parameters on ${nodeName}`;
    return;
  }
  const geometry = currentScene.nodes?.get(nodeName);
  if (!geometry) {
    statusEl.textContent = `Received parameters for ${nodeName}, but it is not visible.`;
    return;
  }

  const titleLines = [`Node: ${nodeName}`];
  if (payload.namespace) {
    titleLines.push(`Namespace: ${payload.namespace}`);
  }
  const parameterEntries = Array.isArray(payload.parameters) ? payload.parameters : [];
  const rows = parameterEntries.map(entry => {
    const name = entry?.name ?? '(unknown)';
    const value = entry?.value ?? '';
    return [name, String(value)];
  });
  const count = rows.length;

  if (!rows.length) {
    const lines = [...titleLines, 'No parameters available.'];
    showOverlayWithDescription(nodeName, lines.join('\n'), false);
  } else {
    const header = ['Name', 'Value'];
    showOverlayWithTables(nodeName, {
      titleLines,
      tables: [
        {
          title: `Parameters (${count})`,
          headers: header,
          rows,
        },
      ],
      context: {
        parameters: parameterEntries,
      },
    });
  }

  updateNodeFeatureInfoFromParameters(nodeName, parameterEntries);
  if (count) {
    statusEl.textContent = `Parameters for ${nodeName}: ${count} found (double-click a value to edit)`;
  } else {
    statusEl.textContent = `Parameters for ${nodeName}: ${count} found`;
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
  const widthLimit = overlayState.maxWidth > 0
    ? Math.max(overlayState.maxWidth, OVERLAY_PADDING * 2 + 40)
    : OVERLAY_MAX_WIDTH;
  const maxTextWidth = Math.max(OVERLAY_PADDING * 2, widthLimit - OVERLAY_PADDING * 2);
  const lines = wrapOverlayText(description, maxTextWidth);
  let maxWidth = 0;
  lines.forEach(line => {
    const width = overlayCtx.measureText(line).width;
    if (width > maxWidth) {
      maxWidth = width;
    }
  });
  const desiredWidth = Math.max(maxWidth, 120) + OVERLAY_PADDING * 2;
  const boxWidth = Math.min(widthLimit, desiredWidth);
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
  overlayState.layout = {
    box: {
      x: boxX,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
    },
    tables: [],
  };
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
  if (overlayState.table) {
    const anchorPoint = layoutToView(geometry.center);
    drawOverlayTables(anchorPoint, overlayState.table);
    return;
  }
  if (overlayState.auto) {
    overlayState.description = resolveOverlayDescription(overlayState.nodeName, geometry);
    overlayState.maxWidth = 0;
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

function showOverlayWithDescription(nodeName, description, auto = false, maxWidth = 0) {
  overlayState.visible = true;
  overlayState.nodeName = nodeName;
  overlayState.description = description;
  overlayState.auto = auto;
  overlayState.maxWidth = Math.max(0, maxWidth || 0);
  overlayState.table = null;
  overlayState.layout = null;
  overlayState.hoverRow = null;
  setOverlayPointerCapture(true);
  refreshOverlay();
}

function showOverlayWithTables(nodeName, tableData) {
  overlayState.visible = true;
  overlayState.nodeName = nodeName;
  overlayState.description = '';
  overlayState.auto = false;
  overlayState.maxWidth = 0;
  overlayState.table = tableData;
  overlayState.layout = null;
  overlayState.hoverRow = null;
  setOverlayPointerCapture(true);
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

function buildNodeTitleLines(nodeName) {
  const parts = splitNodeName(nodeName);
  const lines = [`Node: ${nodeName}`];
  if (parts.basename && parts.basename !== nodeName) {
    lines.push(`Base name: ${parts.basename}`);
  }
  if (parts.namespace && parts.namespace !== nodeName) {
    lines.push(`Namespace: ${parts.namespace}`);
  } else if (!parts.namespace || parts.namespace === nodeName) {
    lines.push('Namespace: /');
  }
  if (lines.length === 1) {
    lines.push('Namespace: /');
  }
  return lines;
}

function buildDefaultNodeDescription(nodeName) {
  const lines = buildNodeTitleLines(nodeName);
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
  const availableNodes = new Set(graph.nodes || []);
  for (const key of Array.from(nodeFeatureInfo.keys())) {
    if (!availableNodes.has(key)) {
      nodeFeatureInfo.delete(key);
    }
  }
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
  const edgeHit = nodeHit ? null : findEdgeAt(graphPoint);
  if (edgeHit) {
    const target = resolveTopicEdgeTarget(edgeHit);
    if (target) {
      hideOverlay();
      showContextMenu({ x: event.clientX, y: event.clientY }, target);
      return;
    }
  }
  if (nodeHit && nodeHit.geometry?.type === 'node') {
    hideOverlay();
    const target = resolveNodeTarget(nodeHit);
    if (target) {
      showContextMenu({ x: event.clientX, y: event.clientY }, target);
      return;
    }
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
