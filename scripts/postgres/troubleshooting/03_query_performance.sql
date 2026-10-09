-- Query performance via pg_stat_statements.
-- Requires: shared_preload_libraries = 'pg_stat_statements' and
--           CREATE EXTENSION pg_stat_statements;  PG 16+ (columns as of 13+,
--           with PG17 renaming blk_read_time -> shared_blk_read_time).
-- Rows are per (database, role, queryid, toplevel), and cover every database in the cluster.
-- Non-superusers without pg_read_all_stats see "<insufficient privilege>" for other roles' query text.

-- 3.0 Health of pg_stat_statements itself
-- dealloc > 0 means entries were evicted: raise pg_stat_statements.max or the rankings below are incomplete.
SELECT (SELECT count(*) FROM pg_stat_statements) AS entries,
       current_setting('pg_stat_statements.max') AS max_entries,
       i.dealloc,
       i.stats_reset, now() - i.stats_reset AS stats_age,
       current_setting('pg_stat_statements.track') AS track,
       current_setting('pg_stat_statements.track_planning') AS track_planning,
       current_setting('track_io_timing') AS track_io_timing,
       current_setting('compute_query_id') AS compute_query_id
FROM pg_stat_statements_info i;

-- 3.1 Top queries by total time
SELECT s.queryid, d.datname, r.rolname, s.calls,
       round(s.total_exec_time::numeric, 1) AS total_ms,
       round(s.mean_exec_time::numeric, 2) AS mean_ms,
       round(s.stddev_exec_time::numeric, 2) AS stddev_ms,
       s.rows,
       round(s.rows::numeric / NULLIF(s.calls, 0), 1) AS rows_per_call,
       round((100 * s.total_exec_time / sum(s.total_exec_time) OVER ())::numeric, 2) AS pct_total,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
LEFT JOIN pg_roles r ON r.oid = s.userid
ORDER BY s.total_exec_time DESC
LIMIT 25;

-- 3.1b Top queries by total time for one role (maintenance roles and CALLs with sleeps inflate 3.1)
SELECT s.queryid, s.calls,
       round(s.total_exec_time::numeric, 1) AS total_ms,
       round(s.mean_exec_time::numeric, 2) AS mean_ms,
       round(s.stddev_exec_time::numeric, 2) AS stddev_ms,
       round(s.rows::numeric / NULLIF(s.calls, 0), 1) AS rows_per_call,
       round((100 * s.total_exec_time / sum(s.total_exec_time) OVER ())::numeric, 2) AS pct_of_role,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
JOIN pg_roles r ON r.oid = s.userid
-- WHERE r.rolname = 'web'   -- edit: your application role
ORDER BY s.total_exec_time DESC
LIMIT 25;

-- 3.2 Slowest on average (min 20 calls to avoid noise)
SELECT s.queryid, d.datname, s.calls,
       round(s.mean_exec_time::numeric, 2) AS mean_ms,
       round(s.min_exec_time::numeric, 2) AS min_ms,
       round(s.max_exec_time::numeric, 1) AS max_ms,
       round(s.total_exec_time::numeric, 1) AS total_ms,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
WHERE s.calls >= 20
ORDER BY s.mean_exec_time DESC
LIMIT 25;

-- 3.3 Most I/O-heavy (shared buffer misses)
-- With track_io_timing on, also add shared_blk_read_time (PG17+) or blk_read_time (PG16) to see actual read latency.
SELECT s.queryid, d.datname, s.calls, s.shared_blks_read,
       pg_size_pretty(s.shared_blks_read * current_setting('block_size')::bigint) AS read_size,
       round(s.shared_blks_read::numeric / NULLIF(s.calls, 0), 1) AS blks_read_per_call,
       s.shared_blks_hit,
       round(100.0 * s.shared_blks_hit / NULLIF(s.shared_blks_hit + s.shared_blks_read, 0), 2) AS hit_pct,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
ORDER BY s.shared_blks_read DESC
LIMIT 25;

-- 3.4 Queries spilling to temp files (work_mem too small)
SELECT s.queryid, d.datname, s.calls, s.temp_blks_read, s.temp_blks_written,
       pg_size_pretty(s.temp_blks_read * current_setting('block_size')::bigint) AS temp_read,
       pg_size_pretty(s.temp_blks_written * current_setting('block_size')::bigint) AS temp_written,
       pg_size_pretty((s.temp_blks_written * current_setting('block_size')::bigint) / NULLIF(s.calls, 0)) AS temp_written_per_call,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
WHERE s.temp_blks_written > 0
ORDER BY s.temp_blks_written DESC
LIMIT 25;

-- 3.5 Heavy WAL producers
SELECT s.queryid, d.datname, s.calls,
       pg_size_pretty(s.wal_bytes) AS wal,
       pg_size_pretty((s.wal_bytes / NULLIF(s.calls, 0))::bigint) AS wal_per_call,
       s.wal_records, s.wal_fpi,
       round(100.0 * s.wal_fpi / NULLIF(s.wal_records, 0), 1) AS fpi_pct_of_records,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
WHERE s.wal_bytes > 0
ORDER BY s.wal_bytes DESC
LIMIT 25;

-- 3.6 Planning-time heavy queries (needs pg_stat_statements.track_planning = on)
SELECT s.queryid, d.datname, s.calls, s.plans,
       round(s.mean_plan_time::numeric, 2) AS mean_plan_ms,
       round(s.mean_exec_time::numeric, 2) AS mean_exec_ms,
       round((100 * s.total_plan_time / NULLIF(s.total_plan_time + s.total_exec_time, 0))::numeric, 1) AS plan_pct_of_time,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
