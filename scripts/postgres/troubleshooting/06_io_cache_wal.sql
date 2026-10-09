-- I/O, cache, checkpoints and WAL. Requires PG 16+ (pg_stat_io is new in 16).
-- Verified on Aurora PostgreSQL 16.13.3: pg_stat_io, pg_stat_bgwriter, pg_stat_replication and pg_replication_slots
-- work; pg_stat_wal is unsupported; checkpoint buffer counters are all 0 (Aurora checkpoints write no buffers), so 6.3
-- is not meaningful there. Use 6.9 for Aurora readers and CloudWatch for storage I/O.
-- A few statements are version-specific (6.3 PG16 vs 6.3b PG17+, 6.4 on PG18); the one that does not match
-- your version will just error and the rest still run (unless psql has ON_ERROR_STOP set).

-- 6.0 Version and when each set of counters last reset (all rates below are since these dates)
-- Run separately so an unsupported view (e.g. pg_stat_wal on Aurora) does not hide the others.
SELECT version();
SELECT aurora_version();   -- errors on non-Aurora; ignore
SELECT 'bgwriter' AS stat, stats_reset FROM pg_stat_bgwriter;
SELECT 'io' AS stat, min(stats_reset) AS stats_reset FROM pg_stat_io;
SELECT 'wal' AS stat, stats_reset FROM pg_stat_wal;   -- not supported on Aurora
SELECT 'database ' || datname AS stat, stats_reset FROM pg_stat_database WHERE datname = current_database();

-- 6.1 Buffer cache hit ratio by database (aim for > 99% on OLTP)
-- blks_read counts shared-buffer misses. With track_io_timing on, read_ms_per_block shows the latency of those reads.
-- On Aurora a miss is served by the storage layer (not verified against AWS docs: I believe there is no OS page cache).
SELECT datname, blks_hit, blks_read,
       round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) AS hit_pct,
       round(blk_read_time::numeric, 0) AS read_ms,
       round((blk_read_time / NULLIF(blks_read, 0))::numeric, 3) AS read_ms_per_block
FROM pg_stat_database
WHERE datname IS NOT NULL
ORDER BY blks_read DESC;

-- 6.1b Session health per database (PG14+): time active vs idle-in-transaction, abandoned/killed sessions
SELECT datname, sessions, sessions_abandoned, sessions_fatal, sessions_killed,
       round((100.0 * active_time / NULLIF(session_time, 0))::numeric, 1) AS active_pct,
       round((100.0 * idle_in_transaction_time / NULLIF(session_time, 0))::numeric, 1) AS idle_in_xact_pct
FROM pg_stat_database
WHERE datname IS NOT NULL AND sessions > 0
ORDER BY sessions DESC;

-- 6.2 Cluster-wide I/O by backend type and context, ordered by bytes (PG16+; works on 16, 17 and 18)
-- read_time/write_time are zero unless track_io_timing = on. avg_read_ms is the average latency per read operation.
SELECT backend_type, object, context,
       reads, pg_size_pretty(rbytes::bigint) AS read_bytes,
       writes, pg_size_pretty(wbytes::bigint) AS write_bytes,
       extends, hits, evictions, reuses, fsyncs,
       round(read_time::numeric, 1) AS read_ms,
       round((read_time / NULLIF(reads, 0))::numeric, 3) AS avg_read_ms,
       round(write_time::numeric, 1) AS write_ms
FROM (
  SELECT s.*,
         COALESCE((to_jsonb(s) ->> 'read_bytes')::numeric, s.reads * (to_jsonb(s) ->> 'op_bytes')::numeric) AS rbytes,
         COALESCE((to_jsonb(s) ->> 'write_bytes')::numeric, s.writes * (to_jsonb(s) ->> 'op_bytes')::numeric) AS wbytes
  FROM pg_stat_io s
) x
WHERE reads > 0 OR writes > 0
ORDER BY COALESCE(rbytes, 0) + COALESCE(wbytes, 0) DESC
LIMIT 30;

-- 6.2b Who writes dirty buffers? A large client backend share means bgwriter/checkpointer are not keeping up.
SELECT backend_type,
       sum(writes) AS buffer_writes,
       round(100.0 * sum(writes) / NULLIF(sum(sum(writes)) OVER (), 0), 1) AS pct
