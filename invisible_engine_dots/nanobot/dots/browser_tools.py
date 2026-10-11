"""The browser tools of the Dot (architecture section 8.3): the identities, the pages of an open one, and the desktop.

Two kinds:

* The identity tools (`browser_identity_*`) are the BrowserManager's: they list, make, delete, open and close
  identities. Opening is explicit. A page tool on an identity that is not open does not open it, it says
  so, so `browser.identity.launch` alone decides whether a browser starts.
* The page tools are invisible-playwright-mcp's own, offered as an MCP host offers a server's tools: the
  server's name, description and input schema, as `invisible_playwright_mcp.json` captured them from the
  pinned version, plus the `identity_id` that says which open identity's server the call goes to. Which of
  the server's tools the model is offered is the permission table's (`permissions.py`); the server's
  instructions go into the system prompt (`INSTRUCTIONS`). The server serves the identity's browser alone
  (`BROWSER_ENV["HOST_MANAGED"]`), so its tools take no `browser`.

An image the server answers with is shown to the model and not stored (images.py): the tool's result is its
text and a placeholder.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from nanobot.agent.tools.base import Tool, ToolResult
from nanobot.agent.tools.mcp import _normalize_schema_for_openai
from nanobot.dots.browser import (
    BrowserIdentity,
    BrowserIdentityError,
    BrowserManager,
    result_is_error,
    split_result,
)
from nanobot.dots.computer import Computer, ComputerError
from nanobot.dots.identity_rules import IDENTITY_ID_MAX
from nanobot.dots.images import ToolImage, current_turn_images, placeholder
from nanobot.dots.store import iso_from_ms

# What invisible-playwright-mcp tells a model, at the version the image installs: written from the real server by
# guest/image-builder/builder/capture-mcp-interface.py, and a test holds its version to the lock's.
SERVER_INTERFACE: Mapping[str, Any] = json.loads(Path(__file__).with_name("invisible_playwright_mcp.json").read_bytes())
# The server's instructions, which the system prompt carries as an MCP host carries them (context.py).
INSTRUCTIONS: str = SERVER_INTERFACE["instructions"]

_IDENTITY_ID = {
    "type": "string",
    "minLength": 1,
    "maxLength": IDENTITY_ID_MAX,
    "description": "The id of a browser identity, as browser_identity_list shows it.",
}
def _string(description: str, **more: Any) -> dict[str, Any]:
    return {"type": "string", "minLength": 1, "description": description, **more}


# Said once, on the argument every page tool takes, rather than in each description.
_OPEN_IDENTITY_ID = {
    **_IDENTITY_ID,
    "description": "The id of an open browser identity, as browser_identity_list shows it; "
    "browser_identity_launch opens one.",
}


@dataclass(frozen=True)
class ServerTool:
    """One tool of invisible-playwright-mcp as the server serves it: name, description, input schema, read-only."""

    name: str
    description: str
    input_schema: Mapping[str, Any]
    read_only: bool


# The server's tools by name, as captured.
SERVER_TOOLS: Mapping[str, ServerTool] = {
    tool["name"]: ServerTool(
        tool["name"],
        tool.get("description") or tool["name"],
        tool.get("inputSchema") or {"type": "object", "properties": {}},
        bool((tool.get("annotations") or {}).get("readOnlyHint")),
    )
    for tool in SERVER_INTERFACE["tools"]
}


# What browser_navigate may open. The server passes the URL to the page unchecked, so file:///home/dot/... would
# put any file the dot user can read into browser_read_text, whatever files.read says, and about:, view-source:,
# data: and javascript: reach browser internals and run script. Each permission decides only its own action.
# The refusal below holds the rule and the schema has no `pattern`: a provider that decodes under the schema takes a
# pattern as the whole value, and this prefix as a whole value is "https://", which the model was then made to send.
_WEB_URL = r"^https?://"


def _only_web_urls(params: Mapping[str, Any]) -> str | None:
    url = params.get("url")
    if isinstance(url, str) and re.match(_WEB_URL, url):
        return None
    return "browser_navigate opens only http:// and https:// URLs"


# What the Dot refuses before a call reaches the server: the reason, or None when the arguments may go.
REFUSALS: Mapping[str, Callable[[Mapping[str, Any]], str | None]] = {"browser_navigate": _only_web_urls}


def _error(error: BrowserIdentityError) -> ToolResult:
    return ToolResult.error(error.message)


def _identity_json(identity: BrowserIdentity) -> dict[str, Any]:
    return {
        "id": identity.id,
        "name": identity.name,
        "status": identity.status,
        "last_used_at": iso_from_ms(identity.last_used_at) if identity.last_used_at is not None else None,
        "has_proxy": identity.has_proxy,
    }


class _BrowserTool(Tool):
    def __init__(self, browser: BrowserManager) -> None:
        self.browser = browser


class BrowserIdentityListTool(_BrowserTool):
    @property
    def name(self) -> str:
        return "browser_identity_list"

    @property
    def description(self) -> str:
        return (
            "List the browser identities of this Dot: each is a separate browser profile with its own cookies, "
            "logins and fingerprint. Shows whether each is open, and how many may be open at once."
        )

    @property
    def read_only(self) -> bool:
        return True

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}, "additionalProperties": False}

    async def execute(self, **kwargs: Any) -> str:
        max_open, max_identities = self.browser.limits
        return json.dumps(
            {
                "identities": [_identity_json(identity) for identity in self.browser.list_identities()],
                "max_open": max_open,
                "max_identities": max_identities,
            },
            ensure_ascii=False,
        )


class BrowserIdentityCreateTool(_BrowserTool):
    @property
    def name(self) -> str:
        return "browser_identity_create"

    @property
    def description(self) -> str:
        return (
            "Create a browser identity: a new browser profile with its own cookies, logins and fingerprint. "
            "It is created closed; open it with browser_identity_launch. Give only a name: the browser then uses "
            "this computer's own network exit, which is what it should do unless the person asked for this one "
            "identity to go through a particular proxy."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": _string("What the identity is for, for example shopping or research.", maxLength=80),
                "proxy": {
                    "type": ["string", "null"],
                    "description": (
                        "Leave this out. Only when the person gave you a proxy for this identity: its URL as they gave "
                        "it, such as http://user:pass@host:port or socks5://host:port."
                    ),
                },
            },
            "required": ["name"],
            "additionalProperties": False,
        }

    async def execute(self, name: str = "", proxy: str | None = None, **kwargs: Any) -> str:
        try:
            identity = await self.browser.create(name, proxy)
        except BrowserIdentityError as error:
            return _error(error)
        return f'Created the identity "{identity.name}" with id {identity.id}. It is closed: call browser_identity_launch to open it.'


class _IdentityActionTool(_BrowserTool):
    """A tool that takes one `identity_id` and does one thing to that identity."""

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"identity_id": dict(_IDENTITY_ID)},
            "required": ["identity_id"],
            "additionalProperties": False,
        }


class BrowserIdentityDeleteTool(_IdentityActionTool):
    @property
    def name(self) -> str:
        return "browser_identity_delete"

    @property
    def description(self) -> str:
        return "Delete a browser identity and its whole profile, logins included. This cannot be undone."

    async def execute(self, identity_id: str = "", **kwargs: Any) -> str:
        try:
            await self.browser.delete(identity_id)
        except BrowserIdentityError as error:
            return _error(error)
        return f"Deleted the identity {identity_id} and its profile."


class BrowserIdentityLaunchTool(_IdentityActionTool):
    @property
    def name(self) -> str:
        return "browser_identity_launch"

    @property
    def description(self) -> str:
        return (
            "Open the browser of an identity on the Dot's desktop. Only a few identities can be open at once; "
            "opening one more closes the one used least recently. The first launch can take minutes while the "
            "browser is prepared."
        )

    async def execute(self, identity_id: str = "", **kwargs: Any) -> str:
        was_open = {identity.id for identity in self.browser.list_identities() if identity.status == "open"}
        try:
            await self.browser.launch(identity_id)
        except BrowserIdentityError as error:
            return _error(error)
        closed = sorted(was_open - {i.id for i in self.browser.list_identities() if i.status == "open"})
        note = f" To stay within max_open it closed {', '.join(closed)}." if closed else ""
        return f"The browser of identity {identity_id} is open.{note}"


class BrowserIdentityCloseTool(_IdentityActionTool):
    @property
    def name(self) -> str:
        return "browser_identity_close"

    @property
    def description(self) -> str:
        return "Close the browser of an identity. Its profile, cookies and logins stay on disk."

    async def execute(self, identity_id: str = "", **kwargs: Any) -> str:
        try:
            await self.browser.close(identity_id)
        except BrowserIdentityError as error:
            return _error(error)
        return f"The browser of identity {identity_id} is closed; its profile is kept."


class BrowserPageTool(_BrowserTool):
    """A tool of invisible-playwright-mcp, called on the open identity the model names."""

    def __init__(self, browser: BrowserManager, tool: ServerTool) -> None:
        super().__init__(browser)
        self._tool = tool
        # The server's schema as nanobot's MCP client offers any server's (`mcp.MCPToolWrapper`), with the identity
        # in front of the server's own arguments.
        schema = _normalize_schema_for_openai(dict(tool.input_schema))
        self._parameters = {
            **schema,
            "properties": {"identity_id": dict(_OPEN_IDENTITY_ID), **(schema.get("properties") or {})},
            "required": ["identity_id", *(schema.get("required") or [])],
        }

    @property
    def name(self) -> str:
        return self._tool.name

    @property
    def description(self) -> str:
        return self._tool.description

    @property
    def read_only(self) -> bool:
        return self._tool.read_only

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    async def execute(self, identity_id: str = "", **arguments: Any) -> Any:
        refusal = REFUSALS.get(self._tool.name)
        if refusal is not None and (reason := refusal(arguments)) is not None:
            return ToolResult.error(reason)
        try:
            result = await self.browser.call_tool(str(identity_id), self._tool.name, arguments)
        except BrowserIdentityError as error:
            return _error(error)
        if result_is_error(result):
            return result
        text, images = split_result(result)
        lines = [text] if text else []
        for mime, data in images:
            # Shown, as an MCP host shows a server's images: the server answers with one where it is the result
            # (a screenshot, the page after a click at a point).
            turn_images = current_turn_images()
            if turn_images is None:
                return ToolResult.error("an image can only be shown inside a model turn")
            turn_images.add(ToolImage(f"{self._tool.name} of identity {identity_id}", mime, data))
            lines.append(placeholder(data))
        return "\n".join(lines)


class ComputerScreenshotTool(Tool):
    """A screenshot of the Dot's whole desktop: its windows, the browsers among them."""

    def __init__(self, computer: Computer) -> None:
        self.computer = computer

    @property
    def name(self) -> str:
        return "computer_screenshot"

    @property
    def description(self) -> str:
        return "Take a screenshot of the Dot's whole desktop and look at it: its windows, open programs and browsers."

    @property
    def read_only(self) -> bool:
        return True

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}, "additionalProperties": False}

    async def execute(self, **kwargs: Any) -> Any:
        turn_images = current_turn_images()
        if turn_images is None:
            return ToolResult.error("a screenshot can only be taken inside a model turn")
        try:
            png = await self.computer.screenshot()
        except ComputerError as error:
            return ToolResult.error(f"the desktop could not be captured ({error})")
        data = base64.b64encode(png).decode("ascii")
        turn_images.add(ToolImage("computer_screenshot of the desktop", "image/png", data))
        return f"Screenshot of the desktop.\n{placeholder(data)}"
