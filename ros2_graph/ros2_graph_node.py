from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Set, Tuple

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from rclpy.executors import SingleThreadedExecutor
from rclpy.serialization import serialize_message
from .web import GraphWebServer

try:
    from rcl_interfaces.msg import Parameter, ParameterDescriptor, ParameterType, ParameterValue  # type: ignore
    from rcl_interfaces.srv import DescribeParameters, GetParameters, ListParameters, SetParameters  # type: ignore
except ImportError:  # pragma: no cover - allows docs/tests without ROS deps
    Parameter = None  # type: ignore[assignment]
    ParameterDescriptor = None  # type: ignore[assignment]
    ParameterType = None  # type: ignore[assignment]
    ParameterValue = None  # type: ignore[assignment]
    DescribeParameters = None  # type: ignore[assignment]
    GetParameters = None  # type: ignore[assignment]
    ListParameters = None  # type: ignore[assignment]
    SetParameters = None  # type: ignore[assignment]

try:
    from rosidl_runtime_py.convert import message_to_ordereddict  # type: ignore
except ImportError:  # pragma: no cover - optional dependency for echo support
    message_to_ordereddict = None  # type: ignore[assignment]

try:
    from rosidl_parser.definition import (  # type: ignore[attr-defined]
        AbstractSequence,
        Array,
        BasicType,
        NamespacedType,
    )
except ImportError:  # pragma: no cover - optional dependency for service description
    AbstractSequence = None  # type: ignore[assignment]
    Array = None  # type: ignore[assignment]
    BasicType = None  # type: ignore[assignment]
    NamespacedType = None  # type: ignore[assignment]

PARAMETER_NOT_SET = getattr(ParameterType, 'PARAMETER_NOT_SET', 0)
PARAMETER_BOOL = getattr(ParameterType, 'PARAMETER_BOOL', 1)
PARAMETER_INTEGER = getattr(ParameterType, 'PARAMETER_INTEGER', 2)
PARAMETER_DOUBLE = getattr(ParameterType, 'PARAMETER_DOUBLE', 3)
PARAMETER_STRING = getattr(ParameterType, 'PARAMETER_STRING', 4)
PARAMETER_BYTE_ARRAY = getattr(ParameterType, 'PARAMETER_BYTE_ARRAY', 5)
PARAMETER_BOOL_ARRAY = getattr(ParameterType, 'PARAMETER_BOOL_ARRAY', 6)
PARAMETER_INTEGER_ARRAY = getattr(ParameterType, 'PARAMETER_INTEGER_ARRAY', 7)
PARAMETER_DOUBLE_ARRAY = getattr(ParameterType, 'PARAMETER_DOUBLE_ARRAY', 8)
PARAMETER_STRING_ARRAY = getattr(ParameterType, 'PARAMETER_STRING_ARRAY', 9)

PARAMETER_DISPLAY_MAX = 32
PARAMETER_SERVICE_TIMEOUT = 5.0


CLUSTER_NAMESPACE_LEVEL = 0
GROUP_TF_NODES = True
GROUP_IMAGE_NODES = True
ACCUMULATE_ACTIONS = True
HIDE_DYNAMIC_RECONFIGURE = True
HIDE_SINGLE_CONNECTION_TOPICS = False
HIDE_DEAD_END_TOPICS = False
HIDE_TF_NODES = False
INTERNAL_NODE_NAMES = {
    '/ros2_graph_metrics_probe',
    'ros2_graph_metrics_probe',
    '/ros2_graph',
    'ros2_graph',
    '/ros2cli_daemon',
    'ros2cli_daemon',
}
INTERNAL_NODE_PREFIXES = (
    '/tf_listener',
    '/tf2_buffer',
    '/tf_static_listener',
    '/transform_listener',
    '/_ros2cli_daemon',
    '_ros2cli_daemon',
    'ros2cli_daemon_',
)


@dataclass(frozen=True)
class Edge:
    """Simple directed edge connecting ROS nodes and topics."""

    start: str
    end: str
    qos_label: str = ''


