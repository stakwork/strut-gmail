import { z, defineStep } from "strut";
import { addressesOf, asCtx, draftIdsOf, header, isDraft, isMine, needToken, threadOf } from "./_gmail.js";
import { PAGE, dbOf, draftsLeft, handoffsOf, personOf, type ReplyCtx } from "./_replies.js";

const address = z.object({ address: z.string(), name: z.string().optional() });

export default defineStep({
  type: "stadeum/gmail/waiting",
  description:
    "What Replies left for the person: how many drafts it left in Gmail are still there (`drafts`), and the threads handed to them (`needsYou`), " +
    "each with its sender, subject and the reason, newest first. A thread drops off once the person writes in it. Sender and subject are read from Gmail now: " +
    "the package keeps no mail. `page` is the `Mail Replies` page's ref_id.",
  effect: "read",
  input: z.object({}),
  output: z.object({
    drafts: z.number(),
    needsYou: z.array(z.object({ thread: z.string(), message: z.string(), from: address.optional(), subject: z.string(), reason: z.string(), at: z.string() })),
    page: z.string().optional(),
  }),
  async run(_cfg, ctx) {
    const c = asCtx(ctx) as ReplyCtx;
    const token = await needToken(c);
    const actor = personOf(c);
    const db = await dbOf(c);
    // A draft Replies left counts while Gmail still has it: one the person
    // sent or deleted is gone from Gmail's drafts.
    const left = draftsLeft(db, actor);
    const there = left.length ? await draftIdsOf(c, token) : new Set<string>();
    const needsYou = [];
    for (const h of handoffsOf(db, actor)) {
      let thread;
      try {
        thread = (await threadOf(c, token, h.thread, "metadata")).filter((m) => !isDraft(m));
      } catch (e) {
        if (e instanceof Error && /no thread/.test(e.message)) continue;
        throw e;
      }
      const at = thread.findIndex((m) => m.id === h.message);
      if (at < 0 || thread.slice(at + 1).some(isMine)) continue;
      const m = thread[at]!;
      const from = addressesOf(header(m.payload, "From"))[0];
      needsYou.push({ thread: h.thread, message: h.message, ...(from ? { from } : {}), subject: (header(m.payload, "Subject") ?? "").replace(/\s+/g, " ").trim(), reason: h.reason ?? "", at: h.at });
    }
    const get = c.registry?.["graph/graph-get"];
    const page = get ? ((await get.run(get.input.parse({ node_type: "Concept", name: PAGE }), c)) as { ref_id?: string } | string | undefined) : undefined;
    return {
      drafts: left.filter((d) => there.has(d)).length,
      needsYou,
      ...(page && typeof page === "object" && page.ref_id ? { page: page.ref_id } : {}),
    };
  },
});
