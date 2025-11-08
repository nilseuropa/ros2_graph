import { toggleHidden } from '../../utils/dom.js';

export class ServiceCaller {
  constructor(root = document.getElementById('serviceCaller')) {
    this.root = root;
    this.form = document.getElementById('serviceCallerForm');
    this.titleEl = document.getElementById('serviceCallerTitle');
    this.subtitleEl = document.getElementById('serviceCallerSubtitle');
    this.bodyEl = document.getElementById('serviceCallerBody');
    this.messageEl = document.getElementById('serviceCallerMessage');
    this.requestSection = document.getElementById('serviceCallerExample');
    this.requestText = document.getElementById('serviceCallerExampleText');
    this.responseSection = document.getElementById('serviceCallerResponse');
    this.responseText = document.getElementById('serviceCallerResponseText');
    this.closeBtn = document.getElementById('serviceCallerClose');
    this.cancelBtn = document.getElementById('serviceCallerCancel');
    this.invokeBtn = document.getElementById('serviceCallerInvoke');
    this.backdrop = this.root?.querySelector('.parameter-editor__backdrop');

    this.requestInput = document.createElement('textarea');
    this.requestInput.rows = 10;
    this.requestInput.className = 'service-caller__input';
    this.requestInput.spellcheck = false;

    if (this.bodyEl) {
      this.bodyEl.innerHTML = '';
      this.bodyEl.appendChild(this.requestInput);
    }

    this.state = {
      resolver: null,
      onSubmit: null,
      submitting: false,
    };

    this.handleSubmit = this.handleSubmit.bind(this);
    this.handleCancel = this.handleCancel.bind(this);

    this.form?.addEventListener('submit', this.handleSubmit);
    this.cancelBtn?.addEventListener('click', this.handleCancel);
    this.closeBtn?.addEventListener('click', this.handleCancel);
    this.backdrop?.addEventListener('click', this.handleCancel);
  }

  open({ nodeName, serviceName, serviceType, example, onSubmit }) {
    if (!this.root) {
      return Promise.resolve({ cancelled: true });
    }
    this.state.onSubmit = onSubmit;
    this.serviceName = serviceName;
    this.nodeName = nodeName;
    this.serviceType = serviceType;
    if (this.titleEl) {
      this.titleEl.textContent = serviceName || 'Service';
    }
    if (this.subtitleEl) {
      this.subtitleEl.textContent = `${nodeName} • ${serviceType ?? 'unknown type'}`;
    }
    const exampleText = example ? formatJson(example) : '{}';
    this.requestInput.value = exampleText;
    this.setMessage('');
    this.setResponse(null);
    this.setBusy(false);
    toggleHidden(this.root, false);
    this.root.classList.add('active');
    setTimeout(() => this.requestInput.focus(), 0);
    return new Promise(resolve => {
      this.state.resolver = resolve;
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
    this.state.onSubmit = null;
    if (resolve) {
      resolve(result);
    }
  }

  setBusy(isBusy) {
    this.state.submitting = isBusy;
    if (this.invokeBtn) {
      this.invokeBtn.disabled = isBusy;
    }
    this.requestInput.disabled = isBusy;
  }

  setMessage(text, isError = false) {
    if (!this.messageEl) {
      return;
    }
    this.messageEl.textContent = text || '';
    this.messageEl.classList.toggle('error', Boolean(isError));
  }

  setResponse(response) {
    if (!this.responseSection || !this.responseText) {
      return;
    }
    if (!response) {
      this.responseSection.classList.add('hidden');
      this.responseText.textContent = '';
      return;
    }
    this.responseSection.classList.remove('hidden');
    this.responseText.textContent = formatJson(response);
  }

  handleCancel() {
    if (this.state.submitting) {
      return;
    }
    this.close({ cancelled: true });
  }

  async handleSubmit(event) {
    event.preventDefault();
    if (!this.state.onSubmit || this.state.submitting) {
      return;
    }
    const rawText = this.requestInput.value || '{}';
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      this.setMessage('Request must be valid JSON', true);
      return;
    }
    this.setBusy(true);
    this.setMessage('Calling service…');
    try {
      const response = await this.state.onSubmit({
        nodeName: this.nodeName,
        serviceName: this.serviceName,
        request: payload,
      });
      this.setResponse(response);
      this.setMessage('Call succeeded');
      this.setBusy(false);
    } catch (error) {
      const message = error?.message || String(error);
      this.setMessage(message, true);
      this.setBusy(false);
    }
  }
}

function formatJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return typeof value === 'string' ? value : String(value);
  }
}
