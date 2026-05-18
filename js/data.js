// Data layer: instant summary JSON + DuckDB-WASM (lazy) for SQL on the parquet.

import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm';

const REGIONS_URL = `data/regions.json`;
const GDP_URL     = `data/gdp_phl.json`;
const CPI_URL     = `data/cpi_phl.json`;
const YEARS_URL   = `data/years.json`;
const FALLBACK_YEAR = 2026;

// --- Year state -------------------------------------------------------------

let _yearsPayload = null;   // { years: number[], default: number }
let _currentYear  = null;   // set after getYears() resolves

export async function getYears() {
  if (_yearsPayload) return _yearsPayload;
  try {
    const r = await fetch(YEARS_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _yearsPayload = await r.json();
  } catch {
    _yearsPayload = { years: [FALLBACK_YEAR], default: FALLBACK_YEAR, coverage: {} };
  }
  if (!_yearsPayload.coverage) _yearsPayload.coverage = {};
  if (_currentYear === null) _currentYear = _yearsPayload.default;
  return _yearsPayload;
}

// Coverage label/description for the year-selector chip + tooltip + timeline footnote.
// Keep keys aligned with build_data.py's COVERAGE dict.
export const COVERAGE_META = {
  UACS_NATIVE: {
    label: 'Complete',
    chipColor: '#5BC58F',           // mint
    bgColor: '#E8F8F0',
    icon: '',
    tooltip: 'DBM published a structured Excel for this year using the standard line-item codes, and the file covers both umbrellas (new appropriations and automatic appropriations). Highest fidelity.',
  },
  UACS_REMAPPED: {
    label: 'Remapped',
    chipColor: '#6B5BEF',           // iris
    bgColor: '#EFEDFE',
    icon: '',
    tooltip: 'Standard line-item codes used, with a few year-specific column-name differences smoothed over so the data lines up with other years. Both umbrellas (new appropriations and automatic appropriations) are included.',
  },
  UACS_REMAPPED_NGA_ONLY: {
    label: 'New approp. only',
    chipColor: '#FFB454',           // amber
    bgColor: '#FFF5E5',
    icon: '⚠',
    tooltip: 'The source Excel for these years was missing the automatic-appropriations side (debt-service interest, transfers to LGUs, retirement and life insurance premiums). Headline totals are therefore lower than the published full GAA. Comparable across these two years, but not directly comparable to years that include both umbrellas.',
  },
  UACS_REMAPPED_AA_PATCHED: {
    label: 'AA patched',
    chipColor: '#5BC58F',           // mint — headline numbers reconcile to full GAA
    bgColor: '#E8F8F0',
    icon: '◐',
    tooltip: 'The source Excel for these years contained only the New General Appropriations side. The Automatic Appropriations umbrella (debt-service interest, transfers to LGUs, RLIP, customs duties, net lending, special accounts) was reconstructed from the FY GAA Vol I/II-B Annex; the four expense-class totals come from BESF Selected Table B.1. Headline totals and the wages / operations / capital / debt-service / transfers-to-LGU breakdown reconcile to the published GAA. Department / region / line-item drill-downs still reflect the original NGA-only Excel.',
  },
  PRE_UACS_MELT: {
    label: 'Pre-2014 format',
    chipColor: '#94A3B8',           // slate
    bgColor: '#F1F5F9',
    icon: '◇',
    tooltip: 'Before 2014, DBM did not yet use the unified line-item codes. The source files report each agency split only into Personnel Services, Operating Expenses, and Capital Outlays — not into specific items like office supplies or travel. We reshaped this into the dashboard format, but the line-item drill-down is not available for these years. Both umbrellas are included; sector and expense-class breakdowns are still valid.',
  },
  OCR_ESTIMATE: {
    label: 'Read from scan',
    chipColor: '#FF6B6B',           // coral
    bgColor: '#FFE8E8',
    icon: '⚠',
    tooltip: 'DBM only released these years as a scanned-image PDF, not as a structured Excel file. We used optical character recognition (OCR) software to read the numbers off the scan, which can introduce small reading errors. Verify before citing specific figures.',
  },
  OCR_PATCHED_AA: {
    label: 'Scan + AA patched',
    chipColor: '#FFB454',           // amber (better than coral, worse than mint)
    bgColor: '#FFF5E5',
    icon: '◐',
    tooltip: 'Originally read from a scanned PDF; the missing automatic-appropriations side (debt-service interest, transfers to LGUs, RLIP, and smaller items) was reconstructed from the FY2019 GAA Volume I-B Annex and the BESF Selected Tables. Headline totals and the wages / operations / capital / debt-service / transfers-to-LGU breakdown reconcile to the published GAA. Department / region / line-item drill-downs still reflect the original OCR scope.',
  },
  OCR_RECONSTRUCTED: {
    label: 'Reconstructed from scan',
    chipColor: '#5BC58F',           // mint — same fidelity tier as Complete on the user-visible cuts
    bgColor: '#E8F8F0',
    icon: '◑',
    tooltip: 'Applies to FY2014, which DBM only released as a scanned PDF. The full department enumeration was rebuilt via the etl/ocr pipeline reading the GAA Volume I-B "Summary of New Appropriations" (47 departments including line agencies, constitutional bodies, BSGC, ALGU, the five Special Purpose Funds, and Unprogrammed Appropriations) and the AA umbrella (debt-service interest, transfers to LGUs, RLIP) was reconstructed from the Vol I-B Annex. Headline total (₱2,263.6 B), expense-class breakdown, and function rollup reconcile to RA 10633 exactly. by_department sum is ~4.5% above the headline because OCR captured Congressional adjustments not in BESF Proposed; this is documented in coverage_note rather than scaled. Sub-program / line-item drill-downs inside individual departments still require per-department PDF OCR (etl/ocr workstream).',
  },
};

export function coverageFor(year) {
  if (!_yearsPayload || !_yearsPayload.coverage) return 'UACS_NATIVE';
  return _yearsPayload.coverage[String(year)] || 'UACS_NATIVE';
}

export function coverageMeta(year) {
  return COVERAGE_META[coverageFor(year)] || COVERAGE_META.UACS_NATIVE;
}

export function getCurrentYear() {
  return _currentYear !== null ? _currentYear : FALLBACK_YEAR;
}

export async function setCurrentYear(year) {
  const prev = _currentYear;
  _currentYear = year;
  // Evict the cached summary for old year (keep cache for others).
  // View will be refreshed lazily by ensureBudgetView().
  if (prev !== year) {
    await ensureBudgetView();  // re-point the view immediately
    window.dispatchEvent(new CustomEvent('budgetyearchange', { detail: { year } }));
  }
}

// --- Per-year caches --------------------------------------------------------

const _summaryCache = new Map();   // year -> payload
let _regions = null;
let _gdp     = null;
let _cpi     = null;

// --- Summary ----------------------------------------------------------------

export async function loadSummary(year) {
  if (year === undefined) {
    await getYears();          // ensure _currentYear is initialised
    year = getCurrentYear();
  }
  if (_summaryCache.has(year)) return _summaryCache.get(year);
  const r = await fetch(`data/summary_${year}.json`);
  if (!r.ok) throw new Error(`Failed to load summary for ${year} (${r.status})`);
  const payload = await r.json();
  _summaryCache.set(year, payload);
  return payload;
}

// --- Regions / GDP ----------------------------------------------------------

export async function loadRegions() {
  if (_regions) return _regions;
  const r = await fetch(REGIONS_URL);
  _regions = await r.json();
  return _regions;
}

// Returns { gdp_php, is_estimate, note } for the requested year (or null if missing).
export async function loadGDP(year) {
  if (year === undefined) {
    await getYears();
    year = getCurrentYear();
  }
  if (!_gdp) {
    const r = await fetch(GDP_URL);
    if (!r.ok) return null;
    _gdp = await r.json();
  }
  const entry = _gdp.years && _gdp.years[String(year)];
  return entry || null;
}

// Returns { cpi_2018, deflator_to_2018, is_estimate } for the requested year, or null.
// `deflator_to_2018` × nominal_PHP[y] = real_PHP[y] in 2018 prices.
export async function loadCPI(year) {
  if (year === undefined) {
    await getYears();
    year = getCurrentYear();
  }
  if (!_cpi) {
    try {
      const r = await fetch(CPI_URL);
      if (!r.ok) { _cpi = { years: {} }; return null; }
      _cpi = await r.json();
    } catch {
      _cpi = { years: {} };
      return null;
    }
  }
  const entry = _cpi.years && _cpi.years[String(year)];
  return entry || null;
}

// Convenience: deflate a nominal PHP-thousands value to 2018-real PHP-thousands.
// Returns null if no CPI for that year (caller decides whether to drop or pass through).
export async function realPHP(amount_thousands, year) {
  const cpi = await loadCPI(year);
  if (!cpi || cpi.deflator_to_2018 == null) return null;
  return amount_thousands * cpi.deflator_to_2018;
}

// --- DuckDB-WASM (lazy) -----------------------------------------------------

let _dbPromise       = null;   // resolves to { db, conn }
let _currentViewYear = null;   // which year the 'budget' view currently points to
const _fetchedYears  = new Set();  // parquet buffers already registered

async function initDuckDB() {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle  = await duckdb.selectBundle(bundles);
  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(worker_url);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db     = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(worker_url);
  const conn = await db.connect();
  return { db, conn };
}

// Returns the raw { db, conn } — no view setup here.
export function getDB() {
  if (!_dbPromise) _dbPromise = initDuckDB();
  return _dbPromise;
}

// Ensure the 'budget' view points to getCurrentYear(). Idempotent.
async function ensureBudgetView() {
  const year = getCurrentYear();
  if (_currentViewYear === year) return;          // already correct

  const { db, conn } = await getDB();

  // Fetch + register the parquet only once per year per session.
  if (!_fetchedYears.has(year)) {
    const url = `data/budget_${year}.parquet`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch parquet for ${year} (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    await db.registerFileBuffer(`budget_${year}.parquet`, buf);
    _fetchedYears.add(year);
  }

  // Cast amount_thousands to DOUBLE so SUM(...) returns DOUBLE instead of HUGEINT.
  // HUGEINT (128-bit) becomes Arrow Decimal128 in WASM, which ECharts can't coerce
  // via Number() — it throws "Cannot mix BigInt and other types".
  await conn.query(`
    CREATE OR REPLACE VIEW budget AS
    SELECT * REPLACE (CAST(amount_thousands AS DOUBLE) AS amount_thousands)
    FROM read_parquet('budget_${year}.parquet');
  `);
  _currentViewYear = year;
}

// Run SQL → returns array of plain JS objects, with all BigInt → Number.
// DuckDB-WASM returns Arrow tables; SUM(int64) comes back as BigInt and ECharts
// can't coerce BigInt — we must strip them before any chart sees the data.
export async function sql(query, params = []) {
  await ensureBudgetView();
  const { conn } = await getDB();
  const stmt   = await conn.prepare(query);
  const result = params.length ? await stmt.query(...params) : await stmt.query();
  await stmt.close();
  return arrowToPlain(result);
}

function arrowToPlain(table) {
  const out = [];
  // toArray() yields Arrow Row proxies; force into plain JSON, then strip BigInts.
  for (const row of table.toArray()) {
    const obj = (row && typeof row.toJSON === 'function')
      ? row.toJSON()
      : Object.assign({}, row);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'bigint') obj[k] = Number(v);
    }
    out.push(obj);
  }
  return out;
}

