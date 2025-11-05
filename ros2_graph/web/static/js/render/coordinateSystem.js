export function toScenePoint(view, canvasPoint) {
  const scale = view?.scale ?? 1;
  const offsetX = view?.offsetX ?? 0;
  const offsetY = view?.offsetY ?? 0;
  return {
    x: (canvasPoint.x - offsetX) / scale,
    y: (canvasPoint.y - offsetY) / scale,
  };
}

export function toCanvasPoint(view, scenePoint) {
  const scale = view?.scale ?? 1;
  const offsetX = view?.offsetX ?? 0;
  const offsetY = view?.offsetY ?? 0;
  return {
    x: scenePoint.x * scale + offsetX,
    y: scenePoint.y * scale + offsetY,
  };
}
