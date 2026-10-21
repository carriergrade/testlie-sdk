#!/usr/bin/env node
/**
 * `testlie` command line: inboxes, waiting for email and extracting codes and links from shell
 * scripts and CI. Reads TESTLIE_API_KEY and TESTLIE_URL (and TESTLIE_INBOX for --inbox).
 *
 * Exit codes: 0 success, 1 timeout or nothing found, 2 usage error, 3 API or network error.
 */
import { randomInt, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { Testlie, pickLink, VERSION, DEFAULT_BASE_URL } from "./client.js";
import { TestlieError, TestlieTimeoutError } from "./errors.js";
import { inboxAddress } from "./address.js";
import { buildMessage, sendMail } from "./smtp.js";
import type { Inbox, MessageSummary } from "./types.js";

export const EXIT = { ok: 0, notFound: 1, usage: 2, api: 3 } as const;

class UsageError extends Error {}
class NotFoundError extends Error {}

type Io = { out: (s: string) => void; err: (s: string) => void; env: Record<string, string | undefined>; fetch?: typeof fetch };

// ---------------------------------------------------------------------------------------------
// Argument parsing

/** Flags that never take a value. */
const BOOLEAN = new Set(["json", "raw", "html", "text", "otp", "help", "unread", "insecure", "version", "quiet"]);
/** Flags whose value is optional (`--link` alone means "the best magic link"). */
const OPTIONAL_VALUE = new Set(["link", "disposable"]);

export type Parsed = { positionals: string[]; flags: Record<string, string | true> };

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) flags[name] = a.slice(eq + 1);
    else if (BOOLEAN.has(name)) flags[name] = true;
    else {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        if (OPTIONAL_VALUE.has(name)) flags[name] = true;
        else throw new UsageError(`--${name} needs a value`);
      } else {
        flags[name] = next;
        i++;
      }
    }
  }
  return { positionals, flags };
}

