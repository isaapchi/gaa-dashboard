// NEP vs GAA comparison — five-section editorial brief.
//
// Reads site/data/compare_${year}.json (pre-baked by etl/compare_nep_gaa.py).
// Five sections in order:
//   1. Top-line — same envelope, very different shape
//   2. Department-level — DPWH was gutted; social sectors topped up
//   3. Programs — what Congress actually killed and grew
//   4. Function (COFOG-lite) — Infrastructure → Education / Health / Agriculture
//   5. Economic — the capital-to-personnel pivot
//
// (Agency-level was dropped: the dominant agency labels are "Office of the
// Secretary" repeated across many departments, which is not informative
// without department context. Department-level § 2 carries the same story.)

import {
  fmtPHP,
  createChart,
  observeChartResize,
  mountChartActions,
  mountGloss,
  emptyState,
  getCurrentYear,
  STATUS_COLORS,
} from '../data.js';

// Editorial color tokens — reused across all sections.
const ADDED   = STATUS_COLORS.ok;     // mint  — Congress added
const CUT     = STATUS_COLORS.error;  // coral — Congress cut
const NEUTRAL = '#7a6a4c';            // ink-400
const IRIS    = '#e25034';

const TRUNC = (s, n = 38) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''));

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Format a Δ amount in PHP thousands with explicit sign and color.
function fmtDelta(thousands) {
  if (thousands == null) return '—';
  const sign = thousands > 0 ? '+' : (thousands < 0 ? '−' : '');
  const abs = Math.abs(thousands);
  return `<span style="color:${thousands > 0 ? ADDED : thousands < 0 ? CUT : NEUTRAL};font-feature-settings:'tnum';">${sign}${fmtPHP(abs).replace('₱','₱')}</span>`;
}

