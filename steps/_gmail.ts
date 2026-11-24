/**
 * What every step of stadeum/gmail shares: who may call, the person's own
 * token, Gmail's API through strut's `http`, a message in the package's
 * shape, and a message to draft or send.
 *
 * A mailbox is whoever's token the run has. A step reads the run's person's
 * own `GOOGLE_TOKEN` (`secrets.own`, which strut gives a package for the
 * secrets it provides) and never `secrets.get`, which would fall back to a
 * deployment's value. No step takes a person or an address to act for, and
 * the package keeps nothing: a step reads Gmail, or writes to it, and
 * answers.
 *
 * A token goes to Google alone, in a header (or, to revoke it, in the body
 * Google's revoke takes), and never into an output, an error or a log.
 */

/** This package's own app: where a person connects and disconnects. */
export const APP = "stadeum/gmail/gmail";
/** The secret a person's Google token is, as the connect seam names it. */
export const SECRET = "GOOGLE_TOKEN";
/** Gmail's API for the token's own mailbox: the only address mail calls go to. */
export const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Google's revoke: the only other address a token is sent to. */
export const REVOKE = "https://oauth2.googleapis.com/revoke";
/** Where a person sees and removes the apps that reach their Google account. */
export const CONNECTIONS = "https://myaccount.google.com/connections";

/** How much of a message's text a step hands over. */
export const TEXT_MAX = 20_000;
/** How far back `new` looks each time: Gmail's search may see new mail a moment late. */
export const LOOK_BACK_MS = 10 * 60_000;
/** The most mail one `new` hands over: the rest waits for the next. */
export const NEW_MAX = 50;
/** The most message ids one search reads: ten of Gmail's pages. */
const LISTED_MAX = 1_000;
/** Messages read from Gmail at once. */
const AT_ONCE = 5;

interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
}
type Http = (
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: unknown; query?: Record<string, string | number | boolean>; timeout?: number },
) => Promise<HttpResponse>;

interface Scope {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** The part of strut's step context these steps read. */
export interface Ctx {
  /** Set by strut's app door on a page's call: the app, named from the
   *  identity strut signed for the page. */
  app?: { name: string; version?: string; admin?: boolean };
  /** Set when a host (a host key) made the call, not a page. */
  host?: unknown;
  services?: {
    http?: Http;
    /** `own`: the run's person's own values of what the package provides,
     *  present wherever the run has a person. */
    secrets?: { own?: Scope };
  };
}

export const asCtx = (ctx: unknown): Ctx => ctx as Ctx;

// ── who may call ──────────────────────────────────────────────────────────

/** A call from this package's own Gmail app, its published version (not a
 *  builder's preview), and a page's, not a host's. */
export function fromOwnApp(ctx: Ctx): boolean {
  const app = ctx.app;
  return app?.name === APP && !app.version?.startsWith("preview-") && !ctx.host;
}

/** A person's Google connection ends only by their own click in the Gmail app. */
export function requireOwnApp(ctx: Ctx, doing: string): void {
  if (fromOwnApp(ctx)) return;
  const from = ctx.app ? (ctx.app.name === APP ? "a preview of it" : ctx.app.name) : ctx.host ? "a host" : undefined;
  throw new Error(`${doing} is a person's own click in the Gmail app (${APP})${from ? `, not from ${from}` : ""}`);
}

// ── the person's own token ────────────────────────────────────────────────

/** The run's person's own secrets, or why there are none: a call that is nobody's. */
export function own(ctx: Ctx): Scope {
  const scope = ctx.services?.secrets?.own;
  if (!scope) throw new Error("this call is nobody's: a mailbox is a person's own, connected by them in the Gmail app");
  return scope;
}

/** The person's own token, never the deployment's, or none. */
export const tokenOf = (ctx: Ctx): Promise<string | undefined> => own(ctx).get(SECRET);

/** The person's own token, or why a mail step can't run. */
export async function needToken(ctx: Ctx): Promise<string> {
  const token = await tokenOf(ctx);
  if (!token) throw new Error("connect Google first, in the Gmail app: a mail step reads and writes your own mailbox");
  return token;
}

// ── Google, through strut's http ──────────────────────────────────────────

/** Google's access and refresh tokens, by their shapes. */
const TOKEN_LIKE = /\b(?:ya29\.[A-Za-z0-9._-]{6,}|1\/\/[A-Za-z0-9._-]{6,})/g;

/** Text from Google or the network, safe to show: no token in it, short. */
export function scrub(text: string, ...secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[a token]");
  return out.replace(TOKEN_LIKE, "[a token]").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** What Google said in an error, scrubbed. Gmail answers `{ error: { message } }`,
 *  Google's OAuth `{ error, error_description }`. */
export function said(res: HttpResponse, token?: string): string {
  const body = res.body && typeof res.body === "object" ? (res.body as Record<string, unknown>) : {};
  const err = body["error"];
  const text =
    err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : typeof body["error_description"] === "string"
        ? body["error_description"]
        : typeof err === "string"
          ? err
          : "";
  return text ? scrub(text, token) : `HTTP ${res.status}`;
}

async function call(ctx: Ctx, url: string, opts: { token?: string; method?: string; headers?: Record<string, string>; body?: unknown; query?: Record<string, string | number> }): Promise<HttpResponse> {
  const http = ctx.services?.http;
  if (!http) throw new Error("stadeum/gmail reaches Gmail through strut's http, and this call has none");
  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) };
  try {
    return await http(url, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.query ? { query: opts.query } : {}),
      timeout: 30_000,
    });
  } catch (e) {
    throw new Error(`Gmail can't be reached (${scrub(e instanceof Error ? e.message : String(e), opts.token)}): try again`);
  }
}

