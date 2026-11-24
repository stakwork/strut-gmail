import { z, defineStep } from "strut";
import { asCtx, compose, createDraft, needToken } from "./_gmail.js";
import { compose as input } from "./_shape.js";

const address = z.object({ address: z.string(), name: z.string().optional() });

export default defineStep({
  type: "stadeum/gmail/draft",
  description:
    "Leave a draft in the person's own Gmail, for them to edit and send. With `thread`, a reply in that thread to its latest message: to whoever sent it, or its Reply-To " +
    "(for a message the mailbox sent, to whom it went), with the thread's subject and the headers that keep it in the thread. Without it, a new message to `to`. " +
    "`to` names the recipients either way. Plain text; nothing attached.",
  effect: "write",
  input: z.object(input),
  output: z.object({ draft: z.string(), message: z.string(), thread: z.string(), to: z.array(address) }),
  async run(cfg, ctx) {
    const c = asCtx(ctx);
    const token = await needToken(c);
    const out = await compose(c, token, cfg);
    return { ...(await createDraft(c, token, out.raw, out.threadId)), to: out.to };
  },
});