/** ISO time, `now`, or a duration ago such as `10m`, `90s`, `2h`. */
export function parseSince(v: string, now = Date.now()): string {
  if (v === "now") return new Date(now).toISOString();
  const rel = v.match(/^-?(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (rel) {
    const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "ms"];
    return new Date(now - Number(rel[1]) * unit).toISOString();
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new UsageError(`--since must be an ISO time, "now" or a duration like 5m (got "${v}")`);
  return new Date(t).toISOString();
}

const str = (f: Parsed["flags"], k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
function int(f: Parsed["flags"], k: string, def?: number) {
  const v = f[k];
  if (v === undefined || v === true) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${k} must be a whole number (got "${v}")`);
  return n;
}

// ---------------------------------------------------------------------------------------------
// Help

const HELP: Record<string, string> = {
  main: `testlie ${VERSION}: email testing from the command line

Usage: testlie <command> [options]

Commands:
  inboxes list                  List the team's inboxes
  inboxes create                Create an inbox (--disposable for one that deletes itself)
  inboxes get ID | delete ID    Show or delete an inbox
  wait --inbox ID               Wait for an email (exit 1 on timeout)
  messages list --inbox ID      List messages, newest first
  messages get ID               Show a message (--raw for MIME, --html for the HTML body)
  extract ID                    Codes and links in a message (--otp, --link PATTERN)
  send-test --inbox ID          Send a sample email to the inbox over SMTP
  scenario list | activate ID | deactivate ID | off   Failure-injection scenarios

Global options:
  --json         Machine-readable output
  --help, -h     Help for a command
  --version      Print the version

Environment:
  TESTLIE_API_KEY   Team API key (required)
  TESTLIE_URL       API base URL (default ${DEFAULT_BASE_URL})
  TESTLIE_INBOX     Default for --inbox

Exit codes: 0 ok, 1 timeout or nothing found, 2 usage error, 3 API or network error.`,
  inboxes: `Usage:
  testlie inboxes list [--json]
  testlie inboxes create [--name NAME] [--disposable [MINUTES]] [--max-messages N] [--json]
  testlie inboxes get ID [--json]
  testlie inboxes delete ID

--disposable makes an inbox that is deleted with its messages after MINUTES (default 30).
create prints the inbox ID, an address and the SMTP settings; with --json, the full inbox.`,
  wait: `Usage: testlie wait --inbox ID [--to ADDRESS] [--subject TEXT] [--since TIME] [--timeout 60] [--json | --otp | --link [PATTERN]]

Waits until a matching email is in the inbox and prints its ID and subject.
  --to        Exact recipient (envelope), case-insensitive
  --subject   Text the subject contains, case-insensitive
  --since     Only mail received after TIME: ISO time, "now", or a duration ago like 5m
  --timeout   Seconds to wait (default 60)
  --json      Print the full message as JSON
  --otp       Print only the one-time code (exit 1 if there is none)
  --link      Print only the best magic link, or the first link matching PATTERN (a regex)

Exits with 1 when nothing arrives in time.`,
  messages: `Usage:
  testlie messages list --inbox ID [--limit 20] [--unread] [--json]
  testlie messages get ID [--raw | --html | --text]

get prints the message as JSON; --raw the original MIME, --html the HTML body, --text the text body.`,
  extract: `Usage: testlie extract ID [--otp | --link [PATTERN]] [--json]

Without options, prints the codes, magic links and links found in the message.
  --otp       Print only the most likely one-time code (exit 1 if there is none)
  --link      Print only the best magic link, or the first link whose URL or text matches PATTERN (a regex)
  --json      Print the full extraction as JSON`,
  scenario: `Usage:
  testlie scenario list [--json]
  testlie scenario activate ID [--param KEY=VALUE[,KEY=VALUE]] [--project ID] [--minutes N | --minutes never] [--json]
  testlie scenario deactivate ID [--project ID]
  testlie scenario off

Presets: email-provider-outage, slow-smtp, idp-outage, idp-flaky-tokens, sms-carrier-failures,
webhook-receiver-down. "off" switches every scenario of the team off. Needs a write API key.`,
  "send-test": `Usage: testlie send-test --inbox ID [--to ADDRESS] [--subject TEXT] [--from ADDRESS] [--host HOST] [--port PORT] [--insecure]

Sends a sample verification email (with a one-time code and a magic link) to the inbox using its
SMTP credentials, so you can try wait and extract. Uses STARTTLS when the server offers it;
--insecure skips certificate verification.`,
};

// ---------------------------------------------------------------------------------------------
// Commands

export async function main(argv: string[], io: Io): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    io.err(`testlie: ${(err as Error).message}\nRun "testlie --help" for usage.`);
    return EXIT.usage;
  }
  const { positionals: pos, flags } = parsed;
  const [cmd, sub] = pos;
  if (flags.version) {
    io.out(VERSION);
    return EXIT.ok;
  }
  if (!cmd || cmd === "help" || (flags.help && !HELP[cmd])) {
    io.out(HELP[cmd === "help" && sub && HELP[sub] ? sub : "main"]);
    return cmd || flags.help ? EXIT.ok : EXIT.usage;
  }
  if (flags.help) {
    io.out(HELP[cmd]);
    return EXIT.ok;
  }

  try {
    const client = () => new Testlie({ apiKey: io.env.TESTLIE_API_KEY, baseUrl: io.env.TESTLIE_URL, fetch: io.fetch });
    const inboxFlag = () => {
      const id = str(flags, "inbox") ?? io.env.TESTLIE_INBOX;
      if (!id) throw new UsageError("--inbox ID is required (or set TESTLIE_INBOX)");
      return id;
    };
    const idArg = (i: number, what: string) => {
      const id = pos[i];
      if (!id) throw new UsageError(`${what} ID is required`);
      return id;
    };
    const json = (v: unknown) => io.out(JSON.stringify(v, null, 2));

    switch (cmd) {
      case "inboxes": {
        const t = client();
        if (sub === "list" || sub === undefined) {
          const inboxes = await t.inboxes.list();
          if (flags.json) json(inboxes);
          else io.out(table(["ID", "NAME", "MESSAGES", "EXPIRES", "ADDRESS"], inboxes.map((i) => [i.id, i.name, String(i.messageCount ?? ""), i.expiresAt ?? "-", inboxAddress(i)])));
          return EXIT.ok;
        }
        if (sub === "create") {
          const d = flags.disposable;
          const minutes = d === undefined ? undefined : d === true ? 30 : Number(d);
          if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1)) throw new UsageError("--disposable takes minutes, e.g. --disposable 30");
          const inbox = await t.inboxes.create({ name: str(flags, "name"), maxMessages: int(flags, "max-messages"), disposable: minutes ? { minutes } : undefined });
          if (flags.json) json(inbox);
          else io.out(describeInbox(inbox));
          return EXIT.ok;
        }
        if (sub === "get") {
          const inbox = await t.inboxes.get(idArg(2, "Inbox"));
          if (flags.json) json(inbox);
          else io.out(describeInbox(inbox));
          return EXIT.ok;
        }
        if (sub === "delete") {
          const id = idArg(2, "Inbox");
          await t.inboxes.delete(id);
          if (!flags.quiet) io.err(`Deleted inbox ${id}`);
          return EXIT.ok;
        }
        throw new UsageError(`Unknown command "inboxes ${sub}"`);
      }

      case "wait": {
        const inboxId = inboxFlag();
        const timeout = int(flags, "timeout", 60)!;
        const since = str(flags, "since");
        const t = client();
        const summary = await t.messages.waitFor({ inboxId, to: str(flags, "to"), subject: str(flags, "subject"), since: since ? parseSince(since) : undefined, timeout });
        if (flags.otp) return printOtp(io, await t.messages.extract(summary.id));
        if (flags.link !== undefined) return printLink(io, await t.messages.extract(summary.id), flags.link);
        if (flags.json) json(await t.messages.get(summary.id));
        else io.out(`${summary.id}\t${summary.subject}`);
        return EXIT.ok;
      }

      case "messages": {
        const t = client();
        if (sub === "list" || sub === undefined) {
          const list = await t.messages.list(inboxFlag(), { limit: int(flags, "limit", 20), unread: !!flags.unread });
          if (flags.json) json(list);
          else io.out(table(["ID", "RECEIVED", "FROM", "TO", "SUBJECT"], list.messages.map(summaryRow)));
          return EXIT.ok;
        }
        if (sub === "get") {
          const id = idArg(2, "Message");
          if (flags.raw) {
            const raw = await t.messages.raw(id);
            io.out(raw.replace(/\r?\n$/, ""));
            return EXIT.ok;
          }
          const m = await t.messages.get(id);
          if (flags.html || flags.text) {
            const body = flags.html ? m.html : m.text;
            if (body == null) throw new NotFoundError(`Message ${id} has no ${flags.html ? "HTML" : "text"} body`);
            io.out(body);
          } else json(m);
          return EXIT.ok;
        }
        throw new UsageError(`Unknown command "messages ${sub}"`);
      }

      case "extract": {
        const x = await client().messages.extract(idArg(1, "Message"));
        if (flags.otp) return printOtp(io, x);
        if (flags.link !== undefined) return printLink(io, x, flags.link);
        if (flags.json) json(x);
        else {
          const lines = [`Codes:${x.codes.length ? "" : " none"}`, ...x.codes.map((c) => `  ${c.value}  (${c.context})`)];
          lines.push(`Magic links:${x.magicLinks.length ? "" : " none"}`, ...x.magicLinks.map((l) => `  ${l.url}  [${l.reason}]`));
          lines.push(`Links:${x.links.length ? "" : " none"}`, ...x.links.map((l) => `  ${l.url}${l.text ? `  "${l.text}"` : ""}`));
          io.out(lines.join("\n"));
        }
        return EXIT.ok;
      }

      case "send-test": {
        const t = client();
        const inbox = await t.inboxes.get(inboxFlag());
        const to = str(flags, "to") ?? inboxAddress(inbox, "send-test");
        const from = str(flags, "from") ?? "Testlie CLI <cli@example.com>";
        const code = String(randomInt(100_000, 1_000_000));
        const link = `${t.baseUrl}/verify?token=${randomBytes(16).toString("hex")}`;
        const subject = str(flags, "subject") ?? `Your verification code is ${code}`;
        const text = `Hello,\n\nYour verification code is ${code}. It expires in 10 minutes.\n\nOr confirm your email: ${link}\n\nSent by testlie send-test.`;
        const html = `<p>Hello,</p><p>Your verification code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 10 minutes.</p><p><a href="${link}">Confirm your email</a></p><p style="color:#888">Sent by testlie send-test.</p>`;
        const ports = inbox.smtp.ports;
        const port = int(flags, "port") ?? ports.find((p) => p !== 465) ?? ports[0] ?? 587;
        const reply = await sendMail({
          host: str(flags, "host") ?? inbox.smtp.host,
          port,
          username: inbox.smtp.username,
          password: inbox.smtp.password,
          rejectUnauthorized: !flags.insecure,
          from: from.match(/<([^>]+)>/)?.[1] ?? from,
          to: [to],
          data: buildMessage({ from, to: [to], subject, text, html }),
        });
        if (flags.json) json({ to, subject, code, link, reply });
        else io.out(`Sent to ${to} (code ${code})\nWait for it with: testlie wait --inbox ${inbox.id} --to ${to} --otp`);
        return EXIT.ok;
      }

      case "scenario": {
        const t = client();
        if (sub === "list" || !sub) {
          const r = await t.scenarios.list();
          if (flags.json) json(r);
          else {
            for (const p of r.presets) io.out(`${p.id}\t${p.name}\t${r.active.some((a) => a.presetId === p.id) ? "ACTIVE" : "off"}`);
          }
          return EXIT.ok;
        }
        if (sub === "activate") {
          const id = idArg(2, "Scenario");
          const params: Record<string, string> = {};
          const raw = str(flags, "param");
          for (const kv of raw ? raw.split(",") : []) {
            const i = kv.indexOf("=");
            if (i < 1) throw new UsageError(`--param takes KEY=VALUE pairs (got "${kv}")`);
            params[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
          }
          const minutes = str(flags, "minutes");
          const durationMinutes = minutes === undefined ? undefined : minutes === "never" ? null : Number(minutes);
          if (typeof durationMinutes === "number" && (!Number.isInteger(durationMinutes) || durationMinutes < 1)) throw new UsageError("--minutes takes a whole number or never");
          const r = await t.scenarios.activate(id, { params, projectId: str(flags, "project") ?? null, durationMinutes });
          if (flags.json) json(r);
          else io.out(`Activated ${r.activation.name}${r.activation.expiresAt ? ` until ${r.activation.expiresAt}` : ""}${r.warnings.map((w) => `\nWarning: ${w}`).join("")}`);
          return EXIT.ok;
        }
        if (sub === "deactivate" || sub === "off") {
          const id = sub === "off" ? "all" : idArg(2, "Scenario");
          const project = str(flags, "project");
          const r = await t.scenarios.deactivate(id, project ? { projectId: project } : {});
          if (flags.json) json(r);
          else io.out(`Switched off ${r.deactivated} scenario${r.deactivated === 1 ? "" : "s"}`);
          return EXIT.ok;
        }
        throw new UsageError(`Unknown command "scenario ${sub}"`);
      }

      default:
        throw new UsageError(`Unknown command "${cmd}"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`testlie: ${err.message}\nRun "testlie ${HELP[cmd] ? `${cmd} ` : ""}--help" for usage.`);
      return EXIT.usage;
    }
    if (err instanceof TestlieTimeoutError || err instanceof NotFoundError) {
      io.err(`testlie: ${err.message}`);
      return EXIT.notFound;
    }
    if (err instanceof TestlieError) {
      io.err(`testlie: ${err.message}${err.upgradeUrl ? `\nUpgrade: ${err.upgradeUrl}` : ""}`);
      return err.code === "missing_api_key" ? EXIT.usage : EXIT.api;
    }
    io.err(`testlie: ${(err as Error).message ?? err}`);
    return EXIT.api;
  }
}

