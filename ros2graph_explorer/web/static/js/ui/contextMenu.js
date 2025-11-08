import { toggleHidden } from '../utils/dom.js';

export class ContextMenu {
  constructor(element, { getItems, onSelect }) {
    this.element = element;
    this.getItems = getItems;
    this.onSelect = onSelect;
    this.visible = false;
    this.target = null;
    this.items = [];

    if (this.element) {
      this.element.addEventListener('click', event => {
        const action = event.target?.dataset?.action;
        if (!action) {
          return;
        }
        event.stopPropagation();
        this.onSelect?.(action, this.target);
        this.toggle(false);
      });
    }
  }

  contains(node) {
    if (!this.element) {
      return false;
    }
    return this.element.contains(node);
  }

  toggle(visible, point, target) {
    if (!this.element) {
      return;
    }
    if (!visible) {
      this.visible = false;
      this.target = null;
      this.items = [];
      toggleHidden(this.element, true);
      this.element.classList.remove('visible');
      return;
    }
    const items = this.getItems ? this.getItems(target) : [];
    if (!items.length) {
      this.toggle(false);
      return;
    }
    this.element.innerHTML = '';
    items.forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = item.action;
      button.textContent = item.label;
      this.element.appendChild(button);
    });
    this.items = items;
    this.target = target;
    this.visible = true;
    if (point) {
      this.positionAt(point);
    }
    toggleHidden(this.element, false);
    this.element.classList.add('visible');
  }

  positionAt(point) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const baseLeft =
      typeof point.clientX === 'number'
        ? point.clientX
        : typeof point.pageX === 'number'
        ? point.pageX - window.scrollX
        : 0;
    const baseTop =
      typeof point.clientY === 'number'
        ? point.clientY
        : typeof point.pageY === 'number'
        ? point.pageY - window.scrollY
        : 0;

    const previousDisplay = this.element.style.display;
    const previousVisibility = this.element.style.visibility;
    this.element.style.display = 'flex';
    this.element.style.visibility = 'hidden';
    this.element.style.left = '0px';
    this.element.style.top = '0px';

    const menuWidth = this.element.offsetWidth || 0;
    const menuHeight = this.element.offsetHeight || 0;

    const maxLeft = viewportWidth - menuWidth;
    const maxTop = viewportHeight - menuHeight;

    const finalLeft = Math.max(0, Math.min(baseLeft, maxLeft));
    const finalTop = Math.max(0, Math.min(baseTop, maxTop));

    this.element.style.left = `${Math.round(finalLeft)}px`;
    this.element.style.top = `${Math.round(finalTop)}px`;
    this.element.style.visibility = previousVisibility || '';
    this.element.style.display = previousDisplay || '';
  }
}
