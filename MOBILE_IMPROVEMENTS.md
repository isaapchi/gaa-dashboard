# Mobile improvements backlog

Issues found during the perf/autoresearch visual review. Mobile-specific layout, alignment, and symmetry problems that exist *independently* of the optimization work — the perf branch didn't introduce them, but the review surfaced them.

Each item is annotated with the affected route(s), severity, and a one-line fix sketch. Add to this file as more issues surface.

---

## 1. Text concatenation: `ALLOCATORSTOTAL BUDGET`
- **Routes:** `#departments`
- **Severity:** bug, not styling
- **Observed:** the two labels above the search bar / total figure render as one run: `ALLOCATORSTOTAL BUDGET` — missing separator.
- **Fix sketch:** missing `gap`, ` `, or `·` between the two label spans, OR they're rendered in a flex row that wraps tighter on narrow viewports without a separator. Check `js/views/departments.js` label markup and the mobile breakpoint.

## 2. KPI grid is asymmetric on `#regions`
- **Routes:** `#regions`
- **Severity:** layout
- **Observed:** the page shows 3 stat cards (Regionally Allocated · Central Office · Central Share) in what looks like a 2×2 grid — the fourth cell is empty, breaking the rhythm against pages like `#expense` (which has a clean symmetric 2×2 of PS/MOOE/CO/FE).
- **Fix sketch:** either (a) make this a 1×3 vertical stack on mobile, (b) add a 4th meaningful stat (e.g., "Top region share"), or (c) center the third card under a 2-column grid.

## 3. Floating controls (`•`, `-`, `RESET`) under FILTER / GEOGRAPHY on `#regions`
- **Routes:** `#regions`
- **Severity:** alignment / discoverability
- **Observed:** above the regional map, three controls — a dot, a minus, and a "RESET" button — float at the right edge with no visible relationship to the labels around them. Looks unfinished.
- **Fix sketch:** label the dot/minus (probably zoom in / zoom out / reset-zoom), align all three to a single horizontal row with proper spacing, and either move into the map header or make a small toolbar above the map.

## 4. "SEQUENTIAL BLUE SCALE" pill placement on `#regions`
- **Routes:** `#regions`
- **Severity:** alignment
- **Observed:** below the map header, the legend pill sits left-of-center next to three small icon buttons. It looks orphaned from both the controls above and the map below.
- **Fix sketch:** anchor the legend to the map itself (e.g., overlay bottom-left of the map canvas) rather than letting it float in the gap above the map.

## 5. Hero takes the entire above-the-fold viewport on `#overview` mobile
- **Routes:** `""` (Overview home)
- **Severity:** UX
- **Observed:** "The annual book of pesos." headline + tagline + intro paragraph fill the whole 844px mobile viewport. Per-Filipino / per-capita KPIs (`₱58,2…` etc.) are clipped at the bottom edge.
- **Fix sketch:** smaller mobile hero font size (e.g., `clamp(2.5rem, 8vw, 3.5rem)` instead of the current scale), tighter line-height, and surface at least one KPI above the fold.

## 6. Compare page buries the comparison cards
- **Routes:** `#compare`
- **Severity:** information architecture
- **Observed:** the long explanatory paragraph (`The total didn't move. ₱6.79 T, exactly as proposed.` and the analytical body) fills the entire above-fold area. The NEP vs GAA stat cards — the actual comparison data the page is named after — start at the very bottom edge and are partly clipped.
- **Fix sketch:** either move the paragraph below the cards on mobile, or truncate it with a "Read more" expansion. Surface the headline numbers before the narrative.

## 7. Year selector vertical stacking is inefficient
- **Routes:** all dashboard pages
- **Severity:** minor / density
- **Observed:** the `FY2026` dropdown and the `FY2026 LOADED` confirmation badge stack vertically, eating ~80px on every page. On a 844px viewport that's ~10% of vertical real estate for status.
- **Fix sketch:** put the confirmation badge inline (right-aligned) next to the dropdown on mobile, or replace the badge with a small green dot inside the dropdown when loaded.

## 8. Inconsistent source-citation placement
- **Routes:** `#timeline` (visible), others (not visible)
- **Severity:** consistency
- **Observed:** `#timeline` shows "SOURCE · DBM GAA" at top-right of the chart container during loading. Other pages don't show it (or show it elsewhere — likely in footers below the fold).
- **Fix sketch:** standardize on one citation placement — either chart-adjacent (small) on every chart, or a single page-level citation line. Pick one and apply across views.

## 9. KPI card height/typography varies across pages
- **Routes:** `#regions` vs `#expense`
- **Severity:** consistency
- **Observed:** `#regions` stat cards (`₱4.16 T`, `38.7%`, etc.) are visibly smaller / less prominent than `#expense` stat cards (`₱1.84 T`, `₱2.98 T`, etc.). No shared card component.
- **Fix sketch:** extract a shared `<StatCard>` (or CSS class) and use across all dashboard pages. Pick a canonical type scale.

## 10. Loading-state UX is fragmented
- **Routes:** `#timeline` (visible loading), others (instant)
- **Severity:** UX
- **Observed:** `#timeline` shows a partial spinner + "Loading multi-year data..." text mid-page. Other pages either load fast enough to skip the state, or show no indicator at all. After H5 (lazy-load parquet) lands, more pages may hit this state — worth standardizing first.
- **Fix sketch:** define a shared loading skeleton (e.g., grey-shimmer block matching final layout) so the loading state preserves perceived layout. Apply to all data-bound views.

## 11. Nav bar separator vertical position drifts
- **Routes:** all
- **Severity:** very minor
- **Observed:** the thin line between the header (logo + tagline) and the nav bar (OVERVIEW · VIEW · COMPARE · EXPLORER · ABOUT) sits at slightly different vertical positions across pages. Hard to spot without overlaying screenshots.
- **Fix sketch:** check that no page injects extra padding above the nav. Likely a single `.header` rule fix.

## 12. Explorer's compact card group is squeezed
- **Routes:** `#explorer`
- **Severity:** density
- **Observed:** the top row of `#explorer` shows `Budget explorer` headline + `25 rows / 39 / APPLY` button cluster crammed into the same horizontal space. The 25/39 numbers are hard to parse and "APPLY" is fighting for room.
- **Fix sketch:** on mobile, stack the headline above the controls row. Separate "25 rows" / "39 [allocators]" with a label so each number is self-describing.

---

## How to work this backlog

These are *not* part of the autoresearch perf loop. Suggested workflow:
1. Pick an item, branch off `main` (not `perf/autoresearch`): `git checkout -b mobile/<short-name>`
2. Fix → eyeball locally on mobile viewport in DevTools → commit
3. Open PR / push to preview if you want a real-device check
4. Repeat

If a fix happens to also help perf, it'd show up as an additional KEEP in a future autoresearch run.
