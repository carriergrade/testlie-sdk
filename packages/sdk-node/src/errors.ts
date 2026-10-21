/** Any non-2xx answer from the Testlie API, or a network failure (status 0). */
export class TestlieError extends Error {
  override name = "TestlieError";
  /** HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  /** Machine-readable code when the API sends one (`read_only_key`, `api_key_expired`, quota codes...). */
  readonly code?: string;
  /** Where to upgrade the plan, on 402 quota errors. Absolute when the client knows its base URL. */
  readonly upgradeUrl?: string;
  /** The parsed error body, for anything not covered above (zod `issues`, quota `limit`...). */
  readonly body?: unknown;
  readonly method?: string;
  readonly path?: string;

  constructor(
    message: string,
    opts: { status: number; code?: string; upgradeUrl?: string; body?: unknown; method?: string; path?: string; cause?: unknown },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.status = opts.status;
    this.code = opts.code;
    this.upgradeUrl = opts.upgradeUrl;
    this.body = opts.body;
    this.method = opts.method;
    this.path = opts.path;
  }

  get isNotFound() {
    return this.status === 404;
  }
  get isQuota() {
    return this.status === 402;
  }
}

/** No matching email arrived before the timeout. */
export class TestlieTimeoutError extends TestlieError {
  override name = "TestlieTimeoutError";
  constructor(message: string, opts: { method?: string; path?: string } = {}) {
    super(message, { status: 408, code: "timeout", ...opts });
  }
}

/** A message had no one-time code, or no link matching the pattern. */
export class TestlieExtractError extends Error {
  override name = "TestlieExtractError";
}
