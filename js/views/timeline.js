import { getYears, loadSummary, loadGDP, loadCPI, fmtPHP, fmtPct, fmtInt, PHL_PALETTE, mountChartActions, mountGloss, observeChartResize, createChart, coverageFor } from '../data.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pctOfGDP(amount_thousands, gdp_php) {
  if (!gdp_php || amount_thousands == null) return null;
  return (amount_thousands * 1000 / gdp_php) * 100;
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

function shortDept(name) {
  const m = name.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return m[2];
  return truncate(name, 28);
}

// CAGR: (end/start)^(1/(n-1)) - 1, expressed as %.
function cagr(start, end, n) {
  if (!start || n < 2) return null;
  return (Math.pow(end / start, 1 / (n - 1)) - 1) * 100;
}

// ---------------------------------------------------------------------------
// KPI card (same signature as overview.js)
// ---------------------------------------------------------------------------

function kpiCard(label, value, sub, dot) {
  return `
    <div class="card kpi">
      <div class="kpi-label"><span class="kpi-dot" style="background:${dot};box-shadow:0 0 0 3px ${dot}1A"></span>${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function renderTimeline(root) {
  root.innerHTML = `
    <div class="flex items-center gap-3 py-10 justify-center text-ink-400">
      <span class="spinner"></span>
      <span class="text-sm">Loading multi-year data…</span>
    </div>`;

  // 1. Discover available years from the canonical years.json (same list that
  //    populates the top-nav year selector).  Falls back gracefully if the file
  //    is missing.  Years that have no matching summary_${yr}.json are silently
  //    dropped below via the .filter(r => r.s != null) step.
  const yearsPayload = await getYears();
  const allYears = yearsPayload.years || [];
  // Cross-year charts only show comparability-equivalent years. NGA-only years
  // (FY2016, FY2017) are excluded here because mixing them with full-GAA years
  // produces misleading dips/jumps. They remain available in single-year views
  // (Overview, Allocations, Regions, Expense, Explorer) where the coverage chip
  // makes the NGA-only scope explicit.
  const NON_COMPARABLE = new Set(['UACS_REMAPPED_NGA_ONLY']);
  const comparableYears = allYears.filter(y => !NON_COMPARABLE.has(coverageFor(y)));
  const excludedForComparability = allYears.filter(y => NON_COMPARABLE.has(coverageFor(y)));

  // Year-range filter — persisted in localStorage so revisits remember the user's choice.
  // Default: most recent 6 comparable years.
  const RANGE_KEY = 'halaga.timeline.range';
  const fullMin = comparableYears[0];
  const fullMax = comparableYears[comparableYears.length - 1];
  let rangeFrom = fullMax - 5;   // last 6 years inclusive
  let rangeTo   = fullMax;
  try {
    const stored = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
    if (stored && Number.isInteger(stored.from) && Number.isInteger(stored.to)
        && stored.from <= stored.to
        && stored.from >= fullMin && stored.to <= fullMax) {
      rangeFrom = stored.from;
      rangeTo   = stored.to;
    }
  } catch {}
  // Clamp to comparable years that actually exist (skip e.g. gap years).
  rangeFrom = comparableYears.find(y => y >= rangeFrom) ?? fullMin;
  rangeTo   = [...comparableYears].reverse().find(y => y <= rangeTo) ?? fullMax;
  if (rangeFrom > rangeTo) { rangeFrom = fullMin; rangeTo = fullMax; }
  const candidateYears = comparableYears.filter(y => y >= rangeFrom && y <= rangeTo);

  // 2. Fetch all summaries + GDP + CPI entries in parallel.
  const [summaries, gdpEntries, cpiEntries] = await Promise.all([
    Promise.all(candidateYears.map(yr => loadSummary(yr).catch(() => null))),
    Promise.all(candidateYears.map(yr => loadGDP(yr).catch(() => null))),
    Promise.all(candidateYears.map(yr => loadCPI(yr).catch(() => null))),
  ]);

  // Filter to years where we actually got data.
  const records = candidateYears
    .map((yr, i) => ({ year: yr, s: summaries[i], gdp: gdpEntries[i], cpi: cpiEntries[i] }))
    .filter(r => r.s != null);

  // Read persisted real-PHP toggle preference.
  const STORAGE_KEY = 'halaga.timeline.realMode';
  let realMode = (typeof localStorage !== 'undefined'
    && localStorage.getItem(STORAGE_KEY) === '1');

  // Helper: convert a nominal PHP-thousands value to real-2018 PHP-thousands.
  // Returns the original value if real-mode is off OR no CPI for that year.
  function deflate(amount, year) {
    if (!realMode || amount == null) return amount;
    const cpi = cpiEntries[candidateYears.indexOf(year)];
    if (!cpi || cpi.deflator_to_2018 == null) return amount;
    return amount * cpi.deflator_to_2018;
  }
  function flagRealLabel() {
    return realMode ? 'real PHP, 2018 base' : 'nominal PHP';
  }
  function realSuffix() {
    return realMode ? ' (2018 PHP)' : '';
  }

  // Apply deflator to every amount on every record's summary so downstream code
  // doesn't have to thread `realMode` through. We deep-clone first to keep the
  // cache untouched.
  const recordsView = records.map(r => {
    if (!realMode || !r.cpi || r.cpi.deflator_to_2018 == null) {
      return { ...r, deflated: false };
    }
    const f = r.cpi.deflator_to_2018;
    const s2 = JSON.parse(JSON.stringify(r.s));
    s2.total_thousands = (s2.total_thousands || 0) * f;
    for (const arr of [s2.by_department, s2.by_function, s2.by_economic, s2.by_region]) {
      if (!Array.isArray(arr)) continue;
      for (const o of arr) {
        if (typeof o.amount_thousands === 'number') o.amount_thousands *= f;
      }
    }
    return { ...r, s: s2, deflated: true };
  });
  // Substitute the view-records for downstream code (charts read from `records`).
  for (let i = 0; i < records.length; i++) records[i] = recordsView[i];

  // Count years missing GDP — surfaced as a small badge on the % of GDP chart.
  const yearsMissingGDP = records
    .filter(r => !r.gdp || r.gdp.gdp_php == null)
    .map(r => r.year);

  if (!records.length) {
    root.innerHTML = `<div class="text-center py-16 text-ink-400 text-sm">No multi-year data available.</div>`;
    return;
  }

  const latest = records[records.length - 1];
  const prior  = records.length > 1 ? records[records.length - 2] : null;
  const first  = records[0];

  // --- KPI derivations ------------------------------------------------------
  const latestTotal = latest.s.total_thousands;
  const priorTotal  = prior ? prior.s.total_thousands : null;
  const growthPct   = priorTotal ? ((latestTotal - priorTotal) / priorTotal) * 100 : null;
  const growthAbs   = priorTotal ? latestTotal - priorTotal : null;

  const latestGDP   = latest.gdp ? latest.gdp.gdp_php : null;
  const latestGDPpct = pctOfGDP(latestTotal, latestGDP);

  const cagrVal = records.length >= 2
    ? cagr(first.s.total_thousands, latestTotal, records.length)
    : null;

  // --- Compute % of GDP series -----------------------------------------------
  // For OCR / NGA-only years the source total is missing the Automatic
  // Appropriations umbrella (~25-30% of the real budget). Null out so the
  // line breaks at those years instead of showing a misleading dip.
  // OCR_PATCHED_AA is excluded — that year's total reconciles after patching.
  const TOTAL_INCOMPLETE_COVERAGES = new Set(['OCR_ESTIMATE', 'UACS_REMAPPED_NGA_ONLY']);
  const gdpPctSeries = records.map(r => {
    const totalIncomplete = TOTAL_INCOMPLETE_COVERAGES.has(coverageFor(r.year));
    const totalAmt = totalIncomplete ? null : r.s.total_thousands;
    const v = pctOfGDP(totalAmt, r.gdp ? r.gdp.gdp_php : null);
    return {
      year: r.year,
      value: v,
      isEst: r.gdp ? r.gdp.is_estimate : false,
      totalIncomplete,
    };
  });
  const gdpPctValues = gdpPctSeries.map(d => d.value).filter(v => v != null);
  const gdpPctAvg = gdpPctValues.length
    ? gdpPctValues.reduce((a, b) => a + b, 0) / gdpPctValues.length
    : null;

  // --- Collect all function names across years --------------------------------
  const allFnNames = [];
  for (const r of records) {
    for (const f of (r.s.by_function || [])) {
      if (!allFnNames.includes(f.name)) allFnNames.push(f.name);
    }
  }

  // Sort function names by latest-year descending.
  const latestFnMap = Object.fromEntries(
    (latest.s.by_function || []).map(f => [f.name, f.amount_thousands])
  );
  allFnNames.sort((a, b) => (latestFnMap[b] || 0) - (latestFnMap[a] || 0));

  // Build color map: prefer color from any year's data.
  const fnColorMap = {};
  for (const r of records) {
    for (const f of (r.s.by_function || [])) {
      if (f.color && !fnColorMap[f.name]) fnColorMap[f.name] = f.color;
    }
  }
  allFnNames.forEach((name, i) => {
    if (!fnColorMap[name]) fnColorMap[name] = PHL_PALETTE[i % PHL_PALETTE.length];
  });

  // Build stacked area data: fnName -> array of values (one per year, 0 if missing).
  const fnByYear = {};
  for (const r of records) {
    const map = Object.fromEntries((r.s.by_function || []).map(f => [f.name, f.amount_thousands]));
    fnByYear[r.year] = map;
  }

  // --- Top 10 agencies (latest year) across time ----------------------------
  const top10depts = (latest.s.by_department || []).slice(0, 10);
  const top10names = top10depts.map(d => d.name);

  const deptTimeSeries = top10names.map(name => {
    return records.map(r => {
      const match = (r.s.by_department || []).find(d => d.name === name);
      return match ? match.amount_thousands : null;
    });
  });

  // NGA-only years that are excluded from this view but exist in the dashboard.
  // Used by the small subtitle under the time-range slider so a user who lands
  // on the page can see at a glance whether their range is missing anything.
  // Full per-year coverage detail lives on the About page.
  const excludedInRange = excludedForComparability.filter(y => y >= first.year && y <= latest.year);

  // -------------------------------------------------------------------------
  // Render HTML shell
  // -------------------------------------------------------------------------
  // Year-range slider — paints two native range inputs on top of each other.
  // Comparable years are pre-filtered (NGA-only years excluded). Min/max snap
  // to the available list so the user can't land on a non-comparable year.
  const yearTickHtml = comparableYears.map(y =>
    `<span class="${y >= rangeFrom && y <= rangeTo ? 'tick-on' : 'tick-off'}" data-year="${y}"
           style="cursor:pointer;font-size:10px;tabular-nums;letter-spacing:.02em;">${y}</span>`
  ).join('');

  const realToggleHTML = `
    <div class="col-span-12 mb-1" id="timeline-controls">
      <div class="card p-4 flex flex-col gap-3">
        <div class="flex items-start justify-between gap-4 flex-wrap">
          <div class="flex-1 min-w-[260px]">
            <div class="flex items-baseline gap-2 mb-1">
              <span class="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-400">Time range</span>
              <span class="text-[12px] text-ink-700 tabular-nums font-semibold" id="range-label">FY${rangeFrom}–FY${rangeTo}</span>
              <span class="text-[11px] text-ink-400" id="range-count">(${candidateYears.length} year${candidateYears.length === 1 ? '' : 's'})</span>
              <button type="button" id="range-reset-6" class="text-[11px] text-ink-500 hover:text-iris-deep underline decoration-dotted ml-1" title="Reset to last 6 years">Last 6 yrs</button>
              <button type="button" id="range-reset-all" class="text-[11px] text-ink-500 hover:text-iris-deep underline decoration-dotted" title="Show all comparable years">All</button>
            </div>
            <div class="relative" style="height:34px;" id="range-slider-track">
              <div style="position:absolute;left:0;right:0;top:14px;height:6px;background:#EFE9E0;border-radius:999px;"></div>
              <div id="range-slider-fill" style="position:absolute;top:14px;height:6px;background:#6B5BEF;border-radius:999px;"></div>
              <input type="range" id="range-from" min="${fullMin}" max="${fullMax}" step="1" value="${rangeFrom}"
                     style="position:absolute;left:0;right:0;top:6px;width:100%;-webkit-appearance:none;appearance:none;background:transparent;pointer-events:none;height:22px;" />
              <input type="range" id="range-to"   min="${fullMin}" max="${fullMax}" step="1" value="${rangeTo}"
                     style="position:absolute;left:0;right:0;top:6px;width:100%;-webkit-appearance:none;appearance:none;background:transparent;pointer-events:none;height:22px;" />
            </div>
            <div class="flex justify-between text-ink-400 mt-1" style="padding:0 2px;">
              ${yearTickHtml}
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-[11px] text-ink-400 uppercase tracking-wider font-semibold">PHP basis</span>
            <div role="group" aria-label="PHP basis toggle"
                 style="display:inline-flex;border:1px solid #EFE9E0;border-radius:999px;padding:2px;background:#ece1c3;">
              <button type="button" data-real="0" class="${!realMode ? 'real-on' : ''}"
                      style="padding:4px 12px;border-radius:999px;border:0;cursor:pointer;font-size:11px;font-weight:600;
                      background:${!realMode ? '#e25034' : 'transparent'};color:${!realMode ? '#FFF' : '#7a6a4c'};">
                Nominal
              </button>
              <button type="button" data-real="1" class="${realMode ? 'real-on' : ''}"
                      style="padding:4px 12px;border-radius:999px;border:0;cursor:pointer;font-size:11px;font-weight:600;
                      background:${realMode ? '#e25034' : 'transparent'};color:${realMode ? '#FFF' : '#7a6a4c'};">
                Real (2018)
              </button>
            </div>
          </div>
        </div>
        <div class="text-[11px] text-ink-400">
          Showing <span class="font-semibold" style="color:${realMode ? '#e25034' : '#1a1a1a'};">${flagRealLabel()}</span>
          across FY${first.year}–FY${latest.year}${excludedInRange.length ? ` · ${excludedInRange.length} year(s) excluded for comparability` : ''}${yearsMissingGDP.length ? ` · ${yearsMissingGDP.length} year(s) pending GDP data (${yearsMissingGDP.join(', ')})` : ''}
        </div>
      </div>
    </div>`;
  root.innerHTML = `
    <div class="grid grid-cols-12 gap-5">

      ${realToggleHTML}

      <!-- Composition % of GDP multi-line — headline chart, tallest -->
      <div class="col-span-12 lg:col-span-7 card p-6">
        <div id="hdr-comp-gdp" class="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <div class="section-kicker">Composition</div>
            <div class="section-title">Composition as % of GDP</div>
            <div class="text-xs text-ink-400 mt-0.5">
              <abbr data-term="GAA" class="cursor-help underline decoration-dotted">GAA</abbr> · Wages · Capital outlays · <abbr data-term="Debt Service" class="cursor-help underline decoration-dotted">Debt service</abbr> · <abbr data-term="Transfers to LGUs" class="cursor-help underline decoration-dotted">Transfers to LGUs</abbr> · FY${first.year}–FY${latest.year}
            </div>
          </div>
          <div class="flex flex-wrap gap-1.5" id="comp-legend"></div>
        </div>
        <div id="chart-comp-gdp" class="chart chart-lg" role="img" aria-label="Composition as percent of GDP, multi-year line chart"></div>
        ${records.some(r => r.gdp && r.gdp.is_estimate)
          ? `<div class="text-[11px] text-ink-400 mt-2">GDP source: World Bank Open Data API (NY.GDP.MKTP.CN) for FY2009–FY2024 actuals; for ${records.filter(r => r.gdp && r.gdp.is_estimate).map(r => 'FY' + r.year).join(' & ')}, the IMF WEO April 2026 nominal projection (consistent with the WB Philippines Economic Update Dec 2025 "Growth Corridors" real growth path of 5.1% / 5.3% and Q4 2025 PSA actuals showing 4.4% real growth). Hollow markers flag projected years; values will be revised once PSA publishes the full-year nominal series.</div>`
          : ''}
      </div>

      <!-- % of GDP trend — companion panel, standard height -->
      <div class="col-span-12 lg:col-span-5 card p-6">
        <div id="hdr-gdp-pct" class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <div class="section-kicker">Trend</div>
            <div class="section-title">Budget as % of GDP</div>
            <div class="text-xs text-ink-400 mt-0.5">Fiscal size of the national budget</div>
          </div>
          ${gdpPctAvg != null
            ? `<span class="pill">Avg: ${gdpPctAvg.toFixed(1)}%</span>`
            : ''}
        </div>
        <div id="chart-gdp-pct" class="chart" role="img" aria-label="Budget as percent of GDP trend, multi-year line chart"></div>
      </div>

      <!-- Functional stacked-bar (% of total) — editorial break above -->
      <div class="col-span-12 card p-6 mt-4">
        <div id="hdr-fn-area" class="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <div class="section-kicker">Functional</div>
            <div class="section-title">Functional breakdown over time</div>
            <div class="text-xs text-ink-400 mt-0.5">
              Each bar = 100% · share of total budget by sector · FY${first.year}–FY${latest.year} · <span class="text-ink-500">hover a function in the legend below to see what's in it</span>
              ${first.year <= 2021 && latest.year >= 2022
                ? ` · <span class="font-medium text-ink-500">Note:</span> The 2022 Mandanas-Garcia ruling expanded the <abbr data-term="NTA" class="cursor-help underline decoration-dotted">NTA</abbr> base, replacing the pre-2022 <abbr data-term="IRA" class="cursor-help underline decoration-dotted">IRA</abbr>; the FY2022 bar reflects the enlarged transfer floor`
                : ''}
            </div>
          </div>
          <span class="pill">${allFnNames.length} functions</span>
        </div>
        <div id="chart-fn-area" class="chart chart-lg" role="img" aria-label="Functional breakdown over time, stacked area chart"></div>
        <div class="mt-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2" id="fn-legend"></div>
        <div class="mt-3 text-[11px] text-ink-400">
          Download buttons in the card header above export the raw per-year amounts (CSV) or the chart image (PNG).
        </div>
      </div>

      <!-- Top 10 agencies multi-line — editorial break above -->
      <div class="col-span-12 card p-6 mt-4">
        <div id="hdr-agency-time" class="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <div class="section-kicker">Agencies</div>
            <div class="section-title">Top 10 agencies over time</div>
            <div class="text-xs text-ink-400 mt-0.5">
              Based on FY${latest.year} ranking · hover to identify · null = agency not present or renamed
            </div>
          </div>
          <span class="pill pill-blue">FY${latest.year} top ${top10names.length}</span>
        </div>
        <div id="chart-agency-time" class="chart chart-lg" role="img" aria-label="Top 10 agencies over time, multi-line chart"></div>
        <div class="mt-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2" id="agency-legend"></div>
      </div>

    </div>
  `;

  // Job 4: activate inline gloss tooltips for all data-term elements.
  mountGloss(root);

  // Wire the real-PHP toggle: persist to localStorage and re-render.
  const ctrls = root.querySelector('#timeline-controls');
  if (ctrls) {
    ctrls.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-real]');
      if (!btn) return;
      const want = btn.dataset.real === '1';
      if (want === realMode) return;
      try { localStorage.setItem(STORAGE_KEY, want ? '1' : '0'); } catch {}
      renderTimeline(root);  // self-rerender; cheap (data already cached)
    });
  }

  // Wire the year-range slider — commit on `change` (release) so dragging
  // doesn't trigger a full re-render every pixel.
  function commitRange(newFrom, newTo) {
    if (newFrom > newTo) { [newFrom, newTo] = [newTo, newFrom]; }
    // Snap to available comparable years.
    const snapFrom = comparableYears.find(y => y >= newFrom) ?? fullMin;
    const snapTo   = [...comparableYears].reverse().find(y => y <= newTo) ?? fullMax;
    if (snapFrom === rangeFrom && snapTo === rangeTo) return;
    try { localStorage.setItem(RANGE_KEY, JSON.stringify({ from: snapFrom, to: snapTo })); } catch {}
    renderTimeline(root);
  }
  const inFrom = root.querySelector('#range-from');
  const inTo   = root.querySelector('#range-to');
  const fillEl = root.querySelector('#range-slider-fill');
  const labelEl = root.querySelector('#range-label');
  function updateFillAndLabel() {
    const a = Math.min(Number(inFrom.value), Number(inTo.value));
    const b = Math.max(Number(inFrom.value), Number(inTo.value));
    const span = (fullMax - fullMin) || 1;
    const left  = ((a - fullMin) / span) * 100;
    const right = ((b - fullMin) / span) * 100;
    if (fillEl) {
      fillEl.style.left  = left  + '%';
      fillEl.style.width = (right - left) + '%';
    }
    if (labelEl) labelEl.textContent = `FY${a}–FY${b}`;
  }
  if (inFrom && inTo) {
    inFrom.addEventListener('input', updateFillAndLabel);
    inTo.addEventListener('input', updateFillAndLabel);
    inFrom.addEventListener('change', () => commitRange(Number(inFrom.value), Number(inTo.value)));
    inTo.addEventListener('change',   () => commitRange(Number(inFrom.value), Number(inTo.value)));
    updateFillAndLabel();
  }
  const reset6 = root.querySelector('#range-reset-6');
  if (reset6) reset6.addEventListener('click', () => commitRange(fullMax - 5, fullMax));
  const resetAll = root.querySelector('#range-reset-all');
  if (resetAll) resetAll.addEventListener('click', () => commitRange(fullMin, fullMax));
  // Click a year tick to set whichever bound is closer.
  const trackEl = root.querySelector('#range-slider-track');
  if (trackEl) {
    root.querySelectorAll('[data-year]').forEach(tick => {
      tick.addEventListener('click', () => {
        const y = Number(tick.dataset.year);
        if (Math.abs(y - rangeFrom) <= Math.abs(y - rangeTo)) commitRange(y, rangeTo);
        else commitRange(rangeFrom, y);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Chart: Composition as % of GDP — wages, capex, debt service, transfers
  // -------------------------------------------------------------------------
  const COMP_SERIES = [
    { key: 'wages',        label: 'Wages & Personnel',  color: '#1d3da8' },
    { key: 'capital',      label: 'Capital Outlays',    color: '#e8b94a' },
    { key: 'debt_service', label: 'Debt Service',       color: '#475569' },
    { key: 'transfers_lgu',label: 'Transfers to LGUs',  color: '#3a5a3a' },
  ];

  // Coverage tiers where the source data does NOT include the Automatic
  // Appropriations umbrella — debt-service interest and transfers to LGUs
  // (NTA/IRA) live there. For those years, the corresponding composition
  // points must be null (chart skips), not zero — otherwise the % of GDP
  // line falsely drops to 0%.
  // OCR_PATCHED_AA (FY2019) is intentionally NOT in this set — that year's AA
  // was reconstructed from the GAA Vol I-B Annex + BESF B.1 and reconciles to
  // the published GAA, so debt-service / transfers-to-LGU points are real.
  const AA_MISSING_COVERAGES = new Set(['OCR_ESTIMATE', 'UACS_REMAPPED_NGA_ONLY']);
  const AA_DERIVED_KEYS = new Set(['debt_service', 'transfers_lgu']);

  // Per-series array of {value, isEst, missing} per year; null value when
  // GDP missing, headline missing, or coverage doesn't include AA.
  const compSeriesData = COMP_SERIES.map(meta => {
    return records.map(r => {
      const cv = coverageFor(r.year);
      const aaMissing = AA_DERIVED_KEYS.has(meta.key) && AA_MISSING_COVERAGES.has(cv);
      const headline = aaMissing ? null : (r.s.headlines || {})[meta.key];
      const gdp_php = r.gdp ? r.gdp.gdp_php : null;
      const v = pctOfGDP(headline, gdp_php);
      return {
        value: v,
        isEst: r.gdp ? r.gdp.is_estimate : false,
        aaMissing,
      };
    });
  });

  // Each chip wraps the label in a data-term span so hovering shows the GLOSS
  // description (esp. relevant for Transfers to LGUs and Debt Service whose
  // scope is non-obvious). mountGloss is called once below.
  document.getElementById('comp-legend').innerHTML = COMP_SERIES.map(m => `
    <span class="inline-flex items-center gap-1.5 text-[11px] text-ink-600 px-2 py-0.5 rounded-full" style="background:#F4F4EE">
      <span class="w-2.5 h-2.5 rounded-full" style="background:${m.color}"></span>
      <span class="cursor-help underline decoration-dotted decoration-ink-300" data-term="${m.label}">${m.label}</span>
    </span>`).join('');
  mountGloss(document.getElementById('comp-legend'));

  const cComp = createChart(document.getElementById('chart-comp-gdp'));
  cComp.setOption({
    grid: { left: 55, right: 20, top: 20, bottom: 30 },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', crossStyle: { color: '#7a6a4c' } },
      formatter: (params) => {
        const yr = params[0] ? params[0].axisValue : '';
        const rec = records.find(r => String(r.year) === String(yr));
        const est = rec && rec.gdp && rec.gdp.is_estimate ? ' *' : '';
        let html = `<div style="font-size:12px;font-weight:700;margin-bottom:4px">FY${yr}${est}</div>`;
        const visible = params.filter(p => p.value != null).sort((a, b) => b.value - a.value);
        for (const p of visible) {
          html += `<div style="font-size:11px;display:flex;align-items:center;gap:6px;margin-top:2px">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>
            <span style="flex:1;color:#2a241c">${escapeHtml(p.seriesName)}</span>
            <span style="font-weight:600;tabular-nums;margin-left:8px">${p.value.toFixed(2)}%</span>
          </div>`;
        }
        // Missing-data footnote when the AA umbrella isn't in the source for this year.
        const idx = params[0] ? params[0].dataIndex : -1;
        const missingHere = idx >= 0
          ? COMP_SERIES.filter((_, i) => compSeriesData[i][idx] && compSeriesData[i][idx].aaMissing).map(m => m.label)
          : [];
        if (missingHere.length) {
          html += `<div style="font-size:10.5px;color:#6b5e48;margin-top:6px;max-width:240px;line-height:1.4;border-top:1px solid #EFE9E0;padding-top:4px">
            Not shown for FY${yr}: ${missingHere.join(', ')} — the source file for this year doesn't include automatic appropriations (debt-service interest, NTA/IRA transfers).
          </div>`;
        }
        return html;
      },
    },
    xAxis: {
      type: 'category',
      data: records.map(r => String(r.year)),
      axisLabel: { color: '#7a6a4c', fontSize: 11 },
      axisLine: { lineStyle: { color: '#c8b988' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: v => v.toFixed(1) + '%', color: '#7a6a4c', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e6d8b3' } },
    },
    series: COMP_SERIES.map((meta, idx) => ({
      name: meta.label,
      type: 'line',
      data: compSeriesData[idx].map(d => d.value),
      lineStyle: { color: meta.color, width: 2.5 },
      itemStyle: {
        color: (p) => compSeriesData[idx][p.dataIndex].isEst ? '#ece1c3' : meta.color,
        borderColor: meta.color,
        borderWidth: 2,
      },
      symbol: 'circle',
      symbolSize: 8,
      smooth: false,
      connectNulls: false,
      emphasis: { focus: 'series', lineStyle: { width: 4 } },
    })),
  });

  // Export affordances — composition % of GDP (PNG headline, CSV with year + one col per series).
  mountChartActions(document.getElementById('hdr-comp-gdp'), {
    getRows: () => records.map((r, i) => {
      const row = { year: r.year };
      COMP_SERIES.forEach((meta, idx) => { row[meta.key] = compSeriesData[idx][i].value; });
      return row;
    }),
    columns: ['year', ...COMP_SERIES.map(m => m.key)],
    csvName:  `timeline-pct-of-gdp-fy${first.year}-fy${latest.year}`,
    chart:    cComp,
    pngName:  `timeline-pct-of-gdp-fy${first.year}-fy${latest.year}`,
    pngTitle:    `Composition as % of GDP`,
    pngSubtitle: `GAA components scaled to nominal GDP · FY${first.year}–FY${latest.year}`,
    pngLegend: COMP_SERIES.map(m => ({ label: m.label, color: m.color })),
  });

  // -------------------------------------------------------------------------
  // Chart: % of GDP trend (single line + dashed average)
  // -------------------------------------------------------------------------
  const cGDP = createChart(document.getElementById('chart-gdp-pct'));
  const gdpPctOption = {
    grid: { left: 55, right: 20, top: 30, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const p = params[0];
        if (!p) return '';
        const yr = p.axisValue;
        const rec = records.find(r => String(r.year) === String(yr));
        const idx = p.dataIndex;
        const ds = idx >= 0 ? gdpPctSeries[idx] : null;
        // Coverage-gap years (OCR / NGA-only) get a tooltip explanation rather than a dropped point.
        if (ds && ds.totalIncomplete) {
          return `<div style="font-size:12px;font-weight:700;margin-bottom:2px">FY${yr}</div>
                  <div style="font-size:11px;color:#6b5e48;max-width:240px;line-height:1.4">Not shown — the source for FY${yr} is missing automatic appropriations (debt-service interest, transfers to LGUs), so the total is partial. See the About page for coverage details.</div>`;
        }
        if (p.value == null) return '';
        const est = rec && rec.gdp && rec.gdp.is_estimate ? ' (est.)' : '';
        return `<div style="font-size:12px;font-weight:700;margin-bottom:2px">FY${yr}</div>
                <div style="font-size:13px"><strong>${p.value.toFixed(2)}%</strong> of GDP${est}</div>`;
      },
    },
    xAxis: {
      type: 'category',
      data: records.map(r => String(r.year)),
      axisLabel: { color: '#7a6a4c', fontSize: 11 },
      axisLine: { lineStyle: { color: '#c8b988' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: v => v.toFixed(1) + '%', color: '#7a6a4c', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e6d8b3' } },
      min: v => Math.max(0, Math.floor(v.min - 1)),
    },
    series: [
      // dashed average line (markLine)
      {
        name: '% of GDP',
        type: 'line',
        data: gdpPctSeries.map(d => d.value),
        lineStyle: { color: '#1d3da8', width: 3 },
        itemStyle: {
          color: (p) => gdpPctSeries[p.dataIndex] && gdpPctSeries[p.dataIndex].isEst
            ? '#ece1c3' : '#1d3da8',
          borderColor: (p) => gdpPctSeries[p.dataIndex] && gdpPctSeries[p.dataIndex].isEst
            ? '#e8b94a' : '#1d3da8',
          borderWidth: (p) => gdpPctSeries[p.dataIndex] && gdpPctSeries[p.dataIndex].isEst
            ? 2.5 : 2,
        },
        symbol: 'circle',
        symbolSize: 9,
        smooth: false,
        markLine: gdpPctAvg != null ? {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: gdpPctAvg }],
          lineStyle: { type: 'dashed', color: '#e25034', width: 1.5 },
          label: {
            formatter: () => 'Avg ' + gdpPctAvg.toFixed(1) + '%',
            color: '#e25034', fontSize: 11, fontWeight: 600,
            position: 'insideEndTop',
          },
        } : undefined,
      },
    ],
  };
  cGDP.setOption(gdpPctOption);

  // Export affordances — budget as % of GDP trend.
  mountChartActions(document.getElementById('hdr-gdp-pct'), {
    getRows: () => gdpPctSeries.map(d => ({ year: d.year, pct_of_gdp: d.value, is_estimate: d.isEst })),
    columns: ['year', 'pct_of_gdp', 'is_estimate'],
    csvName:  `timeline-budget-pct-gdp-fy${first.year}-fy${latest.year}`,
    chart:    cGDP,
    pngName:  `timeline-budget-pct-gdp-fy${first.year}-fy${latest.year}`,
    pngTitle:    `Budget as % of GDP`,
    pngSubtitle: `Fiscal size of the national budget · FY${first.year}–FY${latest.year}${gdpPctAvg != null ? ` · period avg ${gdpPctAvg.toFixed(1)}%` : ''}`,
    pngLegend: [
      { label: '% of GDP', color: '#e25034' },
      ...(gdpPctAvg != null ? [{ label: `Average (${gdpPctAvg.toFixed(1)}%)`, color: '#7a6a4c' }] : []),
    ],
  });

  // -------------------------------------------------------------------------
  // Chart: Functional breakdown — 100% stacked bar (share of total per year)
  // -------------------------------------------------------------------------
  const cFnArea = createChart(document.getElementById('chart-fn-area'));

  // Per-year totals (sum of all functions present, per year). Used to convert
  // each function's amount to a share-of-total percentage.
  const yearTotals = records.map(r =>
    (r.s.by_function || []).reduce((a, f) => a + (f.amount_thousands || 0), 0)
  );

  // For each function name, build an array of per-year percentage shares.
  const fnPctSeries = allFnNames.map(name => ({
    name,
    type: 'bar',
    stack: 'pct',
    barWidth: '52%',
    itemStyle: { color: fnColorMap[name] },
    emphasis: { focus: 'series' },
    data: records.map((r, i) => {
      const amt = (fnByYear[r.year] && fnByYear[r.year][name]) || 0;
      const tot = yearTotals[i] || 0;
      return tot ? (100 * amt / tot) : 0;
    }),
  }));

  cFnArea.setOption({
    grid: { left: 50, right: 20, top: 20, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        // xAxis labels are 'FY2021' etc., but records[].year is a number.
        // Use dataIndex to look up the right record/total directly.
        const idx = params[0] ? params[0].dataIndex : -1;
        const rec = idx >= 0 ? records[idx] : null;
        const tot = idx >= 0 ? yearTotals[idx] : 0;
        const yrLabel = rec ? 'FY' + rec.year : '';
        let html = `<div style="font-size:12px;font-weight:700;margin-bottom:4px">${yrLabel}: ${fmtPHP(tot)}</div>`;
        const sorted = params.slice().sort((a, b) => (b.value || 0) - (a.value || 0));
        for (const p of sorted) {
          if (!p.value) continue;
          const amtAbs = (p.value / 100) * tot;
          html += `<div style="font-size:11px;display:flex;align-items:center;gap:6px;margin-top:2px">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>
            <span style="flex:1;color:#2a241c">${escapeHtml(p.seriesName)}</span>
            <span style="font-weight:600;tabular-nums;margin-left:8px">${p.value.toFixed(1)}%</span>
            <span style="color:#6b5e48;margin-left:4px">${fmtPHP(amtAbs)}</span>
          </div>`;
        }
        return html;
      },
    },
    legend: { show: false },
    xAxis: {
      type: 'category',
      data: records.map(r => 'FY' + r.year),
      axisLabel: { color: '#1a1611', fontSize: 12, fontWeight: 500 },
      axisLine: { lineStyle: { color: '#c8b988' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      max: 100,
      axisLabel: { formatter: v => v + '%', color: '#7a6a4c', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e6d8b3' } },
    },
    series: fnPctSeries,
  });

  // Export affordances — functional breakdown. CSV emits nominal PHP per
  // function per year (matches the per-year amounts table). The chart itself
  // shows % of total, but raw amounts are the more useful download.
  mountChartActions(document.getElementById('hdr-fn-area'), {
    getRows: () => records.map((r) => {
      const row = { year: r.year };
      allFnNames.forEach(name => {
        row[name] = (fnByYear[r.year] && fnByYear[r.year][name]) || null;
      });
      return row;
    }),
    columns: ['year', ...allFnNames],
    csvName:  `timeline-functional-amounts-fy${first.year}-fy${latest.year}`,
    chart:    cFnArea,
    pngName:  `timeline-functional-split-fy${first.year}-fy${latest.year}`,
    pngTitle:    `Functional breakdown over time`,
    pngSubtitle: `Each bar = 100% · share of total budget by sector · FY${first.year}–FY${latest.year}`,
    pngLegend: allFnNames.map(name => ({ label: name, color: fnColorMap[name] })),
  });

  // Functional legend below the chart. Each chip wraps the function name in a
  // data-term span so hovering surfaces the GLOSS description (what falls under
  // each function). mountGloss is called once after innerHTML to wire tooltips.
  document.getElementById('fn-legend').innerHTML = allFnNames.map(name => `
    <div class="flex items-center gap-2 text-xs min-w-0">
      <span class="w-2.5 h-2.5 rounded shrink-0" style="background:${fnColorMap[name]};display:inline-block"></span>
      <span class="truncate text-ink-600 cursor-help underline decoration-dotted decoration-ink-400" data-term="${escapeHtml(name)}">${escapeHtml(name)}</span>
    </div>
  `).join('');
  mountGloss(document.getElementById('fn-legend'));

  // -------------------------------------------------------------------------
  // Chart: Top 10 agencies multi-line
  // -------------------------------------------------------------------------
  const cAgency = createChart(document.getElementById('chart-agency-time'));
  const agencySeries = top10names.map((name, i) => ({
    name,
    type: 'line',
    data: deptTimeSeries[i].map(v => v),   // nulls pass through; ECharts skips them
    lineStyle: { color: PHL_PALETTE[i % PHL_PALETTE.length], width: 2.5 },
    itemStyle: { color: PHL_PALETTE[i % PHL_PALETTE.length], borderColor: '#fff', borderWidth: 2 },
    symbol: 'circle',
    symbolSize: 7,
    connectNulls: false,
    emphasis: { focus: 'series', lineStyle: { width: 4 } },
  }));

  cAgency.setOption({
    grid: { left: 80, right: 20, top: 20, bottom: 40 },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const yr = params[0] ? params[0].axisValue : '';
        const visible = params.filter(p => p.value != null).sort((a, b) => b.value - a.value);
        let html = `<div style="font-size:12px;font-weight:700;margin-bottom:4px">FY${yr}</div>`;
        for (const p of visible) {
          html += `<div style="font-size:11px;display:flex;align-items:center;gap:6px;margin-top:2px">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>
            <span style="flex:1;color:#2a241c">${escapeHtml(shortDept(p.seriesName))}</span>
            <span style="font-weight:600;tabular-nums;margin-left:8px">${fmtPHP(p.value)}</span>
          </div>`;
        }
        return html;
      },
    },
    xAxis: {
      type: 'category',
      data: records.map(r => String(r.year)),
      axisLabel: { color: '#7a6a4c', fontSize: 11 },
      axisLine: { lineStyle: { color: '#c8b988' } },
      axisTick: { show: false },
      boundaryGap: false,
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: v => fmtPHP(v, { decimals: 0 }), color: '#7a6a4c', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e6d8b3' } },
    },
    series: agencySeries,
  });

  // Export affordances — top 10 agencies multi-line.
  mountChartActions(document.getElementById('hdr-agency-time'), {
    getRows: () => records.map((r, i) => {
      const row = { year: r.year };
      top10names.forEach((name, j) => { row[shortDept(name)] = deptTimeSeries[j][i]; });
      return row;
    }),
    columns: ['year', ...top10names.map(n => shortDept(n))],
    csvName:  `timeline-top-agencies-fy${first.year}-fy${latest.year}`,
    chart:    cAgency,
    pngName:  `timeline-top-agencies-fy${first.year}-fy${latest.year}`,
    pngTitle:    `Top 10 agencies over time`,
    pngSubtitle: `Based on FY${latest.year} ranking · null = agency not present or renamed · FY${first.year}–FY${latest.year}`,
    pngLegend: top10names.map((n, i) => ({ label: shortDept(n), color: PHL_PALETTE[i % PHL_PALETTE.length] })),
  });

  // Agency legend (below chart)
  document.getElementById('agency-legend').innerHTML = top10names.map((name, i) => `
    <div class="flex items-center gap-2 text-xs min-w-0">
      <span class="w-3 h-0.5 rounded shrink-0" style="background:${PHL_PALETTE[i % PHL_PALETTE.length]};display:inline-block"></span>
      <span class="truncate text-ink-600" title="${escapeHtml(name)}">${escapeHtml(shortDept(name))}</span>
    </div>
  `).join('');

  // -------------------------------------------------------------------------
  // Resize handling — consolidated via shared observeChartResize helper.
  // Catches first-paint layout settle (Tailwind CDN finishing) so charts size
  // to their real container width instead of overflowing at full body width.
  // -------------------------------------------------------------------------
  observeChartResize(document.getElementById('chart-comp-gdp'),    cComp);
  observeChartResize(document.getElementById('chart-gdp-pct'),     cGDP);
  observeChartResize(document.getElementById('chart-fn-area'),     cFnArea);
  observeChartResize(document.getElementById('chart-agency-time'), cAgency);
}
