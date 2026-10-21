import { Http } from "./http.js";
import { TestlieError, TestlieExtractError, TestlieTimeoutError } from "./errors.js";
import type {
  Extraction,
  ExtractedLink,
  Idp,
  IdpUser,
  Inbox,
  Message,
  MessageList,
  MessageSummary,
  PushDevice,
  PushNotification,
  PushService,
  Webhook,
  WebhookEvent,
} from "./types.js";

export const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://testlie.com";
/** The API holds a long-poll open for at most this long; longer waits are split into several. */
const MAX_POLL_SECONDS = 120;

export type TestlieOptions = {
  /** Team API key (`tl_...`). Defaults to `TESTLIE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `TESTLIE_URL`, then `https://testlie.com`. */
  baseUrl?: string;
  /** Retries for idempotent requests on 429, 5xx and network errors (default 3). */
  maxRetries?: number;
  /** Per-request timeout in milliseconds (default 30 000; long-polls add their wait on top). */
  timeoutMs?: number;
  /** Custom fetch, e.g. for proxies or tests. Defaults to the global fetch (Node 18+). */
  fetch?: typeof fetch;
};

export type CreateInboxOptions = {
  name?: string;
  maxMessages?: number;
  projectId?: string | null;
  /** Make the inbox disposable: it and its messages are deleted after this many minutes. */
  disposable?: { minutes: number } | boolean;
};

export type WaitOptions = {
  inboxId: string;
  /** Exact envelope recipient, e.g. an `inboxAddress(inbox, "signup")`. Case-insensitive. */
  to?: string;
  /** Substring of the subject, case-insensitive. */
  subject?: string;
  /** Only messages received at or after this time. */
  since?: Date | string;
  /** Seconds to wait (default 30). Waits longer than two minutes are split into several polls. */
  timeout?: number;
  signal?: AbortSignal;
};

export type PushWaitOptions = {
  pushInboxId: string;
  /** Device token (APNs hex tokens match case-insensitively) or FCM registration token. */
  token?: string;
  /** apns-topic, or the FCM topic. */
  topic?: string;
  service?: PushService;
  /** Substring of the title or body, case-insensitive. */
  contains?: string;
  since?: Date | string;
  /** Seconds to wait (default 30). Waits longer than two minutes are split into several polls. */
  timeout?: number;
  signal?: AbortSignal;
};

export type MessageRef = string | { id: string };
export type LinkPattern = RegExp | string;

const env = (name: string) => (typeof process !== "undefined" ? process.env?.[name] : undefined);
const idOf = (m: MessageRef) => (typeof m === "string" ? m : m.id);
const enc = encodeURIComponent;

/**
 * Client for the Testlie API.
 *
 *   const testlie = new Testlie();                        // TESTLIE_API_KEY, TESTLIE_URL
 *   await testlie.withInbox(async (inbox) => {
 *     await signUp(inboxAddress(inbox, "alice"));
 *     const email = await testlie.waitForEmail({ inboxId: inbox.id, subject: "Confirm" });
 *     const code = await testlie.extractOtp(email);
 *   });
 */
export class Testlie {
  readonly baseUrl: string;
  readonly inboxes: Inboxes;
  readonly messages: Messages;
  readonly webhooks: Webhooks;
  readonly idps: Idps;
  readonly push: Push;
  readonly scenarios: Scenarios;
  /** @internal */
  readonly http: Http;

