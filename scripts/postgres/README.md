# Diagnosing performance problems

How to approach performance problems on the production Aurora PostgreSQL cluster
(Aurora 16.13.3, PostgreSQL 16.13): top-down and measured. Separate "what is expensive" from "why",
confirm the why with a plan, change one thing, and verify.

Server-specific findings below were observed on 2026-10-09. Counters (`pg_stat_statements`, `pg_stat_*`)
cover roughly 2026-08-24 onward and describe the **writer instance only**, not the reader.

## The loop

1. **Is it healthy?** Run `health_check.sql` (one query, one row per check).
2. **What is happening right now?**
   - `1_connections_activity.sql`: 1.3 running queries, 1.4 wait events, 1.5 idle-in-transaction.
   - `2_locks_blocking.sql`: 2.1 and 2.2 for blocked sessions and root blockers.
3. **What has been expensive over time?** `3_query_performance.sql`: 3.1b for the `web` role (kept separate
   from maintenance roles such as `root` and `dms`), plus 3.9 and 3.10. The counters span about 45 days, so recent
   regressions are diluted: use the 3.13 snapshot-diff to see what changed lately.
4. **Classify each offender by its signature** (see the four concerns below).
5. **Confirm with a plan.**
   - `EXPLAIN (GENERIC_PLAN)` on a `$1`-style statement copied from `pg_stat_statements` shows the plan shape
     without needing parameter values (PostgreSQL 16+; confirmed on 16.13). It does not execute.
   - `EXPLAIN (ANALYZE, BUFFERS)` with literal values gives real timings. It executes the statement: wrap writes in
     `BEGIN ... ROLLBACK`.
6. **Fix one thing, then verify** with a before/after diff, not the cumulative counters.

## The four concerns

### N+1 queries

- **Signature:** very high call counts, a mean of milliseconds or less, `rows_per_call` of 0 to 1, one recurring code path.
- **Query:** D.1 in `diagnosis_toolkit.sql` lists them with the sqlcommenter `controller` and `source_location`
  extracted from the query text; 3.9 ranks by call count.
- **On this server:** `dosespots` (88M calls), `fitbits` (55M, almost always 0 rows), `other_id_numbers` (18M),
  `call_references` (16M), and the `dietitians_users` join (1.05B) are the candidates. Several are tagged
  `controller='graphql'` (for example `user_type.rb:1504`), which points at GraphQL resolvers loading data per record.
- **Limit:** the database can only nominate candidates. `pg_stat_statements` keeps the text of the first statement
  seen for each query, so the tag shows one example caller, not all of them. Confirm with per-request query counts in
  the app (APM, or the Bullet or prosopite gems in tests) and Performance Insights.
- **Typical fixes:** batch-load or preload associations, skip lookups that almost always return nothing, cache.

### Stale statistics

- **Signature:** estimated rows differ from actual rows by 10x or more in `EXPLAIN ANALYZE`, or plans flip between runs (3.10).
- **Query:** D.2 ranks tables by percent modified since the last `ANALYZE`; 4.2 shows how close each table is to its
  autovacuum and analyze thresholds.
- **On this server:** `form_answers` (about 1.6B rows) was last analyzed on 2026-09-17. The default analyze trigger is 10%
  of the table, about 165M changes at that size, so huge tables rarely auto-analyze. The pg_cron `ANALYZE` jobs help;
  a lower per-table `autovacuum_analyze_scale_factor` on the biggest tables is the more lasting fix. For skewed or
  correlated columns (for example `organization_id` and `parent_organization_id`), `CREATE STATISTICS` or a higher
  statistics target can help.
- If the concern is *stalls* (sessions stuck waiting), use 1.4 (wait events), section 2 (blocking), and turn on `log_lock_waits`.

### Bad plans

- **Signature:** high run-to-run variation (3.10), many blocks read per call (3.3), spills to temp files (3.4), or a
  consistently slow simple lookup with a tiny standard deviation (usually a sequential scan).
- **On this server:** the `appointment_status_chart_notes` view (a `bigint` to `integer` cast prevents index use),
  `foods ... NOT IN (subquery)`, the `cms1500s` pagination sort spill (about 11 TB of temp written), and the
  `cpt_codes_cms1500s` `IN (subquery)` lookup.