// --- Formatting helpers -----------------------------------------------------

// Smart auto-format for PHP amounts. Input is in PHP THOUSANDS.
export function fmtPHP(amount_thousands, opts = {}) {
  if (amount_thousands == null || isNaN(amount_thousands)) return '—';
  const php = amount_thousands * 1000;
  const abs = Math.abs(php);
  const decimals = opts.decimals ?? null;
  const sym = '₱'; // ₱
  let val, unit;
  if (abs >= 1e12)      { val = php / 1e12; unit = 'T'; }
  else if (abs >= 1e9)  { val = php / 1e9;  unit = 'B'; }
  else if (abs >= 1e6)  { val = php / 1e6;  unit = 'M'; }
  else if (abs >= 1e3)  { val = php / 1e3;  unit = 'K'; }
  else                  { val = php;        unit = '';  }
  const d = decimals != null ? decimals : (Math.abs(val) >= 100 ? 0 : Math.abs(val) >= 10 ? 1 : 2);
  return `${sym}${val.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}${unit ? ' ' + unit : ''}`;
}

export function fmtPct(numer, denom, decimals = 1) {
  if (!denom) return '—';
  return `${(100 * numer / denom).toFixed(decimals)}%`;
}

export function fmtInt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

// PH-themed palette for charts.
// --- Per-year population (PSA medium-scenario projections) ---------------
//
// Sourced from data/population.json. Used by the Overview view to render a
// year-appropriate 'per-Filipino' figure (total budget / population) so the
// denominator updates when the user switches fiscal year.
//
// Source citation: Philippine Statistics Authority, Projected Population by
// Single Calendar Year, Medium Assumption (2020 POPCEN-anchored for 2020+,
// 2015 POPCEN-anchored for prior years).
let _populationPayload = null;
let _populationPromise = null;

