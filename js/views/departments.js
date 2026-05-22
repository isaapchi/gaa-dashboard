import { loadSummary, sql, fmtPHP, fmtInt, fmtPct, PHL_PALETTE, EXP_CLASS_COLORS,
         mountChartActions, mountGloss, observeChartResize, createChart } from '../data.js';

let _charts = { exp: null, agency: null };

export async function renderDepartments(root) {
  const s = await loadSummary();
  const total = s.total_thousands;
  const depts = s.by_department.slice().sort((a, b) => b.amount_thousands - a.amount_thousands);

  root.innerHTML = `
    <div class="grid grid-cols-12 gap-5">

      <!-- Header row -->
      <div class="col-span-12 card p-4 flex items-center gap-4">
        <div class="flex-1 min-w-0">
          <input id="dept-search" class="input" type="search" placeholder="Search allocations…" autocomplete="off" />
        </div>
        <div class="flex items-center gap-6 shrink-0 pr-2">
          <div class="text-right">
            <div class="kpi-label" style="justify-content:flex-end">Allocators</div>
            <div class="text-lg font-semibold text-ink-900 tabular-nums" id="dept-count">${fmtInt(depts.length)}</div>
          </div>
          <div class="text-right">
            <div class="kpi-label" style="justify-content:flex-end">Total Budget</div>
            <div class="text-lg font-semibold text-ink-900 tabular-nums">${fmtPHP(total)}</div>
          </div>
        </div>
      </div>

      <!-- Left: department list -->
      <div class="col-span-12 lg:col-span-4 card p-4">
        <div class="flex items-center justify-between mb-3 px-1">
          <div>
            <div class="section-kicker">BROWSE</div>
            <div class="section-title">Allocations</div>
          </div>
          <span class="pill">FY${s.year}</span>
        </div>
        <div id="dept-list" class="space-y-2 overflow-y-auto pr-1" style="max-height: 720px;"></div>
      </div>

      <!-- Right: detail panel -->
      <div class="col-span-12 lg:col-span-8 space-y-5" id="dept-detail">
        <div class="card p-6">
          <div class="text-xs text-ink-400">Loading allocation detail…</div>
        </div>
      </div>

    </div>
  `;

  const listEl = document.getElementById('dept-list');
  const searchEl = document.getElementById('dept-search');
  const countEl = document.getElementById('dept-count');

  let selected = depts[0]?.name || null;
  let filter = '';

  function renderList() {
    const q = filter.trim().toLowerCase();
    const filtered = q ? depts.filter(d => d.name.toLowerCase().includes(q)) : depts;
    countEl.textContent = fmtInt(filtered.length);
    if (filtered.length && !filtered.some(d => d.name === selected)) {
      selected = filtered[0].name;
      renderDetail(selected, total);
    }
    listEl.innerHTML = filtered.map(d => deptCard(d, total, d.name === selected)).join('');
    listEl.querySelectorAll('[data-dept]').forEach(el => {
      el.addEventListener('click', () => {
        selected = el.getAttribute('data-dept');
        renderList();
        renderDetail(selected, total);
      });
    });
  }

  searchEl.addEventListener('input', (e) => {
    filter = e.target.value;
    renderList();
  });

  renderList();
  if (selected) renderDetail(selected, total);
}

function deptCard(d, total, active) {
  const share = total ? (d.amount_thousands / total) : 0;
  const pct = (share * 100).toFixed(1);
  const barWidth = Math.max(2, share * 100).toFixed(2);
  const bg = active ? '#e25034' : '#ece1c3';
  const border = active ? '#e25034' : '#c8b988';
  const nameColor = active ? '#ece1c3' : '#1a1611';
  const subColor = active ? '#D8D4FB' : '#7a6a4c';
  const barBg = active ? 'rgba(255,255,255,0.20)' : '#e6d8b3';
  const barFg = active ? '#ece1c3' : '#e25034';
  return `
    <div data-dept="${escapeAttr(d.name)}"
         class="cursor-pointer transition"
         style="background:${bg};border:1px solid ${border};border-radius:14px;padding:12px 14px">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold leading-snug" style="color:${nameColor}" title="${escapeAttr(d.name)}">
            ${truncate(d.name, 64)}
          </div>
          <div class="text-xs mt-0.5 tabular-nums" style="color:${subColor}">
            ${fmtPHP(d.amount_thousands)} · ${pct}% of GAA
          </div>
        </div>
      </div>
      <div class="mt-2 w-full h-1.5 rounded-full" style="background:${barBg}">
        <div class="h-1.5 rounded-full" style="width:${barWidth}%;background:${barFg}"></div>
      </div>
    </div>
  `;
}

