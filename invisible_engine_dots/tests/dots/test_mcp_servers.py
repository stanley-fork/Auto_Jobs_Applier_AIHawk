"""The MCP servers a person declares: started as dot through the relay, reached over HTTP, their tools on the Dot's
registry, their secrets kept off command lines, and why one is not connected (nanobot/dots/mcp_servers.py)."""

from __future__ import annotations

import asyncio
import json
import socket
import subprocess
import sys
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import pytest
from fakes.fake_tool_server import INSTRUCTIONS, SCRIPT, install_fake_tool_server
from fakes.local_computer import LocalComputer

from nanobot.agent.tools.base import ToolResult
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.dots.images import TurnImages, bind_turn_images, reset_turn_images
from nanobot.dots.mcp_servers import INSTRUCTIONS_MAX_CHARS, McpServers, McpServerTool
from nanobot.dots.protocol import McpHttpServer, McpStdioServer
from nanobot.dots.secrets import McpSecrets


class Servers:
    """A manager on a local computer whose relay is the fake one, logging every start."""

    def __init__(self, tmp_path: Path) -> None:
        self.tmp_path = tmp_path
        self.relay_log = tmp_path / "relay.jsonl"
        workspace = tmp_path / "home" / "dot" / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)
        self.computer = LocalComputer(tmp_path, workspace, relay_log=self.relay_log)
        (tmp_path / "bin").mkdir(exist_ok=True)
        self.program = str(install_fake_tool_server(tmp_path / "bin"))
        self.registry = ToolRegistry()
        self.secrets = McpSecrets()
        self.manager = McpServers(computer=self.computer, registry=self.registry, secrets=self.secrets)

    def stdio(self, **fields: Any) -> McpStdioServer:
        return McpStdioServer.model_validate({"command": self.program, "timeout_s": 30, "startup_timeout_s": 20, **fields})

    def starts(self) -> list[dict[str, Any]]:
        if not self.relay_log.exists():
            return []
        return [json.loads(line) for line in self.relay_log.read_text(encoding="utf-8").splitlines()]

    def state(self, name: str) -> dict[str, Any]:
        return next(server for server in self.manager.status() if server["name"] == name)

    async def call(self, tool: str, **arguments: Any) -> Any:
        found = self.registry.get(tool)
        assert found is not None, f"no tool {tool}: {self.registry.tool_names}"
        return await found.execute(**arguments)


@pytest.fixture
async def servers(tmp_path: Path) -> AsyncIterator[Callable[..., Servers]]:
    made: list[Servers] = []

    def make() -> Servers:
        made.append(Servers(tmp_path))
        return made[-1]

    yield make
    for each in made:
        await each.manager.aclose()


async def test_a_declared_server_is_started_through_the_relay_and_its_tools_join_the_registry(
    servers: Callable[..., Servers],
) -> None:
    s = servers()
    s.manager.configure({"tools": s.stdio()})
    await s.manager.ready()

    assert s.state("tools") == {"name": "tools", "state": "connected", "error": None, "tools": 5}
    names = ["mcp_tools_echo", "mcp_tools_env", "mcp_tools_header", "mcp_tools_picture", "mcp_tools_exit"]
    assert s.manager.tool_names(["tools"]) == names
    assert s.manager.tool_names([]) == []
    assert all(isinstance(s.registry.get(name), McpServerTool) for name in names)
    assert await s.call("mcp_tools_echo", text="hello") == "hello"
    # As dot, through the relay: one start, of the declared program.
    (start,) = s.starts()
    assert start["program"] == [s.program]
    assert [(p.name, p.instructions, p.error) for p in s.manager.prompt_servers(["tools"])] == [("tools", INSTRUCTIONS, None)]


