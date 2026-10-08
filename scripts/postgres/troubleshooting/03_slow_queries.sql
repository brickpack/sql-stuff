-- Query performance via pg_stat_statements.
-- Requires: shared_preload_libraries = 'pg_stat_statements' and
--           CREATE EXTENSION pg_stat_statements;  PG 16+ (columns as of 13+,
--           with PG17 renaming blk_read_time -> shared_blk_read_time).

-- 3.1 Top queries by total time
SELECT queryid, calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round(stddev_exec_time::numeric, 2) AS stddev_ms,
       rows,
       round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 2) AS pct_total,
       left(query, 200) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 25;

-- 3.2 Slowest on average (min 20 calls to avoid noise)
SELECT queryid, calls, round(mean_exec_time::numeric, 2) AS mean_ms,
       round(max_exec_time::numeric, 1) AS max_ms, left(query, 200) AS query
FROM pg_stat_statements
WHERE calls >= 20
ORDER BY mean_exec_time DESC
LIMIT 25;

-- 3.3 Most I/O-heavy (shared buffer misses)
SELECT queryid, calls, shared_blks_read, shared_blks_hit,
       round(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 2) AS hit_pct,
       left(query, 200) AS query
FROM pg_stat_statements
ORDER BY shared_blks_read DESC
LIMIT 25;

-- 3.4 Queries spilling to temp files (work_mem too small)
SELECT queryid, calls, temp_blks_read, temp_blks_written,
       pg_size_pretty(temp_blks_read * current_setting('block_size')::bigint) AS temp_read,
       pg_size_pretty(temp_blks_written * current_setting('block_size')::bigint) AS temp_written,
       left(query, 200) AS query
FROM pg_stat_statements
WHERE temp_blks_written > 0
ORDER BY temp_blks_written DESC
LIMIT 25;

-- 3.5 Heavy WAL producers
SELECT queryid, calls, pg_size_pretty(wal_bytes) AS wal, wal_fpi, left(query, 200) AS query
FROM pg_stat_statements
ORDER BY wal_bytes DESC
LIMIT 25;

-- 3.6 Planning-time heavy queries (needs pg_stat_statements.track_planning = on)
SELECT queryid, calls, round(mean_plan_time::numeric, 2) AS mean_plan_ms,
       round(mean_exec_time::numeric, 2) AS mean_exec_ms, left(query, 200) AS query
FROM pg_stat_statements
WHERE plans > 0
ORDER BY total_plan_time DESC
LIMIT 25;

-- 3.7 Tables with lots of sequential scans on big tables
SELECT schemaname, relname, seq_scan, seq_tup_read, idx_scan,
       n_live_tup, pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables
WHERE seq_scan > 0 AND pg_relation_size(relid) > 10 * 1024 * 1024
ORDER BY seq_tup_read DESC
LIMIT 25;

-- 3.8 Reset statistics (DESTRUCTIVE to history; do deliberately)
-- SELECT pg_stat_statements_reset();
