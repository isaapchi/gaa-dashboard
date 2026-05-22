// Router + view orchestration.

import { loadSummary, getYears, setCurrentYear, getCurrentYear, STATUS_COLORS, coverageFor, coverageMeta, COVERAGE_META } from './data.js';
import { renderDepartments } from './views/departments.js';
import { renderRegions }     from './views/regions.js';
import { renderExpense }     from './views/expense.js';
import { renderExplorer }    from './views/explorer.js';
import { renderDeptDetail }  from './views/dept-detail.js';
import { renderGlance }      from './views/glance.js';
import { renderTimeline }    from './views/timeline.js';
import { renderCompare }     from './views/compare.js';
import { renderAbout }       from './views/about.js';

const LOADING_COPY = {
  overview:    'Composing the FY{year} fiscal-space view',
  glance:      'Composing the FY{year} fiscal-space view',  // alias for backward-compat URLs
  timeline:    'Stitching FY2020 through FY{year}',
  departments: 'Indexing departments and agencies',
  dept:        'Loading allocation detail',
  regions:     'Mapping regional allocations',
  expense:     'Breaking down by expense class',
  compare:     'Reconciling NEP{year} against the enacted GAA',
  explorer:    'Preparing the query engine',
  about:       'Loading sources and caveats',
};

