"""The MCP servers the person declares in the Dot's config (architecture sections 7 and 8.3).

The person declares a server as Claude Code, Codex and nanobot have their user declare one: a command, or a URL, with
the names of its secrets (`mcp_servers` of the config). The Dot can install the program a server needs, as it installs
anything; it cannot declare a server, which is the person's.

Each server is an `MCPProvider` of nanobot's client on a registry of its own, as the BrowserManager has one per browser
identity: the client spawns the server, initializes it, lists its tools and times out a call. What is this module's:

* Where a server runs. A stdio server is started through `dot-agentd relay` as the user `dot`, in its home, like every
  program of the model, so it reads and writes what the Dot's commands can and nothing of the engine's. Its secrets
  reach its environment through the relay's own, never the relay's command line (computer.py). An HTTP server is
  reached from the engine, its secrets as headers.
* When. A config or a secret that changes a server's entry restarts that server alone. A server is started when it is
  declared, and one that failed (its program is not installed yet, it exited) is started again when the next turn
  starts; the turn waits for the servers being started, each at most its `startup_timeout_s`. One that did not start
  within that, or whose secret is not set, is not started again until its entry or its secrets change: a turn does not
  wait for it again and again.
* What the model gets. Each tool of a connected server, under the client's name `mcp_<server>_<tool>`, is offered
  while the server's permission (`mcp.<server>`) is not denied, and the gate decides each call by it. The prompt
  carries each such server's instructions, as an MCP host carries them, or why it is not connected. An image a tool
  answers with is shown as the browser's are (images.py).
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Collection, Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, TextIO

from loguru import logger

from nanobot.agent.tools.base import Tool, ToolResult
from nanobot.agent.tools.mcp import MCPProvider, MCPServerConfig
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.dots.browser import result_is_error, split_result
from nanobot.dots.computer import Computer
from nanobot.dots.conversations import redact
from nanobot.dots.images import show_images
from nanobot.dots.permissions import mcp_permission
from nanobot.dots.protocol import McpServerSpec, McpStdioServer
from nanobot.dots.secrets import McpSecrets

# The most of a server's instructions the prompt carries, as Claude Code caps them.
INSTRUCTIONS_MAX_CHARS = 2048
# The most of what a stdio server wrote to its standard error that a failure quotes, its end.
STDERR_KEPT_CHARS = 2000

class _StderrTail:
    """A stdio server's standard error: a pipe the engine drains as it is written, keeping its last STDERR_KEPT_CHARS
    characters to say why the server failed. Drained on the loop, so a chatty server never blocks on a full pipe."""

    def __init__(self) -> None:
        read_fd, write_fd = os.pipe()
        os.set_blocking(read_fd, False)
        self._read_fd = read_fd
        # The server's process gets this end as its stderr; only its descriptor is used.
        self.writer: TextIO = os.fdopen(write_fd, "w")
        self._kept = bytearray()
        self._loop = asyncio.get_running_loop()
        self._loop.add_reader(read_fd, self._drain)
        self._closed = False

    def _drain(self) -> None:
        while not self._closed:
            try:
                chunk = os.read(self._read_fd, 65536)
            except (BlockingIOError, InterruptedError):
                return
            if not chunk:
                return
            self._kept += chunk
            del self._kept[: max(len(self._kept) - STDERR_KEPT_CHARS * 4, 0)]

    def clear(self) -> None:
        """Forget what was written so far: what a failure quotes is of the attempt that failed."""
        self._drain()
        self._kept.clear()

    def text(self) -> str:
        """What is kept, with what the pipe holds now: the server has ended by the time a failure reads it."""
        self._drain()
        text = self._kept.decode("utf-8", errors="replace").strip()
        return text[-STDERR_KEPT_CHARS:]

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._loop.remove_reader(self._read_fd)
        with suppress(OSError):
            self.writer.close()
        with suppress(OSError):
            os.close(self._read_fd)


class McpServerTool(Tool):
    """A tool of a declared MCP server on the Dot's registry: the client's own (name, description, schema), called on
    the server's registry at call time, so a reconnect that replaced it is followed, with its images shown."""

    def __init__(self, server: str, registry: ToolRegistry, wrapped: Tool) -> None:
        self._server = server
        self._registry = registry
        self._name = wrapped.name
        self._description = wrapped.description
        self._parameters = wrapped.parameters
        self._read_only = wrapped.read_only

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    @property
    def read_only(self) -> bool:
        return self._read_only

    @property
    def server(self) -> str:
        return self._server

    async def execute(self, **kwargs: Any) -> Any:
        wrapped = self._registry.get(self._name)
        if wrapped is None:
            return ToolResult.error(f'the MCP server "{self._server}" is not connected')
        result = await wrapped.execute(**kwargs)
        if result_is_error(result):
            return result
        text, images = split_result(result)
        return show_images(text, images, f"{self._name}")


