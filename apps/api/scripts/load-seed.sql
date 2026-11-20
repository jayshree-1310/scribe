-- Synthetic volume for load testing: a platform some way past launch.
--
--   20,000 readers (1,000 of them authors), 5,000 listed stories plus 2,000
--   catalogue editions, 60,000 chapters, ~200,000 shelf entries, ~500,000
--   story views and chapter reads, ~100,000 ratings, ~150,000 follows and
--   ~300,000 notifications.
--
-- For a DEDICATED database only -- it inserts tens of thousands of fake users
-- and does not clean up after itself. The load-test recipe in
-- docs/LOAD-TESTING.md creates `scribe_load`, migrates it, then runs:
--
--   docker exec -i scribe-postgres psql -U scribe -d scribe_load < scripts/load-seed.sql
--
-- Chapter bodies are a realistic length (~1,500 words) but repetitive, so
-- TOAST compresses them to almost nothing on disk while the API still reads
-- and sends the full text -- which is the cost that matters.

\set ON_ERROR_STOP on
SET synchronous_commit = off;

BEGIN;

INSERT INTO content.genre (id, name, hue)
SELECT gen_random_uuid()::text, g, (row_number() OVER () * 30)::int % 360
FROM unnest(ARRAY['Fantasy','Romance','Mystery','Thriller','Science Fiction','Horror',
                  'Historical','Literary','Young Adult','Comedy','Adventure','Poetry']) AS g
ON CONFLICT (name) DO NOTHING;

INSERT INTO auth."user" (id, email, username, "displayName", "isAuthor", "emailVerified", "createdAt")
SELECT gen_random_uuid()::text, 'load' || i || '@example.test', 'load_user_' || i, 'Load User ' || i,
       i <= 1000, true, now() - (random() * interval '400 days')
FROM generate_series(1, 20000) AS i;

CREATE TEMP TABLE u AS SELECT id, row_number() OVER (ORDER BY username) AS n FROM auth."user" WHERE username LIKE 'load_user_%';
CREATE TEMP TABLE a AS SELECT id, row_number() OVER (ORDER BY id) AS n FROM auth."user" WHERE username LIKE 'load_user_%' AND "isAuthor";
CREATE TEMP TABLE g AS SELECT id, row_number() OVER (ORDER BY name) AS n FROM content.genre;

INSERT INTO content.story (id, slug, title, description, "authorId", source, "listedAt", "publishedAt",
                           "likeCount", "viewCount", "ratingAverage", "ratingCount", "isCompleted", "kidsAppropriate", "createdAt")
SELECT gen_random_uuid()::text,
       'load-story-' || i,
       initcap((ARRAY['the','a','last','silent','burning','hidden','broken','golden'])[1 + i % 8] || ' ' ||
               (ARRAY['lantern','harbour','orchard','kingdom','letter','winter','garden','machine','river','crown'])[1 + i % 10] || ' ' || i),
       'A synthetic story for load testing, number ' || i || '. ' || repeat('It is long enough to look like a real blurb. ', 6),
       (SELECT id FROM a WHERE a.n = 1 + (i % 1000)),
       CASE WHEN i <= 5000 THEN 'SCRIBE' ELSE 'CATALOGUE' END,
       CASE WHEN i <= 5000 THEN now() - (random() * interval '365 days') END,
       now() - (random() * interval '365 days'),
       (random() ^ 3 * 5000)::int, (random() ^ 3 * 100000)::int,
       round((2.5 + random() * 2.5)::numeric, 2), (random() * 200)::int,
       random() < 0.4, random() < 0.2,
       now() - (random() * interval '400 days')
FROM generate_series(1, 7000) AS i;

CREATE TEMP TABLE s AS SELECT id, row_number() OVER (ORDER BY slug) AS n FROM content.story WHERE slug LIKE 'load-story-%' AND source = 'SCRIBE';

INSERT INTO content."storyGenre" ("storyId", "genreId")
SELECT DISTINCT st.id, g.id
FROM content.story st
CROSS JOIN LATERAL generate_series(1, 1 + (abs(hashtext(st.id)) % 3)) AS k
JOIN g ON g.n = 1 + (abs(hashtext(st.id || k)) % 12)
WHERE st.slug LIKE 'load-story-%';

-- 12 chapters per listed story; the body is the same paragraph repeated.
INSERT INTO content.chapter (id, "storyId", "chapterNumber", title, content, "wordCount", "publishedAt")
SELECT gen_random_uuid()::text, s.id, c, 'Chapter ' || c,
       repeat('The fog came in off the water at six, as it always did, and the lamps along the quay were lit one after another by a girl who had not asked for the job. ', 50),
       1600, now() - (random() * interval '300 days')
FROM s CROSS JOIN generate_series(1, 12) AS c;

INSERT INTO auth."genrePreference" ("userId", "genreId")
SELECT DISTINCT u.id, g.id FROM u
CROSS JOIN LATERAL generate_series(1, 2) AS k
JOIN g ON g.n = 1 + (abs(hashtext(u.id || k)) % 12);

