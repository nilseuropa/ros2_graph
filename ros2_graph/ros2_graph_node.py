from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Dict, Iterable, List, Set, Tuple

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile


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

    def to_dot(self) -> str:
        """Return GraphViz DOT source."""
        lines: List[str] = [
            'digraph ros2_graph {',
            '  rankdir=LR;',
            '  graph [splines=true, overlap=false];',
        ]

        for node in sorted(self.nodes):
            lines.append(f'  "{node}" [shape=ellipse];')

        for topic, types in sorted(self.topics.items()):
            type_label = '\\n'.join(types)
            label = topic if not type_label else f'{topic}\\n{type_label}'
            safe_label = label.replace('"', '\\"')
            lines.append(f'  "{topic}" [shape=box,style=rounded,label="{safe_label}"];')

        for edge in self.edges:
            label = ''
            if edge.qos_label:
                safe_qos = edge.qos_label.replace('"', '\\"')
                label = f' [label="{safe_qos}"]'
            lines.append(f'  "{edge.start}" -> "{edge.end}"{label};')

        lines.append('}')
        return '\n'.join(lines)

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

        interval = max(float(self.get_parameter('update_interval').value), 0.1)
        self._output_format = str(self.get_parameter('output_format').value).lower()
        self._print_once = bool(self.get_parameter('print_once').value)

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

        self._last_fingerprint = fingerprint
        self._emit_snapshot(snapshot)

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
        self.get_logger().info(
            f'graph updated ({len(snapshot.nodes)} nodes, '
            f'{len(snapshot.topics)} topics, {len(snapshot.edges)} edges)'
        )


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
