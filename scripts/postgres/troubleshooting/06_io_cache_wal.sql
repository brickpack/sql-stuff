-- I/O, cache, checkpoints and WAL. Requires PG 16+ (pg_stat_io is new in 16).

-- 6.1 Buffer cache hit ratio by database (aim for > 99% on OLTP)
SELECT datname, blks_hit, blks_read,
       round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) AS hit_pct
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY blks_read DESC;

-- 6.2 Cluster-wide I/O by backend type and context (PG16+)
SELECT backend_type, object, context,
       reads, pg_size_pretty(reads * op_bytes) AS read_bytes,
       writes, pg_size_pretty(writes * op_bytes) AS write_bytes,
       extends, hits, evictions, reuses, fsyncs,
       round(read_time::numeric, 1) AS read_ms, round(write_time::numeric, 1) AS write_ms
FROM pg_stat_io
WHERE reads > 0 OR writes > 0
ORDER BY COALESCE(reads, 0) + COALESCE(writes, 0) DESC
LIMIT 30;
-- read_time/write_time are zero unless track_io_timing = on.

-- 6.3 Checkpoint activity (PG16: pg_stat_bgwriter; PG17+: pg_stat_checkpointer)
SELECT checkpoints_timed, checkpoints_req,
       round(100.0 * checkpoints_req / NULLIF(checkpoints_timed + checkpoints_req, 0), 1) AS pct_requested,
       checkpoint_write_time, checkpoint_sync_time,
       buffers_checkpoint, buffers_clean, maxwritten_clean, buffers_backend, buffers_alloc,
       stats_reset
FROM pg_stat_bgwriter;
-- PG17+: checkpoint columns moved, use instead:
--   SELECT num_timed, num_requested, write_time, sync_time, buffers_written FROM pg_stat_checkpointer;
-- A high pct_requested means max_wal_size is too small for the write load.

-- 6.4 WAL generation since stats reset
SELECT wal_records, wal_fpi, pg_size_pretty(wal_bytes) AS wal_bytes,
       wal_buffers_full, wal_write, wal_sync, stats_reset
FROM pg_stat_wal;
-- PG18 removes wal_write/wal_sync columns (see pg_stat_io, object = 'wal').

-- 6.5 Temp file usage per database
SELECT datname, temp_files, pg_size_pretty(temp_bytes) AS temp_bytes
FROM pg_stat_database
WHERE datname IS NOT NULL AND temp_files > 0
ORDER BY temp_bytes DESC;

-- 6.6 Memory-related settings at a glance
SELECT name, setting, unit, source
FROM pg_settings
WHERE name IN ('shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size',
               'huge_pages', 'max_connections', 'autovacuum_work_mem', 'hash_mem_multiplier',
               'track_io_timing', 'random_page_cost', 'effective_io_concurrency');

-- 6.7 Per-table cache hit ratio
SELECT schemaname, relname, heap_blks_read, heap_blks_hit,
       round(100.0 * heap_blks_hit / NULLIF(heap_blks_hit + heap_blks_read, 0), 2) AS hit_pct
FROM pg_statio_user_tables
WHERE heap_blks_read > 0
ORDER BY heap_blks_read DESC
LIMIT 25;
