"""pytest plugin (registered through the ``pytest11`` entry point).

Fixtures:

* ``testlie``: a session-wide :class:`testlie.Testlie` client (``TESTLIE_API_KEY``, ``TESTLIE_URL``).
* ``testlie_inbox``: a fresh disposable inbox per test, deleted afterwards. Use
  ``testlie_inbox.address("tag")`` for a recipient and ``testlie_inbox.smtp`` for credentials.

Options: ``--testlie-url`` and the ini setting ``testlie_inbox_minutes`` (default 30).
"""

from __future__ import annotations

from typing import Iterator

import pytest

from .client import Inbox, Testlie
from .errors import TestlieError


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("testlie")
    group.addoption("--testlie-url", default=None, help="Testlie base URL (default: TESTLIE_URL or https://testlie.com)")
    parser.addini("testlie_inbox_minutes", "Lifetime of each testlie_inbox in minutes", default="30")


@pytest.fixture(scope="session")
def testlie(pytestconfig: pytest.Config) -> Testlie:
    """Session-wide Testlie client."""
    try:
        return Testlie(base_url=pytestconfig.getoption("testlie_url"))
    except TestlieError as e:
        raise pytest.UsageError(f"testlie: {e}") from None


@pytest.fixture
def testlie_inbox(testlie: Testlie, request: pytest.FixtureRequest) -> Iterator[Inbox]:
    """A disposable inbox for one test, deleted when the test ends."""
    minutes = int(request.config.getini("testlie_inbox_minutes") or 30)
    with testlie.disposable_inbox(minutes=minutes, name=request.node.nodeid[-80:]) as inbox:
        yield inbox
