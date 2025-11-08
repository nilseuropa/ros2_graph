from __future__ import annotations

import json
from typing import Dict, List, Optional, Set

try:
    from rosidl_runtime_py.convert import message_to_ordereddict  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    message_to_ordereddict = None  # type: ignore[assignment]

ELLIPSIS = "…"


def stringify_echo_value(value: object, limit: int = 256) -> str:
    if isinstance(value, (bytes, bytearray)):
        text = "0x" + bytes(value).hex()
    elif isinstance(value, str):
        text = value
    elif isinstance(value, (int, float, bool)) or value is None:
        text = str(value)
    else:
        try:
            text = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):  # pragma: no cover - defensive
            text = str(value)
    if len(text) > limit:
        return text[: max(0, limit - 1)] + ELLIPSIS
    return text


def build_echo_data_rows(value: object, limit: int = 256) -> List[Dict[str, object]]:
    rows: List[Dict[str, object]] = []

    def walk(current: object, label: Optional[str], depth: int) -> None:
        if isinstance(current, dict):
            entries = list(current.items())
            if label is not None:
                rows.append(
                    {
                        "depth": depth,
                        "label": str(label),
                        "value": "" if entries else "(empty)",
                    }
                )
                next_depth = depth + 1
            else:
                next_depth = depth
            if entries:
                for key, child in entries:
                    walk(child, key, next_depth)
            elif label is None:
                rows.append({"depth": depth, "label": "", "value": "(empty)"})
            return

        if isinstance(current, (list, tuple)):
            items = list(current)
            if label is not None:
                rows.append(
                    {
                        "depth": depth,
                        "label": str(label),
                        "value": "" if items else "(empty)",
                    }
                )
                next_depth = depth + 1
            else:
                next_depth = depth
            if items:
                for index, item in enumerate(items):
                    walk(item, f"[{index}]", next_depth)
            elif label is None:
                rows.append({"depth": depth, "label": "", "value": "(empty)"})
            return

        text = stringify_echo_value(current, limit=limit)
        rows.append(
            {
                "depth": depth,
                "label": "" if label is None else str(label),
                "value": text,
            }
        )

    walk(value, None, 0)
    return rows


def convert_message_to_primitive(msg: object) -> object:
    if msg is None:
        return None
    if message_to_ordereddict is not None:
        try:
            return message_to_ordereddict(msg)
        except Exception:  # pragma: no cover - defensive
            pass
    if isinstance(msg, (str, int, float, bool)):
        return msg
    if isinstance(msg, (bytes, bytearray)):
        return list(msg)
    if isinstance(msg, (list, tuple)):
        return [convert_message_to_primitive(item) for item in msg]
    if hasattr(msg, "__slots__"):
        result: Dict[str, object] = {}
        for slot_name in getattr(type(msg), "__slots__", []):
            attr = slot_name.lstrip("_")
            try:
                value = getattr(msg, attr)
            except AttributeError:
                continue
            result[attr] = convert_message_to_primitive(value)
        return result
    return str(msg)


def message_value_to_primitive(value: object) -> object:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (bytes, bytearray)):
        return list(value)
    if isinstance(value, dict):
        return {key: message_value_to_primitive(val) for key, val in value.items()}
    if isinstance(value, (list, tuple)):
        return [message_value_to_primitive(item) for item in value]
    if hasattr(value, "__slots__"):
        result: Dict[str, object] = {}
        for slot_name in getattr(type(value), "__slots__", []):
            attr = slot_name.lstrip("_")
            if not attr:
                continue
            try:
                slot_value = getattr(value, attr)
            except AttributeError:
                continue
            result[attr] = message_value_to_primitive(slot_value)
        return result
    try:
        return list(value)
    except TypeError:
        return str(value)


def describe_message_type(message_cls, visited: Optional[Set[str]] = None) -> List[Dict[str, object]]:
    from .services import (
        get_message_class_for_slot,
        rosidl_slot_array_size,
        rosidl_slot_is_array,
        rosidl_slot_is_basic,
        rosidl_slot_maximum_size,
        rosidl_slot_type_to_string,
        rosidl_slot_value_type,
    )

    if message_cls is None:
        return []
    if visited is None:
        visited = set()
    key = f"{message_cls.__module__}.{message_cls.__name__}"
    if key in visited:
        return []
    next_visited = set(visited)
    next_visited.add(key)
    descriptors: List[Dict[str, object]] = []
    instance = message_cls()
    slot_names = [name.lstrip("_") for name in getattr(message_cls, "__slots__", [])]
    slot_types = list(getattr(message_cls, "SLOT_TYPES", []))
    for field_name, slot_type in zip(slot_names, slot_types):
        try:
            try:
                default_value = getattr(instance, field_name)
            except AttributeError:
                default_value = None
            descriptor: Dict[str, object] = {
                "name": field_name,
                "type": rosidl_slot_type_to_string(slot_type),
                "is_array": False,
                "array_size": None,
                "max_size": None,
                "is_basic": False,
                "default": message_value_to_primitive(default_value),
            }
            if rosidl_slot_is_array(slot_type):
                descriptor["is_array"] = True
                descriptor["array_size"] = rosidl_slot_array_size(slot_type)
                max_size = rosidl_slot_maximum_size(slot_type)
                if max_size:
                    descriptor["max_size"] = max_size
                value_type = rosidl_slot_value_type(slot_type)
                if value_type is not None:
                    descriptor["element_type"] = rosidl_slot_type_to_string(value_type)
                    descriptor["element_is_basic"] = bool(rosidl_slot_is_basic(value_type))
                    if not descriptor["element_is_basic"]:
                        element_cls = get_message_class_for_slot(value_type)
                        if element_cls is not None:
                            descriptor["element_schema"] = describe_message_type(element_cls, next_visited)
                            descriptor["element_example"] = message_value_to_primitive(element_cls())
                else:
                    descriptor["element_type"] = "unknown"
            else:
                if rosidl_slot_is_basic(slot_type):
                    descriptor["is_basic"] = True
                    descriptor["base_type"] = rosidl_slot_type_to_string(slot_type)
                else:
                    descriptor["base_type"] = rosidl_slot_type_to_string(slot_type)
                    nested_cls = get_message_class_for_slot(slot_type)
                    if nested_cls is not None:
                        descriptor["children"] = describe_message_type(nested_cls, next_visited)
            descriptors.append(descriptor)
        except ValueError as error:
            descriptors.append(
                {
                    "name": field_name,
                    "type": "unknown",
                    "error": str(error),
                }
            )
    return descriptors


__all__ = [
    "build_echo_data_rows",
    "convert_message_to_primitive",
    "describe_message_type",
    "message_value_to_primitive",
    "stringify_echo_value",
]
