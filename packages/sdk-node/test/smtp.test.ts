import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildMessage, sendMail } from "../src/smtp.js";

// smtp-server is not a dependency of the SDK; these tests run when it can be resolved (as in the
// Testlie repo, from the root node_modules) and are skipped elsewhere. It ships a self-signed
// certificate, which is enough to exercise STARTTLS.
type Received = { user?: string; from: string; to: string[]; raw: string; secure: boolean };
const mod = (await import("smtp-server" as string).catch(() => null)) as { SMTPServer: new (o: object) => any } | null;

describe.skipIf(!mod)("smtp client", () => {
  const received: Received[] = [];
  let server: any;
  let port = 0;

  beforeAll(async () => {
    server = new mod!.SMTPServer({
      authMethods: ["PLAIN", "LOGIN"],
      onAuth(auth: { username: string; password: string }, _s: unknown, cb: (e: Error | null, r?: object) => void) {
        if (auth.username === "user" && auth.password === "secret") cb(null, { user: "user" });
        else cb(new Error("Invalid login"));
      },
      onData(stream: NodeJS.ReadableStream, session: any, cb: () => void) {
        let raw = "";
        stream.on("data", (c: Buffer) => (raw += c.toString()));
        stream.on("end", () => {
          received.push({ user: session.user, from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map((r: any) => r.address), raw, secure: session.secure });
          cb();
        });
      },
      logger: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(r)));

  it("upgrades with STARTTLS, authenticates and delivers a dot-stuffed message", async () => {
    const data = buildMessage({ from: "a@x.test", to: ["b@y.test"], subject: "Héllo", text: "line\n.starts with a dot\nend", html: "<p>hi</p>" });
    await sendMail({ host: "127.0.0.1", port, username: "user", password: "secret", rejectUnauthorized: false, from: "a@x.test", to: ["b@y.test"], data });
    const got = received.at(-1)!;
    expect(got).toMatchObject({ user: "user", from: "a@x.test", to: ["b@y.test"], secure: true });
    expect(got.raw).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(got.raw).toMatch(/multipart\/alternative/);
    const text = Buffer.from(got.raw.split("text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0], "base64").toString();
    expect(text).toBe("line\n.starts with a dot\nend");
  });

  it("refuses an untrusted certificate by default and reports bad credentials", async () => {
    const data = buildMessage({ from: "a@x.test", to: ["b@y.test"], subject: "x", text: "x" });
    await expect(sendMail({ host: "127.0.0.1", port, username: "user", password: "secret", from: "a@x.test", to: ["b@y.test"], data })).rejects.toThrow(
      /certificate/i,
    );
    await expect(
      sendMail({ host: "127.0.0.1", port, username: "user", password: "wrong", rejectUnauthorized: false, from: "a@x.test", to: ["b@y.test"], data }),
    ).rejects.toThrow(/AUTH failed: 535/);
  });
});
