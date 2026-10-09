-- Index health. Requires PG 16+.  (idx_scan counters reset with stats reset;
-- PG16 adds last_idx_scan - use it to confirm "unused".)
-- Counters are per instance: an index unused on the primary may still serve a read replica.

-- 5.1 Unused indexes (not backing a constraint), largest first
SELECT s.schemaname, s.relname AS "table", s.indexrelname AS "index",
       s.idx_scan, s.last_idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       pg_size_pretty(pg_relation_size(s.relid)) AS table_size,
       pg_get_indexdef(s.indexrelid) AS definition
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique
  AND NOT i.indisprimary
  AND NOT i.indisexclusion
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 30;

-- 5.1b Rarely used: scanned before, but not in the last 30 days
SELECT s.schemaname, s.relname AS "table", s.indexrelname AS "index",
       s.idx_scan, s.last_idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan > 0
  AND s.last_idx_scan < now() - interval '30 days'
  AND NOT i.indisunique
  AND NOT i.indisprimary
  AND NOT i.indisexclusion
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = s.indexrelid)
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 30;

-- 5.2 Duplicate indexes (same table, access method, columns, opclasses, sort order, expressions, predicate)
SELECT indrelid::regclass AS "table",
       pg_size_pretty(sum(pg_relation_size(idx))::bigint) AS group_size,
       pg_size_pretty((sum(pg_relation_size(idx)) - min(pg_relation_size(idx)))::bigint) AS reclaimable,
       array_agg(idx::regclass ORDER BY pg_relation_size(idx) DESC) AS indexes,
       bool_or(is_unique) AS has_unique_or_pk
FROM (
  SELECT i.indexrelid AS idx, i.indrelid, c.relam,
         i.indkey::text AS key_cols, i.indclass::text AS opclasses,
         i.indoption::text AS sort_opts, i.indcollation::text AS collations,
         coalesce(i.indexprs::text, '') || '|' || coalesce(i.indpred::text, '') AS expr,
         (i.indisunique OR i.indisprimary) AS is_unique
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
) x
GROUP BY indrelid, relam, key_cols, opclasses, sort_opts, collations, expr
HAVING count(*) > 1
ORDER BY sum(pg_relation_size(idx)) DESC;

-- 5.2b Redundant by prefix: btree index whose key columns are the leading columns of another index
-- (e.g. (a) when (a, b) exists). Usually safe to drop; check idx_scan first.
SELECT i1.indrelid::regclass AS "table",
       i1.indexrelid::regclass AS redundant_index,
       i2.indexrelid::regclass AS covered_by,
       pg_size_pretty(pg_relation_size(i1.indexrelid)) AS size,
       s.idx_scan
FROM pg_index i1
JOIN pg_class c1 ON c1.oid = i1.indexrelid
JOIN pg_index i2 ON i2.indrelid = i1.indrelid AND i2.indexrelid <> i1.indexrelid
JOIN pg_class c2 ON c2.oid = i2.indexrelid AND c2.relam = c1.relam
LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i1.indexrelid
WHERE c1.relam = (SELECT oid FROM pg_am WHERE amname = 'btree')
  AND i1.indisvalid AND i2.indisvalid
  AND NOT i1.indisunique AND NOT i1.indisprimary AND NOT i1.indisexclusion
  AND i1.indpred IS NULL AND i2.indpred IS NULL
  AND i1.indexprs IS NULL AND i2.indexprs IS NULL
  AND i1.indnkeyatts < i2.indnkeyatts
  AND (string_to_array(i1.indkey::text, ' '))[1:i1.indnkeyatts]
    = (string_to_array(i2.indkey::text, ' '))[1:i1.indnkeyatts]
  AND (string_to_array(i1.indclass::text, ' '))[1:i1.indnkeyatts]
    = (string_to_array(i2.indclass::text, ' '))[1:i1.indnkeyatts]
  AND (string_to_array(i1.indoption::text, ' '))[1:i1.indnkeyatts]
    = (string_to_array(i2.indoption::text, ' '))[1:i1.indnkeyatts]
  AND (string_to_array(i1.indcollation::text, ' '))[1:i1.indnkeyatts]
    = (string_to_array(i2.indcollation::text, ' '))[1:i1.indnkeyatts]
ORDER BY pg_relation_size(i1.indexrelid) DESC;

-- 5.3 Foreign keys without a supporting index (slow deletes/joins, lock-heavy)
-- An FK is supported if some valid, non-partial index has the FK columns as its leading key columns.
SELECT c.conrelid::regclass AS "table", c.conname AS fk,
       c.confrelid::regclass AS references_table,
       pg_size_pretty(pg_total_relation_size(c.conrelid)) AS table_size,
       f.cols AS fk_columns,
       format('CREATE INDEX CONCURRENTLY ON %s (%s);', c.conrelid::regclass, f.cols) AS suggested_ddl
FROM pg_constraint c
CROSS JOIN LATERAL (
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord) AS cols
  FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
) f
WHERE c.contype = 'f'
  AND c.conparentid = 0
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND i.indisvalid
      AND i.indpred IS NULL
      AND i.indnkeyatts >= cardinality(c.conkey)
      AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] @> c.conkey
  )
ORDER BY pg_total_relation_size(c.conrelid) DESC;

