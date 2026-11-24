-- Send (stadeum plans/gmail.md §4.3): a person's choice, and what went out
-- without a click. Still no mail and no address: ids, what was done, why.

-- 'draft' (every reply is a draft), 'written' (sent to a sender the
-- person has written to before; anyone else gets a draft) or 'anyone'.
ALTER TABLE people ADD COLUMN choice TEXT NOT NULL DEFAULT 'draft';

-- `sent`: the id of the message `answer` sent, when it sent one
-- (did = 'sent'). `held`: why a reply the choice would have sent was left
-- as a draft instead.
ALTER TABLE handled ADD COLUMN sent TEXT;
ALTER TABLE handled ADD COLUMN held TEXT;
