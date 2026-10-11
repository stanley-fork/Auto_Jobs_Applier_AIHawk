"""A turn runner wired to a real store, the real tools on a local computer and a scripted model."""

from __future__ import annotations

import dataclasses
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fakes.browser_manager import make_browser_manager
from fakes.local_computer import LocalComputer
from fakes.scripted_provider import ScriptedProvider, ScriptEntry
from nanobot.agent.memory import Consolidator
from nanobot.agent.tools.exec_session import ExecSessionManager
from nanobot.cron.service import CronService
from nanobot.dots import store as s
from nanobot.dots.gate import DotsGate
from nanobot.dots.permissions import ToolDeps, build_registry
from nanobot.dots.projection import EngineSettings, project
from nanobot.dots.protocol import DotRuntimeConfig
from nanobot.dots.provider import OpenRouterProviders
from nanobot.dots.mcp_servers import McpServers
from nanobot.dots.secrets import KeyHolder, McpSecrets
from nanobot.dots.store import DotStore
from nanobot.dots.turns import OpeningMessage, TurnOutcome, TurnRunner, TurnUnit

KEY = "sk-or-test"


class RecordingHost:
    """The engine's side of a turn: it records what the hook reports and keeps the intents as the engine does."""

    def __init__(self, store: DotStore) -> None:
        self.store = store
        self.events: list[tuple[str, Any]] = []
        self.suspending = False
        # Called with the intent at the moment a tool is about to run.
        self.on_tool_started: Callable[[s.ToolIntent], None] | None = None

    def is_suspending(self) -> bool:
        return self.suspending

    def run_started(self, unit: TurnUnit) -> None:
        self.events.append(("run_started", unit.session_key))

    def tool_started(self, intent: s.ToolIntent) -> None:
        self.events.append(("tool_started", intent.tool))
        self.store.write(lambda conn: s.record_tool_intent(conn, intent))
        if self.on_tool_started is not None:
            self.on_tool_started(intent)

    def tool_ended(self, session_key: str) -> None:
        self.events.append(("tool_ended", session_key))


class FixedProviders(OpenRouterProviders):
    """Hands the scripted provider out in place of OpenRouter's, and counts the asks."""

    def __init__(self, provider: ScriptedProvider) -> None:
        super().__init__()
        self.provider = provider
        self.asked: list[tuple[str, str, str | None]] = []

    def current(self, settings: EngineSettings, key: str) -> Any:
        self.asked.append((key, settings.model_id, settings.openrouter_base_url))
        return self.provider


class Harness:
    def __init__(
        self,
        tmp_path: Path,
        store: DotStore,
        config: DotRuntimeConfig,
        script: list[ScriptEntry],
        *,
        max_tokens: int = 1000,
    ) -> None:
        self.tmp_path = tmp_path
        self.store = store
        self.config: DotRuntimeConfig | None = config
        self.settings_override: dict[str, Any] = {}
        self.provider = ScriptedProvider(script, max_tokens=max_tokens)
        self.providers = FixedProviders(self.provider)
        self.keys = KeyHolder()
        self.keys.set(KEY)
        self.host = RecordingHost(store)
        workspace = tmp_path / "home" / "dot" / "workspace"
        workspace.mkdir(parents=True)
        self.computer = LocalComputer(tmp_path, workspace)
        self.injections: list[list[OpeningMessage]] = []
        self.browser = make_browser_manager(tmp_path, store, self.computer)
        registry = build_registry(
            ToolDeps(
                computer=self.computer,
                exec_session_manager=ExecSessionManager(),
                cron_service=CronService(tmp_path / "cron" / "jobs.json"),
                browser=self.browser,
            )
        )
        self.mcp_secrets = McpSecrets()
        self.mcp_servers = McpServers(computer=self.computer, registry=registry, secrets=self.mcp_secrets)
        self.runner = TurnRunner(
            store=store,
            computer=self.computer,
            base_registry=registry,
            mcp_servers=self.mcp_servers,
            providers=self.providers,
            key_holder=self.keys,
            settings_getter=self._settings,
            gate=DotsGate(lambda: self.config, store),
            consolidator=Consolidator(),
            host=self.host,
            injection_source=self._inject,
        )

    def _settings(self) -> EngineSettings | None:
        if self.config is None:
            return None
        settings = project(self.config, workspace=self.computer.workspace, openrouter_base_url=None)
        return dataclasses.replace(settings, **self.settings_override)

    async def _inject(self) -> list[OpeningMessage]:
        return self.injections.pop(0) if self.injections else []

    async def run(self, unit: TurnUnit) -> TurnOutcome:
        return await self.runner.run(unit)

    def messages(self, session_key: str = s.CHAT_SESSION_KEY) -> list[dict[str, Any]]:
        return self.store.read(lambda conn: s.read_messages(conn, session_key))

    def events(self) -> list[tuple[str, dict[str, Any]]]:
        rows = self.store.read(lambda conn: s.read_outbox_after(conn, 0, 1000))
        return [(row["type"], row["data"]) for row in rows]

    def events_of(self, event_type: str) -> list[dict[str, Any]]:
        return [data for kind, data in self.events() if kind == event_type]

    def accept(self, inbound_id: str, text: str = "hello") -> None:
        event = {"id": inbound_id, "type": "user.message", "ts": "2026-10-05T10:00:00.000Z", "data": {"text": text}}
        self.store.write(lambda conn: s.record_inbound(conn, event, "accepted"))

    def inbound_state(self, inbound_id: str) -> str:
        rows = self.store.read(
            lambda conn: conn.execute("SELECT state FROM dots_inbound WHERE id = ?", (inbound_id,)).fetchone()
        )
        return rows[0]

    def start_task(self, task_id: str = "t1") -> str:
        self.store.write(lambda conn: s.enqueue_task(conn, task_id=task_id, description="do it", priority=0))
        self.store.write(lambda conn: s.start_task(conn, task_id))
        return s.task_session_key(task_id)

