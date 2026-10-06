# Aurora PostgreSQL 16.13 – Reader Replica Lag Runbook (Rails)

**Topology:** Ruby on Rails app → PgBouncer → writer; Rails app → RDS Proxy → reader.
**Symptom:** intermittent replica lag or stale reads on the reader.

## How Aurora lag happens

Aurora readers apply the writer's redo to pages already in their buffer cache. Lag comes from one of four things:

1. **Write burst**: the writer produced redo faster than the reader could apply it (bulk DML, data migrations, vacuum, job-queue churn).
2. **Replay blocked**: reader queries conflict with redo (DDL locks, buffer pins, long snapshots).
3. **Reader starved**: CPU, memory or cache pressure, often from an undersized reader.
4. **Not lag at all**: the app reads the replica right after writing. The metric looks fine, but the data is stale.

> **Current lead:** writer `TransactionLogsDiskUsage` spikes at exactly the times the app team reports problems. That metric only has real values when logical replication or DMS is in use, so a logical replication (CDC) consumer is involved. See §8.

---

## The short list (best bang for the buck)

| # | Action | Effort | Why |
|---|---|---|---|
| 1 | **Download log files now** if logs aren't exported to CloudWatch (§1) | 10 min | They rotate after 3 days by default |
| 2 | **Review Performance Insights for the incident window** (§1) | 15 min | Only 7 days of retention on the default tier |
| 3 | **Identify the logical replication consumer and run the slot queries** (§8) | 20 min | `TransactionLogsDiskUsage` lines up with the app's problems; find out who owns the slot and why WAL piles up |
| 4 | **Ask whether "lag" is the metric or stale data** (§2) | 1 question | Separates a database problem from a Rails read-routing problem |
| 5 | **Overlay writer `WriteIOPS` and `TransactionLogsDiskUsage` on reader `AuroraReplicaLag`, and check RDS Proxy `DatabaseConnectionsCurrentlyInTransaction`** (§3) | 10 min | Tells you whether the cause is a write burst, the CDC consumer or long reader transactions |
| 6 | **Run the incident-timeline and replication Logs Insights queries** (§4) | 10 min | Shows DDL, vacuum, conflicts, slow SQL and consumer disconnects in time order |
| 7 | **Enable Rails query log tags** (§7) | 1 config change + deploy | Ties every query to a controller or job |
| 8 | **Turn on the key logging parameters and log export** (§7) | 15 min, no reboot | So the next incident is fully captured |
| 9 | **Set alarms on `AuroraReplicaLag` and `TransactionLogsDiskUsage`** (§7) | 10 min | Catches the next spike live, so you can run the SQL in §5 and §8 |

---

## 1. Preserve the evidence (time-sensitive)

| Source | Default retention |
|---|---|
| PostgreSQL log files on the instance (not exported) | **3 days**: download now |
| Performance Insights / Database Insights | **7 days**: review now |
| CloudWatch metrics (1-minute) | 15 days |
| Enhanced Monitoring (`RDSOSMetrics`) | 30 days |
| RDS events | 14 days |

If logs aren't exported to CloudWatch, pull them from **both** instances:

```bash
aws rds describe-db-log-files --db-instance-identifier <reader-id> \
  --query 'DescribeDBLogFiles[].[LogFileName,LastWritten,Size]' --output table

aws rds download-db-log-file-portion --db-instance-identifier <reader-id> \
  --log-file-name error/postgresql.log.2026-09-30-14 \
  --starting-token 0 --output text > reader_2026-09-30-14.log
```

In **Performance Insights**, zoom to the incident window on both instances and screenshot what you find:

- **Writer:** Top SQL during the spike, which usually identifies the culprit.
- **Reader:** top waits. Lock or `BufferPin` waits mean replay was blocked; CPU or IO waits mean the reader was starved.

---

## 2. Ask the team

