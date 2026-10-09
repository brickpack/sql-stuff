-- Lock contention and blocking chains. Requires PG 16+.

-- 2.1 Blocked sessions and who blocks them (one row per blocked/blocker pair)
SELECT blocked.pid AS blocked_pid,
       blocked.usename AS blocked_user,
       blocked.application_name AS blocked_app,
       now() - blocked.query_start AS blocked_for,
       blocked.wait_event_type, blocked.wait_event,
       w.locktype, w.mode AS wanted_mode,
       CASE WHEN w.locktype = 'relation'
             AND w.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            THEN w.relation::regclass::text END AS relation,
       blocker.pid AS blocker_pid,
       blocker.usename AS blocker_user,
       blocker.state AS blocker_state,
       now() - blocker.xact_start AS blocker_xact_age,
       left(blocked.query, 150) AS blocked_query,
       left(blocker.query, 150) AS blocker_query
FROM pg_stat_activity blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS bp(pid)
JOIN pg_stat_activity blocker ON blocker.pid = bp.pid
LEFT JOIN pg_locks w ON w.pid = blocked.pid AND NOT w.granted
ORDER BY blocked.query_start;

-- 2.2 Root blockers (block others but are not blocked themselves)
-- sessions_blocked counts direct victims; see 2.7 for the full chain.
WITH edges AS (
  SELECT pid AS blocked_pid, unnest(pg_blocking_pids(pid)) AS blocker_pid
  FROM pg_stat_activity
)
SELECT a.pid, a.usename, a.application_name, a.client_addr, a.state,
       now() - a.xact_start AS xact_age,
       now() - a.state_change AS in_state_for,
       count(DISTINCT e.blocked_pid) AS sessions_blocked,
       left(a.query, 200) AS query
FROM edges e
JOIN pg_stat_activity a ON a.pid = e.blocker_pid
WHERE cardinality(pg_blocking_pids(a.pid)) = 0
GROUP BY a.pid, a.usename, a.application_name, a.client_addr, a.state,
         a.xact_start, a.state_change, a.query
ORDER BY sessions_blocked DESC;

-- 2.3 Locks held/awaited, with relation names (current database only)
SELECT l.pid, a.usename, a.state, l.locktype, l.mode, l.granted,
       CASE WHEN l.locktype = 'relation' THEN l.relation::regclass::text END AS relation,
       pg_blocking_pids(l.pid) AS blocked_by,
       now() - a.query_start AS query_age,
       left(a.query, 120) AS query
FROM pg_locks l
JOIN pg_stat_activity a USING (pid)
WHERE l.locktype IN ('relation', 'transactionid', 'tuple', 'advisory')
  AND (l.database IS NULL OR l.database = (SELECT oid FROM pg_database WHERE datname = current_database()))
  AND a.pid <> pg_backend_pid()
  -- AND NOT (l.granted AND l.mode = 'AccessShareLock')   -- uncomment to cut the noise
ORDER BY l.granted, query_age DESC NULLS LAST;

-- 2.4 Advisory locks, decoded, with the owning session
-- objsubid 1 = pg_advisory_lock(bigint) (key rebuilt below); 2 = pg_advisory_lock(int, int).
SELECT l.pid, a.usename, a.application_name, a.state,
       l.database, l.objsubid, l.classid, l.objid,
       CASE WHEN l.objsubid = 1 THEN (l.classid::bigint << 32) | l.objid::bigint END AS bigint_key,
       l.mode, l.granted,
       now() - a.xact_start AS xact_age,
       left(a.query, 120) AS query
FROM pg_locks l
JOIN pg_stat_activity a USING (pid)
WHERE l.locktype = 'advisory'
ORDER BY l.granted, l.pid;

-- 2.5 Deadlock counters and rollback rate per database
-- Counters are cumulative; save deadlocks + sampled_at and diff over time to get a rate.
-- conflicts only counts queries cancelled on a standby, so it is always 0 on a primary.
SELECT datname, deadlocks, conflicts, xact_commit, xact_rollback,
       round(100.0 * xact_rollback / NULLIF(xact_commit + xact_rollback, 0), 2) AS rollback_pct,
       stats_reset, now() AS sampled_at
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY deadlocks DESC;

