# Aurora PostgreSQL 16.13 – Reader Replica Lag Runbook (Rails)

**Topology:** Ruby on Rails app → PgBouncer → writer; Rails app → RDS Proxy → reader.
**Symptom:** intermittent replica lag or stale reads on the reader.

## How Aurora lag happens

Aurora readers apply the writer's redo to pages already in their buffer cache. Lag comes from one of four things:

1. **Write burst**: the writer produced redo faster than the reader could apply it (bulk DML, data migrations, vacuum, job-queue churn).
2. **Replay blocked**: reader queries conflict with redo (DDL locks, buffer pins, long snapshots).
3. **Reader starved**: CPU, memory or cache pressure, often from an undersized reader.
4. **Not lag at all**: the app reads the replica right after writing. The metric looks fine, but the data is stale.

---

## The short list (best bang for the buck)

| # | Action | Effort | Why |
|---|---|---|---|
| 1 | **Download log files now** if logs aren't exported to CloudWatch (§1) | 10 min | They rotate after 3 days by default |
| 2 | **Review Performance Insights for the incident window** (§1) | 15 min | Only 7 days of retention on the default tier |
| 3 | **Ask whether "lag" is the metric or stale data** (§2) | 1 question | Separates a database problem from a Rails read-routing problem |
| 4 | **Overlay writer `TransactionLogsGeneration` on reader `AuroraReplicaLag`** (§3) | 10 min | The strongest single correlator: tells you whether it's a write burst or a reader-side cause |
| 5 | **Run the incident-timeline Logs Insights query** (§4) | 10 min | Shows DDL, vacuum, conflicts and slow SQL in time order |
| 6 | **Enable Rails query log tags** (§7) | 1 config change + deploy | Ties every query to a controller or job |
| 7 | **Turn on the key logging parameters and log export** (§7) | 15 min, no reboot | So the next incident is fully captured |
| 8 | **Set an `AuroraReplicaLag` alarm** (§7) | 10 min | Catches the next spike live, so you can run the SQL in §5 |

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

Graph these together at 1-minute Maximum:

- **Writer:** `TransactionLogsGeneration`, `WriteIOPS`, `DBLoad`, `MaximumUsedTransactionIDs`
- **Reader:** `AuroraReplicaLag`, `CPUUtilization`, `FreeableMemory`, `BufferCacheHitRatio`
- **RDS Proxy:** `DatabaseConnectionsCurrentlySessionPinned`, `QueryDatabaseResponseLatency`

How to read the graph:

- **Writer redo jumps first and lag follows:** a write burst. Find the job, migration or statement.
- **Redo is flat but lag climbs:** reader-side contention. Look for long reader transactions or resource starvation.
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

Create a CloudWatch alarm on `AuroraReplicaLag` (Maximum, 1 minute, above something like 1000 ms) that notifies you. When it fires, run the §5 SQL while the spike is happening.

---

## 8. Fixes, once the cause is confirmed

- **Undersized reader:** match the reader instance class to the writer.
- **Write bursts:** batch DML into smaller commits and schedule heavy jobs away from peak read traffic.
- **Migrations:** use `strong_migrations`, `algorithm: :concurrently`, and `lock_timeout`.
- **Stale reads:** enqueue jobs in `after_commit` and send read-after-write paths to the primary.
- **Long reader transactions:** role-level `statement_timeout` and `idle_in_transaction_session_timeout`.

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
