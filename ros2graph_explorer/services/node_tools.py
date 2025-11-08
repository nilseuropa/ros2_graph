from __future__ import annotations

import json
import time
from typing import Dict, List, Optional, Tuple

from rclpy.node import Node

try:
    from rcl_interfaces.srv import (  # type: ignore
        DescribeParameters,
        GetParameters,
        ListParameters,
        SetParameters,
    )
except ImportError:  # pragma: no cover - allows docs/tests without ROS deps
    DescribeParameters = None  # type: ignore[assignment]
    GetParameters = None  # type: ignore[assignment]
    ListParameters = None  # type: ignore[assignment]
    SetParameters = None  # type: ignore[assignment]

from ..graph import GraphSnapshot
from ..tools import messages, parameters
from ..utils import fully_qualified_node_name, split_node_fqn


_PARAMETER_NAME_MAP = {
    "not set": parameters.PARAMETER_NOT_SET,
    "not_set": parameters.PARAMETER_NOT_SET,
    "unset": parameters.PARAMETER_NOT_SET,
    "bool": parameters.PARAMETER_BOOL,
    "boolean": parameters.PARAMETER_BOOL,
    "integer": parameters.PARAMETER_INTEGER,
    "int": parameters.PARAMETER_INTEGER,
    "double": parameters.PARAMETER_DOUBLE,
    "float": parameters.PARAMETER_DOUBLE,
    "string": parameters.PARAMETER_STRING,
    "str": parameters.PARAMETER_STRING,
    "bytes": parameters.PARAMETER_BYTE_ARRAY,
    "byte_array": parameters.PARAMETER_BYTE_ARRAY,
    "bool[]": parameters.PARAMETER_BOOL_ARRAY,
    "bool_array": parameters.PARAMETER_BOOL_ARRAY,
    "int[]": parameters.PARAMETER_INTEGER_ARRAY,
    "integer_array": parameters.PARAMETER_INTEGER_ARRAY,
    "double[]": parameters.PARAMETER_DOUBLE_ARRAY,
    "float[]": parameters.PARAMETER_DOUBLE_ARRAY,
    "double_array": parameters.PARAMETER_DOUBLE_ARRAY,
    "float_array": parameters.PARAMETER_DOUBLE_ARRAY,
    "string[]": parameters.PARAMETER_STRING_ARRAY,
    "string_array": parameters.PARAMETER_STRING_ARRAY,
}


def _parameter_type_from_string(value: str) -> Optional[int]:
    if not value:
        return None
    key = value.strip().lower()
    return _PARAMETER_NAME_MAP.get(key)


