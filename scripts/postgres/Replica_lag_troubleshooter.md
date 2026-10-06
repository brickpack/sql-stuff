# Aurora PostgreSQL 16.13 – Replica Lag and CDC Runbook (Rails)

**Topology:** Rails app → PgBouncer → writer; Rails app → RDS Proxy → reader. A logical replication (CDC) consumer reads from the writer.
**Symptom:** intermittent problems reported by the app team, believed to be replica lag on the reader.
**Current lead:** writer `TransactionLogsDiskUsage` spikes at exactly the times the app team reports problems.

## Background in two minutes

**Aurora reader lag.** Aurora readers apply the writer's redo to pages already in their buffer cache. Lag has four usual causes:

1. **Write burst:** the writer produces redo faster than the reader can apply it (bulk DML, data migrations, vacuum, job-queue churn).
2. **Replay blocked:** reader queries conflict with redo (DDL locks, buffer pins, long snapshots).
3. **Reader starved:** CPU, memory or cache pressure, often from an undersized reader.
4. **Not lag at all:** the app reads the replica right after writing. The metric looks fine, but the data is stale.

**Why `TransactionLogsDiskUsage` matters.** On Aurora PostgreSQL this metric only has real values when logical replication or DMS is in use; otherwise it reports `-1`. It rises when a replication slot holds WAL that its consumer hasn't confirmed. So whatever happens at the spike times involves the CDC consumer, a big transaction it's decoding, or both.

---

## The short list

| # | Action | Section | Effort |
|---|---|---|---|
| 1 | **Download log files** if logs aren't exported to CloudWatch. They rotate after 3 days. | §1 | 10 min |
| 2 | **Review Performance Insights for the spike windows.** Data is kept for 7 days. | §1 | 15 min |
| 3 | **Decide what the app team is actually seeing:** reader lag, stale data, or writer slowness. | §2 | 15 min |
| 4 | **Identify the CDC consumer and check the slots.** | §3 | 20 min |
| 5 | **Find the transaction or job that was running at the spike.** | §3, §5 | 20 min |
| 6 | **Run the timeline and replication Logs Insights queries.** | §5 | 10 min |
| 7 | **Enable Rails query log tags, logging parameters and alarms**, so the next spike is fully captured. | §8 | 30 min + deploy |

Record what you find in the findings log at the end as you go.

---

## 1. Preserve the evidence (time-sensitive)

| Source | Default retention |
|---|---|
| PostgreSQL log files on the instance (not exported) | **3 days**: download now |
| Performance Insights / Database Insights | **7 days**: review now |
| CloudWatch metrics (1-minute) | 15 days |
| Enhanced Monitoring (`RDSOSMetrics`) | 30 days |
| RDS events | 14 days |

If logs aren't exported to CloudWatch, pull them from **both** instances. The writer matters most for the current lead.

```bash
aws rds describe-db-log-files --db-instance-identifier <writer-id> \
  --query 'DescribeDBLogFiles[].[LogFileName,LastWritten,Size]' --output table

aws rds download-db-log-file-portion --db-instance-identifier <writer-id> \
  --log-file-name error/postgresql.log.<YYYY-MM-DD-HH> \
  --starting-token 0 --output text > writer_<YYYY-MM-DD-HH>.log
```

In **Performance Insights**, zoom to each spike on both instances and screenshot what you find:

- **Writer:** Top SQL and top waits. Look for a large write statement, and for walsender (logical decoding) processes among the waits.
- **Reader:** top waits. Lock or `BufferPin` waits mean replay was blocked; CPU or IO waits mean the reader was starved.

---

## 2. Decide what the problem actually is

`TransactionLogsDiskUsage` is a writer metric, so don't assume the problem is reader lag. Graph these together at **1-minute Maximum** across several spike times:

- writer `TransactionLogsDiskUsage`
- reader `AuroraReplicaLag`
- writer `CPUUtilization` and `DBLoad`

Then ask the app team exactly what they see (slow responses, timeouts, stale or missing data) and on which code paths.

| What you see | What it means | Go to |
|---|---|---|
| Reader lag spikes **with** `TransactionLogsDiskUsage` | One event, usually a big write, causes both | §3, then §4 |
| `TransactionLogsDiskUsage` spikes, reader lag **stays low**, writer CPU or load rises | Writer-side problem: decoding or catch-up load on the writer | §3 |
| Reader lag spikes **without** `TransactionLogsDiskUsage` | A separate reader-side problem | §4 |
| Both metrics normal, but users see stale data | Rails read routing, not the database | §7 |

