# Aurora PostgreSQL 16.13 – Reader Replica Lag Troubleshooting Runbook

**Topology:** one writer (behind PgBouncer), one reader (behind RDS Proxy). The symptom is random replica lag on the reader.

Aurora replication isn't PostgreSQL streaming replication. The writer ships redo to the shared storage layer and to each reader. The reader then applies that redo to pages it already holds in its buffer cache. So lag usually comes from one of four things:

- **The writer produced redo faster than the reader could apply it**, for example a bulk load, a big UPDATE or DELETE, or a large vacuum.
- **The reader couldn't apply redo** because its own queries conflicted with it, through locks, buffer pins or snapshot conflicts.
- **The reader was starved of resources**: CPU, memory or cache.
- **Something that isn't lag at all**, such as stale reads caused by pooling or routing.

Because your lag is random, the main job is correlating it with a trigger.

---

## 1. Questions for your developer and architect

1. **How exactly are we observing "lag"?** Is it the `AuroraReplicaLag` metric spiking, or the app seeing stale data after a write? The second one is often read-after-write inconsistency through RDS Proxy, which is expected at a few to tens of milliseconds, rather than real lag.
2. **What runs on a schedule?** Ask about ETL, batch jobs, pg_cron, report generation, data purges, `REFRESH MATERIALIZED VIEW`, nightly imports and partition maintenance, and what time each one runs.
3. **Do deployments run migrations?** `ALTER TABLE`, `CREATE INDEX` without `CONCURRENTLY`, `TRUNCATE`, `DROP` and `VACUUM FULL` all take ACCESS EXCLUSIVE locks. Those lock records must replay on the reader and will wait behind reader queries.
4. **Are there long-running queries or idle-in-transaction sessions on the reader?** Think analytics, exports, BI tools, or ORMs that hold transactions open.
5. **Is the reader the same instance class as the writer?** An undersized reader is a very common cause.
6. **What pool mode is PgBouncer in, and what are the pool sizes?** Do write bursts happen when pools refill after a deploy or failover?
7. **Do we write large objects or big JSONB/TOAST rows, or do mass updates that touch many pages?**
8. **Is anything else in play?** Logical replication slots, DMS, CDC or Debezium consumers, or large temp-table usage?
9. **Do lag spikes line up with app-side latency or errors?** Specifically, look for errors like *"canceling statement due to conflict with recovery."*

---

## 2. CloudWatch metrics to watch besides lag

### On the writer (cause side)
- `TransactionLogsGeneration`: the redo/WAL generation rate. Overlay it on reader lag first; it's the strongest single correlator.
- `WriteIOPS`, `WriteThroughput`, `CommitThroughput`, `CommitLatency`
- `DMLThroughput`, `DDLThroughput` (where available), `DBLoad` and `DBLoadCPU`
- `MaximumUsedTransactionIDs`: rising values mean anti-wraparound vacuums, which are heavy redo producers.
- `OldestReplicationSlotLag` and `TransactionLogsDiskUsage`, if you use logical slots.

### On the reader (effect side)
- `AuroraReplicaLag`, plus `AuroraReplicaLagMaximum` and `AuroraReplicaLagMinimum` at the cluster level
- `CPUUtilization`, `DBLoad`, `DBLoadCPU`, `DBLoadNonCPU`
- `FreeableMemory`, `BufferCacheHitRatio`, `ReadIOPS`, `ReadLatency`
- `DatabaseConnections`, `Deadlocks`
- Enhanced Monitoring at 1–5 second granularity: OS CPU steal, run queue (`loadAverageMinute`), memory

### On RDS Proxy (reader side)
- `DatabaseConnectionsCurrentlySessionPinned`: pinned sessions can hold transactions open longer.
- `QueryDatabaseResponseLatency`, `ClientConnections`, `DatabaseConnectionRequests`

### Performance Insights on the reader
During a lag window, check the top wait events and top SQL. Lock waits or `BufferPin` waits during a spike point at replay conflicts.

---

## 3. SQL: writer side

Per-replica status, which is Aurora-specific. Run it every few seconds during an incident:

```sql
SELECT server_id,
       session_id,
       replica_lag_in_msec,
       cur_replay_latency_in_usec,
       log_stream_speed_in_kib_per_second,
       durable_lsn, highest_lsn_rcvd, current_read_lsn,
       feedback_xmin,
       pending_read_ios, cpu,
       last_transport_error, last_error_timestamp,
       last_update_timestamp
FROM aurora_replica_status()
ORDER BY server_id;
```

WAL generation rate, sampled over 60 seconds:

```sql
CREATE TEMP TABLE wal_sample AS SELECT now() ts, pg_current_wal_lsn() lsn;
SELECT pg_sleep(60);
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), lsn)) AS wal_per_min
FROM wal_sample;
```

Top write-heavy statements. This needs `pg_stat_statements`, and the `wal_bytes` column exists on PG 13 and later:

```sql
SELECT queryid, calls,
       pg_size_pretty(wal_bytes) wal,
       wal_fpi, rows,
       round(total_exec_time::numeric,0) total_ms,
       left(query, 120) q
FROM pg_stat_statements
ORDER BY wal_bytes DESC
LIMIT 20;
```

Full-page images (`wal_fpi`) appear after checkpoints and inflate redo. A high `wal_fpi` alongside updates that touch many distinct pages is a classic way to amplify lag.

Active vacuums, which are big redo producers:

```sql
SELECT p.pid, p.relid::regclass, p.phase,
       p.heap_blks_total, p.heap_blks_scanned,
       a.query, now() - a.xact_start AS running_for
FROM pg_stat_progress_vacuum p
JOIN pg_stat_activity a USING (pid);
```

