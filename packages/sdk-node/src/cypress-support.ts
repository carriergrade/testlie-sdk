/**
 * Browser side of the Cypress integration: custom commands that run the tasks registered by
 * `setupTestlie` (see `@testlie/sdk/cypress`). Import it once from `cypress/support/e2e.ts`:
 *
 *   import "@testlie/sdk/cypress/support";
 *
 *   cy.testlieCreateInbox().then((inbox) => {
 *     cy.get("#email").type(inbox.address);
 *     cy.testlieWaitForEmail({ inboxId: inbox.id, subject: "code" }).testlieExtractOtp().then((code) => cy.get("#otp").type(code));
 *   });
 *
 * Only pure helpers are imported here, so nothing Node-specific ends up in the browser bundle.
 */
import { inboxAddress } from "./address.js";
import type { Extraction, Inbox, Message } from "./types.js";

export type CypressInbox = Inbox & { address: string };
export type CypressWaitOptions = { inboxId: string; to?: string; subject?: string; since?: string | Date; timeout?: number };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    // Matches Cypress's own declaration so the two merge.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    interface Chainable<Subject = any> {
      /** Creates a disposable inbox (default 30 minutes). Yields the inbox with an `address`. */
      testlieCreateInbox(opts?: { minutes?: number; name?: string }): Chainable<CypressInbox>;
      testlieDeleteInbox(inboxId: string): Chainable<null>;
      /** Waits for a matching email (timeout in seconds, default 30) and yields the full message. */
      testlieWaitForEmail(opts: CypressWaitOptions): Chainable<Message>;
      /** Yields the one-time code of the given (or previously yielded) message. */
      testlieExtractOtp(message?: Message | string): Chainable<string>;
      /** Yields a link of the given (or previously yielded) message: the best magic link, or the first matching `pattern`. */
      testlieExtractLink(pattern?: RegExp | string, message?: Message | string): Chainable<string>;
      testlieExtract(message?: Message | string): Chainable<Extraction>;
      /** `<alias>+<tag>@<domain>` for an inbox. */
      testlieAddress(inbox: Inbox, tag?: string): Chainable<string>;
    }
  }
}

// The Cypress runtime globals, typed loosely so this file builds without Cypress installed.
type CyGlobal = { task(name: string, arg?: unknown, opts?: { timeout?: number; log?: boolean }): unknown; wrap(v: unknown, opts?: { log?: boolean }): unknown };
type CypressGlobal = { Commands: { add(name: string, ...args: unknown[]): void } };
const g = globalThis as unknown as { Cypress?: CypressGlobal; cy?: CyGlobal };
const cy = () => g.cy!;

const TASK_SLACK_MS = 15_000;

/** Registers the commands. Runs automatically on import when Cypress is present. */
export function registerTestlieCommands(C: CypressGlobal | undefined = g.Cypress) {
  if (!C) return;
  C.Commands.add("testlieCreateInbox", (opts: { minutes?: number; name?: string } = {}) => cy().task("testlie:createInbox", opts));
  C.Commands.add("testlieDeleteInbox", (inboxId: string) => cy().task("testlie:deleteInbox", inboxId));
  C.Commands.add("testlieWaitForEmail", (opts: CypressWaitOptions) => {
    const since = opts.since instanceof Date ? opts.since.toISOString() : opts.since;
    const timeout = opts.timeout ?? 30;
    return cy().task("testlie:waitForEmail", { ...opts, since, timeout }, { timeout: timeout * 1000 + TASK_SLACK_MS });
  });
  C.Commands.add("testlieExtractOtp", { prevSubject: "optional" }, (subject: unknown, message?: unknown) =>
    cy().task("testlie:extractOtp", refOf(message ?? subject)),
  );
  C.Commands.add("testlieExtract", { prevSubject: "optional" }, (subject: unknown, message?: unknown) =>
    cy().task("testlie:extract", refOf(message ?? subject)),
  );
  C.Commands.add("testlieExtractLink", { prevSubject: "optional" }, (subject: unknown, pattern?: RegExp | string, message?: unknown) =>
    cy().task("testlie:extractLink", {
      message: refOf(message ?? subject),
      // RegExps do not survive the trip to Node, so send their parts.
      pattern: pattern instanceof RegExp ? { source: pattern.source, flags: pattern.flags } : (pattern ?? null),
    }),
  );
  C.Commands.add("testlieAddress", (inbox: Inbox, tag?: string) => cy().wrap(inboxAddress(inbox, tag), { log: false }));
}

function refOf(m: unknown) {
  if (typeof m === "string") return m;
  const id = (m as { id?: string } | null)?.id;
  if (!id) throw new Error("Pass a message or message ID, or chain from cy.testlieWaitForEmail()");
  return id;
}

registerTestlieCommands();
