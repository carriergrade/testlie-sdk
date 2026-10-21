import type { Inbox } from "./types.js";

/** Lower-cases a tag and keeps it to characters every mail system accepts in a local part. */
export function cleanTag(tag: string) {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48);
}

/**
 * An address that lands in this inbox, optionally with a `+tag` so each test (or each user a
 * test signs up) gets its own recipient to wait for.
 *
 * With an inbound domain this is `<alias>+<tag>@<domain>`, which reaches the inbox over plain
 * SMTP or real MX delivery. Without one, only SMTP-authenticated mail reaches the inbox and any
 * recipient works, so a reserved `example.com` address is used (it never routes anywhere real).
 */
export function inboxAddress(inbox: Pick<Inbox, "inboundAddress" | "emailAlias">, tag?: string, opts: { unique?: boolean; domain?: string } = {}) {
  let t = tag ? cleanTag(tag) : "";
  if (opts.unique) t = [t, Date.now().toString(36) + Math.random().toString(36).slice(2, 6)].filter(Boolean).join("-");
  const suffix = t ? `+${t}` : "";
  if (inbox.inboundAddress && !opts.domain) {
    const at = inbox.inboundAddress.lastIndexOf("@");
    return `${inbox.inboundAddress.slice(0, at)}${suffix}${inbox.inboundAddress.slice(at)}`;
  }
  return `${inbox.emailAlias}${suffix}@${opts.domain ?? "example.com"}`;
}
