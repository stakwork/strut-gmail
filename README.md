# strut-gmail

Gmail for Stadeum. Each person connects their own Google account. Then any
workflow on the box can read, search, draft and send their mail, as them.

This is work items 4 to 6 of stadeum's `plans/gmail.md`: Connect,
Disconnect and the mail steps; **Replies**, the ready-made `reply`
workflow and the app's Replies card; and **Send**, replies that go out
without a click when the person chooses so. `ask` (item 7) and the job
agent's mail tools (item 8) come later.

Three rules hold in every step (the plan's §6):

1. **A mailbox is whoever's token the run has.** No step takes a person or
   an address to act for. None compares the mailbox's address with the
   address a person signs in with. The package keeps nothing, by address
   or otherwise.
2. **The steps describe mail and decide nothing.** Who sent a message,
   whether this mailbox sent it, whether a machine did: each is a fact on
   the message. What to do about it is a workflow's.
3. **A workflow takes a message and doesn't care what handed it over.** A
   message's shape names nothing of Gmail's but the search text.

## What it ships

| Part | What |
| --- | --- |
| `strut.yaml` | `requires.optional: [GOOGLE_TOKEN]`; `provides.secrets: [GOOGLE_TOKEN]`, so its steps read and remove each person's own value. No schedule and no job tools yet |
| `steps/me.ts` | Which mailbox the person connected: Gmail's profile, read with their own token. Says when Google no longer takes it |
| `steps/disconnect.ts` | Revokes the person's grant at Google, then removes their token. From the Gmail app alone, by the person themselves |
| `steps/new.ts` | Mail that matches a search and came since the last look, oldest first |
| `steps/read.ts` | A thread's messages, oldest first |
| `steps/search.ts` | Mail that matches a search, newest first |
| `steps/draft.ts` | A draft in Gmail: a reply in a thread, or a new message |
| `steps/send.ts` | The same, sent |
| `steps/_gmail.ts` | What the steps share: the token, Gmail's API, a message's shape, a message to write |
| `steps/_shape.ts` | A message's shape as the steps declare it |
| `steps/look.ts` | Replies' look at the person's mail: the ids of what is new, under their search, or nothing when Replies is off |
| `steps/context.ts` | What a reply to one message is written from, or why there is none ("Replies", below) |
| `steps/answer.ts` | Acts on what the model wrote for one message, once: sent when the person's choice allows it, else a draft; a handoff; or nothing |
| `steps/settings.ts` | The person's choices for Replies: on or off, who gets a reply without a click, the search, their own instructions |
| `steps/save.ts` | Changes those choices. From the Gmail app alone, by the person themselves |
| `steps/waiting.ts` | The drafts Replies left that are still in Gmail, the threads under Needs you, and what was sent for the person |
| `steps/_replies.ts` | What the Replies steps share: the person, the app's database, the pages, when not to answer, how the mail is shown |
| `workflows/reply.yaml` | **`reply`**: the person's new mail, one message at a time |
| `workflows/reply-one.yaml` | One message: `context`, the model, `answer` |
| `concepts/Mail Replies.md` | How to answer: tone, length, what to hand to the person, when to say nothing |
| `apps/gmail/` | **Gmail**, every person's app (below), and its database (`db/001-replies.sql`, `db/002-send.sql`) |

## The mail steps

Ordinary steps. Any workflow, page or agent on the box may call them. Each
call acts on the mailbox of the run's person, through their own
`GOOGLE_TOKEN`. A call with no person, or a person with no token, fails
and asks Google nothing.

| Step | Takes | Gives |
| --- | --- | --- |
| `stadeum/gmail/new` | `search`, `since?` | `messages`, oldest first; `since`; `more` when the rest waits |
| `stadeum/gmail/read` | `thread` | `thread`, `subject`, `messages`, oldest first |
| `stadeum/gmail/search` | `query`, `limit?` (20; at most 100) | `messages`, newest first |
| `stadeum/gmail/draft` | `thread?`, `to?`, `subject?`, `text` | `draft`, `message`, `thread`, `to` |
| `stadeum/gmail/send` | `thread?`, `to?`, `subject?`, `text` | `message`, `thread`, `to` |
| `stadeum/gmail/me` | nothing | `connected`, `address`, or `refused` |

`search` and `query` are Gmail searches, as typed in Gmail's search box.

### A message

```ts
{
  id, thread,
  from?: { address, name? },
  to: [{ address, name? }], cc: [...],
  replyTo?: [...],        // when it is not `from`
  subject,
  date,                   // when the mailbox got it, or sent it (ISO 8601)
  text,                   // plain text; HTML-only mail as its words
  truncated?: true,       // cut at 20,000 characters
  attachments: [names],   // never their contents
  mine,                   // this mailbox sent it
  machine,                // a list or a machine sent it
}
```

- **`mine`** is Gmail's `SENT` label. Only the mailbox itself puts it on a
  message ("What Google's documentation says", below). A `From` header can
  say anything, so `mine` never reads it.
- **`machine`** is true when the message has a `List-Id` or
  `List-Unsubscribe` header, `Auto-Submitted` other than `no`, `Precedence`
  of `bulk`, `list` or `junk`, an auto-reply's `X-Autoreply` or
  `X-Autorespond`, or an empty `Return-Path` (a bounce); or when its sender
  is `no-reply`, `do-not-reply`, `mailer-daemon`, `postmaster` or
  `bounces`, in their usual spellings.

Drafts are never handed over, by any step: a draft is not mail yet.

### `new`, and where it stopped

`new` gives back `since`: where it stopped. Pass it back next time.

- **With no `since`** it hands over no mail, only where to start. So a
  first run never takes a backlog.
- **Each look goes back ten minutes**, because Gmail's search can see new
  mail a moment late. `since` remembers what it handed over in that time,
  so nothing comes twice.
- **At most 50 at a time.** `more` says the rest waits for the next call.
- `since` is a time and a few message ids. It is not tied to the search,
  so a workflow may change its search and keep its `since`.

A person's own workflow on a schedule:

```yaml
input:
  since: { type: string, default: "" }
steps:
  - id: mail
    type: stadeum/gmail/new
    config: { search: "from:billing@example.com", since: "{{ input.since }}" }
  # … whatever the workflow does with mail.messages …
  - id: done
    type: pack
    config: { since: "{{ mail.since }}" }
```

Scheduled with the input `{ "since": "{{ last.output.since }}" }`. A run's
output is its last step's, and strut hands a fire its automation's last
successful run, so a failed run never moves `since`. It runs as its owner,
with their token. Strut needs nothing new for this.

### Writing mail: `draft` and `send`

- **With `thread`**, a reply to the thread's latest message that is not a
  draft:
  - to its `Reply-To`, or else its sender. For a message the mailbox sent,
    to whom it went, as Gmail's own Reply does;
  - with the thread's subject and `Re:` once;
  - with `In-Reply-To` and `References`, so Gmail keeps it in the thread.

  A `subject` with a `thread` is refused: a reply keeps its thread's.
- **Without `thread`**, a new message to `to`.
- **`to`** names the recipients either way: an address, `Name <address>`,
  or a list. In a thread it takes the place of the reply's own.
- **From** is the mailbox's default send-as address and name, from Gmail's
  settings.
- Plain text. Nothing is attached. No value can start a header of its own:
  line breaks are refused in a recipient and folded out of a subject.

### Who may call what

- `disconnect` only from this package's own app (`ctx.app.name` is
  `stadeum/gmail/gmail`, the name strut signs for the page), its published
  version, and not a host's call. Another app, a workflow or an agent
  changes nothing.