export async function loadPopulation() {
  if (_populationPayload) return _populationPayload;
  if (!_populationPromise) {
    _populationPromise = fetch('data/population.json')
      .then(r => r.ok ? r.json() : null)
      .then(p => { _populationPayload = p; return p; })
      .catch(() => null);
  }
  return _populationPromise;
}

// Convenience: synchronously look up a year's population once the
// payload is in cache. Returns null if not yet loaded or not present.
export function populationFor(year) {
  if (!_populationPayload || !_populationPayload.population) return null;
  const v = _populationPayload.population[String(year)];
  return v != null ? Number(v) : null;
}

export const PHL_PALETTE = [
  '#e25034', // Scarlet (first ink)
  '#1d3da8', // Cobalt (second ink)
  '#e8b94a', // Ochre
  '#3a5a3a', // Forest
  '#c33d22', // Scarlet deep
  '#15307f', // Cobalt deep
  '#a8842f', // Ochre deep
  '#2a4226', // Forest deep
];

export const EXP_CLASS_COLORS = {
  'Personnel Services':                         '#e25034',
  'Maintenance and Other Operating Expenses':   '#e8b94a',
  'MOOE':                                       '#e8b94a',
  'Capital Outlays':                            '#1d3da8',
  'Capital Outlay':                             '#1d3da8',
  'Financial Expenses':                         '#3a5a3a',
};

// Fixed color lookups for the Overview view so the same category gets
// the same Riso ink every fiscal year. The per-year summary JSON files
// each ship their own (legacy iris-era) color in b.color, which is why
// the bar/donut palette used to drift from year to year — these maps
// override that.
export const ECON_CATEGORY_COLORS = {
  'Wages & Personnel':  '#1d3da8',
  'Operations (MOOE)':  '#e8b94a',
  'Capital Outlays':    '#e25034',
  'Debt Service':       '#3a5a3a',
  'Transfers to LGUs':  '#c33d22',
  'MOOE':               '#e8b94a',
  'Capital Outlay':     '#e25034',
};

export const FN_CATEGORY_COLORS = {
  'Education':                  '#1d3da8',
  'Health':                     '#e25034',
  'Infrastructure & Transport': '#e8b94a',
  'Social Protection':          '#c33d22',
  'Public Order & Safety':      '#15307f',
  'Defense':                    '#2a4226',
  'Agriculture & Environment':  '#3a5a3a',
  'Other Economic Affairs':     '#a8842f',
  'Housing & Community':        '#b35a1e',
  'Debt Service':               '#7a6a4c',
  'Transfers to LGUs':          '#c33d22',
  'General Public Services':    '#7a8030',
  'Multi-sector / Other':       '#c8b988',
};

export function econColorFor(name, fallback) {
  return ECON_CATEGORY_COLORS[name] || fallback || '#1d3da8';
}
export function fnColorFor(name, fallback) {
  return FN_CATEGORY_COLORS[name] || fallback || '#1d3da8';
}

// --- Status color tokens ----------------------------------------------------

// Status colors — bright, contemporary; distinct from the PHL flag triad.
export const STATUS_COLORS = {
  loading: '#e8b94a',  // Ochre
  ok:      '#3a5a3a',  // Forest
  error:   '#e25034',  // Scarlet
  info:    '#1d3da8',  // Cobalt
};

