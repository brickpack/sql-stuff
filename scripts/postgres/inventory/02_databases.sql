-- Database inventory. Requires PG 16+.

-- 2.1 Databases: size, encoding, connection limits, age
SELECT d.datname,
       pg_get_userbyid(d.datdba) AS owner,
       pg_size_pretty(pg_database_size(d.oid)) AS size,
       pg_encoding_to_char(d.encoding) AS encoding,
       d.datcollate, d.datctype,
       d.datconnlimit,
       d.datallowconn,
       age(d.datfrozenxid) AS xid_age,
       s.numbackends AS connections,
       s.xact_commit, s.xact_rollback,
       s.deadlocks, s.temp_files,
       pg_size_pretty(s.temp_bytes) AS temp_bytes,
       s.stats_reset
FROM pg_database d
LEFT JOIN pg_stat_database s ON s.datid = d.oid
WHERE NOT d.datistemplate
ORDER BY pg_database_size(d.oid) DESC;

-- 2.2 Per-database / per-role setting overrides
SELECT COALESCE(d.datname, '(all)') AS database,
       COALESCE(r.rolname, '(all)') AS role,
       s.setconfig
FROM pg_db_role_setting s
LEFT JOIN pg_database d ON d.oid = s.setdatabase
LEFT JOIN pg_roles r ON r.oid = s.setrole;