To find exact spike times, sort the metric by its Maximum:

```bash
aws cloudwatch get-metric-statistics --namespace AWS/RDS \
  --metric-name TransactionLogsDiskUsage \
  --dimensions Name=DBInstanceIdentifier,Value=<writer-id> \
  --start-time <start> --end-time <end> \
  --period 60 --statistics Maximum --output text | sort -k2 -n | tail -20
```

Run the same command with `AuroraReplicaLag` and the reader ID. For each spike, use the **onset** rather than the peak, and look at roughly 15 minutes before to 10 minutes after.

---

## 3. The CDC lead: logical replication

### Three likely explanations

1. **A large transaction is being decoded.** Logical decoding can't send a transaction until it commits, so a big batch job or data migration makes WAL pile up until the commit. The same write burst can also cause reader lag. Here the metric is a symptom of the burst rather than the cause, but it gives a precise timestamp for it.
2. **The consumer fell behind or disconnected.** A DMS task, Debezium connector, zero-ETL integration or logical subscriber slows down or restarts, and WAL is retained until it catches up. Decoding and the catch-up afterwards both add CPU and IO load on the writer.
3. **Decoding spills to disk.** Transactions bigger than `logical_decoding_work_mem` (64 MB by default) are spilled to local files while they're decoded, which adds writer IO and CPU load.

The shape of the `TransactionLogsDiskUsage` graph helps tell them apart:

| Shape | Likely explanation |
|---|---|
| Sharp spike that drains quickly | A big transaction (explanation 1, possibly 3) |
| Sawtooth | The consumer works in batches or keeps reconnecting |
| Steady climb | The consumer is stopped or disconnected (explanation 2) |

### Identify the consumer

Who is connected right now, and how far behind each consumer is:

```sql
SELECT pid, application_name, client_addr, state, backend_start,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn))  AS send_lag,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn)) AS flush_lag_bytes,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;
```

Which slots exist, and how much WAL each one is holding:

```sql
SELECT slot_name, slot_type, plugin, database, active, active_pid,
       wal_status, safe_wal_size,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))         AS retained_wal,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS unconfirmed
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC;
```

The `slot_name`, `plugin`, `application_name` and `client_addr` together usually identify the owner. Confirm with the team, and check AWS-side consumers directly:

```bash
aws dms describe-replication-tasks \
  --query 'ReplicationTasks[].[ReplicationTaskIdentifier,Status,MigrationType]' --output table
aws rds describe-integrations \
  --query 'Integrations[].[IntegrationName,Status,SourceArn]' --output table
```

### Check for decoding spills

This is the key check for explanation 3. The counters are cumulative, so note the values, then compare them after the next spike:

```sql
SELECT slot_name, spill_txns, spill_count, pg_size_pretty(spill_bytes) spill,
       stream_txns, pg_size_pretty(stream_bytes) streamed,
       total_txns, pg_size_pretty(total_bytes) total, stats_reset
FROM pg_stat_replication_slots;
```

### Find the big transaction

Over the long term, the statements that generate the most WAL:

```sql
SELECT queryid, calls, pg_size_pretty(wal_bytes) wal, wal_fpi, rows,
       round(total_exec_time::numeric,0) total_ms, left(query,120) q
FROM pg_stat_statements
ORDER BY wal_bytes DESC
LIMIT 20;
```

During a live spike, the long-running write transactions on the writer:

```sql
SELECT pid, application_name, state,
       now() - xact_start AS xact_age,
       coalesce(substring(query from 'job=''([^'']+)'''),
                substring(query from 'controller=''([^'']+)''')) AS source,
       left(query,150) q
FROM pg_stat_activity
WHERE backend_xid IS NOT NULL
ORDER BY xact_start
LIMIT 15;
```

For past spikes, use Performance Insights Top SQL on the writer, the `db.SQL.tup_*` counters, and the Logs Insights queries in §5. Once query log tags are on (§8), the `source` column names the Rails job or controller.

### Metrics to graph with the lead

- **Writer CloudWatch:** `TransactionLogsDiskUsage`, `ReplicationSlotDiskUsage`, `OldestReplicationSlotLag`, `FreeLocalStorage`, `CPUUtilization`, `WriteIOPS`, `WriteThroughput`
- **Writer Performance Insights:** `db.Transactions.oldest_active_logical_replication_slot_xid_age`, `db.Transactions.oldest_inactive_logical_replication_slot_xid_age`, and `db.SQL.tup_updated`, `tup_inserted` and `tup_deleted`
- **If the consumer is DMS** (`AWS/DMS` namespace, per task): `CDCLatencySource`, `CDCLatencyTarget`, `CDCIncomingChanges`, plus the task's CloudWatch logs

