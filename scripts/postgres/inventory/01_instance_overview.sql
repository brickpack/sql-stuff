-- Instance overview: version, uptime, key identity facts. Requires PG 16+.
-- Aurora/managed-service notes: 1.1c errors outside Aurora; 1.2 and 1.5 (pg_control_*, pg_file_settings) may be
-- unsupported or permission-denied on Aurora; 1.4 pending_restart may not reflect parameter-group changes
-- (check the AWS console for "pending-reboot"). A failed statement does not stop the rest.

-- 1.1 Version and uptime
SELECT version() AS version,
       current_setting('server_version_num')::int AS version_num,
       current_database() AS database,
       current_user AS "user",
       inet_server_port() AS port,
       pg_postmaster_start_time() AS started_at,
       now() - pg_postmaster_start_time() AS uptime,
       pg_conf_load_time() AS config_loaded_at,
       pg_is_in_recovery() AS is_replica,
       (SELECT setting FROM pg_settings WHERE name = 'data_directory') AS data_directory;

-- 1.1b Identity settings: locale, time zone, formats, preloaded libraries
SELECT name, setting, unit, source
FROM pg_settings
WHERE name IN ('server_version', 'server_encoding', 'lc_collate', 'lc_ctype', 'TimeZone', 'log_timezone',
               'DateStyle', 'IntervalStyle', 'standard_conforming_strings', 'default_transaction_isolation',
               'search_path', 'shared_preload_libraries', 'max_connections', 'block_size',
               'data_checksums', 'cluster_name', 'port')
ORDER BY name;

-- 1.1c Aurora engine version (errors on non-Aurora)
SELECT aurora_version();

-- 1.2 Cluster identity (system identifier, control data)
SELECT system_identifier, pg_control_version, catalog_version_no, pg_control_last_modified
FROM pg_control_system();

-- 1.3 Non-default settings (what has someone changed?). Excludes client-set values and Aurora/RDS settings (1.3b).
SELECT name, setting, unit, boot_val, source, sourcefile, pending_restart
FROM pg_settings
WHERE source NOT IN ('default', 'override', 'client')
  AND setting IS DISTINCT FROM boot_val
  AND name NOT LIKE 'rds.%' AND name NOT LIKE 'apg\_%' AND name NOT LIKE 'aurora%'
ORDER BY source, name;

-- 1.3b Aurora/RDS-specific settings changed from their defaults
SELECT name, setting, unit, boot_val, source
FROM pg_settings
WHERE (name LIKE 'rds.%' OR name LIKE 'apg\_%' OR name LIKE 'aurora%')
  AND source NOT IN ('default', 'override')
  AND setting IS DISTINCT FROM boot_val
ORDER BY name;

-- 1.4 Settings awaiting restart/reload
SELECT name, setting, pending_restart
FROM pg_settings
WHERE pending_restart;

-- 1.5 Invalid entries in config files (needs superuser; typically unavailable on managed services)
SELECT sourcefile, sourceline, seqno, name, setting, error
FROM pg_file_settings
WHERE NOT applied AND error IS NOT NULL;

-- 1.6 Installed extensions vs. available upgrades
-- After an engine minor-version upgrade, run: ALTER EXTENSION <name> UPDATE;  for any row marked UPDATE AVAILABLE.
SELECT e.extname, e.extversion AS installed, a.default_version AS available,
       CASE WHEN a.default_version IS DISTINCT FROM e.extversion THEN 'UPDATE AVAILABLE' END AS status,
       n.nspname AS schema,
       pg_get_userbyid(e.extowner) AS owner
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
LEFT JOIN pg_available_extensions a ON a.name = e.extname
ORDER BY status NULLS LAST, e.extname;

-- 1.7 Tablespaces (Aurora has rds_temp_tablespace / aurora_temp_tablespace for temp files)
SELECT spcname, pg_get_userbyid(spcowner) AS owner,
       pg_size_pretty(pg_tablespace_size(oid)) AS size,
       pg_tablespace_location(oid) AS location,
       spcoptions
FROM pg_tablespace;

-- 1.8 Databases: size, owner, encoding, locale, connection limit, XID age
SELECT d.datname, pg_get_userbyid(d.datdba) AS owner,
       pg_encoding_to_char(d.encoding) AS encoding,
       d.datlocprovider, d.datcollate, d.datctype,
       pg_size_pretty(pg_database_size(d.oid)) AS size,
       d.datconnlimit, d.datallowconn, d.datistemplate,
       age(d.datfrozenxid) AS xid_age
FROM pg_database d
WHERE has_database_privilege(d.oid, 'CONNECT')
ORDER BY pg_database_size(d.oid) DESC;

-- 1.9 Roles: privileges, expiry, memberships and role-level setting overrides (e.g. lock_timeout)
SELECT r.rolname, r.rolcanlogin AS can_login, r.rolsuper AS superuser, r.rolcreaterole AS create_role,
       r.rolcreatedb AS create_db, r.rolreplication AS replication, r.rolbypassrls AS bypass_rls,
       r.rolconnlimit AS conn_limit, r.rolvaliduntil AS valid_until,
       (SELECT string_agg(b.rolname, ', ' ORDER BY b.rolname)
        FROM pg_auth_members m
        JOIN pg_roles b ON b.oid = m.roleid
        WHERE m.member = r.oid) AS member_of,
       r.rolconfig AS role_settings
FROM pg_roles r
WHERE r.rolname !~ '^pg_'
ORDER BY r.rolcanlogin DESC, r.rolname;

-- 1.10 Size by schema (tables and materialized views, with indexes and toast)
SELECT n.nspname AS schema,
       count(*) AS tables,
       pg_size_pretty(sum(pg_total_relation_size(c.oid))::bigint) AS total_size,
       pg_size_pretty(sum(pg_relation_size(c.oid))::bigint) AS heap_size,
       pg_size_pretty(sum(pg_indexes_size(c.oid))::bigint) AS index_size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
GROUP BY n.nspname
ORDER BY sum(pg_total_relation_size(c.oid)) DESC;

-- 1.11 Largest tables: heap vs indexes vs toast
SELECT n.nspname AS schema, c.relname AS "table", c.relkind,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid)) AS toast_and_other
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 25;

-- 1.12 Object counts
SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'i' THEN 'index'
                      WHEN 'I' THEN 'partitioned index' WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view'
                      WHEN 'm' THEN 'materialized view' WHEN 't' THEN 'toast table' WHEN 'f' THEN 'foreign table'
                      WHEN 'c' THEN 'composite type' ELSE c.relkind::text END AS kind,
       count(*) AS objects
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
GROUP BY 1
ORDER BY 2 DESC;

-- 1.12b Functions, triggers, foreign keys
SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')) AS functions,
       (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal) AS triggers,
       (SELECT count(*) FROM pg_constraint WHERE contype = 'f') AS foreign_keys;

-- 1.13 Sequences closest to exhaustion. Integer (int4) sequences max out at 2147483647: past ~70% plan the bigint migration.
SELECT schemaname, sequencename, data_type, last_value, max_value,
       round(100.0 * last_value / max_value, 2) AS pct_used
FROM pg_sequences
WHERE last_value IS NOT NULL
ORDER BY last_value::numeric / max_value DESC
LIMIT 20;
