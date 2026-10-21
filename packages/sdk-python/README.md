# testlie

Python client for [Testlie](https://testlie.com): disposable email inboxes for end-to-end tests,
waiting for an email, and pulling one-time codes and magic links out of it. Standard library
only (`urllib`), Python 3.9+, typed, with a pytest plugin.

## 30-second quick start

1. Sign up at [testlie.com](https://testlie.com) (free plan) and create a key on the **API keys** page.
2. Install and point the client at it:

```bash
pip install testlie
export TESTLIE_API_KEY=tl_...                # a read-only key can wait and extract
# export TESTLIE_URL=https://testlie.example  # only to use another server
```

3. Use it in a test:

```python
from testlie import Testlie

testlie = Testlie()  # TESTLIE_API_KEY, TESTLIE_URL

with testlie.disposable_inbox(minutes=15) as inbox:
    # inbox.smtp has host, ports, username and password for your app's SMTP settings
    sign_up(email=inbox.address("alice"))          # <alias>+alice@<inbound domain>
    email = testlie.wait_for_email(inbox.id, to=inbox.address("alice"), subject="Confirm", timeout=60)
    code = testlie.extract_otp(email)              # "482913"
    link = testlie.extract_link(email, "verify")   # first magic link or link containing "verify"
```

Records returned by the API are dicts that also allow attribute access (`inbox.id`,
`inbox["smtp"]["password"]`).

## API

| Call | Description |
|---|---|
| `inboxes.list()`, `get(id)`, `create(name=, max_messages=, project_id=, disposable_minutes=)` | Inboxes with SMTP credentials |
| `inboxes.update(id, name=..., max_messages=...)`, `delete(id)`, `clear(id)`, `mark_all_read(id)`, `rotate_credentials(id)` | |
| `messages.list(inbox_id, q=, unread=, page=, limit=)` | `{"total", "messages": [...]}`, newest first |
| `messages.get(m)`, `raw(m)` (bytes), `html(m)`, `attachment(m, id)`, `delete(m)`, `mark_read(m)`, `forward(m, to)` | |
| `messages.extract(m)` | `{"links", "codes", "magicLinks"}`, best first |
| `messages.wait_for(inbox_id, to=, subject=, since=, timeout=30)` | Long-poll, returns the summary |
| `wait_for_email(...)` | Same, returns the full message |
| `extract_otp(m)`, `extract_link(m, pattern=None)` | The code / the best or first matching link |
| `disposable_inbox(minutes=30, name=None)` | Context manager; deletes the inbox on exit |
| `webhooks.list/create/update/delete`, `idps.list/create/get/update/delete/users/add_user/delete_user` | |

`m` is a message ID or a message dict. `timeout` is in seconds; waits over two minutes are split
into several long-polls. `pattern` is a compiled regex or a case-insensitive substring, matched
against magic links first, then every link, on the URL and the link text.

Errors: `TestlieError` (`status`, `code`, `upgrade_url`, `body`; status 0 for network errors),
`TestlieTimeoutError` (408) and `TestlieExtractError`. GET, PUT and DELETE are retried on 429,
5xx and network errors with exponential backoff, honouring `Retry-After`.

## pytest

The plugin is registered automatically when the package is installed.

```python
def test_signup_sends_code(testlie, testlie_inbox, page):
    address = testlie_inbox.address("signup")
    page.goto("/signup"); page.fill("#email", address); page.click("text=Sign up")
    email = testlie.wait_for_email(testlie_inbox.id, to=address, subject="code")
    page.fill("#code", testlie.extract_otp(email))
```

- `testlie`: session-wide client.
- `testlie_inbox`: a fresh disposable inbox per test, deleted afterwards.
- `--testlie-url URL` overrides `TESTLIE_URL`; the ini option `testlie_inbox_minutes` (default 30)
  sets the inbox lifetime.

## Development

```bash
pip install -e . pytest
pytest                     # uses a local http.server fake of the API
python -m build && twine check dist/*
```

## Links

- Documentation: https://testlie.com/docs/sdks
- REST API: https://testlie.com/docs/api
- Issues: https://github.com/carriergrade/testlie-sdk/issues
- Changelog: [CHANGELOG.md](CHANGELOG.md)

MIT licensed. Copyright (c) 2026 Carrier Grade Inc.