  constructor(opts: TestlieOptions = {}) {
    const apiKey = opts.apiKey ?? env("TESTLIE_API_KEY");
    if (!apiKey) throw new TestlieError("No API key: pass { apiKey } or set TESTLIE_API_KEY", { status: 0, code: "missing_api_key" });
    this.baseUrl = (opts.baseUrl ?? env("TESTLIE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new TestlieError("No global fetch: use Node 18 or later, or pass { fetch }", { status: 0, code: "no_fetch" });
    this.http = new Http({
      apiKey,
      baseUrl: this.baseUrl,
      maxRetries: opts.maxRetries ?? 3,
      timeoutMs: opts.timeoutMs ?? 30_000,
      fetch: f.bind(globalThis),
      userAgent: `testlie-node/${VERSION}`,
    });
    this.inboxes = new Inboxes(this.http);
    this.messages = new Messages(this.http);
    this.webhooks = new Webhooks(this.http);
    this.idps = new Idps(this.http);
    this.push = new Push(this.http);
    this.scenarios = new Scenarios(this.http);
  }

  /** Waits for a matching push notification (with extracted codes and links). Same as push.waitFor. */
  async waitForPush(opts: PushWaitOptions): Promise<PushNotification> {
    return this.push.waitFor(opts);
  }

  /** Waits for a matching email and returns the full message (HTML, text, headers, attachments). */
  async waitForEmail(opts: WaitOptions): Promise<Message> {
    const summary = await this.messages.waitFor(opts);
    return this.messages.get(summary.id);
  }

  /** The most likely one-time code in a message. Throws TestlieExtractError when there is none. */
  async extractOtp(message: MessageRef): Promise<string> {
    const x = await this.messages.extract(message);
    const code = x.codes[0]?.value;
    if (!code) throw new TestlieExtractError(`No one-time code found in message ${x.messageId} ("${x.subject}")`);
    return code;
  }

  /**
   * A link from a message. Without a pattern, the most likely magic link (verify, reset, sign
   * in...). With one, the first magic link, then any link, whose URL or text matches: a RegExp,
   * or a string matched case-insensitively as a substring. Throws TestlieExtractError when none match.
   */
  async extractLink(message: MessageRef, pattern?: LinkPattern): Promise<string> {
    const x = await this.messages.extract(message);
    const link = pickLink(x, pattern);
    if (!link) {
      const what = pattern === undefined ? "No magic link" : `No link matching ${String(pattern)}`;
      throw new TestlieExtractError(`${what} found in message ${x.messageId} ("${x.subject}")`);
    }
    return link.url;
  }

  /**
   * Runs `fn` with a fresh disposable inbox and deletes the inbox afterwards, even when `fn`
   * throws. If deletion fails the inbox still expires on its own after `minutes`.
   */
  async withInbox<T>(fn: (inbox: Inbox) => Promise<T> | T, opts: { minutes?: number; name?: string; maxMessages?: number } = {}): Promise<T> {
    const inbox = await this.inboxes.create({ name: opts.name, maxMessages: opts.maxMessages, disposable: { minutes: opts.minutes ?? 30 } });
    try {
      return await fn(inbox);
    } finally {
      await this.inboxes.delete(inbox.id).catch((err) => {
        if (!(err instanceof TestlieError && err.isNotFound)) throw err;
      });
    }
  }
}

/** Picks a link from an extraction, as described on Testlie.extractLink. */
export function pickLink(x: Pick<Extraction, "links" | "magicLinks">, pattern?: LinkPattern): ExtractedLink | null {
  if (pattern === undefined) return x.magicLinks[0] ?? null;
  const test =
    typeof pattern === "string"
      ? (s: string) => s.toLowerCase().includes(pattern.toLowerCase())
      : (s: string) => {
          pattern.lastIndex = 0;
          return pattern.test(s);
        };
  return [...x.magicLinks, ...x.links].find((l) => test(l.url) || test(l.text)) ?? null;
}

export class Inboxes {
  constructor(private http: Http) {}

  async list(): Promise<Inbox[]> {
    return (await this.http.request<{ inboxes: Inbox[] }>("/api/inboxes")).inboxes;
  }

  async create(opts: CreateInboxOptions = {}): Promise<Inbox> {
    const minutes = opts.disposable === true ? 30 : opts.disposable ? opts.disposable.minutes : undefined;
    const name = opts.name ?? (minutes ? `disposable-${new Date().toISOString().slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}` : "SDK inbox");
    const body = { name, maxMessages: opts.maxMessages, projectId: opts.projectId, expiresInMinutes: minutes };
    return (await this.http.request<{ inbox: Inbox }>("/api/inboxes", { method: "POST", body })).inbox;
  }

  async get(id: string): Promise<Inbox> {
    return (await this.http.request<{ inbox: Inbox }>(`/api/inboxes/${enc(id)}`)).inbox;
  }

  async update(id: string, patch: { name?: string; maxMessages?: number; projectId?: string | null }): Promise<Inbox> {
    return (await this.http.request<{ inbox: Inbox }>(`/api/inboxes/${enc(id)}`, { method: "PATCH", body: patch })).inbox;
  }

  async delete(id: string): Promise<void> {
    await this.http.request(`/api/inboxes/${enc(id)}`, { method: "DELETE" });
  }

  /** Deletes every message in the inbox. */
  async clear(id: string): Promise<{ deleted: number }> {
    return this.http.request(`/api/inboxes/${enc(id)}/messages`, { method: "DELETE" });
  }

  /** Marks every message in the inbox read. */
  async markAllRead(id: string): Promise<{ updated: number }> {
    return this.http.request(`/api/inboxes/${enc(id)}/messages`, { method: "PATCH" });
  }

  /** New SMTP password; the username stays the same. */
  async rotateCredentials(id: string): Promise<Inbox> {
    return (await this.http.request<{ inbox: Inbox }>(`/api/inboxes/${enc(id)}/credentials`, { method: "POST" })).inbox;
  }
}

export class Messages {
  constructor(private http: Http) {}

  async list(inboxId: string, opts: { q?: string; unread?: boolean; page?: number; limit?: number } = {}): Promise<MessageList> {
    return this.http.request(`/api/inboxes/${enc(inboxId)}/messages`, {
      query: { q: opts.q, unread: opts.unread ? "true" : undefined, page: opts.page, limit: opts.limit },
    });
  }

  async get(message: MessageRef): Promise<Message> {
    return (await this.http.request<{ message: Message }>(`/api/messages/${enc(idOf(message))}`)).message;
  }

  /** The original MIME source. */
  async raw(message: MessageRef): Promise<string> {
    return this.http.request(`/api/messages/${enc(idOf(message))}/raw`, { as: "text" });
  }

  /** The HTML body (or the text body wrapped in <pre> when there is no HTML), with cid: images inlined. */
  async html(message: MessageRef): Promise<string> {
    return this.http.request(`/api/messages/${enc(idOf(message))}/html`, { as: "text" });
  }

  /** Attachment metadata. */
  async attachments(message: MessageRef) {
    return (await this.get(message)).attachments;
  }

  /** Downloads one attachment's bytes. */
  async attachment(message: MessageRef, attachmentId: string): Promise<Uint8Array> {
    return this.http.request(`/api/messages/${enc(idOf(message))}/attachments/${enc(attachmentId)}`, { as: "bytes" });
  }

  async delete(message: MessageRef): Promise<void> {
    await this.http.request(`/api/messages/${enc(idOf(message))}`, { method: "DELETE" });
  }

  async markRead(message: MessageRef, isRead = true): Promise<void> {
    await this.http.request(`/api/messages/${enc(idOf(message))}`, { method: "PATCH", body: { isRead } });
  }

  /** Forwards the original message to real addresses (needs outbound SMTP on the server). */
  async forward(message: MessageRef, to: string | string[]) {
    return this.http.request<{ forwarded: boolean; to: string[]; accepted: string[]; rejected: string[] }>(
      `/api/messages/${enc(idOf(message))}/forward`,
      { method: "POST", body: { to: Array.isArray(to) ? to : [to] } },
    );
  }

  /**
   * Spam score and inbox-placement report: SpamAssassin (when the server has it), Testlie
   * heuristics, fix hints and the Gmail/Yahoo bulk-sender checklist. `refresh` re-analyses.
   */
  async spamReport(message: MessageRef, opts: { refresh?: boolean } = {}): Promise<SpamReport> {
    return (await this.http.request<{ report: SpamReport }>(`/api/messages/${enc(idOf(message))}/spam`, { query: { refresh: opts.refresh ? "1" : undefined } })).report;
  }

  /** Links, likely one-time codes and magic links, best first. */
  async extract(message: MessageRef): Promise<Extraction> {
    return this.http.request(`/api/messages/${enc(idOf(message))}/extract`);
  }

  /**
   * Long-polls until a matching message arrives and returns its summary (use get() or
   * Testlie.waitForEmail for the body). Throws TestlieTimeoutError after `timeout` seconds.
   */
  async waitFor(opts: WaitOptions): Promise<MessageSummary> {
    const total = opts.timeout ?? 30;
    const deadline = Date.now() + total * 1000;
    const path = `/api/inboxes/${enc(opts.inboxId)}/messages/wait`;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const chunk = Math.max(1, Math.min(MAX_POLL_SECONDS, left));
      const started = Date.now();
      const res = await this.http.request<{ status: number; body: { message: MessageSummary } }>(path, {
        query: { to: opts.to?.toLowerCase(), subject: opts.subject, since: opts.since, timeout: chunk },
        signal: opts.signal,
        extraTimeoutMs: chunk * 1000,
        okStatuses: [200, 408],
      });
      if (res.status === 200) return res.body.message;
      if (Date.now() >= deadline - 500) break;
      // A proxy that cuts long-polls short should not turn this into a busy loop.
      if (Date.now() - started < 1000) await new Promise((r) => setTimeout(r, 1000));
    }
    const filters = [opts.to && `to ${opts.to}`, opts.subject && `subject containing "${opts.subject}"`].filter(Boolean).join(", ");
    throw new TestlieTimeoutError(`No email${filters ? ` (${filters})` : ""} arrived in inbox ${opts.inboxId} within ${total}s`, {
      method: "GET",
      path,
    });
  }
}

export type WebhookInput = { url: string; inboxId?: string | null; events?: WebhookEvent[]; enabled?: boolean };

export class Webhooks {
  constructor(private http: Http) {}

