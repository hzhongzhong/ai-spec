import { RunLog } from "./run-logger";
import { buildTrendReport } from "./run-trend";
import { computePromptHash } from "./prompt-hasher";

// ─── SVG chart helpers ────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 8) return "#22c55e"; // green
  if (score >= 6) return "#f59e0b"; // amber
  return "#ef4444";                  // red
}

function renderSparkline(scores: number[], width = 400, height = 60): string {
  if (scores.length < 2) return `<svg width="${width}" height="${height}"></svg>`;
  const pad = 6;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const max = Math.max(...scores, 10);
  const min = Math.min(...scores, 0);
  const range = max - min || 1;

  const points = scores.map((s, i) => {
    const x = pad + (i / (scores.length - 1)) * w;
    const y = pad + h - ((s - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const lastX = parseFloat(points[points.length - 1].split(",")[0]);
  const lastY = parseFloat(points[points.length - 1].split(",")[1]);
  const lastScore = scores[scores.length - 1];

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <polyline points="${points.join(" ")}" fill="none" stroke="${scoreColor(lastScore)}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${lastX}" cy="${lastY}" r="3" fill="${scoreColor(lastScore)}"/>
  </svg>`;
}

function renderBarChart(
  entries: { label: string; value: number; color?: string }[],
  maxWidth = 280
): string {
  const maxVal = Math.max(...entries.map((e) => e.value), 1);
  const rows = entries
    .map((e) => {
      const pct = (e.value / maxVal) * maxWidth;
      const color = e.color ?? "#6366f1";
      return `
        <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
          <div style="width:110px;font-size:11px;color:#94a3b8;text-align:right;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.label}">${e.label}</div>
          <div style="height:14px;width:${pct.toFixed(0)}px;background:${color};border-radius:2px;min-width:2px"></div>
          <div style="font-size:11px;color:#e2e8f0">${e.value.toFixed(1)}</div>
        </div>`;
    })
    .join("");
  return `<div style="margin:0">${rows}</div>`;
}

// ─── Data preparation ─────────────────────────────────────────────────────────

interface DashboardData {
  totalRuns: number;
  scoredRuns: number;
  avgScore: number | null;
  compilePassRate: number | null;
  currentPromptHash: string;
  recentScores: { runId: string; date: string; score: number; hash: string }[];
  promptGroups: { hash: string; runs: number; avg: number; best: number; worst: number; isCurrent: boolean }[];
  stageDurations: { stage: string; avgMs: number }[];
  topErrors: { message: string; count: number }[];
  lastRunAt: string | null;
}

function prepareDashboardData(logs: RunLog[]): DashboardData {
  const currentHash = computePromptHash();
  const report = buildTrendReport(logs, { last: 50 });

  // Recent scored runs (last 30)
  const recentScores = logs
    .filter((l) => l.harnessScore !== undefined)
    .slice(0, 30)
    .reverse()
    .map((l) => ({
      runId: l.runId,
      date: l.startedAt.slice(0, 10),
      score: l.harnessScore!,
      hash: l.promptHash ?? "(no hash)",
    }));

  // Stage duration aggregation
  const stageAccum: Record<string, { total: number; count: number }> = {};
  for (const log of logs.slice(0, 20)) {
    const stages: Record<string, number> = {};
    for (const entry of log.entries ?? []) {
      if (entry.event.endsWith(":done") || entry.event.endsWith(":failed")) {
        const stageName = entry.event.replace(/:done$|:failed$/, "");
        const ms = entry.data?.durationMs;
        if (typeof ms === "number") stages[stageName] = ms;
      }
    }
    for (const [stage, ms] of Object.entries(stages)) {
      if (!stageAccum[stage]) stageAccum[stage] = { total: 0, count: 0 };
      stageAccum[stage].total += ms;
      stageAccum[stage].count++;
    }
  }
  const stageDurations = Object.entries(stageAccum)
    .map(([stage, { total, count }]) => ({ stage, avgMs: total / count }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 8);

  // Top errors
  const errorCounts: Record<string, number> = {};
  for (const log of logs) {
    for (const err of log.errors ?? []) {
      const key = err.slice(0, 80);
      errorCounts[key] = (errorCounts[key] ?? 0) + 1;
    }
  }
  const topErrors = Object.entries(errorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([message, count]) => ({ message, count }));

  // Compile pass rate (from error_feedback stage)
  let compilePassed = 0, compileTotal = 0;
  for (const log of logs) {
    const feedback = log.entries?.find((e) => e.event === "error_feedback:done" || e.event === "error_feedback:failed");
    if (feedback) {
      compileTotal++;
      if (feedback.event.endsWith(":done")) compilePassed++;
    }
  }

  const scoredLogs = logs.filter((l) => l.harnessScore !== undefined);
  const avgScore = scoredLogs.length > 0
    ? scoredLogs.reduce((s, l) => s + l.harnessScore!, 0) / scoredLogs.length
    : null;

  return {
    totalRuns: logs.length,
    scoredRuns: scoredLogs.length,
    avgScore,
    compilePassRate: compileTotal > 0 ? compilePassed / compileTotal : null,
    currentPromptHash: currentHash,
    recentScores,
    promptGroups: report.promptGroups.map((g) => ({
      hash: g.promptHash,
      runs: g.runs,
      avg: g.avg,
      best: g.best,
      worst: g.worst,
      isCurrent: g.isCurrent,
    })),
    stageDurations,
    topErrors,
    lastRunAt: logs[0]?.startedAt ?? null,
  };
}

// ─── HTML renderer ────────────────────────────────────────────────────────────

function renderHtml(data: DashboardData, generatedAt: string, totalLogsAnalyzed: number): string {
  const sparkline = renderSparkline(data.recentScores.map((r) => r.score));

  const stageBar = renderBarChart(
    data.stageDurations.map((s) => ({
      label: s.stage.replace(/_/g, " "),
      value: Math.round(s.avgMs / 100) / 10, // seconds
      color: "#6366f1",
    })),
    240
  );

  const promptRows = data.promptGroups
    .map((g) => {
      const isCurrent = g.isCurrent;
      const badge = isCurrent ? `<span style="background:#4f46e5;color:#fff;font-size:9px;padding:1px 6px;border-radius:9px;margin-left:6px">current</span>` : "";
      const avgColor = scoreColor(g.avg);
      return `<tr style="${isCurrent ? "background:#1e1b4b" : ""}">
        <td style="font-family:monospace;font-size:12px;color:#a5b4fc">${g.hash}${badge}</td>
        <td style="text-align:center;color:#94a3b8">${g.runs}</td>
        <td style="text-align:center;color:${avgColor};font-weight:600">${g.avg.toFixed(1)}</td>
        <td style="text-align:center;color:#22c55e">${g.best.toFixed(1)}</td>
        <td style="text-align:center;color:#ef4444">${g.worst.toFixed(1)}</td>
      </tr>`;
    })
    .join("");

  const recentRows = data.recentScores
    .slice()
    .reverse()
    .slice(-10)
    .map((r) => {
      const color = scoreColor(r.score);
      const bar = "█".repeat(Math.round(r.score)) + "░".repeat(10 - Math.round(r.score));
      return `<tr>
        <td style="font-family:monospace;font-size:11px;color:#64748b">${r.date}</td>
        <td style="font-family:monospace;font-size:11px;color:#94a3b8">${r.runId.slice(-12)}</td>
        <td style="color:${color};font-size:12px;font-family:monospace">${bar}</td>
        <td style="text-align:right;color:${color};font-weight:600">${r.score.toFixed(1)}</td>
      </tr>`;
    })
    .join("");

  const avgDisplay = data.avgScore !== null
    ? `<span style="color:${scoreColor(data.avgScore)}">${data.avgScore.toFixed(1)}</span>`
    : `<span style="color:#475569">—</span>`;

  const compileDisplay = data.compilePassRate !== null
    ? `<span style="color:${data.compilePassRate >= 0.8 ? "#22c55e" : "#f59e0b"}">${Math.round(data.compilePassRate * 100)}%</span>`
    : `<span style="color:#475569">—</span>`;

  const errorRows = data.topErrors.length > 0
    ? data.topErrors.map((e) =>
        `<div style="display:flex;gap:8px;align-items:flex-start;margin:4px 0">
          <span style="color:#ef4444;font-weight:600;flex-shrink:0">${e.count}×</span>
          <span style="color:#94a3b8;font-size:11px;font-family:monospace;word-break:break-all">${e.message.replace(/</g, "&lt;")}</span>
        </div>`
      ).join("")
    : `<div style="color:#475569;font-size:12px">No errors recorded</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai-spec Harness Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; }
  .header { background: #1e293b; border-bottom: 1px solid #334155; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 16px; font-weight: 600; color: #f1f5f9; }
  .header .meta { font-size: 11px; color: #475569; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; padding: 20px 24px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 12px; }
  .stat-row { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat { text-align: center; }
  .stat .value { font-size: 28px; font-weight: 700; line-height: 1; }
  .stat .label { font-size: 11px; color: #64748b; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; padding: 4px 8px; text-align: left; border-bottom: 1px solid #334155; }
  td { padding: 6px 8px; border-bottom: 1px solid #1e293b; }
  tr:last-child td { border-bottom: none; }
  .sparkline-wrap { margin: 8px 0; }
  .full { grid-column: 1 / -1; }
</style>
</head>
<body>
<div class="header">
  <h1>ai-spec · Harness Dashboard</h1>
  <div class="meta">Generated ${generatedAt} · Current prompt: <code style="color:#a5b4fc">${data.currentPromptHash}</code></div>
</div>

<div class="grid">

  <!-- Overview stats -->
  <div class="card">
    <h2>Overview</h2>
    <div class="stat-row">
      <div class="stat">
        <div class="value" style="color:#e2e8f0">${data.totalRuns}</div>
        <div class="label">Total Runs</div>
      </div>
      <div class="stat">
        <div class="value">${avgDisplay}</div>
        <div class="label">Avg Score</div>
      </div>
      <div class="stat">
        <div class="value">${compileDisplay}</div>
        <div class="label">Compile Pass</div>
      </div>
      <div class="stat">
        <div class="value" style="color:#e2e8f0">${data.scoredRuns}</div>
        <div class="label">Scored Runs</div>
      </div>
    </div>
  </div>

  <!-- Score trend sparkline -->
  <div class="card">
    <h2>Score Trend (last ${data.recentScores.length} runs)</h2>
    <div class="sparkline-wrap">${sparkline}</div>
    ${data.recentScores.length === 0 ? '<div style="color:#475569;font-size:12px">No scored runs yet</div>' : ""}
  </div>

  <!-- Prompt version comparison -->
  <div class="card full">
    <h2>Prompt Version Performance</h2>
    ${data.promptGroups.length === 0
      ? '<div style="color:#475569;font-size:12px">No runs with prompt hash yet</div>'
      : `<table>
      <thead><tr>
        <th>Prompt Hash</th>
        <th style="text-align:center">Runs</th>
        <th style="text-align:center">Avg</th>
        <th style="text-align:center">Best</th>
        <th style="text-align:center">Worst</th>
      </tr></thead>
      <tbody>${promptRows}</tbody>
    </table>`}
  </div>

  <!-- Recent run history -->
  <div class="card">
    <h2>Recent Runs</h2>
    ${data.recentScores.length === 0
      ? '<div style="color:#475569;font-size:12px">No scored runs yet</div>'
      : `<table>
      <thead><tr><th>Date</th><th>Run ID</th><th>Score</th><th style="text-align:right">/10</th></tr></thead>
      <tbody>${recentRows}</tbody>
    </table>`}
  </div>

  <!-- Stage durations -->
  <div class="card">
    <h2>Avg Stage Duration (seconds)</h2>
    ${data.stageDurations.length === 0
      ? '<div style="color:#475569;font-size:12px">No stage data yet</div>'
      : stageBar}
  </div>

  <!-- Top errors -->
  <div class="card">
    <h2>Top Errors (last ${Math.min(totalLogsAnalyzed, 20)} runs)</h2>
    ${errorRows}
  </div>

</div>
</body>
</html>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateDashboard(logs: RunLog[]): string {
  const data = prepareDashboardData(logs);
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  return renderHtml(data, generatedAt, logs.length);
}
