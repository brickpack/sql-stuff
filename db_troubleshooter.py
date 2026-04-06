#!/usr/bin/env python3
"""
Interactive Database Troubleshooter CLI
Extracts steps from DBTroubleshooter.tsx and runs them against a live database.
"""

import json
import sys
import re
from datetime import datetime

# ============================================================
# STEP DATA (extracted from DBTroubleshooter.tsx)
# ============================================================

ALL_STEPS = {
    "sqlserver": [
        {
            "title": "Get Actual Execution Plan",
            "description": "Analyze query execution in SSMS",
            "sql": (
                "-- Enable execution plan in SSMS (Ctrl+M) or:\n"
                "SET STATISTICS IO ON;\n"
                "SET STATISTICS TIME ON;\n"
                "\n"
                "your_query_here;\n"
                "\n"
                "-- Or get XML plan programmatically\n"
                "SET SHOWPLAN_XML ON;\n"
                "GO\n"
                "your_query_here;\n"
                "GO\n"
                "SET SHOWPLAN_XML OFF;"
            ),
            "guidance": [
                "Look for thick arrows with estimate/actual mismatches",
                "Yellow/red warning icons: missing indexes, implicit conversions, spills",
                "High cost % operators (>50%) are prime suspects",
                "Table Scans on large tables indicate missing indexes",
                "Index Scans vs Index Seeks - seeks are better",
                "Key Lookups expensive when combined with many rows",
            ],
            "checks": [
                {"label": "Warning icons (yellow/red triangles) in plan?", "key": "warnings",
                 "advice": "Investigate the specific warning. Common issues: implicit conversions (ensure parameter types match column types), missing indexes (create them), or missing statistics (run UPDATE STATISTICS)."},
                {"label": "Estimate vs Actual rows >10x difference?", "key": "estimates",
                 "advice": "Update statistics with FULLSCAN: UPDATE STATISTICS YourTable WITH FULLSCAN; If problem persists, check for stale statistics, parameter sniffing issues, or outdated cardinality estimates."},
                {"label": "Table Scan on tables with >100k rows?", "key": "tableScans",
                 "advice": "Add an index on columns used in WHERE, JOIN, or ORDER BY clauses. Use: CREATE NONCLUSTERED INDEX IX_YourIndex ON YourTable(FilterColumn) INCLUDE (SelectColumns);"},
                {"label": "Many Key Lookups (>1000 rows)?", "key": "keyLookups",
                 "advice": "Add INCLUDE columns to your index to create a covering index: CREATE NONCLUSTERED INDEX IX_Name ON Table(KeyColumns) INCLUDE (LookupColumns); This eliminates the need for key lookups."},
                {"label": "Operators with >50% of total cost?", "key": "highCost",
                 "advice": "Focus optimization on this operator. Common fixes: add indexes for scans/seeks, increase memory for sorts/hashes, or rewrite query to avoid expensive operations."},
                {"label": "Thick arrows indicating millions of rows?", "key": "thickArrows",
                 "advice": "Reduce row count earlier in query. Add WHERE filters before JOINs, use TOP/OFFSET-FETCH, or consider query redesign to process fewer rows."},
                {"label": "Memory grants showing spills to tempdb?", "key": "memorySpills",
                 "advice": "Increase memory grant with query hint: OPTION (MAX_GRANT_PERCENT = 25), update statistics for better estimates, or add indexes to reduce sort/hash size."},
                {"label": "Sort or Hash operations with warnings?", "key": "sortHash",
                 "advice": "Add indexes to eliminate sorts (covering index with columns in ORDER BY), increase memory grants, or reduce result set size before sorting/hashing."},
            ],
        },
        {
            "title": "Update Statistics",
            "description": "Refresh statistics",
            "sql": (
                "SELECT OBJECT_NAME(object_id) AS TableName,\n"
                "       STATS_DATE(object_id, index_id) AS Updated\n"
                "FROM sys.indexes\n"
                "WHERE OBJECT_NAME(object_id) = 'YourTable';"
            ),
            "action": (
                "-- Full scan (most accurate but slowest)\n"
                "UPDATE STATISTICS YourTable WITH FULLSCAN;\n"
                "\n"
                "-- Sampled (faster, still accurate)\n"
                "UPDATE STATISTICS YourTable WITH SAMPLE 50 PERCENT;\n"
                "\n"
                "-- Let SQL Server decide sample size\n"
                "UPDATE STATISTICS YourTable;\n"
                "\n"
                "-- Update all statistics in database\n"
                "EXEC sp_updatestats;"
            ),
            "warning": "UPDATE STATISTICS WITH FULLSCAN scans entire table and can be resource-intensive. Consider running during off-peak hours.",
            "guidance": [
                "Stale stats cause bad plans",
                "Update after >20% row changes",
                "You don't need FULLSCAN - SQL Server's default sampling is often sufficient",
                "Use SAMPLE 50 PERCENT for faster updates with good accuracy",
                "FULLSCAN only needed when default sampling gives poor results",
            ],
        },
        {
            "title": "Find Missing Indexes",
            "description": "Use DMVs",
            "sql": (
                "SELECT \n"
                "    migs.user_seeks * migs.avg_total_user_cost AS impact,\n"
                "    mid.equality_columns,\n"
                "    mid.included_columns\n"
                "FROM sys.dm_db_missing_index_groups mig\n"
                "JOIN sys.dm_db_missing_index_group_stats migs\n"
                "    ON migs.group_handle = mig.index_handle\n"
                "JOIN sys.dm_db_missing_index_details mid\n"
                "    ON mig.index_handle = mid.index_handle\n"
                "ORDER BY impact DESC;"
            ),
            "action": (
                "CREATE NONCLUSTERED INDEX IX_Name \n"
                "ON Table(Col1, Col2) \n"
                "INCLUDE (Col3, Col4);"
            ),
            "warning": "Creating indexes can lock tables and impact performance during creation. Consider using ONLINE = ON option (Enterprise Edition).",
            "guidance": [
                "High impact score = high priority",
                "INCLUDE columns eliminate key lookups",
            ],
        },
        {
            "title": "Check Parameter Sniffing",
            "description": "Identify and fix parameter sniffing issues",
            "sql": (
                "-- Test if parameter sniffing is causing issues\n"
                "your_query_with_parameters\n"
                "OPTION (RECOMPILE);\n"
                "\n"
                "-- Compare execution time with and without RECOMPILE\n"
                "-- If RECOMPILE is significantly faster, you have parameter sniffing"
            ),
            "action": (
                "-- Solution 1: Recompile each execution (simple but adds overhead)\n"
                "OPTION (RECOMPILE)\n"
                "\n"
                "-- Solution 2: Optimize for unknown (uses average stats)\n"
                "OPTION (OPTIMIZE FOR UNKNOWN)\n"
                "\n"
                "-- Solution 3: Use local variable to avoid sniffing\n"
                "DECLARE @local_param INT = @parameter;\n"
                "SELECT ... WHERE column = @local_param;\n"
                "\n"
                "-- Solution 4: Optimize for specific common value\n"
                "OPTION (OPTIMIZE FOR (@parameter = 'common_value'))"
            ),
            "guidance": [
                "Parameter sniffing occurs when SQL Server creates a plan based on the first parameter values it sees",
                "That plan gets cached and reused for all subsequent executions - even with different parameters",
                "Problem: A plan optimized for parameter value 'A' might be terrible for parameter value 'B'",
                "If RECOMPILE helps significantly, parameter sniffing is likely the issue",
                "Use OPTIMIZE FOR UNKNOWN when parameter values vary widely",
                "Local variables prevent sniffing but give optimizer less information (can help or hurt)",
                "OPTIMIZE FOR specific value works when you know the most common parameter",
            ],
        },
        {
            "title": "Find Implicit Conversions",
            "description": "Locate type mismatches",
            "sql": (
                "SELECT query_plan, text\n"
                "FROM sys.dm_exec_query_stats qs\n"
                "CROSS APPLY sys.dm_exec_query_plan(plan_handle) qp\n"
                "CROSS APPLY sys.dm_exec_sql_text(sql_handle) st\n"
                "WHERE CAST(query_plan AS NVARCHAR(MAX)) \n"
                "    LIKE '%CONVERT_IMPLICIT%';"
            ),
            "guidance": [
                "Yellow warning shows conversion",
                "Match parameter types to column types",
            ],
        },
        {
            "title": "Analyze I/O and Memory",
            "description": "Check for I/O bottlenecks and memory issues",
            "sql": (
                "-- Find queries with high I/O\n"
                "SELECT TOP 20\n"
                "    total_logical_reads/execution_count AS avg_logical_reads,\n"
                "    total_physical_reads/execution_count AS avg_physical_reads,\n"
                "    total_logical_writes/execution_count AS avg_logical_writes,\n"
                "    execution_count,\n"
                "    total_worker_time/1000000 AS total_cpu_sec,\n"
                "    total_elapsed_time/1000000 AS total_elapsed_sec,\n"
                "    SUBSTRING(st.text, (qs.statement_start_offset/2)+1,\n"
                "        ((CASE qs.statement_end_offset\n"
                "            WHEN -1 THEN DATALENGTH(st.text)\n"
                "            ELSE qs.statement_end_offset\n"
                "        END - qs.statement_start_offset)/2) + 1) AS query_text\n"
                "FROM sys.dm_exec_query_stats qs\n"
                "CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st\n"
                "ORDER BY total_logical_reads DESC;\n"
                "\n"
                "-- Check Page Life Expectancy (PLE)\n"
                "SELECT \n"
                "    object_name,\n"
                "    counter_name,\n"
                "    cntr_value AS page_life_expectancy_seconds\n"
                "FROM sys.dm_os_performance_counters\n"
                "WHERE object_name LIKE '%Buffer Manager%'\n"
                "    AND counter_name = 'Page life expectancy';"
            ),
            "action": (
                "-- Adjust max server memory (leave RAM for OS)\n"
                "EXEC sp_configure 'max server memory (MB)', 16384;\n"
                "RECONFIGURE;\n"
                "\n"
                "-- Query hints for memory control\n"
                "-- SELECT ... OPTION (MAX_GRANT_PERCENT = 10);"
            ),
            "warning": "Changing max server memory or other SQL Server configuration can cause service restarts or performance degradation. Test in non-production and during maintenance windows. Leave 4-6GB RAM for OS.",
            "guidance": [
                "Logical reads = Pages read from buffer pool (memory or disk)",
                "Physical reads = Pages read from disk (slow - indicates cache misses)",
                "High logical reads with low physical reads = good caching",
                "High physical reads = insufficient buffer pool or cache churn",
                "Page Life Expectancy should be > 300 seconds (5 minutes)",
                "Low PLE (<300) = memory pressure, frequent cache evictions",
                "max server memory: SQL Server's memory limit (leave RAM for OS)",
                "Formula: Total RAM - 4GB (for OS) - 1GB per 8GB RAM",
            ],
        },
        {
            "title": "Enable Query Store",
            "description": "Track performance",
            "sql": (
                "ALTER DATABASE YourDB SET QUERY_STORE = ON;\n"
                "\n"
                "SELECT q.query_id, qt.query_sql_text,\n"
                "       rs.avg_duration/1000 AS avg_ms\n"
                "FROM sys.query_store_query q\n"
                "JOIN sys.query_store_query_text qt\n"
                "    ON q.query_text_id = qt.query_text_id\n"
                "JOIN sys.query_store_plan p\n"
                "    ON q.query_id = p.query_id\n"
                "JOIN sys.query_store_runtime_stats rs\n"
                "    ON p.plan_id = rs.plan_id\n"
                "ORDER BY rs.avg_duration DESC;"
            ),
            "action": "EXEC sp_query_store_force_plan \n    @query_id = 123, @plan_id = 456;",
            "guidance": [
                "Query Store tracks performance history",
                "Force good plans to prevent regression",
            ],
        },
        {
            "title": "Optimize Query Patterns",
            "description": "Rewrite inefficient queries",
            "examples": [
                {"bad": "WHERE OrderID IN (SELECT...)", "good": "WHERE EXISTS (SELECT 1...)", "why": "IN materializes entire subquery; EXISTS stops at first match"},
                {"bad": "WHERE YEAR(Date) = 2024", "good": "WHERE Date >= '2024-01-01' AND Date < '2025-01-01'", "why": "YEAR() prevents index seek; range allows index usage"},
                {"bad": "WHERE Status <> 'deleted'", "good": "WHERE Status IN ('active', 'pending')", "why": "<> causes scan; IN allows seeks"},
                {"bad": "WHERE ISNULL(column, '') = ''", "good": "WHERE column IS NULL OR column = ''", "why": "ISNULL() prevents index usage"},
                {"bad": "WHERE SUBSTRING(OrderNumber, 1, 3) = 'ORD'", "good": "WHERE OrderNumber LIKE 'ORD%'", "why": "SUBSTRING prevents seek; LIKE uses index"},
                {"bad": "WHERE Price * Quantity > 1000", "good": "WHERE Price > 1000 / NULLIF(Quantity, 0)", "why": "Math on column prevents seek"},
                {"bad": "WHERE CAST(OrderID AS VARCHAR) = @id", "good": "WHERE OrderID = CAST(@id AS INT)", "why": "CAST on column causes scan"},
                {"bad": "WHERE o.CustomerID NOT IN (SELECT CustomerID FROM Blacklist)", "good": "WHERE NOT EXISTS (SELECT 1 FROM Blacklist b WHERE b.CustomerID = o.CustomerID)", "why": "NOT IN fails with NULLs; NOT EXISTS short-circuits"},
            ],
            "guidance": [
                "EXISTS faster than IN",
                "Avoid functions on columns",
                "Window functions beat correlated subqueries",
                "Move calculations to parameters, not columns",
            ],
        },
        {
            "title": "Using CTEs Effectively",
            "description": "When to use Common Table Expressions",
            "examples": [
                {"bad": "SELECT c.*, (SELECT COUNT(*) FROM Orders WHERE CustomerID = c.ID) as cnt FROM Customers c",
                 "good": "WITH Metrics AS (SELECT CustomerID, COUNT(*) as cnt FROM Orders GROUP BY CustomerID) SELECT c.*, m.cnt FROM Customers c LEFT JOIN Metrics m ON c.ID = m.CustomerID",
                 "why": "Correlated subqueries scan repeatedly; CTE scans once and joins"},
            ],
            "guidance": [
                "Use CTEs for: Readability, reusing calculations, recursive queries",
                "Avoid CTEs when: Single simple subquery, performance-critical hotpath",
                "CTEs make code maintainable; use Query Store to track performance",
            ],
        },
        {
            "title": "Check Tempdb Contention",
            "description": "Diagnose and resolve tempdb allocation contention",
            "sql": (
                "-- Check for allocation contention waits\n"
                "SELECT \n"
                "    wait_type,\n"
                "    waiting_tasks_count,\n"
                "    wait_time_ms,\n"
                "    max_wait_time_ms\n"
                "FROM sys.dm_os_wait_stats\n"
                "WHERE wait_type IN ('PAGELATCH_UP', 'PAGELATCH_EX', 'PAGELATCH_SH')\n"
                "    AND wait_time_ms > 0\n"
                "ORDER BY wait_time_ms DESC;\n"
                "\n"
                "-- Check tempdb file configuration\n"
                "SELECT \n"
                "    name AS file_name,\n"
                "    physical_name,\n"
                "    size * 8 / 1024 AS size_mb\n"
                "FROM tempdb.sys.database_files;\n"
                "\n"
                "-- Check current tempdb usage\n"
                "SELECT \n"
                "    SUM(unallocated_extent_page_count) / 128 AS free_mb,\n"
                "    SUM(user_object_reserved_page_count) / 128 AS user_objects_mb,\n"
                "    SUM(internal_object_reserved_page_count) / 128 AS internal_objects_mb\n"
                "FROM sys.dm_db_file_space_usage;"
            ),
            "action": (
                "-- Add more tempdb files (one per CPU core, up to 8)\n"
                "ALTER DATABASE tempdb ADD FILE (\n"
                "    NAME = tempdev2,\n"
                "    FILENAME = 'C:\\SQLData\\tempdb2.ndf',\n"
                "    SIZE = 8GB,\n"
                "    FILEGROWTH = 512MB\n"
                ");"
            ),
            "warning": "Adding tempdb files requires careful planning. Files should be equal size and on fast storage (SSD). Requires SQL Server restart to take full effect.",
            "guidance": [
                "High PAGELATCH_UP or PAGELATCH_EX waits indicate contention",
                "Create 1 file per CPU core (up to 8 files initially)",
                "All files should be SAME size (critical for proportional fill)",
                "Place files on fast storage (SSD/NVMe)",
            ],
            "checks": [
                {"label": "PAGELATCH waits > 1000ms total?", "key": "pagelatchWaits",
                 "advice": "Add more tempdb files (1 per CPU core, up to 8 initially). Ensure all files are equal size."},
                {"label": "Tempdb has fewer files than CPU cores?", "key": "insufficientFiles",
                 "advice": "Add tempdb data files: ALTER DATABASE tempdb ADD FILE. Create 1 file per CPU core (max 8 for starters)."},
                {"label": "Tempdb files are different sizes?", "key": "unequalSizes",
                 "advice": "Resize all tempdb files to equal size: ALTER DATABASE tempdb MODIFY FILE. Equal sizes ensure proper proportional fill."},
                {"label": "High tempdb usage by specific sessions?", "key": "highUsage",
                 "advice": "Identify the session using sys.dm_db_session_space_usage. Review the query causing high usage."},
                {"label": "Frequent tempdb autogrowth events?", "key": "autogrowth",
                 "advice": "Pre-size tempdb files larger (8GB+ per file). Use fixed growth increments (512MB-1GB) not percentages."},
            ],
        },
        {
            "title": "Identify Blocking and Deadlocks",
            "description": "Find and resolve blocking chains and deadlock issues",
            "sql": (
                "-- Find current blocking sessions\n"
                "SELECT \n"
                "    blocking.session_id AS blocking_session_id,\n"
                "    blocked.session_id AS blocked_session_id,\n"
                "    blocking_text.text AS blocking_query,\n"
                "    blocked_text.text AS blocked_query,\n"
                "    blocked.wait_time / 1000 AS wait_time_seconds,\n"
                "    blocked.wait_type\n"
                "FROM sys.dm_exec_requests blocked\n"
                "INNER JOIN sys.dm_exec_sessions blocking \n"
                "    ON blocked.blocking_session_id = blocking.session_id\n"
                "OUTER APPLY sys.dm_exec_sql_text(blocked.sql_handle) blocked_text\n"
                "OUTER APPLY sys.dm_exec_sql_text(blocking.most_recent_sql_handle) blocking_text\n"
                "WHERE blocked.blocking_session_id <> 0\n"
                "ORDER BY blocked.wait_time DESC;\n"
                "\n"
                "-- View lock details\n"
                "SELECT \n"
                "    l.request_session_id AS session_id,\n"
                "    l.resource_type,\n"
                "    l.request_mode,\n"
                "    l.request_status,\n"
                "    OBJECT_NAME(p.object_id, l.resource_database_id) AS object_name\n"
                "FROM sys.dm_tran_locks l\n"
                "LEFT JOIN sys.partitions p ON l.resource_associated_entity_id = p.hobt_id\n"
                "WHERE l.request_session_id <> @@SPID\n"
                "ORDER BY l.request_session_id, l.resource_type;"
            ),
            "action": (
                "-- Kill blocking session (use carefully!)\n"
                "KILL [blocking_session_id];\n"
                "\n"
                "-- Enable deadlock trace flag for logging\n"
                "DBCC TRACEON(1222, -1);\n"
                "\n"
                "-- Use READ COMMITTED SNAPSHOT ISOLATION to reduce blocking\n"
                "ALTER DATABASE YourDatabase SET READ_COMMITTED_SNAPSHOT ON;"
            ),
            "warning": "Killing sessions terminates user connections and rolls back their transactions. Use only when necessary. Test isolation level changes thoroughly before production use.",
            "guidance": [
                "Blocking occurs when one session holds locks that another session needs",
                "Deadlock = circular blocking (Session A waits for B, B waits for A)",
                "Keep transactions short and fast",
                "Add appropriate indexes to reduce scan times",
                "Access tables in consistent order across queries",
                "Use READ_COMMITTED_SNAPSHOT to allow readers during writes",
            ],
            "checks": [
                {"label": "Sessions blocked > 10 seconds?", "key": "longBlocking",
                 "advice": "Identify the blocking session using sys.dm_exec_requests. Review the blocking query - add indexes, optimize, or shorten the transaction. Consider killing the blocking session."},
                {"label": "Blocking chains with 3+ levels?", "key": "deepChains",
                 "advice": "Find the head blocker (session with blocking_session_id = 0). This session is holding locks that cascade down. Review its query, add appropriate indexes, or commit/rollback the transaction."},
                {"label": "Deadlocks occurring frequently?", "key": "frequentDeadlocks",
                 "advice": "Enable trace flag 1222 to log deadlocks: DBCC TRACEON(1222, -1). Review deadlock graphs. Fix by accessing tables in same order, using proper indexes, or reducing transaction scope."},
                {"label": "Lock escalation to table level?", "key": "lockEscalation",
                 "advice": "Break large operations into smaller batches. Use ROWLOCK hint to prevent escalation. Consider disabling escalation: ALTER TABLE table SET (LOCK_ESCALATION = DISABLE) - use carefully."},
                {"label": "Long-running transactions (>60s)?", "key": "longTransactions",
                 "advice": "Identify using sys.dm_tran_active_transactions. Review application code - commit/rollback transactions promptly. Add indexes to speed up queries."},
            ],
        },
    ],

    "postgresql": [
        {
            "title": "Find Slow Queries (pg_stat_statements)",
            "description": "Identify top offenders by total time, average time, and variance",
            "sql": (
                "-- Enable extension if not already (do once)\n"
                "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;\n"
                "\n"
                "-- Top queries by total time\n"
                "SELECT query,\n"
                "       calls,\n"
                "       ROUND(total_exec_time::numeric, 2) AS total_ms,\n"
                "       ROUND(mean_exec_time::numeric, 2)  AS avg_ms,\n"
                "       ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,\n"
                "       ROUND(((total_exec_time / SUM(total_exec_time) OVER()) * 100)::numeric, 2) AS pct_total\n"
                "FROM pg_stat_statements\n"
                "ORDER BY total_exec_time DESC\n"
                "LIMIT 20;\n"
                "\n"
                "-- Queries with high variance (plan instability)\n"
                "SELECT query,\n"
                "       calls,\n"
                "       ROUND(mean_exec_time::numeric, 2)   AS avg_ms,\n"
                "       ROUND(stddev_exec_time::numeric, 2)  AS stddev_ms,\n"
                "       ROUND((stddev_exec_time / NULLIF(mean_exec_time, 0))::numeric, 2) AS cv\n"
                "FROM pg_stat_statements\n"
                "WHERE calls > 10\n"
                "ORDER BY cv DESC\n"
                "LIMIT 20;"
            ),
            "guidance": [
                "total_exec_time: Best starting point - highest total time = most optimization leverage",
                "High stddev relative to mean (cv > 1) = plan instability or parameter sensitivity",
                "High calls + low avg_ms = frequent lightweight query; even small savings compound",
                "pg_stat_statements requires track_activity_query_size to be set large enough",
                "On RDS/Aurora: enable via Parameter Group with shared_preload_libraries = pg_stat_statements",
                "Reset stats after significant changes to get clean before/after comparison",
            ],
        },
        {
            "title": "Aurora Performance Insights",
            "description": "Identify DB load by wait event, top SQL, and top hosts (Aurora / RDS)",
            "action": (
                "# Enable Performance Insights (if not already)\n"
                "# RDS Console: Modify instance -> Performance Insights -> Enable\n"
                "# Or via CLI:\n"
                "aws rds modify-db-instance \\\n"
                "  --db-instance-identifier my-db \\\n"
                "  --enable-performance-insights \\\n"
                "  --performance-insights-retention-period 7\n"
                "\n"
                "# Query Performance Insights via CLI\n"
                "aws pi get-resource-metrics \\\n"
                "  --service-type RDS \\\n"
                "  --identifier db:my-db-instance-id \\\n"
                "  --metric-queries '[{\"Metric\": \"db.load.avg\", \"GroupBy\": {\"Group\": \"db.wait_event\", \"Limit\": 10}}]' \\\n"
                "  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \\\n"
                "  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \\\n"
                "  --period-in-seconds 60"
            ),
            "guidance": [
                "AAS > number of vCPUs = system is CPU-saturated or waiting",
                "CPU wait: Queries are compute-bound (optimize query, add indexes, scale instance)",
                "IO:DataFileRead: Reading data pages from storage (missing indexes, large scans)",
                "IO:WALWrite: Write-heavy workload",
                "Lock:relation / Lock:tuple: Lock contention (see Blocking step)",
                "Start here before EXPLAIN ANALYZE - PI shows you which queries to investigate",
            ],
            "checks": [
                {"label": "DB load consistently > vCPU count?", "key": "highDBLoad",
                 "advice": "System is saturated. Check top wait events to determine if CPU-bound (scale up) or I/O-bound (add indexes, increase Aurora storage I/O)."},
                {"label": "IO:DataFileRead is top wait event?", "key": "dataFileRead",
                 "advice": "Queries are reading pages from Aurora storage. Add indexes to eliminate full table scans. Consider scaling to a memory-optimized instance class."},
                {"label": "Lock waits prominent in wait events?", "key": "piLockWaits",
                 "advice": "Follow the Identify Blocking step to find the blocking queries."},
                {"label": "CPU is top wait event?", "key": "cpuBound",
                 "advice": "Queries are compute-bound. Identify the top SQL in Performance Insights, run EXPLAIN ANALYZE, and look for large seq scans or hash joins."},
            ],
        },
        {
            "title": "Get Execution Plan with Full Details",
            "description": "Run EXPLAIN ANALYZE to see actual execution statistics",
            "sql": "EXPLAIN (ANALYZE, BUFFERS, VERBOSE)\nyour_query_here;",
            "warning": "EXPLAIN ANALYZE actually executes the query! For INSERT/UPDATE/DELETE, wrap in BEGIN; ... ROLLBACK; to avoid changes.",
            "guidance": [
                "Look for nodes with high 'actual time' values",
                "Compare 'rows' (estimated) vs 'actual rows' - big mismatches (10x+) indicate stale statistics",
                "Check 'Buffers: shared read=X' - high values mean disk I/O (slow)",
                "Sequential Scans on large tables are red flags",
                "Look for 'external merge' in sorts = disk-based sorting (increase work_mem)",
            ],
            "checks": [
                {"label": "Execution time > 1 second?", "key": "slowExecution",
                 "advice": "Review the execution plan for expensive operations. Add indexes for seq scans, increase work_mem for sorts/hashes, optimize WHERE clauses."},
                {"label": "Row estimates way off (10x+ difference)?", "key": "badEstimates",
                 "advice": "Run ANALYZE on the affected tables. Consider increasing statistics target: ALTER TABLE table ALTER COLUMN col SET STATISTICS 1000; Then ANALYZE again."},
                {"label": "Seq Scan on tables with 100k+ rows?", "key": "seqScan",
                 "advice": "Add an index: CREATE INDEX CONCURRENTLY idx_name ON table(column). Use CONCURRENTLY to avoid blocking."},
                {"label": "High buffer reads (not hits)?", "key": "diskIO",
                 "advice": "Increase shared_buffers if <25% of RAM. Add indexes to reduce table scans."},
                {"label": "External merge or external sort present?", "key": "externalSort",
                 "advice": "Increase work_mem: SET work_mem = '256MB'. Or add index to avoid sort."},
                {"label": "Nested Loop with loops > 1000?", "key": "highLoops",
                 "advice": "Add index on the inner table's join column: CREATE INDEX CONCURRENTLY idx ON inner_table(join_col)."},
                {"label": "Hash join with multiple batches?", "key": "hashBatches",
                 "advice": "Increase work_mem to fit hash table in memory: SET work_mem = '512MB'."},
            ],
        },
        {
            "title": "Check Statistics Freshness",
            "description": "Verify when statistics were last updated",
            "sql": (
                "SELECT schemaname, relname, \n"
                "       last_analyze, last_autoanalyze,\n"
                "       n_live_tup as row_count,\n"
                "       n_mod_since_analyze as rows_changed\n"
                "FROM pg_stat_user_tables \n"
                "WHERE relname IN ('table1', 'table2')\n"
                "ORDER BY last_analyze NULLS FIRST;"
            ),
            "action": "ANALYZE table_name;\n\n-- Update all tables in schema\nANALYZE;",
            "guidance": [
                "Statistics should be updated after significant data changes (>10% rows)",
                "If last_analyze is NULL or very old, run ANALYZE immediately",
                "n_mod_since_analyze shows rows changed since last analyze",
            ],
        },
        {
            "title": "Identify Missing Indexes",
            "description": "Look for opportunities to add indexes",
            "sql": (
                "SELECT schemaname, relname, \n"
                "       seq_scan, seq_tup_read,\n"
                "       idx_scan, idx_tup_fetch\n"
                "FROM pg_stat_user_tables\n"
                "WHERE schemaname NOT IN ('pg_catalog', 'information_schema')\n"
                "  AND seq_scan > 0\n"
                "ORDER BY seq_tup_read DESC\n"
                "LIMIT 20;"
            ),
            "action": (
                "CREATE INDEX idx_name ON table_name(column_name);\n"
                "\n"
                "CREATE INDEX idx_name ON table_name(col1) INCLUDE (col2);"
            ),
            "warning": "CREATE INDEX can lock tables. Use CREATE INDEX CONCURRENTLY to avoid blocking reads/writes (takes longer but safer).",
            "guidance": [
                "High seq_tup_read with low idx_scan suggests missing indexes",
                "Index columns used in WHERE, JOIN, and ORDER BY clauses",
                "Use INCLUDE for covering indexes (PostgreSQL 11+)",
            ],
        },
        {
            "title": "Index Health: Unused and Bloated Indexes",
            "description": "Find indexes wasting write overhead and indexes needing rebuild",
            "sql": (
                "-- Unused indexes (never scanned since last stats reset)\n"
                "SELECT schemaname, relname AS table_name, indexrelname AS index_name,\n"
                "       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,\n"
                "       idx_scan\n"
                "FROM pg_stat_user_indexes\n"
                "WHERE idx_scan = 0\n"
                "  AND schemaname NOT IN ('pg_catalog', 'information_schema')\n"
                "ORDER BY pg_relation_size(indexrelid) DESC;\n"
                "\n"
                "-- Bloated indexes\n"
                "SELECT schemaname, relname AS table_name, indexrelname AS index_name,\n"
                "       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,\n"
                "       pg_size_pretty(pg_relation_size(relid)) AS table_size\n"
                "FROM pg_stat_user_indexes\n"
                "JOIN pg_index USING (indexrelid)\n"
                "WHERE NOT indisprimary\n"
                "  AND schemaname NOT IN ('pg_catalog', 'information_schema')\n"
                "ORDER BY pg_relation_size(indexrelid) DESC\n"
                "LIMIT 20;"
            ),
            "action": (
                "-- Rebuild a bloated index without locking (PostgreSQL 12+)\n"
                "REINDEX INDEX CONCURRENTLY idx_name;\n"
                "\n"
                "-- Drop an unused index (verify it's truly unused first!)\n"
                "DROP INDEX CONCURRENTLY idx_name;"
            ),
            "warning": "idx_scan = 0 only means the index hasn't been used since the last pg_stat_reset(). Cross-check before dropping.",
            "guidance": [
                "Unused indexes still incur write overhead on every INSERT/UPDATE/DELETE",
                "Index bloat > 200% of table size often warrants REINDEX CONCURRENTLY",
                "Duplicate indexes with identical leading columns are pure overhead",
                "After dropping unused indexes, monitor for a week before declaring success",
            ],
            "checks": [
                {"label": "Indexes with idx_scan = 0?", "key": "unusedIndexes",
                 "advice": "Confirm the index is genuinely unused (check uptime and last stats reset). If confirmed, drop with DROP INDEX CONCURRENTLY."},
                {"label": "Index size >> table size?", "key": "bloatedIndex",
                 "advice": "Run REINDEX INDEX CONCURRENTLY to rebuild without locking. Check for autovacuum not keeping up."},
                {"label": "Duplicate indexes found?", "key": "duplicateIndexes",
                 "advice": "Keep the index with more INCLUDE columns. Drop the narrower duplicate with DROP INDEX CONCURRENTLY."},
            ],
        },
        {
            "title": "Analyze Join Performance",
            "description": "Check if join methods are optimal",
            "sql": (
                "SET enable_nestloop = off;\n"
                "EXPLAIN (ANALYZE, BUFFERS) your_query_here;\n"
                "RESET enable_nestloop;"
            ),
            "guidance": [
                "Nested Loop: Best for small datasets or when inner table has index on join key",
                "Hash Join: Best for large datasets without indexes, requires work_mem",
                "Merge Join: Best when both inputs already sorted on join key",
                "If disabling a join type helps significantly, investigate why planner chose poorly",
            ],
            "checks": [
                {"label": "Nested Loop with high loop count (>1000)?", "key": "highLoops",
                 "advice": "Add index on inner table join column. CREATE INDEX CONCURRENTLY idx ON inner(join_key)."},
                {"label": "Hash join with multiple batches?", "key": "hashBatches",
                 "advice": "Increase work_mem to fit hash table: SET work_mem = '512MB'."},
                {"label": "Join producing way more rows than expected?", "key": "joinExplosion",
                 "advice": "Check for cartesian product (missing join condition). Run ANALYZE to update statistics."},
            ],
        },
        {
            "title": "Optimize Patterns",
            "description": "Rewrite inefficient queries",
            "examples": [
                {"bad": "WHERE customer_id IN (SELECT...)", "good": "JOIN customers c ON o.customer_id = c.id", "why": "IN with subquery can't short-circuit; JOIN allows better optimization"},
                {"bad": "WHERE DATE(created_at) = '2024-01-01'", "good": "WHERE created_at >= '2024-01-01' AND created_at < '2024-01-02'", "why": "Function on column prevents index usage; range allows index seek"},
                {"bad": "WHERE LOWER(email) = 'user@example.com'", "good": "CREATE INDEX idx ON table(LOWER(email));\nWHERE LOWER(email) = 'user@example.com'", "why": "Function prevents normal index use; expression index solves this"},
                {"bad": "WHERE UPPER(name) = 'JOHN'", "good": "WHERE name ILIKE 'john'", "why": "UPPER() prevents index usage; ILIKE is case-insensitive and more efficient"},
                {"bad": "SELECT * FROM orders WHERE amount > 1000 OR status = 'urgent'",
                 "good": "SELECT * FROM orders WHERE amount > 1000\nUNION\nSELECT * FROM orders WHERE status = 'urgent'",
                 "why": "OR prevents using multiple indexes; UNION allows index on each condition"},
            ],
            "guidance": [
                "Replace IN with JOINs",
                "Avoid functions on indexed columns",
                "Use EXISTS instead of IN for large subqueries",
                "Create expression indexes for functions in WHERE clause",
                "Use ILIKE instead of UPPER()/LOWER() for case-insensitive searches",
            ],
        },
        {
            "title": "Using CTEs Effectively",
            "description": "When to use Common Table Expressions",
            "examples": [
                {"bad": "SELECT o.*,\n  (SELECT SUM(amount) FROM order_items WHERE order_id = o.id) as total,\n  (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count\nFROM orders o",
                 "good": "WITH order_totals AS (\n  SELECT order_id, SUM(amount) as total, COUNT(*) as item_count\n  FROM order_items GROUP BY order_id\n)\nSELECT o.*, ot.total, ot.item_count\nFROM orders o JOIN order_totals ot ON o.id = ot.order_id",
                 "why": "Multiple correlated subqueries scan repeatedly; CTE scans once and joins"},
            ],
            "guidance": [
                "Use CTEs for: Improving readability, avoiding repeated subqueries, breaking complex logic into steps",
                "Avoid CTEs when: Simple queries (adds overhead), results could be a view",
                "PostgreSQL doesn't always optimize CTEs away - consider MATERIALIZED or NOT MATERIALIZED hints",
            ],
        },
        {
            "title": "Check Configuration Settings",
            "description": "Review memory and planner settings",
            "sql": (
                "SELECT name, setting, unit, source, context \n"
                "FROM pg_settings \n"
                "WHERE name IN (\n"
                "  'work_mem', 'shared_buffers', 'effective_cache_size', \n"
                "  'random_page_cost', 'seq_page_cost', 'effective_io_concurrency',\n"
                "  'maintenance_work_mem', 'autovacuum_work_mem',\n"
                "  'max_parallel_workers_per_gather', 'max_worker_processes',\n"
                "  'checkpoint_completion_target', 'wal_buffers'\n"
                ");"
            ),
            "action": (
                "-- Memory settings (adjust for your server)\n"
                "SET work_mem = '256MB';\n"
                "SET maintenance_work_mem = '1GB';\n"
                "\n"
                "-- Disk I/O settings (especially for SSDs)\n"
                "SET random_page_cost = 1.1;\n"
                "SET effective_io_concurrency = 200;\n"
                "\n"
                "-- Parallelism\n"
                "SET max_parallel_workers_per_gather = 4;"
            ),
            "warning": "Changing configuration settings can impact server performance and stability. Test in non-production first. Some settings require PostgreSQL restart (shared_buffers, max_worker_processes).",
            "guidance": [
                "work_mem: Per-operation memory for sorts/hashes (default 4MB often too low)",
                "shared_buffers: PostgreSQL's cache (25% of RAM typical)",
                "effective_cache_size: Tells planner about OS cache (50-75% of total RAM)",
                "random_page_cost: 1.1 for SSD, 4.0 for HDD (default)",
                "effective_io_concurrency: 200 for SSD, 1-2 for HDD",
                "max_parallel_workers_per_gather: Workers per query (2-4 typical)",
            ],
        },
        {
            "title": "Identify Blocking and Lock Contention",
            "description": "Find queries blocking others and lock conflicts",
            "sql": (
                "-- Find blocking queries\n"
                "SELECT \n"
                "    blocked_locks.pid AS blocked_pid,\n"
                "    blocked_activity.usename AS blocked_user,\n"
                "    blocking_locks.pid AS blocking_pid,\n"
                "    blocking_activity.usename AS blocking_user,\n"
                "    blocked_activity.query AS blocked_query,\n"
                "    blocking_activity.query AS blocking_query,\n"
                "    now() - blocked_activity.query_start AS blocked_duration\n"
                "FROM pg_catalog.pg_locks blocked_locks\n"
                "JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid\n"
                "JOIN pg_catalog.pg_locks blocking_locks \n"
                "    ON blocking_locks.locktype = blocked_locks.locktype\n"
                "    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation\n"
                "    AND blocking_locks.pid != blocked_locks.pid\n"
                "JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid\n"
                "WHERE NOT blocked_locks.granted\n"
                "ORDER BY blocked_activity.query_start;"
            ),
            "action": (
                "-- Terminate blocking query (use carefully!)\n"
                "SELECT pg_terminate_backend(blocking_pid);\n"
                "\n"
                "-- Cancel query without terminating connection\n"
                "SELECT pg_cancel_backend(pid);\n"
                "\n"
                "-- Set lock timeout to prevent indefinite waits\n"
                "SET lock_timeout = '5s';\n"
                "\n"
                "-- Set statement timeout\n"
                "SET statement_timeout = '30s';"
            ),
            "warning": "Terminating or canceling queries will abort transactions and may cause application errors.",
            "guidance": [
                "PostgreSQL uses MVCC for most reads (no locks needed)",
                "Locks occur during writes, DDL operations, and explicit LOCK commands",
                "Keep transactions short and fast",
                "Use CREATE INDEX CONCURRENTLY for index creation",
                "Run DDL during maintenance windows",
            ],
            "checks": [
                {"label": "Queries blocked > 30 seconds?", "key": "longBlocking",
                 "advice": "Find blocking query in pg_stat_activity. Kill if needed: SELECT pg_terminate_backend(blocking_pid). Add indexes to speed up blocking query."},
                {"label": "ACCESS EXCLUSIVE locks on busy tables?", "key": "exclusiveLocks",
                 "advice": "Use CREATE INDEX CONCURRENTLY instead of CREATE INDEX. Schedule DDL during maintenance windows."},
                {"label": "Many lock waits in pg_stat_activity?", "key": "lockWaits",
                 "advice": "Add indexes to reduce scan times. Keep transactions short. Use lock_timeout: SET lock_timeout = '5s'."},
                {"label": "DDL operations during peak hours?", "key": "peakDDL",
                 "advice": "Schedule DDL operations during maintenance windows. Use CONCURRENTLY option when available."},
                {"label": "No lock_timeout configured?", "key": "noLockTimeout",
                 "advice": "Set lock_timeout: ALTER SYSTEM SET lock_timeout = '30s'. Or per-session: SET lock_timeout = '10s'."},
            ],
        },
        {
            "title": "Analyze Wait Events",
            "description": "Understand what active queries are waiting on",
            "sql": (
                "-- Current wait events for active sessions\n"
                "SELECT pid,\n"
                "       wait_event_type,\n"
                "       wait_event,\n"
                "       state,\n"
                "       ROUND(EXTRACT(EPOCH FROM (now() - query_start))::numeric, 2) AS query_secs,\n"
                "       LEFT(query, 80) AS query_snippet\n"
                "FROM pg_stat_activity\n"
                "WHERE state <> 'idle'\n"
                "  AND pid <> pg_backend_pid()\n"
                "ORDER BY query_secs DESC;\n"
                "\n"
                "-- I/O time breakdown (PostgreSQL 13-16)\n"
                "SELECT query, calls,\n"
                "       ROUND(mean_exec_time::numeric, 2) AS avg_total_ms\n"
                "FROM pg_stat_statements\n"
                "ORDER BY total_exec_time DESC\n"
                "LIMIT 20;"
            ),
            "guidance": [
                "NULL (no wait): Session is on CPU - CPU-bound query",
                "IO: Waiting on storage reads/writes (DataFileRead = missing index or cold cache)",
                "Lock: Waiting for a row/table/advisory lock (see Blocking step)",
                "LWLock: Internal PostgreSQL structure contention",
                "Client: Waiting for the application to read results",
                "Many sessions on IO:DataFileRead -> missing indexes or buffer cache too small",
                "Many sessions on CPU (no wait) -> query needs optimization",
            ],
            "checks": [
                {"label": "IO:DataFileRead is most common wait?", "key": "dataFileReadWait",
                 "advice": "Add indexes to eliminate sequential scans. Check buffer cache hit rate. On Aurora, consider scaling to memory-optimized instance."},
                {"label": "High blk_read_time in pg_stat_statements?", "key": "highBlkReadTime",
                 "advice": "Enable track_io_timing = on to get accurate I/O data. Queries with high avg_disk_read_ms are I/O-bound."},
                {"label": "Many sessions waiting with no wait_event (CPU)?", "key": "cpuWaits",
                 "advice": "System is CPU-saturated. Find top CPU queries in pg_stat_statements. Look for large seq scans, hash joins processing millions of rows."},
                {"label": "LWLock:BufferMapping or LWLock:WALWrite frequent?", "key": "lwlocks",
                 "advice": "BufferMapping contention: increase shared_buffers. WALWrite contention: tune wal_buffers and checkpoint settings."},
            ],
        },
        {
            "title": "Monitor Autovacuum and Table Bloat",
            "description": "Check vacuum health and identify bloated tables",
            "sql": (
                "-- Check autovacuum activity and dead tuples\n"
                "SELECT \n"
                "    schemaname, relname,\n"
                "    n_live_tup AS live_tuples,\n"
                "    n_dead_tup AS dead_tuples,\n"
                "    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_tuple_percent,\n"
                "    last_vacuum, last_autovacuum\n"
                "FROM pg_stat_user_tables\n"
                "WHERE n_dead_tup > 1000\n"
                "ORDER BY n_dead_tup DESC\n"
                "LIMIT 20;"
            ),
            "action": (
                "-- Manual vacuum on specific table\n"
                "VACUUM ANALYZE table_name;\n"
                "\n"
                "-- Tune autovacuum for specific table\n"
                "ALTER TABLE table_name SET (\n"
                "    autovacuum_vacuum_scale_factor = 0.05,\n"
                "    autovacuum_analyze_scale_factor = 0.02\n"
                ");"
            ),
            "warning": "VACUUM FULL locks the entire table exclusively and can take hours on large tables. Use only during maintenance windows. Regular VACUUM (non-FULL) is safe to run anytime.",
            "guidance": [
                "Bloat = wasted space from UPDATE/DELETE operations",
                "PostgreSQL uses MVCC - UPDATEs create new row versions; old versions become dead tuples",
                "High dead_tuple_percent (>20% is concerning)",
                "last_autovacuum should be recent (within hours/days)",
                "Long-running transactions prevent vacuum from cleaning up",
            ],
            "checks": [
                {"label": "Dead tuple percentage > 20%?", "key": "highDeadTuples",
                 "advice": "Run manual VACUUM ANALYZE on affected tables immediately. Tune autovacuum: ALTER TABLE table SET (autovacuum_vacuum_scale_factor = 0.05)."},
                {"label": "Last autovacuum > 7 days ago?", "key": "staleVacuum",
                 "advice": "Run VACUUM ANALYZE manually. Check autovacuum logs for errors. Tune autovacuum_naptime and vacuum thresholds."},
                {"label": "Long transactions (>1 hour) running?", "key": "longTransactions",
                 "advice": "Identify using pg_stat_activity where xact_start is old. Long transactions prevent VACUUM from removing dead tuples."},
                {"label": "Autovacuum not running on busy tables?", "key": "noAutovacuum",
                 "advice": "Increase autovacuum workers: ALTER SYSTEM SET autovacuum_max_workers = 5. Lower scale_factor for busy tables."},
            ],
        },
        {
            "title": "Monitor Connection Pooling and Limits",
            "description": "Check connection usage and identify connection issues",
            "sql": (
                "-- Check current connection counts by state\n"
                "SELECT state, COUNT(*) AS connection_count\n"
                "FROM pg_stat_activity\n"
                "GROUP BY state\n"
                "ORDER BY connection_count DESC;\n"
                "\n"
                "-- Check connection limits\n"
                "SELECT \n"
                "    setting AS max_connections,\n"
                "    (SELECT COUNT(*) FROM pg_stat_activity) AS current_connections,\n"
                "    ROUND(100.0 * (SELECT COUNT(*) FROM pg_stat_activity) / setting::int, 2) AS percent_used\n"
                "FROM pg_settings\n"
                "WHERE name = 'max_connections';\n"
                "\n"
                "-- Check for idle in transaction (problematic)\n"
                "SELECT pid, usename, application_name,\n"
                "       now() - xact_start AS transaction_age,\n"
                "       query\n"
                "FROM pg_stat_activity\n"
                "WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')\n"
                "ORDER BY xact_start\n"
                "LIMIT 20;"
            ),
            "action": (
                "-- Set idle_in_transaction_session_timeout\n"
                "SET idle_in_transaction_session_timeout = '10min';\n"
                "\n"
                "-- Set connection limits per database\n"
                "ALTER DATABASE your_database CONNECTION LIMIT 50;"
            ),
            "warning": "Terminating connections will abort user transactions and may cause application errors.",
            "guidance": [
                "idle in transaction: In transaction but not executing (BAD - holds locks!)",
                "Connection exhaustion: Applications getting 'too many connections' errors",
                "Popular poolers: PgBouncer, Pgpool-II",
                "Don't set max_connections too high (each connection uses ~10MB RAM)",
                "Set idle_in_transaction_session_timeout to auto-kill stuck transactions",
            ],
            "checks": [
                {"label": "Connection usage > 80% of max_connections?", "key": "highConnUsage",
                 "advice": "Implement connection pooling (PgBouncer) immediately. Terminate idle connections. Set connection limits per database/user."},
                {"label": "Many idle in transaction connections?", "key": "idleInTransaction",
                 "advice": "Set idle_in_transaction_session_timeout = '10min'. Review application code for missing commits/rollbacks."},
                {"label": "No connection pooling in use?", "key": "noPooling",
                 "advice": "Install and configure PgBouncer. Use pool_mode=transaction for most apps. Set default_pool_size=25."},
            ],
        },
        {
            "title": "Query CloudWatch Logs (Aurora / RDS)",
            "description": "Find slow queries and errors using CloudWatch Logs Insights",
            "sql": (
                "-- CloudWatch Logs Insights queries (run in AWS Console)\n"
                "-- Log group: /aws/rds/instance/<db-identifier>/postgresql\n"
                "\n"
                "-- Find slowest queries in the last hour\n"
                "-- fields @timestamp, @message\n"
                "-- | filter @message like /duration:/\n"
                "-- | parse @message \"duration: * ms  statement: *\" as duration_ms, statement\n"
                "-- | sort duration_ms desc\n"
                "-- | limit 50"
            ),
            "action": (
                "# Enable slow query logging on RDS/Aurora via Parameter Group:\n"
                "# log_min_duration_statement = 1000   -- Log queries over 1 second (ms)\n"
                "# log_lock_waits = 1                  -- Log lock waits\n"
                "# log_temp_files = 0                  -- Log all temp file creation\n"
                "\n"
                "# AWS CLI: download log\n"
                "aws rds download-db-log-file-portion \\\n"
                "  --db-instance-identifier my-db \\\n"
                "  --log-file-name error/postgresql.log.2024-01-01.00 \\\n"
                "  --output text > pg.log"
            ),
            "warning": "Enabling verbose logging on high-traffic instances generates large log volumes and increases storage costs.",
            "guidance": [
                "Logs are in CloudWatch under /aws/rds/instance/<id>/postgresql",
                "Set log_min_duration_statement in the DB Parameter Group",
                "log_min_duration_statement = 1000: Captures queries taking >1s",
                "log_lock_waits = on: Essential for diagnosing lock contention",
                "log_temp_files = 0: Logs any temp file creation (indicates work_mem pressure)",
            ],
            "checks": [
                {"label": "log_min_duration_statement not set?", "key": "noSlowQueryLog",
                 "advice": "Set log_min_duration_statement = 1000 in your RDS/Aurora Parameter Group."},
                {"label": "No CloudWatch log group for PostgreSQL?", "key": "noLogGroup",
                 "advice": "Enable log exports in RDS console: Modify instance -> Log exports -> check 'PostgreSQL log'."},
                {"label": "Queries over 5 seconds appearing frequently?", "key": "verySlowQueries",
                 "advice": "Export the slow query log and analyze with pgBadger. Run EXPLAIN ANALYZE on the worst offenders."},
            ],
        },
        {
            "title": "Analyze Logs with pgBadger",
            "description": "Generate query performance reports from PostgreSQL logs",
            "action": (
                "# Install pgBadger\n"
                "brew install pgbadger          # macOS\n"
                "apt-get install pgbadger       # Ubuntu/Debian\n"
                "\n"
                "# Download log from RDS/Aurora\n"
                "aws rds download-db-log-file-portion \\\n"
                "  --db-instance-identifier my-db-instance \\\n"
                "  --log-file-name error/postgresql.log.2024-01-01.00 \\\n"
                "  --output text > postgresql.log\n"
                "\n"
                "# Generate HTML report\n"
                "pgbadger postgresql.log -o report.html\n"
                "\n"
                "# Open report\n"
                "open report.html   # macOS"
            ),
            "guidance": [
                "pgBadger reveals: Top slowest queries, queries with most I/O, lock waits, temp file usage",
                "Required log settings: log_min_duration_statement, log_line_prefix with %t and %p",
                "Focus on 'Slowest queries' by total time - most optimization leverage",
                "Temp file section: any entries indicate work_mem is too low",
            ],
            "checks": [
                {"label": "Report shows queries with high total time?", "key": "highTotalTime",
                 "advice": "Run EXPLAIN ANALYZE on the top 3-5 queries. Add indexes, rewrite patterns, or tune work_mem."},
                {"label": "Many temp file entries in report?", "key": "tempFiles",
                 "advice": "Temp files mean work_mem is too small. Increase work_mem: SET work_mem = '256MB'."},
                {"label": "High lock wait counts?", "key": "lockWaitReport",
                 "advice": "Review the lock section for which tables/queries are involved. Add indexes to speed up locking queries."},
            ],
        },
    ],

    "mysql": [
        {
            "title": "Get Execution Plan",
            "description": "Analyze query execution with EXPLAIN",
            "sql": (
                "EXPLAIN your_query_here;\n"
                "\n"
                "EXPLAIN FORMAT=TREE your_query_here;\n"
                "\n"
                "EXPLAIN ANALYZE your_query_here;"
            ),
            "warning": "EXPLAIN ANALYZE (MySQL 8.0.18+) actually executes the query! Be careful with INSERT/UPDATE/DELETE statements.",
            "guidance": [
                "type column: 'system' > 'const' > 'eq_ref' > 'ref' > 'range' > 'index' > 'ALL' (best to worst)",
                "type='ALL' means full table scan (bad for large tables)",
                "Extra column: 'Using filesort' = expensive sort, 'Using temporary' = temp table needed",
                "rows column: Estimated rows examined (lower is better)",
                "filtered column: % of rows filtered by WHERE (higher is better)",
            ],
            "checks": [
                {"label": "type = ALL on tables >100k rows?", "key": "tableScan",
                 "advice": "Add an index on columns in WHERE, JOIN, or ORDER BY: CREATE INDEX idx_name ON table(column)."},
                {"label": "Using filesort or Using temporary?", "key": "tempSort",
                 "advice": "Add index on ORDER BY columns to eliminate filesort. Increase sort_buffer_size if sorts are unavoidable."},
                {"label": "High row count examined?", "key": "highRows",
                 "advice": "Add more selective indexes. Review WHERE clause conditions - are they using indexes?"},
                {"label": "key column is NULL (no index used)?", "key": "noIndex",
                 "advice": "No index being used! Create index on columns in WHERE/JOIN/ORDER BY: CREATE INDEX idx_name ON table(col1, col2)."},
            ],
        },
        {
            "title": "Update Table Statistics",
            "description": "Ensure optimizer has accurate statistics",
            "sql": (
                "SHOW TABLE STATUS LIKE 'table_name';\n"
                "\n"
                "SHOW INDEX FROM table_name;"
            ),
            "action": "ANALYZE TABLE table_name;\n\nANALYZE TABLE table_name PERSISTENT FOR ALL;",
            "warning": "ANALYZE TABLE can lock the table briefly. On large tables, this may cause brief blocking.",
            "guidance": [
                "Low or zero CARDINALITY indicates stale statistics",
                "Run ANALYZE TABLE after bulk inserts/updates/deletes (>10% rows)",
                "Check that cardinality reflects actual unique values",
            ],
        },
        {
            "title": "Profile Query Execution",
            "description": "Get detailed timing breakdown",
            "sql": (
                "SET profiling = 1;\n"
                "your_query_here;\n"
                "SHOW PROFILES;\n"
                "\n"
                "SHOW PROFILE FOR QUERY 1;\n"
                "SHOW PROFILE CPU, BLOCK IO FOR QUERY 1;"
            ),
            "guidance": [
                "Look for 'Sending data' - this is where most time should be",
                "High 'Creating tmp table' or 'Sorting result' indicates optimization opportunities",
                "Use Performance Schema for production (profiling is deprecated)",
            ],
        },
        {
            "title": "Create Missing Indexes",
            "description": "Add indexes based on query patterns",
            "sql": (
                "SELECT OBJECT_SCHEMA, OBJECT_NAME, INDEX_NAME,\n"
                "       COUNT_STAR as uses\n"
                "FROM performance_schema.table_io_waits_summary_by_index_usage\n"
                "WHERE OBJECT_SCHEMA = 'your_database'\n"
                "ORDER BY COUNT_STAR DESC;"
            ),
            "action": (
                "-- Standard index creation (locks table)\n"
                "CREATE INDEX idx_name ON table_name(column_name);\n"
                "\n"
                "-- InnoDB online DDL (MySQL 5.6+) - allows reads/writes\n"
                "CREATE INDEX idx_name ON table_name(column_name) \n"
                "  ALGORITHM=INPLACE, LOCK=NONE;\n"
                "\n"
                "-- Multi-column index (leftmost prefix rule!)\n"
                "CREATE INDEX idx_name ON table_name(col1, col2, col3);"
            ),
            "warning": "CREATE INDEX locks the table during creation. On InnoDB tables (MySQL 5.6+), use ALGORITHM=INPLACE, LOCK=NONE to allow concurrent reads/writes.",
            "guidance": [
                "Follow leftmost prefix rule: idx(a,b,c) works for a, a+b, a+b+c, but NOT b or c alone",
                "Use FORCE INDEX to test if index helps: FROM table FORCE INDEX(idx_name)",
                "InnoDB online DDL minimizes blocking but isn't completely lock-free",
            ],
        },
        {
            "title": "Optimize Join Performance",
            "description": "Review join methods and buffer settings",
            "sql": "SHOW VARIABLES LIKE 'join_buffer_size';",
            "action": "SET SESSION join_buffer_size = 256 * 1024 * 1024;\n\nSELECT STRAIGHT_JOIN ... FROM t1 JOIN t2;",
            "warning": "Changing join_buffer_size affects memory usage per connection. Monitor server memory.",
            "guidance": [
                "Increase join_buffer_size if join performance is poor",
                "MySQL uses nested loop joins primarily",
                "Adjust join_buffer_size based on available memory and query patterns",
            ],
        },
        {
            "title": "Tune Memory and Configuration",
            "description": "Adjust memory settings for better performance",
            "sql": (
                "SHOW VARIABLES LIKE 'tmp_table_size';\n"
                "SHOW GLOBAL STATUS LIKE 'Created_tmp%';"
            ),
            "action": (
                "SET SESSION tmp_table_size = 64 * 1024 * 1024;\n"
                "SET SESSION max_heap_table_size = 64 * 1024 * 1024;"
            ),
            "warning": "Increasing memory settings can lead to out-of-memory conditions if set too high. Monitor server resources.",
            "guidance": [
                "Increase tmp_table_size for temp tables",
                "Must match max_heap_table_size",
                "Adjust memory settings based on available RAM and concurrent connections",
            ],
        },
        {
            "title": "Fix Anti-Patterns",
            "description": "Avoid common mistakes",
            "examples": [
                {"bad": "WHERE col1 = 'A' OR col2 = 'B'", "good": "WHERE col1 = 'A'\nUNION ALL\nSELECT ... WHERE col2 = 'B'", "why": "OR can't use indexes on both columns; UNION uses index on each"},
                {"bad": "WHERE DATE(created_at) = '2024-01-01'", "good": "WHERE created_at >= '2024-01-01' AND created_at < '2024-01-02'", "why": "DATE() function forces table scan; range uses index"},
                {"bad": "WHERE name LIKE '%smith%'", "good": "CREATE FULLTEXT INDEX idx ON table(name);\nWHERE MATCH(name) AGAINST('smith')", "why": "Leading wildcard can't use B-tree index; FULLTEXT enables search"},
                {"bad": "SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000, 10", "good": "WHERE id > @last_id ORDER BY id LIMIT 10", "why": "Large OFFSET scans all skipped rows; cursor seeks directly"},
                {"bad": "WHERE YEAR(order_date) = 2024 AND MONTH(order_date) = 1", "good": "WHERE order_date >= '2024-01-01' AND order_date < '2024-02-01'", "why": "Functions prevent index usage; range comparison uses index"},
            ],
            "guidance": [
                "OR prevents index usage - use UNION instead",
                "Avoid functions on indexed columns",
                "Leading wildcards can't use indexes",
                "Use cursor pagination instead of OFFSET for large datasets",
            ],
        },
        {
            "title": "Using CTEs Effectively",
            "description": "When to use Common Table Expressions",
            "examples": [
                {"bad": "SELECT p.*,\n  (SELECT COUNT(*) FROM orders WHERE product_id = p.id) as order_count\nFROM products p",
                 "good": "WITH product_stats AS (\n  SELECT product_id, COUNT(*) as order_count\n  FROM orders GROUP BY product_id\n)\nSELECT p.*, ps.order_count\nFROM products p LEFT JOIN product_stats ps ON p.id = ps.product_id",
                 "why": "Correlated subqueries execute per row; CTE scans once and joins"},
            ],
            "guidance": [
                "Use CTEs for: Readability, eliminating duplicate subqueries, multi-step transformations",
                "MySQL note: CTEs always materialized until 8.0.16 - may impact performance on large datasets",
            ],
        },
        {
            "title": "Monitor InnoDB Buffer Pool Efficiency",
            "description": "Check InnoDB buffer pool hit ratio and memory usage",
            "sql": (
                "-- Buffer pool statistics\n"
                "SELECT \n"
                "    (1 - (Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests)) * 100 AS buffer_pool_hit_ratio\n"
                "FROM (\n"
                "    SELECT VARIABLE_VALUE AS Innodb_buffer_pool_reads\n"
                "    FROM performance_schema.global_status \n"
                "    WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads'\n"
                ") reads,\n"
                "(\n"
                "    SELECT VARIABLE_VALUE AS Innodb_buffer_pool_read_requests\n"
                "    FROM performance_schema.global_status \n"
                "    WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'\n"
                ") requests;\n"
                "\n"
                "-- Check current settings\n"
                "SHOW VARIABLES LIKE 'innodb_buffer_pool%';"
            ),
            "action": (
                "-- Set dynamically (MySQL 5.7.5+)\n"
                "SET GLOBAL innodb_buffer_pool_size = 8589934592;  -- 8GB in bytes"
            ),
            "warning": "Changing innodb_buffer_pool_size dynamically can cause brief performance degradation. Best done during low-traffic periods.",
            "guidance": [
                "Target buffer pool hit ratio: >99% for OLTP, >95% acceptable for mixed workloads",
                "Typical: 70-80% of available RAM for dedicated database server",
                "Multiple instances reduce contention: 1 instance per GB of buffer pool",
            ],
            "checks": [
                {"label": "Buffer pool hit ratio < 95%?", "key": "lowHitRatio",
                 "advice": "Increase innodb_buffer_pool_size to 70-80% of available RAM: SET GLOBAL innodb_buffer_pool_size = 8589934592; (8GB)."},
                {"label": "Buffer pool size < 70% of RAM?", "key": "undersizedPool",
                 "advice": "Increase innodb_buffer_pool_size dynamically. Target 70-80% of RAM for dedicated database servers."},
            ],
        },
        {
            "title": "Monitor Replication Lag",
            "description": "Check replica lag and replication health",
            "sql": (
                "-- Check replication status (on replica)\n"
                "SHOW REPLICA STATUS\\G  -- MySQL 8.0.22+\n"
                "-- OR\n"
                "SHOW SLAVE STATUS\\G    -- Older versions\n"
                "\n"
                "-- View replication events (MySQL 8.0.22+)\n"
                "SELECT \n"
                "    CHANNEL_NAME,\n"
                "    SERVICE_STATE,\n"
                "    LAST_ERROR_NUMBER,\n"
                "    LAST_ERROR_MESSAGE\n"
                "FROM performance_schema.replication_connection_status;"
            ),
            "action": (
                "-- Start replication\n"
                "START REPLICA;  -- MySQL 8.0.22+\n"
                "\n"
                "-- Skip problematic transaction (use carefully!)\n"
                "STOP REPLICA;\n"
                "SET GLOBAL sql_slave_skip_counter = 1;\n"
                "START REPLICA;"
            ),
            "warning": "Skipping transactions can cause data inconsistency. Only skip after understanding the error.",
            "guidance": [
                "Seconds_Behind_Master shows lag in seconds (NULL = not replicating)",
                "Slave_IO_Running and Slave_SQL_Running both must be 'Yes'",
                "Enable parallel replication to reduce lag: slave_parallel_workers = 4",
                "Alert on lag >10 seconds for critical systems",
            ],
            "checks": [
                {"label": "Seconds_Behind_Master > 10 seconds?", "key": "replicationLag",
                 "advice": "Enable parallel replication: slave_parallel_workers=4, slave_parallel_type=LOGICAL_CLOCK in my.cnf."},
                {"label": "IO or SQL thread not running?", "key": "threadDown",
                 "advice": "Check Last_Error in SHOW REPLICA STATUS for reason. Fix the error, then START REPLICA."},
                {"label": "Parallel replication not enabled?", "key": "noParallelReplication",
                 "advice": "Enable in my.cnf on replica: slave_parallel_workers=4, slave_parallel_type=LOGICAL_CLOCK."},
            ],
        },
    ],

    "oracle": [
        {
            "title": "Get Execution Plan with Statistics",
            "description": "Generate and view the actual execution plan",
            "sql": (
                "EXPLAIN PLAN FOR\nyour_query_here;\n"
                "\n"
                "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY());\n"
                "\n"
                "-- OR use SQL Monitor\n"
                "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST'));"
            ),
            "warning": "EXPLAIN PLAN is safe, but DISPLAY_CURSOR requires the query to have been executed recently.",
            "guidance": [
                "Look for high 'Cost' values in the execution plan",
                "Check 'Rows' (estimated) vs 'A-Rows' (actual) - mismatches indicate bad statistics",
                "TABLE ACCESS FULL on large tables is a red flag",
                "High 'A-Time' (actual time) shows bottlenecks",
            ],
            "checks": [
                {"label": "Execution cost > 10000?", "key": "highCost",
                 "advice": "Review execution plan for expensive operations. Add indexes for full table scans. Gather statistics: DBMS_STATS.GATHER_TABLE_STATS."},
                {"label": "Row estimates way off (E-Rows vs A-Rows)?", "key": "badEstimates",
                 "advice": "Gather fresh statistics: EXEC DBMS_STATS.GATHER_TABLE_STATS(ownname=>'SCHEMA', tabname=>'TABLE', cascade=>TRUE)."},
                {"label": "Full table scan on large tables?", "key": "fullScan",
                 "advice": "Create index on columns in WHERE/JOIN: CREATE INDEX idx_name ON table(column). Use hints if optimizer ignores index: /*+ INDEX(table idx_name) */."},
                {"label": "Cartesian join in plan?", "key": "cartesian",
                 "advice": "Missing JOIN condition! Review query for missing ON/WHERE clauses. Cartesian joins cause explosive row multiplication."},
                {"label": "High A-Time (actual time) values?", "key": "highTime",
                 "advice": "Focus on operations with highest A-Time. Common fixes: add indexes, increase PGA for sorts/hashes, optimize joins."},
            ],
        },
        {
            "title": "Gather Fresh Statistics",
            "description": "Update optimizer statistics for accurate plans",
            "sql": (
                "SELECT table_name, last_analyzed, num_rows\n"
                "FROM user_tables\n"
                "WHERE table_name IN ('TABLE1', 'TABLE2')\n"
                "ORDER BY last_analyzed;"
            ),
            "action": (
                "EXEC DBMS_STATS.GATHER_TABLE_STATS(\n"
                "  ownname => 'SCHEMA_NAME',\n"
                "  tabname => 'TABLE_NAME',\n"
                "  estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,\n"
                "  method_opt => 'FOR ALL COLUMNS SIZE AUTO',\n"
                "  cascade => TRUE\n"
                ");"
            ),
            "warning": "GATHER_TABLE_STATS can lock tables briefly and consume resources. Run during maintenance windows on large tables.",
            "guidance": [
                "Stale statistics cause poor execution plans",
                "Use CASCADE => TRUE to gather index stats too",
                "AUTO_SAMPLE_SIZE lets Oracle determine sample size",
                "Gather stats after significant data changes (>10% rows)",
            ],
        },
        {
            "title": "Identify Missing Indexes",
            "description": "Find opportunities for new indexes",
            "sql": (
                "SELECT sql_text, executions, \n"
                "       disk_reads, buffer_gets\n"
                "FROM v$sql\n"
                "WHERE sql_text LIKE '%YOUR_TABLE%'\n"
                "  AND sql_text NOT LIKE '%v$sql%'\n"
                "ORDER BY disk_reads DESC;"
            ),
            "action": (
                "CREATE INDEX idx_name ON table_name(column_name);\n"
                "\n"
                "CREATE BITMAP INDEX idx_name ON table_name(status_column);"
            ),
            "warning": "CREATE INDEX locks the table and can take significant time on large tables. Consider ONLINE keyword or run during maintenance.",
            "guidance": [
                "High disk_reads with full scans suggests missing indexes",
                "Composite index column order: equality filters first, then range filters",
                "Bitmap indexes good for low cardinality (few distinct values)",
                "Function-based indexes for WHERE UPPER(col) or other functions",
            ],
        },
        {
            "title": "Analyze Join Operations",
            "description": "Review join methods and efficiency",
            "sql": "SELECT * FROM TABLE(\n  DBMS_XPLAN.DISPLAY_CURSOR(NULL, NULL, 'ALLSTATS LAST')\n);",
            "guidance": [
                "NESTED LOOPS: Good for small datasets or with indexes on join columns",
                "HASH JOIN: Good for large datasets, requires memory (PGA)",
                "MERGE JOIN: Good when both inputs are sorted",
                "CARTESIAN: Usually bad - missing join condition",
                "Check 'A-Rows' - if way higher than 'E-Rows', statistics are stale",
            ],
            "checks": [
                {"label": "Cartesian join present?", "key": "cartesianJoin",
                 "advice": "Missing join condition! Review query - ensure all tables have proper ON or WHERE join conditions."},
                {"label": "Hash join running out of memory?", "key": "hashMemory",
                 "advice": "Increase PGA_AGGREGATE_TARGET: ALTER SYSTEM SET pga_aggregate_target = 4G SCOPE=BOTH."},
                {"label": "Nested loop with many iterations?", "key": "nestedLoop",
                 "advice": "Add index on inner table join column: CREATE INDEX idx ON inner_table(join_key). Or force hash join: /*+ USE_HASH(table1 table2) */."},
            ],
        },
        {
            "title": "Check SQL Area and Memory",
            "description": "Review memory usage and shared pool",
            "sql": (
                "SELECT name, value/1024/1024 as mb\n"
                "FROM v$pgastat\n"
                "WHERE name IN ('total PGA allocated', 'maximum PGA allocated');"
            ),
            "action": "ALTER SYSTEM SET pga_aggregate_target = 2G SCOPE=BOTH;",
            "warning": "Changing PGA settings affects overall database memory. Monitor system memory usage and adjust carefully.",
            "guidance": [
                "High disk_reads indicate insufficient memory",
                "PGA memory used for sorts and hash joins",
                "buffer_gets shows logical I/O (lower is better)",
                "Consider partitioning very large tables",
            ],
        },
        {
            "title": "Use Optimizer Hints Strategically",
            "description": "Guide the optimizer when it chooses poorly",
            "sql": (
                "SELECT /*+ FULL(t) */ * FROM table_name t WHERE ...;\n"
                "SELECT /*+ INDEX(t idx_name) */ * FROM table_name t WHERE ...;"
            ),
            "guidance": [
                "FULL(table): Force full table scan",
                "INDEX(table index): Force index usage",
                "USE_NL: Force nested loops join",
                "USE_HASH: Force hash join",
                "USE_MERGE: Force merge join",
                "PARALLEL(table degree): Enable parallel execution",
                "Use hints only when optimizer consistently chooses wrong plan",
            ],
        },
        {
            "title": "Review and Fix Common Anti-Patterns",
            "description": "Avoid patterns that prevent optimization",
            "examples": [
                {"bad": "WHERE UPPER(name) = 'JOHN'", "good": "CREATE INDEX idx_upper_name ON table(UPPER(name));\nWHERE UPPER(name) = 'JOHN'", "why": "Function on column prevents index usage; function-based index enables it"},
                {"bad": "WHERE col1 = 'A' OR col2 = 'B'", "good": "WHERE col1 = 'A'\nUNION ALL\nSELECT ... WHERE col2 = 'B'", "why": "OR can't use indexes on both columns; UNION uses index on each"},
                {"bad": "WHERE TO_CHAR(date_col) = '2024-01-01'", "good": "WHERE date_col = TO_DATE('2024-01-01', 'YYYY-MM-DD')", "why": "TO_CHAR prevents index usage; direct date comparison uses index"},
            ],
            "guidance": [
                "Avoid functions on indexed columns (use function-based indexes)",
                "OR conditions often prevent index usage",
                "Use bind variables to prevent hard parsing",
                "Avoid implicit type conversions",
                "Use EXISTS instead of IN with subqueries",
            ],
        },
        {
            "title": "Using CTEs (WITH Clause) Effectively",
            "description": "When to use Common Table Expressions in Oracle",
            "examples": [
                {"bad": "SELECT d.*,\n  (SELECT COUNT(*) FROM employees WHERE department_id = d.id) as emp_count\nFROM departments d",
                 "good": "WITH dept_stats AS (\n  SELECT department_id, COUNT(*) as emp_count\n  FROM employees GROUP BY department_id\n)\nSELECT d.*, ds.emp_count\nFROM departments d LEFT JOIN dept_stats ds ON d.id = ds.department_id",
                 "why": "Correlated subqueries execute per row; CTE aggregates once then joins"},
            ],
            "guidance": [
                "Use CTEs for: Recursive queries, improving readability, factoring out complex subqueries",
                "Oracle 12c+: CTEs support recursive queries",
                "CTEs can be materialized with MATERIALIZE hint or inlined with INLINE hint for tuning",
            ],
        },
        {
            "title": "Analyze Wait Events",
            "description": "Identify database bottlenecks using wait event analysis",
            "sql": (
                "-- Top wait events currently\n"
                "SELECT \n"
                "    event,\n"
                "    total_waits,\n"
                "    time_waited / 100 AS time_waited_sec,\n"
                "    average_wait / 100 AS avg_wait_sec,\n"
                "    wait_class\n"
                "FROM v$system_event\n"
                "WHERE wait_class != 'Idle'\n"
                "ORDER BY time_waited DESC\n"
                "FETCH FIRST 20 ROWS ONLY;\n"
                "\n"
                "-- Active sessions and their wait events\n"
                "SELECT \n"
                "    s.sid, s.serial#, s.username, s.status,\n"
                "    s.event, s.wait_class, s.seconds_in_wait\n"
                "FROM v$session s\n"
                "WHERE s.status = 'ACTIVE'\n"
                "    AND s.username IS NOT NULL\n"
                "ORDER BY s.seconds_in_wait DESC;"
            ),
            "action": (
                "-- Kill blocking session (use carefully!)\n"
                "ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE;\n"
                "\n"
                "-- For 'log file sync' (commit waits):\n"
                "-- Move redo logs to faster storage (SSD), batch commits\n"
                "\n"
                "-- For 'enqueue' waits (locks):\n"
                "-- Identify blocking sessions and resolve contention\n"
                "-- Shorten transaction times"
            ),
            "warning": "Killing sessions will abort user transactions. Use only when necessary.",
            "guidance": [
                "db file sequential read: Single block I/O (index reads)",
                "db file scattered read: Multi-block I/O (full table scans)",
                "log file sync: Waiting for redo log writes (commits)",
                "enqueue waits: Lock contention",
                "latch waits: Internal Oracle structure contention",
                "Focus on events with high total time, not just high wait count",
            ],
            "checks": [
                {"label": "High db file sequential read waits?", "key": "sequentialReadWaits",
                 "advice": "Single-block I/O waits. Add indexes to reduce lookups. Check storage performance. Consider SSD storage."},
                {"label": "High db file scattered read waits?", "key": "scatteredReadWaits",
                 "advice": "Multi-block I/O (full table scans). Add indexes. Partition large tables. Increase DB_FILE_MULTIBLOCK_READ_COUNT."},
                {"label": "High log file sync waits?", "key": "logSyncWaits",
                 "advice": "Commit waits for redo log writes. Move redo logs to faster storage (SSD). Batch commits. Increase LOG_BUFFER."},
                {"label": "Enqueue or latch contention?", "key": "concurrencyWaits",
                 "advice": "For TX enqueues: shorten transactions. For latches: use bind variables to reduce hard parsing."},
                {"label": "Sessions waiting > 10 seconds?", "key": "longWaits",
                 "advice": "Identify waiting session in v$session. Check event column for wait type. Consider killing stuck sessions."},
            ],
        },
        {
            "title": "Monitor Temp Tablespace Usage",
            "description": "Check temporary tablespace for sort/hash operations",
            "sql": (
                "-- Check temp tablespace size and free space\n"
                "SELECT \n"
                "    tablespace_name,\n"
                "    tablespace_size / 1024 / 1024 AS total_mb,\n"
                "    free_space / 1024 / 1024 AS free_mb,\n"
                "    ROUND((allocated_space / tablespace_size) * 100, 2) AS used_percent\n"
                "FROM dba_temp_free_space;\n"
                "\n"
                "-- Check temp usage by session\n"
                "SELECT \n"
                "    s.sid, s.username,\n"
                "    t.blocks * 8192 / 1024 / 1024 AS temp_mb\n"
                "FROM v$tempseg_usage t\n"
                "JOIN v$session s ON t.session_addr = s.saddr\n"
                "ORDER BY temp_mb DESC;"
            ),
            "action": (
                "-- Add tempfile to temp tablespace\n"
                "ALTER TABLESPACE TEMP ADD TEMPFILE \n"
                "    '/path/to/temp02.dbf' \n"
                "    SIZE 1G \n"
                "    AUTOEXTEND ON NEXT 100M MAXSIZE 10G;\n"
                "\n"
                "-- Tune PGA for better in-memory sorts/hashes\n"
                "ALTER SYSTEM SET pga_aggregate_target = 4G SCOPE=BOTH;"
            ),
            "warning": "Adding or resizing tempfiles can impact performance briefly. Killing sessions will abort user transactions.",
            "guidance": [
                "Temp tablespace used for sorts, hash joins, temp tables, index creation",
                "When PGA insufficient, operations spill to temp tablespace",
                "Increase PGA_AGGREGATE_TARGET to reduce temp spills",
                "Add indexes to avoid large sorts",
            ],
            "checks": [
                {"label": "Temp tablespace >80% full?", "key": "tempFull",
                 "advice": "Add more tempfiles: ALTER TABLESPACE TEMP ADD TEMPFILE SIZE 1G AUTOEXTEND ON. Increase PGA_AGGREGATE_TARGET."},
                {"label": "Sessions using >1GB temp space?", "key": "highTempUsage",
                 "advice": "Find session in v$tempseg_usage. Add indexes to avoid sorting. Increase PGA if unavoidable."},
                {"label": "ORA-01652 errors in alert log?", "key": "tempExtendErrors",
                 "advice": "Temp tablespace out of space! Add tempfiles immediately: ALTER TABLESPACE TEMP ADD TEMPFILE SIZE 5G AUTOEXTEND ON MAXSIZE 10G."},
            ],
        },
        {
            "title": "Use AWR and ADDM Reports",
            "description": "Generate Automatic Workload Repository and Advisory reports",
            "sql": (
                "-- List available AWR snapshots\n"
                "SELECT snap_id, begin_interval_time, end_interval_time\n"
                "FROM dba_hist_snapshot\n"
                "ORDER BY snap_id DESC\n"
                "FETCH FIRST 20 ROWS ONLY;\n"
                "\n"
                "-- View ADDM findings\n"
                "SELECT task_name, finding_name, type, impact, message\n"
                "FROM dba_advisor_findings\n"
                "WHERE task_name = (SELECT MAX(task_name) FROM dba_advisor_tasks WHERE advisor_name = 'ADDM')\n"
                "ORDER BY impact DESC;"
            ),
            "action": (
                "-- Create manual AWR snapshot\n"
                "EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT();\n"
                "\n"
                "-- Modify snapshot retention (default 8 days)\n"
                "EXEC DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(\n"
                "    retention => 14400,  -- Minutes (10 days)\n"
                "    interval => 60       -- Snapshot every 60 minutes\n"
                ");"
            ),
            "warning": "AWR and ADDM require Oracle Diagnostics Pack license. Check licensing before use.",
            "guidance": [
                "AWR collects performance statistics every hour by default",
                "ADDM automatically analyzes AWR data and provides recommendations",
                "AWR Top 5 Timed Events: Shows main bottlenecks",
                "ADDM findings reference specific SQL_IDs for investigation",
                "AWR and ADDM require Oracle Diagnostics Pack (extra cost)",
            ],
            "checks": [
                {"label": "AWR snapshots being collected?", "key": "awrEnabled",
                 "advice": "Enable AWR snapshots: Check dba_hist_snapshot. Verify STATISTICS_LEVEL = TYPICAL or ALL."},
                {"label": "Recent ADDM findings available?", "key": "addmFindings",
                 "advice": "Generate AWR report for problem period. Review ADDM findings in dba_advisor_findings."},
                {"label": "High-impact ADDM findings unresolved?", "key": "criticalFindings",
                 "advice": "Review ADDM recommendations. Focus on findings with high 'impact' (DB time). Implement recommended fixes."},
                {"label": "Diagnostics Pack licensed?", "key": "diagnosticsLicense",
                 "advice": "Verify Oracle Diagnostics Pack license. Alternative: Use Statspack (free but manual, less comprehensive)."},
            ],
        },
    ],

    "snowflake": [
        {
            "title": "Get the Execution Plan",
            "description": "Use EXPLAIN to analyze query execution without running it",
            "sql": "EXPLAIN USING TEXT\nyour_query_here;",
            "guidance": [
                "GlobalStats: Overall query statistics (partitions, bytes, rows)",
                "TableScan: check partitionsTotal vs partitionsAssigned",
                "Pruning ratio: (Total - Assigned) / Total x 100% (higher is better)",
                ">90% pruned = excellent, 50-90% pruned = good, <50% pruned = poor",
                "EXPLAIN shows estimates. Use Query Profile in Snowflake UI for actual stats.",
            ],
            "checks": [
                {"label": "Poor partition pruning (<50% pruned)?", "key": "poorPruning",
                 "advice": "Add clustering keys: ALTER TABLE table_name CLUSTER BY (date_column, filter_column). Avoid functions on clustered columns."},
                {"label": "Large table scan (>1000 partitions)?", "key": "largeTableScan",
                 "advice": "Improve WHERE clause selectivity. Add clustering keys. Consider search optimization service."},
                {"label": "Cartesian join detected?", "key": "cartesianJoin",
                 "advice": "Add proper JOIN conditions. Ensure all tables have join predicates. Check for missing ON clauses."},
                {"label": "Window function on large dataset?", "key": "expensiveWindow",
                 "advice": "Add PARTITION BY to limit window scope. Consider if aggregate query can replace window function."},
            ],
        },
        {
            "title": "Check Warehouse Size and Scaling",
            "description": "Verify compute resources are adequate",
            "sql": (
                "-- Check current warehouse settings\n"
                "SHOW WAREHOUSES;\n"
                "\n"
                "-- Check warehouse usage history\n"
                "SELECT \n"
                "    WAREHOUSE_NAME,\n"
                "    AVG(AVG_RUNNING) as avg_running,\n"
                "    AVG(AVG_QUEUED) as avg_queued\n"
                "FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_EVENTS_HISTORY\n"
                "WHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())\n"
                "GROUP BY WAREHOUSE_NAME\n"
                "ORDER BY avg_running DESC;"
            ),
            "action": (
                "-- Scale up warehouse temporarily for testing\n"
                "ALTER WAREHOUSE your_warehouse_name SET WAREHOUSE_SIZE = 'LARGE';\n"
                "\n"
                "-- Enable auto-scaling\n"
                "ALTER WAREHOUSE your_warehouse_name SET AUTO_SUSPEND = 60;\n"
                "ALTER WAREHOUSE your_warehouse_name SET AUTO_RESUME = TRUE;"
            ),
            "warning": "Larger warehouses cost more credits. Test performance improvements before permanently scaling up.",
            "guidance": [
                "X-Small: 1 credit/hour. Small: 2, Medium: 4, Large: 8, X-Large: 16 credits/hour",
                "Double warehouse size = double speed (roughly), double cost",
                "Use multi-cluster warehouse for high concurrency (not for single query speed)",
                "Monitor credit usage in Account Usage views",
            ],
            "checks": [
                {"label": "Queries consistently queued?", "key": "queriesQueued",
                 "advice": "Enable multi-cluster warehouse or increase min/max clusters. Queuing indicates concurrency bottleneck."},
                {"label": "Query runs slower on smaller warehouse?", "key": "warehouseTooSmall",
                 "advice": "Test with larger warehouse size. If query speeds up proportionally, warehouse is undersized."},
            ],
        },
        {
            "title": "Optimize Clustering Keys",
            "description": "Improve partition pruning for large tables",
            "sql": (
                "-- Check clustering info\n"
                "SELECT SYSTEM$CLUSTERING_INFORMATION('your_table_name', '(date_col, region)');\n"
                "\n"
                "-- Check clustering depth (lower is better, ideally < 5)\n"
                "SELECT SYSTEM$CLUSTERING_DEPTH('your_table_name');"
            ),
            "action": (
                "-- Add clustering key\n"
                "ALTER TABLE table_name CLUSTER BY (date_column, category_column);\n"
                "\n"
                "-- Recluster manually if needed\n"
                "ALTER TABLE table_name RECLUSTER;"
            ),
            "warning": "Clustering is a background process and incurs Snowflake credit costs. Monitor clustering costs in Account Usage.",
            "guidance": [
                "Cluster on columns used in WHERE and JOIN predicates",
                "Best clustering columns: date/timestamp, category columns with high selectivity",
                "Avoid clustering on high-cardinality columns (UUIDs, random IDs)",
                "Clustering depth < 5 is good, > 10 means poor clustering",
                "Automatic clustering maintains order but costs credits",
            ],
        },
        {
            "title": "Optimize Query Patterns",
            "description": "Snowflake-specific query optimization techniques",
            "examples": [
                {"bad": "SELECT * FROM table", "good": "SELECT col1, col2, col3 FROM table", "why": "SELECT * reads all columns from micro-partitions; selecting specific columns reduces I/O"},
                {"bad": "WHERE date_col::date = '2024-01-01'", "good": "WHERE date_col >= '2024-01-01' AND date_col < '2024-01-02'", "why": "CAST prevents pruning; range comparison enables partition pruning"},
                {"bad": "SELECT COUNT(DISTINCT id) FROM large_table", "good": "SELECT APPROX_COUNT_DISTINCT(id) FROM large_table", "why": "Exact DISTINCT count is expensive; approximate is much faster with small error margin"},
            ],
            "guidance": [
                "Avoid SELECT * - select only needed columns",
                "Use range predicates on clustered columns for pruning",
                "APPROX_COUNT_DISTINCT is much faster than COUNT(DISTINCT)",
                "Flatten semi-structured data (VARIANT) early in CTEs",
                "Use SAMPLE for exploratory queries on large tables",
            ],
        },
        {
            "title": "Monitor Resource Usage",
            "description": "Track query performance and credit consumption",
            "sql": (
                "-- Top queries by execution time\n"
                "SELECT query_text, warehouse_name,\n"
                "       execution_time / 1000 AS execution_sec,\n"
                "       credits_used_cloud_services\n"
                "FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY\n"
                "WHERE start_time >= DATEADD(day, -1, CURRENT_TIMESTAMP())\n"
                "ORDER BY execution_time DESC\n"
                "LIMIT 20;\n"
                "\n"
                "-- Credit usage by warehouse\n"
                "SELECT warehouse_name,\n"
                "       SUM(credits_used) AS total_credits\n"
                "FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY\n"
                "WHERE start_time >= DATEADD(day, -30, CURRENT_TIMESTAMP())\n"
                "GROUP BY warehouse_name\n"
                "ORDER BY total_credits DESC;"
            ),
            "guidance": [
                "QUERY_HISTORY has ~45 min latency; use INFORMATION_SCHEMA.QUERY_HISTORY() for real-time",
                "execution_time is wall clock; compilation_time + queued_overload_time show other costs",
                "Monitor credits_used_cloud_services - high values may indicate policy issues",
            ],
        },
        {
            "title": "Leverage Result Set Caching",
            "description": "Understand and use Snowflake's caching layers",
            "sql": (
                "-- Check if last query used result cache\n"
                "SELECT query_id, query_text, execution_status,\n"
                "       is_client_generated_statement,\n"
                "       partitions_scanned, partitions_total\n"
                "FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY\n"
                "WHERE start_time >= DATEADD(hour, -1, CURRENT_TIMESTAMP())\n"
                "ORDER BY start_time DESC\n"
                "LIMIT 10;"
            ),
            "guidance": [
                "Result cache: Identical queries return instantly at $0 cost (24h TTL)",
                "Warehouse cache: Local SSD cache on the warehouse, persists while running",
                "Result cache requires: identical SQL, same session parameters, no data changes, USE_CACHED_RESULT = TRUE",
                "Standardize query formatting (use query templates) to maximize result cache hits",
                "Result cache hits = $0 (no compute used)",
            ],
        },
    ],
}


