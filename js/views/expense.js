import { loadSummary, sql, fmtPHP, fmtInt, fmtPct, PHL_PALETTE, EXP_CLASS_COLORS,
         mountChartActions, mountGloss, observeChartResize, createChart } from '../data.js';

const EXP_CLASSES = [
  { abbr: 'PS',   full: 'Personnel Services' },
  { abbr: 'MOOE', full: 'Maintenance and Other Operating Expenses' },
  { abbr: 'CO',   full: 'Capital Outlays' },
  { abbr: 'FE',   full: 'Financial Expenses' },
];

export async function renderExpense(root) {
  const s = await loadSummary();
  const year = s.year || '';
  const total = s.total_thousands;

  // Build a class -> amount lookup from the summary.
  const classMap = Object.fromEntries(
    s.by_exp_class.filter(x => x.name).map(x => [x.name, x.amount_thousands])
  );

  root.innerHTML = `
    <div class="grid grid-cols-12 gap-5">

      <!-- KPI cards: one per expense class -->
      <div class="col-span-12 grid grid-cols-2 lg:grid-cols-4 gap-5">
        ${EXP_CLASSES.map(c => kpiCard(
          c.abbr,
          fmtPHP(classMap[c.full] || 0),
          c.full,
          fmtPct(classMap[c.full] || 0, total, 1) + ' of GAA',
          EXP_CLASS_COLORS[c.full] || '#94A3B8'
        )).join('')}
      </div>

      <!-- Stacked horizontal bar: top 12 departments by exp class -->
      <div class="col-span-12 card p-6 mt-2">
        <div class="flex items-center justify-between mb-3" id="hdr-dept-stack">
          <div>
            <div class="section-kicker">BY DEPARTMENT</div>
            <div class="section-title">Top 12 allocators by expense class</div>
            <div class="text-xs text-ink-400 mt-0.5"><span data-term="PS">PS</span> · <span data-term="MOOE">MOOE</span> · <span data-term="CO">CO</span> · <span data-term="FE">FE</span> composition</div>
          </div>
        </div>
        <div id="chart-dept-stack" class="chart chart-lg" role="img" aria-label="Top 12 allocators by expense class, stacked bar chart"></div>
      </div>

      <!-- Class selector + top object codes table -->
      <div class="col-span-12 card p-6 mt-2">
        <div class="flex items-center justify-between mb-3">
          <div>
            <div class="section-kicker">OBJECT CODES</div>
            <div class="section-title">Top object codes (<span data-term="UACS">UACS</span>)</div>
          </div>
          <div id="exp-class-selector" class="flex items-center gap-1.5"></div>
        </div>
        <div class="text-xs text-ink-400 mb-2" id="exp-class-sub"></div>
        <div id="exp-objects-table"></div>
      </div>

      <!-- Composition: 4 cards, one per expense class, top 8 departments each -->
      <div class="col-span-12 mt-2">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
          ${EXP_CLASSES.map(c => {
            const kicker = c.abbr === 'PS' ? 'PERSONNEL' : c.abbr === 'MOOE' ? 'MOOE' : c.abbr === 'CO' ? 'CAPITAL' : 'FINANCIAL';
            const dotColor = EXP_CLASS_COLORS[c.full] || '#94A3B8';
            return `
            <div class="card p-6">
              <div class="flex items-center justify-between mb-2" id="hdr-comp-${c.abbr}">
                <div class="flex items-center gap-2">
                  <span class="kpi-dot" style="background:${dotColor};box-shadow:0 0 0 3px ${dotColor}1A"></span>
                  <div>
                    <div class="section-kicker">${kicker}</div>
                    <div class="section-title"><span data-term="${c.abbr}">${c.abbr}</span></div>
                  </div>
                </div>
                <div class="text-xs text-ink-400">${c.full}</div>
              </div>
              <div id="chart-comp-${c.abbr}" class="chart chart-sm" role="img" aria-label="Top 8 allocators for ${c.abbr}, bar chart"></div>
            </div>
          `}).join('')}
        </div>
      </div>

    </div>
  `;

  // Apply inline glosses to newly rendered DOM
  mountGloss(root);

  // --- Stacked horizontal bar: top 12 departments by class -----------------
  const stackRows = await sql(`
    SELECT department, exp_class, SUM(amount_thousands) AS amt
    FROM budget
    WHERE exp_class IS NOT NULL AND department IS NOT NULL
    GROUP BY department, exp_class
  `);

  // Aggregate to dept totals, take top 12.
  const deptTotals = new Map();
  for (const r of stackRows) {
    deptTotals.set(r.department, (deptTotals.get(r.department) || 0) + r.amt);
  }
  const top12 = [...deptTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, amt]) => ({ name, amt }));
  const top12Set = new Set(top12.map(d => d.name));

  // Pivot: { dept -> { class -> amt } }
  const pivot = new Map(top12.map(d => [d.name, {}]));
  for (const r of stackRows) {
    if (!top12Set.has(r.department)) continue;
    pivot.get(r.department)[r.exp_class] = r.amt;
  }

  const cStack = createChart(document.getElementById('chart-dept-stack'));
  cStack.setOption({
    grid: { left: 230, right: 30, top: 30, bottom: 10, containLabel: false },
    legend: {
      top: 0, right: 0,
      data: EXP_CLASSES.map(c => c.abbr),
      itemWidth: 10, itemHeight: 10,
      textStyle: { color: '#475569', fontSize: 11 },
    },
    xAxis: {
      type: 'value',
      axisLabel: { formatter: v => fmtPHP(v, { decimals: 0 }), color: '#94A3B8', fontSize: 11 },
      splitLine: { lineStyle: { color: '#F4F4EE' } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: top12.map(d => shortDept(d.name)),
      axisLabel: { color: '#0F172A', fontSize: 12, fontWeight: 500 },
      axisLine: { show: false }, axisTick: { show: false },
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (ps) => {
        if (!ps.length) return '';
        const idx = ps[0].dataIndex;
        const fullName = top12[idx].name;
        const deptTotal = top12[idx].amt;
        const lines = ps
          .filter(p => p.value != null && p.value > 0)
          .map(p => `<div style="font-size:12px;display:flex;justify-content:space-between;gap:14px">
                      <span><span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:${p.color};margin-right:6px"></span>${p.seriesName}</span>
                      <span style="font-variant-numeric:tabular-nums">${fmtPHP(p.value)} · ${fmtPct(p.value, deptTotal, 0)}</span>
                    </div>`).join('');
        return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${fullName}</div>
                ${lines}
                <div style="margin-top:4px;padding-top:4px;border-top:1px solid #E9E9DF;font-size:12px;display:flex;justify-content:space-between;gap:14px">
                  <span>Total</span><span style="font-variant-numeric:tabular-nums">${fmtPHP(deptTotal)}</span>
                </div>`;
      }
    },
    series: EXP_CLASSES.map(c => ({
      name: c.abbr,
      type: 'bar',
      stack: 'dept',
      data: top12.map(d => pivot.get(d.name)[c.full] || 0),
      itemStyle: { color: EXP_CLASS_COLORS[c.full] || '#94A3B8' },
      barWidth: 18,
      emphasis: { focus: 'series' },
    })),
  });

  // Export affordance for the stacked dept chart
  const stackRows_export = top12.map(d => ({
    department: d.name,
    ...Object.fromEntries(EXP_CLASSES.map(c => [c.abbr, pivot.get(d.name)[c.full] || 0])),
    total: d.amt,
  }));
  mountChartActions(document.getElementById('hdr-dept-stack'), {
    getRows:  () => stackRows_export,
    columns:  ['department', ...EXP_CLASSES.map(c => c.abbr), 'total'],
    csvName:  `expense-top12-departments-fy${year}`,
    chart:    cStack,
    pngName:  `expense-top12-departments-fy${year}`,
    pngTitle:    `Top 12 departments · Expense-class mix · FY${year}`,
    pngSubtitle: `Stacked by PS / MOOE / CO / FE · ${fmtPHP(top12.reduce((a,d)=>a+d.amt,0))} combined`,
    pngLegend: EXP_CLASSES.map(c => ({ label: c.full, color: EXP_CLASS_COLORS[c.full] || '#94A3B8' })),
  });

  observeChartResize(document.getElementById('chart-dept-stack'), cStack);

  // --- Class selector + top object codes table -----------------------------
  let activeClass = 'Maintenance and Other Operating Expenses'; // default = MOOE
  const selectorEl = document.getElementById('exp-class-selector');
  const subEl = document.getElementById('exp-class-sub');
  const tableEl = document.getElementById('exp-objects-table');

  // Closure variable: current object-code rows (updated on each loadObjects call)
  let currentObjRows = [];

  function renderSelector() {
    selectorEl.innerHTML = EXP_CLASSES.map(c =>
      `<button data-cls="${c.full}" class="${c.full === activeClass ? 'btn' : 'btn btn-ghost'}" style="padding:6px 12px;font-size:12px">${c.abbr}</button>`
    ).join('');
    selectorEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        activeClass = btn.getAttribute('data-cls');
        renderSelector();
        loadObjects();
      });
    });
  }

  async function loadObjects() {
    const classTotal = classMap[activeClass] || 0;
    subEl.innerHTML = `${shortExp(activeClass)} · class total ${fmtPHP(classTotal)}`;
    tableEl.innerHTML = `<div class="flex items-center gap-2 text-xs text-ink-400 py-3"><span class="spinner"></span>Loading…</div>`;
    const rows = await sql(`
      SELECT object_name, SUM(amount_thousands) AS amt
      FROM budget
      WHERE exp_class = ? AND object_name IS NOT NULL
      GROUP BY object_name
      ORDER BY amt DESC
      LIMIT 15
    `, [activeClass]);

    // Update closure variable so export always reflects current selection
    currentObjRows = rows.map(r => ({ object_name: r.object_name, amount_thousands: r.amt, share_pct: classTotal ? +(100 * r.amt / classTotal).toFixed(1) : 0 }));

    const activeAbbr = EXP_CLASSES.find(c => c.full === activeClass)?.abbr || activeClass;
    tableEl.innerHTML = `
      <table class="table">
        <thead><tr><th>Object</th><th class="num">PHP</th><th class="num">Share</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td>${truncate(r.object_name, 48)}</td>
            <td class="num">${fmtPHP(r.amt)}</td>
            <td class="num">${fmtPct(r.amt, classTotal, 1)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
  }

  renderSelector();
  await loadObjects();

  // Mount export affordance on the object-codes panel header (re-mount after each
  // loadObjects so the button cluster stays, but getRows is a live lambda).
  // We need a stable header element — use the card's existing header row.
  const objHdr = document.querySelector('#exp-class-selector')?.closest('.flex');
  if (objHdr) {
    mountChartActions(objHdr, {
      getRows:  () => currentObjRows,
      columns:  ['object_name', 'amount_thousands', 'share_pct'],
      csvName:  `expense-object-codes-fy${year}`,
    });
  }

  // --- Composition: 4 small horizontal bar charts --------------------------
  const compRows = await sql(`
    SELECT exp_class, department, SUM(amount_thousands) AS amt
    FROM budget
    WHERE exp_class IS NOT NULL AND department IS NOT NULL
    GROUP BY exp_class, department
  `);

  // Group by class
  const byClass = new Map(EXP_CLASSES.map(c => [c.full, []]));
  for (const r of compRows) {
    if (byClass.has(r.exp_class)) byClass.get(r.exp_class).push(r);
  }

  for (const c of EXP_CLASSES) {
    const top8 = (byClass.get(c.full) || [])
      .sort((a, b) => b.amt - a.amt)
      .slice(0, 8);
    const classTotal = classMap[c.full] || 0;
    const color = EXP_CLASS_COLORS[c.full] || '#94A3B8';
    const chartEl = document.getElementById(`chart-comp-${c.abbr}`);
    const chart = createChart(chartEl);
    chart.setOption({
      grid: { left: 200, right: 25, top: 8, bottom: 8, containLabel: false },
      xAxis: {
        type: 'value',
        axisLabel: { formatter: v => fmtPHP(v, { decimals: 0 }), color: '#94A3B8', fontSize: 11 },
        splitLine: { lineStyle: { color: '#F4F4EE' } },
      },
      yAxis: {
        type: 'category', inverse: true,
        data: top8.map(d => shortDept(d.department)),
        axisLabel: { color: '#0F172A', fontSize: 11.5 },
        axisLine: { show: false }, axisTick: { show: false },
      },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (p) => {
          const x = p[0];
          const v = top8[x.dataIndex].amt;
          return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${top8[x.dataIndex].department}</div>
                  <div style="font-size:13px">${fmtPHP(v)} · ${fmtPct(v, classTotal, 1)} of ${c.abbr}</div>`;
        }
      },
      series: [{
        type: 'bar',
        data: top8.map(d => d.amt),
        itemStyle: { color, borderRadius: [0, 6, 6, 0] },
        barWidth: 14,
      }],
    });

    // Export affordance for each per-class top-8 chart
    const hdrEl = document.getElementById(`hdr-comp-${c.abbr}`);
    const exportRows = top8.map(d => ({ department: d.department, amount_thousands: d.amt, share_pct: classTotal ? +(100 * d.amt / classTotal).toFixed(1) : 0 }));
    mountChartActions(hdrEl, {
      getRows:  () => exportRows,
      columns:  ['department', 'amount_thousands', 'share_pct'],
      csvName:  `expense-${c.abbr}-top-departments-fy${year}`,
      chart:    chart,
      pngName:  `expense-${c.abbr}-top-departments-fy${year}`,
      pngTitle:    `${c.full} · Top departments · FY${year}`,
      pngSubtitle: `Top 8 departments by ${c.abbr} allocation · ${fmtPHP(classTotal)} class total`,
      pngLegend: [{ label: c.full, color }],
    });

    observeChartResize(chartEl, chart);
  }
}

function kpiCard(label, value, subtitle, sub2, dot) {
  return `
    <div class="card kpi">
      <div class="kpi-label"><span class="kpi-dot" style="background:${dot};box-shadow:0 0 0 3px ${dot}1A"></span><span data-term="${label}">${label}</span></div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${subtitle}</div>
      <div class="kpi-sub" style="color:#64748B;font-weight:600">${sub2}</div>
    </div>`;
}

function shortDept(name) {
  // Strip parenthetical acronym for axis labels.
  const m = name.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return m[2];
  return truncate(name, 32);
}

function shortExp(name) {
  return name.replace('Maintenance and Other Operating Expenses', 'MOOE');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