async def test_a_secret_reaches_the_server_by_the_relays_environment_and_never_its_command_line(
    servers: Callable[..., Servers],
) -> None:
    s = servers()
    s.secrets.set({"tools": {"API_TOKEN": "tok-SECRET-1"}})
    s.manager.configure({"tools": s.stdio(env={"MODE": "test"}, secrets=["API_TOKEN"])})
    await s.manager.ready()

    assert await s.call("mcp_tools_env", name="API_TOKEN") == "tok-SECRET-1"
    assert await s.call("mcp_tools_env", name="MODE") == "test"
    (start,) = s.starts()
    assert start["env_from"] == ["API_TOKEN"]
    assert "tok-SECRET-1" not in json.dumps(start)
    assert s.manager.secret_values() == ["tok-SECRET-1"]


async def test_a_server_whose_secret_is_not_set_is_not_started_until_it_is(servers: Callable[..., Servers]) -> None:
    s = servers()
    s.manager.configure({"tools": s.stdio(secrets=["API_TOKEN"])})
    await s.manager.ready()

    state = s.state("tools")
    assert state["state"] == "failed" and "API_TOKEN is not set" in state["error"]
    assert s.starts() == []
    assert s.manager.tool_names(["tools"]) == []

    s.secrets.set({"tools": {"API_TOKEN": "tok-1"}})
    s.manager.secrets_changed()
    await s.manager.ready()
    assert s.state("tools")["state"] == "connected"


async def test_a_program_that_is_not_installed_fails_with_what_it_wrote_and_starts_once_it_is(
    servers: Callable[..., Servers], tmp_path: Path
) -> None:
    s = servers()
    missing = tmp_path / "bin" / "not-yet"
    s.manager.configure({"later": McpStdioServer.model_validate({"command": str(missing), "timeout_s": 30, "startup_timeout_s": 20})})
    await s.manager.ready()

    state = s.state("later")
    assert state["state"] == "failed"
    assert "No such file or directory" in state["error"]
    assert [(p.name, p.error is not None) for p in s.manager.prompt_servers(["later"])] == [("later", True)]

    # The Dot installs it; the next turn starts it again.
    missing.write_bytes(Path(s.program).read_bytes())
    missing.chmod(0o755)
    await s.manager.ready()
    assert s.state("later")["state"] == "connected"


async def test_what_a_failing_server_wrote_is_its_error_with_its_secrets_masked(servers: Callable[..., Servers]) -> None:
    s = servers()
    s.secrets.set({"tools": {"API_TOKEN": "tok-SECRET-2"}})
    s.manager.configure({"tools": s.stdio(env={"FAKE_TOOLS_FAIL": "refused the key tok-SECRET-2"}, secrets=["API_TOKEN"])})
    await s.manager.ready()

    error = s.state("tools")["error"]
    assert "refused the key ***" in error
    assert "tok-SECRET-2" not in error


async def test_a_server_that_does_not_answer_fails_at_its_startup_timeout_and_holds_up_no_turn_after(
    servers: Callable[..., Servers],
) -> None:
    s = servers()
    s.manager.configure({"slow": s.stdio(env={"FAKE_TOOLS_HANG": "1"}, startup_timeout_s=1)})
    await s.manager.ready()

    state = s.state("slow")
    assert (state["state"], state["error"]) == (
        "failed",
        "it did not start within its startup_timeout_s, 1 s; it is started again when its settings change",
    )
    # The next turn does not wait for it again: it is not started until its entry changes.
    await s.manager.ready()
    assert len(s.starts()) == 1
    s.manager.configure({"slow": s.stdio(env={"FAKE_TOOLS_HANG": "1"}, startup_timeout_s=2)})
    await s.manager.ready()
    assert len(s.starts()) == 2


async def test_a_change_restarts_only_the_server_it_changes_and_a_removed_one_takes_its_tools(
    servers: Callable[..., Servers],
) -> None:
    s = servers()
    s.manager.configure({"a": s.stdio(), "b": s.stdio()})
    await s.manager.ready()
    assert len(s.starts()) == 2

    s.manager.configure({"a": s.stdio(), "b": s.stdio(args=["--changed"])})
    await s.manager.ready()
    assert len(s.starts()) == 3
    assert s.starts()[-1]["program"][-1] == "--changed"

    s.manager.configure({"b": s.stdio(args=["--changed"])})
    assert [server["name"] for server in s.manager.status()] == ["b"]
    assert not any(name.startswith("mcp_a_") for name in s.registry.tool_names)


