export class GraphState {
  constructor() {
    this.view = {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    };
    this.userAdjustedView = false;
    this.pan = {
      active: false,
      pointerId: null,
      lastX: 0,
      lastY: 0,
    };
    this.scene = {
      nodes: new Map(),
      edges: [],
    };
    this.selection = {
      key: '',
      nodes: new Set(),
      edges: new Set(),
    };
    this.hover = {
      key: '',
      nodes: new Set(),
      edges: new Set(),
    };
    this.nodeDescriptions = new Map();
    this.nodeFeatureInfo = new Map();
    this.lastGraph = null;
    this.lastFingerprint = null;
  }

  resetView() {
    this.view.scale = 1;
    this.view.offsetX = 0;
    this.view.offsetY = 0;
    this.userAdjustedView = false;
  }
}
