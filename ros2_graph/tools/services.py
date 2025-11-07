from __future__ import annotations

from typing import Optional

try:
    from rosidl_parser.definition import (  # type: ignore[attr-defined]
        AbstractSequence,
        Array,
        BasicType,
        NamespacedType,
    )
except ImportError:  # pragma: no cover - optional dependency for service description
    AbstractSequence = None  # type: ignore[assignment]
    Array = None  # type: ignore[assignment]
    BasicType = None  # type: ignore[assignment]
    NamespacedType = None  # type: ignore[assignment]


def rosidl_slot_type_to_string(slot_type) -> str:
    if Array is not None and isinstance(slot_type, Array):
        inner = rosidl_slot_type_to_string(slot_type.value_type)
        return f"array<{inner}, {slot_type.size}>"
    if AbstractSequence is not None and isinstance(slot_type, AbstractSequence):
        inner = rosidl_slot_type_to_string(slot_type.value_type)
        max_size = getattr(slot_type, "maximum_size", None)
        if max_size is not None and max_size > 0:
            return f"sequence<{inner}, {max_size}>"
        return f"sequence<{inner}>"
    if BasicType is not None and isinstance(slot_type, BasicType):
        return slot_type.typename
    if NamespacedType is not None and isinstance(slot_type, NamespacedType):
        parts = []
        namespace = []
        names_attr = None
        for attr_name in ("names", "namespaces"):
            try:
                names_attr = getattr(slot_type, attr_name)
            except AttributeError:
                continue
            else:
                break
        try:
            names = tuple(names_attr or ())
        except ValueError:
            names = ()
        except TypeError:
            names = ()
        namespace.extend(names)
        try:
            base_name = getattr(slot_type, "name", "") or ""
        except AttributeError:
            base_name = ""
        except ValueError:
            base_name = ""
        if base_name:
            parts.append(base_name)
        if parts:
            return "/".join(parts)
        return base_name or "unknown"
    return str(slot_type)


def rosidl_slot_is_basic(slot_type) -> bool:
    return BasicType is not None and isinstance(slot_type, BasicType)


def rosidl_slot_is_array(slot_type) -> bool:
    if Array is not None and isinstance(slot_type, Array):
        return True
    if AbstractSequence is not None and isinstance(slot_type, AbstractSequence):
        return True
    return False


def rosidl_slot_value_type(slot_type):
    if Array is not None and isinstance(slot_type, Array):
        return slot_type.value_type
    if AbstractSequence is not None and isinstance(slot_type, AbstractSequence):
        return slot_type.value_type
    return None


def rosidl_slot_array_size(slot_type) -> Optional[int]:
    if Array is not None and isinstance(slot_type, Array):
        return int(getattr(slot_type, "size", 0)) or 0
    return None


def rosidl_slot_maximum_size(slot_type) -> Optional[int]:
    if Array is not None and isinstance(slot_type, Array):
        return int(getattr(slot_type, "size", 0)) or 0
    if AbstractSequence is not None and isinstance(slot_type, AbstractSequence):
        maximum = getattr(slot_type, "maximum_size", None)
        if maximum is not None and maximum > 0:
            return int(maximum)
    return None


def get_message_class_for_slot(slot_type):
    if NamespacedType is None or not isinstance(slot_type, NamespacedType):
        return None
    names_attr = None
    for attr_name in ("names", "namespaces"):
        try:
            names_attr = getattr(slot_type, attr_name)
        except AttributeError:
            continue
        else:
            break
    try:
        namespace = tuple(names_attr or ())
    except (TypeError, ValueError):
        namespace = ()
    try:
        base_name = getattr(slot_type, "name", "") or ""
    except (AttributeError, ValueError):
        base_name = ""
    if not namespace and not base_name:
        return None
    try:
        from rosidl_runtime_py.utilities import get_message  # type: ignore
    except ImportError:  # pragma: no cover - optional dependency
        return None
    parts = [*namespace]
    if base_name:
        parts.append(base_name)
    type_name = "/".join(parts)
    if not type_name:
        return None
    try:
        return get_message(type_name)
    except (AttributeError, ModuleNotFoundError, ValueError):
        return None


__all__ = [
    "get_message_class_for_slot",
    "rosidl_slot_array_size",
    "rosidl_slot_is_array",
    "rosidl_slot_is_basic",
    "rosidl_slot_maximum_size",
    "rosidl_slot_type_to_string",
    "rosidl_slot_value_type",
]
