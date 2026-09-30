-- Roles, privileges and security posture. Requires PG 16+.
-- PG16 added pg_auth_members.inherit_option / set_option / grantor semantics.

-- 4.1 Roles and attributes
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin,
       rolreplication, rolbypassrls, rolinherit, rolconnlimit, rolvaliduntil
FROM pg_roles
WHERE rolname !~ '^pg_'
ORDER BY rolsuper DESC, rolname;

-- 4.2 Role membership, including PG16 INHERIT / SET options
SELECT r.rolname AS role, m.rolname AS member, g.rolname AS grantor,
       am.admin_option, am.inherit_option, am.set_option
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.roleid
JOIN pg_roles m ON m.oid = am.member
JOIN pg_roles g ON g.oid = am.grantor
ORDER BY 1, 2;

-- 4.3 Roles with expired or missing password expiry (login roles)
SELECT rolname, rolvaliduntil,
       CASE WHEN rolvaliduntil < now() THEN 'EXPIRED'
            WHEN rolvaliduntil IS NULL THEN 'no expiry' ELSE 'ok' END AS status
FROM pg_roles
WHERE rolcanlogin
ORDER BY rolvaliduntil NULLS FIRST;

-- 4.4 Password hash type (requires superuser / pg_read_all_data on pg_authid)
SELECT rolname,
       CASE WHEN rolpassword IS NULL THEN 'none'
            WHEN rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'scram-sha-256'
            WHEN rolpassword LIKE 'md5%' THEN 'md5 (weak)'
            ELSE 'other' END AS password_type
FROM pg_authid
WHERE rolcanlogin
ORDER BY 2, 1;

-- 4.5 pg_hba.conf rules as loaded (requires superuser or pg_read_all_settings)
SELECT line_number, type, database, user_name, address, netmask,
       auth_method, options, error
FROM pg_hba_file_rules
ORDER BY line_number;

-- 4.6 Tables with RLS enabled, and their policies
SELECT n.nspname AS schema, c.relname AS table,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity
ORDER BY 1, 2;

-- 4.7 Schema-level privileges (who can CREATE in which schema?)
SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner, n.nspacl
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
ORDER BY 1;

-- 4.8 SECURITY DEFINER functions without a pinned search_path
SELECT n.nspname AS schema, p.proname, pg_get_userbyid(p.proowner) AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (p.proconfig IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));

-- 4.9 SSL usage by current connections
SELECT s.pid, a.usename, a.client_addr, s.ssl, s.version, s.cipher
FROM pg_stat_ssl s
JOIN pg_stat_activity a USING (pid)
WHERE a.backend_type = 'client backend'
ORDER BY s.ssl, a.usename;
