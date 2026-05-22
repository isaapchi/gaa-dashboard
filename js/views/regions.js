import {
  loadSummary, loadRegions, sql, fmtPHP, fmtInt, fmtPct, PHL_PALETTE,
  EXP_CLASS_COLORS, mountChartActions, mountGloss, observeChartResize,
  getCurrentYear, createChart, emptyState,
  REGION_NORMALIZE_SQL, REGION_NAME_OVERRIDES,
} from '../data.js';

const CENTRAL_CODE = '13';
const NATIONWIDE_COLOR = '#7a6a4c';
const REGION_COLOR = '#1d3da8';

// Maps expense class full names to GLOSS keys for inline glossing
const EXP_CLASS_TERM = {
  'Personnel Services':                          'PS',
  'Maintenance and Other Operating Expenses':    'MOOE',
  'Capital Outlays':                             'CO',
  'Financial Expenses':                          'FE',
};

export async function renderRegions(root) {
  const s = await loadSummary();
  const allDepts = (s.by_department || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  root.innerHTML = `
    <div class="grid grid-cols-12 gap-5">

      <!-- Coverage banner — appears for years where the parquet has no real
           per-region detail (currently FY2014, OCR-reconstructed). -->
      <div id="region-coverage-banner" class="col-span-12" style="display:none"></div>

      <!-- KPI cards -->
      <div id="kpi-strip" class="col-span-12 grid grid-cols-2 lg:grid-cols-3 gap-5"></div>

      <!-- Filter row -->
      <div class="col-span-12 flex flex-wrap items-center gap-3">
        <span class="text-xs text-ink-400 uppercase tracking-wider font-semibold">Filter</span>
        <select id="filter-dept" class="select" style="max-width:320px">
          <option value="">All allocators</option>
          ${allDepts.map(d => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join('')}
        </select>
        <select id="filter-agency" class="select" style="max-width:320px">
          <option value="">All agencies</option>
        </select>
      </div>

      <!-- Map placeholder -->
      <div class="col-span-12 lg:col-span-7 card p-6" style="position:relative">
        <div class="flex items-center justify-between mb-3" id="map-header">
          <div>
            <div class="section-kicker">Geography</div>
            <div class="section-title" id="map-title">Regional map</div>
            <div class="text-xs text-ink-400 mt-0.5" id="map-sub">Allocations by administrative region</div>
          </div>
          <span class="pill pill-blue">Sequential blue scale</span>
        </div>
        <div id="chart-map" class="chart chart-lg flex items-center justify-center text-center text-xs text-ink-400"
             role="img" aria-label="Regional allocations map">
          Map pending Philippines GeoJSON. Drop site/data/ph_regions.geojson and refresh.
        </div>
        <!-- Zoom controls injected by JS after map init -->
      </div>

      <!-- Ranked bar chart -->
      <div class="col-span-12 lg:col-span-5 card p-6">
        <div class="flex items-center justify-between mb-3" id="bar-header">
          <div>
            <div class="section-kicker">Ranked</div>
            <div class="section-title">Ranked by allocation</div>
            <div class="text-xs text-ink-400 mt-0.5">Click a bar to drill into the region</div>
          </div>
        </div>
        <div id="chart-region-bar" class="chart chart-lg" role="img" aria-label="Regional allocations ranked, bar chart"></div>
      </div>

      <!-- Region detail -->
      <div class="col-span-12 card p-6 mt-2">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <div class="section-kicker">Detail</div>
            <div class="section-title" id="detail-title">Region detail</div>
            <div class="text-xs text-ink-400 mt-0.5" id="detail-sub"></div>
          </div>
          <select id="region-select" class="select" style="max-width:280px"></select>
        </div>
        <div class="grid grid-cols-12 gap-5">
          <div class="col-span-12 lg:col-span-7">
            <div class="section-kicker mb-2" id="detail-dept-label">Top 10 departments</div>
            <div id="chart-region-dept" class="chart" role="img" aria-label="Top departments for selected region, bar chart"></div>
          </div>
          <div class="col-span-12 lg:col-span-5">
            <div class="section-kicker mb-2">Breakdown</div>
            <div id="chart-region-exp" class="chart" role="img" aria-label="Expense class breakdown for selected region, donut chart"></div>
            <div class="mt-3 space-y-1.5" id="region-exp-legend"></div>
          </div>
        </div>
      </div>

    </div>
  `;
  mountGloss(root);

  // --- chart instances (long-lived) ----------------------------------------
  const cBar  = createChart(document.getElementById('chart-region-bar'));
  const cDept = createChart(document.getElementById('chart-region-dept'));
  const cExp  = createChart(document.getElementById('chart-region-exp'));
  let cMap = null;

  // --- filter state ---------------------------------------------------------
  let activeDept   = null; // null = "All"
  let activeAgency = null; // null = "All"

  // --- agency dropdown ------------------------------------------------------
  const filterDeptSel   = document.getElementById('filter-dept');
  const filterAgencySel = document.getElementById('filter-agency');

  filterDeptSel.addEventListener('change', async () => {
    activeDept   = filterDeptSel.value || null;
    activeAgency = null;
    filterAgencySel.innerHTML = '<option value="">All agencies</option>';
    if (activeDept) {
      const rows = await sql(
        `SELECT DISTINCT agency FROM budget WHERE department = ? AND agency IS NOT NULL ORDER BY agency`,
        [activeDept]
      );
      rows.forEach(row => {
        const opt = document.createElement('option');
        opt.value = row.agency;
        opt.textContent = row.agency;
        filterAgencySel.appendChild(opt);
      });
    }
    await renderForFilter({ department: activeDept, agency: null });
  });

  filterAgencySel.addEventListener('change', async () => {
    activeAgency = filterAgencySel.value || null;
    await renderForFilter({ department: activeDept, agency: activeAgency });
  });

  // =========================================================================
  // Coverage banner — shown when the underlying parquet has no real per-region
  // breakdown (currently FY2014 OCR reconstruction stopped at the department
  // level; everything sits under Central / Unclassified).
  // =========================================================================
  function renderCoverageBanner(nGeographicRegions) {
    const el = document.getElementById('region-coverage-banner');
    if (!el) return;
    const yr = getCurrentYear();
    if (nGeographicRegions >= 5) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    el.innerHTML = `
      <div class="card p-5" style="border:1.5px solid var(--scarlet); background:transparent;">
        <div class="flex items-start gap-3">
          <span class="w-2 h-2 rounded-full mt-2 shrink-0" style="background: var(--scarlet);"></span>
          <div class="flex-1">
            <div class="section-kicker" style="color: var(--scarlet);">Limited regional detail</div>
            <div class="font-display font-bold text-[17px] tracking-[-0.01em] mb-1">FY${yr} does not have per-region budget data in the source.</div>
            <div class="text-[13px] text-ink-700 leading-[1.55]">
              This year was reconstructed from DBM's scanned <em>Summary of New Appropriations</em> annex, which lists department-level totals only. The regional split (per-province / per-LGU allocations) lives in the per-department PDFs and has not been transcribed yet. The ranked bar and map below will be sparse or empty — switch to FY2015 or later for full regional detail.
            </div>
          </div>
        </div>
      </div>`;
  }

  // =========================================================================
  // Central render function
  // =========================================================================
  async function renderForFilter({ department, agency }) {
    // Build conditional WHERE params
    const conditions = ['region_code IS NOT NULL'];
    const params = [];
    if (department) { conditions.push('department = ?'); params.push(department); }
    if (agency)     { conditions.push('agency = ?');     params.push(agency); }
    const whereClause = conditions.join(' AND ');

    // --- Fetch region aggregates for this filter --------------------------
    // Normalise pre-UACS region_code values via REGION_NORMALIZE_SQL so
    // FY2009–FY2013 rows that carry full region names instead of 2-digit
    // codes get folded into the right canonical bucket — otherwise the
    // ranked bar shows e.g. NCR and "National Capital Region" as two
    // separate rows ("mushed" appearance reported on FY2011 / FY2013).
    const regionRows = await sql(
      `SELECT code, SUM(amount_thousands) AS amount_thousands
       FROM (
         SELECT ${REGION_NORMALIZE_SQL} AS code, amount_thousands
         FROM budget
         WHERE ${whereClause}
       )
       GROUP BY code
       ORDER BY amount_thousands DESC`,
      params
    );

    // Merge a display name onto each row using the regions.json lookup,
    // with overrides for synthetic codes the normaliser may emit
    // (DFA, LUZ, VIS, MIN, UNK).
    const reg = await loadRegions();
    const codeToName     = (reg && reg.uacs_to_name)          || {};
    const codeToGeoName  = (reg && reg.uacs_to_geojson_name)  || {};
    regionRows.forEach(r => {
      r.name = REGION_NAME_OVERRIDES[r.code] || codeToName[r.code] || `Region ${r.code}`;
      r.geojson_name = codeToGeoName[r.code] || r.name;
    });

    const regions     = regionRows;
    const central     = regions.find(r => r.code === CENTRAL_CODE);
    const centralAmt  = central ? central.amount_thousands : 0;
    const totalAmt    = regions.reduce((a, x) => a + x.amount_thousands, 0);
    const regionalAmt = totalAmt - centralAmt;
    // Only treat canonical regional buckets as "geographic" for map + default
    // drill-down. UNK / DFA / LUZ / VIS / MIN appear in the ranked bar (so
    // the user can see they exist) but are excluded from the geo map and
    // from the auto-selected default region.
    const CANONICAL_REGIONAL_CODES = new Set(['00','01','02','03','04','05','06','07','08','09','10','11','12','14','15','16','17','18','19']);
    const geographic  = regions.filter(r => CANONICAL_REGIONAL_CODES.has(r.code));
    const defaultRegion = geographic.length ? geographic[0] : (regions.find(r => r.code !== CENTRAL_CODE) || regions[0]);

    // Coverage banner — flagged when the year is missing real regional
    // detail (e.g. FY2014 OCR reconstruction stopped at department level).
    // We detect by checking how many canonical regional codes survived the
    // aggregation. < 5 = effectively no regional breakdown.
    renderCoverageBanner(geographic.length);

    // --- KPI strip --------------------------------------------------------
    document.getElementById('kpi-strip').innerHTML = `
      ${kpiCard('Regionally Allocated', fmtPHP(regionalAmt), `${geographic.length} regions`, '#e25034', 'ok')}
      ${kpiCard('Central Office', fmtPHP(centralAmt), 'Head office / nationwide', '#7a6a4c', 'ok')}
      ${kpiCard('Central Share', fmtPct(centralAmt, totalAmt, 1), 'Of total budget', '#FF6B6B', 'ok')}
    `;

    // --- Map title --------------------------------------------------------
    let mapTitleText = 'Regional map';
    let mapSubText   = 'Allocations by administrative region';
    if (department && agency) {
      mapSubText = `Regional allocations · ${department} · ${agency}`;
    } else if (department) {
      mapSubText = `Regional allocations · ${department}`;
    }
    document.getElementById('map-title').textContent = mapTitleText;
    document.getElementById('map-sub').textContent   = mapSubText;

    // --- Ranked bar -------------------------------------------------------
    cBar.setOption({
      grid: { left: 140, right: 30, top: 10, bottom: 10, containLabel: false },
      xAxis: {
        type: 'value',
        axisLabel: { formatter: v => fmtPHP(v, { decimals: 0 }), color: '#7a6a4c', fontSize: 11 },
        splitLine: { lineStyle: { color: '#e6d8b3' } },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: regions.map(r => shortRegion(r.name)),
        axisLabel: { color: '#1a1611', fontSize: 11.5, fontWeight: 500 },
        axisLine: { show: false }, axisTick: { show: false },
      },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (p) => {
          const x = p[0];
          const r = regions[x.dataIndex];
          const label = r.code === CENTRAL_CODE ? 'Nationwide / Central Office' : r.name;
          return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${label}</div>
                  <div style="font-size:13px">${fmtPHP(r.amount_thousands)} · ${fmtPct(r.amount_thousands, totalAmt, 1)}</div>`;
        }
      },
      series: [{
        type: 'bar',
        data: regions.map(r => ({
          value: r.amount_thousands,
          itemStyle: { color: r.code === CENTRAL_CODE ? NATIONWIDE_COLOR : REGION_COLOR },
        })),
        itemStyle: { borderRadius: [0, 6, 6, 0] },
        barWidth: 14,
      }],
    }, true);

    cBar.off('click');
    cBar.on('click', (params) => {
      if (params.componentType !== 'series') return;
      const r = regions[params.dataIndex];
      if (!r) return;
      const sel = document.getElementById('region-select');
      if (sel) { sel.value = r.code; }
      renderDetail(r, { department, agency, totalAmt });
    });

    // --- Export affordance: ranked bar -----------------------------------
    const _fy = getCurrentYear();
    const filterCaption = department && agency
      ? `${department} · ${agency}`
      : department
        ? `${department}`
        : 'All allocators';
    const barHeaderEl = document.getElementById('bar-header');
    if (barHeaderEl) {
      mountChartActions(barHeaderEl, {
        getRows:  () => regions.map(r => ({
          code:             r.code,
          name:             r.name,
          amount_thousands: r.amount_thousands,
        })),
        columns:  ['code', 'name', 'amount_thousands'],
        csvName:  `regions-fy${_fy}`,
        chart:    cBar,
        pngName:  `regions-ranked-bar-fy${_fy}`,
        pngTitle:    `Regional allocation · FY${_fy}`,
        pngSubtitle: `${filterCaption} · ${fmtPHP(totalAmt)} total · ${regions.length} buckets ranked by amount`,
        pngLegend: [
          { label: 'Geographic region', color: REGION_COLOR },
          { label: 'Central Office / Nationwide', color: NATIONWIDE_COLOR },
        ],
      });
    }

    // --- Region select dropdown -------------------------------------------
    const regionSelect = document.getElementById('region-select');
    regionSelect.innerHTML = regions.map(r =>
      `<option value="${escapeHtml(r.code)}" ${r.code === (defaultRegion ? defaultRegion.code : '') ? 'selected' : ''}>${escapeHtml(r.name)}</option>`
    ).join('');

    regionSelect.onchange = (e) => {
      const r = regions.find(x => x.code === e.target.value);
      if (r) renderDetail(r, { department, agency, totalAmt });
    };

    // --- Map update -------------------------------------------------------
    if (cMap) {
      const mapData = geographic.map(r => ({
        name: r.geojson_name || r.name,
        value: r.amount_thousands,
        code: r.code,
      }));
      const maxAmt = mapData.reduce((m, d) => Math.max(m, d.value || 0), 0);

      cMap.setOption({
        visualMap: {
          min: 0, max: maxAmt || 1,
          formatter: v => fmtPHP(v, { decimals: 0 }),
        },
        tooltip: {
          trigger: 'item',
          formatter: (p) => {
            if (p.value == null || isNaN(p.value)) return `<div style="font-size:12px">${p.name}</div>`;
            return `<div style="font-size:12px;font-weight:600;margin-bottom:2px">${p.name}</div>
                    <div style="font-size:13px">${fmtPHP(p.value)} · ${fmtPct(p.value, regionalAmt, 1)}</div>`;
          }
        },
        series: [{ data: mapData }],
      });

      cMap.off('click');
      cMap.on('click', (params) => {
        if (params.componentType !== 'series') return;
        const match = mapData.find(d => d.name === params.name);
        if (!match) return;
        const r = regions.find(x => x.code === match.code);
        if (!r) return;
        const sel = document.getElementById('region-select');
        if (sel) { sel.value = r.code; }
        renderDetail(r, { department, agency, totalAmt });
      });
    }

    // --- Region detail (default region) ----------------------------------
    if (defaultRegion) {
      await renderDetail(defaultRegion, { department, agency, totalAmt });
    }
  }

  // =========================================================================
  // Region detail panel
  // =========================================================================
  async function renderDetail(r, { department, agency, totalAmt } = {}) {
    const isCentral = r.code === CENTRAL_CODE;
    document.getElementById('detail-title').textContent = isCentral
      ? 'Central Office / Nationwide allocations'
      : `Region ${r.code}: ${r.name}`;
    document.getElementById('detail-sub').textContent =
      `${fmtPHP(r.amount_thousands)} · ${fmtPct(r.amount_thousands, totalAmt || r.amount_thousands, 2)} of filtered total`;

    // Label for breakdown column
    let deptLabel = 'Top 10 departments';
    if (department && agency) deptLabel = 'Top programs';
    else if (department)      deptLabel = 'Top agencies';
    document.getElementById('detail-dept-label').textContent = deptLabel;

    cDept.showLoading({ text: '', maskColor: 'rgba(255,255,255,0.6)', textColor: '#7a6a4c' });
    cExp.showLoading({ text: '', maskColor: 'rgba(255,255,255,0.6)', textColor: '#7a6a4c' });

    // Build breakdown query.
    // The WHERE filter on region uses (REGION_NORMALIZE_SQL) = ? so that the
    // synthetic codes the ranked bar emits (e.g. '00' covers both literal
    // '00' rows AND legacy "National Capital Region" rows) drill down into
    // every row that maps to the same bucket.
    const regionMatch = `(${REGION_NORMALIZE_SQL}) = ?`;
    let breakdownQuery, breakdownParams, breakdownLabelCol;
    if (department && agency) {
      // Both set: top programs
      breakdownQuery = `
        SELECT program, SUM(amount_thousands) AS amount_thousands
        FROM budget
        WHERE ${regionMatch} AND department = ? AND agency = ? AND program IS NOT NULL
        GROUP BY program ORDER BY amount_thousands DESC LIMIT 10`;
      breakdownParams = [r.code, department, agency];
      breakdownLabelCol = 'program';
    } else if (department) {
      // Only dept set: top agencies
      breakdownQuery = `
        SELECT agency, SUM(amount_thousands) AS amount_thousands
        FROM budget
        WHERE ${regionMatch} AND department = ? AND agency IS NOT NULL
        GROUP BY agency ORDER BY amount_thousands DESC LIMIT 10`;
      breakdownParams = [r.code, department];
      breakdownLabelCol = 'agency';
    } else {
      // Default: top departments
      breakdownQuery = `
        SELECT department, SUM(amount_thousands) AS amount_thousands
        FROM budget
        WHERE ${regionMatch}
        GROUP BY department ORDER BY amount_thousands DESC LIMIT 10`;
      breakdownParams = [r.code];
      breakdownLabelCol = 'department';
    }

    // Expense class WHERE — same region-normalisation trick.
    const expConditions = [regionMatch];
    const expParams = [r.code];
    if (department) { expConditions.push('department = ?'); expParams.push(department); }
    if (agency)     { expConditions.push('agency = ?');     expParams.push(agency); }

    const [deptRows, expRows] = await Promise.all([
      sql(breakdownQuery, breakdownParams),
      sql(`SELECT exp_class, SUM(amount_thousands) AS amount_thousands
           FROM budget
           WHERE ${expConditions.join(' AND ')}
           GROUP BY exp_class ORDER BY amount_thousands DESC`, expParams),
    ]);

    cDept.hideLoading();
    cExp.hideLoading();

    const deptLabels = deptRows.map(d => shortDept(d[breakdownLabelCol] || ''));

    cDept.setOption({
      grid: { left: 230, right: 30, top: 10, bottom: 10, containLabel: false },
      xAxis: {
        type: 'value',
        axisLabel: { formatter: v => fmtPHP(v, { decimals: 0 }), color: '#7a6a4c', fontSize: 11 },
        splitLine: { lineStyle: { color: '#e6d8b3' } },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: deptLabels,
        axisLabel: { color: '#1a1611', fontSize: 12, fontWeight: 500 },
        axisLine: { show: false }, axisTick: { show: false },
      },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (p) => {
          const x = p[0];
          const d = deptRows[x.dataIndex];
          return `<div style="font-size:12px;font-weight:600;margin-bottom:4px">${d[breakdownLabelCol]}</div>
                  <div style="font-size:13px">${fmtPHP(d.amount_thousands)} · ${fmtPct(d.amount_thousands, r.amount_thousands, 1)}</div>`;
        }
      },
      series: [{
        type: 'bar',
        data: deptRows.map(d => d.amount_thousands),
        itemStyle: {
          color: (p) => PHL_PALETTE[p.dataIndex % PHL_PALETTE.length],
          borderRadius: [0, 8, 8, 0],
        },
        barWidth: 16,
      }],
    }, true);

    const expData = expRows
      .filter(x => x.exp_class)
      .map(x => ({ value: x.amount_thousands, name: x.exp_class }));

    cExp.setOption({
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
        itemStyle: { borderColor: '#ece1c3', borderWidth: 3 },
        data: expData.map(d => ({
          ...d,
          itemStyle: { color: EXP_CLASS_COLORS[d.name] || '#7a6a4c' }
        })),
      }],
    }, true);

    document.getElementById('region-exp-legend').innerHTML = expData.map(d => {
      const abbr = shortExp(d.name);
      const termAttr = EXP_CLASS_TERM[d.name] ? ` data-term="${EXP_CLASS_TERM[d.name]}"` : '';
      return `
      <div class="flex items-center justify-between text-xs">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-2 h-2 rounded-full shrink-0" style="background:${EXP_CLASS_COLORS[d.name] || '#7a6a4c'}"></span>
          <span class="truncate text-ink-700"${termAttr}>${abbr}</span>
        </div>
        <div class="text-ink-500 font-medium tabular-nums shrink-0 ml-2">${fmtPHP(d.value)}</div>
      </div>`;
    }).join('');
    mountGloss(document.getElementById('region-exp-legend'));
  }

  // =========================================================================
  // Map init (lazy GeoJSON)
  // =========================================================================
  try {
    const mapEl = document.getElementById('chart-map');
    const geoRes = await fetch('data/ph_regions.geojson');
    if (!geoRes.ok) {
      throw new Error(`GeoJSON fetch failed: HTTP ${geoRes.status} ${geoRes.statusText}`);
    }
    const geo = await geoRes.json();
    echarts.registerMap('philippines', geo);

    mapEl.innerHTML = '';
    mapEl.classList.remove('flex', 'items-center', 'justify-center', 'text-center', 'text-xs', 'text-ink-400');

    // placeholder mapData — will be overwritten by renderForFilter
    // SVG renderer (instead of canvas) so the map stays crisp at any zoom level.
    cMap = createChart(mapEl, null, { renderer: 'svg' });
    cMap.setOption({
      tooltip: {
        trigger: 'item',
        formatter: (p) => {
          if (p.value == null || isNaN(p.value)) return `<div style="font-size:12px">${p.name}</div>`;
          return `<div style="font-size:12px;font-weight:600;margin-bottom:2px">${p.name}</div>
                  <div style="font-size:13px">${fmtPHP(p.value)}</div>`;
        }
      },
      visualMap: {
        left: 16, bottom: 16,
        min: 0, max: 1,
        calculable: true,
        inRange: { color: ['#E0E8F7', '#1d3da8', '#1d3da8'] },
        textStyle: { color: '#7a6a4c', fontSize: 11 },
        formatter: v => fmtPHP(v, { decimals: 0 }),
      },
      series: [{
        type: 'map',
        map: 'philippines',
        nameProperty: 'REGION',
        roam: true,
        itemStyle: { borderColor: '#ece1c3', borderWidth: 1, areaColor: '#e6d8b3' },
        emphasis: {
          itemStyle: { areaColor: '#e8b94a', borderColor: '#1a1611' },
          label: { color: '#1a1611', fontWeight: 600 },
        },
        select: { itemStyle: { areaColor: '#e25034' } },
        label: { show: false },
        data: [],
      }],
    });

    // --- Export affordance: regional map ---------------------------------
    const mapFy = getCurrentYear();
    const mapHeaderEl = document.getElementById('map-header');
    if (mapHeaderEl) {
      // geographic snapshot captured at map-init time; re-read on each export via getRows closure
      mountChartActions(mapHeaderEl, {
        getRows:  () => {
          // Pull the latest geographic rows from cMap's data (set by renderForFilter)
          const seriesData = (cMap.getOption().series[0] || {}).data || [];
          return seriesData.map(d => ({ name: d.name, amount_thousands: d.value ?? '' }));
        },
        columns:  ['name', 'amount_thousands'],
        csvName:  `regions-map-fy${mapFy}`,
        chart:    cMap,
        pngName:  `regions-map-fy${mapFy}`,
        pngTitle:    `Regional map · FY${mapFy}`,
        pngSubtitle: `Allocations by Philippine administrative region · ranked colour ramp · sequential blue scale`,
        pngLegend: [
          { label: 'Sequential blue scale · darker = higher allocation', color: '#1d3da8' },
        ],
      });
    }

    // --- Zoom control buttons -------------------------------------------
    const mapCard = mapEl.closest('.card');
    if (mapCard) {
      const zoomWrap = document.createElement('div');
      zoomWrap.style.cssText = 'position:absolute;top:14px;right:14px;display:flex;gap:4px;z-index:10';

      function makeZoomBtn(label) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.className = 'btn btn-ghost';
        btn.style.cssText = 'padding:4px 10px;font-size:11px;';
        return btn;
      }

      const btnIn    = makeZoomBtn('+');
      const btnOut   = makeZoomBtn('−');
      const btnReset = makeZoomBtn('Reset');

      btnIn.addEventListener('click', () => {
        const currentZoom = (cMap.getOption().series[0].zoom) || 1;
        cMap.setOption({ series: [{ zoom: currentZoom * 1.3 }] });
      });
      btnOut.addEventListener('click', () => {
        const currentZoom = (cMap.getOption().series[0].zoom) || 1;
        cMap.setOption({ series: [{ zoom: currentZoom / 1.3 }] });
      });
      btnReset.addEventListener('click', () => {
        cMap.setOption({ series: [{ zoom: 1, center: null }] });
      });

      zoomWrap.appendChild(btnIn);
      zoomWrap.appendChild(btnOut);
      zoomWrap.appendChild(btnReset);
      mapCard.appendChild(zoomWrap);
    }
  } catch (e) {
    console.error('[regions] map init failed:', e);
  }

  // --- initial render -------------------------------------------------------
  await renderForFilter({ department: null, agency: null });

  // Resize handling — use shared ResizeObserver from data.js (no listener leaks)
  observeChartResize(document.getElementById('chart-region-bar'), cBar);
  observeChartResize(document.getElementById('chart-region-dept'), cDept);
  observeChartResize(document.getElementById('chart-region-exp'), cExp);
  if (cMap) observeChartResize(document.getElementById('chart-map'), cMap);
}

function kpiCard(label, value, sub, dot, status) {
  const statusDot = status ? `<span class="kpi-status-dot kpi-status-${status}"></span>` : '';
  return `
    <div class="card kpi">
      ${statusDot}
      <div class="kpi-label"><span class="kpi-dot" style="background:${dot};box-shadow:0 0 0 3px ${dot}1A"></span>${label}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;
}

function shortRegion(name) {
  if (!name) return '';
  return name
    .replace(/^Region\s+/i, '')
    .replace('National Capital Region', 'NCR')
    .replace('Cordillera Administrative Region', 'CAR')
    .replace('Bangsamoro Autonomous Region in Muslim Mindanao', 'BARMM')
    .replace('Autonomous Region in Muslim Mindanao', 'ARMM')
    .replace('Negros Island Region', 'NIR')
    .replace('Central Office', 'Central Office / Nationwide');
}

function shortDept(name) {
  if (!name) return '';
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

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