// Brand colors — for chrome only (active states, primary CTAs, focus rings).
// PHL_PALETTE remains the chart-series semantic palette.
export const BRAND_COLORS = {
  primary:     '#e25034',  // Scarlet - active states, primary CTAs
  primaryDeep: '#c33d22',  // hover/pressed
  primarySoft: '#f5d3c9',  // soft tint backgrounds
  canvas:      '#f1e8d2',  // paper
  peach:       '#ece1c3',  // paper-soft
  peachDeep:   '#d8c8a0',
  pinkBlush:   '#f5d3c9',
  linenEdge:   '#c8b988',
  linenMist:   '#e6d8b3',
};

// --- Trend chip --------------------------------------------------------------

// Returns HTML for a small trend chip — mint for positive deltas, coral for negative.
// Used on KPI cards to show year-over-year change.
//
// Usage in a template literal:
//   ${trendChip(0.042, { suffix: '%', label: 'vs FY2025' })}
//
// Options:
//   - suffix: string appended after the value (default '%')
//   - decimals: number of decimal places (default 1)
//   - label: optional small descriptor appended after the value (e.g. 'vs FY2025')
//   - asPercent: if true, multiplies value by 100 before formatting (default true)
export function trendChip(value, opts = {}) {
  if (value == null || isNaN(value)) return '';
  const decimals  = opts.decimals  ?? 1;
  const suffix    = opts.suffix    ?? '%';
  const asPercent = opts.asPercent ?? true;
  const label     = opts.label;

  const v = asPercent ? Number(value) * 100 : Number(value);
  const positive = v >= 0;
  const arrow = positive ? '↑' : '↓';
  const cls   = positive ? 'trend-chip-mint' : 'trend-chip-coral';
  const num   = Math.abs(v).toFixed(decimals);
  const text  = `${arrow} ${positive ? '+' : '-'}${num}${suffix}`;

  return `<span class="trend-chip ${cls}" title="${label || ''}">${text}</span>`;
}

// --- Glossary ---------------------------------------------------------------