1. **Is "lag" the `AuroraReplicaLag` metric, or the app seeing stale or missing data?** Stale data with a normal metric is a read-routing problem, covered in §6.
2. **What deployed or ran on a schedule around the incident?** Ask about migrations, Rake tasks, and cron jobs (sidekiq-cron, whenever, GoodJob cron).
3. **Which job system do you use**: Sidekiq, GoodJob, Solid Queue? Do any jobs read from the replica?
4. **Are jobs enqueued in `after_commit`**, or in `after_save` and `after_create`?
5. **Is Rails multi-database role switching used** (`connects_to`, `connected_to(role: :reading)`)? What's the `DatabaseSelector` `delay`?
6. **Is the reader the same instance class as the writer?**
7. **Do you use `strong_migrations`,** and do migrations use `algorithm: :concurrently` for indexes?
8. **Is `prepared_statements: false` set** for the PgBouncer connection?
9. **What consumes logical replication from this cluster?** DMS, Debezium/Kafka, a zero-ETL integration, a logical subscriber, an analytics pipeline?
10. **Did that consumer restart, error or fall behind at the spike times?** Check DMS task logs, Kafka Connect logs or the integration's status page.
11. **Could any replication slot be abandoned**, for example left over from an old migration?

---

## 3. Find the window and correlate the metrics

Find the real spike using **Maximum** at a **1-minute** period. Averages hide short spikes.

```bash
aws cloudwatch get-metric-statistics --namespace AWS/RDS \
  --metric-name AuroraReplicaLag \
  --dimensions Name=DBInstanceIdentifier,Value=<reader-id> \
  --start-time 2026-09-29T00:00:00Z --end-time 2026-10-01T00:00:00Z \
  --period 60 --statistics Maximum --output text | sort -k2 -n | tail -20
```

Use the **onset** of the spike, not its peak, and set a window of roughly 15 minutes before to 10 minutes after.

### CloudWatch metrics (`AWS/RDS`)

Graph these together at **1-minute Maximum** unless noted. Metrics marked ★ are the ones to start with.

**Writer: is it producing a burst of redo?**

| Metric | What it tells you |
|---|---|
| ★ `WriteIOPS` | Aurora storage write records per second, roughly the number of redo log records generated. **This is your redo-rate metric on Aurora.** |
| ★ `WriteThroughput` | Bytes per second written to storage. Big rows and TOAST show up here more than in `WriteIOPS`. |
| `StorageNetworkTransmitThroughput` | Bytes per second sent to the storage layer. Another view of the same burst. |
| `CommitThroughput`, `CommitLatency` | Commit rate and commit time. Many small commits versus a few huge ones. |
| ★ `DBLoad`, `DBLoadCPU`, `DBLoadNonCPU` | Active sessions. Published by Performance Insights. |
| `MaximumUsedTransactionIDs` | Rising transaction ID age means anti-wraparound vacuums are coming, which are heavy redo producers. |
| `VolumeWriteIOPs` (cluster level) | 5-minute granularity only. Useful as a coarse confirmation over longer ranges. |
| ★ `TransactionLogsDiskUsage` | Disk space used by transaction logs. Only populated when logical replication or DMS is in use (otherwise `-1`). Rises when a replication slot holds WAL its consumer hasn't confirmed. **Current lead; see §8.** |
| `ReplicationSlotDiskUsage` | Disk space used by replication slot files. |
| `OldestReplicationSlotLag` | How far, in bytes of WAL, the most-lagging slot consumer is behind. |
| `FreeLocalStorage` (writer) | Local storage available on the writer. Drops if retained WAL or decoding spills grow. |

**Reader: was replay blocked, or was the instance starved?**

| Metric | What it tells you |
|---|---|
| ★ `AuroraReplicaLag` | Use the reader's instance dimension. `AuroraReplicaLagMaximum` and `AuroraReplicaLagMinimum` are reported on the writer. |
| ★ `EngineUptime` | Drops to near zero when the instance restarts. A reset at the spike means Aurora restarted the lagging reader. |
| ★ `CPUUtilization`, `DBLoad`, `DBLoadCPU`, `DBLoadNonCPU` | Reader CPU saturation and active sessions. |
| `FreeableMemory`, `SwapUsage`, `AuroraEstimatedSharedMemoryBytes` | Memory pressure. `SwapUsage` isn't published for db.r7g classes. |
| `BufferCacheHitRatio`, `ReadIOPS`, `ReadLatency`, `DiskQueueDepth` | Cache misses forcing storage reads. |
| `StorageNetworkReceiveThroughput` | Bytes per second pulled from storage; rises with cache misses. |
| `FreeLocalStorage` | Local temp-file space. A sharp drop means big sorts or hashes spilling to disk on the reader. |
| `DatabaseConnections`, `Deadlocks` | Connection surges and deadlocks. |

