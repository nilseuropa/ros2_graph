from __future__ import annotations

from typing import Callable, Optional, Tuple

from rclpy.node import Node

from .builder import GraphBuilder
from .snapshot import GraphSnapshot


class GraphMonitor:
    """Periodically build graph snapshots and notify listeners when changes occur."""

    def __init__(
        self,
        node: Node,
        builder: GraphBuilder,
        on_update: Callable[[GraphSnapshot, str], None],
    ) -> None:
        self._node = node
        self._builder = builder
        self._on_update = on_update
        self._timer = None
        self._last_snapshot: Optional[GraphSnapshot] = None
        self._last_fingerprint: Optional[str] = None

    def start(self, interval: float) -> None:
        self._timer = self._node.create_timer(interval, self._tick)
        # Emit immediately so users do not wait for the first interval
        self._tick()

    def stop(self) -> None:
        if self._timer is None:
            return
        try:
            self._node.destroy_timer(self._timer)
        except Exception:  # pragma: no cover - defensive
            pass
        self._timer = None

    def last_snapshot(self) -> Optional[GraphSnapshot]:
        return self._last_snapshot

    def _tick(self) -> None:
        snapshot = self._builder.build()
        fingerprint = snapshot.fingerprint()
        if fingerprint == self._last_fingerprint:
            return
        self._last_snapshot = snapshot
        self._last_fingerprint = fingerprint
        self._on_update(snapshot, fingerprint)