FROM pg_stat_io
WHERE object = 'relation' AND writes > 0
GROUP BY backend_type
ORDER BY buffer_writes DESC;

-- 6.3 Checkpoint activity, PG16 only (PG17+: use 6.3b and 6.3c)
SELECT checkpoints_timed, checkpoints_req,
       round(100.0 * checkpoints_req / NULLIF(checkpoints_timed + checkpoints_req, 0), 1) AS pct_requested,
       round((checkpoints_timed + checkpoints_req) / NULLIF(extract(epoch FROM now() - stats_reset) / 3600, 0), 2) AS checkpoints_per_hour,
       round((checkpoint_write_time / NULLIF(checkpoints_timed + checkpoints_req, 0) / 1000)::numeric, 1) AS avg_write_s,
       round((checkpoint_sync_time / NULLIF(checkpoints_timed + checkpoints_req, 0) / 1000)::numeric, 2) AS avg_sync_s,
       buffers_checkpoint, buffers_clean, maxwritten_clean, buffers_backend, buffers_alloc,
       stats_reset
FROM pg_stat_bgwriter;
-- A high pct_requested means max_wal_size is too small for the write load.

-- 6.3b Checkpoint activity, PG17+
SELECT num_timed, num_requested,
       round(100.0 * num_requested / NULLIF(num_timed + num_requested, 0), 1) AS pct_requested,
       round((num_timed + num_requested) / NULLIF(extract(epoch FROM now() - stats_reset) / 3600, 0), 2) AS checkpoints_per_hour,
       round((write_time / NULLIF(num_timed + num_requested, 0) / 1000)::numeric, 1) AS avg_write_s,
       round((sync_time / NULLIF(num_timed + num_requested, 0) / 1000)::numeric, 2) AS avg_sync_s,
       buffers_written,
       pg_size_pretty(buffers_written * current_setting('block_size')::bigint) AS written,
       stats_reset
FROM pg_stat_checkpointer;

-- 6.3c Background writer, PG17+ (maxwritten_clean > 0 often means bgwriter_lru_maxpages is being hit)
SELECT buffers_clean, maxwritten_clean, buffers_alloc, stats_reset
FROM pg_stat_bgwriter;

-- NOTE for Aurora: pg_stat_wal is not supported, and WAL/checkpoint numbers (6.3, 6.4*) describe a storage
-- layer Aurora manages itself, so expect errors or values that are not meaningful. Use CloudWatch (WriteIOPS,
-- ReadIOPS, FreeLocalStorage, VolumeBytesUsed) and Performance Insights instead.
-- 6.4 WAL generation since stats reset (PG18 removes wal_write/wal_sync: see pg_stat_io, object = 'wal')
SELECT wal_records, wal_fpi,
       round(100.0 * wal_fpi / NULLIF(wal_records, 0), 1) AS fpi_pct_of_records,
       pg_size_pretty(wal_bytes) AS wal_bytes,
       pg_size_pretty(wal_bytes / NULLIF(extract(epoch FROM now() - stats_reset), 0)) AS wal_per_second,
       wal_buffers_full, wal_write, wal_sync, stats_reset
FROM pg_stat_wal;

-- 6.4b WAL directory size (needs pg_monitor or superuser)
SELECT count(*) AS segments, pg_size_pretty(sum(size)) AS wal_dir_size
FROM pg_ls_waldir();

-- 6.4c Measure the WAL rate right now over a window (uncomment; change 60 to taste)
-- SELECT pg_current_wal_lsn() AS lsn1, now() AS t1 \gset
-- SELECT pg_sleep(60);
-- SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), :'lsn1')) AS wal_in_window,
--        pg_size_pretty((pg_wal_lsn_diff(pg_current_wal_lsn(), :'lsn1')
--                        / extract(epoch FROM now() - :'t1'::timestamptz))::bigint) AS wal_per_second;

-- 6.4d Replication slots: WAL each slot is holding back (inactive slots can fill the disk). Primary only.
SELECT slot_name, slot_type, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
       pg_size_pretty(safe_wal_size) AS safe_wal_size
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;

