-- Vacuum, bloat and transaction ID wraparound. Requires PG 16+.

-- 4.1 Dead tuples and last (auto)vacuum/analyze
SELECT schemaname, relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
       last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
       vacuum_count, autovacuum_count
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC
LIMIT 30;

-- 4.2 Tables closest to triggering autovacuum
SELECT s.schemaname, s.relname, s.n_dead_tup,
       (current_setting('autovacuum_vacuum_threshold')::int
        + current_setting('autovacuum_vacuum_scale_factor')::float * c.reltuples)::bigint AS av_threshold,
       s.n_mod_since_analyze, s.n_ins_since_vacuum
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
ORDER BY s.n_dead_tup DESC
LIMIT 30;

-- 4.3 Autovacuum / vacuum in progress
SELECT p.pid, p.datname, p.relid::regclass AS relation, p.phase,
       round(100.0 * p.heap_blks_scanned / NULLIF(p.heap_blks_total, 0), 1) AS pct_scanned,
       p.index_vacuum_count,
       now() - a.xact_start AS running_for
FROM pg_stat_progress_vacuum p
JOIN pg_stat_activity a USING (pid);
-- Dead-tuple counters differ by version (PG16: num_dead_tuples; PG17+: num_dead_item_ids), so omitted.

-- 4.4 Per-table autovacuum storage-parameter overrides
SELECT n.nspname AS schema, c.relname, c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.reloptions IS NOT NULL AND c.relkind IN ('r', 'm', 't')
ORDER BY 1, 2;

-- 4.5 Transaction ID wraparound risk by database (freeze_max_age default 200M, hard limit ~2.1B)
SELECT datname, age(datfrozenxid) AS xid_age,
       round(100.0 * age(datfrozenxid) / 2100000000, 2) AS pct_to_wraparound,
       mxid_age(datminmxid) AS multixact_age
FROM pg_database
ORDER BY age(datfrozenxid) DESC;

-- 4.6 Wraparound risk by table (current database)
SELECT n.nspname AS schema, c.relname, age(c.relfrozenxid) AS xid_age,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm', 't')
ORDER BY age(c.relfrozenxid) DESC
LIMIT 25;

-- 4.7 What is holding back the xmin horizon?
SELECT 'backend' AS source, pid::text AS id, backend_xmin AS xmin, age(backend_xmin) AS age
FROM pg_stat_activity WHERE backend_xmin IS NOT NULL
UNION ALL
SELECT 'replication slot', slot_name, xmin, age(xmin) FROM pg_replication_slots WHERE xmin IS NOT NULL
UNION ALL
SELECT 'slot catalog_xmin', slot_name, catalog_xmin, age(catalog_xmin) FROM pg_replication_slots WHERE catalog_xmin IS NOT NULL
UNION ALL
SELECT 'prepared xact', gid, transaction, age(transaction) FROM pg_prepared_xacts
ORDER BY age DESC;

-- 4.8 Estimated table bloat (heuristic, based on stats; install pgstattuple for exact)
SELECT current_database() AS db, schemaname, tblname,
       pg_size_pretty((bs * tblpages)::bigint) AS real_size,
       pg_size_pretty((bs * GREATEST(tblpages - est_tblpages, 0))::bigint) AS bloat_size,
       round(100 * GREATEST(tblpages - est_tblpages, 0)::numeric / NULLIF(tblpages, 0), 1) AS bloat_pct
FROM (
  SELECT (ceil(reltuples / ((bs - page_hdr) / NULLIF(tpl_size, 0))) + ceil(toasttuples / 4))::numeric AS est_tblpages,
         tblpages, bs, schemaname, tblname
  FROM (
    SELECT n.nspname AS schemaname, c.relname AS tblname, c.reltuples, c.relpages AS tblpages,
           COALESCE(t.reltuples, 0) AS toasttuples, current_setting('block_size')::numeric AS bs,
           24 AS page_hdr,
           (SELECT 23 + sum(COALESCE(s.avg_width, 8)) FROM pg_stats s
            WHERE s.schemaname = n.nspname AND s.tablename = c.relname) AS tpl_size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
    WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ) a
) b
WHERE tblpages > 100
ORDER BY bs * GREATEST(tblpages - est_tblpages, 0) DESC NULLS LAST
LIMIT 25;
