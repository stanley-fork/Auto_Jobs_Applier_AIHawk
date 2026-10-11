"""A stand-in for `invisible-playwright-mcp` over stdio, run by the tests as the MCP program.

It speaks real MCP through the SDK, answers with the sentences the real server uses, and writes what
it was started with and every call it receives to `$INVISIBLE_MCP_HOME/record.jsonl`, so a test can
assert on the process's environment, working directory and calls. Like the real server, a successful
`browser_open` writes down who `main` is (seed, proxy with its password, profile directory) in
`$INVISIBLE_MCP_HOME/sessions/<$INVISIBLE_MCP_SESSION_ID>.json`, so a test can assert where that file is. Its behavior is steered by
`$INVISIBLE_MCP_HOME/control.json`, because the engine hands the process an environment of its own
and a test cannot add a variable to it.

Its instructions and `tools/list` are the real server's, as the engine reads them
(`nanobot/dots/invisible_playwright_mcp.json`, captured in the mode the engine starts it in), and the SDK checks
every call against those input schemas. The server also refuses an argument the real tool does not have,
so a parameter renamed in a call fails here and not only inside a Dot.

`install_fake_mcp` writes the executable the manager runs as the MCP command, the way
`local_computer.install_fake_relay` does for the relay.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

# Beside the engine's package in the repository, and copied to the same place relative to this file by the smoke.
INTERFACE = Path(__file__).resolve().parents[2] / "nanobot" / "dots" / "invisible_playwright_mcp.json"
SCRIPT = Path(__file__).resolve()

# A 1x1 transparent PNG, and a JPEG of one pixel.
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k="


def install_fake_mcp(directory: Path) -> Path:
    """Write an executable that runs this file with the interpreter of the tests; returns its path."""
    script = directory / f"fake-mcp-{uuid.uuid4().hex}"
    script.write_bytes(f"#!/bin/sh\nexec '{sys.executable}' '{SCRIPT}' \"$@\"\n".encode("utf-8"))
    script.chmod(0o755)
    return script


def read_record(mcp_home: Path) -> list[dict[str, Any]]:
    """What the fake wrote under `mcp_home`: one entry per start, call and exit, oldest first."""
    path = mcp_home / "record.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_control(mcp_home: Path, **control: Any) -> None:
    """Steer the next fake started with this `mcp_home`.

    download_answers: `browser_open` answers with the engine's download progress this many times first.
    fail_open: `browser_open` fails the way the real server does when Firefox does not start.
    lose_browser_once: the first page action after opening reports the browser gone, as after a Firefox crash.
    lose_browser_always: every page action does.
    overlay_says_gone: `browser_click` fails the way a blocked click does, with a diagnosis of the covering element
        whose text is the sentence of a lost browser: a page controls that text, and the browser is not lost.
    refuse_close: `browser_close` fails.
    slow_close_s: `browser_close` answers after this many seconds, as Firefox flushing a profile on a loaded machine.
    slow_exit_s: once its input closes, the process takes this many seconds more to end.
    fail_watch: `browser_watch` fails the way the real server does when the browser has no page.
    watch_png: `browser_watch` answers with a PNG, which the frame route's contract (a JPEG) does not take.

