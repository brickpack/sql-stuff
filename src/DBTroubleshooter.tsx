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
            { bad: "SELECT * FROM orders\nWHERE amount > 1000 OR status = 'urgent'", good: "SELECT * FROM orders WHERE amount > 1000\nUNION\nSELECT * FROM orders WHERE status = 'urgent'", why: "OR prevents using multiple indexes; UNION allows index on each condition" }
          ],
          guidance: [
            "Replace IN with JOINs",
            "Avoid functions on indexed columns",
            "Use EXISTS instead of IN for large subqueries",
            "Create expression indexes for functions in WHERE clause"
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
            { bad: "WHERE YEAR(order_date) = 2024\n  AND MONTH(order_date) = 1", good: "WHERE order_date >= '2024-01-01'\n  AND order_date < '2024-02-01'", why: "Functions prevent index usage; range comparison uses index" }
          ],
          guidance: [
            "OR prevents index usage - use UNION instead",
            "Avoid functions on indexed columns",
            "Leading wildcards can't use indexes",
            "Use cursor pagination instead of OFFSET for large datasets",
            "Prefer positive conditions over NOT/!= when possible"
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {['postgresql', 'mysql', 'sqlserver', 'oracle'].map((db) => (
              <button key={db} onClick={() => setDbType(db)} className="p-6 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-all">
                <Database className="w-8 h-8 mx-auto mb-2 text-blue-600" />
                <div className="font-semibold capitalize">{db === 'sqlserver' ? 'SQL Server' : db === 'postgresql' ? 'PostgreSQL' : db === 'oracle' ? 'Oracle' : 'MySQL'}</div>
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
          <h1 className="text-2xl font-bold">{dbType === 'sqlserver' ? 'SQL Server' : dbType === 'postgresql' ? 'PostgreSQL' : dbType === 'oracle' ? 'Oracle' : 'MySQL'} Troubleshooting</h1>
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