class GraphSnapshot:
    """Immutable snapshot of the ROS graph."""

    def __init__(
        self,
        nodes: Set[str],
        topics: Dict[str, Tuple[str, ...]],
        edges: Iterable[Edge],
    ) -> None:
        self.nodes = frozenset(nodes)
        self.topics = {name: tuple(types) for name, types in topics.items()}
        self.edges = tuple(sorted(set(edges), key=lambda e: (e.start, e.end, e.qos_label)))

    def fingerprint(self) -> str:
        """Stable fingerprint for change detection."""
        payload = {
            'nodes': sorted(self.nodes),
            'topics': {name: list(types) for name, types in sorted(self.topics.items())},
            'edges': [(e.start, e.end, e.qos_label) for e in self.edges],
        }
        serialized = json.dumps(payload, sort_keys=True, separators=(',', ':'))
        return hashlib.sha1(serialized.encode('utf-8')).hexdigest()

    def to_dict(self) -> Dict[str, object]:
        """Return a JSON-serializable dictionary."""
        return {
            'nodes': sorted(self.nodes),
            'topics': {name: list(types) for name, types in sorted(self.topics.items())},
            'edges': [
                {'start': e.start, 'end': e.end, 'qos': e.qos_label}
                for e in self.edges
            ],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True)

    @staticmethod
    def _make_safe_identifier(name: str, prefix: str, used: Set[str]) -> str:
        stripped = name.strip()
        if not stripped:
            stripped = 'root'
        safe_chars = []
        for char in stripped:
            if char.isalnum():
                safe_chars.append(char)
            else:
                safe_chars.append('_')
        base = ''.join(safe_chars) or 'item'
        candidate = f'{prefix}{base}'
        counter = 1
        while candidate in used:
            candidate = f'{prefix}{base}_{counter}'
            counter += 1
        used.add(candidate)
        return candidate

    def _compute_graphviz_artifacts(self) -> Tuple[str, Dict[str, str]]:
        if hasattr(self, '_graphviz_cache'):
            cached = getattr(self, '_graphviz_cache')
            if cached is not None:
                return cached
        try:
            from rqt_graph.dotcode import RosGraphDotcodeGenerator, NODE_TOPIC_GRAPH, _conv
            from qt_dotgraph.pydotfactory import PydotFactory
            from rqt_graph import rosgraph2_impl
        except Exception:
            cache_value = self._compute_simple_graphviz_artifacts()
            setattr(self, '_graphviz_cache', cache_value)
            return cache_value

        class _GraphAdapter:
            def __init__(self) -> None:
                self.nn_nodes: Set[str] = set()
                self.nt_nodes: Set[str] = set()
                self.nt_edges = rosgraph2_impl.EdgeList()
                self.nt_all_edges = rosgraph2_impl.EdgeList()
                self.nn_edges = rosgraph2_impl.EdgeList()
                self.topic_with_qos_incompatibility = defaultdict(lambda: defaultdict(list))
                self.topic_with_type_incompatibility = defaultdict(lambda: defaultdict(list))
                self.bad_nodes: Dict[str, object] = {}

        graph_adapter = _GraphAdapter()
        graph_adapter.nn_nodes = set(self.nodes)

        publishers: Dict[str, Set[str]] = defaultdict(set)
        subscribers: Dict[str, Set[str]] = defaultdict(set)

        for edge in self.edges:
            if edge.start in self.nodes and edge.end in self.topics:
                publishers[edge.end].add(edge.start)
            elif edge.start in self.topics and edge.end in self.nodes:
                subscribers[edge.start].add(edge.end)

        for topic in self.topics.keys():
            topic_node = rosgraph2_impl.topic_node(topic)
            graph_adapter.nt_nodes.add(topic_node)

        for topic, pubs in publishers.items():
            topic_node = rosgraph2_impl.topic_node(topic)
            for pub in pubs:
                graph_adapter.nt_edges.add_edges(pub, topic_node, 'o', label=topic, qos=None)
                graph_adapter.nt_all_edges.add_edges(pub, topic_node, 'o', label=topic, qos=None)

        for topic, subs in subscribers.items():
            topic_node = rosgraph2_impl.topic_node(topic)
            for sub in subs:
                graph_adapter.nt_edges.add_edges(sub, topic_node, 'i', label=topic, qos=None)
                graph_adapter.nt_all_edges.add_edges(sub, topic_node, 'i', label=topic, qos=None)

        nn_edges = rosgraph2_impl.EdgeList()
        for topic, pubs in publishers.items():
            subs = subscribers.get(topic, set())
            for pub in pubs:
                for sub in subs:
                    nn_edges.add_edges(pub, sub, 'o', label=topic, qos=None)
        graph_adapter.nn_edges = nn_edges

        factory = PydotFactory()
        generator = RosGraphDotcodeGenerator('ros2_graph_web')
        dot_source = generator.generate_dotcode(
            rosgraphinst=graph_adapter,
            ns_filter='',
            topic_filter='',
            graph_mode=NODE_TOPIC_GRAPH,
            dotcode_factory=factory,
            hide_single_connection_topics=HIDE_SINGLE_CONNECTION_TOPICS,
            hide_dead_end_topics=HIDE_DEAD_END_TOPICS,
            cluster_namespaces_level=CLUSTER_NAMESPACE_LEVEL,
            accumulate_actions=ACCUMULATE_ACTIONS,
            orientation='LR',
            rank='same',
            ranksep=0.2,
            rankdir='TB',
            simplify=False,
            quiet=False,
            unreachable=False,
            hide_tf_nodes=HIDE_TF_NODES,
            group_tf_nodes=GROUP_TF_NODES,
            group_image_nodes=GROUP_IMAGE_NODES,
            hide_dynamic_reconfigure=HIDE_DYNAMIC_RECONFIGURE,
        )

        id_map: Dict[str, str] = {}
        for node in sorted(self.nodes):
            id_map[node] = factory.escape_name(_conv(node))
        for topic in sorted(self.topics.keys()):
            topic_node = rosgraph2_impl.topic_node(topic)
            id_map[topic] = factory.escape_name(_conv(topic_node))

        cache_value = (dot_source, id_map)
        setattr(self, '_graphviz_cache', cache_value)
        return cache_value

    def _compute_simple_graphviz_artifacts(self) -> Tuple[str, Dict[str, str]]:
        used_ids: Set[str] = set()
        id_map: Dict[str, str] = {}
        for node in sorted(self.nodes):
            id_map[node] = self._make_safe_identifier(node, 'n_', used_ids)
        for topic in sorted(self.topics.keys()):
            id_map[topic] = self._make_safe_identifier(topic, 't_', used_ids)

        def escape_label(value: str) -> str:
            return value.replace('"', '\\"')

        def topic_label(name: str) -> str:
            types = self.topics.get(name, ())
            if not types:
                return name
            type_lines = '\\n'.join(types)
            return f'{name}\\n{type_lines}'

        lines: List[str] = [
            'digraph ros2_graph {',
            '  graph [rankdir=LR];',
            '  node [fontsize=12];',
            '  edge [fontsize=10];',
        ]

        for node in sorted(self.nodes):
            lines.append(f'  {id_map[node]} [shape=ellipse,label="{escape_label(node)}"];')
        for topic in sorted(self.topics.keys()):
            lines.append(
                f'  {id_map[topic]} [shape=box,style=rounded,label="{escape_label(topic_label(topic))}"];'
            )

        for edge in self.edges:
            start_id = id_map.get(edge.start)
            end_id = id_map.get(edge.end)
            if not start_id or not end_id:
                continue
            attributes: List[str] = ['weight=2']
            if edge.qos_label:
                attributes.append(f'label="{escape_label(edge.qos_label)}"')
            attr_str = f" [{', '.join(attributes)}]" if attributes else ''
            lines.append(f'  {start_id} -> {end_id}{attr_str};')

        lines.append('}')
        dot_source = '\n'.join(lines)
        return dot_source, id_map

    def graphviz_id_map(self) -> Dict[str, str]:
        _, id_map = self._compute_graphviz_artifacts()
        return dict(id_map)

    def to_dot(self) -> str:
        """Return GraphViz DOT source with additional layout hints."""
        dot_source, _ = self._compute_graphviz_artifacts()
        return dot_source

    def to_adjacency(self) -> str:
        """Return a simple adjacency-list text format."""
        adjacency: Dict[str, List[Tuple[str, str]]] = {}
        for edge in self.edges:
            adjacency.setdefault(edge.start, []).append((edge.end, edge.qos_label))

        lines: List[str] = []
        for start in sorted(adjacency.keys()):
            targets = adjacency[start]
            formatted_targets = []
            for end, qos in sorted(targets, key=lambda t: t[0]):
                if qos:
                    formatted_targets.append(f'{end} [{qos}]')
                else:
                    formatted_targets.append(end)
            lines.append(f'{start} -> {", ".join(formatted_targets)}')

        if not lines:
            return '# graph is empty'
        return '\n'.join(lines)


class GraphBuilder:
    """Build graph snapshots using the node graph API."""

    def __init__(self, node: Node) -> None:
        self._node = node

    def build(self) -> GraphSnapshot:
        node_names: Set[str] = set()
        topics: Dict[str, Tuple[str, ...]] = {}
        edges: List[Edge] = []

        for topic_name, types in self._node.get_topic_names_and_types():
            topics[topic_name] = tuple(types)
            publisher_infos = self._node.get_publishers_info_by_topic(topic_name)
            subscription_infos = self._node.get_subscriptions_info_by_topic(topic_name)

            for info in publisher_infos:
                fq_name = _fully_qualified_node_name(info.node_namespace, info.node_name)
                node_names.add(fq_name)
                edges.append(Edge(fq_name, topic_name, _format_qos(info.qos_profile)))

            for info in subscription_infos:
                fq_name = _fully_qualified_node_name(info.node_namespace, info.node_name)
                node_names.add(fq_name)
                edges.append(Edge(topic_name, fq_name, _format_qos(info.qos_profile)))

        excluded_nodes = {
            name
            for name in {
                self._node.get_fully_qualified_name(),
                f'/{self._node.get_name()}',
            }
            if name
        }
        excluded_nodes.update(INTERNAL_NODE_NAMES)
        excluded_nodes.update(
            {
                name
                for name in node_names
                if any(name.startswith(prefix) for prefix in INTERNAL_NODE_PREFIXES)
            }
        )

        if excluded_nodes:
            node_names.difference_update(excluded_nodes)
            edges = [
                edge
                for edge in edges
                if edge.start not in excluded_nodes and edge.end not in excluded_nodes
            ]

        return GraphSnapshot(node_names, topics, edges)


def _fully_qualified_node_name(namespace: str, node_name: str) -> str:
    namespace = namespace or '/'
    if not namespace.startswith('/'):
        namespace = '/' + namespace
    namespace = namespace.rstrip('/')
    if not namespace:
        namespace = '/'
    if namespace == '/':
        return f'/{node_name}'.replace('//', '/')
    return f'{namespace}/{node_name}'.replace('//', '/')


def _split_node_fqn(node_name: str) -> Tuple[str, str]:
    name = node_name or ''
    if not name.startswith('/'):
        name = '/' + name if name else '/'
    if name == '/':
        return '/', ''
    namespace, _, base = name.rpartition('/')
    if not namespace:
        namespace = '/'
    base = base or namespace.strip('/') or ''
    if not base:
        base = name.lstrip('/') or name or ''
    return namespace or '/', base


def _parameter_type_label(param_type: Optional[int]) -> str:
    if param_type is None:
        return ''
    mapping = {
        PARAMETER_NOT_SET: 'not set',
        PARAMETER_BOOL: 'bool',
        PARAMETER_INTEGER: 'integer',
        PARAMETER_DOUBLE: 'double',
        PARAMETER_STRING: 'string',
        PARAMETER_BYTE_ARRAY: 'bytes',
        PARAMETER_BOOL_ARRAY: 'bool[]',
        PARAMETER_INTEGER_ARRAY: 'int[]',
        PARAMETER_DOUBLE_ARRAY: 'double[]',
        PARAMETER_STRING_ARRAY: 'string[]',
    }
    return mapping.get(param_type, f'unknown({param_type})')


