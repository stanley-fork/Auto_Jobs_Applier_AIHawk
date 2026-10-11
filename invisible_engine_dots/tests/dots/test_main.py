"""The entry point: what it refuses, and the whole engine served on a socket."""

from __future__ import annotations

import asyncio
import json
import os
import pwd
import re
import sqlite3
import shutil
import socket
import subprocess
import sys
import tempfile
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import aiohttp
import pytest
from aiohttp import web
from fakes.dot_config import runtime_config_body

import nanobot
from nanobot.cron.service import CronService
from nanobot.dots import main as entry_point
from nanobot.dots.engine import Engine
from nanobot.dots.main import (
    DEFAULT_AGENT_SOCKET,
    DEFAULT_STATE_DIR,
    REFUSAL,
    UPSTREAM_COMMIT,
    Environment,
    GoldenImageError,
    main,
    read_environment,
    refused_peer_uids,
    serve,
)
from nanobot.dots.store import DotStore

ENGINE_ROOT = Path(__file__).resolve().parents[2]
TS = "2026-10-04T10:00:00.000Z"


# The user the API socket refuses: a machine that runs these tests has no user dot, so they name their own.
OWN_USER = pwd.getpwuid(os.getuid()).pw_name


def short_dir() -> Path:
    """A directory with a short path: a unix socket's path has a small limit."""
    return Path(tempfile.mkdtemp(prefix="dots-main-"))


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class TestTheCommandLine:
    def test_version_names_the_engine_and_the_commit_it_forked_from(self, capsys: pytest.CaptureFixture[str]) -> None:
        assert main(["--version"], {}) == 0

        out = capsys.readouterr().out
        assert out == f"invisible_dots engine {nanobot.__version__} (nanobot fork, f75470e7)\n"
        assert re.fullmatch(r"invisible_dots engine \d+\.\d+\.\d+ \(nanobot fork, [0-9a-f]{8}\)\n", out)

    def test_the_commit_it_names_is_the_one_upstream_md_records(self) -> None:
        recorded = re.search(r"commit ([0-9a-f]{40})", (ENGINE_ROOT / "UPSTREAM.md").read_text(encoding="utf-8"))
        assert recorded is not None
        assert recorded.group(1).startswith(UPSTREAM_COMMIT)

    @pytest.mark.parametrize("argv", [["status"], ["--version", "x"], ["gateway", "--port", "1"], ["--help"]])
    def test_any_other_argument_is_refused(self, argv: list[str], capsys: pytest.CaptureFixture[str]) -> None:
        assert main(argv, {}) == 2

        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err == REFUSAL + "\n"
        assert "runs only" in captured.err

    def test_the_module_runs_as_python_dash_m_nanobot(self) -> None:
        version = subprocess.run(
            [sys.executable, "-I", "-B", "-m", "nanobot", "--version"],
            capture_output=True, text=True, cwd=ENGINE_ROOT, check=False,
        )
        refused = subprocess.run(
            [sys.executable, "-I", "-B", "-m", "nanobot", "status"],
            capture_output=True, text=True, cwd=ENGINE_ROOT, check=False,
        )

        assert (version.returncode, version.stdout.startswith("invisible_dots engine ")) == (0, True)
        assert (refused.returncode, "runs only" in refused.stderr) == (2, True)


