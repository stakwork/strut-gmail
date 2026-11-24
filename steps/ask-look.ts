import { z, defineStep } from "strut";
import {
  asCtx,
  createDraft,
  draftThere,
  header,
  isMine,
  lookSince,
  messageOf,
  needToken,
  profileOf,
  rawOf,
  replySubject,
  senderOf,
  sendDraft,
  textOf,
  threadOf,
  threading,
  type Address,
  type GMessage,
} from "./_gmail.js";
import { dbOf, personOf, settingsOf, type ReplyCtx } from "./_replies.js";
import {
  ANSWER_MARK,
  ENDED,
  answerIds,
  answerOf,
  answered,
  busy,
  isAnswer,
  jamieAddress,
  jobOf,
  nothing,
  ownWords,
  sending,
  toJamie,
  turnOf,
  turnsIn,
  wait,
  type JobView,
  type Turn,
} from "./_ask.js";

const turn = z.object({
  message: z.string().describe("The person's message"),
  thread: z.string(),
  job: z.string().describe("The thread's job, to continue; empty for a new one, to start"),
  title: z.string().describe("A new job's title: the mail's subject"),
  prompt: z.string().describe("What the job is told: the person's own words"),
});

export default defineStep({
  type: "stadeum/gmail/ask-look",
  description:
    "Email Jamie's look at the person's own mailbox, as them. First, each turn whose job run has ended since the last look is answered in its thread: " +
    "the job's reply and its links, or that it failed, sent to the person's own address and nobody else, once. A run still going is left alone. " +
    "Then the mail the mailbox itself sent since `since` (Gmail's Sent: mail from outside can't be it): a message to the person's +jamie address in a new thread is a new job (`turns` with no `job`), " +
    "and any message of theirs in a thread that is already a job continues it (`turns` with its `job`), once the thread's last turn is answered. " +
    "With Email Jamie off: nothing, no call to Gmail, and an empty `since`.",
  effect: "write",
  input: z.object({ since: z.string().max(20_000).optional().describe("Where the last look stopped: its `since`") }),
  output: z.object({
    on: z.boolean().describe("Email Jamie is on"),
    since: z.string(),
    turns: z.array(turn).describe("Jobs to start or continue, one per thread"),
    answered: z.number().describe("Answers sent this look"),
  }),
  async run(cfg, ctx) {
    const c = asCtx(ctx) as ReplyCtx;
    const actor = personOf(c);
    const db = await dbOf(c);
    if (!settingsOf(db, actor).ask) return { on: false, since: "", turns: [], answered: 0 };
    const token = await needToken(c);

    // The person's own address, and the From an answer goes out with: read once, when needed.
    let me: { address: string; from: Address } | undefined;
    const mine = async () => {
      if (me) return me;
      const p = await profileOf(c, token);
      if ("refused" in p) throw new Error("Google no longer accepts your connection (it was revoked or it expired): connect Google again, in the Gmail app");
      me = { address: p.address, from: await senderOf(c, token) };
      return me;
    };

    // 1. Answers: each turn whose run has ended, in its thread, once.
    let sent = 0;
    const open = turnsIn(db, actor, ["running", "sending"]);
    if (open.length) {
      const get = c.registry?.["job/get"];
      if (!get) throw new Error("stadeum/gmail reads a job with strut's job/get, and this run's registry has none");
      const views = new Map<string, JobView>();
      const viewOf = async (job: string) => {
        if (!views.has(job)) views.set(job, (await get.run(get.input.parse({ job }), c)) as JobView);
        return views.get(job)!;
      };
      for (const t of open) {
        if (t.state === "sending") {
          sent += await finish(t);
          continue;
        }
        const run = (await viewOf(t.job!)).runs?.find((r) => r.runId === t.run);
        if (!run || !ENDED.has(String(run.status))) continue;
        const { text, failed } = answerOf(await viewOf(t.job!), run);
        const asked = await messageOf(c, token, t.message, "metadata");
        if (!asked) {
          answered(db, actor, t.message, null); // the person's message is gone: no thread to answer in
          continue;
        }
        const { address, from } = await mine();
        const raw = rawOf({
          from,
          to: [{ address }],
          subject: replySubject(header(asked.payload, "Subject") ?? ""),
          text,
          ...threading(asked),
          marks: { [ANSWER_MARK]: t.run! },
        });
        // The draft first, kept: a run that stops before the send sends it next time.
        const draft = await createDraft(c, token, raw, t.thread);
        sending(db, actor, t.message, draft.draft, failed);
        answered(db, actor, t.message, (await sendDraft(c, token, draft.draft)).message);
        sent++;
      }
    }

    // A turn left `sending`: its draft is sent now, or was (it is gone, and
    // the thread has the answer by its mark); never a second answer.
    async function finish(t: Turn): Promise<number> {
      if (t.draft && (await draftThere(c, token, t.draft))) {
        answered(db, actor, t.message, (await sendDraft(c, token, t.draft)).message);
        return 1;
      }
      const thread = await threadOf(c, token, t.thread, "metadata").catch(() => [] as GMessage[]);
      const mark = thread.find((m) => header(m.payload, ANSWER_MARK) === t.run);
      answered(db, actor, t.message, mark?.id ?? null);
      return 0;
    }

    // 2. Turns that waited for their thread: on, one per thread, oldest first.
    const turns: Array<z.infer<typeof turn>> = [];
    const taken = new Set<string>();
    const words = async (message: string): Promise<{ subject: string; text: string } | undefined> => {
      const m = await messageOf(c, token, message, "full");
      if (!m) return undefined;
      return { subject: (header(m.payload, "Subject") ?? "").replace(/\s+/g, " ").trim(), text: ownWords(textOf(m.payload)) };
    };
    for (const t of turnsIn(db, actor, ["waiting"])) {
      const job = t.job ?? jobOf(db, actor, t.thread);
      if (taken.has(t.thread) || !job || busy(db, actor, t.thread)) {
        taken.add(t.thread);
        continue;
      }
      taken.add(t.thread);
      const w = await words(t.message);
      if (!w?.text) {
        answered(db, actor, t.message, null); // nothing of the person's own to send the job
        continue;
      }
      turns.push({ message: t.message, thread: t.thread, job, title: "", prompt: w.text });
    }

    // 3. Mail the mailbox itself sent since the last look.
    const look = await lookSince(c, token, "from:me", cfg.since, "metadata");
    const ours = answerIds(db, actor);
    const fresh = look.messages.filter((m) => isMine(m) && !isAnswer(m) && !ours.has(m.id!) && !turnOf(db, actor, m.id!));
    for (const m of fresh) {
      const thread = m.threadId!;
      const job = jobOf(db, actor, thread);
      if (!job) {
        const jamie = jamieAddress((await mine()).address);
        if (!jamie || !toJamie(m, jamie)) continue; // the person's other mail: not to Jamie
      }
      if (taken.has(thread) || (job && busy(db, actor, thread))) {
        wait(db, actor, m.id!, thread, job);
        taken.add(thread);
        continue;
      }
      taken.add(thread);
      const w = await words(m.id!);
      if (!w?.text) {
        nothing(db, actor, m.id!, thread);
        continue;
      }
      turns.push(
        job
          ? { message: m.id!, thread, job, title: "", prompt: w.text }
          : { message: m.id!, thread, job: "", title: w.subject || "Email", prompt: w.subject ? `${w.subject}\n\n${w.text}` : w.text },
      );
    }
    return { on: true, since: look.since, turns, answered: sent };
  },
});