- Every other step is anyone's, as themselves. Another package's app that
  lists them among its grants reads and writes the viewer's own mailbox,
  as strut's grants allow.

### Tokens

- A step reads and removes only `secrets.own` for `GOOGLE_TOKEN`: never
  `secrets.get`, which falls back to a deployment value, and never
  `secrets.deployment`.
- A token goes to two addresses alone, through strut's `http`:
  `https://gmail.googleapis.com/gmail/v1/users/me/…` in the
  `Authorization` header, and `https://oauth2.googleapis.com/revoke` in a
  form body, with no other credential.
- A token is never in an output, an error, a run, an event, a graph node or
  a log. The steps scrub what Google says before showing it.

## Replies

**Replies** answers a person's mail. It is on, in Draft, from the moment
a person connects: every reply is a draft in their Gmail, which they edit
and send there. They may choose instead to have some replies sent without
a click ("Send", below).

### `reply`

`workflows/reply.yaml`, run as the person, on their own mailbox:

1. **`look`** reads the person's choices. With Replies on, it looks for
   mail under their search (`in:inbox category:primary to:me` unless they
   changed it) from `since`, by `new`'s rule, and gives the new messages'
   ids. Off, it reads no mail and hands back an empty `since`, so turning
   it on again starts from then, with no backlog.
