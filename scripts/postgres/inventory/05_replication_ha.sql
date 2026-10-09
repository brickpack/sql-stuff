-- Replication and backup/HA inventory. Requires PG 16+.
-- Aurora: readers use shared storage and appear in aurora_replica_status() (5.8), not pg_stat_replication.
-- pg_stat_replication / pg_replication_slots here show logical consumers (Debezium, DMS), not Aurora readers.
-- Backups on Aurora are continuous and managed outside SQL: see the CLI note at the bottom.
-- A failed statement does not stop the rest. Primary only: pg_current_wal_lsn() errors on a standby.

-- 5.1 Key settings (rds.* / logical replication settings included for Aurora)
SELECT name, setting, unit, source
FROM pg_settings
WHERE name IN ('wal_level', 'max_wal_senders', 'max_replication_slots',
               'max_slot_wal_keep_size', 'synchronous_commit',
               'synchronous_standby_names', 'archive_mode', 'archive_command',
               'archive_library', 'hot_standby', 'wal_compression',
               'max_wal_size', 'min_wal_size', 'wal_keep_size',
               'track_commit_timestamp', 'data_checksums',
               'max_logical_replication_workers', 'max_sync_workers_per_subscription',
               'max_worker_processes', 'wal_sender_timeout', 'wal_receiver_timeout',
               'logical_decoding_work_mem', 'rds.logical_replication',
               'rds.local_volume_spill_enabled', 'rds.logical_decoding_work_disk')
ORDER BY name;

-- 5.2 Replication slots. For logical slots, unconfirmed_wal (what the consumer has not acknowledged) is the
-- real lag; retained_wal is how much WAL the slot is holding. wal_status: reserved > extended > unreserved > lost.
SELECT s.slot_name, s.plugin, s.slot_type, s.database, s.active, s.active_pid,
       s.wal_status, pg_size_pretty(s.safe_wal_size) AS safe_wal_size,
       s.conflicting, s.two_phase, s.temporary,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn)) AS retained_wal,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), s.confirmed_flush_lsn)) AS unconfirmed_wal,
       s.xmin, age(s.xmin) AS xmin_age,
       s.catalog_xmin, age(s.catalog_xmin) AS catalog_xmin_age
FROM pg_replication_slots s
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn) DESC NULLS LAST;
-- PG17+ also exposes inactive_since, invalidation_reason and failover columns (not on PG16).

-- 5.2b Logical decoding load per slot: transactions spilled to disk, streamed, and totals (PG14+)
SELECT slot_name, total_txns, pg_size_pretty(total_bytes) AS total_decoded,
       spill_txns, spill_count, pg_size_pretty(spill_bytes) AS spilled,
       stream_txns, stream_count, pg_size_pretty(stream_bytes) AS streamed,
       stats_reset
FROM pg_stat_replication_slots
ORDER BY spill_bytes DESC;

-- 5.3 Walsender connections (primary only): logical consumers and physical standbys, with their slot
SELECT r.pid, r.usename, r.application_name, r.client_addr, r.state, r.sync_state,
       s.slot_name, r.backend_start,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), r.sent_lsn)) AS unsent,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), r.replay_lsn)) AS replay_lag_bytes,
       r.write_lag, r.flush_lag, r.replay_lag
FROM pg_stat_replication r
LEFT JOIN pg_replication_slots s ON s.active_pid = r.pid;

-- 5.4 Logical replication: publications and subscriptions
SELECT pubname, pubowner::regrole AS owner, puballtables,
       pubinsert, pubupdate, pubdelete, pubtruncate, pubviaroot
FROM pg_publication;

SELECT subname, subowner::regrole AS owner, subenabled, subslotname,
       subpublications, subbinary, substream
FROM pg_subscription;
-- PG17+ adds subfailover; add it to the list if present.

-- 5.4b Tables per publication (an ALL TABLES publication covers every table, so its count shows 0 here)
SELECT p.pubname, p.puballtables AS all_tables,
       count(t.tablename) AS tables,
       left(string_agg(t.tablename, ', ' ORDER BY t.tablename), 300) AS table_list
FROM pg_publication p
LEFT JOIN pg_publication_tables t ON t.pubname = p.pubname AND NOT p.puballtables
GROUP BY p.pubname, p.puballtables
ORDER BY p.pubname;

-- 5.4c Published tables that cannot replicate UPDATE/DELETE: no primary key and no usable REPLICA IDENTITY.
-- When a publication publishes updates/deletes, UPDATE/DELETE on such a table FAILS with
-- "cannot delete from table ... because it does not have a replica identity".
-- Fix: add a primary key, or ALTER TABLE ... REPLICA IDENTITY FULL (heavier WAL), or USING INDEX <unique index>.
WITH published AS (
  SELECT DISTINCT schemaname, tablename FROM pg_publication_tables
)
SELECT n.nspname AS schema, c.relname AS "table",
       CASE c.relreplident WHEN 'd' THEN 'default, but no primary key' WHEN 'n' THEN 'nothing'
                           WHEN 'f' THEN 'full' WHEN 'i' THEN 'index' END AS replica_identity,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN published p ON p.schemaname = n.nspname AND p.tablename = c.relname
WHERE c.relkind IN ('r', 'p')
  AND ((c.relreplident = 'd' AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary))
       OR c.relreplident = 'n')
ORDER BY pg_total_relation_size(c.oid) DESC;

-- 5.4d Subscription apply workers (empty unless this database subscribes to another)
SELECT subid, subname, pid, received_lsn, last_msg_send_time, last_msg_receipt_time,
       latest_end_lsn, latest_end_time
FROM pg_stat_subscription;

-- 5.5 Archiver status (not meaningful on Aurora: durability is handled by the storage layer)
SELECT archived_count, last_archived_wal, last_archived_time,
       failed_count, last_failed_wal, last_failed_time
FROM pg_stat_archiver;

-- 5.6 WAL generated so far / current position (pg_walfile_name may be unsupported on Aurora)
SELECT pg_current_wal_lsn() AS current_lsn,
       pg_walfile_name(pg_current_wal_lsn()) AS current_walfile;

-- 5.7 Are data checksums on?
SHOW data_checksums;

-- 5.8 Aurora cluster members (writer and readers), with lag and the xmin each reader feeds back
SELECT server_id,
       CASE WHEN session_id = 'MASTER_SESSION_ID' THEN 'writer' ELSE 'reader' END AS role,
       is_current, replica_lag_in_msec, round(cpu::numeric, 1) AS cpu_pct,
       feedback_xmin, age(feedback_xmin::text::xid) AS feedback_xmin_age,
       last_update_timestamp
FROM aurora_replica_status()
ORDER BY role DESC, server_id;

-- 5.9 Unlogged tables: not crash-safe and not replicated; their contents are lost on failover or crash
SELECT n.nspname AS schema, c.relname AS "table",
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relpersistence = 'u' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC;

-- 5.10 Backups and cluster HA facts live in the AWS control plane, not SQL. From a terminal with the AWS CLI (not run here):
--   aws rds describe-db-clusters --db-cluster-identifier <cluster> \
--     --query 'DBClusters[0].{Retention:BackupRetentionPeriod,Window:PreferredBackupWindow,
--    Latest:LatestRestorableTime,Members:DBClusterMembers[].[DBInstanceIdentifier,IsClusterWriter],
--    DeletionProtection:DeletionProtection,Encrypted:StorageEncrypted}'
