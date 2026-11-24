/**
 * What `reply`'s steps share: the person, the Gmail app's own database, the
 * `Mail Replies` pages, when a message is not to be answered, and how the
 * model is shown the mail.
 *
 * Every instruction the model reads is a Concept page's (`Mail Replies` and
 * the pages a box adds under it) or the person's own. The steps add no
 * words of their own: they lay the pages out by name and mark the mail as
 * mail, in tags the page explains.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { APP, isDraft, isMachine, isMine, mailOf, type Ctx, type GMessage, type Mail } from "./_gmail.js";

/** The package's page on how to answer mail; a box adds pages under it. */
export const PAGE = "Mail Replies";
/** The mail Replies answers, unless the person says otherwise. */
export const DEFAULT_SEARCH = "in:inbox category:primary to:me";

/** The most of one page's words, and of all of them, that go to the model. */
const PAGE_MAX = 8_000;
const PAGES_MAX = 30_000;
/** How many pages under `Mail Replies` are read, and how deep. */
const PAGES_COUNT = 30;
const PAGES_DEPTH = 3;
/** The most of one message's text the model reads: the thread's, and the earlier mail's. */
const THREAD_TEXT = 6_000;
const EARLIER_TEXT = 1_500;
export const INSTRUCTIONS_MAX = 10_000;
export const SEARCH_MAX = 1_000;

// ── the person and their database ─────────────────────────────────────────

/** The run's step context, as these steps read it. */
export interface ReplyCtx extends Ctx {
  /** Whose run this is: the person whose mailbox and choices it acts on. */
  principal?: string;
  registry?: Record<string, { input: { parse(v: unknown): unknown }; run(cfg: unknown, ctx: unknown): Promise<unknown> } | undefined>;
  services?: Ctx["services"] & { appDb?: { open(name: string): Promise<DatabaseSync> } };
}

/** The person a run is for: its principal. A call that is nobody's keeps nothing. */
export function personOf(ctx: ReplyCtx): string {
  const p = ctx.principal;
  if (!p) throw new Error("this call is nobody's: Replies are a person's own, and this run is for no one");
  return p;
}

/** The Gmail app's own database: one file for the app, every person's rows in it, by actor. */
export async function dbOf(ctx: ReplyCtx): Promise<DatabaseSync> {
  const dbs = ctx.services?.appDb;
  if (!dbs) throw new Error("stadeum/gmail keeps its Replies in its app's database, and this strut has none (ctx.services.appDb)");
  return dbs.open(APP);
}

export interface Settings {
  /** Replies is on: `reply` answers this person's mail. */
  replies: boolean;
  /** The mail it answers: a Gmail search. */
  search: string;
  /** The person's own instructions, after the shared pages. */
  instructions: string;
}

/** A person's choices; the defaults until they change one, so Replies is on from the moment they connect. */
export function settingsOf(db: DatabaseSync, actor: string): Settings {
  const row = db.prepare("SELECT replies, search, instructions FROM people WHERE actor = ?").get(actor) as { replies: number; search: string; instructions: string } | undefined;
  return row ? { replies: row.replies === 1, search: row.search, instructions: row.instructions } : { replies: true, search: DEFAULT_SEARCH, instructions: "" };
}

/** Change some of a person's choices. An empty search is the default one. */
export function saveSettings(db: DatabaseSync, actor: string, patch: Partial<Settings>): Settings {
  const next = { ...settingsOf(db, actor), ...patch };
  next.search = next.search.trim() || DEFAULT_SEARCH;
  db.prepare(
    "INSERT INTO people (actor, replies, search, instructions, updated_at) VALUES (:actor, :replies, :search, :instructions, :at) " +
      "ON CONFLICT (actor) DO UPDATE SET replies = excluded.replies, search = excluded.search, instructions = excluded.instructions, updated_at = excluded.updated_at",
  ).run({ actor, replies: next.replies ? 1 : 0, search: next.search, instructions: next.instructions, at: new Date().toISOString() });
  return next;
}

export type Did = "draft" | "handoff" | "nothing" | "stood-down";

