-- Who is connected and what are they doing. Requires PG 16+.

-- 1.1 Connections by state vs. max_connections
SELECT state, count(*) AS sessions,
       round(100.0 * count(*) / current_setting('max_connections')::int, 1) AS pct_of_max
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state
ORDER BY sessions DESC;

-- 1.2 Connections by database / user / application / client
SELECT datname, usename, application_name, client_addr, state, count(*) AS sessions
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY 1, 2, 3, 4, 5
ORDER BY sessions DESC;

-- 1.3 Currently running queries, longest first
SELECT pid, usename, datname, application_name, client_addr,
       now() - query_start AS runtime,
       wait_event_type, wait_event, query_id, left(query, 200) AS query
FROM pg_stat_activity
WHERE state = 'active'
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid()
ORDER BY query_start;

-- 1.4 Wait event summary (what is the instance waiting on right now?)
SELECT wait_event_type, wait_event, count(*) AS sessions
FROM pg_stat_activity
WHERE state = 'active' AND wait_event IS NOT NULL
GROUP BY 1, 2
ORDER BY sessions DESC;

-- 1.5 Idle-in-transaction sessions (hold locks, block vacuum)
SELECT pid, usename, datname, application_name, client_addr,
       now() - xact_start AS xact_age,
       now() - state_change AS idle_for,
       left(query, 200) AS last_query
FROM pg_stat_activity
WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
ORDER BY xact_start;

-- 1.6 Oldest open transactions (xmin horizon holders)
SELECT pid, usename, state, now() - xact_start AS xact_age,
       backend_xid, backend_xmin, age(backend_xmin) AS xmin_age,
       left(query, 200) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()
ORDER BY xact_start
LIMIT 20;

-- 1.7 Prepared (two-phase) transactions left behind: also hold back vacuum
SELECT gid, prepared, owner, database, now() - prepared AS age
FROM pg_prepared_xacts
ORDER BY prepared;

-- 1.8 Background workers / autovacuum in flight
SELECT backend_type, count(*)
FROM pg_stat_activity
GROUP BY 1
ORDER BY 2 DESC;

-- 1.9 Terminate / cancel templates (DESTRUCTIVE - edit pid first)
-- SELECT pg_cancel_backend(12345);      -- cancel current query
-- SELECT pg_terminate_backend(12345);   -- kill the session
