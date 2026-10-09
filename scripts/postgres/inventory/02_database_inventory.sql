-- Database inventory. Requires PG 16+.
-- Note: pg_stat_* counters are per instance (on Aurora, the writer's numbers exclude reader instances).

-- 2.1 Databases: size, encoding, connection limits, age (databases you cannot CONNECT to are skipped)
SELECT d.datname,
       pg_get_userbyid(d.datdba) AS owner,
       pg_size_pretty(pg_database_size(d.oid)) AS size,
       pg_encoding_to_char(d.encoding) AS encoding,
       d.datlocprovider, d.datcollate, d.datctype,
       d.datconnlimit,
       d.datallowconn,
       s.numbackends AS connections,
       age(d.datfrozenxid) AS xid_age,
       round(100.0 * age(d.datfrozenxid) / current_setting('autovacuum_freeze_max_age')::numeric, 1) AS pct_of_freeze_max_age,
       mxid_age(d.datminmxid) AS multixact_age
FROM pg_database d
LEFT JOIN pg_stat_database s ON s.datid = d.oid
WHERE NOT d.datistemplate
  AND has_database_privilege(d.oid, 'CONNECT')
ORDER BY pg_database_size(d.oid) DESC;

-- 2.1b Activity counters per database since stats reset (conflicts is only non-zero on standbys;
-- checksum_failures is NULL/0 unless data checksums are enabled)
SELECT d.datname,
       s.xact_commit, s.xact_rollback,
       round(100.0 * s.xact_rollback / NULLIF(s.xact_commit + s.xact_rollback, 0), 2) AS rollback_pct,
       round(100.0 * s.blks_hit / NULLIF(s.blks_hit + s.blks_read, 0), 2) AS cache_hit_pct,
       s.tup_inserted, s.tup_updated, s.tup_deleted,
       s.deadlocks, s.conflicts,
       s.temp_files, pg_size_pretty(s.temp_bytes) AS temp_bytes,
       s.checksum_failures,
       s.stats_reset
FROM pg_database d
JOIN pg_stat_database s ON s.datid = d.oid
WHERE NOT d.datistemplate
ORDER BY s.xact_commit + s.xact_rollback DESC;

-- 2.2 Per-database / per-role setting overrides, one row per setting
-- Precedence when several apply: database+role > role > database > instance default.
SELECT COALESCE(d.datname, '(all)') AS database,
       COALESCE(r.rolname, '(all)') AS role,
       split_part(cfg, '=', 1) AS setting,
       substr(cfg, strpos(cfg, '=') + 1) AS value
FROM pg_db_role_setting s
CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
LEFT JOIN pg_database d ON d.oid = s.setdatabase
LEFT JOIN pg_roles r ON r.oid = s.setrole
ORDER BY setting, database, role;

-- 2.3 Connections per database and role vs their limits
SELECT a.datname, a.usename,
       count(*) AS sessions,
       count(*) FILTER (WHERE a.state = 'active') AS active,
       count(*) FILTER (WHERE a.state LIKE 'idle in transaction%') AS idle_in_xact,
       d.datconnlimit AS db_limit,
       r.rolconnlimit AS role_limit
FROM pg_stat_activity a
LEFT JOIN pg_database d ON d.datname = a.datname
LEFT JOIN pg_roles r ON r.rolname = a.usename
WHERE a.backend_type = 'client backend'
GROUP BY a.datname, a.usename, d.datconnlimit, r.rolconnlimit
ORDER BY sessions DESC;

-- 2.4 Who can CONNECT / CREATE / use TEMP on each database (PUBLIC = everyone, the default for CONNECT and TEMP)
SELECT d.datname,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
FROM pg_database d
CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
WHERE NOT d.datistemplate
GROUP BY d.datname, a.grantee
ORDER BY d.datname, grantee;

-- 2.5 Schemas in the current database: owner, table count, privileges
SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner,
       (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p')) AS tables,
       n.nspacl
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
ORDER BY tables DESC;

-- 2.6 Logical replication: publications (current database) and replication slots (cluster-wide)
SELECT p.pubname, pg_get_userbyid(p.pubowner) AS owner, p.puballtables AS all_tables,
       p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate,
       (SELECT count(*) FROM pg_publication_tables t WHERE t.pubname = p.pubname) AS tables
FROM pg_publication p
ORDER BY p.pubname;

SELECT slot_name, plugin, slot_type, database, active, active_pid, wal_status
FROM pg_replication_slots;

-- 2.7 Object ownership in the current database (relevant for who may ANALYZE / VACUUM / repack what)
SELECT pg_get_userbyid(c.relowner) AS owner,
       count(*) FILTER (WHERE c.relkind IN ('r', 'p')) AS tables,
       count(*) FILTER (WHERE c.relkind = 'i') AS indexes,
       count(*) FILTER (WHERE c.relkind = 'S') AS sequences,
       count(*) FILTER (WHERE c.relkind IN ('v', 'm')) AS views
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
GROUP BY 1
ORDER BY tables DESC;
