from __future__ import annotations

from typing import Dict, Iterable, List, Set, Tuple

from rclpy.node import Node

from .snapshot import Edge, GraphSnapshot
from ..utils import format_qos, fully_qualified_node_name
from .constants import INTERNAL_NODE_NAMES, INTERNAL_NODE_PREFIXES


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
                fq_name = fully_qualified_node_name(info.node_namespace, info.node_name)
                node_names.add(fq_name)
                edges.append(Edge(fq_name, topic_name, format_qos(info.qos_profile)))

            for info in subscription_infos:
                fq_name = fully_qualified_node_name(info.node_namespace, info.node_name)
                node_names.add(fq_name)
                edges.append(Edge(topic_name, fq_name, format_qos(info.qos_profile)))

        excluded_nodes = {
            name
            for name in {
                self._node.get_fully_qualified_name(),
                f"/{self._node.get_name()}",
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
