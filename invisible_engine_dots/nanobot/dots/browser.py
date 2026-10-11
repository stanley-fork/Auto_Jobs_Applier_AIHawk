"""The browser identities of the Dot and the invisible-playwright-mcp process of each open one.

Architecture section 6: an identity is a directory under `/home/dot/browsers/<id>` (a Firefox profile
and the MCP server's own home) plus one row of the Dot's database. An identity is OPEN while a
`invisible-playwright-mcp` process serves it, and at most `max_open` are at once. A browser action
runs as a tool call of that process, so the model sees our tool names and an `identity_id`, never the
MCP server's.

Three rules shape this module:

* Nothing model-driven runs as the engine's user. The MCP server is started through
  `dot-agentd relay` (the Computer's `relay_argv`), which runs it as `dot`, so its Firefox reads
  dot's home and the engine's secrets are not in its environment. The directories are made and
  removed through the Computer for the same reason: `/home/dot/browsers` is `dot` 0700.
* nanobot's MCP client stays in use. Each open identity has its own `MCPProvider` on a private
  registry, so spawning, initialize, per-call timeout and the one retry of a transient error are the
  client's. What is the manager's is when a process ends: it gets `on_terminated` instead of a silent
  reconnect, because a restarted process has lost its browser.
* Nothing waits on a browser while holding anything others need. A session is `opening`, `open` or
  `closing`, and what moves it (a launch, a close) is a task of its own. The decisions that keep the slot
  count and the LRU order true (reserve a slot, pick what to close) are made in one step with no await
  in it, so the event loop is the lock; whoever has to wait for a browser waits on the session's task.
  A slow launch therefore holds up only the callers that need that identity, never a config change, a
  close or a delete of another one. Calls on one identity are serialized by that identity's own lock.

An action on a closed identity does not launch it: it fails with `not_open`, so `browser.identity.launch`
decides alone whether a browser starts. An identity whose process ended, or whose browser the server reports
gone while the process lives on (Firefox crashed, its window was closed), is closed the same way: the `closed`
event is emitted once, the call that found out fails with `crashed`, and the next action says `not_open` like
any other. Nothing reopens a browser behind the model's back: the library took that out on purpose (a
repeated click lands on a blank page), and the model, which cannot call `browser_open`, is told to launch
the identity again.
"""

from __future__ import annotations

import asyncio
import base64
import json
import posixpath
import re
import sqlite3
from collections.abc import Callable, Coroutine, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from loguru import logger

from nanobot.agent.tools.base import ToolResult
from nanobot.agent.tools.mcp import MCPProvider, MCPServerConfig
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.dots import store as dots_store
from nanobot.dots.computer import Computer
from nanobot.dots.identity_rules import (
    IdentityRequestError,
    check_identity_request,
    is_valid_identity_id,
    new_identity_id,
)
from nanobot.dots.protocol import BROWSER_ENV, BROWSERS_DIR, GUEST_DISPLAY, MCP_HOMES_DIR
from nanobot.dots.store import BrowserIdentityRow, DotStore

# The name the private registry of one identity knows its one MCP server by.
SERVER_NAME = "browser"

# What `browser_open` answers when the browser started. Anything else that is not an error is the
# engine's download progress, and it is asked again.
_OPENED = re.compile(r"\bbrowser is open\b", re.IGNORECASE)
# What the server answers when its browser closed under it while the process lives on (Firefox crashed): its
# GONE and NOT_OPEN sentences for the main browser (invisible_playwright_mcp/mcp/__init__.py, in the MCP's own
# environment, so there is nothing importable to call; the browser smoke reads the real GONE sentence).
# The sentence is the WHOLE error, behind the prefix FastMCP puts on what a tool raises. A phrase anywhere in
# a longer error is not it: a failed click or select echoes text the page controls (the covering element's
# text, the option asked for), and a page that says "the main browser is gone" must not close the identity.
_BROWSER_LOST = re.compile(
    r"(?:Error executing tool \w+: )?(?:"
    + re.escape("the main browser is not open. Call browser_open to open it.")
    + "|"
    + re.escape(
        "the main browser is gone: it closed or crashed. Call browser_open to open it again; "
        "it comes back as the same person."
    )
    + ")"
)

