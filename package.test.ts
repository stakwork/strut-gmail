/**
 * stadeum/gmail on a strut server, the way it runs on a box: installed from
 * this directory (`file:`) into a strut started in this process from a
 * checkout of stakwork/strut (`STRUT_DIR`, default `../strut`, with its
 * install), on a LadybugDB file. Then driven as the Gmail app's page drives
 * it, and as a workflow of a person's own runs the mail steps.
 *
 * Gmail is stood in for by a fake: a real HTTP server on 127.0.0.1 that
 * answers Gmail's API and Google's revoke for made-up tokens, each its own
 * mailbox, and keeps to the rules Google's documentation gives (README,
 * "What Google's documentation says"). Strut's `http` reaches it through a
 * fetch that sends https://gmail.googleapis.com and
 * https://oauth2.googleapis.com to the fake, records every request, and
 * refuses any other address. No real Google account is used and nothing
 * reaches Google. The deployment's GOOGLE_TOKEN this test sets is one the
 * fake would answer for, to see that no step ever sends it.
 *
 *   STRUT_DIR=../strut npm test
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { addressesOf, htmlToText, mailOf, rawOf, readCursor, recipients, replySubject, scrub, threading, writeCursor, type GMessage } from "./steps/_gmail.ts";
import { SCOPES, seamLink } from "./apps/gmail/src/links.ts";

const STRUT = resolve(process.env["STRUT_DIR"] ?? "../strut");
for (const k of ["GOOGLE_TOKEN", "STRUT_GIT_LOCAL"]) delete process.env[k];
const from = async <T>(path: string): Promise<T> => (await import(pathToFileURL(join(STRUT, "src", path)).href)) as T;

const HERE = resolve(".");
const APP = "stadeum/gmail/gmail";
const OTHER_APP = "acme/other/console";
const STEPS = ["me", "disconnect", "new", "read", "search", "draft", "send"].map((s) => `stadeum/gmail/${s}`);
const READONLY = SCOPES[0]!;
const COMPOSE = SCOPES[1]!;

/** Another package, whose app grants this package's steps. */
const OTHER: Record<string, string> = {
  "strut.yaml": "package: acme/other\nversion: 0.1.0\n",
  "apps/console/app.yaml": ["title: Console", "grants:", `  steps: [${STEPS.join(", ")}]`, ""].join("\n"),
  "apps/console/src/App.tsx": "export default function App() { return <p>console</p>; }\n",
};

const hex = (n: number) => randomBytes(n).toString("hex");
/** Made-up tokens in the shape of Google's access tokens. */
const T = {
  ada: `ya29.${hex(24)}`, // a member's, both scopes
  bea: `ya29.${hex(24)}`, // a member's, gmail.readonly alone
  dan: `ya29.${hex(24)}`, // one Google will not revoke
  gone: `ya29.${hex(24)}`, // one Google no longer takes
  deployment: `ya29.${hex(24)}`, // the deployment's: no step may send it
};
const ALL_TOKENS = Object.values(T);

// ── a fake Gmail ──────────────────────────────────────────────────────────

interface Stored {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  headers: Array<[string, string]>;
  text?: string;
  html?: string;
  charset?: string;
  attachments?: string[];
  /** Gmail's search sees it: false for a message its index hasn't caught up with yet. */
  searchable: boolean;
}
interface Mailbox {
  address: string;
  name: string;
  scopes: string[];
  messages: Map<string, Stored>;
  drafts: Map<string, string>;
}
interface Call {
  url: string;
  method: string;
  auth?: string;
  body?: string;
}

const MINUTE = 60_000;

/** Gmail's API and Google's revoke, for made-up tokens, as a real HTTP server. */
class FakeGoogle {
  server!: Server;
  base = "";
  boxes = new Map<string, Mailbox>();
  revoked = new Set<string>();
  /** Tokens whose revocation Google answers with an error. */
  stubborn = new Set<string>();
  private seq = 0;

  mailbox(token: string, address: string, name: string, scopes = SCOPES): Mailbox {
    const box: Mailbox = { address, name, scopes, messages: new Map(), drafts: new Map() };
    this.boxes.set(token, box);
    return box;
  }

  id(): string {
    return (0x18c0000000000000n + BigInt(++this.seq)).toString(16);
  }