-- 6.4e Replication lag per standby. Primary only.
SELECT application_name, client_addr, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_lag_bytes,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;

-- 6.5 Temp file usage per database
SELECT datname, temp_files, pg_size_pretty(temp_bytes) AS temp_bytes,
       pg_size_pretty(temp_bytes / NULLIF(temp_files, 0)) AS avg_temp_file,
       stats_reset
FROM pg_stat_database
WHERE datname IS NOT NULL AND temp_files > 0
ORDER BY temp_bytes DESC;

-- 6.6 Memory, checkpoint and WAL settings at a glance (-1 means "use the default / unlimited")
SELECT name, setting, unit,
       CASE unit WHEN '8kB' THEN pg_size_pretty(setting::bigint * 8192)
                 WHEN 'kB'  THEN pg_size_pretty(setting::bigint * 1024)
                 WHEN 'MB'  THEN pg_size_pretty(setting::bigint * 1048576)
       END AS pretty,
       source
FROM pg_settings
WHERE name IN ('shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size',
               'huge_pages', 'max_connections', 'autovacuum_work_mem', 'hash_mem_multiplier',
               'temp_buffers', 'temp_file_limit', 'track_io_timing', 'random_page_cost',
               'effective_io_concurrency',
               'checkpoint_timeout', 'checkpoint_completion_target', 'max_wal_size', 'min_wal_size',
               'log_checkpoints', 'wal_buffers', 'wal_compression', 'full_page_writes', 'wal_level',
               'synchronous_commit', 'bgwriter_delay', 'bgwriter_lru_maxpages',
               'max_wal_senders', 'max_slot_wal_keep_size')
ORDER BY name;

-- 6.7 Per-table cache hit ratio (heap and index), by blocks read from outside shared_buffers
SELECT schemaname, relname,
       heap_blks_read, heap_blks_hit,
       round(100.0 * heap_blks_hit / NULLIF(heap_blks_hit + heap_blks_read, 0), 2) AS heap_hit_pct,
       idx_blks_read, idx_blks_hit,
       round(100.0 * idx_blks_hit / NULLIF(idx_blks_hit + idx_blks_read, 0), 2) AS idx_hit_pct,
       toast_blks_read,
       pg_size_pretty((heap_blks_read + COALESCE(idx_blks_read, 0)) * current_setting('block_size')::bigint) AS read_volume
FROM pg_statio_user_tables
WHERE heap_blks_read > 0
ORDER BY heap_blks_read + COALESCE(idx_blks_read, 0) DESC
LIMIT 25;

-- 6.9 Aurora cluster members: writer/readers, lag, load, and the xmin each reader feeds back to the writer
-- A reader with a large feedback_xmin_age holds back vacuum on the writer (see 4.7).
SELECT server_id,
       CASE WHEN session_id = 'MASTER_SESSION_ID' THEN 'writer' ELSE 'reader' END AS role,
       is_current, replica_lag_in_msec, round(cpu::numeric, 1) AS cpu_pct,
       active_txns, pending_read_ios, read_ios,
       feedback_xmin, age(feedback_xmin::text::xid) AS feedback_xmin_age,
       last_update_timestamp
FROM aurora_replica_status()
ORDER BY role DESC, server_id;

-- 6.9b Replication slot detail (rds.logical_replication = on here; an inactive slot retains WAL)
SELECT slot_name, plugin, slot_type, database, active, active_pid,
       xmin, catalog_xmin, restart_lsn, confirmed_flush_lsn, wal_status
FROM pg_replication_slots;

-- 6.8 What is in shared_buffers? (needs CREATE EXTENSION pg_buffercache; commented out)
-- SELECT c.relname, count(*) AS buffers,
--        pg_size_pretty(count(*) * current_setting('block_size')::bigint) AS size,
--        round(100.0 * count(*) / (SELECT setting::int FROM pg_settings WHERE name = 'shared_buffers'), 1) AS pct_of_cache
-- FROM pg_buffercache b
-- JOIN pg_class c ON b.relfilenode = pg_relation_filenode(c.oid)
--  AND b.reldatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
-- GROUP BY c.relname
-- ORDER BY buffers DESC
-- LIMIT 20;
