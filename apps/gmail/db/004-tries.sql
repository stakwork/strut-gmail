-- A mail that keeps failing goes to the person (Evan's ruling): how many
-- times `reply` set out to write a reply to a message and never got as far
-- as `answer` recording what it did. A row goes once the message has an
-- outcome. At three, `context` hands the message to the person instead of a
-- fourth try, so the mail after it is answered. Ids and a count: no mail.
CREATE TABLE tries (
  actor TEXT NOT NULL,
  message TEXT NOT NULL,
  count INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (actor, message)
);
