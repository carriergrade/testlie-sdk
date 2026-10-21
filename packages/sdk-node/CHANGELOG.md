# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-21

First public release.

- `Testlie` client: inboxes (including disposable inboxes), messages, long-poll `waitForEmail`,
  server-side OTP and magic-link extraction (`extractOtp`, `extractLink`), webhooks, mock
  identity providers, push sandbox (`waitForPush`) and scenarios.
- `inboxAddress` plus-address helpers.
- Playwright fixtures (`@testlie/sdk/playwright`) and Cypress tasks and commands
  (`@testlie/sdk/cypress`, `@testlie/sdk/cypress/support`).
- `testlie` CLI (`inboxes`, `wait`, `messages`, `extract`, `send-test`, `--version`).
- Retries with exponential backoff and `Retry-After` for idempotent requests; typed errors.
- Zero runtime dependencies, Node 18+, ESM with type declarations.
