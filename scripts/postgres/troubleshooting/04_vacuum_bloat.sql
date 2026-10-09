-- Vacuum, bloat and transaction ID wraparound. Requires PG 16+.
-- Aurora note: 4.7 includes Aurora reader feedback (aurora_replica_status()); that branch errors on non-Aurora.

-- 4.1 Dead tuples and last (auto)vacuum/analyze
SELECT schemaname, relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
       pg_size_pretty(pg_table_size(relid)) AS table_size,
       last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
       vacuum_count, autovacuum_count
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC
LIMIT 30;

-- 4.2 Tables closest to triggering autovacuum (honours per-table overrides)
SELECT s.schemaname, s.relname, s.n_dead_tup,
       round(t.vac_threshold) AS vac_threshold,
       round(100.0 * s.n_dead_tup / NULLIF(t.vac_threshold, 0), 1) AS pct_of_vac_threshold,
       s.n_ins_since_vacuum, round(t.ins_threshold) AS ins_threshold,
       s.n_mod_since_analyze, round(t.anl_threshold) AS anl_threshold,
       s.last_autovacuum, s.last_autoanalyze, t.av_enabled
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
CROSS JOIN LATERAL (
  SELECT max(option_value) FILTER (WHERE option_name = 'autovacuum_enabled') AS en,
         max(option_value) FILTER (WHERE option_name = 'autovacuum_vacuum_threshold') AS vt,
         max(option_value) FILTER (WHERE option_name = 'autovacuum_vacuum_scale_factor') AS vsf,
         max(option_value) FILTER (WHERE option_name = 'autovacuum_vacuum_max_threshold') AS vmax,
         max(option_value) FILTER (WHERE option_name = 'autovacuum_vacuum_insert_threshold') AS it,
         max(option_value) FILTER (WHERE option_name = 'autovacuum_vacuum_insert_scale_factor') AS isf,
         max(option_value) FILTER (WHERE option_name = 'autovacuum_analyze_threshold') AS at,
         max(option_value) FILTER (WHERE option_name = 'autovacuum_analyze_scale_factor') AS asf
  FROM pg_options_to_table(c.reloptions)
) o
CROSS JOIN LATERAL (
  SELECT COALESCE(o.en::boolean, current_setting('autovacuum')::boolean) AS av_enabled,
         -- autovacuum_vacuum_max_threshold exists on PG18+ only; LEAST ignores the NULL on older versions
         LEAST(COALESCE(o.vt::numeric, current_setting('autovacuum_vacuum_threshold')::numeric)
               + COALESCE(o.vsf::numeric, current_setting('autovacuum_vacuum_scale_factor')::numeric)
                 * GREATEST(c.reltuples::numeric, 0),
               NULLIF(COALESCE(o.vmax::numeric,
                               current_setting('autovacuum_vacuum_max_threshold', true)::numeric), -1)
         ) AS vac_threshold,
         CASE WHEN COALESCE(o.it::numeric, current_setting('autovacuum_vacuum_insert_threshold')::numeric) < 0
              THEN NULL
              ELSE COALESCE(o.it::numeric, current_setting('autovacuum_vacuum_insert_threshold')::numeric)
                   + COALESCE(o.isf::numeric, current_setting('autovacuum_vacuum_insert_scale_factor')::numeric)
                     * GREATEST(c.reltuples::numeric, 0)
         END AS ins_threshold,
         COALESCE(o.at::numeric, current_setting('autovacuum_analyze_threshold')::numeric)
         + COALESCE(o.asf::numeric, current_setting('autovacuum_analyze_scale_factor')::numeric)
           * GREATEST(c.reltuples::numeric, 0) AS anl_threshold
) t
WHERE s.n_dead_tup > 0
ORDER BY pct_of_vac_threshold DESC NULLS LAST
LIMIT 30;

-- 4.3 Autovacuum / vacuum in progress
-- Dead-tuple counters differ by version (PG16: num_dead_tuples; PG17+: num_dead_item_ids), so omitted.
SELECT p.pid, p.datname, a.backend_type,
       CASE WHEN p.datname = current_database() THEN p.relid::regclass::text END AS relation,
       p.phase,
       round(100.0 * p.heap_blks_scanned / NULLIF(p.heap_blks_total, 0), 1) AS pct_scanned,
       round(100.0 * p.heap_blks_vacuumed / NULLIF(p.heap_blks_total, 0), 1) AS pct_vacuumed,
       p.index_vacuum_count,  -- > 1 means maintenance_work_mem / autovacuum_work_mem is too small for this table
       now() - a.xact_start AS running_for,
       a.query LIKE '%to prevent wraparound%' AS anti_wraparound,
       a.wait_event_type, a.wait_event,
       left(a.query, 100) AS query
FROM pg_stat_progress_vacuum p
LEFT JOIN pg_stat_activity a USING (pid)
ORDER BY running_for DESC NULLS LAST;

