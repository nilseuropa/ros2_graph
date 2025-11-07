import { toggleHidden, clamp } from '../utils/dom.js';

const EDGE_PADDING = 16;
const MIN_PANEL_WIDTH = 320;
const MIN_RESIZE_WIDTH = 200;
const MIN_PANEL_HEIGHT = 200;
const MIN_RESIZE_HEIGHT = 160;
const MAX_PANEL_WIDTH = 720;

export class OverlayPanel {
  constructor(container) {
    this.container = container || document.body;
    this.onAction = null;
    this.overlays = new Map();
    this.spawnIndex = 0;
    this.zIndexSeed = 30;
    this.dragState = null;
    this.resizeState = null;
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleResizePointerMove = this.handleResizePointerMove.bind(this);
    this.handleResizePointerUp = this.handleResizePointerUp.bind(this);
    this.handleWindowResize = this.handleWindowResize.bind(this);
    window.addEventListener('resize', this.handleWindowResize);
  }

  setActionHandler(handler) {
    this.onAction = handler;
  }

  show(content, options = {}) {
    const id = options.id || this.generateId();
    const overlay = this.ensureOverlay(id, options);
    this.renderContent(overlay, content);
    toggleHidden(overlay.root, false);
    this.bringToFront(overlay);
    this.syncSize(overlay);
    this.ensureWithinBounds(overlay);
    window.requestAnimationFrame(() => {
      this.syncSize(overlay);
      this.ensureWithinBounds(overlay);
    });
    return id;
  }

  hide(options = {}) {
    if (options?.id) {
      const overlay = this.overlays.get(options.id);
      if (!overlay) {
        return;
      }
      this.emitOverlayClose(overlay);
      overlay.root.remove();
      this.overlays.delete(options.id);
      if (this.dragState?.overlayId === options.id) {
        this.endDrag();
      }
      if (this.resizeState?.overlayId === options.id) {
        this.endResize();
      }
      return;
    }
    this.overlays.forEach(entry => {
      this.emitOverlayClose(entry);
      entry.root.remove();
    });
    this.overlays.clear();
    this.endDrag();
    this.endResize();
  }

  isOpen(id) {
    if (!id) {
      return this.overlays.size > 0;
    }
    return this.overlays.has(id);
  }

  ensureOverlay(id, options = {}) {
    let overlay = this.overlays.get(id);
    if (!overlay) {
      overlay = this.createOverlay(id, options);
      this.overlays.set(id, overlay);
    } else if (options.position) {
      this.applyPosition(overlay, options.position);
    }
    return overlay;
  }

