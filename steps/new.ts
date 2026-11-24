import { z, defineStep } from "strut";
import { asCtx, lookSince, mailOf, needToken } from "./_gmail.js";
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
    const out = await lookSince(c, await needToken(c), cfg.search, cfg.since, "full");
    return { messages: out.messages.map(mailOf), since: out.since, ...(out.more ? { more: true } : {}) };
  },
});
