import { toggleHidden } from '../utils/dom.js';

export class OverlayPanel {
  constructor(container) {
    this.container = container || document.body;
    this.root = document.createElement('div');
    this.root.className = 'overlay-panel hidden';
    this.root.setAttribute('role', 'region');
    this.container.appendChild(this.root);
    this.onAction = null;
  }

  setActionHandler(handler) {
    this.onAction = handler;
  }

  show(content) {
    this.render(content);
    this.root.style.width = 'auto';
    toggleHidden(this.root, false);
    this.root.classList.add('visible');
    this.syncSize();
    window.requestAnimationFrame(() => this.syncSize());
  }

  hide() {
    toggleHidden(this.root, true);
    this.root.classList.remove('visible');
    this.root.innerHTML = '';
    this.root.style.width = '';
  }

  render(content) {
    this.root.innerHTML = '';
    if (!content) {
      return;
    }
    const title = document.createElement('div');
    title.className = 'overlay-panel__title';
    title.textContent = content.title || '';
    this.root.appendChild(title);

    if (content.subtitle) {
      const subtitle = document.createElement('div');
      subtitle.className = 'overlay-panel__subtitle';
      subtitle.textContent = content.subtitle;
      this.root.appendChild(subtitle);
    }

    if (content.description) {
      const description = Array.isArray(content.description)
        ? content.description
        : [content.description];
      description.forEach(line => {
        const p = document.createElement('p');
        p.className = 'overlay-panel__description';
        p.textContent = line;
        this.root.appendChild(p);
      });
    }

    const sections = Array.isArray(content.sections) ? content.sections : [];
    sections.forEach(section => {
      if (section.type === 'table') {
        this.renderTable(section);
      } else if (section.type === 'text') {
        this.renderTextSection(section);
      } else if (section.type === 'code') {
        this.renderCodeSection(section);
      }
    });
  }

  renderTextSection(section) {
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
    this.root.appendChild(wrapper);
  }

  renderTable(section) {
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
        tr.dataset.action = JSON.stringify(rowData.action);
        tr.classList.add('overlay-panel__row--actionable');
        tr.addEventListener('click', () => {
          this.onAction?.(rowData.action);
        });
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    this.root.appendChild(wrapper);
  }

  renderCodeSection(section) {
    const wrapper = document.createElement('div');
    wrapper.className = 'overlay-panel__section';
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
    this.root.appendChild(wrapper);
  }

  syncSize() {
    if (!this.root) {
      return;
    }
    const maxWidth = Math.max(320, Math.min(window.innerWidth - 32, 720));
    this.root.style.maxWidth = `${maxWidth}px`;
    this.root.style.width = 'auto';
    const measured = this.root.scrollWidth + 24;
    const width = Math.min(Math.ceil(measured), maxWidth);
    this.root.style.width = `${width}px`;
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
