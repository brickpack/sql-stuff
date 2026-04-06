#!/usr/bin/env python3
"""
results_viewer.py — Generates a self-contained HTML report from troubleshoot_results.json
and opens it in the default browser.

Usage:
    python results_viewer.py                          # reads troubleshoot_results.json
    python results_viewer.py /path/to/results.json   # reads specific file
"""

import json
import html
import webbrowser
import sys
from datetime import datetime
from pathlib import Path

# ============================================================
# HELPERS
# ============================================================

def esc(s):
    """HTML-escape a string."""
    if s is None:
        return ""
    return html.escape(str(s))


def truncate(s, max_len=200):
    """Truncate a string for display."""
    s = str(s) if s is not None else ""
    if len(s) > max_len:
        return s[:max_len] + "…"
    return s


def is_numeric(s):
    """Return True if the string looks like a number."""
    if s is None:
        return False
    try:
        float(str(s).replace(",", ""))
        return True
    except ValueError:
        return False


# ============================================================
# CSS (inline, dark-mode friendly)
# ============================================================

CSS = """
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    background: #0f1117;
    color: #c9d1d9;
    padding: 24px;
}

a { color: #58a6ff; }

h1 { font-size: 1.6rem; color: #e6edf3; margin-bottom: 6px; }
h2 { font-size: 1.2rem; color: #e6edf3; margin-bottom: 12px; }
h3 { font-size: 1rem; color: #8b949e; margin-bottom: 8px; font-weight: 600; }

.container { max-width: 1100px; margin: 0 auto; }

/* ── Header ── */
.header {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 24px;
}

.header-top { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }

.db-badge {
    display: inline-block;
    padding: 3px 12px;
    border-radius: 20px;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    background: #1f6feb;
    color: #fff;
}

.meta { font-size: 0.85rem; color: #8b949e; }
.meta span { margin-right: 16px; }

/* ── Summary chips ── */
.summary-row { display: flex; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
.chip {
    display: inline-flex; align-items: center; gap: 6px;
    background: #21262d; border: 1px solid #30363d;
    border-radius: 20px; padding: 4px 14px; font-size: 0.82rem;
}
.chip .num { font-weight: 700; color: #e6edf3; }

/* ── Findings summary ── */
.findings-summary {
    background: #161b22;
    border: 1px solid #30363d;
    border-left: 4px solid #d29922;
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 24px;
}
.findings-summary h2 { color: #d29922; }
.findings-group { margin-bottom: 14px; }
.findings-group-title {
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #8b949e;
    margin-bottom: 6px;
    font-weight: 600;
}
.finding-item {
    background: #1c2128;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 6px;
}
.finding-label { font-weight: 600; color: #e6edf3; margin-bottom: 4px; font-size: 0.88rem; }
.finding-advice { color: #c9d1d9; font-size: 0.85rem; }

/* ── Step cards ── */
.step-card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    margin-bottom: 14px;
    overflow: hidden;
}

.step-card > details > summary {
    list-style: none;
    cursor: pointer;
    padding: 14px 20px;
    display: flex;
    align-items: center;
    gap: 10px;
    user-select: none;
    background: #1c2128;
    border-bottom: 1px solid #30363d;
}
.step-card > details > summary::-webkit-details-marker { display: none; }
.step-card > details > summary::before {
    content: "▶";
    font-size: 0.7rem;
    color: #8b949e;
    transition: transform 0.15s;
    flex-shrink: 0;
}
.step-card > details[open] > summary::before { transform: rotate(90deg); }

.step-num {
    font-size: 0.7rem;
    font-weight: 700;
    color: #8b949e;
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 1px 7px;
    flex-shrink: 0;
}
.step-title { font-weight: 600; color: #e6edf3; flex: 1; }
.step-desc { font-size: 0.82rem; color: #8b949e; }

.step-badges { display: flex; gap: 6px; flex-shrink: 0; }
.badge {
    font-size: 0.72rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 12px;
    white-space: nowrap;
}
.badge-skipped { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
.badge-applied  { background: #1a4731; color: #3fb950; border: 1px solid #2ea043; }
.badge-flagged  { background: #3d2c00; color: #d29922; border: 1px solid #9e6a03; }

.step-body { padding: 20px; }

/* ── SQL results table ── */
.results-section { margin-bottom: 20px; }
.results-section h3 { margin-bottom: 8px; }

.sql-table-wrap { overflow-x: auto; }
.sql-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace;
}
.sql-table th {
    background: #1c2128;
    color: #8b949e;
    font-weight: 600;
    text-align: left;
    padding: 7px 12px;
    border-bottom: 2px solid #30363d;
    white-space: nowrap;
}
.sql-table td {
    padding: 6px 12px;
    border-bottom: 1px solid #21262d;
    vertical-align: top;
    word-break: break-word;
    max-width: 300px;
}
.sql-table tr:hover td { background: #1c2128; }
.sql-table td.numeric { text-align: right; color: #79c0ff; font-variant-numeric: tabular-nums; }
.sql-table td.error-cell { color: #f85149; }
.sql-table td.info-cell  { color: #8b949e; font-style: italic; }
.row-count { font-size: 0.75rem; color: #8b949e; margin-top: 6px; }

/* ── Checks table ── */
.checks-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.83rem;
    margin-bottom: 20px;
}
.checks-table th {
    text-align: left;
    padding: 7px 12px;
    background: #1c2128;
    color: #8b949e;
    font-weight: 600;
    border-bottom: 2px solid #30363d;
}
.checks-table td {
    padding: 8px 12px;
    border-bottom: 1px solid #21262d;
    vertical-align: top;
}
.checks-table tr.yes-row td { background: #2d1e00; }
.checks-table tr.no-row  td { background: #0d1f12; }
.answer-yes { color: #d29922; font-weight: 700; }
.answer-no  { color: #3fb950; font-weight: 700; }
.checks-advice { color: #c9d1d9; font-size: 0.82rem; font-style: italic; }

/* ── Applied actions ── */
.action-block {
    background: #0d1117;
    border: 1px solid #2ea043;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 10px;
    position: relative;
}
.action-applied-badge {
    position: absolute;
    top: 8px; right: 10px;
    font-size: 0.7rem;
    font-weight: 700;
    color: #3fb950;
}
.action-block pre {
    font-family: 'SF Mono', 'Fira Code', Menlo, monospace;
    font-size: 0.78rem;
    color: #c9d1d9;
    white-space: pre-wrap;
    word-break: break-word;
}

/* ── Skipped ── */
.skipped-notice {
    color: #8b949e;
    font-style: italic;
    padding: 10px 0;
}

/* ── No data ── */
.empty-note { color: #8b949e; font-style: italic; font-size: 0.85rem; padding: 6px 0; }
"""