def _parameter_value_to_python(param_type: Optional[int], param_value: object) -> object:
    if ParameterValue is not None and isinstance(param_value, ParameterValue):
        type_id = param_type if isinstance(param_type, int) else param_value.type
        if type_id == PARAMETER_NOT_SET:
            return None
        if type_id == PARAMETER_BOOL:
            return bool(param_value.bool_value)
        if type_id == PARAMETER_INTEGER:
            return int(param_value.integer_value)
        if type_id == PARAMETER_DOUBLE:
            return float(param_value.double_value)
        if type_id == PARAMETER_STRING:
            return str(param_value.string_value)
        if type_id == PARAMETER_BYTE_ARRAY:
            return bytes(param_value.byte_array_value)
        if type_id == PARAMETER_BOOL_ARRAY:
            return [bool(v) for v in param_value.bool_array_value]
        if type_id == PARAMETER_INTEGER_ARRAY:
            return [int(v) for v in param_value.integer_array_value]
        if type_id == PARAMETER_DOUBLE_ARRAY:
            return [float(v) for v in param_value.double_array_value]
        if type_id == PARAMETER_STRING_ARRAY:
            return [str(v) for v in param_value.string_array_value]
    return param_value


def _stringify_parameter_value(param_type: Optional[int], param_value: object) -> str:
    value = _parameter_value_to_python(param_type, param_value)
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, bytes):
        return '0x' + value.hex()
    if isinstance(value, (list, tuple)):
        try:
            return json.dumps(value, ensure_ascii=False)
        except TypeError:  # pragma: no cover - defensive
            return '[' + ', '.join(str(item) for item in value) + ']'
    if isinstance(value, dict):
        try:
            return json.dumps(value, ensure_ascii=False)
        except TypeError:  # pragma: no cover - defensive
            return str(value)
    return str(value)


def _truncate_parameter_display(value: str, limit: int = PARAMETER_DISPLAY_MAX) -> str:
    text = value or ''
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3] + '...'


def _stringify_echo_value(value: object, limit: int = 256) -> str:
    if isinstance(value, (bytes, bytearray)):
        text = '0x' + bytes(value).hex()
    elif isinstance(value, str):
        text = value
    elif isinstance(value, (int, float, bool)) or value is None:
        text = str(value)
    else:
        try:
            text = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):  # pragma: no cover - defensive
            text = str(value)
    if len(text) > limit:
        return text[: max(0, limit - 1)] + '…'
    return text


def _convert_message_to_primitive(msg: object) -> object:
    if msg is None:
        return None
    if message_to_ordereddict is not None:
        try:
            return message_to_ordereddict(msg)
        except Exception:  # pragma: no cover - defensive
            pass
    if isinstance(msg, (str, int, float, bool)):
        return msg
    if isinstance(msg, (bytes, bytearray)):
        return list(msg)
    if isinstance(msg, (list, tuple)):
        return [_convert_message_to_primitive(item) for item in msg]
    if hasattr(msg, '__slots__'):
        result: Dict[str, object] = {}
        for slot_name in getattr(type(msg), '__slots__', []):
            attr = slot_name.lstrip('_')
            try:
                value = getattr(msg, attr)
            except AttributeError:
                continue
            result[attr] = _convert_message_to_primitive(value)
        return result
    return str(msg)


def _parameter_descriptor_to_dict(descriptor) -> Optional[Dict[str, object]]:
    if descriptor is None:
        return None
    data: Dict[str, object] = {}
    name = getattr(descriptor, 'name', '') or ''
    if name:
        data['name'] = str(name)
    type_id = getattr(descriptor, 'type', None)
    if isinstance(type_id, int):
        data['type_id'] = type_id
        data['type'] = _parameter_type_label(type_id)
    description = getattr(descriptor, 'description', '') or ''
    if description:
        data['description'] = str(description)
    constraints = getattr(descriptor, 'additional_constraints', '') or ''
    if constraints:
        data['additional_constraints'] = str(constraints)
    data['read_only'] = bool(getattr(descriptor, 'read_only', False))
    data['dynamic_typing'] = bool(getattr(descriptor, 'dynamic_typing', False))

    integer_ranges = []
    for item in list(getattr(descriptor, 'integer_range', []) or []):
        integer_ranges.append({
            'from_value': int(getattr(item, 'from_value', 0)),
            'to_value': int(getattr(item, 'to_value', 0)),
            'step': int(getattr(item, 'step', 0)),
        })
    if integer_ranges:
        data['integer_ranges'] = integer_ranges

    float_ranges = []
    for item in list(getattr(descriptor, 'floating_point_range', []) or []):
        float_ranges.append({
            'from_value': float(getattr(item, 'from_value', 0.0)),
            'to_value': float(getattr(item, 'to_value', 0.0)),
            'step': float(getattr(item, 'step', 0.0)),
        })
    if float_ranges:
        data['floating_point_ranges'] = float_ranges

    return data


class _TopicEchoAggregator:
    def __init__(self, node: Node, topic: str, msg_type, type_name: str) -> None:
        self._node = node
        self.topic = topic
        self.type_name = type_name
        self._lock = threading.Lock()
        self._watchers: Dict[str, float] = {}
        self._count = 0
        self._last_received = 0.0
        self._last_sample: Optional[Dict[str, object]] = None
        qos_profile = QoSProfile(depth=10)
        qos_profile.reliability = ReliabilityPolicy.BEST_EFFORT
        qos_profile.durability = DurabilityPolicy.VOLATILE
        self._subscription = node.create_subscription(msg_type, topic, self._callback, qos_profile)

    def _callback(self, msg) -> None:
        primitive = _convert_message_to_primitive(msg)
        header = None
        data_field = None
        if isinstance(primitive, dict):
            header = primitive.get('header')
            if 'data' in primitive:
                data_field = primitive.get('data')
            else:
                remaining = {k: v for k, v in primitive.items() if k != 'header'}
                if len(remaining) == 1:
                    data_field = next(iter(remaining.values()))
                else:
                    data_field = remaining or primitive
        else:
            data_field = primitive

        timestamp = time.time()
        sample = {
            'header': header,
            'data': data_field,
            'data_text': _stringify_echo_value(data_field),
            'received_at': timestamp,
        }
        with self._lock:
            self._count += 1
            self._last_received = timestamp
            self._last_sample = sample

    def register(self, token: str) -> None:
        with self._lock:
            self._watchers[token] = time.time()

    def unregister(self, token: str) -> None:
        with self._lock:
            self._watchers.pop(token, None)

    def touch(self, token: str, timestamp: Optional[float] = None) -> None:
        with self._lock:
            if token in self._watchers:
                self._watchers[token] = timestamp or time.time()

    def prune_watchers(self, cutoff: float) -> List[str]:
        removed: List[str] = []
        with self._lock:
            stale = [token for token, ts in self._watchers.items() if ts < cutoff]
            for token in stale:
                self._watchers.pop(token, None)
                removed.append(token)
        return removed

    def has_watchers(self) -> bool:
        with self._lock:
            return bool(self._watchers)

    def snapshot(self) -> Dict[str, object]:
        with self._lock:
            sample = None if self._last_sample is None else dict(self._last_sample)
            count = self._count
            last_received = self._last_received
        if sample is not None:
            received_at = sample.get('received_at')
            if isinstance(received_at, (int, float)) and received_at > 0:
                sample['received_iso'] = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(received_at))
        return {
            'type': self.type_name,
            'count': count,
            'last_received': last_received,
            'sample': sample,
        }

    def destroy(self) -> None:
        try:
            self._node.destroy_subscription(self._subscription)
        except Exception:  # pragma: no cover - defensive
            pass
        with self._lock:
            self._watchers.clear()

def _rosidl_slot_type_to_string(slot_type) -> str:
    if Array is not None and isinstance(slot_type, Array):
        inner = _rosidl_slot_type_to_string(slot_type.value_type)
        return f'array<{inner}, {slot_type.size}>'
    if AbstractSequence is not None and isinstance(slot_type, AbstractSequence):
        inner = _rosidl_slot_type_to_string(slot_type.value_type)
        max_size = getattr(slot_type, 'maximum_size', None)
        if max_size is not None and max_size > 0:
            return f'sequence<{inner}, {max_size}>'
        return f'sequence<{inner}>'
    if BasicType is not None and isinstance(slot_type, BasicType):
        return slot_type.typename
    if NamespacedType is not None and isinstance(slot_type, NamespacedType):
        return '/'.join((*slot_type.names, slot_type.name))
    return str(slot_type)


def _rosidl_slot_is_basic(slot_type) -> bool:
    return BasicType is not None and isinstance(slot_type, BasicType)


def _rosidl_slot_is_array(slot_type) -> bool:
    if Array is not None and isinstance(slot_type, Array):
        return True
    if AbstractSequence is not None and isinstance(slot_type, AbstractSequence):
        return True
    return False