  /** `inboxId: "team"` lists only the team-wide webhooks. */
  async list(opts: { inboxId?: string } = {}): Promise<Webhook[]> {
    return (await this.http.request<{ webhooks: Webhook[] }>("/api/webhooks", { query: { inboxId: opts.inboxId } })).webhooks;
  }

  async create(input: WebhookInput): Promise<Webhook> {
    return (await this.http.request<{ webhook: Webhook }>("/api/webhooks", { method: "POST", body: input })).webhook;
  }

  async update(id: string, patch: Partial<WebhookInput> & { rotateSecret?: boolean }): Promise<Webhook> {
    return (await this.http.request<{ webhook: Webhook }>(`/api/webhooks/${enc(id)}`, { method: "PATCH", body: patch })).webhook;
  }

  async delete(id: string): Promise<void> {
    await this.http.request(`/api/webhooks/${enc(id)}`, { method: "DELETE" });
  }

  /** Sends a test delivery and returns its result. */
  async test(id: string): Promise<{ result: unknown; webhook: Webhook }> {
    return this.http.request(`/api/webhooks/${enc(id)}/test`, { method: "POST" });
  }

  async deliveries(id: string, opts: { limit?: number } = {}): Promise<unknown[]> {
    return (await this.http.request<{ deliveries: unknown[] }>(`/api/webhooks/${enc(id)}/deliveries`, { query: { limit: opts.limit } })).deliveries;
  }

