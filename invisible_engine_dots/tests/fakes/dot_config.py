"""The Dot config the tests push: a valid body, and the permission map that allows everything."""

from __future__ import annotations

from typing import Any

ALLOW_ALL = {
    "computer.exec": "allow",
    "files.read": "allow",
    "files.write": "allow",
    "automations": "allow",
}


def runtime_config_body(**overrides: Any) -> dict[str, Any]:
    """A valid `PUT /config` body, with top-level fields replaced by `overrides`."""
    body: dict[str, Any] = {
        "name": "fare-watch",
        "model": {"provider": "openrouter", "id": "z-ai/glm-5.3-flash"},
        "permissions": {},
        "limits": {"max_steps_per_task": 60, "max_cost_per_task_usd": 1},
        "mcp_servers": {},
    }
    body.update(overrides)
    return body
