"""Download, verify and describe the model directory. Standard library only."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PIN_PATH = Path(__file__).resolve().parent.parent / "model-pin.json"
MANIFEST_NAME = "manifest.json"
HF_BASE = "https://huggingface.co"
USER_AGENT = "receipt-extractor-weights-downloader"


class WeightsError(Exception):
    """The model directory is missing, incomplete or does not match its checksums."""


def load_pin(path: Path = PIN_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_sha256sums(text: str) -> dict[str, str]:
    """`<hex>  ./path` lines -> {path: hex}."""
    sums: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        digest, name = parts[0].lower(), parts[1].strip().lstrip("*")
        if name.startswith("./"):
            name = name[2:]
        if len(digest) == 64 and all(c in "0123456789abcdef" for c in digest):
            sums[name] = digest
    return sums


def _safe_relative(name: str) -> Path:
    path = Path(name)
    if path.is_absolute() or ".." in path.parts:
        raise WeightsError(f"refusing unsafe file name in pin: {name!r}")
    return path


def _fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 (https only, fixed host)
        return response.read()


def default_model_dir(models_root: Path, pin: dict) -> Path:
    return models_root / pin["repo"].split("/")[-1].lower() / pin["revision"]


def download(models_root: Path, pin: dict | None = None, fetch=_fetch, log=print) -> Path:
    """Fetch the pinned revision into models_root/<name>/<revision>/ and verify it.

    Every file is checked against the repository's own SHA256SUMS at that
    revision, and SHA256SUMS itself against the hash recorded in the pin, so
    a changed upstream file cannot slip in unnoticed. Files are written to a
    temporary directory and moved into place only after everything verified.
    """
    pin = pin or load_pin()
    repo, revision = pin["repo"], pin["revision"]
    target = default_model_dir(models_root, pin)
    if target.exists():
        try:
            verify(target, pin)
            log(f"already present and verified: {target}")
            return target
        except WeightsError as error:
            log(f"existing copy is not valid ({error}); downloading again")
            shutil.rmtree(target)

    base = f"{HF_BASE}/{repo}/resolve/{revision}"
    sums_bytes = fetch(f"{base}/SHA256SUMS")
    sums_digest = hashlib.sha256(sums_bytes).hexdigest()
    if sums_digest != pin["sha256sums_sha256"]:
        raise WeightsError(
            "SHA256SUMS does not match the pinned hash "
            f"(expected {pin['sha256sums_sha256']}, got {sums_digest}). "
            "The upstream revision is not the one this project pinned."
        )
    sums = parse_sha256sums(sums_bytes.decode("utf-8"))

    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".download-", dir=target.parent))
    try:
        files: dict[str, str] = {}
        for name in pin["files"]:
            relative = _safe_relative(name)
            if name not in sums:
                raise WeightsError(f"{name} is not listed in the repository's SHA256SUMS")
            log(f"downloading {name}")
            data = fetch(f"{base}/{name}")
            digest = hashlib.sha256(data).hexdigest()
            if digest != sums[name]:
                raise WeightsError(f"checksum mismatch for {name}: expected {sums[name]}, got {digest}")
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            files[name] = digest
        manifest = {
            "repo": repo,
            "revision": revision,
            "sha256sums_sha256": sums_digest,
            "files": files,
            "downloaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        (staging / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        os.replace(staging, target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    log(f"verified {len(files)} files at revision {revision}")
    log(f"model directory: {target}")
    return target


def read_manifest(model_dir: Path) -> dict:
    path = model_dir / MANIFEST_NAME
    if not path.exists():
        raise WeightsError(f"no {MANIFEST_NAME} in {model_dir}; run the weights download first")
    return json.loads(path.read_text(encoding="utf-8"))


def verify(model_dir: Path, pin: dict | None = None) -> dict:
    """Re-hash every file against the manifest. Returns the manifest.

    Run at every engine start: results are only tied to a model revision if
    the bytes on disk are still the ones that were downloaded.
    """
    manifest = read_manifest(model_dir)
    if pin is not None:
        for key in ("repo", "revision", "sha256sums_sha256"):
            if manifest.get(key) != pin[key]:
                raise WeightsError(f"manifest {key} is {manifest.get(key)!r}, pin says {pin[key]!r}")
        missing = [name for name in pin["files"] if name not in manifest["files"]]
        if missing:
            raise WeightsError(f"manifest is missing pinned files: {', '.join(missing)}")
    for name, expected in manifest["files"].items():
        path = model_dir / _safe_relative(name)
        if not path.exists():
            raise WeightsError(f"missing file: {name}")
        actual = sha256_file(path)
        if actual != expected:
            raise WeightsError(f"{name} has been modified: expected {expected}, got {actual}")
    return manifest