/** One call of Gmail's API for the token's own mailbox: `path` under `users/me`. */
export function gmail(ctx: Ctx, token: string, path: string, opts: { method?: string; body?: unknown; query?: Record<string, string | number> } = {}): Promise<HttpResponse> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) throw new Error(`not a path of Gmail's API: ${path}`);
  return call(ctx, `${API}${path}`, { token, ...opts });
}

/** A refusal of a call made with the person's token, said so they can act on it. */
export function refused(res: HttpResponse, token: string, what: string): Error {
  const why = said(res, token);
  if (res.status === 401) return new Error("Google no longer accepts your connection (it was revoked or it expired): connect Google again, in the Gmail app");
  if (res.status === 403 && /scope|insufficient/i.test(why)) return new Error("your Google connection does not allow this: connect Google again, in the Gmail app");
  if (res.status === 429 || res.status >= 500) return new Error(`Gmail is busy and did not ${what} (${res.status}): try again`);
  return new Error(`Gmail did not ${what}: ${why}`);
}

/** The mailbox's own address: Gmail's profile. `refused` when Google no longer takes the token. */
export async function profileOf(ctx: Ctx, token: string): Promise<{ address: string } | { refused: true }> {
  const res = await gmail(ctx, token, "/profile");
  if (res.status === 401) return { refused: true };
  if (!res.ok) throw refused(res, token, "say which mailbox this is");
  const address = (res.body as { emailAddress?: unknown } | undefined)?.emailAddress;
  if (typeof address !== "string" || !isAddress(address)) throw new Error("Gmail's profile names no address");
  return { address };
}

/**
 * Revoke a token at Google: `POST oauth2.googleapis.com/revoke` with the
 * token in a form body. Revoking an access token revokes its refresh token
 * too, so it ends the whole grant. `revoked: false` says why, never throws:
 * a token is removed from the box whether or not Google answered.
 */
export async function revoke(ctx: Ctx, token: string): Promise<{ revoked: true } | { revoked: false; why: string }> {
  try {
    const res = await call(ctx, REVOKE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    if (res.ok) return { revoked: true };
    return { revoked: false, why: `Google answered ${res.status}: ${said(res, token)}` };
  } catch (e) {
    return { revoked: false, why: scrub(e instanceof Error ? e.message : String(e), token) };
  }
}

// ── a message, as the package hands it over ───────────────────────────────

export interface Address {
  address: string;
  name?: string;
}

/** A message, in a shape that names nothing of Gmail's: an Outlook package could hand over the same. */
export interface Mail {
  id: string;
  thread: string;
  from?: Address;
  to: Address[];
  cc: Address[];
  /** Where the sender asked replies to go, when it is not `from`. */
  replyTo?: Address[];
  subject: string;
  /** When the mailbox got it (or sent it), ISO 8601. */
  date: string;
  text: string;
  /** The text was longer than `TEXT_MAX` characters and was cut there. */
  truncated?: true;
  /** The names of its attachments, never their contents. */
  attachments: string[];
  /** This mailbox sent it: Gmail marked it SENT, which mail from outside can't set. */
  mine: boolean;
  /** A list or a machine sent it. */
  machine: boolean;
}

interface GHeader {
  name?: string;
  value?: string;
}
interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: GHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GPart[];
}
export interface GMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GPart;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isId = (id: unknown): id is string => typeof id === "string" && ID.test(id);