function printOtp(io: Io, x: { codes: { value: string }[]; messageId: string }) {
  const code = x.codes[0]?.value;
  if (!code) throw new NotFoundError(`No one-time code found in message ${x.messageId}`);
  io.out(code);
  return EXIT.ok;
}

function printLink(io: Io, x: Parameters<typeof pickLink>[0] & { messageId: string }, pattern: string | true) {
  let re: RegExp | undefined;
  if (pattern !== true) {
    try {
      re = new RegExp(pattern, "i");
    } catch {
      throw new UsageError(`--link PATTERN is not a valid regular expression: ${pattern}`);
    }
  }
  const link = pickLink(x, re);
  if (!link) throw new NotFoundError(`No ${re ? `link matching /${pattern}/` : "magic link"} found in message ${x.messageId}`);
  io.out(link.url);
  return EXIT.ok;
}

function describeInbox(i: Inbox) {
  return [
    `ID:        ${i.id}`,
    `Name:      ${i.name}`,
    `Address:   ${inboxAddress(i)}`,
    ...(i.expiresAt ? [`Expires:   ${i.expiresAt}`] : []),
    `SMTP host: ${i.smtp.host}`,
    `SMTP port: ${i.smtp.ports.join(", ")}${i.smtp.tls ? " (STARTTLS)" : ""}`,
    `Username:  ${i.smtp.username}`,
    `Password:  ${i.smtp.password}`,
  ].join("\n");
}

const summaryRow = (m: MessageSummary) => [
  m.id,
  m.receivedAt.replace("T", " ").slice(0, 19),
  m.from.address ?? "",
  m.envelopeTo.slice(0, 2).join(", ") + (m.envelopeTo.length > 2 ? ", ..." : ""),
  m.subject,
];

function table(head: string[], rows: string[][]) {
  if (!rows.length) return "(none)";
  const widths = head.map((h, i) => Math.min(48, Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))));
  const fmt = (r: string[]) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : (c.length > widths[i] ? c.slice(0, widths[i] - 1) + "…" : c).padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [fmt(head), ...rows.map(fmt)].join("\n");
}

// Run when executed directly (bin or `node dist/cli.js`), not when imported by tests.
const invoked = process.argv[1] ? safeRealpath(process.argv[1]) : "";
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  main(process.argv.slice(2), {
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    env: process.env,
  }).then((code) => {
    process.exitCode = code;
  });
}

function safeRealpath(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
