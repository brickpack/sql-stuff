# Aurora PostgreSQL 16.13: Is it the Database or the Application?

**Topology:** Rails app → PgBouncer → writer; Rails app → RDS Proxy → reader. A logical replication (CDC) consumer also reads from the writer.
**Symptom:** intermittent problems reported by the app team, described as replica lag.
**Current lead:** writer `TransactionLogsDiskUsage` spikes at exactly the times of the app team's reports. That metric only has values when logical replication or DMS is in use, so a CDC consumer is involved (Part 3).

---

## Start here

1. **Pin down the symptom.** Get the exact symptom, timestamps, and the endpoints or jobs affected (Part 1).
2. **Compare the three clocks:** the app's time, the pooler's wait, and the database's execution time. This answers "database or application" for slowness (Part 1).
3. **Run the heartbeat test.** This answers "database or application" for stale data (Part 1).
4. **Identify the CDC consumer and run the slot queries** (Part 3). Given the lead, do this in parallel with steps 1–3.
5. **Follow the verdict** to Part 2 (database), Part 3 (CDC pipeline) or Part 4 (application).
6. **Instrument for the next occurrence** (Part 5). With an intermittent problem, the next incident is your best evidence.

---

## Part 1: Is it the database or the application?

### 1.1 Pin down the symptom

Vague reports such as "the replica is lagging" can't be tested. Get answers to these from the app team:

1. **What exactly did users or jobs experience?** Slow responses, errors (with the exact exception class and message), or stale or missing data?
2. **Exact timestamps,** with time zone, and how they were obtained: an alert, an APM trace, a user report?
3. **Which endpoints, jobs or services were affected?** Were they reading through the reader (RDS Proxy), the writer (PgBouncer), or neither?
4. **If the data was stale, where was it seen?** In the Rails app itself, or in a downstream system such as a search index, cache, data warehouse or another service fed by CDC?
5. **What deployed or ran on a schedule around those times?** Migrations, Rake tasks, cron jobs.

Question 4 matters most given the current lead. If the stale data was seen in a system fed by the CDC consumer, the "lag" is **CDC pipeline lag**, not Aurora replica lag, and the database reader may be fine.

### 1.2 Slowness: compare the three clocks

Every slow database call can be split into three parts. Measure each one for the same time window, and the gap between them shows where the time went.

| Clock | What it measures | Where to read it |
|---|---|---|
| **App** | Total request or job time, and the time Rails spent in SQL | Rails log line `Completed 200 OK in 812ms (Views: … \| ActiveRecord: 790ms)`; APM traces (Datadog, New Relic, Scout, Skylight) |
| **Pooler** | Time waiting for a server connection | PgBouncer `SHOW POOLS` / `SHOW STATS` (writer path); RDS Proxy `DatabaseConnectionsBorrowLatency` (reader path); ActiveRecord pool stats |
| **Database** | Time the query actually executed | `log_min_duration_statement` durations, `pg_stat_statements`, Performance Insights Top SQL and `DBLoad` |

**PgBouncer** (connect to its admin console, usually the `pgbouncer` database):

```sql
SHOW POOLS;   -- cl_waiting > 0 or a high maxwait means clients were queued for a server connection
SHOW STATS;   -- avg_wait_time (microseconds): average time clients waited for a server
```

**ActiveRecord connection pool** (from a Rails console or a periodic log line):

```ruby
ActiveRecord::Base.connection_pool.stat
# => { size: 10, connections: 10, busy: 10, dead: 0, idle: 0, waiting: 4, checkout_timeout: 5.0 }
```

`waiting > 0` or errors like `ActiveRecord::ConnectionTimeoutError` mean the app's own pool is exhausted. That's an application or configuration problem, not the database.

Reading the clocks:

- **App time is high, ActiveRecord time is low:** **application.** The time went into Ruby: CPU, GC, rendering, external HTTP calls, or Puma thread saturation.
- **ActiveRecord time is high, database execution time is also high:** **database.** Go to Part 2.
- **ActiveRecord time is high, database execution time is low:** **in between.** Queueing in PgBouncer, RDS Proxy or the ActiveRecord pool, or network. Check the pooler clock.

### 1.3 Stale data: the heartbeat test