# ============================================================
# REPORT GENERATION
# ============================================================

DB_BADGE_COLORS = {
    "sqlserver":  "#1f6feb",
    "postgresql": "#336791",
    "mysql":      "#e48e00",
    "oracle":     "#c74634",
    "snowflake":  "#29b5e8",
}

CHECK_LABELS = {}  # populated from session data during render


def build_check_label_map(session):
    """Build a map of key -> label from all steps in ALL_STEPS."""
    # We inline the TSX check labels into the report by pulling from session.
    # The session stores keys; labels come from the step data we read at generation time.
    # Since we don't have ALL_STEPS available in this standalone script,
    # we store labels alongside keys in the extended session format.
    # As a fallback, humanize the key.
    pass


def humanize_key(key):
    """Turn a camelCase key into a readable label."""
    import re
    s = re.sub(r"([A-Z])", r" \1", key)
    return s.strip().capitalize()


def render_sql_table(rows):
    if not rows:
        return '<p class="empty-note">No results returned.</p>'

    # Error / info rows
    if len(rows) == 1:
        if "error" in rows[0]:
            return f'<p class="empty-note" style="color:#f85149">Query Error: {esc(rows[0]["error"])}</p>'
        if "__info__" in rows[0]:
            return f'<p class="empty-note">{esc(rows[0]["__info__"])}</p>'

    cols = list(rows[0].keys())
    buf = ['<div class="sql-table-wrap"><table class="sql-table">']
    buf.append("<thead><tr>" + "".join(f"<th>{esc(c)}</th>" for c in cols) + "</tr></thead>")
    buf.append("<tbody>")
    for row in rows[:200]:
        buf.append("<tr>")
        for c in cols:
            val = row.get(c)
            display = truncate(val)
            if c == "error":
                buf.append(f'<td class="error-cell">{esc(display)}</td>')
            elif c == "__info__":
                buf.append(f'<td class="info-cell" colspan="{len(cols)}">{esc(display)}</td>')
            elif is_numeric(val):
                buf.append(f'<td class="numeric">{esc(display)}</td>')
            else:
                buf.append(f"<td>{esc(display)}</td>")
        buf.append("</tr>")
    buf.append("</tbody></table></div>")
    if len(rows) > 200:
        buf.append(f'<p class="row-count">(Showing 200 of {len(rows)} rows)</p>')
    elif rows:
        buf.append(f'<p class="row-count">{len(rows)} row{"s" if len(rows) != 1 else ""} returned</p>')
    return "\n".join(buf)


