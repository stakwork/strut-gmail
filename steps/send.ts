import { z, defineStep } from "strut";
import { asCtx, asRecipient, compose, gmail, needToken, outgoingOf, recipients, refused, scrub, type Address, type Compose, type Outgoing } from "./_gmail.js";
import { compose as input } from "./_shape.js";

const address = z.object({ address: z.string(), name: z.string().optional() });

/** The addresses as the card shows them. */
const whom = (to: Address[]): string => to.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

/** The call names no one: a reply whose recipients come from its thread. */
const namesNobody = (cfg: Compose): boolean => {
  try {
    return recipients(cfg.to).length === 0;
  } catch {
    return false; // not addresses: the send refuses them itself
  }
};

/**
 * What the send would be now, as `run` works it out (`outgoingOf`): or why
 * it can't be told, in a line with no token in it.
 */
async function plan(cfg: Compose, ctx: unknown): Promise<{ out: Outgoing } | { unknown: string }> {
  try {
    const c = asCtx(ctx as never);
    return { out: (await outgoingOf(c, await needToken(c), cfg)).out };
  } catch (e) {
    return { unknown: scrub(e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
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
  // When a send asks first (the job agent's `approve: [send]`), a reply in a
  // thread that names no one is read now, as the send will read it. When the
  // thread can't be read, nothing is asked: the call fails and says why, so
  // no card ever hides whom a reply goes to.
  async answerGated(cfg, ctx) {
    if (cfg.thread === undefined || !namesNobody(cfg)) return undefined;
    const now = await plan(cfg, ctx);
    if ("unknown" in now) {
      throw new Error(`couldn't read the thread to see whom the reply would go to (${now.unknown}), so nothing was asked. Name the recipients with \`to\`.`);
    }
    return undefined;
  },
  // The card the person accepts: whom it goes to, the subject and the text,
  // worked out as the send works them out. For a reply that names no one,
  // the recipients it read are kept on the proposal as `to` (`input`), so
  // the yes sends to exactly the addresses the card showed, whatever mail
  // comes in the thread before it.
  async describe(cfg, ctx) {
    let named: Address[];
    try {
      named = recipients(cfg.to);
    } catch {
      return undefined; // not addresses: the plain card, and the send refuses them
    }
    const now = cfg.thread !== undefined ? await plan(cfg, ctx) : undefined;
    const read = now && "out" in now ? now.out : undefined;
    const unknown = now && "unknown" in now ? `Unknown: the thread couldn't be read (${now.unknown})` : undefined;
    const to = read ? read.to : named;
    const subject = read ? read.subject : (unknown ?? cfg.subject ?? "");
    const names = to.map((a) => a.name ?? a.address).join(", ");
    return {
      title: !to.length ? "Send a reply to someone unknown" : cfg.thread !== undefined ? `Send a reply to ${names}` : `Send an email to ${names}`,
      fields: [
        to.length ? { label: "To", value: whom(to) } : { label: "To", value: unknown ?? "Nobody", danger: true },
        ...(subject ? [{ label: "Subject", value: subject }] : []),
        { label: "Text", value: cfg.text },
        ...(cfg.thread !== undefined ? [{ label: "Thread", value: cfg.thread, detail: true }] : []),
      ],
      actions: { accept: "Send", reject: "Don't send" },
      full: true,
      ...(read && !named.length ? { input: { ...cfg, to: read.to.map(asRecipient) } } : {}),
    };
  },
  async run(cfg, ctx) {
    // A yes to a card that couldn't say whom: describe kept no `to` on it.
    if (ctx.proposal && cfg.thread !== undefined && namesNobody(cfg)) {
      throw new Error("the card this send was accepted on didn't say whom it goes to, so nothing was sent. Ask again with `to`.");
    }
    const c = asCtx(ctx);
    const token = await needToken(c);
    const out = await compose(c, token, cfg);
    const res = await gmail(c, token, "/messages/send", { method: "POST", body: { raw: out.raw, ...(out.threadId ? { threadId: out.threadId } : {}) } });
    if (!res.ok) throw refused(res, token, "send it");
    const body = (res.body ?? {}) as { id?: unknown; threadId?: unknown };
    return { message: String(body.id ?? ""), thread: String(body.threadId ?? ""), to: out.to };
  },
});
