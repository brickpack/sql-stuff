import React, { useState } from 'react';
import { Database, AlertCircle, CheckCircle, ChevronRight, Copy, Play } from 'lucide-react';

interface Finding {
  [key: string]: boolean;
}

interface Check {
  label: string;
  key: string;
}

interface Example {
  bad: string;
  good: string;
  why: string;
}

interface Step {
  title: string;
  description: string;
  sql?: string;
  action?: string;
  warning?: string;
  guidance?: string[];
  checks?: Check[];
  examples?: Example[];
}

const DBTroubleshooter = () => {
  const [dbType, setDbType] = useState<string>('');
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [findings, setFindings] = useState<Finding>({});
  const [copiedIndex, setCopiedIndex] = useState<string | null>(null);

  const copyToClipboard = (text: string, index: string) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const getSteps = (): Step[] => {
    const allSteps: Record<string, Step[]> = {
      sqlserver: [
        {
          title: "Get Actual Execution Plan",
          description: "Analyze query execution in SSMS",
          sql: "-- Enable execution plan in SSMS (Ctrl+M) or:\nSET STATISTICS IO ON;\nSET STATISTICS TIME ON;\n\nyour_query_here;\n\n-- Or get XML plan programmatically\nSET SHOWPLAN_XML ON;\nGO\nyour_query_here;\nGO\nSET SHOWPLAN_XML OFF;",
          guidance: [
            "Look for thick arrows with estimate/actual mismatches",
            "Yellow/red warning icons: missing indexes, implicit conversions, spills",
            "High cost % operators (>50%) are prime suspects",
            "Table Scans on large tables indicate missing indexes",
            "Index Scans vs Index Seeks - seeks are better",
            "Key Lookups expensive when combined with many rows"
          ],
          checks: [
            { label: "Warning icons (yellow/red triangles) in plan?", key: "warnings" },
            { label: "Estimate vs Actual rows >10x difference?", key: "estimates" },
            { label: "Table Scan on tables with >100k rows?", key: "tableScans" },
            { label: "Many Key Lookups (>1000 rows)?", key: "keyLookups" },
            { label: "Operators with >50% of total cost?", key: "highCost" },
            { label: "Thick arrows indicating millions of rows?", key: "thickArrows" },
            { label: "Memory grants showing spills to tempdb?", key: "memorySpills" },
            { label: "Sort or Hash operations with warnings?", key: "sortHash" }
          ]
        },
        {
          title: "Update Statistics",
          description: "Refresh statistics",
          sql: "SELECT OBJECT_NAME(object_id) AS TableName,\n       STATS_DATE(object_id, index_id) AS Updated\nFROM sys.indexes\nWHERE OBJECT_NAME(object_id) = 'YourTable';",
          action: "-- Full scan (most accurate but slowest)\nUPDATE STATISTICS YourTable WITH FULLSCAN;\n\n-- Sampled (faster, still accurate)\nUPDATE STATISTICS YourTable WITH SAMPLE 50 PERCENT;\n\n-- Let SQL Server decide sample size\nUPDATE STATISTICS YourTable;\n\n-- Update all statistics in database\nEXEC sp_updatestats;",
          warning: "⚠️ UPDATE STATISTICS WITH FULLSCAN scans entire table and can be resource-intensive. Consider running during off-peak hours.",
          guidance: [
            "Stale stats cause bad plans",
            "Update after >20% row changes",
            "💡 You don't need FULLSCAN - SQL Server's default sampling is often sufficient",
            "Use SAMPLE 50 PERCENT for faster updates with good accuracy",
            "FULLSCAN only needed when default sampling gives poor results"
          ]
        },
        {
          title: "Find Missing Indexes",
          description: "Use DMVs",
          sql: "SELECT \n    migs.user_seeks * migs.avg_total_user_cost AS impact,\n    mid.equality_columns,\n    mid.included_columns\nFROM sys.dm_db_missing_index_groups mig\nJOIN sys.dm_db_missing_index_group_stats migs\n    ON migs.group_handle = mig.index_handle\nJOIN sys.dm_db_missing_index_details mid\n    ON mig.index_handle = mid.index_handle\nORDER BY impact DESC;",
          action: "CREATE NONCLUSTERED INDEX IX_Name \nON Table(Col1, Col2) \nINCLUDE (Col3, Col4);",
          warning: "⚠️ Creating indexes can lock tables and impact performance during creation. Consider using ONLINE = ON option (Enterprise Edition).",
          guidance: [
            "High impact score = high priority",
            "INCLUDE columns eliminate key lookups"
          ]
        },
        {
          title: "Check Parameter Sniffing",
          description: "Identify and fix parameter sniffing issues",
          sql: "-- Test if parameter sniffing is causing issues\nyour_query_with_parameters\nOPTION (RECOMPILE);\n\n-- Compare execution time with and without RECOMPILE\n-- If RECOMPILE is significantly faster, you have parameter sniffing",
          action: "-- Solution 1: Recompile each execution (simple but adds overhead)\nOPTION (RECOMPILE)\n\n-- Solution 2: Optimize for unknown (uses average stats)\nOPTION (OPTIMIZE FOR UNKNOWN)\n\n-- Solution 3: Use local variable to avoid sniffing\nDECLARE @local_param INT = @parameter;\nSELECT ... WHERE column = @local_param;\n\n-- Solution 4: Optimize for specific common value\nOPTION (OPTIMIZE FOR (@parameter = 'common_value'))",
          guidance: [
            "Parameter sniffing occurs when SQL Server creates a plan based on the first parameter values it sees",
            "That plan gets cached and reused for all subsequent executions - even with different parameters",
            "Problem: A plan optimized for parameter value 'A' might be terrible for parameter value 'B'",
            "If RECOMPILE helps significantly, parameter sniffing is likely the issue",
            "Use OPTIMIZE FOR UNKNOWN when parameter values vary widely",
            "Local variables prevent sniffing but give optimizer less information (can help or hurt)",
            "OPTIMIZE FOR specific value works when you know the most common parameter"
          ]
        },
        {
          title: "Find Implicit Conversions",
          description: "Locate type mismatches",
          sql: "SELECT query_plan, text\nFROM sys.dm_exec_query_stats qs\nCROSS APPLY sys.dm_exec_query_plan(plan_handle) qp\nCROSS APPLY sys.dm_exec_sql_text(sql_handle) st\nWHERE CAST(query_plan AS NVARCHAR(MAX)) \n    LIKE '%CONVERT_IMPLICIT%';",
          guidance: [
            "Yellow warning shows conversion",
            "Match parameter types to column types"
          ]
        },
        {
          title: "Analyze I/O and Memory",
          description: "Check for I/O bottlenecks and memory issues",
          sql: "-- Find queries with high I/O\nSELECT TOP 20\n    total_logical_reads/execution_count AS avg_logical_reads,\n    total_physical_reads/execution_count AS avg_physical_reads,\n    total_logical_writes/execution_count AS avg_logical_writes,\n    execution_count,\n    total_worker_time/1000000 AS total_cpu_sec,\n    total_elapsed_time/1000000 AS total_elapsed_sec,\n    SUBSTRING(st.text, (qs.statement_start_offset/2)+1,\n        ((CASE qs.statement_end_offset\n            WHEN -1 THEN DATALENGTH(st.text)\n            ELSE qs.statement_end_offset\n        END - qs.statement_start_offset)/2) + 1) AS query_text\nFROM sys.dm_exec_query_stats qs\nCROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st\nORDER BY total_logical_reads DESC;\n\n-- Check for memory grants and spills\nSELECT \n    text,\n    query_plan,\n    granted_memory_kb,\n    used_memory_kb,\n    ideal_memory_kb,\n    requested_memory_kb,\n    CASE \n        WHEN granted_memory_kb < ideal_memory_kb THEN 'Under-granted'\n        WHEN granted_memory_kb > used_memory_kb * 2 THEN 'Over-granted'\n        ELSE 'OK'\n    END AS grant_status\nFROM sys.dm_exec_query_memory_grants qmg\nCROSS APPLY sys.dm_exec_sql_text(sql_handle) st\nCROSS APPLY sys.dm_exec_query_plan(plan_handle) qp\nORDER BY granted_memory_kb DESC;\n\n-- Check buffer pool usage\nSELECT \n    (cntr_value * 8 / 1024) AS buffer_pool_mb\nFROM sys.dm_os_performance_counters\nWHERE object_name LIKE '%Buffer Manager%'\n    AND counter_name = 'Database pages';\n\n-- Check for memory pressure\nSELECT \n    type,\n    (pages_kb / 1024) AS pages_mb,\n    (virtual_memory_committed_kb / 1024) AS vm_committed_mb\nFROM sys.dm_os_memory_clerks\nWHERE pages_kb > 0\nORDER BY pages_kb DESC;\n\n-- Check Page Life Expectancy (PLE)\nSELECT \n    object_name,\n    counter_name,\n    cntr_value AS page_life_expectancy_seconds\nFROM sys.dm_os_performance_counters\nWHERE object_name LIKE '%Buffer Manager%'\n    AND counter_name = 'Page life expectancy';",
          action: "-- Adjust max server memory (leave RAM for OS)\nEXEC sp_configure 'max server memory (MB)', 16384;  -- 16GB example\nRECONFIGURE;\n\n-- Check current memory settings\nEXEC sp_configure 'max server memory';\nEXEC sp_configure 'min server memory';\n\n-- Use Resource Governor for query memory limits\nCREATE RESOURCE POOL limited_pool\nWITH (\n    MAX_MEMORY_PERCENT = 50,\n    MAX_CPU_PERCENT = 80\n);\n\n-- Query hints for memory control\nSELECT ... \nOPTION (MAX_GRANT_PERCENT = 10);  -- Limit memory grant\n\nSELECT ...\nOPTION (MIN_GRANT_PERCENT = 5, MAX_GRANT_PERCENT = 20);",
          warning: "⚠️ Changing max server memory or other SQL Server configuration can cause service restarts or performance degradation. Test in non-production and during maintenance windows. Leave 4-6GB RAM for OS (more for large servers).",
          guidance: [
            "💡 I/O Metrics:",
            "• Logical reads = Pages read from buffer pool (memory or disk)",
            "• Physical reads = Pages read from disk (slow - indicates cache misses)",
            "• Logical writes = Pages modified in memory",
            "• High logical reads with low physical reads = good caching",
            "• High physical reads = insufficient buffer pool or cache churn",
            "",
            "💡 Memory Grant Issues:",
            "• Under-granted: Query needs more memory than granted (causes spills to tempdb)",
            "• Over-granted: Wastes memory that other queries could use",
            "• Ideal vs Granted mismatch = poor cardinality estimates (update stats)",
            "• Check execution plan for 'SpillToTempDb' warnings (yellow exclamation)",
            "",
            "💡 Page Life Expectancy (PLE):",
            "• How long pages stay in buffer pool before being evicted",
            "• Rule of thumb: Should be > 300 seconds (5 minutes)",
            "• Low PLE (<300) = memory pressure, frequent cache evictions",
            "• Very low PLE (<100) = serious memory pressure",
            "",
            "💡 Memory Configuration:",
            "• max server memory: SQL Server's memory limit (leave RAM for OS)",
            "• Formula: Total RAM - 4GB (for OS) - 1GB per 8GB RAM (for OS/other)",
            "• Example: 32GB server = ~24GB max server memory",
            "• min server memory: Prevents SQL from releasing memory",
            "",
            "💡 Addressing Memory Issues:",
            "• Spills to tempdb: Increase memory, update statistics, add indexes",
            "• Over-grants: Update statistics (better cardinality estimates)",
            "• Memory pressure: Increase max server memory or add more RAM",
            "• High physical reads: Increase buffer pool or optimize queries",
            "",
            "⚙️ NOTE: Memory values are examples - adjust based on:",
            "• Total server RAM (leave 4-6GB minimum for OS)",
            "• Workload patterns (OLTP vs Analytics)",
            "• Concurrent user count",
            "• Other applications running on server",
            "",
            "📊 Monitor with: sys.dm_os_memory_clerks, sys.dm_os_performance_counters, sys.dm_exec_query_memory_grants"
          ]
        },
        {
          title: "Enable Query Store",
          description: "Track performance",
          sql: "ALTER DATABASE YourDB SET QUERY_STORE = ON;\n\nSELECT q.query_id, qt.query_sql_text,\n       rs.avg_duration/1000 AS avg_ms\nFROM sys.query_store_query q\nJOIN sys.query_store_query_text qt\n    ON q.query_text_id = qt.query_text_id\nJOIN sys.query_store_plan p\n    ON q.query_id = p.query_id\nJOIN sys.query_store_runtime_stats rs\n    ON p.plan_id = rs.plan_id\nORDER BY rs.avg_duration DESC;",
          action: "EXEC sp_query_store_force_plan \n    @query_id = 123, @plan_id = 456;",
          guidance: [
            "Query Store tracks performance history",
            "Force good plans to prevent regression"
          ]
        },
        {
          title: "Optimize Query Patterns",
          description: "Rewrite inefficient queries",
          examples: [
            { bad: "WHERE OrderID IN (SELECT...)", good: "WHERE EXISTS (SELECT 1...)", why: "IN materializes entire subquery; EXISTS stops at first match" },
            { bad: "WHERE YEAR(Date) = 2024", good: "WHERE Date >= '2024-01-01' AND Date < '2025-01-01'", why: "YEAR() prevents index seek; range allows index usage" },
            { bad: "SELECT * FROM Orders o OUTER APPLY (SELECT TOP 1 * FROM OrderDetails od WHERE od.OrderID = o.OrderID ORDER BY od.Date DESC) od", good: "WITH Ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY OrderID ORDER BY Date DESC) as rn FROM OrderDetails) SELECT o.*, r.* FROM Orders o JOIN Ranked r ON o.OrderID = r.OrderID WHERE r.rn = 1", why: "APPLY runs per row; window function scans once" },
            { bad: "WHERE Status <> 'deleted'", good: "WHERE Status IN ('active', 'pending')", why: "<> causes scan; IN allows seeks" },
            { bad: "SELECT DISTINCT col1, col2 FROM table", good: "SELECT col1, col2 FROM table GROUP BY col1, col2", why: "DISTINCT requires sort; GROUP BY uses indexes" },
            { bad: "WHERE ISNULL(column, '') = ''", good: "WHERE column IS NULL OR column = ''", why: "ISNULL() prevents index usage" },
            { bad: "WHERE SUBSTRING(OrderNumber, 1, 3) = 'ORD'", good: "WHERE OrderNumber LIKE 'ORD%'", why: "SUBSTRING prevents seek; LIKE uses index" },
            { bad: "WHERE Price * Quantity > 1000", good: "WHERE Price > 1000 / NULLIF(Quantity, 0)", why: "Math on column prevents seek" },
            { bad: "ORDER BY NEWID()", good: "TABLESAMPLE (1000 ROWS)", why: "NEWID() sorts entire table; TABLESAMPLE is faster" },
            { bad: "WHERE o.CustomerID NOT IN (SELECT CustomerID FROM Blacklist)", good: "WHERE NOT EXISTS (SELECT 1 FROM Blacklist b WHERE b.CustomerID = o.CustomerID)", why: "NOT IN fails with NULLs; NOT EXISTS short-circuits" },
            { bad: "WHERE CAST(OrderID AS VARCHAR) = @id", good: "WHERE OrderID = CAST(@id AS INT)", why: "CAST on column causes scan" },
            { bad: "GROUP BY DATEPART(hour, OrderDate)", good: "ALTER TABLE Orders ADD OrderHour AS DATEPART(hour, OrderDate) PERSISTED; GROUP BY OrderHour", why: "Repeating function; use persisted computed column" },
            { bad: "WHERE Salary BETWEEN @min AND @max OR Department = @dept", good: "WHERE Salary BETWEEN @min AND @max UNION ALL SELECT * WHERE Department = @dept AND NOT (Salary BETWEEN @min AND @max)", why: "OR prevents index intersection; UNION uses indexes" }
          ],
          guidance: [
            "EXISTS faster than IN",
            "Avoid functions on columns",
            "Window functions beat correlated subqueries",
            "Move calculations to parameters, not columns"
          ]
        },
        {
          title: "Using CTEs Effectively",
          description: "When to use Common Table Expressions",
          examples: [
            { bad: "SELECT c.*, (SELECT COUNT(*) FROM Orders WHERE CustomerID = c.ID) as cnt FROM Customers c", good: "WITH Metrics AS (SELECT CustomerID, COUNT(*) as cnt FROM Orders GROUP BY CustomerID) SELECT c.*, m.cnt FROM Customers c LEFT JOIN Metrics m ON c.ID = m.CustomerID", why: "Correlated subqueries scan repeatedly; CTE scans once" }
          ],
          guidance: [
            "✅ Use CTEs for: Readability, reusing calculations, recursive queries",
            "❌ Avoid CTEs when: Single simple subquery, performance-critical hotpath",
            "💡 Tip: CTEs make code maintainable; use Query Store to track performance"
          ]
        },
        {
          title: "Check Tempdb Contention",
          description: "Diagnose and resolve tempdb allocation contention",
          sql: "-- Check for allocation contention waits\nSELECT \n    wait_type,\n    waiting_tasks_count,\n    wait_time_ms,\n    max_wait_time_ms,\n    signal_wait_time_ms\nFROM sys.dm_os_wait_stats\nWHERE wait_type IN ('PAGELATCH_UP', 'PAGELATCH_EX', 'PAGELATCH_SH')\n    AND wait_time_ms > 0\nORDER BY wait_time_ms DESC;\n\n-- Check tempdb file configuration\nSELECT \n    name AS file_name,\n    physical_name,\n    size * 8 / 1024 AS size_mb,\n    growth,\n    is_percent_growth\nFROM tempdb.sys.database_files;\n\n-- Check current tempdb usage\nSELECT \n    SUM(unallocated_extent_page_count) / 128 AS free_mb,\n    SUM(user_object_reserved_page_count) / 128 AS user_objects_mb,\n    SUM(internal_object_reserved_page_count) / 128 AS internal_objects_mb,\n    SUM(version_store_reserved_page_count) / 128 AS version_store_mb\nFROM sys.dm_db_file_space_usage;\n\n-- Check for sessions using tempdb heavily\nSELECT \n    session_id,\n    DB_NAME(database_id) AS database_name,\n    host_name,\n    program_name,\n    (user_objects_alloc_page_count - user_objects_dealloc_page_count) / 128 AS user_objects_mb,\n    (internal_objects_alloc_page_count - internal_objects_dealloc_page_count) / 128 AS internal_objects_mb\nFROM sys.dm_db_session_space_usage\nWHERE (user_objects_alloc_page_count - user_objects_dealloc_page_count) > 1000\n   OR (internal_objects_alloc_page_count - internal_objects_dealloc_page_count) > 1000\nORDER BY user_objects_mb + internal_objects_mb DESC;",
          action: "-- Add more tempdb files (one per CPU core, up to 8)\n-- Run for each additional file needed:\nALTER DATABASE tempdb ADD FILE (\n    NAME = tempdev2,\n    FILENAME = 'C:\\SQLData\\tempdb2.ndf',\n    SIZE = 8GB,\n    FILEGROWTH = 512MB\n);\n\n-- Make all tempdb files the same size\nALTER DATABASE tempdb MODIFY FILE (NAME = tempdev, SIZE = 8GB);\nALTER DATABASE tempdb MODIFY FILE (NAME = tempdev2, SIZE = 8GB);\n\n-- Enable trace flag 1117 and 1118 (pre-SQL 2016)\n-- SQL 2016+ has these enabled by default\nDBCC TRACEON(1117, 1118, -1);",
          warning: "⚠️ Adding tempdb files requires careful planning. Files should be equal size and on fast storage (SSD). Requires SQL Server restart to take full effect.",
          guidance: [
            "💡 Tempdb Contention Symptoms:",
            "• High PAGELATCH_UP or PAGELATCH_EX waits",
            "• Wait resource like 2:1:1 or 2:1:3 (PFS/SGAM/GAM pages)",
            "• Slow performance with many concurrent sessions",
            "",
            "💡 Tempdb File Configuration:",
            "• Create 1 file per CPU core (up to 8 files initially)",
            "• For 8+ cores: Start with 8 files, add more if contention persists",
            "• All files should be SAME size (critical for proportional fill)",
            "• Place files on fast storage (SSD/NVMe)",
            "• Use fixed growth (MB) not percentage growth",
            "",
            "💡 Best Practices:",
            "• Initial size: 8GB+ per file (prevents autogrowth)",
            "• Growth increment: 512MB-1GB (not 10%)",
            "• Equal file sizes ensure round-robin allocation works",
            "• Trace flags 1117/1118 enabled (default in SQL 2016+)",
            "",
            "💡 Reducing Tempdb Usage:",
            "• Avoid SELECT DISTINCT on large datasets",
            "• Optimize sorting (better indexes, reduce ORDER BY scope)",
            "• Reduce temp table usage (use table variables for small sets)",
            "• Check for implicit conversions causing spools",
            "• Enable READ_COMMITTED_SNAPSHOT to reduce version store usage",
            "",
            "📊 Monitor: sys.dm_os_wait_stats, sys.dm_db_file_space_usage, sys.dm_db_session_space_usage"
          ],
          checks: [
            { label: "PAGELATCH waits > 1000ms total?", key: "pagelatchWaits" },
            { label: "Tempdb has fewer files than CPU cores?", key: "insufficientFiles" },
            { label: "Tempdb files are different sizes?", key: "unequalSizes" },
            { label: "High tempdb usage by specific sessions?", key: "highUsage" },
            { label: "Frequent tempdb autogrowth events?", key: "autogrowth" }
          ]
        },
        {
          title: "Identify Blocking and Deadlocks",
          description: "Find and resolve blocking chains and deadlock issues",
          sql: "-- Find current blocking sessions\nSELECT \n    blocking.session_id AS blocking_session_id,\n    blocked.session_id AS blocked_session_id,\n    blocking_text.text AS blocking_query,\n    blocked_text.text AS blocked_query,\n    blocked.wait_time / 1000 AS wait_time_seconds,\n    blocked.wait_type,\n    DB_NAME(blocked.database_id) AS database_name,\n    blocking.host_name AS blocking_host,\n    blocked.host_name AS blocked_host,\n    blocking.program_name AS blocking_program,\n    blocked.program_name AS blocked_program\nFROM sys.dm_exec_requests blocked\nINNER JOIN sys.dm_exec_sessions blocking \n    ON blocked.blocking_session_id = blocking.session_id\nOUTER APPLY sys.dm_exec_sql_text(blocked.sql_handle) blocked_text\nOUTER APPLY sys.dm_exec_sql_text(blocking.most_recent_sql_handle) blocking_text\nWHERE blocked.blocking_session_id <> 0\nORDER BY blocked.wait_time DESC;\n\n-- Get blocking chain hierarchy\nWITH BlockingChain AS (\n    SELECT \n        session_id,\n        blocking_session_id,\n        0 AS level,\n        CAST(session_id AS VARCHAR(MAX)) AS chain\n    FROM sys.dm_exec_requests\n    WHERE blocking_session_id = 0 AND session_id IN (\n        SELECT blocking_session_id FROM sys.dm_exec_requests WHERE blocking_session_id <> 0\n    )\n    UNION ALL\n    SELECT \n        r.session_id,\n        r.blocking_session_id,\n        bc.level + 1,\n        bc.chain + ' -> ' + CAST(r.session_id AS VARCHAR(MAX))\n    FROM sys.dm_exec_requests r\n    INNER JOIN BlockingChain bc ON r.blocking_session_id = bc.session_id\n    WHERE r.blocking_session_id <> 0\n)\nSELECT * FROM BlockingChain ORDER BY level, chain;\n\n-- Check for deadlocks (requires trace flag 1222 or XEvents)\nSELECT \n    target_data\nFROM sys.dm_xe_session_targets xet\nINNER JOIN sys.dm_xe_sessions xe ON xe.address = xet.event_session_address\nWHERE xe.name = 'system_health'\n    AND xet.target_name = 'ring_buffer';\n\n-- View lock details\nSELECT \n    l.request_session_id AS session_id,\n    DB_NAME(l.resource_database_id) AS database_name,\n    l.resource_type,\n    l.resource_associated_entity_id,\n    l.request_mode,\n    l.request_status,\n    OBJECT_NAME(p.object_id, l.resource_database_id) AS object_name,\n    st.text AS query_text\nFROM sys.dm_tran_locks l\nLEFT JOIN sys.partitions p ON l.resource_associated_entity_id = p.hobt_id\nLEFT JOIN sys.dm_exec_requests r ON l.request_session_id = r.session_id\nOUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st\nWHERE l.request_session_id <> @@SPID\nORDER BY l.request_session_id, l.resource_type;",
          action: "-- Kill blocking session (use carefully!)\nKILL [blocking_session_id];\n\n-- Enable deadlock trace flag for logging\nDBCC TRACEON(1222, -1);  -- Logs deadlocks to error log\n\n-- Set lock timeout to prevent indefinite waits\nSET LOCK_TIMEOUT 5000;  -- 5 seconds\n\n-- Use NOLOCK hint to read uncommitted data (may see dirty reads)\nSELECT * FROM table WITH (NOLOCK);\n\n-- Use READ COMMITTED SNAPSHOT ISOLATION to reduce blocking\nALTER DATABASE YourDatabase SET READ_COMMITTED_SNAPSHOT ON;\n\n-- Use SNAPSHOT ISOLATION for consistent reads\nALTER DATABASE YourDatabase SET ALLOW_SNAPSHOT_ISOLATION ON;\nSET TRANSACTION ISOLATION LEVEL SNAPSHOT;",
          warning: "⚠️ Killing sessions terminates user connections and rolls back their transactions. Use only when necessary. NOLOCK can return inconsistent data. Test isolation level changes thoroughly before production use.",
          guidance: [
            "💡 Understanding Blocking:",
            "• Blocking occurs when one session holds locks that another session needs",
            "• blocking_session_id shows which session is causing the wait",
            "• Long blocking chains indicate transactions held open too long",
            "• Common causes: Missing indexes, long transactions, lock escalation",
            "",
            "💡 Deadlock Analysis:",
            "• Deadlock = circular blocking (Session A waits for B, B waits for A)",
            "• SQL Server kills one session (deadlock victim) to resolve",
            "• Review deadlock graph in system_health XEvents or error log",
            "• Common fix: Access tables in same order in all queries",
            "",
            "💡 Reducing Blocking:",
            "• Keep transactions short and fast",
            "• Add appropriate indexes to reduce scan times",
            "• Access tables in consistent order across queries",
            "• Use READ_COMMITTED_SNAPSHOT to allow readers during writes",
            "• Consider SNAPSHOT isolation for consistent reads without blocking",
            "",
            "💡 Lock Types:",
            "• S (Shared): Read locks, multiple allowed",
            "• X (Exclusive): Write locks, blocks all others",
            "• U (Update): Prevents deadlocks during UPDATE",
            "• IS/IX (Intent): Hierarchical lock indicators",
            "",
            "💡 Isolation Level Trade-offs:",
            "• READ UNCOMMITTED (NOLOCK): Fastest but dirty reads possible",
            "• READ COMMITTED (default): Balances consistency and concurrency",
            "• READ_COMMITTED_SNAPSHOT: Like READ COMMITTED but uses row versioning",
            "• SNAPSHOT: Full transactional consistency, no blocking on reads",
            "• SERIALIZABLE: Strictest, most blocking",
            "",
            "📊 Monitor: sys.dm_exec_requests, sys.dm_tran_locks, system_health XEvents"
          ],
          checks: [
            { label: "Sessions blocked > 10 seconds?", key: "longBlocking" },
            { label: "Blocking chains with 3+ levels?", key: "deepChains" },
            { label: "Deadlocks occurring frequently?", key: "frequentDeadlocks" },
            { label: "Lock escalation to table level?", key: "lockEscalation" },
            { label: "Long-running transactions (>60s)?", key: "longTransactions" }
          ]
        }
      ],
      postgresql: [
        {
          title: "Get Execution Plan with Full Details",
          description: "Run EXPLAIN ANALYZE to see actual execution statistics",
          sql: "EXPLAIN (ANALYZE, BUFFERS, VERBOSE)\nyour_query_here;",
          warning: "⚠️ EXPLAIN ANALYZE actually executes the query! For INSERT/UPDATE/DELETE, wrap in BEGIN; ... ROLLBACK; to avoid changes.",
          guidance: [
            "Look for nodes with high 'actual time' values",
            "Compare 'rows' (estimated) vs 'actual rows' - big mismatches (10x+) indicate stale statistics",
            "Check 'Buffers: shared read=X' - high values mean disk I/O (slow)",
            "Sequential Scans on large tables are red flags",
            "Look for 'external merge' in sorts = disk-based sorting (increase work_mem)"
          ],
          checks: [
            { label: "Execution time > 1 second?", key: "slowExecution" },
            { label: "Row estimates way off (10x+ difference)?", key: "badEstimates" },
            { label: "Seq Scan on tables with 100k+ rows?", key: "seqScan" },
            { label: "High buffer reads (not hits)?", key: "diskIO" },
            { label: "External merge or external sort present?", key: "externalSort" },
            { label: "Nested Loop with loops > 1000?", key: "highLoops" },
            { label: "Hash join with multiple batches?", key: "hashBatches" }
          ]
        },
        {
          title: "Check Statistics Freshness",
          description: "Verify when statistics were last updated",
          sql: "SELECT schemaname, tablename, \n       last_analyze, last_autoanalyze,\n       n_live_tup as row_count,\n       n_mod_since_analyze as rows_changed\nFROM pg_stat_user_tables \nWHERE tablename IN ('table1', 'table2')\nORDER BY last_analyze NULLS FIRST;",
          action: "-- Update statistics for specific table\nANALYZE table_name;\n\n-- Update all tables in schema\nANALYZE;",
          guidance: [
            "Statistics should be updated after significant data changes (>10% rows)",
            "If last_analyze is NULL or very old, run ANALYZE immediately",
            "n_mod_since_analyze shows rows changed since last analyze"
          ]
        },
        {
          title: "Identify Missing Indexes",
          description: "Look for opportunities to add indexes",
          sql: "SELECT schemaname, tablename, \n       seq_scan, seq_tup_read,\n       idx_scan, idx_tup_fetch\nFROM pg_stat_user_tables\nWHERE schemaname NOT IN ('pg_catalog', 'information_schema')\n  AND seq_scan > 0\nORDER BY seq_tup_read DESC\nLIMIT 20;",
          action: "CREATE INDEX idx_name ON table_name(column_name);\n\nCREATE INDEX idx_name ON table_name(col1) INCLUDE (col2);",
          warning: "⚠️ CREATE INDEX can lock tables. Use CREATE INDEX CONCURRENTLY to avoid blocking reads/writes (takes longer but safer).",
          guidance: [
            "High seq_tup_read with low idx_scan suggests missing indexes",
            "Index columns used in WHERE, JOIN, and ORDER BY clauses",
            "Use INCLUDE for covering indexes (PostgreSQL 11+)"
          ]
        },
        {
          title: "Analyze Join Performance",
          description: "Check if join methods are optimal",
          sql: "SET enable_nestloop = off;\nEXPLAIN (ANALYZE, BUFFERS) your_query_here;\nRESET enable_nestloop;",
          guidance: [
            "Nested Loop: Best for small datasets or when inner table has index on join key",
            "Hash Join: Best for large datasets without indexes, requires work_mem",
            "Merge Join: Best when both inputs already sorted on join key",
            "If disabling a join type helps significantly, investigate why planner chose poorly",
            "Look for 'loops' value - high loops in nested loop = performance issue"
          ],
          checks: [
            { label: "Nested Loop with high loop count (>1000)?", key: "highLoops" },
            { label: "Hash join with multiple batches?", key: "hashBatches" },
            { label: "Join producing way more rows than expected?", key: "joinExplosion" }
          ]
        },
        {
          title: "Check Configuration Settings",
          description: "Review memory and planner settings",
          sql: "-- Check key configuration parameters\nSHOW work_mem;\nSHOW shared_buffers;\nSHOW effective_cache_size;\nSHOW random_page_cost;\nSHOW effective_io_concurrency;\nSHOW maintenance_work_mem;\nSHOW max_parallel_workers_per_gather;\nSHOW max_worker_processes;\nSHOW checkpoint_completion_target;\nSHOW wal_buffers;\n\n-- View all current settings\nSELECT name, setting, unit, source, context \nFROM pg_settings \nWHERE name IN (\n  'work_mem', 'shared_buffers', 'effective_cache_size', \n  'random_page_cost', 'seq_page_cost', 'effective_io_concurrency',\n  'maintenance_work_mem', 'autovacuum_work_mem',\n  'max_parallel_workers_per_gather', 'max_worker_processes',\n  'checkpoint_completion_target', 'wal_buffers', 'min_wal_size', 'max_wal_size'\n);",
          action: "-- Memory settings (adjust for your server)\nSET work_mem = '256MB';                    -- For sorts/hashes per operation\nSET maintenance_work_mem = '1GB';          -- For VACUUM, CREATE INDEX\nSET shared_buffers = '4GB';                -- PostgreSQL cache (25% of RAM typical)\nSET effective_cache_size = '12GB';         -- Total system cache estimate (50-75% of RAM)\n\n-- Disk I/O settings (especially for SSDs)\nSET random_page_cost = 1.1;                -- Lower for SSDs (default 4.0 for HDD)\nSET seq_page_cost = 1.0;                   -- Usually keep at 1.0\nSET effective_io_concurrency = 200;        -- For SSDs (1-2 for HDD)\n\n-- Parallelism settings (PostgreSQL 9.6+)\nSET max_parallel_workers_per_gather = 4;  -- Parallel workers per query\nSET max_worker_processes = 8;              -- Total background workers\nSET parallel_setup_cost = 1000;            -- Lower to encourage parallelism\nSET parallel_tuple_cost = 0.1;             -- Lower to encourage parallelism\n\n-- WAL and checkpoint settings\nSET checkpoint_completion_target = 0.9;    -- Spread checkpoints over time\nSET wal_buffers = '16MB';                  -- WAL buffer size\nSET min_wal_size = '1GB';                  -- Minimum WAL size\nSET max_wal_size = '4GB';                  -- Maximum WAL size before checkpoint\n\n-- Make permanent in postgresql.conf:\n# work_mem = 256MB\n# maintenance_work_mem = 1GB\n# shared_buffers = 4GB\n# effective_cache_size = 12GB\n# random_page_cost = 1.1\n# effective_io_concurrency = 200\n# max_parallel_workers_per_gather = 4",
          warning: "⚠️ Changing configuration settings can impact server performance and stability. Test in non-production first and monitor resource usage. Some settings require PostgreSQL restart (shared_buffers, max_worker_processes).",
          guidance: [
            "💡 Memory Settings:",
            "• work_mem: Per-operation memory for sorts/hashes (default 4MB often too low)",
            "• maintenance_work_mem: For VACUUM, CREATE INDEX (larger = faster maintenance)",
            "• shared_buffers: PostgreSQL's cache (25% of RAM typical, 8GB max recommended)",
            "• effective_cache_size: Tells planner about OS cache (50-75% of total RAM)",
            "",
            "💡 Disk I/O Settings (critical for SSDs):",
            "• random_page_cost: 1.1 for SSD, 4.0 for HDD (default)",
            "• effective_io_concurrency: 200 for SSD, 1-2 for HDD",
            "",
            "💡 Parallelism (PostgreSQL 9.6+):",
            "• max_parallel_workers_per_gather: Workers per query (2-4 typical)",
            "• max_worker_processes: Total workers (CPU cores typical)",
            "• Lower parallel costs to encourage parallelism on large scans",
            "",
            "💡 WAL and Checkpoints:",
            "• checkpoint_completion_target: 0.9 spreads I/O over time",
            "• Larger WAL sizes reduce checkpoint frequency but use more disk",
            "",
            "⚙️ NOTE: All values are examples. Tune based on:",
            "• Available RAM (work_mem × max_connections must fit in RAM)",
            "• Storage type (SSD vs HDD dramatically affects page costs)",
            "• CPU cores (for parallelism settings)",
            "• Workload patterns (OLTP vs Analytics)",
            "",
            "🔧 Settings requiring restart: shared_buffers, max_worker_processes, wal_buffers",
            "🔧 Settings changeable per session: work_mem, random_page_cost, enable_* flags",
            "",
            "📊 Monitor impact with: pg_stat_database, pg_stat_bgwriter, pg_stat_progress_*"
          ]
        },
        {
          title: "Optimize Patterns",
          description: "Rewrite inefficient queries",
          examples: [
            { bad: "WHERE customer_id IN (SELECT...)", good: "JOIN customers c ON o.customer_id = c.id", why: "IN with subquery can't short-circuit; JOIN allows better optimization" },
            { bad: "WHERE DATE(created_at) = '2024-01-01'", good: "WHERE created_at >= '2024-01-01'\n  AND created_at < '2024-01-02'", why: "Function on column prevents index usage; range allows index seek" },
            { bad: "SELECT COUNT(*) FROM large_table\nWHERE status = 'active'", good: "SELECT reltuples::bigint\nFROM pg_class\nWHERE relname = 'large_table'", why: "Exact count scans entire table; approximate is instant from stats" },
            { bad: "SELECT DISTINCT column FROM table", good: "SELECT column FROM table\nGROUP BY column", why: "DISTINCT requires sort; GROUP BY can use indexes more efficiently" },
            { bad: "WHERE LOWER(email) = 'user@example.com'", good: "CREATE INDEX idx ON table(LOWER(email));\nWHERE LOWER(email) = 'user@example.com'", why: "Function prevents normal index use; expression index solves this" },
            { bad: "WHERE UPPER(name) = 'JOHN'", good: "WHERE name ILIKE 'john'", why: "UPPER() prevents index usage; ILIKE is case-insensitive and more efficient" },
            { bad: "SELECT * FROM orders\nWHERE amount > 1000 OR status = 'urgent'", good: "SELECT * FROM orders WHERE amount > 1000\nUNION\nSELECT * FROM orders WHERE status = 'urgent'", why: "OR prevents using multiple indexes; UNION allows index on each condition" }
          ],
          guidance: [
            "Replace IN with JOINs",
            "Avoid functions on indexed columns",
            "Use EXISTS instead of IN for large subqueries",
            "Create expression indexes for functions in WHERE clause",
            "Use ILIKE instead of UPPER()/LOWER() for case-insensitive searches"
          ]
        },
        {
          title: "Using CTEs Effectively",
          description: "When to use Common Table Expressions",
          examples: [
            { bad: "SELECT o.*, \n  (SELECT SUM(amount) FROM order_items WHERE order_id = o.id) as total,\n  (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count\nFROM orders o", good: "WITH order_totals AS (\n  SELECT order_id,\n    SUM(amount) as total,\n    COUNT(*) as item_count\n  FROM order_items\n  GROUP BY order_id\n)\nSELECT o.*, ot.total, ot.item_count\nFROM orders o\nJOIN order_totals ot ON o.id = ot.order_id", why: "Multiple correlated subqueries scan repeatedly; CTE scans once and joins" },
            { bad: "SELECT * FROM (\n  SELECT * FROM (\n    SELECT ... FROM table\n    WHERE ...\n  ) sub1\n  WHERE ...\n) sub2", good: "WITH step1 AS (\n  SELECT ... FROM table WHERE ...\n),\nstep2 AS (\n  SELECT ... FROM step1 WHERE ...\n)\nSELECT * FROM step2", why: "Nested subqueries are hard to read; CTEs provide clear logical steps" }
          ],
          guidance: [
            "✅ Use CTEs for: Improving readability, avoiding repeated subqueries, breaking complex logic into steps",
            "✅ Use CTEs when: Same subquery used multiple times, recursive queries needed, complex multi-step transformations",
            "❌ Avoid CTEs when: Simple queries (adds overhead), results could be a view, single-use subquery is simpler",
            "⚠️ Note: PostgreSQL doesn't always optimize CTEs away - consider MATERIALIZED or NOT MATERIALIZED hints",
            "💡 Tip: Use CTEs for development/readability, then optimize hotspots if needed"
          ]
        },
        {
          title: "Monitor Production",
          description: "Track slow queries",
          sql: "SELECT query, calls, mean_exec_time\nFROM pg_stat_statements\nORDER BY mean_exec_time DESC\nLIMIT 10;",
          guidance: [
            "Use pg_stat_statements extension",
            "Track performance over time"
          ]
        },
        {
          title: "Monitor Autovacuum and Table Bloat",
          description: "Check vacuum health and identify bloated tables",
          sql: "-- Check autovacuum activity and dead tuples\nSELECT \n    schemaname,\n    relname,\n    n_live_tup AS live_tuples,\n    n_dead_tup AS dead_tuples,\n    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_tuple_percent,\n    last_vacuum,\n    last_autovacuum,\n    last_analyze,\n    last_autoanalyze,\n    autovacuum_count,\n    autoanalyze_count\nFROM pg_stat_user_tables\nWHERE n_dead_tup > 1000\nORDER BY n_dead_tup DESC\nLIMIT 20;\n\n-- Estimate table bloat\nSELECT \n    schemaname,\n    tablename,\n    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,\n    ROUND(100 * pg_total_relation_size(schemaname||'.'||tablename) / \n          NULLIF(pg_database_size(current_database()), 0), 2) AS percent_of_db\nFROM pg_tables\nWHERE schemaname NOT IN ('pg_catalog', 'information_schema')\nORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC\nLIMIT 20;\n\n-- Check for long-running transactions blocking vacuum\nSELECT \n    pid,\n    now() - xact_start AS duration,\n    state,\n    query\nFROM pg_stat_activity\nWHERE state <> 'idle'\n    AND xact_start IS NOT NULL\nORDER BY xact_start\nLIMIT 10;\n\n-- View autovacuum configuration\nSELECT \n    name,\n    setting,\n    unit,\n    short_desc\nFROM pg_settings\nWHERE name LIKE 'autovacuum%'\n   OR name LIKE 'vacuum%'\nORDER BY name;",
          action: "-- Manual vacuum on specific table\nVACUUM ANALYZE table_name;\n\n-- Full vacuum to reclaim space (locks table!)\nVACUUM FULL table_name;\n\n-- Tune autovacuum for specific table\nALTER TABLE table_name SET (\n    autovacuum_vacuum_scale_factor = 0.05,  -- Vacuum at 5% dead tuples (default 20%)\n    autovacuum_analyze_scale_factor = 0.02, -- Analyze at 2% changes (default 10%)\n    autovacuum_vacuum_cost_delay = 10       -- Throttle vacuum to reduce I/O impact\n);\n\n-- Global autovacuum tuning (postgresql.conf)\n-- autovacuum_max_workers = 3              -- More workers for parallel vacuuming\n-- autovacuum_naptime = 30s                 -- Check for work every 30s (default 60s)\n-- autovacuum_vacuum_threshold = 50         -- Min dead tuples before vacuum\n-- autovacuum_vacuum_scale_factor = 0.1     -- Vacuum when 10% of table is dead\n-- autovacuum_vacuum_cost_limit = 2000      -- Higher = faster vacuum but more I/O",
          warning: "⚠️ VACUUM FULL locks the entire table exclusively and can take hours on large tables. Use only during maintenance windows. Regular VACUUM (non-FULL) is safe to run anytime and doesn't lock tables.",
          guidance: [
            "💡 Understanding Table Bloat:",
            "• Bloat = wasted space from UPDATE/DELETE operations",
            "• PostgreSQL uses MVCC (Multi-Version Concurrency Control)",
            "• UPDATEs create new row versions; old versions become 'dead tuples'",
            "• DELETEs mark rows as dead but don't immediately reclaim space",
            "• Autovacuum cleans up dead tuples and updates statistics",
            "",
            "💡 Bloat Symptoms:",
            "• High dead_tuple_percent (>20% is concerning)",
            "• Queries slowing down over time despite stable row counts",
            "• Disk usage growing without data growth",
            "• Sequential scans taking longer than expected",
            "",
            "💡 Autovacuum Monitoring:",
            "• last_autovacuum should be recent (within hours/days)",
            "• High dead tuple counts indicate autovacuum can't keep up",
            "• Long-running transactions prevent vacuum from cleaning up",
            "• autovacuum_count shows how often table is vacuumed",
            "",
            "💡 Tuning Autovacuum:",
            "• Decrease scale_factor for high-churn tables (0.05 = vacuum at 5% dead)",
            "• Increase max_workers for databases with many tables",
            "• Decrease naptime to check more frequently (careful with I/O)",
            "• Increase vacuum_cost_limit for faster vacuuming (uses more I/O)",
            "",
            "💡 When to Use VACUUM vs VACUUM FULL:",
            "• VACUUM: Regular maintenance, no locks, run anytime, reclaims space for reuse",
            "• VACUUM FULL: Major bloat (>50%), locks table, rewrites entire table, returns space to OS",
            "",
            "💡 Preventing Bloat:",
            "• Keep transactions short (long transactions block cleanup)",
            "• Tune autovacuum for write-heavy tables",
            "• Monitor pg_stat_user_tables regularly",
            "• Use HOT updates when possible (update indexed columns less)",
            "• Consider partitioning for very large tables",
            "",
            "📊 Monitor: pg_stat_user_tables, pg_stat_progress_vacuum, pg_stat_activity"
          ],
          checks: [
            { label: "Dead tuple percentage > 20%?", key: "highDeadTuples" },
            { label: "Last autovacuum > 7 days ago?", key: "staleVacuum" },
            { label: "Tables with >10GB size growing?", key: "largeTablesGrowing" },
            { label: "Long transactions (>1 hour) running?", key: "longTransactions" },
            { label: "Autovacuum not running on busy tables?", key: "noAutovacuum" }
          ]
        },
        {
          title: "Monitor Connection Pooling and Limits",
          description: "Check connection usage and identify connection issues",
          sql: "-- Check current connection counts by state\nSELECT \n    state,\n    COUNT(*) AS connection_count,\n    MAX(now() - state_change) AS max_idle_time\nFROM pg_stat_activity\nGROUP BY state\nORDER BY connection_count DESC;\n\n-- Check connection limits\nSELECT \n    setting AS max_connections,\n    (SELECT COUNT(*) FROM pg_stat_activity) AS current_connections,\n    setting::int - (SELECT COUNT(*) FROM pg_stat_activity) AS available_connections,\n    ROUND(100.0 * (SELECT COUNT(*) FROM pg_stat_activity) / setting::int, 2) AS percent_used\nFROM pg_settings\nWHERE name = 'max_connections';\n\n-- Identify idle connections\nSELECT \n    pid,\n    usename,\n    application_name,\n    client_addr,\n    state,\n    now() - state_change AS idle_time,\n    query\nFROM pg_stat_activity\nWHERE state = 'idle'\n    AND state_change < now() - interval '10 minutes'\nORDER BY state_change\nLIMIT 20;\n\n-- Check for idle in transaction (problematic)\nSELECT \n    pid,\n    usename,\n    application_name,\n    client_addr,\n    now() - xact_start AS transaction_age,\n    now() - state_change AS idle_time,\n    query\nFROM pg_stat_activity\nWHERE state IN ('idle in transaction', 'idle in transaction (aborted)')\nORDER BY xact_start\nLIMIT 20;\n\n-- Check connections by database and user\nSELECT \n    datname,\n    usename,\n    application_name,\n    COUNT(*) AS connection_count\nFROM pg_stat_activity\nGROUP BY datname, usename, application_name\nORDER BY connection_count DESC;",
          action: "-- Terminate idle connections (use carefully!)\nSELECT pg_terminate_backend(pid)\nFROM pg_stat_activity\nWHERE state = 'idle'\n    AND state_change < now() - interval '1 hour'\n    AND pid <> pg_backend_pid();\n\n-- Set connection limits per database\nALTER DATABASE your_database CONNECTION LIMIT 50;\n\n-- Set connection limits per user\nALTER ROLE your_user CONNECTION LIMIT 10;\n\n-- Set statement timeout to kill long-running queries\nSET statement_timeout = '5min';\n\n-- Set idle_in_transaction_session_timeout (PostgreSQL 9.6+)\nSET idle_in_transaction_session_timeout = '10min';\n\n-- Configuration for connection management (postgresql.conf)\n-- max_connections = 100                           -- Total connections allowed\n-- superuser_reserved_connections = 3              -- Connections reserved for superuser\n-- idle_in_transaction_session_timeout = 600000    -- 10 minutes in milliseconds\n-- statement_timeout = 300000                      -- 5 minutes in milliseconds\n-- tcp_keepalives_idle = 60                        -- Detect dead connections\n-- tcp_keepalives_interval = 10\n-- tcp_keepalives_count = 6",
          warning: "⚠️ Terminating connections will abort user transactions and may cause application errors. Always notify users before killing connections. Test timeout settings thoroughly as they affect all queries.",
          guidance: [
            "💡 Connection States:",
            "• active: Currently executing a query",
            "• idle: Connected but not in a transaction",
            "• idle in transaction: In transaction but not executing (BAD - holds locks!)",
            "• idle in transaction (aborted): Transaction failed, waiting for ROLLBACK",
            "",
            "💡 Connection Exhaustion Symptoms:",
            "• Applications getting 'too many connections' errors",
            "• Connection counts near max_connections limit",
            "• Many idle connections from connection leaks",
            "• Legitimate users unable to connect",
            "",
            "💡 Connection Pooling Benefits:",
            "• Reduces connection overhead (establishing connections is expensive)",
            "• Prevents connection exhaustion",
            "• Better resource utilization",
            "• Popular poolers: PgBouncer, Pgpool-II",
            "",
            "💡 PgBouncer Configuration:",
            "• Transaction pooling: Releases connection after each transaction (recommended)",
            "• Session pooling: Releases connection when client disconnects",
            "• pool_mode = transaction (most efficient)",
            "• default_pool_size = 25 (connections per user/database pair)",
            "",
            "💡 Idle in Transaction Issues:",
            "• Holds locks blocking other queries",
            "• Prevents VACUUM from cleaning up dead tuples",
            "• Often caused by application bugs (forgot to commit/rollback)",
            "• Set idle_in_transaction_session_timeout to auto-kill",
            "",
            "💡 Connection Limit Tuning:",
            "• Don't set max_connections too high (each connection uses RAM)",
            "• Formula: max_connections = (RAM - shared_buffers) / 10MB per connection",
            "• Better to use connection pooling than increase max_connections",
            "• Reserve connections for superuser (superuser_reserved_connections)",
            "",
            "💡 Best Practices:",
            "• Use connection pooling (PgBouncer) for high-connection applications",
            "• Set idle_in_transaction_session_timeout (10-30 minutes)",
            "• Set statement_timeout to prevent runaway queries",
            "• Monitor connection counts and states regularly",
            "• Close connections properly in application code",
            "• Use prepared statements to reduce parsing overhead",
            "",
            "📊 Monitor: pg_stat_activity, pg_settings (max_connections)"
          ],
          checks: [
            { label: "Connection usage > 80% of max_connections?", key: "highConnUsage" },
            { label: "Many idle in transaction connections?", key: "idleInTransaction" },
            { label: "Idle connections > 15 minutes old?", key: "longIdle" },
            { label: "Connection errors in logs?", key: "connectionErrors" },
            { label: "No connection pooling in use?", key: "noPooling" }
          ]
        },
        {
          title: "Identify Blocking and Lock Contention",
          description: "Find queries blocking others and lock conflicts",
          sql: "-- Find blocking queries\nSELECT \n    blocked_locks.pid AS blocked_pid,\n    blocked_activity.usename AS blocked_user,\n    blocking_locks.pid AS blocking_pid,\n    blocking_activity.usename AS blocking_user,\n    blocked_activity.query AS blocked_query,\n    blocking_activity.query AS blocking_query,\n    blocked_activity.application_name AS blocked_app,\n    blocking_activity.application_name AS blocking_app,\n    now() - blocked_activity.query_start AS blocked_duration\nFROM pg_catalog.pg_locks blocked_locks\nJOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid\nJOIN pg_catalog.pg_locks blocking_locks \n    ON blocking_locks.locktype = blocked_locks.locktype\n    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database\n    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation\n    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page\n    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple\n    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid\n    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid\n    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid\n    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid\n    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid\n    AND blocking_locks.pid != blocked_locks.pid\nJOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid\nWHERE NOT blocked_locks.granted\nORDER BY blocked_activity.query_start;\n\n-- View all locks by type\nSELECT \n    locktype,\n    relation::regclass AS table_name,\n    mode,\n    COUNT(*) AS lock_count,\n    ARRAY_AGG(DISTINCT pid) AS pids\nFROM pg_locks\nWHERE relation IS NOT NULL\nGROUP BY locktype, relation, mode\nORDER BY lock_count DESC;\n\n-- Check for lock waits\nSELECT \n    pid,\n    usename,\n    wait_event_type,\n    wait_event,\n    state,\n    query,\n    now() - query_start AS duration\nFROM pg_stat_activity\nWHERE wait_event IS NOT NULL\n    AND state = 'active'\nORDER BY query_start\nLIMIT 20;",
          action: "-- Terminate blocking query (use carefully!)\nSELECT pg_terminate_backend(blocking_pid);\n\n-- Cancel query without terminating connection\nSELECT pg_cancel_backend(pid);\n\n-- Set lock timeout to prevent indefinite waits\nSET lock_timeout = '5s';\n\n-- Set statement timeout\nSET statement_timeout = '30s';\n\n-- Use explicit locking when needed\nBEGIN;\nLOCK TABLE table_name IN ACCESS EXCLUSIVE MODE;\n-- Your operations here\nCOMMIT;",
          warning: "⚠️ Terminating or canceling queries will abort transactions and may cause application errors. Only use when necessary. Lock timeouts will cause queries to fail if locks can't be acquired.",
          guidance: [
            "💡 Understanding Locks:",
            "• PostgreSQL uses MVCC for most reads (no locks needed)",
            "• Locks occur during writes, DDL operations, and explicit LOCK commands",
            "• blocked_locks.granted = false means query is waiting for a lock",
            "• Long-running transactions hold locks longer",
            "",
            "💡 Lock Modes (least to most restrictive):",
            "• ACCESS SHARE: SELECT (doesn't conflict with most operations)",
            "• ROW SHARE: SELECT FOR UPDATE",
            "• ROW EXCLUSIVE: INSERT, UPDATE, DELETE",
            "• SHARE UPDATE EXCLUSIVE: VACUUM, CREATE INDEX CONCURRENTLY",
            "• SHARE: CREATE INDEX (locks out writes)",
            "• EXCLUSIVE: Refresh materialized views",
            "• ACCESS EXCLUSIVE: DDL operations (ALTER, DROP, TRUNCATE, VACUUM FULL)",
            "",
            "💡 Common Blocking Scenarios:",
            "• Long UPDATE/DELETE blocking other writes to same rows",
            "• ALTER TABLE blocking all access to table",
            "• CREATE INDEX (without CONCURRENTLY) blocking writes",
            "• VACUUM FULL blocking all access",
            "• Explicit LOCK TABLE commands",
            "",
            "💡 Reducing Lock Contention:",
            "• Keep transactions short and fast",
            "• Use CREATE INDEX CONCURRENTLY for index creation",
            "• Avoid LOCK TABLE unless absolutely necessary",
            "• Use smaller batches for large UPDATE/DELETE operations",
            "• Consider partitioning to reduce lock scope",
            "• Run DDL during maintenance windows",
            "",
            "💡 Wait Events:",
            "• Lock wait events indicate lock contention",
            "• LWLock = lightweight lock (internal PostgreSQL structures)",
            "• Common: BufferPin, LockManager, WALWrite",
            "• Monitor wait_event_type and wait_event columns",
            "",
            "📊 Monitor: pg_locks, pg_stat_activity (wait_event columns)"
          ],
          checks: [
            { label: "Queries blocked > 30 seconds?", key: "longBlocking" },
            { label: "ACCESS EXCLUSIVE locks on busy tables?", key: "exclusiveLocks" },
            { label: "Many lock waits in pg_stat_activity?", key: "lockWaits" },
            { label: "DDL operations during peak hours?", key: "peakDDL" },
            { label: "No lock_timeout configured?", key: "noLockTimeout" }
          ]
        }
      ],
      mysql: [
        {
          title: "Get Execution Plan",
          description: "Analyze query execution with EXPLAIN",
          sql: "EXPLAIN your_query_here;\n\nEXPLAIN FORMAT=TREE your_query_here;\n\nEXPLAIN ANALYZE your_query_here;",
          warning: "⚠️ EXPLAIN ANALYZE (MySQL 8.0.18+) actually executes the query! Be careful with INSERT/UPDATE/DELETE statements.",
          guidance: [
            "type column: 'system' > 'const' > 'eq_ref' > 'ref' > 'range' > 'index' > 'ALL' (best to worst)",
            "type='ALL' means full table scan (bad for large tables)",
            "Extra column: 'Using filesort' = expensive sort, 'Using temporary' = temp table needed",
            "rows column: Estimated rows examined (lower is better)",
            "filtered column: % of rows filtered by WHERE (higher is better)"
          ],
          checks: [
            { label: "type = ALL on tables >100k rows?", key: "tableScan" },
            { label: "Using filesort or Using temporary?", key: "tempSort" },
            { label: "High row count examined?", key: "highRows" },
            { label: "filtered < 10%?", key: "lowFilter" },
            { label: "key column is NULL (no index used)?", key: "noIndex" },
            { label: "Extra shows 'Using where' without index?", key: "whereNoIndex" }
          ]
        },
        {
          title: "Update Table Statistics",
          description: "Ensure optimizer has accurate statistics",
          sql: "SHOW TABLE STATUS LIKE 'table_name';\n\nSHOW INDEX FROM table_name;",
          action: "ANALYZE TABLE table_name;\n\nANALYZE TABLE table_name PERSISTENT FOR ALL;",
          warning: "⚠️ ANALYZE TABLE can lock the table briefly. On large tables, this may cause brief blocking.",
          guidance: [
            "Low or zero CARDINALITY indicates stale statistics",
            "Run ANALYZE TABLE after bulk inserts/updates/deletes (>10% rows)",
            "Check that cardinality reflects actual unique values"
          ]
        },
        {
          title: "Profile Query Execution",
          description: "Get detailed timing breakdown",
          sql: "SET profiling = 1;\nyour_query_here;\nSHOW PROFILES;\n\nSHOW PROFILE FOR QUERY 1;\nSHOW PROFILE CPU, BLOCK IO FOR QUERY 1;",
          guidance: [
            "Look for 'Sending data' - this is where most time should be",
            "High 'Creating tmp table' or 'Sorting result' indicates optimization opportunities",
            "Use Performance Schema for production (profiling is deprecated)"
          ]
        },
        {
          title: "Create Missing Indexes",
          description: "Add indexes based on query patterns",
          sql: "SELECT OBJECT_SCHEMA, OBJECT_NAME, INDEX_NAME,\n       COUNT_STAR as uses\nFROM performance_schema.table_io_waits_summary_by_index_usage\nWHERE OBJECT_SCHEMA = 'your_database'\nORDER BY COUNT_STAR DESC;",
          action: "-- Standard index creation (locks table)\nCREATE INDEX idx_name ON table_name(column_name);\n\n-- InnoDB online DDL (MySQL 5.6+) - allows reads/writes\nCREATE INDEX idx_name ON table_name(column_name) \n  ALGORITHM=INPLACE, LOCK=NONE;\n\n-- Multi-column index (leftmost prefix rule!)\nCREATE INDEX idx_name ON table_name(col1, col2, col3);\n\n-- Full-text index\nCREATE FULLTEXT INDEX idx_name ON table_name(text_col);",
          warning: "⚠️ CREATE INDEX locks the table during creation. On InnoDB tables (MySQL 5.6+), use ALGORITHM=INPLACE, LOCK=NONE to allow concurrent reads/writes (still has brief metadata locks at start/end).",
          guidance: [
            "Follow leftmost prefix rule: idx(a,b,c) works for a, a+b, a+b+c, but NOT b or c alone",
            "Use FORCE INDEX to test if index helps: FROM table FORCE INDEX(idx_name)",
            "Check for unused indexes to remove them",
            "InnoDB online DDL (ALGORITHM=INPLACE, LOCK=NONE) minimizes blocking but isn't completely lock-free",
            "LOCK=NONE will fail if the operation requires locks - fallback to LOCK=SHARED or default"
          ]
        },
        {
          title: "Optimize Join Performance",
          description: "Review join methods and buffer settings",
          sql: "SHOW VARIABLES LIKE 'join_buffer_size';",
          action: "SET SESSION join_buffer_size = 256M;\n\nSELECT STRAIGHT_JOIN ... FROM t1 JOIN t2;",
          warning: "⚠️ Changing join_buffer_size affects memory usage per connection. Monitor server memory and adjust carefully to avoid OOM issues.",
          guidance: [
            "Increase join_buffer_size",
            "MySQL uses nested loop joins primarily",
            "⚙️ NOTE: 256M is an example. Adjust join_buffer_size based on your available memory and query patterns."
          ]
        },
        {
          title: "Tune Memory and Configuration",
          description: "Adjust memory settings for better performance",
          sql: "SHOW VARIABLES LIKE 'tmp_table_size';\nSHOW GLOBAL STATUS LIKE 'Created_tmp%';",
          action: "SET SESSION tmp_table_size = 64M;\nSET SESSION max_heap_table_size = 64M;",
          warning: "⚠️ Increasing memory settings can lead to out-of-memory conditions if set too high. Monitor server resources and test changes carefully.",
          guidance: [
            "Increase tmp_table_size for temp tables",
            "Must match max_heap_table_size",
            "⚙️ NOTE: 64M is an example. Adjust memory settings based on your server's available RAM and concurrent connections."
          ]
        },
        {
          title: "Fix Anti-Patterns",
          description: "Avoid common mistakes",
          examples: [
            { bad: "WHERE col1 = 'A' OR col2 = 'B'", good: "WHERE col1 = 'A'\nUNION ALL\nSELECT ... WHERE col2 = 'B'", why: "OR can't use indexes on both columns; UNION uses index on each" },
            { bad: "WHERE DATE(created_at) = '2024-01-01'", good: "WHERE created_at >= '2024-01-01'\n  AND created_at < '2024-01-02'", why: "DATE() function forces table scan; range uses index" },
            { bad: "WHERE name LIKE '%smith%'", good: "CREATE FULLTEXT INDEX idx ON table(name);\nWHERE MATCH(name) AGAINST('smith')", why: "Leading wildcard can't use B-tree index; FULLTEXT enables search" },
            { bad: "SELECT * FROM orders\nORDER BY created_at DESC\nLIMIT 1000, 10", good: "WHERE id > @last_id\nORDER BY id LIMIT 10", why: "Large OFFSET scans all skipped rows; cursor seeks directly" },
            { bad: "WHERE id IN (1,2,3...1000)", good: "CREATE TEMPORARY TABLE temp_ids (id INT);\nINSERT INTO temp_ids VALUES (1),(2),(3);\nJOIN temp_ids ON table.id = temp_ids.id", why: "Large IN list causes parse overhead; temp table optimizes better" },
            { bad: "SELECT * FROM table\nWHERE status != 'deleted'", good: "WHERE status IN ('active', 'pending', 'complete')", why: "!= can't use index efficiently; IN with known values uses index" },
            { bad: "WHERE YEAR(order_date) = 2024\n  AND MONTH(order_date) = 1", good: "WHERE order_date >= '2024-01-01'\n  AND order_date < '2024-02-01'", why: "Functions prevent index usage; range comparison uses index" },
            { bad: "WHERE UPPER(name) = 'JOHN'", good: "WHERE name LIKE 'john'", why: "UPPER() prevents index usage; LIKE is case-insensitive by default in MySQL" }
          ],
          guidance: [
            "OR prevents index usage - use UNION instead",
            "Avoid functions on indexed columns",
            "Leading wildcards can't use indexes",
            "Use cursor pagination instead of OFFSET for large datasets",
            "Prefer positive conditions over NOT/!= when possible",
            "LIKE is case-insensitive by default (depends on collation)"
          ]
        },
        {
          title: "Using CTEs Effectively",
          description: "When to use Common Table Expressions",
          examples: [
            { bad: "SELECT p.*,\n  (SELECT COUNT(*) FROM orders WHERE product_id = p.id) as order_count,\n  (SELECT SUM(quantity) FROM orders WHERE product_id = p.id) as total_qty\nFROM products p", good: "WITH product_stats AS (\n  SELECT product_id,\n    COUNT(*) as order_count,\n    SUM(quantity) as total_qty\n  FROM orders\n  GROUP BY product_id\n)\nSELECT p.*, ps.order_count, ps.total_qty\nFROM products p\nLEFT JOIN product_stats ps ON p.id = ps.product_id", why: "Correlated subqueries execute per row; CTE scans once and joins" },
            { bad: "SELECT * FROM (\n  SELECT * FROM (\n    SELECT * FROM table WHERE ...\n  ) a WHERE ...\n) b WHERE ...", good: "WITH filtered AS (\n  SELECT * FROM table WHERE ...\n),\nrefined AS (\n  SELECT * FROM filtered WHERE ...\n)\nSELECT * FROM refined WHERE ...", why: "Nested queries obscure logic; CTEs show clear progression" }
          ],
          guidance: [
            "✅ Use CTEs for: Readability, eliminating duplicate subqueries, multi-step transformations",
            "✅ Use CTEs when: Same calculation needed multiple times, recursive operations, complex business logic",
            "❌ Avoid CTEs when: Simple single-use subquery, adding unnecessary complexity",
            "⚠️ MySQL note: CTEs always materialized until 8.0.16 - may impact performance on large datasets",
            "💡 Tip: CTEs excellent for development clarity; profile performance on production data"
          ]
        },
        {
          title: "Monitor InnoDB Buffer Pool Efficiency",
          description: "Check InnoDB buffer pool hit ratio and memory usage",
          sql: "-- Check buffer pool hit ratio\nSHOW ENGINE INNODB STATUS\\G\n\n-- Buffer pool statistics\nSELECT \n    (1 - (Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests)) * 100 AS buffer_pool_hit_ratio,\n    Innodb_buffer_pool_read_requests AS read_requests,\n    Innodb_buffer_pool_reads AS disk_reads,\n    Innodb_buffer_pool_size / (1024 * 1024 * 1024) AS buffer_pool_size_gb,\n    Innodb_buffer_pool_pages_data AS pages_with_data,\n    Innodb_buffer_pool_pages_free AS free_pages,\n    Innodb_buffer_pool_pages_total AS total_pages,\n    ROUND((Innodb_buffer_pool_pages_data / Innodb_buffer_pool_pages_total) * 100, 2) AS buffer_pool_utilization\nFROM (\n    SELECT \n        VARIABLE_VALUE AS Innodb_buffer_pool_reads\n    FROM performance_schema.global_status \n    WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads'\n) reads,\n(\n    SELECT \n        VARIABLE_VALUE AS Innodb_buffer_pool_read_requests\n    FROM performance_schema.global_status \n    WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'\n) requests,\n(\n    SELECT \n        VARIABLE_VALUE AS Innodb_buffer_pool_size\n    FROM performance_schema.global_variables \n    WHERE VARIABLE_NAME = 'innodb_buffer_pool_size'\n) size,\n(\n    SELECT \n        VARIABLE_VALUE AS Innodb_buffer_pool_pages_data\n    FROM performance_schema.global_status \n    WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_data'\n) data_pages,\n(\n    SELECT \n        VARIABLE_VALUE AS Innodb_buffer_pool_pages_free\n    FROM performance_schema.global_status \n    WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_free'\n) free,\n(\n    SELECT \n        VARIABLE_VALUE AS Innodb_buffer_pool_pages_total\n    FROM performance_schema.global_status \n    WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_total'\n) total;\n\n-- Check buffer pool usage by table\nSELECT \n    object_schema AS database_name,\n    object_name AS table_name,\n    COUNT(*) AS cached_pages,\n    ROUND(SUM(IF(compressed_size = 0, 16384, compressed_size)) / 1024 / 1024, 2) AS cached_mb\nFROM information_schema.innodb_buffer_page\nWHERE object_schema IS NOT NULL\n    AND object_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')\nGROUP BY object_schema, object_name\nORDER BY cached_pages DESC\nLIMIT 20;",
          action: "-- Increase buffer pool size (set in my.cnf/my.ini)\n-- innodb_buffer_pool_size = 8G  -- Typically 70-80% of available RAM\n\n-- Set dynamically (MySQL 5.7.5+)\nSET GLOBAL innodb_buffer_pool_size = 8589934592;  -- 8GB in bytes\n\n-- Multiple buffer pool instances for concurrency (8+ GB pools)\n-- innodb_buffer_pool_instances = 8  -- 1 instance per GB recommended\n\n-- Check current settings\nSHOW VARIABLES LIKE 'innodb_buffer_pool%';",
          warning: "⚠️ Changing innodb_buffer_pool_size dynamically can cause brief performance degradation during resize. Best done during low-traffic periods. Requires sufficient free memory.",
          guidance: [
            "💡 Buffer Pool Hit Ratio:",
            "• Hit ratio = % of reads served from memory (not disk)",
            "• Target: >99% for OLTP, >95% acceptable for mixed workloads",
            "• <95% indicates buffer pool too small or working set too large",
            "• Low ratio = frequent disk I/O = slow queries",
            "",
            "💡 Buffer Pool Sizing:",
            "• Typical: 70-80% of available RAM for dedicated database server",
            "• Leave RAM for OS, connections, query execution, temp tables",
            "• Formula: (Total RAM × 0.7) - 1GB for OS",
            "• Example: 16GB server = ~10-11GB buffer pool",
            "• Shared server: Reduce percentage accordingly",
            "",
            "💡 Buffer Pool Instances:",
            "• Multiple instances reduce contention (MySQL 5.5+)",
            "• Recommended: 1 instance per GB of buffer pool (8+ instances max)",
            "• Example: 8GB buffer pool = 8 instances of 1GB each",
            "• Only beneficial for pools >1GB",
            "",
            "💡 Monitoring Indicators:",
            "• Innodb_buffer_pool_reads: Disk reads (lower is better)",
            "• Innodb_buffer_pool_read_requests: Total read requests",
            "• pages_data / pages_total: Buffer pool utilization",
            "• High utilization (>80%) with low hit ratio = increase size",
            "",
            "💡 Improving Cache Hit Ratio:",
            "• Increase buffer pool size (most effective)",
            "• Optimize queries to access less data",
            "• Add indexes to reduce full table scans",
            "• Partition large tables to reduce working set",
            "• Schedule batch jobs during off-peak hours",
            "",
            "📊 Monitor: SHOW ENGINE INNODB STATUS, performance_schema.global_status"
          ],
          checks: [
            { label: "Buffer pool hit ratio < 95%?", key: "lowHitRatio" },
            { label: "Buffer pool utilization > 90%?", key: "highUtilization" },
            { label: "Frequent disk reads (high Innodb_buffer_pool_reads)?", key: "frequentDiskReads" },
            { label: "Buffer pool size < 70% of RAM?", key: "undersizedPool" },
            { label: "Large tables not fully cached?", key: "uncachedTables" }
          ]
        },
        {
          title: "Monitor Replication Lag",
          description: "Check replica lag and replication health",
          sql: "-- Check replication status (on replica)\nSHOW REPLICA STATUS\\G  -- MySQL 8.0.22+\n-- OR\nSHOW SLAVE STATUS\\G    -- Older versions\n\n-- Quick lag check (on replica)\nSELECT \n    CASE \n        WHEN Seconds_Behind_Master IS NULL THEN 'Replication not running'\n        WHEN Seconds_Behind_Master = 0 THEN 'No lag'\n        WHEN Seconds_Behind_Master < 10 THEN 'Minimal lag (<10s)'\n        WHEN Seconds_Behind_Master < 60 THEN 'Moderate lag (<1min)'\n        ELSE 'Significant lag (>1min)'\n    END AS lag_status,\n    Seconds_Behind_Master AS seconds_behind,\n    Slave_IO_Running AS io_thread,\n    Slave_SQL_Running AS sql_thread,\n    Last_Error AS last_error\nFROM (\n    SELECT \n        CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(result, '\\n', ','), 'Seconds_Behind_Master: ', -1), ',', 1) AS UNSIGNED) AS Seconds_Behind_Master,\n        SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(result, '\\n', ','), 'Slave_IO_Running: ', -1), ',', 1) AS Slave_IO_Running,\n        SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(result, '\\n', ','), 'Slave_SQL_Running: ', -1), ',', 1) AS Slave_SQL_Running,\n        SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(result, '\\n', ','), 'Last_Error: ', -1), ',', 1) AS Last_Error\n    FROM (\n        SELECT GROUP_CONCAT(info SEPARATOR '\\n') AS result\n        FROM (\n            SELECT CONCAT(Field, ': ', Value) AS info\n            FROM information_schema.processlist\n            WHERE Command = 'Binlog Dump'\n            LIMIT 1\n        ) t\n    ) status\n) parsed;\n\n-- Check binlog position on source\nSHOW MASTER STATUS;\n\n-- View replication events (MySQL 8.0.22+)\nSELECT \n    CHANNEL_NAME,\n    SERVICE_STATE,\n    LAST_ERROR_NUMBER,\n    LAST_ERROR_MESSAGE,\n    LAST_ERROR_TIMESTAMP\nFROM performance_schema.replication_connection_status;\n\n-- Monitor relay log space\nSHOW VARIABLES LIKE 'relay_log_space_limit';",
          action: "-- Start replication\nSTART REPLICA;  -- MySQL 8.0.22+\n-- OR\nSTART SLAVE;    -- Older versions\n\n-- Stop replication\nSTOP REPLICA;\n\n-- Skip problematic transaction (use carefully!)\nSTOP REPLICA;\nSET GLOBAL sql_slave_skip_counter = 1;\nSTART REPLICA;\n\n-- Reset replica to specific position\nSTOP REPLICA;\nCHANGE MASTER TO\n    MASTER_LOG_FILE = 'mysql-bin.000123',\n    MASTER_LOG_POS = 4567890;\nSTART REPLICA;\n\n-- Optimize replication performance\n-- In my.cnf/my.ini on replica:\n-- slave_parallel_workers = 4              -- Parallel replication threads\n-- slave_parallel_type = LOGICAL_CLOCK    -- MySQL 5.7+\n-- slave_preserve_commit_order = ON       -- Maintain consistency\n-- sync_binlog = 0                        -- On replica only (faster)\n-- innodb_flush_log_at_trx_commit = 2     -- On replica only (faster)",
          warning: "⚠️ Skipping transactions can cause data inconsistency. Only skip after understanding the error. Changing replication settings requires careful testing. Never disable sync_binlog or innodb_flush_log_at_trx_commit on source.",
          guidance: [
            "💡 Understanding Replication Lag:",
            "• Lag = time difference between source writes and replica applying them",
            "• Seconds_Behind_Master shows lag in seconds (NULL = not replicating)",
            "• Lag impacts: Stale reads on replica, delayed failover, reporting inaccuracy",
            "",
            "💡 Common Causes of Lag:",
            "• Heavy write load on source overwhelming single-threaded replica",
            "• Long-running transactions on source",
            "• Replica hardware slower than source",
            "• Network latency between source and replica",
            "• Replica also serving read queries (resource contention)",
            "• Large transactions (bulk INSERT/UPDATE/DELETE)",
            "",
            "💡 Replication Thread Health:",
            "• Slave_IO_Running: Should be 'Yes' (fetching binlog from source)",
            "• Slave_SQL_Running: Should be 'Yes' (applying events to replica)",
            "• Both must be 'Yes' for replication to work",
            "• Check Last_Error for problems if either is 'No'",
            "",
            "💡 Reducing Replication Lag:",
            "• Enable parallel replication (slave_parallel_workers > 1)",
            "• Use LOGICAL_CLOCK parallel type (MySQL 5.7+)",
            "• Upgrade replica hardware to match source",
            "• Reduce read load on replica (use read replicas)",
            "• Optimize source queries to reduce write volume",
            "• Use row-based replication for better parallelism",
            "",
            "💡 Parallel Replication (MySQL 5.7+):",
            "• slave_parallel_workers: Set to number of CPU cores (4-16 typical)",
            "• slave_parallel_type = LOGICAL_CLOCK: Best for MySQL 5.7+",
            "• slave_parallel_type = DATABASE: Parallel at database level",
            "• slave_preserve_commit_order = ON: Maintains consistency",
            "",
            "💡 Monitoring Best Practices:",
            "• Alert on lag >10 seconds for critical systems",
            "• Monitor IO_Running and SQL_Running threads",
            "• Check Last_Error regularly for issues",
            "• Track relay_log_space to prevent disk full",
            "• Monitor binlog position drift between source and replica",
            "",
            "📊 Monitor: SHOW REPLICA STATUS, performance_schema.replication_*"
          ],
          checks: [
            { label: "Seconds_Behind_Master > 10 seconds?", key: "replicationLag" },
            { label: "IO or SQL thread not running?", key: "threadDown" },
            { label: "Last_Error is not empty?", key: "replicationError" },
            { label: "Parallel replication not enabled?", key: "noParallelReplication" },
            { label: "Relay log space running low?", key: "relayLogSpace" }
          ]
        }
      ],
      oracle: [
        {
          title: "Get Execution Plan with Statistics",
          description: "Generate and view the actual execution plan",
          sql: "EXPLAIN PLAN FOR\nyour_query_here;\n\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY());\n\n-- OR use SQL Monitor\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'));",
          warning: "EXPLAIN PLAN is safe, but DISPLAY_CURSOR requires the query to have been executed recently.",
          guidance: [
            "Look for high 'Cost' values in the execution plan",
            "Check 'Rows' (estimated) vs 'A-Rows' (actual) - mismatches indicate bad statistics",
            "TABLE ACCESS FULL on large tables is a red flag",
            "High 'A-Time' (actual time) shows bottlenecks"
          ],
          checks: [
            { label: "Execution cost > 10000?", key: "highCost" },
            { label: "Row estimates way off (E-Rows vs A-Rows)?", key: "badEstimates" },
            { label: "Full table scan on large tables?", key: "fullScan" },
            { label: "Cartesian join in plan?", key: "cartesian" },
            { label: "TABLE ACCESS FULL on tables >100k rows?", key: "largeScan" },
            { label: "High A-Time (actual time) values?", key: "highTime" }
          ]
        },
        {
          title: "Gather Fresh Statistics",
          description: "Update optimizer statistics for accurate plans",
          sql: "SELECT table_name, last_analyzed, num_rows\nFROM user_tables\nWHERE table_name IN ('TABLE1', 'TABLE2')\nORDER BY last_analyzed;",
          action: "EXEC DBMS_STATS.GATHER_TABLE_STATS(\n  ownname => 'SCHEMA_NAME',\n  tabname => 'TABLE_NAME',\n  estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,\n  method_opt => 'FOR ALL COLUMNS SIZE AUTO',\n  cascade => TRUE\n);",
          warning: "⚠️ GATHER_TABLE_STATS can lock tables briefly and consume resources. Run during maintenance windows on large tables.",
          guidance: [
            "Stale statistics cause poor execution plans",
            "Use CASCADE => TRUE to gather index stats too",
            "AUTO_SAMPLE_SIZE lets Oracle determine sample size",
            "Gather stats after significant data changes (>10% rows)"
          ]
        },
        {
          title: "Identify Missing Indexes",
          description: "Find opportunities for new indexes",
          sql: "SELECT sql_text, executions, \n       disk_reads, buffer_gets\nFROM v$sql\nWHERE sql_text LIKE '%YOUR_TABLE%'\n  AND sql_text NOT LIKE '%v$sql%'\nORDER BY disk_reads DESC;",
          action: "CREATE INDEX idx_name ON table_name(column_name);\n\nCREATE BITMAP INDEX idx_name ON table_name(status_column);",
          warning: "⚠️ CREATE INDEX locks the table and can take significant time on large tables. Consider ONLINE keyword or run during maintenance.",
          guidance: [
            "High disk_reads with full scans suggests missing indexes",
            "Composite index column order: equality filters first, then range filters",
            "Bitmap indexes good for low cardinality (few distinct values)",
            "Function-based indexes for WHERE UPPER(col) or other functions"
          ]
        },
        {
          title: "Analyze Join Operations",
          description: "Review join methods and efficiency",
          sql: "SELECT * FROM TABLE(\n  DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST')\n);",
          guidance: [
            "NESTED LOOPS: Good for small datasets or with indexes on join columns",
            "HASH JOIN: Good for large datasets, requires memory (PGA)",
            "MERGE JOIN: Good when both inputs are sorted",
            "CARTESIAN: Usually bad - missing join condition",
            "Check 'A-Rows' - if way higher than 'E-Rows', statistics are stale"
          ],
          checks: [
            { label: "Cartesian join present?", key: "cartesianJoin" },
            { label: "Hash join running out of memory?", key: "hashMemory" },
            { label: "Nested loop with many iterations?", key: "nestedLoop" }
          ]
        },
        {
          title: "Check SQL Area and Memory",
          description: "Review memory usage and shared pool",
          sql: "SELECT name, value/1024/1024 as mb\nFROM v$pgastat\nWHERE name IN ('total PGA allocated', 'maximum PGA allocated');",
          action: "ALTER SYSTEM SET pga_aggregate_target = 2G SCOPE=BOTH;",
          warning: "⚠️ Changing PGA settings affects overall database memory. Monitor system memory usage and adjust carefully to avoid resource contention.",
          guidance: [
            "High disk_reads indicate insufficient memory",
            "PGA memory used for sorts and hash joins",
            "buffer_gets shows logical I/O (lower is better)",
            "Consider partitioning very large tables",
            "⚙️ NOTE: 2G is an example. Adjust PGA based on your server's available memory and workload."
          ]
        },
        {
          title: "Use Optimizer Hints Strategically",
          description: "Guide the optimizer when it chooses poorly",
          sql: "SELECT /*+ FULL(t) */ * FROM table_name t WHERE ...;\nSELECT /*+ INDEX(t idx_name) */ * FROM table_name t WHERE ...;",
          guidance: [
            "FULL(table): Force full table scan",
            "INDEX(table index): Force index usage",
            "USE_NL: Force nested loops join",
            "USE_HASH: Force hash join",
            "USE_MERGE: Force merge join",
            "PARALLEL(table degree): Enable parallel execution",
            "Use hints only when optimizer consistently chooses wrong plan"
          ]
        },
        {
          title: "Review and Fix Common Anti-Patterns",
          description: "Avoid patterns that prevent optimization",
          examples: [
            { bad: "WHERE UPPER(name) = 'JOHN'", good: "CREATE INDEX idx_upper_name ON table(UPPER(name));\nWHERE UPPER(name) = 'JOHN'", why: "Function on column prevents index usage; function-based index enables it" },
            { bad: "WHERE col1 = 'A' OR col2 = 'B'", good: "WHERE col1 = 'A'\nUNION ALL\nSELECT ... WHERE col2 = 'B'", why: "OR can't use indexes on both columns; UNION uses index on each" },
            { bad: "WHERE TO_CHAR(date_col) = '2024-01-01'", good: "WHERE date_col = TO_DATE('2024-01-01', 'YYYY-MM-DD')", why: "TO_CHAR prevents index usage; direct date comparison uses index" },
            { bad: "WHERE column_name IS NOT NULL", good: "WHERE column_name > '' -- for strings\nWHERE column_name > 0  -- for numbers", why: "IS NOT NULL can't use standard index efficiently; comparison can" }
          ],
          guidance: [
            "Avoid functions on indexed columns (use function-based indexes)",
            "OR conditions often prevent index usage",
            "Use bind variables to prevent hard parsing",
            "Avoid implicit type conversions",
            "Use EXISTS instead of IN with subqueries for better performance"
          ]
        },
        {
          title: "Using CTEs (WITH Clause) Effectively",
          description: "When to use Common Table Expressions in Oracle",
          examples: [
            { bad: "SELECT d.*,\n  (SELECT COUNT(*) FROM employees WHERE department_id = d.id) as emp_count\nFROM departments d", good: "WITH dept_stats AS (\n  SELECT department_id,\n    COUNT(*) as emp_count\n  FROM employees\n  GROUP BY department_id\n)\nSELECT d.*, ds.emp_count\nFROM departments d\nLEFT JOIN dept_stats ds ON d.id = ds.department_id", why: "Correlated subqueries execute per row; CTE aggregates once then joins" }
          ],
          guidance: [
            "✅ Use CTEs for: Recursive queries, improving readability, factoring out complex subqueries",
            "⚠️ Oracle 12c+: CTEs support recursive queries",
            "💡 Tip: CTEs can be materialized with MATERIALIZE hint or inlined with INLINE hint for tuning"
          ]
        },
        {
          title: "Analyze Wait Events",
          description: "Identify database bottlenecks using wait event analysis",
          sql: "-- Top wait events currently\nSELECT \n    event,\n    total_waits,\n    time_waited / 100 AS time_waited_sec,\n    average_wait / 100 AS avg_wait_sec,\n    wait_class\nFROM v$system_event\nWHERE wait_class != 'Idle'\nORDER BY time_waited DESC\nFETCH FIRST 20 ROWS ONLY;\n\n-- Active sessions and their wait events\nSELECT \n    s.sid,\n    s.serial#,\n    s.username,\n    s.status,\n    s.event,\n    s.wait_class,\n    s.seconds_in_wait,\n    s.state,\n    q.sql_text\nFROM v$session s\nLEFT JOIN v$sql q ON s.sql_id = q.sql_id\nWHERE s.status = 'ACTIVE'\n    AND s.username IS NOT NULL\nORDER BY s.seconds_in_wait DESC;\n\n-- Wait event history (requires Diagnostics Pack)\nSELECT \n    event_name,\n    wait_class,\n    total_waits,\n    time_waited_micro / 1000000 AS time_waited_sec,\n    (time_waited_micro / total_waits) / 1000 AS avg_wait_ms\nFROM dba_hist_system_event\nWHERE snap_id = (SELECT MAX(snap_id) FROM dba_hist_snapshot)\n    AND wait_class != 'Idle'\nORDER BY time_waited_micro DESC\nFETCH FIRST 20 ROWS ONLY;\n\n-- Session wait statistics\nSELECT \n    sw.sid,\n    s.username,\n    sw.event,\n    sw.total_waits,\n    sw.time_waited / 100 AS time_waited_sec,\n    sw.average_wait / 100 AS avg_wait_sec\nFROM v$session_wait sw\nJOIN v$session s ON sw.sid = s.sid\nWHERE s.username IS NOT NULL\n    AND sw.event NOT LIKE 'SQL*Net%'\nORDER BY sw.time_waited DESC;",
          action: "-- Kill blocking session (use carefully!)\nALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE;\n\n-- Tune specific wait events:\n-- For 'db file sequential read' (single block reads):\n-- Add indexes, improve query selectivity\n\n-- For 'db file scattered read' (multi-block reads / full scans):\n-- Add indexes to avoid full table scans\n-- Increase DB_FILE_MULTIBLOCK_READ_COUNT\n\n-- For 'log file sync' (commit waits):\n-- Move redo logs to faster storage\n-- Reduce commit frequency (batch commits)\n-- Increase LOG_BUFFER size\n\n-- For 'enqueue' waits (locks):\n-- Identify blocking sessions and resolve contention\n-- Shorten transaction times\n-- Review application logic\n\n-- For 'latch' waits:\n-- Reduce hard parsing (use bind variables)\n-- Tune shared pool and library cache",
          warning: "⚠️ Killing sessions will abort user transactions. Use only when necessary. Configuration changes should be tested thoroughly before production use.",
          guidance: [
            "💡 Understanding Wait Events:",
            "• Wait events show where database spends time when not executing SQL",
            "• High time_waited indicates bottleneck in that area",
            "• wait_class groups related events (User I/O, System I/O, Concurrency, etc.)",
            "• Focus on events with high total time, not just high wait count",
            "",
            "💡 Common Wait Events:",
            "• db file sequential read: Single block I/O (index reads, table access by ROWID)",
            "• db file scattered read: Multi-block I/O (full table scans)",
            "• log file sync: Waiting for redo log writes to complete (commits)",
            "• enqueue waits: Lock contention (TX = row locks, TM = table locks)",
            "• latch waits: Internal Oracle structure contention",
            "• buffer busy waits: Multiple sessions trying to access same buffer",
            "• library cache latch: Hard parsing, SQL sharing issues",
            "",
            "💡 Wait Event Analysis:",
            "• time_waited = total time spent waiting (most important metric)",
            "• average_wait = avg time per wait (helps identify severity)",
            "• total_waits = frequency of waits",
            "• High time + low avg wait = many short waits (I/O throughput issue)",
            "• High time + high avg wait = fewer long waits (I/O latency issue)",
            "",
            "💡 Resolving I/O Wait Events:",
            "• db file sequential read: Add indexes, tune queries, faster storage",
            "• db file scattered read: Add indexes to avoid scans, partition tables",
            "• log file sync: Move redo to fast storage (SSD), batch commits",
            "• direct path read/write: Parallel queries, sort operations",
            "",
            "💡 Resolving Concurrency Wait Events:",
            "• enqueue TX: Row lock contention (shorten transactions, avoid hot rows)",
            "• enqueue TM: Table lock contention (use ROW locks, avoid DDL)",
            "• latch: shared pool/library cache (use bind variables, tune cursors)",
            "• buffer busy waits: Hot blocks (reverse key indexes, hash partitioning)",
            "",
            "💡 Best Practices:",
            "• Monitor wait events regularly (baseline normal vs. problem periods)",
            "• Focus on top 5-10 wait events by time_waited",
            "• Use AWR/ADDM reports for historical analysis",
            "• Correlate wait events with application behavior",
            "• Some waits are normal (focus on abnormal spikes)",
            "",
            "📊 Monitor: v$system_event, v$session_event, v$session_wait, dba_hist_system_event"
          ],
          checks: [
            { label: "High db file sequential read waits?", key: "sequentialReadWaits" },
            { label: "High db file scattered read waits?", key: "scatteredReadWaits" },
            { label: "High log file sync waits?", key: "logSyncWaits" },
            { label: "Enqueue or latch contention?", key: "concurrencyWaits" },
            { label: "Sessions waiting > 10 seconds?", key: "longWaits" }
          ]
        },
        {
          title: "Monitor Temp Tablespace Usage",
          description: "Check temporary tablespace for sort/hash operations",
          sql: "-- Check temp tablespace usage by session\nSELECT \n    s.sid,\n    s.serial#,\n    s.username,\n    s.osuser,\n    s.program,\n    t.tablespace,\n    t.blocks * (SELECT block_size FROM dba_tablespaces WHERE tablespace_name = t.tablespace) / 1024 / 1024 AS temp_mb,\n    q.sql_text\nFROM v$tempseg_usage t\nJOIN v$session s ON t.session_addr = s.saddr\nLEFT JOIN v$sql q ON s.sql_id = q.sql_id\nORDER BY temp_mb DESC;\n\n-- Check temp tablespace size and free space\nSELECT \n    tablespace_name,\n    tablespace_size / 1024 / 1024 AS total_mb,\n    allocated_space / 1024 / 1024 AS allocated_mb,\n    free_space / 1024 / 1024 AS free_mb,\n    ROUND((allocated_space / tablespace_size) * 100, 2) AS used_percent\nFROM dba_temp_free_space;\n\n-- Check temp file locations and sizes\nSELECT \n    file_name,\n    tablespace_name,\n    bytes / 1024 / 1024 AS size_mb,\n    maxbytes / 1024 / 1024 AS max_size_mb,\n    autoextensible,\n    status\nFROM dba_temp_files\nORDER BY tablespace_name, file_name;\n\n-- Queries causing high temp usage\nSELECT \n    sql_id,\n    SUBSTR(sql_text, 1, 100) AS sql_text_preview,\n    executions,\n    disk_reads,\n    buffer_gets,\n    sorts,\n    temp_space_mb\nFROM (\n    SELECT \n        sql_id,\n        sql_text,\n        executions,\n        disk_reads,\n        buffer_gets,\n        sorts,\n        ROUND(temp_space / 1024 / 1024, 2) AS temp_space_mb\n    FROM v$sql\n    WHERE temp_space > 0\n    ORDER BY temp_space DESC\n)\nFETCH FIRST 20 ROWS ONLY;",
          action: "-- Add tempfile to temp tablespace\nALTER TABLESPACE TEMP ADD TEMPFILE \n    '/path/to/temp02.dbf' \n    SIZE 1G \n    AUTOEXTEND ON \n    NEXT 100M \n    MAXSIZE 10G;\n\n-- Resize existing tempfile\nALTER DATABASE TEMPFILE '/path/to/temp01.dbf' RESIZE 5G;\n\n-- Enable autoextend\nALTER DATABASE TEMPFILE '/path/to/temp01.dbf' \n    AUTOEXTEND ON \n    NEXT 100M \n    MAXSIZE 10G;\n\n-- Kill session using excessive temp space\nALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE;\n\n-- Tune PGA for better in-memory sorts/hashes\nALTER SYSTEM SET pga_aggregate_target = 4G SCOPE=BOTH;\nALTER SYSTEM SET workarea_size_policy = AUTO SCOPE=BOTH;",
          warning: "⚠️ Adding or resizing tempfiles can impact performance briefly. Ensure sufficient disk space before adding files. Killing sessions will abort user transactions.",
          guidance: [
            "💡 Understanding Temp Tablespace:",
            "• Used for sorts, hash joins, temp tables, index creation",
            "• Sorts/hashes first try to use PGA memory",
            "• When PGA insufficient, operations spill to temp tablespace",
            "• High temp usage indicates memory pressure or inefficient queries",
            "",
            "💡 Temp Usage Symptoms:",
            "• Queries using excessive temp space (>1GB per query)",
            "• Temp tablespace growing quickly or filling up",
            "• 'direct path write temp' or 'direct path read temp' waits",
            "• ORA-01652: unable to extend temp segment errors",
            "",
            "💡 Common Causes:",
            "• Large sorts (ORDER BY on millions of rows without index)",
            "• Hash joins on large datasets",
            "• Group by operations on many rows",
            "• Distinct operations on large result sets",
            "• CREATE INDEX on large tables",
            "• Analytic functions (RANK, ROW_NUMBER, etc.)",
            "• Insufficient PGA memory for workarea operations",
            "",
            "💡 Reducing Temp Usage:",
            "• Increase PGA_AGGREGATE_TARGET (more in-memory operations)",
            "• Add indexes to avoid large sorts",
            "• Tune queries to reduce intermediate result sets",
            "• Use DISTINCT sparingly (or GROUP BY with indexes)",
            "• Break large operations into smaller batches",
            "• Consider materialized views for complex aggregations",
            "",
            "💡 Temp Tablespace Sizing:",
            "• Size based on peak concurrent sort/hash operations",
            "• Rule of thumb: 2-3x largest expected operation",
            "• Monitor over time to establish baseline",
            "• Use AUTOEXTEND ON with reasonable MAXSIZE",
            "• Multiple tempfiles improve parallel operations",
            "",
            "💡 PGA vs Temp Relationship:",
            "• PGA = private memory for each session",
            "• Temp = disk storage when PGA insufficient",
            "• Prefer PGA (memory) over temp (disk) for performance",
            "• Increase PGA first before adding temp space",
            "• Monitor PGA usage: v$pgastat, v$process_memory",
            "",
            "📊 Monitor: v$tempseg_usage, dba_temp_free_space, v$temp_extent_pool"
          ],
          checks: [
            { label: "Temp tablespace >80% full?", key: "tempFull" },
            { label: "Sessions using >1GB temp space?", key: "highTempUsage" },
            { label: "High 'direct path write temp' waits?", key: "tempWriteWaits" },
            { label: "ORA-01652 errors in alert log?", key: "tempExtendErrors" },
            { label: "PGA_AGGREGATE_TARGET too small?", key: "lowPGA" }
          ]
        },
        {
          title: "Use AWR and ADDM Reports",
          description: "Generate Automatic Workload Repository and Advisory reports",
          sql: "-- List available AWR snapshots\nSELECT \n    snap_id,\n    begin_interval_time,\n    end_interval_time,\n    snap_level\nFROM dba_hist_snapshot\nORDER BY snap_id DESC\nFETCH FIRST 20 ROWS ONLY;\n\n-- Generate AWR report (run in SQL*Plus)\n-- @?/rdbms/admin/awrrpt.sql\n\n-- Generate AWR report programmatically\nSELECT output\nFROM TABLE(DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(\n    l_dbid => (SELECT dbid FROM v$database),\n    l_inst_num => 1,\n    l_bid => 100,  -- Begin snapshot ID\n    l_eid => 110   -- End snapshot ID\n));\n\n-- List ADDM tasks\nSELECT \n    task_name,\n    description,\n    advisor_name,\n    created,\n    status\nFROM dba_advisor_tasks\nWHERE advisor_name = 'ADDM'\nORDER BY created DESC\nFETCH FIRST 10 ROWS ONLY;\n\n-- View ADDM findings\nSELECT \n    task_name,\n    finding_name,\n    type,\n    impact,\n    message\nFROM dba_advisor_findings\nWHERE task_name = (SELECT MAX(task_name) \n                   FROM dba_advisor_tasks \n                   WHERE advisor_name = 'ADDM')\nORDER BY impact DESC;",
          action: "-- Create manual AWR snapshot\nEXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT();\n\n-- Modify snapshot retention (default 8 days)\nEXEC DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(\n    retention => 14400,  -- Minutes (10 days)\n    interval => 60       -- Snapshot every 60 minutes\n);\n\n-- Run ADDM analysis manually\nDECLARE\n    l_task_name VARCHAR2(30);\nBEGIN\n    l_task_name := 'ADDM_' || TO_CHAR(SYSDATE, 'YYYYMMDD_HH24MISS');\n    DBMS_ADVISOR.CREATE_TASK(\n        advisor_name => 'ADDM',\n        task_name => l_task_name\n    );\n    DBMS_ADVISOR.SET_TASK_PARAMETER(\n        task_name => l_task_name,\n        parameter => 'START_SNAPSHOT',\n        value => 100  -- Begin snapshot ID\n    );\n    DBMS_ADVISOR.SET_TASK_PARAMETER(\n        task_name => l_task_name,\n        parameter => 'END_SNAPSHOT',\n        value => 110  -- End snapshot ID\n    );\n    DBMS_ADVISOR.EXECUTE_TASK(task_name => l_task_name);\nEND;\n/\n\n-- Generate SQL Tuning Advisor report\n-- @?/rdbms/admin/addmrpt.sql",
          warning: "⚠️ AWR and ADDM require Oracle Diagnostics Pack license. Creating frequent snapshots increases storage requirements. Check licensing before use.",
          guidance: [
            "💡 AWR (Automatic Workload Repository):",
            "• Collects performance statistics every hour by default",
            "• Retains data for 8 days by default",
            "• Provides historical performance analysis",
            "• Essential for diagnosing intermittent issues",
            "• AWR reports show top SQL, wait events, system stats",
            "",
            "💡 ADDM (Automatic Database Diagnostic Monitor):",
            "• Automatically analyzes AWR data",
            "• Identifies performance bottlenecks",
            "• Provides actionable recommendations",
            "• Ranks findings by impact (DB time)",
            "• Runs automatically after each snapshot",
            "",
            "💡 AWR Report Sections to Review:",
            "• Top 5 Timed Foreground Events: Shows main bottlenecks",
            "• SQL ordered by Elapsed Time: Identifies slow queries",
            "• SQL ordered by CPU Time: Finds CPU-intensive queries",
            "• SQL ordered by Gets: Finds high logical I/O queries",
            "• SQL ordered by Reads: Finds high physical I/O queries",
            "• Instance Efficiency Percentages: Buffer cache hit ratio, etc.",
            "• Wait Events Statistics: Detailed wait event analysis",
            "",
            "💡 ADDM Findings:",
            "• High DB Time impact = critical findings",
            "• Recommendations include: SQL tuning, configuration changes, schema changes",
            "• ADDM findings reference specific SQL_IDs for investigation",
            "• Rationale explains why recommendation matters",
            "",
            "💡 Using AWR Reports:",
            "1. Identify problem period (slow performance window)",
            "2. Find snapshot IDs for that period",
            "3. Generate AWR report for those snapshots",
            "4. Review top wait events and top SQL",
            "5. Investigate and tune problematic queries",
            "6. Compare baseline vs problem period reports",
            "",
            "💡 Best Practices:",
            "• Generate AWR reports during problem periods",
            "• Compare problem period vs baseline (normal) period",
            "• Take manual snapshots before/after changes",
            "• Increase snapshot frequency (30 min) for critical issues",
            "• Archive important AWR reports for future reference",
            "• Use ADDM for quick automated analysis",
            "",
            "⚠️ Licensing Note:",
            "• AWR and ADDM require Oracle Diagnostics Pack (extra cost)",
            "• Check Oracle license before using these features",
            "• Alternative: Statspack (free, manual, less features)",
            "",
            "📊 Monitor: dba_hist_* views, dba_advisor_* views"
          ],
          checks: [
            { label: "AWR snapshots being collected?", key: "awrEnabled" },
            { label: "Recent ADDM findings available?", key: "addmFindings" },
            { label: "AWR retention too short (<7 days)?", key: "shortRetention" },
            { label: "High-impact ADDM findings unresolved?", key: "criticalFindings" },
            { label: "Diagnostics Pack licensed?", key: "diagnosticsLicense" }
          ]
        }
      ],
      snowflake: [
        {
          title: "Analyze Query Profile",
          description: "Use Snowflake's Query Profile to understand execution details",
          sql: "-- Enable query profiling (run before your query)\nALTER SESSION SET QUERY_TAG = 'troubleshooting_query';\n\n-- Your query here\nyour_query_here;\n\n-- View query profile\nSELECT * FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY())\nWHERE QUERY_TAG = 'troubleshooting_query'\nORDER BY START_TIME DESC\nLIMIT 1;",
          warning: "⚠️ Query Profile shows actual execution details but requires the query to complete. For very slow queries, consider using EXPLAIN PLAN first.",
          guidance: [
            "Query Profile shows actual execution statistics, not estimates",
            "Look for high 'Bytes Scanned' vs 'Bytes Spilled' ratios",
            "Check 'Partitions Scanned' vs 'Partitions Total' - high ratios indicate inefficient pruning",
            "Monitor 'Remote I/O' - high values suggest data movement between compute nodes",
            "Check 'Spilling' - indicates insufficient memory allocation"
          ],
          checks: [
            { label: "Query execution time > 30 seconds?", key: "slowExecution" },
            { label: "High Bytes Spilled (>1GB)?", key: "highSpilling" },
            { label: "Low partition pruning (<50% partitions scanned)?", key: "poorPruning" },
            { label: "High Remote I/O (>100MB)?", key: "highRemoteIO" },
            { label: "Many micro-partitions scanned?", key: "manyPartitions" },
            { label: "Query using external tables?", key: "externalTables" }
          ]
        },
        {
          title: "Check Warehouse Size and Scaling",
          description: "Verify compute resources are adequate",
          sql: "-- Check current warehouse settings\nSHOW WAREHOUSES;\n\n-- Check warehouse usage history\nSELECT \n    WAREHOUSE_NAME,\n    AVG(AVG_RUNNING) as avg_running,\n    AVG(AVG_QUEUED) as avg_queued,\n    AVG(AVG_BLOCKED) as avg_blocked\nFROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_EVENTS_HISTORY\nWHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())\nGROUP BY WAREHOUSE_NAME\nORDER BY avg_running DESC;\n\n-- Check for warehouse scaling events\nSELECT \n    WAREHOUSE_NAME,\n    EVENT_NAME,\n    COUNT(*) as event_count\nFROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_EVENTS_HISTORY\nWHERE START_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP())\n    AND EVENT_NAME IN ('WAREHOUSE_RESUMING', 'WAREHOUSE_SCALING_UP', 'WAREHOUSE_SCALING_DOWN')\nGROUP BY WAREHOUSE_NAME, EVENT_NAME\nORDER BY event_count DESC;",
          action: "-- Scale up warehouse temporarily for testing\nALTER WAREHOUSE your_warehouse_name SET WAREHOUSE_SIZE = 'LARGE';\n\n-- Enable auto-scaling\nALTER WAREHOUSE your_warehouse_name SET AUTO_SUSPEND = 60;\nALTER WAREHOUSE your_warehouse_name SET AUTO_RESUME = TRUE;\n\n-- Set scaling policy\nALTER WAREHOUSE your_warehouse_name SET SCALING_POLICY = 'STANDARD';",
          warning: "⚠️ Larger warehouses cost more credits. Test performance improvements before permanently scaling up. Monitor credit usage in Account Usage views.",
          guidance: [
            "💡 Warehouse Sizing:",
            "• X-Small: 1 credit/hour, 1 server",
            "• Small: 2 credits/hour, 2 servers", 
            "• Medium: 4 credits/hour, 4 servers",
            "• Large: 8 credits/hour, 8 servers",
            "• X-Large: 16 credits/hour, 16 servers",
            "",
            "💡 Auto-scaling Benefits:",
            "• Automatically scales up during high load",
            "• Scales down during low activity",
            "• Reduces costs while maintaining performance",
            "",
            "💡 When to Scale Up:",
            "• Queries consistently taking >30 seconds",
            "• High queuing times (avg_queued > 0)",
            "• Frequent warehouse scaling events",
            "• Memory-intensive operations (large sorts, joins)",
            "",
            "💡 Cost Optimization:",
            "• Use auto-suspend to pause idle warehouses",
            "• Monitor credit usage with Account Usage views",
            "• Consider query optimization before scaling"
          ]
        },
        {
          title: "Optimize Clustering Keys",
          description: "Ensure tables are properly clustered for efficient pruning",
          sql: "-- Check clustering information for tables\nSELECT \n    TABLE_NAME,\n    CLUSTERING_KEY,\n    TOTAL_BYTES,\n    BYTES_NOT_CLUSTERED,\n    ROUND((BYTES_NOT_CLUSTERED / TOTAL_BYTES) * 100, 2) AS PERCENT_NOT_CLUSTERED\nFROM INFORMATION_SCHEMA.TABLES\nWHERE TABLE_SCHEMA = 'YOUR_SCHEMA'\n    AND CLUSTERING_KEY IS NOT NULL\nORDER BY PERCENT_NOT_CLUSTERED DESC;\n\n-- Check partition pruning effectiveness\nSELECT \n    QUERY_ID,\n    QUERY_TEXT,\n    PARTITIONS_SCANNED,\n    PARTITIONS_TOTAL,\n    ROUND((PARTITIONS_SCANNED / PARTITIONS_TOTAL) * 100, 2) AS PRUNING_PERCENTAGE\nFROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY\nWHERE START_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP())\n    AND PARTITIONS_TOTAL > 0\nORDER BY PRUNING_PERCENTAGE DESC\nLIMIT 10;",
          action: "-- Add clustering key to table\nALTER TABLE your_table_name CLUSTER BY (date_column, id_column);\n\n-- Re-cluster table (run periodically)\nALTER TABLE your_table_name RECLUSTER;\n\n-- Check clustering progress\nSELECT SYSTEM$CLUSTERING_INFORMATION('your_table_name');",
          warning: "⚠️ RECLUSTER consumes credits and can take time on large tables. Run during off-peak hours. Monitor clustering effectiveness before adding clustering keys.",
          guidance: [
            "💡 Clustering Key Selection:",
            "• Choose columns frequently used in WHERE clauses",
            "• High cardinality columns work best",
            "• Date/time columns are excellent choices",
            "• Avoid clustering on low-cardinality columns",
            "",
            "💡 Clustering Effectiveness:",
            "• <10% not clustered = excellent",
            "• 10-30% not clustered = good",
            "• >30% not clustered = needs attention",
            "",
            "💡 When to Re-cluster:",
            "• After bulk data loads",
            "• When clustering effectiveness drops below 80%",
            "• Before important analytical queries",
            "",
            "💡 Partition Pruning:",
            "• Higher pruning percentage = better performance",
            "• <50% pruning indicates clustering issues",
            "• Use EXPLAIN to verify pruning in query plans"
          ]
        },
        {
          title: "Optimize Data Types and Compression",
          description: "Ensure efficient data storage and processing",
          sql: "-- Check table sizes and compression\nSELECT \n    TABLE_NAME,\n    ROW_COUNT,\n    BYTES,\n    ROUND(BYTES / ROW_COUNT, 2) AS BYTES_PER_ROW\nFROM INFORMATION_SCHEMA.TABLES\nWHERE TABLE_SCHEMA = 'YOUR_SCHEMA'\nORDER BY BYTES DESC\nLIMIT 10;\n\n-- Check for inefficient data types\nSELECT \n    COLUMN_NAME,\n    DATA_TYPE,\n    CHARACTER_MAXIMUM_LENGTH,\n    NUMERIC_PRECISION,\n    NUMERIC_SCALE\nFROM INFORMATION_SCHEMA.COLUMNS\nWHERE TABLE_SCHEMA = 'YOUR_SCHEMA'\n    AND DATA_TYPE IN ('VARCHAR', 'CHAR', 'NUMBER')\nORDER BY TABLE_NAME, ORDINAL_POSITION;",
          action: "-- Optimize VARCHAR columns\nALTER TABLE your_table_name ALTER COLUMN varchar_column SET DATA_TYPE VARCHAR(50);\n\n-- Use appropriate NUMBER precision\nALTER TABLE your_table_name ALTER COLUMN number_column SET DATA_TYPE NUMBER(10,2);\n\n-- Consider using VARIANT for semi-structured data\nALTER TABLE your_table_name ADD COLUMN json_data VARIANT;",
          guidance: [
            "💡 Data Type Optimization:",
            "• Use smallest appropriate VARCHAR size",
            "• Avoid CHAR unless fixed-length needed",
            "• Use NUMBER with appropriate precision",
            "• Consider VARIANT for JSON/semi-structured data",
            "",
            "💡 Compression Benefits:",
            "• Snowflake automatically compresses data",
            "• Smaller data types = better compression",
            "• Reduces I/O and improves query performance",
            "",
            "💡 Storage Optimization:",
            "• Monitor BYTES_PER_ROW ratios",
            "• High ratios may indicate inefficient types",
            "• Consider partitioning large tables",
            "",
            "💡 Best Practices:",
            "• Use DATE instead of VARCHAR for dates",
            "• Use TIMESTAMP_NTZ for UTC timestamps",
            "• Use BOOLEAN instead of VARCHAR('true'/'false')",
            "• Use ARRAY for repeated values"
          ]
        },
        {
          title: "Optimize Query Patterns",
          description: "Rewrite inefficient Snowflake-specific patterns",
          examples: [
            { bad: "SELECT * FROM table WHERE DATE(created_at) = '2024-01-01'", good: "SELECT * FROM table WHERE created_at >= '2024-01-01' AND created_at < '2024-01-02'", why: "DATE() function prevents partition pruning; range comparison enables pruning" },
            { bad: "SELECT COUNT(*) FROM large_table", good: "SELECT COUNT(*) FROM large_table SAMPLE ROW (1000000)", why: "Full table scan is expensive; sampling gives approximate count quickly" },
            { bad: "SELECT DISTINCT col1, col2 FROM table", good: "SELECT col1, col2 FROM table GROUP BY col1, col2", why: "DISTINCT requires sort; GROUP BY can use clustering keys" },
            { bad: "WHERE col1 = 'A' OR col2 = 'B'", good: "WHERE col1 = 'A'\nUNION ALL\nSELECT * WHERE col2 = 'B' AND col1 != 'A'", why: "OR prevents partition pruning; UNION allows pruning on each condition" },
            { bad: "SELECT * FROM table ORDER BY random_column LIMIT 1000", good: "SELECT * FROM table TABLESAMPLE BERNOULLI (1) LIMIT 1000", why: "ORDER BY random_column scans entire table; TABLESAMPLE is much faster" },
            { bad: "SELECT * FROM table WHERE UPPER(name) = 'JOHN'", good: "SELECT * FROM table WHERE name ILIKE 'john'", why: "UPPER() prevents pruning; ILIKE is case-insensitive and more efficient" },
            { bad: "SELECT * FROM table WHERE id IN (1,2,3...10000)", good: "CREATE TEMPORARY TABLE temp_ids (id INT);\nINSERT INTO temp_ids VALUES (1),(2),(3);\nSELECT * FROM table JOIN temp_ids ON table.id = temp_ids.id", why: "Large IN lists cause parsing overhead; temp table is more efficient" },
            { bad: "SELECT * FROM table WHERE col IS NOT NULL", good: "SELECT * FROM table WHERE col > ''", why: "IS NOT NULL can't use clustering; comparison enables pruning" }
          ],
          guidance: [
            "Use range comparisons instead of functions on columns",
            "Leverage Snowflake's automatic partition pruning",
            "Use TABLESAMPLE for approximate results",
            "Prefer UNION over OR for better pruning",
            "Use ILIKE instead of UPPER()/LOWER() functions",
            "Consider temporary tables for large IN lists"
          ]
        },
        {
          title: "Monitor Resource Usage",
          description: "Track credit consumption and performance metrics",
          sql: "-- Check credit usage by warehouse\nSELECT \n    WAREHOUSE_NAME,\n    DATE(START_TIME) as usage_date,\n    SUM(CREDITS_USED) as total_credits,\n    AVG(CREDITS_USED) as avg_credits_per_query\nFROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY\nWHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())\nGROUP BY WAREHOUSE_NAME, DATE(START_TIME)\nORDER BY usage_date DESC, total_credits DESC;\n\n-- Check query performance trends\nSELECT \n    DATE(START_TIME) as query_date,\n    COUNT(*) as total_queries,\n    AVG(TOTAL_ELAPSED_TIME) as avg_execution_time_ms,\n    AVG(BYTES_SCANNED) as avg_bytes_scanned,\n    AVG(BYTES_SPILLED_TO_LOCAL_STORAGE) as avg_bytes_spilled\nFROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY\nWHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())\n    AND QUERY_TYPE = 'SELECT'\nGROUP BY DATE(START_TIME)\nORDER BY query_date DESC;\n\n-- Check for expensive queries\nSELECT \n    QUERY_ID,\n    QUERY_TEXT,\n    TOTAL_ELAPSED_TIME,\n    BYTES_SCANNED,\n    CREDITS_USED_CLOUD_SERVICES,\n    START_TIME\nFROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY\nWHERE START_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP())\n    AND TOTAL_ELAPSED_TIME > 30000  -- >30 seconds\nORDER BY TOTAL_ELAPSED_TIME DESC\nLIMIT 10;",
          action: "-- Set up query monitoring\nALTER SESSION SET QUERY_TAG = 'performance_monitoring';\n\n-- Use result caching for repeated queries\nALTER SESSION SET USE_CACHED_RESULT = TRUE;\n\n-- Enable query result caching\nALTER SESSION SET QUERY_RESULT_FORMAT = 'JSON';",
          guidance: [
            "💡 Credit Optimization:",
            "• Monitor credit usage patterns",
            "• Use auto-suspend for idle warehouses",
            "• Consider result caching for repeated queries",
            "• Optimize queries before scaling warehouses",
            "",
            "💡 Performance Monitoring:",
            "• Track average execution times",
            "• Monitor bytes scanned vs spilled",
            "• Identify expensive queries regularly",
            "• Use query tags for tracking",
            "",
            "💡 Cost Management:",
            "• Set up billing alerts",
            "• Review credit usage weekly",
            "• Optimize before scaling up",
            "• Use Account Usage views for insights",
            "",
            "💡 Best Practices:",
            "• Cache frequently accessed results",
            "• Use appropriate warehouse sizes",
            "• Monitor and optimize continuously",
            "• Set up automated monitoring alerts"
          ]
        },
        {
          title: "Using CTEs and Window Functions Effectively",
          description: "Leverage Snowflake's advanced SQL features",
          examples: [
            { bad: "SELECT o.*,\n  (SELECT SUM(amount) FROM order_items WHERE order_id = o.id) as total,\n  (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count\nFROM orders o", good: "WITH order_totals AS (\n  SELECT order_id,\n    SUM(amount) as total,\n    COUNT(*) as item_count\n  FROM order_items\n  GROUP BY order_id\n)\nSELECT o.*, ot.total, ot.item_count\nFROM orders o\nLEFT JOIN order_totals ot ON o.id = ot.order_id", why: "Correlated subqueries execute per row; CTE aggregates once then joins" },
            { bad: "SELECT * FROM (\n  SELECT *, ROW_NUMBER() OVER (ORDER BY created_at DESC) as rn\n  FROM orders\n) WHERE rn <= 10", good: "SELECT * FROM orders\nQUALIFY ROW_NUMBER() OVER (ORDER BY created_at DESC) <= 10", why: "QUALIFY is Snowflake-specific and more efficient than subquery" },
            { bad: "SELECT customer_id, order_date, amount\nFROM orders\nWHERE order_date >= '2024-01-01'\nORDER BY customer_id, order_date", good: "SELECT customer_id, order_date, amount,\n  LAG(amount) OVER (PARTITION BY customer_id ORDER BY order_date) as prev_amount\nFROM orders\nWHERE order_date >= '2024-01-01'\nQUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date) <= 5", why: "Window functions provide more analytical power and QUALIFY filters efficiently" }
          ],
          guidance: [
            "✅ Use CTEs for: Complex multi-step transformations, recursive queries, improving readability",
            "✅ Use QUALIFY instead of subqueries for filtering window function results",
            "✅ Leverage Snowflake's advanced window functions (LAG, LEAD, QUALIFY)",
            "✅ Use window functions for analytical queries instead of self-joins",
            "❌ Avoid CTEs when: Simple single-use subqueries, adding unnecessary complexity",
            "💡 Tip: Snowflake's QUALIFY clause is more efficient than subqueries for window function filtering"
          ]
        },
        {
          title: "Leverage Result Set Caching",
          description: "Optimize query performance using Snowflake's automatic result caching",
          sql: "-- Check if result cache is enabled (default: ON)\nSHOW PARAMETERS LIKE 'USE_CACHED_RESULT' IN SESSION;\n\n-- View queries using cached results\nSELECT \n    query_id,\n    query_text,\n    execution_time,\n    CASE \n        WHEN query_type = 'SELECT' AND bytes_scanned = 0 THEN 'Result Cache Hit'\n        ELSE 'Cache Miss'\n    END AS cache_status,\n    start_time\nFROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY\nWHERE start_time >= DATEADD(hour, -1, CURRENT_TIMESTAMP())\n    AND query_type = 'SELECT'\n    AND bytes_scanned = 0  -- Indicates result cache hit\nORDER BY start_time DESC\nLIMIT 20;\n\n-- Analyze cache effectiveness\nSELECT \n    DATE(start_time) AS query_date,\n    COUNT(*) AS total_queries,\n    SUM(CASE WHEN bytes_scanned = 0 AND query_type = 'SELECT' THEN 1 ELSE 0 END) AS cached_queries,\n    ROUND(100.0 * SUM(CASE WHEN bytes_scanned = 0 AND query_type = 'SELECT' THEN 1 ELSE 0 END) / COUNT(*), 2) AS cache_hit_percent,\n    AVG(total_elapsed_time) AS avg_execution_time_ms\nFROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY\nWHERE start_time >= DATEADD(day, -7, CURRENT_TIMESTAMP())\n    AND query_type = 'SELECT'\nGROUP BY DATE(start_time)\nORDER BY query_date DESC;\n\n-- Check warehouse cache (local disk cache)\nSELECT \n    query_id,\n    query_text,\n    bytes_scanned,\n    bytes_read_from_result_cache,\n    percentage_scanned_from_cache,\n    execution_time\nFROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY\nWHERE start_time >= DATEADD(hour, -1, CURRENT_TIMESTAMP())\n    AND percentage_scanned_from_cache > 0\nORDER BY start_time DESC\nLIMIT 20;",
          action: "-- Enable result caching (default is ON)\nALTER SESSION SET USE_CACHED_RESULT = TRUE;\n\n-- Disable result caching for fresh data\nALTER SESSION SET USE_CACHED_RESULT = FALSE;\n\n-- Force query to bypass result cache\nSELECT * FROM table\nWHERE created_at >= CURRENT_TIMESTAMP();  -- Time-dependent queries bypass cache\n\n-- Clear result cache for specific query pattern (not directly supported)\n-- Workaround: Add a comment or modify query slightly\nSELECT * FROM table /* cache_bust_v1 */;\n\n-- Optimize for result caching\n-- Use consistent query text (formatting matters)\n-- Parameterize queries when possible\n-- Avoid time-based functions that change (CURRENT_TIMESTAMP, etc.)",
          warning: "⚠️ Result cache returns stale data if underlying tables changed. Cache is invalidated automatically when tables are modified, but may not reflect concurrent changes immediately. Time-dependent queries bypass cache.",
          guidance: [
            "💡 Snowflake Result Caching (3 Layers):",
            "• Result Cache: Stores exact query results for 24 hours (no compute used)",
            "• Warehouse Cache: Stores data on local SSD (faster than remote storage)",
            "• Remote Storage: Cloud object storage (S3, Azure Blob, GCS)",
            "",
            "💡 Result Cache Behavior:",
            "• Exact query match required (whitespace, case, comments matter)",
            "• Automatically invalidated when underlying tables change",
            "• Retained for 24 hours since last access",
            "• No compute credits used for cache hits",
            "• Works across all warehouses for same account",
            "",
            "💡 Cache Hit Requirements:",
            "• Identical SQL text (including formatting, comments)",
            "• Same session parameters and context",
            "• No changes to underlying tables since cache creation",
            "• No time-dependent functions (CURRENT_TIMESTAMP, etc.)",
            "• USE_CACHED_RESULT = TRUE (default)",
            "",
            "💡 Warehouse Cache (Local Disk Cache):",
            "• Stores raw table data on warehouse's local SSD",
            "• Persists while warehouse is running (lost on suspend)",
            "• Automatically manages cache (LRU eviction)",
            "• Speeds up repeated scans of same data",
            "• Shared across queries in same warehouse",
            "",
            "💡 Maximizing Cache Effectiveness:",
            "• Standardize query formatting (use query templates)",
            "• Use views or CTEs for commonly accessed data",
            "• Keep warehouses running for frequently queried data",
            "• Use materialized views for complex aggregations",
            "• Monitor cache hit ratio and adjust strategies",
            "",
            "💡 When Result Cache Doesn't Help:",
            "• Ad-hoc exploratory queries (each query different)",
            "• Rapidly changing data (cache frequently invalidated)",
            "• Time-series data with time-based filters",
            "• Queries with CURRENT_TIMESTAMP or random functions",
            "• Real-time dashboards requiring fresh data",
            "",
            "💡 Cost Optimization with Caching:",
            "• Result cache hits = $0 (no compute used)",
            "• Warehouse cache reduces I/O costs",
            "• Use smaller warehouses for cache-friendly workloads",
            "• Dashboard queries benefit greatly from caching",
            "• Repeated reporting queries save significant credits",
            "",
            "📊 Monitor: bytes_scanned = 0, percentage_scanned_from_cache, query_history"
          ],
          checks: [
            { label: "Low cache hit ratio (<50%)?", key: "lowCacheHitRatio" },
            { label: "USE_CACHED_RESULT disabled?", key: "cachingDisabled" },
            { label: "Queries with time functions bypassing cache?", key: "timeFunctions" },
            { label: "Inconsistent query formatting?", key: "inconsistentQueries" },
            { label: "Warehouses suspending too frequently?", key: "frequentSuspend" }
          ]
        },
        {
          title: "Optimize Time Travel Queries",
          description: "Manage performance impact of historical data queries",
          sql: "-- Check Time Travel retention settings\nSHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN ACCOUNT;\n\n-- Check retention per table\nSELECT \n    table_catalog,\n    table_schema,\n    table_name,\n    retention_time\nFROM INFORMATION_SCHEMA.TABLES\nWHERE table_schema NOT IN ('INFORMATION_SCHEMA', 'PERFORMANCE_SCHEMA')\nORDER BY retention_time DESC;\n\n-- Query historical data using Time Travel\nSELECT * FROM table AT(OFFSET => -3600);  -- 1 hour ago\nSELECT * FROM table AT(TIMESTAMP => '2024-01-01 12:00:00'::TIMESTAMP);\nSELECT * FROM table BEFORE(STATEMENT => 'query_id_here');\n\n-- Check storage costs for Time Travel data\nSELECT \n    table_catalog,\n    table_schema,\n    table_name,\n    active_bytes / (1024 * 1024 * 1024) AS active_gb,\n    time_travel_bytes / (1024 * 1024 * 1024) AS time_travel_gb,\n    failsafe_bytes / (1024 * 1024 * 1024) AS failsafe_gb,\n    ROUND(100.0 * time_travel_bytes / NULLIF(active_bytes + time_travel_bytes + failsafe_bytes, 0), 2) AS time_travel_percent\nFROM SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS\nWHERE active_bytes > 0\nORDER BY time_travel_bytes DESC\nLIMIT 20;\n\n-- Identify expensive Time Travel queries\nSELECT \n    query_id,\n    query_text,\n    execution_time,\n    bytes_scanned / (1024 * 1024 * 1024) AS gb_scanned,\n    partitions_scanned,\n    start_time\nFROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY\nWHERE query_text ILIKE '%AT(%'\n   OR query_text ILIKE '%BEFORE(%'\nORDER BY execution_time DESC\nLIMIT 20;",
          action: "-- Reduce Time Travel retention to save storage costs\nALTER TABLE table_name SET DATA_RETENTION_TIME_IN_DAYS = 1;  -- Minimum for Standard edition\n\n-- Increase retention for critical tables (Enterprise edition)\nALTER TABLE critical_table SET DATA_RETENTION_TIME_IN_DAYS = 90;  -- Max 90 days\n\n-- Set database-level default retention\nALTER DATABASE database_name SET DATA_RETENTION_TIME_IN_DAYS = 7;\n\n-- Clone table at specific point in time (zero-copy)\nCREATE TABLE restored_table CLONE source_table \n    AT(TIMESTAMP => '2024-01-01 12:00:00'::TIMESTAMP);\n\n-- Create table without Time Travel retention\nCREATE TRANSIENT TABLE temp_table (...)  -- No Time Travel or Fail-safe\nDATA_RETENTION_TIME_IN_DAYS = 0;\n\n-- Best practice: Use TRANSIENT for staging/temp data\nCREATE TRANSIENT TABLE staging_table AS SELECT * FROM source;",
          warning: "⚠️ Reducing retention time prevents recovering data beyond new retention period. Plan carefully for compliance requirements. TRANSIENT tables have no Fail-safe and reduced durability guarantees.",
          guidance: [
            "💡 Time Travel Overview:",
            "• Allows querying historical data up to 90 days (Enterprise)",
            "• Standard edition: 1 day default, 1 day maximum",
            "• Enterprise edition: 1 day default, 90 days maximum",
            "• Incurs storage costs for historical data versions",
            "• Enables point-in-time recovery and auditing",
            "",
            "💡 Time Travel Performance Impact:",
            "• Historical queries may scan more data than current queries",
            "• Older data may not benefit from clustering",
            "• Time Travel queries can't use result cache",
            "• May scan multiple micro-partitions for point-in-time view",
            "• Performance degrades with longer time offsets",
            "",
            "💡 Storage Costs:",
            "• Time Travel data stored separately from active data",
            "• Billed as additional storage beyond active data",
            "• Costs accumulate with high retention and frequent updates",
            "• Monitor time_travel_bytes in TABLE_STORAGE_METRICS",
            "• Can exceed active data size for frequently updated tables",
            "",
            "💡 Optimizing Time Travel Costs:",
            "• Reduce retention for non-critical tables (1 day minimum)",
            "• Use TRANSIENT tables for staging/temporary data",
            "• Use clones for long-term snapshots instead of high retention",
            "• Monitor storage metrics and adjust retention accordingly",
            "• Archive historical data to cheaper storage (S3, external tables)",
            "",
            "💡 Use Cases for Time Travel:",
            "• Recover from accidental deletes/updates (use CLONE or UNDROP)",
            "• Audit data changes and track modifications",
            "• Compare data across time periods",
            "• Reproduce reports as of specific dates",
            "• Debug data pipeline issues",
            "",
            "💡 Time Travel Syntax:",
            "• AT(OFFSET => -3600): 1 hour ago (seconds)",
            "• AT(TIMESTAMP => '...'): Specific point in time",
            "• BEFORE(STATEMENT => 'query_id'): Before specific query",
            "• Works with SELECT, CREATE TABLE AS, CLONE",
            "",
            "💡 TRANSIENT vs PERMANENT Tables:",
            "• PERMANENT: Full Time Travel + 7-day Fail-safe (default)",
            "• TRANSIENT: Time Travel but no Fail-safe (lower storage cost)",
            "• TRANSIENT good for staging, ETL intermediates, temp data",
            "• Use PERMANENT for critical business data",
            "",
            "💡 Cloning vs Time Travel:",
            "• Clones create zero-copy snapshots (instant, no storage until modified)",
            "• Better for long-term archival than high retention settings",
            "• Clones can be queried without Time Travel syntax overhead",
            "• More cost-effective for monthly/quarterly snapshots",
            "",
            "📊 Monitor: TABLE_STORAGE_METRICS, time_travel_bytes, DATA_RETENTION_TIME_IN_DAYS"
          ],
          checks: [
            { label: "High Time Travel storage costs (>20% of active)?", key: "highTimeTravelStorage" },
            { label: "Retention period longer than needed?", key: "excessiveRetention" },
            { label: "Non-critical tables with high retention?", key: "unnecessaryRetention" },
            { label: "Staging/temp tables not using TRANSIENT?", key: "missingTransient" },
            { label: "Time Travel queries performing slowly?", key: "slowTimeTravelQueries" }
          ]
        }
      ]
    };
    return allSteps[dbType] || [];
  };

  const steps = getSteps();
  const currentStepData = steps[currentStep];

  if (!dbType) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="text-center mb-8">
          <Database className="w-16 h-16 mx-auto mb-4 text-blue-600" />
          <h1 className="text-3xl font-bold mb-2">Database Query Troubleshooter</h1>
          <p className="text-gray-600">Interactive guide to diagnose and fix slow queries</p>
        </div>
        <div className="mb-6">
          <label className="block text-sm font-medium mb-2">Select Your Database Type:</label>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {['postgresql', 'mysql', 'sqlserver', 'oracle', 'snowflake'].map((db) => (
              <button key={db} onClick={() => setDbType(db)} className="p-6 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-all">
                <Database className="w-8 h-8 mx-auto mb-2 text-blue-600" />
                <div className="font-semibold capitalize">{db === 'sqlserver' ? 'SQL Server' : db === 'postgresql' ? 'PostgreSQL' : db === 'oracle' ? 'Oracle' : db === 'snowflake' ? 'Snowflake' : 'MySQL'}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <button onClick={() => { setDbType(''); setCurrentStep(0); setFindings({}); }} className="text-sm text-blue-600 hover:text-blue-800 mb-2">← Change Database</button>
          <h1 className="text-2xl font-bold">{dbType === 'sqlserver' ? 'SQL Server' : dbType === 'postgresql' ? 'PostgreSQL' : dbType === 'oracle' ? 'Oracle' : dbType === 'snowflake' ? 'Snowflake' : 'MySQL'} Troubleshooting</h1>
        </div>
        <div className="text-sm text-gray-600">Step {currentStep + 1} of {steps.length}</div>
      </div>

      <div className="mb-6 bg-amber-50 border-l-4 border-amber-500 p-4 rounded">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900"><strong>Important:</strong> These are general guidelines. Verify with execution plans and test in non-production first.</div>
        </div>
      </div>

        <div className="mb-6"><div className="flex gap-2">{steps.map((_: Step, idx: number) => (<div key={idx} className={`flex-1 h-2 rounded ${idx <= currentStep ? 'bg-blue-600' : 'bg-gray-200'}`} />))}</div></div>

      <div className="bg-white border rounded-lg shadow-sm">
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-4 rounded-t-lg">
          <h2 className="text-xl font-semibold">{currentStepData?.title}</h2>
          <p className="text-blue-100 text-sm mt-1">{currentStepData?.description}</p>
        </div>

        <div className="p-6">
          {currentStepData?.sql && (
            <div className="mb-6">
              {currentStepData?.warning && (<div className="mb-3 bg-orange-50 border-l-4 border-orange-400 p-3 rounded"><p className="text-sm text-orange-800 font-medium">{currentStepData.warning}</p></div>)}
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold flex items-center gap-2"><Play className="w-4 h-4" />Run This Query:</h3>
                <button onClick={() => copyToClipboard(currentStepData.sql || '', 'sql')} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"><Copy className="w-4 h-4" />{copiedIndex === 'sql' ? 'Copied!' : 'Copy'}</button>
              </div>
              <pre className="bg-gray-800 text-gray-100 p-4 rounded overflow-x-auto text-sm">{currentStepData.sql}</pre>
            </div>
          )}

          {currentStepData?.checks && (<div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4"><h3 className="font-semibold mb-3 flex items-center gap-2"><AlertCircle className="w-5 h-5 text-yellow-600" />Check for These Issues:</h3>{currentStepData.checks.map((check: Check, idx: number) => (<div key={idx} className="flex items-center gap-2 mb-2"><input type="checkbox" id={`check-${idx}`} checked={findings[check.key] || false} onChange={(e) => setFindings(prev => ({ ...prev, [check.key]: e.target.checked }))} className="w-4 h-4" /><label htmlFor={`check-${idx}`} className="text-sm">{check.label}</label></div>))}</div>)}

          {currentStepData?.action && (<div className="mb-6"><div className="flex items-center justify-between mb-2"><h3 className="font-semibold flex items-center gap-2"><CheckCircle className="w-4 h-4 text-green-600" />Fix With:</h3><button onClick={() => copyToClipboard(currentStepData.action || '', 'action')} className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"><Copy className="w-4 h-4" />{copiedIndex === 'action' ? 'Copied!' : 'Copy'}</button></div><pre className="bg-green-50 border border-green-200 p-4 rounded overflow-x-auto text-sm">{currentStepData.action}</pre></div>)}

          {currentStepData?.examples && (<div className="mb-6"><h3 className="font-semibold mb-3">Common Patterns to Fix:</h3>{currentStepData.examples.map((example: Example, idx: number) => (<div key={idx} className="mb-4 border-l-4 border-red-300 pl-4"><div className="mb-2"><span className="text-xs font-semibold text-red-600 uppercase">❌ Bad:</span><pre className="bg-red-50 p-2 rounded text-xs mt-1 overflow-x-auto">{example.bad}</pre></div><div className="mb-2"><span className="text-xs font-semibold text-green-600 uppercase">✅ Good:</span><pre className="bg-green-50 p-2 rounded text-xs mt-1 overflow-x-auto">{example.good}</pre></div>{example.why && (<div className="mt-2 text-xs text-gray-600 italic">💡 Why: {example.why}</div>)}</div>))}</div>)}

          {currentStepData?.guidance && (<div className="bg-blue-50 border border-blue-200 rounded-lg p-4"><h3 className="font-semibold mb-2">💡 Key Points:</h3><ul className="space-y-2">{currentStepData.guidance.map((point: string, idx: number) => (<li key={idx} className="text-sm flex items-start gap-2"><span className="text-blue-600 mt-0.5">•</span><span>{point}</span></li>))}</ul></div>)}
        </div>
      </div>

      <div className="mt-6 flex justify-between">
        <button onClick={() => setCurrentStep(Math.max(0, currentStep - 1))} disabled={currentStep === 0} className="px-4 py-2 border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">← Previous</button>
        <button onClick={() => setCurrentStep(Math.min(steps.length - 1, currentStep + 1))} disabled={currentStep === steps.length - 1} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">Next <ChevronRight className="w-4 h-4" /></button>
      </div>
    </div>
  );
};

export default DBTroubleshooter;