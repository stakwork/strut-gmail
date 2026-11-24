import { z, defineStep } from "strut";
import { asCtx } from "./_gmail.js";
import { dbOf, personOf, type ReplyCtx } from "./_replies.js";
import { started } from "./_ask.js";

export default defineStep({
  type: "stadeum/gmail/ask-started",
  description:
    "Keep, for the person, which job a message's turn is: the thread's job from its first turn on, and the job's run for this turn, which `ask-look` answers once it ends. Ids alone.",
  effect: "write",
  input: z.object({
    message: z.string(),
    thread: z.string(),
    job: z.string().min(1),
    run: z.string().min(1),
  }),
  output: z.object({ kept: z.boolean() }),
  async run(cfg, ctx) {
    const c = asCtx(ctx) as ReplyCtx;
    started(await dbOf(c), personOf(c), cfg);
    return { kept: true };
  },
});