# Why a session ended without a close of ours, as the log says it.
_PROCESS_ENDED = "the MCP server exited unexpectedly"
_BROWSER_GONE = "the MCP server reports its browser gone (Firefox crashed or its window was closed)"

_DATA_URL = "data:"

CLOSE_TIMEOUT_S = 30.0
# How long a call of a browser tool waits for its answer. The server answers every call within its own bound, the 45
# s it gives a page to load: a typing longer than that goes on in the background and its answer says so
# (invisible-playwright-mcp's `Work.typing`), so no call is meant to reach this.
REQUEST_TIMEOUT_S = 120
# How long a frame waits for the identity's call in flight before it gives up with `busy`.
FRAME_WAIT_S = 5.0
# What a frame is: the route's contract (architecture section 5.3) is a JPEG, and the host labels the bytes as one all the
# way to the browser, so the engine refuses any other media type as a failed frame and the host does not check again.
FRAME_MEDIA_TYPE = "image/jpeg"

SessionState = Literal["opening", "open", "closing"]

# What an identity route (list, create, get, delete, frame, close) can fail with: IDENTITY_ERROR_STATUS of
# protocol.py names the HTTP status of each.
RouteErrorCode = Literal["not_found", "invalid", "limit", "not_open", "busy", "crashed", "frame_failed"]
# `launch_failed` is the launch's alone: the model's browser_identity_launch and browser_open fail with it, and
# no route launches (architecture section 5.3), so no HTTP status names it.
ErrorCode = Literal[RouteErrorCode, "launch_failed"]


class BrowserIdentityError(Exception):
    """A failure whose message is meant to be shown as it is, to the model or in an API answer.

    `not_found`, `invalid` (a bad name or proxy, or an archived identity) and `limit` are the caller's;
    `not_open` is an action on an identity that is not open; `busy` is a frame that found the identity
    in the middle of a call; `launch_failed`, `crashed` and `frame_failed` are the browser's.
    """

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class BrowserIdentity:
    """An identity as callers see it. Whether it has a proxy of its own is all that leaves the manager of it."""

    id: str
    name: str
    status: Literal["available", "open", "archived"]
    created_at: int
    last_used_at: int | None
    profile_path: str
    has_proxy: bool


class _Session:
    """The MCP process of one identity that is opening, open or closing, on a registry of its own."""

    def __init__(
        self,
        identity_id: str,
        proxy: str | None,
        config: MCPServerConfig,
        on_ended: Callable[[_Session], None],
    ) -> None:
        self.identity_id = identity_id
        self.proxy = proxy
        self.registry = ToolRegistry()
        self.provider = MCPProvider({SERVER_NAME: config}, self.registry, on_terminated=self._ended)
        self._on_ended = on_ended
        # Taken by a call for its whole time, so calls on one identity run one at a time, and by a close.
        self.calls = asyncio.Lock()
        # Set when the MCP client reports the process gone.
        self.terminated = False
        self.state: SessionState = "opening"
        # What moves the session: the task that opens it, then the one that closes it. Set by the manager
        # in the step that makes the session, so it is never None for a session the manager holds.
        self.task: asyncio.Task[None] | None = None
        # The task that closes the session once its process is gone: one for every caller that finds out.
        self.ended: asyncio.Task[None] | None = None

    def _ended(self, _server: str) -> None:
        # Called when the process ends, whether or not a call is in flight to find out.
        self.terminated = True
        self._on_ended(self)


def result_text(result: Any) -> str:
    """The text of a tool result: a string as it is, a list of content blocks by its text parts."""
    if isinstance(result, str):
        return result
    return "\n".join(
        part.get("text", "") for part in result if isinstance(part, Mapping) and part.get("type") == "text"
    )


def result_is_error(result: Any) -> bool:
    return isinstance(result, ToolResult) and result.is_error


def split_result(result: Any) -> tuple[str, list[tuple[str, str]]]:
    """A tool result of the MCP client as its text and its images, each as (media type, base64 data)."""
    if isinstance(result, str):
        return str(result), []
    images: list[tuple[str, str]] = []
    for block in result:
        if not isinstance(block, Mapping) or block.get("type") != "image_url":
            continue
        url = (block.get("image_url") or {}).get("url", "")
        header, _, data = url.partition(",")
        if url.startswith(_DATA_URL) and data:
            images.append((header[len(_DATA_URL) :].split(";")[0], data))
    return result_text(result), images


