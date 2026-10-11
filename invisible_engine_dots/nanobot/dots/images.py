"""The images a tool of the Dot returns for the model to look at (architecture section 8.3).

A screenshot is the one thing a tool returns that the model must SEE, and the transcript must not
STORE: a PNG of a desktop is megabytes of base64, and the transcript is a SQLite file the engine
reads whole on every turn. So the two are kept apart:

* the tool message in the transcript holds the tool's text and a placeholder,
  `[screenshot, 1280x720, not stored]`, never the bytes;
* the bytes go to the `TurnImages` of the running turn, which the runner asks for the messages of
  every model request (`AgentRunSpec.request_attachments`). It keeps the newest `IMAGES_KEPT` and
  puts them in one user message, right after the last tool message of the request, because a tool
  message cannot carry an image on OpenRouter's chat completions. That message is made for the request
  and is never stored.

The buffer lives as long as one turn. A later turn replays the transcript, where an image is its
placeholder: the model asks for another screenshot when it wants one.
"""

from __future__ import annotations

import base64
import binascii
import struct
from collections.abc import Sequence
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Any

from nanobot.agent.tools.base import ToolResult

# How many images of one turn the model is shown: the newest.
IMAGES_KEPT = 3

# The first words of the user message that carries the images.
IMAGES_HEADER = "Images returned by the tool calls above"

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# JPEG markers that start a frame and so carry the size (every SOFn except DHT, JPG and DAC).
_JPEG_FRAMES = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}


@dataclass(frozen=True)
class ToolImage:
    """One image a tool returned: what it is of, its media type and its base64 bytes."""

    caption: str
    mime: str
    data: str


def image_size(data: str) -> tuple[int, int] | None:
    """The width and height of a base64 PNG or JPEG, or None for anything else (or damaged data)."""
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        return None
    if raw.startswith(_PNG_SIGNATURE) and len(raw) >= 24 and raw[12:16] == b"IHDR":
        width, height = struct.unpack(">II", raw[16:24])
        return width, height
    if raw.startswith(b"\xff\xd8"):
        position = 2
        while position + 4 <= len(raw):
            if raw[position] != 0xFF:
                return None
            marker = raw[position + 1]
            if marker == 0xFF:
                position += 1
                continue
            if marker in _JPEG_FRAMES:
                if position + 9 > len(raw):
                    return None
                height, width = struct.unpack(">HH", raw[position + 5 : position + 9])
                return width, height
            if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:
                position += 2
                continue
            position += 2 + struct.unpack(">H", raw[position + 2 : position + 4])[0]
    return None


def placeholder(data: str, *, note: str = "") -> str:
    """What the transcript keeps of an image: `[screenshot, 1280x720, not stored]`."""
    size = image_size(data)
    shown = f"{size[0]}x{size[1]}" if size else "size unknown"
    return f"[screenshot, {shown}, not stored{'; ' + note if note else ''}]"


class TurnImages:
    """The images the tools of one turn returned, and the request messages that show the newest of them."""

    def __init__(self, kept: int = IMAGES_KEPT) -> None:
        if kept < 1:
            raise ValueError("a turn must keep at least one image")
        self._kept = kept
        self._images: list[ToolImage] = []
        self._dropped = 0

    def add(self, image: ToolImage) -> None:
        self._images.append(image)
        while len(self._images) > self._kept:
            del self._images[0]
            self._dropped += 1

    @property
    def images(self) -> tuple[ToolImage, ...]:
        return tuple(self._images)

    def attach(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """`messages` for one request, with the kept images in a user message after the last tool message.

        The list handed in is not changed. Nothing is added when the turn has no image or the request
        has no tool message to follow.
        """
        if not self._images:
            return messages
        last_tool = next((i for i in range(len(messages) - 1, -1, -1) if messages[i].get("role") == "tool"), None)
        if last_tool is None:
            return messages
        note = f"{IMAGES_HEADER}:"
        if self._dropped:
            note = f"{IMAGES_HEADER} (the newest {self._kept} are shown; {self._dropped} earlier of this turn are dropped):"
        content: list[dict[str, Any]] = [{"type": "text", "text": note}]
        for number, image in enumerate(self._images, start=1):
            content.append({"type": "text", "text": f"Image {number}: {image.caption}"})
            content.append({"type": "image_url", "image_url": {"url": f"data:{image.mime};base64,{image.data}"}})
        return [*messages[: last_tool + 1], {"role": "user", "content": content}, *messages[last_tool + 1 :]]


_CURRENT: ContextVar[TurnImages | None] = ContextVar("dots_turn_images", default=None)


def bind_turn_images(images: TurnImages) -> Token[TurnImages | None]:
    return _CURRENT.set(images)


def reset_turn_images(token: Token[TurnImages | None]) -> None:
    _CURRENT.reset(token)


def current_turn_images() -> TurnImages | None:
    """The images of the turn the calling tool runs in; None outside a turn."""
    return _CURRENT.get()


def show_images(text: str, images: Sequence[tuple[str, str]], caption: str) -> Any:
    """What a tool answers with when an MCP server's answer had images, as (media type, base64 data): its text, then a
    placeholder for each image, which is shown to the model for this turn, as an MCP host shows a server's images.
    An error outside a turn, where nothing can be shown."""
    lines = [text] if text else []
    for mime, data in images:
        turn_images = current_turn_images()
        if turn_images is None:
            return ToolResult.error("an image can only be shown inside a model turn")
        turn_images.add(ToolImage(caption, mime, data))
        lines.append(placeholder(data))
    return "\n".join(lines)
