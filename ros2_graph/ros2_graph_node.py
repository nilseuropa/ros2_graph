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


CLUSTER_NAMESPACE_LEVEL = 0
GROUP_TF_NODES = True
GROUP_IMAGE_NODES = True
ACCUMULATE_ACTIONS = True
HIDE_DYNAMIC_RECONFIGURE = True
HIDE_SINGLE_CONNECTION_TOPICS = False
HIDE_DEAD_END_TOPICS = False
HIDE_TF_NODES = False
INTERNAL_NODE_NAMES = {'/ros2_graph_metrics_probe', 'ros2_graph_metrics_probe'}
INTERNAL_NODE_PREFIXES = ('/tf_listener', '/tf2_buffer', '/tf_static_listener', '/transform_listener')


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

        interval = max(float(self.get_parameter('update_interval').value), 0.1)
        self._output_format = str(self.get_parameter('output_format').value).lower()
        self._print_once = bool(self.get_parameter('print_once').value)
        self._metrics_lock = threading.Lock()
        self._metrics_cache: Dict[Tuple[str, Tuple[str, ...]], Dict[str, object]] = {}
        self._metrics_cache_ttl = 5.0
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

    def _handle_topic_tool_request(self, action: str, topic: str, peer: Optional[str]) -> Tuple[int, Dict[str, object]]:
        action = (action or '').lower()
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
            self.get_logger().warning('Failed to collect %s for %s: %s', action, topic, exc)
            return 500, {'error': str(exc)}

        metrics['action'] = action
        metrics['topic'] = topic
        return 200, metrics

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
