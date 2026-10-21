"""Client for the Testlie REST API, using only the standard library."""

from __future__ import annotations

import contextlib
import json
import os
import random
import re
import secrets
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Dict, Iterator, List, Optional, Pattern, Union

from .errors import TestlieError, TestlieExtractError, TestlieTimeoutError

__version__ = "0.1.0"
DEFAULT_BASE_URL = "https://testlie.com"
#: The API holds a long-poll open for at most this long; longer waits are split into several.
MAX_POLL_SECONDS = 120
IDEMPOTENT = {"GET", "HEAD", "PUT", "DELETE", "OPTIONS"}


class Record(dict):
    """A JSON object from the API that also allows attribute access (``inbox.id``)."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None


class Inbox(Record):
    """An inbox, with its SMTP credentials under ``smtp``."""

    def address(self, tag: Optional[str] = None, unique: bool = False) -> str:
        """An address that lands in this inbox; see :func:`inbox_address`."""
        return inbox_address(self, tag, unique=unique)


class Message(Record):
    pass


def clean_tag(tag: str) -> str:
    t = re.sub(r"[^a-z0-9._-]+", "-", tag.lower())
    return re.sub(r"^[-.]+|[-.]+$", "", t)[:48]


def inbox_address(inbox: Dict[str, Any], tag: Optional[str] = None, unique: bool = False, domain: Optional[str] = None) -> str:
    """``<alias>+<tag>@<inbound domain>``, or ``<alias>+<tag>@example.com`` when the server has no
    inbound domain (then only SMTP-authenticated mail reaches the inbox, and any recipient works)."""
    t = clean_tag(tag) if tag else ""
    if unique:
        t = "-".join(x for x in (t, secrets.token_hex(4)) if x)
    suffix = f"+{t}" if t else ""
    inbound = inbox.get("inboundAddress")
    if inbound and not domain:
        local, _, host = inbound.rpartition("@")
        return f"{local}{suffix}@{host}"
    return f"{inbox['emailAlias']}{suffix}@{domain or 'example.com'}"


def _iso(v: Union[str, datetime, None]) -> Optional[str]:
    if v is None or isinstance(v, str):
        return v
    if v.tzinfo is None:
        v = v.replace(tzinfo=timezone.utc)
    return v.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _id(m: Union[str, Dict[str, Any]]) -> str:
    return m if isinstance(m, str) else m["id"]


def _q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def backoff(attempt: int, retry_after: Optional[str] = None) -> float:
    """Seconds to wait before retry ``attempt``: Retry-After when sent, else exponential with jitter."""
    if retry_after:
        try:
            return min(30.0, max(0.0, float(retry_after)))
        except ValueError:
            try:
                return min(30.0, max(0.0, parsedate_to_datetime(retry_after).timestamp() - time.time()))
            except (TypeError, ValueError):
                pass
    base = min(8.0, 0.25 * 2**attempt)
    return base / 2 + random.random() * base / 2


def pick_link(extraction: Dict[str, Any], pattern: Union[str, Pattern[str], None] = None) -> Optional[Dict[str, Any]]:
    """The best magic link, or the first magic link then link whose URL or text matches ``pattern``
    (a compiled regex, or a string matched case-insensitively as a substring)."""
    if pattern is None:
        links = extraction.get("magicLinks") or []
        return links[0] if links else None
    if isinstance(pattern, str):
        needle = pattern.lower()
        test: Callable[[str], bool] = lambda s: needle in s.lower()
    else:
        test = lambda s: bool(pattern.search(s))  # type: ignore[union-attr]
    for link in list(extraction.get("magicLinks") or []) + list(extraction.get("links") or []):
        if test(link.get("url", "")) or test(link.get("text", "")):
            return link
    return None


class _Http:
    def __init__(self, api_key: str, base_url: str, max_retries: int, timeout: float, opener: Optional[urllib.request.OpenerDirector]):
        self.api_key = api_key
        self.base_url = base_url
        self.max_retries = max_retries
        self.timeout = timeout
        self.opener = opener or urllib.request.build_opener()

    def url(self, path: str, query: Optional[Dict[str, Any]] = None) -> str:
        q = {k: (_iso(v) if isinstance(v, datetime) else v) for k, v in (query or {}).items() if v not in (None, "")}
        return self.base_url + path + (("?" + urllib.parse.urlencode(q)) if q else "")

    def request(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, Any]] = None,
        body: Any = None,
        raw: bool = False,
        extra_timeout: float = 0,
        ok_statuses: tuple = (),
    ) -> Any:
        method = method.upper()
        url = self.url(path, query)
        retries = self.max_retries if method in IDEMPOTENT else 0
        data = json.dumps(body).encode() if body is not None else None
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "*/*" if raw else "application/json",
            "User-Agent": f"testlie-python/{__version__}",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with self.opener.open(req, timeout=self.timeout + extra_timeout) as res:
                    payload = res.read()
                    status = res.status
            except urllib.error.HTTPError as e:
                with e:
                    payload = e.read()
                status = e.code
                if (status == 429 or status >= 500) and attempt < retries:
                    time.sleep(backoff(attempt, e.headers.get("Retry-After")))
                    attempt += 1
                    continue
                if status in ok_statuses:
                    return status, _parse(payload)
                raise self._error(status, payload, method, path) from None
            except (urllib.error.URLError, socket.timeout, ConnectionError) as e:
                if attempt < retries:
                    time.sleep(backoff(attempt))
                    attempt += 1
                    continue
                reason = getattr(e, "reason", e)
                raise TestlieError(f"{method} {path} failed: {reason}", status=0, code="network_error", method=method, path=path) from e
            if ok_statuses:
                return status, _parse(payload)
            if raw:
                return payload
            return _parse(payload)

    def _error(self, status: int, payload: bytes, method: str, path: str) -> TestlieError:
        body = _parse(payload)
        obj = body if isinstance(body, dict) else {}
        message = obj.get("error") or (body[:200] if isinstance(body, str) and body else f"HTTP {status}")
        upgrade = obj.get("upgradeUrl")
        if isinstance(upgrade, str) and upgrade.startswith("/"):
            upgrade = self.base_url + upgrade
        return TestlieError(
            f"{message} ({status} on {method} {path})",
            status=status,
            code=obj.get("code"),
            upgrade_url=upgrade,
            body=body,
            method=method,
            path=path,
        )


def _parse(payload: bytes) -> Any:
    if not payload:
        return None
    text = payload.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


class Inboxes:
    def __init__(self, http: _Http):
        self._http = http

    def list(self) -> List[Inbox]:
        return [Inbox(i) for i in self._http.request("GET", "/api/inboxes")["inboxes"]]

    def create(
        self,
        name: Optional[str] = None,
        max_messages: Optional[int] = None,
        project_id: Optional[str] = None,
        disposable_minutes: Optional[int] = None,
    ) -> Inbox:
        """Creates an inbox; ``disposable_minutes`` makes it delete itself (and its messages)."""
        if name is None:
            name = f"disposable-{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%S}-{secrets.token_hex(2)}" if disposable_minutes else "SDK inbox"
        body = {"name": name, "maxMessages": max_messages, "projectId": project_id, "expiresInMinutes": disposable_minutes}
        body = {k: v for k, v in body.items() if v is not None}
        return Inbox(self._http.request("POST", "/api/inboxes", body=body)["inbox"])

    def get(self, inbox_id: str) -> Inbox:
        return Inbox(self._http.request("GET", f"/api/inboxes/{_q(inbox_id)}")["inbox"])

    def update(self, inbox_id: str, **patch: Any) -> Inbox:
        """``name``, ``max_messages`` / ``maxMessages``, ``project_id`` / ``projectId``."""
        names = {"max_messages": "maxMessages", "project_id": "projectId"}
        body = {names.get(k, k): v for k, v in patch.items()}
        return Inbox(self._http.request("PATCH", f"/api/inboxes/{_q(inbox_id)}", body=body)["inbox"])

    def delete(self, inbox_id: str) -> None:
        self._http.request("DELETE", f"/api/inboxes/{_q(inbox_id)}")

    def clear(self, inbox_id: str) -> int:
        """Deletes every message; returns how many."""
        return self._http.request("DELETE", f"/api/inboxes/{_q(inbox_id)}/messages")["deleted"]

    def mark_all_read(self, inbox_id: str) -> int:
        return self._http.request("PATCH", f"/api/inboxes/{_q(inbox_id)}/messages")["updated"]

    def rotate_credentials(self, inbox_id: str) -> Inbox:
        return Inbox(self._http.request("POST", f"/api/inboxes/{_q(inbox_id)}/credentials")["inbox"])


class Messages:
    def __init__(self, http: _Http):
        self._http = http

    def list(self, inbox_id: str, q: Optional[str] = None, unread: bool = False, page: int = 1, limit: int = 50) -> Dict[str, Any]:
        """``{"total", "page", "limit", "messages": [...]}``, newest first."""
        res = self._http.request(
            "GET",
            f"/api/inboxes/{_q(inbox_id)}/messages",
            query={"q": q, "unread": "true" if unread else None, "page": page, "limit": limit},
        )
        res["messages"] = [Message(m) for m in res["messages"]]
        return res

    def get(self, message: Union[str, Dict[str, Any]]) -> Message:
        return Message(self._http.request("GET", f"/api/messages/{_q(_id(message))}")["message"])

    def raw(self, message: Union[str, Dict[str, Any]]) -> bytes:
        """The original MIME source."""
        return self._http.request("GET", f"/api/messages/{_q(_id(message))}/raw", raw=True)

    def html(self, message: Union[str, Dict[str, Any]]) -> str:
        """The HTML body with cid: images inlined (text wrapped in <pre> when there is no HTML)."""
        return self._http.request("GET", f"/api/messages/{_q(_id(message))}/html", raw=True).decode("utf-8", "replace")

    def attachment(self, message: Union[str, Dict[str, Any]], attachment_id: str) -> bytes:
        return self._http.request("GET", f"/api/messages/{_q(_id(message))}/attachments/{_q(attachment_id)}", raw=True)

    def delete(self, message: Union[str, Dict[str, Any]]) -> None:
        self._http.request("DELETE", f"/api/messages/{_q(_id(message))}")

    def mark_read(self, message: Union[str, Dict[str, Any]], is_read: bool = True) -> None:
        self._http.request("PATCH", f"/api/messages/{_q(_id(message))}", body={"isRead": is_read})

    def forward(self, message: Union[str, Dict[str, Any]], to: Union[str, List[str]]) -> Dict[str, Any]:
        return self._http.request("POST", f"/api/messages/{_q(_id(message))}/forward", body={"to": [to] if isinstance(to, str) else to})

    def extract(self, message: Union[str, Dict[str, Any]]) -> Dict[str, Any]:
        """``{"links", "codes", "magicLinks"}``, most likely first."""
        return self._http.request("GET", f"/api/messages/{_q(_id(message))}/extract")

    def wait_for(
        self,
        inbox_id: str,
        to: Optional[str] = None,
        subject: Optional[str] = None,
        since: Union[str, datetime, None] = None,
        timeout: float = 30,
    ) -> Message:
        """Long-polls until a matching message arrives; returns its summary. ``to`` is an exact
        envelope recipient, ``subject`` a case-insensitive substring, ``timeout`` in seconds.
        Raises :class:`TestlieTimeoutError`."""
        deadline = time.monotonic() + timeout
        path = f"/api/inboxes/{_q(inbox_id)}/messages/wait"
        while True:
            left = int(-(-(deadline - time.monotonic()) // 1))  # ceil
            chunk = max(1, min(MAX_POLL_SECONDS, left))
            started = time.monotonic()
            status, body = self._http.request(
                "GET",
                path,
                query={"to": to.lower() if to else None, "subject": subject, "since": _iso(since), "timeout": chunk},
                extra_timeout=chunk,
                ok_statuses=(200, 408),
            )
            if status == 200:
                return Message(body["message"])
            if time.monotonic() >= deadline - 0.5:
                break
            # A proxy that cuts long-polls short should not turn this into a busy loop.
            if time.monotonic() - started < 1:
                time.sleep(1)
        filters = ", ".join(x for x in (f"to {to}" if to else "", f'subject containing "{subject}"' if subject else "") if x)
        raise TestlieTimeoutError(f"No email{f' ({filters})' if filters else ''} arrived in inbox {inbox_id} within {timeout:g}s", path=path)


class Webhooks:
    def __init__(self, http: _Http):
        self._http = http

    def list(self, inbox_id: Optional[str] = None) -> List[Record]:
        return [Record(w) for w in self._http.request("GET", "/api/webhooks", query={"inboxId": inbox_id})["webhooks"]]

    def create(self, url: str, inbox_id: Optional[str] = None, events: Optional[List[str]] = None, enabled: bool = True) -> Record:
        body = {"url": url, "inboxId": inbox_id, "enabled": enabled, **({"events": events} if events else {})}
        return Record(self._http.request("POST", "/api/webhooks", body=body)["webhook"])

    def update(self, webhook_id: str, **patch: Any) -> Record:
        return Record(self._http.request("PATCH", f"/api/webhooks/{_q(webhook_id)}", body=patch)["webhook"])

    def delete(self, webhook_id: str) -> None:
        self._http.request("DELETE", f"/api/webhooks/{_q(webhook_id)}")


class Idps:
    def __init__(self, http: _Http):
        self._http = http

    def list(self) -> List[Record]:
        return [Record(i) for i in self._http.request("GET", "/api/idps")["idps"]]

    def create(self, name: str, redirect_uris: Optional[List[str]] = None) -> Record:
        body = {"name": name, **({"redirectUris": redirect_uris} if redirect_uris else {})}
        return Record(self._http.request("POST", "/api/idps", body=body)["idp"])

    def get(self, idp_id: str) -> Record:
        return Record(self._http.request("GET", f"/api/idps/{_q(idp_id)}")["idp"])

    def update(self, idp_id: str, **patch: Any) -> Record:
        return Record(self._http.request("PATCH", f"/api/idps/{_q(idp_id)}", body=patch)["idp"])

    def delete(self, idp_id: str) -> None:
        self._http.request("DELETE", f"/api/idps/{_q(idp_id)}")

    def users(self, idp_id: str) -> List[Record]:
        return [Record(u) for u in self._http.request("GET", f"/api/idps/{_q(idp_id)}/users")["users"]]

    def add_user(self, idp_id: str, email: str, name: str, **extra: Any) -> Record:
        return Record(self._http.request("POST", f"/api/idps/{_q(idp_id)}/users", body={"email": email, "name": name, **extra})["user"])

    def delete_user(self, idp_id: str, user_id: str) -> None:
        self._http.request("DELETE", f"/api/idps/{_q(idp_id)}/users/{_q(user_id)}")


class Testlie:
    """Testlie API client.

    >>> testlie = Testlie()  # TESTLIE_API_KEY, TESTLIE_URL
    >>> with testlie.disposable_inbox(minutes=15) as inbox:
    ...     sign_up(inbox.address("alice"))
    ...     email = testlie.wait_for_email(inbox.id, subject="Confirm")
    ...     code = testlie.extract_otp(email)
    """

    __test__ = False  # not a pytest test class, despite the name

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        max_retries: int = 3,
        timeout: float = 30.0,
        opener: Optional[urllib.request.OpenerDirector] = None,
    ) -> None:
        api_key = api_key or os.environ.get("TESTLIE_API_KEY")
        if not api_key:
            raise TestlieError("No API key: pass api_key= or set TESTLIE_API_KEY", code="missing_api_key")
        self.base_url = (base_url or os.environ.get("TESTLIE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self._http = _Http(api_key, self.base_url, max_retries, timeout, opener)
        self.inboxes = Inboxes(self._http)
        self.messages = Messages(self._http)
        self.webhooks = Webhooks(self._http)
        self.idps = Idps(self._http)

    def wait_for_email(
        self,
        inbox_id: str,
        to: Optional[str] = None,
        subject: Optional[str] = None,
        since: Union[str, datetime, None] = None,
        timeout: float = 30,
    ) -> Message:
        """Waits for a matching email and returns the full message (html, text, headers...)."""
        summary = self.messages.wait_for(inbox_id, to=to, subject=subject, since=since, timeout=timeout)
        return self.messages.get(summary["id"])

    def extract_otp(self, message: Union[str, Dict[str, Any]]) -> str:
        """The most likely one-time code. Raises :class:`TestlieExtractError` when there is none."""
        x = self.messages.extract(message)
        if not x["codes"]:
            raise TestlieExtractError(f"No one-time code found in message {x['messageId']} (\"{x['subject']}\")")
        return x["codes"][0]["value"]

    def extract_link(self, message: Union[str, Dict[str, Any]], pattern: Union[str, Pattern[str], None] = None) -> str:
        """The best magic link, or the first link matching ``pattern`` (see :func:`pick_link`)."""
        x = self.messages.extract(message)
        link = pick_link(x, pattern)
        if not link:
            what = "No magic link" if pattern is None else f"No link matching {getattr(pattern, 'pattern', pattern)!r}"
            raise TestlieExtractError(f"{what} found in message {x['messageId']} (\"{x['subject']}\")")
        return link["url"]

    @contextlib.contextmanager
    def disposable_inbox(self, minutes: int = 30, name: Optional[str] = None) -> Iterator[Inbox]:
        """A fresh inbox that is deleted on exit (and by the server after ``minutes`` regardless)."""
        inbox = self.inboxes.create(name=name, disposable_minutes=minutes)
        try:
            yield inbox
        finally:
            try:
                self.inboxes.delete(inbox["id"])
            except TestlieError as e:
                if not e.is_not_found:
                    raise