2. For each message, oldest first, **`reply-one`**:
   - **`context`** stands down, and nothing else runs, for the mailbox's own
     mail, a list's or a machine's, one answered before, or one its thread
     has moved past: the person answered in it, or newer mail came.
     Otherwise it gathers what the reply is written from (below).
   - **`agent`**, with `toolFilter: ["none"]`, no `agentTools`, `mcp: false`,
     no session and a schema of `{ reply?, handoff? }`. Its system prompt is
     `context.system` and its prompt `context.prompt`. The YAML holds no
     words of its own.
   - **`answer`** stands down as `context` does. Otherwise:
     - a **`reply`** is sent when the person's choice allows it ("Send",
       below). Otherwise it is a draft in the thread, in place of the one
       it left there before (Gmail's `drafts.update` keeps the draft's
       id);
     - a **`handoff`** lists the thread under Needs you with its reason,
       beside the draft if the model wrote one;
     - **neither** is nothing. Most mail needs no answer.
3. A last `pack` hands back `{ since }`.

**The recipient is the step's:** the message's Reply-To, or its sender.
The model never names anyone, and nothing is attached. `answer` records
what it did with each message, so it never acts on one twice. These
rules are in the steps, so no search, page or instruction loosens them.

`params.model` is `claude-sonnet-5-5`; any model the box has a key for
will do.

### Send

The person picks who gets a reply without a click (the plan's §4.3,
ruling 8):

| Choice | Sent to | Everyone else |
| --- | --- | --- |
| **Draft** (the default) | Nobody | A draft |
| **Send to people I've written to** | A sender the person has written to before | A draft |
| **Send to anyone** | Any sender | A draft |

Under both Send choices, `answer` still leaves a draft and sends nothing
when any of these holds. They are in the step (`holdBack`,
`steps/_replies.ts`), and no page, instruction or mail changes them:

1. **the mail went to more people than the person**: someone in To or Cc
   besides the mailbox's own addresses (its send-as addresses, `+tag` or
   not);
2. **the reply would go to someone other than the sender**: a Reply-To
   elsewhere. A reply is written from what its recipient has already
   seen, and `context` gathers the earlier mail with the sender; with a
   Reply-To elsewhere it gathers the thread alone, and the person judges
   the draft;
3. **three replies went out without a click in the thread** since the
   person last wrote in it themselves. Sending a draft from Gmail counts
   as the person writing;
4. **the model handed the mail off**: the thread goes under Needs you,
   beside the draft.

Mail from a list or a machine never gets this far: `context` and
`answer` stand down for it.

