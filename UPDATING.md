# Updating the dashboard

This repo holds the served site. Data updates flow from a separate `gaa-etl` repo (private). Dashboard UI tweaks happen directly here.

## Multi-machine workflow

You may work from two machines:
- **primary machine (primary):** full setup — both `gaa-etl` and `gaa-dashboard` repos
- **Personal laptop (occasional):** clone of `gaa-dashboard` only. No `gaa-etl` (raw Excels can't sync to personal — corporate IT blocks)

Before starting work on either machine:

```powershell
cd C:\Users\<you>\repos\gaa-dashboard
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

Done on the primary machine (only place with raw Excels):

```powershell
# 1. Drop the new Excel into OneDrive's "GAA excels" folder
# 2. Run the ETL
cd C:\Users\<windows-user>\repos\gaa-etl
python etl\build_data.py --year 2027   # or whatever year

# 3. Inspect output\budget_2027.parquet — row count, top-line totals match DBM
# 4. Commit ETL repo
git add output\ etl\
git commit -m "FY2027 parquet"
git push

# 5. Copy parquet to dashboard repo
Copy-Item output\budget_2027.parquet C:\Users\<windows-user>\repos\gaa-dashboard\data\

# 6. Update year-list in dashboard JS config (one line, typically js/config.js
#    or wherever the YEARS array lives — search for the prior latest year)
# 7. Commit + push dashboard
cd C:\Users\<windows-user>\repos\gaa-dashboard
git add data\budget_2027.parquet js\
git commit -m "Add FY2027"
git push

# Netlify auto-deploys in ~30 seconds.
```

## When you fix a bug across all years

Done on primary machine:

```powershell
cd C:\Users\<windows-user>\repos\gaa-etl
# Edit etl\... fix the bug
python etl\build_data.py --all
git add output\ etl\
git commit -m "Fix UACS sub-aggregate double-count, regenerate all years"
git push

Copy-Item output\*.parquet C:\Users\<windows-user>\repos\gaa-dashboard\data\

cd C:\Users\<windows-user>\repos\gaa-dashboard
git add data\
git commit -m "Refresh all parquets after UACS fix"
git push
```

## When you only tweak the UI (CSS / JS / text)

Works from either machine:

```powershell
cd C:\Users\<you>\repos\gaa-dashboard
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
- **You edited on personal, forgot to pull on the other machine:** org `git pull` will either fast-forward (fine) or report conflicts (call Claude)
