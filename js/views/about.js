// About page — opens with a motivation paragraph that thanks DBM, surfaces a
// few headline metrics, then drops into a Data section with methodology and
// caveats. Technical mechanics (OCR engine, parser internals, etc.) live in
// the project README and CLAUDE.md, not here.

import { getYears, COVERAGE_META, coverageFor, mountGloss } from '../data.js';

// Headline numbers. Updated when the dataset materially grows.
const PHL_POPULATION_M = 117;          // PSA 2024 estimate, ~117 million.
const TOTAL_BUDGET_LINES = 5_553_516;  // sum of rows across all 18 budget_*.parquet files.
const N_FY = 18;                       // FY2009 through FY2026 inclusive (Across Time + Allocations).
const N_COMPARE_FY = 11;               // Years where NEP-vs-GAA Compare is available.

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildCoverageGroups(years) {
  const groups = {};
  for (const y of years) {
    const flag = coverageFor(y);
    if (!groups[flag]) groups[flag] = [];
    groups[flag].push(y);
  }
  return groups;
}

function fmtYearList(arr) {
  if (!arr || !arr.length) return '—';
  const sorted = arr.slice().sort((a, b) => a - b);
  const runs = [];
  let runStart = sorted[0], runPrev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === runPrev + 1) {
      runPrev = sorted[i];
    } else {
      runs.push([runStart, runPrev]);
      runStart = sorted[i];
      runPrev = sorted[i];
    }
  }
  runs.push([runStart, runPrev]);
  return runs.map(([a, b]) => a === b ? `FY${a}` : `FY${a}–FY${b}`).join(', ');
}