export function header(part: GPart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  const h = part?.headers?.find((x) => x.name?.toLowerCase() === lower);
  return typeof h?.value === "string" ? h.value : undefined;
}

/** When Gmail got the message (or sent it), in ms: its `internalDate`. */
export const timeOf = (m: GMessage): number => {
  const n = Number(m.internalDate);
  return Number.isFinite(n) ? n : 0;
};

export const labelled = (m: GMessage, label: string): boolean => (m.labelIds ?? []).includes(label);
/** A draft is not mail yet: no step hands one over. */
export const isDraft = (m: GMessage): boolean => labelled(m, "DRAFT");
/** Gmail puts SENT on what the mailbox sent, through the API or Gmail itself, and lets no one put it on by hand. */
export const isMine = (m: GMessage): boolean => labelled(m, "SENT");

const ADDRESS = /^[^\s@<>()[\],;:"\\]{1,64}@[^\s@<>()[\],;:"\\]{1,253}$/;
export const isAddress = (s: string): boolean => ADDRESS.test(s) && s.split("@")[1]!.includes(".");

/** One address as a header writes it: `Name <a@b>`, `"Name" <a@b>` or `a@b`. */
function oneAddress(raw: string): Address | undefined {
  const s = raw.replace(/\([^()]*\)/g, " ").trim();
  if (!s) return undefined;
  const m = /^(.*)<([^<>]*)>\s*$/.exec(s);
  const address = (m ? m[2]! : s).trim();
  if (!isAddress(address)) return undefined;
  let name = m ? m[1]!.trim() : "";
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  name = name.trim().slice(0, 200);
  return name && name !== address ? { address, name } : { address };
}

/** The addresses in a header such as To or Cc: commas inside quotes and
 *  brackets kept, a group's name dropped, anything not an address left out. */
export function addressesOf(raw: string | undefined): Address[] {
  if (!raw) return [];
  const out: Address[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  const push = () => {
    const a = oneAddress(cur);
    if (a) out.push(a);
    cur = "";
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted) {
      cur += c;
      if (c === "\\" && i + 1 < raw.length) cur += raw[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if ((c === "," || c === ";") && !angle) {
      push();
      continue;
    } else if (c === ":" && !angle) {
      cur = ""; // a group's name: "Team: a@b, c@d;"
      continue;
    }
    cur += c;
  }
  push();
  return out.slice(0, 100);
}

const MACHINE_SENDER = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?)(?:[-_.+].*)?$/i;

/**
 * A list or a machine sent it: a `List-Id` or `List-Unsubscribe` header,
 * `Auto-Submitted` other than `no`, `Precedence` of `bulk`, `list` or
 * `junk`, an auto-reply's `X-Autoreply` or `X-Autorespond`, an empty
 * `Return-Path` (a bounce), or a sender such as `no-reply` or
 * `mailer-daemon`.
 */
export function isMachine(part: GPart | undefined, from: Address | undefined): boolean {
  if (header(part, "List-Id") !== undefined || header(part, "List-Unsubscribe") !== undefined) return true;
  const auto = header(part, "Auto-Submitted")?.trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if (/^(?:bulk|list|junk)$/i.test(header(part, "Precedence")?.trim() ?? "")) return true;
  if (header(part, "X-Autoreply") !== undefined || header(part, "X-Autorespond") !== undefined) return true;
  if (header(part, "Return-Path")?.replace(/\s/g, "") === "<>") return true;
  const local = from?.address.split("@")[0] ?? "";
  return MACHINE_SENDER.test(local);
}

const isAttachment = (p: GPart): boolean => !!p.filename || /^\s*attachment/i.test(header(p, "Content-Disposition") ?? "");

function find(part: GPart | undefined, want: (p: GPart) => boolean): GPart | undefined {
  if (!part) return undefined;
  if (want(part)) return part;
  for (const p of part.parts ?? []) {
    const found = find(p, want);
    if (found) return found;
  }
  return undefined;
}

function decodePart(p: GPart): string {
  const data = p.body?.data;
  if (!data) return "";
  const bytes = Buffer.from(data, "base64url");
  const charset = /charset\s*=\s*"?([^";\s]+)"?/i.exec(header(p, "Content-Type") ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** An HTML part's words, for mail that has no plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    });
}