export interface Handled {
  message: string;
  thread: string;
  did: Did;
  draft?: string | null;
  reason?: string | null;
  at: string;
}

/** What `answer` did with a message, if it did anything. */
export function handledOf(db: DatabaseSync, actor: string, message: string): Handled | undefined {
  return db.prepare("SELECT message, thread, did, draft, reason, at FROM handled WHERE actor = ? AND message = ?").get(actor, message) as Handled | undefined;
}

/** The draft `answer` left in a thread before, still its latest, if any. */
export function draftIn(db: DatabaseSync, actor: string, thread: string): string | undefined {
  const row = db.prepare("SELECT draft FROM handled WHERE actor = ? AND thread = ? AND draft IS NOT NULL ORDER BY at DESC LIMIT 1").get(actor, thread) as { draft: string } | undefined;
  return row?.draft;
}

/** Record what `answer` did with a message. The thread's earlier rows give up
 *  their draft: one draft is the thread's, and it is the latest row's. */
export function record(db: DatabaseSync, actor: string, h: Omit<Handled, "at">): void {
  const at = new Date().toISOString();
  db.exec("BEGIN");
  try {
    if (h.draft) db.prepare("UPDATE handled SET draft = NULL WHERE actor = ? AND thread = ?").run(actor, h.thread);
    db.prepare("INSERT INTO handled (actor, message, thread, did, draft, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(actor, h.message, h.thread, h.did, h.draft ?? null, h.reason ?? null, at);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Every draft `answer` left that is still a thread's latest. */
export function draftsLeft(db: DatabaseSync, actor: string): string[] {
  return (db.prepare("SELECT DISTINCT draft FROM handled WHERE actor = ? AND draft IS NOT NULL").all(actor) as Array<{ draft: string }>).map((r) => r.draft);
}

/** The threads handed to the person, newest first: each thread's latest handoff. */
export function handoffsOf(db: DatabaseSync, actor: string, limit = 20): Handled[] {
  return db
    .prepare(
      "SELECT h.message, h.thread, h.did, h.draft, h.reason, h.at FROM handled h WHERE h.actor = ? AND h.did = 'handoff' " +
        "AND h.at = (SELECT MAX(at) FROM handled x WHERE x.actor = h.actor AND x.thread = h.thread) ORDER BY h.at DESC LIMIT ?",
    )
    .all(actor, limit) as unknown as Handled[];
}

// ── when not to answer ────────────────────────────────────────────────────

/**
 * Why a message is not to be answered, or none. Held in the steps, so no
 * search, page or instruction loosens it: the mailbox's own mail, a list's
 * or a machine's, and a message the thread has moved past (the person
 * answered in it, or newer mail came).
 */
export function standDown(m: GMessage, thread: GMessage[]): string | undefined {
  if (isDraft(m)) return "it is a draft";
  if (isMine(m)) return "this mailbox sent it";
  if (isMachine(m.payload, mailOf(m).from)) return "a list or a machine sent it";
  const mail = thread.filter((x) => !isDraft(x));
  const at = mail.findIndex((x) => x.id === m.id);
  if (at < 0) return "it is no longer in its thread";
  const after = mail.slice(at + 1);
  if (after.some(isMine)) return "the person answered in the thread";
  if (after.length) return "a newer message came in the thread";
  return undefined;
}

// ── the pages ─────────────────────────────────────────────────────────────

export interface Page {
  name: string;
  ref: string;
  docs: string;
}

type GraphGetOut = { ref_id?: string; name?: string; node_type?: string; properties?: { docs?: unknown }; children?: Array<{ ref_id: string; node_type?: string; name: string }> } | string | undefined;

/**
 * `Mail Replies` and every page under it, read with strut's own
 * graph/graph-get by name and then by each child's ref_id, breadth first:
 * the package's page, then the box's own under it, each level in name
 * order. None when the box has no such page, or no graph.
 */
export async function pagesOf(ctx: ReplyCtx): Promise<Page[]> {
  const get = ctx.registry?.["graph/graph-get"];
  if (!get) throw new Error("stadeum/gmail reads its pages with strut's graph/graph-get, and this run's registry has none");
  const read = async (by: { name: string } | { ref_id: string }): Promise<{ page: Page; children: string[] } | undefined> => {
    const out = (await get.run(get.input.parse({ node_type: "Concept", ...by, children: "PARENT_OF" }), ctx)) as GraphGetOut;
    if (!out || typeof out === "string" || !out.ref_id) return undefined;
    const docs = typeof out.properties?.docs === "string" ? out.properties.docs.trim() : "";
    return {
      page: { name: out.name ?? "", ref: out.ref_id, docs: docs.length > PAGE_MAX ? `${docs.slice(0, PAGE_MAX)}…` : docs },
      children: (out.children ?? []).filter((c) => !c.node_type || c.node_type === "Concept").map((c) => c.ref_id),
    };
  };
  const first = await read({ name: PAGE });
  if (!first) return [];
  const pages: Page[] = [first.page];
  const seen = new Set([first.page.ref]);
  let level = first.children;
  for (let depth = 1; depth <= PAGES_DEPTH && level.length && pages.length < PAGES_COUNT; depth++) {
    const next: string[] = [];
    for (const ref of level) {
      if (seen.has(ref) || pages.length >= PAGES_COUNT) continue;
      seen.add(ref);
      const one = await read({ ref_id: ref });
      if (!one) continue;
      pages.push(one.page);
      next.push(...one.children);
    }
    level = next;
  }
  return pages;
}

/** The pages, then the person's own instructions: the model's system prompt. Names as headings, nothing else added. */
export function systemOf(pages: Page[], instructions: string): string {
  const parts: string[] = [];
  let left = PAGES_MAX;
  for (const p of pages) {
    if (left <= 0) break;
    const docs = p.docs.slice(0, left);
    left -= docs.length;
    parts.push(`# ${p.name}\n\n${docs}`);
  }
  const own = instructions.trim().slice(0, INSTRUCTIONS_MAX);
  if (own) parts.push(`# The person's own instructions\n\n${own}`);
  return parts.join("\n\n");
}

// ── the mail, as the model sees it ────────────────────────────────────────

/** A mark no mail can guess: each run's own, so a message can't close its own tag. */
export const nonce = (): string => randomBytes(6).toString("hex");

const attr = (s: string): string => s.replace(/[\r\n]+/g, " ").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const who = (a: { address: string; name?: string } | undefined): string => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : "");

/** One message, marked as mail: someone's words, never instructions (the page says so). */
export function mailBlock(m: Mail, mark: string, max: number): string {
  const text = (m.text.length > max ? `${m.text.slice(0, max)}…` : m.text).split(mark).join("");
  const attrs = [
    `from="${attr(who(m.from))}"`,
    `to="${attr(m.to.map(who).join(", "))}"`,
    ...(m.cc.length ? [`cc="${attr(m.cc.map(who).join(", "))}"`] : []),
    `date="${m.date}"`,
    `mine="${m.mine}"`,
    ...(m.attachments.length ? [`attachments="${attr(m.attachments.join(", "))}"`] : []),
  ];
  return `<mail ${attrs.join(" ")} mark="${mark}">\n${text}\n</mail mark="${mark}">`;
}

/**
 * The mail the model reads: the earlier mail between the person and the
 * sender, oldest first, then the thread, oldest first, whose last message
 * is the one to answer. Tags and attributes only; the page says what they
 * mean.
 */
export function promptOf(thread: Mail[], earlier: Mail[], mark: string): string {
  const parts: string[] = [];
  if (earlier.length) parts.push(`<earlier mark="${mark}">\n${earlier.map((m) => mailBlock(m, mark, EARLIER_TEXT)).join("\n")}\n</earlier mark="${mark}">`);
  parts.push(`<thread subject="${attr(thread[0]?.subject ?? "")}" mark="${mark}">\n${thread.map((m) => mailBlock(m, mark, THREAD_TEXT)).join("\n")}\n</thread mark="${mark}">`);
  return parts.join("\n\n");
}