INSERT INTO library."libraryEntry" (id, "userId", "storyId", status)
SELECT gen_random_uuid()::text, u.id, s.id,
       (ARRAY['WANT_TO_READ','READING','FINISHED'])[1 + (abs(hashtext(u.id || s.id)) % 3)]
FROM u CROSS JOIN LATERAL generate_series(1, 10) AS k
JOIN s ON s.n = 1 + (abs(hashtext(u.id || 'shelf' || k)) % 5000)
ON CONFLICT ("userId", "storyId") DO NOTHING;

INSERT INTO engagement.rating (id, "userId", "storyId", rating)
SELECT gen_random_uuid()::text, u.id, s.id, 1 + (abs(hashtext(u.id || s.id)) % 5)
FROM u CROSS JOIN LATERAL generate_series(1, 5) AS k
JOIN s ON s.n = 1 + (abs(hashtext(u.id || 'rate' || k)) % 5000)
ON CONFLICT ("userId", "storyId") DO NOTHING;

INSERT INTO engagement."readingHistory" (id, "userId", "storyId", progress, "lastReadAt")
SELECT gen_random_uuid()::text, u.id, s.id, (random() * 100)::int, now() - random() * interval '90 days'
FROM u CROSS JOIN LATERAL generate_series(1, 5) AS k
JOIN s ON s.n = 1 + (abs(hashtext(u.id || 'read' || k)) % 5000)
ON CONFLICT ("userId", "storyId") DO NOTHING;

-- Follows skew towards the first hundred authors, as follows do.
INSERT INTO engagement.follow (id, "followerId", "followingId", "createdAt")
SELECT gen_random_uuid()::text, u.id, a.id, x.d
FROM (SELECT un, 1 + floor((random() ^ 2) * 1000)::int AS an, now() - random() * interval '300 days' AS d
      FROM generate_series(1, 20000) AS un CROSS JOIN generate_series(1, 8)) AS x
JOIN u ON u.n = x.un
JOIN a ON a.n = x.an
WHERE u.id <> a.id
ON CONFLICT ("followerId", "followingId") DO NOTHING;

-- Views and reads over the last 90 days, one row per visitor per target per day.
-- random() sits in the subquery's select list, where it is evaluated per row;
-- in a join condition the planner is free to evaluate it once.
INSERT INTO engagement."storyView" (id, "storyId", "userId", "visitorKey", day, "createdAt")
SELECT gen_random_uuid()::text, s.id, u.id, 'user:' || u.id, to_char(x.d, 'YYYY-MM-DD'), x.d
FROM (SELECT i, 1 + floor((random() ^ 2) * 5000)::int AS sn, now() - random() * interval '90 days' AS d
      FROM generate_series(1, 500000) AS i) AS x
JOIN s ON s.n = x.sn
JOIN u ON u.n = 1 + (x.i % 20000)
ON CONFLICT DO NOTHING;

INSERT INTO engagement."chapterRead" (id, "chapterId", "storyId", "userId", "visitorKey", day, "createdAt")
SELECT gen_random_uuid()::text, ch.id, ch."storyId", u.id, 'user:' || u.id, to_char(x.d, 'YYYY-MM-DD'), x.d
FROM (SELECT i, 1 + floor((random() ^ 2) * 5000)::int AS sn, 1 + floor(random() * 12)::int AS cn,
             now() - random() * interval '90 days' AS d
      FROM generate_series(1, 500000) AS i) AS x
JOIN s ON s.n = x.sn
JOIN content.chapter ch ON ch."storyId" = s.id AND ch."chapterNumber" = x.cn
JOIN u ON u.n = 1 + (x.i % 20000)
ON CONFLICT DO NOTHING;

INSERT INTO notifications.notification (id, "userId", type, title, href, "createdAt", "readAt")
SELECT gen_random_uuid()::text, u.id, 'NEW_STORY', 'A new story from an author you follow', '/stories/load-story-1',
       now() - random() * interval '120 days', CASE WHEN random() < 0.7 THEN now() END
FROM u CROSS JOIN generate_series(1, 15);

COMMIT;

ANALYZE;

SELECT 'users' AS what, count(*) FROM auth."user"
UNION ALL SELECT 'stories', count(*) FROM content.story
UNION ALL SELECT 'chapters', count(*) FROM content.chapter
UNION ALL SELECT 'shelf entries', count(*) FROM library."libraryEntry"
UNION ALL SELECT 'story views', count(*) FROM engagement."storyView"
UNION ALL SELECT 'chapter reads', count(*) FROM engagement."chapterRead"
UNION ALL SELECT 'ratings', count(*) FROM engagement.rating
UNION ALL SELECT 'follows', count(*) FROM engagement.follow
UNION ALL SELECT 'notifications', count(*) FROM notifications.notification;
