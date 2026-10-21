/**
 * Node side of the Cypress integration: tasks that call the Testlie API from `setupNodeEvents`,
 * so the API key stays in the Node process and never reaches the browser (do not put it in
 * Cypress `env`, which the browser can read). The browser side is `@testlie/sdk/cypress/support`.
 *
 *   // cypress.config.ts
 *   import { setupTestlie } from "@testlie/sdk/cypress";
 *   export default defineConfig({ e2e: { setupNodeEvents(on, config) { setupTestlie(on); return config; } } });
 */
import { Testlie, type TestlieOptions } from "./client.js";
import { inboxAddress } from "./address.js";
import { TestlieError } from "./errors.js";

export type SerializedPattern = string | { source: string; flags?: string };
type Task = (arg: any) => Promise<unknown>;

/** Task names, shared with the support file. */
export const TASKS = {
  createInbox: "testlie:createInbox",
  deleteInbox: "testlie:deleteInbox",
  waitForEmail: "testlie:waitForEmail",
  extract: "testlie:extract",
  extractOtp: "testlie:extractOtp",
  extractLink: "testlie:extractLink",
} as const;

/** The task handlers, for `on("task", testlieTasks())`. The client is created on first use. */
export function testlieTasks(opts: TestlieOptions = {}): Record<string, Task> {
  let client: Testlie | null = null;
  const t = () => (client ??= new Testlie(opts));
  const idOf = (m: unknown) => (typeof m === "string" ? m : (m as { id?: string; messageId?: string })?.id ?? (m as { messageId?: string })?.messageId);
  return {
    [TASKS.createInbox]: async (arg: { minutes?: number; name?: string } | null) => {
      const inbox = await t().inboxes.create({ name: arg?.name ?? "cypress", disposable: { minutes: arg?.minutes ?? 30 } });
      return { ...inbox, address: inboxAddress(inbox) };
    },
    [TASKS.deleteInbox]: async (id: string) => {
      await t()
        .inboxes.delete(id)
        .catch((err) => {
          if (!(err instanceof TestlieError && err.isNotFound)) throw err;
        });
      return null; // tasks must not return undefined
    },
    [TASKS.waitForEmail]: async (arg: { inboxId: string; to?: string; subject?: string; since?: string; timeout?: number }) => t().waitForEmail(arg),
    [TASKS.extract]: async (message: unknown) => t().messages.extract(idOf(message)!),
    [TASKS.extractOtp]: async (message: unknown) => t().extractOtp(idOf(message)!),
    [TASKS.extractLink]: async (arg: { message: unknown; pattern?: SerializedPattern | null }) => {
      const p = arg.pattern;
      const pattern = p == null ? undefined : typeof p === "string" ? p : new RegExp(p.source, p.flags);
      return t().extractLink(idOf(arg.message)!, pattern);
    },
  };
}

/** Registers the tasks: call it from `setupNodeEvents(on, config)`. */
export function setupTestlie(on: (event: "task", tasks: Record<string, Task>) => void, opts: TestlieOptions = {}) {
  on("task", testlieTasks(opts));
}
