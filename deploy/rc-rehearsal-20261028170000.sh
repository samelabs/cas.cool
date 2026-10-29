#!/usr/bin/env bash
# RC migration rehearsal — dirty-data copies, three scenarios:
#   F1 (cascool_rc_f1): OLD version vs MENTION data  → must fail & roll back (proves
#                       any DB that recorded the old version had zero MENTION rows)
#   N  (cascool_rc_n) : fresh apply of the REWRITTEN migration on full dirty seed
#   R  (cascool_rc_r) : OLD version applied on MENTION-free seed, then repair +
#                       checksum re-baseline → must equal N's end state
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .tmp/rc-rehearsal
cp deploy/repair-20261028170000-old-version.sql .tmp/rc-rehearsal/repair.sql

DBS="cascool_rc_f1 cascool_rc_n cascool_rc_r"
NEW_SHA=$(shasum -a 256 prisma/migrations/20261028170000_governance_rc_schema_fixes/migration.sql | cut -d' ' -f1)
OLD_SHA=$(git show 463f197:prisma/migrations/20261028170000_governance_rc_schema_fixes/migration.sql | shasum -a 256 | cut -d' ' -f1)
NEW_SQL=.tmp/rc-rehearsal/new.sql
OLD_SQL=.tmp/rc-rehearsal/old.sql
git show 463f197:prisma/migrations/20261028170000_governance_rc_schema_fixes/migration.sql > "$OLD_SQL"
cp prisma/migrations/20261028170000_governance_rc_schema_fixes/migration.sql "$NEW_SQL"
echo "NEW sha=$NEW_SHA"
echo "OLD sha=$OLD_SHA"

for db in $DBS; do
  psql -U "${PGUSER:-tim}" -d postgres -qac "DROP DATABASE IF EXISTS $db" >/dev/null
  psql -U "${PGUSER:-tim}" -d postgres -qac "CREATE DATABASE $db" >/dev/null
done

