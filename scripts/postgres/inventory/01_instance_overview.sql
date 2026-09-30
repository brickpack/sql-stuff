-- Instance overview: version, uptime, key identity facts. Requires PG 16+.

-- 1.1 Version and uptime
SELECT version() AS version,
       current_setting('server_version_num')::int AS version_num,
       pg_postmaster_start_time() AS started_at,
       now() - pg_postmaster_start_time() AS uptime,
       pg_is_in_recovery() AS is_replica,
       current_setting('data_directory', true) AS data_directory;

-- 1.2 Cluster identity (system identifier, control data)
SELECT system_identifier, pg_control_version, catalog_version_no
FROM pg_control_system();

-- 1.3 Non-default settings (what has someone changed?)
SELECT name, setting, unit, source, sourcefile, pending_restart
FROM pg_settings
WHERE source NOT IN ('default', 'override')
ORDER BY source, name;

-- 1.4 Settings awaiting restart/reload
SELECT name, setting, pending_restart
FROM pg_settings
WHERE pending_restart;

-- 1.5 Invalid entries in config files
SELECT sourcefile, sourceline, seqno, name, setting, error
FROM pg_file_settings
WHERE NOT applied AND error IS NOT NULL;

-- 1.6 Installed extensions vs. available upgrades
SELECT e.extname, e.extversion AS installed, a.default_version AS available,
       n.nspname AS schema
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
LEFT JOIN pg_available_extensions a ON a.name = e.extname
ORDER BY e.extname;

-- 1.7 Tablespaces
SELECT spcname, pg_get_userbyid(spcowner) AS owner,
       pg_size_pretty(pg_tablespace_size(oid)) AS size,
       pg_tablespace_location(oid) AS location
FROM pg_tablespace;
