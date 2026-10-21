"""Exceptions raised by the Testlie client."""

from __future__ import annotations

from typing import Any, Optional


class TestlieError(Exception):
    """Any non-2xx answer from the API, or a network failure (``status == 0``)."""

    __test__ = False  # not a pytest test class, despite the name

    def __init__(
        self,
        message: str,
        status: int = 0,
        code: Optional[str] = None,
        upgrade_url: Optional[str] = None,
        body: Any = None,
        method: Optional[str] = None,
        path: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        #: HTTP status, or 0 when no answer arrived.
        self.status = status
        #: Machine-readable code when the API sends one (``read_only_key``, quota codes...).
        self.code = code
        #: Where to upgrade the plan, on 402 quota errors.
        self.upgrade_url = upgrade_url
        #: The parsed error body.
        self.body = body
        self.method = method
        self.path = path

    @property
    def is_not_found(self) -> bool:
        return self.status == 404

    @property
    def is_quota(self) -> bool:
        return self.status == 402


class TestlieTimeoutError(TestlieError):
    """No matching email arrived before the timeout."""

    def __init__(self, message: str, path: Optional[str] = None) -> None:
        super().__init__(message, status=408, code="timeout", method="GET", path=path)


class TestlieExtractError(Exception):
    """A message had no one-time code, or no link matching the pattern."""

    __test__ = False