export const GLOSS = {
  UACS:  { full: 'Unified Accounts Code Structure',         desc: "DBM's standard chart of accounts for the national budget." },
  PREXC: { full: 'Program Expenditure Classification',      desc: 'Results-based budgeting hierarchy that ties appropriations to programs, activities, and projects.' },
  FPAP:  { full: 'Final Program / Activity / Project',      desc: 'The leaf identifier in the PREXC hierarchy.' },
  COFOG: { full: 'Classification of the Functions of Government', desc: "UN standard for classifying spending by purpose. This dashboard uses a 12-category 'COFOG-lite' adaptation." },
  AAs:   { full: 'Automatic Appropriations',                desc: "Appropriations authorised by standing law that don't go through the annual budget cycle — debt service, NTA/IRA, RLIP, and similar." },
  SPFs:  { full: 'Special Purpose Funds',                   desc: 'Lump-sum allocations for specific national purposes — Calamity Fund, Contingent Fund, Pension and Gratuity Fund, etc.' },
  NTA:   { full: 'National Tax Allotment',                  desc: 'The post-2022 share of national taxes transferred to LGUs. Replaced IRA after the 2018 Mandanas-Garcia Supreme Court ruling.' },
  IRA:   { full: 'Internal Revenue Allotment',              desc: 'The pre-2022 name for what is now the National Tax Allotment (NTA).' },
  GAA:   { full: 'General Appropriations Act',              desc: 'The annual national budget law signed by the President each fiscal year.' },
  DBM:   { full: 'Department of Budget and Management',     desc: 'Executive department that prepares and issues the GAA.' },
  PS:    { full: 'Personnel Services',                      desc: 'Salaries, wages, allowances, and contributions for government personnel.' },
  MOOE:  { full: 'Maintenance and Other Operating Expenses', desc: 'Operating costs other than personnel and capital: supplies, utilities, repairs, training.' },
  CO:    { full: 'Capital Outlays',                         desc: 'Spending that creates or improves physical assets: buildings, equipment, infrastructure.' },
  FE:    { full: 'Financial Expenses',                      desc: 'Interest payments, bank charges, and other costs of financing government operations.' },
  HUC:   { full: 'Highly Urbanized City',                   desc: 'An LGU classification for cities outside provincial supervision (e.g. Manila, Quezon City, Davao, Cebu).' },
  NCR:   { full: 'National Capital Region',                 desc: 'Metropolitan Manila: the seat of national government.' },
  BARMM: { full: 'Bangsamoro Autonomous Region in Muslim Mindanao', desc: 'Autonomous region established in 2019; receives a block grant separate from the NTA.' },
  RLIP:  { full: 'Retirement and Life Insurance Premiums',  desc: 'Government share of GSIS contributions for personnel; an automatic appropriation.' },
  NGA:   { full: 'New General Appropriations (umbrella entry)', desc: 'A DBM source-data umbrella for items being appropriated fresh in the current GAA that are not tied to a single line department. In practice it holds Special Purpose Funds (Calamity Fund, Contingent Fund, Pension and Gratuity Fund, etc.) and miscellaneous cross-cutting items. Distinct from Automatic Appropriations (legally mandated, no annual action needed) and Continuing Appropriations (carried over from prior years).' },
  CA:    { full: 'Continuing Appropriations',               desc: 'Appropriations from a prior year that remain available for obligation in the current year. Distinct from New General Appropriations (current-year items) and Automatic Appropriations (legally mandated).' },
  BSGC:  { full: 'Budgetary Support to Government Corporations', desc: 'Subsidies and equity contributions from the national budget to government-owned and -controlled corporations (GOCCs).' },
  Allocators: { full: 'Allocators (departments and offices)', desc: 'Departments, offices, and umbrella categories that hold appropriations under the GAA. Includes line departments (DepEd, DPWH, etc.), constitutional bodies (the Judiciary, Congress), and DBM umbrella entries (Automatic Appropriations, New General Appropriations, Budgetary Support to Government Corporations).' },
  'Fund sub-category': { full: 'Fund sub-category (UACS funding source)', desc: 'A sub-classification of the funding source within UACS, distinguishing for example new appropriations, continuing appropriations, automatic appropriations, special purpose funds, and unprogrammed funds.' },
  NEP:   { full: 'National Expenditure Program',             desc: 'The executive proposal for the annual budget that DBM submits to Congress. Congress amends it and enacts the GAA.' },
  FERB:  { full: 'Final Executive Reference Budget',         desc: 'The final NEP layer DBM transmits with the proposed GAA — the version Congress receives for deliberation.' },
  OSEC:  { full: 'Office of the Secretary',                  desc: "The central administration line of a department, separate from its bureaus and attached agencies. Most large appropriations sit here." },
  PhilHealth: { full: 'Philippine Health Insurance Corporation', desc: 'GOCC running the National Health Insurance Program; receives subsidy through BSGC.' },
  MAIFIP: { full: 'Medical Assistance to Indigent and Financially-Incapacitated Patients', desc: 'DOH program providing direct medical-bill assistance through hospitals and field offices.' },
  NSCR:  { full: 'North-South Commuter Railway',             desc: 'Foreign-financed (ADB + JICA) commuter rail project under DOTr; one of the largest single program lines in the budget.' },
  MMSP:  { full: 'Metro Manila Subway Project',              desc: 'JICA-financed underground rail project under DOTr; Phase I appears as a separate appropriation line.' },
  MPBF:  { full: 'Miscellaneous Personnel Benefits Fund',    desc: 'Special-purpose fund used to pay personnel benefits — staffing modifications, salary adjustments, and other items not yet placed in agency budgets.' },
  MVUC:  { full: "Motor Vehicle User's Charge",              desc: 'A road-user fee, earmarked under R.A. 11239 for road maintenance. Funds the DPWH Special Road Fund.' },
  BIP:   { full: 'Basic Infrastructure Program',             desc: 'DPWH portfolio of small infrastructure (multi-purpose buildings, access roads/bridges) typically tied to congressional districts.' },
  SIPAG: { full: 'Sustainable Infrastructure Projects Alleviating Gaps', desc: 'DPWH portfolio of access roads/bridges connecting national roads to public buildings and facilities.' },
  LGSF:  { full: 'Local Government Support Fund',            desc: 'Fund channeling national-government financial assistance to LGUs — formerly known as Financial Subsidy to LGUs.' },
  // Function category descriptions (COFOG-lite). Used by the timeline functional
  // breakdown chart and any view that exposes a per-function tooltip. Each desc
  // lists the actual line items that fall under the function, drawn from the
  // dept/agency/program mappings in etl/cofog_map.py. The keys match the raw
  // function names emitted by refresh_summary.py so chart legends can use them
  // as data-term spans directly.
  'Wages & Personnel': { full: 'Wages & Personnel', desc: 'The Personnel Services (PS) economic class plus the Retirement and Life Insurance Premiums (RLIP) automatic appropriation. Captures salaries, allowances, premium contributions, and similar compensation for government personnel across the GAA.' },
  'Capital Outlays': { full: 'Capital Outlays', desc: 'The Capital Outlays (CO) economic class. Spending that creates or improves physical assets: buildings, roads, ICT systems, equipment, vehicles. Distinct from Maintenance and Other Operating Expenses (MOOE), which funds the running costs of those assets.' },
  'Education': { full: 'Education', desc: 'DepEd (basic ed, K-12), the State Universities and Colleges (SUCs), CHED (higher ed), TESDA (technical-vocational). Also folds in culture/heritage agencies: NCCA, National Library, National Museum, National Historical Commission, Cultural Center of the Philippines, Philippine Sports Commission, Film Development Council.' },
  'Health': { full: 'Health', desc: 'DOH (Office of the Secretary, hospitals, regional offices, MAIFIP), the specialty centers (Philippine Heart Center, Lung Center, National Kidney and Transplant Institute, Philippine Children\u2019s Medical Center), PhilHealth premium subsidy, Population/Commission on Population and Development, Food and Nutrition Research Institute.' },
  'Defense': { full: 'Defense', desc: 'DND (Office of the Secretary, AFP-wide HQ, Philippine Army, Philippine Navy, Philippine Air Force, GHQ-AFPWSSUs, Office of Civil Defense, Veterans Affairs). Also AFP Modernization Program and NICA / National Security Council where present.' },
  'Public Order & Safety': { full: 'Public Order & Safety', desc: 'DILG (PNP, BFP, BJMP, PPSC, LGA, NAPOLCOM, DILG-OSEC), Department of Justice (NBI, PAO, public prosecution, BuCor, BI, OGCC), the Judiciary, Office of the Ombudsman, PDEA, Dangerous Drugs Board, Office of the Presidential Adviser on Peace, Reconciliation and Unity, Anti-Money Laundering Council.' },
  'Infrastructure & Transport': { full: 'Infrastructure & Transport', desc: 'DPWH (national roads/bridges, BIP, SIPAG, MVUC-funded roadworks, flood control). DOTr (Office of the Secretary, MRT-3 / NSCR / MMSP rail projects, Land Transportation Office, Maritime Industry Authority, Civil Aviation Authority of the Philippines). Plus LRTA, PNR, Bases Conversion and Development Authority.' },
  'Agriculture & Environment': { full: 'Agriculture & Environment', desc: 'Department of Agriculture (Office of the Secretary, regional offices, banner programs like rice, livestock, fisheries), Department of Agrarian Reform, DENR. Attached agencies: National Irrigation Administration, National Food Authority, Philippine Crop Insurance Corporation, Philippine Coconut Authority, National Dairy Authority, PAGASA, PHIVOLCS, Climate Change Commission, Forest Products Research and Development Institute.' },
  'Other Economic Affairs': { full: 'Other Economic Affairs', desc: 'DTI, Department of Tourism, Department of Energy, DOST (most institutes), DICT, DOLE, Department of Migrant Workers. Plus BSGC subsidies to economic GOCCs (National Electrification Administration, National Power Corp., PSALM, Philippine Postal Corporation, Tourism Promotions Board, Philippine Space Agency, etc.).' },
  'Housing & Community': { full: 'Housing & Community', desc: 'Department of Human Settlements and Urban Development (DHSUD), National Housing Authority, Social Housing Finance Corporation. Excludes the housing GOCCs (Pag-IBIG) when they are not budgetarily supported.' },
  'Social Protection': { full: 'Social Protection', desc: 'DSWD (4Ps / Pantawid Pamilyang Pilipino Program, Social Pension, Sustainable Livelihood Program, Protective Services), Pension and Gratuity Fund (military and civilian retirees), National Commission on Indigenous Peoples, National Anti-Poverty Commission, Marawi Compensation Board, National Youth Commission, Presidential Commission for the Urban Poor, Commission on Filipinos Overseas.' },
  'General Public Services': { full: 'General Public Services', desc: 'Office of the President, Office of the Vice President, Department of Finance, DBM, Department of Foreign Affairs, Department of Economy, Planning and Development (formerly NEDA), Congress, the constitutional commissions (COA, COMELEC, CSC, CHR), and special-purpose funds for general management (Calamity Fund, Contingent Fund, Miscellaneous Personnel Benefits Fund, Tax Expenditure Fund). Includes the residual line in Automatic Appropriations that is not debt service or transfers to LGUs (e.g. RLIP).' },
  'Debt Service': { full: 'Debt Service', desc: 'Interest payments on national-government debt - the Payment of Interest on Foreign and Domestic Indebtedness automatic appropriation. Net Lending to GOCCs is also included. Principal repayment is NOT in the GAA - it is funded from the separate financing program.' },
  'Transfers to LGUs': { full: 'Transfers to LGUs', desc: 'Broader than just NTA/IRA. Includes: (1) National Tax Allotment - the post-Mandanas-Garcia (FY2022+) share of national taxes, called Internal Revenue Allotment pre-2022; (2) BARMM Annual Block Grant under the Bangsamoro Organic Law; (3) Special Shares of LGUs in national tax collections; (4) Local Government Support Fund / Financial Assistance to LGUs (LGSF); (5) LGU share in the Tobacco Excise Tax; (6) LGU share in national-wealth utilization (R.A. 7160 Sec. 290); (7) Growth Equity Fund (equalization transfer for fiscally weak LGUs); (8) Disaster Rehabilitation and Reconstruction Assistance Program for LGUs. NTA/IRA is typically 85-90% of the total in any given year.' },
  'Multi-sector / Other': { full: 'Multi-sector / Other', desc: 'Items that do not cleanly map to a single sector: Unprogrammed Appropriations, Priority Development Assistance Fund (historical), Economic Stimulus Fund, General Fund Adjustments, the ARMM / BARMM block-grant operating budget (separate from the explicit Transfers-to-LGUs line), and a few cross-cutting Special Purpose Funds.' },

  Reshuffle: {
    full: 'Line-item adjustment ratio',
    desc: 'Share of NEP that Congress changed at the line-item level. Each line item is a unique combination of department × agency × program × region × fund × expense class × object code. For every line item, we take the absolute difference between NEP and GAA, sum across all line items, halve it (because every peso added to one item came from a cut elsewhere — matched pairs), and divide by total NEP. We subtract any net top-line change first, so the figure reports only the within-envelope reshuffling, not the headline movement. Two finer measures are available in the deck: program-level reshuffle (only counts movement between programs, ignoring within-program changes) and department-level (only counts movement between departments).',
  },
};

