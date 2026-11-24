import { z, defineStep } from "strut";
import { asCtx, lookSince, needToken } from "./_gmail.js";
import { dbOf, personOf, settingsOf, type ReplyCtx } from "./_replies.js";

export default defineStep({
  type: "stadeum/gmail/look",
  description:
    "Replies' look at the person's own mailbox: with Replies on, the ids of the mail that matches their search and came after `since`, oldest first, " +
    "and `since` for the next look (as `new`, which it shares its rule with). With Replies off, no mail, no call to Gmail, and an empty `since`, " +
    "so turning Replies on again starts from then. Ids alone, read at Gmail's smallest: `context` reads each message itself.",
  effect: "read",
  input: z.object({ since: z.string().max(20_000).optional().describe("Where the last look stopped: its `since`") }),
  output: z.object({
    on: z.boolean().describe("Replies is on"),
    messages: z.array(z.string()).describe("The new messages' ids, oldest first"),
    since: z.string(),
    more: z.boolean().optional(),
  }),
  async run(cfg, ctx) {
    const c = asCtx(ctx) as ReplyCtx;
    const settings = settingsOf(await dbOf(c), personOf(c));
    if (!settings.replies) return { on: false, messages: [], since: "" };
    const out = await lookSince(c, await needToken(c), settings.search, cfg.since, "minimal");
    return { on: true, messages: out.messages.map((m) => m.id!), since: out.since, ...(out.more ? { more: true } : {}) };
  },
});
