from __future__ import annotations

from typing import Dict, List, Optional

import rclpy
from rclpy.node import Node

from .graph import GraphBuilder, GraphMonitor, GraphSnapshot, layout
from .graph.constants import INTERNAL_NODE_NAMES, INTERNAL_NODE_PREFIXES
from .services import NodeToolService, TopicToolService
from .tools import parameters as parameter_tools
from .web import GraphWebServer

PARAMETER_SERVICE_TIMEOUT = 5.0

PARAMETER_NOT_SET = parameter_tools.PARAMETER_NOT_SET
PARAMETER_BOOL = parameter_tools.PARAMETER_BOOL
PARAMETER_INTEGER = parameter_tools.PARAMETER_INTEGER
PARAMETER_DOUBLE = parameter_tools.PARAMETER_DOUBLE
PARAMETER_STRING = parameter_tools.PARAMETER_STRING
PARAMETER_BYTE_ARRAY = parameter_tools.PARAMETER_BYTE_ARRAY
PARAMETER_BOOL_ARRAY = parameter_tools.PARAMETER_BOOL_ARRAY
PARAMETER_INTEGER_ARRAY = parameter_tools.PARAMETER_INTEGER_ARRAY
PARAMETER_DOUBLE_ARRAY = parameter_tools.PARAMETER_DOUBLE_ARRAY
PARAMETER_STRING_ARRAY = parameter_tools.PARAMETER_STRING_ARRAY
PARAMETER_DISPLAY_MAX = parameter_tools.PARAMETER_DISPLAY_MAX
Parameter = parameter_tools.Parameter
ParameterDescriptor = parameter_tools.ParameterDescriptor
ParameterType = parameter_tools.ParameterType
ParameterValue = parameter_tools.ParameterValue

__all__ = [
    "INTERNAL_NODE_NAMES",
    "INTERNAL_NODE_PREFIXES",
    "PARAMETER_NOT_SET",
    "PARAMETER_BOOL",
    "PARAMETER_INTEGER",
    "PARAMETER_DOUBLE",
    "PARAMETER_STRING",
    "PARAMETER_BYTE_ARRAY",
    "PARAMETER_BOOL_ARRAY",
    "PARAMETER_INTEGER_ARRAY",
    "PARAMETER_DOUBLE_ARRAY",
    "PARAMETER_STRING_ARRAY",
    "PARAMETER_DISPLAY_MAX",
    "Parameter",
    "ParameterDescriptor",
    "ParameterType",
    "ParameterValue",
    "Ros2GraphNode",
    "main",
]


class Ros2GraphNode(Node):
    """ROS node that streams graph snapshots to stdout and the web UI."""

    def __init__(self) -> None:
        super().__init__("ros2graph_explorer")
        self.declare_parameter("output_format", "dot")
        self.declare_parameter("update_interval", 2.0)
        self.declare_parameter("print_once", False)
        self.declare_parameter("web_enable", True)
        self.declare_parameter("web_host", "0.0.0.0")
        self.declare_parameter("web_port", 8734)
        self.declare_parameter("parameter_service_timeout", PARAMETER_SERVICE_TIMEOUT)

        interval = max(float(self.get_parameter("update_interval").value), 0.1)
        self._output_format = str(self.get_parameter("output_format").value).lower()
        self._print_once = bool(self.get_parameter("print_once").value)
        timeout_param = self.get_parameter("parameter_service_timeout").value
        try:
            timeout_value = float(timeout_param)
        except (TypeError, ValueError):
            timeout_value = PARAMETER_SERVICE_TIMEOUT
        self._parameter_service_timeout = max(timeout_value, 0.5)

        self._topic_tools = TopicToolService(self)
        self._node_tools = NodeToolService(self, parameter_timeout=self._parameter_service_timeout)
        self._builder = GraphBuilder(self)
        self._monitor = GraphMonitor(self, self._builder, self._on_graph_update)

        self._web_server: Optional[GraphWebServer] = None
        host = str(self.get_parameter("web_host").value or "0.0.0.0")
        port = int(self.get_parameter("web_port").value or 8734)
        if bool(self.get_parameter("web_enable").value):
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
                self.get_logger().error(f"Failed to start web server on {host}:{port} ({exc})")

        self._last_snapshot: Optional[GraphSnapshot] = None

        self._monitor.start(interval)

    def _on_graph_update(self, snapshot: GraphSnapshot, fingerprint: str) -> None:
        self._last_snapshot = snapshot
        self._topic_tools.set_snapshot(snapshot)
        self._node_tools.set_snapshot(snapshot)

        self._emit_snapshot(snapshot)
        self._publish_web(snapshot, fingerprint)
        self.get_logger().info(
            f"graph updated ({len(snapshot.nodes)} nodes, "
            f"{len(snapshot.topics)} topics, {len(snapshot.edges)} edges)"
        )

        if self._print_once:
            self.get_logger().info("print_once=true, shutting down after first update")
            rclpy.shutdown()

    def _emit_snapshot(self, snapshot: GraphSnapshot) -> None:
        formatter = {
            "dot": self._snapshot_to_dot,
            "json": lambda s: s.to_json(),
            "adjacency": lambda s: s.to_adjacency(),
        }.get(self._output_format)

        if formatter is None:
            self.get_logger().warning(
                "Unknown output_format '%s', falling back to DOT",
                self._output_format,
            )
            formatter = self._snapshot_to_dot

        print(formatter(snapshot), flush=True)

    def _snapshot_to_dot(self, snapshot: GraphSnapshot) -> str:
        dot_source, _ = layout.generate_graphviz(snapshot)
        return dot_source

    def _publish_web(self, snapshot: GraphSnapshot, fingerprint: str) -> None:
        if not self._web_server:
            return
        try:
            self._web_server.publish(snapshot, fingerprint)
        except Exception:  # pragma: no cover - defensive
            self.get_logger().exception("Failed to push graph update to web clients")

    def _handle_topic_tool_request(
        self,
        action: str,
        topic: str,
        peer: Optional[str],
        params: Optional[Dict[str, List[str]]] = None,
    ) -> tuple[int, Dict[str, object]]:
        return self._topic_tools.handle_request(action, topic, peer, params)

    def _handle_node_tool_request(
        self,
        action: str,
        node_name: str,
        payload: Optional[Dict[str, object]] = None,
    ) -> tuple[int, Dict[str, object]]:
        return self._node_tools.handle_request(action, node_name, payload)

    def destroy_node(self) -> bool:
        self._monitor.stop()
        self._topic_tools.shutdown()
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
