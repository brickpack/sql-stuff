-- Lock contention and blocking chains. Requires PG 16+.

-- 2.1 Blocked sessions and who blocks them
SELECT blocked.pid AS blocked_pid,
       blocked.usename AS blocked_user,
       now() - blocked.query_start AS blocked_for,
       pg_blocking_pids(blocked.pid) AS blocked_by,
       blocked.wait_event_type, blocked.wait_event,
       left(blocked.query, 150) AS blocked_query
FROM pg_stat_activity blocked
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0
ORDER BY blocked.query_start;

-- 2.2 Root blockers (block others but are not blocked themselves)
WITH blocked AS (
  SELECT pid, unnest(pg_blocking_pids(pid)) AS blocker
  FROM pg_stat_activity
)
SELECT a.pid, a.usename, a.state, now() - a.xact_start AS xact_age,
       count(DISTINCT b.pid) AS sessions_blocked,
       left(a.query, 200) AS query
FROM blocked b
JOIN pg_stat_activity a ON a.pid = b.blocker
WHERE cardinality(pg_blocking_pids(a.pid)) = 0
GROUP BY a.pid, a.usename, a.state, a.xact_start, a.query
ORDER BY sessions_blocked DESC;

-- 2.3 Locks held/awaited, with relation names
SELECT l.pid, a.usename, l.locktype, l.mode, l.granted,
       l.relation::regclass AS relation,
       now() - a.query_start AS query_age,
       left(a.query, 120) AS query
FROM pg_locks l
JOIN pg_stat_activity a USING (pid)
WHERE l.locktype IN ('relation', 'transactionid', 'tuple', 'advisory')
  AND a.pid <> pg_backend_pid()
ORDER BY l.granted, query_age DESC;

-- 2.4 Advisory locks
SELECT pid, classid, objid, mode, granted
FROM pg_locks
WHERE locktype = 'advisory';

-- 2.5 Deadlock and lock-timeout counters per database
SELECT datname, deadlocks, conflicts, xact_rollback, stats_reset
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY deadlocks DESC;

-- 2.6 Current lock-related settings
SELECT name, setting, unit
FROM pg_settings
WHERE name IN ('deadlock_timeout', 'lock_timeout', 'statement_timeout',
               'idle_in_transaction_session_timeout', 'idle_session_timeout',
               'log_lock_waits', 'max_locks_per_transaction');