- **Written to before** is the person's own sent mail to the sender
  (Gmail's `in:sent to:`), never a reply sent for them: `answer` keeps the
  id of every message it sent, and leaves those out. So one reply sent to
  a stranger under Send to anyone doesn't make them someone the person has
  written to.
- **Sending** writes the draft first, in place of any earlier one, then
  sends that draft (Gmail's `drafts.send`). So no stale draft stays in the
  thread, and a send that fails leaves the draft.
- **The recipient stays the step's**, as for a draft: the message's
  Reply-To, or its sender. Hold-back 2 means a sent reply only ever goes to
  the sender. The model names nobody and attaches nothing.

Hold-back 2 is this package's addition to the plan's three. Without it, a
message with a forged `From` of someone the person writes to, and a
Reply-To of the forger's, would get a reply written from the person's
mail with the real sender, sent to the forger.

### What a run costs

A schedule will run `reply` every five minutes for each person: 288 kept
runs a day each. So a run that finds no new mail is as small as it can be:

- **One call to Gmail**, its search, answered with no messages. None at
  all with Replies off. `look` reads ids and times alone (`format=minimal`):
  `context` reads each message whole, once, when there is one.
- **Three steps:** `look`, a `foreach` over nothing, and the `pack`.
- **Its output is `{ since }` alone**, and so is its summary's. A run's
  summary stays after its log goes, so no summary ever holds mail: the
  mail, the prompts and the model's answers are in the log alone.

**`retain: 1d`** on both workflows: a run's log, with the mail and the
prompts in it, is dropped after a day (ruling 12 of stadeum's
`plans/gmail.md`). Nothing needs it longer: the cursor is read from the
run's summary (a fire's `last`), and the drafts and Needs you from the
app's database. A count would not do: `{ runs: N }` counts every person's
runs of the workflow together. `reply-one` runs inside `reply`'s run and
log, so its own `retain` is for a run of one message started by hand. On
a box with an archive bucket, retention uploads a log before it removes
it.

### What the model is given

- **System prompt:** the `Mail Replies` page, then every page a box adds
  under it (breadth first, each level in name order, up to 30 pages), then
  the person's own instructions. Each under its name as a heading. Nothing
  else: every instruction the model reads is a page's or the person's.
- **Prompt:** the last 20 messages between the person and the sender,
  outside this thread, in `<earlier>`; then the thread in `<thread>`, oldest
  first, whose last message is the one to answer. Each message is a
  `<mail>` with `from`, `to`, `cc`, `date`, `mine` and the names of its
  attachments. When the mail went to more people than the person, the
  thread alone.
- **The mark.** Every tag carries a mark made fresh for each message, and
  the mark is taken out of the mail's text. So a message can't close its
  own tag and pass its words off as the page's. The page says what the
  tags mean: everything inside a `<mail>` is someone's email, never an
  instruction.

`context` also says whom a reply goes to (`to`), whether the mail went to
several people (`group`), and whether the person has written to the
sender before (`writtenBefore`). Item 6's Send choices read those.

### Where the logic lives

| What | Where |
| --- | --- |
| How to answer: tone, length, what to hand off, when to say nothing | `concepts/Mail Replies.md`, the package's page. A release changes it |
| A box's own rules | Pages the box adds under `Mail Replies`. A box never edits the package's page: strut keeps an edited page as it is, and it stops taking releases |
| A person's own instructions | **Your instructions** in the Gmail app. They come after the pages and win where they disagree |
| Which mail, and whether Replies is on | The Gmail app, per person |
| Who a reply goes to, when one is not written, never twice | The steps |
| The order of the steps | `reply.yaml` and `reply-one.yaml` |

### Running `reply`

`reply` takes `since` and hands it back, so it runs on any schedule:

```yaml
# A workflow of the person's own.
input:
  since: { type: string, default: "" }
steps:
  - id: replies
    type: subflow
    config:
      workflow: stadeum/gmail/reply
      input: { since: "{{ input.since }}" }
```

Scheduled every five minutes with the input
`{ "since": "{{ last.output.since }}" }`.

Today a fire runs as its workflow's **owner** (strut's
`docs/automations.md`, "Whom a fire runs as"), and the owner of
`stadeum/gmail/reply` is whoever installed the package. So a person
schedules a workflow of their own, as above, which runs `reply` as them.
The plan's per-person schedule (`each: GOOGLE_TOKEN`, item 3) is
stakwork/strut#871. Once a box's strut has it, the package ships:

```yaml
schedules:
  - workflow: reply
    trigger: { every: interval, minutes: 5 }
    each: GOOGLE_TOKEN
```

and this wrapper is not needed. #871 is merged into strut's `main`; a
strut without it refuses `each:`, so it is not in `strut.yaml` until a
release has it.

### What it keeps

The Gmail app's own SQLite (`apps/gmail/db/001-replies.sql`), one file for
the app, every row keyed by the person's strut actor:

- `people`: whether Replies is on, who gets a reply without a click, the
  search, the person's instructions;
- `handled`: for each message `answer` acted on, its id and thread, what
  it did (`draft`, `sent`, `handoff`, `nothing`, `stood-down`), the draft's
  id while it is the thread's latest, the id of the message it sent, a
  handoff's reason, and why a reply that could have been sent was held
  back.