class TestTheEnvironment:
    def test_every_name_has_a_default(self) -> None:
        env = read_environment({})

        assert env.agent_socket == DEFAULT_AGENT_SOCKET == "/run/invisible-dots-agent/agent.sock"
        assert env.agentd_socket == "/run/invisible-dots/agentd.sock"
        assert env.agentd_bin == "/opt/invisible-dots/bin/dot-agentd"
        assert env.workspace == "/home/dot/workspace"
        assert env.state_dir == DEFAULT_STATE_DIR == "/home/dotengine/state"
        assert env.openrouter_url is None
        assert env.network_check == "openrouter.ai:443"
        assert env.mcp_command == "invisible-playwright-mcp"
        # The user of the model's commands, whose processes the API socket refuses (architecture 4.1).
        assert env.model_user == "dot"

    def test_the_names_the_unit_and_the_smoke_set(self) -> None:
        env = read_environment(
            {
                "INVISIBLE_DOTS_AGENT_SOCKET": "/s/agent.sock",
                "INVISIBLE_DOTS_AGENTD_SOCKET": "/s/agentd.sock",
                "INVISIBLE_DOTS_AGENTD_BIN": "/b/dot-agentd",
                "INVISIBLE_DOTS_WORKSPACE": "/w",
                "INVISIBLE_DOTS_ENGINE_STATE": "/state",
                "INVISIBLE_DOTS_OPENROUTER_URL": " http://127.0.0.1:9999/api/v1 ",
                "INVISIBLE_DOTS_NETWORK_CHECK": "127.0.0.1:9999",
                "INVISIBLE_DOTS_MCP_COMMAND": "/opt/mcp",
                "INVISIBLE_DOTS_MODEL_USER": "model",
                "PATH": "/a:/b",
                "HOME": "/home/dotengine",
            }
        )

        assert env == Environment(
            agent_socket="/s/agent.sock",
            agentd_socket="/s/agentd.sock",
            agentd_bin="/b/dot-agentd",
            workspace="/w",
            state_dir="/state",
            openrouter_url="http://127.0.0.1:9999/api/v1",
            network_check="127.0.0.1:9999",
            mcp_command="/opt/mcp",
            path="/a:/b",
            home="/home/dotengine",
            model_user="model",
        )

    def test_a_blank_value_is_the_default(self) -> None:
        env = read_environment({"INVISIBLE_DOTS_WORKSPACE": "  ", "INVISIBLE_DOTS_OPENROUTER_URL": " "})

        assert env.workspace == "/home/dot/workspace"
        assert env.openrouter_url is None


class RunBound:
    """How long `a_run_that_ends` lets main() run, in seconds."""

    seconds = 10.0


@pytest.fixture
def a_run_that_ends(monkeypatch: pytest.MonkeyPatch) -> RunBound:
    """Bound the engine's run inside main(): a test of a refusal then fails, where it would stall.

    main() serves until a signal arrives. A refusal that stopped refusing would start the engine
    and the test would never return, so CI would hang until its own timeout. The refusals all
    come before the engine has anything to wait for, so a run that is still going after the
    bound is a refusal that did not happen.
    """
    bound = RunBound()
    run = entry_point._run

    async def bounded(environment: Environment) -> None:
        try:
            await asyncio.wait_for(run(environment), bound.seconds)
        except TimeoutError:
            pytest.fail(f"the engine was still serving after {bound.seconds} s: it should have refused to start")

    monkeypatch.setattr(entry_point, "_run", bounded)
    return bound


