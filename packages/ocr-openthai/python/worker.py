"""stdio transport for the OpenThai OCR engine: one JSON object per line.

    python worker.py --model-dir <dir> [--threads 1] [--backend openvino|onnxruntime]

Loads the model once, prints a `ready` line, then answers one request line
with one response line until stdin closes. See openthai_ocr/protocol.py.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--backend", choices=["openvino", "onnxruntime"], default=None)
    args = parser.parse_args()

    # stdout carries the protocol and nothing else. Keep a private handle to
    # the real stdout, then point fd 1 at stderr so that prints from Python
    # or native libraries cannot corrupt a message.
    out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    stdin = open(0, "r", encoding="utf-8", newline="\n", closefd=False)  # noqa: SIM115

    from openthai_ocr import protocol

    def send(message: dict) -> None:
        out.write(protocol.encode(message) + "\n")
        out.flush()

    try:
        from openthai_ocr.engine import OpenThaiEngine
        from openthai_ocr.weights import load_pin

        engine = OpenThaiEngine(args.model_dir, threads=args.threads, backend=args.backend, pin=load_pin())
    except Exception as error:  # noqa: BLE001 - report any startup failure to the parent
        send(protocol.fatal_message(f"{type(error).__name__}: {error}"))
        return 1

    send(protocol.ready_message(engine))
    for line in stdin:
        if line.strip():
            send(protocol.handle_line(engine, line))
    return 0


if __name__ == "__main__":
    sys.exit(main())
