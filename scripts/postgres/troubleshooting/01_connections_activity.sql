-- Who is connected and what are they doing. Requires PG 16+.

-- 1.1 Connections by state vs. max_connections (with total row)
SELECT CASE WHEN GROUPING(state) = 1 THEN '** total **'
            ELSE COALESCE(state, '(hidden: no permission)') END AS state,
       count(*) AS sessions,
       round(100.0 * count(*) / current_setting('max_connections')::int, 1) AS pct_of_max,
       current_setting('max_connections')::int AS max_connections
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY ROLLUP (state)
ORDER BY GROUPING(state) DESC, sessions DESC;

-- 1.2 Connections by database / user / application / client
SELECT datname, usename, application_name, client_addr, state, count(*) AS sessions,
       min(backend_start) AS oldest_connection,
       max(now() - state_change) AS longest_in_state
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY 1, 2, 3, 4, 5
ORDER BY sessions DESC
LIMIT 50;

-- 1.3 Currently running queries, longest first
SELECT pid, usename, datname, application_name, client_addr,
       now() - query_start AS runtime,
       now() - xact_start AS xact_age,
       wait_event_type, wait_event,
       pg_blocking_pids(pid) AS blocked_by,
       query_id, left(query, 200) AS query
FROM pg_stat_activity
WHERE state = 'active'
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid()
ORDER BY query_start;

-- 1.4 Wait event summary (what is the instance waiting on right now?)
-- A NULL wait_event on an active session means it is running on CPU.
SELECT COALESCE(wait_event_type, '(on CPU)') AS wait_event_type,
       COALESCE(wait_event, '-') AS wait_event,
       count(*) AS sessions,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM pg_stat_activity
WHERE state = 'active' AND pid <> pg_backend_pid()
GROUP BY wait_event_type, wait_event
ORDER BY sessions DESC;

-- 1.5 Idle-in-transaction sessions (hold locks, block vacuum)
SELECT a.pid, a.usename, a.datname, a.application_name, a.client_addr, a.state,
       now() - a.xact_start AS xact_age,
       now() - a.state_change AS idle_for,
       a.backend_xid IS NOT NULL AS has_xid,   -- true = has written, holds row locks
       (SELECT count(*) FROM pg_stat_activity w
        WHERE a.pid = ANY (pg_blocking_pids(w.pid))) AS sessions_blocked,
       left(a.query, 200) AS last_query
FROM pg_stat_activity a
WHERE a.state IN ('idle in transaction', 'idle in transaction (aborted)')
ORDER BY a.xact_start;

-- 1.6 Oldest open transactions (xmin horizon holders)
-- Autovacuum workers are listed but do not hold back the horizon.
SELECT pid, backend_type, usename, state, now() - xact_start AS xact_age,
       backend_xid, age(backend_xid) AS xid_age,
       backend_xmin, age(backend_xmin) AS xmin_age,
       left(query, 200) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()
ORDER BY xact_start
LIMIT 20;

-- 1.7 Prepared (two-phase) transactions left behind: also hold back vacuum
SELECT gid, prepared, owner, database, now() - prepared AS age,
       age(transaction) AS xid_age
FROM pg_prepared_xacts
ORDER BY prepared;

-- 1.8 Background workers / autovacuum in flight
SELECT backend_type, count(*) AS processes,
       count(*) FILTER (WHERE state = 'active') AS active
FROM pg_stat_activity
GROUP BY 1
ORDER BY 2 DESC;

-- 1.9 Terminate / cancel templates (DESTRUCTIVE - edit pid first)
-- On RDS you need rds_superuser (or the same role) to signal other sessions.
-- SELECT pg_cancel_backend(12345);      -- cancel current query
-- SELECT pg_terminate_backend(12345);   -- kill the session
--
-- Preview first, then terminate, e.g. idle-in-transaction > 30 min:
-- SELECT pid, usename, application_name, now() - state_change AS idle_for, left(query, 100)
-- FROM pg_stat_activity
-- WHERE state LIKE 'idle in transaction%' AND now() - state_change > interval '30 minutes'
--   AND pid <> pg_backend_pid();
-- ...then swap the select list for pg_terminate_backend(pid) with the same WHERE clause.
