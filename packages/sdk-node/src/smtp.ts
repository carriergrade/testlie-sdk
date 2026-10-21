import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

/**
 * A deliberately small SMTP client (EHLO, STARTTLS, AUTH PLAIN/LOGIN, one message) so the CLI's
 * `send-test` works without any dependency. For anything beyond test messages use nodemailer.
 */
export type SmtpSendOptions = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Implicit TLS (port 465). Defaults to true for 465. */
  secure?: boolean;
  /** Use STARTTLS when offered (default true). */
  startTls?: boolean;
  /** Verify the server certificate (default true). */
  rejectUnauthorized?: boolean;
  from: string;
  to: string[];
  /** A complete RFC 5322 message; see buildMessage(). */
  data: string;
  timeoutMs?: number;
};

type Reply = { code: number; lines: string[] };

class Conn {
  private buf = "";
  private waiters: ((r: Reply) => void)[] = [];
  private replies: Reply[] = [];
  private pending: string[] = [];
  private failure: Error | null = null;
  private onFail: ((e: Error) => void)[] = [];

  constructor(public socket: net.Socket) {
    this.attach(socket);
  }

  attach(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.feed(chunk));
    socket.on("error", (e) => this.fail(e));
    socket.on("close", () => this.fail(new Error("SMTP connection closed")));
  }

  detach() {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
  }

  private fail(e: Error) {
    if (this.failure) return;
    this.failure = e;
    for (const f of this.onFail.splice(0)) f(e);
  }

  private feed(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.pending.push(line);
      // "250-..." continues a multi-line reply, "250 ..." ends it.
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.pending.map((l) => l.slice(4)) };
        this.pending = [];
        const w = this.waiters.shift();
        if (w) w(reply);
        else this.replies.push(reply);
      }
    }
  }

  read(): Promise<Reply> {
    const ready = this.replies.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.onFail.push(reject);
    });
  }

  async cmd(line: string, expect: number[], label = line.split(" ")[0]): Promise<Reply> {
    this.socket.write(line + "\r\n");
    const r = await this.read();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${label} failed: ${r.code} ${r.lines.join(" ")}`);
    return r;
  }
}

/** Sends one message. Resolves with the server's final reply text (usually includes a queue id). */
export async function sendMail(o: SmtpSendOptions): Promise<string> {
  const secure = o.secure ?? o.port === 465;
  const timeout = o.timeoutMs ?? 30_000;
  const tlsOpts = { servername: net.isIP(o.host) ? undefined : o.host, rejectUnauthorized: o.rejectUnauthorized ?? true };
  const socket: net.Socket = await new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host: o.host, port: o.port, ...tlsOpts }, () => resolve(s)) : net.connect({ host: o.host, port: o.port }, () => resolve(s));
    s.once("error", reject);
    s.setTimeout(timeout, () => s.destroy(new Error(`SMTP timed out after ${timeout} ms`)));
  });
  const conn = new Conn(socket);
  try {
    const greet = await conn.read();
    if (greet.code !== 220) throw new Error(`SMTP greeting: ${greet.code} ${greet.lines.join(" ")}`);
    const me = hostname() || "localhost";
    let ehlo = await conn.cmd(`EHLO ${me}`, [250]);
    const has = (ext: string) => ehlo.lines.some((l) => l.toUpperCase().startsWith(ext));
    if (!secure && (o.startTls ?? true) && has("STARTTLS")) {
      await conn.cmd("STARTTLS", [220]);
      conn.detach();
      const upgraded: tls.TLSSocket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, ...tlsOpts }, () => resolve(t));
        t.once("error", reject);
      });
      upgraded.setTimeout(timeout, () => upgraded.destroy(new Error(`SMTP timed out after ${timeout} ms`)));
      conn.attach(upgraded);
      ehlo = await conn.cmd(`EHLO ${me}`, [250]);
    }
    if (o.username) {
      const auth = ehlo.lines.find((l) => l.toUpperCase().startsWith("AUTH")) ?? "";
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        const token = Buffer.from(`\0${o.username}\0${o.password ?? ""}`).toString("base64");
        await conn.cmd(`AUTH PLAIN ${token}`, [235], "AUTH");
      } else {
        await conn.cmd("AUTH LOGIN", [334], "AUTH");
        await conn.cmd(Buffer.from(o.username).toString("base64"), [334], "AUTH");
        await conn.cmd(Buffer.from(o.password ?? "").toString("base64"), [235], "AUTH");
      }
    }
    await conn.cmd(`MAIL FROM:<${o.from}>`, [250], "MAIL FROM");
    for (const rcpt of o.to) await conn.cmd(`RCPT TO:<${rcpt}>`, [250, 251], "RCPT TO");
    await conn.cmd("DATA", [354]);
    // Dot-stuffing: a line starting with "." gets another one, and the message ends with CRLF.CRLF.
    const body = o.data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const done = await conn.cmd(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.`, [250], "DATA");
    await conn.cmd("QUIT", [221]).catch(() => {});
    return done.lines.join(" ");
  } finally {
    conn.socket.destroy();
  }
}

/** Builds a simple multipart/alternative message with a text and an HTML part. */
export function buildMessage(m: { from: string; to: string[]; subject: string; text: string; html?: string }) {
  const boundary = `----testlie-${randomBytes(8).toString("hex")}`;
  const domain = m.from.split("@")[1]?.replace(/[>\s]/g, "") || "localhost";
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  if (!m.html) return [...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(m.text)].join("\r\n");
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(m.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(m.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
