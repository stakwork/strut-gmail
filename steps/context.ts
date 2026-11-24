import { z, defineStep } from "strut";
import { asCtx, idsOf, isDraft, mailOf, messageOf, messagesOf, needToken, ownAddressesOf, plainAddress, replyTargets, threadOf, timeOf, withoutDrafts } from "./_gmail.js";
import { dbOf, handledOf, nonce, pagesOf, personOf, promptOf, settingsOf, standDown, systemOf, type ReplyCtx } from "./_replies.js";

const address = z.object({ address: z.string(), name: z.string().optional() });

/** How many earlier messages between the person and the sender the model reads. */
const EARLIER = 20;

export default defineStep({
  type: "stadeum/gmail/context",
  description:
    "What a reply to one message in the person's own mailbox is written from, or why there is none (`go` false and `why`): the mailbox's own mail, a list's or a machine's, " +
    "one answered before, or one its thread has moved past (the person answered in it, or newer mail came). " +
    "Otherwise `system`: the `Mail Replies` page and every page under it, then the person's own instructions from the Gmail app; " +
    "and `prompt`: the last 20 messages between the person and the sender, then the thread, each marked as mail. When the mail went to more people than the person (`group`), the thread alone. " +
    "Also whom a reply goes to (`to`: the message's Reply-To, or its sender) and whether the person has written to the sender before.",
  effect: "read",
  input: z.object({ message: z.string().describe("The message's id: a message's `id` from `new`") }),
  output: z.object({
    go: z.boolean(),
    why: z.string().optional().describe("Why there is no reply to write"),
    message: z.string(),
    thread: z.string(),
    system: z.string(),
    prompt: z.string(),
    to: z.array(address).describe("Whom a reply goes to: the step's, never the model's"),
    group: z.boolean().describe("The mail went to more people than the person"),
    writtenBefore: z.boolean().describe("The person has written to the sender before"),
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
    const mail = mailOf(m);
    const own = await ownAddressesOf(c, token);
    const group = [...mail.to, ...mail.cc].some((a) => !own.has(plainAddress(a.address)));
    const sender = mail.from?.address;
    let earlier: ReturnType<typeof mailOf>[] = [];
    if (sender && !group) {
      const { ids } = await idsOf(c, token, withoutDrafts(`from:${sender} OR to:${sender}`), EARLIER);
      earlier = (await messagesOf(c, token, ids))
        .filter((x) => x.threadId !== m.threadId && !isDraft(x))
        .sort((a, b) => timeOf(a) - timeOf(b))
        .map(mailOf);
    }
    const writtenBefore = sender ? (await idsOf(c, token, `in:sent to:${sender}`, 1)).ids.length > 0 : false;
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
    };
  },
});
