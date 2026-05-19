# Philippines GAA Dashboard

Interactive visualization of the Philippine General Appropriations Act (GAA), FY2009–FY2026. Source: Department of Budget and Management (DBM) "By Object" releases, harmonized to UACS (Unified Accounts Code Structure).

**Live:** https://publikoph.org

**Feedback:** [feedback@publikoph.org](mailto:feedback@publikoph.org)

## What's here

Pure static site — HTML/CSS/JS plus per-year parquet files served as-is by Netlify. No build step, no runtime backend.

```
gaa-dashboard/
├── index.html         Entry point
├── css/               Styles
├── js/                Dashboard logic, parquet loaders, chart rendering
├── data/              Per-year cleaned parquets (budget_2009.parquet …) + summaries
├── serve.py           Local dev server (python serve.py → http://localhost:8000)
└── netlify.toml       Build / cache headers for Netlify
```

## Local development

```powershell
python serve.py
# Open http://localhost:8000
```

## Updating data

Per-year parquets are produced by a separate (private) ETL pipeline that reads raw DBM Excels. When DBM publishes a new fiscal year, the ETL regenerates the parquet, you copy it into `data/`, commit, and Netlify auto-deploys.

See `UPDATING.md` for the step-by-step.

## Acronyms

- **GAA** — General Appropriations Act (the annual national budget law)
- **DBM** — Department of Budget and Management (publishes the GAA Excels)
- **NEP** — National Expenditure Program (DBM's pre-enactment budget proposal)
- **UACS** — Unified Accounts Code Structure (DBM's standardized chart of accounts)
- **PREXC** — Program Expenditure Classification

## Source data

DBM-published GAA "By Object" Excel files for each fiscal year. Cleaned and harmonized for cross-year comparison (UACS code reconciliation, department-name normalization, sub-aggregate de-duplication).
