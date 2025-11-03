export const VIEW_MIN_SCALE = 0.25;
export const VIEW_MAX_SCALE = 6;
export const ZOOM_SENSITIVITY = 0.0015;
export const BASE_STROKE_WIDTH = 1.5;
export const MIN_STROKE_WIDTH = 0.75;
export const MAX_STROKE_WIDTH = 2.5;

export const SELECT_EDGE_COLOR = '#ff9800';
export const SELECT_NODE_STROKE = '#ff9800';
export const SELECT_NODE_FILL = '#ffe6bf';
export const SELECT_TOPIC_STROKE = '#ff9800';
export const SELECT_TOPIC_FILL = '#d8f5d0';
export const HOVER_EDGE_COLOR = '#42a5f5';
export const HOVER_NODE_STROKE = '#42a5f5';
export const HOVER_NODE_FILL = '#d6ecff';
export const HOVER_TOPIC_STROKE = '#42a5f5';
export const HOVER_TOPIC_FILL = '#cbe8ff';

export const MIN_ARROW_HEAD = 4;
export const MAX_ARROW_HEAD = 18;

export const PARAMETER_TYPES = {
  PARAMETER_NOT_SET: 0,
  PARAMETER_BOOL: 1,
  PARAMETER_INTEGER: 2,
  PARAMETER_DOUBLE: 3,
  PARAMETER_STRING: 4,
  PARAMETER_BYTE_ARRAY: 5,
  PARAMETER_BOOL_ARRAY: 6,
  PARAMETER_INTEGER_ARRAY: 7,
  PARAMETER_DOUBLE_ARRAY: 8,
  PARAMETER_STRING_ARRAY: 9,
};

export const SERVICE_BOOLEAN_TYPES = new Set(['bool', 'boolean']);
export const SERVICE_INTEGER_TYPES = new Set([
  'int8',
  'uint8',
  'int16',
  'uint16',
  'int32',
  'uint32',
  'int64',
  'uint64',
  'byte',
  'char',
]);
export const SERVICE_FLOAT_TYPES = new Set(['float', 'float32', 'double', 'float64']);
export const SERVICE_STRING_TYPES = new Set(['string', 'wstring']);
export const SERVICE_INTEGER_LIMITS = {
  int8: { min: -128, max: 127 },
  uint8: { min: 0, max: 255 },
  int16: { min: -32768, max: 32767 },
  uint16: { min: 0, max: 65535 },
  int32: { min: -2147483648, max: 2147483647 },
  uint32: { min: 0, max: 4294967295 },
  byte: { min: 0, max: 255 },
  char: { min: 0, max: 255 },
};

export const BASE_FONT_FAMILY = '"Times New Roman", serif';
export const BASE_FONT_SIZE = 14;
export const BASE_LINE_HEIGHT = 18;
export const POINTS_PER_INCH = 72;
export const MIN_FONT_SIZE_PX = 7;
export const BASE_LINE_HEIGHT_RATIO = BASE_LINE_HEIGHT / BASE_FONT_SIZE;
export const OVERLAY_FONT = '14.3px "Segoe UI", system-ui, -apple-system, sans-serif';
export const OVERLAY_LINE_HEIGHT = 18;
export const OVERLAY_PADDING = 12;
export const OVERLAY_MAX_WIDTH = 320;
export const OVERLAY_MARGIN = 12;

export const TOPIC_TOOL_TIMEOUT = 15000;
export const TOPIC_ECHO_REFRESH_MS = 750;
export const FEATURE_PARAM_ORDER = ['name', 'class', 'version', 'gui_version', 'state'];
export const FEATURE_LABELS = {
  name: 'Name',
  class: 'Class',
  version: 'Version',
  gui_version: 'GUI Version',
  state: 'State',
};

export const HIDDEN_NAME_PATTERNS = [/\/rosout\b/i];
