"""What the host sends the engine, parsed with the engine's own parsers.

`apps/scheduler/test/host-shapes.test.ts` runs a real scheduler against a fake guest and writes what the host sent
(the events of `POST /events`, the config of `PUT /config`) into `host_wire_shapes.json`. The engine is Python and
cannot import the host's schemas, so this is the other half of the contract (`test_wire_shapes.py` is the half the
engine writes): every event and every config in that file must be accepted, and must come out of the parse with every
key the host sent, so a key the host adds and the engine drops (or one it renames) fails here and not in a Dot.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from nanobot.dots.protocol import INBOUND_EVENT_TYPES, parse_inbound_event, parse_runtime_config
from nanobot.dots.secrets import KeyHolder, McpSecrets

SHAPES = json.loads(Path(__file__).with_name("host_wire_shapes.json").read_text(encoding="utf-8"))
TS = "2026-10-06T09:00:00.000Z"


def _event(index: int, shape: dict[str, Any]) -> dict[str, Any]:
    return {"id": f"evt_{index}", "ts": TS, "type": shape["type"], "data": shape["data"]}


@pytest.mark.parametrize("index", range(len(SHAPES["inbound_events"])))
def test_every_event_the_host_sends_is_accepted_with_every_key_it_carries(index: int) -> None:
    shape = SHAPES["inbound_events"][index]

    parsed = parse_inbound_event(_event(index, shape))

    assert parsed.type == shape["type"]
    assert parsed.data.model_dump(exclude_none=True) == shape["data"]


def test_the_file_holds_one_event_of_every_type_the_host_sends() -> None:
    assert {shape["type"] for shape in SHAPES["inbound_events"]} == set(INBOUND_EVENT_TYPES)


@pytest.mark.parametrize("name", [entry["name"] for entry in SHAPES["runtime_configs"]])
def test_every_config_the_host_pushes_is_accepted_with_every_key_it_carries(name: str) -> None:
    config = next(entry["config"] for entry in SHAPES["runtime_configs"] if entry["name"] == name)

    parsed = parse_runtime_config(config)

    assert parsed.model_dump(mode="json", exclude_none=True) == config


@pytest.mark.parametrize("index", range(len(SHAPES["secrets_requests"])))
def test_every_secrets_push_of_the_host_is_held_whole(index: int) -> None:
    body = SHAPES["secrets_requests"][index]
    keys, mcp = KeyHolder(), McpSecrets()

    keys.set(body["openrouter_api_key"])
    mcp.set(body["mcp_secrets"])

    assert set(body) == {"openrouter_api_key", "mcp_secrets"}
    assert {server: mcp.of(server) for server in body["mcp_secrets"]} == body["mcp_secrets"]


def test_the_full_config_declares_both_kinds_of_mcp_server() -> None:
    full = parse_runtime_config(next(entry["config"] for entry in SHAPES["runtime_configs"] if entry["name"] == "shapes-full"))

    assert [type(server).__name__ for server in full.mcp_servers.values()] == ["McpStdioServer", "McpHttpServer"]
