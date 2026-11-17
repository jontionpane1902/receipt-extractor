"""Protocol and weights logic, with a fake engine and fake downloads.

Standard library only (no model, no venv needed):
    python3 -m unittest discover -s packages/ocr-openthai/python/tests -t packages/ocr-openthai/python
"""

import base64
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from openthai_ocr import PROTOCOL_VERSION, protocol
from openthai_ocr.weights import WeightsError, default_model_dir, download, parse_sha256sums, verify


class FakeEngine:
    def __init__(self):
        self.images = []

    def info(self):
        return {"model": "fake/model", "revision": "abc", "backend": "fake", "load_ms": 1.0}

    def read(self, image: bytes) -> dict:
        self.images.append(image)
        if image == b"undecodable":
            raise ValueError("cannot decode image bytes")
        if image == b"explode":
            raise RuntimeError("native crash")
        return {"lines": [{"text": "ยอดสุทธิ", "confidence": 0.99, "row": 0, "box": [[0, 0], [1, 0], [1, 1], [0, 1]]}],
                "dropped": [], "rotation": 0, "text_angle": 0.0, "timing": {"total_ms": 1.0}}


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class ProtocolTest(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()

    def test_ready_message(self):
        self.assertEqual(
            protocol.ready_message(self.engine),
            {"type": "ready", "protocol": PROTOCOL_VERSION, "model": "fake/model", "revision": "abc",
             "backend": "fake", "load_ms": 1.0},
        )

    def test_ocr_passes_image_bytes_and_returns_lines(self):
        response = protocol.handle(self.engine, {"id": "1", "op": "ocr", "image_b64": b64(b"\x00\xffimg")})
        self.assertEqual(self.engine.images, [b"\x00\xffimg"])
        self.assertTrue(response["ok"])
        self.assertEqual(response["id"], "1")
        self.assertEqual(response["lines"][0]["text"], "ยอดสุทธิ")

    def test_ping(self):
        self.assertEqual(protocol.handle(self.engine, {"id": "p", "op": "ping"}),
                         {"type": "result", "id": "p", "ok": True, "pong": True})

    def test_bad_requests_never_raise(self):
        cases = [
            ("not json", None, "bad_request"),
            ("[1]", None, "bad_request"),
            ('{"op":"ocr"}', None, "bad_request"),
            ('{"id":"1","op":"nope"}', "1", "bad_request"),
            ('{"id":"1","op":"ocr"}', "1", "bad_request"),
            ('{"id":"1","op":"ocr","image_b64":"***"}', "1", "bad_request"),
        ]
        for line, request_id, code in cases:
            response = protocol.handle_line(self.engine, line)
            self.assertFalse(response["ok"], line)
            self.assertEqual(response["id"], request_id, line)
            self.assertEqual(response["error"]["code"], code, line)

    def test_engine_errors_become_error_responses(self):
        bad = protocol.handle(self.engine, {"id": "1", "op": "ocr", "image_b64": b64(b"undecodable")})
        self.assertEqual(bad["error"]["code"], "bad_image")
        crash = protocol.handle(self.engine, {"id": "2", "op": "ocr", "image_b64": b64(b"explode")})
        self.assertEqual(crash["error"]["code"], "ocr_failed")
        self.assertIn("RuntimeError", crash["error"]["message"])

    def test_encode_is_one_line_and_keeps_thai_readable(self):
        line = protocol.encode({"text": "น้ำดื่ม\nสองบรรทัด"})
        self.assertNotIn("\n", line)
        self.assertIn("น้ำดื่ม", line)
        self.assertEqual(json.loads(line)["text"], "น้ำดื่ม\nสองบรรทัด")


class WeightsTest(unittest.TestCase):
    FILES = {"det.onnx": b"detector-bytes", "runtime/line_engine.py": b"print('x')\n"}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sums = "".join(f"{hashlib.sha256(data).hexdigest()}  ./{name}\n" for name, data in self.FILES.items()).encode()
        self.pin = {"repo": "org/Model-Name", "revision": "rev1",
                    "sha256sums_sha256": hashlib.sha256(self.sums).hexdigest(), "files": list(self.FILES)}
        self.fetched = []

    def tearDown(self):
        self.tmp.cleanup()

    def fetch(self, url: str) -> bytes:
        self.fetched.append(url)
        prefix = "https://huggingface.co/org/Model-Name/resolve/rev1/"
        assert url.startswith(prefix), url
        name = url[len(prefix):]
        return self.sums if name == "SHA256SUMS" else self.FILES[name]

    def quiet(self, *_):
        pass

    def test_parse_sha256sums(self):
        self.assertEqual(parse_sha256sums("AB" * 32 + "  ./a/b.txt\nnot a line\n"), {"a/b.txt": "ab" * 32})

    def test_download_verifies_and_writes_manifest(self):
        target = download(self.root, self.pin, fetch=self.fetch, log=self.quiet)
        self.assertEqual(target, default_model_dir(self.root, self.pin))
        self.assertEqual(target, self.root / "model-name" / "rev1")
        self.assertEqual((target / "runtime" / "line_engine.py").read_bytes(), self.FILES["runtime/line_engine.py"])
        manifest = verify(target, self.pin)
        self.assertEqual(manifest["revision"], "rev1")
        self.assertEqual(set(manifest["files"]), set(self.FILES))

    def test_second_download_reuses_a_verified_copy(self):
        download(self.root, self.pin, fetch=self.fetch, log=self.quiet)
        self.fetched.clear()
        download(self.root, self.pin, fetch=self.fetch, log=self.quiet)
        self.assertEqual(self.fetched, [])

    def test_corrupted_download_is_rejected_and_nothing_is_left_behind(self):
        def corrupt(url):
            return b"tampered" if url.endswith("det.onnx") else self.fetch(url)

        with self.assertRaisesRegex(WeightsError, "checksum mismatch for det.onnx"):
            download(self.root, self.pin, fetch=corrupt, log=self.quiet)
        self.assertFalse(default_model_dir(self.root, self.pin).exists())
        self.assertEqual(list((self.root / "model-name").iterdir()), [])

    def test_changed_upstream_sha256sums_is_rejected(self):
        pin = {**self.pin, "sha256sums_sha256": "0" * 64}
        with self.assertRaisesRegex(WeightsError, "does not match the pinned hash"):
            download(self.root, pin, fetch=self.fetch, log=self.quiet)

    def test_verify_detects_a_file_modified_after_download(self):
        target = download(self.root, self.pin, fetch=self.fetch, log=self.quiet)
        (target / "det.onnx").write_bytes(b"swapped")
        with self.assertRaisesRegex(WeightsError, "det.onnx has been modified"):
            verify(target, self.pin)

    def test_verify_detects_a_different_revision(self):
        target = download(self.root, self.pin, fetch=self.fetch, log=self.quiet)
        with self.assertRaisesRegex(WeightsError, "revision"):
            verify(target, {**self.pin, "revision": "rev2"})

    def test_unsafe_file_names_are_refused(self):
        pin = {**self.pin, "files": ["../escape.txt"]}
        with self.assertRaisesRegex(WeightsError, "unsafe"):
            download(self.root, pin, fetch=self.fetch, log=self.quiet)


if __name__ == "__main__":
    unittest.main()