- **Hypothesis to test (not a finding):** Rails prepared statements switch to a generic plan after five executions.
  In a multi-tenant database with skew, a generic plan can be wrong for large tenants. Compare a statement under
  `SET plan_cache_mode = force_custom_plan`.
- **Aurora tools (not verified on this cluster):** the parameter list shows `aurora_stat_plans.*` (currently off), and
  `apg_plan_mgmt`, `pg_hint_plan`, `hypopg` and `pg_buffercache` are in the allowed extension list.

### Missing and unused indexes

- **Missing:**
  - 5.3: foreign keys without a supporting index.
  - 5.7: sequential-scan culprits (`table_fraction_per_scan` and `last_seq_scan`).
  - Slow lookups with a tiny standard deviation (3.2, 3.1b), such as `dosespots.dosespot_user_id`.
  - Indexes that exist but cannot be used: expression or cast mismatches and partial-index predicates.
  - Test a candidate with `hypopg` first, then build with `CREATE INDEX CONCURRENTLY`.
- **Unused:** 5.1, 5.1b, 5.9 (big and rarely scanned), 5.2 and 5.2b (duplicate and redundant).
  - Counters are writer-only and since 2026-08-24: check the reader before dropping anything.
  - Several `tmp_`-prefixed indexes are heavily used (billions of scans) while others show zero. Do not drop by name pattern.
  - Wait a full business cycle (month-end jobs), save `pg_get_indexdef()` output, then `DROP INDEX CONCURRENTLY`.

## What to add to the server

1. **Performance Insights.** Turn it on if it is not, and check the retention. It provides a time series of DB load by
   SQL, wait event, user and application, which cumulative `pg_stat_statements` cannot.
2. **Logging parameters.** `log_lock_waits = on` (currently off), `log_temp_files` at something like 100 MB (currently
   -1, disabled), and a `log_min_duration_statement` that fits the log volume. Consider `auto_explain` with sampling if
   the cluster allows it.
3. **A history of your own.** A pg_cron job that snapshots `pg_stat_statements` (queryid, calls, times, blocks) into a
   table every hour and prunes after about two weeks. That makes "what changed on Tuesday" answerable.
4. **Keep `pg_stat_statements` complete.** It was at 48,225 of 50,000 entries and evicting (45 deallocations).
   Variable-length `IN` lists and multi-row inserts (for example `available_slots`) create thousands of near-duplicate
   entries; fixing those keeps the rankings trustworthy.

## Guardrails

- Counters are per instance: on Aurora, the writer's numbers exclude the reader. Check readers separately.
- `EXPLAIN ANALYZE` runs the statement. Wrap writes in `BEGIN ... ROLLBACK`.
- Change one thing at a time and keep a short ledger (what changed, when, the before and after numbers).
- Query files were tested for syntax and type errors against a local PostgreSQL 16.13, not against Aurora.
  Aurora-specific behaviour (`aurora_*` functions, `pg_stat_io`, replication views) was only partly verified.

## Query files referenced

| File | Contents |
|------|----------|
| `health_check.sql` | One-shot checklist, one row per check, plus an Aurora reader add-on |
| `0_instance_overview.sql` | Version, settings, extensions, sizes, sequences close to exhaustion |
| `1_connections_activity.sql` | Connections, running queries, waits, idle-in-transaction, oldest transactions |
| `2_locks_blocking.sql` | Blocked sessions, root blockers, blocking tree, locks, advisory locks |
| `3_query_performance.sql` | `pg_stat_statements` rankings, temp spill, WAL, snapshot-diff |
| `4_vacuum_bloat.sql` | Dead tuples, autovacuum progress, wraparound, xmin holders, bloat estimate |
| `5_index_health.sql` | Unused, duplicate, missing and invalid indexes, FK coverage |
| `6_io_cache_wal.sql` | Cache hit ratios, `pg_stat_io`, checkpoints, WAL (limited on Aurora) |
| `database_inventory.sql` | Databases, roles settings, publications and slots |
| `roles_security.sql` | Roles, privileges, RLS, security definer functions |
| `replication_ha.sql` | Slots, publications, replica identity, Aurora cluster members |
| `diagnosis_toolkit.sql` | N+1 candidates (D.1), stale statistics (D.2), `GENERIC_PLAN` usage (D.3) |
