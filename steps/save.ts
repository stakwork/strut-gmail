import { z, defineStep } from "strut";
import { asCtx, requireOwnApp } from "./_gmail.js";
import { INSTRUCTIONS_MAX, SEARCH_MAX, dbOf, personOf, saveSettings, type ReplyCtx } from "./_replies.js";

export default defineStep({
  type: "stadeum/gmail/save",
  description:
    "Change the person's own choices for Replies, from the Gmail app, by the person themselves: `replies` on or off, the `search` it answers " +
    "(empty: `in:inbox category:primary to:me`), their own `instructions`. Answers with all of them.",
  effect: "write",
  input: z.object({
    replies: z.boolean().optional(),
    search: z.string().max(SEARCH_MAX).optional(),
    instructions: z.string().max(INSTRUCTIONS_MAX).optional(),
  }),
  output: z.object({ replies: z.boolean(), search: z.string(), instructions: z.string() }),
  async run(cfg, ctx) {
    const c = asCtx(ctx) as ReplyCtx;
    requireOwnApp(c, "changing Replies");
    const patch = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined));
    return saveSettings(await dbOf(c), personOf(c), patch);
  },
});
