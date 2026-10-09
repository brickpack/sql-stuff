-- Roles, privileges and security posture. Requires PG 16+.
-- PG16 added pg_auth_members.inherit_option / set_option / grantor semantics.
-- Aurora/RDS: 4.4 (pg_authid) and 4.5 (pg_hba_file_rules) are normally permission-denied for rds_superuser;
-- use the fallbacks 4.4b and 4.5b. A failed statement does not stop the rest.

-- 4.1 Roles and attributes (elevated = any of superuser/createrole/createdb/replication/bypassrls)
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin,
       rolreplication, rolbypassrls, rolinherit, rolconnlimit, rolvaliduntil,
       (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS elevated
FROM pg_roles
WHERE rolname !~ '^pg_'
ORDER BY rolsuper DESC, elevated DESC, rolname;

-- 4.2 Role membership, including PG16 INHERIT / SET options
SELECT r.rolname AS role, m.rolname AS member, g.rolname AS grantor,
       am.admin_option, am.inherit_option, am.set_option
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
JOIN pg_roles g ON g.oid = am.grantor
ORDER BY 1, 2;

-- 4.2b Who holds the powerful roles?
SELECT b.rolname AS powerful_role, m.rolname AS member,
       am.admin_option, am.inherit_option, am.set_option
FROM pg_auth_members am
JOIN pg_roles b ON b.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
WHERE b.rolname IN ('rds_superuser', 'pg_execute_server_program', 'pg_read_server_files',
                    'pg_write_server_files', 'pg_read_all_data', 'pg_write_all_data',
                    'pg_signal_backend', 'pg_monitor', 'pg_read_all_settings', 'pg_read_all_stats',
                    'pg_stat_scan_tables', 'pg_checkpoint', 'rds_replication')
ORDER BY 1, 2;

-- 4.3 Login roles: password expiry (NULL expiry is normal for service accounts, but worth knowing)
SELECT rolname, rolvaliduntil,
       round(extract(epoch FROM rolvaliduntil - now()) / 86400) AS days_left,
       CASE WHEN rolvaliduntil < now() THEN 'EXPIRED'
            WHEN rolvaliduntil IS NULL THEN 'no expiry' ELSE 'ok' END AS status
FROM pg_roles
WHERE rolcanlogin
ORDER BY rolvaliduntil NULLS FIRST, rolname;

-- 4.4 Password hash type (requires superuser / access to pg_authid; usually denied on Aurora, see 4.4b)
SELECT rolname,
       CASE WHEN rolpassword IS NULL THEN 'none'
            WHEN rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'scram-sha-256'
            WHEN rolpassword LIKE 'md5%' THEN 'md5 (weak)'
            ELSE 'other' END AS password_type
FROM pg_authid
WHERE rolcanlogin
ORDER BY 2, 1;

-- 4.4b Fallback: default hash type for new passwords, and which login roles use IAM authentication
SELECT name, setting FROM pg_settings WHERE name = 'password_encryption';

SELECT r.rolname,
       EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid
               WHERE m.member = r.oid AND b.rolname = 'rds_iam') AS iam_auth
FROM pg_roles r
WHERE r.rolcanlogin AND r.rolname !~ '^pg_'
ORDER BY iam_auth DESC, r.rolname;

-- 4.5 pg_hba.conf rules as loaded (requires superuser or pg_read_all_settings; not available on Aurora, see 4.5b)
SELECT line_number, type, database, user_name, address, netmask,
       auth_method, options, error
FROM pg_hba_file_rules
ORDER BY line_number;

-- 4.5b Fallback: transport and authentication settings (Aurora enforces network access with security groups)
SELECT name, setting, source
FROM pg_settings
WHERE name IN ('ssl', 'rds.force_ssl', 'ssl_min_protocol_version', 'ssl_max_protocol_version',
               'ssl_ciphers', 'password_encryption', 'row_security', 'log_connections',
               'log_disconnections', 'log_statement', 'log_min_duration_statement',
               'log_lock_waits', 'log_temp_files')
   OR name LIKE 'pgaudit.%'
ORDER BY name;

-- 4.6 Tables with RLS enabled, and their policies
SELECT n.nspname AS schema, c.relname AS "table",
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity
ORDER BY 1, 2;

-- 4.6b Policy definitions (table owners and BYPASSRLS roles are exempt unless the table has FORCE ROW LEVEL SECURITY)
SELECT schemaname, tablename, policyname, permissive, roles, cmd,
       left(qual, 120) AS using_expr, left(with_check, 120) AS check_expr
FROM pg_policies
ORDER BY 1, 2, 3;

-- 4.6c RLS misconfigurations: RLS on with no policies (non-owners see nothing), or policies defined but RLS off (not enforced)
SELECT n.nspname AS schema, c.relname AS "table",
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
       count(p.oid) AS policies,
       CASE WHEN c.relrowsecurity AND count(p.oid) = 0 THEN 'RLS on, no policies: non-owners see no rows'
            WHEN NOT c.relrowsecurity AND count(p.oid) > 0 THEN 'policies exist but RLS is off: not enforced' END AS issue
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
GROUP BY n.nspname, c.relname, c.oid, c.relrowsecurity, c.relforcerowsecurity
HAVING (c.relrowsecurity AND count(p.oid) = 0) OR (NOT c.relrowsecurity AND count(p.oid) > 0)
ORDER BY 1, 2;

-- 4.7 Schema-level privileges, per grantee (who can CREATE / USAGE in which schema?)
-- A NULL ACL means the default: owner only. PUBLIC with CREATE on a schema lets anyone create objects there.
SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
GROUP BY n.nspname, n.nspowner, a.grantee
ORDER BY 1, grantee;

-- 4.8 SECURITY DEFINER functions without a pinned search_path (extension-owned functions excluded)
SELECT n.nspname AS schema, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_userbyid(p.proowner) AS owner,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  AND (p.proconfig IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));

-- 4.9 SSL usage by current connections, summarised (behind a proxy this is the proxy-to-database leg)
SELECT a.usename, s.ssl, s.version, s.cipher, count(*) AS sessions
FROM pg_stat_ssl s
JOIN pg_stat_activity a USING (pid)
WHERE a.backend_type = 'client backend'
GROUP BY a.usename, s.ssl, s.version, s.cipher
ORDER BY s.ssl, sessions DESC;

-- 4.10 Default privileges (ALTER DEFAULT PRIVILEGES): what new objects get automatically
SELECT pg_get_userbyid(d.defaclrole) AS for_role,
       CASE WHEN d.defaclnamespace = 0 THEN '(all schemas)' ELSE d.defaclnamespace::regnamespace::text END AS schema,
       CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences' WHEN 'f' THEN 'functions'
                            WHEN 'T' THEN 'types' WHEN 'n' THEN 'schemas' END AS object_type,
       d.defaclacl AS privileges
FROM pg_default_acl d
ORDER BY 1, 2, 3;

-- 4.11 Table privileges granted to someone other than the owner: grantee x privilege x number of tables
SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type, count(*) AS tables
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND a.grantee <> c.relowner
GROUP BY 1, 2
ORDER BY 1, 2;

-- 4.12 Event triggers (DDL hooks; check who owns them and that they are enabled as intended)
SELECT evtname, evtevent, pg_get_userbyid(evtowner) AS owner, evtenabled, evttags, evtfoid::regproc AS function
FROM pg_event_trigger
ORDER BY evtname;
