import { z, defineStep } from "strut";
import { LISTED, LOOK_BACK_MS, NEW_MAX, asCtx, idsOf, isDraft, mailOf, messagesOf, needToken, readCursor, timeOf, withoutDrafts, writeCursor } from "./_gmail.js";
import { mail } from "./_shape.js";

export default defineStep({
  type: "stadeum/gmail/new",
  description:
    "Mail in the person's own mailbox that matches a Gmail search and came after `since`, oldest first, with `since` for the next call: where this one stopped. " +
    "With no `since` it hands over no mail, only where to start, so a first run never takes a backlog. At most 50 at a time; `more` when the rest waits for the next call. " +
    "Each message comes with `mine` (this mailbox sent it) and `machine` (a list or a machine did). Drafts are never handed over.",
  effect: "read",
  input: z.object({
    search: z.string().max(1_000).describe("A Gmail search, as in Gmail's search box: `in:inbox category:primary`. Empty for all mail"),
    since: z.string().max(20_000).optional().describe("Where the last call stopped: its `since`, passed back as it was"),
  }),
  output: z.object({
    messages: z.array(mail),
    since: z.string().describe("Where this call stopped: pass it back next time"),
    more: z.boolean().optional().describe("More mail came than one call hands over: call again with `since`"),
  }),
  async run(cfg, ctx) {
    const c = asCtx(ctx);
    const token = await needToken(c);
    const now = Date.now();
    if (!cfg.since?.trim()) return { messages: [], since: writeCursor({ after: now, seen: new Map() }) };
    const cur = readCursor(cfg.since);
    // Gmail's search takes seconds; a second early, and each message's own time decides.
    const q = `${withoutDrafts(cfg.search)} after:${Math.max(0, Math.floor(cur.after / 1000) - 1)}`;
    const { ids, over } = await idsOf(c, token, q, LISTED);
    if (over) throw new Error(`more than ${LISTED} messages match since the last look: narrow the search`);
    const fetched = await messagesOf(c, token, ids.filter((id) => !cur.seen.has(id)));
    const fresh = fetched.filter((m) => timeOf(m) >= cur.after).sort((a, b) => timeOf(a) - timeOf(b) || (a.id ?? "").localeCompare(b.id ?? ""));
    const drafts = fresh.filter(isDraft);
    const mailIn = fresh.filter((m) => !isDraft(m));
    const handed = mailIn.slice(0, NEW_MAX);
    const left = mailIn[NEW_MAX];
    // It looks back a while each time, since Gmail's search can see new mail
    // late; and never past mail it has not handed over yet.
    const after = Math.max(cur.after, Math.min(now - LOOK_BACK_MS, left ? timeOf(left) : Infinity));
    const seen = new Map<string, number>();
    for (const [id, at] of cur.seen) if (at >= after) seen.set(id, at);
    for (const m of [...handed, ...drafts]) if (timeOf(m) >= after) seen.set(m.id!, timeOf(m));
    return { messages: handed.map(mailOf), since: writeCursor({ after, seen }), ...(left ? { more: true } : {}) };
  },
});
