import { loadSummary, sql, fmtPHP, fmtInt, fmtPct, PHL_PALETTE, EXP_CLASS_COLORS,
         mountChartActions, mountGloss, observeChartResize, createChart } from '../data.js';

const PROGRAMS_PAGE_SIZE = 50;

let _charts = { tree: null, exp: null, region: null };

export async function renderDeptDetail(root, deptName) {
  if (!deptName) {
    root.innerHTML = `<div class="card p-6 text-sm text-ink-700">No allocation specified.</div>`;
    return;
  }

  const summary = await loadSummary();
  const totalGAA = summary.total_thousands;

  // Header skeleton + KPI row, then we fetch in parallel.
  root.innerHTML = `
    <div class="grid grid-cols-12 gap-5">

      <!-- breadcrumb / header -->
      <div class="col-span-12">
        <div class="crumb mb-2">
          <a data-back="overview">← Overview</a>
          <span>·</span>
          <a data-back="departments">All allocations</a>
        </div>
        <div class="card p-6 flex items-start justify-between gap-4 flex-wrap">
          <div class="min-w-0">
            <div class="section-kicker">Allocation</div>
            <div class="font-display font-extrabold text-[32px] leading-[1.05] tracking-[-0.025em] text-ink-900" id="dd-name">${escapeHtml(deptName)}</div>
            <div class="text-xs text-ink-500 mt-2" id="dd-sub">Loading…</div>
          </div>
          <div class="text-right shrink-0">
            <div class="kpi-value" id="dd-total">—</div>
            <div class="text-xs text-ink-400 mt-1" id="dd-share">—</div>
          </div>
        </div>
      </div>

      <!-- KPI strip -->
      <div class="col-span-12 grid grid-cols-2 lg:grid-cols-4 gap-5">
        ${kpi('Programs',     '<span id="dd-kpi-prog">—</span>',     '<span data-term="PREXC">PREXC</span> <span data-term="FPAP">FPAP</span> IDs',        '#1d3da8', 'ok')}
        ${kpi('Agencies',     '<span id="dd-kpi-agency">—</span>',   'Implementing units',    '#e25034', 'ok')}
        ${kpi('Regions',      '<span id="dd-kpi-region">—</span>',   'Geographic spread',     '#e8b94a', 'ok')}
        ${kpi('Object lines', '<span id="dd-kpi-obj">—</span>',      'Distinct <span data-term="UACS">UACS</span> objects', '#3a5a3a', 'ok')}
      </div>

      <!-- Top programs - horizontal bar chart (replaces treemap) -->
      <div class="col-span-12 card p-6">
        <div class="flex items-center justify-between mb-3">
          <div>
            <div class="section-kicker">PROGRAMS</div>
            <div class="section-title">Top programs</div>
            <div class="text-xs text-ink-400 mt-0.5">Largest <span data-term="PREXC">PREXC</span> programs in this allocator · click a bar to filter the full list below</div>
          </div>
          <span class="pill pill-blue" id="dd-tree-count">—</span>
        </div>
        <div id="dd-tree" class="chart chart-lg" role="img" aria-label="Top programs by allocation, horizontal bar chart"></div>
      </div>

      <!-- Expense class + Top regions side-by-side -->
      <div class="col-span-12 lg:col-span-5 card p-6">
        <div class="section-kicker">BREAKDOWN</div>
        <div class="section-title mb-1">Expense class</div>
        <div class="text-xs text-ink-400 mb-2"><span data-term="PS">PS</span> · <span data-term="MOOE">MOOE</span> · <span data-term="CO">CO</span> · <span data-term="FE">FE</span></div>
        <div id="dd-exp" class="chart chart-sm" role="img" aria-label="Expense class breakdown, donut chart"></div>
        <div class="mt-3 space-y-1.5" id="dd-exp-legend"></div>
      </div>
      <div class="col-span-12 lg:col-span-7 card p-6">
        <div class="section-kicker">GEOGRAPHY</div>
        <div class="section-title mb-1">Top regions</div>
        <div class="text-xs text-ink-400 mb-2">Where the budget lands</div>
        <div id="dd-region" class="chart chart-sm" role="img" aria-label="Top regions for this department, bar chart"></div>
      </div>

      <!-- Programs table -->
      <div class="col-span-12 card p-6 mt-2">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <div class="section-kicker">DETAILS</div>
            <div class="section-title">All programs</div>
            <div class="text-xs text-ink-400 mt-0.5">Click a row for the <span data-term="PREXC">PREXC</span> program-level breakdown</div>
          </div>
          <div class="flex items-center gap-2">
            <input id="dd-search" class="input" type="search" placeholder="Search programs…" autocomplete="off" style="width: 280px" />
            <select id="dd-sort" class="select" style="width: 160px">
              <option value="amount_desc">Amount (high → low)</option>
              <option value="amount_asc">Amount (low → high)</option>
              <option value="name_asc">Name (A → Z)</option>
            </select>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                <th style="width:38px"></th>
                <th>Program</th>
                <th>Agency</th>
                <th class="num">PHP</th>
                <th class="num">Share of allocation</th>
              </tr>
            </thead>
            <tbody id="dd-prog-body">
              <tr><td colspan="5" class="text-ink-400 text-xs">Loading programs…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="mt-3 flex items-center justify-between text-xs text-ink-500" id="dd-pagebar">
          <div id="dd-pageinfo">—</div>
          <div class="flex items-center gap-2">
            <button class="btn btn-ghost" id="dd-prev">← Prev</button>
            <button class="btn btn-ghost" id="dd-next">Next →</button>
          </div>
        </div>
      </div>

    </div>
  `;

  mountGloss(root);

  // Wire breadcrumb
  root.querySelectorAll('[data-back]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = '#' + a.dataset.back;
    });
  });

  // --- fetch everything in parallel -----------------------------------------

  const [
    totalRow, programs, expRows, regionRows, agencyCount, objCount,
  ] = await Promise.all([
    sql(`SELECT SUM(amount_thousands) AS t FROM budget WHERE department = ?`, [deptName]),
    sql(`
      SELECT program_id, program, agency,
             SUM(amount_thousands) AS amount_thousands
      FROM budget
      WHERE department = ? AND program IS NOT NULL
      GROUP BY program_id, program, agency
      ORDER BY amount_thousands DESC
    `, [deptName]),
    sql(`
      SELECT exp_class, SUM(amount_thousands) AS amount_thousands
      FROM budget WHERE department = ? AND exp_class IS NOT NULL
      GROUP BY exp_class ORDER BY amount_thousands DESC
    `, [deptName]),
    sql(`
      SELECT region_code, region_name, SUM(amount_thousands) AS amount_thousands
      FROM budget WHERE department = ? AND region_name IS NOT NULL
      GROUP BY region_code, region_name ORDER BY amount_thousands DESC LIMIT 10
    `, [deptName]),
    sql(`SELECT COUNT(DISTINCT agency) AS c FROM budget WHERE department = ?`, [deptName]),
    sql(`SELECT COUNT(DISTINCT object_code) AS c FROM budget WHERE department = ?`, [deptName]),
  ]);

  const deptTotal = totalRow[0]?.t || 0;
  document.getElementById('dd-total').textContent = fmtPHP(deptTotal);
  document.getElementById('dd-share').textContent = `${fmtPct(deptTotal, totalGAA, 2)} of GAA`;
  document.getElementById('dd-sub').textContent =
    `FY${summary.year} GAA · ${fmtInt(programs.length)} programs · ${fmtInt(agencyCount[0]?.c || 0)} agencies`;

  document.getElementById('dd-kpi-prog').textContent = fmtInt(programs.length);
  document.getElementById('dd-kpi-agency').textContent = fmtInt(agencyCount[0]?.c || 0);
  document.getElementById('dd-kpi-region').textContent = fmtInt(regionRows.length);
  document.getElementById('dd-kpi-obj').textContent = fmtInt(objCount[0]?.c || 0);
  document.getElementById('dd-tree-count').textContent = `${fmtInt(programs.length)} programs`;

  // --- top programs horizontal bar chart -----------------------------------
  // Replaced the prior treemap: for wide departments (DPWH ~18k programs) the
  // treemap was visually noisy. A ranked horizontal bar chart of the top 25
  // surfaces the meaningful concentration; the full sortable/searchable list
  // remains in the table below.

  const TOP_BAR_N = 25;
  const topPrograms = programs.slice(0, TOP_BAR_N);
  const treeEl = document.getElementById('dd-tree');
  _charts.tree = createChart(treeEl);
  observeChartResize(treeEl, _charts.tree);
  _charts.tree.setOption({
    grid: { left: 230, right: 60, top: 10, bottom: 24, containLabel: false },
    xAxis: {
      type: 'value',
      axisLabel: { formatter: v => fmtPHP(v, { decimals: 0 }), color: '#7a6a4c', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e6d8b3' } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: topPrograms.map(p => truncate(p.program || '', 36)),
      axisLabel: { color: '#1a1611', fontSize: 11, fontWeight: 500 },
      axisLine: { show: false }, axisTick: { show: false },
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p) => {
        const idx = p[0].dataIndex;
        const row = topPrograms[idx];
        return `<div style="font-size:12px;font-weight:600;margin-bottom:2px;max-width:360px">${escapeHtml(row.program || '')}</div>
                ${row.agency ? `<div style="font-size:11px;color:#6b5e48;margin-bottom:4px">${escapeHtml(shortAgency(row.agency))}</div>` : ''}
                <div style="font-size:13px">${fmtPHP(row.amount_thousands)} · ${fmtPct(row.amount_thousands, deptTotal, 2)} of allocation</div>
                <div style="font-size:11px;color:#6b5e48;margin-top:4px">Click to filter the table below</div>`;
      },
    },
    series: [{
      type: 'bar',
      data: topPrograms.map(p => p.amount_thousands),
      itemStyle: {
        color: (p) => PHL_PALETTE[p.dataIndex % PHL_PALETTE.length],
        borderRadius: [0, 6, 6, 0],
      },
      barWidth: 12,
      label: {
        show: true, position: 'right',
        formatter: (p) => fmtPHP(p.value, { decimals: 0 }),
        color: '#7a6a4c', fontSize: 10.5, fontWeight: 500,
      },
    }],
  });
  _charts.tree.on('click', (params) => {
    const row = topPrograms[params.dataIndex];
    if (!row) return;
    const fullName = row.program;
    document.getElementById('dd-search').value = fullName;
    state.search = fullName;
    state.page = 0;
    renderProgramsTable();
    const tbl = document.getElementById('dd-prog-body');
    if (tbl) tbl.closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  {
    const deptSlug = slugify(deptName);
    const treeHdr = treeEl.closest('.card').querySelector('.flex.items-center.justify-between');
    mountChartActions(treeHdr, {
      getRows: () => topPrograms.map(p => ({ program: p.program, agency: p.agency, amount_thousands: p.amount_thousands })),
      columns: ['program', 'agency', 'amount_thousands'],
      csvName: `dept-${deptSlug}-top-programs-fy${summary.year}`,
      chart: _charts.tree,
      pngName: `dept-${deptSlug}-top-programs-fy${summary.year}`,
    });
  }

  // --- expense donut --------------------------------------------------------

  const expEl = document.getElementById('dd-exp');
  _charts.exp = createChart(expEl);
  observeChartResize(expEl, _charts.exp);
  _charts.exp.setOption({
    tooltip: {
      trigger: 'item',
      formatter: (p) => `<div style="font-size:12px;font-weight:600;margin-bottom:2px">${p.name}</div>
                        <div style="font-size:13px">${fmtPHP(p.value)} · ${p.percent}%</div>`,
    },
    series: [{
      type: 'pie',
      radius: ['58%', '82%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      label: { show: false },
      itemStyle: { borderColor: '#f1e8d2', borderWidth: 3 },
      data: expRows.map(d => ({
        value: d.amount_thousands, name: d.exp_class,
        itemStyle: { color: EXP_CLASS_COLORS[d.exp_class] || '#7a6a4c' },
      })),
    }],
  });
  document.getElementById('dd-exp-legend').innerHTML = expRows.map(d => `
    <div class="flex items-center justify-between text-xs">
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${EXP_CLASS_COLORS[d.exp_class] || '#7a6a4c'}"></span>
        <span class="truncate text-ink-700">${shortExp(d.exp_class)}</span>
      </div>
      <div class="text-ink-500 font-medium tabular-nums shrink-0 ml-2">${fmtPHP(d.amount_thousands)}</div>
    </div>
  `).join('');
  {
    const deptSlug = slugify(deptName);
    const expHdr = expEl.closest('.card').querySelector('.section-title');
    mountChartActions(expHdr, {
      getRows: () => expRows.map(d => ({ exp_class: d.exp_class, amount_thousands: d.amount_thousands })),
      columns: ['exp_class', 'amount_thousands'],
      csvName: `dept-${deptSlug}-expense-mix-fy${summary.year}`,
      chart: _charts.exp,
      pngName: `dept-${deptSlug}-expense-mix-fy${summary.year}`,
    });
  }

  // --- region bar -----------------------------------------------------------

  const regEl = document.getElementById('dd-region');
  _charts.region = createChart(regEl);
  observeChartResize(regEl, _charts.region);
  _charts.region.setOption({
    grid: { left: 160, right: 30, top: 10, bottom: 10, containLabel: false },
    xAxis: {
      type: 'value',
      axisLabel: { formatter: v => fmtPHP(v, { decimals: 0 }), color: '#7a6a4c', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e6d8b3' } },
    },
    yAxis: {
      type: 'category', inverse: true,
      data: regionRows.map(r => shortRegion(r.region_name)),
      axisLabel: { color: '#1a1611', fontSize: 11.5, fontWeight: 500 },
      axisLine: { show: false }, axisTick: { show: false },
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p) => {
        const r = regionRows[p[0].dataIndex];
        return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${r.region_name}</div>
                <div style="font-size:13px">${fmtPHP(r.amount_thousands)} · ${fmtPct(r.amount_thousands, deptTotal, 1)} of allocation</div>`;
      }
    },
    series: [{
      type: 'bar',
      data: regionRows.map(r => r.amount_thousands),
      itemStyle: {
        color: (p) => PHL_PALETTE[p.dataIndex % PHL_PALETTE.length],
        borderRadius: [0, 6, 6, 0],
      },
      barWidth: 12,
    }],
  });

  {
    const deptSlug = slugify(deptName);
    const regHdr = regEl.closest('.card').querySelector('.section-title');
    mountChartActions(regHdr, {
      getRows: () => regionRows.map(r => ({ region_name: r.region_name, amount_thousands: r.amount_thousands })),
      columns: ['region_name', 'amount_thousands'],
      csvName: `dept-${deptSlug}-top-regions-fy${summary.year}`,
      chart: _charts.region,
      pngName: `dept-${deptSlug}-top-regions-fy${summary.year}`,
    });
  }

  // --- programs table (search + sort + paginate) ----------------------------

  const state = { search: '', sort: 'amount_desc', page: 0, expanded: null };

  const searchEl = document.getElementById('dd-search');
  const sortEl = document.getElementById('dd-sort');
  const prevBtn = document.getElementById('dd-prev');
  const nextBtn = document.getElementById('dd-next');

  searchEl.addEventListener('input', (e) => {
    state.search = e.target.value;
    state.page = 0;
    renderProgramsTable();
  });
  sortEl.addEventListener('change', (e) => {
    state.sort = e.target.value;
    state.page = 0;
    renderProgramsTable();
  });
  prevBtn.addEventListener('click', () => {
    if (state.page > 0) { state.page -= 1; renderProgramsTable(); }
  });
  nextBtn.addEventListener('click', () => {
    state.page += 1; renderProgramsTable();
  });

  function filteredSorted() {
    const q = state.search.trim().toLowerCase();
    let rows = q
      ? programs.filter(p => (p.program || '').toLowerCase().includes(q) || (p.agency || '').toLowerCase().includes(q))
      : programs.slice();
    if (state.sort === 'amount_desc') rows.sort((a, b) => b.amount_thousands - a.amount_thousands);
    else if (state.sort === 'amount_asc') rows.sort((a, b) => a.amount_thousands - b.amount_thousands);
    else if (state.sort === 'name_asc') rows.sort((a, b) => (a.program || '').localeCompare(b.program || ''));
    return rows;
  }

  async function renderProgramsTable() {
    const rows = filteredSorted();
    const start = state.page * PROGRAMS_PAGE_SIZE;
    const end = Math.min(start + PROGRAMS_PAGE_SIZE, rows.length);
    const page = rows.slice(start, end);

    const body = document.getElementById('dd-prog-body');
    if (!page.length) {
      body.innerHTML = `<tr><td colspan="5" class="text-ink-400 text-xs">No programs match.</td></tr>`;
    } else {
      body.innerHTML = page.map((p, i) => {
        const idx = start + i;
        const isExpanded = state.expanded === idx;
        return `
          <tr class="prog-row cursor-pointer" data-idx="${idx}">
            <td>
              <span class="inline-flex items-center justify-center w-6 h-6 rounded-md text-[11px] font-semibold"
                style="background:${PHL_PALETTE[idx % PHL_PALETTE.length]}1A;color:${PHL_PALETTE[idx % PHL_PALETTE.length]}">
                ${isExpanded ? '−' : '+'}
              </span>
            </td>
            <td>
              <div class="text-sm font-medium text-ink-900 leading-snug" title="${escapeAttr(p.program)}">${escapeHtml(truncate(p.program, 100))}</div>
              ${p.program_id ? `<div class="text-[11px] text-ink-400 tabular-nums mt-0.5">${escapeHtml(p.program_id)}</div>` : ''}
            </td>
            <td class="text-xs text-ink-700">${escapeHtml(shortAgency(p.agency || ''))}</td>
            <td class="num font-medium">${fmtPHP(p.amount_thousands)}</td>
            <td class="num">${fmtPct(p.amount_thousands, deptTotal, 2)}</td>
          </tr>
          ${isExpanded ? `<tr><td colspan="5" style="background:#F4F4EE;padding:0">
            <div class="p-4" id="prog-detail-${idx}">
              <div class="text-xs text-ink-400">Loading program detail…</div>
            </div>
          </td></tr>` : ''}
        `;
      }).join('');

      body.querySelectorAll('.prog-row').forEach(tr => {
        tr.addEventListener('click', async () => {
          const idx = Number(tr.dataset.idx);
          state.expanded = (state.expanded === idx) ? null : idx;
          renderProgramsTable();
          if (state.expanded === idx) {
            await loadProgramDetail(idx, rows[idx]);
          }
        });
      });
    }

    document.getElementById('dd-pageinfo').textContent = rows.length
      ? `Showing ${start + 1}–${end} of ${fmtInt(rows.length)}${state.search ? ' filtered' : ''}`
      : '';
    prevBtn.disabled = state.page === 0;
    nextBtn.disabled = end >= rows.length;
    prevBtn.style.opacity = prevBtn.disabled ? 0.4 : 1;
    nextBtn.style.opacity = nextBtn.disabled ? 0.4 : 1;
    prevBtn.style.pointerEvents = prevBtn.disabled ? 'none' : 'auto';
    nextBtn.style.pointerEvents = nextBtn.disabled ? 'none' : 'auto';
  }

  async function loadProgramDetail(idx, p) {
    const wrap = document.getElementById('prog-detail-' + idx);
    if (!wrap) return;
    const params = p.program_id
      ? [deptName, p.program_id]
      : [deptName, p.program];
    const whereClause = p.program_id
      ? `department = ? AND program_id = ?`
      : `department = ? AND program = ?`;

    const [exp, region, objects] = await Promise.all([
      sql(`SELECT exp_class, SUM(amount_thousands) AS amt FROM budget WHERE ${whereClause} AND exp_class IS NOT NULL GROUP BY exp_class ORDER BY amt DESC`, params),
      sql(`SELECT region_name, SUM(amount_thousands) AS amt FROM budget WHERE ${whereClause} AND region_name IS NOT NULL GROUP BY region_name ORDER BY amt DESC LIMIT 8`, params),
      sql(`SELECT object_name, SUM(amount_thousands) AS amt FROM budget WHERE ${whereClause} AND object_name IS NOT NULL GROUP BY object_name ORDER BY amt DESC LIMIT 10`, params),
    ]);

    wrap.innerHTML = `
      <div class="grid grid-cols-12 gap-4">
        <div class="col-span-12 lg:col-span-4">
          <div class="text-[11px] text-ink-400 uppercase tracking-wider font-semibold mb-2">Expense class</div>
          ${exp.length ? exp.map(e => `
            <div class="flex items-center justify-between text-xs py-1">
              <div class="flex items-center gap-2 min-w-0">
                <span class="w-2 h-2 rounded-full shrink-0" style="background:${EXP_CLASS_COLORS[e.exp_class] || '#7a6a4c'}"></span>
                <span class="truncate">${shortExp(e.exp_class)}</span>
              </div>
              <span class="text-ink-700 tabular-nums ml-2">${fmtPHP(e.amt)}</span>
            </div>`).join('') : '<div class="text-xs text-ink-400">No data</div>'}
        </div>
        <div class="col-span-12 lg:col-span-4">
          <div class="text-[11px] text-ink-400 uppercase tracking-wider font-semibold mb-2">Top regions</div>
          ${region.length ? region.map(r => `
            <div class="flex items-center justify-between text-xs py-1">
              <span class="truncate">${escapeHtml(shortRegion(r.region_name))}</span>
              <span class="text-ink-700 tabular-nums ml-2">${fmtPHP(r.amt)}</span>
            </div>`).join('') : '<div class="text-xs text-ink-400">No regional split</div>'}
        </div>
        <div class="col-span-12 lg:col-span-4">
          <div class="text-[11px] text-ink-400 uppercase tracking-wider font-semibold mb-2">Top object codes</div>
          ${objects.length ? objects.map(o => `
            <div class="flex items-center justify-between text-xs py-1">
              <span class="truncate" title="${escapeAttr(o.object_name)}">${escapeHtml(truncate(o.object_name, 40))}</span>
              <span class="text-ink-700 tabular-nums ml-2">${fmtPHP(o.amt)}</span>
            </div>`).join('') : '<div class="text-xs text-ink-400">No object detail</div>'}
        </div>
      </div>
    `;
  }

  renderProgramsTable();
}

// ---- helpers ---------------------------------------------------------------

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function kpi(label, value, sub, dot, status) {
  const statusDot = status ? `<span class="kpi-status-dot kpi-status-${status}"></span>` : '';
  return `
    <div class="card kpi">
      ${statusDot}
      <div class="kpi-label"><span class="kpi-dot" style="background:${dot};box-shadow:0 0 0 3px ${dot}1A"></span>${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;
}

function shortProg(name) {
  if (!name) return '';
  return truncate(name, 40);
}
function shortAgency(name) {
  const m = (name || '').match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? m[2] : truncate(name, 40);
}
function shortExp(name) {
  return (name || '').replace('Maintenance and Other Operating Expenses', 'MOOE');
}
function shortRegion(name) {
  if (!name) return '';
  return name
    .replace(/^Region\s+/i, '')
    .replace('National Capital Region', 'NCR')
    .replace('Cordillera Administrative Region', 'CAR')
    .replace('Bangsamoro Autonomous Region in Muslim Mindanao', 'BARMM')
    .replace('Negros Island Region', 'NIR')
    .replace('Central Office / Nationwide', 'Central Office');
}
function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