def _rosidl_slot_value_type(slot_type):
    if Array is not None and isinstance(slot_type, Array):
        return slot_type.value_type
    if AbstractSequence is not None and isinstance(slot_type, AbstractSequence):
        return slot_type.value_type
    return None


def _rosidl_slot_array_size(slot_type) -> Optional[int]:
    if Array is not None and isinstance(slot_type, Array):
        return int(getattr(slot_type, 'size', 0)) or 0
    return None


def _rosidl_slot_maximum_size(slot_type) -> Optional[int]:
    if Array is not None and isinstance(slot_type, Array):
        return int(getattr(slot_type, 'size', 0)) or 0
    if AbstractSequence is not None and isinstance(slot_type, AbstractSequence):
        maximum = getattr(slot_type, 'maximum_size', None)
        if maximum is not None and maximum > 0:
            return int(maximum)
    return None


def _get_message_class_for_slot(slot_type):
    if NamespacedType is None or not isinstance(slot_type, NamespacedType):
        return None
    try:
        from rosidl_runtime_py.utilities import get_message  # type: ignore
    except ImportError:  # pragma: no cover - optional dependency
        return None
    type_name = '/'.join((*slot_type.names, slot_type.name))
    try:
        return get_message(type_name)
    except (AttributeError, ModuleNotFoundError, ValueError):
        return None


def _message_value_to_primitive(value: object) -> object:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (bytes, bytearray)):
        return list(value)
    if isinstance(value, dict):
        return {key: _message_value_to_primitive(val) for key, val in value.items()}
    if isinstance(value, (list, tuple)):
        return [_message_value_to_primitive(item) for item in value]
    if hasattr(value, '__slots__'):
        result: Dict[str, object] = {}
        for slot_name in getattr(type(value), '__slots__', []):
            attr = slot_name.lstrip('_')
            if not attr:
                continue
            try:
                slot_value = getattr(value, attr)
            except AttributeError:
                continue
            result[attr] = _message_value_to_primitive(slot_value)
        return result
    try:
        return list(value)
    except TypeError:
        return str(value)


def _describe_message_type(message_cls, visited: Optional[Set[str]] = None) -> List[Dict[str, object]]:
    if message_cls is None:
        return []
    if visited is None:
        visited = set()
    key = f'{message_cls.__module__}.{message_cls.__name__}'
    if key in visited:
        return []
    next_visited = set(visited)
    next_visited.add(key)
    descriptors: List[Dict[str, object]] = []
    instance = message_cls()
    slot_names = [name.lstrip('_') for name in getattr(message_cls, '__slots__', [])]
    slot_types = list(getattr(message_cls, 'SLOT_TYPES', []))
    for field_name, slot_type in zip(slot_names, slot_types):
        try:
            default_value = getattr(instance, field_name)
        except AttributeError:
            default_value = None
        descriptor: Dict[str, object] = {
            'name': field_name,
            'type': _rosidl_slot_type_to_string(slot_type),
            'is_array': False,
            'array_size': None,
            'max_size': None,
            'is_basic': False,
            'default': _message_value_to_primitive(default_value),
        }
        if _rosidl_slot_is_array(slot_type):
            descriptor['is_array'] = True
            descriptor['array_size'] = _rosidl_slot_array_size(slot_type)
            max_size = _rosidl_slot_maximum_size(slot_type)
            if max_size:
                descriptor['max_size'] = max_size
            value_type = _rosidl_slot_value_type(slot_type)
            descriptor['element_type'] = _rosidl_slot_type_to_string(value_type)
            descriptor['element_is_basic'] = bool(_rosidl_slot_is_basic(value_type))
            if not descriptor['element_is_basic']:
                element_cls = _get_message_class_for_slot(value_type)
                if element_cls is not None:
                    descriptor['element_schema'] = _describe_message_type(element_cls, next_visited)
                    descriptor['element_example'] = _message_value_to_primitive(element_cls())
        else:
            if _rosidl_slot_is_basic(slot_type):
                descriptor['is_basic'] = True
                descriptor['base_type'] = _rosidl_slot_type_to_string(slot_type)
            else:
                descriptor['base_type'] = _rosidl_slot_type_to_string(slot_type)
                nested_cls = _get_message_class_for_slot(slot_type)
                if nested_cls is not None:
                    descriptor['children'] = _describe_message_type(nested_cls, next_visited)
        descriptors.append(descriptor)
    return descriptors


def _resolve_service_name(namespace: str, base: str, service_name: str) -> str:
    if not service_name:
        return service_name
    if service_name.startswith('/'):
        return service_name
    node_fqn = _fully_qualified_node_name(namespace, base)
    return f'{node_fqn}/{service_name}'.replace('//', '/')


def _parse_parameter_input(param_type: Optional[int], raw_value: object) -> object:
    if not isinstance(param_type, int):
        raise ValueError('unknown parameter type')

    def _coerce_bool(value: object) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            text = value.strip().lower()
            if text in {'true', '1', 'yes', 'on'}:
                return True
            if text in {'false', '0', 'no', 'off'}:
                return False
        raise ValueError('expected boolean value')

    def _ensure_array(value: object) -> List[object]:
        if isinstance(value, (list, tuple)):
            return list(value)
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return []
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError('expected JSON array') from exc
            if not isinstance(parsed, list):
                raise ValueError('expected JSON array')
            return list(parsed)
        raise ValueError('expected array value')

    if param_type == PARAMETER_NOT_SET:
        return None
    if param_type == PARAMETER_BOOL:
        return _coerce_bool(raw_value)
    if param_type == PARAMETER_INTEGER:
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                raise ValueError('expected integer value')
            return int(text, 0)
        if isinstance(raw_value, (int, float)):
            return int(raw_value)
        raise ValueError('expected integer value')
    if param_type == PARAMETER_DOUBLE:
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                raise ValueError('expected floating-point value')
            return float(text)
        if isinstance(raw_value, (int, float)):
            return float(raw_value)
        raise ValueError('expected floating-point value')
    if param_type == PARAMETER_STRING:
        return '' if raw_value is None else str(raw_value)
    if param_type == PARAMETER_BYTE_ARRAY:
        if isinstance(raw_value, (bytes, bytearray)):
            return bytes(raw_value)
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                return bytes()
            if text.startswith('0x'):
                try:
                    return bytes.fromhex(text[2:])
                except ValueError as exc:
                    raise ValueError('expected hex string for byte array') from exc
        items = _ensure_array(raw_value)
        try:
            return bytes(int(item) & 0xFF for item in items)
        except (TypeError, ValueError) as exc:
            raise ValueError('expected array of integers (0-255)') from exc
    if param_type == PARAMETER_BOOL_ARRAY:
        items = _ensure_array(raw_value)
        return [_coerce_bool(item) for item in items]
    if param_type == PARAMETER_INTEGER_ARRAY:
        items = _ensure_array(raw_value)
        result = []
        for item in items:
            if isinstance(item, str):
                text = item.strip()
                if not text:
                    raise ValueError('expected integer value')
                result.append(int(text, 0))
            elif isinstance(item, (int, float)):
                result.append(int(item))
            else:
                raise ValueError('expected integer value')
        return result
    if param_type == PARAMETER_DOUBLE_ARRAY:
        items = _ensure_array(raw_value)
        result = []
        for item in items:
            if isinstance(item, str):
                text = item.strip()
                if not text:
                    raise ValueError('expected floating-point value')
                result.append(float(text))
            elif isinstance(item, (int, float)):
                result.append(float(item))
            else:
                raise ValueError('expected floating-point value')
        return result
    if param_type == PARAMETER_STRING_ARRAY:
        items = _ensure_array(raw_value)
        return ['' if item is None else str(item) for item in items]
    raise ValueError(f'unhandled parameter type {param_type}')


