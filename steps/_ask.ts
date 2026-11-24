/**
 * What `ask`'s steps share: the +jamie address, the mark an answer
 * carries, the app's records of threads, jobs and turns, and what an
 * answer says.
 *
 * The records hold ids alone: a thread, the job it is, each turn's message
 * and the job's run for it, the answer's draft and message. Never mail,
 * never an address.
 */
import type { DatabaseSync } from "node:sqlite";
import { addressesOf, header, scrub, type GMessage } from "./_gmail.js";

/** The tag a person's own address takes to reach Jamie: `name+jamie@`. */
export const TAG = "jamie";
/** The header every answer carries: the job's run it answers. A later look knows its own answer by it. */
export const ANSWER_MARK = "X-Jamie-Answer";
/** The most of a job's reply an answer carries. */
const ANSWER_MAX = 50_000;

/** A person's address with +jamie, their own +tag taken off first. */
export function jamieAddress(address: string): string | undefined {
  const at = address.lastIndexOf("@");
  if (at < 1) return undefined;
  const local = address.slice(0, at).replace(/\+.*$/, "");
  return local ? `${local}+${TAG}@${address.slice(at + 1)}` : undefined;
}

/** The message went to the +jamie address. */
export const toJamie = (m: GMessage, jamie: string): boolean =>
  ["To", "Cc"].some((h) => addressesOf(header(m.payload, h)).some((a) => a.address.toLowerCase() === jamie.toLowerCase()));

/** One of `ask`'s own answers, by its mark. */
export const isAnswer = (m: GMessage): boolean => header(m.payload, ANSWER_MARK) !== undefined;

/**
 * The person's own words in a reply: the text above the quoted mail
 * (Gmail's "On … wrote:" line, or lines that start with `>`).
 */