-- 5.4 Index vs. sequential scan ratio on user tables
SELECT schemaname, relname, seq_scan, last_seq_scan, idx_scan,
       round(100.0 * COALESCE(idx_scan, 0) / NULLIF(seq_scan + COALESCE(idx_scan, 0), 0), 1) AS idx_pct,
       n_live_tup, pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables
WHERE n_live_tup > 10000
ORDER BY seq_scan DESC
LIMIT 25;

-- 5.5 Index size vs table size (over-indexing)
SELECT n.nspname AS schema, c.relname AS "table",
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       round(pg_indexes_size(c.oid)::numeric / NULLIF(pg_relation_size(c.oid), 0), 2) AS index_to_heap_ratio,
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid) AS index_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_indexes_size(c.oid) DESC
LIMIT 25;

-- 5.6 Index build/reindex progress
SELECT p.pid, p.command, p.datname,
       CASE WHEN p.datname = current_database() THEN p.relid::regclass::text END AS "table",
       CASE WHEN p.datname = current_database() THEN p.index_relid::regclass::text END AS "index",
       p.phase,
       p.lockers_done || '/' || p.lockers_total AS lockers,
       p.current_locker_pid,
       round(100.0 * p.blocks_done / NULLIF(p.blocks_total, 0), 1) AS pct_blocks,
       round(100.0 * p.tuples_done / NULLIF(p.tuples_total, 0), 1) AS pct_tuples,
       p.partitions_done || '/' || p.partitions_total AS partitions,
       now() - a.xact_start AS running_for,
       left(a.query, 100) AS query
FROM pg_stat_progress_create_index p
LEFT JOIN pg_stat_activity a USING (pid)
ORDER BY running_for DESC NULLS LAST;

-- 5.7 Missing-index candidates: tables whose sequential scans read the most tuples
-- table_fraction_per_scan near 1 = each scan reads the whole table; > 1 means dead or since-deleted rows.
-- Small tables are excluded (a seq scan is the right plan there). last_seq_scan shows if it is still happening.
SELECT schemaname, relname AS table_name,
       seq_scan, last_seq_scan, seq_tup_read,
       seq_tup_read / NULLIF(seq_scan, 0) AS avg_rows_per_seq_scan,
       round(seq_tup_read::numeric / NULLIF(seq_scan, 0) / NULLIF(n_live_tup, 0), 2) AS table_fraction_per_scan,
       idx_scan, n_live_tup,
       pg_size_pretty(pg_relation_size(relid)) AS size
FROM pg_stat_user_tables
WHERE seq_scan > 0
  AND (n_live_tup > 10000 OR pg_relation_size(relid) > 10 * 1024 * 1024)
ORDER BY seq_tup_read DESC
LIMIT 20;

-- 5.8 Invalid or not-ready indexes (failed CREATE INDEX CONCURRENTLY leaves these behind)
-- An index being built right now also shows up here; check 5.6 first.
-- Fix: DROP INDEX CONCURRENTLY <name>; then retry the build.
:regclass AS "table",
       i.indisvalid, i.indisready, i.indislive,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
       pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i
WHERE NOT i.indisvalid OR NOT i.indisready
ORDER BY pg_relation_size(i.indexrelid) DESC;

-- 5.9 Biggest indexes: size vs use vs table write churn (big + rarely scanned + heavily written = costly)
SELECT s.schemaname, s.relname AS "table", s.indexrelname AS "index",
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       s.idx_scan, s.last_idx_scan,
       t.n_tup_ins + t.n_tup_upd + t.n_tup_del AS table_writes,
       round((t.n_tup_ins + t.n_tup_upd + t.n_tup_del)::numeric / NULLIF(s.idx_scan, 0), 1) AS writes_per_scan
FROM pg_stat_user_indexes s
JOIN pg_stat_user_tables t ON t.relid = s.relid
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 25;

-- 5.10 Non-selective indexes: many tuples read per scan (range scans can be legitimate; check the queries)
SELECT s.schemaname, s.relname AS "table", s.indexrelname AS "index",
       s.idx_scan, s.idx_tup_read,
       s.idx_tup_read / NULLIF(s.idx_scan, 0) AS avg_tuples_per_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
WHERE s.idx_scan > 1000
ORDER BY s.idx_tup_read DESC
LIMIT 25;

-- 5.11 Indexes with the most disk reads (cache misses)
SELECT schemaname, relname AS "table", indexrelname AS "index",
       idx_blks_read, idx_blks_hit,
       round(100.0 * idx_blks_hit / NULLIF(idx_blks_hit + idx_blks_read, 0), 2) AS hit_pct,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_statio_user_indexes
WHERE idx_blks_read > 0
ORDER BY idx_blks_read DESC
LIMIT 25;

-- 5.12 tmp_-prefixed indexes with usage (some are heavily used despite the name; do not drop by pattern)
SELECT s.relname AS "table", s.indexrelname AS "index",
       s.idx_scan, s.last_idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
WHERE s.indexrelname LIKE 'tmp\_%'
ORDER BY s.idx_scan, pg_relation_size(s.indexrelid) DESC;

-- 5.13 Exact index bloat (needs CREATE EXTENSION pgstattuple; reads the whole index, so avoid on huge ones)
-- SELECT * FROM pgstatindex('public.some_index');   -- avg_leaf_density well below 90 and high leaf_fragmentation = bloated