function fmtPctSigned(pct) {
  if (pct == null || isNaN(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  const color = pct > 0 ? ADDED : pct < 0 ? CUT : NEUTRAL;
  return `<span style="color:${color};font-feature-settings:'tnum';">${sign}${pct.toFixed(1)}%</span>`;
}

async function loadCompare(year) {
  try {
    const r = await fetch(`data/compare_${year}.json`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

// --- Data-driven editorial helpers -----------------------------------------
// Each year has different cuts/adds, so we compute the headline framing from
// the data rather than hard-coding FY2026-specific prose.

// Pull the parenthetical short form from a dept name (e.g. "DPWH"); fallback
// to a sane shortened name if no parenthetical is present.
function shortDept(name) {
  if (!name) return '';
  const m = name.match(/\(([^)]+)\)\s*$/);
  if (m) return m[1];
  return name.replace(/^Department of /, '').replace(/^Office of /, '').trim();
}

function biggestCut(arr, key = 'diff') {
  return arr.slice().filter(x => x[key] < 0).sort((a, b) => a[key] - b[key])[0] || null;
}
function biggestAdd(arr, key = 'diff') {
  return arr.slice().filter(x => x[key] > 0).sort((a, b) => b[key] - a[key])[0] || null;
}
function topAdds(arr, n, key = 'diff') {
  return arr.slice().filter(x => x[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, n);
}

// Compute the hero headline + supporting paragraph from the comparison data.
function buildHero(data) {
  const tl = data.top_line;
  const fnCut = biggestCut(data.function);
  const ecCut = biggestCut(data.economic);
  const ecAdd = biggestAdd(data.economic);
  const deptCut = biggestCut(data.department);
  const fnAdds = topAdds(data.function, 3);

  let headline;
  if (Math.abs(tl.diff_pct) < 0.001) {
    headline = `The total didn't move. ${fmtPHP(tl.nep_thousands)}, exactly as proposed.`;
  } else if (tl.diff_thousands > 0) {
    headline = `Congress raised the proposal by ${fmtPHP(Math.abs(tl.diff_thousands))} (+${tl.diff_pct.toFixed(1)}%) to ${fmtPHP(tl.gaa_thousands)}.`;
  } else {
    headline = `Congress trimmed the proposal by ${fmtPHP(Math.abs(tl.diff_thousands))} (${tl.diff_pct.toFixed(1)}%) to ${fmtPHP(tl.gaa_thousands)}.`;
  }

  const parts = [];
  if (fnCut && fnAdds.length) {
    parts.push(
      `Inside that ${Math.abs(tl.diff_pct) < 0.001 ? 'ceiling' : 'envelope'}, ` +
      `Congress redirected <strong>${fmtPHP(Math.abs(fnCut.diff))}</strong> out of ${escapeHtml(fnCut.name)} ` +
      `into ${fnAdds.map(f => escapeHtml(f.name)).join(', ')}`
    );
  }
  if (ecCut && ecAdd && ecCut.diff < 0 && ecAdd.diff > 0) {
    const pivot = Math.min(Math.abs(ecCut.diff), ecAdd.diff);
    const tail = `pivoted <strong>${fmtPHP(pivot)}</strong> from <span data-term="${ecCutTerm(ecCut.name)}">${escapeHtml(ecCut.name)}</span> into <span data-term="${ecAddTerm(ecAdd.name)}">${escapeHtml(ecAdd.name)}</span>`;
    parts[0] = (parts[0] || '') + ` &mdash; and ${tail}`;
  }
  if (parts.length) parts[parts.length - 1] += '.';
  if (deptCut) {
    parts.push(
      `${escapeHtml(shortDept(deptCut.name))} was the largest single source ` +
      `(−${fmtPHP(Math.abs(deptCut.diff))}).`
    );
  }

  // Reshuffle intensity — how much of NEP got changed at line-item level,
  // even when the headline matches. The leaf-level number is the most
  // accurate; the program-level number is added in parentheses for context.
  const rs = tl.reshuffle_pct;
  if (rs && rs.leaf_pct != null) {
    parts.push(
      `At the line-item level, <strong>${rs.leaf_pct.toFixed(1)}%</strong> of NEP was adjusted ` +
      `(${rs.program_pct.toFixed(1)}% at program level).`
    );
  }

  return { headline, narrative: parts.join(' ') };
}

// Map economic-bucket display name to glossary key (PS / MOOE / CO / FE).
function ecCutTerm(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('personnel')) return 'PS';
  if (n.includes('mooe') || n.includes('operations')) return 'MOOE';
  if (n.includes('capital')) return 'CO';
  if (n.includes('debt')) return 'FE';
  return '';
}
const ecAddTerm = ecCutTerm;

// §2 title — biggest dept cut + adds
function deptTitle(data) {
  const cut = biggestCut(data.department);
  if (!cut) return 'Departmental shifts';
  const cutShort = shortDept(cut.name);
  const cutPct = cut.pct != null ? Math.abs(cut.pct) : null;
  const verb = cutPct != null && cutPct > 30 ? 'was gutted' : 'was the largest source';
  return `${cutShort} ${verb}`;
}

function deptDeck(data) {
  const cut = biggestCut(data.department);
  const adds = topAdds(data.department, 3);
  if (!cut) return 'Largest department-level reallocations.';
  const list = adds.length ? adds.map(d => shortDept(d.name)).join(', ') : '';
  return list
    ? `${shortDept(cut.name)} alone supplied ${fmtPHP(Math.abs(cut.diff))} of the redirected pool; ${list} absorbed most of it.`
    : `${shortDept(cut.name)} supplied ${fmtPHP(Math.abs(cut.diff))} of the redirected pool.`;
}

// §3 deck — program counts
function programDeck(data) {
  const killed = (data.program && data.program.killed) ? data.program.killed.length : 0;
  const added  = (data.program && data.program.added)  ? data.program.added.length  : 0;
  return `${killed} programs zeroed out (NEP &gt; 0, GAA = 0); top ${added} largest additions on the right.`;
}

// §4 title and deck
function functionTitle(data) {
  const cut = biggestCut(data.function);
  if (!cut) return 'Functional shifts';
  const adds = topAdds(data.function, 3);
  if (!adds.length) return `${cut.name} cut`;
  return `${cut.name} → ${adds.map(f => f.name).join(', ')}`;
}
function functionDeck(data) {
  const cut = biggestCut(data.function);
  const adds = topAdds(data.function, 3);
  if (!cut) return 'COFOG-lite functional reallocation.';
  const list = adds.map(f => `+${fmtPHP(f.diff)} ${f.name}`).join(', ');
  return `A ${fmtPHP(Math.abs(cut.diff))} ${cut.name} cut funded ${list}.`;
}

// §5 economic title (named pivot when recognisable, otherwise generic A → B).
function economicTitle(data) {
  const cut = biggestCut(data.economic);
  const add = biggestAdd(data.economic);
  if (!cut || !add) return 'Economic-class shifts';
  const c = (cut.name || '').toLowerCase();
  const a = (add.name || '').toLowerCase();
  if (c.includes('capital') && a.includes('personnel')) return 'A capital-to-personnel pivot';
  if (c.includes('personnel') && a.includes('capital')) return 'A personnel-to-capital pivot';
  if (c.includes('mooe') && a.includes('personnel')) return 'An operations squeeze; personnel up';
  if (c.includes('mooe') && a.includes('capital'))   return 'An operations squeeze; capital up';
  if (c.includes('personnel') && a.includes('mooe')) return 'A personnel-to-operations shift';
  return `${cut.name.split(' (')[0]} → ${add.name.split(' (')[0]}`;
}
function economicDeck(data) {
  const cut = biggestCut(data.economic);
  const add = biggestAdd(data.economic);
  if (!cut || !add) return 'Reallocation by economic class.';
  return `+${fmtPHP(add.diff)} ${add.name}, ${fmtPHP(cut.diff)} ${cut.name}.`;
}

export async function renderCompare(root) {
  const year = getCurrentYear();
  const data = await loadCompare(year);

  if (!data) {
    root.innerHTML = `
      <div class="card p-8 max-w-2xl">
        ${emptyState({
          title: `No NEP available for FY${year}`,
          body:  `Drop the relevant NEP Excel into NEPs/ and re-run etl/build_nep_parquet.py and etl/compare_nep_gaa.py for that year to extend the comparison.`,
        })}
      </div>
    `;
    return;
  }

  const tl = data.top_line;
  const totalNep = tl.nep_thousands;
  const totalGaa = tl.gaa_thousands;
  const totalDiff = tl.diff_thousands;
  const hero = buildHero(data);
  const top1Deck = (Math.abs(tl.diff_pct) < 0.001)
    ? `Congress kept the headline ceiling intact. Every section below is a zero-sum shift inside it.`
    : `Congress changed the headline ceiling by ${tl.diff_pct >= 0 ? '+' : ''}${tl.diff_pct.toFixed(2)}%. Sections below show the redistribution inside that envelope.`;

  root.innerHTML = `
    <div class="space-y-6">

      <!-- Hero lede -->
      <div class="card p-8" style="background:transparent;">
        <div class="section-kicker" style="color:${IRIS};">NEP FY${year} → GAA FY${year}</div>
        <div class="font-display font-extrabold text-[28px] leading-[1.15] tracking-[-0.02em] text-ink-900 mt-1 max-w-3xl">
          ${hero.headline}
        </div>
        <div class="mt-3 text-[15px] leading-[1.55] text-ink-700 max-w-3xl">
          ${hero.narrative}
        </div>
        <div class="mt-4 text-[11px] uppercase tracking-[0.16em] font-bold text-ink-400">
          ${data.row_counts.nep_leaf_rows.toLocaleString()} NEP line items · ${data.row_counts.gaa_leaf_rows.toLocaleString()} GAA line items
        </div>
      </div>

      <!-- §1 Top-line -->
      <section class="card p-6">
        <div class="mb-5">
          <div class="section-kicker">§ 1 · TOTAL</div>
          <div class="section-title">${Math.abs(tl.diff_pct) < 0.001 ? 'Same envelope, very different shape' : 'A different envelope'}</div>
          <div class="text-sm text-ink-500 mt-1">${top1Deck}</div>
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          ${kpiTile('NEP', fmtPHP(totalNep), 'Executive proposal', NEUTRAL)}
          ${kpiTile('GAA', fmtPHP(totalGaa), 'Enacted by Congress', IRIS)}
          ${kpiTile(
            'Net change',
            Math.abs(tl.diff_pct) < 0.05
              ? '0.0%'
              : (tl.diff_pct > 0 ? '+' : '') + tl.diff_pct.toFixed(1) + '%',
            Math.abs(tl.diff_pct) < 0.05
              ? 'GAA matches NEP'
              : `${tl.diff_thousands > 0 ? '+' : ''}${fmtPHP(Math.abs(tl.diff_thousands))} vs NEP`,
            Math.abs(tl.diff_pct) < 0.05 ? '#10B981' : (totalDiff > 0 ? ADDED : CUT),
          )}
          ${kpiTile(
            'Adjusted',
            tl.reshuffle_pct ? `${tl.reshuffle_pct.leaf_pct.toFixed(1)}%` : '—',
            tl.reshuffle_pct
              ? `Of NEP changed at line-item level · ${tl.reshuffle_pct.program_pct.toFixed(1)}% at program level`
              : 'Line-item reshuffle',
            '#FFB454',
            'Reshuffle',
          )}
        </div>
      </section>

      <!-- §2 Department -->
      <section class="card p-6">
        <div class="mb-3 flex items-start justify-between gap-4" id="hdr-dept">
          <div>
            <div class="section-kicker">§ 2 · DEPARTMENTS</div>
            <div class="section-title">${escapeHtml(deptTitle(data))}</div>
            <div class="text-sm text-ink-500 mt-1">${deptDeck(data)}</div>
          </div>
        </div>
        <div id="chart-dept" class="chart" style="height:520px;" role="img" aria-label="Top 15 departments by absolute NEP-to-GAA change, diverging horizontal bar"></div>
        <div class="text-xs text-ink-400 mt-3 leading-relaxed">
          Mint = Congress added; coral = Congress cut.
        </div>
      </section>

      <!-- §3 Program -->
      <section class="card p-6">
        <div class="mb-4">
          <div class="section-kicker">§ 3 · PROGRAMS</div>
          <div class="section-title">What Congress actually killed and grew</div>
          <div class="text-sm text-ink-500 mt-1 max-w-3xl">${programDeck(data)}</div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div>
            <div class="flex items-center justify-between mb-2">
              <div class="text-[12px] uppercase tracking-[0.14em] font-bold" style="color:${CUT};">Killed by Congress</div>
              <button class="btn-ghost btn text-xs" data-toggle-prog="killed">Show all (25)</button>
            </div>
            <div class="text-xs text-ink-500 mb-2">NEP &gt; 0, GAA = 0</div>
            <div id="prog-killed">${renderProgramTable(data.program.killed.slice(0, 10), 'killed')}</div>
          </div>

          <div>
            <div class="flex items-center justify-between mb-2">
              <div class="text-[12px] uppercase tracking-[0.14em] font-bold" style="color:${ADDED};">Big additions</div>
              <button class="btn-ghost btn text-xs" data-toggle-prog="added">Show all (25)</button>
            </div>
            <div class="text-xs text-ink-500 mb-2">Top by Δ &gt; 0</div>
            <div id="prog-added">${renderProgramTable(data.program.added.slice(0, 10), 'added')}</div>
          </div>
        </div>
      </section>

      <!-- §4 Function -->
      <section class="card p-6">
        <div class="mb-3" id="hdr-function">
          <div class="section-kicker">§ 4 · FUNCTION (<span data-term="COFOG">COFOG</span>-lite)</div>
          <div class="section-title">${escapeHtml(functionTitle(data))}</div>
          <div class="text-sm text-ink-500 mt-1">${functionDeck(data)}</div>
        </div>
        <div id="chart-function" class="chart" style="height:480px;" role="img" aria-label="Function-level NEP vs GAA paired bar"></div>
      </section>

      <!-- §5 Economic -->
      <section class="card p-6">
        <div class="mb-3" id="hdr-economic">
          <div class="section-kicker">§ 5 · ECONOMIC</div>
          <div class="section-title">${escapeHtml(economicTitle(data))}</div>
          <div class="text-sm text-ink-500 mt-1">${economicDeck(data)}</div>
        </div>
        <div id="chart-economic" class="chart" style="height:300px;" role="img" aria-label="Economic-bucket NEP vs GAA paired bar"></div>
      </section>

      <!-- Source line -->
      <div class="text-[11px] text-ink-400 mt-2 leading-snug max-w-2xl">
        Source: DBM <span data-term="NEP">NEP</span>-FY${year} (<span data-term="FERB">FERB</span>) and
        <span data-term="GAA">GAA</span>-FY${year}, by-object releases. Functional groupings via
        <span data-term="COFOG">COFOG</span>-lite. Comparison generated ${escapeHtml(data.generated)}.
      </div>
    </div>
  `;

  // ---------- Charts ----------

  // §2 Department diverging bar
  mountDivergingBar(
    document.getElementById('chart-dept'),
    document.getElementById('hdr-dept'),
    data.department.slice(0, 15).map(r => ({ name: r.name, diff: r.diff, nep: r.nep, gaa: r.gaa, pct: r.pct })),
    { csvName: `nep-vs-gaa-${year}-dept`, pngName: `nep-vs-gaa-${year}-dept` },
  );

  // §4 Function paired bar
  mountPairedBar(
    document.getElementById('chart-function'),
    document.getElementById('hdr-function'),
    data.function,
    { csvName: `nep-vs-gaa-${year}-function`, pngName: `nep-vs-gaa-${year}-function` },
  );

  // §5 Economic paired bar
  mountPairedBar(
    document.getElementById('chart-economic'),
    document.getElementById('hdr-economic'),
    data.economic,
    { csvName: `nep-vs-gaa-${year}-economic`, pngName: `nep-vs-gaa-${year}-economic` },
  );

  // ---------- Show-all toggles for programs ----------
  root.querySelectorAll('[data-toggle-prog]').forEach(btn => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.toggleProg; // 'killed' or 'added'
      const list = data.program[which];
      const target = document.getElementById(`prog-${which}`);
      const expanded = btn.dataset.expanded === '1';
      if (expanded) {
        target.innerHTML = renderProgramTable(list.slice(0, 10), which);
        btn.textContent = `Show all (${list.length})`;
        btn.dataset.expanded = '0';
      } else {
        target.innerHTML = renderProgramTable(list, which);
        btn.textContent = 'Collapse';
        btn.dataset.expanded = '1';
      }
      mountGloss(target);
    });
  });

  mountGloss(root);
}

// -------- KPI tile (used by §1) --------
// `infoTerm` (optional): GLOSS dict key — adds an info icon next to the label
// that triggers the standard hover tooltip on mountGloss(root).
function kpiTile(label, value, sub, dotColor, infoTerm) {
  const info = infoTerm
    ? `<span data-term="${escapeHtml(infoTerm)}" role="button" tabindex="0" aria-label="What does this mean?" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid #6b5e48;color:#6b5e48;font-size:10px;font-weight:700;cursor:help;line-height:1;font-family:Inter,sans-serif;">i</span>`
    : '';
  return `
    <div class="rounded-[16px] border border-linen-edge p-5 ">
      <div class="flex items-center gap-2">
        <span class="kpi-dot" style="background:${dotColor};box-shadow:0 0 0 3px ${dotColor}1A"></span>
        <span class="text-[11px] uppercase tracking-[0.16em] font-bold text-ink-400">${escapeHtml(label)}</span>
        ${info}
      </div>
      <div class="font-display font-extrabold text-ink-900 mt-2" style="font-size:clamp(22px,3.4vw,34px);line-height:1.05;font-feature-settings:'tnum';letter-spacing:-0.02em;">
        ${value}
      </div>
      <div class="text-xs text-ink-500 mt-1">${escapeHtml(sub)}</div>
    </div>
  `;
}

// -------- Diverging horizontal bar (§2 dept, §3 agency) --------
function mountDivergingBar(domEl, headerEl, rows, exportOpts) {
  if (!domEl || rows.length === 0) return;

  // Sort ascending by diff so positive bars stack at the top in ECharts inverted Y.
  // ECharts y-axis inverted: first row in data is at top.
  // We want largest |Δ| at top — so sort by |Δ| desc, but to draw a clean shape
  // we use the original order (already sorted by |Δ| desc in the JSON).
  const labels   = rows.map(r => r.sublabel ? `${TRUNC(r.name, 30)}` : TRUNC(r.name, 36));
  const tooltips = rows.map(r => r);
  const values   = rows.map(r => r.diff / 1e6); // PHP B (thousands → billions)

  const colors   = values.map(v => v >= 0 ? ADDED : CUT);

  const chart = createChart(domEl);
  chart.setOption({
    grid: { left: 8, right: 24, top: 8, bottom: 24, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        const idx = params[0].dataIndex;
        const r = tooltips[idx];
        return `
          <div style="font:600 12px Inter;margin-bottom:4px;">${escapeHtml(r.name)}</div>
          ${r.sublabel ? `<div style="font:400 11px Inter;color:#6b5e48;margin-bottom:6px;">${escapeHtml(r.sublabel)}</div>` : ''}
          <div style="display:grid;grid-template-columns:auto auto;gap:2px 12px;font:500 12px Inter;">
            <span style="color:#6b5e48;">NEP</span><span style="font-feature-settings:'tnum';">${fmtPHP(r.nep)}</span>
            <span style="color:#6b5e48;">GAA</span><span style="font-feature-settings:'tnum';">${fmtPHP(r.gaa)}</span>
            <span style="color:#6b5e48;">Δ</span><span style="font-feature-settings:'tnum';color:${r.diff > 0 ? ADDED : CUT};">${r.diff > 0 ? '+' : '−'}${fmtPHP(Math.abs(r.diff))}</span>
            <span style="color:#6b5e48;">Δ %</span><span style="font-feature-settings:'tnum';color:${r.diff > 0 ? ADDED : CUT};">${r.pct == null ? '—' : (r.pct > 0 ? '+' : '') + r.pct.toFixed(1) + '%'}</span>
          </div>
        `;
      },
      backgroundColor: '#f1e8d2',
      borderColor: '#c8b988',
      borderWidth: 1,
      padding: 12,
      textStyle: { color: '#1a1611' },
      extraCssText: 'box-shadow:0 12px 32px -12px rgba(15,23,42,0.18);border-radius:12px;',
    },
    xAxis: {
      type: 'value',
      axisLabel: {
        color: '#7a6a4c',
        fontSize: 11,
        fontFamily: 'Inter',
        formatter: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} B`,
      },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#c8b988', type: 'dashed' } },
    },
    yAxis: {
      type: 'category',
      data: labels,
      inverse: true,
      axisLabel: {
        color: '#2a221a',
        fontSize: 12,
        fontFamily: 'Inter',
        fontWeight: 500,
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [{
      type: 'bar',
      data: values.map((v, i) => ({
        value: v,
        itemStyle: { color: colors[i], borderRadius: v >= 0 ? [3, 3, 3, 3] : [3, 3, 3, 3] },
      })),
      barMaxWidth: 16,
      label: {
        show: true,
        position: 'right',
        formatter: (p) => {
          const v = p.value;
          const sign = v > 0 ? '+' : '';
          return `${sign}${Math.round(v)} B`;
        },
        color: '#2a221a',
        fontSize: 11,
        fontFamily: 'Inter',
        fontWeight: 500,
      },
      animationDuration: 800,
    }],
  });
  observeChartResize(domEl, chart);

  if (headerEl) {
    mountChartActions(headerEl, {
      getRows: () => rows.map(r => ({
        name: r.name,
        sublabel: r.sublabel || '',
        nep_thousands: r.nep,
        gaa_thousands: r.gaa,
        diff_thousands: r.diff,
        pct: r.pct,
      })),
      columns: ['name', 'sublabel', 'nep_thousands', 'gaa_thousands', 'diff_thousands', 'pct'],
      csvName: exportOpts.csvName,
      chart: chart,
      pngName: exportOpts.pngName,
    });
  }
}

// -------- Paired horizontal bar (§5 function, §6 economic) --------
function mountPairedBar(domEl, headerEl, rows, exportOpts) {
  if (!domEl || !rows || rows.length === 0) return;

  const labels = rows.map(r => r.name);
  const nepVals = rows.map(r => r.nep / 1e6);
  const gaaVals = rows.map(r => r.gaa / 1e6);

  const chart = createChart(domEl);
  chart.setOption({
    grid: { left: 8, right: 24, top: 32, bottom: 36, containLabel: true },
    legend: {
      data: ['NEP (proposed)', 'GAA (enacted)'],
      bottom: 4,
      textStyle: { color: '#2a221a', fontFamily: 'Inter', fontSize: 12 },
      itemWidth: 12,
      itemHeight: 12,
      itemGap: 18,
      icon: 'roundRect',
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        const idx = params[0].dataIndex;
        const r = rows[idx];
        return `
          <div style="font:600 12px Inter;margin-bottom:6px;">${escapeHtml(r.name)}</div>
          <div style="display:grid;grid-template-columns:auto auto;gap:2px 12px;font:500 12px Inter;">
            <span style="color:#6b5e48;">NEP</span><span style="font-feature-settings:'tnum';">${fmtPHP(r.nep)} <span style="color:#6b5e48;">(${r.nep_share_pct.toFixed(1)}%)</span></span>
            <span style="color:#6b5e48;">GAA</span><span style="font-feature-settings:'tnum';">${fmtPHP(r.gaa)} <span style="color:#6b5e48;">(${r.gaa_share_pct.toFixed(1)}%)</span></span>
            <span style="color:#6b5e48;">Δ</span><span style="font-feature-settings:'tnum';color:${r.diff > 0 ? ADDED : (r.diff < 0 ? CUT : NEUTRAL)};">${r.diff > 0 ? '+' : (r.diff < 0 ? '−' : '')}${fmtPHP(Math.abs(r.diff))}</span>
            <span style="color:#6b5e48;">Δ %</span><span style="font-feature-settings:'tnum';color:${r.diff > 0 ? ADDED : (r.diff < 0 ? CUT : NEUTRAL)};">${r.pct == null ? '0.0%' : (r.pct > 0 ? '+' : '') + r.pct.toFixed(1) + '%'}</span>
          </div>
        `;
      },
      backgroundColor: '#f1e8d2',
      borderColor: '#c8b988',
      borderWidth: 1,
      padding: 12,
      textStyle: { color: '#1a1611' },
      extraCssText: 'box-shadow:0 12px 32px -12px rgba(15,23,42,0.18);border-radius:12px;',
    },
    xAxis: {
      type: 'value',
      axisLabel: {
        color: '#7a6a4c',
        fontSize: 11,
        fontFamily: 'Inter',
        formatter: (v) => `${v.toFixed(0)} B`,
      },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#c8b988', type: 'dashed' } },
    },
    yAxis: {
      type: 'category',
      data: labels,
      inverse: true,
      axisLabel: {
        color: '#2a221a',
        fontSize: 12,
        fontFamily: 'Inter',
        fontWeight: 500,
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: 'NEP (proposed)',
        type: 'bar',
        data: nepVals,
        barMaxWidth: 12,
        itemStyle: { color: '#C4BBF7', borderRadius: [0, 3, 3, 0] },
        animationDuration: 800,
      },
      {
        name: 'GAA (enacted)',
        type: 'bar',
        data: gaaVals,
        barMaxWidth: 12,
        itemStyle: { color: IRIS, borderRadius: [0, 3, 3, 0] },
        animationDuration: 800,
        animationDelay: 100,
      },
    ],
  });
  observeChartResize(domEl, chart);

  if (headerEl) {
    mountChartActions(headerEl, {
      getRows: () => rows.map(r => ({
        name: r.name,
        nep_thousands: r.nep,
        gaa_thousands: r.gaa,
        diff_thousands: r.diff,
        pct: r.pct,
        nep_share_pct: r.nep_share_pct,
        gaa_share_pct: r.gaa_share_pct,
      })),
      columns: ['name', 'nep_thousands', 'gaa_thousands', 'diff_thousands', 'pct', 'nep_share_pct', 'gaa_share_pct'],
      csvName: exportOpts.csvName,
      chart: chart,
      pngName: exportOpts.pngName,
    });
  }
}

// -------- Programs table (§4) --------
function renderProgramTable(rows, kind) {
  if (!rows || rows.length === 0) {
    return `<div class="text-sm text-ink-400">No rows.</div>`;
  }
  const headerColor = kind === 'killed' ? CUT : ADDED;
  const head = `
    <thead>
      <tr class="text-[11px] uppercase tracking-[0.12em] font-bold text-ink-400">
        <th class="text-left py-2 pr-3" style="font-weight:700;">Department · Agency · Program</th>
        <th class="text-right py-2 pr-3 whitespace-nowrap">NEP</th>
        <th class="text-right py-2 pr-3 whitespace-nowrap">GAA</th>
        <th class="text-right py-2 pr-1 whitespace-nowrap">Δ</th>
      </tr>
    </thead>
  `;
  const body = rows.map(r => {
    const dept = shortDept(r.department);
    const agency = TRUNC(r.agency, 40);
    const program = TRUNC(r.program, 90);
    return `
      <tr class="border-t border-linen-edge align-top">
        <td class="py-2.5 pr-3 text-[12.5px] leading-snug">
          <div class="text-ink-900 font-medium">${escapeHtml(program)}</div>
          <div class="text-[11px] text-ink-500 mt-0.5">${escapeHtml(dept)}${agency ? ' · ' + escapeHtml(agency) : ''}</div>
        </td>
        <td class="py-2.5 pr-3 text-right text-[12px] text-ink-700 whitespace-nowrap" style="font-feature-settings:'tnum';">${fmtPHP(r.nep)}</td>
        <td class="py-2.5 pr-3 text-right text-[12px] text-ink-700 whitespace-nowrap" style="font-feature-settings:'tnum';">${fmtPHP(r.gaa)}</td>
        <td class="py-2.5 pr-1 text-right text-[12px] whitespace-nowrap font-semibold" style="font-feature-settings:'tnum';color:${r.diff > 0 ? ADDED : CUT};">${r.diff > 0 ? '+' : '−'}${fmtPHP(Math.abs(r.diff))}</td>
      </tr>
    `;
  }).join('');
  return `<div class="overflow-x-auto"><table class="w-full text-sm">${head}<tbody>${body}</tbody></table></div>`;
}