**RDS Proxy (reader side).** Use the `ProxyName`, `TargetGroup`, `TargetRole` dimensions with `TargetRole = READ_ONLY`.

| Metric | Statistic | What it tells you |
|---|---|---|
| ★ `DatabaseConnectionsCurrentlyInTransaction` | Sum | Connections with an open transaction. A climb before the lag spike points to long reader transactions blocking replay. |
| `DatabaseConnectionsCurrentlySessionPinned` | Sum | Pinned sessions. Expect this to be high with Rails, which issues `SET` commands on connect. |
| `DatabaseConnectionsBorrowLatency` | Average | Time to get a database connection from the pool. Rises when the pool is exhausted. |
| `ClientConnections`, `DatabaseConnections` | Sum | Connection surges, for example after a deploy. |

> **Caution:** `QueryDatabaseResponseLatency`, `QueryResponseLatency` and `QueryRequests` don't include PostgreSQL traffic that uses the extended query protocol. Rails' `pg` adapter uses it for prepared statements and parameterized queries, so these metrics may undercount or show nothing for your app. Don't read a flat line there as "the database was fine."

### Performance Insights counters (1-minute, 7-day retention)

These aren't in CloudWatch, but you can add them to the Performance Insights or Database Insights dashboard for each instance, or pull them with the CLI. Several map directly onto the causes of lag.

| Counter | Instance | What it tells you |
|---|---|---|
| ★ `db.Transactions.oldest_reader_feedback_xid_age` | Writer (check both) | Age of the oldest long-running transaction on an Aurora reader. The most direct signal for "a reader transaction is blocking things." |
| ★ `db.SQL.tup_updated`, `db.SQL.tup_inserted`, `db.SQL.tup_deleted` | Writer | Rows changed per second. Pins down a write burst and whether it was updates, inserts or deletes. |
| `db.Checkpoint.checkpoints_req` | Writer | Forced checkpoints, which lead to bursts of full-page writes. |
| ★ `db.Transactions.oldest_active_logical_replication_slot_xid_age`, `db.Transactions.oldest_inactive_logical_replication_slot_xid_age` | Writer | Age of the oldest transaction held by an active or inactive logical slot. An inactive slot with a growing age suggests an abandoned or stalled consumer. |
| ★ `db.state.idle_in_transaction_count`, `db.state.idle_in_transaction_max_time` | Reader | Sessions holding a transaction open while doing nothing, and the longest such session in seconds. |
| `db.Transactions.active_transactions`, `db.Transactions.blocked_transactions`, `db.Locks.num_blocked_sessions` | Reader | Transaction pile-ups and blocking. |
| `db.Temp.temp_bytes` | Reader | Temp-file spills from big sorts or hashes. |
| `db.IO.storage_blks_read` | Reader | Blocks read from Aurora storage, meaning cache misses. |
| `os.cpuUtilization.steal`, `os.loadAverageMinute.one`, `os.swap.in`, `os.memory.outOfMemoryKillCount` | Reader | OS-level starvation. |

```bash
aws pi get-resource-metrics --service-type RDS \
  --identifier <writer-DbiResourceId> \
  --start-time 2026-09-30T14:00:00Z --end-time 2026-09-30T15:00:00Z \
  --period-in-seconds 60 \
  --metric-queries '[{"Metric":"db.SQL.tup_updated.avg"},
                     {"Metric":"db.SQL.tup_deleted.avg"},
                     {"Metric":"db.Transactions.oldest_reader_feedback_xid_age.max"}]'
```