# ============================================================
# DB CONNECTION HELPERS
# ============================================================

REQUIRED_PACKAGES = {
    "sqlserver": "pyodbc",
    "postgresql": "psycopg2",
    "mysql": "mysql-connector-python",
    "oracle": "cx_Oracle",
    "snowflake": "snowflake-connector-python",
}

SHELL_CMD_PREFIXES = (
    "aws ", "brew ", "apt-", "apt ", "yum ", "pip ", "sudo ",
    "psql ", "mysql ", "sqlcmd ", "pgbadger", "#", "open ",
    "for ", "wget ", "curl ",
)


def check_driver(db_type):
    """Verify the required DB driver is installed."""
    pkg = REQUIRED_PACKAGES.get(db_type, "")
    try:
        if db_type == "sqlserver":
            import pyodbc  # noqa: F401
        elif db_type == "postgresql":
            import psycopg2  # noqa: F401
        elif db_type == "mysql":
            import mysql.connector  # noqa: F401
        elif db_type == "oracle":
            import cx_Oracle  # noqa: F401
        elif db_type == "snowflake":
            import snowflake.connector  # noqa: F401
    except ImportError:
        print(f"\n[ERROR] Required package not found: {pkg}")
        print(f"Install it with:  pip install {pkg}")
        sys.exit(1)


