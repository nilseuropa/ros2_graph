import { TOPIC_TOOL_TIMEOUT } from './constants.js';

function buildSearchParams(initial = {}) {
  const params = new URLSearchParams();
  Object.entries(initial).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    params.set(key, String(value));
  });
  return params;
}

export async function requestTopicTool(action, topicName, peerName, options = {}) {
  const params = buildSearchParams({
    action,
    topic: topicName,
    peer: peerName,
    ...(options.params || {}),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOPIC_TOOL_TIMEOUT);
  let response;
  let payload = {};
  try {
    response = await fetch(`/topic_tool?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    try {
      payload = await response.json();
    } catch (err) {
      payload = {};
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!response?.ok) {
    const message = payload?.error || `HTTP ${response?.status ?? 'error'}`;
    throw new Error(message);
  }
  return payload;
}

export function requestTopicEcho(topicName, mode, streamId, peerName) {
  const params = {};
  if (mode) {
    params.mode = mode;
  }
  if (streamId) {
    params.stream = streamId;
  }
  return requestTopicTool('echo', topicName, peerName, { params });
}

export async function requestNodeTool(action, nodeName, options = {}) {
  const method = (options?.method || 'GET').toUpperCase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOPIC_TOOL_TIMEOUT);
  let response;
  let payload = {};
  try {
    if (method === 'GET') {
      const params = buildSearchParams({
        action,
        node: nodeName,
        ...(options.params || {}),
      });
      response = await fetch(`/node_tool?${params.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
    } else if (method === 'POST') {
      const body = { action, node: nodeName, ...(options.body || {}) };
      response = await fetch('/node_tool', {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } else {
      throw new Error(`unsupported method ${method}`);
    }
    try {
      payload = await response.json();
    } catch (err) {
      payload = {};
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!response?.ok) {
    const message = payload?.error || `HTTP ${response?.status ?? 'error'}`;
    throw new Error(message);
  }
  return payload;
}
