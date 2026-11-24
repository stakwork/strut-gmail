# strut-gmail

Gmail for Stadeum. Each person connects their own Google account. Then any
workflow on the box can read, search, draft and send their mail, as them.

This is work item 4 of stadeum's `plans/gmail.md`: Connect, Disconnect and
the mail steps. The ready-made workflows (`reply`, `ask`), the app's Replies
card and the job agent's mail tools come in later items.

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
| `strut.yaml` | `requires.optional: [GOOGLE_TOKEN]`; `provides.secrets: [GOOGLE_TOKEN]`, so its steps read and remove each person's own value. No schedule, job tools or workflows yet |
| `steps/me.ts` | Which mailbox the person connected: Gmail's profile, read with their own token. Says when Google no longer takes it |
| `steps/disconnect.ts` | Revokes the person's grant at Google, then removes their token. From the Gmail app alone, by the person themselves |
| `steps/new.ts` | Mail that matches a search and came since the last look, oldest first |
| `steps/read.ts` | A thread's messages, oldest first |
| `steps/search.ts` | Mail that matches a search, newest first |
| `steps/draft.ts` | A draft in Gmail: a reply in a thread, or a new message |
| `steps/send.ts` | The same, sent |
| `steps/_gmail.ts` | What the steps share: the token, Gmail's API, a message's shape, a message to write |
| `steps/_shape.ts` | A message's shape as the steps declare it |
| `apps/gmail/` | **Gmail**, every person's app (below) |

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

### Replies: `draft` and `send`

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
  drop `DRAFT` either way.

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

## What a box needs

- **A strut with `provides.secrets` and `secrets.own`** (stakwork/strut#789,
  #790). Its `main` has them.
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
it. The last test looks for every token in what pages and workflows were
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