// Wrap an element in a custom hover tooltip showing GLOSS[term].full + desc.
// Element must have data-term="<KEY>" matching a GLOSS key. Idempotent.
//
// Custom tooltip (not native title) so the appearance matches the design system:
// no OS chrome, no 1-second delay, bond-paper styling.
let _glossTipEl = null;
function ensureGlossTip() {
  if (_glossTipEl) return _glossTipEl;
  _glossTipEl = document.createElement('div');
  _glossTipEl.id = 'gloss-tooltip';
  _glossTipEl.setAttribute('role', 'tooltip');
  _glossTipEl.style.cssText = 'position:fixed;z-index:9999;max-width:300px;padding:10px 12px;background:#0F172A;color:#FAFAF7;border-radius:10px;font-family:Inter,system-ui,sans-serif;font-size:12px;line-height:1.45;letter-spacing:-0.005em;box-shadow:0 8px 24px -8px rgba(15,23,42,0.35),0 2px 6px rgba(15,23,42,0.18);opacity:0;pointer-events:none;transition:opacity 0.12s ease;text-transform:none;';
  document.body.appendChild(_glossTipEl);
  return _glossTipEl;
}

function showGlossTip(target, term, entry) {
  const tip = ensureGlossTip();
  tip.innerHTML = `<div style="font-weight:700;font-size:12.5px;margin-bottom:3px;color:#f1e8d2;">${term}: ${entry.full}</div><div style="color:#CBD5E1;">${entry.desc}</div>`;
  // Position above the target if there's room, else below.
  const r = target.getBoundingClientRect();
  // Make visible to measure height.
  tip.style.opacity = '0';
  tip.style.left = '-9999px';
  tip.style.top  = '0px';
  tip.style.opacity = '1';
  // Re-measure after reflow.
  requestAnimationFrame(() => {
    const tr  = tip.getBoundingClientRect();
    const gap = 8;
    let left  = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    let top   = r.top - tr.height - gap;
    if (top < 8) top = r.bottom + gap; // flip below if no room above
    tip.style.left = left + 'px';
    tip.style.top  = top  + 'px';
  });
}

