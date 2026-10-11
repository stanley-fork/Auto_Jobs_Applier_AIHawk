"""The entry point of the Dot's engine: `python -I -B -m nanobot`.

It reads the environment once, refuses to start when a credential is on disk or
another engine owns the state, builds the engine and serves the Dot's API on
its unix socket until SIGTERM or SIGINT. Nothing else of the process reads the
environment: every value travels down as an argument.
"""

from __future__ import annotations

import asyncio
import os
import pwd
import signal
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from loguru import logger

import nanobot
from nanobot.agent.tools.exec_session import ExecSessionManager
from nanobot.cron.service import CronService
from nanobot.dots.browser import BrowserManager
from nanobot.dots.checks import DEFAULT_BROWSER_COMMAND, DEFAULT_NETWORK_TARGET, create_guest_checks
from nanobot.dots.computer import (
    DEFAULT_AGENTD_BIN,
    DEFAULT_AGENTD_SOCKET,
    DEFAULT_WORKSPACE,
    AgentdComputer,
)
from nanobot.dots.engine import Engine
from nanobot.dots.mcp_servers import McpServers
from nanobot.dots.permissions import ToolDeps, build_registry
from nanobot.dots.provider import OpenRouterProviders
from nanobot.dots.secrets import KeyHolder, McpSecrets
from nanobot.dots.server import AgentServer
from nanobot.dots.store import DotStore, StoreOwnedError
from nanobot.utils.token_encoding import warmup_token_encoding

DEFAULT_AGENT_SOCKET = "/run/invisible-dots-agent/agent.sock"
# The user every command of the model runs as (dot-agentd's `--run-as`): the one the API socket refuses.
DEFAULT_MODEL_USER = "dot"
DEFAULT_STATE_DIR = "/home/dotengine/state"
# The nanobot commit the fork was copied at (UPSTREAM.md holds the full id).
UPSTREAM_COMMIT = "f75470e7"
# How often work that waits is looked at again, in seconds.
RETRY_INTERVAL_S = 5.0
# The browser limits: at most this many identities open at once (each holds about 0.8 GB of the computer's
# memory; opening one more closes the one used least recently), and at most this many in all. They are the
# engine's own, not a setting: the Dot manages its identities itself.
DEFAULT_MAX_OPEN = 3
DEFAULT_MAX_IDENTITIES = 20

REFUSAL = "invisible-dots-engine runs only the Dot's engine; it takes no command (only --version)"

MODEL_USER_MISSING = (
    "the golden image has no user {user}, the user of the model's commands, whose processes the engine's socket "
    "refuses: build a new golden image"
)


class GoldenImageError(Exception):
    """The golden image is not the one this runtime disk's engine needs."""


@dataclass(frozen=True)
class Environment:
    """Everything the process takes from its environment."""

    agent_socket: str
    agentd_socket: str
    agentd_bin: str
    workspace: str
    state_dir: str
    # The OpenRouter base URL of a stand-in, for tests and the smoke only.
    openrouter_url: str | None
    network_check: str
    mcp_command: str
    path: str
    home: str
    # The user of the model's commands, whose processes the API socket refuses. None refuses no one: a development
    # machine has no such user.
    model_user: str | None = DEFAULT_MODEL_USER


def read_environment(environ: Mapping[str, str]) -> Environment:
    def value(name: str, default: str) -> str:
        return environ.get(name, "").strip() or default

    return Environment(
        agent_socket=value("INVISIBLE_DOTS_AGENT_SOCKET", DEFAULT_AGENT_SOCKET),
        agentd_socket=value("INVISIBLE_DOTS_AGENTD_SOCKET", DEFAULT_AGENTD_SOCKET),
        agentd_bin=value("INVISIBLE_DOTS_AGENTD_BIN", DEFAULT_AGENTD_BIN),
        workspace=value("INVISIBLE_DOTS_WORKSPACE", DEFAULT_WORKSPACE),
        state_dir=value("INVISIBLE_DOTS_ENGINE_STATE", DEFAULT_STATE_DIR),
        openrouter_url=environ.get("INVISIBLE_DOTS_OPENROUTER_URL", "").strip() or None,
        network_check=value("INVISIBLE_DOTS_NETWORK_CHECK", DEFAULT_NETWORK_TARGET),
        mcp_command=value("INVISIBLE_DOTS_MCP_COMMAND", DEFAULT_BROWSER_COMMAND),
        path=environ.get("PATH", ""),
        home=environ.get("HOME", "").strip() or str(Path.home()),
        model_user=value("INVISIBLE_DOTS_MODEL_USER", DEFAULT_MODEL_USER),
    )


