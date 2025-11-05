export function throttle(fn, intervalMs) {
  let lastTime = 0;
  let timer = null;
  let pendingArgs = null;

  const invoke = () => {
    lastTime = Date.now();
    timer = null;
    const args = pendingArgs;
    pendingArgs = null;
    fn(...args);
  };

  return (...args) => {
    pendingArgs = args;
    const now = Date.now();
    const elapsed = now - lastTime;
    if (elapsed >= intervalMs) {
      invoke();
      return;
    }
    if (timer) {
      return;
    }
    timer = window.setTimeout(invoke, intervalMs - elapsed);
  };
}
