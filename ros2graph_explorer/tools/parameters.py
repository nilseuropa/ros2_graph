from __future__ import annotations

import json
from typing import Dict, List, Optional

try:
    from rcl_interfaces.msg import (
        Parameter,
        ParameterDescriptor,
        ParameterType,
        ParameterValue,
    )  # type: ignore
except ImportError:  # pragma: no cover - allows docs/tests without ROS deps
    Parameter = None  # type: ignore[assignment]
    ParameterDescriptor = None  # type: ignore[assignment]
    ParameterType = None  # type: ignore[assignment]
    ParameterValue = None  # type: ignore[assignment]


PARAMETER_NOT_SET = getattr(ParameterType, "PARAMETER_NOT_SET", 0)
PARAMETER_BOOL = getattr(ParameterType, "PARAMETER_BOOL", 1)
PARAMETER_INTEGER = getattr(ParameterType, "PARAMETER_INTEGER", 2)
PARAMETER_DOUBLE = getattr(ParameterType, "PARAMETER_DOUBLE", 3)
PARAMETER_STRING = getattr(ParameterType, "PARAMETER_STRING", 4)
PARAMETER_BYTE_ARRAY = getattr(ParameterType, "PARAMETER_BYTE_ARRAY", 5)
PARAMETER_BOOL_ARRAY = getattr(ParameterType, "PARAMETER_BOOL_ARRAY", 6)
PARAMETER_INTEGER_ARRAY = getattr(ParameterType, "PARAMETER_INTEGER_ARRAY", 7)
PARAMETER_DOUBLE_ARRAY = getattr(ParameterType, "PARAMETER_DOUBLE_ARRAY", 8)
PARAMETER_STRING_ARRAY = getattr(ParameterType, "PARAMETER_STRING_ARRAY", 9)

PARAMETER_DISPLAY_MAX = 32


def parameter_type_label(param_type: Optional[int]) -> str:
    if param_type is None:
        return ""
    mapping = {
        PARAMETER_NOT_SET: "not set",
        PARAMETER_BOOL: "bool",
        PARAMETER_INTEGER: "integer",
        PARAMETER_DOUBLE: "double",
        PARAMETER_STRING: "string",
        PARAMETER_BYTE_ARRAY: "bytes",
        PARAMETER_BOOL_ARRAY: "bool[]",
        PARAMETER_INTEGER_ARRAY: "int[]",
        PARAMETER_DOUBLE_ARRAY: "double[]",
        PARAMETER_STRING_ARRAY: "string[]",
    }
    return mapping.get(param_type, f"unknown({param_type})")


def parameter_value_to_python(param_type: Optional[int], param_value: object) -> object:
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


def stringify_parameter_value(param_type: Optional[int], param_value: object) -> str:
    value = parameter_value_to_python(param_type, param_value)
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, bytes):
        return "0x" + value.hex()
    if isinstance(value, (list, tuple)):
        try:
            return json.dumps(value, ensure_ascii=False)
        except TypeError:  # pragma: no cover - defensive
            return "[" + ", ".join(str(item) for item in value) + "]"
    if isinstance(value, dict):
        try:
            return json.dumps(value, ensure_ascii=False)
        except TypeError:  # pragma: no cover - defensive
            return str(value)
    return str(value)


def truncate_parameter_display(value: str, limit: int = PARAMETER_DISPLAY_MAX) -> str:
    text = value or ""
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3] + "..."


def parameter_descriptor_to_dict(descriptor) -> Optional[Dict[str, object]]:
    if descriptor is None:
        return None
    data: Dict[str, object] = {}
    name = getattr(descriptor, "name", "") or ""
    if name:
        data["name"] = str(name)
    type_id = getattr(descriptor, "type", None)
    if isinstance(type_id, int):
        data["type_id"] = type_id
        data["type"] = parameter_type_label(type_id)
    description = getattr(descriptor, "description", "") or ""
    if description:
        data["description"] = str(description)
    constraints = getattr(descriptor, "additional_constraints", "") or ""
    if constraints:
        data["additional_constraints"] = str(constraints)
    data["read_only"] = bool(getattr(descriptor, "read_only", False))
    data["dynamic_typing"] = bool(getattr(descriptor, "dynamic_typing", False))

    integer_ranges = []
    for item in list(getattr(descriptor, "integer_range", []) or []):
        integer_ranges.append(
            {
                "from_value": int(getattr(item, "from_value", 0)),
                "to_value": int(getattr(item, "to_value", 0)),
                "step": int(getattr(item, "step", 0)),
            }
        )
    if integer_ranges:
        data["integer_ranges"] = integer_ranges

    float_ranges = []
    for item in list(getattr(descriptor, "floating_point_range", []) or []):
        float_ranges.append(
            {
                "from_value": float(getattr(item, "from_value", 0.0)),
                "to_value": float(getattr(item, "to_value", 0.0)),
                "step": float(getattr(item, "step", 0.0)),
            }
        )
    if float_ranges:
        data["floating_point_ranges"] = float_ranges

    return data