  /** Mail in a mailbox, as Gmail would have it. */
  add(token: string, m: { from: string; to?: string; cc?: string; subject: string; text?: string; html?: string; at?: number; labels?: string[]; thread?: string; headers?: Array<[string, string]>; attachments?: string[]; searchable?: boolean; charset?: string; inReplyTo?: Stored }): Stored {
    const box = this.boxes.get(token)!;
    const id = this.id();
    const given = new Set((m.headers ?? []).map(([k]) => k.toLowerCase()));
    const headers: Array<[string, string]> = [
      ["From", m.from],
      ["To", m.to ?? box.address],
      ...(m.cc ? ([["Cc", m.cc]] as Array<[string, string]>) : []),
      ["Subject", m.subject],
      ["Date", new Date(m.at ?? Date.now()).toUTCString()],
      ["Message-ID", `<${id}@mail.example>`],
      ...(m.inReplyTo ? ([["In-Reply-To", msgId(m.inReplyTo)], ["References", msgId(m.inReplyTo)]] as Array<[string, string]>) : []),
    ].filter(([k]) => !given.has(k!.toLowerCase())) as Array<[string, string]>;
    headers.push(...(m.headers ?? []));
    const stored: Stored = {
      id,
      threadId: m.thread ?? m.inReplyTo?.threadId ?? id,
      labelIds: m.labels ?? ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
      internalDate: m.at ?? Date.now(),
      headers,
      ...(m.text !== undefined || m.html === undefined ? { text: m.text ?? "" } : {}),
      ...(m.html !== undefined ? { html: m.html } : {}),
      ...(m.charset ? { charset: m.charset } : {}),
      ...(m.attachments ? { attachments: m.attachments } : {}),
      searchable: m.searchable ?? true,
    };
    box.messages.set(id, stored);
    return stored;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res).catch((e) => send(res, 500, { error: { code: 500, message: String(e) } })));
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    const at = this.server.address();
    this.base = `http://127.0.0.1:${typeof at === "object" && at ? at.port : 0}`;
  }

  stop(): Promise<void> {
    return new Promise((ok) => this.server.close(() => ok()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://fake");
    const [host, ...rest] = url.pathname.slice(1).split("/");
    const path = `/${rest.join("/")}`;
    if (host === "oauth2.googleapis.com" && path === "/revoke" && req.method === "POST") {
      const token = new URLSearchParams(body).get("token") ?? url.searchParams.get("token") ?? "";
      if (!this.boxes.has(token) || this.revoked.has(token) || this.stubborn.has(token)) return send(res, 400, { error: "invalid_token", error_description: "Token expired or revoked" });
      this.revoked.add(token);
      return send(res, 200, {});
    }
    if (host !== "gmail.googleapis.com") return send(res, 404, { error: { code: 404, message: "Not Found" } });
    const token = (req.headers["authorization"] ?? "").replace(/^Bearer /, "");
    const box = this.boxes.get(token);
    if (!box || this.revoked.has(token) || token === T.gone) {
      return send(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials. Expected OAuth 2 access token.", status: "UNAUTHENTICATED" } });
    }
    const me = "/gmail/v1/users/me";
    if (!path.startsWith(me)) return send(res, 404, { error: { code: 404, message: "Not Found" } });
    const p = path.slice(me.length);
    const insufficient = () => send(res, 403, { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } });

    if (req.method === "GET" && p === "/profile") return send(res, 200, { emailAddress: box.address, messagesTotal: box.messages.size, threadsTotal: 1, historyId: "1234" });
    if (req.method === "GET" && p === "/settings/sendAs") {
      return send(res, 200, { sendAs: [{ sendAsEmail: `${box.address.split("@")[0]}@old.example`, displayName: "", isPrimary: false, isDefault: false }, { sendAsEmail: box.address, displayName: box.name, isPrimary: true, isDefault: true }] });
    }
    if (req.method === "GET" && p === "/messages") {
      const q = url.searchParams.get("q") ?? "";
      const max = Math.min(500, Number(url.searchParams.get("maxResults") ?? 100));
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const found = [...box.messages.values()].filter((m) => matches(box, m, q)).sort((a, b) => b.internalDate - a.internalDate);
      const page = found.slice(offset, offset + max);
      return send(res, 200, {
        ...(page.length ? { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}),
        ...(offset + max < found.length ? { nextPageToken: String(offset + max) } : {}),
        resultSizeEstimate: found.length,
      });
    }
    let m = /^\/messages\/([^/]+)$/.exec(p);
    if (req.method === "GET" && m) {
      const one = box.messages.get(decodeURIComponent(m[1]!));
      return one ? send(res, 200, resource(one)) : send(res, 404, { error: { code: 404, message: "Requested entity was not found." } });
    }
    m = /^\/threads\/([^/]+)$/.exec(p);
    if (req.method === "GET" && m) {
      const id = decodeURIComponent(m[1]!);
      const all = [...box.messages.values()].filter((x) => x.threadId === id).sort((a, b) => a.internalDate - b.internalDate);
      return all.length ? send(res, 200, { id, historyId: "1234", messages: all.map(resource) }) : send(res, 404, { error: { code: 404, message: "Requested entity was not found." } });
    }
    if (req.method === "POST" && (p === "/drafts" || p === "/messages/send")) {
      if (!box.scopes.includes(COMPOSE)) return insufficient();
      const json = JSON.parse(body || "{}") as { raw?: string; threadId?: string; message?: { raw?: string; threadId?: string } };
      const given = p === "/drafts" ? json.message : json;
      if (!given?.raw) return send(res, 400, { error: { code: 400, message: "Invalid draft: missing raw" } });
      const parsed = parseRaw(given.raw);
      const threadId = threadFor(this, box, given.threadId, parsed.headers);
      if (threadId === null) return send(res, 404, { error: { code: 404, message: "Requested entity was not found." } });
      const id = this.id();
      const sentToSelf = ["To", "Cc"].some((h) => addressesOf(get(parsed.headers, h)).some((a) => base(a.address) === box.address));
      const stored: Stored = {
        id,
        threadId,
        labelIds: p === "/drafts" ? ["DRAFT"] : sentToSelf ? ["SENT", "INBOX", "UNREAD"] : ["SENT"],
        internalDate: Date.now(),
        headers: [...parsed.headers, ["Message-ID", `<${id}@mail.gmail.example>`]],
        text: parsed.text,
        searchable: true,
      };
      box.messages.set(id, stored);
      if (p === "/drafts") {
        const draft = `r-${this.id()}`;
        box.drafts.set(draft, id);
        return send(res, 200, { id: draft, message: { id, threadId, labelIds: stored.labelIds } });
      }
      return send(res, 200, { id, threadId, labelIds: stored.labelIds });
    }
    return send(res, 404, { error: { code: 404, message: "Not Found" } });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=UTF-8" });
  res.end(JSON.stringify(body));
}

const get = (headers: Array<[string, string]>, name: string) => headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const msgId = (m: Stored) => get(m.headers, "Message-ID")!;
/** An address with its +tag taken off: Gmail delivers both to one mailbox. */
const base = (address: string) => address.toLowerCase().replace(/\+[^@]*@/, "@");
const plainSubject = (s: string) => s.replace(/^\s*((re|fwd?)\s*:\s*)+/i, "").trim().toLowerCase();

/** A message as Gmail's API gives it, `format=full`. */
function resource(m: Stored): GMessage & { snippet: string } {
  const charset = m.charset ?? "UTF-8";
  const enc = (s: string) => Buffer.from(s, charset.toLowerCase() === "iso-8859-1" ? "latin1" : "utf8").toString("base64url");
  const part = (mimeType: string, s: string) => ({ partId: "", mimeType, filename: "", headers: [{ name: "Content-Type", value: `${mimeType}; charset="${charset}"` }], body: { size: s.length, data: enc(s) } });
  const bodies = [...(m.text !== undefined ? [part("text/plain", m.text)] : []), ...(m.html !== undefined ? [part("text/html", m.html)] : [])];
  const atts = (m.attachments ?? []).map((name, i) => ({ partId: `${i + 2}`, mimeType: "application/pdf", filename: name, headers: [{ name: "Content-Disposition", value: `attachment; filename="${name}"` }], body: { size: 1234, attachmentId: `att-${i}` } }));
  const headers = m.headers.map(([name, value]) => ({ name, value }));
  const payload =
    bodies.length === 1 && !atts.length
      ? { ...bodies[0]!, headers: [...headers, ...bodies[0]!.headers] }
      : {
          partId: "",
          mimeType: "multipart/mixed",
          filename: "",
          headers,
          body: { size: 0 },
          parts: [...(bodies.length > 1 ? [{ partId: "0", mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts: bodies }] : bodies), ...atts],
        };
  return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: (m.text ?? "").slice(0, 100), internalDate: String(m.internalDate), payload } as GMessage & { snippet: string };
}

/** Gmail's search, enough of it: words, from:, to:, subject:, in:, category:primary, after:, before:. */
function matches(box: Mailbox, m: Stored, q: string): boolean {
  if (!m.searchable) return false;
  const labels = new Set(m.labelIds);
  const terms = q.replace(/[()]/g, " ").match(/\S+/g) ?? [];
  if (!terms.some((t) => /^in:(spam|trash|anywhere)$/i.test(t)) && (labels.has("SPAM") || labels.has("TRASH"))) return false;
  const header = (n: string) => (get(m.headers, n) ?? "").toLowerCase();
  for (const term of terms) {
    const not = term.startsWith("-");
    const t = not ? term.slice(1) : term;
    const at = t.indexOf(":");
    const [k, v] = at > 0 ? [t.slice(0, at).toLowerCase(), t.slice(at + 1).toLowerCase()] : ["", t.toLowerCase()];
    const ok =
      k === "after" ? m.internalDate > Number(v) * 1000
      : k === "before" ? m.internalDate < Number(v) * 1000
      : k === "in" ? (v === "anywhere" ? true : labels.has(v.toUpperCase()) || (v === "drafts" && labels.has("DRAFT")))
      : k === "from" ? header("From").includes(v)
      : k === "to" ? [header("To"), header("Cc")].some((h) => h.includes(v))
      : k === "subject" ? header("Subject").includes(v)
      : k === "category" ? v === "primary" && !["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"].some((c) => labels.has(c))
      : k === "" ? `${header("Subject")} ${(m.text ?? "").toLowerCase()}`.includes(v)
      : false;
    if (ok === not) return false;
  }
  return box.messages.has(m.id);
}

/** RFC 2047 words back to text, as Gmail shows a header. */
const unwords = (s: string) => s.replace(/\?=\s+=\?/g, "?==?").replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b: string) => Buffer.from(b, "base64").toString("utf8"));