> **Caution:** Don't drop a replication slot until you know who owns it. Dropping it breaks that consumer's change stream, and the consumer usually needs a full resync afterwards. If a slot is truly abandoned (`active = false` and nobody claims it), dropping it is the fix.

---

## 4. Reader lag: metrics and SQL

Use this section when reader `AuroraReplicaLag` spikes, with or without the CDC metric.

### CloudWatch metrics (1-minute Maximum)

| Instance | Metric | What it tells you |
|---|---|---|
| Writer | `WriteIOPS`, `WriteThroughput` | The redo rate on Aurora: storage write records per second, and bytes per second. A jump just before lag means a write burst. |
| Writer | `MaximumUsedTransactionIDs` | A rising transaction ID age means anti-wraparound vacuums are coming, which produce heavy redo. |
| Reader | `AuroraReplicaLag` | Use the reader's instance dimension. |
| Reader | `EngineUptime` | Resets when the instance restarts. A reset at a spike means Aurora restarted the lagging reader. |
| Reader | `CPUUtilization`, `DBLoad` | CPU saturation and active sessions. |
| Reader | `FreeableMemory`, `BufferCacheHitRatio`, `ReadIOPS`, `ReadLatency` | Memory pressure and cache misses. |
| Reader | `FreeLocalStorage` | A sharp drop means big sorts or hashes spilling to disk. |
| RDS Proxy (`TargetRole = READ_ONLY`, Sum) | `DatabaseConnectionsCurrentlyInTransaction` | Connections with an open transaction. A climb before the spike points to long reader transactions. |

> **Caution:** RDS Proxy's `QueryDatabaseResponseLatency`, `QueryResponseLatency` and `QueryRequests` don't include PostgreSQL traffic that uses the extended query protocol, which Rails' `pg` adapter uses for many queries. A flat line there doesn't mean the database was fine.

**Performance Insights counters on the reader** (1-minute, 7-day retention): `db.state.idle_in_transaction_max_time`, `db.Transactions.blocked_transactions`, `db.Temp.temp_bytes` and `os.cpuUtilization.steal`. On the writer, `db.Transactions.oldest_reader_feedback_xid_age` shows the age of the oldest long-running transaction on a reader.

To pull counters with the CLI, use the instance's `DbiResourceId`, which starts with `db-` (`aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,DbiResourceId]'`):

```bash
aws pi get-resource-metrics --service-type RDS --identifier <DbiResourceId> \
  --start-time <start> --end-time <end> --period-in-seconds 60 \
  --metric-queries '[{"Metric":"db.SQL.tup_updated.avg"},
                     {"Metric":"db.Transactions.oldest_reader_feedback_xid_age.max"}]'
```

### How to read the reader graphs

- **Writer `WriteIOPS` jumps first, then lag follows:** a write burst. Find the statement using §3.
- **Writer is flat, but reader transaction age or proxy in-transaction connections climb first:** long reader transactions are blocking replay.
- **Writer is flat, and reader CPU, memory or IO spikes:** the reader is starved. Check its instance class and its Top SQL.
- **`EngineUptime` resets:** Aurora restarted the reader. Confirm in RDS events:

```bash
aws rds describe-events --source-identifier <reader-id> --source-type db-instance --duration 10080
```

### SQL

Per-replica status, run on the writer. Aurora-specific; run it repeatedly during a live spike:

```sql
SELECT server_id, replica_lag_in_msec, cur_replay_latency_in_usec,
       log_stream_speed_in_kib_per_second, feedback_xmin,
       pending_read_ios, cpu, last_transport_error, last_update_timestamp
FROM aurora_replica_status()
ORDER BY server_id;
```

Replay conflicts, run on the reader. Any non-zero `confl_lock`, `confl_snapshot` or `confl_bufferpin` confirms that reader queries are blocking replay:

```sql
SELECT d.datname, c.confl_lock, c.confl_snapshot, c.confl_bufferpin,
       c.confl_deadlock, d.stats_reset