def get_connection(db_type, conn_params):
    """Return a DB connection for the given db_type."""
    if db_type == "sqlserver":
        import pyodbc
        conn_str = (
            f"DRIVER={{ODBC Driver 17 for SQL Server}};"
            f"SERVER={conn_params['host']},{conn_params.get('port', 1433)};"
            f"DATABASE={conn_params['dbname']};"
            f"UID={conn_params['user']};"
            f"PWD={conn_params['password']}"
        )
        return pyodbc.connect(conn_str)
    elif db_type == "postgresql":
        import psycopg2
        return psycopg2.connect(
            host=conn_params["host"],
            port=conn_params.get("port", 5432),
            dbname=conn_params["dbname"],
            user=conn_params["user"],
            password=conn_params["password"],
        )
    elif db_type == "mysql":
        import mysql.connector
        return mysql.connector.connect(
            host=conn_params["host"],
            port=conn_params.get("port", 3306),
            database=conn_params["dbname"],
            user=conn_params["user"],
            password=conn_params["password"],
        )
    elif db_type == "oracle":
        import cx_Oracle
        dsn = cx_Oracle.makedsn(
            conn_params["host"],
            conn_params.get("port", 1521),
            service_name=conn_params["dbname"],
        )
        return cx_Oracle.connect(
            user=conn_params["user"],
            password=conn_params["password"],
            dsn=dsn,
        )
    elif db_type == "snowflake":
        import snowflake.connector
        return snowflake.connector.connect(
            account=conn_params["host"],
            user=conn_params["user"],
            password=conn_params["password"],
            database=conn_params["dbname"],
        )
    raise ValueError(f"Unknown db_type: {db_type}")


