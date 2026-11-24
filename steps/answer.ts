import { z, defineStep } from "strut";
import { addressesOf, asCtx, compose, createDraft, header, messageOf, needToken, sendDraft, threadOf, updateDraft } from "./_gmail.js";
import { dbOf, draftIn, handledOf, holdBack, personOf, record, sentIdsOf, settingsOf, standDown, writtenTo, type ReplyCtx } from "./_replies.js";

const address = z.object({ address: z.string(), name: z.string().optional() });

export default defineStep({
  type: "stadeum/gmail/answer",
  description:
    "Act on what a model wrote for one message in the person's own mailbox, once. It stands down as `context` does (`stood-down` and `why`). " +
    "A `reply` is sent when the person's choice in the Gmail app allows it, and is a draft in the message's thread otherwise, in place of one it left there before: " +
    "Draft sends nothing; Send to people I've written to sends to a sender the person has written to before; Send to anyone sends to any sender. " +
    "Under both, a reply is still a draft (`held` says why) when it would go to someone other than the sender, " +
    "or when 3 replies already went out without a click in the thread since the person last wrote in it. Mail to several people is answered to its sender alone. " +
    "A `handoff` is never sent: the thread goes under Needs you in the Gmail app with that reason, beside the draft if there was a reply too. Neither: nothing. " +
    "The recipient is the step's (the message's Reply-To, or its sender), never the model's, and nothing is attached. What it did is kept in the Gmail app's database; " +
    "a message it acted on before is `already`.",
  effect: "write",
  input: z.object({
    message: z.string().describe("The message's id, as `context` had it"),
    reply: z.string().max(20_000).optional().describe("The reply's text, plain"),
    handoff: z.string().max(1_000).optional().describe("Why the person should answer this themselves"),
  }),
  output: z.object({
    did: z.enum(["draft", "sent", "handoff", "nothing", "stood-down", "already"]),
    why: z.string().optional(),
    held: z.string().optional().describe("Why a reply the person's choice would have sent is a draft"),
    thread: z.string().optional(),
    draft: z.string().optional(),
    sent: z.string().optional().describe("The message sent"),
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
    const messages = await threadOf(c, token, thread);
    const why = standDown(m, messages);
    if (why) {
      record(db, actor, { message: cfg.message, thread, did: "stood-down", reason: why });
      return { did: "stood-down" as const, why, thread };
    }
    const reply = cfg.reply?.trim();
    const handoff = cfg.handoff?.trim().replace(/\s+/g, " ");
    if (!reply) {
      const did = handoff ? ("handoff" as const) : ("nothing" as const);
      record(db, actor, { message: cfg.message, thread, did, reason: handoff || null });
      return { did, thread, ...(handoff ? { why: handoff } : {}) };
    }

    // Whether the reply may go without a click: the person's choice, then
    // the step's own hold-backs. None of it reads what the model wrote.
    const { choice } = settingsOf(db, actor);
    let held: string | undefined;
    if (handoff && choice !== "draft") held = "the reply was handed to the person";
    else if (choice !== "draft") {
      const ours = sentIdsOf(db, actor);
      const sender = addressesOf(header(m.payload, "From"))[0]?.address;
      held = holdBack({
        m,
        thread: messages,
        ours,
        choice,
        writtenBefore: choice === "written" && !!sender && (await writtenTo(c, token, sender, ours)),
      });
    }
    const send = choice !== "draft" && !handoff && !held;

    // A reply to the thread's latest message, which is this one: to its
    // Reply-To or its sender, as the step works it out. Left as a draft in
    // place of the one before; sent from that draft, so none is left behind.
    const out = await compose(c, token, { thread, text: reply });
    const earlier = draftIn(db, actor, thread);
    const kept = (earlier ? await updateDraft(c, token, earlier, out.raw, out.threadId) : false) || (await createDraft(c, token, out.raw, out.threadId));
    if (send) {
      const sent = await sendDraft(c, token, kept.draft);
      record(db, actor, { message: cfg.message, thread, did: "sent", sent: sent.message });
      return { did: "sent" as const, thread, sent: sent.message, to: out.to };
    }
    const did = handoff ? ("handoff" as const) : ("draft" as const);
    record(db, actor, { message: cfg.message, thread, did, draft: kept.draft, reason: handoff || null, held: held ?? null });
    return { did, thread, draft: kept.draft, to: out.to, ...(handoff ? { why: handoff } : {}), ...(held ? { held } : {}) };
  },
});
