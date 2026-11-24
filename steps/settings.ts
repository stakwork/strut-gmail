import { z, defineStep } from "strut";
import { asCtx } from "./_gmail.js";
import { dbOf, personOf, settingsOf, type ReplyCtx } from "./_replies.js";

export default defineStep({
  type: "stadeum/gmail/settings",
  description:
    "The person's own choices for Replies, kept by the Gmail app: whether `reply` answers their mail (`replies`, on until they turn it off), " +
    "who gets a reply without a click (`choice`: `draft`, nobody; `written`, a sender they have written to before; `anyone`), " +
    "which mail (`search`, a Gmail search) and their own `instructions`, which come after the shared `Mail Replies` pages.",
  effect: "read",
  input: z.object({}),
  output: z.object({ replies: z.boolean(), choice: z.enum(["draft", "written", "anyone"]), search: z.string(), instructions: z.string() }),
  async run(_cfg, ctx) {
    const c = asCtx(ctx) as ReplyCtx;
    return settingsOf(await dbOf(c), personOf(c));
  },
});