apply_base() { # chain 1..8 (everything before 20261028170000)
  psql -U "${PGUSER:-tim}" -d "$1" -qc 'CREATE TABLE IF NOT EXISTS _prisma_migrations (
    id VARCHAR(36) PRIMARY KEY NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL,
    logs TEXT,
    rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0
  )' >/dev/null
  for dir in prisma/migrations/*/; do
    name=$(basename "$dir")
    [ "$name" = "20261028170000_governance_rc_schema_fixes" ] && continue
    [ "$name" = "20261028200000_side_effect_outbox" ] && continue
    sha=$(shasum -a 256 "$dir/migration.sql" | cut -d' ' -f1)
    # CONCURRENTLY cannot run inside a transaction (Prisma runs such files
    # non-transactionally too); every other file applies atomically.
    if grep -q "CONCURRENTLY" "$dir/migration.sql"; then
      psql -U "${PGUSER:-tim}" -d "$1" -q -v ON_ERROR_STOP=1 -f "$dir/migration.sql" >/dev/null
    else
      psql -U "${PGUSER:-tim}" -d "$1" -1 -q -v ON_ERROR_STOP=1 -f "$dir/migration.sql" >/dev/null
    fi
    psql -U "${PGUSER:-tim}" -d "$1" -qc "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, applied_steps_count)
                             VALUES (gen_random_uuid()::text, '$sha', now(), '$name', NULL, 0)" >/dev/null
  done
}
for db in $DBS; do apply_base "$db"; done

seed_common() { # adversarial Repost/Post data, NO notifications yet
  psql -U "${PGUSER:-tim}" -d "$1" -1 -q -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "User" (id, email, username, "passwordHash", "postCount", "createdAt", "updatedAt") VALUES
  ('u1','u1@t.test','u1','x',3,now(),now()),
  ('u2','u2@t.test','u2','x',2,now(),now()),
  ('u3','u3@t.test','u3','x',2,now(),now());
INSERT INTO "Post" (id, "shortCode", "authorId", content, images, "createdAt", "updatedAt") VALUES
  ('tp1','tp000001','u1','target one','{}'::text[], now()-interval '10 days', now()-interval '10 days'),
  ('tp2','tp000002','u1','target two','{}'::text[], now()-interval '9 days', now()-interval '9 days'),
  ('tp3','tp000003','u2','target three','{}'::text[], now()-interval '8 days', now()-interval '8 days'),
  ('tp4','tp000004','u2','target four','{}'::text[], now()-interval '7 days', now()-interval '7 days');
-- R1 exact match
INSERT INTO "Post" (id, "shortCode", "authorId", content, "quotePostId", images, "createdAt", "updatedAt") VALUES
  ('gen_ok','genok001','u2','','tp1','{}'::text[], now()-interval '6 days', now()-interval '6 days');
INSERT INTO "Repost" (id, "postId", "userId", "createdAt") VALUES ('r1','tp1','u2', now()-interval '6 days');
-- R2 UNMATCHED (no generated post at all)
INSERT INTO "Repost" (id, "postId", "userId", "createdAt") VALUES ('r2','tp2','u3', now()-interval '5 days');
-- R3 MULTI-MATCH (gen_early is the deterministic winner: earlier createdAt)
INSERT INTO "Post" (id, "shortCode", "authorId", content, "quotePostId", images, "createdAt", "updatedAt") VALUES
  ('gen_late','genlate01','u3','','tp3','{}'::text[], now()-interval '4 days', now()-interval '4 days'),
  ('gen_early','genearly1','u3','','tp3','{}'::text[], now()-interval '5 days', now()-interval '5 days');
INSERT INTO "Repost" (id, "postId", "userId", "createdAt") VALUES ('r3','tp3','u3', now()-interval '5 days');
-- R4 only a TOMBSTONED match (old version filtered deletedAt and left it NULL)
INSERT INTO "Post" (id, "shortCode", "authorId", content, "quotePostId", images, "deletedAt", "createdAt", "updatedAt") VALUES
  ('gen_dead','gendead01','u2','','tp4','{}'::text[], now()-interval '1 days', now()-interval '3 days', now()-interval '3 days');
INSERT INTO "Repost" (id, "postId", "userId", "createdAt") VALUES ('r4','tp4','u2', now()-interval '3 days');
-- orphan pure-repost post with NO Repost row (historical orphan — must survive untouched)
INSERT INTO "Post" (id, "shortCode", "authorId", content, "quotePostId", images, "createdAt", "updatedAt") VALUES
  ('orphan1','orphan001','u3','','tp1','{}'::text[], now()-interval '2 days', now()-interval '2 days');
SQL
}
for db in $DBS; do seed_common "$db"; done

seed_notifications() { # $1=db  $2=mention (set to "mention" to include MENTION rows)
  psql -U "${PGUSER:-tim}" -d "$1" -1 -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO "Notification" (id, "userId", "fromId", type, "postId", read, "createdAt") VALUES
  ('n_like_1','u1','u3','LIKE','tp1',true, now()-interval '5 days'),
  ('n_report_1','u1','u2','REPORT_RESOLVED','tp2',false, now()-interval '4 days')
  ${2:+,('n_mention_1','u1','u2','MENTION','tp1',false, now()-interval '6 days')
  ,('n_mention_2','u2','u3','MENTION',NULL,false, now()-interval '6 days')};
SQL
}
seed_notifications cascool_rc_f1 mention
seed_notifications cascool_rc_n mention
seed_notifications cascool_rc_r

state() { # $1=db  $2=label  $3=phase(pre|post)
  echo "===== $2 ($1) ====="
  if [ "$3" = pre ]; then
    psql -U "${PGUSER:-tim}" -d "$1" -tA <<'SQL'
SELECT json_build_object(
  'reposts', (SELECT count(*) FROM "Repost"),
  'posts_total', (SELECT count(*) FROM "Post"),
  'posts_live', (SELECT count(*) FROM "Post" WHERE "deletedAt" IS NULL),
  'orphan_pure_reposts_norepost', (SELECT count(*) FROM "Post" p WHERE p.content='' AND p."quotePostId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Repost" r WHERE r."postId" = p."quotePostId" AND r."userId" = p."authorId")),
  'notif_total', (SELECT count(*) FROM "Notification"),
  'notif_mention', (SELECT count(*) FROM "Notification" WHERE type::text='MENTION'),
  'notif_like_report', (SELECT count(*) FROM "Notification" WHERE type::text IN ('LIKE','REPORT_RESOLVED')),
  'enum_allows_mention', EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='NotificationType' AND e.enumlabel='MENTION'),
  'repostPostId_column_exists', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Repost' AND column_name='repostPostId'),
  'user_postcounts', (SELECT json_object_agg(username, "postCount") FROM "User")
)::text;
SQL
  else
    psql -U "${PGUSER:-tim}" -d "$1" -tA <<'SQL'
SELECT json_build_object(
  'reposts', (SELECT count(*) FROM "Repost"),
  'reposts_unlinked', (SELECT count(*) FROM "Repost" WHERE "repostPostId" IS NULL),
  'posts_total', (SELECT count(*) FROM "Post"),
  'posts_live', (SELECT count(*) FROM "Post" WHERE "deletedAt" IS NULL),
  'orphan_pure_reposts', (SELECT count(*) FROM "Post" p WHERE p.content='' AND p."quotePostId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Repost" r WHERE r."repostPostId" = p.id)),
  'notif_total', (SELECT count(*) FROM "Notification"),
  'notif_mention', (SELECT count(*) FROM "Notification" WHERE type::text='MENTION'),
  'notif_like_report', (SELECT count(*) FROM "Notification" WHERE type::text IN ('LIKE','REPORT_RESOLVED')),
  'enum_allows_mention', EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='NotificationType' AND e.enumlabel='MENTION'),
  'repostPostId_not_null', (SELECT attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relname='Repost' AND a.attname='repostPostId'),
  'user_postcounts', (SELECT json_object_agg(username, "postCount") FROM "User")
)::text;
SELECT 'link r1=' || COALESCE("repostPostId",'NULL') FROM "Repost" WHERE id='r1';
SELECT 'link r2=' || COALESCE("repostPostId",'NULL') FROM "Repost" WHERE id='r2';
SELECT 'link r3=' || COALESCE("repostPostId",'NULL') FROM "Repost" WHERE id='r3';
SELECT 'link r4=' || COALESCE("repostPostId",'NULL') FROM "Repost" WHERE id='r4';
SELECT conname || ': ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='"Repost"'::regclass AND contype='f';
SQL
  fi
}

state cascool_rc_n "PRE  N (fresh-apply path, with MENTION rows)" pre
state cascool_rc_r "PRE  R (old-then-repair path, MENTION-free — old version could only succeed on such data)" pre

echo
echo "===== F1: OLD version against MENTION data (single transaction, Prisma semantics) ====="
if psql -U "${PGUSER:-tim}" -d cascool_rc_f1 -1 -q -v ON_ERROR_STOP=1 -f "$OLD_SQL" >/dev/null 2>.tmp/rc-rehearsal/f1.err; then
  echo "UNEXPECTED: old version succeeded on MENTION data"
  exit 1
else
  echo "EXPECTED FAILURE + ROLLBACK: $(tail -1 .tmp/rc-rehearsal/f1.err)"
  psql -U "${PGUSER:-tim}" -d cascool_rc_f1 -tAc "SELECT 'mention rows still present: ' || count(*) FROM \"Notification\" WHERE type::text='MENTION'"
  psql -U "${PGUSER:-tim}" -d cascool_rc_f1 -tAc "SELECT 'repostPostId column still absent: ' || (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Repost' AND column_name='repostPostId'))::text"
fi

echo
echo "===== N: apply REWRITTEN migration ====="
psql -U "${PGUSER:-tim}" -d cascool_rc_n -1 -q -v ON_ERROR_STOP=1 -f "$NEW_SQL" >/dev/null
psql -U "${PGUSER:-tim}" -d cascool_rc_n -qc "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, applied_steps_count) VALUES (gen_random_uuid()::text, '$NEW_SHA', now(), '20261028170000_governance_rc_schema_fixes', NULL, 0)" >/dev/null
state cascool_rc_n "POST N" post

echo
echo "===== R: apply OLD version, then repair + checksum re-baseline ====="
psql -U "${PGUSER:-tim}" -d cascool_rc_r -1 -q -v ON_ERROR_STOP=1 -f "$OLD_SQL" >/dev/null
psql -U "${PGUSER:-tim}" -d cascool_rc_r -qc "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, applied_steps_count) VALUES (gen_random_uuid()::text, '$OLD_SHA', now(), '20261028170000_governance_rc_schema_fixes', NULL, 0)" >/dev/null
state cascool_rc_r "MID R (old version applied — note r2 NULL, nullable column, SET NULL fk, arbitrary r3 pick)" post
echo "r3 pick (old version, non-deterministic in general):"
psql -U "${PGUSER:-tim}" -d cascool_rc_r -tAc "SELECT \"repostPostId\" FROM \"Repost\" WHERE id='r3'"

psql -U "${PGUSER:-tim}" -d cascool_rc_r -1 -q -v ON_ERROR_STOP=1 -f .tmp/rc-rehearsal/repair.sql >/dev/null
psql -U "${PGUSER:-tim}" -d cascool_rc_r -qc "UPDATE _prisma_migrations SET checksum='$NEW_SHA' WHERE migration_name='20261028170000_governance_rc_schema_fixes'" >/dev/null
state cascool_rc_r "POST R (after repair)" post

echo
echo "===== N vs R end-state diff (must be empty) ====="
for db in cascool_rc_n cascool_rc_r; do
  psql -U "${PGUSER:-tim}" -d "$db" -tA > ".tmp/rc-rehearsal/end_$db.txt" <<'SQL'
SELECT json_build_object(
  'reposts', (SELECT count(*) FROM "Repost"),
  'posts_total', (SELECT count(*) FROM "Post"),
  'posts_live', (SELECT count(*) FROM "Post" WHERE "deletedAt" IS NULL),
  'orphan_pure_reposts', (SELECT count(*) FROM "Post" p WHERE p.content='' AND p."quotePostId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Repost" r WHERE r."repostPostId" = p.id)),
  'notif_like_report', (SELECT count(*) FROM "Notification" WHERE type::text IN ('LIKE','REPORT_RESOLVED')),
  'enum_allows_mention', EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='NotificationType' AND e.enumlabel='MENTION'),
  'repostPostId_not_null', (SELECT attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relname='Repost' AND a.attname='repostPostId'),
  'user_postcounts', (SELECT json_object_agg(username, "postCount") FROM "User"),
  'links', (SELECT json_object_agg(id, "repostPostId") FROM "Repost")
)::text;
SELECT conname || ': ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='"Repost"'::regclass AND contype='f';
SELECT 'synth r2: ' || p.id || ' quote=' || p."quotePostId" || ' author=' || p."authorId" || ' live=' || (p."deletedAt" IS NULL) || ' counts0=' || (p."likeCount"=0 AND p."replyCount"=0 AND p."repostCount"=0) FROM "Post" p JOIN "Repost" r ON r."repostPostId"=p.id WHERE r.id='r2';
SELECT 'r4 target tombstoned still: ' || ("deletedAt" IS NOT NULL)::text FROM "Post" WHERE id='gen_dead';
SELECT 'gen_late still live unlinked: ' || ("deletedAt" IS NULL)::text FROM "Post" WHERE id='gen_late';
SELECT 'orphan1 intact: content=' || quote_literal(content) || ' deleted=' || ("deletedAt" IS NOT NULL)::text FROM "Post" WHERE id='orphan1';
SQL
done
diff .tmp/rc-rehearsal/end_cascool_rc_n.txt .tmp/rc-rehearsal/end_cascool_rc_r.txt && echo "IDENTICAL"

echo
echo "===== prisma migrate deploy + status against both rehearsal DBs ====="
for db in cascool_rc_n cascool_rc_r; do
  echo "--- $db ---"
  DATABASE_URL="postgresql://${PGUSER:-tim}@localhost:5432/$db" npx prisma migrate deploy 2>&1 | tail -3
  DATABASE_URL="postgresql://${PGUSER:-tim}@localhost:5432/$db" npx prisma migrate status 2>&1 | tail -3
done
