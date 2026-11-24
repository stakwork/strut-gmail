import { z, defineStep } from "strut";
import { CONNECTIONS, SECRET, asCtx, own, requireOwnApp, revoke } from "./_gmail.js";

export default defineStep({
  type: "stadeum/gmail/disconnect",
  description:
    "End the person's Google connection, from the Gmail app, by the person themselves: their own GOOGLE_TOKEN is revoked at Google first " +
    "(which ends the whole grant, for every Google package on the box), then removed from the box whether or not Google answered, " +
    "with `why` and `manage` (Google's page where they remove the access themselves) when it did not. The token is never in the answer.",
  effect: "write",
  input: z.object({}),
  output: z.object({
    removed: z.boolean(),
    revoked: z.boolean().optional(),
    why: z.string().optional().describe("Why Google did not revoke it"),
    manage: z.string().optional().describe("Google's page where the person removes the access"),
  }),
  async run(_cfg, ctx) {
    const c = asCtx(ctx);
    requireOwnApp(c, "disconnecting Google");
    const mine = own(c);
    const token = await mine.get(SECRET);
    if (!token) return { removed: false };
    // Revoked first: once removed, nothing on the box could revoke it.
    const done = await revoke(c, token);
    await mine.delete(SECRET);
    return done.revoked ? { removed: true, revoked: true } : { removed: true, ...done, manage: CONNECTIONS };
  },
});
