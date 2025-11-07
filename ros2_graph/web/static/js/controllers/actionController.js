import { getNodeSummary, getTopicSummary } from '../data/graphSelectors.js';
import { formatHz, formatBytesPerSecond, formatBytes } from '../utils/format.js';

const FEATURE_FIELDS = ['name', 'class', 'version', 'gui_version', 'state'];
const FEATURE_LABELS = {
  name: 'Name',
  class: 'Class',
  version: 'Version',
  gui_version: 'GUI Version',
  state: 'State',
};

const buildOverlayId = (type, ...parts) => [type, ...parts.filter(Boolean)].join(':');
const nodeInfoOverlayId = nodeName => buildOverlayId('node-info', nodeName);
const nodeParametersOverlayId = nodeName => buildOverlayId('node-parameters', nodeName);
const nodeServicesOverlayId = nodeName => buildOverlayId('node-services', nodeName);
const topicInfoOverlayId = topicName => buildOverlayId('topic-info', topicName);
const topicStatsOverlayId = (topicName, peerName) => buildOverlayId('topic-stats', topicName, peerName);

export class ActionController {
  constructor({
    store,
    overlay,
    statusBar,
    nodeApi,
    topicApi,
    parameterEditor,
    serviceCaller,
    topicEcho,
    topicPlot,
  }) {
    this.store = store;
    this.overlay = overlay;
    this.statusBar = statusBar;
    this.nodeApi = nodeApi;
    this.topicApi = topicApi;
    this.parameterEditor = parameterEditor;
    this.serviceCaller = serviceCaller;
    this.topicEcho = topicEcho;
    this.topicPlot = topicPlot;
    this.nodeFeatureCache = new Map();
    if (this.overlay?.setActionHandler) {
      this.overlay.setActionHandler(action => this.handleOverlayAction(action));
    }
  }

  async handleAction(action, target) {
    if (!action || !target) {
      return;
    }
    try {
      switch (action) {
        case 'node-info':
          await this.showNodeInfo(target.nodeName ?? target.name);
          break;
        case 'node-parameters':
          await this.showNodeParameters(target.nodeName ?? target.name);
          break;
        case 'node-services':
          await this.showNodeServices(target.nodeName ?? target.name);
          break;
        case 'topic-info':
          await this.showTopicInfo(resolveTopicName(target));
          break;
        case 'topic-stats':
          await this.showTopicStats(resolveTopicName(target), target.peerName);
          break;
        case 'topic-plot':
          await this.topicPlot?.toggle(resolveTopicName(target));
          break;
        case 'topic-echo':
          await this.toggleTopicEcho(resolveTopicName(target), target.peerName);
          break;
        default:
          this.statusBar?.setStatus(`Unknown action: ${action}`);
      }
    } catch (error) {
      const message = error?.message || String(error);
      this.statusBar?.setStatus(message);
    }
  }

  async showNodeInfo(nodeName) {
    const graph = this.store.getGraph();
    const summary = getNodeSummary(graph, nodeName);
    const overlayId = nodeInfoOverlayId(nodeName);
    if (!summary) {
      this.overlay?.hide({ id: overlayId });
      this.statusBar?.setStatus(`No data for ${nodeName}`);
      return;
    }
    const cachedFeatures = this.nodeFeatureCache.get(nodeName) || [];
    this.renderNodeInfo(nodeName, summary, cachedFeatures);
    if (!this.nodeFeatureCache.has(nodeName)) {
      void this.fetchNodeFeatures(nodeName, summary);
    }
  }

  async showNodeParameters(nodeName) {
    this.statusBar?.setStatus(`Fetching parameters for ${nodeName}…`);
    const payload = await this.nodeApi.get('parameters', nodeName);
    this.presentParameters(nodeName, payload);
  }

  presentParameters(nodeName, payload) {
    const parameters = Array.isArray(payload?.parameters) ? payload.parameters : [];
    const overlayId = nodeParametersOverlayId(nodeName);
    const rows = parameters.map(entry => ({
      cells: [entry.name ?? '(unknown)', summarizeValue(entry.value)],
      action: { type: 'edit-parameter', nodeName, parameter: entry },
    }));
    this.overlay?.show(
      {
        title: `Parameters (${rows.length})`,
        subtitle: nodeName,
        sections: [
          {
            type: 'table',
            headers: ['Name', 'Value'],
            rows,
          },
        ],
      },
      { id: overlayId },
    );
    this.statusBar?.setStatus(`Parameters for ${nodeName}: ${rows.length} found`);
  }

