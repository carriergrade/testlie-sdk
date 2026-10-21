# @testlie/sdk

Node.js SDK and CLI for [Testlie](https://testlie.com): disposable email inboxes for end-to-end
tests, waiting for an email, and pulling one-time codes and magic links out of it, with
Playwright and Cypress helpers. Zero runtime dependencies (global `fetch`, Node 18+), ESM with
type declarations.

## 30-second quick start

1. Sign up at [testlie.com](https://testlie.com) (free plan) and create a key on the **API keys** page.
2. Install and point the SDK at it:

```bash
npm install --save-dev @testlie/sdk
export TESTLIE_API_KEY=tl_...                # a read-only key can wait and extract
# export TESTLIE_URL=https://testlie.example  # only for a self-hosted server
```

3. Try it without writing any code: create an inbox, send it a sample email, read the code back.

```bash
INBOX=$(npx testlie inboxes create --disposable 10 --json | jq -r .id)
npx testlie send-test --inbox "$INBOX"
npx testlie wait --inbox "$INBOX" --subject code --since 5m --otp   # prints the one-time code
```

4. In a test:

```ts
import { Testlie, inboxAddress } from "@testlie/sdk";

const testlie = new Testlie(); // reads TESTLIE_API_KEY and TESTLIE_URL

await testlie.withInbox(async (inbox) => {
  // Point your app's SMTP settings at inbox.smtp (host, ports, username, password),
  // or send to inboxAddress(inbox, "alice") when the server has an inbound domain.
  await signUp({ email: inboxAddress(inbox, "alice") });

  const email = await testlie.waitForEmail({ inboxId: inbox.id, subject: "Confirm", timeout: 60 });
  const code = await testlie.extractOtp(email);           // "482913"
  const link = await testlie.extractLink(email, /verify/); // "https://app.example.com/verify?token=..."
}, { minutes: 15 });
```

`withInbox` creates a disposable inbox (deleted by the server after `minutes` anyway) and deletes
it when the callback finishes, even if it throws.

## API

```ts
new Testlie({ apiKey?, baseUrl?, maxRetries = 3, timeoutMs = 30_000, fetch? })
```

| Call | Description |
|---|---|
| `inboxes.list()` / `get(id)` | Inboxes with SMTP credentials |
| `inboxes.create({ name?, maxMessages?, projectId?, disposable?: { minutes } })` | Create an inbox; `disposable` makes it delete itself |
| `inboxes.update(id, { name?, maxMessages?, projectId? })` / `delete(id)` | |
| `inboxes.clear(id)` / `markAllRead(id)` / `rotateCredentials(id)` | Empty, mark read, new SMTP password |
| `messages.list(inboxId, { q?, unread?, page?, limit? })` | Summaries, newest first |
| `messages.get(m)` / `raw(m)` / `html(m)` / `attachments(m)` / `attachment(m, id)` | Full message, MIME source, HTML body, attachment metadata and bytes |
| `messages.delete(m)` / `markRead(m, isRead?)` / `forward(m, to)` | |
| `messages.extract(m)` | `{ links, codes, magicLinks }`, best first |
| `messages.waitFor({ inboxId, to?, subject?, since?, timeout?, signal? })` | Long-poll; resolves with the summary |
| `waitForEmail(sameOptions)` | Same, resolves with the full message |
| `extractOtp(m)` / `extractLink(m, pattern?)` | Just the code / the best (or first matching) link |
| `withInbox(fn, { minutes?, name? })` | Disposable inbox for the duration of `fn` |
| `webhooks.list/create/update/delete/test/deliveries/redeliver` | Webhooks |
| `idps.list/create/get/update/delete/rotate/events/clearEvents`, `idps.users.list/create/update/delete` | Mock identity providers |
| `waitForPush({ pushInboxId, token?, topic?, service?, contains?, since?, timeout? })` | Long-poll the push sandbox; resolves with the notification, `extracted.codes` and `extracted.links` included |
| `push.list/get/clear/registerDevice` | Captured push notifications and test device tokens (with simulated outcomes) |

`m` is a message ID or any object with an `id`. `timeout` is in **seconds** (as in the REST API);
waits longer than two minutes are split into several long-polls. `to` is an exact envelope
recipient, `subject` a case-insensitive substring and `since` a `Date` or ISO string. Use a
unique recipient (`inboxAddress(inbox, tag, { unique: true })`) or `since` when several tests
share one inbox.

`extractLink(m)` without a pattern returns the most likely magic link (verify, confirm, reset,
magic, sign-in, activate, invite). A `RegExp` or a case-insensitive substring is matched against
magic links first, then every link, on both the URL and the link text.

### Errors

Every API failure is a `TestlieError` with `status` (0 for network errors), `code` (for example
`read_only_key`, `api_key_expired` or a quota code), `upgradeUrl` on 402 quota errors and the
parsed `body`. Timeouts are `TestlieTimeoutError` (status 408); `extractOtp`/`extractLink`
throw `TestlieExtractError` when nothing matches.

GET, PUT and DELETE requests are retried on 429, 5xx and network errors with exponential backoff
(honouring `Retry-After`); POST and PATCH are never retried.

## Playwright

`@playwright/test` is an optional peer dependency; the SDK only imports its types.

```ts
// fixtures.ts
import { test as base, expect } from "@playwright/test";
import { extendTest } from "@testlie/sdk/playwright";
export const test = extendTest(base);
export { expect };

// signup.spec.ts
import { test, expect } from "./fixtures";

test("sign-up sends a code", async ({ page, inbox, email }) => {
  const address = inbox.address("signup");          // <alias>+signup@<inbound domain>
  await page.goto("/signup");
  await page.getByLabel("Email").fill(address);
  await page.getByRole("button", { name: "Sign up" }).click();

  const message = await email.waitFor({ to: address, subject: "code" });
  await page.getByLabel("Code").fill(await email.extractOtp(message));
});
```

Each test gets its own disposable `inbox` (`Inbox` plus `address(tag?)` and `uniqueAddress(tag?)`),
deleted after the test, and an `email` helper (`waitFor`, `list`, `extractOtp`, `extractLink`).
The inbox URL is added to the test's annotations. Options:

```ts
test.use({ testlieOptions: { inboxMinutes: 15, waitTimeout: 60, keepFailedInboxes: true } });
```

Already have a `test.extend` chain? Use `base.extend(testlieFixtures())`.

## Cypress

The API key stays in Node: commands run through `cy.task`. Do not put the key in Cypress `env`,
which the browser can read.

```ts
// cypress.config.ts
import { defineConfig } from "cypress";
import { setupTestlie } from "@testlie/sdk/cypress";
export default defineConfig({
  e2e: { setupNodeEvents(on, config) { setupTestlie(on); return config; } },
});

// cypress/support/e2e.ts
import "@testlie/sdk/cypress/support";

// cypress/e2e/signup.cy.ts
it("signs up with a code", () => {
  cy.testlieCreateInbox({ minutes: 15 }).then((inbox) => {
    cy.visit("/signup");
    cy.get("#email").type(inbox.address);
    cy.get("form").submit();
    cy.testlieWaitForEmail({ inboxId: inbox.id, subject: "code", timeout: 60 })
      .testlieExtractOtp()
      .then((code) => cy.get("#code").type(code));
    cy.testlieDeleteInbox(inbox.id);
  });
});
```

Commands: `testlieCreateInbox`, `testlieDeleteInbox`, `testlieWaitForEmail`, `testlieExtractOtp`,
`testlieExtractLink(pattern?)`, `testlieExtract`, `testlieAddress(inbox, tag)`. The extract
commands take a message argument or chain from `testlieWaitForEmail`.

## CLI

The `testlie` command is installed with this package. Outside a Node project, `npx testlie ...`
runs the same CLI from the [`testlie`](https://www.npmjs.com/package/testlie) package, a thin
wrapper pinned to the same version. `testlie --version` prints the version.

```bash
npx testlie inboxes create --disposable 30 --name "CI run $GITHUB_RUN_ID"
npx testlie wait --inbox "$INBOX" --to "$EMAIL" --subject Welcome --since 5m --timeout 60 --json
CODE=$(npx testlie wait --inbox "$INBOX" --to "$EMAIL" --otp)
LINK=$(npx testlie extract "$MESSAGE_ID" --link 'reset')
npx testlie send-test --inbox "$INBOX"     # sample email over SMTP, to try the above
```

| Command | |
|---|---|
| `inboxes list` / `inboxes create [--disposable [MIN]] [--name N]` / `inboxes get ID` / `inboxes delete ID` | |
| `wait --inbox ID [--to] [--subject] [--since] [--timeout 60] [--json\|--otp\|--link [PATTERN]]` | Exit 1 on timeout |
| `messages list --inbox ID [--limit] [--unread]` / `messages get ID [--raw\|--html\|--text]` | |
| `extract ID [--otp\|--link [PATTERN]] [--json]` | `--otp`/`--link` print only the value |
| `send-test --inbox ID [--to] [--subject] [--host] [--port] [--insecure]` | Dependency-free SMTP client with STARTTLS |

`--since` takes an ISO time, `now` or a duration ago (`10m`). `--inbox` defaults to
`TESTLIE_INBOX`. Exit codes: 0 ok, 1 timeout or nothing found, 2 usage error, 3 API or network
error. `testlie <command> --help` explains each command.

## Development

```bash
npm install
npm test          # vitest, mocked fetch
npm run build     # tsc to dist/
npm run smoke     # runs the built CLI
```

## Links

- Documentation: https://testlie.com/docs/sdks
- REST API: https://testlie.com/docs/api
- Issues: https://github.com/carriergrade/testlie-sdk/issues
- Changelog: [CHANGELOG.md](CHANGELOG.md)

MIT licensed. Copyright (c) 2026 Carrier Grade Inc.