class NodeToolService:
    def __init__(self, node: Node, *, parameter_timeout: float) -> None:
        self._node = node
        self._parameter_service_timeout = parameter_timeout
        self._snapshot: Optional[GraphSnapshot] = None

    def set_snapshot(self, snapshot: GraphSnapshot) -> None:
        self._snapshot = snapshot

    def handle_request(
        self,
        action: str,
        node_name: str,
        payload: Optional[Dict[str, object]] = None,
    ) -> Tuple[int, Dict[str, object]]:
        action = (action or "").lower()
        if action not in {
            "services",
            "parameters",
            "set_parameter",
            "describe_parameter",
            "describe_service",
            "call_service",
        }:
            return 400, {"error": f"unsupported action '{action}'"}

        snapshot = self._snapshot
        if snapshot is None:
            return 503, {"error": "graph not ready yet"}

        if node_name not in snapshot.nodes:
            return 404, {"error": f"node '{node_name}' not found"}

        namespace, base = split_node_fqn(node_name)

        if action == "services":
            return self._handle_services(namespace, base, node_name, action)

        if action == "parameters":
            return self._handle_parameters(namespace, base, node_name, action)

        if action == "describe_service":
            return self._handle_describe_service(namespace, base, node_name, payload, action)

        if action == "call_service":
            return self._handle_call_service(namespace, base, node_name, payload, action)

        if action == "describe_parameter":
            return self._handle_describe_parameter(namespace, base, node_name, payload, action)

        if action == "set_parameter":
            return self._handle_set_parameter(namespace, base, node_name, payload, action)

        return 400, {"error": f"unsupported action '{action}'"}

    def _handle_services(
        self,
        namespace: str,
        base: str,
        node_name: str,
        action: str,
    ) -> Tuple[int, Dict[str, object]]:
        try:
            entries = self._node.get_service_names_and_types_by_node(base, namespace)
        except Exception as exc:  # pragma: no cover - defensive
            self._node.get_logger().warning(f"Failed to fetch services for {node_name}: {exc}")
            return 500, {"error": str(exc)}

        services_data = [
            {
                "name": service_name,
                "types": list(types),
            }
            for service_name, types in sorted(entries, key=lambda item: item[0])
        ]

        return 200, {
            "action": action,
            "node": node_name,
            "namespace": namespace,
            "base": base,
            "services": services_data,
            "count": len(services_data),
        }

    def _handle_parameters(
        self,
        namespace: str,
        base: str,
        node_name: str,
        action: str,
    ) -> Tuple[int, Dict[str, object]]:
        if ListParameters is None or GetParameters is None:
            return 503, {"error": "parameter services unavailable"}

        try:
            parameters_data = self._collect_parameters_for_node(base, namespace)
        except TimeoutError as exc:
            self._node.get_logger().warning(f"Parameter query timed out for {node_name}: {exc}")
            return 504, {"error": str(exc)}
        except Exception as exc:  # pragma: no cover - defensive
            self._node.get_logger().warning(f"Failed to fetch parameters for {node_name}: {exc}")
            return 500, {"error": str(exc)}

        parameters_data.sort(key=lambda item: item["name"])

        return 200, {
            "action": action,
            "node": node_name,
            "namespace": namespace,
            "base": base,
            "parameters": parameters_data,
            "count": len(parameters_data),
        }

    def _handle_describe_service(
        self,
        namespace: str,
        base: str,
        node_name: str,
        payload: Optional[Dict[str, object]],
        action: str,
    ) -> Tuple[int, Dict[str, object]]:
        details = dict(payload or {})
        service_name = str(details.get("service") or "").strip()
        service_type_hint = str(details.get("type") or "").strip()
        if not service_name:
            return 400, {"error": "missing service name"}
        try:
            service_info = self._describe_service_for_node(base, namespace, service_name, service_type_hint)
        except ValueError as exc:
            return 404, {"error": str(exc)}
        except RuntimeError as exc:
            message = str(exc)
            status = 503 if "rosidl_runtime_py" in message else 500
            return status, {"error": message}
        except Exception as exc:  # pragma: no cover - defensive
            return 500, {"error": str(exc)}
        return 200, {
            "action": action,
            "node": node_name,
            "namespace": namespace,
            "base": base,
            "service": service_info,
        }

    def _handle_call_service(
        self,
        namespace: str,
        base: str,
        node_name: str,
        payload: Optional[Dict[str, object]],
        action: str,
    ) -> Tuple[int, Dict[str, object]]:
        details = dict(payload or {})
        service_name = str(details.get("service") or "").strip()
        service_type_hint = str(details.get("type") or "").strip()
        request_payload = details.get("request")
        if not service_name:
            return 400, {"error": "missing service name"}
        if not isinstance(request_payload, dict):
            return 400, {"error": "service request must be an object"}
        try:
            resolved_type, response_data, response_text = self._call_service_for_node(
                base,
                namespace,
                service_name,
                service_type_hint,
                request_payload,
            )
        except TimeoutError as exc:
            return 504, {"error": str(exc)}
        except ValueError as exc:
            return 400, {"error": str(exc)}
        except RuntimeError as exc:
            message = str(exc)
            status = 503 if "rosidl_runtime_py" in message else 500
            return status, {"error": message}
        except Exception as exc:  # pragma: no cover - defensive
            return 500, {"error": str(exc)}
        return 200, {
            "action": action,
            "node": node_name,
            "namespace": namespace,
            "base": base,
            "service": {
                "name": service_name,
                "type": resolved_type,
            },
            "request": request_payload,
            "response": response_data,
            "response_text": response_text,
        }

    def _handle_describe_parameter(
        self,
        namespace: str,
        base: str,
        node_name: str,
        payload: Optional[Dict[str, object]],
        action: str,
    ) -> Tuple[int, Dict[str, object]]:
        if DescribeParameters is None:
            return 503, {"error": "parameter description service unavailable"}
        details = dict(payload or {})
        parameter_name = str(details.get("name") or "").strip()
        if not parameter_name:
            return 400, {"error": "missing parameter name"}
        try:
            descriptor = self._describe_parameter_for_node(base, namespace, parameter_name)
        except TimeoutError as exc:
            return 504, {"error": str(exc)}
        except ValueError as exc:
            return 404, {"error": str(exc)}
        except RuntimeError as exc:
            return 503, {"error": str(exc)}
        except Exception as exc:  # pragma: no cover - defensive
            return 500, {"error": str(exc)}
        return 200, {
            "action": action,
            "node": node_name,
            "namespace": namespace,
            "base": base,
            "parameter": descriptor,
        }

    def _handle_set_parameter(
        self,
        namespace: str,
        base: str,
        node_name: str,
        payload: Optional[Dict[str, object]],
        action: str,
    ) -> Tuple[int, Dict[str, object]]:
        if SetParameters is None:
            return 503, {"error": "parameter update service unavailable"}
        details = dict(payload or {})
        parameter_name = str(details.get("name") or "").strip()
        if not parameter_name:
            return 400, {"error": "missing parameter name"}
        type_id = details.get("type")
        if type_id is None:
            type_id = details.get("type_id")
        if isinstance(type_id, str):
            text = type_id.strip()
            if text.isdigit():
                type_id = int(text, 10)
            else:
                type_id = _parameter_type_from_string(text)
        raw_value = details.get("value")
        if not isinstance(type_id, int):
            return 400, {"error": "invalid or missing parameter type"}
        try:
            parsed_value = parameters.parse_parameter_input(type_id, raw_value)
        except ValueError as exc:
            return 400, {"error": str(exc)}
        try:
            success, reason = self._set_parameter_for_node(
                base,
                namespace,
                parameter_name,
                type_id,
                parsed_value,
            )
        except TimeoutError as exc:
            return 504, {"error": str(exc)}
        except RuntimeError as exc:
            return 503, {"error": str(exc)}
        except Exception as exc:  # pragma: no cover - defensive
            return 500, {"error": str(exc)}
        return 200, {
            "action": action,
            "node": node_name,
            "namespace": namespace,
            "base": base,
            "parameter": parameter_name,
            "success": success,
            "reason": reason,
        }

    def _collect_parameters_for_node(self, base: str, namespace: str) -> List[Dict[str, object]]:
        if ListParameters is None or GetParameters is None:
            raise RuntimeError("parameter services unavailable (rcl_interfaces missing)")

        fully_qualified = fully_qualified_node_name(namespace, base)
        list_service = f"{fully_qualified}/list_parameters"
        list_request = ListParameters.Request()
        list_request.depth = 0

        list_response = self._call_parameter_service(
            ListParameters,
            list_service,
            list_request,
            timeout=self._parameter_service_timeout,
        )
        result = getattr(list_response, "result", None)
        names = list((getattr(result, "names", []) or [])) if result is not None else []

        names = sorted(set(names))
        if not names:
            return []

        get_service = f"{fully_qualified}/get_parameters"
        get_request = GetParameters.Request()
        get_request.names = list(names)
        get_response = self._call_parameter_service(
            GetParameters,
            get_service,
            get_request,
            timeout=self._parameter_service_timeout,
        )

        values = list(getattr(get_response, "values", []) or [])
        parameters_data: List[Dict[str, object]] = []
        for name, value in zip(names, values):
            type_id = getattr(value, "type", None)
            full_text = parameters.stringify_parameter_value(type_id, value)
            display_value = parameters.truncate_parameter_display(full_text)
            parameters_data.append(
                {
                    "name": name,
                    "type": parameters.parameter_type_label(type_id),
                    "type_id": int(type_id) if isinstance(type_id, int) else None,
                    "value": display_value,
                    "raw_value": full_text,
                }
            )

        return parameters_data

    def _describe_parameter_for_node(
        self,
        base: str,
        namespace: str,
        name: str,
    ) -> Optional[Dict[str, object]]:
        if DescribeParameters is None:
            raise RuntimeError("parameter description service unavailable")
        fully_qualified = fully_qualified_node_name(namespace, base)
        describe_service = f"{fully_qualified}/describe_parameters"
        request = DescribeParameters.Request()
        request.names = [name]

        response = self._call_parameter_service(
            DescribeParameters,
            describe_service,
            request,
            timeout=self._parameter_service_timeout,
        )
        descriptors = list(getattr(response, "descriptors", []) or [])
        if not descriptors:
            return None
        descriptor = descriptors[0]
        return parameters.parameter_descriptor_to_dict(descriptor)

    def _describe_service_for_node(
        self,
        base: str,
        namespace: str,
        service_name: str,
        service_type_hint: str = "",
    ) -> Dict[str, object]:
        try:
            entries = self._node.get_service_names_and_types_by_node(base, namespace)
        except Exception as exc:  # pragma: no cover - defensive
            raise RuntimeError(f"failed to fetch services for node: {exc}") from exc

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
            raise RuntimeError("rosidl_runtime_py is required for service tools") from exc

        try:
            service_cls = get_service(service_type)
        except (AttributeError, ModuleNotFoundError, ValueError) as exc:
            raise RuntimeError(f"failed to import service type '{service_type}'") from exc

        request_cls = getattr(service_cls, "Request", None)
        if request_cls is None:
            raise RuntimeError(f"service '{service_type}' has no Request definition")

        request_schema = messages.describe_message_type(request_cls)
        request_example = messages.message_value_to_primitive(request_cls())

        return {
            "name": service_name,
            "type": service_type,
            "types": matching_types or [service_type],
            "request": {
                "fields": request_schema,
                "example": request_example,
            },
        }

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
            raise RuntimeError(f"failed to prepare service call: {exc}") from exc

        service_type = str(service_info.get("type") or "")
        if not service_type:
            raise RuntimeError("unable to determine service type")

        try:
            from rosidl_runtime_py.utilities import get_service  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError("rosidl_runtime_py is required for service calls") from exc

        try:
            service_cls = get_service(service_type)
        except (AttributeError, ModuleNotFoundError, ValueError) as exc:
            raise RuntimeError(f"failed to import service type '{service_type}'") from exc

        request_cls = getattr(service_cls, "Request", None)
        response_cls = getattr(service_cls, "Response", None)
        if request_cls is None or response_cls is None:
            raise RuntimeError(f"service '{service_type}' is missing request/response definitions")

        try:
            from rosidl_runtime_py import set_message_fields  # type: ignore
        except ImportError:
            try:  # pragma: no cover - compatibility
                from rosidl_runtime_py.set_message_fields import set_message_fields  # type: ignore
            except ImportError as exc:
                raise RuntimeError("rosidl_runtime_py.set_message_fields is required for service calls") from exc

        request_message = request_cls()
        try:
            set_message_fields(request_message, dict(payload))
        except Exception as exc:
            raise ValueError(f"invalid request payload: {exc}") from exc

        service_fqn = self._resolve_service_name(namespace, base, service_name)
        response = self._call_parameter_service(  # reuse generic service call helper
            service_cls,
            service_fqn,
            request_message,
            timeout=self._parameter_service_timeout,
        )
        primitive = messages.message_value_to_primitive(response)
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
            raise RuntimeError("parameter update service unavailable")
        fully_qualified = fully_qualified_node_name(namespace, base)
        set_service = f"{fully_qualified}/set_parameters"
        request = SetParameters.Request()
        try:
            request.parameters = [parameters.make_parameter_message(name, type_id, value)]
        except ValueError as exc:
            raise ValueError(f"failed to construct parameter message: {exc}") from exc

        response = self._call_parameter_service(
            SetParameters,
            set_service,
            request,
            timeout=self._parameter_service_timeout,
        )
        results = list(getattr(response, "results", []) or [])
        if not results:
            return False, "no response from set_parameters"
        result = results[0]
        success = bool(getattr(result, "successful", False))
        reason = str(getattr(result, "reason", "") or "")
        return success, reason

    def _call_parameter_service(self, srv_type, service_name: str, request, timeout: Optional[float] = None):
        client = self._node.create_client(srv_type, service_name)
        deadline_timeout = timeout
        if deadline_timeout is None:
            deadline_timeout = getattr(self, "_parameter_service_timeout", 5.0)
        deadline_timeout = max(float(deadline_timeout), 0.1)
        try:
            if not client.wait_for_service(timeout_sec=deadline_timeout):
                raise TimeoutError(f"service {service_name} unavailable")
            future = client.call_async(request)

            deadline = time.monotonic() + max(deadline_timeout, 0.1)
            while True:
                if future.done():
                    if future.cancelled():
                        raise RuntimeError(f"service call to {service_name} was cancelled")
                    exc = future.exception()
                    if exc is not None:
                        raise exc
                    return future.result()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    future.cancel()
                    raise TimeoutError(f"service {service_name} timed out")
                time.sleep(min(0.05, remaining))
        finally:
            try:
                self._node.destroy_client(client)
            except Exception:  # pragma: no cover - defensive
                pass

    def _resolve_service_name(self, namespace: str, base: str, service_name: str) -> str:
        if not service_name:
            return service_name
        if service_name.startswith("/"):
            return service_name
        node_fqn = fully_qualified_node_name(namespace, base)
        return f"{node_fqn}/{service_name}".replace("//", "/")


__all__ = ["NodeToolService"]
