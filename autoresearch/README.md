# autoresearch — local perf optimization loop

Closed-loop optimization of LCP / FCP / TBT / Performance score for publikoph,
with a live dashboard and a hard no-deploy gate.

## What it does

Walks a fixed queue of 9 optimization hypotheses (H1–H9). Per hypothesis:
1. Snapshot working tree (git commit).
2. Apply the hypothesis (deterministic file edits).
3. Smoke-check (page loads).
4. **Visual gate** — Playwright screenshots all 8 SPA routes × 2 viewports, pixelmatch-diff vs baseline. Fail if any view exceeds 0.5%.
5. **Perf gate** — CDP-measured LCP/FCP/TBT/CLS with Lighthouse v10 scoring (×3 runs, median).
6. KEEP iff composite Perf score strictly improved vs last kept iteration. Otherwise REVERT (`git restore .`).

Never runs `git push`. Final status is "complete"; pushing to Netlify preview / merge to main requires **explicit user approval in chat** (~15 credits per push out of ~300/month).

## Setup (one-time)

```
pip install playwright pillow numpy pixelmatch
# We use system Chrome (channel='chrome'); no Chromium download needed.
```

## Run

From `C:/Users/WB480398/repos/gaa-dashboard/`:

```
git checkout perf/autoresearch        # must be on this branch
python -m autoresearch.orchestrator   # full loop
```

Open `http://localhost:8765/autoresearch/dashboard.html` in a browser to watch.

### Modes

- `--baseline-only` — capture visual baselines + initial perf measurement, then exit.
- `--measure-only` — one perf measurement, print, exit (doesn't touch state.json).
- `--dry-run` — walk the queue without applying any change. Validates orchestrator + dashboard wiring.
- `--runs N` — perf measurement runs per gate (default 3; lower for quick smoke).

## Stop mid-loop

Create `autoresearch/STOP` (empty file). The loop checks the sentinel at the start of each iteration and exits gracefully with `status: paused`.

```
ni autoresearch/STOP     # PowerShell, also: type nul > autoresearch/STOP
```

## Files

- `orchestrator.py` — the loop.
- `hypotheses.py` — H1–H9 applier functions.
- `cdp_measure.py` — Playwright + CDP, returns LCP/FCP/TBT/CLS/perf.
- `lighthouse_score.py` — Lighthouse v10 log-normal scoring curves.
- `visual_check.py` — Playwright screenshot diff (pixelmatch).
- `state.py` — atomic JSON read/write.
- `dashboard.html` + `dashboard.js` + `dashboard.css` — live view.
- `state.json` — live loop state (gitignored).
- `visual-baseline/` — committed PNG baselines (~16 files).
- `runs/` — per-iteration outputs (gitignored).
- `bin/tailwindcss.exe` — standalone CLI (gitignored, downloaded on first H1 run).
- `tailwind-src.css` — Tailwind directives input for H1 (committed).
- `STOP` — sentinel file user creates to halt (gitignored).

## Hypotheses

| ID | Name                                     | Risk    |
|----|------------------------------------------|---------|
| H1 | self-host Tailwind                       | high    |
| H2 | defer ECharts script (body bottom)       | low     |
| H3 | remove `?v=Date.now()` cache-bust        | low     |
| H4 | drop unused font weights + preload LCP   | med     |
| H5 | lazy-load parquet (idle prefetch)        | med     |
| H6 | split critical CSS                       | high    |
| H7 | defer Cloudflare Insights to idle        | low     |
| H8 | extend cache headers (1y immutable)      | low     |
| H9 | preload LCP element                      | low     |

## Deploy gate

After the local loop completes, the dashboard shows a yellow banner: "Local complete. Push to Netlify preview? requires explicit user approval."

I (Claude) will only run `git push origin perf/autoresearch` after the user explicitly types "push" / "deploy" / "ok go" in chat. Preview deploy and final merge are **two separate approvals**.