/** A message's text: its plain part, or its HTML part's words. */
export function textOf(payload: GPart | undefined): string {
  const plain = find(payload, (p) => p.mimeType === "text/plain" && !isAttachment(p));
  const raw = plain ? decodePart(plain) : (() => {
    const html = find(payload, (p) => p.mimeType === "text/html" && !isAttachment(p));
    return html ? htmlToText(decodePart(html)) : "";
  })();
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function attachmentsOf(part: GPart | undefined, out: string[] = []): string[] {
  if (!part) return out;
  if (part.filename) out.push(part.filename.replace(/[\r\n]/g, " ").slice(0, 200));
  for (const p of part.parts ?? []) attachmentsOf(p, out);
  return out.slice(0, 50);
}

/** A message from Gmail (`format=full`) in the package's shape. */
export function mailOf(m: GMessage): Mail {
  const p = m.payload;
  const from = addressesOf(header(p, "From"))[0];
  const replyTo = addressesOf(header(p, "Reply-To"));
  const full = textOf(p);
  const sameAsFrom = replyTo.length === 1 && replyTo[0]!.address.toLowerCase() === from?.address.toLowerCase();
  return {
    id: m.id ?? "",
    thread: m.threadId ?? "",
    ...(from ? { from } : {}),
    to: addressesOf(header(p, "To")),
    cc: addressesOf(header(p, "Cc")),
    ...(replyTo.length && !sameAsFrom ? { replyTo } : {}),
    subject: (header(p, "Subject") ?? "").replace(/\s+/g, " ").trim(),
    date: new Date(timeOf(m)).toISOString(),
    text: full.slice(0, TEXT_MAX),
    ...(full.length > TEXT_MAX ? { truncated: true as const } : {}),
    attachments: attachmentsOf(p),
    mine: isMine(m),
    machine: isMachine(p, from),
  };
}

// ── reading ───────────────────────────────────────────────────────────────

/** Each of `items` through `fn`, a few at a time, in order. */
async function inTurn<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker));
  return out;
}

/** One message, whole; none when it is gone (deleted since it was listed). */
export async function messageOf(ctx: Ctx, token: string, id: string): Promise<GMessage | undefined> {
  const res = await gmail(ctx, token, `/messages/${encodeURIComponent(id)}`, { query: { format: "full" } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw refused(res, token, "show a message");
  return res.body as GMessage;
}

/** Messages by id, whole, those still there. */
export async function messagesOf(ctx: Ctx, token: string, ids: string[]): Promise<GMessage[]> {
  return (await inTurn(ids, (id) => messageOf(ctx, token, id))).filter((m): m is GMessage => !!m);
}

/** The ids of the messages a Gmail search finds, up to `max`; `over` when there were more. */
export async function idsOf(ctx: Ctx, token: string, q: string, max: number): Promise<{ ids: string[]; over: boolean }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail(ctx, token, "/messages", { query: { q, maxResults: Math.min(100, max - ids.length), ...(pageToken ? { pageToken } : {}) } });
    if (!res.ok) throw refused(res, token, "search your mail");
    const body = (res.body ?? {}) as { messages?: Array<{ id?: unknown }>; nextPageToken?: unknown };
    for (const m of body.messages ?? []) if (isId(m.id) && !ids.includes(m.id)) ids.push(m.id);
    pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
  } while (pageToken && ids.length < max);
  return { ids, over: !!pageToken };
}