The identifier is the instance's `DbiResourceId` (it starts with `db-`), not its name. Run `aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,DbiResourceId]'` to find it.

### Metrics to skip

| Metric | Why |
|---|---|
| `TransactionLogsGeneration` | RDS for PostgreSQL only. Aurora doesn't publish it. Use `WriteIOPS` and `WriteThroughput` instead. |
| `DMLThroughput`, `DDLThroughput`, `ActiveTransactions`, `BlockedTransactions` | Aurora MySQL only. Use the Performance Insights counters above instead. |

### How to read the graph

- **Writer `WriteIOPS` and `db.SQL.tup_*` jump first, then lag follows:** a write burst. Find the job, migration or statement with Performance Insights Top SQL on the writer and the §4 log queries.
- **`TransactionLogsDiskUsage` or `OldestReplicationSlotLag` rises at the same time as the app's problems:** the logical replication consumer is involved, either decoding a big transaction or falling behind. Work through §8.
- **Writer is flat, but `oldest_reader_feedback_xid_age`, `idle_in_transaction_max_time` or proxy `DatabaseConnectionsCurrentlyInTransaction` climbs before the lag:** long reader transactions are blocking replay.
- **Writer is flat, and reader CPU, memory, `ReadIOPS` or `FreeLocalStorage` spikes:** the reader is starved. Check the instance class and the reader's top SQL.
- **Reader `EngineUptime` resets at the spike:** Aurora restarted the reader for falling too far behind. Confirm in RDS events below.
- **Lag stays low but users see stale data:** read routing, covered in §6.

Also check RDS events for reader restarts. Aurora restarts a reader that falls too far behind:

```bash
aws rds describe-events --source-identifier <reader-id> \
  --source-type db-instance --duration 10080
```

---

## 4. CloudWatch Logs Insights: the queries that matter

Use the log group `/aws/rds/cluster/<cluster>/postgresql`. Set the time picker to your window and query **both** instance log streams.

**1. Incident timeline.** Start here:

```
fields @timestamp, @logStream, @message
| filter @message like /conflict with recovery|canceling statement|terminating connection|still waiting for|acquired .*Lock|AccessExclusiveLock|automatic (aggressive )?vacuum|statement: (ALTER|CREATE|DROP|TRUNCATE|VACUUM|REINDEX|CLUSTER|REFRESH)|duration: \d{4,}|checkpoint (starting|complete)|FATAL|PANIC/
| sort @timestamp asc
| limit 1000
```

**2. Volume per minute per instance.** The first minute where counts rise usually identifies the trigger:

```
fields @timestamp, @logStream
| filter @message like /ERROR|FATAL|conflict|canceling|waiting|vacuum|duration:/
| stats count(*) as events by bin(1m), @logStream
| sort @timestamp asc
```

**3. Slow SQL by Rails job or controller.** This needs the query log tags from §7:

```
fields @timestamp, @logStream, @message
| parse @message /duration: (?<dur_ms>[\d\.]+) ms/
| parse @message /job='(?<job>[^']+)'/
| parse @message /controller='(?<ctrl>[^']+)'/
| filter ispresent(dur_ms)
| stats count(*) as n, max(dur_ms) as max_ms by job, ctrl, @logStream
| sort max_ms desc
```

Durations are logged at completion, so subtract each duration from its timestamp to see whether the statement was running when lag began.

**4. Reader OS pressure** (`RDSOSMetrics` log group):

```
fields @timestamp, cpuUtilization.total, cpuUtilization.steal,
       loadAverageMinute.one, memory.free, swap.in, swap.out