  async showNodeServices(nodeName) {
    this.statusBar?.setStatus(`Fetching services for ${nodeName}…`);
    const payload = await this.nodeApi.get('services', nodeName);
    const services = Array.isArray(payload?.services) ? payload.services : [];
    const overlayId = nodeServicesOverlayId(nodeName);
    const rows = services.map(entry => ({
      cells: [entry.name ?? '(unknown)', formatTypes(entry.types)],
      action: { type: 'call-service', nodeName, service: entry },
    }));
    this.overlay?.show(
      {
        title: `Services (${rows.length})`,
        subtitle: nodeName,
        sections: [
          {
            type: 'table',
            headers: ['Service', 'Type'],
            rows,
          },
        ],
      },
      { id: overlayId },
    );
    this.statusBar?.setStatus(`Services for ${nodeName}: ${rows.length} found`);
  }

  async showTopicInfo(topicName) {
    const graph = this.store.getGraph();
    const summary = getTopicSummary(graph, topicName);
    const overlayId = topicInfoOverlayId(topicName);
    if (!summary) {
      this.overlay?.hide({ id: overlayId });
      this.statusBar?.setStatus(`No data for ${topicName}`);
      return;
    }
    const typeLines = summary.types.length ? summary.types : ['(unknown)'];
    const publishers = summary.publishers.map(entry => ({
      cells: [entry.name, entry.qos],
    }));
    const subscribers = summary.subscribers.map(entry => ({
      cells: [entry.name, entry.qos],
    }));
    const sections = [
      {
        type: 'text',
        title: 'Types',
        text: typeLines,
      },
    ];
    if (publishers.length) {
      sections.push({
        type: 'table',
        title: `Publishers (${publishers.length})`,
        headers: ['Node', 'QoS'],
        rows: publishers,
      });
    }
    if (subscribers.length) {
      sections.push({
        type: 'table',
        title: `Subscribers (${subscribers.length})`,
        headers: ['Node', 'QoS'],
        rows: subscribers,
      });
    }
    this.overlay?.show(
      {
        title: topicName,
        subtitle: 'Topic overview',
        sections,
      },
      { id: overlayId },
    );
    this.statusBar?.setStatus(`Info shown for ${topicName}`);
  }

  async showTopicStats(topicName, peerName) {
    this.statusBar?.setStatus(`Collecting statistics for ${topicName}…`);
    const params = peerName ? { peer: peerName } : undefined;
    const payload = await this.topicApi.request('stats', topicName, { params });
    const sections = [];
    const overlayId = topicStatsOverlayId(topicName, peerName);
    sections.push({
      type: 'table',
      title: 'Frequency',
      headers: ['Average', 'Min', 'Max'],
      rows: [
        {
          cells: [formatHz(payload.average_hz), formatHz(payload.min_hz), formatHz(payload.max_hz)],
        },
      ],
    });
    sections.push({
      type: 'table',
      title: 'Message Size',
      headers: ['Average', 'Min', 'Max'],
      rows: [
        {
          cells: [
            formatBytes(payload.average_bytes_per_msg),
            formatBytes(payload.min_bytes),
            formatBytes(payload.max_bytes),
          ],
        },
      ],
    });
    sections.push({
      type: 'table',
      title: 'Bandwidth',
      headers: ['Average', 'Min', 'Max'],
      rows: [
        {
          cells: [
            formatBytesPerSecond(computeBandwidth(payload.average_hz, payload.average_bytes_per_msg)),
            formatBytesPerSecond(computeBandwidth(payload.min_hz, payload.min_bytes)),
            formatBytesPerSecond(computeBandwidth(payload.max_hz, payload.max_bytes)),
          ],
        },
      ],
    });
    this.overlay?.show(
      {
        title: topicName,
        subtitle: peerName ? `Peer: ${peerName}` : 'Topic statistics',
        sections,
      },
      { id: overlayId },
    );
    this.statusBar?.setStatus(`Statistics ready for ${topicName}`);
  }

  async toggleTopicEcho(topicName, peerName) {
    if (!this.topicEcho || !topicName) {
      this.statusBar?.setStatus('Echo not available');
      return;
    }
    if (this.topicEcho.isActive(topicName, peerName)) {
      await this.topicEcho.stop({ quiet: true });
      this.statusBar?.setStatus('Echo stopped');
      return;
    }
    await this.topicEcho.start(topicName, peerName);
  }

  renderNodeInfo(nodeName, summary, featureSections = []) {
    if (!summary) {
      return;
    }
    const overlayId = nodeInfoOverlayId(nodeName);
    const sections = featureSections.length
      ? featureSections
      : [
          {
            type: 'text',
            title: 'Feature Descriptor',
            text: ['No feature descriptor available.'],
          },
        ];
    this.overlay?.show(
      {
        title: nodeName,
        subtitle: `Namespace: ${summary.namespace}`,
        sections,
      },
      { id: overlayId },
    );
    this.statusBar?.setStatus(`Details shown for ${nodeName}`);
  }

