# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-21

First public release.

- `Testlie` client: inboxes (including `disposable_inbox`), messages, long-poll
  `wait_for_email`, server-side OTP and magic-link extraction, webhooks and mock identity providers.
- pytest plugin with `testlie` and `testlie_inbox` fixtures and a `--testlie-url` option.
- Retries with exponential backoff and `Retry-After` for idempotent requests; typed errors.
- Standard library only, Python 3.9+, `py.typed`.
