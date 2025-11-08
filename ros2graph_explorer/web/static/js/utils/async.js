export async function withTimeout(promise, timeoutMs, controller) {
  if (!timeoutMs) {
    return promise;
  }
  const timeoutController = controller ?? new AbortController();
  const timer = window.setTimeout(() => timeoutController.abort(), timeoutMs);
  try {
    return await promise;
  } finally {
    window.clearTimeout(timer);
  }
}

export function createAbortableTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => window.clearTimeout(timer),
  };
}