def _make_parameter_message(name: str, param_type: int, value: object) -> 'Parameter':
    if Parameter is None or ParameterValue is None:
        raise RuntimeError('parameter services unavailable')
    param_msg = Parameter()
    param_msg.name = name
    value_msg = ParameterValue()
    value_msg.type = param_type
    if param_type == PARAMETER_NOT_SET:
        pass
    elif param_type == PARAMETER_BOOL:
        value_msg.bool_value = bool(value)
    elif param_type == PARAMETER_INTEGER:
        value_msg.integer_value = int(value)
    elif param_type == PARAMETER_DOUBLE:
        value_msg.double_value = float(value)
    elif param_type == PARAMETER_STRING:
        value_msg.string_value = '' if value is None else str(value)
    elif param_type == PARAMETER_BYTE_ARRAY:
        value_msg.byte_array_value = list(value if isinstance(value, (bytes, bytearray)) else bytes(value))
    elif param_type == PARAMETER_BOOL_ARRAY:
        value_msg.bool_array_value = [bool(item) for item in value]
    elif param_type == PARAMETER_INTEGER_ARRAY:
        value_msg.integer_array_value = [int(item) for item in value]
    elif param_type == PARAMETER_DOUBLE_ARRAY:
        value_msg.double_array_value = [float(item) for item in value]
    elif param_type == PARAMETER_STRING_ARRAY:
        value_msg.string_array_value = ['' if item is None else str(item) for item in value]
    else:
        raise ValueError(f'unhandled parameter type {param_type}')
    param_msg.value = value_msg
    return param_msg


def _format_qos(profile: QoSProfile | None) -> str:
    if profile is None:
        return ''

    parts: List[str] = []
    if profile.reliability is not None:
        parts.append(profile.reliability.name)
    if profile.durability is not None:
        parts.append(profile.durability.name)
    if profile.history is not None:
        parts.append(profile.history.name)
    if profile.depth not in (None, 0):
        parts.append(f'depth={profile.depth}')

    return '/'.join(parts)