const VIEWS = {
  // The Overview view (formerly two pages — "Overview" and "At a Glance" — was
  // merged 2026-05-04). Both #overview and #glance hash routes resolve to the
  // same merged renderer; #glance kept as alias for URL backward compatibility.
  overview:    { title: 'Overview',                   render: renderGlance,      nav: 'overview' },
  glance:      { title: 'Overview',                   render: renderGlance,      nav: 'overview' },
  timeline:    { title: 'Across Time',                render: renderTimeline,    nav: 'timeline' },
  departments: { title: 'Allocations',                render: renderDepartments, nav: 'departments' },
  regions:     { title: 'By Region',                  render: renderRegions,     nav: 'regions' },
  expense:     { title: 'Expense Class',              render: renderExpense,     nav: 'expense' },
  compare:     { title: 'Compare',                    render: renderCompare,     nav: 'compare', supportedYears: [2015, 2016, 2017, 2018, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  explorer:    { title: 'Explorer',                   render: renderExplorer,    nav: 'explorer' },
  about:       { title: 'About',                      render: renderAbout,       nav: 'about' },
  dept:        { title: 'Allocation detail',          render: renderDeptDetail,  nav: 'departments', dynamic: true },
};

// Keyboard shortcut: digit index → view name (1-indexed).
const KBD_VIEW_ORDER = ['overview', 'timeline', 'departments', 'regions', 'expense', 'compare', 'explorer', 'about'];

// Update the kicker that sits above the (visually hidden) page title.
//   - Across Time spans years and About is data-quality / methodology, so the
//     kicker is suppressed on those views.
//   - Every other view shows 'FY <year> General Appropriations Act'.
function updatePageKicker(view, year) {
  const el = document.getElementById('page-kicker');
  if (!el) return;
  if (view === 'timeline' || view === 'about') {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  el.textContent = `FY ${year} General Appropriations Act`;
}

function setNavActive(navKey) {
  // The 'View' dropdown groups four sub-views; mark its trigger active
  // when any of them is the current view, and also mark the menu item.
  const VIEW_SUBITEMS = new Set(['timeline', 'departments', 'regions', 'expense']);
  document.querySelectorAll('#nav .nav-item').forEach(el => {
    let active;
    if (el.classList.contains('nav-dropdown')) {
      active = VIEW_SUBITEMS.has(navKey);
    } else {
      active = el.dataset.view === navKey;
    }
    el.classList.toggle('nav-active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  document.querySelectorAll('#nav .nav-dropdown-menu > a').forEach(el => {
    el.classList.toggle('nav-active', el.dataset.view === navKey);
  });
}

function parseHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  if (!raw) return { view: 'overview', arg: null };
  const [view, ...rest] = raw.split('/');
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
  return { view, arg };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/**
 * Render a plain-language error card into `root`.
 * Detects context from err.message, shows a collapsible stack trace,
 * and wires a "Show / Hide technical details" toggle button.
 */
function renderError(root, err) {
  console.error(err);

  const msg = (err && err.message) ? err.message.toLowerCase() : '';
  let heading, body;

  if (msg.includes('parquet')) {
    heading = `Couldn't load the budget data`;
    body    = `The FY${getCurrentYear()} GAA file isn't available in the dashboard yet, or the request was blocked. Try a different year, or refresh the page in a moment.`;
  } else if (msg.includes('duckdb') || msg.includes('wasm')) {
    heading = `The data engine couldn't start`;
    body    = `DuckDB-WASM failed to initialise. Refresh the page; if the problem persists, check the browser console for details.`;
  } else if (msg.includes('fetch') || msg.includes('http')) {
    heading = `Couldn't reach a data file`;
    body    = `A required data file didn't load. The dashboard runs on a static server: confirm the python -m http.server is still running.`;
  } else {
    heading = `Something went wrong rendering this view`;
    body    = `Try switching to another view, or refresh the page.`;
  }

  const stackText = escapeHtml(String(err && err.stack ? err.stack : err));

  root.innerHTML = `
<div class="card p-6 max-w-2xl">
  <div class="flex items-start gap-3">
    <span class="w-2 h-2 rounded-full mt-2.5 shrink-0" style="background: var(--status-error, #FF6B6B);"></span>
    <div class="flex-1 min-w-0">
      <div class="font-display font-bold text-base text-ink-900 mb-1">${escapeHtml(heading)}</div>
      <div class="text-sm text-ink-700 leading-relaxed">${escapeHtml(body)}</div>
      <div class="mt-4 flex items-center gap-2">
        <button class="btn" onclick="location.reload()">Reload page</button>
        <button class="btn-ghost btn" id="err-details-toggle">Show technical details</button>
      </div>
      <details class="mt-3" id="err-details" style="display:none;">
        <summary class="text-xs text-ink-500 cursor-pointer hover:text-ink-700">Stack trace</summary>
        <pre class="mt-2 p-3 text-xs text-ink-700" style="background:#FAFAF7;border:1px solid #E9E9DF;border-radius:10px;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto;max-height:300px;">${stackText}</pre>
      </details>
    </div>
  </div>
</div>`;

  // Wire toggle button after insertion.
  const toggle  = root.querySelector('#err-details-toggle');
  const details = root.querySelector('#err-details');
  if (toggle && details) {
    toggle.addEventListener('click', () => {
      const visible = details.style.display !== 'none';
      details.style.display = visible ? 'none' : 'block';
      toggle.textContent = visible ? 'Show technical details' : 'Hide technical details';
    });
  }
}

async function navigate(viewArg) {
  let view, arg;
  if (typeof viewArg === 'string') {
    const parts = viewArg.split('/');
    view = parts[0];
    arg = parts.length > 1 ? decodeURIComponent(parts.slice(1).join('/')) : null;
  } else {
    ({ view, arg } = parseHash());
  }
  if (!VIEWS[view]) view = 'overview';
  const meta = VIEWS[view];
  setNavActive(meta.nav);
  document.getElementById('page-title').textContent = meta.title;

  // Year controls only make sense on per-year views. On Across Time + About we
  // hide the *content* with visibility:hidden so the row keeps its height —
  // otherwise the nav above would shift down on those two pages. The row
  // itself stays in the layout flow.
  const yearControls = document.getElementById('year-controls');
  if (yearControls) {
    const hide = (view === 'timeline' || view === 'about');
    yearControls.style.visibility = hide ? 'hidden' : 'visible';
    yearControls.style.display = '';   // never collapse the row
  }

  // Per-view year scope: views can declare `supportedYears` on their VIEW entry.
  // Trim the selector to those years; if current year isn't supported,
  // auto-switch to the latest supported year before rendering.
  const yearSel = document.getElementById('year-select');
  if (yearSel) {
    const yp = await getYears();
    const allYears = yp.years || [];
    const supportedYears = meta.supportedYears || allYears;
    const supportedSet = new Set(supportedYears);
    const visibleYears = allYears.filter(y => supportedSet.has(y));
    // Plain "FY{year}" labels — coverage caveats live on the About page (#about → Data section).
    yearSel.innerHTML = visibleYears.map(y => `<option value="${y}">FY${y}</option>`).join('');
    let curYr = getCurrentYear();
    if (!supportedSet.has(curYr) && visibleYears.length) {
      curYr = visibleYears[visibleYears.length - 1];
      await setCurrentYear(curYr);
    }
    yearSel.value = String(curYr);
    updateCoverageChip(curYr);
  }

  const root = document.getElementById('view-root');
  const yr = getCurrentYear();
  const msg = (LOADING_COPY[view] || 'Loading').replace('{year}', yr);
  root.innerHTML = `<div class="flex items-center gap-3 text-ink-500 text-sm"><span class="spinner"></span>${msg}</div>`;
  try {
    await meta.render(root, arg);
  } catch (err) {
    renderError(root, err);
  }

  // Dynamic page title — timeline + about have no FY scope so omit the suffix.
  const yrSuffix = (view === 'timeline' || view === 'about') ? '' : ` — FY${getCurrentYear()}`;
  document.title = `${meta.title} · Halaga${yrSuffix}`;
  updatePageKicker(view, getCurrentYear());
  // Dynamic kicker over the page title — varies by view + year.
  const kicker = document.getElementById('page-kicker');
  if (kicker) {
    const yr = getCurrentYear();
    // 'timeline' (Across Time) and 'about' intentionally show no FY kicker.
    if (view === 'timeline' || view === 'about') {
      kicker.textContent = '';
      kicker.style.visibility = 'hidden';
    } else {
      kicker.textContent = `FY ${yr} General Appropriations Act`;
      kicker.style.visibility = 'visible';
    }
  }

  const newHash = '#' + view + (arg ? '/' + encodeURIComponent(arg) : '');
  if (location.hash !== newHash) history.replaceState(null, '', newHash);
}

// Coverage chip lives next to the year selector; mounted on first call, updated on year change.
function updateCoverageChip(year) {
  // Coverage chip suppressed by user request — coverage details are
  // documented on the About page (Data quality & coverage report).
  // Strip any stale chip from earlier session if it exists.
  const stale = document.getElementById('coverage-chip');
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
}

function setStatus(state, label) {
  const el = document.getElementById('data-status');
  const dot = el.querySelector('span:first-child');
  const txt = el.querySelector('span:last-child');
  txt.textContent = label;
  // Reset to base classes (size + shape only); colors via inline style for token discipline.
  dot.className = 'w-1.5 h-1.5 rounded-full shrink-0' + (state === 'loading' ? ' animate-pulse' : '');
  const colorMap = {
    loading: STATUS_COLORS.loading,
    ready:   STATUS_COLORS.ok,
    error:   STATUS_COLORS.error,
  };
  dot.style.background = colorMap[state] || '#94A3B8';
}

document.getElementById('year-select').addEventListener('change', async (e) => {
  const yr = Number(e.target.value);
  setStatus('loading', `Switching to FY${yr}…`);
  await setCurrentYear(yr);
  updateCoverageChip(yr);
  updatePageKicker((parseHash().view || 'overview'), yr);
  setStatus('ready', `FY${yr} loaded`);
  navigate();
});

document.getElementById('nav').addEventListener('click', (e) => {
  const a = e.target.closest('[data-view]');
  if (!a) return;
  e.preventDefault();
  navigate(a.dataset.view);
});

window.addEventListener('hashchange', () => {
  navigate();
});

(async () => {
  setStatus('loading', `Reading FY${getCurrentYear()} aggregates`);
  try {
    const summary = await loadSummary();
    setStatus('ready', `FY${summary.year} loaded`);
    const yearSel = document.getElementById('year-select');
    const yp = await getYears();
    yearSel.innerHTML = (yp.years || []).map(y => `<option value="${y}">FY${y}</option>`).join('');
    yearSel.value = String(getCurrentYear());
    updateCoverageChip(getCurrentYear());
  } catch (e) {
    console.error(e);
    setStatus('error', 'Data load failed');
  }
  navigate();
})();

// Tiny global helper for views to navigate without importing app.js
window.gotoDept = (deptName) => {
  location.hash = '#dept/' + encodeURIComponent(deptName);
};

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/**
 * Lazily build and return the keyboard-help overlay <div>.
 * Called on first `?` keypress; subsequent calls return the same node.
 */
function getKbdOverlay() {
  let overlay = document.getElementById('kbd-help-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'kbd-help-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Keyboard shortcuts');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'background:rgba(15,23,42,0.4)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'z-index:1000',
  ].join(';');

  overlay.innerHTML = `
<div class="card" id="kbd-help-card" style="max-width:440px;width:100%;padding:24px;border-radius:24px;">
  <div class="section-title" style="font-family:'Manrope',Inter,sans-serif;font-weight:700;font-size:18px;margin-bottom:16px;">Keyboard shortcuts</div>
  <table style="width:100%;border-collapse:collapse;font-size:13px;font-family:Inter,system-ui,sans-serif;">
    <tbody>
      <tr>
        <td style="padding:6px 0;vertical-align:top;width:120px;">
          <kbd style="display:inline-block;padding:2px 6px;border:1px solid #E9E9DF;border-radius:6px;background:#FAFAF7;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155;">1</kbd>
          &ndash;
          <kbd style="display:inline-block;padding:2px 6px;border:1px solid #E9E9DF;border-radius:6px;background:#FAFAF7;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155;">8</kbd>
        </td>
        <td style="padding:6px 0;color:#334155;">Switch view</td>
      </tr>
      <tr>
        <td style="padding:6px 0;vertical-align:top;">
          <kbd style="display:inline-block;padding:2px 6px;border:1px solid #E9E9DF;border-radius:6px;background:#FAFAF7;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155;">[</kbd>
          /
          <kbd style="display:inline-block;padding:2px 6px;border:1px solid #E9E9DF;border-radius:6px;background:#FAFAF7;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155;">]</kbd>
        </td>
        <td style="padding:6px 0;color:#334155;">Previous / next fiscal year</td>
      </tr>
      <tr>
        <td style="padding:6px 0;vertical-align:top;">
          <kbd style="display:inline-block;padding:2px 6px;border:1px solid #E9E9DF;border-radius:6px;background:#FAFAF7;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155;">?</kbd>
        </td>
        <td style="padding:6px 0;color:#334155;">Show / hide this overlay</td>
      </tr>
      <tr>
        <td style="padding:6px 0;vertical-align:top;">
          <kbd style="display:inline-block;padding:2px 6px;border:1px solid #E9E9DF;border-radius:6px;background:#FAFAF7;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155;">Esc</kbd>
        </td>
        <td style="padding:6px 0;color:#334155;">Close overlay or return from drilldown</td>
      </tr>
    </tbody>
  </table>
</div>`;

  // Clicking the dim background dismisses (with animation); clicking the inner card does not.
  overlay.addEventListener('click', (e) => {
    if (!document.getElementById('kbd-help-card').contains(e.target)) {
      toggleKbdOverlay();
    }
  });

  // Focus trap: cycle Tab/Shift-Tab within the dialog while it is visible.
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || overlay.style.display === 'none') return;
    const focusables = overlay.querySelectorAll('button, a, [tabindex="0"]');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last  = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  document.body.appendChild(overlay);
  return overlay;
}

/**
 * Show or hide the keyboard-help overlay.
 * Applies a scale+fade entrance/exit animation unless the user prefers reduced motion.
 */
function toggleKbdOverlay() {
  const overlay = getKbdOverlay();
  const inner   = overlay.querySelector('.card');
  const isHidden = overlay.style.display === 'none' || overlay.style.display === '';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (isHidden) {
    // Remember which element had focus so we can restore it on close.
    const prevFocusEl = document.activeElement;
    overlay.dataset.prevFocus = prevFocusEl ? (prevFocusEl.id || '__body__') : '__body__';

    // Show
    if (reduceMotion) {
      overlay.style.display = 'flex';
      if (inner) { inner.style.transform = 'scale(1)'; inner.style.opacity = '1'; }
      // Move focus into the overlay.
      requestAnimationFrame(() => {
        const focusable = overlay.querySelector('button, a, [tabindex="0"]');
        if (focusable) focusable.focus();
        else if (inner) { inner.setAttribute('tabindex', '-1'); inner.focus(); }
      });
      return;
    }
    if (inner) {
      inner.style.transition = 'transform 0.18s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.18s ease-out';
      inner.style.transform  = 'scale(0.96)';
      inner.style.opacity    = '0';
    }
    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
      if (inner) { inner.style.transform = 'scale(1)'; inner.style.opacity = '1'; }
      // Focus the first focusable element inside the overlay (the close affordance or body).
      requestAnimationFrame(() => {
        const focusable = overlay.querySelector('button, a, [tabindex="0"]');
        if (focusable) focusable.focus();
        else if (inner) { inner.setAttribute('tabindex', '-1'); inner.focus(); }
      });
    });
  } else {
    // Restore focus to the element that was active before the overlay opened.
    const prevId = overlay.dataset.prevFocus;
    if (prevId && prevId !== '__body__') {
      const el = document.getElementById(prevId);
      if (el && el.focus) el.focus();
    }

    // Hide
    if (reduceMotion) {
      overlay.style.display = 'none';
      return;
    }
    if (inner) {
      inner.style.transform = 'scale(0.96)';
      inner.style.opacity   = '0';
    }
    setTimeout(() => { overlay.style.display = 'none'; }, 180);
  }
}

/**
 * Guard: returns true when the event originated inside an interactive element
 * where keyboard shortcuts must not fire.
 */
function isInteractiveTarget(e) {
  const tag = e.target.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) return true;
  if (e.target.isContentEditable) return true;
  return false;
}