@dataclass
class _Server:
    """One declared server and its current attempt."""

    name: str
    spec: McpServerSpec
    # The values of the secrets it names that are set, by name.
    secrets: dict[str, str]
    state: str = "connecting"
    error: str | None = None
    # Whether a turn that starts may start it again: not when what is missing is the person's to give (a secret).
    retry: bool = True
    instructions: str = ""
    tools: list[str] = field(default_factory=list)
    registry: ToolRegistry = field(default_factory=ToolRegistry)
    provider: MCPProvider | None = None
    tail: _StderrTail | None = None
    task: asyncio.Task[None] | None = None
    removed: bool = False

    def same(self, spec: McpServerSpec, secrets: Mapping[str, str]) -> bool:
        return self.spec == spec and self.secrets == dict(secrets)


@dataclass(frozen=True)
class PromptServer:
    """What the prompt says of one server: its instructions, or why it is not connected."""

    name: str
    instructions: str
    error: str | None


class McpServers:
    """The declared MCP servers of the Dot, their processes or connections, and their tools on the Dot's registry."""

    def __init__(
        self,
        *,
        computer: Computer,
        registry: ToolRegistry,
        secrets: McpSecrets,
    ) -> None:
        self._computer = computer
        self._registry = registry
        self._secrets = secrets
        self._declared: dict[str, McpServerSpec] = {}
        self._servers: dict[str, _Server] = {}
        # Closes of servers that were removed or replaced, which the shutdown waits for.
        self._closing: set[asyncio.Task[None]] = set()

    # --- what the engine tells it -------------------------------------------

    def configure(self, servers: Mapping[str, McpServerSpec]) -> None:
        """The config's servers: start the new ones, restart the changed ones, stop the ones no longer declared.

        They are kept by name, the order of every list of them: the host keeps a config as jsonb, which does not keep
        the order of an object's keys."""
        self._declared = dict(sorted(servers.items()))
        self._reconcile()

    def secrets_changed(self) -> None:
        """The host pushed the secrets again: restart a server whose secrets changed."""
        self._reconcile()

    async def ready(self) -> None:
        """What a turn does before it offers the tools: start again the servers that failed and may succeed now, then
        wait for every server being started (each start is bounded by its `startup_timeout_s`)."""
        for server in self._servers.values():
            if server.state == "failed" and server.retry:
                self._start(server)
        pending = [server.task for server in self._servers.values() if server.task is not None and not server.task.done()]
        if pending:
            await asyncio.wait(pending)

    async def aclose(self) -> None:
        """Stop every server; the engine is shutting down."""
        self._declared = {}
        for name in list(self._servers):
            self._remove(name)
        if self._closing:
            await asyncio.wait(set(self._closing))

    # --- what the engine reads ----------------------------------------------

    def tool_names(self, servers: Collection[str]) -> list[str]:
        """The tools of the connected servers among `servers`, the servers by name, each one's in its order."""
        return [tool for server in self._listed(servers) if server.state == "connected" for tool in server.tools]

    def tool_rows(self, offered: Collection[str]) -> list[dict[str, Any]]:
        """One row per tool of a connected server, as `GET /tools` shows it; `offered` are the servers whose tools the
        model is offered."""
        rows: list[dict[str, Any]] = []
        for server in self._servers.values():
            if server.state != "connected":
                continue
            for name in server.tools:
                tool = self._registry.get(name)
                description = tool.description if tool is not None else ""
                rows.append(
                    {
                        "name": name,
                        "permission": mcp_permission(server.name),
                        "offered": server.name in offered,
                        "description": description,
                    }
                )
        return rows

    def status(self) -> list[dict[str, Any]]:
        """Every declared server and where it is, by name, as `GET /tools` shows them."""
        return [
            {
                "name": server.name,
                "state": server.state,
                "error": server.error if server.state == "failed" else None,
                "tools": len(server.tools) if server.state == "connected" else 0,
            }
            for server in self._servers.values()
        ]

    def prompt_servers(self, servers: Collection[str]) -> list[PromptServer]:
        """What the prompt says of the servers among `servers`: a connected one's instructions, cut at
        INSTRUCTIONS_MAX_CHARS; for one that is not, why."""
        said: list[PromptServer] = []
        for server in self._listed(servers):
            if server.state == "connected":
                instructions = server.instructions
                if len(instructions) > INSTRUCTIONS_MAX_CHARS:
                    instructions = f"{instructions[:INSTRUCTIONS_MAX_CHARS]}\n(cut at {INSTRUCTIONS_MAX_CHARS} characters)"
                said.append(PromptServer(server.name, instructions, None))
            else:
                said.append(PromptServer(server.name, "", server.error or "it is still starting"))
        return said

    def secret_values(self) -> list[str]:
        """The values of the servers' secrets, which a conversation file must not show."""
        return self._secrets.values()

    def _listed(self, servers: Collection[str]) -> list[_Server]:
        return [server for name, server in self._servers.items() if name in servers]

    # --- the servers' lives -------------------------------------------------

    def _reconcile(self) -> None:
        for name in list(self._servers):
            if name not in self._declared:
                self._remove(name)
        for name, spec in self._declared.items():
            secrets = {key: value for key, value in self._secrets.of(name).items() if key in spec.secrets}
            current = self._servers.get(name)
            if current is not None and current.same(spec, secrets):
                continue
            if current is not None:
                self._remove(name)
            server = _Server(name, spec, secrets)
            self._servers[name] = server
            self._start(server)
        # By name, which the status and the prompt follow.
        self._servers = {name: self._servers[name] for name in self._declared}

    def _start(self, server: _Server) -> None:
        """Start an attempt at the server, unless it waits for the person. Never awaits."""
        missing = [name for name in server.spec.secrets if name not in server.secrets]
        if missing:
            server.state, server.retry = "failed", False
            server.error = f"its secret {', '.join(missing)} is not set: the person sets it in the Dot's settings"
            return
        server.state, server.error, server.retry = "connecting", None, True
        server.task = asyncio.get_running_loop().create_task(self._connect(server), name=f"mcp server {server.name}")

    async def _connect(self, server: _Server) -> None:
        try:
            await self._attempt(server)
        except Exception as error:
            # Not the client's (it reports its own failures): a defect here, said where the person and the model see it.
            logger.opt(exception=error).error("starting MCP server {} failed", server.name)
            if not server.removed:
                self._fail(server, f"{type(error).__name__}: {error}")

    async def _attempt(self, server: _Server) -> None:
        name = server.name
        if isinstance(server.spec, McpStdioServer) and server.tail is None:
            server.tail = _StderrTail()
        if server.tail is not None:
            server.tail.clear()
        provider = MCPProvider(
            {name: self._client_config(server)},
            server.registry,
            on_terminated=lambda _name: self._ended(server, provider),
            errlogs={name: server.tail.writer} if server.tail is not None else None,
        )
        server.provider = provider
        reason: str | None
        timed_out = False
        try:
            failed = await asyncio.wait_for(provider.connect(), server.spec.startup_timeout_s)
            reason = (provider.failure(name) or "it did not connect") if failed else None
        except asyncio.TimeoutError:
            timed_out = True
            reason = (
                f"it did not start within its startup_timeout_s, {server.spec.startup_timeout_s} s; it is started again "
                "when its settings change"
            )
        if server.removed:
            await provider.aclose()
            return
        if reason is not None:
            await provider.aclose()
            self._fail(server, reason)
            # Started again at every turn, it would hold up every turn for as long again.
            server.retry = not timed_out
            return
        server.instructions = provider.instructions(name)
        server.tools = list(server.registry.tool_names)
        for tool_name in server.tools:
            wrapped = server.registry.get(tool_name)
            if wrapped is not None:
                self._registry.register(McpServerTool(name, server.registry, wrapped))
        server.state = "connected"
        logger.info("MCP server {} connected with {} tools", name, len(server.tools))

    def _fail(self, server: _Server, reason: str) -> None:
        written = server.tail.text() if server.tail is not None else ""
        error = f"{reason}; it wrote: {written}" if written else reason
        server.state, server.error = "failed", redact(error, list(server.secrets.values()))
        server.instructions, server.tools = "", []
        logger.warning("MCP server {} failed: {}", server.name, server.error)

    def _ended(self, server: _Server, provider: MCPProvider) -> None:
        """The server's process exited, or its connection dropped: its tools go, and the next turn starts it again."""
        if server.removed or server.provider is not provider or server.state != "connected":
            return
        self._unregister(server)
        server.state, server.error = "failed", "it exited"
        logger.warning("MCP server {} ended", server.name)

        async def close() -> None:
            await provider.aclose()
            if server.provider is provider and server.state == "failed":
                self._fail(server, "it exited")

        self._track(asyncio.get_running_loop().create_task(close(), name=f"mcp server {server.name} ended"))

    def _remove(self, name: str) -> None:
        """Stop a server that is no longer declared, or that is replaced: its tools go now, its process soon."""
        server = self._servers.pop(name)
        server.removed = True
        self._unregister(server)
        task, provider, tail = server.task, server.provider, server.tail

        async def close() -> None:
            if task is not None and not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await task
            if provider is not None:
                await provider.aclose()
            if tail is not None:
                tail.close()

        self._track(asyncio.get_running_loop().create_task(close(), name=f"mcp server {name} closing"))

    def _track(self, task: asyncio.Task[None]) -> None:
        self._closing.add(task)
        task.add_done_callback(self._closed)

    def _closed(self, task: asyncio.Task[None]) -> None:
        self._closing.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error("closing an MCP server failed: {!r}", task.exception())

    def _unregister(self, server: _Server) -> None:
        for tool_name in server.tools:
            tool = self._registry.get(tool_name)
            if isinstance(tool, McpServerTool) and tool.server == server.name:
                self._registry.unregister(tool_name)

    def _client_config(self, server: _Server) -> MCPServerConfig:
        spec = server.spec
        if isinstance(spec, McpStdioServer):
            # In dot's home, as dot; the secrets by the relay's environment, only their names on its command line.
            argv = self._computer.relay_argv([spec.command, *spec.args], env=dict(spec.env), secrets=server.secrets)
            return MCPServerConfig(
                command=argv[0],
                args=argv[1:],
                env=self._computer.spawn_env(secrets=server.secrets),
                tool_timeout=spec.timeout_s,
                images=True,
            )
        return MCPServerConfig(
            url=spec.url,
            headers={**spec.headers, **server.secrets},
            tool_timeout=spec.timeout_s,
            images=True,
        )