/** A thread's messages, whole, oldest first. */
export async function threadOf(ctx: Ctx, token: string, thread: string): Promise<GMessage[]> {
  if (!isId(thread)) throw new Error(`not a thread's id: ${scrub(thread)}`);
  const res = await gmail(ctx, token, `/threads/${encodeURIComponent(thread)}`, { query: { format: "full" } });
  if (res.status === 404) throw new Error(`there is no thread ${thread} in your mailbox`);
  if (!res.ok) throw refused(res, token, "show the thread");
  const messages = ((res.body ?? {}) as { messages?: GMessage[] }).messages ?? [];
  return [...messages].sort((a, b) => timeOf(a) - timeOf(b));
}

export const LISTED = LISTED_MAX;

/** A person's search, with drafts left out at Gmail's end too: a draft is not mail yet. */
export const withoutDrafts = (search: string): string => (search.trim() ? `(${search.trim()}) -in:drafts` : "-in:drafts");

// ── where `new` stopped ───────────────────────────────────────────────────

/**
 * Where `new` stopped, as a string a workflow hands back: the time it
 * looks from (ms), and the messages since then it already handed over, each
 * with its time, so a look back hands none of them over twice.
 * `1732400000000;18c3f…@1732400012345,…`.
 */
export interface Cursor {
  after: number;
  seen: Map<string, number>;
}

export function writeCursor(c: Cursor): string {
  const seen = [...c.seen].map(([id, at]) => `${id}@${at}`).join(",");
  return seen ? `${c.after};${seen}` : `${c.after}`;
}

export function readCursor(raw: string): Cursor {
  const bad = () => new Error("`since` is not where an earlier `new` stopped: pass back its `since`, as it gave it");
  const m = /^(\d{1,16})(?:;(.*))?$/.exec(raw.trim());
  if (!m) throw bad();
  const seen = new Map<string, number>();
  for (const one of m[2] ? m[2].split(",") : []) {
    const at = /^([A-Za-z0-9_-]{1,128})@(\d{1,16})$/.exec(one);
    if (!at) throw bad();
    seen.set(at[1]!, Number(at[2]));
  }
  return { after: Number(m[1]), seen };
}

// ── a message to draft or send ────────────────────────────────────────────

const CRLF = "\r\n";

/** A header's text with no line breaks in it: nothing a value holds can start a header of its own. */
const oneLine = (s: string): string => s.replace(/[\r\n\0]+/g, " ").trim();

const ascii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

