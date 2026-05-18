import {
  loadSummary, sql, fmtPHP, fmtInt, fmtPct, PHL_PALETTE,
  mountChartActions, mountGloss, observeChartResize, emptyState, createChart,
} from '../data.js';
import MultiSelect from '../multiselect.js';

// Whitelisted columns — never trust user input straight into SQL.
const GROUP_BY_COLS = {
  department:   { col: 'department',   label: 'Allocator' },
  agency:       { col: 'agency',       label: 'Agency' },
  region_name:  { col: 'region_name',  label: 'Region' },
  fund_subcat:  { col: 'fund_subcat',  label: 'Fund sub-category' },
  exp_class:    { col: 'exp_class',    label: 'Expense class' },
  object_name:  { col: 'object_name',  label: 'Object of expenditure' },
};

const FILTER_COLS = {
  department:  'department',
  region_code: 'region_code',
  exp_class:   'exp_class',
  fund_subcat: 'fund_subcat',
};

let _chart = null;

// --- Job 2: URL state helpers ------------------------------------------------

function encodeState(state) {
  const json = JSON.stringify(state);
  const b64  = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(s) {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    return JSON.parse(decodeURIComponent(escape(atob(b64 + pad))));
  } catch { return null; }
}

function getQueryArg(arg) {
  // arg is the portion after '#explorer/' — may be 'q=<b64>'
  if (!arg) return null;
  const m = arg.match(/^q=(.+)/);
  return m ? m[1] : null;
}

function currentQueryState() {
  const groupKey = document.getElementById('ex-groupby').value;
  const topN     = parseInt(document.getElementById('ex-topn').value, 10) || 25;
  const filters  = {};
  for (const key of Object.keys(FILTER_COLS)) {
    const sel = document.getElementById(`ex-f-${key}`);
    if (!sel) continue;
    const vals = Array.from(sel.selectedOptions).map(o => o.value).filter(v => v !== '');
    if (vals.length) filters[key] = vals;
  }
  return { groupBy: groupKey, topN, filters };
}

function applyStateToForm(state) {
  if (!state) return;
  const gbEl = document.getElementById('ex-groupby');
  if (gbEl && state.groupBy && GROUP_BY_COLS[state.groupBy]) {
    gbEl.value = state.groupBy;
  }
  const tnEl = document.getElementById('ex-topn');
  if (tnEl && state.topN) {
    tnEl.value = String(clamp(Number(state.topN), 5, 100));
  }
  if (state.filters) {
    for (const key of Object.keys(FILTER_COLS)) {
      const vals = state.filters[key];
      if (!vals || !vals.length) continue;
      const sel = document.getElementById(`ex-f-${key}`);
      if (!sel) continue;
      const valSet = new Set(vals);
      for (const opt of sel.options) {
        opt.selected = valSet.has(opt.value);
      }
    }
  }
}

// --- Job 1: stale indicator --------------------------------------------------

// Injected once per render; shared by stale helpers below.
let _applyBtn = null;

function initStaleCss() {
  if (!document.getElementById('explorer-btn-pulse-css')) {
    const s = document.createElement('style');
    s.id = 'explorer-btn-pulse-css';
    s.textContent =
      '@keyframes btnPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(107, 91, 239, 0); } ' +
      '50% { box-shadow: 0 0 0 4px rgba(107, 91, 239, 0.20); } } ' +
      '.btn-pulse { animation: btnPulse 1.4s ease-in-out infinite; }';
    document.head.appendChild(s);
  }
}

let _stale = false;

function markStale() {
  if (_stale) return;
  _stale = true;
  if (_applyBtn) _applyBtn.classList.add('btn-pulse');
  setStatus('Press Apply to refresh');
  updateFilterChip();
}

function clearStale() {
  _stale = false;
  if (_applyBtn) _applyBtn.classList.remove('btn-pulse');
}

// --- render ------------------------------------------------------------------