  async fetchNodeFeatures(nodeName, summary) {
    try {
      const payload = await this.nodeApi.get('parameters', nodeName);
      const sections = buildFeatureSectionsFromParameters(payload?.parameters);
      this.nodeFeatureCache.set(nodeName, sections);
      const overlayId = nodeInfoOverlayId(nodeName);
      if (this.overlay?.isOpen?.(overlayId)) {
        const latestSummary = summary ?? getNodeSummary(this.store.getGraph(), nodeName);
        if (latestSummary) {
          this.renderNodeInfo(nodeName, latestSummary, sections);
        }
      }
    } catch (error) {
      // Ignore feature enrichment failures; base info is already shown.
    }
  }

  async handleOverlayAction(action) {
    if (!action) {
      return;
    }
    switch (action.type) {
      case 'edit-parameter':
        await this.editParameter(action.nodeName, action.parameter);
        break;
      case 'call-service':
        await this.invokeService(action.nodeName, action.service);
        break;
      default:
        break;
    }
  }

  async editParameter(nodeName, parameter) {
    if (!this.parameterEditor) {
      return;
    }
    await this.parameterEditor.open({
      nodeName,
      parameter,
      onSubmit: async ({ value }) => {
        await this.nodeApi.post('set_parameter', nodeName, {
          name: parameter.name,
          type_id: parameter.type_id,
          value,
        });
        const updated = await this.nodeApi.get('parameters', nodeName);
        this.presentParameters(nodeName, updated);
        this.statusBar?.setStatus(`Updated ${parameter.name} on ${nodeName}`);
      },
    });
  }

  async invokeService(nodeName, service) {
    if (!this.serviceCaller) {
      return;
    }
    let description = null;
    try {
      description = await this.nodeApi.post('describe_service', nodeName, {
        service: service.name,
        type: Array.isArray(service.types) ? service.types[0] : undefined,
      });
    } catch (error) {
      // description optional
    }
    const example = description?.service?.request?.example ?? {};
    await this.serviceCaller.open({
      nodeName,
      serviceName: service.name,
      serviceType: Array.isArray(service.types) ? service.types[0] : description?.service?.type,
      example,
      onSubmit: async ({ request }) => {
        const response = await this.nodeApi.post('call_service', nodeName, {
          service: service.name,
          request,
        });
        this.statusBar?.setStatus(`Service ${service.name} invoked on ${nodeName}`);
        return response?.response ?? response;
      },
    });
  }
}

function resolveTopicName(target) {
  return target?.topicName ?? target?.name;
}

function buildFeatureSectionsFromParameters(parameters) {
  const entries = Array.isArray(parameters) ? parameters : [];
  const featureMap = new Map();
  entries.forEach(entry => {
    const paramName = entry?.name;
    if (typeof paramName !== 'string') {
      return;
    }
    const match = paramName.match(/^feature(?:\.([^.]+))?\.(name|class|version|gui_version|state)$/i);
    if (!match) {
      return;
    }
    const featureKey = match[1] ? match[1] : '';
    const field = match[2].toLowerCase();
    if (!FEATURE_FIELDS.includes(field)) {
      return;
    }
    if (!featureMap.has(featureKey)) {
      featureMap.set(featureKey, new Map());
    }
    const table = featureMap.get(featureKey);
    const rawValue = entry?.value ?? entry?.raw_value;
    let text;
    if (typeof rawValue === 'string') {
      text = rawValue;
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      text = String(rawValue);
    } else {
      try {
        text = JSON.stringify(rawValue);
      } catch (error) {
        text = String(rawValue);
      }
    }
    table.set(field, text);
  });

  if (!featureMap.size) {
    return [];
  }

  const sections = [];
  Array.from(featureMap.keys())
    .sort((a, b) => a.localeCompare(b))
    .forEach(featureKey => {
      const table = featureMap.get(featureKey);
      const rows = [];
      FEATURE_FIELDS.forEach(field => {
        if (!table.has(field)) {
          return;
        }
        rows.push({ cells: [FEATURE_LABELS[field] || field, table.get(field)] });
      });
      if (rows.length) {
        sections.push({
          type: 'table',
          title: featureKey ? `Feature: ${featureKey}` : 'Feature',
          headers: ['Field', 'Value'],
          rows,
        });
      }
    });

  return sections;
}

function summarizeValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 48 ? `${json.slice(0, 45)}…` : json;
  } catch (error) {
    return String(value);
  }
}

function formatTypes(types) {
  if (!Array.isArray(types) || !types.length) {
    return 'unknown';
  }
  return types.join(', ');
}

function computeBandwidth(hz, bytes) {
  if (!Number.isFinite(hz) || !Number.isFinite(bytes)) {
    return NaN;
  }
  return hz * bytes;
}