/** Text for a header, as RFC 2047 words when it is not plain ASCII. */
function encodeWords(s: string): string {
  if (ascii(s)) return s;
  const words: string[] = [];
  let chunk = "";
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

export function formatAddress(a: Address): string {
  if (!isAddress(a.address)) throw new Error(`not an address: ${scrub(a.address)}`);
  const name = a.name ? oneLine(a.name) : "";
  if (!name) return a.address;
  const shown = ascii(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodeWords(name);
  return `${shown} <${a.address}>`;
}

/** Recipients a workflow names: an address, `Name <address>`, or a list of them. */
export function recipients(to: string | string[] | undefined): Address[] {
  if (to === undefined) return [];
  const list = Array.isArray(to) ? to : [to];
  const out: Address[] = [];
  for (const raw of list) {
    if (/[\r\n\0]/.test(raw)) throw new Error("a recipient can't have a line break in it");
    const found = addressesOf(raw);
    const parts = raw.split(/[,;]/).filter((s) => s.trim()).length;
    if (!found.length || found.length < parts) throw new Error(`not an address: ${scrub(raw).slice(0, 100)}`);
    out.push(...found);
  }
  if (out.length > 50) throw new Error("at most 50 recipients");
  return out;
}

/** A reply's subject: the thread's, with `Re:` once. */
export function replySubject(subject: string): string {
  const s = oneLine(subject);
  if (!s) return "Re:";
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

const MSG_ID = /<[^<>\s]{1,500}>/g;

/** What a reply to `m` carries so Gmail keeps it in the thread: In-Reply-To
 *  its Message-ID, References its References and its Message-ID. */
export function threading(m: GMessage): { inReplyTo?: string; references: string[] } {
  const id = header(m.payload, "Message-ID")?.match(MSG_ID)?.[0];
  const refs = header(m.payload, "References")?.match(MSG_ID) ?? [];
  const all = [...refs.filter((r) => r !== id), ...(id ? [id] : [])];
  // Long chains keep the first and the latest, as mail clients trim them.
  const references = all.length > 20 ? [all[0]!, ...all.slice(-19)] : all;
  return { ...(id ? { inReplyTo: id } : {}), references };
}

/** Who a reply to `m` goes to: its Reply-To or its sender; for the mailbox's own message, whom it went to. */
export function replyTargets(m: GMessage): Address[] {
  const p = m.payload;
  if (isMine(m)) return addressesOf(header(p, "To"));
  const replyTo = addressesOf(header(p, "Reply-To"));
  if (replyTo.length) return replyTo;
  return addressesOf(header(p, "From")).slice(0, 1);
}

/** The message a reply in a thread answers: its latest that is not a draft. */
export function answered(thread: GMessage[]): GMessage | undefined {
  return [...thread].reverse().find((m) => !isDraft(m));
}

export interface Outgoing {
  from: Address;
  to: Address[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}

/** An RFC 2822 message, base64url as Gmail's `raw` takes it. */
export function rawOf(o: Outgoing): string {
  const lines = [
    `From: ${formatAddress(o.from)}`,
    `To: ${o.to.map(formatAddress).join(`,${CRLF} `)}`,
    `Subject: ${encodeWords(oneLine(o.subject))}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${oneLine(o.inReplyTo)}`] : []),
    ...(o.references?.length ? [`References: ${o.references.map(oneLine).join(`${CRLF} `)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(o.text.replace(/\r\n?/g, "\n").replace(/\n/g, CRLF), "utf8").toString("base64").replace(/.{1,76}/g, (l) => l + CRLF);
  return Buffer.from(lines.join(CRLF) + CRLF + CRLF + body, "utf8").toString("base64url");
}

/** The mailbox's own From: its default send-as address and name, as Gmail's settings say. */
export async function senderOf(ctx: Ctx, token: string): Promise<Address> {
  const res = await gmail(ctx, token, "/settings/sendAs");
  if (!res.ok) throw refused(res, token, "say which address mail goes out from");
  const list = ((res.body ?? {}) as { sendAs?: Array<{ sendAsEmail?: unknown; displayName?: unknown; isDefault?: unknown; isPrimary?: unknown }> }).sendAs ?? [];
  const pick = list.find((s) => s.isDefault === true) ?? list.find((s) => s.isPrimary === true) ?? list[0];
  const address = typeof pick?.sendAsEmail === "string" ? pick.sendAsEmail : "";
  if (!isAddress(address)) throw new Error("Gmail's settings name no address to send from");
  const name = typeof pick?.displayName === "string" ? oneLine(pick.displayName).slice(0, 200) : "";
  return name ? { address, name } : { address };
}

/** What `draft` and `send` take. */
export interface Compose {
  thread?: string;
  to?: string | string[];
  subject?: string;
  text: string;
}

/**
 * A message ready for Gmail: in a thread, a reply to its latest message
 * (to whoever sent it, or its Reply-To; for the mailbox's own message, to
 * whom it went), with the thread's subject and the headers that keep it
 * there; or a new one, to `to`. `to` names the recipients either way.
 */
export async function compose(ctx: Ctx, token: string, cfg: Compose): Promise<{ raw: string; threadId?: string; to: Address[] }> {
  if (!cfg.text.trim()) throw new Error("say something: `text` is empty");
  const named = recipients(cfg.to);
  const from = await senderOf(ctx, token);
  if (cfg.thread !== undefined) {
    if (cfg.subject !== undefined) throw new Error("a reply keeps its thread's subject: leave out `subject`, or leave out `thread` for a new message");
    const thread = await threadOf(ctx, token, cfg.thread);
    const m = answered(thread);
    if (!m) throw new Error(`thread ${cfg.thread} has no message to reply to`);
    const to = named.length ? named : replyTargets(m);
    if (!to.length) throw new Error("the message names no one to reply to: say whom, with `to`");
    const subject = replySubject(header(m.payload, "Subject") ?? "");
    return { raw: rawOf({ from, to, subject, text: cfg.text, ...threading(m) }), threadId: cfg.thread, to };
  }
  if (!named.length) throw new Error("say whom it is to, with `to`, or which thread it answers, with `thread`");
  return { raw: rawOf({ from, to: named, subject: cfg.subject ?? "", text: cfg.text }), to: named };
}