| filter instanceID = "<reader-id>"
| sort @timestamp asc
```

Watch for CPU pinned near 100%, a load average above the vCPU count, or swap activity.

**5. Logical replication activity** (writer log stream). Look for consumers disconnecting and reconnecting, or logical decoding starting, at the spike times:

```
fields @timestamp, @logStream, @message
| filter @message like /logical decoding|replication slot|walsender|START_REPLICATION|could not send data|terminating walsender|replication connection|snapshot/
| sort @timestamp asc
| limit 500
```

If you only have downloaded log files, grep them with the same patterns (adjust for any time zone difference in the log prefix):

```bash
grep -E "2026-09-30 14:(2|3)" reader_*.log | grep -Ei "conflict|cancel|waiting|vacuum|duration|statement:|FATAL"
```

---

## 5. Key SQL

### Writer

Per-replica status, which is Aurora-specific. Run it repeatedly during a live spike:

```sql
SELECT server_id, replica_lag_in_msec, cur_replay_latency_in_usec,
       log_stream_speed_in_kib_per_second, feedback_xmin,
       pending_read_ios, cpu, last_transport_error, last_update_timestamp
FROM aurora_replica_status()
ORDER BY server_id;
```

Top redo producers. The counters are cumulative, so this works after the fact:

```sql
SELECT queryid, calls, pg_size_pretty(wal_bytes) wal, wal_fpi, rows,
       round(total_exec_time::numeric,0) total_ms, left(query,120) q
FROM pg_stat_statements
ORDER BY wal_bytes DESC
LIMIT 20;
```

Sessions holding or waiting on ACCESS EXCLUSIVE locks, usually migrations:

```sql
SELECT l.pid, l.relation::regclass, l.mode, l.granted,
       a.state, now() - a.query_start dur, left(a.query,120)
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE l.mode = 'AccessExclusiveLock';
```

### Reader

Replay conflicts. Any non-zero `confl_lock`, `confl_snapshot` or `confl_bufferpin` confirms that reader queries are blocking replay:

```sql
SELECT d.datname, c.confl_lock, c.confl_snapshot, c.confl_bufferpin,
       c.confl_deadlock, d.stats_reset
