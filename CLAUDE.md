# Claude Instructions — gaa-dashboard

Project-local guidance for Claude Code sessions working in this repository.

---

## Deploy economy — Netlify free tier (Starter plan)

This site is served by Netlify's free tier:
- **300 build credits/month** — each `git push` to `main` = 1 deploy ≈ **15 credits**
- **100 GB bandwidth/month**

Credits reset on the 1st of each month. The deploy cost is flat per deploy (no build step happens — site is pure static HTML/JS/parquet), so frequency of pushes is what burns the quota.

### Commit + push policy

- **Batch related fixes into one commit.** Aim for 3–5 user-visible fixes per commit during iteration rather than one-fix-per-commit.
- **Push 1–2 times per day max** during stable operation. More during a release/launch push is fine but plan around the 300-credit ceiling.
- **Local commits are free.** Commit as often as feels natural — only `git push` triggers a Netlify deploy.
- **Docs-only changes that don't affect served files** (README, this CLAUDE.md, UPDATING.md, comments inside repo) can include `[skip netlify]` in the commit message to suppress the auto-deploy.
- **Risky changes go solo** so rollback is surgical. Low-risk UI tweaks can be batched safely.

### When credits are low (>70% used mid-cycle)

1. Lock auto-publishing on Netlify (Deploys page → "Lock to stop auto publishing")
2. Push to GitHub freely; deploys are paused
3. When the batched changes are ready, manually click "Publish deploy" on the latest deploy entry
4. Re-enable auto-publishing afterward

### Bandwidth concern (separate quota)

If bandwidth (100 GB) becomes the bottleneck instead of build credits:
- Turn on Cloudflare proxy (orange cloud) and switch CF SSL mode to "Full (strict)" — this offloads cached parquets/assets to Cloudflare's CDN and cuts Netlify bandwidth ~80%
- Cloudflare's Bot Fight Mode (free once proxy is on) reduces crawler traffic

---

## What this repo is

Pure static site — vanilla HTML/CSS/JS plus per-year parquet files served as-is. No build step. Netlify config (`netlify.toml`) sets publish dir = `.`.

Data pipeline lives in the separate (private) `gaa-etl` repo. Cleaned parquets get copied from there into `data/` here. See `UPDATING.md` for the full FY-update workflow.

---

## File layout

```
gaa-dashboard/
├── index.html            Entry point
├── css/style.css         All styles (newspaper / "riso almanac" palette)
├── js/
│   ├── app.js            SPA router + nav
│   ├── data.js           Shared: parquet loaders, ECharts wrappers, chart actions
│   ├── multiselect.js    Custom multi-select dropdown component (used in Explorer)
│   └── views/            One file per view: glance, timeline, departments, regions,
│                         expense, compare, explorer, about, dept-detail
├── data/                 Per-year cleaned parquets + summaries + reference json
├── serve.py              Local dev server (python serve.py → :8765)
├── netlify.toml          Static publish + cache headers
├── README.md             Public-facing repo overview
├── UPDATING.md           Multi-machine + FY-update operational workflow
└── CLAUDE.md             (this file)
```

---

## When making changes

- Stata project rules live at `~/.claude/CLAUDE.md` (user-global) — graph standards, etc. They don't apply directly here but the broader "clean, modern, no chart junk" aesthetic does.
- Save `.do` / `.py` / `.js` as **LF endings**, not CRLF.
- The masthead and parent branding pattern is set: `Halaga.` (product) / `A Publiko Project` (parent) / `The People's Budget Almanac` (tagline). Don't restructure casually.
- Cloudflare Web Analytics beacon is wired in `index.html` before `</body>` — don't remove it.
- Site is anonymous: no real names, no WBG identifiers, no email signatures in commits.
