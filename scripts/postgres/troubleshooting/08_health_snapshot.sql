-- One-shot DBA health checklist: each row is a check with a status.
-- Requires PG 16+. Run in the database you want to inspect.

SELECT * FROM (
  SELECT 'connections used %' AS check,
         round(100.0 * count(*) / current_setting('max_connections')::int, 1)::text AS value,
         CASE WHEN count(*) > 0.8 * current_setting('max_connections')::int THEN 'WARN' ELSE 'ok' END AS status
  FROM pg_stat_activity
  UNION ALL
  SELECT 'idle in transaction > 5 min',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_stat_activity
  WHERE state LIKE 'idle in transaction%' AND now() - state_change > interval '5 minutes'
  UNION ALL
  SELECT 'blocked sessions',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0
  UNION ALL
  SELECT 'queries running > 5 min',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_stat_activity
  WHERE state = 'active' AND backend_type = 'client backend'
    AND now() - query_start > interval '5 minutes' AND pid <> pg_backend_pid()
  UNION ALL
  SELECT 'max XID age (% to wraparound)',
         round(100.0 * max(age(datfrozenxid)) / 2100000000, 1)::text,
         CASE WHEN max(age(datfrozenxid)) > 1000000000 THEN 'CRIT'
              WHEN max(age(datfrozenxid)) > 500000000 THEN 'WARN' ELSE 'ok' END
  FROM pg_database
  UNION ALL
  SELECT 'inactive replication slots',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_replication_slots WHERE NOT active
  UNION ALL
  SELECT 'invalid indexes',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_index WHERE NOT indisvalid
  UNION ALL
  SELECT 'prepared transactions',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_prepared_xacts
  UNION ALL
  SELECT 'cache hit % (this db)',
         round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2)::text,
         CASE WHEN 100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0) < 95 THEN 'WARN' ELSE 'ok' END
  FROM pg_stat_database WHERE datname = current_database()
  UNION ALL
  SELECT 'deadlocks (this db, since reset)',
         deadlocks::text, CASE WHEN deadlocks > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_stat_database WHERE datname = current_database()
  UNION ALL
  SELECT 'WAL archiver failures',
         failed_count::text, CASE WHEN last_failed_time > coalesce(last_archived_time, '-infinity') THEN 'CRIT' ELSE 'ok' END
  FROM pg_stat_archiver
  UNION ALL
  SELECT 'tables with > 20% dead tuples (>10k rows)',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_stat_user_tables
  WHERE n_live_tup > 10000 AND n_dead_tup > 0.2 * (n_live_tup + n_dead_tup)
) checks
ORDER BY CASE status WHEN 'CRIT' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END, check;
