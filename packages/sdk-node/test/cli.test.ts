import { describe, expect, it } from "vitest";
import { EXIT, main, parseArgs, parseSince } from "../src/cli.js";
import { extraction, inbox, message, mockFetch, summary } from "./helpers.js";

function run(argv: string[], routes: Parameters<typeof mockFetch>[0] = {}, env: Record<string, string> = {}) {
  const { fetch, calls } = mockFetch(routes);
  const out: string[] = [];
  const err: string[] = [];
  return main(argv, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { TESTLIE_API_KEY: "tl_cli", TESTLIE_URL: "https://t.test", ...env },
    fetch,
  }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n"), calls }));
}

describe("argument parsing", () => {
  it("handles values, =values, booleans and optional values", () => {
    expect(parseArgs(["wait", "--inbox", "i1", "--timeout=5", "--json", "--link"])).toEqual({
      positionals: ["wait"],
      flags: { inbox: "i1", timeout: "5", json: true, link: true },
    });
    expect(parseArgs(["extract", "m1", "--link", "reset", "--otp"]).flags).toEqual({ link: "reset", otp: true });
    expect(parseArgs(["inboxes", "create", "--disposable", "--name", "x"]).flags).toEqual({ disposable: true, name: "x" });
    expect(() => parseArgs(["wait", "--inbox"])).toThrow(/--inbox needs a value/);
  });

  it("parses --since as ISO, now or a duration ago", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(parseSince("now", now)).toBe("2026-10-13T12:00:00.000Z");
    expect(parseSince("5m", now)).toBe("2026-10-13T11:55:00.000Z");
    expect(parseSince("-90s", now)).toBe("2026-10-13T11:58:30.000Z");
    expect(parseSince("2026-10-13T10:00:00+02:00", now)).toBe("2026-10-13T08:00:00.000Z");
    expect(() => parseSince("yesterday", now)).toThrow(/--since/);
  });
});

describe("help and usage", () => {
  it("prints help for the CLI and each command", async () => {
    expect((await run(["--help"])).out).toMatch(/Usage: testlie <command>/);
    const wait = await run(["wait", "--help"]);
    expect(wait.code).toBe(EXIT.ok);
    expect(wait.out).toMatch(/Exits with 1 when nothing arrives/);
    expect((await run(["help", "extract"])).out).toMatch(/--otp/);
  });

  it("exits 2 on usage errors and unknown commands", async () => {
    expect((await run(["frobnicate"])).code).toBe(EXIT.usage);
    const r = await run(["wait"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toMatch(/--inbox ID is required/);
    expect((await run(["inboxes", "list"], {}, { TESTLIE_API_KEY: "" })).code).toBe(EXIT.usage);
  });
});

describe("commands", () => {
  const waitRoutes = {
    "GET /api/inboxes/ibx_1/messages/wait": () => ({ json: { message: summary() } }),
    "GET /api/messages/msg_1": () => ({ json: { message: message() } }),
    "GET /api/messages/msg_1/extract": () => ({ json: extraction }),
  };

  it("wait prints id and subject, or the full message with --json", async () => {
    const r = await run(["wait", "--inbox", "ibx_1", "--to", "a@b.test", "--timeout", "5"], waitRoutes);
    expect(r).toMatchObject({ code: 0, out: "msg_1\tYour code" });
    expect(r.calls[0].query.get("timeout")).toBe("5");
    const j = await run(["wait", "--json"], waitRoutes, { TESTLIE_INBOX: "ibx_1" });
    expect(JSON.parse(j.out)).toMatchObject({ id: "msg_1", html: "<p>123456</p>" });
  });

  it("wait --otp and --link print just the value", async () => {
    expect((await run(["wait", "--inbox", "ibx_1", "--otp"], waitRoutes)).out).toBe("482913");
    expect((await run(["wait", "--inbox", "ibx_1", "--link", "reset"], waitRoutes)).out).toBe("https://app.test/reset/xyz");
  });

  it("wait exits 1 on timeout", async () => {
    const r = await run(["wait", "--inbox", "ibx_1", "--timeout", "1"], {
      "GET /api/inboxes/ibx_1/messages/wait": () => ({ status: 408, json: { error: "No matching message before the timeout" } }),
    });
    expect(r.code).toBe(EXIT.notFound);
    expect(r.err).toMatch(/No email arrived/);
    expect(r.out).toBe("");
  });

  it("extract prints everything, or only --otp / --link, and exits 1 when nothing matches", async () => {
    const all = await run(["extract", "msg_1"], waitRoutes);
    expect(all.out).toMatch(/Codes:\n {2}482913/);
    expect(all.out).toMatch(/Magic links:\n {2}https:\/\/app\.test\/verify/);
    expect((await run(["extract", "msg_1", "--otp"], waitRoutes)).out).toBe("482913");
    expect((await run(["extract", "msg_1", "--link"], waitRoutes)).out).toBe("https://app.test/verify?token=abc");
    const none = await run(["extract", "msg_1", "--link", "^https://other"], waitRoutes);
    expect(none.code).toBe(EXIT.notFound);
    expect((await run(["extract", "msg_1", "--link", "("], waitRoutes)).code).toBe(EXIT.usage);
  });

  it("inboxes create --disposable prints the SMTP settings", async () => {
    const r = await run(["inboxes", "create", "--disposable", "15", "--name", "ci"], {
      "POST /api/inboxes": () => ({ status: 201, json: { inbox: inbox({ expiresAt: "2026-10-13T10:15:00.000Z" }) } }),
    });
    expect(r.code).toBe(0);
    expect(r.calls[0].body).toMatchObject({ name: "ci", expiresInMinutes: 15 });
    expect(r.out).toMatch(/Password: {2}pass/);
    expect(r.out).toMatch(/Address: {3}a1b2c3d4e5f6@in\.testlie\.com/);
  });

  it("inboxes list and messages list print tables", async () => {
    const i = await run(["inboxes", "list"], { "GET /api/inboxes": () => ({ json: { inboxes: [inbox({ messageCount: 3 })] } }) });
    expect(i.out.split("\n")[0]).toMatch(/^ID\s+NAME\s+MESSAGES/);
    expect(i.out).toMatch(/ibx_1\s+Test\s+3/);
    const m = await run(["messages", "list", "--inbox", "ibx_1"], {
      "GET /api/inboxes/ibx_1/messages": () => ({ json: { total: 1, page: 1, limit: 20, messages: [summary()] } }),
    });
    expect(m.out).toMatch(/msg_1\s+2026-10-13 10:00:01\s+no-reply@app\.test\s+a@b\.test\s+Your code/);
  });

  it("messages get supports --raw and --html", async () => {
    const routes = {
      "GET /api/messages/msg_1": () => ({ json: { message: message() } }),
      "GET /api/messages/msg_1/raw": () => ({ text: "Subject: hi\r\n\r\nbody\r\n" }),
    };
    expect((await run(["messages", "get", "msg_1", "--raw"], routes)).out).toBe("Subject: hi\r\n\r\nbody");
    expect((await run(["messages", "get", "msg_1", "--html"], routes)).out).toBe("<p>123456</p>");
    expect(JSON.parse((await run(["messages", "get", "msg_1"], routes)).out).id).toBe("msg_1");
  });

  it("API errors exit 3 with the server's message", async () => {
    const r = await run(["messages", "get", "nope"], { "GET /api/messages/nope": () => ({ status: 404, json: { error: "Message not found" } }) });
    expect(r.code).toBe(EXIT.api);
    expect(r.err).toMatch(/Message not found \(404/);
  });
});
