from __future__ import annotations

import threading
import time
from collections import defaultdict
from typing import Dict, List, Optional, Set, Tuple

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from rclpy.serialization import serialize_message
from rclpy.executors import SingleThreadedExecutor

from ..graph import GraphSnapshot
from ..tools import messages


class TopicEchoAggregator:
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
        self._subscription = node.create_subscription(
            msg_type,
            topic,
            self._callback,
            qos_profile,
        )

    def _callback(self, msg) -> None:
        primitive = messages.convert_message_to_primitive(msg)
        header = None
        data_field = None
        if isinstance(primitive, dict):
            header = primitive.get("header")
            if "data" in primitive:
                data_field = primitive.get("data")
            else:
                remaining = {k: v for k, v in primitive.items() if k != "header"}
                if len(remaining) == 1:
                    data_field = next(iter(remaining.values()))
                else:
                    data_field = remaining or primitive
        else:
            data_field = primitive

        timestamp = time.time()
        sample = {
            "header": header,
            "data": data_field,
            "data_text": messages.stringify_echo_value(data_field),
            "received_at": timestamp,
            "message": primitive,
        }
        sample["data_rows"] = messages.build_echo_data_rows(data_field)
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
            received_at = sample.get("received_at")
            if isinstance(received_at, (int, float)) and received_at > 0:
                sample["received_iso"] = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(received_at))
        return {
            "type": self.type_name,
            "count": count,
            "last_received": last_received,
            "sample": sample,
        }

    def destroy(self) -> None:
        try:
            self._node.destroy_subscription(self._subscription)
        except Exception:  # pragma: no cover - defensive
            pass
        with self._lock:
            self._watchers.clear()


