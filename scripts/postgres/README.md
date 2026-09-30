# PostgreSQL DBA Scripts (16+)

Read-only inventory and troubleshooting queries for PostgreSQL 16 and newer.
Each file holds numbered, self-contained queries; run a whole file or copy one.

```bash
psql -X -d mydb -f scripts/postgres/troubleshooting/08_health_snapshot.sql
psql -X -d mydb -f scripts/postgres/inventory/01_instance_overview.sql
```

## Inventory (`inventory/`)

| File | Covers |
|------|--------|
| `01_instance_overview.sql` | Version, uptime, non-default settings, extensions, tablespaces |
| `02_databases.sql` | Database sizes, encodings, XID age, per-db/role overrides |
| `03_schema_objects.sql` | Object counts, largest tables, missing PKs, partitions, sequences, invalid indexes |
| `04_roles_security.sql` | Roles, PG16 membership options, password types, pg_hba, RLS, SSL |
| `05_replication_backup.sql` | WAL/replication settings, slots, standbys, pub/sub, archiver |

## Troubleshooting (`troubleshooting/`)

| File | Covers |
|------|--------|
| `01_activity_sessions.sql` | Connections, running queries, waits, idle-in-transaction, old xacts |
| `02_locks_blocking.sql` | Blocking chains, root blockers, locks, deadlocks |
| `03_slow_queries.sql` | `pg_stat_statements` top-N by time, I/O, temp, WAL, planning |
| `04_vacuum_bloat.sql` | Dead tuples, autovacuum, wraparound, xmin horizon, bloat estimate |
| `05_indexes.sql` | Unused/duplicate indexes, FKs without indexes, index progress |
| `06_io_cache_wal.sql` | Cache hit ratio, `pg_stat_io`, checkpoints, WAL, temp files |
| `07_replication_health.sql` | Lag, slots, conflicts, logical replication errors |
| `08_health_snapshot.sql` | One-shot pass/warn/crit checklist |

## Notes

- Everything is read-only except commented-out templates (terminate backend, stats reset).
- Some queries need `pg_monitor` (or superuser): `pg_hba_file_rules`, `pg_authid`, `pg_ls_waldir`.
- Queries are written to run on PG 16 as-is. Where PG 17+ differs (checkpointer
  view, slot `inactive_since`, `subfailover`), the newer variant is given in a comment.
- Not yet tested against a live server; please report any query that errors on your version.
