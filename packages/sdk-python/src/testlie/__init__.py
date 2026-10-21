"""Testlie: disposable email inboxes, wait-for-email and code/link extraction for tests."""

from .client import (
    DEFAULT_BASE_URL,
    Inbox,
    Message,
    Record,
    Testlie,
    __version__,
    clean_tag,
    inbox_address,
    pick_link,
)
from .errors import TestlieError, TestlieExtractError, TestlieTimeoutError

__all__ = [
    "DEFAULT_BASE_URL",
    "Inbox",
    "Message",
    "Record",
    "Testlie",
    "TestlieError",
    "TestlieExtractError",
    "TestlieTimeoutError",
    "__version__",
    "clean_tag",
    "inbox_address",
    "pick_link",
]