`AuroraReplicaLag` is measured inside Aurora. A heartbeat measures the lag the app actually sees, through the same path the app uses.

On the **writer**, create a one-row table and update it every second. This uses `pg_cron`; a Sidekiq job or external script also works:

```sql
CREATE TABLE ops_heartbeat (id int PRIMARY KEY, ts timestamptz NOT NULL);
INSERT INTO ops_heartbeat VALUES (1, clock_timestamp());

SELECT cron.schedule('ops-heartbeat', '1 seconds',
  $$UPDATE ops_heartbeat SET ts = clock_timestamp() WHERE id = 1$$);
```

On the **reader, through RDS Proxy**, run this, or have the app log it every 10–30 seconds:

```sql
SELECT now() - ts AS observed_lag FROM ops_heartbeat;
```

Reading the heartbeat:

- **Users see stale data, but the heartbeat lag is under about 1 second:** **application.** Look at read routing, caching (Rails cache, Redis, CDN), or job timing (Part 4).
- **Heartbeat lag and `AuroraReplicaLag` are both high:** **database replica lag.** Go to Part 2.
- **Heartbeat lag is high but `AuroraReplicaLag` is low:** the reader's connection path. Check RDS Proxy pinning and long transactions.

If the CDC publication includes all tables, this heartbeat also flows through the CDC pipeline. That lets you measure CDC lag end to end at the destination, too.

### 1.4 Error messages that point to a side

| Error in the app | Points to |
|---|---|
| `ActiveRecord::ConnectionTimeoutError` ("could not obtain a connection from the pool") | App pool exhausted: application or configuration |
| `PG::TRSerializationFailure` / `ActiveRecord::SerializationFailure` with "conflict with recovery" | A reader query blocked replay and was canceled: database, caused by long reader queries |
| `PG::QueryCanceled` ("canceling statement due to statement timeout") | A slow query hit `statement_timeout`: database query or plan |
| `PG::ConnectionBad` or connection resets | Pooler, proxy, failover or a reader restart. Check RDS events. |
| `ActiveRecord::RecordNotFound` right after a create | Read-after-write against the replica: application routing |

### 1.5 Verdict matrix

| What you observe | Verdict | Go to |
|---|---|---|
| Slow, ActiveRecord time low | Application | Part 4 |
| Slow, database execution time high | Database | Part 2 |
| Slow, database time low but pooler wait high | Pooling or configuration | Part 4 |
| Stale in Rails, heartbeat lag low | Application (routing, caching, jobs) | Part 4 |
| Stale in Rails, heartbeat and `AuroraReplicaLag` high | Database replica lag | Part 2 |
| Stale in a downstream system, `TransactionLogsDiskUsage` rising | CDC pipeline lag | Part 3 |
| "conflict with recovery" errors | Database, caused by app reader queries | Parts 2 and 4 |

---

## Part 2: If it's the database

### 2.1 How Aurora replica lag happens

Aurora readers apply the writer's redo to pages already in their buffer cache. Lag comes from:

1. **Write bursts:** bulk DML, data migrations, vacuum, job-queue churn.
2. **Blocked replay:** reader queries conflict with redo through DDL locks, buffer pins or long snapshots.
3. **A starved reader:** CPU, memory or cache pressure, often from an undersized reader.

### 2.2 Evidence retention

| Source | Default retention |
|---|---|
| PostgreSQL log files on the instance (not exported) | 3 days |
| Performance Insights / Database Insights | 7 days |
| CloudWatch metrics (1-minute) | 15 days |
| Enhanced Monitoring (`RDSOSMetrics`) | 30 days |
| RDS events | 14 days |

Older incidents may already be past some of these limits. Part 5 fixes retention for the next one.

### 2.3 Find the window

Find the real spike using **Maximum** at a **1-minute** period. Averages hide short spikes.

```bash
aws cloudwatch get-metric-statistics --namespace AWS/RDS \
  --metric-name AuroraReplicaLag \
  --dimensions Name=DBInstanceIdentifier,Value=<reader-id> \
  --start-time 2026-09-29T00:00:00Z --end-time 2026-10-01T00:00:00Z \
  --period 60 --statistics Maximum --output text | sort -k2 -n | tail -20
```