-- 4.4 Per-table autovacuum storage-parameter overrides
SELECT n.nspname AS schema, c.relname, c.relkind, c.reloptions,
       'autovacuum_enabled=false' = ANY (c.reloptions) AS autovac_disabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.reloptions IS NOT NULL AND c.relkind IN ('r', 'm', 't')
ORDER BY autovac_disabled DESC, 1, 2;

-- 4.5 Transaction ID wraparound risk by database (freeze_max_age default 200M, hard limit ~2.1B)
SELECT datname, age(datfrozenxid) AS xid_age,
       round(100.0 * age(datfrozenxid) / 2100000000, 2) AS pct_to_wraparound,
       round(100.0 * age(datfrozenxid) / current_setting('autovacuum_freeze_max_age')::numeric, 1) AS pct_of_freeze_max_age,
       mxid_age(datminmxid) AS multixact_age,
       round(100.0 * mxid_age(datminmxid) / current_setting('autovacuum_multixact_freeze_max_age')::numeric, 1) AS pct_of_mxid_freeze_max_age
FROM pg_database
ORDER BY age(datfrozenxid) DESC;

-- 4.6 Wraparound risk by table (current database; per-table autovacuum_freeze_max_age overrides not applied)
SELECT n.nspname AS schema, c.relname, c.relkind, age(c.relfrozenxid) AS xid_age,
       round(100.0 * age(c.relfrozenxid) / current_setting('autovacuum_freeze_max_age')::numeric, 1) AS pct_of_freeze_max_age,
       mxid_age(c.relminmxid) AS multixact_age,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm', 't')
ORDER BY age(c.relfrozenxid) DESC
LIMIT 25;

-- 4.7 What is holding back the xmin horizon?
SELECT 'backend' AS source, pid::text AS id, backend_xmin AS holder_xmin, age(backend_xmin) AS age,
       concat_ws(', ', usename, application_name, state, 'xact_age ' || (now() - xact_start)) AS detail
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL AND pid <> pg_backend_pid()
UNION ALL
SELECT 'replication slot', slot_name::text, xmin, age(xmin),
       concat_ws(', ', slot_type, CASE WHEN active THEN 'active' ELSE 'INACTIVE' END)
FROM pg_replication_slots WHERE xmin IS NOT NULL
UNION ALL
SELECT 'slot catalog_xmin', slot_name::text, catalog_xmin, age(catalog_xmin),
       concat_ws(', ', slot_type, CASE WHEN active THEN 'active' ELSE 'INACTIVE' END)
FROM pg_replication_slots WHERE catalog_xmin IS NOT NULL
UNION ALL
SELECT 'standby feedback', pid::text, backend_xmin, age(backend_xmin),
       concat_ws(', ', application_name, client_addr::text, state)
FROM pg_stat_replication WHERE backend_xmin IS NOT NULL
UNION ALL
SELECT 'aurora reader', server_id::text, feedback_xmin::text::xid, age(feedback_xmin::text::xid),
       concat_ws(', ', 'lag ' || replica_lag_in_msec || ' ms', 'active_txns ' || active_txns)
FROM aurora_replica_status()
WHERE session_id <> 'MASTER_SESSION_ID' AND feedback_xmin IS NOT NULL
UNION ALL
SELECT 'prepared xact', gid, transaction, age(transaction),
       concat_ws(', ', owner, 'prepared ' || prepared::text)
FROM pg_prepared_xacts
ORDER BY age DESC;

-- 4.8 Estimated table bloat (heuristic, based on stats; install pgstattuple for exact)
SELECT current_database() AS db, schemaname, tblname,
       pg_size_pretty((bs * tblpages)::bigint) AS real_size,
       pg_size_pretty((bs * GREATEST(tblpages - est_tblpages, 0))::bigint) AS bloat_size,
       round(100 * GREATEST(tblpages - est_tblpages, 0) / NULLIF(tblpages, 0), 1) AS bloat_pct
FROM (
  SELECT schemaname, tblname, tblpages, bs,
         ceil(reltuples / NULLIF(floor((bs - page_hdr) * fillfactor / 100 / tpl_size), 0)) AS est_tblpages
  FROM (
    SELECT n.nspname AS schemaname, c.relname AS tblname,
           c.reltuples::numeric AS reltuples, c.relpages::numeric AS tblpages,
           current_setting('block_size')::numeric AS bs,
           24 AS page_hdr,
           COALESCE(substring(array_to_string(c.reloptions, ',') FROM 'fillfactor=(\d+)')::numeric, 100) AS fillfactor,
           -- 24-byte tuple header + 4-byte line pointer + column data, rounded up to 8-byte alignment
           (SELECT (ceil((24 + 4 + sum((1 - s.null_frac) * s.avg_width)) / 8) * 8)::numeric
            FROM pg_stats s
            WHERE s.schemaname = n.nspname AND s.tablename = c.relname AND NOT s.inherited) AS tpl_size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND c.reltuples > 0
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ) a
) b
WHERE tblpages > 100 AND est_tblpages IS NOT NULL
ORDER BY bs * GREATEST(tblpages - est_tblpages, 0) DESC
LIMIT 25;