FROM pg_stat_database_conflicts c JOIN pg_stat_database d USING (datid);
```

Long transactions on the reader, attributed to Rails jobs and controllers once query log tags are on:

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

Sessions holding or waiting on ACCESS EXCLUSIVE locks, run on the writer. Usually migrations:

```sql
SELECT l.pid, l.relation::regclass, l.mode, l.granted,
       a.state, now() - a.query_start dur, left(a.query,120)
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE l.mode = 'AccessExclusiveLock';
```

---

## 5. CloudWatch Logs Insights

Use the log group `/aws/rds/cluster/<cluster>/postgresql`. Set the time picker to the spike window and query **both** instance log streams so events interleave in order.

**1. Incident timeline.** Start here. It covers DDL, vacuum, locks, conflicts, slow SQL and replication events:

```
fields @timestamp, @logStream, @message
| filter @message like /conflict with recovery|canceling statement|terminating connection|still waiting for|acquired .*Lock|automatic (aggressive )?vacuum|statement: (ALTER|CREATE|DROP|TRUNCATE|VACUUM|REINDEX|CLUSTER|REFRESH)|duration: \d{4,}|checkpoint (starting|complete)|logical decoding|replication slot|walsender|START_REPLICATION|could not send data|FATAL|PANIC/
| sort @timestamp asc
| limit 1000
```

**2. Volume per minute per instance.** The first minute where counts rise usually identifies the trigger:

```
fields @timestamp, @logStream
| filter @message like /ERROR|FATAL|conflict|canceling|waiting|vacuum|duration:|walsender|logical decoding/
| stats count(*) as events by bin(1m), @logStream
| sort @timestamp asc
```

**3. Slow SQL by Rails job or controller.** This needs the query log tags from §8:

```
fields @timestamp, @logStream, @message
| parse @message /duration: (?<dur_ms>[\d\.]+) ms/
| parse @message /job='(?<job>[^']+)'/
| parse @message /controller='(?<ctrl>[^']+)'/
| filter ispresent(dur_ms)
| stats count(*) as n, max(dur_ms) as max_ms by job, ctrl, @logStream
| sort max_ms desc
```

Durations are logged at completion, so subtract each duration from its timestamp to see when the statement started. A long write that started before the spike and finished at its peak fits explanation 1 in §3.

**4. OS pressure** (`RDSOSMetrics` log group; use the writer or reader instance ID):

```
fields @timestamp, cpuUtilization.total, cpuUtilization.steal,
       loadAverageMinute.one, memory.free, swap.in, swap.out