  async redeliver(id: string, deliveryId: string): Promise<unknown> {
    return (await this.http.request<{ delivery: unknown }>(`/api/webhooks/${enc(id)}/deliveries/${enc(deliveryId)}`, { method: "POST" })).delivery;
  }
}

export type IdpPatch = Partial<{
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  tokenTtl: number;
  autoLoginUserId: string | null;
  requireTeamSession: boolean;
  samlSpEntityId: string | null;
  samlAcsUrl: string | null;
  samlNameIdFormat: string;
}>;
export type IdpUserInput = { email: string; name: string; subject?: string; groups?: string[]; claims?: Record<string, unknown> };

export class IdpUsers {
  constructor(private http: Http) {}

  async list(idpId: string): Promise<IdpUser[]> {
    return (await this.http.request<{ users: IdpUser[] }>(`/api/idps/${enc(idpId)}/users`)).users;
  }

  async create(idpId: string, user: IdpUserInput): Promise<IdpUser> {
    return (await this.http.request<{ user: IdpUser }>(`/api/idps/${enc(idpId)}/users`, { method: "POST", body: user })).user;
  }

  async update(idpId: string, userId: string, patch: Partial<IdpUserInput>): Promise<IdpUser> {
    return (await this.http.request<{ user: IdpUser }>(`/api/idps/${enc(idpId)}/users/${enc(userId)}`, { method: "PATCH", body: patch })).user;
  }

