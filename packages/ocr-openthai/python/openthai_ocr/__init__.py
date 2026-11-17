"""Local service around the official iapp/OpenThai2.0-OCR-Text runtime.

Layers, so the same code can sit behind stdio today and HTTP later:

    weights.py    download, verify and describe the model directory (stdlib only)
    engine.py     load the official runtime once; bytes in -> dict out
    protocol.py   request dict -> response dict (transport-agnostic, stdlib only)
    ../worker.py  stdio transport: one JSON object per line
"""

PROTOCOL_VERSION = 1