def render_checks_table(checks_dict, step_checks_meta):
    """Render the checks table. checks_dict = {key: bool}. step_checks_meta = list of {key, label, advice}."""
    if not checks_dict:
        return ""

    buf = ['<table class="checks-table">']
    buf.append("<thead><tr><th>Check</th><th>Answer</th><th>Advice</th></tr></thead>")
    buf.append("<tbody>")
    for key, answered_yes in checks_dict.items():
        # Find label + advice from meta
        meta = next((c for c in (step_checks_meta or []) if c.get("key") == key), None)
        label = meta["label"] if meta else humanize_key(key)
        advice = meta["advice"] if meta else ""
        row_class = "yes-row" if answered_yes else "no-row"
        answer_html = '<span class="answer-yes">Yes ⚠</span>' if answered_yes else '<span class="answer-no">No ✓</span>'
        advice_html = f'<span class="checks-advice">{esc(advice)}</span>' if (answered_yes and advice) else ""
        buf.append(
            f'<tr class="{row_class}">'
            f"<td>{esc(label)}</td>"
            f"<td>{answer_html}</td>"
            f"<td>{advice_html}</td>"
            f"</tr>"
        )
    buf.append("</tbody></table>")
    return "\n".join(buf)


def render_actions(actions_applied):
    if not actions_applied:
        return ""
    buf = []
    for action in actions_applied:
        buf.append(
            '<div class="action-block">'
            '<span class="action-applied-badge">✅ Applied</span>'
            f"<pre>{esc(action)}</pre>"
            "</div>"
        )
    return "\n".join(buf)


def render_findings_summary(session, step_meta_map):
    """Render the consolidated findings (Yes-answered checks) at the top."""
    flagged = []
    for step_rec in session.get("steps", []):
        checks = step_rec.get("checks", {})
        if not checks:
            continue
        title = step_rec.get("title", "")
        meta_list = step_meta_map.get(title, [])
        yes_checks = [(k, v) for k, v in checks.items() if v]
        if not yes_checks:
            continue
        items = []
        for key, _ in yes_checks:
            meta = next((c for c in meta_list if c.get("key") == key), None)
            label = meta["label"] if meta else humanize_key(key)
            advice = meta["advice"] if meta else ""
            items.append({"label": label, "advice": advice})
        flagged.append({"step": title, "items": items})

    if not flagged:
        return (
            '<div class="findings-summary">'
            '<h2>🔍 Action Items</h2>'
            '<p class="empty-note">No checks were flagged as Yes — no action items identified.</p>'
            "</div>"
        )

    total_items = sum(len(f["items"]) for f in flagged)
    buf = [
        '<div class="findings-summary">',
        f'<h2>🔍 Action Items ({total_items} flagged)</h2>',
        '<p style="font-size:0.85rem;color:#8b949e;margin-bottom:16px">Checks where you answered Yes — address these in priority order.</p>',
    ]
    for group in flagged:
        buf.append(f'<div class="findings-group">')
        buf.append(f'<div class="findings-group-title">{esc(group["step"])}</div>')
        for item in group["items"]:
            buf.append(
                '<div class="finding-item">'
                f'<div class="finding-label">{esc(item["label"])}</div>'
                f'<div class="finding-advice">{esc(item["advice"])}</div>'
                "</div>"
            )
        buf.append("</div>")
    buf.append("</div>")
    return "\n".join(buf)


def build_step_meta_map(session):
    """
    Build a map of step title -> list of check metadata.
    We embed check metadata in the session's steps under a '_checks_meta' key if available,
    or fall back to empty list. Since the CLI script doesn't embed metadata, we return empty.
    This allows the viewer to work without ALL_STEPS at runtime.
    """
    meta_map = {}
    for step in session.get("steps", []):
        title = step.get("title", "")
        meta_map[title] = step.get("_checks_meta", [])
    return meta_map