Tables close to anti-wraparound vacuum:

```sql
SELECT c.oid::regclass, age(c.relfrozenxid) xid_age,
       pg_size_pretty(pg_total_relation_size(c.oid)) size
FROM pg_class c
WHERE c.relkind IN ('r','m','t')
ORDER BY age(c.relfrozenxid) DESC
LIMIT 20;
```

Sessions holding or waiting on ACCESS EXCLUSIVE locks, usually DDL:

```sql
SELECT l.pid, l.relation::regclass, l.mode, l.granted,
       a.state, now() - a.query_start dur, left(a.query,120)
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE l.mode = 'AccessExclusiveLock';
```

---

## 4. SQL: reader side

Replay conflicts, cumulative per database. Non-zero `confl_lock`, `confl_snapshot` or `confl_bufferpin` is strong evidence of replay conflicts:

```sql
SELECT datname, confl_tablespace, confl_lock, confl_snapshot,
       confl_bufferpin, confl_deadlock
FROM pg_stat_database_conflicts;
```

Long-running queries and transactions on the reader:

```sql
SELECT pid, usename, application_name, client_addr, state,
       now() - xact_start  AS xact_age,
       now() - query_start AS query_age,
       wait_event_type, wait_event,
       backend_xmin,
       left(query, 150) q
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND state <> 'idle'
ORDER BY xact_start NULLS LAST
LIMIT 25;
```

Wait events on the reader right now:

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE state <> 'idle'
GROUP BY 1,2
ORDER BY 3 DESC;
```

The settings that govern how long replay waits behind reader queries:

```sql
SELECT name, setting, unit
FROM pg_settings
WHERE name IN ('max_standby_streaming_delay','max_standby_archive_delay',
               'hot_standby_feedback','statement_timeout',
               'idle_in_transaction_session_timeout');
```

> **Note:** Column names and functions can vary slightly by Aurora minor version. Run `\df aurora_*` or check the docs for 16.13 if a column errors.

---

## 5. Logging to turn on (cluster or instance parameter group)

| Parameter | Suggested value | Why |
|---|---|---|
| `log_min_duration_statement` | 1000–5000 ms | catch long reader queries |
| `log_lock_waits` | on | lock contention around DDL |
| `log_autovacuum_min_duration` | 0 or 10s | see which tables vacuum, and when |
| `log_statement` | `ddl` | catch migrations and DDL |
| `log_checkpoints` | on | correlates with full-page-image bursts |
| `log_temp_files` | 0 or small | spills on reader |

Export the PostgreSQL log to CloudWatch Logs for both instances.

---

## 6. CloudWatch Logs Insights queries

Use the log group `/aws/rds/cluster/<cluster>/postgresql`.

Replay conflicts and cancellations over time:

```
fields @timestamp, @logStream, @message
| filter @message like /conflict with recovery/ or @message like /canceling statement due to/
| stats count(*) as conflicts by bin(5m), @logStream
| sort @timestamp desc
```

DDL timeline, to overlay on lag spikes:

```
fields @timestamp, @logStream, @message
| filter @message like /statement: (ALTER|CREATE|DROP|TRUNCATE|VACUUM|REINDEX|CLUSTER|REFRESH)/
| sort @timestamp desc
| limit 200
```

Slow statements by duration:

```
fields @timestamp, @logStream, @message
| parse @message /duration: (?<dur_ms>[\d\.]+) ms/
| filter ispresent(dur_ms) and dur_ms > 5000
| sort dur_ms desc
| limit 100
```

Autovacuum activity: which tables, and how long each run took:

```
fields @timestamp, @message
| filter @message like /automatic (aggressive )?vacuum/
| parse @message /of table "(?<tbl>[^"]+)"/
| parse @message /elapsed: (?<elapsed>[\d\.]+) s/
| sort @timestamp desc
| limit 100
```

Lock waits:

```
fields @timestamp, @logStream, @message
| filter @message like /still waiting for/ or @message like /acquired .*Lock after/
| sort @timestamp desc
```

Checkpoint frequency, where bursts of checkpoints mean more full-page writes:

```
fields @timestamp, @message
| filter @message like /checkpoint complete/
| stats count(*) by bin(15m)
```

### RDS events

Also check RDS events for the reader. Aurora will restart a reader that falls too far behind, and that shows up as an event, not in the Postgres log:

```bash
aws rds describe-events --source-identifier <reader-instance-id> \
  --source-type db-instance --duration 10080
```

---

## 7. Suggested triage order

1. Graph writer `TransactionLogsGeneration` against reader `AuroraReplicaLag` at 1-minute granularity over 1–2 weeks. If they correlate, the cause is a write burst; find the job with `pg_stat_statements` `wal_bytes` and the DDL and vacuum log queries.
2. If they don't correlate, check reader `pg_stat_database_conflicts`, long transactions, and Performance Insights waits during a spike. That points to reader queries blocking replay.
3. Check the reader's `CPUUtilization`, `FreeableMemory`, `BufferCacheHitRatio` and Enhanced Monitoring. If the reader is smaller than the writer, that alone can explain spikes under load.
4. Check RDS events for reader restarts and compare deploy timestamps against the spikes.
5. If the app reports stale reads but the metric stays low, the problem is consistency, not lag. Route read-after-write paths to the writer through PgBouncer.

---

## 8. Quick wins if the cause is confirmed

- Match the reader instance class to the writer.
- Batch large DML into smaller commits.
- Use `CREATE INDEX CONCURRENTLY` and lock-timeout-guarded migrations (`SET lock_timeout = '5s'`).
- Set `idle_in_transaction_session_timeout` and `statement_timeout` for reader app roles.
- Schedule heavy jobs away from peak read traffic.
