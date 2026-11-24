-- The Gmail app's own database: each person's choices for Replies, and what
-- `answer` did with each message. Kept by person (strut's actor), never by
-- address. No mail: no sender, no subject, no text. Those are read from
-- Gmail, with the person's own token, when the page shows them.

-- A person's choices. No row: the defaults, so Replies is on from the
-- moment a person connects.
CREATE TABLE people (
  actor TEXT PRIMARY KEY,
  replies INTEGER NOT NULL DEFAULT 1,
  search TEXT NOT NULL DEFAULT 'in:inbox category:primary to:me',
  instructions TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- What `answer` did with a message, once: `draft`, `handoff` (Needs you),
-- `nothing`, or `stood-down` (the person had answered, or newer mail came).
-- `draft` is the Gmail draft it left, while it is the thread's latest.
CREATE TABLE handled (
  actor TEXT NOT NULL,
  message TEXT NOT NULL,
  thread TEXT NOT NULL,
  did TEXT NOT NULL,
  draft TEXT,
  reason TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (actor, message)
);

CREATE INDEX handled_thread ON handled (actor, thread);
CREATE INDEX handled_did ON handled (actor, did, at);
