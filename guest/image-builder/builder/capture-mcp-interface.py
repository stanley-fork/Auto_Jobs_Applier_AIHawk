"""Capture what invisible-playwright-mcp tells a model, as the engine serves it to a Dot's model.

The engine offers the model the page tools of the server with the server's own names, descriptions and input
schemas, and puts the server's instructions in its prompt, as an MCP host does (architecture section 8.3). It
reads them from `invisible_engine_dots/nanobot/dots/invisible_playwright_mcp.json`, which this writes from the
real server at the version `mcp-requirements.lock` pins, started the way the engine starts it
(`INVISIBLE_MCP_HOST_MANAGED=1`): `initialize` gives the version and the instructions, `tools/list` the tools.
Nothing is opened: listing starts no browser.

Run it with a Python that has the pinned server installed (and so the `mcp` package it depends on), whenever
the lock moves to another version:

    python guest/image-builder/builder/capture-mcp-interface.py \
        invisible_engine_dots/nanobot/dots/invisible_playwright_mcp.json
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

PACKAGE = "invisible-playwright-mcp"
NOTE = (
    "What invisible-playwright-mcp tells a model, at the version builder/mcp-requirements.lock pins, started as the "
    "engine starts it (INVISIBLE_MCP_HOST_MANAGED=1): its instructions and its tools/list as served. Written by "
    "guest/image-builder/builder/capture-mcp-interface.py; capture it again when the lock changes that version."
)


async def capture() -> dict:
    environment = {**os.environ, "INVISIBLE_MCP_HOST_MANAGED": "1"}
    server = StdioServerParameters(command=sys.executable, args=["-m", "invisible_playwright_mcp"], env=environment)
    async with stdio_client(server) as (read, write), ClientSession(read, write) as session:
        started = await session.initialize()
        listed = await session.list_tools()
    return {
        "//": NOTE,
        "package": PACKAGE,
        "version": started.serverInfo.version,
        "instructions": started.instructions,
        "tools": [
            {
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.inputSchema,
                "annotations": tool.annotations.model_dump(exclude_none=True) if tool.annotations else None,
            }
            for tool in listed.tools
        ],
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} <output.json>")
    interface = asyncio.run(capture())
    Path(sys.argv[1]).write_bytes((json.dumps(interface, indent=1, ensure_ascii=False) + "\n").encode("utf-8"))
    print(f"{interface['package']} {interface['version']}: {len(interface['tools'])} tools")


if __name__ == "__main__":
    main()
