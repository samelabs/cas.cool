-- Post.mentionUsernames: lowercase usernames that were extracted from the
-- post content at write time AND confirmed to exist in "User". The render
-- layer links an @token to /u/<name> only when the name is in this list;
-- everything else renders as plain text (spec: no regex-only mention links,
-- because /u/<unknown> is a guaranteed 404).
-- No backfill: existing posts keep the empty default, i.e. their @tokens
-- render as plain text from now on. Deliberate — no legacy compatibility.
ALTER TABLE "Post" ADD COLUMN "mentionUsernames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
