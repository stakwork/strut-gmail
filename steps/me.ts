import { z, defineStep } from "strut";
import { asCtx, profileOf, tokenOf } from "./_gmail.js";

export default defineStep({
  type: "stadeum/gmail/me",
  description:
    "Which mailbox the person connected: their own GOOGLE_TOKEN alone (never a deployment's), asked of Gmail's profile. " +
    "`connected` false when they have none. Otherwise its `address`, or `refused` when Google no longer takes the token. The token is never in the answer.",
  effect: "read",
  input: z.object({}),
  output: z.object({
    connected: z.boolean(),
    address: z.string().optional().describe("The mailbox's own address"),
    refused: z.boolean().optional().describe("Google no longer takes the token: it was revoked or it expired"),
  }),
  async run(_cfg, ctx) {
    const c = asCtx(ctx);
    const token = await tokenOf(c);
    if (!token) return { connected: false };
    const who = await profileOf(c, token);
    if ("refused" in who) return { connected: true, refused: true };
    return { connected: true, address: who.address };
  },
});
