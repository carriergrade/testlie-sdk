# Testlie SDKs

Official client libraries for [Testlie](https://testlie.com), the testing sandbox for email,
SMS, SMPP, WhatsApp, push and voice, mock OIDC/SAML/social identity providers and request bins.
Create a disposable inbox in a test, wait for the email your app sends, and use its one-time
code or magic link, without writing HTTP calls or regexes by hand.

| Package | Install | Source |
|---|---|---|
| Node.js SDK, Playwright and Cypress helpers, `testlie` CLI | `npm install --save-dev @testlie/sdk` | [`packages/sdk-node`](packages/sdk-node) |
| CLI only, no Node project | `npx @testlie/cli --version` | [`packages/cli`](packages/cli) |
| Python client and pytest plugin | `pip install testlie` | [`packages/sdk-python`](packages/sdk-python) |
| Go client | `go get github.com/carriergrade/testlie-go` | [carriergrade/testlie-go](https://github.com/carriergrade/testlie-go) |
| GitHub Action | `uses: carriergrade/testlie-action@v1` | [carriergrade/testlie-action](https://github.com/carriergrade/testlie-action) |

## 30-second quick start

1. Sign up at [testlie.com](https://testlie.com) (free plan) and create a key on the **API keys** page.
2. Run:

```bash
export TESTLIE_API_KEY=tl_...
INBOX=$(npx @testlie/cli inboxes create --disposable 10 --json | jq -r .id)
npx @testlie/cli send-test --inbox "$INBOX"                               # a sample verification email
npx @testlie/cli wait --inbox "$INBOX" --subject code --since 5m --otp    # prints the one-time code
```

Each package's README has its own quick start. Full documentation: https://testlie.com/docs/sdks.

This repository is exported from Testlie's main (private) repository on every release; issues
and pull requests are welcome here.

MIT licensed. Copyright (c) 2026 Carrier Grade Inc.