def generate_html(session, step_meta_map):
    db_type = session.get("db_type", "unknown")
    timestamp = session.get("timestamp", "")
    conn = session.get("connection", {})
    steps = session.get("steps", [])

    # Summary stats
    total_steps = len(steps)
    total_flagged = sum(
        sum(1 for v in s.get("checks", {}).values() if v)
        for s in steps
    )
    total_actions = sum(len(s.get("actions_applied", [])) for s in steps)

    # Format timestamp
    try:
        dt = datetime.fromisoformat(timestamp)
        ts_display = dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        ts_display = timestamp

    badge_color = DB_BADGE_COLORS.get(db_type, "#444")

    # ── Header
    header = f"""
<div class="header">
  <div class="header-top">
    <span class="db-badge" style="background:{badge_color}">{esc(db_type)}</span>
    <h1>Troubleshooting Report</h1>
  </div>
  <div class="meta">
    <span>🕒 {esc(ts_display)}</span>
    <span>🖥 {esc(conn.get('host',''))}:{conn.get('port','')}</span>
    <span>🗄 {esc(conn.get('dbname',''))}</span>
    {"<span>👤 " + esc(conn.get('user','')) + "</span>" if conn.get('user') else ""}
  </div>
  <div class="summary-row">
    <div class="chip"><span class="num">{total_steps}</span> steps run</div>
    <div class="chip"><span class="num">{total_flagged}</span> checks flagged</div>
    <div class="chip"><span class="num">{total_actions}</span> actions applied</div>
  </div>
</div>
"""

    # ── Findings summary
    findings = render_findings_summary(session, step_meta_map)

    # ── Step cards
    cards = []
    for idx, step in enumerate(steps, 1):
        title = step.get("title", f"Step {idx}")
        desc = step.get("description", "")
        sql_results = step.get("sql_results")
        checks = step.get("checks", {})
        actions = step.get("actions_applied", [])
        skipped = step.get("skipped", False)
        meta_list = step_meta_map.get(title, [])

        # Badges
        badges = []
        if skipped:
            badges.append('<span class="badge badge-skipped">⏭ Skipped</span>')
        if actions:
            badges.append(f'<span class="badge badge-applied">✅ {len(actions)} applied</span>')
        flagged_count = sum(1 for v in checks.values() if v)
        if flagged_count:
            badges.append(f'<span class="badge badge-flagged">⚠ {flagged_count} flagged</span>')
        badges_html = '<div class="step-badges">' + "".join(badges) + "</div>" if badges else ""

        # Body
        body_parts = []

        if skipped:
            body_parts.append('<p class="skipped-notice">⏭ This step was skipped.</p>')
        else:
            # SQL results
            if sql_results is not None:
                body_parts.append('<div class="results-section"><h3>📊 Query Results</h3>')
                body_parts.append(render_sql_table(sql_results))
                body_parts.append("</div>")

            # Checks
            if checks:
                body_parts.append('<div class="results-section"><h3>☑ Checks</h3>')
                body_parts.append(render_checks_table(checks, meta_list))
                body_parts.append("</div>")

            # Applied actions
            if actions:
                body_parts.append('<div class="results-section"><h3>🔧 Actions Applied</h3>')
                body_parts.append(render_actions(actions))
                body_parts.append("</div>")

            if not sql_results and not checks and not actions:
                body_parts.append('<p class="empty-note">No data recorded for this step.</p>')

        body_html = "\n".join(body_parts)

        card = f"""
<div class="step-card">
  <details>
    <summary>
      <span class="step-num">#{idx}</span>
      <div>
        <div class="step-title">{esc(title)}</div>
        <div class="step-desc">{esc(desc)}</div>
      </div>
      {badges_html}
    </summary>
    <div class="step-body">
      {body_html}
    </div>
  </details>
</div>
"""
        cards.append(card)

    cards_html = "\n".join(cards)

    html_doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DB Troubleshooting Report — {esc(db_type)} — {esc(ts_display)}</title>
  <style>
{CSS}
  </style>
</head>
<body>
  <div class="container">
    {header}
    {findings}
    <h2 style="margin-bottom:12px">Step-by-Step Results</h2>
    {cards_html}
    <p style="margin-top:32px;font-size:0.75rem;color:#8b949e;text-align:center">
      Generated by db_troubleshooter.py · {esc(ts_display)}
    </p>
  </div>
</body>
</html>
"""
    return html_doc


# ============================================================
# ENTRY POINT
# ============================================================

def main():
    # Determine input file
    if len(sys.argv) > 1:
        input_path = Path(sys.argv[1])
    else:
        input_path = Path("troubleshoot_results.json")

    if not input_path.exists():
        print(f"[ERROR] File not found: {input_path}")
        print("Run db_troubleshooter.py first to generate results.")
        sys.exit(1)

    print(f"Reading: {input_path}")
    with open(input_path, encoding="utf-8") as f:
        session = json.load(f)

    step_meta_map = build_step_meta_map(session)

    # Generate HTML
    html_content = generate_html(session, step_meta_map)

    # Determine output path
    out_path = input_path.parent / "troubleshoot_report.html"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html_content)

    print(f"Report written: {out_path}")

    # Open in browser
    try:
        webbrowser.open(out_path.resolve().as_uri())
        print("Opening in browser...")
    except Exception as exc:
        print(f"Could not open browser automatically: {exc}")
        print(f"Open manually: {out_path.resolve()}")


if __name__ == "__main__":
    main()