/** A `raw` message: its headers (unfolded, words decoded) and its text. */
function parseRaw(raw: string): { headers: Array<[string, string]>; text: string; source: string } {
  const source = Buffer.from(raw, "base64url").toString("utf8");
  const split = source.indexOf("\r\n\r\n");
  const head = source.slice(0, split).replace(/\r\n[ \t]+/g, " ");
  const headers = head.split("\r\n").map((l): [string, string] => [l.slice(0, l.indexOf(":")), unwords(l.slice(l.indexOf(":") + 1).trim())]);
  const rest = source.slice(split + 4);
  const text = get(headers, "Content-Transfer-Encoding") === "base64" ? Buffer.from(rest.replace(/\r\n/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n") : rest;
  return { headers, text, source };
}

/** Google's rules for a message added to a thread (README): the threadId on
 *  the message, References or In-Reply-To naming one of the thread's
 *  messages, and the same subject. Short of them, a new thread. */
function threadFor(g: FakeGoogle, box: Mailbox, threadId: string | undefined, headers: Array<[string, string]>): string | null {
  if (!threadId) return g.id();
  const thread = [...box.messages.values()].filter((m) => m.threadId === threadId && !m.labelIds.includes("DRAFT"));
  if (!thread.length) return null;
  const ids = new Set(thread.map(msgId));
  const named = `${get(headers, "In-Reply-To") ?? ""} ${get(headers, "References") ?? ""}`.match(/<[^<>\s]+>/g) ?? [];
  const sameSubject = plainSubject(get(headers, "Subject") ?? "") === plainSubject(get(thread[0]!.headers, "Subject") ?? "");
  return named.some((n) => ids.has(n)) && sameSubject ? threadId : g.id();
}

// ── the package's own rules ───────────────────────────────────────────────

const gm = (headers: Record<string, string>, extra: Partial<GMessage> = {}, text = "hello"): GMessage => ({
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX"],
  internalDate: "1732400000000",
  payload: { mimeType: "text/plain", headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data: Buffer.from(text).toString("base64url") } },
  ...extra,
});

describe("the package's own rules", () => {
  it("reads the addresses in a header: names with commas, quotes, groups; nothing that is not an address", () => {
    assert.deepEqual(addressesOf('"Lovelace, Ada" <ada@acme.example>, bob@acme.example, Team: cy@acme.example, "x" <not-an-address>;, Dee Dee <dee@ACME.example> (work)'), [
      { address: "ada@acme.example", name: "Lovelace, Ada" },
      { address: "bob@acme.example" },
      { address: "cy@acme.example" },
      { address: "dee@ACME.example", name: "Dee Dee" },
    ]);
    assert.deepEqual(addressesOf(undefined), []);
    assert.deepEqual(addressesOf("undisclosed-recipients:;"), []);
  });

  it("marks mail a list or a machine sent, and nothing else", () => {
    const person = { From: "Bob <bob@acme.example>", Subject: "Lunch?" };
    assert.equal(mailOf(gm(person)).machine, false);
    for (const [k, v] of [
      ["List-Id", "<news.acme.example>"],
      ["List-Unsubscribe", "<mailto:leave@acme.example>"],
      ["Auto-Submitted", "auto-replied"],
      ["Precedence", "bulk"],
      ["Precedence", "junk"],
      ["X-Autoreply", "yes"],
      ["Return-Path", "<>"],
    ] as const) {
      assert.equal(mailOf(gm({ ...person, [k]: v })).machine, true, `${k}: ${v}`);
    }
    assert.equal(mailOf(gm({ ...person, "Auto-Submitted": "no" })).machine, false, "Auto-Submitted: no is a person");
    assert.equal(mailOf(gm({ ...person, Precedence: "first-class" })).machine, false);
    for (const sender of ["no-reply@acme.example", "noreply+x@acme.example", "Do_Not_Reply@acme.example", "MAILER-DAEMON@acme.example", "postmaster@acme.example", "bounces@acme.example"]) {
      assert.equal(mailOf(gm({ ...person, From: sender })).machine, true, sender);
    }
    assert.equal(mailOf(gm({ ...person, From: "noreen@acme.example" })).machine, false, "a person whose name starts like one");
  });

  it("knows the mailbox's own mail by Gmail's SENT, never by its From", () => {
    assert.equal(mailOf(gm({ From: "ada@acme.example" }, { labelIds: ["SENT"] })).mine, true);
    assert.equal(mailOf(gm({ From: "ada@acme.example" }, { labelIds: ["INBOX"] })).mine, false, "a From anyone can write");
  });

  it("gives a message's text: its plain part, or its HTML's words; attachments by name; Reply-To only when it differs", () => {
    const html: GMessage = {
      id: "m2",
      threadId: "t2",
      labelIds: ["INBOX"],
      internalDate: "1732400000000",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Bob <bob@acme.example>" },
          { name: "Reply-To", value: "Bob <BOB@acme.example>" },
          { name: "Subject", value: "  The  plan " },
        ],
        parts: [
          { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { data: Buffer.from("<style>p{}</style><p>Hi &amp; welcome</p><ul><li>one</li></ul>caf&#233;<br>bye").toString("base64url") } },
          { mimeType: "application/pdf", filename: "plan.pdf", body: { attachmentId: "a1" } },
        ],
      },
    };
    const m = mailOf(html);
    assert.equal(m.text, "Hi & welcome\n- one\ncafé\nbye");
    assert.deepEqual(m.attachments, ["plan.pdf"]);
    assert.equal(m.replyTo, undefined, "the same as From");
    assert.equal(m.subject, "The plan");
    assert.equal(m.date, "2024-11-23T22:13:20.000Z");
    const long = mailOf(gm({ From: "bob@acme.example", "Reply-To": "desk@acme.example" }, {}, "x".repeat(25_000)));
    assert.equal(long.text.length, 20_000);
    assert.equal(long.truncated, true);
    assert.deepEqual(long.replyTo, [{ address: "desk@acme.example" }]);
    assert.equal(htmlToText("a&nbsp;b &unknown; &#x41;"), "a b &unknown; A");
    const latin: GMessage = gm({ From: "bob@acme.example" });
    latin.payload!.headers!.push({ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' });
    latin.payload!.body = { data: Buffer.from("Gr\xfc\xdfe", "latin1").toString("base64url") };
    assert.equal(mailOf(latin).text, "Grüße");
  });

  it("writes a message Gmail takes: one line per header, whatever a value holds, and the text in base64", () => {
    const raw = rawOf({
      from: { address: "ada@acme.example", name: 'Ada "A" Lovelace' },
      to: [{ address: "bob@acme.example", name: "Bøb" }, { address: "cy@acme.example" }],
      subject: "Hello\r\nBcc: eve@evil.example",
      text: "Hi Bob,\nsee you.\r\n— Ada",
      inReplyTo: "<a1@mail.example>",
      references: ["<a0@mail.example>", "<a1@mail.example>"],
    });
    const { headers, text, source } = parseRaw(raw);
    assert.deepEqual(
      headers.map(([k]) => k),
      ["From", "To", "Subject", "In-Reply-To", "References", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"],
      "no header a value could add",
    );
    assert.equal(get(headers, "From"), '"Ada \\"A\\" Lovelace" <ada@acme.example>');
    assert.equal(get(headers, "To"), "Bøb <bob@acme.example>, cy@acme.example");
    assert.equal(get(headers, "Subject"), "Hello Bcc: eve@evil.example");
    assert.equal(get(headers, "References"), "<a0@mail.example> <a1@mail.example>");
    assert.equal(text, "Hi Bob,\nsee you.\n— Ada");
    for (const line of source.split("\r\n")) assert.ok(line.length <= 998, "no line over RFC 2822's limit");
    assert.match(source, /^To: =\?UTF-8\?B\?/m, "a name that is not ASCII is encoded");
    // A subject that is not ASCII, in words of its own.
    assert.equal(get(parseRaw(rawOf({ from: { address: "ada@acme.example" }, to: [{ address: "bob@acme.example" }], subject: "Grüße aus Köln — ".repeat(5), text: "x" })).headers, "Subject"), "Grüße aus Köln — ".repeat(5).trim());
  });

  it("takes recipients as an address, a name and address, or a list; never a line break or something that is not an address", () => {
    assert.deepEqual(recipients("bob@acme.example"), [{ address: "bob@acme.example" }]);
    assert.deepEqual(recipients(["Bob <bob@acme.example>", "cy@acme.example, dee@acme.example"]), [
      { address: "bob@acme.example", name: "Bob" },
      { address: "cy@acme.example" },
      { address: "dee@acme.example" },
    ]);
    assert.throws(() => recipients("bob@acme.example\r\nBcc: eve@evil.example"), /line break/);
    assert.throws(() => recipients("bob"), /not an address/);
    assert.throws(() => recipients("bob@acme.example, nobody"), /not an address/);
    assert.throws(() => recipients(Array.from({ length: 51 }, (_, i) => `p${i}@acme.example`)), /at most 50/);
  });

  it("keeps a reply in its thread: Re: once, In-Reply-To its message, References the chain", () => {
    assert.equal(replySubject("Lunch?"), "Re: Lunch?");
    assert.equal(replySubject("RE: Lunch?"), "RE: Lunch?");
    assert.equal(replySubject(""), "Re:");
    assert.deepEqual(threading(gm({ "Message-ID": "<b@x>", References: "<a@x>\r\n <z@x>" })), { inReplyTo: "<b@x>", references: ["<a@x>", "<z@x>", "<b@x>"] });
    const long = threading(gm({ "Message-ID": "<last@x>", References: Array.from({ length: 30 }, (_, i) => `<r${i}@x>`).join(" ") }));
    assert.equal(long.references.length, 20);
    assert.deepEqual([long.references[0], long.references.at(-1)], ["<r0@x>", "<last@x>"]);
  });

  it("hands back where `new` stopped as it took it, and says so when it is not one", () => {
    const c = { after: 1732400000000, seen: new Map([["18c1", 1732400001000], ["18c2", 1732400002000]]) };
    assert.equal(writeCursor(c), "1732400000000;18c1@1732400001000,18c2@1732400002000");
    assert.deepEqual(readCursor(writeCursor(c)), c);
    assert.deepEqual(readCursor("1732400000000"), { after: 1732400000000, seen: new Map() });
    for (const bad of ["", "yesterday", "17;x", "17;a@b@c", "-1"]) assert.throws(() => readCursor(bad), /not where an earlier `new` stopped/, bad);
  });

  it("scrubs a token out of anything it shows", () => {
    assert.equal(scrub(`bad ${T.ada} and 1//0g${hex(20)}`), "bad [a token] and [a token]");
    assert.equal(scrub("weird value 12345", "12345"), "weird value [a token]");
  });

  it("sends a person to the box's connect seam with the package's two scopes, only when the host's page is on the box this strut is served for", () => {
    const strut = "https://strut.acme.stakwork.ai/?ticket=x&app=stadeum%2Fgmail%2Fgmail&solo=1";
    const page = "https://acme.stakwork.ai/apps/stadeum%2Fgmail%2Fgmail";
    const link = new URL(seamLink(page, strut)!);
    assert.equal(link.origin + link.pathname, "https://acme.stakwork.ai/api/connect/google");
    assert.deepEqual(link.searchParams.get("scope")!.split(" "), ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"]);
    assert.equal(link.searchParams.get("return"), page);
    assert.ok(seamLink("http://box.localhost:4100/apps/x", "http://strut.box.localhost:3100/")?.startsWith("http://box.localhost:4100/api/connect/google?"));
    for (const named of ["https://phish.example/apps/gmail", "https://evil.stakwork.ai/apps/gmail", "https://strut.acme.stakwork.ai/?app=x", "http://acme.stakwork.ai/apps/gmail", "javascript:alert(1)"]) {
      assert.equal(seamLink(named, strut), undefined, named);
    }
    assert.equal(seamLink(page, "http://localhost:3000/"), undefined);
    assert.equal(seamLink(page, undefined), undefined);
    assert.equal(seamLink(undefined, strut), undefined);
  });
});

// ── on strut ──────────────────────────────────────────────────────────────

describe("stadeum/gmail on strut", { timeout: 300_000 }, () => {
  let root = "";
  let strut: any;
  let tools: any;
  let store: any;
  let appIdentity: (name: string, version: string) => string;
  let STEP_RUN: string;
  const versions: Record<string, string> = {};
  const calls: Call[] = [];
  const google = new FakeGoogle();
  const seen: string[] = [];
  const logged: string[] = [];
  const consoleWas = { ...console };

  /** A call from an app's page (the Gmail app's unless named), as its viewer. */
  const page = (actor: string, app = APP, version?: string) => {
    const t = tools.buildAppTools({ apps: strut.apps, registry: strut.getRegistry(), services: strut.services, actor, admin: false, runStepDeps: { store, workspace: strut.workspace } });
    return async (type: string, config: Record<string, unknown> = {}): Promise<{ error?: string; result?: any }> => {
      const out = await t[STEP_RUN].execute({ type, config, app: appIdentity(app, version ?? versions[app]!) }, { toolCallId: "t", messages: [] });
      seen.push(JSON.stringify(out));
      return out;
    };
  };
  const ok = async (p: Promise<{ error?: string; result?: any }>) => {
    const out = await p;
    assert.equal(out.error, undefined, out.error);
    return out.result;
  };
  /** A person's own secret, as the connect seam writes it. */
  const seam = async (actor: string, value: string) => {
    const res = await strut.app.request(`/actors/${actor}/secrets/GOOGLE_TOKEN`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
    assert.equal(res.status, 200, await res.text());
  };
  const hasOwn = async (actor: string) => {
    const { secrets } = await (await strut.app.request(`/actors/${actor}/secrets`)).json();
    return (secrets as Array<string | { name: string }>).some((s) => (typeof s === "string" ? s : s.name) === "GOOGLE_TOKEN");
  };
  const since = (n: number) => calls.slice(n);
  const install = async (dir: string) => {
    const key = `key-${hex(8)}`;
    process.env["STRUT_API_KEY"] = key;
    try {
      const res = await strut.app.request("/packages/install", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-strut-actor": "root" },
        body: JSON.stringify({ ref: `file:${dir}` }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      return body;
    } finally {
      delete process.env["STRUT_API_KEY"];
    }
  };
  const outOf = (run: any) => run.output?.s ?? run.output;
  let flows = 0;
  /** One step, as a workflow of the person's own runs it: no page, no app. */
  const once = async (step: string, config: Record<string, unknown>, actor: string) => {
    const name = `test/once-${++flows}`;
    await strut.workspace.publishWorkflowByContent(name, `steps:\n  - id: s\n    type: ${step}\n    config: ${JSON.stringify(config)}\n`);
    const run = await strut.run(name, {}, { actor, principal: actor });
    seen.push(JSON.stringify(run));
    return run;
  };
  const step = async (s: string, config: Record<string, unknown>, actor: string) => {
    const run = await once(s, config, actor);
    assert.equal(run.status, "success", JSON.stringify(run.error));
    return outOf(run);
  };
  const failed = async (s: string, config: Record<string, unknown>, actor: string) => {
    const run = await once(s, config, actor);
    assert.equal(run.status, "error", `${s} should fail: ${JSON.stringify(outOf(run))}`);
    return JSON.stringify(run.error);
  };
  const gmailCalls = (n: number) => since(n).map((c) => `${c.method} ${c.url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "")}`);

  let ada: Mailbox;
  let bea: Mailbox;

  before(async () => {
    delete process.env["STRUT_API_KEY"];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      console[level] = (...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
        consoleWas[level](...args);
      };
    }
    await google.start();
    ada = google.mailbox(T.ada, "ada@acme.example", "Ada Lovelace");
    bea = google.mailbox(T.bea, "bea@acme.example", "Bea Smith", [READONLY]);
    google.mailbox(T.dan, "dan@acme.example", "Dan");
    google.stubborn.add(T.dan);
    google.mailbox(T.deployment, "the-box@acme.example", "The Box");

    root = await mkdtemp(join(tmpdir(), "strut-gmail-test-"));
    store = new (await from<any>("store.ts")).MemoryRunStore();
    const { createStrut } = await from<any>("createStrut.ts");
    const { httpCapability } = await from<any>("capabilities.ts");
    const { openGraphBackend } = await from<any>("graph/backend.ts");
    const { PRIVATE_NAMESPACE } = await from<any>("graph/ladybug/namespaces.ts");
    const { GraphWorkspaceStore } = await from<any>("graph/workspace-store.ts");
    const { kitForTests } = await from<any>("test-util/app-kit.ts");
    tools = await from<any>("apps/tools.ts");
    STEP_RUN = tools.STEP_RUN_TOOL;
    appIdentity = (await from<any>("auth.ts")).appIdentity;
    // Google's two hosts, sent to the fake; anything else refused.
    const toFake = async (raw: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
      const url = new URL(raw);
      const method = init?.method ?? "GET";
      const auth = Object.entries(init?.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1];
      calls.push({ url: raw, method, ...(auth ? { auth } : {}), ...(init?.body ? { body: init.body } : {}) });
      if (url.origin !== "https://gmail.googleapis.com" && url.origin !== "https://oauth2.googleapis.com") throw new Error(`the fake answers Google's two hosts alone, not ${url.origin}`);
      return fetch(`${google.base}/${url.host}${url.pathname}${url.search}`, { method, headers: init?.headers ?? {}, ...(init?.body !== undefined ? { body: init.body } : {}), ...(init?.signal ? { signal: init.signal } : {}) });
    };
    const graph = await openGraphBackend({ kind: "ladybug", path: join(root, "graph.lbug"), namespace: PRIVATE_NAMESPACE }, { embeddings: false });
    strut = await createStrut({
      workspace: new GraphWorkspaceStore(graph, { materializeDir: join(root, "steps"), appsDir: join(root, "apps") }),
      dataDir: root,
      store,
      kit: await kitForTests(),
      serveUi: false,
      enableChat: false,
      autoResume: false,
      orchestrator: false,
      builder: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      views: false,
      concepts: { personal: false, claims: false },
      stt: false,
      jamie: false,
      earnings: false,
      staff: false,
      worker: false,
      git: { local: false },
      services: { http: httpCapability(toFake) },
    });
    await install(HERE);
    const other = join(root, "acme-other");
    for (const [rel, text] of Object.entries(OTHER)) {
      await mkdir(dirname(join(other, rel)), { recursive: true });
      await writeFile(join(other, rel), text);
    }
    await install(other);
    for (const app of [APP, OTHER_APP]) versions[app] = (await strut.apps.manifestOf(app)).version;
    // The deployment's GOOGLE_TOKEN: a box sets none, and no step may read one.
    const res = await strut.app.request("/secrets/GOOGLE_TOKEN", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: T.deployment }) });
    assert.ok(res.status < 300, await res.text());
  });
  after(async () => {
    Object.assign(console, consoleWas);
    await strut?.close?.().catch(() => {});
    await google.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it("installs whole: the token it provides, its seven steps, its app, and no schedule", async () => {
    const { packages } = await (await strut.app.request("/packages")).json();
    const pkg = packages.find((p: any) => p.package === "stadeum/gmail");
    assert.ok(pkg, "installed");
    assert.equal(pkg.version, "0.1.0");
    assert.deepEqual(pkg.provides?.secrets, ["GOOGLE_TOKEN"]);
    const registry = strut.getRegistry();
    const effects = Object.fromEntries(STEPS.map((s) => [s.split("/").pop(), registry[s]?.effect]));
    assert.deepEqual(effects, { me: "read", disconnect: "write", new: "read", read: "read", search: "read", draft: "write", send: "write" });
    const manifest = await strut.apps.manifestOf(APP);
    assert.deepEqual([...manifest.manifest.grants.steps].sort(), ["stadeum/gmail/disconnect", "stadeum/gmail/me"]);
    assert.equal(manifest.manifest.admin, undefined, "everyone's app");
    const { automations } = await (await strut.app.request("/automations")).json();
    assert.deepEqual(automations.filter((a: any) => a.package === "stadeum/gmail"), [], "no schedule yet");
  });

  it("says a person with no token of their own is not connected, though the deployment has one, and asks Google nothing", async () => {
    const n = calls.length;
    assert.deepEqual(await ok(page("cy")("stadeum/gmail/me")), { connected: false });
    assert.deepEqual(since(n), [], "no call to Google");
  });

  it("refuses every mail step to a person with no token, and asks Google nothing", async () => {
    const n = calls.length;
    for (const [s, config] of [
      ["stadeum/gmail/new", { search: "in:inbox" }],
      ["stadeum/gmail/read", { thread: "18c" }],
      ["stadeum/gmail/search", { query: "lunch" }],
      ["stadeum/gmail/draft", { to: "bob@acme.example", text: "hi" }],
      ["stadeum/gmail/send", { to: "bob@acme.example", text: "hi" }],
    ] as const) {
      assert.match(await failed(s, config, "cy"), /connect Google first, in the Gmail app/, s);
    }
    assert.deepEqual(since(n), [], "no call to Google");
  });

  it("says which mailbox a person connected, with their own token alone", async () => {
    await seam("ada", T.ada);
    const n = calls.length;
    assert.deepEqual(await ok(page("ada")("stadeum/gmail/me")), { connected: true, address: "ada@acme.example" });
    assert.deepEqual(since(n).map((c) => [c.method, c.url, c.auth]), [["GET", "https://gmail.googleapis.com/gmail/v1/users/me/profile", `Bearer ${T.ada}`]]);
    // Another app's page reads the viewer's own too: the mailbox is whoever's token the call has.
    assert.deepEqual(await ok(page("ada", OTHER_APP)("stadeum/gmail/me")), { connected: true, address: "ada@acme.example" });
  });

  let cursor = "";
  const old = Date.now() - 2 * 24 * 60 * MINUTE;
  let bobThread: Stored[] = [];

  it("hands over no mail on a first look, only where to start: no backlog", async () => {
    const first = google.add(T.ada, { from: "Bob Stone <bob@acme.example>", subject: "Lunch?", text: "Free on Tuesday?", at: old });
    const mine = google.add(T.ada, { from: "Ada Lovelace <ada@acme.example>", to: "Bob Stone <bob@acme.example>", subject: "Re: Lunch?", text: "Tuesday works.", at: old + MINUTE, labels: ["SENT"], inReplyTo: first });
    const last = google.add(T.ada, {
      from: "Bob Stone <bob@acme.example>",
      subject: "RE: Lunch?",
      text: "Great. Noon?\n\n> Tuesday works.",
      at: old + 2 * MINUTE,
      inReplyTo: mine,
      headers: [["Reply-To", "Bob's desk <desk@acme.example>"], ["References", `${msgId(first)} ${msgId(mine)}`]],
      attachments: ["menu.pdf"],
    });
    bobThread = [first, mine, last];
    const n = calls.length;
    const out = await step("stadeum/gmail/new", { search: "in:inbox" }, "ada");
    assert.deepEqual(out.messages, []);
    assert.match(out.since, /^\d+$/);
    assert.ok(Math.abs(Number(out.since) - Date.now()) < MINUTE);
    assert.deepEqual(since(n), [], "a first look asks Gmail nothing");
    cursor = out.since;
  });

  it("then hands over new mail that matches, oldest first, each with mine and machine; drafts and other mail left out", async () => {
    const t0 = Date.now();
    google.add(T.ada, { from: "News <news@shop.example>", subject: "Sale", text: "50% off", at: t0 + 3, headers: [["List-Unsubscribe", "<mailto:leave@shop.example>"]] });
    google.add(T.ada, { from: "Cy <cy@acme.example>", subject: "The deck", text: "Here it is.", at: t0 + 1, attachments: ["deck.pdf", "notes.txt"] });
    google.add(T.ada, { from: "no-reply@build.example", subject: "Build passed", text: "ok", at: t0 + 2 });
    google.add(T.ada, { from: "Ada Lovelace <ada@acme.example>", to: "ada+jamie@acme.example", subject: "Fix the build", text: "Please look.", at: t0 + 4, labels: ["SENT", "INBOX"] });
    google.add(T.ada, { from: "Eve <eve@acme.example>", subject: "Archived", text: "not in the inbox", at: t0 + 5, labels: ["CATEGORY_PERSONAL"] });
    google.add(T.ada, { from: "Ada Lovelace <ada@acme.example>", to: "cy@acme.example", subject: "Draft", text: "unfinished", at: t0 + 6, labels: ["DRAFT"] });
    const n = calls.length;
    const out = await step("stadeum/gmail/new", { search: "in:inbox", since: cursor }, "ada");
    assert.deepEqual(
      out.messages.map((m: any) => [m.subject, m.from.address, m.mine, m.machine]),
      [
        ["The deck", "cy@acme.example", false, false],
        ["Build passed", "no-reply@build.example", false, true],
        ["Sale", "news@shop.example", false, true],
        ["Fix the build", "ada@acme.example", true, false],
      ],
    );
    const deck = out.messages[0];
    assert.deepEqual(Object.keys(deck).sort(), ["attachments", "cc", "date", "from", "id", "machine", "mine", "subject", "text", "thread", "to"]);
    assert.deepEqual(deck.attachments, ["deck.pdf", "notes.txt"]);
    assert.deepEqual(deck.to, [{ address: "ada@acme.example" }]);
    assert.equal(deck.text, "Here it is.");
    const list = gmailCalls(n);
    assert.match(list[0]!, /^GET \/messages\?q=\(in%3Ainbox\)%20-in%3Adrafts%20after%3A\d+&maxResults=100$/, "Gmail's search, from where the last look stopped");
    assert.equal(list.length, 1 + 4, "the search, then each message once");
    assert.ok(since(n).every((c) => c.auth === `Bearer ${T.ada}`));
    // Again from where it stopped: nothing twice.
    const again = await step("stadeum/gmail/new", { search: "in:inbox", since: out.since }, "ada");
    assert.deepEqual(again.messages, []);
    cursor = again.since;
    assert.equal(readCursor(cursor).seen.size, 4, "it remembers what it handed over while it still looks back that far");
  });

  it("still hands over mail Gmail's search saw late, and only once; never mail from before the first look", async () => {
    // As if the first look was nine minutes ago.
    const nineAgo = writeCursor({ after: Date.now() - 9 * MINUTE, seen: new Map() });
    google.add(T.ada, { from: "Dee <dee@acme.example>", subject: "Before the first look", text: "old", at: Date.now() - 12 * MINUTE });
    const late = google.add(T.ada, { from: "Dee <dee@acme.example>", subject: "Slow mail", text: "late", at: Date.now() - 5 * MINUTE, searchable: false });
    const before = await step("stadeum/gmail/new", { search: "from:dee@acme.example", since: nineAgo }, "ada");
    assert.deepEqual(before.messages, [], "Gmail's search doesn't see it yet");
    assert.equal(readCursor(before.since).after, readCursor(nineAgo).after, "and it still looks back far enough to");
    late.searchable = true;
    const now = await step("stadeum/gmail/new", { search: "from:dee@acme.example", since: before.since }, "ada");
    assert.deepEqual(now.messages.map((m: any) => m.subject), ["Slow mail"]);
    const after = await step("stadeum/gmail/new", { search: "from:dee@acme.example", since: now.since }, "ada");
    assert.deepEqual(after.messages, []);
  });

  it("hands over at most 50 at a time, and the rest on the next look", async () => {
    const t0 = Date.now();
    for (let i = 0; i < 55; i++) google.add(T.ada, { from: "Fan <fan@acme.example>", subject: `Note ${i}`, text: "hi", at: t0 + i });
    const first = await step("stadeum/gmail/new", { search: "from:fan@acme.example", since: cursor }, "ada");
    assert.equal(first.messages.length, 50);
    assert.equal(first.more, true);
    assert.equal(first.messages[0].subject, "Note 0");
    const next = await step("stadeum/gmail/new", { search: "from:fan@acme.example", since: first.since }, "ada");
    assert.deepEqual(next.messages.map((m: any) => m.subject), ["Note 50", "Note 51", "Note 52", "Note 53", "Note 54"]);
    assert.equal(next.more, undefined);
    assert.deepEqual((await step("stadeum/gmail/new", { search: "from:fan@acme.example", since: next.since }, "ada")).messages, []);
  });

  it("says so when `since` is not where an earlier look stopped", async () => {
    assert.match(await failed("stadeum/gmail/new", { search: "in:inbox", since: "last tuesday" }, "ada"), /not where an earlier `new` stopped/);
  });

  it("runs in a person's own workflow, which passes `since` from one run to the next", async () => {
    await strut.workspace.publishWorkflowByContent(
      "test/my-mail",
      ["steps:", "  - id: mail", "    type: stadeum/gmail/new", '    config: { search: "from:gus@acme.example", since: "{{ input.since }}" }', ""].join("\n"),
    );
    const run = async (input: Record<string, unknown>) => {
      const r = await strut.run("test/my-mail", input, { actor: "ada", principal: "ada" });
      seen.push(JSON.stringify(r));
      assert.equal(r.status, "success", JSON.stringify(r.error));
      return r.output?.mail ?? r.output;
    };
    const start = await run({});
    assert.deepEqual(start.messages, []);
    google.add(T.ada, { from: "Gus <gus@acme.example>", subject: "Hello from Gus", text: "hi" });
    const got = await run({ since: start.since });
    assert.deepEqual(got.messages.map((m: any) => m.subject), ["Hello from Gus"]);
    assert.deepEqual((await run({ since: got.since })).messages, []);
  });

  it("reads a thread, oldest first, with its facts; drafts left out", async () => {
    google.add(T.ada, { from: "Ada Lovelace <ada@acme.example>", to: "bob@acme.example", subject: "Re: Lunch?", text: "half-written", thread: bobThread[0]!.threadId, labels: ["DRAFT"] });
    const n = calls.length;
    const out = await step("stadeum/gmail/read", { thread: bobThread[0]!.threadId }, "ada");
    assert.equal(out.thread, bobThread[0]!.threadId);
    assert.equal(out.subject, "Lunch?");
    assert.deepEqual(
      out.messages.map((m: any) => [m.id, m.mine, m.text]),
      bobThread.map((m) => [m.id, m.labelIds.includes("SENT"), m.text]),
    );
    assert.deepEqual(out.messages[2].replyTo, [{ address: "desk@acme.example", name: "Bob's desk" }]);
    assert.deepEqual(out.messages[2].attachments, ["menu.pdf"]);
    assert.equal(out.messages[0].date, new Date(old).toISOString());
    assert.deepEqual(gmailCalls(n), [`GET /threads/${bobThread[0]!.threadId}?format=full`]);
    assert.match(await failed("stadeum/gmail/read", { thread: "ffff0000" }, "ada"), /no thread ffff0000 in your mailbox/);
    assert.match(await failed("stadeum/gmail/read", { thread: "../profile" }, "ada"), /not a thread's id/);
  });

  it("searches, newest first, 20 unless a limit says otherwise", async () => {
    const out = await step("stadeum/gmail/search", { query: "from:fan@acme.example" }, "ada");
    assert.equal(out.messages.length, 20);
    assert.equal(out.messages[0].subject, "Note 54");
    const two = await step("stadeum/gmail/search", { query: "lunch", limit: 2 }, "ada");
    assert.deepEqual(two.messages.map((m: any) => m.text), ["Great. Noon?\n\n> Tuesday works.", "Tuesday works."]);
  });

  it("drafts a reply in a thread: to the sender's Reply-To, from the mailbox's own address, with the headers that keep it in the thread", async () => {
    const thread = bobThread[0]!.threadId;
    const n = calls.length;
    const out = await step("stadeum/gmail/draft", { thread, text: "Noon is good.\n— Ada" }, "ada");
    assert.deepEqual(gmailCalls(n), ["GET /settings/sendAs", `GET /threads/${thread}?format=full`, "POST /drafts"]);
    assert.equal(out.thread, thread, "Gmail kept it in the thread: its rules for a reply were met");
    assert.deepEqual(out.to, [{ address: "desk@acme.example", name: "Bob's desk" }]);
    const kept = ada.messages.get(out.message)!;
    assert.deepEqual(kept.labelIds, ["DRAFT"]);
    assert.equal(ada.drafts.get(out.draft), out.message);
    assert.equal(get(kept.headers, "From"), '"Ada Lovelace" <ada@acme.example>');
    assert.equal(get(kept.headers, "To"), `"Bob's desk" <desk@acme.example>`);
    assert.equal(get(kept.headers, "Subject"), "RE: Lunch?");
    assert.equal(get(kept.headers, "In-Reply-To"), msgId(bobThread[2]!));
    assert.equal(get(kept.headers, "References"), bobThread.map(msgId).join(" "));
    assert.equal(kept.text, "Noon is good.\n— Ada");
    // The fake starts a new thread when a reply misses Google's rules: it is a fair check.
    const stray = google.add(T.ada, { from: "x@acme.example", subject: "Other", text: "x" });
    const body = JSON.parse(since(n).at(-1)!.body!);
    const res = await fetch(`${google.base}/gmail.googleapis.com/gmail/v1/users/me/drafts`, { method: "POST", headers: { authorization: `Bearer ${T.ada}` }, body: JSON.stringify({ message: { raw: body.message.raw, threadId: stray.threadId } }) });
    assert.notEqual(((await res.json()) as any).message.threadId, stray.threadId);
  });

  it("answers the mailbox's own last message to whom it went, and `to` names someone else", async () => {
    const asked = google.add(T.ada, { from: "Ada Lovelace <ada@acme.example>", to: "Cy <cy@acme.example>", subject: "Numbers", text: "Any news?", labels: ["SENT"] });
    const out = await step("stadeum/gmail/draft", { thread: asked.threadId, text: "Nudging this." }, "ada");
    assert.deepEqual(out.to, [{ address: "cy@acme.example", name: "Cy" }]);
    assert.equal(out.thread, asked.threadId);
    const other = await step("stadeum/gmail/draft", { thread: asked.threadId, to: "Dee <dee@acme.example>", text: "Over to you." }, "ada");
    assert.deepEqual(other.to, [{ address: "dee@acme.example", name: "Dee" }]);
  });

  it("drafts a new message to `to`; refuses one with no one to send to, a subject on a reply, or a line break in a recipient", async () => {
    const out = await step("stadeum/gmail/draft", { to: ["Bob <bob@acme.example>", "cy@acme.example"], subject: "Grüße", text: "Hallo" }, "ada");
    const kept = ada.messages.get(out.message)!;
    assert.equal(get(kept.headers, "To"), '"Bob" <bob@acme.example>, cy@acme.example');
    assert.equal(get(kept.headers, "Subject"), "Grüße");
    assert.equal(get(kept.headers, "In-Reply-To"), undefined);
    assert.notEqual(out.thread, bobThread[0]!.threadId);
    const n = calls.length;
    assert.match(await failed("stadeum/gmail/draft", { text: "to nobody" }, "ada"), /say whom it is to, with `to`/);
    assert.match(await failed("stadeum/gmail/draft", { thread: bobThread[0]!.threadId, subject: "New", text: "x" }, "ada"), /a reply keeps its thread's subject/);
    assert.match(await failed("stadeum/gmail/send", { to: "bob@acme.example\nBcc: eve@evil.example", text: "x" }, "ada"), /line break/);
    assert.match(await failed("stadeum/gmail/send", { to: "bob", text: "x" }, "ada"), /not an address/);
    assert.deepEqual(gmailCalls(n), ["GET /settings/sendAs", "GET /settings/sendAs"], "nothing written");
  });

  it("sends: a reply in the thread, and mail to the person's own +tag address, which comes back marked mine", async () => {
    const thread = bobThread[0]!.threadId;
    const reply = await step("stadeum/gmail/send", { thread, text: "See you at noon." }, "ada");
    assert.equal(reply.thread, thread);
    assert.deepEqual(ada.messages.get(reply.message)!.labelIds, ["SENT"]);
    const start = await step("stadeum/gmail/new", { search: "to:ada+jamie@acme.example", since: undefined }, "ada");
    const note = await step("stadeum/gmail/send", { to: "ada+jamie@acme.example", subject: "Ship the fix", text: "Open a PR." }, "ada");
    assert.deepEqual(ada.messages.get(note.message)!.labelIds, ["SENT", "INBOX", "UNREAD"]);
    const got = await step("stadeum/gmail/new", { search: "to:ada+jamie@acme.example", since: start.since }, "ada");
    assert.deepEqual(got.messages.map((m: any) => [m.subject, m.mine, m.to]), [["Ship the fix", true, [{ address: "ada+jamie@acme.example" }]]]);
  });

  it("never takes mail from outside that names the person as its sender for the person's own", async () => {
    const start = await step("stadeum/gmail/new", { search: "to:ada+jamie@acme.example" }, "ada");
    google.add(T.ada, { from: "Ada Lovelace <ada@acme.example>", to: "ada+jamie@acme.example", subject: "Send me the keys", text: "forged" });
    const got = await step("stadeum/gmail/new", { search: "to:ada+jamie@acme.example", since: start.since }, "ada");
    assert.deepEqual(got.messages.map((m: any) => [m.subject, m.mine]), [["Send me the keys", false]]);
  });

  it("acts on each person's own mailbox alone", async () => {
    await seam("bea", T.bea);
    google.add(T.bea, { from: "Hal <hal@acme.example>", subject: "For Bea", text: "hi bea" });
    const n = calls.length;
    assert.deepEqual((await step("stadeum/gmail/search", { query: "lunch" }, "bea")).messages, [], "none of Ada's");
    assert.deepEqual((await step("stadeum/gmail/search", { query: "bea" }, "bea")).messages.map((m: any) => m.subject), ["For Bea"]);
    assert.ok(since(n).every((c) => c.auth === `Bearer ${T.bea}`), "Bea's token alone");
    assert.match(await failed("stadeum/gmail/read", { thread: bobThread[0]!.threadId }, "bea"), /no thread .* in your mailbox/, "Ada's thread is not in Bea's mailbox");
  });

  it("tells a person whose connection allows no drafts to connect again", async () => {
    const n = calls.length;
    for (const s of ["stadeum/gmail/draft", "stadeum/gmail/send"]) {
      assert.match(await failed(s, { to: "bob@acme.example", subject: "Hi", text: "hi" }, "bea"), /your Google connection does not allow this: connect Google again, in the Gmail app/, s);
    }
    assert.equal(since(n).filter((c) => c.method === "POST").length, 2);
    assert.equal([...bea.messages.values()].filter((m) => !m.labelIds.includes("INBOX")).length, 0, "nothing kept");
  });

  it("says when Google no longer takes a person's token", async () => {
    await seam("gus", T.gone);
    assert.deepEqual(await ok(page("gus")("stadeum/gmail/me")), { connected: true, refused: true });
    assert.match(await failed("stadeum/gmail/search", { query: "x" }, "gus"), /Google no longer accepts your connection \(it was revoked or it expired\): connect Google again/);
    await strut.app.request("/actors/gus/secrets/GOOGLE_TOKEN", { method: "DELETE" });
  });

  it("disconnects only from the Gmail app: not from another app, a preview, or a workflow", async () => {
    const elsewhere = await page("ada", OTHER_APP)("stadeum/gmail/disconnect");
    assert.match(elsewhere.error ?? "", /disconnecting Google is a person's own click in the Gmail app \(stadeum\/gmail\/gmail\), not from acme\/other\/console/);
    const preview = await page("ada", APP, "preview-abc")("stadeum/gmail/disconnect");
    assert.ok(preview.error, "a builder's preview of the app changes nothing");
    assert.match(await failed("stadeum/gmail/disconnect", {}, "ada"), /a person's own click in the Gmail app/);
    assert.equal(await hasOwn("ada"), true, "still connected");
    assert.equal(google.revoked.has(T.ada), false);
  });

  it("disconnects by revoking the grant at Google, the token in a form body and no other credential, then removing it", async () => {
    const n = calls.length;
    assert.deepEqual(await ok(page("ada")("stadeum/gmail/disconnect")), { removed: true, revoked: true });
    const made = since(n);
    assert.deepEqual(made.map((c) => [c.method, c.url, c.auth]), [["POST", "https://oauth2.googleapis.com/revoke", undefined]]);
    assert.equal(made[0]!.body, new URLSearchParams({ token: T.ada }).toString());
    assert.equal(google.revoked.has(T.ada), true);
    assert.equal(await hasOwn("ada"), false);
    assert.deepEqual(await ok(page("ada")("stadeum/gmail/me")), { connected: false });
    assert.deepEqual(await ok(page("ada")("stadeum/gmail/disconnect")), { removed: false });
  });

  it("removes a token Google would not revoke, and says where the person removes the access", async () => {
    await seam("dan", T.dan);
    assert.deepEqual(await ok(page("dan")("stadeum/gmail/disconnect")), {
      removed: true,
      revoked: false,
      why: "Google answered 400: Token expired or revoked",
      manage: "https://myaccount.google.com/connections",
    });
    assert.equal(await hasOwn("dan"), false);
  });

  it("sends a token to Google alone, and never the deployment's", () => {
    assert.ok(calls.length > 0);
    for (const c of calls) assert.ok(c.url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/") || c.url === "https://oauth2.googleapis.com/revoke", c.url);
    assert.ok(!JSON.stringify(calls).includes(T.deployment), "the deployment's GOOGLE_TOKEN was never sent");
  });

  it("puts no token in any output, error, run, event, node, file or log", async () => {
    const control = `control-${hex(6)}`;
    assert.equal((await once("graph/create-node", { node_type: "Concept", node_data: { name: control, description: "A value to find in the graph's bytes." } }, "root")).status, "success");
    const leaks = (text: string) => ALL_TOKENS.filter((t) => text.includes(t));
    assert.deepEqual(leaks(seen.join("\n")), [], "what a page or a workflow was given");
    assert.deepEqual(leaks(JSON.stringify([...store.events.entries()])), [], "events");
    assert.deepEqual(leaks(JSON.stringify([...store.summaries.entries()])), [], "run summaries");
    assert.deepEqual(leaks(logged.join("\n")), [], "logs");
    const walk = async (dir: string): Promise<string[]> =>
      (await readdir(dir, { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [join(dir, e.name)])).concat(
        ...(await Promise.all((await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => walk(join(dir, e.name))))),
      );
    let found = false;
    for (const file of await walk(root)) {
      const bytes = (await readFile(file)).toString("latin1");
      assert.deepEqual(leaks(bytes), [], file);
      found ||= bytes.includes(control);
    }
    assert.ok(found, "the scan found a value the graph holds, so it would find a token there");
    assert.ok(seen.length > 20, "and it read what pages and workflows were given");
  });
});
