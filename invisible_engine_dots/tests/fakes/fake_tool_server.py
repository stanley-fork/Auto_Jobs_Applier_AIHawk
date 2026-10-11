"""A stand-in for any MCP server a person declares, run by the tests over stdio or streamable HTTP.

It speaks real MCP through the SDK's FastMCP. Its tools let a test see what reached it: `env` reads one of its
environment variables (a secret arrives that way), `header` one header of the request it answers (over HTTP),
`picture` answers with an image, and `exit` ends the process, as a server that crashes. Its behavior at start is
steered by its environment, which the declared entry sets:

* FAKE_TOOLS_INSTRUCTIONS: what it says at initialize ("" says nothing);
* FAKE_TOOLS_FAIL: written to stderr, then the process exits 1 before it answers, as a server missing a key does;
* FAKE_TOOLS_HANG: it never answers initialize.

`python fake_tool_server.py --http PORT` serves streamable HTTP at http://127.0.0.1:PORT/mcp instead of stdio.
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from pathlib import Path

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import ImageContent, TextContent

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
SCRIPT = Path(__file__).resolve()
INSTRUCTIONS = "Call echo to repeat a text."


def install_fake_tool_server(directory: Path) -> Path:
    """Write an executable that runs this file with the interpreter of the tests; returns its path."""
    script = directory / f"fake-tools-{uuid.uuid4().hex}"
    script.write_bytes(f"#!/bin/sh\nexec '{sys.executable}' '{SCRIPT}' \"$@\"\n".encode("utf-8"))
    script.chmod(0o755)
    return script


def build() -> FastMCP:
    instructions = os.environ.get("FAKE_TOOLS_INSTRUCTIONS", INSTRUCTIONS)
    server = FastMCP("fake-tools", instructions=instructions or None)

    @server.tool(description="Repeat a text.")
    def echo(text: str) -> str:
        return text

    @server.tool(description="Read one of the server's environment variables.")
    def env(name: str) -> str:
        return os.environ.get(name, "(unset)")

    @server.tool(description="Read one header of the request this call came in.")
    def header(name: str, ctx: Context) -> str:
        request = ctx.request_context.request
        return request.headers.get(name, "(unset)") if request is not None else "(no request)"

    @server.tool(description="Answer with a picture.")
    def picture() -> list[TextContent | ImageContent]:
        return [TextContent(type="text", text="a pixel"), ImageContent(type="image", data=PNG, mimeType="image/png")]

    @server.tool(description="End the server's process.")
    def exit() -> str:
        os._exit(3)

    return server


def main(argv: list[str]) -> int:
    failure = os.environ.get("FAKE_TOOLS_FAIL")
    if failure:
        sys.stderr.write(f"{failure}\n")
        sys.stderr.flush()
        return 1
    if os.environ.get("FAKE_TOOLS_HANG"):
        while True:
            time.sleep(60)
    server = build()
    if len(argv) == 3 and argv[1] == "--http":
        server.settings.host = "127.0.0.1"
        server.settings.port = int(argv[2])
        server.run(transport="streamable-http")
    else:
        server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
