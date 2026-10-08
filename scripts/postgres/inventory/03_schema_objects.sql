-- Object inventory for the CURRENT database. Requires PG 16+.

-- 3.1 Object counts by schema and kind
SELECT n.nspname AS schema,
       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table'
            WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'i' THEN 'index'
            WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign table'
            WHEN 'I' THEN 'partitioned index' WHEN 't' THEN 'toast' END AS kind,
       count(*) AS objects
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
GROUP BY 1, 2
ORDER BY 1, 2;

-- 3.2 Largest tables (heap + toast + indexes)
SELECT n.nspname AS schema, c.relname AS table,
       c.reltuples::bigint AS est_rows,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(pg_total_relation_size(c.oid) - pg_indexes_size(c.oid)
                      - pg_relation_size(c.oid)) AS toast_etc,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 50;

-- 3.3 Tables without a primary key (breaks logical replication of updates/deletes)
SELECT n.nspname AS schema, c.relname AS table, c.reltuples::bigint AS est_rows,
       c.relreplident AS replica_identity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = c.oid AND k.contype = 'p')
ORDER BY c.reltuples DESC;

-- 3.4 Partitioned tables and their partition counts
SELECT pn.nspname AS schema, pc.relname AS parent,
       pg_get_partkeydef(pc.oid) AS partition_key,
       count(i.inhrelid) AS partitions
FROM pg_partitioned_table p
JOIN pg_class pc ON pc.oid = p.partrelid
JOIN pg_namespace pn ON pn.oid = pc.relnamespace
LEFT JOIN pg_inherits i ON i.inhparent = pc.oid
GROUP BY 1, 2, 3
ORDER BY 4 DESC;

-- 3.5 Sequences nearing exhaustion
SELECT schemaname, sequencename, data_type, last_value, max_value,
       round(100.0 * last_value / max_value, 2) AS pct_used
FROM pg_sequences
WHERE last_value IS NOT NULL
ORDER BY last_value::numeric / max_value DESC
LIMIT 25;

-- 3.6 Functions/procedures and their languages (user-defined only)
SELECT n.nspname AS schema, p.proname AS name, l.lanname AS language,
       CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure'
            WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' END AS kind,
       p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1, 2;

-- 3.7 Triggers (non-internal)
SELECT event_object_schema AS schema, event_object_table AS table,
       trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
ORDER BY 1, 2, 3;

-- 3.8 Invalid indexes (failed CREATE INDEX CONCURRENTLY)
SELECT n.nspname AS schema, c.relname AS index, t.relname AS table
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT i.indisvalid;

-- 3.9 Bloat
WITH constants AS (
    SELECT current_setting('block_size')::numeric AS bs,
           23 AS hdr,
           8 AS ma
),
no_stats AS (
    SELECT table_schema, table_name,
           n_live_tup::numeric AS est_rows,
           pg_table_size(relid)::numeric AS table_bytes
    FROM pg_stat_user_tables
    JOIN information_schema.columns
      ON table_schema = schemaname AND table_name = relname
    GROUP BY table_schema, table_name, relid, n_live_tup
),
null_headers AS (
    SELECT hdr + 1 + (sum(CASE WHEN null_frac <> 0 THEN 1 ELSE 0 END) / 8) AS nullhdr,
           sum((1 - null_frac) * avg_width) AS datawidth,
           max(null_frac) AS maxfracsum,
           schemaname, tablename, hdr, ma, bs
    FROM pg_stats CROSS JOIN constants
    GROUP BY schemaname, tablename, hdr, ma, bs
),
table_est AS (
    SELECT schemaname, tablename,
           (bs * ceil(reltuples / NULLIF((bs - 20) / (datawidth + nullhdr), 0)))::numeric AS est_bytes,
           (relpages * bs)::numeric AS real_bytes
    FROM null_headers
    JOIN pg_class ON tablename = relname
    JOIN pg_namespace ON relnamespace = pg_namespace.oid AND schemaname = nspname
    WHERE relkind = 'r'
)
SELECT schemaname, tablename,
       pg_size_pretty(real_bytes::bigint) AS real_size,
       pg_size_pretty(est_bytes::bigint) AS est_size,
       round(100 * (real_bytes - est_bytes) / NULLIF(real_bytes, 0), 1) AS bloat_pct,
       pg_size_pretty((real_bytes - est_bytes)::bigint) AS wasted
FROM table_est
WHERE real_bytes > 10 * 1024 * 1024
ORDER BY real_bytes - est_bytes DESC
LIMIT 20;