function hideGlossTip() {
  if (_glossTipEl) {
    _glossTipEl.style.opacity = '0';
    _glossTipEl.style.pointerEvents = 'none';
    setTimeout(() => {
      if (_glossTipEl && _glossTipEl.style.opacity === '0') _glossTipEl.style.left = '-9999px';
    }, 200);
  }
}

export function mountGloss(rootEl) {
  if (!rootEl) return;
  const els = rootEl.querySelectorAll('[data-term]:not([data-gloss-mounted])');
  els.forEach(el => {
    const term = el.dataset.term;
    const entry = GLOSS[term];
    if (!entry) return;
    el.setAttribute('data-gloss-mounted', '1');
    el.setAttribute('tabindex', '0');
    el.classList.add('gloss');
    // aria-label kept for assistive tech; native title removed (custom tooltip replaces).
    el.setAttribute('aria-label', `${term}: ${entry.full}. ${entry.desc}`);
    el.removeAttribute('title');
    el.addEventListener('mouseenter', () => showGlossTip(el, term, entry));
    el.addEventListener('mouseleave', hideGlossTip);
    el.addEventListener('focus',      () => showGlossTip(el, term, entry));
    el.addEventListener('blur',       hideGlossTip);
  });
}

// --- Chart export affordance ------------------------------------------------

// Check whether an ECharts instance has rendered data (not just background).
function chartHasData(chart) {
  if (!chart || typeof chart.getOption !== 'function') return false;
  try {
    const opt = chart.getOption();
    if (!opt) return false;
    if (Array.isArray(opt.series)) {
      for (const s of opt.series) {
        if (s && Array.isArray(s.data) && s.data.length > 0) return true;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

// Export a chart as a PNG with a 'publikoph.org' watermark in the bottom-right.
// Uses ECharts' 'finished' event so we capture only after the chart's last
// render completes — fixes blank captures and missing labels on Overview's
// donut/bar charts where labels paint after the data series.
async function exportChartPng(chart, filename) {
  // 1. Make sure the chart has data; if not, give it a moment and re-check.
  if (!chartHasData(chart)) {
    await new Promise(r => setTimeout(r, 250));
    if (!chartHasData(chart)) throw new Error('Chart has no series data yet');
  }
  // 2. Wait for ECharts to signal a finished render. We force a resize to
  //    trigger a fresh render, then resolve on the next 'finished' event.
  //    Fallback timeout so we never hang if no render is scheduled.
  await new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chart.off && chart.off('finished', finish); } catch (_) {}
      resolve();
    };
    try {
      if (chart.on) chart.on('finished', finish);
    } catch (_) {}
    if (typeof chart.resize === 'function') chart.resize();
    // Belt-and-braces: also wait two animation frames + a 700ms cap
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimeout(finish, 700);
    }));
  });

  // 3. Capture the chart at 2x pixel ratio against the paper background.
  const baseUrl = chart.getDataURL({ pixelRatio: 2, backgroundColor: '#ece1c3' });

  // 4. Load into an Image to get dimensions, then composite a watermark.
  const img = new Image();
  img.src = baseUrl;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Failed to load captured chart image'));
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  // 5. Watermark — small mono caps, muted ink, bottom-right corner.
  const baseFont = Math.max(10, Math.round(Math.min(canvas.width, canvas.height) / 70));
  const fontPx = baseFont * 2; // already on a 2x canvas, scale so it reads ~10pt on screen
  ctx.font = `600 ${fontPx}px 'Space Mono', ui-monospace, monospace`;
  ctx.fillStyle = 'rgba(26, 22, 17, 0.55)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const pad = Math.max(12, Math.round(canvas.width / 80));
  ctx.fillText('publikoph.org', canvas.width - pad, canvas.height - pad);

  // 6. Trigger download via a Blob (more reliable than a data: URL for large charts).
  await new Promise(resolve => {
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      resolve();
    }, 'image/png');
  });
}

