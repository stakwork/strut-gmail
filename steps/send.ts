import { z, defineStep } from "strut";
import { asCtx, compose, gmail, needToken, recipients, refused, type Address } from "./_gmail.js";
import { compose as input } from "./_shape.js";

const address = z.object({ address: z.string(), name: z.string().optional() });

/** Whom the card says a send goes to: the names and addresses given, or the step's rule for a reply. */
function whom(to: Address[]): string {
  return to.length ? to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ") : "Whoever sent the thread's latest message, or its Reply-To";
}

export default defineStep({
  type: "stadeum/gmail/send",
  description:
    "Send mail from the person's own Gmail. With `thread`, a reply in that thread to its latest message: to whoever sent it, or its Reply-To " +
    "(for a message the mailbox sent, to whom it went), with the thread's subject and the headers that keep it in the thread. Without it, a new message to `to`. " +
    "`to` names the recipients either way. Plain text; nothing attached.",
  effect: "write",
  input: z.object(input),
  output: z.object({ message: z.string(), thread: z.string(), to: z.array(address) }),
  // The card a person accepts when a send asks first (the job agent's
  // `approve: [send]`): whom it goes to, the subject and the text, from the
  // input alone. It reads no mail and no secret: strut calls it before
  // anything runs (behind the package's fence since stakwork/strut#880).
  async describe(cfg) {
    let to: Address[] = [];
    try {
      to = recipients(cfg.to);
    } catch {
      return undefined; // not addresses: the plain card, and the send refuses them
    }
    const fields = [
      { label: "To", value: whom(to) },
      ...(cfg.subject !== undefined ? [{ label: "Subject", value: cfg.subject }] : cfg.thread ? [{ label: "Subject", value: "Re: the thread's subject" }] : []),
      { label: "Text", value: cfg.text },
      ...(cfg.thread ? [{ label: "Thread", value: cfg.thread, detail: true }] : []),
    ];
    return {
      title: to.length ? `Send an email to ${to.map((a) => a.name ?? a.address).join(", ")}` : "Send a reply in the thread",
      fields,
      actions: { accept: "Send", reject: "Don't send" },
      full: true,
    };
  },
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

