"""What invisible-playwright-mcp tells a model, as the engine serves it, and the version it was captured at.

`nanobot/dots/invisible_playwright_mcp.json` is the real server's instructions and `tools/list`, captured over stdio by
`guest/image-builder/builder/capture-mcp-interface.py` from the server started as the engine starts it. The engine
offers the model those tools with those descriptions and schemas and puts those instructions in its prompt, and the
fake MCP server of the tests serves the same file, so it has to describe the version the golden image installs:
`guest/image-builder/builder/mcp-requirements.lock` is the one place that version is written.
"""

from __future__ import annotations

import re
from pathlib import Path

from nanobot.dots.browser_tools import INSTRUCTIONS, SERVER_INTERFACE, SERVER_TOOLS

ENGINE_ROOT = Path(__file__).resolve().parents[2]
LOCK = ENGINE_ROOT.parent / "guest" / "image-builder" / "builder" / "mcp-requirements.lock"
PACKAGE = "invisible-playwright-mcp"


def locked_version(package: str) -> str:
    match = re.search(rf"^{re.escape(package)}==(\S+)", LOCK.read_text(encoding="utf-8"), re.MULTILINE)
    assert match is not None, f"{package} is not pinned in {LOCK.name}"
    return match.group(1)


def test_the_capture_is_of_the_version_the_image_installs() -> None:
    assert SERVER_INTERFACE["package"] == PACKAGE
    assert SERVER_INTERFACE["version"] == locked_version(PACKAGE), (
        "the lock pins another invisible-playwright-mcp version than the one captured: run "
        "guest/image-builder/builder/capture-mcp-interface.py with the pinned version installed"
    )


def test_it_was_captured_from_a_server_started_as_the_engine_starts_it() -> None:
    """A capture of the default server would offer `support` on every tool and tell the model to call browser_open,
    which it does not have: the engine starts the server with INVISIBLE_MCP_HOST_MANAGED=1."""
    assert "browser_open" not in INSTRUCTIONS and "support" not in INSTRUCTIONS
    assert not [name for name, tool in SERVER_TOOLS.items() if "browser" in tool.input_schema.get("properties", {})]


def test_the_capture_holds_the_servers_tools_with_their_descriptions_and_schemas() -> None:
    assert {"browser_open", "browser_close", "browser_navigate", "browser_snapshot", "browser_watch"} <= set(SERVER_TOOLS)
    for name, tool in SERVER_TOOLS.items():
        assert tool.description and tool.description != name, name
        assert tool.input_schema.get("type") == "object", name
