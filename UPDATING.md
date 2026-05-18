# Updating the dashboard

This repo holds the served site. Data updates flow from a separate `gaa-etl` repo (private). Dashboard UI tweaks happen directly here.

## Multi-machine workflow

If you work from more than one machine:

Before starting work on any machine:

```powershell
cd <your-repos-path>\gaa-dashboard
git pull
```

Before stopping:

```powershell
git add <files>
git commit -m "..."
git push
```

Netlify auto-deploys on push to `main` in ~30 seconds.

If you forget to pull and a conflict arises, ask Claude — don't resolve manually unless you're confident.

## When DBM publishes a new fiscal year

Done on the machine that has the ETL setup (the one with access to raw DBM Excels):

```powershell
# 1. Drop the new Excel into your raw-data folder, then:
cd <your-repos-path>\gaa-etl
python etl\build_data.py --year 2027   # or whatever year

# 2. Inspect output\budget_2027.parquet — row count, top-line totals match DBM
# 3. Commit ETL repo
git add output\ etl\
git commit -m "FY2027 parquet"
git push

# 4. Copy parquet to dashboard repo
Copy-Item output\budget_2027.parquet <your-repos-path>\gaa-dashboard\data\

# 5. Update year-list in dashboard JS config (one line, typically js/config.js
#    or wherever the YEARS array lives — search for the prior latest year)
# 6. Commit + push dashboard
cd <your-repos-path>\gaa-dashboard
git add data\budget_2027.parquet js\
git commit -m "Add FY2027"
git push

# Netlify auto-deploys in ~30 seconds.
```

## When you fix a bug across all years

```powershell
cd <your-repos-path>\gaa-etl
# Edit etl\... fix the bug
python etl\build_data.py --all
git add output\ etl\
git commit -m "Fix UACS sub-aggregate double-count, regenerate all years"
git push

Copy-Item output\*.parquet <your-repos-path>\gaa-dashboard\data\

cd <your-repos-path>\gaa-dashboard
git add data\
git commit -m "Refresh all parquets after UACS fix"
git push
```

## When you only tweak the UI (CSS / JS / text)

Works from any machine with the dashboard repo:

```powershell
cd <your-repos-path>\gaa-dashboard
git pull
# Edit index.html, css/, js/, or README
git add <files>
git commit -m "..."
git push
```

## Rolling back a bad deploy

Don't try to revert via git unless you know what you're doing. The fast path:

1. Open https://app.netlify.com → your site → Deploys
2. Find the last working deploy
3. Click "Publish deploy"
4. Live site rolls back in ~5 seconds
5. Fix the underlying issue locally, push, new deploy supersedes the rollback

## Common gotchas

- **Parquet not showing on live site after push:** check Netlify deploy log; if 404 it may be a netlify.toml cache header issue or a missing file in `data/`
- **Year list shows new year but data doesn't load:** the JS config knows about the year but the parquet wasn't copied — re-copy from `gaa-etl/output/`
- **Conflicts after working from multiple machines:** always `git pull` before starting work
