import { describe, expect, it } from "vitest";
import { testlieFixtures, withAddressHelpers } from "../src/playwright.js";
import { TASKS, testlieTasks } from "../src/cypress.js";
import { registerTestlieCommands } from "../src/cypress-support.js";
import { Testlie } from "../src/client.js";
import { extraction, inbox, message, mockFetch, summary } from "./helpers.js";

const routes = {
  "POST /api/inboxes": () => ({ status: 201, json: { inbox: inbox() } }),
  "DELETE /api/inboxes/ibx_1": () => new Response(null, { status: 204 }),
  "GET /api/inboxes/ibx_1/messages/wait": () => ({ json: { message: summary() } }),
  "GET /api/messages/msg_1": () => ({ json: { message: message() } }),
  "GET /api/messages/msg_1/extract": () => ({ json: extraction }),
};

type FixtureFn = (args: Record<string, unknown>, use: (v: unknown) => Promise<void>, info?: unknown) => Promise<void>;
const fn = (f: unknown) => (Array.isArray(f) ? f[0] : f) as FixtureFn;

describe("playwright fixtures", () => {
  it("gives each test a disposable inbox with address helpers, and deletes it afterwards", async () => {
    const { fetch, calls } = mockFetch(routes);
    const fx = testlieFixtures() as Record<string, unknown>;
    const options = { apiKey: "tl_pw", baseUrl: "https://t.test", fetch, inboxMinutes: 10 };
    let testlie!: Testlie;
    await fn(fx.testlie)({ testlieOptions: options }, async (v) => {
      testlie = v as Testlie;
    });
    const info = { titlePath: ["spec.ts", "signup", "sends a code"], annotations: [] as { type: string; description: string }[], status: "passed", expectedStatus: "passed" };
    await fn(fx.inbox)({ testlie, testlieOptions: options }, async (v) => {
      const ibx = v as ReturnType<typeof withAddressHelpers>;
      expect(ibx.address("alice")).toBe("a1b2c3d4e5f6+alice@in.testlie.com");
      expect(ibx.uniqueAddress("alice")).not.toBe(ibx.uniqueAddress("alice"));
      await fn(fx.email)({ testlie, inbox: ibx, testlieOptions: options }, async (e) => {
        const email = e as { waitFor: (o: object) => Promise<{ id: string }>; extractOtp: (m: unknown) => Promise<string> };
        const m = await email.waitFor({ subject: "code" });
        expect(m.id).toBe("msg_1");
        expect(await email.extractOtp(m)).toBe("482913");
      });
    }, info);
    expect(calls[0].body).toMatchObject({ name: "signup › sends a code", expiresInMinutes: 10 });
    expect(info.annotations[0]).toEqual({ type: "testlie inbox", description: "https://t.test/inboxes/ibx_1" });
    const wait = calls.find((c) => c.path.endsWith("/wait"))!;
    expect(wait.query.get("subject")).toBe("code");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/inboxes/ibx_1" });
  });

  it("keeps a failed test's inbox when asked", async () => {
    const { fetch, calls } = mockFetch(routes);
    const fx = testlieFixtures() as Record<string, unknown>;
    const options = { apiKey: "tl_pw", baseUrl: "https://t.test", fetch, keepFailedInboxes: true };
    const testlie = new Testlie(options);
    const info = { titlePath: ["a", "b"], annotations: [], status: "failed", expectedStatus: "passed" };
    await fn(fx.inbox)({ testlie, testlieOptions: options }, async () => {}, info);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("cypress", () => {
  it("node tasks create inboxes with an address, wait and extract", async () => {
    const { fetch } = mockFetch(routes);
    const tasks = testlieTasks({ apiKey: "tl_cy", baseUrl: "https://t.test", fetch });
    const created = (await tasks[TASKS.createInbox]({ minutes: 5 })) as { address: string };
    expect(created.address).toBe("a1b2c3d4e5f6@in.testlie.com");
    const m = (await tasks[TASKS.waitForEmail]({ inboxId: "ibx_1" })) as { id: string };
    expect(await tasks[TASKS.extractOtp](m)).toBe("482913");
    expect(await tasks[TASKS.extractLink]({ message: "msg_1", pattern: { source: "RESET", flags: "i" } })).toBe("https://app.test/reset/xyz");
    expect(await tasks[TASKS.deleteInbox]("ibx_1")).toBeNull();
  });

  it("support file registers commands that call the tasks with a long enough timeout", () => {
    const added: Record<string, unknown[]> = {};
    const taskCalls: unknown[][] = [];
    (globalThis as { cy?: unknown }).cy = { task: (...a: unknown[]) => taskCalls.push(a), wrap: (v: unknown) => v };
    registerTestlieCommands({ Commands: { add: (name: string, ...rest: unknown[]) => (added[name] = rest) } });
    expect(Object.keys(added).sort()).toEqual([
      "testlieAddress",
      "testlieCreateInbox",
      "testlieDeleteInbox",
      "testlieExtract",
      "testlieExtractLink",
      "testlieExtractOtp",
      "testlieWaitForEmail",
    ]);
    (added.testlieWaitForEmail[0] as (o: object) => void)({ inboxId: "ibx_1", timeout: 90, since: new Date("2026-10-13T00:00:00Z") });
    expect(taskCalls[0]).toEqual(["testlie:waitForEmail", { inboxId: "ibx_1", timeout: 90, since: "2026-10-13T00:00:00.000Z" }, { timeout: 105_000 }]);
    expect(added.testlieExtractOtp[0]).toEqual({ prevSubject: "optional" });
    (added.testlieExtractLink[1] as (s: unknown, p: RegExp) => void)({ id: "msg_1" }, /reset/i);
    expect(taskCalls[1]).toEqual(["testlie:extractLink", { message: "msg_1", pattern: { source: "reset", flags: "i" } }]);
    delete (globalThis as { cy?: unknown }).cy;
  });
});