  async delete(idpId: string, userId: string): Promise<void> {
    await this.http.request(`/api/idps/${enc(idpId)}/users/${enc(userId)}`, { method: "DELETE" });
  }
}

export class Idps {
  readonly users: IdpUsers;
  constructor(private http: Http) {
    this.users = new IdpUsers(http);
  }

  async list(): Promise<Idp[]> {
    return (await this.http.request<{ idps: Idp[] }>("/api/idps")).idps;
  }

  async create(input: { name: string; redirectUris?: string[] }): Promise<Idp> {
    return (await this.http.request<{ idp: Idp }>("/api/idps", { method: "POST", body: input })).idp;
  }

  async get(id: string): Promise<Idp> {
    return (await this.http.request<{ idp: Idp }>(`/api/idps/${enc(id)}`)).idp;
  }

  async update(id: string, patch: IdpPatch): Promise<Idp> {
    return (await this.http.request<{ idp: Idp }>(`/api/idps/${enc(id)}`, { method: "PATCH", body: patch })).idp;
  }

  async delete(id: string): Promise<void> {
    await this.http.request(`/api/idps/${enc(id)}`, { method: "DELETE" });
  }

  /** Rotates the client secret or the signing key; the old one stops working at once. */
  async rotate(id: string, what: "secret" | "keys"): Promise<Idp> {
    return (await this.http.request<{ idp: Idp }>(`/api/idps/${enc(id)}/rotate`, { method: "POST", body: { what } })).idp;
  }

  /** Activity log, newest first. */
  async events(id: string, opts: { after?: string; limit?: number } = {}): Promise<unknown[]> {
    return (await this.http.request<{ events: unknown[] }>(`/api/idps/${enc(id)}/events`, { query: opts })).events;
  }

  async clearEvents(id: string): Promise<void> {
    await this.http.request(`/api/idps/${enc(id)}/events`, { method: "DELETE" });
  }
}

/** The push notification sandbox: captured APNs / FCM notifications and test devices. */
export class Push {
  constructor(private http: Http) {}

  async list(pushInboxId: string, opts: { service?: PushService; token?: string; topic?: string; q?: string; page?: number; limit?: number } = {}) {
    return this.http.request<{ total: number; page: number; limit: number; notifications: PushNotification[] }>(
      `/api/push-inboxes/${enc(pushInboxId)}/notifications`,
      { query: opts },
    );
  }

  /** One notification, with extracted codes and links. */
  async get(id: string): Promise<PushNotification> {
    return (await this.http.request<{ notification: PushNotification }>(`/api/push/${enc(id)}`)).notification;
  }

  async clear(pushInboxId: string): Promise<{ deleted: number }> {
    return this.http.request(`/api/push-inboxes/${enc(pushInboxId)}/notifications`, { method: "DELETE" });
  }

  /** Registers (or updates) a test device token and the outcome sends to it simulate. */
  async registerDevice(
    pushInboxId: string,
    device: { platform: PushService; token: string; label?: string; topic?: string | null; outcome?: PushDevice["outcome"] },
  ): Promise<PushDevice> {
    return (await this.http.request<{ device: PushDevice }>(`/api/push-inboxes/${enc(pushInboxId)}/devices`, { method: "POST", body: device })).device;
  }