Use the onset of the spike, and a window of roughly 15 minutes before to 10 minutes after.

### 2.4 Metrics

Graph these at **1-minute Maximum** unless noted.

**Writer: was there a burst of writes or CDC activity?**

| Metric | What it tells you |
|---|---|
| `WriteIOPS` | Aurora storage write records per second, roughly the redo records generated. Aurora's redo-rate metric. |
| `WriteThroughput` | Bytes per second written to storage. Big rows and TOAST show up here. |
| `TransactionLogsDiskUsage` | WAL held for logical replication. **Current lead.** See Part 3. |
| `OldestReplicationSlotLag` | Bytes of WAL the most-lagging slot consumer is behind. |
| `CommitLatency` | Commit time. Rises under write pressure. |
| `DBLoad`, `DBLoadCPU`, `DBLoadNonCPU` | Active sessions. |
| `CPUUtilization`, `FreeLocalStorage` | Writer CPU; local storage consumed by retained WAL or decoding spills. |

**Reader: was replay blocked, or was the instance starved?**

| Metric | What it tells you |
|---|---|
| `AuroraReplicaLag` | Lag on this reader. |
| `EngineUptime` | Resets on restart. A reset at the spike means Aurora restarted the lagging reader. |
| `CPUUtilization`, `DBLoad` | Reader saturation. |
| `FreeableMemory`, `BufferCacheHitRatio`, `ReadIOPS` | Memory pressure and cache misses. |
| `FreeLocalStorage` | Temp-file spills from big sorts or hashes. |

**RDS Proxy (reader).** Use dimensions `ProxyName`, `TargetGroup`, `TargetRole = READ_ONLY`, and the Sum statistic unless noted.

| Metric | What it tells you |
|---|---|
| `DatabaseConnectionsCurrentlyInTransaction` | Open transactions. A climb before a lag spike points to long reader transactions. |
| `DatabaseConnectionsBorrowLatency` (Average) | Pooler wait: the middle clock from §1.2. |
| `DatabaseConnectionsCurrentlySessionPinned` | Expect this to be high with Rails, which issues `SET` commands on connect. |

> RDS Proxy's `QueryDatabaseResponseLatency`, `QueryResponseLatency` and `QueryRequests` exclude PostgreSQL traffic that uses the extended query protocol, which Rails uses heavily. Don't rely on them. `TransactionLogsGeneration` is an RDS for PostgreSQL metric that Aurora doesn't publish.

**Performance Insights counters** (1-minute, 7-day retention). Add them to the instance dashboard or pull them with `aws pi get-resource-metrics`.

| Counter | Instance | What it tells you |
|---|---|---|
| `db.Transactions.oldest_reader_feedback_xid_age` | Writer | Age of the oldest long transaction on the reader. The most direct sign of blocked replay. |
| `db.SQL.tup_updated`, `tup_inserted`, `tup_deleted` | Writer | Rows changed per second: the shape of a write burst. |
| `db.Transactions.oldest_active_logical_replication_slot_xid_age`, `oldest_inactive_logical_replication_slot_xid_age` | Writer | Stalled or abandoned CDC slots. |
| `db.state.idle_in_transaction_max_time` | Reader | Longest session holding a transaction open while doing nothing. |

```bash
aws pi get-resource-metrics --service-type RDS \
  --identifier <writer-DbiResourceId> \
  --start-time 2026-09-30T14:00:00Z --end-time 2026-09-30T15:00:00Z \
  --period-in-seconds 60 \
  --metric-queries '[{"Metric":"db.SQL.tup_updated.avg"},
                     {"Metric":"db.Transactions.oldest_reader_feedback_xid_age.max"},
                     {"Metric":"db.Transactions.oldest_active_logical_replication_slot_xid_age.max"}]'
```

The identifier is the instance's `DbiResourceId` (starts with `db-`). Run `aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,DbiResourceId]'` to find it.

**Reading the graph:**

- **Writer `WriteIOPS` and `tup_*` jump first, lag follows:** write burst.
- **`TransactionLogsDiskUsage` or `OldestReplicationSlotLag` rises with the app's problems:** CDC involvement. Go to Part 3.
- **Writer flat, `oldest_reader_feedback_xid_age` or proxy `DatabaseConnectionsCurrentlyInTransaction` climbing:** long reader transactions blocking replay.
- **Writer flat, reader CPU or memory spiking:** starved reader.
- **Reader `EngineUptime` resets:** Aurora restarted it. Confirm in RDS events:

```bash
aws rds describe-events --source-identifier <reader-id> \
  --source-type db-instance --duration 10080