function fmtCompact(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + ' million';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export async function renderAbout(root) {
  const yp = await getYears();
  const years = yp.years || [];
  const coverageGroups = buildCoverageGroups(years);

  // Highest-fidelity rows first.
  const FLAG_ORDER = [
    'UACS_NATIVE', 'UACS_REMAPPED', 'OCR_RECONSTRUCTED', 'PRE_UACS_MELT',
    'OCR_PATCHED_AA', 'OCR_ESTIMATE', 'UACS_REMAPPED_NGA_ONLY',
  ];
  const orderedFlags = FLAG_ORDER.filter(f => coverageGroups[f] && coverageGroups[f].length);

  root.innerHTML = `
    <div class="grid grid-cols-12 gap-5">

      <!-- HERO: motivation + DBM thanks -->
      <div class="col-span-12 card p-8" style="background:transparent;">
        <div class="section-kicker">Why this exists</div>
        <h2 class="font-display font-extrabold text-[32px] leading-[1.15] tracking-[-0.02em] mb-4 max-w-3xl">
          The Philippines is ${PHL_POPULATION_M} million people. Its national budget should be readable in five minutes, not five hours.
        </h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl">
          <p class="text-ink-700 text-[14.5px] leading-[1.7]">
            Every year the Philippine Congress enacts a <span data-term="GAA" class="cursor-help underline decoration-dotted">General Appropriations Act</span> that allocates trillions of pesos across more than forty departments, hundreds of agencies, and over a million line items. A budget at that scale shapes everything &mdash; the schools that get built, the roads that get paved, the social-protection floor that catches families through a typhoon. It deserves a clear, public-facing read.
          </p>
          <p class="text-ink-700 text-[14.5px] leading-[1.7]">
            This dashboard exists because the <span data-term="DBM" class="cursor-help underline decoration-dotted">Department of Budget and Management</span> has steadily made the budget more open over the last decade &mdash; publishing the GAA in machine-readable form, posting the executive's proposal alongside it, and keeping the older years on file (sometimes only as scans, but kept). Every chart on this site comes straight from those releases. The job here is simply to make them easy to look at side-by-side.
          </p>
        </div>

        <!-- Headline-metric strip -->
        <div class="mt-7 grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl">
          <div>
            <div class="font-display font-extrabold text-[28px] tracking-[-0.015em] text-iris-deep tabular-nums">${fmtCompact(TOTAL_BUDGET_LINES)}</div>
            <div class="text-[11.5px] uppercase tracking-[0.14em] font-bold text-ink-500 mt-1">Budget line items read</div>
          </div>
          <div>
            <div class="font-display font-extrabold text-[28px] tracking-[-0.015em] text-iris-deep tabular-nums">${N_FY}</div>
            <div class="text-[11.5px] uppercase tracking-[0.14em] font-bold text-ink-500 mt-1">Fiscal years (FY${years[0]}&ndash;FY${years[years.length - 1]})</div>
          </div>
          <div>
            <div class="font-display font-extrabold text-[28px] tracking-[-0.015em] text-iris-deep tabular-nums">42&ndash;46</div>
            <div class="text-[11.5px] uppercase tracking-[0.14em] font-bold text-ink-500 mt-1">Departments tracked per year</div>
          </div>
          <div>
            <div class="font-display font-extrabold text-[28px] tracking-[-0.015em] text-iris-deep tabular-nums">${N_COMPARE_FY}</div>
            <div class="text-[11.5px] uppercase tracking-[0.14em] font-bold text-ink-500 mt-1">Years with NEP-vs-GAA reconciliation</div>
          </div>
        </div>
      </div>

      <!-- DATA section: per-year coverage table + caveats -->
      <div class="col-span-12 card p-7">
        <div class="section-kicker">Data</div>
        <h3 class="font-display font-bold text-[20px] tracking-[-0.01em] mb-2">Coverage by fiscal year</h3>
        <p class="text-ink-700 text-[13.5px] leading-[1.65] mb-4 max-w-4xl">
          Most years come straight from DBM's structured "By Object" Excel and reflect the full enacted budget &mdash; line agencies, <span data-term="SPFs" class="cursor-help underline decoration-dotted">Special Purpose Funds</span>, and <span data-term="AAs" class="cursor-help underline decoration-dotted">Automatic Appropriations</span>. A handful of years required extra work: where DBM only released a scanned PDF, we read the values off the scan and reconciled the totals against the published GAA. The table below shows what each year is built from.
        </p>

        <div class="overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                <th>Fidelity tier</th>
                <th>Years</th>
                <th>What this means</th>
              </tr>
            </thead>
            <tbody>
              ${orderedFlags.map(flag => {
                const meta = COVERAGE_META[flag] || {};
                return `
                  <tr>
                    <td>
                      <span class="inline-flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full inline-block" style="background:${meta.chipColor || '#7a6a4c'}"></span>
                        <span class="font-semibold" style="color:${meta.chipColor || '#1a1611'}">${escapeHtml(meta.label || flag)}</span>
                      </span>
                    </td>
                    <td class="text-ink-700 text-[13px] tabular-nums">${fmtYearList(coverageGroups[flag])}</td>
                    <td class="text-ink-600 text-[12.5px] leading-[1.55]">${escapeHtml(meta.tooltip || '')}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>

        <h3 class="font-display font-bold text-[18px] tracking-[-0.01em] mt-7 mb-2">Two umbrella entries you'll see</h3>
        <p class="text-ink-700 text-[13.5px] leading-[1.65] max-w-4xl">
          A common point of confusion: the GAA is <em>not</em> just "new appropriations." It bundles two parallel categories that share the same Excel file but are conceptually distinct.
        </p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 max-w-4xl">
          <div class="card p-5" style="background:transparent;border:0;">
            <div class="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400 mb-1">Umbrella A</div>
            <div class="font-display font-bold text-[16px] mb-2">New General Appropriations <span class="text-ink-400 font-normal">(NGA)</span></div>
            <p class="text-[12.5px] text-ink-700 leading-[1.6]">
              Items being appropriated <em>fresh</em> in the current GAA that aren't tied to a single line department: <span data-term="SPFs" class="cursor-help underline decoration-dotted">Special Purpose Funds</span> (Calamity Fund, Contingent Fund, Pension and Gratuity Fund), and miscellaneous cross-cutting items. Requires annual congressional action.
            </p>
          </div>
          <div class="card p-5" style="background:transparent;border:0;">
            <div class="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400 mb-1">Umbrella B</div>
            <div class="font-display font-bold text-[16px] mb-2">Automatic Appropriations <span class="text-ink-400 font-normal">(AA)</span></div>
            <p class="text-[12.5px] text-ink-700 leading-[1.6]">
              Legally-mandated outflows that <em>don't</em> need yearly congressional action: <span data-term="NTA" class="cursor-help underline decoration-dotted">NTA</span>/<span data-term="IRA" class="cursor-help underline decoration-dotted">IRA</span> transfers to LGUs, debt-service interest, <span data-term="RLIP" class="cursor-help underline decoration-dotted">RLIP</span>. Authorised by standing law.
            </p>
          </div>
        </div>
      </div>

      <!-- METHODOLOGY -->
      <div class="col-span-12 lg:col-span-7 card p-7">
        <div class="section-kicker">Methodology</div>

        <h3 class="font-display font-bold text-[18px] tracking-[-0.01em] mt-3 mb-2">Reading the source files</h3>
        <p class="text-ink-700 text-[13.5px] leading-[1.65]">
          For most years, DBM publishes the GAA as a structured spreadsheet — one row per budget line item, with department, agency, program, region, fund, expense class, and object code. The dashboard reads those files directly. For a few older years, DBM only published the GAA as a scanned image. We read those scans page-by-page, recover the same fields where possible, and reconcile the year's total against the published GAA so the headline figure matches the law.
        </p>

        <h3 class="font-display font-bold text-[18px] tracking-[-0.01em] mt-6 mb-2">Functional and economic classification</h3>
        <p class="text-ink-700 text-[13.5px] leading-[1.65]">
          The DBM source records department, agency, program, region, fund, and object code &mdash; but not function (health vs. education vs. defence) or economic type (wages vs. capital outlays vs. transfers). The dashboard adds those two cuts using a "<span data-term="COFOG" class="cursor-help underline decoration-dotted">COFOG</span>-lite" mapping that keys on program-name keywords first, then agency, then department.
        </p>

        <h3 class="font-display font-bold text-[18px] tracking-[-0.01em] mt-6 mb-2">GDP series</h3>
        <p class="text-ink-700 text-[13.5px] leading-[1.65]">
          Percent-of-GDP figures use World Bank Open Data nominal GDP (current PHP) for FY2009–FY2024. For FY2025 and FY2026, the dashboard uses World Bank projections from the latest <em>Philippines Economic Update</em> (Dec 2025) cross-checked against the IMF April 2026 World Economic Outlook nominal level. These years are flagged with hollow markers in the timeline charts and will be revised once PSA publishes the full nominal series.
        </p>

        <h3 class="font-display font-bold text-[18px] tracking-[-0.01em] mt-6 mb-2">Real PHP toggle</h3>
        <p class="text-ink-700 text-[13.5px] leading-[1.65]">
          The Across Time view has a Nominal / Real (2018) toggle. In Real mode every peso amount is rescaled to its 2018 buying power using the Philippine consumer price index, so a five-year trend reflects real growth rather than the cumulative effect of inflation.
        </p>
      </div>

      <!-- SOURCES + CAVEATS -->
      <div class="col-span-12 lg:col-span-5 card p-7">
        <div class="section-kicker">Sources</div>
        <ul class="text-[13px] text-ink-700 leading-[1.7]">
          <li><strong>DBM "By Object" Excel</strong> &mdash; one file per fiscal year; the canonical line-item record of the enacted GAA.</li>
          <li><strong>DBM NEP Excel</strong> &mdash; the executive's proposal each year; used in the Compare view.</li>
          <li><strong>DBM scanned annexes</strong> (FY2014, FY2019) &mdash; the GAA Volume I-B "Summary of New Appropriations" plus the Automatic Appropriations annex.</li>
          <li><strong>DBM BESF Selected Tables</strong> &mdash; macro fiscal tables used to anchor expense-class totals.</li>
          <li><strong>World Bank Open Data API</strong> &mdash; nominal GDP, PHP current prices.</li>
          <li><strong>WB Philippines Economic Update</strong> (Dec 2025) &mdash; out-year GDP path.</li>
          <li><strong>IMF WEO April 2026</strong> &mdash; cross-check on nominal GDP level.</li>
          <li><strong>PSA CPI</strong> &mdash; deflator for the Real (2018) toggle.</li>
          <li><strong>macoymejia/geojsonph</strong> &mdash; regional choropleth boundaries.</li>
        </ul>

        <h3 class="font-display font-bold text-[18px] tracking-[-0.01em] mt-6 mb-2">Caveats worth restating</h3>
        <ul class="text-[12.5px] text-ink-600 leading-[1.65]">
          <li>All amounts are in nominal PHP unless the toggle is set to Real (2018).</li>
          <li>For FY2014 and FY2019, drill-downs at the line-item level inside individual line departments are still partial — the dashboard has the headlines, the expense classes, the department list, and the agency-level breakdown for each department, but not yet every program and object code inside each agency.</li>
          <li>FY2016 and FY2017 are <span class="font-semibold" style="color:${COVERAGE_META.UACS_REMAPPED_NGA_ONLY.chipColor}">${escapeHtml(COVERAGE_META.UACS_REMAPPED_NGA_ONLY.label)}</span> — DBM's structured Excel for those years was missing the Automatic Appropriations side, so the headline totals are lower than the published full GAA. Comparable to each other; not directly comparable to other years.</li>
          <li>Region code "13" is non-geographic (Central Office / Nationwide) and is excluded from the regional map but kept in ranked bars.</li>
          <li>Pre-2014 years (FY2009–FY2013) only reported per-agency totals split into Personnel Services, Operating Expenses, and Capital Outlays — not specific items. The line-item drill-down is unavailable for those years; sector and expense-class views still work.</li>
          <li>The 2022 Mandanas-Garcia ruling expanded the NTA base; FY2022 onward reflects the enlarged transfer floor.</li>
          <li>FY2026 expense-class detail is coarser than FY2024 / FY2025: DBM consolidated sub-object codes in the FY2026 release (e.g. "Basic Salary - Civilian" and "Salaries and Wages - Casual/Contractual" both roll up to "Salaries and Wages - Regular"). Object-code drill-downs for FY2026 will show fewer distinct line items than for prior years.</li>
        </ul>
      </div>

      <!-- Disclaimer + contact -->
      <div class="col-span-12 card p-6" style="background:transparent;border:0;">
        <div class="section-kicker">Disclaimer</div>
        <h3 class="font-display font-bold text-[18px] tracking-[-0.01em] mt-1 mb-2">A note on the numbers</h3>
        <p class="text-[13px] text-ink-700 leading-[1.7] max-w-3xl">
          The underlying source documents (GAA, NEP, BESF) are published by the Philippine Department of Budget and Management. The cleaning rules, cross-vintage reconciliations, OCR transcription of scanned years, functional and economic classifications, and per-region apportioning on this site are the author's own work on top of those sources. Where a figure here disagrees with an official DBM release, the DBM release is authoritative.
        </p>
        <p class="text-[13px] text-ink-700 leading-[1.7] max-w-3xl mt-3">
          A contact channel for corrections and data requests will be added here in a future release. Until then, please raise issues through the working-paper channel you received this link from.
        </p>
      </div>

    </div>
  `;

  mountGloss(root);
}
