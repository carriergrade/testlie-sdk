import { describe, expect, it } from "vitest";
import { Testlie, TestlieTimeoutError } from "../src/index.js";
import { mockFetch } from "./helpers.js";

const client = (fetch: typeof globalThis.fetch) => new Testlie({ apiKey: "tl_test", baseUrl: "https://t.test", fetch, maxRetries: 0 });
const notification = { id: "pn_1", service: "apns", title: "Sign in", body: "Code 482913", extracted: { codes: ["482913"], links: [] } };

describe("push", () => {
  it("waitForPush long-polls with the filters and returns the notification", async () => {
    const { fetch, calls } = mockFetch({
      "GET /api/push-inboxes/pi_1/notifications/wait": [() => ({ status: 408, json: { error: "timeout" } }), () => ({ json: { notification } })],
    });
    const n = await client(fetch).waitForPush({ pushInboxId: "pi_1", token: "ab".repeat(32), contains: "code", since: "2026-01-01T00:00:00Z", timeout: 5 });
    expect(n.extracted?.codes[0]).toBe("482913");
    expect(calls).toHaveLength(2);
    expect(calls[0].query.get("token")).toBe("ab".repeat(32));
    expect(calls[0].query.get("contains")).toBe("code");
    expect(calls[0].query.get("since")).toBe("2026-01-01T00:00:00Z");
    expect(Number(calls[0].query.get("timeout"))).toBeLessThanOrEqual(5);
  });

  it("throws TestlieTimeoutError when nothing arrives", async () => {
    const { fetch } = mockFetch({ "GET /api/push-inboxes/pi_1/notifications/wait": () => ({ status: 408, json: { error: "timeout" } }) });
    const err = await client(fetch).push.waitFor({ pushInboxId: "pi_1", topic: "com.example.app", timeout: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TestlieTimeoutError);
    expect(err.message).toMatch(/No push notification \(topic com.example.app\) arrived in push inbox pi_1 within 1s/);
  });

  it("registers devices, lists, gets and clears", async () => {
    const { fetch, calls } = mockFetch({
      "POST /api/push-inboxes/pi_1/devices": () => ({ status: 201, json: { device: { id: "d1", platform: "fcm", token: "t", outcome: "unregistered" } } }),
      "GET /api/push-inboxes/pi_1/notifications": () => ({ json: { total: 1, page: 1, limit: 100, notifications: [notification] } }),
      "GET /api/push/pn_1": () => ({ json: { notification } }),
      "DELETE /api/push-inboxes/pi_1/notifications": () => ({ json: { deleted: 1 } }),
    });
    const t = client(fetch);
    expect((await t.push.registerDevice("pi_1", { platform: "fcm", token: "t", outcome: "unregistered" })).outcome).toBe("unregistered");
    expect(calls[0].body).toEqual({ platform: "fcm", token: "t", outcome: "unregistered" });
    expect((await t.push.list("pi_1", { service: "fcm" })).total).toBe(1);
    expect(calls[1].query.get("service")).toBe("fcm");
    expect((await t.push.get("pn_1")).id).toBe("pn_1");
    expect(await t.push.clear("pi_1")).toEqual({ deleted: 1 });
  });
});
