"""The Dot's API (invisible_dots architecture section 5.3), served on its unix socket.

The host reaches it as `/v1/agent/...` through dot-agentd, which checked the
Dot's token already. The socket's directory admits only the engine's user and
dot-agentd's, so this server does no authentication of its own. It does refuse
one thing the directory already keeps out: a peer that runs as the user of the
model's commands (SO_PEERCRED), so that a directory mode changed by mistake
does not leave the Dot's permissions and approvals to its own model.

The server logs a request's method, path and status, never a body: the body of
`POST /secrets` is the OpenRouter key and the MCP servers' secrets.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import struct
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import unquote

from aiohttp import web
from loguru import logger

from nanobot.dots.browser import BrowserIdentity, BrowserIdentityError
from nanobot.dots.checks import GuestCheckRunner
from nanobot.dots.engine import Engine, EngineStopped
from nanobot.dots.protocol import (
    AGENT_ROUTES,
    BROWSER_IDENTITY_ACTIONS,
    IDENTITY_ERROR_STATUS,
    DotsConfigError,
    InvalidEvent,
    parse_inbound_event,
)
from nanobot.dots.secrets import KeyHolder, McpSecrets
from nanobot.dots.store import iso_from_ms

MAX_BODY_BYTES = 1024 * 1024
HEARTBEAT_S = 15.0
SOCKET_MODE = 0o660
# Events sent per read of the outbox while a stream catches up.
_STREAM_BATCH = 500


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _error_body(code: str, message: str) -> dict[str, str]:
    return {"error": code, "message": message}


def _allow(method: str, *allowed: str) -> None:
    if method not in allowed:
        raise HttpError(405, "method_not_allowed", f"{method} is not allowed here; use {' or '.join(allowed)}")


def _identity_error(error: BrowserIdentityError) -> HttpError:
    """The answer for a failed browser identity request; its status is the shared table's (`not_open` is an
    action on a closed identity: the Dot's tools make it, and so does a frame of one).

    `launch_failed` has no status because no route launches. If one ever raises it, the engine has a defect
    and answers as one: a logged 500 `internal` that keeps the reason, not a failure inside this table. The log
    carries the traceback, as the middleware's own 500 does, so it shows where the defect is."""
    status = IDENTITY_ERROR_STATUS.get(error.code)
    if status is None:
        logger.opt(exception=error).error(
            "a browser identity route raised {} which no route answers with: {}", error.code, error.message
        )
        return HttpError(500, "internal", error.message)
    return HttpError(status, error.code, error.message)


def _identity_json(identity: BrowserIdentity) -> dict[str, object]:
    """An identity as `BrowserIdentity` of packages/shared protocol.ts has it; it says whether there is a proxy, not which."""
    return {
        "id": identity.id,
        "name": identity.name,
        "createdAt": iso_from_ms(identity.created_at),
        "lastUsedAt": iso_from_ms(identity.last_used_at) if identity.last_used_at is not None else None,
        "status": identity.status,
        "profilePath": identity.profile_path,
        "hasProxy": identity.has_proxy,
    }


async def _read_json(request: web.Request, max_bytes: int) -> object:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.content.iter_chunked(64 * 1024):
        size += len(chunk)
        if size > max_bytes:
            raise HttpError(413, "payload_too_large", f"the body is larger than {max_bytes} bytes")
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw.strip():
        raise HttpError(400, "invalid_json", "the body is empty; expected JSON")
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        # Not the parser's message: it can quote the body, and the body of /secrets is a key.
        raise HttpError(400, "invalid_json", "the body is not valid JSON") from None