class TopicToolService:
    def __init__(self, node: Node, *, echo_timeout: float = 30.0, metrics_ttl: float = 5.0) -> None:
        self._node = node
        self._echo_lock = threading.Lock()
        self._echo_timeout = echo_timeout
        self._echo_aggregators: Dict[str, TopicEchoAggregator] = {}
        self._echo_streams: Dict[str, Dict[str, object]] = {}
        self._echo_next_stream_id = 1

        self._metrics_lock = threading.Lock()
        self._metrics_cache: Dict[Tuple[str, Tuple[str, ...]], Dict[str, object]] = {}
        self._metrics_cache_ttl = metrics_ttl

        self._snapshot: Optional[GraphSnapshot] = None

    def set_snapshot(self, snapshot: GraphSnapshot) -> None:
        self._snapshot = snapshot
        self._prune_metrics_cache(snapshot)

    def handle_request(
        self,
        action: str,
        topic: str,
        peer: Optional[str],
        params: Optional[Dict[str, List[str]]] = None,
    ) -> Tuple[int, Dict[str, object]]:
        action = (action or "").lower()
        params_map = params or {}
        if action == "echo":
            return self._handle_topic_echo_request(topic, peer, params_map)
        if action not in {"info", "stats", "schema"}:
            return 400, {"error": f"unsupported action '{action}'"}

        snapshot = self._snapshot
        if snapshot is None:
            return 503, {"error": "graph not ready yet"}

        if topic not in snapshot.topics:
            return 404, {"error": f"topic '{topic}' not found"}

        if action == "info":
            return 200, {
                "action": action,
                "topic": topic,
                "data": self._build_topic_info_payload(snapshot, topic, peer),
            }
        if action == "schema":
            try:
                schemas = self._describe_topic_schema(topic)
            except ValueError as exc:
                return 404, {"error": str(exc)}
            except RuntimeError as exc:
                return 503, {"error": str(exc)}
            except Exception as exc:  # pragma: no cover - defensive
                self._node.get_logger().warning(f"Failed to describe schema for {topic}: {exc}")
                return 500, {"error": str(exc)}
            return 200, {
                "action": action,
                "topic": topic,
                "schemas": schemas,
            }

        duration = 2.5
        type_names = snapshot.topics.get(topic, ())
        try:
            metrics = self._get_topic_stats(topic, type_names, duration)
        except Exception as exc:  # pragma: no cover - defensive
            self._node.get_logger().warning(f"Failed to collect {action} for {topic}: {exc}")
            return 500, {"error": str(exc)}

        metrics["action"] = action
        metrics["topic"] = topic
        return 200, metrics

    def _handle_topic_echo_request(
        self,
        topic: str,
        peer: Optional[str],
        params: Dict[str, List[str]],
    ) -> Tuple[int, Dict[str, object]]:
        raw_mode = params.get("mode", [""])[0].strip().lower()
        stream_id = params.get("stream", [""])[0].strip()
        mode = raw_mode or ("start" if not stream_id else "poll")

        aggregator: Optional[TopicEchoAggregator] = None
        with self._echo_lock:
            self._cleanup_echo_locked()
            if mode == "stop":
                if not stream_id:
                    return 400, {"error": "missing stream identifier"}
                if not self._stop_topic_echo_stream_locked(stream_id):
                    return 404, {"error": "unknown echo stream"}
                return 200, {
                    "action": "echo",
                    "topic": topic,
                    "stream_id": stream_id,
                    "stopped": True,
                }

            if mode == "start":
                try:
                    aggregator = self._ensure_echo_aggregator_locked(topic)
                except ValueError as exc:
                    return 404, {"error": str(exc)}
                except RuntimeError as exc:
                    return 503, {"error": str(exc)}
                except Exception as exc:  # pragma: no cover - defensive
                    return 500, {"error": str(exc)}
                stream_id = self._create_echo_stream_locked(topic, aggregator)
            else:
                if not stream_id:
                    return 400, {"error": "missing stream identifier"}
                info = self._echo_streams.get(stream_id)
                if not info or info["topic"] != topic:
                    return 404, {"error": "unknown echo stream"}
                aggregator = info["aggregator"]
                now = time.time()
                info["last_access"] = now
                aggregator.touch(stream_id, now)

        if aggregator is None:  # pragma: no cover - defensive
            return 500, {"error": "failed to initialise echo stream"}

        snapshot = aggregator.snapshot()
        sample = snapshot.get("sample")
        payload: Dict[str, object] = {
            "action": "echo",
            "topic": topic,
            "stream_id": stream_id,
            "type": snapshot.get("type"),
            "count": snapshot.get("count", 0),
            "sample": sample,
            "timeout": self._echo_timeout,
        }
        if peer:
            payload["peer"] = peer
        if mode == "start":
            payload["started"] = True
        if sample is None:
            payload["status"] = "waiting"
        return 200, payload

    def _ensure_echo_aggregator_locked(self, topic: str) -> TopicEchoAggregator:
        aggregator = self._echo_aggregators.get(topic)
        if aggregator is not None:
            return aggregator
        snapshot = self._snapshot
        if snapshot is None:
            raise RuntimeError("graph not ready yet")
        type_names = snapshot.topics.get(topic)
        if not type_names:
            raise ValueError(f"topic '{topic}' not found")
        type_name = type_names[0]
        try:
            from rosidl_runtime_py.utilities import get_message  # type: ignore
        except ImportError as exc:
            raise RuntimeError("rosidl_runtime_py is required for topic echo support") from exc
        try:
            msg_type = get_message(type_name)
        except (AttributeError, ModuleNotFoundError, ValueError) as exc:
            raise RuntimeError(f"failed to import message type '{type_name}'") from exc
        aggregator = TopicEchoAggregator(self._node, topic, msg_type, type_name)
        self._echo_aggregators[topic] = aggregator
        return aggregator

    def _create_echo_stream_locked(
        self,
        topic: str,
        aggregator: TopicEchoAggregator,
    ) -> str:
        stream_id = ""
        while True:
            candidate = f"echo-{int(time.time() * 1000):x}-{self._echo_next_stream_id}"
            self._echo_next_stream_id += 1
            if candidate not in self._echo_streams:
                stream_id = candidate
                break
        aggregator.register(stream_id)
        self._echo_streams[stream_id] = {
            "topic": topic,
            "aggregator": aggregator,
            "last_access": time.time(),
        }
        return stream_id

    def _stop_topic_echo_stream_locked(self, stream_id: str) -> bool:
        info = self._echo_streams.pop(stream_id, None)
        if not info:
            return False
        aggregator: TopicEchoAggregator = info["aggregator"]
        aggregator.unregister(stream_id)
        if not aggregator.has_watchers():
            aggregator.destroy()
            self._echo_aggregators.pop(info["topic"], None)
        return True

    def _cleanup_echo_locked(self) -> None:
        if not self._echo_streams and not self._echo_aggregators:
            return
        now = time.time()
        cutoff = now - self._echo_timeout
        stale_streams: List[str] = []
        for stream_id, info in list(self._echo_streams.items()):
            if info.get("last_access", 0.0) < cutoff:
                aggregator: TopicEchoAggregator = info["aggregator"]
                aggregator.unregister(stream_id)
                stale_streams.append(stream_id)
        for stream_id in stale_streams:
            info = self._echo_streams.pop(stream_id, None)
            if not info:
                continue
            aggregator = info["aggregator"]
            if not aggregator.has_watchers():
                aggregator.destroy()
                self._echo_aggregators.pop(info["topic"], None)
        for topic, aggregator in list(self._echo_aggregators.items()):
            removed = aggregator.prune_watchers(cutoff)
            for token in removed:
                self._echo_streams.pop(token, None)
            if not aggregator.has_watchers():
                aggregator.destroy()
                self._echo_aggregators.pop(topic, None)

    def _describe_topic_schema(self, topic: str) -> List[Dict[str, object]]:
        snapshot = self._snapshot
        if snapshot is None:
            raise RuntimeError("graph not ready yet")
        type_names = list(snapshot.topics.get(topic, ()))
        if not type_names:
            raise ValueError(f"topic '{topic}' not found")
        schemas: List[Dict[str, object]] = []
        errors: List[str] = []
        for type_name in type_names:
            try:
                entry = self._build_schema_entry(type_name)
            except Exception as exc:  # pragma: no cover - defensive
                errors.append(str(exc))
                continue
            if entry:
                schemas.append(entry)
        if schemas:
            return schemas
        if errors:
            raise RuntimeError(errors[0])
        raise RuntimeError(f"no schema data available for '{topic}'")

    def _build_schema_entry(self, type_name: str) -> Optional[Dict[str, object]]:
        try:
            from rosidl_runtime_py.utilities import get_message  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError("rosidl_runtime_py is required for topic schema support") from exc
        try:
            message_cls = get_message(type_name)
        except (AttributeError, ModuleNotFoundError, ValueError) as exc:
            raise RuntimeError(f"failed to import message type '{type_name}'") from exc
        schema = messages.describe_message_type(message_cls)
        example = messages.message_value_to_primitive(message_cls())
        return {
            "type": type_name,
            "fields": schema,
            "example": example,
        }

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
                entries.append({"name": name, "qos": qos})
            return entries

        return {
            "topic": topic,
            "types": list(snapshot.topics.get(topic, ())),
            "publishers": _sort_entries(publishers),
            "subscribers": _sort_entries(subscribers),
            "peer": peer,
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
            if entry and now - entry.get("timestamp", 0.0) < self._metrics_cache_ttl:
                cached_copy = dict(entry["data"])
                cached_copy["cached"] = True
                return cached_copy

        metrics = self._collect_topic_metrics(topic, type_names, duration)
        metrics["cached"] = False
        stored_copy = dict(metrics)

        with self._metrics_lock:
            self._metrics_cache[cache_key] = {
                "timestamp": time.monotonic(),
                "data": stored_copy,
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
            raise RuntimeError("rosidl_runtime_py is required for topic tools") from exc

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
            "count": 0,
            "bytes": 0,
            "intervals": [],
            "first_stamp": None,
            "last_stamp": None,
            "max_bytes": 0,
            "min_bytes": None,
            "type": type_name,
        }

        def _callback(msg) -> None:
            now = time.monotonic()
            if stats["count"] == 0:
                stats["first_stamp"] = now
            else:
                interval = now - stats["last_stamp"]
                if interval >= 0:
                    stats["intervals"].append(interval)
            stats["last_stamp"] = now
            stats["count"] += 1
            try:
                message_bytes = serialize_message(msg)
                size = len(message_bytes)
            except Exception:  # pragma: no cover - defensive
                size = None
            if size is not None:
                stats["bytes"] += size
                stats["max_bytes"] = max(stats["max_bytes"], size)
                stats["min_bytes"] = size if stats["min_bytes"] is None else min(stats["min_bytes"], size)

        executor = None
        probe = None
        subscription = None
        start_time = time.monotonic()
        try:
            context.init(args=None)
            executor = SingleThreadedExecutor(context=context)
            probe = rclpy.create_node(
                "ros2graph_explorer_metrics_probe",
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
        count = stats["count"]
        intervals: List[float] = stats["intervals"]

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
        elif count and stats["first_stamp"] is not None and stats["last_stamp"] is not None:
            elapsed = max(stats["last_stamp"] - stats["first_stamp"], 1e-6)
            average_hz = count / elapsed

        average_bps: Optional[float] = None
        average_bytes_per_msg: Optional[float] = None
        if stats["bytes"] and total_elapsed > 0:
            average_bps = stats["bytes"] / total_elapsed
            if count:
                average_bytes_per_msg = stats["bytes"] / count

        result: Dict[str, object] = {
            "topic": topic,
            "type": type_name,
            "duration": total_elapsed,
            "message_count": count,
            "average_hz": average_hz,
            "min_hz": min_hz,
            "max_hz": max_hz,
            "average_bps": average_bps,
            "average_bytes_per_msg": average_bytes_per_msg,
            "max_bytes": stats["max_bytes"] or None,
            "min_bytes": stats["min_bytes"],
        }

        if count == 0:
            result["warning"] = "No messages received during measurement window"

        return result

    def _prune_metrics_cache(self, snapshot: GraphSnapshot) -> None:
        valid_topics = set(snapshot.topics.keys())
        with self._metrics_lock:
            stale_keys = [key for key in self._metrics_cache.keys() if key[0] not in valid_topics]
            for key in stale_keys:
                self._metrics_cache.pop(key, None)

    def shutdown(self) -> None:
        with self._echo_lock:
            for aggregator in self._echo_aggregators.values():
                aggregator.destroy()
            self._echo_aggregators.clear()
            self._echo_streams.clear()


__all__ = ["TopicToolService", "TopicEchoAggregator"]