def split_sql_batches(db_type, sql_text):
    """Split SQL into executable batches."""
    if db_type == "sqlserver":
        # Split on GO as a batch separator
        batches = re.split(r"\nGO\s*(?:\n|$)", sql_text, flags=re.IGNORECASE)
    else:
        # Single batch for other DBs
        batches = [sql_text]
    return [b.strip() for b in batches if b.strip() and b.strip().upper() != "GO"]


def strip_comments_for_exec(sql_text):
    """Strip comment-only lines before execution (keep SQL)."""
    lines = sql_text.split("\n")
    exec_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("--") or stripped.startswith("#"):
            continue
        exec_lines.append(line)
    return "\n".join(exec_lines).strip()


def run_query(conn, db_type, sql_text):
    """Run a SQL query and return list of dicts. Never crashes."""
    results = []
    batches = split_sql_batches(db_type, sql_text)

    for batch_num, batch in enumerate(batches, 1):
        exec_sql = strip_comments_for_exec(batch)
        if not exec_sql:
            continue

        prefix = f"[Batch {batch_num}] " if len(batches) > 1 else ""
        try:
            cur = conn.cursor()
            cur.execute(exec_sql)
            if cur.description:
                cols = [d[0] for d in cur.description]
                rows = cur.fetchall()
                for row in rows:
                    results.append(
                        {prefix + c if len(batches) > 1 else c: (str(v) if v is not None else None)
                         for c, v in zip(cols, row)}
                    )
                if not rows:
                    results.append({"__info__": f"{prefix}Query returned no rows."})
            else:
                results.append({"__info__": f"{prefix}Statement executed (no result set)."})
        except Exception as exc:
            results.append({"error": f"{prefix}{exc}"})
            # Reset aborted transaction so subsequent queries can run
            try:
                conn.rollback()
            except Exception:
                pass

    return results if results else [{"__info__": "No results returned."}]


