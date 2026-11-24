import { z, defineStep } from "strut";
import { asCtx, isDraft, mailOf, needToken, threadOf } from "./_gmail.js";
import { mail } from "./_shape.js";

export default defineStep({
  type: "stadeum/gmail/read",
  description:
    "A thread in the person's own mailbox: its messages, oldest first, each with `mine` (this mailbox sent it) and `machine` (a list or a machine did). Drafts are left out.",
  effect: "read",
  input: z.object({ thread: z.string().describe("The thread's id: a message's `thread`") }),
  output: z.object({ thread: z.string(), subject: z.string(), messages: z.array(mail) }),
  async run(cfg, ctx) {
    const c = asCtx(ctx);
    const token = await needToken(c);
    const messages = (await threadOf(c, token, cfg.thread)).filter((m) => !isDraft(m)).map(mailOf);
    return { thread: cfg.thread, subject: messages[0]?.subject ?? "", messages };
  },
});