| filter instanceID = "<instance-id>"
| sort @timestamp asc
```

If you only have downloaded log files, grep them with the same patterns (adjust for any time zone difference in the log prefix):

```bash
grep -E "<YYYY-MM-DD HH:M>" *.log | grep -Ei "conflict|cancel|waiting|vacuum|duration|statement:|walsender|logical decoding|FATAL"
```

---

## 6. Questions for the team

**CDC consumer**
1. What consumes logical replication from this cluster: DMS, Debezium/Kafka, a zero-ETL integration, a logical subscriber?
2. Did it restart, error or fall behind at the spike times? Check DMS task logs, Kafka Connect logs or the integration's status page.
3. Could any slot be abandoned, for example left over from an old migration?

**App and jobs**

4. What exactly does the app team see (slow responses, timeouts, stale data) and on which code paths?
5. What deployed or ran on a schedule at the spike times? Ask about migrations, Rake tasks, and cron jobs (sidekiq-cron, whenever, GoodJob cron).
6. Which job system do you use? Do jobs read from the replica, and are they enqueued in `after_commit`?
7. Is Rails multi-database role switching used, and what's the `DatabaseSelector` `delay`?
8. Do you use `strong_migrations`, and `algorithm: :concurrently` for indexes?

**Infrastructure**

9. Is the reader the same instance class as the writer?
10. Is `prepared_statements: false` set for the PgBouncer connection?

---

## 7. Rails-specific causes

**Large transactions, which feed both reader lag and CDC spikes**
- Data migrations and Rake tasks using `update_all`, `delete_all`, `insert_all` or large `in_batches` runs inside one transaction.
- `touch: true` chains and `counter_cache` on hot rows, which quietly multiply writes.
- Postgres-backed job queues (GoodJob, Que, Solid Queue), which churn rows constantly. That drives heavy vacuum and redo, and every change is also decoded for CDC.

**Blocked replay on the reader**
- Migrations taking ACCESS EXCLUSIVE locks: `add_index` without `algorithm: :concurrently`, `change_column`, and new foreign keys or constraints. Rails wraps migrations in a transaction, so locks are held longer.
- Long reader transactions: reports, exports, `find_each` loops, or `transaction do` blocks that make HTTP calls.

**Stale data with a normal lag metric**
- Jobs enqueued in `after_save` or `after_create` run before the commit, or read the replica milliseconds later.
- `DatabaseSelector` only protects web requests, and only for its `delay` window (2 seconds by default).

**Connection layer**
- PgBouncer in transaction mode needs `prepared_statements: false`, unless you're on PgBouncer 1.21 or later with `max_prepared_statements` set.
- RDS Proxy pins sessions because Rails issues `SET` commands on every new connection. Expect a high `DatabaseConnectionsCurrentlySessionPinned`.
- Put timeouts on the database role, not in `database.yml` `variables:`. Through the poolers they're either lost or add more pinning.

---

## 8. Set the trap for the next spike

**Rails query log tags.** This is the biggest single win: every query then names the job or controller that sent it.

```ruby
# config/application.rb  (Rails 7+; use the marginalia gem on older versions)
config.active_record.query_log_tags_enabled = true
config.active_record.query_log_tags = [:application, :controller, :action, :job]
config.active_record.query_log_tags_format = :sqlcommenter
```

Also set a distinct `application_name` per process type (web, sidekiq, rake) in `database.yml`.

**Database parameters.** These are dynamic, so no reboot is needed:

| Parameter | Value | Why |
|---|---|---|
| `log_min_duration_statement` | 1000–5000 ms | long queries, including the big write |
| `log_lock_waits` | on | lock contention around migrations |
| `log_autovacuum_min_duration` | 10s | which tables vacuum, and when |
| `log_statement` | `ddl` | migrations |
| `log_checkpoints` | on | full-page-write bursts |
| `log_replication_commands` | on | consumer connects, disconnects and replication commands |
| `rds.log_retention_period` | 10080 | 7 days of log files on the instance |

Also enable PostgreSQL log export to CloudWatch Logs on the cluster.

**Role-level timeouts for the reader:**

```sql
ALTER ROLE app_reader SET statement_timeout = '30s';
ALTER ROLE app_reader SET idle_in_transaction_session_timeout = '60s';
```

**Alarms** (1-minute Maximum, with notification):

- writer `TransactionLogsDiskUsage`, above a threshold set from its normal baseline
- reader `AuroraReplicaLag`, above something like 1000 ms
- writer `OldestReplicationSlotLag`, to catch a stalled consumer early

When an alarm fires, run the §3 SQL on the writer and the §4 SQL on the reader while the spike is happening. Note the `pg_stat_replication_slots` counters before and after.

---

## 9. Fixes, once the cause is confirmed

**CDC consumer**
- Fix or scale the consumer that falls behind (DMS task size, connector settings).
- Drop slots confirmed to be abandoned.
- Set `max_slot_wal_keep_size` as a guardrail, so a stalled consumer can't retain WAL without limit.
- If decoding spills are high, consider raising `logical_decoding_work_mem`, or use streaming of in-progress transactions if the consumer supports it.

**Large transactions:** batch DML into smaller commits and schedule heavy jobs away from peak traffic. This helps both reader lag and CDC.

**Migrations:** use `strong_migrations`, `algorithm: :concurrently` and `lock_timeout`.

**Long reader transactions:** role-level `statement_timeout` and `idle_in_transaction_session_timeout`.

**Stale reads:** enqueue jobs in `after_commit`, and send read-after-write paths to the primary.

**Undersized reader:** match the reader instance class to the writer.

---

## Findings log

| Spike time (UTC) | `TransactionLogsDiskUsage` peak / shape | Reader lag peak | Writer CPU / load | Consumer state | Statement / job running | App symptom | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |
| | | | | | | | |

---

## Appendix: additional SQL

WAL generation rate on the writer, sampled over 60 seconds:

```sql
CREATE TEMP TABLE wal_sample AS SELECT now() ts, pg_current_wal_lsn() lsn;
SELECT pg_sleep(60);
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), lsn)) AS wal_per_min
FROM wal_sample;
```

Replication-related settings on the writer:

```sql
SELECT name, setting, unit FROM pg_settings
WHERE name IN ('rds.logical_replication','logical_decoding_work_mem','max_slot_wal_keep_size',
               'max_replication_slots','max_wal_senders','log_replication_commands');
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

Wait events right now (either instance):

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity WHERE state <> 'idle'
GROUP BY 1,2 ORDER BY 3 DESC;
```

Reader settings that govern how long replay waits behind queries:

```sql
SELECT name, setting, unit FROM pg_settings
WHERE name IN ('max_standby_streaming_delay','hot_standby_feedback',
               'statement_timeout','idle_in_transaction_session_timeout');
```

> **Note:** Column names and functions can vary slightly by Aurora minor version. Run `\df aurora_*` or check the docs for 16.13 if a column errors.