class Ros2GraphNode(Node):
    """Minimal ROS node that prints graph snapshots to stdout."""

    def __init__(self) -> None:
        super().__init__('ros2_graph')
        self.declare_parameter('output_format', 'dot')
        self.declare_parameter('update_interval', 2.0)
        self.declare_parameter('print_once', False)
        self.declare_parameter('web_enable', True)
        self.declare_parameter('web_host', '0.0.0.0')
        self.declare_parameter('web_port', 8734)
        self.declare_parameter('parameter_service_timeout', PARAMETER_SERVICE_TIMEOUT)

        interval = max(float(self.get_parameter('update_interval').value), 0.1)
        self._output_format = str(self.get_parameter('output_format').value).lower()
        self._print_once = bool(self.get_parameter('print_once').value)
        timeout_param = self.get_parameter('parameter_service_timeout').value
        try:
            timeout_value = float(timeout_param)
        except (TypeError, ValueError):
            timeout_value = PARAMETER_SERVICE_TIMEOUT
        self._parameter_service_timeout = max(timeout_value, 0.5)
        self._metrics_lock = threading.Lock()
        self._metrics_cache: Dict[Tuple[str, Tuple[str, ...]], Dict[str, object]] = {}
        self._metrics_cache_ttl = 5.0
        self._echo_lock = threading.Lock()
        self._echo_aggregators: Dict[str, _TopicEchoAggregator] = {}
        self._echo_streams: Dict[str, Dict[str, object]] = {}
        self._echo_next_stream_id = 1
        self._echo_timeout = 30.0
        self._web_server: Optional[GraphWebServer] = None
        self._last_snapshot: Optional[GraphSnapshot] = None
        if bool(self.get_parameter('web_enable').value):
            host = str(self.get_parameter('web_host').value or '0.0.0.0')
            port = int(self.get_parameter('web_port').value or 8734)
            try:
                self._web_server = GraphWebServer(
                    host,
                    port,
                    self.get_logger(),
                    topic_tool_handler=self._handle_topic_tool_request,
                    node_tool_handler=self._handle_node_tool_request,
                )
                self._web_server.start()
            except OSError as exc:
                self.get_logger().error(f'Failed to start web server on {host}:{port} ({exc})')

        self._builder = GraphBuilder(self)
        self._last_fingerprint: str | None = None

        self._timer = self.create_timer(interval, self._update_graph)
        # emit immediately so users don't wait for the first interval
        self._update_graph()

    def _update_graph(self) -> None:
        snapshot = self._builder.build()
        fingerprint = snapshot.fingerprint()
        if fingerprint == self._last_fingerprint:
            return
        self._prune_metrics_cache(snapshot)

        self._emit_snapshot(snapshot)
        self._publish_web(snapshot, fingerprint)
        self.get_logger().info(
            f'graph updated ({len(snapshot.nodes)} nodes, '
            f'{len(snapshot.topics)} topics, {len(snapshot.edges)} edges)'
        )
        self._last_fingerprint = fingerprint
        self._last_snapshot = snapshot

        if self._print_once:
            self.get_logger().info('print_once=true, shutting down after first update')
            # allow logs to flush before shutting down
            rclpy.shutdown()

    def _emit_snapshot(self, snapshot: GraphSnapshot) -> None:
        formatter = {
            'dot': snapshot.to_dot,
            'json': snapshot.to_json,
            'adjacency': snapshot.to_adjacency,
        }.get(self._output_format, snapshot.to_dot)

        if formatter is snapshot.to_dot and self._output_format not in ('dot', 'json', 'adjacency'):
            self.get_logger().warning(
                f"Unknown output_format '{self._output_format}', falling back to DOT"
            )

        print(formatter(), flush=True)

    def _prune_metrics_cache(self, snapshot: GraphSnapshot) -> None:
        valid_topics = set(snapshot.topics.keys())
        with self._metrics_lock:
            stale_keys = [
                key for key in self._metrics_cache.keys()
                if key[0] not in valid_topics
            ]
            for key in stale_keys:
                self._metrics_cache.pop(key, None)

    def _call_parameter_service(self, srv_type, service_name: str, request, timeout: Optional[float] = None):
        client = self.create_client(srv_type, service_name)
        deadline_timeout = timeout
        if deadline_timeout is None:
            deadline_timeout = getattr(self, '_parameter_service_timeout', PARAMETER_SERVICE_TIMEOUT)
        deadline_timeout = max(float(deadline_timeout), 0.1)
        try:
            if not client.wait_for_service(timeout_sec=deadline_timeout):
                raise TimeoutError(f'service {service_name} unavailable')
            future = client.call_async(request)

            deadline = time.monotonic() + max(deadline_timeout, 0.1)
            while True:
                if future.done():
                    if future.cancelled():
                        raise RuntimeError(f'service call to {service_name} was cancelled')
                    exc = future.exception()
                    if exc is not None:
                        raise exc
                    return future.result()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    future.cancel()
                    raise TimeoutError(f'service {service_name} timed out')
                time.sleep(min(0.05, remaining))
        finally:
            try:
                self.destroy_client(client)
            except Exception:  # pragma: no cover - defensive
                pass

    def _collect_parameters_for_node(self, base: str, namespace: str) -> List[Dict[str, object]]:
        if ListParameters is None or GetParameters is None:
            raise RuntimeError('parameter services unavailable (rcl_interfaces missing)')

        fully_qualified = _fully_qualified_node_name(namespace, base)
        list_service = f'{fully_qualified}/list_parameters'
        list_request = ListParameters.Request()
        list_request.depth = 0

        list_response = self._call_parameter_service(
            ListParameters,
            list_service,
            list_request,
            timeout=self._parameter_service_timeout,
        )
        result = getattr(list_response, 'result', None)
        names = list((getattr(result, 'names', []) or [])) if result is not None else []

        names = sorted(set(names))
        if not names:
            return []

        get_service = f'{fully_qualified}/get_parameters'
        get_request = GetParameters.Request()
        get_request.names = list(names)
        get_response = self._call_parameter_service(
            GetParameters,
            get_service,
            get_request,
            timeout=self._parameter_service_timeout,
        )

        values = list(getattr(get_response, 'values', []) or [])
        parameters: List[Dict[str, object]] = []
        for name, value in zip(names, values):
            type_id = getattr(value, 'type', None)
            full_text = _stringify_parameter_value(type_id, value)
            display_value = _truncate_parameter_display(full_text, PARAMETER_DISPLAY_MAX)
            parameters.append({
                'name': name,
                'type': _parameter_type_label(type_id),
                'type_id': int(type_id) if isinstance(type_id, int) else None,
                'value': display_value,
                'raw_value': full_text,
            })

        return parameters

    def _describe_parameter_for_node(
        self,
        base: str,
        namespace: str,
        name: str,
    ) -> Optional[Dict[str, object]]:
        if DescribeParameters is None:
            raise RuntimeError('parameter description service unavailable')
        fully_qualified = _fully_qualified_node_name(namespace, base)
        describe_service = f'{fully_qualified}/describe_parameters'
        request = DescribeParameters.Request()
        request.names = [name]

        response = self._call_parameter_service(
            DescribeParameters,
            describe_service,
            request,
            timeout=self._parameter_service_timeout,
        )
        descriptors = list(getattr(response, 'descriptors', []) or [])
        if not descriptors:
            return None
        descriptor = descriptors[0]
        return _parameter_descriptor_to_dict(descriptor)

    def _describe_service_for_node(
        self,
        base: str,
        namespace: str,
        service_name: str,
        service_type_hint: str = '',
    ) -> Dict[str, object]:
        try:
            entries = self.get_service_names_and_types_by_node(base, namespace)
        except Exception as exc:  # pragma: no cover - defensive
            raise RuntimeError(f'failed to fetch services for node: {exc}') from exc

        matching_types: List[str] = []
        for name, types in entries:
            if name == service_name:
                matching_types = list(types)
                break

        service_type = service_type_hint.strip()
        if not service_type:
            if not matching_types:
                raise ValueError(f"service '{service_name}' not found for node")
            service_type = matching_types[0]
        elif matching_types and service_type not in matching_types:
            matching_types.insert(0, service_type)

        try:
            from rosidl_runtime_py.utilities import get_service  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError('rosidl_runtime_py is required for service tools') from exc

        try:
            service_cls = get_service(service_type)
        except (AttributeError, ModuleNotFoundError, ValueError) as exc:
            raise RuntimeError(f"failed to import service type '{service_type}'") from exc

        request_cls = getattr(service_cls, 'Request', None)
        if request_cls is None:
            raise RuntimeError(f"service '{service_type}' has no Request definition")

        request_schema = _describe_message_type(request_cls)
        request_example = _message_value_to_primitive(request_cls())

        return {
            'name': service_name,
            'type': service_type,
            'types': matching_types or [service_type],
            'request': {
                'fields': request_schema,
                'example': request_example,
            },
        }

    def _ensure_echo_aggregator_locked(self, topic: str) -> _TopicEchoAggregator:
        aggregator = self._echo_aggregators.get(topic)
        if aggregator is not None:
            return aggregator
        snapshot = self._last_snapshot
        if snapshot is None:
            raise RuntimeError('graph not ready yet')
        type_names = snapshot.topics.get(topic)
        if not type_names:
            raise ValueError(f"topic '{topic}' not found")
        type_name = type_names[0]
        try:
            from rosidl_runtime_py.utilities import get_message  # type: ignore
        except ImportError as exc:
            raise RuntimeError('rosidl_runtime_py is required for topic echo support') from exc
        try:
            msg_type = get_message(type_name)
        except (AttributeError, ModuleNotFoundError, ValueError) as exc:
            raise RuntimeError(f"failed to import message type '{type_name}'") from exc
        aggregator = _TopicEchoAggregator(self, topic, msg_type, type_name)
        self._echo_aggregators[topic] = aggregator
        return aggregator

    def _create_echo_stream_locked(self, topic: str, aggregator: _TopicEchoAggregator) -> str:
        stream_id = ''
        while True:
            candidate = f'echo-{int(time.time() * 1000):x}-{self._echo_next_stream_id}'
            self._echo_next_stream_id += 1
            if candidate not in self._echo_streams:
                stream_id = candidate
                break
        aggregator.register(stream_id)
        self._echo_streams[stream_id] = {
            'topic': topic,
            'aggregator': aggregator,
            'last_access': time.time(),
        }
        return stream_id

    def _stop_topic_echo_stream_locked(self, stream_id: str) -> bool:
        info = self._echo_streams.pop(stream_id, None)
        if not info:
            return False
        aggregator: _TopicEchoAggregator = info['aggregator']
        aggregator.unregister(stream_id)
        if not aggregator.has_watchers():
            aggregator.destroy()
            self._echo_aggregators.pop(info['topic'], None)
        return True

    def _cleanup_echo_locked(self) -> None:
        if not self._echo_streams and not self._echo_aggregators:
            return
        now = time.time()
        cutoff = now - self._echo_timeout
        stale_streams: List[str] = []
        for stream_id, info in list(self._echo_streams.items()):
            if info.get('last_access', 0.0) < cutoff:
                aggregator: _TopicEchoAggregator = info['aggregator']
                aggregator.unregister(stream_id)
                stale_streams.append(stream_id)
        for stream_id in stale_streams:
            info = self._echo_streams.pop(stream_id, None)
            if not info:
                continue
            aggregator: _TopicEchoAggregator = info['aggregator']
            if not aggregator.has_watchers():
                aggregator.destroy()
                self._echo_aggregators.pop(info['topic'], None)
        for topic, aggregator in list(self._echo_aggregators.items()):
            removed = aggregator.prune_watchers(cutoff)
            for token in removed:
                self._echo_streams.pop(token, None)
            if not aggregator.has_watchers():
                aggregator.destroy()
                self._echo_aggregators.pop(topic, None)

    def _handle_topic_echo_request(
        self,
        topic: str,
        peer: Optional[str],
        params: Dict[str, list],
    ) -> Tuple[int, Dict[str, object]]:
        raw_mode = params.get('mode', [''])[0].strip().lower()
        stream_id = params.get('stream', [''])[0].strip()
        mode = raw_mode or ('start' if not stream_id else 'poll')

        aggregator: Optional[_TopicEchoAggregator] = None
        with self._echo_lock:
            self._cleanup_echo_locked()
            if mode == 'stop':
                if not stream_id:
                    return 400, {'error': 'missing stream identifier'}
                if not self._stop_topic_echo_stream_locked(stream_id):
                    return 404, {'error': 'unknown echo stream'}
                return 200, {
                    'action': 'echo',
                    'topic': topic,
                    'stream_id': stream_id,
                    'stopped': True,
                }

            if mode == 'start':
                try:
                    aggregator = self._ensure_echo_aggregator_locked(topic)
                except ValueError as exc:
                    return 404, {'error': str(exc)}
                except RuntimeError as exc:
                    return 503, {'error': str(exc)}
                except Exception as exc:  # pragma: no cover - defensive
                    return 500, {'error': str(exc)}
                stream_id = self._create_echo_stream_locked(topic, aggregator)
            else:
                if not stream_id:
                    return 400, {'error': 'missing stream identifier'}
                info = self._echo_streams.get(stream_id)
                if not info or info['topic'] != topic:
                    return 404, {'error': 'unknown echo stream'}
                aggregator = info['aggregator']
                now = time.time()
                info['last_access'] = now
                aggregator.touch(stream_id, now)

        if aggregator is None:  # pragma: no cover - defensive
            return 500, {'error': 'failed to initialise echo stream'}

        snapshot = aggregator.snapshot()
        sample = snapshot.get('sample')
        payload: Dict[str, object] = {
            'action': 'echo',
            'topic': topic,
            'stream_id': stream_id,
            'type': snapshot.get('type'),
            'count': snapshot.get('count', 0),
            'sample': sample,
            'timeout': self._echo_timeout,
        }
        if peer:
            payload['peer'] = peer
        if mode == 'start':
            payload['started'] = True
        if sample is None:
            payload['status'] = 'waiting'
        return 200, payload

    def _call_service_for_node(
        self,
        base: str,
        namespace: str,
        service_name: str,
        service_type_hint: str,
        payload: Dict[str, object],
    ) -> Tuple[str, Dict[str, object], str]:
        try:
            service_info = self._describe_service_for_node(base, namespace, service_name, service_type_hint)
        except ValueError:
            raise
        except Exception as exc:
            raise RuntimeError(f'failed to prepare service call: {exc}') from exc

        service_type = str(service_info.get('type') or '')
        if not service_type:
            raise RuntimeError('unable to determine service type')

        try:
            from rosidl_runtime_py.utilities import get_service  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError('rosidl_runtime_py is required for service calls') from exc

        try:
            service_cls = get_service(service_type)
        except (AttributeError, ModuleNotFoundError, ValueError) as exc:
            raise RuntimeError(f"failed to import service type '{service_type}'") from exc

        request_cls = getattr(service_cls, 'Request', None)
        response_cls = getattr(service_cls, 'Response', None)
        if request_cls is None or response_cls is None:
            raise RuntimeError(f"service '{service_type}' is missing request/response definitions")

        try:
            from rosidl_runtime_py import set_message_fields  # type: ignore
        except ImportError:
            try:  # pragma: no cover - compatibility
                from rosidl_runtime_py.set_message_fields import set_message_fields  # type: ignore
            except ImportError as exc:
                raise RuntimeError('rosidl_runtime_py.set_message_fields is required for service calls') from exc

        request_message = request_cls()
        try:
            set_message_fields(request_message, dict(payload))
        except Exception as exc:
            raise ValueError(f'invalid request payload: {exc}') from exc

        service_fqn = _resolve_service_name(namespace, base, service_name)
        response = self._call_parameter_service(  # reuse generic service call helper
            service_cls,
            service_fqn,
            request_message,
            timeout=self._parameter_service_timeout,
        )
        primitive = _message_value_to_primitive(response)
        try:
            response_text = json.dumps(primitive, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            response_text = str(primitive)
        return service_type, primitive, response_text

    def _set_parameter_for_node(
        self,
        base: str,
        namespace: str,
        name: str,
        type_id: int,
        value: object,
    ) -> Tuple[bool, str]:
        if SetParameters is None:
            raise RuntimeError('parameter update service unavailable')
        fully_qualified = _fully_qualified_node_name(namespace, base)
        set_service = f'{fully_qualified}/set_parameters'
        request = SetParameters.Request()
        try:
            request.parameters = [_make_parameter_message(name, type_id, value)]
        except ValueError as exc:
            raise ValueError(f'failed to construct parameter message: {exc}') from exc

        response = self._call_parameter_service(
            SetParameters,
            set_service,
            request,
            timeout=self._parameter_service_timeout,
        )
        results = list(getattr(response, 'results', []) or [])
        if not results:
            return False, 'no response from set_parameters'
        result = results[0]
        success = bool(getattr(result, 'successful', False))
        reason = str(getattr(result, 'reason', '') or '')
        return success, reason

    def _handle_topic_tool_request(
        self,
        action: str,
        topic: str,
        peer: Optional[str],
        params: Optional[Dict[str, list]] = None,
    ) -> Tuple[int, Dict[str, object]]:
        action = (action or '').lower()
        params_map = params or {}
        if action == 'echo':
            return self._handle_topic_echo_request(topic, peer, params_map)
        if action not in {'info', 'stats'}:
            return 400, {'error': f"unsupported action '{action}'"}

        snapshot = self._last_snapshot
        if snapshot is None:
            return 503, {'error': 'graph not ready yet'}

        if topic not in snapshot.topics:
            return 404, {'error': f"topic '{topic}' not found"}

        if action == 'info':
            return 200, {
                'action': action,
                'topic': topic,
                'data': self._build_topic_info_payload(snapshot, topic, peer),
            }

        duration = 2.5
        type_names = snapshot.topics.get(topic, ())
        try:
            metrics = self._get_topic_stats(topic, type_names, duration)
        except Exception as exc:  # pragma: no cover - defensive
            self.get_logger().warning(f'Failed to collect {action} for {topic}: {exc}')
            return 500, {'error': str(exc)}

        metrics['action'] = action
        metrics['topic'] = topic
        return 200, metrics

    def _handle_node_tool_request(
        self,
        action: str,
        node_name: str,
        payload: Optional[Dict[str, object]] = None,
    ) -> Tuple[int, Dict[str, object]]:
        action = (action or '').lower()
        if action not in {'services', 'parameters', 'set_parameter', 'describe_parameter', 'describe_service', 'call_service'}:
            return 400, {'error': f"unsupported action '{action}'"}

        snapshot = self._last_snapshot
        if snapshot is None:
            return 503, {'error': 'graph not ready yet'}

        if node_name not in snapshot.nodes:
            return 404, {'error': f"node '{node_name}' not found"}

        namespace, base = _split_node_fqn(node_name)

        if action == 'services':
            try:
                entries = self.get_service_names_and_types_by_node(base, namespace)
            except Exception as exc:  # pragma: no cover - defensive
                self.get_logger().warning(f'Failed to fetch services for {node_name}: {exc}')
                return 500, {'error': str(exc)}

            services = [
                {
                    'name': service_name,
                    'types': list(types),
                }
                for service_name, types in sorted(entries, key=lambda item: item[0])
            ]

            return 200, {
                'action': action,
                'node': node_name,
                'namespace': namespace,
                'base': base,
                'services': services,
                'count': len(services),
            }

        if action == 'parameters':
            if ListParameters is None or GetParameters is None:
                return 503, {'error': 'parameter services unavailable'}

            try:
                parameters = self._collect_parameters_for_node(base, namespace)
            except TimeoutError as exc:
                self.get_logger().warning(f'Parameter query timed out for {node_name}: {exc}')
                return 504, {'error': str(exc)}
            except Exception as exc:  # pragma: no cover - defensive
                self.get_logger().warning(f'Failed to fetch parameters for {node_name}: {exc}')
                return 500, {'error': str(exc)}

            parameters.sort(key=lambda item: item['name'])

            return 200, {
                'action': action,
                'node': node_name,
                'namespace': namespace,
                'base': base,
                'parameters': parameters,
                'count': len(parameters),
            }

        if action == 'describe_service':
            details = dict(payload or {})
            service_name = str(details.get('service') or '').strip()
            service_type_hint = str(details.get('type') or '').strip()
            if not service_name:
                return 400, {'error': 'missing service name'}
            try:
                service_info = self._describe_service_for_node(base, namespace, service_name, service_type_hint)
            except ValueError as exc:
                return 404, {'error': str(exc)}
            except RuntimeError as exc:
                message = str(exc)
                status = 503 if 'rosidl_runtime_py' in message else 500
                return status, {'error': message}
            except Exception as exc:  # pragma: no cover - defensive
                return 500, {'error': str(exc)}
            return 200, {
                'action': action,
                'node': node_name,
                'namespace': namespace,
                'base': base,
                'service': service_info,
            }

        if action == 'call_service':
            details = dict(payload or {})
            service_name = str(details.get('service') or '').strip()
            service_type_hint = str(details.get('type') or '').strip()
            request_payload = details.get('request')
            if not service_name:
                return 400, {'error': 'missing service name'}
            if not isinstance(request_payload, dict):
                return 400, {'error': 'service request must be an object'}
            try:
                resolved_type, response_data, response_text = self._call_service_for_node(
                    base,
                    namespace,
                    service_name,
                    service_type_hint,
                    request_payload,
                )
            except TimeoutError as exc:
                return 504, {'error': str(exc)}
            except ValueError as exc:
                return 400, {'error': str(exc)}
            except RuntimeError as exc:
                message = str(exc)
                status = 503 if 'rosidl_runtime_py' in message else 500
                return status, {'error': message}
            except Exception as exc:  # pragma: no cover - defensive
                return 500, {'error': str(exc)}
            return 200, {
                'action': action,
                'node': node_name,
                'namespace': namespace,
                'base': base,
                'service': {
                    'name': service_name,
                    'type': resolved_type,
                },
                'request': request_payload,
                'response': response_data,
                'response_text': response_text,
            }

        if action == 'describe_parameter':
            if DescribeParameters is None:
                return 503, {'error': 'parameter description service unavailable'}
            details = dict(payload or {})
            param_name = str(details.get('name') or '').strip()
            if not param_name:
                return 400, {'error': 'missing parameter name'}
            try:
                descriptor = self._describe_parameter_for_node(base, namespace, param_name)
            except TimeoutError as exc:
                self.get_logger().warning(f'Parameter describe timed out for {node_name}/{param_name}: {exc}')
                return 504, {'error': str(exc)}
            except Exception as exc:  # pragma: no cover - defensive
                self.get_logger().warning(f'Failed to describe parameter {param_name} for {node_name}: {exc}')
                return 500, {'error': str(exc)}
            if descriptor is None:
                return 404, {'error': f'parameter {param_name} not found'}
            type_id = None
            if isinstance(descriptor, dict):
                raw_type_id = descriptor.get('type_id')
                if isinstance(raw_type_id, int):
                    type_id = raw_type_id
            return 200, {
                'action': action,
                'node': node_name,
                'namespace': namespace,
                'base': base,
                'parameter': {
                    'name': param_name,
                    'type_id': type_id,
                    'type': _parameter_type_label(type_id),
                    'descriptor': descriptor,
                },
            }

        if action == 'set_parameter':
            if SetParameters is None or Parameter is None or ParameterValue is None:
                return 503, {'error': 'parameter update service unavailable'}
            details = dict(payload or {})
            param_name = str(details.get('name') or '').strip()
            if not param_name:
                return 400, {'error': 'missing parameter name'}
            raw_type_id = details.get('type_id')
            if raw_type_id is None:
                return 400, {'error': 'missing parameter type'}
            try:
                type_id = int(raw_type_id)
            except (TypeError, ValueError):
                return 400, {'error': f'invalid parameter type: {raw_type_id!r}'}
            raw_value = details.get('value', '')
            try:
                parsed_value = _parse_parameter_input(type_id, raw_value)
            except ValueError as exc:
                return 400, {'error': str(exc)}

            try:
                success, reason = self._set_parameter_for_node(base, namespace, param_name, type_id, parsed_value)
            except TimeoutError as exc:
                self.get_logger().warning(f'Parameter set timed out for {node_name}/{param_name}: {exc}')
                return 504, {'error': str(exc)}
            except Exception as exc:  # pragma: no cover - defensive
                self.get_logger().warning(f'Failed to set parameter {param_name} for {node_name}: {exc}')
                return 500, {'error': str(exc)}

            if not success:
                message = reason or 'parameter update rejected'
                return 409, {'error': message}

            return 200, {
                'action': action,
                'node': node_name,
                'namespace': namespace,
                'base': base,
                'parameter': {
                    'name': param_name,
                    'type': _parameter_type_label(type_id),
                    'type_id': type_id,
                    'value': _stringify_parameter_value(type_id, parsed_value) if parsed_value is not None else '',
                },
            }

        return 400, {'error': f"unsupported action '{action}'"}

    def _build_topic_info_payload(
        self,
        snapshot: GraphSnapshot,
        topic: str,
        peer: Optional[str],
    ) -> Dict[str, object]:
        publishers: Set[str] = set()
        subscribers: Set[str] = set()
        qos_map: Dict[str, Set[str]] = defaultdict(set)

        for edge in snapshot.edges:
            if edge.end == topic and edge.start in snapshot.nodes:
                publishers.add(edge.start)
                if edge.qos_label:
                    qos_map[edge.start].add(edge.qos_label)
            elif edge.start == topic and edge.end in snapshot.nodes:
                subscribers.add(edge.end)
                if edge.qos_label:
                    qos_map[edge.end].add(edge.qos_label)

        def _sort_entries(items: Set[str]) -> List[Dict[str, object]]:
            entries: List[Dict[str, object]] = []
            for name in sorted(items):
                qos = sorted(qos_map.get(name, []))
                entries.append({'name': name, 'qos': qos})
            return entries

        return {
            'topic': topic,
            'types': list(snapshot.topics.get(topic, ())),
            'publishers': _sort_entries(publishers),
            'subscribers': _sort_entries(subscribers),
            'peer': peer,
        }

    def _get_topic_stats(
        self,
        topic: str,
        type_names: Tuple[str, ...],
        duration: float,
    ) -> Dict[str, object]:
        cache_key = (topic, tuple(type_names))
        now = time.monotonic()
        with self._metrics_lock:
            entry = self._metrics_cache.get(cache_key)
            if entry and now - entry.get('timestamp', 0.0) < self._metrics_cache_ttl:
                cached_copy = dict(entry['data'])
                cached_copy['cached'] = True
                return cached_copy

        metrics = self._collect_topic_metrics(topic, type_names, duration)
        metrics['cached'] = False
        stored_copy = dict(metrics)

        with self._metrics_lock:
            self._metrics_cache[cache_key] = {
                'timestamp': time.monotonic(),
                'data': stored_copy,
            }

        return dict(metrics)

    def _collect_topic_metrics(
        self,
        topic: str,
        type_names: Tuple[str, ...],
        duration: float,
    ) -> Dict[str, object]:
        if not type_names:
            raise ValueError(f"topic '{topic}' has no type information")

        try:
            from rosidl_runtime_py.utilities import get_message
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError('rosidl_runtime_py is required for topic tools') from exc

        type_name = type_names[0]
        try:
            msg_type = get_message(type_name)
        except (AttributeError, ModuleNotFoundError, ValueError) as exc:
            raise RuntimeError(f"failed to import message type '{type_name}'") from exc

        qos_profile = QoSProfile(
            depth=20,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )

        context = rclpy.Context()
        stats = {
            'count': 0,
            'bytes': 0,
            'intervals': [],
            'first_stamp': None,
            'last_stamp': None,
            'max_bytes': 0,
            'min_bytes': None,
            'type': type_name,
        }

        def _callback(msg) -> None:
            now = time.monotonic()
            if stats['count'] == 0:
                stats['first_stamp'] = now
            else:
                interval = now - stats['last_stamp']
                if interval >= 0:
                    stats['intervals'].append(interval)
            stats['last_stamp'] = now
            stats['count'] += 1
            try:
                message_bytes = serialize_message(msg)
                size = len(message_bytes)
            except Exception:  # pragma: no cover - defensive
                size = None
            if size is not None:
                stats['bytes'] += size
                stats['max_bytes'] = max(stats['max_bytes'], size)
                stats['min_bytes'] = size if stats['min_bytes'] is None else min(stats['min_bytes'], size)

        executor = None
        probe = None
        subscription = None
        start_time = time.monotonic()
        try:
            context.init(args=None)
            executor = SingleThreadedExecutor(context=context)
            probe = rclpy.create_node(
                'ros2_graph_metrics_probe',
                context=context,
                allow_undeclared_parameters=True,
                automatically_declare_parameters_from_overrides=False,
            )
            subscription = probe.create_subscription(msg_type, topic, _callback, qos_profile)
            executor.add_node(probe)
            start_time = time.monotonic()
            while time.monotonic() - start_time < duration:
                executor.spin_once(timeout_sec=0.1)
        finally:
            if executor and probe:
                try:
                    executor.remove_node(probe)
                except Exception:  # pragma: no cover
                    pass
            if probe and subscription:
                try:
                    probe.destroy_subscription(subscription)
                except Exception:  # pragma: no cover
                    pass
            if probe:
                try:
                    probe.destroy_node()
                except Exception:  # pragma: no cover
                    pass
            if executor:
                try:
                    executor.shutdown()
                except Exception:  # pragma: no cover
                    pass
            try:
                context.shutdown()
            except Exception:  # pragma: no cover
                pass

        total_elapsed = max(time.monotonic() - start_time, 1e-6)
        count = stats['count']
        intervals: List[float] = stats['intervals']

        average_hz: Optional[float] = None
        min_hz: Optional[float] = None
        max_hz: Optional[float] = None
        if count >= 2 and intervals:
            total_interval = sum(intervals)
            if total_interval > 0:
                average_hz = (count - 1) / total_interval
            if intervals:
                max_interval = max(intervals)
                min_interval = min(intervals)
                if max_interval > 0:
                    min_hz = 1.0 / max_interval
                if min_interval > 0:
                    max_hz = 1.0 / min_interval
        elif count and stats['first_stamp'] is not None and stats['last_stamp'] is not None:
            elapsed = max(stats['last_stamp'] - stats['first_stamp'], 1e-6)
            average_hz = count / elapsed

        average_bps: Optional[float] = None
        average_bytes_per_msg: Optional[float] = None
        if stats['bytes'] and total_elapsed > 0:
            average_bps = stats['bytes'] / total_elapsed
            if count:
                average_bytes_per_msg = stats['bytes'] / count

        result: Dict[str, object] = {
            'topic': topic,
            'type': type_name,
            'duration': total_elapsed,
            'message_count': count,
            'average_hz': average_hz,
            'min_hz': min_hz,
            'max_hz': max_hz,
            'average_bps': average_bps,
            'average_bytes_per_msg': average_bytes_per_msg,
            'max_bytes': stats['max_bytes'] or None,
            'min_bytes': stats['min_bytes'],
        }

        if count == 0:
            result['warning'] = 'No messages received during measurement window'

        return result

    def _publish_web(self, snapshot: GraphSnapshot, fingerprint: str) -> None:
        if not self._web_server:
            return
        try:
            self._web_server.publish(snapshot, fingerprint)
        except Exception:  # pragma: no cover - defensive
            self.get_logger().exception('Failed to push graph update to web clients')

    def destroy_node(self) -> bool:
        with self._echo_lock:
            for aggregator in self._echo_aggregators.values():
                aggregator.destroy()
            self._echo_aggregators.clear()
            self._echo_streams.clear()
        if self._web_server:
            self._web_server.stop()
        return super().destroy_node()


def main() -> None:
    rclpy.init()
    node = Ros2GraphNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
