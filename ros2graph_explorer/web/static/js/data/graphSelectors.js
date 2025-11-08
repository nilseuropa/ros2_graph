const HIDDEN_PATTERNS = [/\/rosout\b/i];

function isHidden(name) {
  if (!name) {
    return false;
  }
  return HIDDEN_PATTERNS.some(pattern => pattern.test(name));
}

export function getNodeSummary(graph, nodeName) {
  if (!graph || !nodeName) {
    return null;
  }
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const topics = graph.topics || {};
  const publishes = new Map();
  const subscribes = new Map();

  edges.forEach(edge => {
    if (!edge || typeof edge !== 'object') {
      return;
    }
    if (edge.start === nodeName && topics[edge.end] && !isHidden(edge.end)) {
      addQoS(publishes, edge.end, edge.qos);
    } else if (edge.end === nodeName && topics[edge.start] && !isHidden(edge.start)) {
      addQoS(subscribes, edge.start, edge.qos);
    }
  });

  return {
    nodeName,
    namespace: deriveNamespace(nodeName),
    publishes: mapToRows(publishes),
    subscribes: mapToRows(subscribes),
  };
}

export function getTopicSummary(graph, topicName) {
  if (!graph || !topicName) {
    return null;
  }
  if (isHidden(topicName)) {
    return null;
  }
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const nodes = new Set(graph.nodes || []);
  const types = graph.topics?.[topicName] || [];
  const publishers = new Map();
  const subscribers = new Map();

  edges.forEach(edge => {
    if (edge.end === topicName && nodes.has(edge.start)) {
      addQoS(publishers, edge.start, edge.qos);
    } else if (edge.start === topicName && nodes.has(edge.end)) {
      addQoS(subscribers, edge.end, edge.qos);
    }
  });

  return {
    topicName,
    types: Array.isArray(types) ? types : [],
    publishers: mapToRows(publishers),
    subscribers: mapToRows(subscribers),
  };
}

function deriveNamespace(nodeName) {
  const lastSlash = nodeName.lastIndexOf('/');
  if (lastSlash <= 0) {
    return '/';
  }
  return nodeName.slice(0, lastSlash);
}

function addQoS(map, name, qos) {
  if (!map.has(name)) {
    map.set(name, new Set());
  }
  if (qos) {
    const value = Array.isArray(qos) ? qos.join(' | ') : String(qos);
    if (value) {
      map.get(name).add(value);
    }
  }
}

function mapToRows(map) {
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, qosSet]) => ({
      name,
      qos: qosSet.size ? Array.from(qosSet).join(' | ') : 'n/a',
    }));
}
