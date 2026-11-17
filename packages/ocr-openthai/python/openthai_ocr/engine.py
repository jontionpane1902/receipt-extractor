"""Loads the official runtime once and reads images. bytes in -> dict out."""

from __future__ import annotations

import sys
import time
from pathlib import Path

from .weights import verify

LINE_KEYS = ("text", "confidence", "row", "box")


class OpenThaiEngine:
    """Thin wrapper over `runtime.line_engine.LineOCR` from the model repository.

    No OCR logic lives here: detection, recognition, reading order, the
    confidence filter and its thresholds are all the official runtime's, read
    from the model directory's own config.json. `backend` is None for the
    runtime's default (OpenVINO, else ONNX Runtime) or forces one of them.
    """

    def __init__(self, model_dir: Path, threads: int = 1, backend: str | None = None, pin: dict | None = None):
        started = time.perf_counter()
        self.model_dir = Path(model_dir).resolve()
        self.manifest = verify(self.model_dir, pin)
        # The runtime ships inside the verified model directory as the
        # `runtime` package; make exactly that directory importable.
        sys.path.insert(0, str(self.model_dir))
        from runtime.line_engine import LineOCR  # type: ignore[import-not-found]

        overrides = {"runtime": {"backend": backend}} if backend else {}
        self._ocr = LineOCR(str(self.model_dir), threads=threads, **overrides)
        self.load_ms = round((time.perf_counter() - started) * 1000, 1)

    def info(self) -> dict:
        return {
            "model": self.manifest["repo"],
            "revision": self.manifest["revision"],
            "backend": self._ocr.backend,
            "load_ms": self.load_ms,
        }

    def read(self, image: bytes) -> dict:
        started = time.perf_counter()
        result = self._ocr.read(image)
        timing = dict(result.get("timing", {}))
        timing["total_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return {
            "lines": [{key: line[key] for key in LINE_KEYS} for line in result["lines"]],
            "dropped": [
                {**{key: line[key] for key in LINE_KEYS}, "reason": line.get("reason", "unknown")}
                for line in result.get("dropped", [])
            ],
            "rotation": result.get("rotation", 0),
            "text_angle": result.get("text_angle", 0.0),
            "timing": timing,
        }