A `browser_navigate` to `https://crash.test/now` ends the process without an answer, like a server killed in the
middle of a call; to `slow://...` it answers after 0.3 s. Each call is recorded when it arrives
(`call`) and when it is answered (`done`).
    """
    mcp_home.mkdir(parents=True, exist_ok=True)
    (mcp_home / "control.json").write_bytes(json.dumps(control).encode("utf-8"))


def _interface() -> dict[str, Any]:
    return json.loads(INTERFACE.read_text(encoding="utf-8"))


async def _serve() -> None:
    import mcp.types as types
    from mcp.server.lowlevel import Server
    from mcp.server.stdio import stdio_server

    home = Path(os.environ.get("INVISIBLE_MCP_HOME") or os.getcwd())
    record_file = home / "record.jsonl"
    control_file = home / "control.json"
    control: dict[str, Any] = json.loads(control_file.read_text(encoding="utf-8")) if control_file.exists() else {}

    def record(entry: dict[str, Any]) -> None:
        with record_file.open("a", encoding="utf-8") as out:
            out.write(json.dumps(entry) + "\n")

    record({"kind": "start", "pid": os.getpid(), "argv": sys.argv[1:], "env": dict(os.environ), "cwd": os.getcwd()})

    def remember(role: str) -> None:
        """What the real server's `Work.remember` saves: who the browser is, the proxy included."""
        session_id = os.environ.get("INVISIBLE_MCP_SESSION_ID") or "default"
        who = {
            "seed": 1,
            "proxy": os.environ.get("STEALTHFOX_PROXY"),
            "profile_dir": os.environ.get("STEALTHFOX_PROFILE_DIR"),
        }
        saved = home / "sessions" / f"{session_id}.json"
        saved.parent.mkdir(parents=True, exist_ok=True)
        saved.write_bytes(json.dumps({"browsers": {role: who}, "focus": role}).encode("utf-8"))

    interface = _interface()
    tools = {tool["name"]: tool for tool in interface["tools"]}
    state: dict[str, Any] = {
        "download_left": int(control.get("download_answers", 0)),
        "lose_browser": bool(control.get("lose_browser_once", False) or control.get("lose_browser_always", False)),
        "open": False,
        "url": "about:blank",
    }

    def text(value: str, *, error: bool = False) -> types.CallToolResult:
        return types.CallToolResult(content=[types.TextContent(type="text", text=value)], isError=error)

    def tool_error(name: str, message: str) -> types.CallToolResult:
        # What the real server's FastMCP answers when a tool raises: the library's sentence behind this prefix.
        return text(f"Error executing tool {name}: {message}", error=True)

    def image(data: str, mime: str) -> types.CallToolResult:
        return types.CallToolResult(content=[types.ImageContent(type="image", data=data, mimeType=mime)])

    def call(name: str, args: dict[str, Any]) -> types.CallToolResult:
        unknown = sorted(set(args) - set(tools[name]["inputSchema"].get("properties", {})))
        if unknown:
            return text(f"invalid arguments for {name}: it has no argument {', '.join(unknown)}", error=True)
        # Started as the engine starts the real one (INVISIBLE_MCP_HOST_MANAGED=1), it serves `main` alone.
        role = "main"

        if name == "browser_open":
            if control.get("fail_open"):
                return text(f"the {role} browser did NOT start: proxy refused the connection", error=True)
            if state["download_left"] > 0:
                state["download_left"] -= 1
                return text(
                    "the engine is not on this machine yet and is downloading now: 40% of 90 MB. "
                    "Call browser_open again in a minute; nothing else needs doing."
                )
            state["open"] = True
            remember(role)
            return text(f"the {role} browser is open. seed: remembered by the profile")
        if name == "browser_close":
            if control.get("refuse_close"):
                return text(f"the {role} browser could not be closed", error=True)
            was_open, state["open"] = state["open"], False
            return text(f"the {role} browser is closed." if was_open else f"the {role} browser is not open.")
        if name == "browser_list":
            return text(json.dumps({"focus": "main", "browsers": []}))
        if not state["open"]:
            return tool_error(name, f"the {role} browser is not open. Call browser_open to open it.")
        if state["lose_browser"]:
            state["lose_browser"] = bool(control.get("lose_browser_always", False))
            state["open"] = False
            return tool_error(
                name,
                f"the {role} browser is gone: it closed or crashed. Call browser_open to open it again; "
                "it comes back as the same person.",
            )

        if name == "browser_status":
            return text(f"the {role} browser is open on {state['url']}")
        if name == "browser_navigate":
            if args.get("url") == "https://crash.test/now":
                # Exit without answering, like a server killed in the middle of a call.
                record({"kind": "exit", "code": 3})
                os._exit(3)
            state["url"] = str(args["url"])
            return text(f"200 {state['url']}")
        if name == "browser_snapshot":
            return text(f"title: Fake\nurl: {state['url']}\n- button \"Go\" selector: #go at: [10, 20]")
        if name == "browser_read_text":
            return text(f"text of {args.get('selector', 'body')}")
        if name == "browser_take_screenshot" or name == "browser_click_at":
            return image(PNG, "image/png")
        if name == "browser_watch":
            if control.get("fail_watch"):
                return text(f"the {role} browser has no page to watch", error=True)
            if control.get("watch_png"):
                return image(PNG, "image/png")
            return image(JPEG, "image/jpeg")
        if name == "browser_click":
            if control.get("overlay_says_gone"):
                diagnosis = {"covered_by": {"text": f"the {role} browser is gone", "cls": "overlay"}}
                return tool_error(name, f"click on {args['selector']} failed: it is covered: {json.dumps(diagnosis)}")
            return text(f"clicked {args['selector']}")
        if name == "browser_type":
            return text(f"typed into {args['selector']}")
        if name == "browser_select_option":
            return text(f"selected {args['value']} in {args['selector']}")
        if name == "browser_press_key":
            return text(f"pressed {args['key']}")
        if name == "browser_read_html":
            return text("<form></form>")
        if name == "browser_evaluate":
            return text("null")
        if name == "browser_upload_files":
            return text(f"attached {len(args['paths'])} file(s) to {args['selector']}")
        return text(f"unknown tool {name}", error=True)

    server: Server[Any] = Server("fake-stealth", instructions=interface["instructions"])

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [
            types.Tool(name=tool["name"], description=tool["description"], inputSchema=tool["inputSchema"])
            for tool in tools.values()
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        record({"kind": "call", "name": name, "args": arguments})
        if str(arguments.get("url", "")).startswith("slow://"):
            await asyncio.sleep(0.3)
        if name == "browser_close" and control.get("slow_close_s"):
            await asyncio.sleep(float(control["slow_close_s"]))
        result = call(name, arguments)
        record({"kind": "done", "name": name})
        return result

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())
    if control.get("slow_exit_s"):
        await asyncio.sleep(float(control["slow_exit_s"]))
    record({"kind": "exit", "code": 0})


if __name__ == "__main__":
    asyncio.run(_serve())
