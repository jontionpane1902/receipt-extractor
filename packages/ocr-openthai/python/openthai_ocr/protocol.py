"""Request dict -> response dict. Transport-agnostic and standard library only.

The stdio worker calls `handle` once per input line; an HTTP wrapper for the
container milestone can call the same function once per request body.

Protocol v1
-----------
ready (sent once by the transport, see `ready_message`):
    {"type": "ready", "protocol": 1, "model": "<repo>", "revision": "<sha>",
     "backend": "openvino" | "onnxruntime", "load_ms": 123.4}

requests:
    {"id": "<string>", "op": "ocr", "image_b64": "<base64 image bytes>"}
    {"id": "<string>", "op": "ping"}

responses:
    {"type": "result", "id": "...", "ok": true, "lines": [...], "dropped": [...],
     "rotation": 0, "text_angle": 0.0, "timing": {"det_ms", "rec_ms", "total_ms"}}
    {"type": "result", "id": "...", "ok": true, "pong": true}
    {"type": "result", "id": "...", "ok": false,
     "error": {"code": "<code>", "message": "<text>"}}

A line is {"text", "confidence" (0..1), "row" (reading-order row), "box"
(four [x, y] points in input-image pixels: top-left, top-right, bottom-right,
bottom-left)}. A dropped line has the same fields plus "reason".
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any, Protocol

from . import PROTOCOL_VERSION


class Engine(Protocol):
    def info(self) -> dict: ...

    def read(self, image: bytes) -> dict: ...


def ready_message(engine: Engine) -> dict:
    return {"type": "ready", "protocol": PROTOCOL_VERSION, **engine.info()}


def fatal_message(message: str) -> dict:
    return {"type": "fatal", "error": message}


def _error(request_id: Any, code: str, message: str) -> dict:
    return {"type": "result", "id": request_id, "ok": False, "error": {"code": code, "message": message}}


def handle(engine: Engine, request: Any) -> dict:
    """Never raises: every failure becomes an error response."""
    if not isinstance(request, dict):
        return _error(None, "bad_request", "request must be a JSON object")
    request_id = request.get("id")
    if not isinstance(request_id, str) or not request_id:
        return _error(None, "bad_request", "request needs a non-empty string id")
    op = request.get("op")
    if op == "ping":
        return {"type": "result", "id": request_id, "ok": True, "pong": True}
    if op != "ocr":
        return _error(request_id, "bad_request", f"unknown op: {op!r}")
    encoded = request.get("image_b64")
    if not isinstance(encoded, str) or not encoded:
        return _error(request_id, "bad_request", "ocr needs image_b64")
    try:
        image = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return _error(request_id, "bad_request", "image_b64 is not valid base64")
    try:
        result = engine.read(image)
    except ValueError as error:  # the runtime raises ValueError for undecodable images
        return _error(request_id, "bad_image", str(error))
    except Exception as error:  # noqa: BLE001 - one bad page must not kill the worker
        return _error(request_id, "ocr_failed", f"{type(error).__name__}: {error}")
    return {"type": "result", "id": request_id, "ok": True, **result}


def handle_line(engine: Engine, line: str) -> dict:
    try:
        request = json.loads(line)
    except json.JSONDecodeError as error:
        return _error(None, "bad_request", f"invalid JSON: {error}")
    return handle(engine, request)


def encode(message: dict) -> str:
    """One line of JSON; non-ASCII kept as UTF-8 so Thai stays readable in logs."""
    return json.dumps(message, ensure_ascii=False, separators=(",", ":"))