  createOverlay(id, options) {
    const root = document.createElement('div');
    root.className = 'overlay-panel overlay-panel--floating hidden';
    root.dataset.overlayId = id;
    root.tabIndex = 0;
    root.setAttribute('role', 'dialog');

    const header = document.createElement('div');
    header.className = 'overlay-panel__header';

    const title = document.createElement('div');
    title.className = 'overlay-panel__title';
    header.appendChild(title);

    const controls = document.createElement('div');
    controls.className = 'overlay-panel__controls';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'overlay-panel__close';
    closeBtn.setAttribute('aria-label', 'Close overlay');
    closeBtn.textContent = '×';
    controls.appendChild(closeBtn);
    header.appendChild(controls);

    const subtitle = document.createElement('div');
    subtitle.className = 'overlay-panel__subtitle';
    subtitle.hidden = true;

    const body = document.createElement('div');
    body.className = 'overlay-panel__body';

    const resizer = document.createElement('div');
    resizer.className = 'overlay-panel__resizer';
    resizer.setAttribute('aria-hidden', 'true');

    root.appendChild(header);
    root.appendChild(subtitle);
    root.appendChild(body);
    root.appendChild(resizer);

    this.container.appendChild(root);

    const overlay = {
      id,
      root,
      header,
      titleEl: title,
      subtitleEl: subtitle,
      bodyEl: body,
      resizer,
      size: {
        width: null,
        height: null,
      },
    };

    closeBtn.addEventListener('click', () => this.hide({ id }));
    header.addEventListener('pointerdown', event => this.startDrag(event, overlay));
    resizer.addEventListener('pointerdown', event => this.startResize(event, overlay));
    root.addEventListener('pointerdown', () => this.bringToFront(overlay));
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.hide({ id });
      }
    });

    this.applyInitialPosition(overlay, options);
    this.bringToFront(overlay);
    return overlay;
  }

  applyInitialPosition(overlay, options) {
    if (options?.position && Number.isFinite(options.position.x) && Number.isFinite(options.position.y)) {
      this.applyPosition(overlay, options.position);
      return;
    }
    const width = this.container?.clientWidth || window.innerWidth || 0;
    const offset = (this.spawnIndex++ % 6) * 32;
    const maxLeft = Math.max(EDGE_PADDING, width - EDGE_PADDING - MIN_PANEL_WIDTH);
    const desiredLeft = width - MIN_PANEL_WIDTH - EDGE_PADDING - offset;
    const defaultLeft = clamp(desiredLeft, EDGE_PADDING, maxLeft);
    const top = EDGE_PADDING + offset;
    overlay.root.style.left = `${Math.max(EDGE_PADDING, defaultLeft)}px`;
    overlay.root.style.top = `${Math.max(EDGE_PADDING, top)}px`;
  }

  applyPosition(overlay, position) {
    const left = Number.isFinite(position.x) ? position.x : EDGE_PADDING;
    const top = Number.isFinite(position.y) ? position.y : EDGE_PADDING;
    overlay.root.style.left = `${left}px`;
    overlay.root.style.top = `${top}px`;
  }

  bringToFront(overlay) {
    if (!overlay?.root) {
      return;
    }
    this.zIndexSeed += 1;
    overlay.root.style.zIndex = String(this.zIndexSeed);
  }

  renderContent(overlay, content) {
    if (!overlay) {
      return;
    }
    const titleText = content?.title ?? '';
    overlay.titleEl.textContent = titleText;
    overlay.titleEl.classList.toggle('overlay-panel__title--empty', !titleText);

    const hasSubtitle = Boolean(content?.subtitle);
    overlay.subtitleEl.textContent = hasSubtitle ? content.subtitle : '';
    overlay.subtitleEl.hidden = !hasSubtitle;

    overlay.bodyEl.innerHTML = '';
    if (!content) {
      return;
    }

    if (content.description) {
      const descriptionLines = Array.isArray(content.description) ? content.description : [content.description];
      descriptionLines.forEach(line => {
        const p = document.createElement('p');
        p.className = 'overlay-panel__description';
        p.textContent = line;
        overlay.bodyEl.appendChild(p);
      });
    }

    const sections = Array.isArray(content.sections) ? content.sections : [];
    sections.forEach(section => {
      if (section.type === 'table') {
        this.renderTableSection(overlay.bodyEl, section);
      } else if (section.type === 'text') {
        this.renderTextSection(overlay.bodyEl, section);
      } else if (section.type === 'code') {
        this.renderCodeSection(overlay.bodyEl, section);
      } else if (section.type === 'custom') {
        this.renderCustomSection(overlay.bodyEl, section);
      }
    });
  }

  renderTextSection(container, section) {
    const wrapper = document.createElement('div');
    wrapper.className = 'overlay-panel__section';
    if (section.title) {
      const heading = document.createElement('div');
      heading.className = 'overlay-panel__section-title';
      heading.textContent = section.title;
      wrapper.appendChild(heading);
    }
    const lines = Array.isArray(section.text) ? section.text : [section.text];
    lines.forEach(line => {
      const p = document.createElement('p');
      p.textContent = line;
      wrapper.appendChild(p);
    });
    container.appendChild(wrapper);
  }

  renderTableSection(container, section) {
    const wrapper = document.createElement('div');
    wrapper.className = 'overlay-panel__section';
    if (section.title) {
      const heading = document.createElement('div');
      heading.className = 'overlay-panel__section-title';
      heading.textContent = section.title;
      wrapper.appendChild(heading);
    }
    const table = document.createElement('table');
    table.className = 'overlay-panel__table';
    if (section.headers && section.headers.length) {
      const thead = document.createElement('thead');
      const row = document.createElement('tr');
      section.headers.forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        row.appendChild(th);
      });
      thead.appendChild(row);
      table.appendChild(thead);
    }
    const tbody = document.createElement('tbody');
    const rows = Array.isArray(section.rows) ? section.rows : [];
    rows.forEach(rowData => {
      const tr = document.createElement('tr');
      const cells = Array.isArray(rowData.cells) ? rowData.cells : rowData;
      cells.forEach(cell => {
        const td = document.createElement('td');
        td.textContent = cell ?? '';
        tr.appendChild(td);
      });
      if (rowData.action && this.onAction) {
        tr.classList.add('overlay-panel__row--actionable');
        tr.addEventListener('click', () => {
          this.onAction?.(rowData.action);
        });
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    container.appendChild(wrapper);
  }

  renderCodeSection(container, section) {
    const wrapper = document.createElement('div');
    wrapper.className = 'overlay-panel__section overlay-panel__section--code';
    if (section.title) {
      const heading = document.createElement('div');
      heading.className = 'overlay-panel__section-title';
      heading.textContent = section.title;
      wrapper.appendChild(heading);
    }
    const pre = document.createElement('pre');
    pre.className = 'overlay-panel__code';
    pre.textContent = formatCode(section.code);
    wrapper.appendChild(pre);
    container.appendChild(wrapper);
  }

  renderCustomSection(container, section) {
    const wrapper = document.createElement('div');
    wrapper.className = 'overlay-panel__section';
    if (section.className) {
      wrapper.classList.add(section.className);
    }
    if (typeof section.render === 'function') {
      section.render(wrapper);
    } else if (section.element instanceof Node) {
      wrapper.appendChild(section.element);
    }
    container.appendChild(wrapper);
  }

  syncSize(overlay) {
    if (!overlay?.root?.isConnected) {
      return;
    }
    const containerWidth = this.container?.clientWidth || window.innerWidth || MIN_PANEL_WIDTH;
    const containerHeight = this.container?.clientHeight || window.innerHeight || MIN_PANEL_HEIGHT;

    const maxWidthAvailable = Math.max(0, containerWidth - EDGE_PADDING * 2);
    const hasCustomWidth = overlay.size?.width != null;
    const minWidthLimit = hasCustomWidth ? MIN_RESIZE_WIDTH : MIN_PANEL_WIDTH;
    const widthLowerBound =
      maxWidthAvailable > 0 && maxWidthAvailable < minWidthLimit ? maxWidthAvailable : minWidthLimit;
    const widthUpperBoundRaw = Math.min(MAX_PANEL_WIDTH, maxWidthAvailable);
    const widthUpperBound = Math.max(widthLowerBound, widthUpperBoundRaw);
    const effectiveMaxWidth = widthUpperBound > 0 ? widthUpperBound : Math.max(widthLowerBound, MIN_PANEL_WIDTH);
    overlay.root.style.maxWidth = `${effectiveMaxWidth}px`;

    if (overlay.size?.width != null) {
      const width = clamp(overlay.size.width, widthLowerBound, widthUpperBound);
      overlay.size.width = width;
      overlay.root.style.width = `${width}px`;
    } else {
      overlay.root.style.width = 'auto';
      const measured = Math.ceil(overlay.root.scrollWidth + 24);
      const width = clamp(measured, widthLowerBound, widthUpperBound || effectiveMaxWidth || measured);
      overlay.root.style.width = `${width}px`;
    }

    const maxHeightAvailable = Math.max(0, containerHeight - EDGE_PADDING * 2);
    const hasCustomHeight = overlay.size?.height != null;
    const minHeightLimit = hasCustomHeight ? MIN_RESIZE_HEIGHT : MIN_PANEL_HEIGHT;
    const heightLowerBound =
      maxHeightAvailable > 0 && maxHeightAvailable < minHeightLimit ? maxHeightAvailable : minHeightLimit;
    const heightUpperBound = Math.max(heightLowerBound, maxHeightAvailable);
    const effectiveMaxHeight =
      heightUpperBound > 0 ? heightUpperBound : Math.max(heightLowerBound, MIN_PANEL_HEIGHT);
    overlay.root.style.maxHeight = `${effectiveMaxHeight}px`;

    if (overlay.size?.height != null) {
      const height = clamp(overlay.size.height, heightLowerBound, heightUpperBound);
      overlay.size.height = height;
      overlay.root.style.height = `${height}px`;
    } else {
      overlay.root.style.height = '';
    }
  }

  ensureWithinBounds(overlay) {
    if (!overlay?.root?.isConnected) {
      return;
    }
    const width = this.container?.clientWidth || window.innerWidth || 0;
    const height = this.container?.clientHeight || window.innerHeight || 0;
    if (width === 0 || height === 0) {
      return;
    }
    const panelWidth = overlay.root.offsetWidth;
    const panelHeight = overlay.root.offsetHeight;
    const maxLeft = Math.max(EDGE_PADDING, width - panelWidth - EDGE_PADDING);
    const maxTop = Math.max(EDGE_PADDING, height - panelHeight - EDGE_PADDING);
    const currentLeft = this.resolvePositionValue(overlay.root.style.left, overlay.root.offsetLeft);
    const currentTop = this.resolvePositionValue(overlay.root.style.top, overlay.root.offsetTop);
    overlay.root.style.left = `${clamp(currentLeft, EDGE_PADDING, maxLeft)}px`;
    overlay.root.style.top = `${clamp(currentTop, EDGE_PADDING, maxTop)}px`;
  }

  resolvePositionValue(styleValue, fallback) {
    const numeric = parseFloat(styleValue);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    if (Number.isFinite(fallback)) {
      return fallback;
    }
    return EDGE_PADDING;
  }

  startDrag(event, overlay) {
    if (!overlay?.root) {
      return;
    }
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    if (event.target.closest('button')) {
      return;
    }
    this.endResize();
    event.preventDefault();
    const containerRect = this.container.getBoundingClientRect();
    const overlayRect = overlay.root.getBoundingClientRect();
    this.dragState = {
      overlayId: overlay.id,
      pointerId: event.pointerId,
      offsetX: event.clientX - overlayRect.left,
      offsetY: event.clientY - overlayRect.top,
      containerLeft: containerRect.left,
      containerTop: containerRect.top,
    };
    this.bringToFront(overlay);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerUp);
  }

  handlePointerMove(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
      return;
    }
    event.preventDefault();
    const overlay = this.overlays.get(this.dragState.overlayId);
    if (!overlay?.root) {
      return;
    }
    const width = this.container?.clientWidth || window.innerWidth || 0;
    const height = this.container?.clientHeight || window.innerHeight || 0;
    const panelWidth = overlay.root.offsetWidth;
    const panelHeight = overlay.root.offsetHeight;
    const maxLeft = Math.max(EDGE_PADDING, width - panelWidth - EDGE_PADDING);
    const maxTop = Math.max(EDGE_PADDING, height - panelHeight - EDGE_PADDING);
    const left = clamp(
      event.clientX - this.dragState.containerLeft - this.dragState.offsetX,
      EDGE_PADDING,
      maxLeft,
    );
    const top = clamp(
      event.clientY - this.dragState.containerTop - this.dragState.offsetY,
      EDGE_PADDING,
      maxTop,
    );
    overlay.root.style.left = `${left}px`;
    overlay.root.style.top = `${top}px`;
  }

  handlePointerUp(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
      return;
    }
    this.endDrag();
  }

  startResize(event, overlay) {
    if (!overlay?.root) {
      return;
    }
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.endDrag();
    const containerRect = this.container?.getBoundingClientRect();
    const overlayRect = overlay.root.getBoundingClientRect();
    this.resizeState = {
      overlayId: overlay.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: overlayRect.width,
      startHeight: overlayRect.height,
      offsetLeft: overlayRect.left - (containerRect?.left ?? 0),
      offsetTop: overlayRect.top - (containerRect?.top ?? 0),
    };
    this.bringToFront(overlay);
    window.addEventListener('pointermove', this.handleResizePointerMove);
    window.addEventListener('pointerup', this.handleResizePointerUp);
    window.addEventListener('pointercancel', this.handleResizePointerUp);
  }

  handleResizePointerMove(event) {
    if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) {
      return;
    }
    event.preventDefault();
    const overlay = this.overlays.get(this.resizeState.overlayId);
    if (!overlay?.root) {
      this.endResize();
      return;
    }
    const containerWidth = this.container?.clientWidth || window.innerWidth || this.resizeState.startWidth;
    const containerHeight = this.container?.clientHeight || window.innerHeight || this.resizeState.startHeight;
    const left = this.resolvePositionValue(overlay.root.style.left, this.resizeState.offsetLeft);
    const top = this.resolvePositionValue(overlay.root.style.top, this.resizeState.offsetTop);
    const deltaX = event.clientX - this.resizeState.startX;
    const deltaY = event.clientY - this.resizeState.startY;
    const desiredWidth = this.resizeState.startWidth + deltaX;
    const desiredHeight = this.resizeState.startHeight + deltaY;
    const maxWidth = clamp(containerWidth - EDGE_PADDING * 2, MIN_RESIZE_WIDTH, MAX_PANEL_WIDTH);
    const maxHeight = Math.max(MIN_RESIZE_HEIGHT, containerHeight - EDGE_PADDING * 2);

    const availableWidth = Math.max(0, containerWidth - EDGE_PADDING - left);
    const widthUpperBoundRaw = Math.min(maxWidth, availableWidth);
    const widthLowerBound =
      widthUpperBoundRaw > 0 && widthUpperBoundRaw < MIN_RESIZE_WIDTH ? widthUpperBoundRaw : MIN_RESIZE_WIDTH;
    const widthUpperBound = Math.max(widthLowerBound, widthUpperBoundRaw);
    const newWidth = clamp(desiredWidth, widthLowerBound, widthUpperBound);

    const availableHeight = Math.max(0, containerHeight - EDGE_PADDING - top);
    const heightUpperBoundRaw = Math.min(maxHeight, availableHeight);
    const heightLowerBound =
      heightUpperBoundRaw > 0 && heightUpperBoundRaw < MIN_RESIZE_HEIGHT ? heightUpperBoundRaw : MIN_RESIZE_HEIGHT;
    const heightUpperBound = Math.max(heightLowerBound, heightUpperBoundRaw);
    const newHeight = clamp(desiredHeight, heightLowerBound, heightUpperBound);

    overlay.root.style.width = `${newWidth}px`;
    overlay.root.style.height = `${newHeight}px`;
    overlay.root.style.maxWidth = `${maxWidth}px`;
    overlay.root.style.maxHeight = `${maxHeight}px`;
    overlay.size.width = newWidth;
    overlay.size.height = newHeight;
    this.ensureWithinBounds(overlay);
  }

  handleResizePointerUp(event) {
    if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) {
      return;
    }
    this.endResize();
  }

  endDrag() {
    if (!this.dragState) {
      return;
    }
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);
    this.dragState = null;
  }

  endResize() {
    if (!this.resizeState) {
      return;
    }
    window.removeEventListener('pointermove', this.handleResizePointerMove);
    window.removeEventListener('pointerup', this.handleResizePointerUp);
    window.removeEventListener('pointercancel', this.handleResizePointerUp);
    this.resizeState = null;
  }

  handleWindowResize() {
    this.overlays.forEach(overlay => {
      this.syncSize(overlay);
      this.ensureWithinBounds(overlay);
    });
  }

  emitOverlayClose(overlay) {
    if (!overlay?.root?.isConnected) {
      return;
    }
    overlay.root.dispatchEvent(
      new CustomEvent('overlaypanel:close', {
        detail: { id: overlay.id },
        bubbles: true,
      }),
    );
  }

  generateId() {
    return `overlay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function formatCode(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}