  /**
   * Long-polls until a matching notification arrives and returns it with extracted codes and
   * links. Throws TestlieTimeoutError after `timeout` seconds.
   */
  async waitFor(opts: PushWaitOptions): Promise<PushNotification> {
    const total = opts.timeout ?? 30;
    const deadline = Date.now() + total * 1000;
    const path = `/api/push-inboxes/${enc(opts.pushInboxId)}/notifications/wait`;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const chunk = Math.max(1, Math.min(MAX_POLL_SECONDS, left));
      const started = Date.now();
      const res = await this.http.request<{ status: number; body: { notification: PushNotification } }>(path, {
        query: { token: opts.token, topic: opts.topic, service: opts.service, contains: opts.contains, since: opts.since, timeout: chunk },
        signal: opts.signal,
        extraTimeoutMs: chunk * 1000,
        okStatuses: [200, 408],
      });
      if (res.status === 200) return res.body.notification;
      if (Date.now() >= deadline - 500) break;
      if (Date.now() - started < 1000) await new Promise((r) => setTimeout(r, 1000));
    }
    const filters = [opts.token && `token ${opts.token}`, opts.topic && `topic ${opts.topic}`, opts.contains && `containing "${opts.contains}"`]
      .filter(Boolean)
      .join(", ");
    throw new TestlieTimeoutError(`No push notification${filters ? ` (${filters})` : ""} arrived in push inbox ${opts.pushInboxId} within ${total}s`, {
      method: "GET",
      path,
    });
  }
}

export type SpamReport = {
  engine: "spamassassin" | "builtin";
  score: number;
  threshold: number;
  verdict: "ok" | "warn" | "spam";
  rules: { name: string; score: number; description: string; source: string; category: string; hint: string | null }[];
  placement: { verdict: "inbox" | "at_risk" | "spam"; summary: string; reasons: string[] };
  checklist: { id: string; title: string; appliesTo: "all" | "bulk"; status: string; detail: string; fix: string | null }[];
  [key: string]: unknown;
};

export type ScenarioActivation = {
  id: string;
  presetId: string;
  name: string;
  projectId: string | null;
  scope: "team" | "project";
  params: Record<string, string | number>;
  activatedAt: string;
  expiresAt: string | null;
};
export type ScenarioOptions = {
  /** Only resources in this project (default: the whole team). */
  projectId?: string | null;
  /** Preset parameters, e.g. { mode: "tempfail", failCount: 2 }. */
  params?: Record<string, string | number>;
  /** Minutes until it switches itself off (default 60); null keeps it on until deactivated. */
  durationMinutes?: number | null;
};

/** Failure-injection scenarios (outages, slow SMTP, flaky IdP tokens, SMS carrier failures...). */
export class Scenarios {
  constructor(private http: Http) {}

  async list(): Promise<{ presets: { id: string; name: string; summary: string; params: unknown[] }[]; active: ScenarioActivation[] }> {
    return this.http.request("/api/scenarios");
  }

  async activate(presetId: string, opts: ScenarioOptions = {}): Promise<{ activation: ScenarioActivation; warnings: string[] }> {
    return this.http.request(`/api/scenarios/${enc(presetId)}/activate`, { method: "POST", body: opts });
  }

  /** Without projectId every scope of the preset is switched off; presetId "all" switches off everything. */
  async deactivate(presetId: string, opts: { projectId?: string | null } = {}): Promise<{ deactivated: number }> {
    return this.http.request(`/api/scenarios/${enc(presetId)}/deactivate`, { method: "POST", body: opts });
  }

  /** Runs `fn` with the scenario active and always switches it off afterwards. */
  async with<T>(presetId: string, opts: ScenarioOptions, fn: () => Promise<T>): Promise<T> {
    await this.activate(presetId, opts);
    try {
      return await fn();
    } finally {
      await this.deactivate(presetId, { projectId: opts.projectId ?? null });
    }
  }
}
