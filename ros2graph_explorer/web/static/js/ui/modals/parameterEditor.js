import { toggleHidden } from '../../utils/dom.js';

export class ParameterEditor {
  constructor(root = document.getElementById('parameterEditor')) {
    this.root = root;
    this.form = document.getElementById('parameterEditorForm');
    this.titleEl = document.getElementById('parameterEditorTitle');
    this.subtitleEl = document.getElementById('parameterEditorSubtitle');
    this.bodyEl = document.getElementById('parameterEditorBody');
    this.messageEl = document.getElementById('parameterEditorMessage');
    this.closeBtn = document.getElementById('parameterEditorClose');
    this.cancelBtn = document.getElementById('parameterEditorCancel');
    this.applyBtn = document.getElementById('parameterEditorApply');
    this.backdrop = this.root?.querySelector('.parameter-editor__backdrop');

    this.valueInput = document.createElement('textarea');
    this.valueInput.rows = 6;
    this.valueInput.spellcheck = false;
    this.valueInput.className = 'parameter-editor__input';

    this.state = {
      resolver: null,
      rejecter: null,
      onSubmit: null,
      submitting: false,
    };

    if (this.bodyEl) {
      this.bodyEl.innerHTML = '';
      this.bodyEl.appendChild(this.valueInput);
    }

    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleCancel = this.handleCancel.bind(this);
    this.handleClose = this.handleClose.bind(this);

    this.form?.addEventListener('submit', this.handleSubmit);
    this.cancelBtn?.addEventListener('click', this.handleCancel);
    this.closeBtn?.addEventListener('click', this.handleClose);
    this.backdrop?.addEventListener('click', this.handleClose);
  }

  open({ nodeName, parameter, onSubmit }) {
    if (!this.root) {
      return Promise.resolve({ cancelled: true });
    }
    this.parameter = parameter;
    this.nodeName = nodeName;
    this.state.onSubmit = onSubmit;
    this.setMessage('');
    if (this.titleEl) {
      this.titleEl.textContent = parameter?.name ?? 'Parameter';
    }
    if (this.subtitleEl) {
      const type = parameter?.type ?? '';
      this.subtitleEl.textContent = `${nodeName} • ${type || 'unknown type'}`;
    }
    this.valueInput.value = formatParameterValue(parameter?.value);
    this.setBusy(false);
    toggleHidden(this.root, false);
    this.root.classList.add('active');
    setTimeout(() => this.valueInput.focus(), 0);

    return new Promise((resolve, reject) => {
      this.state.resolver = resolve;
      this.state.rejecter = reject;
    });
  }

  close(result = { cancelled: true }) {
    if (!this.root) {
      return;
    }
    this.root.classList.remove('active');
    toggleHidden(this.root, true);
    this.state.submitting = false;
    const resolve = this.state.resolver;
    this.state.resolver = null;
    this.state.rejecter = null;
    this.state.onSubmit = null;
    if (resolve) {
      resolve(result);
    }
  }

  handleCancel() {
    this.close({ cancelled: true });
  }

  handleClose() {
    if (this.state.submitting) {
      return;
    }
    this.close({ cancelled: true });
  }

  setBusy(isBusy) {
    this.state.submitting = isBusy;
    if (this.applyBtn) {
      this.applyBtn.disabled = isBusy;
    }
    this.valueInput.disabled = isBusy;
  }

  setMessage(text, isError = false) {
    if (!this.messageEl) {
      return;
    }
    this.messageEl.textContent = text || '';
    this.messageEl.classList.toggle('error', Boolean(isError));
  }

  async handleSubmit(event) {
    event.preventDefault();
    if (!this.state.onSubmit || this.state.submitting) {
      return;
    }
    const rawText = this.valueInput.value;
    let parsedValue;
    try {
      parsedValue = rawText.trim().length ? JSON.parse(rawText) : '';
    } catch (error) {
      parsedValue = rawText;
    }
    this.setBusy(true);
    this.setMessage('Applying update…');
    try {
      await this.state.onSubmit({
        raw: rawText,
        value: parsedValue,
      });
      this.setMessage('Parameter updated');
      this.close({ updated: true });
    } catch (error) {
      const message = error?.message || String(error);
      this.setMessage(message, true);
      this.setBusy(false);
    }
  }
}

function formatParameterValue(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}