@pytest.mark.usefixtures("a_run_that_ends")
class TestWhatItRefusesToStartOn:
    def environ(self, state: Path, **extra: str) -> dict[str, str]:
        return {
            "INVISIBLE_DOTS_ENGINE_STATE": str(state),
            "INVISIBLE_DOTS_AGENT_SOCKET": str(state.parent / "agent.sock"),
            "INVISIBLE_DOTS_MODEL_USER": OWN_USER,
            "HOME": str(state.parent / "home"),
            **extra,
        }

    def test_a_second_engine_on_the_same_state_does_not_start(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        state = tmp_path / "state"
        owner = DotStore.open(state / "engine.sqlite")
        try:
            assert main([], self.environ(state)) == 1
        finally:
            owner.close()

        assert "another engine owns" in capsys.readouterr().err

    def test_the_bound_fails_an_engine_that_starts_instead_of_stalling(self, a_run_that_ends: RunBound) -> None:
        a_run_that_ends.seconds = 1.0
        directory = short_dir()
        try:
            environ = {
                "INVISIBLE_DOTS_ENGINE_STATE": str(directory / "state"),
                "INVISIBLE_DOTS_AGENT_SOCKET": str(directory / "agent.sock"),
                "INVISIBLE_DOTS_AGENTD_BIN": str(directory / "no-dot-agentd"),
                "INVISIBLE_DOTS_MODEL_USER": OWN_USER,
                "HOME": str(directory),
            }

            with pytest.raises(pytest.fail.Exception, match="still serving after 1.0 s"):
                main([], environ)
        finally:
            shutil.rmtree(directory, ignore_errors=True)


class TestTheModelUser:
    """The API socket refuses the user of the model's commands, so the engine has to be able to name it."""

    def test_the_user_is_named_by_its_id(self) -> None:
        assert refused_peer_uids("root") == frozenset({0})
        assert refused_peer_uids(OWN_USER) == frozenset({os.getuid()})

    def test_no_user_named_refuses_no_one(self) -> None:
        assert refused_peer_uids(None) == frozenset()

    def test_a_user_that_does_not_exist_is_refused_with_the_way_out(self) -> None:
        with pytest.raises(GoldenImageError, match="has no user nobody-here, the user of the model's commands"):
            refused_peer_uids("nobody-here")

    @pytest.mark.usefixtures("a_run_that_ends")
    def test_main_refuses_to_start_before_it_opens_the_state(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        state = tmp_path / "state"

        code = main([], {"INVISIBLE_DOTS_ENGINE_STATE": str(state), "INVISIBLE_DOTS_MODEL_USER": "nobody-here", "HOME": str(tmp_path / "home")})

        assert code == 1
        assert "refusing to start: the golden image has no user nobody-here" in capsys.readouterr().err
        assert not state.exists()


class FakeOpenRouter:
    """What the engine's provider talks to in these tests: it answers "pong" and keeps what it was sent."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.runner: web.AppRunner | None = None
        self.port = free_port()

    async def _completions(self, request: web.Request) -> web.StreamResponse:
        body = await request.json()
        self.requests.append({"headers": dict(request.headers), "body": body})
        # OpenRouter prices every request in the usage of its last chunk; a response without it fails the turn.
        usage = {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6, "cost": 0.0125}
        # The provider always streams: the model's answer comes back as server-sent events.
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)

        def chunk(delta: dict[str, Any], finish: str | None, extra: dict[str, Any] | None = None) -> bytes:
            frame = {
                "id": "chatcmpl-1",
                "object": "chat.completion.chunk",
                "model": body["model"],
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}] if delta or finish else [],
                **(extra or {}),
            }
            return f"data: {json.dumps(frame)}\n\n".encode()

        await response.write(chunk({"role": "assistant", "content": "pong"}, None))
        await response.write(chunk({}, "stop"))
        await response.write(chunk({}, None, {"usage": usage}))
        await response.write(b"data: [DONE]\n\n")
        return response

    async def _models(self, request: web.Request) -> web.Response:
        # OpenRouter's list of models: each with the context window and the longest answer of the provider it
        # routes to by default, which is what the engine reads its limits from.
        model = {"id": "z-ai/glm-5.3-flash", "top_provider": {"context_length": 400_000, "max_completion_tokens": 128_000}}
        return web.json_response({"data": [model]})

    async def start(self) -> None:
        app = web.Application()
        app.router.add_post("/api/v1/chat/completions", self._completions)
        app.router.add_get("/api/v1/models", self._models)
        self.runner = web.AppRunner(app, access_log=None)
        await self.runner.setup()
        await web.TCPSite(self.runner, "127.0.0.1", self.port).start()

    async def stop(self) -> None:
        if self.runner is not None:
            await self.runner.cleanup()


class Served:
    def __init__(self, environment: Environment, session: aiohttp.ClientSession, task: asyncio.Task[None], stop: asyncio.Event, fake: FakeOpenRouter) -> None:
        self.environment = environment
        self.session = session
        self.task = task
        self.stop = stop
        self.fake = fake

    async def call(self, method: str, path: str, body: Any = None) -> tuple[int, str]:
        async with self.session.request(
            method, "http://agent" + path, data=None if body is None else json.dumps(body)
        ) as response:
            return response.status, await response.text()


@asynccontextmanager
async def serving(prepare: Callable[[Environment], None] = lambda environment: None) -> AsyncIterator[Served]:
    """The engine served as `main` serves it; `prepare` sees the environment before it starts."""
    directory = short_dir()
    fake = FakeOpenRouter()
    await fake.start()
    environment = Environment(
        agent_socket=str(directory / "agent.sock"),
        agentd_socket=str(directory / "agentd.sock"),
        agentd_bin=str(directory / "no-dot-agentd"),
        workspace="/home/dot/workspace",
        state_dir=str(directory / "state"),
        openrouter_url=f"http://127.0.0.1:{fake.port}/api/v1",
        network_check=f"127.0.0.1:{fake.port}",
        mcp_command="invisible-playwright-mcp",
        path="",
        home=str(directory),
        model_user=None,
    )
    prepare(environment)
    stop = asyncio.Event()
    task = asyncio.get_running_loop().create_task(serve(environment, stop))
    for _ in range(500):
        if Path(environment.agent_socket).exists() or task.done():
            break
        await asyncio.sleep(0.01)
    session = aiohttp.ClientSession(connector=aiohttp.UnixConnector(path=environment.agent_socket))
    api = Served(environment, session, task, stop, fake)
    yield api
    await session.close()
    stop.set()
    await asyncio.wait_for(task, 30)
    await fake.stop()
    shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture
async def served() -> AsyncIterator[Served]:
    async with serving() as api:
        yield api


async def next_events(api: Served, after: int, count: int) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async with api.session.get(f"http://agent/events/stream?after={after}") as response:
        async for raw in response.content:
            line = raw.decode("utf-8")
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
                if len(events) >= count:
                    break
    return events


class TestTheEngineServed:
    async def test_a_message_goes_through_the_api_the_provider_and_back_into_the_stream(self, served: Served) -> None:
        status, health = await served.call("GET", "/health")
        assert status == 200
        assert json.loads(health)["status"] == "ok"
        assert json.loads(health)["checks"]["network_reachable"] is True

        assert (await served.call("PUT", "/config", runtime_config_body(permissions={"files.read": "allow"})))[0] == 204
        assert (await served.call("POST", "/secrets", {"openrouter_api_key": "sk-or-served", "mcp_secrets": {}}))[0] == 204
        event = {"id": "m1", "type": "user.message", "ts": TS, "data": {"text": "ping"}}
        assert (await served.call("POST", "/events", event))[0] == 202
        events = await asyncio.wait_for(next_events(served, 0, 6), 30)

        assert [e["type"] for e in events] == [
            "agent.started", "agent.state", "agent.state", "message.assistant", "agent.state", "agent.state",
        ]
        assert events[3]["data"] == {"text": "pong", "in_reply_to": "m1", "spent_usd": 0.0125}
        (request,) = served.fake.requests
        # The key reached the provider from memory, the model is the Dot's, and nothing of the Dot's
        # attribution goes to a stand-in.
        assert request["headers"]["Authorization"] == "Bearer sk-or-served"
        assert request["body"]["model"] == "z-ai/glm-5.3-flash"
        assert "HTTP-Referer" not in request["headers"]
        assert "ping" in json.dumps(request["body"]["messages"])
        # The answer may be as long as the model's own longest: the limit OpenRouter publishes for it is sent.
        assert request["body"]["max_tokens"] == 128_000
        # The state is in the one database file, the key in none.
        state = Path(served.environment.state_dir)
        assert (state / "engine.sqlite").exists()
        assert "sk-or-served" not in b"".join(p.read_bytes() for p in state.rglob("*") if p.is_file()).decode("latin-1")

    async def test_the_tokenizer_is_loading_before_the_first_turn(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # No turn has run: only the start can have begun the load, so the first count of a turn is the tokenizer's.
        from nanobot.utils import token_encoding

        monkeypatch.setattr(token_encoding, "_warmup_thread", None)
        monkeypatch.setattr(token_encoding, "_encoding", None)
        async with serving():
            assert token_encoding._warmup_thread is not None
            token_encoding._warmup_thread.join(30)
            assert token_encoding.get_token_encoding() is not None

    async def test_the_cron_service_keeps_its_jobs_in_the_state_directory(self, served: Served) -> None:
        jobs = Path(served.environment.state_dir) / "cron" / "jobs.json"
        for _ in range(100):
            if jobs.exists():
                break
            await asyncio.sleep(0.02)

        assert jobs.exists()

    async def test_an_automation_on_the_disk_at_start_tells_the_host_when_it_is_next_due(self) -> None:
        # The Dot made it before the computer slept: the host learns its next run as the engine comes up.
        def a_job(environment: Environment) -> None:
            jobs = Path(environment.state_dir) / "cron" / "jobs.json"
            jobs.parent.mkdir(parents=True)
            job = {
                "id": "j1",
                "name": "daily",
                "enabled": True,
                "schedule": {"kind": "every", "everyMs": 3_600_000},
                "payload": {"kind": "agent_turn", "message": "go"},
                "state": {},
            }
            jobs.write_text(json.dumps({"version": 1, "jobs": [job]}), encoding="utf-8")

        async with serving(a_job) as served:
            events = await asyncio.wait_for(next_events(served, 0, 3), 30)
        next_runs = [e["data"]["next_run_at_ms"] for e in events if e["type"] == "automation.next_run"]
        assert len(next_runs) == 1 and isinstance(next_runs[0], int)

    async def test_the_cron_timer_stops_before_the_engine_does_so_no_firing_falls_into_the_stop(
        self, served: Served, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A firing that reaches a stopped engine is recorded nowhere, and its job moves on as if it had run.
        order: list[str] = []
        cron_stop = CronService.stop
        engine_stop = Engine.stop

        def record_cron_stop(self: CronService) -> None:
            order.append("cron")
            cron_stop(self)

        async def record_engine_stop(self: Engine) -> None:
            order.append("engine")
            await engine_stop(self)

        monkeypatch.setattr(CronService, "stop", record_cron_stop)
        monkeypatch.setattr(Engine, "stop", record_engine_stop)

        served.stop.set()
        await asyncio.wait_for(served.task, 30)

        assert order == ["cron", "engine"]

    async def test_stopping_closes_the_socket_and_the_database(self, served: Served) -> None:
        socket_path = Path(served.environment.agent_socket)
        assert socket_path.exists()
        stream = asyncio.create_task(next_events(served, 10_000, 1))
        await asyncio.sleep(0.05)

        served.stop.set()
        await asyncio.wait_for(served.task, 30)

        assert not socket_path.exists()
        stream.cancel()
        # The database is free again: another engine can take it.
        DotStore.open(Path(served.environment.state_dir) / "engine.sqlite").close()

    async def test_shutdown_stops_accepting_and_closes_the_streams_before_the_engine_stops(
        self, served: Served, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The order of the contract's index.ts: nothing new is taken while the turns in flight end.
        seen: dict[str, Any] = {}
        real_stop = Engine.stop
        stream = asyncio.create_task(next_events(served, 10_000, 1))
        await asyncio.sleep(0.05)

        async def stop(engine: Engine) -> None:
            try:
                async with aiohttp.ClientSession(
                    connector=aiohttp.UnixConnector(path=served.environment.agent_socket)
                ) as late:
                    await late.get("http://agent/health")
                seen["connected"] = True
            except aiohttp.ClientConnectorError:
                seen["connected"] = False
            # The stream of before is ended by now.
            seen["stream_ended"] = await asyncio.wait_for(stream, 10) == []
            await real_stop(engine)

        monkeypatch.setattr(Engine, "stop", stop)
        served.stop.set()
        await asyncio.wait_for(served.task, 30)

        assert seen == {"connected": False, "stream_ended": True}
