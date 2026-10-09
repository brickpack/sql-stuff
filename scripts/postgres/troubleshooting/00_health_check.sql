-- One-shot DBA health checklist: each row is a check with a status.
-- Requires PG 16+. Run in the database you want to inspect. Portable: catalog/statistics views only
-- (Aurora-only checks are in the separate statement at the bottom).
-- Counters (deadlocks, cache hit) cover the stats window since the last reset or restart, on this instance only.

SELECT * FROM (
  SELECT 'connections used %' AS check_name,
         round(100.0 * count(*) / current_setting('max_connections')::int, 1)::text AS value,
         CASE WHEN count(*) > 0.8 * current_setting('max_connections')::int THEN 'WARN' ELSE 'ok' END AS status
  FROM pg_stat_activity
  WHERE backend_type = 'client backend'
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
  -- long batch jobs (e.g. CALL dba.batch_cleanup) count here by design
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
  -- forced anti-wraparound vacuums start at autovacuum_freeze_max_age; many tables near it means a vacuum wave is coming
  SELECT 'tables past 90% of autovacuum_freeze_max_age',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_class
  WHERE relkind IN ('r', 'm', 't')
    AND age(relfrozenxid) > 0.9 * current_setting('autovacuum_freeze_max_age')::int
  UNION ALL
  -- oldest snapshot pinning vacuum: sessions (not autovacuum), replication slots, prepared transactions
  SELECT 'oldest xmin holder age (xids)',
         coalesce(max(a), 0)::text,
         CASE WHEN coalesce(max(a), 0) > 20000000 THEN 'WARN' ELSE 'ok' END
  FROM (
    SELECT age(backend_xmin) AS a FROM pg_stat_activity
      WHERE backend_xmin IS NOT NULL AND backend_type <> 'autovacuum worker'
    UNION ALL SELECT age(xmin) FROM pg_replication_slots WHERE xmin IS NOT NULL
    UNION ALL SELECT age(catalog_xmin) FROM pg_replication_slots WHERE catalog_xmin IS NOT NULL
    UNION ALL SELECT age(transaction) FROM pg_prepared_xacts
  ) x
  UNION ALL
  SELECT 'inactive replication slots',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_replication_slots WHERE NOT active
  UNION ALL
  SELECT 'replication slots at risk (wal_status unreserved/lost)',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'CRIT' ELSE 'ok' END
  FROM pg_replication_slots WHERE wal_status IN ('unreserved', 'lost')
  UNION ALL
  -- an index being built right now is also invalid until it finishes, so those are excluded
  SELECT 'invalid indexes',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_index i
  WHERE NOT i.indisvalid
    AND NOT EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p.index_relid = i.indexrelid)
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
  -- only evaluated when archiving is enabled (not meaningful on Aurora)
  SELECT 'WAL archiver failures',
         failed_count::text, CASE WHEN last_failed_time > coalesce(last_archived_time, '-infinity') THEN 'CRIT' ELSE 'ok' END
  FROM pg_stat_archiver
  WHERE current_setting('archive_mode') <> 'off'
  UNION ALL
  SELECT 'tables with > 20% dead tuples (>10k rows)',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_stat_user_tables
  WHERE n_live_tup > 10000 AND n_dead_tup > 0.2 * (n_live_tup + n_dead_tup)
  UNION ALL
  -- int4 sequences stop at 2147483647; past 70% start planning the bigint migration
  SELECT 'integer sequences > 70% used',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_sequences
  WHERE data_type = 'integer'::regtype AND last_value IS NOT NULL
    AND last_value::numeric / max_value > 0.7
  UNION ALL
  -- published tables with no primary key and no REPLICA IDENTITY reject UPDATE/DELETE
  SELECT 'published tables without usable replica identity',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND (c.relreplident = 'n'
         OR (c.relreplident = 'd'
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)))
    AND EXISTS (SELECT 1 FROM pg_publication_tables pt
                WHERE pt.schemaname = n.nspname AND pt.tablename = c.relname)
  UNION ALL
  SELECT 'extensions with updates available',
         count(*)::text, CASE WHEN count(*) > 0 THEN 'WARN' ELSE 'ok' END
  FROM pg_extension e
  JOIN pg_available_extensions a ON a.name = e.extname
  WHERE a.default_version IS DISTINCT FROM e.extversion
) checks
ORDER BY CASE status WHEN 'CRIT' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END, check_name;

-- Aurora add-on (errors on non-Aurora): reader lag and the xmin each reader feeds back to the writer
SELECT server_id, replica_lag_in_msec,
       CASE WHEN replica_lag_in_msec > 1000 THEN 'WARN' ELSE 'ok' END AS lag_status,
       age(feedback_xmin::text::xid) AS feedback_xmin_age,
       CASE WHEN age(feedback_xmin::text::xid) > 20000000 THEN 'WARN' ELSE 'ok' END AS xmin_status
FROM aurora_replica_status()
WHERE session_id <> 'MASTER_SESSION_ID';