FROM pg_stat_database_conflicts c JOIN pg_stat_database d USING (datid);
```

Long transactions, attributed to Rails jobs and controllers through the query log tags:

```sql
SELECT pid, application_name, state,
       now() - xact_start AS xact_age,
       coalesce(substring(query from 'job=''([^'']+)'''),
                substring(query from 'controller=''([^'']+)''')) AS source,
       wait_event_type, wait_event, left(query,150) q
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND state <> 'idle'
ORDER BY xact_start NULLS LAST
LIMIT 25;
```

More queries are in the appendix.

---

## 6. Rails-specific causes, by symptom

### Stale data, normal lag metric
- **Jobs enqueued in `after_save` or `after_create`** run before the transaction commits, or read the replica milliseconds later. Fix: enqueue in `after_commit`, and have jobs that act on fresh writes read from the primary (`connected_to(role: :writing)`).
- **`DatabaseSelector` only protects web requests** for its `delay` window (2 seconds by default). Jobs, other processes and clients without the session cookie get no protection.

### Real lag from write bursts
- **Data migrations and Rake tasks** using `update_all`, `delete_all`, `insert_all` or large `in_batches` runs. Fix: smaller batches with a short sleep between them.
- **`touch: true` chains and `counter_cache` on hot rows** quietly multiply writes.
- **Postgres-backed job queues** (GoodJob, Que, Solid Queue) churn rows constantly, which drives heavy vacuum and redo. Check their tables first in the vacuum log entries.

### Real lag from blocked replay
- **Migrations taking ACCESS EXCLUSIVE locks:** `add_index` without `algorithm: :concurrently`, `change_column`, and new foreign keys or constraints. Rails wraps migrations in a transaction, so locks are held longer. Fix: use `strong_migrations` and set `lock_timeout` in migrations.
- **Long reader transactions:** reports, exports, `find_each` loops, or `transaction do` blocks that make HTTP calls.

### Connection-layer gotchas
- **PgBouncer in transaction mode** needs `prepared_statements: false`, unless you're on PgBouncer 1.21 or later with `max_prepared_statements` set. Advisory locks and `LISTEN/NOTIFY` (GoodJob) don't work reliably through it.
- **RDS Proxy pins sessions** because Rails issues `SET` commands on every new connection. A high `DatabaseConnectionsCurrentlySessionPinned` is expected. Pinning isn't a lag cause by itself, but long transactions keep their connections open.
- **Put timeouts on the database role, not in `database.yml` `variables:`.** Through the poolers they're either lost or add more pinning.

---

## 7. Set the trap for next time

### Rails query log tags (biggest single win)

```ruby
# config/application.rb  (Rails 7+; use the marginalia gem on older versions)
config.active_record.query_log_tags_enabled = true
config.active_record.query_log_tags = [:application, :controller, :action, :job]
config.active_record.query_log_tags_format = :sqlcommenter
```

Every query then carries a comment like `/*job='NightlyPurgeJob'*/`, which appears in `pg_stat_activity`, Performance Insights and the Postgres logs. `pg_stat_statements` ignores comments when grouping queries, so use `pg_stat_activity` and the logs for attribution.

Also set a distinct `application_name` per process type (web, sidekiq, rake) in `database.yml`, and check that it comes through RDS Proxy before relying on it on the reader.

### Database parameters (dynamic, no reboot)

| Parameter | Value | Why |
|---|---|---|
| `log_min_duration_statement` | 1000–5000 ms | long queries |
| `log_lock_waits` | on | lock contention around migrations |
| `log_autovacuum_min_duration` | 10s | which tables vacuum, and when |
| `log_statement` | `ddl` | migrations |
| `log_checkpoints` | on | full-page-write bursts |
| `rds.log_retention_period` | 10080 | 7 days of log files on the instance |

Also enable PostgreSQL log export to CloudWatch Logs on the cluster.

### Role-level timeouts for the reader

```sql
ALTER ROLE app_reader SET statement_timeout = '30s';
ALTER ROLE app_reader SET idle_in_transaction_session_timeout = '60s';
```

### Alarm

Create CloudWatch alarms that notify you, then run the §5 and §8 SQL while the spike is happening:

- `AuroraReplicaLag` on the reader: Maximum, 1 minute, above something like 1000 ms.
- `TransactionLogsDiskUsage` on the writer: Maximum, 1 minute, above a threshold set from its normal baseline.
- Optionally, `OldestReplicationSlotLag` on the writer, to catch a stalled consumer early.

---

## 8. Logical replication / CDC (current lead)

A real value in `TransactionLogsDiskUsage` means something consumes changes from the writer through a logical replication slot. The metric rises when a slot holds WAL that its consumer hasn't confirmed yet.

### Three likely explanations

1. **A large transaction is being decoded.** Logical decoding can't send a transaction until it commits, so a big batch job or data migration makes WAL pile up until the commit. The same burst can also cause reader lag and app slowness. Here the metric is a symptom of the burst rather than the cause, but it gives a precise timestamp for it.
2. **The consumer fell behind or disconnected.** A DMS task, Debezium connector, zero-ETL integration or logical subscriber slows down or restarts, and WAL is retained until it catches up. The decoding and the catch-up afterwards both add CPU and IO load on the writer.
3. **Decoding spills to disk.** Transactions bigger than `logical_decoding_work_mem` are spilled to local files while they're decoded. That shows up as writer IO and CPU load at the same time as the metric spike.

### Reading the shape of `TransactionLogsDiskUsage`

| Shape | Likely explanation |
|---|---|
| Sharp spike that drains quickly | A big transaction (explanation 1 or 3) |
| Sawtooth | The consumer works in batches or keeps reconnecting |
| Steady climb | The consumer is stopped or disconnected (explanation 2) |

### Metrics to graph with it

- **Writer CloudWatch:** `TransactionLogsDiskUsage`, `ReplicationSlotDiskUsage`, `OldestReplicationSlotLag`, `FreeLocalStorage`, `CPUUtilization`, `WriteThroughput`
- **Writer Performance Insights:** `db.Transactions.oldest_active_logical_replication_slot_xid_age` and `oldest_inactive_logical_replication_slot_xid_age`, plus walsender (logical decoding) processes among the top waits
- **If the consumer is DMS** (`AWS/DMS` namespace, per task): `CDCLatencySource`, `CDCLatencyTarget`, `CDCIncomingChanges`
- **Reader:** `AuroraReplicaLag`, to see whether reader lag rises with the slot metrics or is a separate problem
- **Logs:** Logs Insights query 5 in §4

### SQL on the writer

Which slots exist, and how much WAL each one is holding:

```sql
SELECT slot_name, slot_type, plugin, database, active, active_pid,
       wal_status, safe_wal_size,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))         AS retained_wal,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS unconfirmed,
       age(catalog_xmin) AS catalog_xmin_age
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC;
```

Whether decoding is spilling large transactions to disk. This is the key check for explanation 3. The counters are cumulative, so look for non-zero and growing `spill_*` values:

```sql
SELECT slot_name, spill_txns, spill_count, pg_size_pretty(spill_bytes) spill,
       stream_txns, pg_size_pretty(stream_bytes) streamed,
       total_txns, pg_size_pretty(total_bytes) total, stats_reset
