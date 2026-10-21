import { afterEach, describe, expect, it, vi } from "vitest";
import { Testlie, TestlieError, TestlieExtractError, TestlieTimeoutError, inboxAddress, pickLink } from "../src/index.js";
import { backoff } from "../src/http.js";
import { extraction, inbox, message, mockFetch, summary } from "./helpers.js";

const client = (fetch: typeof globalThis.fetch, over = {}) => new Testlie({ apiKey: "tl_test", baseUrl: "https://t.test", fetch, maxRetries: 2, ...over });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("configuration", () => {
  it("reads TESTLIE_API_KEY and TESTLIE_URL and sends the key as a bearer token", async () => {
    vi.stubEnv("TESTLIE_API_KEY", "tl_env");
    vi.stubEnv("TESTLIE_URL", "http://localhost:3202/");
    const { fetch, calls } = mockFetch({ "GET /api/inboxes": () => ({ json: { inboxes: [] } }) });
    const t = new Testlie({ fetch });
    expect(t.baseUrl).toBe("http://localhost:3202");
    await t.inboxes.list();
    expect(calls[0].headers.get("authorization")).toBe("Bearer tl_env");
    expect(calls[0].headers.get("user-agent")).toMatch(/^testlie-node\//);
  });

  it("defaults to testlie.com and refuses to start without a key", () => {
    vi.stubEnv("TESTLIE_API_KEY", "");
    expect(() => new Testlie()).toThrow(/TESTLIE_API_KEY/);
    expect(new Testlie({ apiKey: "tl_x" }).baseUrl).toBe("https://testlie.com");
  });
});

describe("errors and retries", () => {
  it("turns error bodies into TestlieError with status, code and an absolute upgrade URL", async () => {
    const { fetch } = mockFetch({
      "POST /api/inboxes": () => ({ status: 402, json: { error: "Inbox limit reached", code: "limit_inboxes", limit: 3, upgradeUrl: "/billing" } }),
    });
    const err = await client(fetch).inboxes.create({ name: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(TestlieError);
    expect(err).toMatchObject({ status: 402, code: "limit_inboxes", upgradeUrl: "https://t.test/billing", isQuota: true });
    expect(err.message).toMatch(/Inbox limit reached \(402 on POST \/api\/inboxes\)/);
    expect((err.body as { limit: number }).limit).toBe(3);
  });

  it("retries idempotent requests on 429 and 5xx, honouring Retry-After", async () => {
    const { fetch, calls } = mockFetch({
      "GET /api/inboxes/ibx_1": [
        () => ({ status: 503, json: { error: "down" } }),
        () => ({ status: 429, json: { error: "slow down" }, headers: { "retry-after": "0" } }),
        () => ({ json: { inbox: inbox() } }),
      ],
    });
    const got = await client(fetch).inboxes.get("ibx_1");
    expect(got.id).toBe("ibx_1");
    expect(calls).toHaveLength(3);
  });

  it("does not retry POSTs, and gives up after maxRetries", async () => {
    const post = mockFetch({ "POST /api/inboxes": () => ({ status: 500, json: { error: "boom" } }) });
    await expect(client(post.fetch).inboxes.create()).rejects.toMatchObject({ status: 500 });
    expect(post.calls).toHaveLength(1);
    const get = mockFetch({ "GET /api/inboxes": () => ({ status: 502, text: "Bad gateway" }) });
    await expect(client(get.fetch, { maxRetries: 1 }).inboxes.list()).rejects.toMatchObject({ status: 502, message: expect.stringContaining("Bad gateway") });
    expect(get.calls).toHaveLength(2);
  });

  it("reports network failures as status 0", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(client(fetch, { maxRetries: 0 }).inboxes.list()).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("backs off exponentially with jitter, capped", () => {
    expect(backoff(0)).toBeGreaterThanOrEqual(125);
    expect(backoff(0)).toBeLessThanOrEqual(250);
    expect(backoff(10)).toBeLessThanOrEqual(8000);
    expect(backoff(0, "2")).toBe(2000);
  });
});

describe("inboxes", () => {
  it("creates disposable inboxes with expiresInMinutes and a generated name", async () => {
    const { fetch, calls } = mockFetch({ "POST /api/inboxes": () => ({ status: 201, json: { inbox: inbox() } }) });
    await client(fetch).inboxes.create({ disposable: { minutes: 15 } });
    expect(calls[0].body).toMatchObject({ expiresInMinutes: 15, name: expect.stringMatching(/^disposable-/) });
    await client(fetch).inboxes.create({ name: "Mine", disposable: true });
    expect(calls[1].body).toMatchObject({ name: "Mine", expiresInMinutes: 30 });
  });

  it("covers update, clear, rotate and delete", async () => {
    const { fetch, calls } = mockFetch({
      "PATCH /api/inboxes/ibx_1": () => ({ json: { inbox: inbox({ name: "New" }) } }),
      "DELETE /api/inboxes/ibx_1/messages": () => ({ json: { deleted: 2 } }),
      "POST /api/inboxes/ibx_1/credentials": () => ({ json: { inbox: inbox() } }),
      "DELETE /api/inboxes/ibx_1": () => new Response(null, { status: 204 }),
    });
    const t = client(fetch);
    expect((await t.inboxes.update("ibx_1", { name: "New" })).name).toBe("New");
    expect(await t.inboxes.clear("ibx_1")).toEqual({ deleted: 2 });
    await t.inboxes.rotateCredentials("ibx_1");
    await expect(t.inboxes.delete("ibx_1")).resolves.toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "DELETE", "POST", "DELETE"]);
  });

  it("builds +tag addresses", () => {
    expect(inboxAddress(inbox(), "Sign Up!")).toBe("a1b2c3d4e5f6+sign-up@in.testlie.com");
    expect(inboxAddress(inbox())).toBe("a1b2c3d4e5f6@in.testlie.com");
    expect(inboxAddress(inbox({ inboundAddress: null }), "x")).toBe("a1b2c3d4e5f6+x@example.com");
    expect(inboxAddress(inbox(), "x", { unique: true })).toMatch(/^a1b2c3d4e5f6\+x-[a-z0-9]+@in\.testlie\.com$/);
  });
});

describe("waiting", () => {
  it("passes filters to the long-poll and returns the summary", async () => {
    const { fetch, calls } = mockFetch({ "GET /api/inboxes/ibx_1/messages/wait": () => ({ json: { message: summary() } }) });
    const since = new Date("2026-10-13T10:00:00Z");
    const m = await client(fetch).messages.waitFor({ inboxId: "ibx_1", to: "A@B.test", subject: "code", since, timeout: 10 });
    expect(m.id).toBe("msg_1");
    const q = calls[0].query;
    expect(Object.fromEntries(q)).toEqual({ to: "a@b.test", subject: "code", since: since.toISOString(), timeout: "10" });
  });

  it("splits long waits into polls of at most 120 s and throws TestlieTimeoutError at the end", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { fetch, calls } = mockFetch({
      "GET /api/inboxes/ibx_1/messages/wait": (c) => {
        now += Number(c.query.get("timeout")) * 1000;
        return { status: 408, json: { error: "No matching message before the timeout" } };
      },
    });
    const err = await client(fetch).messages.waitFor({ inboxId: "ibx_1", subject: "Welcome", timeout: 300 }).catch((e) => e);
    vi.restoreAllMocks();
    expect(err).toBeInstanceOf(TestlieTimeoutError);
    expect(err.status).toBe(408);
    expect(err.message).toMatch(/subject containing "Welcome".*300s/);
    expect(calls.map((c) => c.query.get("timeout"))).toEqual(["120", "120", "60"]);
  });

  it("waitForEmail returns the full message", async () => {
    const { fetch } = mockFetch({
      "GET /api/inboxes/ibx_1/messages/wait": () => ({ json: { message: summary() } }),
      "GET /api/messages/msg_1": () => ({ json: { message: message() } }),
    });
    const m = await client(fetch).waitForEmail({ inboxId: "ibx_1" });
    expect(m.html).toBe("<p>123456</p>");
  });

  it("stops when the caller aborts", async () => {
    const ctrl = new AbortController();
    const fetch = ((_: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof globalThis.fetch;
    const p = client(fetch).messages.waitFor({ inboxId: "ibx_1", signal: ctrl.signal });
    ctrl.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
  });
});

describe("extraction helpers", () => {
  const routes = { "GET /api/messages/msg_1/extract": () => ({ json: extraction }) };

  it("extractOtp returns the best code and accepts a message or an ID", async () => {
    const { fetch } = mockFetch(routes);
    const t = client(fetch);
    expect(await t.extractOtp("msg_1")).toBe("482913");
    expect(await t.extractOtp(message())).toBe("482913");
  });

  it("extractOtp throws TestlieExtractError when there is no code", async () => {
    const { fetch } = mockFetch({ "GET /api/messages/msg_1/extract": () => ({ json: { ...extraction, codes: [] } }) });
    await expect(client(fetch).extractOtp("msg_1")).rejects.toBeInstanceOf(TestlieExtractError);
  });

  it("extractLink picks the magic link, or the first link matching a pattern", async () => {
    const { fetch } = mockFetch(routes);
    const t = client(fetch);
    expect(await t.extractLink("msg_1")).toBe("https://app.test/verify?token=abc");
    expect(await t.extractLink("msg_1", /reset/)).toBe("https://app.test/reset/xyz");
    expect(await t.extractLink("msg_1", "BLOG")).toBe("https://app.test/blog");
    await expect(t.extractLink("msg_1", /nope/)).rejects.toThrow(/No link matching \/nope\//);
  });

  it("pickLink matches link text too and resets global regexes", () => {
    expect(pickLink(extraction, /reset password/i)?.url).toBe("https://app.test/reset/xyz");
    const g = /app/g;
    expect(pickLink(extraction, g)?.url).toBe(pickLink(extraction, g)?.url);
  });
});

describe("withInbox", () => {
  it("creates a disposable inbox and deletes it afterwards, also when the callback throws", async () => {
    const { fetch, calls } = mockFetch({
      "POST /api/inboxes": () => ({ status: 201, json: { inbox: inbox() } }),
      "DELETE /api/inboxes/ibx_1": () => new Response(null, { status: 204 }),
    });
    const t = client(fetch);
    expect(await t.withInbox(async (i) => i.id, { minutes: 5 })).toBe("ibx_1");
    expect(calls[0].body).toMatchObject({ expiresInMinutes: 5 });
    await expect(
      t.withInbox(() => {
        throw new Error("test failed");
      }),
    ).rejects.toThrow("test failed");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });

  it("ignores an inbox that is already gone", async () => {
    const { fetch } = mockFetch({
      "POST /api/inboxes": () => ({ status: 201, json: { inbox: inbox() } }),
      "DELETE /api/inboxes/ibx_1": () => ({ status: 404, json: { error: "Inbox not found" } }),
    });
    await expect(client(fetch).withInbox(async () => "ok")).resolves.toBe("ok");
  });
});

describe("other resources", () => {
  it("webhooks and idps hit the right endpoints", async () => {
    const { fetch, calls } = mockFetch({
      "GET /api/webhooks": () => ({ json: { webhooks: [] } }),
      "POST /api/webhooks": () => ({ status: 201, json: { webhook: { id: "wh_1" } } }),
      "PATCH /api/webhooks/wh_1": () => ({ json: { webhook: { id: "wh_1" } } }),
      "POST /api/webhooks/wh_1/test": () => ({ json: { result: { ok: true }, webhook: { id: "wh_1" } } }),
      "GET /api/idps": () => ({ json: { idps: [{ id: "idp_1" }] } }),
      "POST /api/idps/idp_1/users": () => ({ status: 201, json: { user: { id: "u1" } } }),
      "POST /api/idps/idp_1/rotate": () => ({ json: { idp: { id: "idp_1" } } }),
      "GET /api/messages/msg_1/raw": () => ({ text: "From: a\r\n\r\nhi", headers: { "content-type": "message/rfc822" } }),
    });
    const t = client(fetch);
    await t.webhooks.list({ inboxId: "team" });
    await t.webhooks.create({ url: "https://hook.test", inboxId: "ibx_1" });
    await t.webhooks.update("wh_1", { rotateSecret: true });
    await t.webhooks.test("wh_1");
    expect((await t.idps.list())[0].id).toBe("idp_1");
    expect((await t.idps.users.create("idp_1", { email: "a@b.test", name: "A" })).id).toBe("u1");
    await t.idps.rotate("idp_1", "keys");
    expect(await t.messages.raw("msg_1")).toContain("From: a");
    expect(calls[0].query.get("inboxId")).toBe("team");
    expect(calls[2].body).toEqual({ rotateSecret: true });
    expect(calls[6].body).toEqual({ what: "keys" });
  });
});
