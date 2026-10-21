import type { Inbox, Message, MessageSummary } from "../src/types.js";

export type Call = { method: string; path: string; query: URLSearchParams; headers: Headers; body: unknown };
type Handler = (call: Call) => Response | Promise<Response> | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/** A fetch stand-in that routes "METHOD /path" to handlers and records every call. */
export function mockFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: Call[] = [];
  const counters = new Map<string, number>();
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const call: Call = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404, headers: { "content-type": "application/json" } });
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    const h = Array.isArray(route) ? route[Math.min(n, route.length - 1)] : route;
    const r = await h(call);
    if (r instanceof Response) return r;
    if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200, headers: r.headers });
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...r.headers },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const inbox = (over: Partial<Inbox> = {}): Inbox => ({
  id: "ibx_1",
  name: "Test",
  projectId: null,
  emailAlias: "a1b2c3d4e5f6",
  inboundAddress: "a1b2c3d4e5f6@in.testlie.com",
  maxMessages: 500,
  expiresAt: null,
  createdAt: "2026-10-13T10:00:00.000Z",
  smtp: { host: "smtp.testlie.com", ports: [587], username: "user", password: "pass", auth: ["PLAIN"], tls: true },
  ...over,
});

export const summary = (over: Partial<MessageSummary> = {}): MessageSummary => ({
  id: "msg_1",
  inboxId: "ibx_1",
  subject: "Your code",
  from: { address: "no-reply@app.test", name: null },
  to: [{ address: "a@b.test", name: "" }],
  cc: [],
  envelopeTo: ["a@b.test"],
  size: 100,
  isRead: false,
  receivedAt: "2026-10-13T10:00:01.000Z",
  ...over,
});

export const message = (over: Partial<Message> = {}): Message => {
  const { envelopeTo: _drop, ...s } = summary();
  return { ...s, messageId: "<x@y>", bcc: [], envelope: { from: "no-reply@app.test", to: ["a@b.test"] }, html: "<p>123456</p>", text: "123456", headers: [], attachments: [], ...over };
};

export const extraction = {
  messageId: "msg_1",
  subject: "Your code",
  codes: [
    { value: "482913", context: "Your code is 482913", score: 7 },
    { value: "1111", context: "PIN 1111", score: 4 },
  ],
  magicLinks: [{ url: "https://app.test/verify?token=abc", text: "Verify", reason: "text and URL mention verify", score: 7 }],
  links: [
    { url: "https://app.test/verify?token=abc", text: "Verify" },
    { url: "https://app.test/reset/xyz", text: "Reset password" },
    { url: "https://app.test/blog", text: "Blog" },
  ],
};
