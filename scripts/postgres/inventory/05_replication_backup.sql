-- Replication and backup/HA inventory. Requires PG 16+.

-- 5.1 Key settings
SELECT name, setting, unit
FROM pg_settings
WHERE name IN ('wal_level', 'max_wal_senders', 'max_replication_slots',
               'max_slot_wal_keep_size', 'synchronous_commit',
               'synchronous_standby_names', 'archive_mode', 'archive_command',
               'archive_library', 'hot_standby', 'wal_compression',
               'max_wal_size', 'min_wal_size', 'wal_keep_size',
               'track_commit_timestamp', 'data_checksums')
ORDER BY name;

-- 5.2 Replication slots
SELECT slot_name, plugin, slot_type, database, active, active_pid,
       wal_status, safe_wal_size,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal,
       conflicting
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;
-- PG17+ also exposes inactive_since, invalidation_reason and failover columns.
-- pg_current_wal_lsn() errors on a standby; use pg_last_wal_replay_lsn() there.

-- 5.3 Connected standbys (run on primary)
SELECT application_name, client_addr, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_lag_bytes,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;

-- 5.4 Logical replication: publications and subscriptions
SELECT pubname, pubowner::regrole AS owner, puballtables,
       pubinsert, pubupdate, pubdelete, pubtruncate, pubviaroot
FROM pg_publication;

SELECT subname, subowner::regrole AS owner, subenabled, subslotname,
       subpublications, subbinary, substream
FROM pg_subscription;
-- PG17+ adds subfailover; add it to the list if present.

-- 5.5 Archiver status
SELECT archived_count, last_archived_wal, last_archived_time,
       failed_count, last_failed_wal, last_failed_time
FROM pg_stat_archiver;

-- 5.6 WAL generated so far / current position
SELECT pg_current_wal_lsn() AS current_lsn,
       pg_walfile_name(pg_current_wal_lsn()) AS current_walfile;

-- 5.7 Are data checksums on?
SHOW data_checksums;
