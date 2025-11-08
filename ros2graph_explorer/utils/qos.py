from __future__ import annotations

from typing import List

from rclpy.qos import QoSProfile


def format_qos(profile: QoSProfile | None) -> str:
    if profile is None:
        return ""

    parts: List[str] = []
    if profile.reliability is not None:
        parts.append(profile.reliability.name)
    if profile.durability is not None:
        parts.append(profile.durability.name)
    if profile.history is not None:
        parts.append(profile.history.name)
    if getattr(profile, "depth", None) not in (None, 0):
        parts.append(f"depth={profile.depth}")

    return "/".join(parts)
