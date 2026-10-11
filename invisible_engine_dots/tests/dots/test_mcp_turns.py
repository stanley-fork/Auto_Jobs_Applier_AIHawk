"""A turn with the MCP servers the person declared: the tools it offers, what its prompt says of each server, the gate
on their calls, the tool table, and the masking of their secrets (nanobot/dots/mcp_servers.py, turns.py, gate.py)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from fakes.fake_tool_server import INSTRUCTIONS, install_fake_tool_server
from fakes.scripted_provider import call, calls, says
from fakes.turn_harness import Harness

from nanobot.dots.conversations import CONVERSATIONS_DIR
from nanobot.dots.permissions import mcp_server_of_tool, offered_mcp_servers, tool_permission
from nanobot.dots.projection import project
from nanobot.dots.protocol import DotsConfigError, parse_runtime_config
from nanobot.dots.turns import TurnUnit

import pytest
from fakes.dot_config import runtime_config_body

MakeHarness = Callable[..., Harness]


def chat_unit() -> TurnUnit:
    return TurnUnit("chat", None)


def server(tmp_path: Path, **fields: Any) -> dict[str, Any]:
    (tmp_path / "bin").mkdir(exist_ok=True)
    return {"command": str(install_fake_tool_server(tmp_path / "bin")), "timeout_s": 30, "startup_timeout_s": 20, **fields}


class TestNames:
    def test_a_tools_server_is_the_name_before_its_first_underscore(self) -> None:
        assert mcp_server_of_tool("mcp_time-zones_get_current_time") == "time-zones"
        assert tool_permission("mcp_time-zones_get_current_time") == "mcp.time-zones"
        assert mcp_server_of_tool("mcp_time") is None
        assert mcp_server_of_tool("read_file") is None
        assert tool_permission("read_file") == "files.read"

    def test_a_server_is_offered_while_its_permission_is_allow_or_ask(self) -> None:
        servers = ["a", "b", "c"]
        assert offered_mcp_servers(servers, {"mcp.a": "allow", "mcp.b": "deny", "mcp.c": "ask"}) == ["a", "c"]
        assert offered_mcp_servers(servers, {}) == []

    def test_the_settings_name_the_servers_offered_by_name(self, tmp_path: Path) -> None:
        body = runtime_config_body(
            mcp_servers={"z": server(tmp_path), "a": server(tmp_path)}, permissions={"mcp.z": "ask", "mcp.a": "ask"}
        )
        settings = project(parse_runtime_config(body), workspace="/w", openrouter_base_url=None)
        assert settings.mcp_servers == ("a", "z")


class TestConfig:
    def test_both_kinds_of_server_are_read_with_their_defaults(self) -> None:
        config = parse_runtime_config(
            runtime_config_body(
                mcp_servers={
                    "time": {"command": "uvx", "args": ["mcp-server-time"], "timeout_s": 120, "startup_timeout_s": 60},
                    "web": {"url": "https://example.com/mcp", "secrets": ["Authorization"], "timeout_s": 60, "startup_timeout_s": 30},
                }
            )
        )
        time, web = config.mcp_servers.values()
        assert (type(time).__name__, time.env, time.secrets) == ("McpStdioServer", {}, [])
        assert (type(web).__name__, web.headers, web.secrets) == ("McpHttpServer", {}, ["Authorization"])

    @pytest.mark.parametrize(
        ("overrides", "problem"),
        [
            ({"mcp_servers": {"Bad_Name": {"command": "x", "timeout_s": 1, "startup_timeout_s": 1}}}, "is not an MCP server name"),
            ({"permissions": {"mcp.ghost": "allow"}}, "does not declare"),
            ({"mcp_servers": {"web": {"url": "ftp://example.com", "timeout_s": 1, "startup_timeout_s": 1}}}, "mcp_servers"),
        ],
    )
    def test_a_server_the_engine_cannot_act_on_is_refused(self, overrides: dict[str, Any], problem: str) -> None:
        with pytest.raises(DotsConfigError, match=problem):
            parse_runtime_config(runtime_config_body(**overrides))


async def test_a_turn_offers_the_tools_of_a_server_it_may_use_and_carries_its_instructions(
    make_harness: MakeHarness, tmp_path: Path
) -> None:
    h = make_harness(
        [calls(call("c1", "mcp_tools_echo", text="hi")), says("done")],
        {"mcp.tools": "allow"},
        mcp_servers={"tools": server(tmp_path), "hidden": server(tmp_path)},
    )
    h.mcp_servers.configure(h.config.mcp_servers)  # type: ignore[union-attr]
    h.accept("in1")

    outcome = await h.run(chat_unit())

    assert outcome.kind == "completed"
    # Only the server whose permission is not denied: its tools, and its words in the prompt.
    offered = h.provider.tool_names[0]
    assert "mcp_tools_echo" in offered and not any(name.startswith("mcp_hidden_") for name in offered)
    system = h.provider.requests[0]["messages"][0]["content"]
    assert "## MCP servers" in system and f"### tools\n{INSTRUCTIONS}" in system and "### hidden" not in system
    assert [m["content"] for m in h.messages() if m["role"] == "tool"] == ["hi"]
    assert h.events_of("tool.called")[0] | {"duration_ms": 0} == {
        "tool": "mcp_tools_echo",
        "permission": "mcp.tools",
        "decision": "allow",
        "ok": True,
        "duration_ms": 0,
    }
    await h.mcp_servers.aclose()


async def test_a_call_of_a_server_that_asks_waits_for_the_person(make_harness: MakeHarness, tmp_path: Path) -> None:
    h = make_harness(
        [calls(call("c1", "mcp_tools_echo", text="hi"))],
        {"mcp.tools": "ask"},
        mcp_servers={"tools": server(tmp_path)},
    )
    h.mcp_servers.configure(h.config.mcp_servers)  # type: ignore[union-attr]
    h.accept("in1")

    outcome = await h.run(chat_unit())

    assert outcome.kind == "parked"
    (asked,) = h.events_of("approval.requested")
    assert (asked["tool"], asked["permission"], asked["arguments"]) == ("mcp_tools_echo", "mcp.tools", {"text": "hi"})
    await h.mcp_servers.aclose()


async def test_a_server_that_is_not_connected_is_said_in_the_prompt_with_why(
    make_harness: MakeHarness, tmp_path: Path
) -> None:
    h = make_harness(
        [says("ok")],
        {"mcp.keyed": "allow"},
        mcp_servers={"keyed": server(tmp_path, secrets=["API_TOKEN"])},
    )
    h.mcp_servers.configure(h.config.mcp_servers)  # type: ignore[union-attr]
    h.accept("in1")

    await h.run(chat_unit())

    system = h.provider.requests[0]["messages"][0]["content"]
    assert "### keyed\nNot connected: its secret API_TOKEN is not set" in system


async def test_a_servers_secret_never_reaches_the_conversation_files(make_harness: MakeHarness, tmp_path: Path) -> None:
    h = make_harness(
        [calls(call("c1", "mcp_tools_env", name="API_TOKEN")), says("the token is tok-SECRET-9")],
        {"mcp.tools": "allow"},
        mcp_servers={"tools": server(tmp_path, secrets=["API_TOKEN"])},
    )
    h.mcp_secrets.set({"tools": {"API_TOKEN": "tok-SECRET-9"}})
    h.mcp_servers.configure(h.config.mcp_servers)  # type: ignore[union-attr]
    h.accept("in1")

    await h.run(chat_unit())

    written = "".join(path.read_text(encoding="utf-8") for path in (tmp_path / CONVERSATIONS_DIR.lstrip("/")).rglob("*.md"))
    assert "tok-SECRET-9" not in written and "***" in written
    await h.mcp_servers.aclose()