def _compact(value: object) -> str:
    """JSON with no spaces, as the host's JSON.stringify writes it: what every reader of the API sees."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _json_response(status: int, body: object) -> web.Response:
    return web.Response(
        status=status, text=_compact(body), content_type="application/json", charset="utf-8"
    )


class _Stream:
    """One open event stream: the wake-up it waits on and the end the server can ask for."""

    def __init__(self) -> None:
        self.wake = asyncio.Event()
        self.closing = False

    def close(self) -> None:
        self.closing = True
        self.wake.set()


def peer_uid(request: web.Request) -> int | None:
    """The user id of the process on the other end of the request's unix socket, as the kernel recorded it
    when that process connected; None when the kernel cannot say."""
    option = getattr(socket, "SO_PEERCRED", None)
    sock = request.transport.get_extra_info("socket") if request.transport is not None else None
    if option is None or sock is None:
        return None
    try:
        _pid, uid, _gid = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, option, struct.calcsize("3i")))
    except OSError:
        return None
    return int(uid)


class AgentServer:
    def __init__(
        self,
        *,
        engine: Engine,
        key_holder: KeyHolder,
        mcp_secrets: McpSecrets,
        checks: GuestCheckRunner,
        max_body_bytes: int = MAX_BODY_BYTES,
        heartbeat_s: float = HEARTBEAT_S,
        refused_uids: frozenset[int] = frozenset(),
    ) -> None:
        self._engine = engine
        self._key_holder = key_holder
        self._mcp_secrets = mcp_secrets
        self._checks = checks
        self._max_body = max_body_bytes
        self._heartbeat_s = heartbeat_s
        self._refused_uids = refused_uids
        self._streams: set[_Stream] = set()
        self._stopping = False
        self._runner: web.AppRunner | None = None
        self._socket_path: Path | None = None
        self._app = web.Application(middlewares=[self._errors, self._peers])
        self._app.router.add_route("*", "/{tail:.*}", self._handle)

    # --- the socket ---------------------------------------------------------

    async def listen(self, socket_path: str | Path) -> None:
        """Bind the socket (a file left by a crash is removed first) and serve."""
        path = Path(socket_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        runner = web.AppRunner(self._app, access_log=None, handler_cancellation=True)
        await runner.setup()
        await web.UnixSite(runner, str(path)).start()
        # The directory decides who may connect: the engine's user and dot-agentd's.
        os.chmod(path, SOCKET_MODE)
        self._runner = runner
        self._socket_path = path
        logger.info("Dot API listening socket={}", path)

    async def stop_accepting(self) -> None:
        """Stop listening: no new connection is taken, and no new stream on a connection kept open from before.
        Requests and streams already open go on."""
        self._stopping = True
        if self._runner is not None:
            for site in list(self._runner.sites):
                await site.stop()

    def close_streams(self) -> None:
        """End every open event stream, so `close` can finish."""
        for stream in list(self._streams):
            stream.close()

    async def close(self) -> None:
        self.close_streams()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        if self._socket_path is not None:
            self._socket_path.unlink(missing_ok=True)
            self._socket_path = None
        logger.info("Dot API stopped")

    # --- requests -----------------------------------------------------------

    @web.middleware
    async def _errors(
        self, request: web.Request, handler: Callable[[web.Request], Awaitable[web.StreamResponse]]
    ) -> web.StreamResponse:
        try:
            response = await handler(request)
        except HttpError as error:
            response = _json_response(error.status, _error_body(error.code, error.message))
        except web.HTTPException:
            raise
        except Exception as error:
            logger.opt(exception=True).error("request failed method={} path={}", request.method, request.path)
            response = _json_response(500, _error_body("internal", str(error)))
        if request.path != AGENT_ROUTES["events_stream"]:
            logger.debug("request method={} path={} status={}", request.method, request.path, response.status)
        return response

    @web.middleware
    async def _peers(
        self, request: web.Request, handler: Callable[[web.Request], Awaitable[web.StreamResponse]]
    ) -> web.StreamResponse:
        """Refuse a request from a process that runs as one of `refused_uids`, the user of the model's commands.

        A peer whose user the kernel cannot name is refused too, when there is anyone to refuse: a check that
        passes on an error would be open exactly when it is needed."""
        if self._refused_uids:
            uid = peer_uid(request)
            if uid is None or uid in self._refused_uids:
                logger.warning("a request was refused for its peer uid={} method={} path={}", uid, request.method, request.path)
                raise HttpError(403, "forbidden_peer", "this socket serves dot-agentd only")
        return await handler(request)

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        # The path as sent: a route is matched on it and an identity id is decoded from it, once.
        path = re.sub(r"/+$", "", request.rel_url.raw_path) or "/"
        method = request.method
        engine = self._engine
        browser = engine.browser

        if path == AGENT_ROUTES["health"]:
            _allow(method, "GET")
            checks = await self._checks()
            return _json_response(
                200,
                {
                    "status": "ok" if engine.started else "starting",
                    "state": engine.state,
                    "openrouter_configured": self._key_holder.configured,
                    "browser": {"identities": len(browser.list_identities()), "open": browser.open_count},
                    "checks": checks.to_json(),
                },
            )

        if path == AGENT_ROUTES["secrets"]:
            _allow(method, "POST")
            body = await _read_json(request, self._max_body)
            key = body.get("openrouter_api_key") if isinstance(body, dict) else None
            if not isinstance(key, str):
                raise HttpError(400, "invalid_secret", "openrouter_api_key must be a non-empty string")
            if not isinstance(body, dict) or "mcp_secrets" not in body:
                raise HttpError(400, "invalid_secret", "mcp_secrets must be an object of servers")
            # Both checked before either is held: a request refused changes nothing.
            mcp_secrets = McpSecrets()
            try:
                mcp_secrets.set(body["mcp_secrets"])
            except ValueError as error:
                # The holder's reasons never name a value; `from None` keeps the chain out of any log too.
                raise HttpError(400, "invalid_secret", str(error)) from None
            try:
                change = self._key_holder.set(key)
            except ValueError as error:
                raise HttpError(400, "invalid_secret", f"openrouter_api_key: {error}") from None
            changed = self._mcp_secrets.set(body["mcp_secrets"])
            # Never a value, not even a prefix of one.
            logger.info("OpenRouter key {}; MCP secrets {}", change, "changed" if changed else "unchanged")
            engine.secrets_received()
            return web.Response(status=204)

        if path == AGENT_ROUTES["config"]:
            _allow(method, "PUT")
            body = await _read_json(request, self._max_body)
            try:
                engine.set_config(body)
            except DotsConfigError as error:
                raise HttpError(400, "invalid_config", str(error)) from None
            return web.Response(status=204)

        if path == AGENT_ROUTES["events"]:
            _allow(method, "POST")
            body = await _read_json(request, self._max_body)
            try:
                event = parse_inbound_event(body)
            except InvalidEvent as error:
                raise HttpError(400, "invalid_event", str(error)) from None
            try:
                engine.accept(event)
            except EngineStopped as error:
                raise HttpError(503, "shutting_down", str(error)) from None
            return _json_response(202, {"accepted": True})

        if path == AGENT_ROUTES["events_stream"]:
            _allow(method, "GET")
            return await self._stream(request)

        if path == AGENT_ROUTES["state"]:
            _allow(method, "GET")
            answer = engine.state_answer()
            return _json_response(
                200,
                {
                    "state": answer.state,
                    "current_task_id": answer.current_task_id,
                    "pending_approval": answer.pending_approval,
                },
            )

        identities_route = AGENT_ROUTES["browser_identities"]
        if path == identities_route:
            if method == "GET":
                return _json_response(200, {"identities": [_identity_json(i) for i in browser.list_identities()]})
            _allow(method, "GET", "POST")
            body = await _read_json(request, self._max_body)
            if not isinstance(body, dict) or not isinstance(body.get("name"), str):
                raise HttpError(400, "invalid", "name must be a string")
            proxy = body.get("proxy")
            if proxy is not None and not isinstance(proxy, str):
                raise HttpError(400, "invalid", "proxy must be a string")
            try:
                created = await browser.create(body["name"], proxy or None)
            except BrowserIdentityError as error:
                raise _identity_error(error) from None
            return _json_response(201, _identity_json(created))

        if path.startswith(f"{identities_route}/"):
            # The id is the segment before the action, decoded once: the percent sign of "a%2541" is the id's own.
            raw_id, _, action = path[len(identities_route) + 1 :].partition("/")
            identity_id = unquote(raw_id)
            if identity_id == "" or "/" in identity_id or (action and action not in BROWSER_IDENTITY_ACTIONS):
                raise HttpError(404, "not_found", f"no route {method} {path}")
            if action == "frame":
                _allow(method, "GET")
                try:
                    media_type, jpeg = await browser.frame(identity_id)
                except BrowserIdentityError as error:
                    raise _identity_error(error) from None
                # A frame is live: nothing may keep it.
                return web.Response(body=jpeg, content_type=media_type, headers={"Cache-Control": "no-store"})
            if action == "close":
                _allow(method, "POST")
                try:
                    await browser.close(identity_id)
                except BrowserIdentityError as error:
                    raise _identity_error(error) from None
                return web.Response(status=204)
            if method == "GET":
                found = browser.get(identity_id)
                if found is None:
                    raise HttpError(404, "not_found", f'no browser identity "{identity_id}"')
                return _json_response(200, _identity_json(found))
            _allow(method, "GET", "DELETE")
            try:
                await browser.delete(identity_id)
            except BrowserIdentityError as error:
                raise _identity_error(error) from None
            return web.Response(status=204)

        if path == AGENT_ROUTES["tools"]:
            _allow(method, "GET")
            return _json_response(200, {"tools": engine.tool_table(), "mcp_servers": engine.mcp_status()})

        if path == AGENT_ROUTES["skills"]:
            _allow(method, "GET")
            return _json_response(200, {"skills": await engine.skills()})

        if path == AGENT_ROUTES["prepare_sleep"]:
            _allow(method, "POST")
            logger.info("preparing to sleep")
            await engine.suspend()
            logger.info("ready to sleep: work paused, browsers closed, state flushed")
            return web.Response(status=204)

        raise HttpError(404, "not_found", f"no route {method} {path}")

    async def _stream(self, request: web.Request) -> web.StreamResponse:
        """Replay every event after `after`, then keep sending new ones.

        Events are read from the outbox only, in seq order, each at most once per stream. Every
        outbox row is written by this process, and the store wakes the stream after the commit.
        """
        raw = request.query.get("after")
        if raw is None:
            raw = request.headers.get("Last-Event-ID", "0")
        if not re.fullmatch(r"[0-9]+", raw):
            raise HttpError(400, "invalid_after", f'after must be a non-negative integer, got "{raw}"')
        last = int(raw)
        # dot-agentd reaches the socket through kept-alive connections, which outlive stop_accepting: a stream asked
        # on one once the stop began would be one close_streams never ends, and the runner's cleanup would wait for it.
        if self._stopping:
            raise HttpError(503, "shutting_down", "the engine is stopping; the next one serves the stream")
        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
        # Registered before the first await, so a close_streams that comes while the headers go out ends it too.
        stream = _Stream()
        self._streams.add(stream)
        remove_listener = self._engine.on_append(stream.wake.set)
        try:
            await response.prepare(request)
            logger.info("event stream opened after={}", last)
            while not stream.closing:
                # Clear before reading: a commit after the read sets the event again.
                stream.wake.clear()
                batch = self._engine.read_outbox_after(last, _STREAM_BATCH)
                if batch:
                    frames = [f"id: {event['seq']}\ndata: {_compact(event)}\n\n" for event in batch]
                    await response.write("".join(frames).encode("utf-8"))
                    last = batch[-1]["seq"]
                    continue
                try:
                    await asyncio.wait_for(stream.wake.wait(), self._heartbeat_s)
                except asyncio.TimeoutError:
                    await response.write(b": keep-alive\n\n")
        except ConnectionError:
            pass
        except Exception as error:
            # The headers are sent: there is no second response to give. The host reconnects with the
            # last id it saw.
            logger.warning("event stream read failed after={} error={!r}", last, error)
        finally:
            remove_listener()
            self._streams.discard(stream)
            logger.info("event stream closed last_sent={}", last)
        return response
