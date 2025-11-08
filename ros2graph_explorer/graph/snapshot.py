from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Dict, Iterable, List, Set, Tuple


@dataclass(frozen=True)
class Edge:
    """Simple directed edge connecting ROS nodes and topics."""

    start: str
    end: str
    qos_label: str = ""


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
            "nodes": sorted(self.nodes),
            "topics": {name: list(types) for name, types in sorted(self.topics.items())},
            "edges": [(e.start, e.end, e.qos_label) for e in self.edges],
        }
        serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha1(serialized.encode("utf-8")).hexdigest()

    def to_dict(self) -> Dict[str, object]:
        """Return a JSON-serializable dictionary."""
        return {
            "nodes": sorted(self.nodes),
            "topics": {name: list(types) for name, types in sorted(self.topics.items())},
            "edges": [
                {"start": e.start, "end": e.end, "qos": e.qos_label}
                for e in self.edges
            ],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True)

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
                    formatted_targets.append(f"{end} [{qos}]")
                else:
                    formatted_targets.append(end)
            lines.append(f'{start} -> {", ".join(formatted_targets)}')

        if not lines:
            return "# graph is empty"
        return "\n".join(lines)
