import { loadSummary, loadGDP, loadPopulation, getYears, fmtPHP, fmtPct, fmtInt, PHL_PALETTE,
         ECON_CATEGORY_COLORS, FN_CATEGORY_COLORS, econColorFor, fnColorFor,
         mountChartActions, mountGloss, observeChartResize, createChart, trendChip } from '../data.js';

// % of GDP for an amount in PHP thousands; returns null if no GDP figure available.
function pctOfGDP(amount_thousands, gdp_php) {
  if (!gdp_php || amount_thousands == null) return null;
  return (amount_thousands * 1000 / gdp_php) * 100;
}
function fmtGDPpct(amount_thousands, gdp_php, decimals = 1) {
  const v = pctOfGDP(amount_thousands, gdp_php);
  if (v == null) return '—';
  return v.toFixed(decimals) + '% of GDP';
}
export async function renderGlance(root) {
  const [s, gdp] = await Promise.all([loadSummary(), loadGDP()]);
  const total = s.total_thousands;
  const gdp_php = gdp ? gdp.gdp_php : null;
  const gdp_is_est = gdp ? gdp.is_estimate : false;
  const currentYear = s.year;

  // Pull prior-year totals for Growth-vs-prior KPI and the count trend chips.
  const yp = await getYears().catch(() => ({ years: [currentYear] }));
  const allYears = (yp.years || [currentYear]).filter(y => y <= currentYear).sort((a, b) => a - b);
  const priorYear = allYears.includes(currentYear)
    ? allYears[allYears.indexOf(currentYear) - 1] || null
    : null;
  const priorSummary = priorYear ? await loadSummary(priorYear).catch(() => null) : null;
  const priorTotal = priorSummary ? priorSummary.total_thousands : null;
  const growthPct = priorTotal ? ((total - priorTotal) / priorTotal) * 100 : null;
  const growthAbs = priorTotal ? total - priorTotal : null;

  // YoY deltas for the structural counts (Agencies / Programs).
  const agenciesYoY = priorSummary ? (s.n_agencies / priorSummary.n_agencies - 1) : null;
  const programsYoY = priorSummary ? (s.n_programs / priorSummary.n_programs - 1) : null;

  // Concentration table inputs: top-10 sum vs everyone else.
  const top10Sum = (s.by_department || []).slice(0, 10).reduce((a, x) => a + x.amount_thousands, 0);
  const otherSum = total - top10Sum;

  const econ = (s.by_economic || []).filter(x => x && x.amount_thousands)
                   .map(b => ({ ...b, color: econColorFor(b.name) }));
  const fns  = (s.by_function || []).filter(x => x && x.amount_thousands)
                   .slice().sort((a, b) => b.amount_thousands - a.amount_thousands)
                   .map(f => ({ ...f, color: fnColorFor(f.name) }));
  const h = s.headlines || {};

  // Pre-compute headline shares.
  const econTotal = econ.reduce((a, x) => a + x.amount_thousands, 0) || total;
  const econPct   = econ.map(x => 100 * x.amount_thousands / econTotal);

  // Plain-English callout sources (amount_thousands -> fmtPHP handles units).
  const fnByName = Object.fromEntries(fns.map(f => [f.name.toLowerCase(), f]));
  const eduFn    = fnByName['education'];
  const healthFn = fnByName['health'];

  const callouts = [
    h.wages != null && {
      color: econColorFor('Wages & Personnel', econColor(econ, 'Wages & Personnel')),
      amt: h.wages,
      sentence: 'pays wages and benefits for civil servants and uniformed personnel.',
    },
    h.transfers_lgu != null && {
      color: econColorFor('Transfers to LGUs', econColor(econ, 'Transfers to LGUs')),
      amt: h.transfers_lgu,
      sentence: 'is transferred to local government units as their share of national taxes.',
    },
    h.debt_service != null && {
      color: econColorFor('Debt Service', econColor(econ, 'Debt Service')),
      amt: h.debt_service,
      sentence: 'services foreign and domestic debt obligations.',
    },
    h.capital != null && {
      color: econColorFor('Capital Outlays', econColor(econ, 'Capital Outlays')),
      amt: h.capital,
      sentence: 'funds new infrastructure and capital projects.',
    },
    eduFn && {
      color: fnColorFor('Education', eduFn.color),
      amt: eduFn.amount_thousands,
      sentence: 'educates Filipino students from kindergarten to tertiary level.',
    },
    healthFn && {
      color: fnColorFor('Health', healthFn.color),
      amt: healthFn.amount_thousands,
      sentence: 'supports public health services and the universal health programme.',
    },
  ].filter(Boolean);

  // ── Riso Almanac hero — "Book of Pesos" intro for the Overview view.
  //   Replaces the Broadsheet Cover Story block. Uses figures already loaded
  //   by loadSummary(); nothing is invented. Renders a giant offset-overprint
  //   total figure on the right and a serif headline + narrative on the left,
  //   followed by a four-column "Almanac entries" KPI bar.
  const totalPHP_T = total / 1_000_000_000;
  const totalStrBig = totalPHP_T >= 1 ? ("\u20B1" + totalPHP_T.toFixed(2) + "T") : ("\u20B1" + (total/1000).toFixed(0) + "B");
  const totalStrPlain = fmtPHP(total);
  const growthSignTxt = growthPct != null
    ? (growthPct >= 0 ? ("\u2191 +" + growthPct.toFixed(1) + "%") : ("\u2193 " + growthPct.toFixed(1) + "%"))
    : "";
  const issueNo = String(currentYear).slice(-2);

  // Per-Filipino — uses the PSA per-year population baked in to
  // data/population.json. perFilipino is null when the lookup misses.
  const popPayload = await loadPopulation().catch(() => null);
  const population = popPayload && popPayload.population
    ? Number(popPayload.population[String(currentYear)]) || null
    : null;
  const perFilipino = (population && population > 0)
    ? Math.round((total * 1000) / population)
    : null;
  const perFilStr = perFilipino != null
    ? ('₱' + perFilipino.toLocaleString('en-PH'))
    : '—';

  root.innerHTML = `
    <!-- RISO ALMANAC HERO (FY${currentYear}) -->
    <div class="riso-hero" style="position:relative; padding: 4px 0 22px;">

      <div class="mono smallcaps" style="color: var(--scarlet); margin-bottom: 10px;">CHAPTER ONE &middot; OVERVIEW</div>

      <div style="display:grid; grid-template-columns: 1.5fr 1fr; gap: 40px; align-items: flex-end;">
        <div>
          <h2 class="display" style="font-size: clamp(56px, 7vw, 92px); margin: 0;">
            The annual<br/>
            <span class="overprint-r" style="color: var(--scarlet);">book of pesos.</span>
          </h2>
          <div style="font-family: 'Space Grotesk', sans-serif; font-size: 15px; line-height: 1.55; margin-top: 16px; max-width: 580px; color: var(--ink); opacity: 0.86;">
            ${(total / 1_000_000_000).toFixed(2)} <em>trillion Philippine pesos</em>.
            An almanac of where each one is headed in fiscal year ${currentYear}, indexed by agency, region, expense class, and a decade of history.
          </div>
        </div>
        <!-- Per-Filipino headline (right column) -->
        <div class="riso-perfil" style="position: relative; min-height: 140px;">
          <div class="mono smallcaps" style="color: var(--cobalt); font-size: 11px; letter-spacing: 0.18em; margin-bottom: 6px;">
            PER FILIPINO &middot; FY${currentYear}
          </div>
          <div style="position: relative; line-height: 0.9;">
            <div class="display" aria-hidden="true" style="position: absolute; inset: 0; font-size: clamp(56px, 6.5vw, 96px); color: var(--cobalt); transform: translate(5px, 4px); mix-blend-mode: multiply; opacity: 0.55;">
              ${perFilStr}
            </div>
            <div class="display" style="position: relative; font-size: clamp(56px, 6.5vw, 96px); color: var(--scarlet); mix-blend-mode: multiply;">
              ${perFilStr}
            </div>
          </div>
          <div class="mono smallcaps" style="font-size: 10px; letter-spacing: 0.18em; color: var(--muted); margin-top: 10px;">
            ${population
              ? ('PHP PER PERSON &middot; POP. ' + (population/1_000_000).toFixed(1) + 'M &middot; PSA')
              : 'POPULATION DATA UNAVAILABLE'}
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-12 gap-5">

      <!-- KPI strip: scale (Total / Growth / %GDP) + structure (Agencies / Programs) -->
      <div class="col-span-12 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-0 kpi-strip riso-strip">
        ${kpiCard(
          `FY${currentYear} Total Budget`,
          fmtPHP(total),
          '<span data-term="GAA">GAA</span>',
          '#e25034',
          'ok'
        )}
        ${kpiCard(
          `Growth vs FY${priorYear || '—'}`,
          growthPct != null ? (growthPct >= 0 ? '+' : '') + growthPct.toFixed(1) + '%' : '—',
          growthAbs != null ? (growthAbs >= 0 ? '+' : '') + fmtPHP(growthAbs) + ' year-on-year' : 'Prior year unavailable',
          '#3a5a3a',
          growthPct != null ? (growthPct >= 0 ? 'ok' : 'alert') : null
        )}
        ${kpiCard(
          'Budget as % of GDP',
          gdp_php ? fmtGDPpct(total, gdp_php, 1).replace(' of GDP', '') : '—',
          gdp_php
            ? `FY${currentYear} GDP${gdp_is_est ? ' (est.)' : ''}: ${fmtPHP(Math.round(gdp_php / 1000))}`
            : 'GDP data unavailable',
          '#e8b94a',
          gdp_php ? 'ok' : null
        )}
        ${kpiCard(
          'Agencies',
          fmtInt(s.n_agencies),
          'Implementing units',
          '#1d3da8',
          'ok',
          trendChip(agenciesYoY, { label: `vs FY${priorYear || '—'}`, decimals: 0 })
        )}
        ${kpiCard(
          'Programs',
          fmtInt(s.n_programs),
          '<span data-term="PREXC">PREXC</span> <span data-term="FPAP">FPAP</span> IDs',
          '#7a6a4c',
          'ok',
          trendChip(programsYoY, { label: `vs FY${priorYear || '—'}`, decimals: 0 })
        )}
      </div>

      <!-- Headline strip: stacked bar + tile breakdown by economic class -->
      <div class="col-span-12 card p-6" id="headline-strip-card">
        <div class="flex items-end justify-between mb-3 flex-wrap gap-3" id="headline-strip-header">
          <div>
            <div class="section-kicker">WHERE IT GOES</div>
            <div class="section-title">Where every &#x20B1;100 of FY${s.year} goes</div>
            <div class="text-xs text-ink-400 mt-0.5">Economic composition of the National Budget &middot; ${fmtPHP(total)} total</div>
          </div>
          <div class="flex items-center gap-2">
            ${gdp_php ? `
              <div class="pill pill-blue" title="${escapeHtml(gdp ? (gdp.note || 'World Bank: NY.GDP.MKTP.CN') : '')}">
                Total = <span class="font-bold ml-1">${fmtGDPpct(total, gdp_php, 1)}</span>
              </div>
              <div class="text-[11px] text-ink-400">
                FY${s.year} GDP: ${fmtPHP(Math.round(gdp_php / 1000))}${gdp_is_est ? ' &middot; est.' : ''}
              </div>
            ` : ''}
          </div>
        </div>
        <div id="headline-bar" class="w-full" style="height:18px" role="img" aria-label="Economic composition stacked bar chart"></div>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mt-5">
          ${econ.map((b, i) => headlineTile(b, econPct[i], gdp_php)).join('')}
        </div>
      </div>

      <!-- Economic donut -->
      <div class="col-span-12 lg:col-span-4 card p-6" id="econ-card">
        <div class="flex items-center justify-between mb-1" id="econ-card-header">
          <div>
            <div class="section-kicker">BY ECONOMIC CATEGORY</div>
            <div class="section-title">Economic breakdown</div>
          </div>
        </div>
        <div class="text-xs text-ink-400 mb-2">What the money buys</div>
        <div id="chart-econ" class="chart" role="img" aria-label="Economic breakdown donut chart"></div>
        <div class="mt-3 space-y-2" id="econ-legend"></div>
      </div>

      <!-- Functional bars + drill-down -->
      <div class="col-span-12 lg:col-span-8 card p-6" id="fn-card">
        <div class="flex items-center justify-between mb-3" id="fn-card-header">
          <div>
            <div class="section-kicker">BY FUNCTION</div>
            <div class="section-title">Functional breakdown</div>
            <div class="text-xs text-ink-400 mt-0.5">What the money does · click a bar for top departments</div>
          </div>
          <span class="pill">${fns.length} sectors</span>
        </div>
        <div id="chart-fn" class="chart" style="height:${Math.max(280, fns.length * 26)}px" role="img" aria-label="Functional breakdown bar chart"></div>
        <div id="fn-detail" class="mt-4"></div>
      </div>

      <!-- Plain-English callouts -->
      <div class="col-span-12">
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          ${callouts.map(c => calloutCard(c, total)).join('')}
        </div>
      </div>

      <!-- Concentration table — share of total held by top N allocators -->
      <div class="col-span-12 card p-6 mt-2">
        <div class="section-kicker">CONCENTRATION</div>
        <div class="section-title">Share held by the largest <span data-term="Allocators">allocators</span></div>
        <div class="text-xs text-ink-400 mt-0.5 mb-3">How much of the budget the largest entries account for</div>
        <table class="table">
          <thead><tr><th>Cohort</th><th class="num">PHP</th><th class="num">Share</th></tr></thead>
          <tbody>
            ${cohortRow('Top 1 allocator',   (s.by_department || []).slice(0, 1),  total)}
            ${cohortRow('Top 5 allocators',  (s.by_department || []).slice(0, 5),  total)}
            ${cohortRow('Top 10 allocators', (s.by_department || []).slice(0, 10), total)}
            ${cohortRow('Top 20 allocators', (s.by_department || []).slice(0, 20), total)}
            ${cohortRow('All other',         [{ amount_thousands: otherSum }],     total)}
          </tbody>
        </table>
      </div>


    </div>
  `;

  // --- headline stacked bar -------------------------------------------------
  const cBar = createChart(document.getElementById('headline-bar'));
  cBar.setOption({
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    xAxis: { type: 'value', show: false, max: econTotal },
    yAxis: { type: 'category', show: false, data: [''] },
    tooltip: {
      trigger: 'item',
      formatter: (p) => `<div style="font-size:12px;font-weight:600;margin-bottom:2px">${p.seriesName}</div>
                        <div style="font-size:13px">${fmtPHP(p.value)} · ${(100 * p.value / econTotal).toFixed(1)}%</div>`
    },
    series: econ.map((b, i) => ({
      name: b.name,
      type: 'bar',
      stack: 'total',
      data: [b.amount_thousands],
      itemStyle: {
        color: econColorFor(b.name, b.color),
        borderRadius: i === 0 ? [9, 0, 0, 9]
                    : i === econ.length - 1 ? [0, 9, 9, 0]
                    : 0,
      },
      barWidth: 18,
      barGap: '2px',
    })),
  });

  // export affordances: headline bar (stacked bar — no PNG, data rows are the econ array)
  const headlineStripHeader = document.getElementById('headline-strip-header');
  mountChartActions(headlineStripHeader, {
    getRows: () => econ.map((b, i) => ({ name: b.name, share_pct: econPct[i].toFixed(2), amount_thousands: b.amount_thousands })),
    columns: ['name', 'share_pct', 'amount_thousands'],
    csvName: `glance-economic-fy${s.year}`,
    chart: cBar,
    pngName: `glance-economic-bar-fy${s.year}`,
  });

  // --- economic donut -------------------------------------------------------
  const cEcon = createChart(document.getElementById('chart-econ'));
  cEcon.setOption({
    tooltip: {
      trigger: 'item',
      formatter: (p) => `<div style="font-size:12px;font-weight:600;margin-bottom:2px">${p.name}</div>
                        <div style="font-size:13px">${fmtPHP(p.value)} · ${p.percent}%</div>`
    },
    series: [{
      type: 'pie',
      radius: ['58%', '82%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      label: { show: false },
      itemStyle: { borderColor: '#f1e8d2', borderWidth: 3 },
      data: econ.map((b, i) => ({
        name: b.name,
        value: b.amount_thousands,
        itemStyle: { color: econColorFor(b.name, b.color) },
      })),
    }],
  });

  // export affordances: economic donut
  const econCardHeader = document.getElementById('econ-card-header');
  mountChartActions(econCardHeader, {
    getRows: () => econ.map((b, i) => ({ name: b.name, share_pct: econPct[i].toFixed(2), amount_thousands: b.amount_thousands })),
    columns: ['name', 'share_pct', 'amount_thousands'],
    csvName: `glance-econ-donut-fy${s.year}`,
    chart: cEcon,
    pngName: `glance-econ-donut-fy${s.year}`,
  });

  document.getElementById('econ-legend').innerHTML = econ.map((b, i) => `
    <div class="flex items-center justify-between text-xs">
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${econColorFor(b.name, b.color)}"></span>
        <span class="truncate text-ink-700 font-medium">${escapeHtml(b.name)}</span>
      </div>
      <div class="text-ink-500 tabular-nums shrink-0 ml-2">
        <span class="font-semibold text-ink-900">${fmtPHP(b.amount_thousands)}</span>
        <span class="text-ink-400 ml-1.5">${(100 * b.amount_thousands / econTotal).toFixed(1)}%</span>
      </div>
    </div>
  `).join('');

  // --- functional bars ------------------------------------------------------
  const cFn = createChart(document.getElementById('chart-fn'));
  cFn.setOption({
    grid: { left: 200, right: 80, top: 6, bottom: 6, containLabel: false },
    xAxis: {
      type: 'value',
      axisLabel: { formatter: v => fmtPHP(v, { decimals: 0 }), color: '#7a6a4c', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e6d8b3' } },
    },
    yAxis: {
      type: 'category', inverse: true,
      data: fns.map(f => truncate(f.name, 28)),
      axisLabel: { color: '#1a1611', fontSize: 12, fontWeight: 500 },
      axisLine: { show: false }, axisTick: { show: false },
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p) => {
        const x = p[0]; const f = fns[x.dataIndex];
        return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${escapeHtml(f.name)}</div>
                <div style="font-size:13px">${fmtPHP(f.amount_thousands)} · ${fmtPct(f.amount_thousands, total, 1)}</div>
                <div style="font-size:11px;color:#6b5e48;margin-top:4px">Click for top departments</div>`;
      }
    },
    series: [{
      type: 'bar',
      data: fns.map(f => f.amount_thousands),
      itemStyle: {
        color: (p) => fnColorFor(fns[p.dataIndex].name, fns[p.dataIndex].color),
        borderRadius: [0, 8, 8, 0],
      },
      barWidth: 16,
      cursor: 'pointer',
      label: {
        show: true, position: 'right',
        formatter: (p) => fmtPct(fns[p.dataIndex].amount_thousands, total, 1),
        color: '#7a6a4c', fontSize: 11, fontWeight: 600,
      },
    }],
  });

  // export affordances: functional bars
  const fnCardHeader = document.getElementById('fn-card-header');
  mountChartActions(fnCardHeader, {
    getRows: () => fns.map(f => ({ name: f.name, share_pct: fmtPct(f.amount_thousands, total, 1), amount_thousands: f.amount_thousands })),
    columns: ['name', 'share_pct', 'amount_thousands'],
    csvName: `glance-functional-fy${s.year}`,
    chart: cFn,
    pngName: `glance-functional-fy${s.year}`,
  });

  let activeFnIdx = -1;
  cFn.on('click', (params) => {
    const idx = params.dataIndex;
    if (idx === activeFnIdx) {
      activeFnIdx = -1;
      document.getElementById('fn-detail').innerHTML = '';
      return;
    }
    activeFnIdx = idx;
    renderFnDetail(fns[idx]);
  });

  function renderFnDetail(f) {
    const tops = (f.top_departments || []).slice(0, 8);
    const fnSum = f.amount_thousands;
    if (!tops.length) {
      document.getElementById('fn-detail').innerHTML = `
        <div class="text-xs text-ink-400 italic px-1">No department detail available for ${escapeHtml(f.name)}.</div>`;
      return;
    }
    const maxAmt = Math.max(...tops.map(d => d.amount_thousands));
    document.getElementById('fn-detail').innerHTML = `
      <div class="rounded-xl p-4" style="background:transparent;border:0;">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2 text-sm font-semibold text-ink-900">
            <span class="w-2.5 h-2.5 rounded-full" style="background:${fnColorFor(f.name, f.color)}"></span>
            Top departments in ${escapeHtml(f.name)}
          </div>
          <div class="text-xs text-ink-400">${fmtPHP(fnSum)} total</div>
        </div>
        <div class="space-y-2">
          ${tops.map(d => {
            const w = (100 * d.amount_thousands / maxAmt).toFixed(1);
            const sh = (100 * d.amount_thousands / fnSum).toFixed(1);
            return `
              <div class="flex items-center gap-3 text-xs">
                <div class="w-48 truncate text-ink-700 font-medium" title="${escapeHtml(d.name)}">${escapeHtml(shortDept(d.name))}</div>
                <div class="flex-1 h-2 rounded-full overflow-hidden" style="background:rgba(26,22,17,0.10)">
                  <div style="width:${w}%;height:100%;background:${fnColorFor(f.name, f.color)};border-radius:999px"></div>
                </div>
                <div class="w-20 text-right tabular-nums font-semibold text-ink-900">${fmtPHP(d.amount_thousands)}</div>
                <div class="w-12 text-right tabular-nums text-ink-400">${sh}%</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // Shared ResizeObserver for all charts in this view.
  observeChartResize(document.getElementById('headline-bar'), cBar);
  observeChartResize(document.getElementById('chart-econ'), cEcon);
  observeChartResize(document.getElementById('chart-fn'), cFn);
  // Note: observeChartResize covers container resize via shared ResizeObserver.
  // window.resize listener removed to avoid accumulating listeners on re-render.

  // (Removed) The view used to install a permanent `budgetyearchange`
  // listener that re-rendered glance into `#view-root` whenever the year
  // changed. That listener was global, never torn down, and fired even when
  // the user was on another view (Compare / Region / etc.) — causing the
  // Overview HTML to overwrite the current view after a year switch. The
  // year-select change handler in app.js already calls navigate() after
  // setCurrentYear(), so the current view re-renders correctly without
  // needing a per-view event listener.

  // Apply inline glosses to all data-term spans rendered above.
  mountGloss(root);
}

// --- Components -------------------------------------------------------------

function kpiCard(label, value, sub, dot, status, trendHTML) {
  // status: 'ok' | 'warn' | 'alert' (optional)
  // trendHTML: optional pre-rendered trend chip (from data.js trendChip helper)
  const statusDot = status ? `<span class="kpi-status-dot kpi-status-${status}"></span>` : '';
  const trendBlock = trendHTML
    ? `<span>${sub}</span>${trendHTML}`
    : `<span>${sub}</span>`;
  return `
    <div class="card kpi">
      ${statusDot}
      <div class="kpi-label"><span class="kpi-dot" style="background:${dot};box-shadow:0 0 0 3px ${dot}1A"></span>${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub flex items-center gap-2">${trendBlock}</div>
    </div>`;
}

function cohortRow(label, items, total) {
  const sum = items.reduce((a, x) => a + (x.amount_thousands || 0), 0);
  return `<tr>
    <td>${label}</td>
    <td class="num">${fmtPHP(sum)}</td>
    <td class="num">${fmtPct(sum, total, 1)}</td>
  </tr>`;
}

function headlineTile(b, pct, gdp_php) {
  const gdpPct = pctOfGDP(b.amount_thousands, gdp_php);
  return `
    <div class="rounded-xl p-3" style="background:transparent;border:0;">
      <div class="flex items-center gap-1.5 mb-1.5">
        <span class="kpi-dot" style="background:${econColorFor(b.name, b.color)};box-shadow:0 0 0 3px ${econColorFor(b.name, b.color)}1A"></span>
        <div class="text-xs font-semibold text-ink-700 leading-tight">${escapeHtml(b.name)}</div>
      </div>
      <div class="font-display font-extrabold text-ink-900 leading-none" style="font-size:30px;letter-spacing:-0.02em">
        ${pct.toFixed(1)}<span class="text-ink-400" style="font-size:18px;font-weight:600">%</span>
      </div>
      <div class="text-xs text-ink-400 tabular-nums mt-0.5">${fmtPHP(b.amount_thousands)}</div>
      ${gdpPct != null ? `<div class="text-[11px] text-ink-500 tabular-nums mt-0.5"><span class="font-semibold">${gdpPct.toFixed(2)}%</span> of GDP</div>` : ''}
    </div>
  `;
}

function calloutCard(c, total) {
  const pct = (100 * c.amt / total).toFixed(1);
  return `
    <div class="card p-6">
      <div class="flex items-baseline gap-2">
        <span class="kpi-dot" style="background:${c.color};box-shadow:0 0 0 3px ${c.color}1A"></span>
        <div class="font-display font-extrabold text-ink-900 leading-none" style="font-size:30px;letter-spacing:-0.02em">
          ${fmtPHP(c.amt)}
        </div>
        <div class="text-sm font-semibold tabular-nums" style="color:${c.color}">${pct}%</div>
      </div>
      <div class="mt-2 text-sm text-ink-700 leading-snug">${c.sentence}</div>
    </div>
  `;
}

// --- Helpers ----------------------------------------------------------------

function econColor(econ, name) {
  const m = econ.find(x => x.name === name);
  return m && m.color;
}

function shortDept(name) {
  const m = name.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return m[2];
  return truncate(name, 28);
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
