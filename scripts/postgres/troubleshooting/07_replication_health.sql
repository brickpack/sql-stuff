-- Replication health. Requires PG 16+.

-- 7.1 Primary: lag per standby in bytes and time
SELECT application_name, client_addr, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn))   AS sent_lag,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), write_lsn))  AS write_lag_bytes,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn))  AS flush_lag_bytes,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_lag_bytes,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) DESC;

-- 7.2 Replicas: how far behind is this standby? (run on the standby)
SELECT pg_is_in_recovery() AS in_recovery,
       pg_last_wal_receive_lsn() AS received,
       pg_last_wal_replay_lsn() AS replayed,
       pg_last_xact_replay_timestamp() AS last_replay_ts,
       now() - pg_last_xact_replay_timestamp() AS replay_delay;

-- 7.3 Replica: recovery conflicts (queries cancelled by replay)
SELECT datname, confl_tablespace, confl_lock, confl_snapshot, confl_bufferpin, confl_deadlock
FROM pg_stat_database_conflicts
WHERE datname IS NOT NULL;

-- 7.4 Slots retaining WAL (disk-fill risk); inactive slots are the usual culprit
SELECT slot_name, slot_type, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
       pg_size_pretty(safe_wal_size) AS safe_wal_size
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;

-- 7.5 Subscriber: logical replication worker stats
SELECT subid, subname, apply_error_count, sync_error_count, stats_reset
FROM pg_stat_subscription_stats;

SELECT subname, pid, relid::regclass AS relation, received_lsn,
       last_msg_send_time, last_msg_receipt_time, latest_end_time
FROM pg_stat_subscription;

-- 7.6 WAL receiver (on standby)
SELECT status, receive_start_lsn, written_lsn, flushed_lsn,
       last_msg_receipt_time, sender_host, sender_port, slot_name
FROM pg_stat_wal_receiver;

-- 7.7 WAL directory size (needs pg_ls_waldir: superuser or pg_monitor)
SELECT count(*) AS files, pg_size_pretty(sum(size)) AS total
FROM pg_ls_waldir();
