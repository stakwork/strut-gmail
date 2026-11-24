-- Email Jamie (stadeum plans/gmail.md §4.4): a person writes to their own
-- address with +jamie, a job does the work, and the answer comes back in
-- the thread. Ids only: no mail and no address.

-- Email Jamie is off until the person turns it on.
ALTER TABLE people ADD COLUMN ask INTEGER NOT NULL DEFAULT 0;

-- Which job a thread is: every turn in the thread continues it.
CREATE TABLE asks (
  actor TEXT NOT NULL,
  thread TEXT NOT NULL,
  job TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (actor, thread)
);

-- One turn: a message the person sent, the job's run it started, and the
-- answer. `state`: `waiting` (the thread's last turn is not answered yet),
-- `running` (its run is the job's turn), `sending` (the answer's draft is
-- made: `draft`), `answered` (`answer` is the message sent, when known).
-- `failed`: the job's turn failed, and the answer said so.
CREATE TABLE ask_turns (
  actor TEXT NOT NULL,
  message TEXT NOT NULL,
  thread TEXT NOT NULL,
  job TEXT,
  run TEXT,
  state TEXT NOT NULL,
  draft TEXT,
  answer TEXT,
  failed INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  PRIMARY KEY (actor, message)
);

CREATE INDEX ask_turns_state ON ask_turns (actor, state);
CREATE INDEX ask_turns_thread ON ask_turns (actor, thread);