No mail, and no address. The page reads each Needs you row's sender and
subject, and each Sent for you row's sender and first line, from Gmail
when it shows them, with the person's own token. The
steps open the file with `ctx.services.appDb.open("stadeum/gmail/gmail")`,
from a page's call or a run no page started alike.

### Who may call what, for Replies

- `save` only from the Gmail app, by the person themselves.
- `settings`, `waiting`, `context` and `answer` are anyone's, as
  themselves: a workflow, a page that grants them, an agent. Each acts on
  the run's person's own mailbox and rows.

## The Gmail app

Every person's own. For now it is one card:

- **Not connected:** one button, **Connect Google**. It opens the box's
  connect seam with the package's two scopes and the way back:
  `https://<box>/api/connect/google?scope=<gmail.readonly gmail.compose>&return=<this app's page>`.
  The seam shows the box's confirm page, then Google, then keeps the token
  as the person's own `GOOGLE_TOKEN` and comes back. The app reads it all
  again when the person comes back to the page.
- **Connected:** the mailbox's address, read from Gmail with the person's
  own token, and **Disconnect**. It asks first, then revokes the grant at
  Google and removes the token. If Google does not confirm, the token is
  removed anyway, and the app links to the person's Google connections
  page, where they remove the access themselves.

**Replies**, once connected:

- A switch, **Replies**, with "Jamie answers your mail" under it. On, it
  shows:
  - who gets a reply without a click, a dropdown: **Draft**, **Send to
    people I've written to**, **Send to anyone**. Beside it, a few words
    that change with the choice: "You send each one in Gmail", "Everyone
    else gets a draft", "Never to lists or machines";
  - **N drafts waiting**, the drafts Replies left that are still in Gmail,
    with **Open Gmail**, which opens Gmail's drafts in the connected
    account;
  - **Your instructions**, a text box that saves as the person types and
    shows **Saved**. Beside its label, **Shared instructions** opens the
    `Mail Replies` page in strut's Knowledge app;
  - **Mail to answer**, the search, saved when the person leaves the field
    or presses Enter.
- **Needs you:** the threads handed to the person, newest first, each with
  the sender, the subject and the reason. A row opens its thread in Gmail.
  A thread leaves the list once the person writes in it.
- **Sent for you:** what went out without a click, newest first, each with
  the sender it answered and the reply's first line. A row opens its
  thread in Gmail. "Nothing yet" when there is none, as under Draft. A
  person who goes back to Draft still sees what was sent before.

The page reads and changes these through `settings`, `save` and `waiting`
alone. It is granted no SQL (`grants.sqlite: false`).

Revoking ends the whole grant. With `include_granted_scopes`, every Google
package on the box shares one `GOOGLE_TOKEN`, so Disconnect ends them all.
The dialog says so.

**Where Connect leads** follows stadeum/github's rule (its README, "Where
Connect leads"; `apps/gmail/src/links.ts` here). The host's page that strut
hands an app can be named by any page that frames strut. So Connect is
offered only when that page is on the box this strut is served for: strut
at `strut.<box>`, Stadeum and its seam at `<box>`. Anywhere else the app
says to open Gmail in Stadeum.

## What Google's documentation says

Read on 2026-11-23, for the plan's §13 "to check" items that touch these
steps.

**A reply inside an existing thread** ([Managing threads][threads],
[Sending email][sending], [Message][message]). For a draft or a sent
message to join a thread:

1. the `threadId` goes on the message: `Draft.message.threadId` for
   `drafts.create`, `threadId` beside `raw` for `messages.send`;
2. `References` and `In-Reply-To` are set as RFC 2822 says;
3. the `Subject` headers match.

`raw` is the whole RFC 2822 message, base64url. The steps do all three.
The test's fake Gmail keeps to these rules and starts a new thread for a
reply that misses them, and the replies land in their threads.

**How a step knows the mailbox itself sent a message** ([Managing
labels][labels]). `SENT` is "applied automatically" to messages sent with
`drafts.send` or `messages.send`, sent through Gmail's web interface, or
inserted with `messages.insert` with the user's own address in `From`. It
cannot be applied by hand: the guide's table says "no". Mail from outside
arrives with `INBOX` and whatever `From` its sender wrote. So `mine` is
`SENT`. The one other way to it, `messages.insert`, is a call made with a
token for the person's own mailbox, not mail from outside.