async function renderDetail(deptName, total) {
  const s = await loadSummary();   // cached — no extra fetch
  const detail = document.getElementById('dept-detail');

  detail.innerHTML = `
    <div class="card p-6">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="section-kicker">Allocator</div>
          <div class="font-display font-extrabold text-[26px] leading-[1.1] tracking-[-0.02em] text-ink-900" id="dept-name">${escapeHtml(deptName)}</div>
        </div>
        <div class="flex items-center gap-4 shrink-0">
          <div class="text-right">
            <div class="kpi-value" id="dept-total">—</div>
            <div class="text-xs text-ink-400 mt-1" id="dept-share">—</div>
          </div>
          <button class="btn" id="dept-open-detail" data-dept="${escapeAttr(deptName)}">
            View all programs →
          </button>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-12 gap-5">
      <div class="col-span-12 lg:col-span-6 card p-6">
        <div class="section-kicker">BREAKDOWN</div>
        <div class="section-title mb-1">Expense class</div>
        <div class="text-xs text-ink-400 mb-2"><span data-term="PS">PS</span> · <span data-term="MOOE">MOOE</span> · <span data-term="CO">CO</span> · <span data-term="FE">FE</span></div>
        <div id="dept-exp" class="chart" role="img" aria-label="Expense class breakdown, donut chart"></div>
        <div class="mt-3 space-y-1.5" id="dept-exp-legend"></div>
      </div>
      <div class="col-span-12 lg:col-span-6 card p-6">
        <div class="section-kicker" id="dept-agency-kicker">AGENCIES</div>
        <div class="section-title mb-1" id="dept-agency-title">Top agencies</div>
        <div class="text-xs text-ink-400 mb-2" id="dept-agency-sub">Implementing units within the allocator</div>
        <div id="dept-agency" class="chart" role="img" aria-label="Top units for this allocator, bar chart"></div>
      </div>
    </div>

    <div class="card p-6">
      <div class="flex items-center justify-between mb-3">
        <div>
          <div class="section-kicker">DETAILS</div>
          <div class="section-title">Top programs</div>
        </div>
        <span class="pill pill-blue"><span data-term="PREXC">PREXC</span> <span data-term="FPAP">FPAP</span></span>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>Program</th>
            <th class="num">PHP</th>
            <th class="num">Share of dept</th>
          </tr>
        </thead>
        <tbody id="dept-prog-body">
          <tr><td colspan="3" class="text-ink-400 text-xs">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  `;

  mountGloss(detail);

  const [expRows, agencyRows, operunitRows, progRows, totalRows] = await Promise.all([
    sql(`SELECT exp_class AS name, SUM(amount_thousands) AS amount_thousands
         FROM budget WHERE department = ? AND exp_class IS NOT NULL
         GROUP BY exp_class ORDER BY amount_thousands DESC`, [deptName]),
    sql(`SELECT agency AS name, SUM(amount_thousands) AS amount_thousands
         FROM budget WHERE department = ? AND agency IS NOT NULL
         GROUP BY agency ORDER BY amount_thousands DESC LIMIT 8`, [deptName]),
    sql(`SELECT operunit_name AS name, SUM(amount_thousands) AS amount_thousands
         FROM budget WHERE department = ? AND operunit_name IS NOT NULL
         GROUP BY operunit_name ORDER BY amount_thousands DESC LIMIT 8`, [deptName]),
    sql(`SELECT program AS name, SUM(amount_thousands) AS amount_thousands
         FROM budget WHERE department = ? AND program IS NOT NULL
         GROUP BY program ORDER BY amount_thousands DESC LIMIT 10`, [deptName]),
    sql(`SELECT SUM(amount_thousands) AS t FROM budget WHERE department = ?`, [deptName]),
  ]);

  const deptTotal = totalRows[0]?.t || 0;
  document.getElementById('dept-total').textContent = fmtPHP(deptTotal);
  document.getElementById('dept-share').textContent = `${fmtPct(deptTotal, total, 2)} of GAA`;
  const openBtn = document.getElementById('dept-open-detail');
  if (openBtn) openBtn.addEventListener('click', () => window.gotoDept(openBtn.dataset.dept));

  // Expense class donut
  const expEl = document.getElementById('dept-exp');
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
        value: d.amount_thousands,
        name: d.name,
        itemStyle: { color: EXP_CLASS_COLORS[d.name] || '#7a6a4c' },
      })),
    }],
  });

  document.getElementById('dept-exp-legend').innerHTML = expRows.map(d => `
    <div class="flex items-center justify-between text-xs">
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${EXP_CLASS_COLORS[d.name] || '#7a6a4c'}"></span>
        <span class="truncate text-ink-700">${shortExp(d.name)}</span>
      </div>
      <div class="text-ink-500 font-medium tabular-nums shrink-0 ml-2">${fmtPHP(d.amount_thousands)}</div>
    </div>
  `).join('');
  {
    const deptSlug = slugify(deptName);
    const expHdr = expEl.closest('.card').querySelector('.section-title');
    mountChartActions(expHdr, {
      getRows: () => expRows.map(d => ({ exp_class: d.name, amount_thousands: d.amount_thousands })),
      columns: ['exp_class', 'amount_thousands'],
      csvName: `dept-${deptSlug}-expense-mix-fy${s.year}`,
      chart: _charts.exp,
      pngName: `dept-${deptSlug}-expense-mix-fy${s.year}`,
      pngTitle:    `${deptName} · Expense mix · FY${s.year}`,
      pngSubtitle: `Share of allocation by economic class · ${fmtPHP(deptTotal)} total`,
      pngForceLabels: true,
      pngLegend: expRows.map(d => ({
        label: `${shortExp(d.name)} · ${fmtPHP(d.amount_thousands)}`,
        color: EXP_CLASS_COLORS[d.name] || '#7a6a4c',
      })),
    });
  }

  // Agencies bar - smart swap to operating units when one agency dominates.
  // Under UACS, line departments route nearly all appropriations through
  // "Office of the Secretary" then sub-allocate via operating units
  // (Central Office, regional offices, hospitals, schools division offices).
  // When the top agency holds >=80% of the dept, agencies are uninformative,
  // so we show top operating units instead. DND/AA/NGA keep the agency view
  // because their agencies (PA, PN, PAF; the SPFs) are genuinely distinct.
  const topAgencyShare = (agencyRows.length && deptTotal)
    ? agencyRows[0].amount_thousands / deptTotal
    : 0;
  const showOperunit = topAgencyShare >= 0.80 && operunitRows.length > 1;
  const barRows = showOperunit ? operunitRows : agencyRows;
  const barLabelFn = showOperunit
    ? (n => truncate(n || 'Unallocated', 32))
    : (n => truncate(shortAgency(n), 32));

  if (showOperunit) {
    document.getElementById('dept-agency-kicker').textContent = 'OPERATING UNITS';
    document.getElementById('dept-agency-title').textContent = 'Top operating units';
    const sub = document.getElementById('dept-agency-sub');
    sub.innerHTML = 'Central Office, regional offices, and sub-units. <a href="#" id="dept-show-agencies" class="underline decoration-dotted text-ink-500 hover:text-iris-deep">Show agencies instead</a> · ' + escapeHtml(shortAgency(agencyRows[0]?.name || '')) + ' holds ' + (topAgencyShare*100).toFixed(0) + '% of this allocator under UACS, so the agency view is uninformative.';
  } else {
    document.getElementById('dept-agency-kicker').textContent = 'AGENCIES';
    document.getElementById('dept-agency-title').textContent = 'Top agencies';
    document.getElementById('dept-agency-sub').textContent = 'Implementing units within the allocator';
  }

  const agencyEl = document.getElementById('dept-agency');
  _charts.agency = createChart(agencyEl);
  observeChartResize(agencyEl, _charts.agency);
  _charts.agency.setOption({
    grid: { left: 230, right: 30, top: 10, bottom: 10, containLabel: false },
    xAxis: {
      type: 'value',
      axisLabel: { formatter: v => fmtPHP(v, { decimals: 0 }), color: '#7a6a4c', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e6d8b3' } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: barRows.map(d => barLabelFn(d.name)),
      axisLabel: { color: '#1a1611', fontSize: 11.5, fontWeight: 500 },
      axisLine: { show: false }, axisTick: { show: false },
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p) => {
        const x = p[0];
        const row = barRows[x.dataIndex];
        return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${row.name || 'Unallocated'}</div>
                <div style="font-size:13px">${fmtPHP(row.amount_thousands)} · ${fmtPct(row.amount_thousands, deptTotal, 1)} of dept</div>`;
      },
    },
    series: [{
      type: 'bar',
      data: barRows.map(d => d.amount_thousands),
      itemStyle: {
        color: (p) => PHL_PALETTE[p.dataIndex % PHL_PALETTE.length],
        borderRadius: [0, 8, 8, 0],
      },
      barWidth: 16,
    }],
  });

  if (showOperunit) {
    const tlink = document.getElementById('dept-show-agencies');
    if (tlink) tlink.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('dept-agency-kicker').textContent = 'AGENCIES';
      document.getElementById('dept-agency-title').textContent = 'Top agencies';
      document.getElementById('dept-agency-sub').textContent = 'Implementing units within the allocator';
      _charts.agency.setOption({
        yAxis: { data: agencyRows.map(d => truncate(shortAgency(d.name), 32)) },
        series: [{ data: agencyRows.map(d => d.amount_thousands) }],
        tooltip: {
          trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: (p) => {
            const r = agencyRows[p[0].dataIndex];
            return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${r.name}</div>
                    <div style="font-size:13px">${fmtPHP(r.amount_thousands)} · ${fmtPct(r.amount_thousands, deptTotal, 1)} of dept</div>`;
          },
        },
      }, true);
    });
  }

  {
    const deptSlug = slugify(deptName);
    const agencyHdr = agencyEl.closest('.card').querySelector('.section-title');
    const colName = showOperunit ? 'operating_unit' : 'agency';
    const granularity = showOperunit ? 'operating unit' : 'agency';
    mountChartActions(agencyHdr, {
      getRows: () => barRows.map(d => ({ [colName]: d.name, amount_thousands: d.amount_thousands })),
      columns: [colName, 'amount_thousands'],
      csvName: `dept-${deptSlug}-top-${showOperunit ? 'operunits' : 'agencies'}-fy${s.year}`,
      chart: _charts.agency,
      pngName: `dept-${deptSlug}-top-${showOperunit ? 'operunits' : 'agencies'}-fy${s.year}`,
      pngTitle:    `${deptName} · Top ${granularity}s · FY${s.year}`,
      pngSubtitle: `Top ${barRows.length} ${granularity}s by allocation · ${fmtPHP(deptTotal)} dept total`,
    });
  }

  // Programs table
  const progBody = document.getElementById('dept-prog-body');
  if (!progRows.length) {
    progBody.innerHTML = `<tr><td colspan="3" class="text-ink-400 text-xs">No programs found.</td></tr>`;
  } else {
    progBody.innerHTML = progRows.map(p => `
      <tr>
        <td title="${escapeAttr(p.name)}">${escapeHtml(truncate(p.name, 80))}</td>
        <td class="num">${fmtPHP(p.amount_thousands)}</td>
        <td class="num">${fmtPct(p.amount_thousands, deptTotal, 1)}</td>
      </tr>
    `).join('');
  }
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function shortAgency(name) {
  const m = name.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return m[2];
  return name;
}

function shortExp(name) {
  return name.replace('Maintenance and Other Operating Expenses', 'MOOE');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}
