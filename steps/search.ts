import { z, defineStep } from "strut";
import { asCtx, idsOf, isDraft, mailOf, messagesOf, needToken, timeOf, withoutDrafts } from "./_gmail.js";
import { mail } from "./_shape.js";

export default defineStep({
  type: "stadeum/gmail/search",
  description:
    "Mail in the person's own mailbox that matches a Gmail search, newest first: 20 unless `limit` says otherwise, at most 100. " +
    "Each message comes with `mine` (this mailbox sent it) and `machine` (a list or a machine did). Drafts are left out.",
  effect: "read",
  input: z.object({
    query: z.string().min(1).max(1_000).describe("A Gmail search, as in Gmail's search box: `from:ada@example.com newer_than:30d`"),
    limit: z.number().int().min(1).max(100).optional().describe("How many, newest first: 20 unless said"),
  }),
  output: z.object({ messages: z.array(mail) }),
  async run(cfg, ctx) {
    const c = asCtx(ctx);
    const token = await needToken(c);
    const { ids } = await idsOf(c, token, withoutDrafts(cfg.query), cfg.limit ?? 20);
    const found = (await messagesOf(c, token, ids)).filter((m) => !isDraft(m));
    found.sort((a, b) => timeOf(b) - timeOf(a));
    return { messages: found.map(mailOf) };
  },
});
