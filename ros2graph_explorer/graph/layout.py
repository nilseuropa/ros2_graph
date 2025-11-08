from __future__ import annotations

import logging
from collections import defaultdict
from typing import Dict, Iterable, List, Set, Tuple

from .snapshot import GraphSnapshot

CLUSTER_NAMESPACE_LEVEL = 0
GROUP_TF_NODES = True
GROUP_IMAGE_NODES = True
ACCUMULATE_ACTIONS = True
HIDE_DYNAMIC_RECONFIGURE = True
HIDE_SINGLE_CONNECTION_TOPICS = False
HIDE_DEAD_END_TOPICS = False
HIDE_TF_NODES = False

_GRAPHVIZ_CACHE: Dict[str, Tuple[str, Dict[str, str]]] = {}
_LOGGER = logging.getLogger(__name__)


def graphviz_id_map(snapshot: GraphSnapshot) -> Dict[str, str]:
    _, id_map = generate_graphviz(snapshot)
    return dict(id_map)


def generate_graphviz(snapshot: GraphSnapshot) -> Tuple[str, Dict[str, str]]:
    fingerprint = snapshot.fingerprint()
    cached = _GRAPHVIZ_CACHE.get(fingerprint)
    if cached is not None:
        return cached
    try:
        result = _generate_rqt_graphviz(snapshot)
    except Exception:  # pragma: no cover - optional dependency path
        result = generate_simple_graphviz(snapshot)
    _GRAPHVIZ_CACHE[fingerprint] = result
    return result


def generate_simple_graphviz(snapshot: GraphSnapshot) -> Tuple[str, Dict[str, str]]:
    used_ids: Set[str] = set()
    id_map: Dict[str, str] = {}
    for node in sorted(snapshot.nodes):
        id_map[node] = _make_safe_identifier(node, "n_", used_ids)
    for topic in sorted(snapshot.topics.keys()):
        id_map[topic] = _make_safe_identifier(topic, "t_", used_ids)

    def escape_label(value: str) -> str:
        return value.replace('"', '\\"')

    def topic_label(name: str) -> str:
        types = snapshot.topics.get(name, ())
        if not types:
            return name
        type_lines = "\\n".join(types)
        return f"{name}\\n{type_lines}"

    lines: List[str] = [
        "digraph ros2graph_explorer {",
        "  graph [rankdir=LR];",
        "  node [fontsize=12];",
        "  edge [fontsize=10];",
    ]

    for node in sorted(snapshot.nodes):
        lines.append(f'  {id_map[node]} [shape=ellipse,label="{escape_label(node)}"];')
    for topic in sorted(snapshot.topics.keys()):
        lines.append(
            f'  {id_map[topic]} [shape=box,style=rounded,label="{escape_label(topic_label(topic))}"];'
        )

    for edge in snapshot.edges:
        start_id = id_map.get(edge.start)
        end_id = id_map.get(edge.end)
        if not start_id or not end_id:
            continue
        attributes: List[str] = ["weight=2"]
        if edge.qos_label:
            attributes.append(f'label="{escape_label(edge.qos_label)}"')
        attr_str = f" [{', '.join(attributes)}]" if attributes else ""
        lines.append(f"  {start_id} -> {end_id}{attr_str};")

    lines.append("}")
    dot_source = "\n".join(lines)
    result = (dot_source, id_map)
    return result


def _make_safe_identifier(name: str, prefix: str, used: Set[str]) -> str:
    stripped = name.strip()
    if not stripped:
        stripped = "root"
    safe_chars: List[str] = []
    for char in stripped:
        if char.isalnum():
            safe_chars.append(char)
        else:
            safe_chars.append("_")
    base = "".join(safe_chars) or "item"
    candidate = f"{prefix}{base}"
    counter = 1
    while candidate in used:
        candidate = f"{prefix}{base}_{counter}"
        counter += 1
    used.add(candidate)
    return candidate


def _generate_rqt_graphviz(snapshot: GraphSnapshot) -> Tuple[str, Dict[str, str]]:
    from rqt_graph.dotcode import NODE_TOPIC_GRAPH, RosGraphDotcodeGenerator, _conv  # type: ignore
    from qt_dotgraph.pydotfactory import PydotFactory  # type: ignore
    from rqt_graph import rosgraph2_impl  # type: ignore

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
    graph_adapter.nn_nodes = set(snapshot.nodes)

    publishers: Dict[str, Set[str]] = defaultdict(set)
    subscribers: Dict[str, Set[str]] = defaultdict(set)

    for edge in snapshot.edges:
        if edge.start in snapshot.nodes and edge.end in snapshot.topics:
            publishers[edge.end].add(edge.start)
        elif edge.start in snapshot.topics and edge.end in snapshot.nodes:
            subscribers[edge.start].add(edge.end)

    for topic in snapshot.topics.keys():
        topic_node = rosgraph2_impl.topic_node(topic)
        graph_adapter.nt_nodes.add(topic_node)

    for topic, pubs in publishers.items():
        topic_node = rosgraph2_impl.topic_node(topic)
        for pub in pubs:
            graph_adapter.nt_edges.add_edges(pub, topic_node, "o", label=topic, qos=None)
            graph_adapter.nt_all_edges.add_edges(pub, topic_node, "o", label=topic, qos=None)

    for topic, subs in subscribers.items():
        topic_node = rosgraph2_impl.topic_node(topic)
        for sub in subs:
            graph_adapter.nt_edges.add_edges(sub, topic_node, "i", label=topic, qos=None)
            graph_adapter.nt_all_edges.add_edges(sub, topic_node, "i", label=topic, qos=None)

    nn_edges = rosgraph2_impl.EdgeList()
    for topic, pubs in publishers.items():
        subs = subscribers.get(topic, set())
        for pub in pubs:
            for sub in subs:
                nn_edges.add_edges(pub, sub, "o", label=topic, qos=None)
    graph_adapter.nn_edges = nn_edges

    factory = PydotFactory()
    generator = RosGraphDotcodeGenerator("ros2graph_explorer_web")
    dot_source = generator.generate_dotcode(
        rosgraphinst=graph_adapter,
        ns_filter="",
        topic_filter="",
        graph_mode=NODE_TOPIC_GRAPH,
        dotcode_factory=factory,
        hide_single_connection_topics=HIDE_SINGLE_CONNECTION_TOPICS,
        hide_dead_end_topics=HIDE_DEAD_END_TOPICS,
        cluster_namespaces_level=CLUSTER_NAMESPACE_LEVEL,
        accumulate_actions=ACCUMULATE_ACTIONS,
        orientation="LR",
        rank="same",
        ranksep=0.2,
        rankdir="TB",
        simplify=False,
        quiet=False,
        unreachable=False,
        hide_tf_nodes=HIDE_TF_NODES,
        group_tf_nodes=GROUP_TF_NODES,
        group_image_nodes=GROUP_IMAGE_NODES,
        hide_dynamic_reconfigure=HIDE_DYNAMIC_RECONFIGURE,
    )

    id_map: Dict[str, str] = {}
    for node in sorted(snapshot.nodes):
        id_map[node] = factory.escape_name(_conv(node))
    for topic in sorted(snapshot.topics.keys()):
        topic_node = rosgraph2_impl.topic_node(topic)
        id_map[topic] = factory.escape_name(_conv(topic_node))

    return dot_source, id_map