```

### 2.5 CloudWatch Logs Insights

Use the log group `/aws/rds/cluster/<cluster>/postgresql`. Set the time picker to the window and query **both** instance log streams.

**Incident timeline.** Start here:

```
fields @timestamp, @logStream, @message
| filter @message like /conflict with recovery|canceling statement|terminating connection|still waiting for|acquired .*Lock|AccessExclusiveLock|automatic (aggressive )?vacuum|statement: (ALTER|CREATE|DROP|TRUNCATE|VACUUM|REINDEX|CLUSTER|REFRESH)|duration: \d{4,}|checkpoint (starting|complete)|logical decoding|replication slot|walsender|could not send data|FATAL|PANIC/
| sort @timestamp asc
| limit 1000
```

**Volume per minute per instance.** The first minute where counts rise usually identifies the trigger:

```
fields @timestamp, @logStream
| filter @message like /ERROR|FATAL|conflict|canceling|waiting|vacuum|duration:|walsender/
| stats count(*) as events by bin(1m), @logStream
| sort @timestamp asc
```

**Slow SQL by Rails job or controller.** This needs query log tags (Part 5):

```
fields @timestamp, @logStream, @message
| parse @message /duration: (?<dur_ms>[\d\.]+) ms/
| parse @message /job='(?<job>[^']+)'/
| parse @message /controller='(?<ctrl>[^']+)'/
| filter ispresent(dur_ms)
| stats count(*) as n, max(dur_ms) as max_ms by job, ctrl, @logStream
| sort max_ms desc
```

Durations are logged at completion, so subtract each duration from its timestamp to see whether the statement was running when the problem began.

**Reader OS pressure** (`RDSOSMetrics` log group):

```
fields @timestamp, cpuUtilization.total, cpuUtilization.steal,
       loadAverageMinute.one, memory.free, swap.in, swap.out
| filter instanceID = "<reader-id>"
| sort @timestamp asc
```

### 2.6 Key SQL

**Writer.** Per-replica status, which is Aurora-specific. Run it repeatedly during a live spike:

```sql
SELECT server_id, replica_lag_in_msec, cur_replay_latency_in_usec,
       log_stream_speed_in_kib_per_second, feedback_xmin,
       pending_read_ios, cpu, last_transport_error, last_update_timestamp
FROM aurora_replica_status()
ORDER BY server_id;
```

**Writer.** Top redo producers. The counters are cumulative, so this works after the fact:

```sql
SELECT queryid, calls, pg_size_pretty(wal_bytes) wal, wal_fpi, rows,
       round(total_exec_time::numeric,0) total_ms, left(query,120) q
FROM pg_stat_statements
ORDER BY wal_bytes DESC
LIMIT 20;
```

**Writer.** Sessions holding or waiting on ACCESS EXCLUSIVE locks, usually migrations:

```sql
SELECT l.pid, l.relation::regclass, l.mode, l.granted,
       a.state, now() - a.query_start dur, left(a.query,120)
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE l.mode = 'AccessExclusiveLock';
```

**Reader.** Replay conflicts. Non-zero `confl_lock`, `confl_snapshot` or `confl_bufferpin` confirms that reader queries are blocking replay:

```sql
SELECT d.datname, c.confl_lock, c.confl_snapshot, c.confl_bufferpin,
       c.confl_deadlock, d.stats_reset
