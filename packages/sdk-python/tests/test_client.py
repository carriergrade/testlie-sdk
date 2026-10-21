"""Tests against a local http.server fake of the Testlie API. Run: python3 -m unittest discover -s tests"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Tuple
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from testlie import (  # noqa: E402
    Testlie,
    TestlieError,
    TestlieExtractError,
    TestlieTimeoutError,
    inbox_address,
    pick_link,
)
from testlie import client as client_module  # noqa: E402

INBOX = {
    "id": "ibx_1",
    "name": "Test",
    "emailAlias": "a1b2c3d4e5f6",
    "inboundAddress": "a1b2c3d4e5f6@in.testlie.com",
    "expiresAt": None,
    "smtp": {"host": "smtp.testlie.com", "ports": [587], "username": "u", "password": "p", "auth": ["PLAIN"], "tls": True},
}
SUMMARY = {"id": "msg_1", "inboxId": "ibx_1", "subject": "Your code", "envelopeTo": ["a@b.test"]}
MESSAGE = {**SUMMARY, "html": "<p>482913</p>", "text": "482913"}
EXTRACTION = {
    "messageId": "msg_1",
    "subject": "Your code",
    "codes": [{"value": "482913", "context": "code 482913", "score": 7}],
    "magicLinks": [{"url": "https://app.test/verify?token=abc", "text": "Verify", "reason": "text mention verify", "score": 6}],
    "links": [
        {"url": "https://app.test/verify?token=abc", "text": "Verify"},
        {"url": "https://app.test/reset/xyz", "text": "Reset password"},
    ],
}

Reply = Tuple[int, Any, Dict[str, str]]
Route = Callable[[Dict[str, Any]], Reply]


class Fake:
    """Routes "METHOD /path" to functions returning (status, json body, headers)."""

    def __init__(self) -> None:
        self.routes: Dict[str, List[Route]] = {}
        self.calls: List[Dict[str, Any]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def handle_any(self) -> None:
                url = urlparse(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                call = {
                    "method": self.command,
                    "path": url.path,
                    "query": {k: v[0] for k, v in parse_qs(url.query).items()},
                    "headers": dict(self.headers),
                    "body": json.loads(raw) if raw else None,
                }
                fake.calls.append(call)
                handlers = fake.routes.get(f"{self.command} {url.path}")
                if not handlers:
                    status, body, headers = 404, {"error": "not found"}, {}
                else:
                    h = handlers.pop(0) if len(handlers) > 1 else handlers[0]
                    status, body, headers = h(call)
                data = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
                self.send_response(status)
                self.send_header("Content-Type", headers.pop("Content-Type", "application/json"))
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = handle_any

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def on(self, key: str, *handlers: Route) -> None:
        self.routes[key] = list(handlers)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def ok(body: Any, status: int = 200, headers: Dict[str, str] = None) -> Route:  # type: ignore[assignment]
    return lambda _c: (status, body, dict(headers or {}))


class ClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = Fake()
        self.t = Testlie(api_key="tl_py", base_url=self.fake.url + "/", max_retries=2)
        # Keep retry back-off fast in tests.
        self._backoff = client_module.backoff
        client_module.backoff = lambda attempt, retry_after=None: 0.01

    def tearDown(self) -> None:
        client_module.backoff = self._backoff
        self.fake.close()

    def test_env_defaults_and_auth_header(self) -> None:
        os.environ["TESTLIE_API_KEY"] = "tl_env"
        os.environ["TESTLIE_URL"] = self.fake.url
        try:
            self.fake.on("GET /api/inboxes", ok({"inboxes": [INBOX]}))
            inboxes = Testlie().inboxes.list()
            self.assertEqual(inboxes[0].id, "ibx_1")
            self.assertEqual(self.fake.calls[0]["headers"]["Authorization"], "Bearer tl_env")
            self.assertTrue(self.fake.calls[0]["headers"]["User-Agent"].startswith("testlie-python/"))
        finally:
            del os.environ["TESTLIE_API_KEY"], os.environ["TESTLIE_URL"]
        self.assertEqual(Testlie(api_key="tl_x").base_url, "https://testlie.com")
        with self.assertRaises(TestlieError) as cm:
            Testlie()
        self.assertEqual(cm.exception.code, "missing_api_key")

    def test_errors_carry_status_code_and_upgrade_url(self) -> None:
        self.fake.on("POST /api/inboxes", ok({"error": "Inbox limit reached", "code": "limit_inboxes", "upgradeUrl": "/billing"}, 402))
        with self.assertRaises(TestlieError) as cm:
            self.t.inboxes.create(name="x")
        e = cm.exception
        self.assertEqual((e.status, e.code, e.upgrade_url), (402, "limit_inboxes", self.fake.url + "/billing"))
        self.assertTrue(e.is_quota)
        self.assertIn("Inbox limit reached (402 on POST /api/inboxes)", str(e))

    def test_retries_idempotent_requests_only(self) -> None:
        self.fake.on("GET /api/inboxes/ibx_1", ok({"error": "down"}, 503), ok({"error": "slow"}, 429, {"Retry-After": "0"}), ok({"inbox": INBOX}))
        self.assertEqual(self.t.inboxes.get("ibx_1")["name"], "Test")
        self.assertEqual(len(self.fake.calls), 3)
        self.fake.calls.clear()
        self.fake.on("POST /api/inboxes", ok({"error": "boom"}, 500))
        with self.assertRaises(TestlieError):
            self.t.inboxes.create()
        self.assertEqual(len(self.fake.calls), 1)

    def test_network_errors_are_status_zero(self) -> None:
        t = Testlie(api_key="tl", base_url="http://127.0.0.1:9", max_retries=0, timeout=2)
        with self.assertRaises(TestlieError) as cm:
            t.inboxes.list()
        self.assertEqual((cm.exception.status, cm.exception.code), (0, "network_error"))

    def test_create_disposable_and_address(self) -> None:
        self.fake.on("POST /api/inboxes", ok({"inbox": INBOX}, 201))
        inbox = self.t.inboxes.create(disposable_minutes=15)
        body = self.fake.calls[0]["body"]
        self.assertEqual(body["expiresInMinutes"], 15)
        self.assertTrue(body["name"].startswith("disposable-"))
        self.assertEqual(inbox.address("Sign Up!"), "a1b2c3d4e5f6+sign-up@in.testlie.com")
        self.assertEqual(inbox_address({**INBOX, "inboundAddress": None}, "x"), "a1b2c3d4e5f6+x@example.com")
        self.assertRegex(inbox.address("x", unique=True), r"^a1b2c3d4e5f6\+x-[0-9a-f]{8}@in\.testlie\.com$")

    def test_wait_for_passes_filters(self) -> None:
        self.fake.on("GET /api/inboxes/ibx_1/messages/wait", ok({"message": SUMMARY}))
        since = datetime(2026, 10, 13, 10, 0, tzinfo=timezone.utc)
        m = self.t.messages.wait_for("ibx_1", to="A@B.test", subject="code", since=since, timeout=5)
        self.assertEqual(m.id, "msg_1")
        self.assertEqual(self.fake.calls[0]["query"], {"to": "a@b.test", "subject": "code", "since": "2026-10-13T10:00:00Z", "timeout": "5"})

    def test_wait_for_times_out(self) -> None:
        self.fake.on("GET /api/inboxes/ibx_1/messages/wait", ok({"error": "No matching message before the timeout"}, 408))
        with self.assertRaises(TestlieTimeoutError) as cm:
            self.t.messages.wait_for("ibx_1", subject="Welcome", timeout=1)
        self.assertEqual(cm.exception.status, 408)
        self.assertIn('subject containing "Welcome"', str(cm.exception))

    def test_wait_for_email_returns_full_message(self) -> None:
        self.fake.on("GET /api/inboxes/ibx_1/messages/wait", ok({"message": SUMMARY}))
        self.fake.on("GET /api/messages/msg_1", ok({"message": MESSAGE}))
        self.assertEqual(self.t.wait_for_email("ibx_1").html, "<p>482913</p>")

    def test_extract_helpers(self) -> None:
        self.fake.on("GET /api/messages/msg_1/extract", ok(EXTRACTION))
        self.assertEqual(self.t.extract_otp("msg_1"), "482913")
        self.assertEqual(self.t.extract_otp(MESSAGE), "482913")
        self.assertEqual(self.t.extract_link("msg_1"), "https://app.test/verify?token=abc")
        self.assertEqual(self.t.extract_link("msg_1", re.compile("reset")), "https://app.test/reset/xyz")
        self.assertEqual(self.t.extract_link("msg_1", "RESET PASSWORD"), "https://app.test/reset/xyz")
        with self.assertRaises(TestlieExtractError):
            self.t.extract_link("msg_1", "nope")
        self.assertIsNone(pick_link({"magicLinks": [], "links": []}))

    def test_extract_otp_raises_without_code(self) -> None:
        self.fake.on("GET /api/messages/msg_1/extract", ok({**EXTRACTION, "codes": []}))
        with self.assertRaises(TestlieExtractError):
            self.t.extract_otp("msg_1")

    def test_disposable_inbox_is_deleted_even_on_error(self) -> None:
        self.fake.on("POST /api/inboxes", ok({"inbox": INBOX}, 201))
        self.fake.on("DELETE /api/inboxes/ibx_1", ok(None, 204))
        with self.t.disposable_inbox(minutes=5) as inbox:
            self.assertEqual(inbox.id, "ibx_1")
        with self.assertRaises(RuntimeError):
            with self.t.disposable_inbox():
                raise RuntimeError("test failed")
        deletes = [c for c in self.fake.calls if c["method"] == "DELETE"]
        self.assertEqual(len(deletes), 2)
        self.assertEqual(self.fake.calls[0]["body"]["expiresInMinutes"], 5)

    def test_disposable_inbox_ignores_already_deleted(self) -> None:
        self.fake.on("POST /api/inboxes", ok({"inbox": INBOX}, 201))
        self.fake.on("DELETE /api/inboxes/ibx_1", ok({"error": "Inbox not found"}, 404))
        with self.t.disposable_inbox():
            pass

    def test_messages_and_raw(self) -> None:
        self.fake.on("GET /api/inboxes/ibx_1/messages", ok({"total": 1, "page": 1, "limit": 50, "messages": [SUMMARY]}))
        self.fake.on("GET /api/messages/msg_1/raw", lambda _c: (200, b"Subject: hi\r\n\r\nbody", {"Content-Type": "message/rfc822"}))
        self.fake.on("PATCH /api/messages/msg_1", ok({"ok": True}))
        res = self.t.messages.list("ibx_1", unread=True)
        self.assertEqual(res["messages"][0].subject, "Your code")
        self.assertEqual(self.fake.calls[0]["query"]["unread"], "true")
        self.assertEqual(self.t.messages.raw("msg_1"), b"Subject: hi\r\n\r\nbody")
        self.t.messages.mark_read("msg_1")
        self.assertEqual(self.fake.calls[-1]["body"], {"isRead": True})


try:
    import pytest  # noqa: F401

    HAVE_PYTEST = True
except ImportError:
    HAVE_PYTEST = False


@unittest.skipUnless(HAVE_PYTEST, "pytest not installed")
class PluginTest(unittest.TestCase):
    def test_testlie_inbox_fixture(self) -> None:
        import subprocess
        import tempfile

        fake = Fake()
        try:
            fake.on("POST /api/inboxes", ok({"inbox": INBOX}, 201))
            fake.on("DELETE /api/inboxes/ibx_1", ok(None, 204))
            with tempfile.TemporaryDirectory() as d:
                with open(os.path.join(d, "test_sample.py"), "w") as f:
                    f.write("def test_it(testlie_inbox):\n    assert testlie_inbox.address('x') == 'a1b2c3d4e5f6+x@in.testlie.com'\n")
                src = os.path.join(os.path.dirname(__file__), "..", "src")
                env = {**os.environ, "TESTLIE_API_KEY": "tl_plugin", "TESTLIE_URL": fake.url, "PYTHONPATH": os.path.abspath(src),
                       # Load the plugin explicitly, whether or not the package is installed.
                       "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"}
                r = subprocess.run(
                    [sys.executable, "-m", "pytest", "-q", "-p", "testlie.pytest_plugin", "-o", "testlie_inbox_minutes=7", d],
                    env=env,
                    capture_output=True,
                    text=True,
                )
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertEqual(fake.calls[0]["body"]["expiresInMinutes"], 7)
            self.assertEqual(fake.calls[-1]["method"], "DELETE")
        finally:
            fake.close()


if __name__ == "__main__":
    unittest.main()