# ============================================================
# DISPLAY HELPERS
# ============================================================

def hr(char="─", width=72):
    print(char * width)


def print_table(rows, max_col_width=45):
    if not rows:
        print("  (no rows returned)")
        return

    # Show errors or info inline
    if "error" in rows[0]:
        print(f"  [Query Error] {rows[0]['error']}")
        return
    if "__info__" in rows[0]:
        print(f"  {rows[0]['__info__']}")
        return

    cols = list(rows[0].keys())
    col_widths = {}
    for c in cols:
        vals = [str(r.get(c) or "") for r in rows]
        col_widths[c] = min(max_col_width, max(len(c), max((len(v) for v in vals), default=0)))

    header = " | ".join(c.ljust(col_widths[c])[:col_widths[c]] for c in cols)
    sep = "-+-".join("-" * col_widths[c] for c in cols)
    print("  " + header)
    print("  " + sep)
    display_rows = rows[:50]
    for row in display_rows:
        line = " | ".join(str(row.get(c) or "").ljust(col_widths[c])[:col_widths[c]] for c in cols)
        print("  " + line)
    if len(rows) > 50:
        print(f"  ... ({len(rows) - 50} more rows not shown)")


def prompt_yn(question, default_yes=True):
    default = "Y/n" if default_yes else "y/N"
    try:
        ans = input(f"{question} [{default}]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return default_yes
    if not ans:
        return default_yes
    return ans.startswith("y")


def is_shell_action(action_text):
    first_exec_line = ""
    for line in action_text.strip().split("\n"):
        s = line.strip()
        if s and not s.startswith("--") and not s.startswith("#"):
            first_exec_line = s
            break
    return any(first_exec_line.startswith(p) for p in SHELL_CMD_PREFIXES)


# ============================================================
# MAIN SESSION RUNNER
# ============================================================

def run_session(db_type, conn, conn_params):
    steps = ALL_STEPS[db_type]
    session = {
        "db_type": db_type,
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "connection": {k: v for k, v in conn_params.items() if k != "password"},
        "steps": [],
    }

    print(f"\n{'=' * 72}")
    print(f"  DB TROUBLESHOOTER — {db_type.upper()}")
    print(f"  {len(steps)} steps  |  Press Enter to continue, 'q' to quit early")
    print(f"{'=' * 72}\n")

    for i, step in enumerate(steps):
        step_record = {
            "title": step["title"],
            "description": step.get("description", ""),
            "sql_results": None,
            "checks": {},
            "actions_applied": [],
            "skipped": False,
        }

        hr("═")
        print(f"  Step {i + 1}/{len(steps)}: {step['title']}")
        print(f"  {step.get('description', '')}")
        hr()

        # Warning
        if step.get("warning"):
            print(f"\n  ⚠  WARNING: {step['warning']}\n")

        # Guidance
        if step.get("guidance"):
            print("\n  Guidance:")
            for g in step["guidance"]:
                if g.strip():
                    print(f"    • {g}")

        # Examples
        if step.get("examples"):
            print("\n  Query Pattern Examples:")
            for ex in step["examples"]:
                bad = ex["bad"][:70].replace("\n", " ")
                good = ex["good"][:70].replace("\n", " ")
                print(f"    ❌ Bad:  {bad}")
                print(f"    ✅ Good: {good}")
                print(f"    💡 Why:  {ex.get('why', '')}")
                print()

        # SQL — show and optionally run
        if step.get("sql"):
            sql_to_run = step["sql"]

            # If the SQL contains a placeholder, prompt the user to supply their query
            if "your_query_here" in sql_to_run:
                print("\n  Diagnostic SQL (template — requires your query):")
                for line in sql_to_run.split("\n"):
                    print(f"    {line}")
                print()
                print("  This step requires you to provide a query to analyze.")
                user_query = input("  Enter your query (or leave blank to skip): ").strip()
                if not user_query:
                    print("  Skipping — no query provided.")
                    step_record["sql_results"] = None
                    # Still show checks/guidance below
                else:
                    sql_to_run = sql_to_run.replace("your_query_here", user_query)
                    print("\n  Running with your query...")
                    results = run_query(conn, db_type, sql_to_run)
                    step_record["sql_results"] = results
                    print_table(results)
            else:
                print("\n  Diagnostic SQL:")
                for line in sql_to_run.split("\n"):
                    print(f"    {line}")
                print()

                run_it = prompt_yn("  Run this diagnostic query?", default_yes=True)
                if run_it:
                    print()
                    results = run_query(conn, db_type, sql_to_run)
                    step_record["sql_results"] = results
                    print_table(results)
                else:
                    step_record["sql_results"] = None

        # Checks (yes/no questions)
        if step.get("checks"):
            print("\n  Checks:")
            for check in step["checks"]:
                ans = prompt_yn(f"    {check['label']}", default_yes=False)
                step_record["checks"][check["key"]] = ans
                if ans:
                    print(f"      → Advice: {check['advice']}\n")

        # Action
        if step.get("action"):
            action_text = step["action"]
            print("\n  Action / Fix:")
            for line in action_text.split("\n"):
                print(f"    {line}")
            print()

            if is_shell_action(action_text):
                print("  [Manual action required — shell/CLI command, not executed by this script]")
            else:
                apply_it = prompt_yn("  Apply this fix? (DEFAULT is NO)", default_yes=False)
                if apply_it:
                    print("  Applying fix...")
                    results = run_query(conn, db_type, action_text)
                    step_record["actions_applied"].append(action_text)
                    print_table(results)

        # Continue or quit
        print()
        try:
            nav = input("  Press Enter to continue (or 'q' to quit, 's' to skip): ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            nav = "q"

        if nav == "q":
            print("  Exiting session early.")
            session["steps"].append(step_record)
            break
        elif nav == "s":
            step_record["skipped"] = True

        session["steps"].append(step_record)

    return session


# ============================================================
# ENTRY POINT
# ============================================================

def main():
    print("\n" + "=" * 72)
    print("  DATABASE TROUBLESHOOTER")
    print("  Interactive CLI — steps through diagnostic checks against a live DB")
    print("=" * 72)

    db_types = list(ALL_STEPS.keys())
    print("\nAvailable database types:")
    for idx, t in enumerate(db_types, 1):
        print(f"  {idx}. {t}")

    while True:
        try:
            choice = input("\nSelect database type [1-%d or name]: " % len(db_types)).strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\nAborted.")
            sys.exit(0)

        if choice.isdigit() and 1 <= int(choice) <= len(db_types):
            db_type = db_types[int(choice) - 1]
            break
        if choice in db_types:
            db_type = choice
            break
        print("  Invalid choice, please try again.")

    print(f"\n  Selected: {db_type}")
    print(f"  Required package: pip install {REQUIRED_PACKAGES.get(db_type, 'N/A')}")

    check_driver(db_type)

    # Connection details
    default_ports = {
        "sqlserver": "1433", "postgresql": "5432",
        "mysql": "3306", "oracle": "1521", "snowflake": "443",
    }
    print("\nConnection details:")
    host = input("  Host [localhost]: ").strip() or "localhost"
    port_default = default_ports.get(db_type, "5432")
    port_str = input(f"  Port [{port_default}]: ").strip() or port_default
    dbname = input("  Database name: ").strip()
    user = input("  Username: ").strip()
    import getpass
    try:
        password = getpass.getpass("  Password: ")
    except Exception:
        password = input("  Password: ").strip()

    conn_params = {
        "host": host,
        "port": int(port_str),
        "dbname": dbname,
        "user": user,
        "password": password,
    }

    print("\n  Connecting...")
    try:
        conn = get_connection(db_type, conn_params)
        print("  ✓ Connection successful.")
    except Exception as exc:
        print(f"  ✗ Connection failed: {exc}")
        sys.exit(1)

    try:
        session = run_session(db_type, conn, conn_params)
    finally:
        try:
            conn.close()
        except Exception:
            pass

    # Save results
    out_file = "troubleshoot_results.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(session, f, indent=2, default=str)

    print(f"\n  ✓ Results saved to {out_file}")
    print("  Run:  python results_viewer.py   to generate the HTML report.\n")


if __name__ == "__main__":
    main()