-- 2.6 Current lock-related settings, and where each value comes from
SELECT name, setting, unit, source
FROM pg_settings
WHERE name IN ('deadlock_timeout', 'lock_timeout', 'statement_timeout',
               'idle_in_transaction_session_timeout', 'idle_session_timeout',
               'log_lock_waits', 'max_locks_per_transaction', 'max_prepared_transactions');

-- 2.6b Per-role / per-database overrides (these win over the global values above)
SELECT coalesce(r.rolname, '(all roles)') AS role,
       coalesce(d.datname, '(all dbs)') AS db,
       s.setconfig
FROM pg_db_role_setting s
LEFT JOIN pg_roles r ON r.oid = s.setrole
LEFT JOIN pg_database d ON d.oid = s.setdatabase;

-- 2.7 Blocking chains as a tree (root blocker first, victims indented)
WITH RECURSIVE edges AS (
  SELECT pid AS blocked_pid, unnest(pg_blocking_pids(pid)) AS blocker_pid
  FROM pg_stat_activity
),
tree AS (
  SELECT a.pid, a.pid AS root_pid, 0 AS depth, ARRAY[a.pid] AS path
  FROM pg_stat_activity a
  WHERE EXISTS (SELECT 1 FROM edges e WHERE e.blocker_pid = a.pid)
    AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.blocked_pid = a.pid)
  UNION ALL
  SELECT e.blocked_pid, t.root_pid, t.depth + 1, t.path || e.blocked_pid
  FROM tree t
  JOIN edges e ON e.blocker_pid = t.pid
  WHERE NOT e.blocked_pid = ANY (t.path)   -- guard against cycles
)
SELECT repeat('  ', t.depth) || t.pid AS pid_tree,
       a.usename, a.state,
       now() - a.xact_start AS xact_age,
       a.wait_event_type, a.wait_event,
       left(a.query, 120) AS query
FROM tree t
JOIN pg_stat_activity a ON a.pid = t.pid
ORDER BY t.root_pid, t.path;

-- 2.8 Hottest relations: where sessions are waiting on locks
SELECT l.relation::regclass AS relation, l.mode,
       count(*) FILTER (WHERE NOT l.granted) AS waiting,
       count(*) FILTER (WHERE l.granted) AS held
FROM pg_locks l
WHERE l.locktype = 'relation'
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
GROUP BY 1, 2
HAVING count(*) FILTER (WHERE NOT l.granted) > 0
ORDER BY waiting DESC;

-- 2.9 Heavy relation locks (DDL in flight; an AccessExclusiveLock waiter queues up everyone behind it)
SELECT l.pid, a.usename, a.application_name, a.state, l.mode, l.granted,
       l.relation::regclass AS relation,
       now() - a.xact_start AS xact_age,
       left(a.query, 150) AS query
FROM pg_locks l
JOIN pg_stat_activity a USING (pid)
WHERE l.locktype = 'relation'
  AND l.mode IN ('AccessExclusiveLock', 'ExclusiveLock', 'ShareRowExclusiveLock', 'ShareLock')
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND a.pid <> pg_backend_pid()
ORDER BY l.granted, a.xact_start;

-- 2.10 Sessions holding locks inside long-running transactions (> 1 min)
SELECT a.pid, a.usename, a.application_name, a.state,
       now() - a.xact_start AS xact_age,
       count(*) AS locks_held,
       count(*) FILTER (WHERE l.mode IN ('AccessExclusiveLock', 'ExclusiveLock',
                                         'ShareRowExclusiveLock', 'ShareLock')) AS heavy_locks,
       left(a.query, 150) AS query
FROM pg_stat_activity a
JOIN pg_locks l ON l.pid = a.pid AND l.granted AND l.locktype <> 'virtualxid'
WHERE a.xact_start < now() - interval '1 minute'
  AND a.pid <> pg_backend_pid()
GROUP BY a.pid, a.usename, a.application_name, a.state, a.xact_start, a.query
ORDER BY a.xact_start
LIMIT 20;

-- 2.11 Lock table headroom (approximate; "out of shared memory" errors mean this is exhausted)
SELECT locks_in_use, capacity,
       round(100.0 * locks_in_use / NULLIF(capacity, 0), 1) AS pct_used
FROM (
  SELECT (SELECT count(*) FROM pg_locks) AS locks_in_use,
         current_setting('max_locks_per_transaction')::numeric
         * (current_setting('max_connections')::numeric
            + current_setting('max_prepared_transactions')::numeric) AS capacity
) x;
