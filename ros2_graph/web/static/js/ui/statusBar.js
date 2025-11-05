import { setText } from '../utils/dom.js';

export class StatusBar {
  constructor({ metaEl, statusEl, refreshBtn, onRefresh }) {
    this.metaEl = metaEl;
    this.statusEl = statusEl;
    this.refreshBtn = refreshBtn;
    this.onRefresh = onRefresh;
    if (this.refreshBtn && this.onRefresh) {
      this.refreshBtn.addEventListener('click', () => {
        this.setBusy(true);
        Promise.resolve()
          .then(() => this.onRefresh())
          .finally(() => this.setBusy(false));
      });
    }
  }

  setMeta(text) {
    setText(this.metaEl, text || '');
  }

  setStatus(text) {
    setText(this.statusEl, text || '');
  }

  setBusy(isBusy) {
    if (!this.refreshBtn) {
      return;
    }
    this.refreshBtn.disabled = isBusy;
  }
}
