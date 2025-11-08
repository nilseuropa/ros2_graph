import { VIEW_MIN_SCALE, VIEW_MAX_SCALE, ZOOM_SENSITIVITY } from '../constants/index.js';
import { clamp } from '../utils/dom.js';

export class ViewController {
  constructor(store) {
    this.store = store;
    this.panPointerId = null;
    this.lastPanPoint = null;
  }

  zoomAt(canvasPoint, deltaY) {
    const view = this.store.getView();
    const scaleDelta = clamp(
      view.scale * (1 - deltaY * ZOOM_SENSITIVITY),
      VIEW_MIN_SCALE,
      VIEW_MAX_SCALE,
    );
    if (scaleDelta === view.scale) {
      return;
    }
    const scaleRatio = scaleDelta / view.scale;
    const nextOffsetX = canvasPoint.x - scaleRatio * (canvasPoint.x - view.offsetX);
    const nextOffsetY = canvasPoint.y - scaleRatio * (canvasPoint.y - view.offsetY);
    this.store.updateView({
      scale: scaleDelta,
      offsetX: nextOffsetX,
      offsetY: nextOffsetY,
    });
  }

  beginPan(pointerId, canvasPoint) {
    this.panPointerId = pointerId;
    this.lastPanPoint = { ...canvasPoint };
  }

  updatePan(pointerId, canvasPoint) {
    if (this.panPointerId !== pointerId || !this.lastPanPoint) {
      return;
    }
    const dx = canvasPoint.x - this.lastPanPoint.x;
    const dy = canvasPoint.y - this.lastPanPoint.y;
    if (dx === 0 && dy === 0) {
      return;
    }
    this.lastPanPoint = { ...canvasPoint };
    this.store.updateView(view => ({
      ...view,
      offsetX: view.offsetX + dx,
      offsetY: view.offsetY + dy,
    }));
  }

  endPan(pointerId) {
    if (this.panPointerId !== pointerId) {
      return;
    }
    this.panPointerId = null;
    this.lastPanPoint = null;
  }

  isPanning() {
    return this.panPointerId !== null;
  }
}