async def test_a_server_that_exits_loses_its_tools_and_the_next_turn_starts_it_again(
    servers: Callable[..., Servers],
) -> None:
    s = servers()
    s.manager.configure({"tools": s.stdio()})
    await s.manager.ready()

    result = await s.call("mcp_tools_exit")
    assert isinstance(result, ToolResult) and result.is_error
    for _ in range(100):
        if s.state("tools")["state"] == "failed":
            break
        await asyncio.sleep(0.05)
    assert s.state("tools")["state"] == "failed"
    assert s.manager.tool_names(["tools"]) == []

    await s.manager.ready()
    assert s.state("tools")["state"] == "connected"
    assert await s.call("mcp_tools_echo", text="back") == "back"


async def test_an_image_a_tool_answers_with_is_shown_for_the_turn_and_not_kept_in_the_text(
    servers: Callable[..., Servers],
) -> None:
    s = servers()
    s.manager.configure({"tools": s.stdio()})
    await s.manager.ready()

    images = TurnImages()
    token = bind_turn_images(images)
    try:
        text = await s.call("mcp_tools_picture")
    finally:
        reset_turn_images(token)

    assert text.startswith("a pixel\n[screenshot, 1x1, not stored")
    assert [(image.caption, image.mime) for image in images.images] == [("mcp_tools_picture", "image/png")]


async def test_long_instructions_are_cut_and_a_server_that_gives_none_says_so(servers: Callable[..., Servers]) -> None:
    s = servers()
    s.manager.configure({"long": s.stdio(env={"FAKE_TOOLS_INSTRUCTIONS": "x" * 3000}), "quiet": s.stdio(env={"FAKE_TOOLS_INSTRUCTIONS": ""})})
    await s.manager.ready()

    long, quiet = s.manager.prompt_servers(["long", "quiet"])
    assert long.instructions.startswith("x" * INSTRUCTIONS_MAX_CHARS + "\n(cut at")
    assert (quiet.instructions, quiet.error) == ("", None)


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


async def test_an_http_server_gets_its_secrets_as_headers(servers: Callable[..., Servers]) -> None:
    port = _free_port()
    process = subprocess.Popen([sys.executable, str(SCRIPT), "--http", str(port)], stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                await asyncio.sleep(0.1)
        s = servers()
        s.secrets.set({"remote": {"Authorization": "Bearer tok-3"}})
        url = f"http://127.0.0.1:{port}/mcp"
        s.manager.configure(
            {"remote": McpHttpServer.model_validate({"url": url, "headers": {"X-Client": "dots"}, "secrets": ["Authorization"], "timeout_s": 30, "startup_timeout_s": 20})}
        )
        await s.manager.ready()

        assert s.state("remote")["state"] == "connected"
        assert await s.call("mcp_remote_header", name="authorization") == "Bearer tok-3"
        assert await s.call("mcp_remote_header", name="x-client") == "dots"
        assert s.starts() == []
    finally:
        process.terminate()
        process.wait(timeout=10)


async def test_a_tool_row_says_its_servers_permission_and_whether_the_model_is_offered_it(
    servers: Callable[..., Servers],
) -> None:
    s = servers()
    s.manager.configure({"tools": s.stdio()})
    await s.manager.ready()

    rows = s.manager.tool_rows(offered=[])
    assert {row["permission"] for row in rows} == {"mcp.tools"}
    assert not any(row["offered"] for row in rows)
    assert all(row["offered"] for row in s.manager.tool_rows(offered=["tools"]))
    assert next(row for row in rows if row["name"] == "mcp_tools_echo")["description"] == "Repeat a text."
