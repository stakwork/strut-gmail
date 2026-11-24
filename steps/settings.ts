import { z, defineStep } from "strut";
import { asCtx } from "./_gmail.js";
import { dbOf, personOf, settingsOf, type ReplyCtx } from "./_replies.js";

export default defineStep({
  type: "stadeum/gmail/settings",
  description:
    "The person's own choices for Replies, kept by the Gmail app: whether `reply` answers their mail (`replies`, on until they turn it off), " +
    "which mail (`search`, a Gmail search) and their own `instructions`, which come after the shared `Mail Replies` pages.",
  effect: "read",
  input: z.object({}),
  output: z.object({ replies: z.boolean(), search: z.string(), instructions: z.string() }),
  async run(_cfg, ctx) {
    const c = asCtx(ctx) as ReplyCtx;
    return settingsOf(await dbOf(c), personOf(c));
  },
});
