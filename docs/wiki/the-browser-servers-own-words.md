---
title: "The browser server's own tools and words"
description: "A Dot's page tools used to be rewritten in the engine and their rules copied into a skill. Now the engine offers invisible-playwright-mcp's tools and instructions as an MCP host does, and every rule about a page is written once, in the server."
parent: "Studies"
nav_order: 7
---

# The browser server's own tools and words

A Dot drives its browser through invisible-playwright-mcp. Until October 2026 the
model never saw that server's words: the engine wrote its own tool names and
descriptions, and its skill copied the server's instructions (the order to try
things in, never act by script, say when a task is impossible). The audit of the
browser calls ([Browser calls that lead nowhere](browser-calls-that-lead-nowhere.md))
then added three more rules to the skill, all of them true of any page and any
host. Two copies of a rule drift apart, and the copy the model reads was not the
one the server's authors keep.

## How other hosts do it

| Host | Tool descriptions | The server's instructions |
|---|---|---|
| Claude Code | the server's, as `mcp__<server>__<tool>` | in the system prompt |
| opencode | the server's | in the system prompt, in `<mcp_instructions>` |
| nanobot (the engine's base) | the server's, as `mcp_<server>_<tool>` | not used |
| a Dot, before | rewritten in the engine | not used; copied into a skill |

## Why it could not be passed as it was

The server serves one person and a helper, `main` and `support`, and its model
opens them itself: "OPEN `main` WITH browser_open BEFORE ANYTHING ELSE". A Dot
has many identities, each the engine opens and closes, within limits and
permissions the model does not control. Handed the server's instructions as they
were, a Dot's model would read about a tool it does not have.

The standard answer is the one Microsoft's playwright-mcp gives with its flags:
the host starts the server configured for how it is used. invisible-playwright-mcp
0.71.0 reads `INVISIBLE_MCP_HOST_MANAGED=1`. The process then serves `main`
alone, no tool takes `browser` (`support` is refused if sent anyway), and its
instructions are the page rules only. Opening and closing stay tools of the
server, because the host needs them: a first launch answers with the engine's
download progress for minutes, and a close has to let Firefox write its profile
before the MCP client stops the process two seconds after closing its input.

## What a Dot does now

- The page tools are the server's: same names, descriptions and input schemas,
  plus the `identity_id` of the open identity whose server the call goes to.
  The permission table says which the model is offered; `browser_open`,
  `browser_close`, `browser_list` and `browser_status` are the engine's identity
  tools, and `browser_watch` is the frame the UI shows.
- The server's instructions go into the system prompt whenever a page tool is
  offered.
- The engine reads both from a capture of the pinned version
  (`nanobot/dots/invisible_playwright_mcp.json`, written by
  `guest/image-builder/builder/capture-mcp-interface.py`), held to the lock by a
  test.
- What the engine still adds is what only a Dot knows: a URL that is not
  `http://` or `https://` is refused before it reaches the server, and the skill
  is about identities.

The tools the Dot had invented went: `browser_scroll` (the server's
`browser_press_key` with `PageDown` does it) and the 214-character cap on
`browser_type`, which the server made unnecessary when it began to type a long
text in the background. Four tools of the server came in: `browser_read_html`,
`browser_evaluate`, `browser_upload_files`, and `browser_take_screenshot` under
its own name. An image the server answers with is shown, so `browser_click_at`
returns the page after the click.

## What it costs

Counted with tiktoken (o200k), with every permission allowed: the page tools'
definitions went from 1,632 tokens (10 tools) to 2,885 (12 tools), and the
instructions add 765, about 2,000 tokens more on each request that offers the
browser. The skill a model reads once per task got shorter. It is what any MCP
host pays for a server's words. The engine's own estimate, which is cautious,
puts a turn with every permission at about 34,000 tokens.

## Sources

- [invisible-playwright-mcp](https://github.com/feder-cr/invisible_playwright_mcp):
  `mcp/server.py` (`PAGE_RULES`, `INVISIBLE_MCP_HOST_MANAGED`).
- [opencode](https://github.com/anomalyco/opencode): `packages/core/src/mcp/instructions.ts`.
- [playwright-mcp](https://github.com/microsoft/playwright-mcp): its command-line flags.
