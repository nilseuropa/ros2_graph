// Core UI constants shared across modules.

export const VIEW_MIN_SCALE = 0.05;
export const VIEW_MAX_SCALE = 6;
export const ZOOM_SENSITIVITY = 0.0015;

export const BASE_STROKE_WIDTH = 1.5;
export const MIN_STROKE_WIDTH = 0.75;
export const MAX_STROKE_WIDTH = 2.5;

export const MIN_ARROW_HEAD = 4;
export const MAX_ARROW_HEAD = 18;

export const BASE_EDGE_COLOR = '#3a4b5e';
export const SELECT_EDGE_COLOR = '#ffab3d';
export const HOVER_EDGE_COLOR = '#5cb2ff';

export const SELECT_NODE = {
  stroke: SELECT_EDGE_COLOR,
  fill: '#4b7da1',
};

export const SELECT_TOPIC = {
  stroke: SELECT_EDGE_COLOR,
  fill: '#1f2e41',
};

export const HOVER_NODE = {
  stroke: HOVER_EDGE_COLOR,
  fill: '#3f6d90',
};

export const HOVER_TOPIC = {
  stroke: HOVER_EDGE_COLOR,
  fill: '#162331',
};

export const BASE_FONT_FAMILY = 'Inter, "Segoe UI", Roboto, sans-serif';
export const BASE_FONT_SIZE = 14;
export const BASE_LINE_HEIGHT_RATIO = 1.4;
export const MIN_FONT_SIZE_PX = 11;

export const FETCH_TIMEOUT_MS = 10000;

export const GRAPH_REFRESH_INTERVAL_MS = 2000;