export function ownWords(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*On .+wrote:\s*$/.test(line) || /^\s*>/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

// ── the records ───────────────────────────────────────────────────────────

export type TurnState = "waiting" | "running" | "sending" | "answered";

export interface Turn {
  message: string;
  thread: string;
  job: string | null;
  run: string | null;
  state: TurnState;
  draft: string | null;
  answer: string | null;
  failed: number;
  at: string;
}

const now = () => new Date().toISOString();
const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

export function turnOf(db: DatabaseSync, actor: string, message: string): Turn | undefined {
  const row = db.prepare("SELECT * FROM ask_turns WHERE actor = ? AND message = ?").get(actor, message);
  return row ? plain<Turn>(row) : undefined;
}

/** The person's turns in these states, oldest first. */
export function turnsIn(db: DatabaseSync, actor: string, states: TurnState[]): Turn[] {
  const marks = states.map(() => "?").join(", ");
  return (db.prepare(`SELECT * FROM ask_turns WHERE actor = ? AND state IN (${marks}) ORDER BY at, rowid`).all(actor, ...states) as unknown[]).map((r) => plain<Turn>(r));
}

/** The job a thread is, once its first turn started one. */
export function jobOf(db: DatabaseSync, actor: string, thread: string): string | undefined {
  return (db.prepare("SELECT job FROM asks WHERE actor = ? AND thread = ?").get(actor, thread) as { job: string } | undefined)?.job;
}

/** The thread has a turn the job is on, or whose answer is going out: its next turn waits. */
export function busy(db: DatabaseSync, actor: string, thread: string): boolean {
  return !!db.prepare("SELECT 1 FROM ask_turns WHERE actor = ? AND thread = ? AND state IN ('running', 'sending') LIMIT 1").get(actor, thread);
}

/** Every answer `ask` sent the person: their mail no click of theirs sent. */
export function answerIds(db: DatabaseSync, actor: string): Set<string> {
  return new Set((db.prepare("SELECT answer FROM ask_turns WHERE actor = ? AND answer IS NOT NULL").all(actor) as Array<{ answer: string }>).map((r) => r.answer));
}

/** A turn that waits for its thread's last turn to be answered. */
export function wait(db: DatabaseSync, actor: string, message: string, thread: string, job: string | undefined): void {
  db.prepare("INSERT OR IGNORE INTO ask_turns (actor, message, thread, job, state, at) VALUES (?, ?, ?, ?, 'waiting', ?)").run(actor, message, thread, job ?? null, now());
}

/** A turn with nothing to send the job: the person's message held no words of their own. */
export function nothing(db: DatabaseSync, actor: string, message: string, thread: string): void {
  db.prepare("INSERT OR IGNORE INTO ask_turns (actor, message, thread, state, at) VALUES (?, ?, ?, 'answered', ?)").run(actor, message, thread, now());
}

/** A turn the job is on: its run, and the thread's job from its first turn on. */
export function started(db: DatabaseSync, actor: string, t: { message: string; thread: string; job: string; run: string }): void {
  const at = now();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR IGNORE INTO asks (actor, thread, job, at) VALUES (?, ?, ?, ?)").run(actor, t.thread, t.job, at);
    db.prepare(
      "INSERT INTO ask_turns (actor, message, thread, job, run, state, at) VALUES (?, ?, ?, ?, ?, 'running', ?) " +
        "ON CONFLICT (actor, message) DO UPDATE SET job = excluded.job, run = excluded.run, state = 'running'",
    ).run(actor, t.message, t.thread, t.job, t.run, at);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** The answer's draft is made: a run that stops here sends that draft next time, and no other. */
export function sending(db: DatabaseSync, actor: string, message: string, draft: string, failed: boolean): void {
  db.prepare("UPDATE ask_turns SET state = 'sending', draft = ?, failed = ? WHERE actor = ? AND message = ?").run(draft, failed ? 1 : 0, actor, message);
}

/** The turn is answered: by the message sent, when it is known. */
export function answered(db: DatabaseSync, actor: string, message: string, answer: string | null): void {
  db.prepare("UPDATE ask_turns SET state = 'answered', draft = NULL, answer = ? WHERE actor = ? AND message = ?").run(answer, actor, message);
}

// ── what an answer says ───────────────────────────────────────────────────

/** A job as strut's `job/get` reads it: the part an answer needs. */
export interface JobView {
  runs?: Array<{ runId?: string; status?: string; error?: unknown }>;
  text?: string;
  artifacts?: Array<{ title?: string; url?: string }>;
  urls?: Record<string, string>;
}

/** A run is over: it succeeded, failed or was cancelled. One still going, or parked, is not. */
export const ENDED = new Set(["success", "error", "cancelled"]);

/** The links an answer lists: each deliverable's, then each hold's (a pod), once each. */
export function linksOf(view: JobView): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const add = (title: string, url: unknown) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url) || out.some((l) => l.url === url)) return;
    out.push({ title: title.replace(/[\r\n]+/g, " ").trim().slice(0, 200) || url, url });
  };
  for (const a of view.artifacts ?? []) add(a.title ?? "", a.url);
  for (const [k, v] of Object.entries(view.urls ?? {})) add(k, v);
  return out;
}

/**
 * What the answer to a turn says: the job's reply and its links, or, for a
 * run that failed or was cancelled, that it did not finish.
 */
export function answerOf(view: JobView, run: { status?: string; error?: unknown }): { text: string; failed: boolean } {
  if (run.status !== "success") {
    const why = typeof run.error === "string" ? run.error : run.error && typeof run.error === "object" && typeof (run.error as { message?: unknown }).message === "string" ? (run.error as { message: string }).message : "";
    return { text: why ? `Jamie couldn't finish this: ${scrub(why).slice(0, 300)}` : "Jamie couldn't finish this.", failed: true };
  }
  const reply = (view.text ?? "").trim().slice(0, ANSWER_MAX) || "Done.";
  const links = linksOf(view);
  return { text: links.length ? `${reply}\n\n${links.map((l) => `${l.title}: ${l.url}`).join("\n")}` : reply, failed: false };
}