window.addEventListener('keydown', async (e) => {
  if (isInteractiveTarget(e)) return;

  // Digits 1–8: jump to view by index.
  if (e.key >= '1' && e.key <= '8') {
    const idx = Number(e.key) - 1;
    const viewName = KBD_VIEW_ORDER[idx];
    if (viewName) navigate(viewName);
    return;
  }

  // [ — previous fiscal year
  if (e.key === '[') {
    const yp = await getYears();
    const years = yp.years || [];
    const cur = getCurrentYear();
    const idx = years.indexOf(cur);
    if (idx > 0) {
      setStatus('loading', `Switching to FY${years[idx - 1]}…`);
      await setCurrentYear(years[idx - 1]);
      setStatus('ready', `FY${years[idx - 1]} loaded`);
      navigate();
    }
    return;
  }

  // ] — next fiscal year
  if (e.key === ']') {
    const yp = await getYears();
    const years = yp.years || [];
    const cur = getCurrentYear();
    const idx = years.indexOf(cur);
    if (idx !== -1 && idx < years.length - 1) {
      setStatus('loading', `Switching to FY${years[idx + 1]}…`);
      await setCurrentYear(years[idx + 1]);
      setStatus('ready', `FY${years[idx + 1]} loaded`);
      navigate();
    }
    return;
  }

  // ? — toggle keyboard help overlay
  if (e.key === '?') {
    toggleKbdOverlay();
    return;
  }

  // Escape — close overlay if visible, else return from dept drilldown
  if (e.key === 'Escape') {
    const overlay = document.getElementById('kbd-help-overlay');
    if (overlay && overlay.style.display === 'flex') {
      toggleKbdOverlay();
      return;
    }
    if (location.hash.startsWith('#dept/')) {
      navigate('departments');
    }
    return;
  }
});

// ---------------------------------------------------------------------------
// Console signature — developer easter egg, brand-appropriate.
// ---------------------------------------------------------------------------
console.log(
  '%cHalaga · Philippine Budget',
  'font: 700 14px/1.2 system-ui, sans-serif; color: #0F172A; background: #FBF8F3; padding: 6px 10px; border-radius: 6px; border: 1px solid #EFE9E0;',
);
console.log(
  '%cTagalog: value, worth. Source: DBM GAA. Press ? for keyboard shortcuts.',
  'font: 500 11px/1.4 system-ui; color: #64748B;',
);
