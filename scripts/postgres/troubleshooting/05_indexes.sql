-- Index health. Requires PG 16+.  (idx_scan counters reset with stats reset;
-- PG16 adds last_idx_scan - use it to confirm "unused".)

-- 5.1 Unused indexes (not backing a constraint), largest first
SELECT s.schemaname, s.relname AS table, s.indexrelname AS index,
       s.idx_scan, s.last_idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique
  AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 30;

-- 5.2 Duplicate / overlapping indexes (same table, same leading columns)
SELECT pg_size_pretty(sum(pg_relation_size(idx))::bigint) AS wasted,
       array_agg(idx::regclass) AS indexes,
       (array_agg(indkey))[1] AS columns
FROM (
  SELECT indexrelid AS idx, indrelid, indkey::text AS indkey,
         coalesce(indexprs::text, '') || coalesce(indpred::text, '') AS expr
  FROM pg_index
) x
GROUP BY indrelid, indkey, expr
HAVING count(*) > 1
ORDER BY sum(pg_relation_size(idx)) DESC;

-- 5.3 Foreign keys without a supporting index (slow deletes/joins, lock-heavy)
SELECT c.conrelid::regclass AS table, c.conname AS fk,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
  )
ORDER BY pg_total_relation_size(c.conrelid) DESC;

-- 5.4 Index vs. sequential scan ratio on user tables
SELECT schemaname, relname, seq_scan, idx_scan,
       round(100.0 * idx_scan / NULLIF(seq_scan + idx_scan, 0), 1) AS idx_pct,
       n_live_tup
FROM pg_stat_user_tables
WHERE n_live_tup > 10000
ORDER BY seq_scan DESC
LIMIT 25;

-- 5.5 Index size vs table size (over-indexing)
SELECT n.nspname AS schema, c.relname AS table,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid) AS index_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_indexes_size(c.oid) DESC
LIMIT 25;

-- 5.6 Index build/reindex progress
SELECT p.pid, p.relid::regclass AS table, p.index_relid::regclass AS index,
       p.phase, p.blocks_done, p.blocks_total, p.tuples_done, p.tuples_total
FROM pg_stat_progress_create_index p;
