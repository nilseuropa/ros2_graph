/* DOM helper utilities to keep imperative code tidy. */

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function setText(el, text) {
  if (!el) {
    return;
  }
  el.textContent = text;
}

export function toggleHidden(el, hidden) {
  if (!el) {
    return;
  }
  el.classList.toggle('hidden', hidden);
  el.setAttribute('aria-hidden', hidden ? 'true' : 'false');
}

export function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

export function bindEvent(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export function nextAnimationFrame() {
  return new Promise(resolve => window.requestAnimationFrame(resolve));
}