def parse_parameter_input(param_type: Optional[int], raw_value: object) -> object:
    if not isinstance(param_type, int):
        raise ValueError("unknown parameter type")

    def _coerce_bool(value: object) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            text = value.strip().lower()
            if text in {"true", "1", "yes", "on"}:
                return True
            if text in {"false", "0", "no", "off"}:
                return False
        raise ValueError("expected boolean value")

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
                raise ValueError("expected JSON array") from exc
            if not isinstance(parsed, list):
                raise ValueError("expected JSON array")
            return list(parsed)
        raise ValueError("expected array value")

    if param_type == PARAMETER_NOT_SET:
        return None
    if param_type == PARAMETER_BOOL:
        return _coerce_bool(raw_value)
    if param_type == PARAMETER_INTEGER:
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                raise ValueError("expected integer value")
            return int(text, 0)
        if isinstance(raw_value, (int, float)):
            return int(raw_value)
        raise ValueError("expected integer value")
    if param_type == PARAMETER_DOUBLE:
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                raise ValueError("expected floating-point value")
            return float(text)
        if isinstance(raw_value, (int, float)):
            return float(raw_value)
        raise ValueError("expected floating-point value")
    if param_type == PARAMETER_STRING:
        return "" if raw_value is None else str(raw_value)
    if param_type == PARAMETER_BYTE_ARRAY:
        if isinstance(raw_value, (bytes, bytearray)):
            return bytes(raw_value)
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                return bytes()
            if text.startswith("0x"):
                try:
                    return bytes.fromhex(text[2:])
                except ValueError as exc:
                    raise ValueError("expected hex string for byte array") from exc
        items = _ensure_array(raw_value)
        try:
            return bytes(int(item) & 0xFF for item in items)
        except (TypeError, ValueError) as exc:
            raise ValueError("expected array of integers (0-255)") from exc
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
                    raise ValueError("expected integer value")
                result.append(int(text, 0))
            elif isinstance(item, (int, float)):
                result.append(int(item))
            else:
                raise ValueError("expected integer value")
        return result
    if param_type == PARAMETER_DOUBLE_ARRAY:
        items = _ensure_array(raw_value)
        result = []
        for item in items:
            if isinstance(item, str):
                text = item.strip()
                if not text:
                    raise ValueError("expected floating-point value")
                result.append(float(text))
            elif isinstance(item, (int, float)):
                result.append(float(item))
            else:
                raise ValueError("expected floating-point value")
        return result
    if param_type == PARAMETER_STRING_ARRAY:
        items = _ensure_array(raw_value)
        return ["" if item is None else str(item) for item in items]
    raise ValueError(f"unhandled parameter type {param_type}")


def make_parameter_message(name: str, param_type: int, value: object):
    if Parameter is None or ParameterValue is None:
        raise RuntimeError("parameter services unavailable")
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
        value_msg.string_value = "" if value is None else str(value)
    elif param_type == PARAMETER_BYTE_ARRAY:
        value_msg.byte_array_value = list(
            value if isinstance(value, (bytes, bytearray)) else bytes(value)
        )
    elif param_type == PARAMETER_BOOL_ARRAY:
        value_msg.bool_array_value = [bool(item) for item in value]
    elif param_type == PARAMETER_INTEGER_ARRAY:
        value_msg.integer_array_value = [int(item) for item in value]
    elif param_type == PARAMETER_DOUBLE_ARRAY:
        value_msg.double_array_value = [float(item) for item in value]
    elif param_type == PARAMETER_STRING_ARRAY:
        value_msg.string_array_value = ["" if item is None else str(item) for item in value]
    else:
        raise ValueError(f"unhandled parameter type {param_type}")
    param_msg.value = value_msg
    return param_msg


__all__ = [
    "Parameter",
    "ParameterDescriptor",
    "ParameterType",
    "ParameterValue",
    "PARAMETER_BOOL",
    "PARAMETER_BOOL_ARRAY",
    "PARAMETER_BYTE_ARRAY",
    "PARAMETER_DISPLAY_MAX",
    "PARAMETER_DOUBLE",
    "PARAMETER_DOUBLE_ARRAY",
    "PARAMETER_INTEGER",
    "PARAMETER_INTEGER_ARRAY",
    "PARAMETER_NOT_SET",
    "PARAMETER_STRING",
    "PARAMETER_STRING_ARRAY",
    "make_parameter_message",
    "parameter_descriptor_to_dict",
    "parameter_type_label",
    "parameter_value_to_python",
    "parse_parameter_input",
    "stringify_parameter_value",
    "truncate_parameter_display",
]