// Inject Copy table / Download CSV / Download PNG actions in the top-right of a chart card.
// Pass the DOM element of the card body container, plus a getter for the rows
// and (optionally) the chart instance for PNG export.
//
// Usage:
//   mountChartActions(cardHeaderEl, {
//     getRows:   () => [{ name: '...', amount_thousands: 12345 }, ...],
//     columns:   ['name', 'amount_thousands'],   // order matters
//     csvName:   'top-departments-fy2026',
//     chart:     echartsInstance,                 // optional, enables PNG
//     pngName:   'top-departments-fy2026',
//   });
//
// Idempotent: re-mounting on the same element replaces the existing cluster.
export function mountChartActions(headerEl, opts) {
  if (!headerEl || !opts) return;
  const existing = headerEl.querySelector('.chart-actions');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.className = 'chart-actions';
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-left:8px;';

  const mkBtn = (label, svg, handler) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.className = 'chart-action-btn';
    b.innerHTML = svg;
    b.addEventListener('click', handler);
    return b;
  };

  const ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const ICON_CSV  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
  const ICON_PNG  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

  const rowsToCSV = (rows, cols) => {
    const head = cols.join(',');
    const body = rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\n');
    return head + '\n' + body;
  };
  const rowsToTSV = (rows, cols) => {
    const head = cols.join('\t');
    const body = rows.map(r => cols.map(c => String(r[c] ?? '')).join('\t')).join('\n');
    return head + '\n' + body;
  };
  const csvCell = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const downloadBlob = (data, name, mime) => {
    const blob = new Blob([data], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const flash = (btn, msg) => {
    const orig = btn.title;
    btn.title = msg;
    btn.classList.add('chart-action-flash');
    setTimeout(() => { btn.title = orig; btn.classList.remove('chart-action-flash'); }, 1100);
  };

  const cols = opts.columns || [];
  const csvName = opts.csvName || 'export';

  const copyBtn = mkBtn('Copy table (TSV)', ICON_COPY, async () => {
    const rows = (opts.getRows && opts.getRows()) || [];
    const tsv  = rowsToTSV(rows, cols);
    try { await navigator.clipboard.writeText(tsv); flash(copyBtn, 'Copied'); }
    catch { flash(copyBtn, 'Copy failed'); }
  });
  wrap.appendChild(copyBtn);

  const csvBtn = mkBtn('Download CSV', ICON_CSV, () => {
    const rows = (opts.getRows && opts.getRows()) || [];
    const csv  = rowsToCSV(rows, cols);
    downloadBlob(csv, csvName + '.csv', 'text/csv;charset=utf-8;');
    flash(csvBtn, 'Downloaded');
  });
  wrap.appendChild(csvBtn);

  if (opts.chart) {
    const pngBtn = mkBtn('Download PNG', ICON_PNG, async () => {
      try {
        await exportChartPng(opts.chart, opts.pngName || csvName);
        flash(pngBtn, 'Downloaded');
      } catch (e) {
        console.error('PNG export failed:', e);
        flash(pngBtn, 'Not ready — try again');
      }
    });
    wrap.appendChild(pngBtn);
  }

  if (opts.extra && Array.isArray(opts.extra)) {
    for (const ex of opts.extra) {
      const eb = mkBtn(ex.label, ex.icon || ICON_COPY, ex.onClick);
      wrap.appendChild(eb);
    }
  }

  headerEl.appendChild(wrap);
}

// --- Shared chart resize observer -------------------------------------------

// Shared chart-resize observer. Re-using a single instance per session avoids
// listener leaks from per-render registration.
let _chartResizeObserver = null;
const _observedCharts = new WeakMap(); // dom el -> echarts instance

export function observeChartResize(domEl, chartInstance) {
  if (!domEl || !chartInstance) return;
  if (!_chartResizeObserver) {
    _chartResizeObserver = new ResizeObserver((entries) => {
      for (const e of entries) {
        const inst = _observedCharts.get(e.target);
        if (inst && !inst.isDisposed()) inst.resize();
      }
    });
  }
  _observedCharts.set(domEl, chartInstance);
  _chartResizeObserver.observe(domEl);
}

// --- Number tick animation -------------------------------------------------

// Animate a numeric KPI value from `from` to `to` over `durationMs`.
// `formatter` formats each interpolated number (defaults to identity).
// Respects prefers-reduced-motion (jumps directly to final value).
//
// Usage:
//   tickNumber(document.getElementById('total'), 6280000, 6360000, {
//     durationMs: 350,
//     formatter:  (v) => fmtPHP(v),
//   });
export function tickNumber(el, fromValue, toValue, opts = {}) {
  if (!el) return;
  const durationMs = opts.durationMs ?? 350;
  const formatter  = opts.formatter  ?? ((v) => String(Math.round(v)));

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || durationMs <= 0) {
    el.textContent = formatter(toValue);
    return;
  }

  const from = Number(fromValue);
  const to   = Number(toValue);
  if (!isFinite(from) || !isFinite(to)) {
    el.textContent = formatter(toValue);
    return;
  }

  const start = performance.now();
  const ease  = (t) => 1 - Math.pow(1 - t, 4);  // ease-out-quart, matches DESIGN.md motion guidance

  function frame(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const v = from + (to - from) * ease(t);
    el.textContent = formatter(v);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// --- Empty-state helper ----------------------------------------------------

// Returns HTML for a friendly empty-state block. Use when a view or chart
// has no data to render but is otherwise healthy (filter excluded everything,
// no matching rows, etc.).
//
// Usage in a template literal:
//   ${emptyState({
//     title: 'No matching rows',
//     body:  'Try removing a filter or widening the Top N range.',
//   })}
export function emptyState({ title, body, iconSvg } = {}) {
  const icon = iconSvg || '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>';
  return `
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      ${title ? `<div class="empty-state-title">${escapeHtml(title)}</div>` : ''}
      ${body  ? `<div class="empty-state-body">${escapeHtml(body)}</div>`   : ''}
    </div>
  `;
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

// --- Chart lifecycle helper ------------------------------------------------

// Initialize an ECharts instance on a DOM element, safely disposing any
// prior instance bound to the same element first. Mirrors ECharts' native
// init signature: (domEl, theme, opts).
//
// Usage:
//   const cBar = createChart(document.getElementById('chart-x'));
//   const cMap = createChart(mapEl, null, { renderer: 'svg' });
export function createChart(domEl, theme, opts) {
  if (!domEl) return null;
  if (typeof echarts === 'undefined') return null;
  // Dispose any prior instance bound to this element.
  const prior = echarts.getInstanceByDom(domEl);
  if (prior && !prior.isDisposed()) {
    prior.dispose();
  }
  return echarts.init(domEl, theme, opts);
}