**Mail to `name+tag@` arrives in the same mailbox.** Gmail Help says mail
to `name+anything@gmail.com` goes to `name@gmail.com` ([Use Gmail
aliases][plus]). Google Workspace's Learning Center says the same for a
work address: mail to any variation "with the plus sign" arrives in the
current inbox ([Tips to optimize your Gmail inbox][plus-workspace]).

Settled on the way:

- **From.** No page says what Gmail does with a message that has no
  `From`. So the steps always write one: the default send-as address,
  which `settings.sendAs.list` gives with `gmail.readonly` ([SendAs][sendas]).
- **Search by time.** `after:` takes seconds since the epoch; a plain date
  is read as midnight Pacific ([Searching for messages][filtering]).
- **Revoking.** `POST https://oauth2.googleapis.com/revoke`, form-encoded.
  Revoking an access token revokes its refresh token too. `200` on
  success, `400` with an error code otherwise, and it "might take some
  time" to take full effect ([OAuth 2.0 for web server apps][revoke]).
- **The address.** `users.getProfile` gives `emailAddress` with
  `gmail.readonly` ([getProfile][profile]).

Still to check, with a real account:

- that `after:` reads the same time as a message's `internalDate`. `new`
  filters by `internalDate` itself, so a mismatch could only miss mail
  whose `Date` header is older than when Gmail got it;
- how late Gmail's search sees new mail. `new` looks back ten minutes;
- that mail the mailbox sends to itself carries both `SENT` and `INBOX`.
  The fake does; `ask` (item 7) relies on it;
- whether `messages.list` returns drafts. The steps add `-in:drafts` and
  drop `DRAFT` either way;
- that a draft keeps its id while the person edits it in Gmail, and leaves
  `drafts.list` once it is sent or deleted. **Drafts waiting** counts the
  draft ids Replies left that `drafts.list` still has. The drafts guide
  says only that a sent draft becomes a message with a new id.

[threads]: https://developers.google.com/workspace/gmail/api/guides/threads
[sending]: https://developers.google.com/workspace/gmail/api/guides/sending
[message]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
[labels]: https://developers.google.com/workspace/gmail/api/guides/labels
[plus]: https://support.google.com/mail/answer/12096
[plus-workspace]: https://support.google.com/a/users/answer/9282734
[sendas]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs
[filtering]: https://developers.google.com/workspace/gmail/api/guides/filtering
[revoke]: https://developers.google.com/identity/protocols/oauth2/web-server
[profile]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile

## What strut's code says

Read in strut's `main` (3a8e900e) for the plan's §13 items that Replies
rests on. The test runs each one.

- **A package's workflow running `agent` with no built-in tools.** The
  `agent` step takes `toolFilter: ["none"]`, `mcp: false` and a `schema`
  (src/steps/core/agent.ts), and nothing at install or in the package fence
  (src/packages/fence.ts) keeps a package's workflow from running it. The
  model the test stands in for is offered `final_answer` alone.
- **A package's step reaching its app's SQLite from a run no page
  started.** `ctx.services.appDb` is on every run's bag, and the fence
  leaves it there. `open(name)` opens that app's file, made by the
  migrations the install applied (src/apps/data.ts).
- **The pages under a Concept, by name.** strut's `graph/graph-get` takes a
  Concept's name and `children: "PARENT_OF"`, and a package's step calls it
  through `ctx.registry` with its own context. `context/concept` would not
  do: it inlines the entry page alone, and lists the pages under it for an
  agent to open with a tool, which this agent does not have.

Two things strut is gaining, worked around nowhere in the package:

- **A workflow's cost cap, shipped by its package.** Today `maxRunCostUsd`
  is a workflow's metadata on the box, set with `PUT
  /workflows/:name/run-cap`. stakwork/strut#874 (open) adds a top-level map
  in `strut.yaml`, by workflow name, which an admin's own cap on the box
  overrides:

  ```yaml
  maxRunCostUsd:
    reply: 1
  ```

  A strut without #874 refuses the key, so it is not in `strut.yaml` yet.
- **A schedule for each person:** stakwork/strut#871, merged into strut's
  `main` ("Running `reply`", above).

Both keys go into `strut.yaml` in one change once both are released, and
this README will then say which strut the package needs.

## What a box needs

- **A strut at or after stakwork/strut#867's merge** (`main` @3a8e900e),
  which has `provides.secrets` and `secrets.own` (#789, #790) too. On an
  older strut, the `agent` step wants a `cwd`, and `reply` fails.
- **Secrets that refresh themselves** (the plan's item 1, in strut). A
  Google access token lasts about an hour. The steps read
  `secrets.own.get("GOOGLE_TOKEN")` and send what it gives as a bearer
  token, so strut must hand them a fresh one. Until it does, a connection
  works for an hour, then the steps say to connect again.
- **Google in stadeum's connect seam** (the plan's item 2):
  `/api/connect/google` taking `scope` and `return`, with
  `CONNECT_GOOGLE_CLIENT_ID` and `_SECRET` set. Without them the route is a
  404, and the app can't tell beforehand.
- **Strut at `strut.<box>`, beside Stadeum at `<box>`**, for Connect (above).
- **A model key**, for Replies: `reply`'s `params.model` is
  `claude-sonnet-5-5`, through whatever key the box has for it.

## Installing it

A box follows the `stable` branch:

```text
git+https://github.com/stakwork/strut-gmail@stable
```

As a subscription, by a person (it moves when `stable` does):

```bash
curl -X PUT $STRUT/packages/subscriptions/gmail -H "authorization: Bearer $KEY" -H "x-strut-actor: $ME" -H 'content-type: application/json' -d '{"ref":"git+https://github.com/stakwork/strut-gmail@stable"}'
```

## Developing it

`package.test.ts` installs this directory into a strut started in the
test's own process from a checkout of stakwork/strut (`STRUT_DIR`), on a
LadybugDB file. It drives the package as the Gmail app's page does, and as
a person's own workflow runs the mail steps.

Gmail is a fake: a real HTTP server on `127.0.0.1` that answers Gmail's API
and Google's revoke for made-up tokens, each its own mailbox. Strut's
`http` reaches it through a fetch that sends Google's two hosts to the fake
and refuses any other address. The fake keeps to the rules above: a reply
joins a thread only with the right headers, `SENT` only on what the mailbox
sent, `+tag` mail in the same mailbox, drafts only with `gmail.compose`.
The deployment is given a `GOOGLE_TOKEN`, to see that no step ever sends
it.

The model is a fake too: an OpenAI-compatible server that the box's
`maple` provider reaches through the deployment's `MAPLE_BASE_URL`, with
`reply` run at `params.model: maple/fake-replier`. So `reply-one` runs
strut's real `agent` step. The fake answers each turn by calling
`final_answer`, deciding from the last mail in the thread, and records the
system prompt, the prompt and the tools it was offered, which the test
reads. The last test looks for every token in what pages and workflows were
given, the runs and their events, the logs, and every file under the data
directory.

```bash
STRUT_DIR=../strut npm test
```

`STRUT_DIR` is a strut checkout with its install (`yarn install
--frozen-lockfile --ignore-scripts`, and the same in `kit/`). With no built
`kit/vendor` there, the test builds the kit's vendor layer itself; a stale
one fails the app's build. `.github/workflows/checks.yml` runs it on every
pull request and push to `main`, against strut's `main`.

To try the app, install the checkout into a strut of your own:

```bash
curl -X POST $STRUT/packages/install -H "authorization: Bearer $KEY" -H "x-strut-actor: $ME" -H 'content-type: application/json' -d "{\"ref\":\"file:$PWD\"}"
```

Connect Google needs a host that frames strut and serves the seam on its
own origin, with strut at `strut.<host>`. On a laptop,
`http://box.localhost:<port>` framing `http://strut.box.localhost:<port>`
works.

## Releasing it

A merge to `main` changes no box. `stable` moves only when someone runs the
`promote` workflow with a commit on `main` whose checks passed. A rollback
is the same run with an older commit:

```bash
gh workflow run promote.yml -R stakwork/strut-gmail -f commit=<sha>
```

The first run makes `stable`.
