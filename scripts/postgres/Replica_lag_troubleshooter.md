# Aurora PostgreSQL 16.13 – Reader Replica Lag Troubleshooting Runbook

**Topology:** one writer (behind PgBouncer), one reader (behind RDS Proxy). The symptom is intermittent replica lag on the reader.

## How Aurora lag happens

Aurora replication isn't PostgreSQL streaming replication. The writer ships redo to the shared storage layer and to each reader. The reader then applies that redo to pages it already holds in its buffer cache. So lag usually comes from one of four things:

- **The writer produced redo faster than the reader could apply it**, for example a bulk load, a big UPDATE or DELETE, or a large vacuum.
- **The reader couldn't apply redo** because its own queries conflicted with it, through locks, buffer pins or snapshot conflicts.
- **The reader was starved of resources**: CPU, memory or cache.
- **Something that isn't lag at all**, such as stale reads caused by pooling or routing.

Because the lag is intermittent, the main job is correlating it with a trigger.

## Contents

1. Questions for your developer and architect
2. If the incident already happened: preserve the evidence
3. Pin down the exact window
4. CloudWatch metrics to watch
5. Performance Insights / Database Insights
6. SQL: writer side
7. SQL: reader side
8. Logging to turn on
9. CloudWatch Logs Insights queries
10. RDS events and deploy history
11. Triage decision path
12. Set a trap for next time
13. Quick wins if the cause is confirmed

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
10. **What was deployed or scheduled around the reported incident?** Get exact deploy and migration timestamps and the job schedule for that day.

---

## 2. If the incident already happened: preserve the evidence

Most evidence from a recent incident still exists, but some of it expires within days. Secure it first.

| Source | Default retention | Action |
|---|---|---|
| PostgreSQL log files on the instance (not exported) | `rds.log_retention_period` = 4320 min (**3 days**) | **Urgent.** Download now. |
| PostgreSQL logs exported to CloudWatch Logs | per log group (often "never expire") | Safe |
| Performance Insights / Database Insights (free or standard tier) | **7 days** | Review and screenshot before it expires |
| CloudWatch metrics at 1-minute granularity | 15 days (then 5-min for 63 days) | Safe for now |
| Enhanced Monitoring (`RDSOSMetrics` log group) | 30 days | Safe |
| RDS events | 14 days | Safe |

If logs aren't exported to CloudWatch, pull the files for **both** instances before they rotate:

```bash
aws rds describe-db-log-files --db-instance-identifier <reader-id> \
  --query 'DescribeDBLogFiles[].[LogFileName,LastWritten,Size]' --output table

aws rds download-db-log-file-portion --db-instance-identifier <reader-id> \
  --log-file-name error/postgresql.log.2026-09-30-14 \
  --starting-token 0 --output text > reader_2026-09-30-14.log
```

Repeat for the writer. Then raise `rds.log_retention_period` to 10080, which is 7 days, and enable PostgreSQL log export to CloudWatch Logs on the cluster.

---

## 3. Pin down the exact window

The reported time is rarely accurate. Find the real spike from the metric, using the **Maximum** statistic at a **1-minute** period. Averages hide short spikes.

```bash
aws cloudwatch get-metric-statistics --namespace AWS/RDS \
  --metric-name AuroraReplicaLag \
  --dimensions Name=DBInstanceIdentifier,Value=<reader-id> \
  --start-time 2026-09-29T00:00:00Z --end-time 2026-10-01T00:00:00Z \
  --period 60 --statistics Maximum --output text | sort -k2 -n | tail -20
```

That gives you the top 20 minutes by lag. Use the **onset** of the spike, not its peak, and set a window of roughly 15 minutes before to 10 minutes after. Use that window for every metric, Performance Insights view and log query below.

---

## 4. CloudWatch metrics to watch

Graph these together at **1-minute Maximum** over the window, or over 1–2 weeks to look for patterns.

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
- Enhanced Monitoring at 1–5 second granularity: OS CPU steal, run queue (`loadAverageMinute`), memory and swap. Section 9 has a query for these.

### On RDS Proxy (reader side)
- `DatabaseConnectionsCurrentlySessionPinned`: pinned sessions can hold transactions open longer.
- `QueryDatabaseResponseLatency`, `ClientConnections`, `DatabaseConnectionRequests`

### Reading the graph
- **Writer redo jumps first and lag follows:** a write burst. Find the statement or job with Performance Insights, `pg_stat_statements` and the log queries.
- **Redo is flat but lag climbs:** reader-side contention, such as replay conflicts or resource starvation.

---

## 5. Performance Insights / Database Insights

Data is kept for 7 days on the default tier. Open **both** instances and zoom to the window.

- **Writer:** look at the Top SQL during the redo spike. That's usually your culprit statement, often a batch UPDATE or DELETE, a `REFRESH`, or DDL.
- **Reader:** look at the top waits.
  - Lock or `BufferPin` waits, or long-running SQL just before the spike, point to reader queries blocking replay.
  - High CPU or IO waits point to resource starvation.

Screenshot or export what you find before it ages out.

---

## 6. SQL: writer side

Per-replica status, which is Aurora-specific. Run it every few seconds during a live incident:

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

Top write-heavy statements. This needs `pg_stat_statements`, and the `wal_bytes` column exists on PG 13 and later. The counters are cumulative, so this also works after the fact:

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

## 7. SQL: reader side

Replay conflicts, cumulative per database. Non-zero `confl_lock`, `confl_snapshot` or `confl_bufferpin` is strong evidence of replay conflicts. The counts can't tell you *when* conflicts happened, so also check `stats_reset` to know how far back they go:

```sql
SELECT datname, confl_tablespace, confl_lock, confl_snapshot,
       confl_bufferpin, confl_deadlock
FROM pg_stat_database_conflicts;

SELECT datname, stats_reset FROM pg_stat_database;
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

## 8. Logging to turn on

Set these in the cluster or instance parameter group. They're dynamic, so no reboot is needed.

| Parameter | Suggested value | Why |
|---|---|---|
| `log_min_duration_statement` | 1000–5000 ms | catch long reader queries |
| `log_lock_waits` | on | lock contention around DDL |
| `log_autovacuum_min_duration` | 0 or 10s | see which tables vacuum, and when |
| `log_statement` | `ddl` | catch migrations and DDL |
| `log_checkpoints` | on | correlates with full-page-image bursts |
| `log_temp_files` | 0 or small | spills on reader |
| `rds.log_retention_period` | 10080 | keep 7 days of log files on the instance |

Also export the PostgreSQL log to CloudWatch Logs for both instances.

---

## 9. CloudWatch Logs Insights queries

Use the log group `/aws/rds/cluster/<cluster>/postgresql` and set the time picker to your window. Query **both** instance log streams together so events interleave in order.

### Start here

**Everything relevant, in chronological order.** This is the single most useful query:

```
fields @timestamp, @logStream, @message
| filter @message like /conflict with recovery|canceling statement|terminating connection|still waiting for|acquired .*Lock|AccessExclusiveLock|automatic (aggressive )?vacuum|statement: (ALTER|CREATE|DROP|TRUNCATE|VACUUM|REINDEX|CLUSTER|REFRESH)|duration: \d{4,}|checkpoint (starting|complete)|FATAL|PANIC/
| sort @timestamp asc
| limit 1000
```

**Volume per minute per instance.** The first minute where counts rise usually identifies the trigger:

```
fields @timestamp, @logStream
| filter @message like /ERROR|FATAL|conflict|canceling|waiting|vacuum|duration:/
| stats count(*) as events by bin(1m), @logStream
| sort @timestamp asc
```

### Focused drill-downs

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

Slow statements by duration. Durations are logged at completion, so subtract each duration from its timestamp to see when the statement started and whether it was running when lag began:

```
fields @timestamp, @logStream, @message
| parse @message /duration: (?<dur_ms>[\d\.]+) ms/
| filter ispresent(dur_ms) and dur_ms > 2000
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

### Enhanced Monitoring (reader OS metrics)

Run this against the `RDSOSMetrics` log group. It gives OS-level detail at second-level granularity:

```
fields @timestamp, cpuUtilization.total, cpuUtilization.steal,
       loadAverageMinute.one, memory.free, memory.cached, swap.in, swap.out
| filter instanceID = "<reader-id>"
| sort @timestamp asc
```

Watch for CPU pinned near 100%, a load average above the vCPU count, or swap activity.

### If you only have downloaded log files

Grep them with the same patterns, roughly as follows (adjust the pattern for any time zone difference in the log prefix):

```bash
grep -E "2026-09-30 14:(2|3)" reader_*.log | grep -Ei "conflict|cancel|waiting|vacuum|duration|statement:|FATAL"
```

---

## 10. RDS events and deploy history

Aurora will restart a reader that falls too far behind, and that shows up as an RDS event, not in the Postgres log. Pull events for both instances; they're retained for 14 days:

```bash
aws rds describe-events --source-identifier <reader-id> \
  --source-type db-instance --duration 10080
```

Look for reader restarts, failovers, maintenance or parameter changes near the spike. Compare against the deploy and migration timestamps and the job schedule from your developer. A migration within minutes of the spike is a very common answer.

---

## 11. Triage decision path

1. **Correlate writer redo with reader lag** (section 4). If they track together, it's a write burst. Identify the statement with Performance Insights on the writer, `pg_stat_statements` `wal_bytes`, and the DDL and vacuum log queries.
2. **If they don't correlate,** check the reader: `pg_stat_database_conflicts`, long transactions, Performance Insights waits, and the conflict and lock-wait log queries. That points to reader queries blocking replay.
3. **Check reader resources:** `CPUUtilization`, `FreeableMemory`, `BufferCacheHitRatio` and Enhanced Monitoring. If the reader is smaller than the writer, that alone can explain spikes under load.
4. **Check RDS events** for reader restarts and line spikes up against deploys and scheduled jobs.
5. **If the app reports stale reads but the metric stays low,** the problem is consistency, not lag. Route read-after-write paths to the writer through PgBouncer.

---

## 12. Set a trap for next time

If logging wasn't verbose enough, you may not find a definitive cause from a past incident. Make sure the next one is captured:

- Apply the logging parameters from section 8 and enable log export.
- Create a CloudWatch alarm on `AuroraReplicaLag` (Maximum, 1 minute, above something like 1000 ms) that notifies you, so the next occurrence is caught while it's still happening. Then run the live queries from sections 6 and 7.
- Optionally, run a small external sampler every 10–15 seconds that writes the output of `aurora_replica_status()` (from the writer) and `pg_stat_activity` (from the reader) to a table or to CloudWatch. That gives you a timeline of what was running on each side when lag starts.

---

## 13. Quick wins if the cause is confirmed

- Match the reader instance class to the writer.
- Batch large DML into smaller commits.
- Use `CREATE INDEX CONCURRENTLY` and lock-timeout-guarded migrations (`SET lock_timeout = '5s'`).
- Set `idle_in_transaction_session_timeout` and `statement_timeout` for reader app roles.
- Schedule heavy jobs away from peak read traffic.
