import { z, defineStep } from "strut";
import { asCtx, compose, gmail, needToken, refused } from "./_gmail.js";
import { compose as input } from "./_shape.js";

const address = z.object({ address: z.string(), name: z.string().optional() });

export default defineStep({
  type: "stadeum/gmail/send",
  description:
    "Send mail from the person's own Gmail. With `thread`, a reply in that thread to its latest message: to whoever sent it, or its Reply-To " +
    "(for a message the mailbox sent, to whom it went), with the thread's subject and the headers that keep it in the thread. Without it, a new message to `to`. " +
    "`to` names the recipients either way. Plain text; nothing attached.",
  effect: "write",
  input: z.object(input),
  output: z.object({ message: z.string(), thread: z.string(), to: z.array(address) }),
  async run(cfg, ctx) {
    const c = asCtx(ctx);
    const token = await needToken(c);
    const out = await compose(c, token, cfg);
    const res = await gmail(c, token, "/messages/send", { method: "POST", body: { raw: out.raw, ...(out.threadId ? { threadId: out.threadId } : {}) } });
    if (!res.ok) throw refused(res, token, "send it");
    const body = (res.body ?? {}) as { id?: unknown; threadId?: unknown };
    return { message: String(body.id ?? ""), thread: String(body.threadId ?? ""), to: out.to };
  },
});