FROM pg_stat_replication_slots;
```

Who is connected and how far behind they are. `application_name` and `client_addr` usually identify the consumer:

```sql
SELECT pid, application_name, client_addr, state, backend_start,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn))  AS send_lag,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn)) AS flush_lag_bytes,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;
```

Relevant settings:

```sql
SELECT name, setting, unit FROM pg_settings
WHERE name IN ('rds.logical_replication','wal_level','logical_decoding_work_mem',
               'max_slot_wal_keep_size','max_replication_slots','max_wal_senders');
```

> **Caution:** Don't drop a replication slot to "clean up" until you know who owns it. Dropping it breaks that consumer's change stream, and the consumer usually needs a full resync afterwards. If a slot is truly abandoned (`active = false` and nobody claims it), dropping it is the fix.

---

## 9. Fixes, once the cause is confirmed

- **Undersized reader:** match the reader instance class to the writer.
- **Write bursts:** batch DML into smaller commits and schedule heavy jobs away from peak read traffic. Smaller transactions also decode and stream to CDC consumers more smoothly.
- **Migrations:** use `strong_migrations`, `algorithm: :concurrently`, and `lock_timeout`.
- **Stale reads:** enqueue jobs in `after_commit` and send read-after-write paths to the primary.
- **Long reader transactions:** role-level `statement_timeout` and `idle_in_transaction_session_timeout`.
- **Logical replication consumer:**
  - Fix or scale the consumer that falls behind (DMS task size, connector settings).
  - Drop slots confirmed to be abandoned.
  - Set `max_slot_wal_keep_size` as a guardrail, so a stalled consumer can't retain WAL without limit.
  - If decoding spills are high, consider raising `logical_decoding_work_mem`, or use streaming of in-progress transactions if the consumer supports it.

---

## Appendix: additional SQL

WAL generation rate on the writer, sampled over 60 seconds:

```sql
CREATE TEMP TABLE wal_sample AS SELECT now() ts, pg_current_wal_lsn() lsn;
SELECT pg_sleep(60);
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), lsn)) AS wal_per_min
FROM wal_sample;
```

Active vacuums on the writer:

```sql
SELECT p.pid, p.relid::regclass, p.phase, p.heap_blks_total, p.heap_blks_scanned,
       now() - a.xact_start AS running_for
FROM pg_stat_progress_vacuum p JOIN pg_stat_activity a USING (pid);
```

Tables close to anti-wraparound vacuum on the writer:

```sql
SELECT c.oid::regclass, age(c.relfrozenxid) xid_age,
       pg_size_pretty(pg_total_relation_size(c.oid)) size
FROM pg_class c
WHERE c.relkind IN ('r','m','t')
ORDER BY age(c.relfrozenxid) DESC
LIMIT 20;
```

Wait events on the reader right now:

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity WHERE state <> 'idle'
GROUP BY 1,2 ORDER BY 3 DESC;
```

Settings that govern how long replay waits behind reader queries:

```sql
SELECT name, setting, unit FROM pg_settings
WHERE name IN ('max_standby_streaming_delay','hot_standby_feedback',
               'statement_timeout','idle_in_transaction_session_timeout');
```

> **Note:** Column names and functions can vary slightly by Aurora minor version. Run `\df aurora_*` or check the docs for 16.13 if a column errors.
> 