FROM pg_stat_database_conflicts c JOIN pg_stat_database d USING (datid);
```

**Reader.** Long transactions, attributed to Rails jobs and controllers through query log tags:

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

---

## Part 3: The CDC pipeline (current lead)

A real value in `TransactionLogsDiskUsage` means something consumes changes from the writer through a logical replication slot. The metric rises when a slot holds WAL that its consumer hasn't confirmed yet.

### 3.1 First, which side is it?

- **If the app team's stale data is in a system fed by CDC** (search index, cache, warehouse, another service), the problem is CDC pipeline lag. Aurora replica lag may be irrelevant. Focus on the consumer.
- **If the stale data or slowness is in the Rails app itself**, the CDC spike is most likely a timestamp for the real trigger: a large write burst that also drives reader lag and writer load.

### 3.2 Three likely explanations

1. **A large transaction is being decoded.** Logical decoding can't send a transaction until it commits, so WAL piles up until a big batch or migration commits. The same burst can cause reader lag and app slowness.
2. **The consumer fell behind or disconnected.** DMS, Debezium, a zero-ETL integration or a logical subscriber slows down or restarts, and WAL is retained until it catches up. The catch-up adds CPU and IO load on the writer.
3. **Decoding spills to disk.** Transactions larger than `logical_decoding_work_mem` are spilled to local files, adding writer IO and CPU load.

| Shape of `TransactionLogsDiskUsage` | Likely explanation |
|---|---|
| Sharp spike that drains quickly | A big transaction (explanation 1 or 3) |
| Sawtooth | The consumer works in batches or keeps reconnecting |
| Steady climb | The consumer is stopped or disconnected (explanation 2) |

### 3.3 Questions for the team

1. What consumes logical replication: DMS, Debezium/Kafka, zero-ETL, a logical subscriber?
2. Did that consumer restart, error or fall behind at the spike times? Check DMS task logs, Kafka Connect logs, or the integration's status page.
3. Could any replication slot be abandoned, for example from an old migration?

### 3.4 Consumer-side metrics

- **DMS** (`AWS/DMS`, per task): `CDCLatencySource`, `CDCLatencyTarget`, `CDCIncomingChanges`.
  - High source latency means the task is slow to read from Aurora.
  - High target latency means it's slow to write to the destination.
- **Debezium / Kafka Connect:** connector lag, the source-lag metric, and consumer-group lag on the topics.

### 3.5 SQL on the writer

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

Whether decoding spills large transactions to disk. The counters are cumulative, so look for non-zero and growing `spill_*` values:

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

> **Caution:** Don't drop a replication slot until you know who owns it. Dropping it breaks that consumer's change stream, and the consumer usually needs a full resync afterwards. If a slot is truly abandoned (`active = false` and nobody claims it), dropping it is the fix.

---

## Part 4: If it's the application (Rails)

### 4.1 Questions for the developers

1. Is Rails multi-database role switching used (`connects_to`, `connected_to(role: :reading)`)? What's the `DatabaseSelector` `delay`?
2. Are jobs enqueued in `after_commit`, or in `after_save` and `after_create`? Do jobs read from the replica?
3. What caching sits in front of reads: Rails cache, Redis, a CDN, HTTP caching?
4. What are the ActiveRecord pool size, Puma threads and Sidekiq concurrency? Do they fit within PgBouncer and RDS Proxy limits?
5. Is `prepared_statements: false` set for the PgBouncer connection?
6. Do you use `strong_migrations`, with `algorithm: :concurrently` for indexes?

### 4.2 Causes, by symptom

**Stale data with low heartbeat lag**
- **Jobs enqueued in `after_save` or `after_create`** run before the transaction commits, or read the replica milliseconds later. Fix: enqueue in `after_commit`, and have jobs that act on fresh writes read from the primary.
- **`DatabaseSelector` only protects web requests** for its `delay` window (2 seconds by default). Jobs, other processes and clients without the session cookie get no protection.
- **Caching:** a cached value outlives the write. Check cache keys and expiry on the affected screens.

**Slowness with low database time**
- **Pool exhaustion:** the ActiveRecord pool is smaller than the Puma or Sidekiq threads using it, or PgBouncer `default_pool_size` is too small for peak load.
- **Ruby-side time:** GC, CPU, rendering, or external HTTP calls inside requests or jobs.

**App behavior that causes real database lag**
- **Write bursts:** data migrations and Rake tasks using `update_all`, `delete_all`, `insert_all` or large `in_batches` runs; `touch: true` chains; `counter_cache` on hot rows; Postgres-backed job queues (GoodJob, Que, Solid Queue). Big transactions also hit CDC (Part 3).
- **Blocking migrations:** `add_index` without `algorithm: :concurrently`, `change_column`, and new foreign keys or constraints take ACCESS EXCLUSIVE locks. Rails wraps migrations in a transaction, so the locks are held longer.
- **Long reader transactions:** reports, exports, `find_each` loops, or `transaction do` blocks that make HTTP calls. These block replay on the reader.

**Connection-layer gotchas**
- **PgBouncer in transaction mode** needs `prepared_statements: false`, unless you're on PgBouncer 1.21 or later with `max_prepared_statements` set. Advisory locks and `LISTEN/NOTIFY` don't work reliably through it.
- **RDS Proxy pins sessions** because Rails issues `SET` commands on every new connection. Pinning isn't a lag cause by itself, but long transactions keep their connections open.
- **Put timeouts on the database role, not in `database.yml` `variables:`.** Through the poolers they're either lost or add more pinning.

---

## Part 5: Instrument for the next occurrence

**1. Heartbeat (§1.3).** Log the reader's observed lag from the app every 10–30 seconds. This settles "database or application" for stale data the next time it happens.

**2. Rails query log tags.** Ties every query to a controller or job:

```ruby
# config/application.rb  (Rails 7+; use the marginalia gem on older versions)
config.active_record.query_log_tags_enabled = true
config.active_record.query_log_tags = [:application, :controller, :action, :job]
config.active_record.query_log_tags_format = :sqlcommenter
```

Also set a distinct `application_name` per process type (web, sidekiq, rake) in `database.yml`.

**3. Pool and pooler metrics.** Log `ActiveRecord::Base.connection_pool.stat` periodically. Scrape PgBouncer `SHOW POOLS` and `SHOW STATS`, for example with a Prometheus exporter or a small script that ships them to CloudWatch.

**4. Database parameters** (dynamic, no reboot):

| Parameter | Value | Why |
|---|---|---|
| `log_min_duration_statement` | 1000–5000 ms | long queries |
| `log_lock_waits` | on | lock contention around migrations |
| `log_autovacuum_min_duration` | 10s | which tables vacuum, and when |
| `log_statement` | `ddl` | migrations |
| `log_checkpoints` | on | full-page-write bursts |
| `rds.log_retention_period` | 10080 | 7 days of log files on the instance |

Also enable PostgreSQL log export to CloudWatch Logs on the cluster.

**5. Reader role timeouts:**

```sql
ALTER ROLE app_reader SET statement_timeout = '30s';
ALTER ROLE app_reader SET idle_in_transaction_session_timeout = '60s';
```

**6. Alarms** that notify you, so you can run the Part 2 and Part 3 SQL while the problem is live:

- `AuroraReplicaLag` on the reader: Maximum, 1 minute, above about 1000 ms.
- `TransactionLogsDiskUsage` on the writer: Maximum, 1 minute, above its normal baseline.
- `OldestReplicationSlotLag` on the writer, to catch a stalled consumer early.
- Heartbeat lag, if you publish it as a custom metric.

---

## Part 6: Fixes, once the cause is confirmed

| Cause | Fix |
|---|---|
| Undersized reader | Match the reader instance class to the writer |
| Write bursts | Smaller batched commits; schedule heavy jobs away from peak traffic |
| Blocking migrations | `strong_migrations`, `algorithm: :concurrently`, `lock_timeout` |
| Long reader transactions | Role-level `statement_timeout` and `idle_in_transaction_session_timeout` |
| Stale reads in Rails | Enqueue in `after_commit`; send read-after-write paths to the primary; review cache expiry |
| Pool exhaustion | Align the ActiveRecord pool with threads; size PgBouncer and RDS Proxy pools for peak |
| CDC consumer lag | Fix or scale the consumer; drop slots confirmed to be abandoned; set `max_slot_wal_keep_size` as a guardrail; raise `logical_decoding_work_mem` or enable streaming of in-progress transactions if spills are high |

---

## Appendix: additional SQL

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

> **Note:** Column names and functions can vary slightly by Aurora minor version. Run `\df aurora_*` or check the docs for 16.13 if a column errors. `pg_cron` must be listed in `shared_preload_libraries` and created with `CREATE EXTENSION pg_cron` before the heartbeat schedule will work.
