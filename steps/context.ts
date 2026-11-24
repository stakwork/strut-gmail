import { z, defineStep } from "strut";
import { asCtx, idsOf, isDraft, mailOf, messageOf, messagesOf, needToken, ownAddressesOf, replyTargets, threadOf, timeOf, withoutDrafts } from "./_gmail.js";
import { dbOf, handledOf, nonce, pagesOf, personOf, promptOf, sentIdsOf, settingsOf, standDown, systemOf, toSenderAlone, toSeveral, writtenTo, type ReplyCtx } from "./_replies.js";

const address = z.object({ address: z.string(), name: z.string().optional() });

/** How many earlier messages between the person and the sender the model reads. */
const EARLIER = 20;
/** The box's default model, which strut's `agent` runs on when it is named none (stadeum's Models page, "Org default"). */
const DEFAULT_MODEL = "STRUT_DEFAULT_MODEL";

export default defineStep({
  type: "stadeum/gmail/context",
  description:
    "What a reply to one message in the person's own mailbox is written from, or why there is none (`go` false and `why`): the mailbox's own mail, a list's or a machine's, " +
    "one answered before, or one its thread has moved past (the person answered in it, or newer mail came). " +
    "Otherwise `system`: the `Mail Replies` page and every page under it, then the person's own instructions from the Gmail app; " +
    "and `prompt`: the last 20 messages between the person and the sender, then the thread, each marked as mail. The thread alone when the mail went to more people than the person (`group`), " +
    "or when a reply would go to someone other than the sender (a Reply-To elsewhere): a reply is written from what its recipient has seen. " +
    "Also whom a reply goes to (`to`: the message's Reply-To, or its sender) and whether the person has written to the sender before (their own sent mail, not a reply sent for them). " +
    "The model is `model` when given, else the box's default (`model` left out): with neither, a reply to write fails the run, never falling to a model nobody chose.",
  effect: "read",
  input: z.object({
    message: z.string().describe("The message's id: a message's `id` from `new`"),
    model: z.string().optional().describe("The model to write with; blank or left out: the box's default"),
  }),
  output: z.object({
    go: z.boolean(),
    why: z.string().optional().describe("Why there is no reply to write"),
    message: z.string(),
    thread: z.string(),
    system: z.string(),
    prompt: z.string(),
    to: z.array(address).describe("Whom a reply goes to: the step's, never the model's"),
    group: z.boolean().describe("The mail went to more people than the person"),
    writtenBefore: z.boolean().describe("The person has written to the sender before, themselves"),
    model: z.string().optional().describe("The model named, for the agent; left out: the box's default"),
  }),
  async run(cfg, ctx) {
    const c = asCtx(ctx) as ReplyCtx;
    const token = await needToken(c);
    const actor = personOf(c);
    const db = await dbOf(c);
    const none = (why: string, thread = "") => ({ go: false, why, message: cfg.message, thread, system: "", prompt: "", to: [], group: false, writtenBefore: false });
    const before = handledOf(db, actor, cfg.message);
    if (before) return none("it was answered before", before.thread);
    const m = await messageOf(c, token, cfg.message);
    if (!m?.threadId) return none("it is gone from the mailbox");
    const thread = await threadOf(c, token, m.threadId);
    const why = standDown(m, thread);
    if (why) return none(why, m.threadId);
    const pages = await pagesOf(c);
    if (!pages.length) return none("the Mail Replies page is missing", m.threadId);
    const to = replyTargets(m);
    if (!to.length) return none("the message names no one to reply to", m.threadId);
    // A reply to write needs a model: the one named, else the box's default.
    // Strut's `agent` with neither falls to a built-in model nobody chose,
    // so the run fails here and says what to set.
    const model = cfg.model?.trim() || undefined;
    if (!model && !(await c.services?.secrets?.get?.(DEFAULT_MODEL))?.trim()) {
      throw new Error("no model to write replies with: choose the org default model on the Models page");
    }
    const mail = mailOf(m);
    const group = toSeveral(m, await ownAddressesOf(c, token));
    const sender = mail.from?.address;
    let earlier: ReturnType<typeof mailOf>[] = [];
    if (sender && !group && toSenderAlone(m)) {
      const { ids } = await idsOf(c, token, withoutDrafts(`from:${sender} OR to:${sender}`), EARLIER);
      earlier = (await messagesOf(c, token, ids))
        .filter((x) => x.threadId !== m.threadId && !isDraft(x))
        .sort((a, b) => timeOf(a) - timeOf(b))
        .map(mailOf);
    }
    const writtenBefore = sender ? await writtenTo(c, token, sender, sentIdsOf(db, actor)) : false;
    const { instructions } = settingsOf(db, actor);
    return {
      go: true,
      message: cfg.message,
      thread: m.threadId,
      system: systemOf(pages, instructions),
      prompt: promptOf(thread.filter((x) => !isDraft(x)).map(mailOf), earlier, nonce()),
      to,
      group,
      writtenBefore,
      ...(model ? { model } : {}),
    };
  },
});
