-- Targeted diagnosis queries for N+1 candidates and stale planner statistics.
-- Companion to: health_check.sql, 1_connections_activity.sql, 2_locks_blocking.sql, 3_query_performance.sql,
-- 4_vacuum_bloat.sql, 5_index_health.sql. Per-instance counters: on Aurora these describe the writer only.

-- D.1 N+1 candidates: very many calls, cheap, ~0-2 rows each (point lookups, often per-record association loads).
-- rows_per_call near 0 means the lookup almost always finds nothing: a call that could often be skipped entirely.
-- controller / source_location come from the sqlcommenter tag in the query text. pg_stat_statements keeps the text
-- of the FIRST statement seen for each queryid, so the tag shows one example caller, not every caller.
SELECT s.queryid, r.rolname, s.calls,
       round(100.0 * s.calls / sum(s.calls) OVER (), 2) AS pct_of_all_calls,
       round(s.mean_exec_time::numeric, 3) AS mean_ms,
       round((100 * s.total_exec_time / sum(s.total_exec_time) OVER ())::numeric, 2) AS pct_total_time,
       round(s.rows::numeric / NULLIF(s.calls, 0), 2) AS rows_per_call,
       substring(s.query FROM 'controller=''([^'']*)''') AS controller,
       replace(replace(substring(s.query FROM 'source_location=''([^'']*)'''), '%2F', '/'), '%3A', ':') AS source_location,
       left(regexp_replace(regexp_replace(s.query, '\s*/\*.*\*/\s*$', ''), '\s+', ' ', 'g'), 150) AS query
FROM pg_stat_statements s
LEFT JOIN pg_roles r ON r.oid = s.userid
WHERE s.calls > 1000000
  AND s.mean_exec_time < 50
  AND s.rows::numeric / NULLIF(s.calls, 0) <= 2
  AND s.query ~* '^\s*select'
ORDER BY s.calls DESC
LIMIT 25;

-- D.2 Stale planner statistics: tables whose data changed a lot since the last ANALYZE.
-- pct_modified over ~10-20% on a big table, or an old last_analyzed, means row estimates may be off.
-- Large tables are the usual victims: the default analyze trigger is 10% of the table, which is hundreds of
-- millions of rows on your biggest tables. Fix with ANALYZE (the pg_cron jobs) and per-table autovacuum_analyze_scale_factor.
SELECT schemaname, relname, n_live_tup, n_mod_since_analyze,
       round(100.0 * n_mod_since_analyze / NULLIF(n_live_tup, 0), 1) AS pct_modified,
       GREATEST(last_analyze, last_autoanalyze) AS last_analyzed,
       now() - GREATEST(last_analyze, last_autoanalyze) AS since_analyzed,
       pg_size_pretty(pg_relation_size(relid)) AS heap
FROM pg_stat_user_tables
WHERE n_live_tup > 100000
ORDER BY n_mod_since_analyze DESC
LIMIT 25;

-- D.3 Plan a parameterised statement from pg_stat_statements WITHOUT knowing the parameter values (PG16+).
-- Copy a query text containing $1, $2 ... and run:
--   EXPLAIN (GENERIC_PLAN) <statement with $1, $2 ...>;
-- This shows the plan shape and the planner's estimates but does not execute (it cannot be combined with ANALYZE).
-- For real timings use EXPLAIN (ANALYZE, BUFFERS) with literal values; wrap writes in BEGIN ... ROLLBACK.