WHERE s.plans > 0
ORDER BY s.total_plan_time DESC
LIMIT 25;

-- 3.7 Tables with lots of sequential scans on big tables
SELECT schemaname, relname, seq_scan, seq_tup_read,
       round(seq_tup_read::numeric / NULLIF(seq_scan, 0)) AS rows_per_seq_scan,
       idx_scan,
       round(100.0 * seq_scan / NULLIF(seq_scan + COALESCE(idx_scan, 0), 0), 1) AS seq_scan_pct,
       n_live_tup, pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables
WHERE seq_scan > 0 AND pg_relation_size(relid) > 10 * 1024 * 1024
ORDER BY seq_tup_read DESC
LIMIT 25;

-- 3.8 Time by database and role (who is using the database?)
SELECT d.datname, r.rolname,
       sum(s.calls) AS calls,
       round(sum(s.total_exec_time)::numeric, 0) AS total_ms,
       round((100 * sum(s.total_exec_time) / sum(sum(s.total_exec_time)) OVER ())::numeric, 1) AS pct_total
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
LEFT JOIN pg_roles r ON r.oid = s.userid
GROUP BY 1, 2
ORDER BY sum(s.total_exec_time) DESC;

-- 3.9 Most-called queries (chatty / N+1 candidates)
SELECT s.queryid, d.datname, s.calls,
       round(s.mean_exec_time::numeric, 3) AS mean_ms,
       round(s.total_exec_time::numeric, 1) AS total_ms,
       round((100 * s.total_exec_time / sum(s.total_exec_time) OVER ())::numeric, 2) AS pct_total,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
ORDER BY s.calls DESC
LIMIT 25;

-- 3.10 Unstable queries (high variance: sometimes fast, sometimes slow; often plan flips or lock waits)
SELECT s.queryid, d.datname, s.calls,
       round(s.mean_exec_time::numeric, 2) AS mean_ms,
       round(s.stddev_exec_time::numeric, 2) AS stddev_ms,
       round((s.stddev_exec_time / NULLIF(s.mean_exec_time, 0))::numeric, 2) AS variation,
       round(s.min_exec_time::numeric, 2) AS min_ms,
       round(s.max_exec_time::numeric, 1) AS max_ms,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
WHERE s.calls >= 20 AND s.mean_exec_time > 1
ORDER BY s.stddev_exec_time / NULLIF(s.mean_exec_time, 0) DESC NULLS LAST
LIMIT 25;

-- 3.11 Large result sets (rows returned per call)
SELECT s.queryid, d.datname, s.calls, s.rows,
       round(s.rows::numeric / NULLIF(s.calls, 0), 1) AS rows_per_call,
       round(s.mean_exec_time::numeric, 2) AS mean_ms,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
WHERE s.calls >= 20
ORDER BY s.rows::numeric / NULLIF(s.calls, 0) DESC NULLS LAST
LIMIT 25;


-- 3.12 Worst cache hit ratio among queries with meaningful reads (> 10k blocks)
SELECT s.queryid, d.datname, s.calls, s.shared_blks_read,
       round(100.0 * s.shared_blks_hit / NULLIF(s.shared_blks_hit + s.shared_blks_read, 0), 2) AS hit_pct,
       left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
FROM pg_stat_statements s
LEFT JOIN pg_database d ON d.oid = s.dbid
WHERE s.shared_blks_read > 10000
ORDER BY 100.0 * s.shared_blks_hit / NULLIF(s.shared_blks_hit + s.shared_blks_read, 0) NULLS LAST
LIMIT 25;

-- 3.13 What changed recently? (counters are cumulative; diff against a snapshot)
-- Step 1: take a snapshot (temp table lives only in this session)
-- CREATE TEMP TABLE pgss_snap AS
--   SELECT now() AS taken_at, dbid, userid, queryid, toplevel, calls, total_exec_time, rows,
--          shared_blks_read, temp_blks_written, wal_bytes
--   FROM pg_stat_statements;
-- Step 2: wait (minutes to an hour), then:
-- SELECT s.queryid, d.datname,
--        s.calls - COALESCE(p.calls, 0) AS calls,
--        round((s.total_exec_time - COALESCE(p.total_exec_time, 0))::numeric, 1) AS total_ms,
--        round(((s.total_exec_time - COALESCE(p.total_exec_time, 0))
--               / NULLIF(s.calls - COALESCE(p.calls, 0), 0))::numeric, 2) AS mean_ms,
--        s.shared_blks_read - COALESCE(p.shared_blks_read, 0) AS blks_read,
--        left(regexp_replace(s.query, '\s+', ' ', 'g'), 200) AS query
-- FROM pg_stat_statements s
-- LEFT JOIN pg_database d ON d.oid = s.dbid
-- LEFT JOIN pgss_snap p ON p.dbid = s.dbid AND p.userid = s.userid
--                      AND p.queryid = s.queryid AND p.toplevel = s.toplevel
-- ORDER BY s.total_exec_time - COALESCE(p.total_exec_time, 0) DESC
-- LIMIT 25;

-- 3.14 Reset statistics (DESTRUCTIVE to history; do deliberately)
-- SELECT pg_stat_statements_reset();
-- Reset a single query only: SELECT pg_stat_statements_reset(userid, dbid, queryid);
