// Type-only import: @playwright/test is an optional peer dependency, and this module never
// loads it at runtime. You pass in your own `test`, so the SDK always uses your Playwright copy.
import type { Fixtures, TestInfo, TestType } from "@playwright/test";
import { Testlie, type LinkPattern, type MessageRef, type TestlieOptions, type WaitOptions } from "./client.js";
import { inboxAddress } from "./address.js";
import { TestlieError } from "./errors.js";
import type { Inbox, Message, MessageSummary } from "./types.js";

export type TestlieFixtureOptions = TestlieOptions & {
  /** Lifetime of each test's disposable inbox (default 30 minutes). */
  inboxMinutes?: number;
  /** Keep the inbox of a failed test for debugging, instead of deleting it (it still expires). */
  keepFailedInboxes?: boolean;
  /** Default `email.waitFor` timeout in seconds (default 30). */
  waitTimeout?: number;
};

/** A disposable inbox for one test, with address helpers. */
export type TestlieInbox = Inbox & {
  /** `<alias>+<tag>@<domain>`: lands in this inbox. Same tag, same address. */
  address(tag?: string): string;
  /** Like address(), plus a random suffix: a new recipient every call. */
  uniqueAddress(tag?: string): string;
};

export type EmailHelper = {
  /** Waits for a matching email in the test's inbox and returns the full message. */
  waitFor(opts?: Partial<WaitOptions>): Promise<Message>;
  /** Every message in the test's inbox, newest first. */
  list(): Promise<MessageSummary[]>;
  extractOtp(message: MessageRef): Promise<string>;
  extractLink(message: MessageRef, pattern?: LinkPattern): Promise<string>;
};

export type TestlieTestFixtures = { inbox: TestlieInbox; email: EmailHelper };
export type TestlieWorkerFixtures = { testlie: Testlie; testlieOptions: TestlieFixtureOptions };

/** Wraps an inbox with the address helpers. */
export function withAddressHelpers(inbox: Inbox): TestlieInbox {
  return {
    ...inbox,
    address: (tag?: string) => inboxAddress(inbox, tag),
    uniqueAddress: (tag?: string) => inboxAddress(inbox, tag, { unique: true }),
  };
}

/**
 * Fixtures for `test.extend()`: `testlie` (client, per worker), `inbox` (a fresh disposable inbox
 * per test, deleted afterwards) and `email` (wait and extract helpers bound to that inbox).
 * Configure with `test.use({ testlieOptions: { ... } })` or the TESTLIE_* environment variables.
 */
export function testlieFixtures(): Fixtures<TestlieTestFixtures, TestlieWorkerFixtures> {
  return {
    testlieOptions: [{}, { scope: "worker", option: true }],
    testlie: [
      async ({ testlieOptions }, use) => {
        await use(new Testlie(testlieOptions));
      },
      { scope: "worker" },
    ],
    inbox: async ({ testlie, testlieOptions }, use, testInfo: TestInfo) => {
      const name = testInfo.titlePath.slice(1).join(" › ").slice(0, 80) || "playwright";
      const inbox = await testlie.inboxes.create({ name, disposable: { minutes: testlieOptions.inboxMinutes ?? 30 } });
      testInfo.annotations.push({ type: "testlie inbox", description: `${testlie.baseUrl}/inboxes/${inbox.id}` });
      await use(withAddressHelpers(inbox));
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (failed && testlieOptions.keepFailedInboxes) return;
      await testlie.inboxes.delete(inbox.id).catch((err) => {
        if (!(err instanceof TestlieError && err.isNotFound)) throw err;
      });
    },
    email: async ({ testlie, inbox, testlieOptions }, use) => {
      await use({
        waitFor: (opts = {}) => testlie.waitForEmail({ ...opts, timeout: opts.timeout ?? testlieOptions.waitTimeout, inboxId: opts.inboxId ?? inbox.id }),
        list: async () => (await testlie.messages.list(inbox.id, { limit: 200 })).messages,
        extractOtp: (m) => testlie.extractOtp(m),
        extractLink: (m, pattern) => testlie.extractLink(m, pattern),
      });
    },
  };
}

/**
 * Adds the Testlie fixtures to your Playwright `test`:
 *
 *   import { test as base, expect } from "@playwright/test";
 *   import { extendTest } from "@testlie/sdk/playwright";
 *   export const test = extendTest(base);
 */
export function extendTest<T extends {}, W extends {}>(base: TestType<T, W>): TestType<T & TestlieTestFixtures, W & TestlieWorkerFixtures> {
  return base.extend<TestlieTestFixtures, TestlieWorkerFixtures>(testlieFixtures() as Fixtures<TestlieTestFixtures, TestlieWorkerFixtures, T, W>);
}