export async function renderExplorer(root, arg) {
  const s = await loadSummary();

  const departments = s.by_department.map(d => d.name).filter(Boolean).sort();
  const regions     = (s.by_region || []).map(r => ({ code: r.code, name: r.name })).filter(r => r.code && r.name);
  const expClasses  = (s.by_exp_class || []).map(x => x.name).filter(Boolean);
  const fundSubcats = (s.by_fund_subcat || []).map(x => x.name).filter(Boolean).sort();

  root.innerHTML = `
    <div class="grid grid-cols-12 gap-5">

      <!-- Controls -->
      <div class="col-span-12 card p-6">
        <div class="flex items-center justify-between mb-4">
          <div>
            <div class="section-kicker">Query</div>
            <div class="section-title">Budget explorer</div>
            <div class="text-xs text-ink-400 mt-0.5">Pivot the FY${s.year} <span data-term="GAA">GAA</span> across any dimension</div>
          </div>
          <div class="flex items-center gap-2">
            <span id="explorer-filter-chip"></span>
            <span id="explorer-status" class="text-xs text-ink-400"></span>
            <button id="explorer-apply" class="btn">Apply</button>
          </div>
        </div>

        <div class="grid grid-cols-12 gap-3">
          <div class="col-span-12 md:col-span-3">
            <label for="ex-groupby" class="kpi-label mb-1.5 block">Group by</label>
            <select id="ex-groupby" class="select">
              ${Object.entries(GROUP_BY_COLS).map(([k, v]) =>
                `<option value="${k}"${k === 'department' ? ' selected' : ''}>${v.label}</option>`
              ).join('')}
            </select>
          </div>

          <div class="col-span-12 md:col-span-2">
            <label for="ex-topn" class="kpi-label mb-1.5 block">Top N</label>
            <input id="ex-topn" type="number" class="input" value="25" min="5" max="100" step="5" />
          </div>

          <div class="col-span-12 md:col-span-7 grid grid-cols-2 lg:grid-cols-4 gap-3 ex-filters">
            <div class="ex-filter-cell">
              <label for="ex-f-department" class="kpi-label mb-1.5 block">Allocator</label>
              <div class="ms-wrapper" data-target="ex-f-department">
                <select id="ex-f-department" multiple data-empty="all">
                  ${departments.map(d => `<option value="${escapeAttr(d)}">${escapeHtml(d)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="ex-filter-cell">
              <label for="ex-f-region_code" class="kpi-label mb-1.5 block">Region</label>
              <div class="ms-wrapper" data-target="ex-f-region_code">
                <select id="ex-f-region_code" multiple data-empty="all">
                  ${regions.map(r => `<option value="${escapeAttr(r.code)}">${escapeHtml(r.name)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="ex-filter-cell">
              <label for="ex-f-exp_class" class="kpi-label mb-1.5 block">Expense class</label>
              <div class="ms-wrapper" data-target="ex-f-exp_class">
                <select id="ex-f-exp_class" multiple data-empty="all">
                  ${expClasses.map(x => `<option value="${escapeAttr(x)}">${escapeHtml(x)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="ex-filter-cell">
              <label for="ex-f-fund_subcat" class="kpi-label mb-1.5 block">Fund category</label>
              <div class="ms-wrapper" data-target="ex-f-fund_subcat">
                <select id="ex-f-fund_subcat" multiple data-empty="all">
                  ${fundSubcats.map(x => `<option value="${escapeAttr(x)}">${escapeHtml(x)}</option>`).join('')}
                </select>
              </div>
            </div>
          </div>
        </div>

      </div>

      <!-- Chart -->
      <div class="col-span-12 lg:col-span-8 card p-6 mt-2">
        <div class="flex items-center justify-between mb-3" id="ex-chart-header">
          <div>
            <div class="section-kicker">Results</div>
            <div class="section-title" id="ex-chart-title">Top allocators</div>
            <div class="text-xs text-ink-400 mt-0.5" id="ex-chart-sub">Loading…</div>
          </div>
          <span id="ex-chart-pill" class="pill pill-blue">—</span>
        </div>
        <div id="ex-chart" class="chart chart-lg" style="position:relative;" role="img" aria-label="Top results bar chart">
          <div id="ex-spinner" class="absolute inset-0 flex items-center justify-center" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
            <span class="spinner"></span>
          </div>
        </div>
      </div>

      <!-- KPI + table -->
      <div class="col-span-12 lg:col-span-4 space-y-5 mt-2">
        <div class="grid grid-cols-2 gap-3">
          <div class="card kpi">
            <div class="kpi-label"><span class="kpi-dot" style="background:#6B5BEF;box-shadow:0 0 0 3px #6B5BEF1A"></span>Filtered total</div>
            <div class="kpi-value" id="ex-kpi-total">—</div>
            <div class="kpi-sub" id="ex-kpi-total-sub">—</div>
          </div>
          <div class="card kpi">
            <div class="kpi-label"><span class="kpi-dot" style="background:#6b5e48;box-shadow:0 0 0 3px #6b5e481A"></span>Rows in result</div>
            <div class="kpi-value" id="ex-kpi-rows">—</div>
            <div class="kpi-sub">grouped categories</div>
          </div>
        </div>

        <div class="card p-6">
          <div class="flex items-center justify-between mb-3" id="ex-table-header">
            <div>
              <div class="section-kicker">Ranked</div>
              <div class="section-title">Top 10</div>
            </div>
          </div>
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th class="num">PHP</th>
                <th class="num">Share</th>
              </tr>
            </thead>
            <tbody id="ex-table-body">
              <tr><td colspan="3" class="text-ink-400" style="text-align:center;padding:20px;">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>
  `;

  // Job 1: inject pulse CSS once.
  initStaleCss();

  // Initialise chart once.
  _chart = createChart(document.getElementById('ex-chart'));
  observeChartResize(document.getElementById('ex-chart'), _chart);

  // Wire up Apply button.
  _applyBtn = document.getElementById('explorer-apply');

  // Job 2: populate form from URL state before running.
  const b64 = getQueryArg(arg);
  if (b64) {
    const state = decodeState(b64);
    if (state) applyStateToForm(state);
  }

  // Job 1: wire stale listeners — change events mark form as stale but do NOT auto-run.
  const staleTargets = [
    'ex-groupby', 'ex-topn',
    'ex-f-department', 'ex-f-region_code', 'ex-f-exp_class', 'ex-f-fund_subcat',
  ];
  for (const id of staleTargets) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', markStale);
  }

  // Job 1: Apply click — run query and update URL.
  _applyBtn.addEventListener('click', () => runQuery({ updateUrl: true }));

  // Mount the custom multi-select dropdowns. They wrap the hidden <select multiple>
  // elements and provide a usable open/close panel with checkboxes + search +
  // per-panel Select-all / Clear actions. Selecting items still drives
  // option.selected on the underlying select and dispatches a 'change' event,
  // so markStale and currentQueryState() continue to work unchanged.
  MultiSelect.mountAll(root);

  // Initial auto-run (not user-triggered — don't push a URL state here to
  // avoid conflicting with app.js's own replaceState that fires after render).
  await runQuery({ updateUrl: false });

  // Job 5: mount glossary on the whole view.
  mountGloss(root);

  // Initialise the filter chip after listeners are wired and initial query ran.
  updateFilterChip();
}

// --- query orchestration -----------------------------------------------------

// Last successful result set — kept for chart actions getRows closure.
let _lastGrouped = [];
let _lastGroupSpec = null;
let _lastGroupKey = '';

async function runQuery({ updateUrl = false } = {}) {
  // Job 1: clear stale state at query start.
  clearStale();
  updateFilterChip();

  const groupKey = document.getElementById('ex-groupby').value;
  const groupSpec = GROUP_BY_COLS[groupKey];
  if (!groupSpec) return;

  const topN = clamp(parseInt(document.getElementById('ex-topn').value, 10) || 25, 5, 100);

  const filters = collectFilters();

  // Build WHERE clause + parameters.
  const { whereSQL, params } = buildWhere(filters);

  const groupCol = groupSpec.col;
  const groupedSQL = `
SELECT ${groupCol} AS name,
       SUM(amount_thousands) AS amount_thousands
FROM budget
${whereSQL}
GROUP BY ${groupCol}
ORDER BY amount_thousands DESC NULLS LAST
LIMIT ${topN}
`.trim();

  const totalSQL = `
SELECT SUM(amount_thousands) AS total_thousands,
       COUNT(DISTINCT ${groupCol}) AS n_groups
FROM budget
${whereSQL}
`.trim();

  setLoading(true);
  setStatus('Running…');

  try {
    const [grouped, totals] = await Promise.all([
      sql(groupedSQL, params),
      sql(totalSQL, params),
    ]);

    const totalRow = totals[0] || { total_thousands: 0, n_groups: 0 };
    const filteredTotal = Number(totalRow.total_thousands || 0);
    const nGroups = Number(totalRow.n_groups || 0);

    // Stash for chart-actions closures.
    _lastGrouped   = grouped;
    _lastGroupSpec = groupSpec;
    _lastGroupKey  = groupKey;

    renderResults({ groupSpec, grouped, filteredTotal, nGroups, topN });
    setStatus(`${grouped.length} rows · ${fmtInt(nGroups)} ${plural(groupSpec.label.toLowerCase(), nGroups)}`);

    // Job 3: brief success flash on the Apply button.
    const applyBtn = document.getElementById('explorer-apply');
    if (applyBtn) {
      applyBtn.classList.add('chart-action-flash');
      setTimeout(() => applyBtn.classList.remove('chart-action-flash'), 600);
    }

    // Job 3 + 4: mount export actions on the chart card header.
    const chartHeaderEl = document.getElementById('ex-chart-header');
    if (chartHeaderEl) {
      mountChartActions(chartHeaderEl, {
        getRows:  () => _lastGrouped,
        columns:  ['name', 'amount_thousands'],
        csvName:  `explorer-${_lastGroupKey}`,
        chart:    _chart,
        pngName:  `explorer-${_lastGroupKey}`,
      });
    }

    // Table export actions.
    const tableHeaderEl = document.getElementById('ex-table-header');
    if (tableHeaderEl) {
      mountChartActions(tableHeaderEl, {
        getRows:  () => _lastGrouped.slice(0, 10),
        columns:  ['name', 'amount_thousands'],
        csvName:  `explorer-${_lastGroupKey}-top10`,
      });
    }

    // Job 2: update URL state on explicit Apply clicks only (avoids conflict
    // with app.js replaceState that fires after initial render returns).
    if (updateUrl) {
      const state = currentQueryState();
      history.replaceState(null, '', '#explorer/q=' + encodeState(state));
    }

  } catch (err) {
    console.warn('[explorer] query produced no rows or failed:', err && err.message ? err.message : err);
    setStatus('Query failed: see console');
    renderResults({ groupSpec, grouped: [], filteredTotal: 0, nGroups: 0, topN });
  } finally {
    setLoading(false);
  }
}

function renderResults({ groupSpec, grouped, filteredTotal, nGroups, topN }) {
  // Titles & KPIs.
  document.getElementById('ex-chart-title').textContent = `Top ${groupSpec.label.toLowerCase()}`;
  document.getElementById('ex-chart-sub').textContent =
    grouped.length
      ? `Top ${grouped.length} of ${fmtInt(nGroups)} · ${fmtPHP(filteredTotal)} filtered total`
      : 'No matching rows';
  document.getElementById('ex-chart-pill').textContent =
    grouped.length ? `Top ${grouped.length}` : '0 rows';

  document.getElementById('ex-kpi-total').textContent = fmtPHP(filteredTotal);
  document.getElementById('ex-kpi-total-sub').textContent =
    `Across ${fmtInt(nGroups)} ${plural(groupSpec.label.toLowerCase(), nGroups)}`;
  document.getElementById('ex-kpi-rows').textContent = fmtInt(grouped.length);

  // Chart.
  if (!grouped.length) {
    _chart.clear();
    _chart.setOption({
      title: {
        text: 'No data for the current filters',
        left: 'center', top: 'middle',
        textStyle: { color: '#7a6a4c', fontSize: 13, fontWeight: 500 },
      },
    });
  } else {
    const labels = grouped.map(d => truncate(displayName(d.name), 42));
    const values = grouped.map(d => Number(d.amount_thousands || 0));

    _chart.clear();
    _chart.setOption({
      grid: { left: 250, right: 30, top: 10, bottom: 10, containLabel: false },
      xAxis: {
        type: 'value',
        axisLabel: { formatter: v => fmtPHP(v, { decimals: 0 }), color: '#7a6a4c', fontSize: 11 },
        splitLine: { lineStyle: { color: '#e6d8b3' } },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: labels,
        axisLabel: { color: '#1a1611', fontSize: 11.5, fontWeight: 500 },
        axisLine: { show: false }, axisTick: { show: false },
      },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (p) => {
          const x = p[0];
          const row = grouped[x.dataIndex];
          const v = Number(row.amount_thousands || 0);
          return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${escapeHtml(displayName(row.name))}</div>
                  <div style="font-size:13px">${fmtPHP(v)} · ${fmtPct(v, filteredTotal, 1)}</div>`;
        }
      },
      series: [{
        type: 'bar',
        data: values,
        itemStyle: {
          color: (p) => PHL_PALETTE[p.dataIndex % PHL_PALETTE.length],
          borderRadius: [0, 8, 8, 0],
        },
        barWidth: barWidthFor(grouped.length),
        label: {
          show: grouped.length <= 20,
          position: 'right',
          formatter: (p) => fmtPHP(p.value, { decimals: 0 }),
          color: '#475569', fontSize: 11,
        },
      }],
    });
  }

  // Top 10 table.
  const tbody = document.getElementById('ex-table-body');
  if (!grouped.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="padding:0;">${emptyState({
      title: 'No matching rows',
      body:  'Try removing a filter or widening the Top N range.',
    })}</td></tr>`;
  } else {
    const top10 = grouped.slice(0, 10);
    tbody.innerHTML = top10.map(r => {
      const v = Number(r.amount_thousands || 0);
      return `<tr>
        <td>${escapeHtml(displayName(r.name))}</td>
        <td class="num">${fmtPHP(v)}</td>
        <td class="num">${fmtPct(v, filteredTotal, 1)}</td>
      </tr>`;
    }).join('');
  }
}

// --- WHERE builder -----------------------------------------------------------

function collectFilters() {
  const out = {};
  for (const key of Object.keys(FILTER_COLS)) {
    const sel = document.getElementById(`ex-f-${key}`);
    if (!sel) continue;
    const vals = Array.from(sel.selectedOptions).map(o => o.value).filter(v => v !== '');
    if (vals.length) out[key] = vals;
  }
  return out;
}

function buildWhere(filters) {
  const clauses = [];
  const params = [];
  for (const [key, vals] of Object.entries(filters)) {
    const col = FILTER_COLS[key];
    if (!col) continue; // whitelist guard
    const placeholders = vals.map(() => '?').join(', ');
    clauses.push(`${col} IN (${placeholders})`);
    params.push(...vals);
  }
  const whereSQL = clauses.length ? `WHERE ${clauses.join('\n  AND ')}` : '';
  return { whereSQL, params };
}

// --- helpers -----------------------------------------------------------------

function setLoading(on) {
  const sp = document.getElementById('ex-spinner');
  if (sp) sp.style.display = on ? 'flex' : 'none';
}

function setStatus(msg) {
  const el = document.getElementById('explorer-status');
  if (el) el.textContent = msg || '';
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function plural(label, n) {
  if (n === 1) return label;
  if (label.endsWith('y')) return label.slice(0, -1) + 'ies';
  if (label.endsWith('s')) return label;
  return label + 's';
}

function barWidthFor(n) {
  if (n <= 10) return 22;
  if (n <= 20) return 16;
  if (n <= 40) return 11;
  return 7;
}

function displayName(name) {
  if (name == null || name === '') return '(unspecified)';
  return String(name);
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function updateFilterChip() {
  const chipEl = document.getElementById('explorer-filter-chip');
  if (!chipEl) return;
  const filters = collectFilters();
  const totalActive = Object.values(filters).reduce((sum, vals) => sum + vals.length, 0);
  if (totalActive === 0) {
    chipEl.innerHTML = '';
    return;
  }
  const filterCount = Object.keys(filters).length;
  const dimLabel = filterCount === 1 ? '1 dimension' : `${filterCount} dimensions`;
  chipEl.innerHTML = `<span class="filter-active-chip" title="${totalActive} value${totalActive === 1 ? '' : 's'} across ${dimLabel}">${totalActive} filter${totalActive === 1 ? '' : 's'}</span>`;
}