def refused_peer_uids(model_user: str | None) -> frozenset[int]:
    """The user ids the API socket refuses: the model's user. The user must exist: an engine that cannot name the
    user it is to refuse would serve everyone, so it does not start."""
    if model_user is None:
        return frozenset()
    try:
        return frozenset({pwd.getpwnam(model_user).pw_uid})
    except KeyError:
        raise GoldenImageError(MODEL_USER_MISSING.format(user=model_user)) from None


def configure_logging() -> int:
    """Log to stderr, which is the journal; returns the sink's id.

    `diagnose` stays off: it prints the values of variables in a traceback, and one of them could be the key.
    """
    logger.remove()
    return logger.add(sys.stderr, level="INFO", diagnose=False, backtrace=False)


async def serve(environment: Environment, stop: asyncio.Event) -> None:
    """Run the engine and its API until `stop` is set, then shut down in order."""
    # The tokenizer's table loads now, from the image's cache, while the host pushes the config and the key. Loaded on
    # the first count instead, that count (the first turn after every start, so after every wake) would be one token
    # per byte, about four times the truth, and a long thread would fail as over its budget.
    warmup_token_encoding()
    refused_uids = refused_peer_uids(environment.model_user)
    state_dir = Path(environment.state_dir)
    store = DotStore.open(state_dir / "engine.sqlite")
    try:
        key_holder = KeyHolder()
        mcp_secrets = McpSecrets()
        computer = AgentdComputer(environment.agentd_bin, environment.agentd_socket, environment.workspace)
        exec_sessions = ExecSessionManager()
        cron = CronService(state_dir / "cron" / "jobs.json")
        # The Dot's one browser: invisible-playwright-mcp, one process per open identity, run as `dot`.
        browser = BrowserManager(
            store=store,
            computer=computer,
            mcp_command=environment.mcp_command,
            max_open=DEFAULT_MAX_OPEN,
            max_identities=DEFAULT_MAX_IDENTITIES,
        )
        registry = build_registry(ToolDeps(computer, exec_sessions, cron, browser))
        # The MCP servers the person declares: their tools join the registry while they are connected.
        mcp_servers = McpServers(computer=computer, registry=registry, secrets=mcp_secrets)
        engine = Engine(
            store=store,
            computer=computer,
            base_registry=registry,
            browser=browser,
            mcp_servers=mcp_servers,
            providers=OpenRouterProviders(),
            key_holder=key_holder,
            workspace=environment.workspace,
            openrouter_base_url=environment.openrouter_url,
        )
        cron.on_job = engine.automation_fired
        cron.on_next_wake = engine.automations_next_run
        checks = create_guest_checks(
            writable_dir=state_dir,
            browser_command=environment.mcp_command,
            network_target=environment.network_check,
            path=environment.path,
        )
        server = AgentServer(
            engine=engine,
            key_holder=key_holder,
            mcp_secrets=mcp_secrets,
            checks=checks,
            refused_uids=refused_uids,
        )
        await server.listen(environment.agent_socket)
        retry: asyncio.Task[None] | None = None
        try:
            engine.start()
            await cron.start()
            retry = asyncio.get_running_loop().create_task(_retry(engine))
            await stop.wait()
            logger.info("stopping")
        finally:
            if retry is not None:
                retry.cancel()
            # The cron timer first: a firing that reached the stopped engine would be recorded nowhere, and its
            # job would move on as if it had run.
            cron.stop()
            # Stop accepting, then close the streams, then stop the engine (which closes the open
            # browsers once the turns in flight have ended): nothing new is taken meanwhile.
            await server.stop_accepting()
            server.close_streams()
            await engine.stop()
            # No turn is left to call them: the declared MCP servers end (a stdio one's relay, and so its process).
            await mcp_servers.aclose()
            await exec_sessions.close_all()
            await server.close()
            await computer.aclose()
    finally:
        store.close()


async def _retry(engine: Engine) -> None:
    while True:
        await asyncio.sleep(RETRY_INTERVAL_S)
        engine.kick()


async def _run(environment: Environment) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stop.set)
    await serve(environment, stop)


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args == ["--version"]:
        print(f"invisible_dots engine {nanobot.__version__} (nanobot fork, {UPSTREAM_COMMIT})")
        return 0
    if args:
        print(REFUSAL, file=sys.stderr)
        return 2
    environment = read_environment(os.environ if environ is None else environ)
    sink = configure_logging()
    try:
        asyncio.run(_run(environment))
    except GoldenImageError as error:
        print(f"refusing to start: {error}", file=sys.stderr)
        return 1
    except StoreOwnedError as error:
        print(f"refusing to start: {error}", file=sys.stderr)
        return 1
    finally:
        logger.remove(sink)
    return 0
