from __future__ import annotations

from typing import Tuple


def fully_qualified_node_name(namespace: str, node_name: str) -> str:
    namespace = namespace or "/"
    if not namespace.startswith("/"):
        namespace = "/" + namespace
    namespace = namespace.rstrip("/")
    if not namespace:
        namespace = "/"
    if namespace == "/":
        return f"/{node_name}".replace("//", "/")
    return f"{namespace}/{node_name}".replace("//", "/")


def split_node_fqn(node_name: str) -> Tuple[str, str]:
    name = node_name or ""
    if not name.startswith("/"):
        name = "/" + name if name else "/"
    if name == "/":
        return "/", ""
    namespace, _, base = name.rpartition("/")
    if not namespace:
        namespace = "/"
    base = base or namespace.strip("/") or ""
    if not base:
        base = name.lstrip("/") or name or ""
    return namespace or "/", base
