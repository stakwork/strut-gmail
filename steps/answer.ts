import { z, defineStep } from "strut";
import { asCtx, compose, createDraft, messageOf, needToken, threadOf, updateDraft } from "./_gmail.js";
import { dbOf, draftIn, handledOf, personOf, record, standDown, type ReplyCtx } from "./_replies.js";

const address = z.object({ address: z.string(), name: z.string().optional() });

export default defineStep({
  type: "stadeum/gmail/answer",
  description:
    "Act on what a model wrote for one message in the person's own mailbox, once. It stands down as `context` does (`stood-down` and `why`). " +
    "A `reply` becomes a draft in Gmail, in the message's thread, in place of one it left there before; the person edits and sends it in Gmail. " +
    "A `handoff` lists the thread under Needs you in the Gmail app with that reason, beside the draft if there was a reply too. Neither: nothing. " +
    "The recipient is the step's (the message's Reply-To, or its sender), never the model's, and nothing is attached. What it did is kept in the Gmail app's database; a message it acted on before is `already`.",
  effect: "write",
  input: z.object({
    message: z.string().describe("The message's id, as `context` had it"),
    reply: z.string().max(20_000).optional().describe("The reply's text, plain"),
    handoff: z.string().max(1_000).optional().describe("Why the person should answer this themselves"),
  }),
  output: z.object({
    did: z.enum(["draft", "handoff", "nothing", "stood-down", "already"]),
    why: z.string().optional(),
    thread: z.string().optional(),
    draft: z.string().optional(),
    to: z.array(address).optional(),
  }),
  async run(cfg, ctx) {
    const c = asCtx(ctx) as ReplyCtx;
    const token = await needToken(c);
    const actor = personOf(c);
    const db = await dbOf(c);
    const before = handledOf(db, actor, cfg.message);
    if (before) return { did: "already" as const, thread: before.thread };
    const m = await messageOf(c, token, cfg.message);
    if (!m?.threadId) return { did: "stood-down" as const, why: "it is gone from the mailbox" };
    const thread = m.threadId;
    const why = standDown(m, await threadOf(c, token, thread));
    if (why) {
      record(db, actor, { message: cfg.message, thread, did: "stood-down", reason: why });
      return { did: "stood-down" as const, why, thread };
    }
    const reply = cfg.reply?.trim();
    const handoff = cfg.handoff?.trim().replace(/\s+/g, " ");
    let left: { draft: string; to: Array<{ address: string; name?: string }> } | undefined;
    if (reply) {
      // A reply to the thread's latest message, which is this one: to its
      // Reply-To or its sender, as the step works it out.
      const out = await compose(c, token, { thread, text: reply });
      const earlier = draftIn(db, actor, thread);
      const kept = (earlier ? await updateDraft(c, token, earlier, out.raw, out.threadId) : false) || (await createDraft(c, token, out.raw, out.threadId));
      left = { draft: kept.draft, to: out.to };
    }
    const did = handoff ? ("handoff" as const) : reply ? ("draft" as const) : ("nothing" as const);
    record(db, actor, { message: cfg.message, thread, did, draft: left?.draft ?? null, reason: handoff || null });
    return { did, thread, ...(handoff ? { why: handoff } : {}), ...(left ?? {}) };
  },
});
