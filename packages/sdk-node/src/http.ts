import { TestlieError } from "./errors.js";

export type HttpOptions = {
  apiKey: string;
  baseUrl: string;
  /** Retries for idempotent requests on 429, 5xx and network errors. */
  maxRetries: number;
  /** Per-request timeout in ms (long-polls add their own wait on top). */
  timeoutMs: number;
  fetch: typeof fetch;
  userAgent: string;
};

export type ReqInit = {
  method?: string;
  query?: Record<string, string | number | boolean | Date | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  /** Extra time on top of timeoutMs, for long-poll requests. */
  extraTimeoutMs?: number;
  /** Return the body as text/bytes instead of JSON. */
  as?: "json" | "text" | "bytes" | "response";
  /** Statuses that are not errors; the response is returned as `{ status, body }`. */
  okStatuses?: number[];
};

const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/** Exponential backoff with jitter, honouring Retry-After (seconds or HTTP date) when sent. */
export function backoff(attempt: number, retryAfter?: string | null) {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(30_000, Math.max(0, secs * 1000));
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(30_000, Math.max(0, at - Date.now()));
  }
  const base = Math.min(8_000, 250 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export class Http {
  constructor(readonly opts: HttpOptions) {}

  url(path: string, query?: ReqInit["query"]) {
    const u = new URL(path.replace(/^\//, ""), this.opts.baseUrl.replace(/\/?$/, "/"));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, v instanceof Date ? v.toISOString() : String(v));
    }
    return u.toString();
  }

  async request<T>(path: string, init: ReqInit = {}): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const url = this.url(path, init.query);
    const retries = IDEMPOTENT.has(method) ? this.opts.maxRetries : 0;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.opts.timeoutMs + (init.extraTimeoutMs ?? 0));
      const signal = init.signal ? anySignal(init.signal, timeout) : timeout;
      let res: Response;
      try {
        res = await this.opts.fetch(url, {
          method,
          signal,
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            Accept: init.as === "text" || init.as === "bytes" ? "*/*" : "application/json",
            "User-Agent": this.opts.userAgent,
            ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
      } catch (err) {
        if (init.signal?.aborted) throw init.signal.reason ?? err;
        if (attempt < retries) {
          await sleep(backoff(attempt), init.signal);
          continue;
        }
        const timedOut = timeout.aborted;
        throw new TestlieError(
          timedOut ? `${method} ${path} timed out` : `${method} ${path} failed: ${(err as Error).message ?? err}`,
          { status: 0, code: timedOut ? "request_timeout" : "network_error", method, path, cause: err },
        );
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await res.body?.cancel().catch(() => {});
        await sleep(backoff(attempt, res.headers.get("retry-after")), init.signal);
        continue;
      }
      if (init.okStatuses?.includes(res.status)) return { status: res.status, body: await readBody(res) } as T;
      if (!res.ok) throw await this.toError(res, method, path);
      if (init.as === "response") return res as T;
      if (res.status === 204) return undefined as T;
      if (init.as === "text") return (await res.text()) as T;
      if (init.as === "bytes") return new Uint8Array(await res.arrayBuffer()) as T;
      return (await res.json()) as T;
    }
  }

  private async toError(res: Response, method: string, path: string) {
    const body = await readBody(res);
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const message = typeof obj.error === "string" ? obj.error : typeof body === "string" && body ? body.slice(0, 200) : res.statusText;
    let upgradeUrl = typeof obj.upgradeUrl === "string" ? obj.upgradeUrl : undefined;
    if (upgradeUrl?.startsWith("/")) upgradeUrl = new URL(upgradeUrl, this.opts.baseUrl).toString();
    return new TestlieError(`${message} (${res.status} on ${method} ${path})`, {
      status: res.status,
      code: typeof obj.code === "string" ? obj.code : undefined,
      upgradeUrl,
      body,
      method,
      path,
    });
  }
}

/** AbortSignal.any() only exists from Node 20.3; this works on 18. */
function anySignal(...signals: AbortSignal[]) {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
