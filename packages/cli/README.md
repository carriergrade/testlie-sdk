# @testlie/cli

Command-line tool for [Testlie](https://testlie.com): create disposable email inboxes, wait for
the email your app sends, and print its one-time code or magic link, from any shell or CI job.

This package is a thin wrapper around the CLI in [`@testlie/sdk`](https://www.npmjs.com/package/@testlie/sdk)
(pinned to the same version), so `npx @testlie/cli ...` works without adding anything to a project.
In a Node project, install `@testlie/sdk` instead: it brings the same `testlie` command plus the
SDK and the Playwright and Cypress helpers.

## 30-second quick start

1. Sign up at [testlie.com](https://testlie.com) (free plan) and create a key on the **API keys** page.
2. Run:

```bash
export TESTLIE_API_KEY=tl_...
INBOX=$(npx @testlie/cli inboxes create --disposable 10 --json | jq -r .id)
npx @testlie/cli send-test --inbox "$INBOX"                               # a sample verification email
npx @testlie/cli wait --inbox "$INBOX" --subject code --since 5m --otp    # prints the one-time code
npx @testlie/cli inboxes delete "$INBOX"
```

| Command | Description |
|---|---|
| `inboxes list` / `inboxes create [--disposable [MIN]] [--name N]` / `inboxes get ID` / `inboxes delete ID` | Inboxes and their SMTP settings |
| `wait --inbox ID [--to] [--subject] [--since] [--timeout 60] [--json\|--otp\|--link [PATTERN]]` | Waits for a matching email; exit 1 on timeout |
| `messages list --inbox ID [--limit] [--unread]` / `messages get ID [--raw\|--html\|--text]` | |
| `extract ID [--otp\|--link [PATTERN]] [--json]` | Codes and links; `--otp`/`--link` print only the value |
| `send-test --inbox ID [--to] [--subject] [--host] [--port] [--insecure]` | Sends a sample email with the inbox's SMTP credentials |

`TESTLIE_URL` overrides the server URL (default `https://testlie.com`), `TESTLIE_INBOX` is the default `--inbox`.
Installed globally (`npm install -g @testlie/cli`), the command is `testlie`.
`testlie --version` prints the version and `testlie <command> --help` explains each command.
Exit codes: 0 ok, 1 timeout or nothing found, 2 usage error, 3 API or network error.

## Links

- Documentation: https://testlie.com/docs/sdks#cli
- Issues: https://github.com/carriergrade/testlie-sdk/issues
- Changelog: [CHANGELOG.md](CHANGELOG.md)

MIT licensed. Copyright (c) 2026 Carrier Grade Inc.