def _check_limits(max_open: int, max_identities: int) -> None:
    for name, value in (("max_open", max_open), ("max_identities", max_identities)):
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError(f"{name} must be an integer of at least 1")


class BrowserManager:
    """Browser identities, their directories and their MCP processes. Everything asynchronous runs on one loop."""

    def __init__(
        self,
        *,
        store: DotStore,
        computer: Computer,
        mcp_command: str,
        max_open: int,
        max_identities: int,
        browsers_dir: str = BROWSERS_DIR,
        mcp_homes_dir: str = MCP_HOMES_DIR,
        display: str = GUEST_DISPLAY,
        open_deadline_s: float = 900.0,
        open_retry_initial_s: float = 2.0,
        open_retry_max_s: float = 30.0,
        request_timeout_s: int = REQUEST_TIMEOUT_S,
        close_timeout_s: float = CLOSE_TIMEOUT_S,
        frame_wait_s: float = FRAME_WAIT_S,
    ) -> None:
        _check_limits(max_open, max_identities)
        if not mcp_command.strip():
            raise ValueError("mcp_command must name a program")
        self._store = store
        self._computer = computer
        self._mcp_command = mcp_command
        self._max_open = max_open
        self._max_identities = max_identities
        self._browsers_dir = browsers_dir
        self._mcp_homes_dir = mcp_homes_dir
        self._display = display
        self._open_deadline_s = open_deadline_s
        self._open_retry_initial_s = open_retry_initial_s
        self._open_retry_max_s = open_retry_max_s
        self._request_timeout_s = request_timeout_s
        self._close_timeout_s = close_timeout_s
        self._frame_wait_s = frame_wait_s
        # Identities with a session in any state, least recently used first (a dict keeps insertion order).
        self._sessions: dict[str, _Session] = {}
        # Identities being deleted: they are gone for every caller from the moment the delete starts.
        self._deleting: set[str] = set()
        # Sessions dropped by a close that has not recorded `closed` yet: it does once their process has ended.
        self._unrecorded: set[_Session] = set()
        # Orders `create`, whose count check and insert are apart by the directory it makes.
        self._create_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # What callers read
    # ------------------------------------------------------------------

    @property
    def limits(self) -> tuple[int, int]:
        """`(max_open, max_identities)`."""
        return self._max_open, self._max_identities

    @property
    def open_count(self) -> int:
        return sum(1 for session in self._sessions.values() if session.state == "open")

    def is_open(self, identity_id: str) -> bool:
        session = self._sessions.get(identity_id)
        return session is not None and session.state == "open"

    def list_identities(self) -> list[BrowserIdentity]:
        """Every identity, oldest first."""
        return [self._view(row) for row in self._store.read(dots_store.list_identities)]

    def get(self, identity_id: str) -> BrowserIdentity | None:
        if not is_valid_identity_id(identity_id):
            return None
        row = self._store.read(lambda conn: dots_store.get_identity(conn, identity_id))
        return self._view(row) if row else None

    # ------------------------------------------------------------------
    # Records
    # ------------------------------------------------------------------

    async def create(self, name: str, proxy: str | None = None) -> BrowserIdentity:
        """Make an identity: its directories on the computer, its row and `browser.identity.created`.

        `proxy` is an explicit option, off by default: with none the identity's browser inherits the VM's egress.
        """
        async with self._create_lock:
            body: dict[str, object] = {"name": name, "proxy": proxy}
            count = self._store.read(dots_store.count_identities)
            try:
                request = check_identity_request(body, count, self._max_identities)
            except IdentityRequestError as error:
                raise BrowserIdentityError(error.code, error.message) from None
            identity_id = new_identity_id(request.name)
            while self._store.read(lambda conn: dots_store.get_identity(conn, identity_id)) is not None:
                identity_id = new_identity_id(request.name)
            await self._make_directories(identity_id)

            def record(conn: sqlite3.Connection) -> None:
                dots_store.insert_identity(conn, identity_id=identity_id, name=request.name, proxy=request.proxy)
                dots_store.append_outbox(
                    conn, "browser.identity.created", {"identity_id": identity_id, "name": request.name}
                )

            self._store.write(record)
            where = " with a proxy of its own" if request.proxy else ""
            logger.info("browser identity {} created ({}){}", identity_id, request.name, where)
            return self._view(self._require(identity_id))

    async def delete(self, identity_id: str) -> None:
        """Close the identity if open, remove its directory, then its row and emit `browser.identity.deleted`.

        The directory goes before the row: one a failed removal left behind would be invisible, while a
        row whose directory is gone can be deleted again. From the start the identity is not found by
        anyone else, so nothing launches it while its directory goes.
        """
        row = self._require(identity_id)
        self._deleting.add(identity_id)
        try:
            session = self._sessions.get(identity_id)
            if session is not None:
                await self._settled(self._begin_close(session))
            await self._remove_directory(identity_id)

            def forget(conn: sqlite3.Connection) -> None:
                dots_store.delete_identity(conn, identity_id)
                dots_store.append_outbox(
                    conn, "browser.identity.deleted", {"identity_id": identity_id, "name": row.name}
                )

            self._store.write(forget)
        finally:
            self._deleting.discard(identity_id)
        logger.info("browser identity {} deleted with its profile", identity_id)

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    async def launch(self, identity_id: str) -> BrowserIdentity:
        """Open the identity's browser; closes the least recently used identity first when `max_open` is reached.

        Waits for the browser, which can take minutes while the engine downloads, and holds up nothing else.
        A launch of an identity that is opening waits for that opening and shares its outcome; one of an
        identity that is closing waits for the close and then opens it.
        """
        while True:
            row = self._require(identity_id)
            if row.archived:
                raise BrowserIdentityError("invalid", f'browser identity "{identity_id}" is archived')
            session = self._sessions.get(identity_id)
            if session is not None and session.state == "open":
                self._touch(identity_id)
                return self._view(row)
            if session is not None and session.state == "closing" and session.task is not None:
                # How the close went is its caller's to hear, not this launch's.
                await asyncio.wait({session.task})
                continue
            owner = session is None
            if session is None:
                session = self._reserve(row)
            task = session.task
            assert task is not None
            try:
                await asyncio.wait({task})
            except asyncio.CancelledError:
                if owner:
                    # The caller gave up: what its launch started is stopped, and its process is gone when
                    # this returns. (The task has run its first step: it was scheduled before this await.)
                    task.cancel()
                    await asyncio.wait({task})
                raise
            if task.cancelled():
                raise BrowserIdentityError(
                    "launch_failed", f'the launch of identity "{identity_id}" was stopped before it finished'
                )
            task.result()
            # The row as the launch left it (its last use); the launch's own record if a delete took it since.
            current = self.get(identity_id)
            return current if current is not None else self._view(row)

    async def close(self, identity_id: str) -> None:
        """Close the identity's browser (a no-op when it is closed); the profile is kept."""
        self._require(identity_id)
        session = self._sessions.get(identity_id)
        if session is not None:
            await self._settled(self._begin_close(session))

    async def close_all(self) -> None:
        """Close every open identity: for suspend, prepare-sleep and shutdown."""
        tasks = [self._begin_close(session) for session in list(self._sessions.values())]
        if tasks:
            await asyncio.wait(tasks)

    def closed_by_exit(self) -> None:
        """The engine stops before these identities finished closing, and its exit ends their processes: each is
        recorded closed now, while the store still takes the event, and a close that ends later records nothing.
        A session still opening was never open: it is only dropped."""
        for session in list(self._sessions.values()):
            if self._forget(session) and session.state != "opening":
                self._unrecorded.add(session)
        for session in list(self._unrecorded):
            self._record_closed(session)

    def _record_closed(self, session: _Session) -> None:
        """Emit `closed` for a session a close dropped, once, whoever gets there first."""
        if session in self._unrecorded:
            self._unrecorded.discard(session)
            self._emit_closed(session.identity_id)

    async def call_tool(self, identity_id: str, tool: str, arguments: Mapping[str, Any] | None = None) -> Any:
        """Call a tool of the identity's MCP server, which serves the identity's browser alone (`HOST_MANAGED`).

        Returns what nanobot's MCP client returns: text, or a list of content blocks when the result has
        an image, and an error as a `ToolResult` with `is_error`. Raises `not_open` for an identity that is
        not open, and `crashed` when its process ended or when the server says its browser is gone: the
        identity is closed first, so the model launches it again instead of repeating a call on a page
        that is no longer there.
        """
        session = self._sessions.get(identity_id) if is_valid_identity_id(identity_id) else None
        if session is None or session.state != "open":
            raise self._not_open(identity_id)
        async with session.calls:
            if session.state != "open" or self._sessions.get(identity_id) is not session:
                raise self._not_open(identity_id)
            self._touch(identity_id)
            result = await self._request(session, tool, arguments or {})
            if session.terminated:
                await self._process_ended(session)
                raise BrowserIdentityError(
                    "crashed",
                    f'the browser process of identity "{identity_id}" exited during {tool}; '
                    "the identity is closed, launch it again",
                )
            if self._is_browser_lost(result):
                await self._browser_lost(session)
                raise BrowserIdentityError(
                    "crashed",
                    f'the browser of identity "{identity_id}" is gone: it closed or crashed during {tool}. '
                    "The identity is closed and keeps its profile: call browser_identity_launch to open it "
                    "again as the same person, then navigate again, because it comes back on a blank page",
                )
            return result

    async def frame(self, identity_id: str) -> tuple[str, bytes]:
        """One frame of the open identity's window, as `(media type, bytes)`: what the UI shows of a browser.

        This only looks. It does not count as a use (the LRU order and `last_used_at` stay as they were, so
        a page that polls cannot keep a browser open), and it never opens a browser the server lost: that
        is `not_open`, because opening is the decision of `browser_identity_launch`. It waits at most
        `frame_wait_s` for the call in flight on the identity and then says `busy`.
        """
        self._require(identity_id)
        session = self._sessions.get(identity_id)
        if session is None or session.state != "open":
            raise self._not_open(identity_id)
        try:
            await asyncio.wait_for(session.calls.acquire(), timeout=self._frame_wait_s)
        except asyncio.TimeoutError:
            raise BrowserIdentityError(
                "busy", f'browser identity "{identity_id}" is busy with a call; ask again in a moment'
            ) from None
        try:
            if session.state != "open" or self._sessions.get(identity_id) is not session:
                raise self._not_open(identity_id)
            result = await self._request(session, "browser_watch", {})
            if session.terminated:
                await self._process_ended(session)
                raise BrowserIdentityError(
                    "crashed",
                    f'the browser process of identity "{identity_id}" exited; the identity is closed, launch it again',
                )
        finally:
            session.calls.release()
        text = result_text(result)
        if result_is_error(result):
            if self._is_browser_lost(result):
                # The same fact a call finds out: the identity is closed now, not "open" with nothing to show.
                await self._browser_lost(session)
                raise self._not_open(identity_id)
            raise BrowserIdentityError("frame_failed", f'no frame of identity "{identity_id}": {text}')
        _, images = split_result(result)
        if not images:
            raise BrowserIdentityError("frame_failed", f'no frame of identity "{identity_id}": the server sent no image')
        mime, data = images[0]
        if mime != FRAME_MEDIA_TYPE:
            raise BrowserIdentityError(
                "frame_failed", f'no frame of identity "{identity_id}": the server sent {mime or "no media type"}, not {FRAME_MEDIA_TYPE}'
            )
        try:
            return mime, base64.b64decode(data, validate=True)
        except ValueError:
            raise BrowserIdentityError(
                "frame_failed", f'no frame of identity "{identity_id}": the image is damaged'
            ) from None

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _view(self, row: BrowserIdentityRow) -> BrowserIdentity:
        status: Literal["available", "open", "archived"] = "archived" if row.archived else "available"
        if self.is_open(row.id):
            status = "open"
        return BrowserIdentity(
            id=row.id,
            name=row.name,
            status=status,
            created_at=row.created_at,
            last_used_at=row.last_used_at,
            profile_path=posixpath.join(self._browsers_dir, row.id, "profile"),
            has_proxy=bool(row.proxy),
        )

    def _require(self, identity_id: str) -> BrowserIdentityRow:
        # An id becomes a directory name: one that could leave `browsers/` is "not found", never looked up.
        row = (
            self._store.read(lambda conn: dots_store.get_identity(conn, identity_id))
            if is_valid_identity_id(identity_id) and identity_id not in self._deleting
            else None
        )
        if row is None:
            raise BrowserIdentityError("not_found", f'no browser identity "{identity_id}"')
        return row

    @staticmethod
    def _not_open(identity_id: str) -> BrowserIdentityError:
        return BrowserIdentityError(
            "not_open", f"identity {identity_id} is not open; call browser_identity_launch first"
        )

    def _touch(self, identity_id: str) -> None:
        self._sessions[identity_id] = self._sessions.pop(identity_id)

    def _paths(self, identity_id: str) -> tuple[str, str, str]:
        """The identity's directory, its profile, and the home of its MCP server.

        The home is not under the identity's directory, nor anywhere under /home/dot: for an identity that has a
        proxy of its own the server saves it, password included, in a session file under its home, and the host's
        file routes read /home/dot and nothing else.
        """
        root = posixpath.join(self._browsers_dir, identity_id)
        return root, posixpath.join(root, "profile"), posixpath.join(self._mcp_homes_dir, identity_id)

    async def _make_directories(self, identity_id: str) -> None:
        _, profile, mcp_home = self._paths(identity_id)
        result = await self._computer.run(["mkdir", "-p", "--", profile, mcp_home])
        if result.exit_code != 0:
            raise RuntimeError(
                f"could not make the directories of browser identity {identity_id}: "
                f"{result.stderr.decode('utf-8', 'replace').strip()}"
            )

    async def _remove_directory(self, identity_id: str) -> None:
        root, _, mcp_home = self._paths(identity_id)
        result = await self._computer.run(["rm", "-rf", "--", root, mcp_home])
        if result.exit_code != 0:
            raise RuntimeError(
                f"could not remove the directory of browser identity {identity_id}: "
                f"{result.stderr.decode('utf-8', 'replace').strip()}"
            )

    def _server_config(self, identity_id: str, proxy: str | None) -> MCPServerConfig:
        root, profile, mcp_home = self._paths(identity_id)
        environment = {
            BROWSER_ENV["MCP_HOME"]: mcp_home,
            BROWSER_ENV["MCP_SESSION_ID"]: identity_id,
            BROWSER_ENV["PROFILE_DIR"]: profile,
            BROWSER_ENV["HEADLESS"]: "0",
            BROWSER_ENV["DISPLAY"]: self._display,
            # invisible_core reinstalls itself from the package index when its version drifts; the image installed it
            # from a hashed lock, and a drift has to fail loudly instead of bringing in files nobody checked.
            BROWSER_ENV["CORE_AUTOFIX"]: "off",
            # The engine opens and closes this browser and the model has the page tools only: the server serves
            # `main` alone (no tool takes `browser`, so a caller cannot choose another) and its instructions are
            # the page rules, without the browser_open the model cannot call.
            BROWSER_ENV["HOST_MANAGED"]: "1",
        }
        # An identity has no proxy unless the person gave it one: then no proxy variable is set at all and the
        # browser inherits the egress of the VM, whatever the engine's own environment holds. A proxy carries a
        # password: it goes to the relay by its environment, never by its command line, which every user of the
        # VM can read in /proc.
        secrets = {BROWSER_ENV["PROXY"]: proxy} if proxy else {}
        argv = self._computer.relay_argv([self._mcp_command], cwd=root, env=environment, secrets=secrets)
        return MCPServerConfig(
            command=argv[0],
            args=argv[1:],
            env=self._computer.spawn_env(secrets=secrets),
            tool_timeout=self._request_timeout_s,
            images=True,
        )

    def _live_sessions(self) -> list[_Session]:
        """The sessions that hold a slot of `max_open`, least recently used first."""
        return [session for session in self._sessions.values() if session.state != "closing"]

    def _make_room(self, slots: int) -> list[asyncio.Task[None]]:
        """Start closing the least recently used sessions until at most `slots` hold a slot; the closes' tasks."""
        live = self._live_sessions()
        closes = []
        for session in live[: max(len(live) - slots, 0)]:
            logger.info(
                "closing browser identity {}, the least recently used, to stay within max_open {}",
                session.identity_id,
                self._max_open,
            )
            closes.append(self._begin_close(session))
        return closes

    def _reserve(self, row: BrowserIdentityRow) -> _Session:
        """Take a slot for the identity: close what must make room, and start opening it. Never awaits."""
        closes = self._make_room(self._max_open - 1)
        session = _Session(row.id, row.proxy, self._server_config(row.id, row.proxy), self._session_ended)
        self._sessions[row.id] = session
        session.task = self._spawn(self._bring_up(session, row, closes))
        return session

    def _begin_close(self, session: _Session) -> asyncio.Task[None]:
        """Mark the session closing and start the task that closes it; the one already closing it if there is one."""
        if session.state == "closing" and session.task is not None:
            return session.task
        opening = session.task if session.state == "opening" else None
        session.state = "closing"
        session.task = self._spawn(self._shut_down(session, opening))
        return session.task

    def _spawn(self, work: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        task = asyncio.get_running_loop().create_task(work)
        task.add_done_callback(self._report_failure)
        return task

    @staticmethod
    def _report_failure(task: asyncio.Task[None]) -> None:
        """What a task of the manager failed with, unless it is an answer for a caller (a launch that failed)."""
        if task.cancelled():
            return
        error = task.exception()
        if error is not None and not isinstance(error, BrowserIdentityError):
            logger.error("browser identity task failed: {}: {}", type(error).__name__, error)

    @staticmethod
    async def _settled(task: asyncio.Task[None] | None) -> None:
        """Wait for the task of a session and raise what it raised. A caller that is cancelled leaves it running."""
        if task is not None:
            await asyncio.wait({task})
            task.result()

    async def _bring_up(self, session: _Session, row: BrowserIdentityRow, closes: list[asyncio.Task[None]]) -> None:
        identity_id = row.id
        try:
            if closes:
                await asyncio.wait(closes)
            await self._make_directories(identity_id)
            logger.info("launching browser identity {}: {}", identity_id, self._mcp_command)
            failed = await session.provider.connect()
            if failed or session.registry.get(self._tool_name("browser_open")) is None:
                raise BrowserIdentityError(
                    "launch_failed", f'could not start "{self._mcp_command}" for identity "{identity_id}"'
                )
            await self._open_browser(session)
        except BaseException:
            self._forget(session)
            await session.provider.aclose()
            raise
        if session.state == "opening":
            # A close that came in meanwhile owns the state: it closes what this opened.
            session.state = "open"

        def record(conn: sqlite3.Connection) -> None:
            dots_store.touch_identity(conn, identity_id)
            dots_store.append_outbox(conn, "browser.identity.launched", {"identity_id": identity_id, "name": row.name})

        self._store.write(record)
        logger.info("browser identity {} is open", identity_id)

    @staticmethod
    def _tool_name(tool: str) -> str:
        return f"mcp_{SERVER_NAME}_{tool}"

    async def _request(self, session: _Session, tool: str, arguments: Mapping[str, Any]) -> Any:
        wrapper = session.registry.get(self._tool_name(tool))
        if wrapper is None:
            raise ValueError(f"the browser server has no tool {tool}")
        return await wrapper.execute(**arguments)

    async def _open_browser(self, session: _Session) -> None:
        """`browser_open` with nothing but the browser role: the environment is the one source of the profile
        and the proxy, and the profile owns the seed.

        While the engine is still downloading, the server answers with its progress instead of a browser,
        so this asks again, waiting 2 s doubling to 30 s, until the deadline.
        """
        identity_id = session.identity_id
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._open_deadline_s
        wait = self._open_retry_initial_s
        while True:
            result = await self._request(session, "browser_open", {})
            text = result_text(result)
            if session.terminated:
                raise BrowserIdentityError(
                    "launch_failed", f'the browser process of identity "{identity_id}" exited while it was opening'
                )
            if result_is_error(result):
                raise BrowserIdentityError("launch_failed", f'browser_open failed for identity "{identity_id}": {text}')
            if _OPENED.search(text):
                return
            if loop.time() + wait > deadline:
                raise BrowserIdentityError(
                    "launch_failed",
                    f'the browser of identity "{identity_id}" was not ready within '
                    f"{round(self._open_deadline_s)} s; last answer: {text}",
                )
            logger.info("browser identity {}: not ready yet ({}); asking again in {} s", identity_id, text, wait)
            await asyncio.sleep(wait)
            wait = min(wait * 2, self._open_retry_max_s)

    def _forget(self, session: _Session) -> bool:
        """Drop the session when it is still the identity's; True for the one caller that did."""
        if self._sessions.get(session.identity_id) is not session:
            return False
        del self._sessions[session.identity_id]
        return True

    def _emit_closed(self, identity_id: str) -> None:
        row = self._store.read(lambda conn: dots_store.get_identity(conn, identity_id))
        name = row.name if row else ""

        def record(conn: sqlite3.Connection) -> None:
            dots_store.append_outbox(conn, "browser.identity.closed", {"identity_id": identity_id, "name": name})

        self._store.write(record)

    def _session_ended(self, session: _Session) -> None:
        """The MCP client says the process is gone: an open identity is closed now, not at the next call.

        A session that is opening or closing is not touched: its launch or its close sees `terminated`.
        """
        if session.state == "open" and self._sessions.get(session.identity_id) is session:
            self._end_session(session, _PROCESS_ENDED)

    def _end_session(self, session: _Session, why: str) -> asyncio.Task[None]:
        """The one task that closes a session that cannot be used any more, started by whoever finds out first.

        `why` is what the first of them found, for the log: the process is gone, or it lives on without its browser.
        """
        if session.ended is None:
            session.ended = self._spawn(self._close_ended(session, why))
        return session.ended

    async def _process_ended(self, session: _Session) -> None:
        """The MCP process is gone: wait until the identity is closed and `closed` is emitted."""
        await asyncio.wait({self._end_session(session, _PROCESS_ENDED)})

    async def _browser_lost(self, session: _Session) -> None:
        """The server says its browser is gone while its process lives on: close the identity, emit `closed`.

        The process is stopped as well. Its browser is not coming back (the server never opens one by itself,
        that is the library's rule), and a launch makes a process of its own.
        """
        await asyncio.wait({self._end_session(session, _BROWSER_GONE)})

    @staticmethod
    def _is_browser_lost(result: Any) -> bool:
        return result_is_error(result) and _BROWSER_LOST.fullmatch(result_text(result).strip()) is not None

    async def _close_ended(self, session: _Session, why: str) -> None:
        """Close the identity of a session that cannot be used any more, and emit `closed` once."""
        if not self._forget(session):
            return
        self._unrecorded.add(session)
        logger.warning("browser identity {}: {}", session.identity_id, why)
        await session.provider.aclose()
        self._record_closed(session)

    async def _shut_down(self, session: _Session, opening: asyncio.Task[None] | None) -> None:
        """Close a session: `browser_close` first, so Firefox flushes its profile, then the process.

        The SDK waits only 2 s for a process to leave after its stdin closes, which is too short for
        that. A close that fails is logged and the process is ended anyway. A session still opening is
        closed once its launch has finished: what the launch opened is closed, and a launch that failed
        left nothing to close.
        """
        identity_id = session.identity_id
        if opening is not None:
            await asyncio.wait({opening})
        async with session.calls:
            if self._sessions.get(identity_id) is not session:
                return
            try:
                result = await asyncio.wait_for(
                    self._request(session, "browser_close", {}), timeout=self._close_timeout_s
                )
                if result_is_error(result):
                    logger.warning(
                        "browser identity {}: browser_close failed ({}); stopping the process anyway",
                        identity_id,
                        result_text(result),
                    )
            except asyncio.TimeoutError:
                logger.warning(
                    "browser identity {}: browser_close timed out after {} s; stopping the process anyway",
                    identity_id,
                    self._close_timeout_s,
                )
            except Exception as error:
                logger.warning(
                    "browser identity {}: browser_close raised {}: {}; stopping the process anyway",
                    identity_id,
                    type(error).__name__,
                    error,
                )
            if not self._forget(session):
                return
            self._unrecorded.add(session)
            try:
                await session.provider.aclose()
            finally:
                self._record_closed(session)
            logger.info("browser identity {} closed", identity_id)

