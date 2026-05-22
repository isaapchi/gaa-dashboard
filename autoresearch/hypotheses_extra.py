"""
H10-H14 hypothesis appliers for the autoresearch web-perf loop.

These extend the registry defined in hypotheses.py with five additional
low-risk `<head>` resource-hint tweaks targeting LCP/FCP. All edits are
strictly idempotent (gated by sentinel comments) and gracefully no-op when
their anchor pattern is missing, returning {"files_changed": [], "notes": ...}
rather than raising — the orchestrator can then mark the iteration as a
no-change rather than as BLOCKED.

Design rules (same as hypotheses.py):
- Idempotent: applying twice == applying once. Each function checks for its
  own marker before mutating.
- Precise string matching: edits use `.replace(old, new, 1)`.
- Soft failure for these head-only hints: missing anchor returns a no-op
  dict (these are speculative perf hints, not load-bearing).
- One-line stdout per file mutated, prefixed with `[Hx] <file>: <summary>`.
"""

from __future__ import annotations

import json
from pathlib import Path


def _log(hid: str, file_rel: str, msg: str) -> None:
    print(f"[{hid}] {file_rel}: {msg}", flush=True)


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def _write(p: Path, content: str) -> None:
    p.write_text(content, encoding="utf-8", newline="\n")


# ---------------------------------------------------------------------------
# H10 — preconnect cdn.jsdelivr.net
# ---------------------------------------------------------------------------

H10_MARKER = "<!-- H10 preconnect jsdelivr -->"
H10_TAG = (
    '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>'
)
# Anchor: insert right after the existing fonts preconnects. We anchor on the
# second (gstatic, crossorigin) one so we land *below* both fonts preconnects.
H10_ANCHOR = '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />'


def apply_h10(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    if H10_MARKER in html:
        _log("H10", "index.html", "jsdelivr preconnect already present, no change")
        return {"files_changed": [], "notes": "already present"}

    # If a preconnect to cdn.jsdelivr.net already exists (added by hand or by a
    # sibling tool), treat it as a no-op and just lay down the marker so future
    # runs short-circuit.
    if 'rel="preconnect"' in html and "cdn.jsdelivr.net" in html:
        # Look for a preconnect link pointing at cdn.jsdelivr.net.
        if 'href="https://cdn.jsdelivr.net"' in html and "preconnect" in html.split(
            "cdn.jsdelivr.net", 1
        )[0][-80:]:
            new_html = html.replace(
                H10_ANCHOR,
                H10_ANCHOR + "\n  " + H10_MARKER,
                1,
            ) if H10_ANCHOR in html else html
            if new_html != html:
                _write(index, new_html)
                _log("H10", "index.html", "preconnect already present, dropped marker")
                return {
                    "files_changed": ["index.html"],
                    "notes": "preconnect already present in HTML; added idempotency marker",
                }
            _log("H10", "index.html", "preconnect already present, no change")
            return {"files_changed": [], "notes": "preconnect already present"}

    if H10_ANCHOR not in html:
        _log("H10", "index.html", "anchor (fonts.gstatic preconnect) not found, skipping")
        return {
            "files_changed": [],
            "notes": "anchor 'fonts.gstatic preconnect' not found; no-op",
        }

    injected = H10_ANCHOR + "\n  " + H10_MARKER + "\n  " + H10_TAG
    new_html = html.replace(H10_ANCHOR, injected, 1)
    _write(index, new_html)
    _log("H10", "index.html", "added preconnect for cdn.jsdelivr.net")
    return {
        "files_changed": ["index.html"],
        "notes": "added <link rel=preconnect> for cdn.jsdelivr.net (ECharts CDN)",
    }


# ---------------------------------------------------------------------------
# H11 — modulepreload glance.js + data.js
# ---------------------------------------------------------------------------

H11_MARKER = "<!-- H11 modulepreload landing -->"
H11_TAGS = (
    '<link rel="modulepreload" href="js/views/glance.js">\n'
    '  <link rel="modulepreload" href="js/data.js">'
)
# Anchor on the static module script that H3 produces; if H3 hasn't run yet
# the original dynamic injector block lives there instead — handle both.
H11_ANCHOR_STATIC = '<script type="module" src="js/app.js"></script>'
H11_ANCHOR_DYNAMIC = "const _s = document.createElement('script');"


def apply_h11(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    if H11_MARKER in html:
        _log("H11", "index.html", "modulepreload tags already present, no change")
        return {"files_changed": [], "notes": "already present"}

    if H11_ANCHOR_STATIC in html:
        injected = (
            "  " + H11_MARKER + "\n"
            "  " + H11_TAGS + "\n"
            "  " + H11_ANCHOR_STATIC
        )
        # Replace the *line* containing the anchor (with its leading indent)
        # so we don't double up indentation. Anchor in source is `  <script ...`.
        anchor_line = "  " + H11_ANCHOR_STATIC
        if anchor_line in html:
            new_html = html.replace(anchor_line, injected, 1)
        else:
            new_html = html.replace(
                H11_ANCHOR_STATIC,
                H11_MARKER + "\n  " + H11_TAGS + "\n  " + H11_ANCHOR_STATIC,
                1,
            )
        _write(index, new_html)
        _log("H11", "index.html", "added modulepreload for glance.js + data.js")
        return {
            "files_changed": ["index.html"],
            "notes": "modulepreload glance.js (default route) + data.js (its hard dep)",
        }

    # H3 hasn't run yet — the dynamic injector block is still present. Insert
    # just before the <script> wrapper that contains the injector. We use a
    # broader anchor on the `<script>` opening of that block.
    if H11_ANCHOR_DYNAMIC in html:
        # Find the `  <script>` line that opens the dynamic injector. The
        # block in hypotheses.H3_OLD_BLOCK starts with `  <script>\n    const _v`.
        dyn_open = "  <script>\n    const _v = Date.now();"
        if dyn_open in html:
            injected = (
                "  " + H11_MARKER + "\n"
                "  " + H11_TAGS + "\n"
                + dyn_open
            )
            new_html = html.replace(dyn_open, injected, 1)
            _write(index, new_html)
            _log(
                "H11",
                "index.html",
                "added modulepreload (above pre-H3 dynamic app.js injector)",
            )
            return {
                "files_changed": ["index.html"],
                "notes": (
                    "modulepreload glance.js + data.js inserted above pre-H3 "
                    "dynamic app.js injector"
                ),
            }

    _log("H11", "index.html", "neither static nor dynamic app.js anchor found, skipping")
    return {
        "files_changed": [],
        "notes": "no app.js script tag anchor found; no-op",
    }


# ---------------------------------------------------------------------------
# H12 — Google Fonts display=optional
# ---------------------------------------------------------------------------

H12_MARKER = "<!-- H12 display-optional -->"


def apply_h12(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    if H12_MARKER in html:
        _log("H12", "index.html", "display=optional already applied, no change")
        return {"files_changed": [], "notes": "already applied"}

    # Find the Google Fonts <link rel=stylesheet> with display=swap and flip it
    # to display=optional. Be defensive — there can be multiple links to
    # fonts.googleapis.com (the H4 preload tag uses display=swap too). We
    # must target the `rel="stylesheet"` link specifically.
    sheet_anchor = '<link href="https://fonts.googleapis.com/css2?'
    if sheet_anchor not in html:
        _log("H12", "index.html", "Google Fonts stylesheet link not found, skipping")
        return {
            "files_changed": [],
            "notes": "no Google Fonts <link rel=stylesheet>; no-op",
        }

    # Slice out the stylesheet link tag and check it actually has display=swap.
    start = html.find(sheet_anchor)
    end = html.find("/>", start)
    if end == -1:
        # Try `>` for non-self-closing form.
        end = html.find(">", start)
        if end == -1:
            _log("H12", "index.html", "couldn't find closing of stylesheet link, skipping")
            return {
                "files_changed": [],
                "notes": "stylesheet link closer not found; no-op",
            }
        tag_end = end + 1
    else:
        tag_end = end + 2
    sheet_tag = html[start:tag_end]
    if "&display=swap" not in sheet_tag:
        _log("H12", "index.html", "stylesheet link has no &display=swap, skipping")
        return {
            "files_changed": [],
            "notes": "stylesheet display already not swap; no-op",
        }

    new_sheet_tag = sheet_tag.replace("&display=swap", "&display=optional", 1)
    new_html = html.replace(sheet_tag, new_sheet_tag, 1)

    # Drop the marker comment just above the next stylesheet link so re-runs
    # short-circuit on the marker check.
    # We inject it just before the line containing fonts.googleapis.com with
    # rel="stylesheet". If we can't find that exact pattern, still keep the
    # display change and drop the marker just before </head>.
    marker_anchor = '<link href="https://fonts.googleapis.com/css2?'
    if marker_anchor in new_html:
        new_html = new_html.replace(
            marker_anchor,
            H12_MARKER + "\n  " + marker_anchor,
            1,
        )
    elif "</head>" in new_html:
        new_html = new_html.replace("</head>", "  " + H12_MARKER + "\n</head>", 1)

    _write(index, new_html)
    _log("H12", "index.html", "flipped Google Fonts display=swap -> display=optional")
    return {
        "files_changed": ["index.html"],
        "notes": "Google Fonts display=swap -> display=optional (prior +0.01 perf win)",
    }


# ---------------------------------------------------------------------------
# H13 — fetchpriority="high" on DM Serif Text preload (added by H4)
# ---------------------------------------------------------------------------

H13_MARKER = "<!-- H13 fetchpriority -->"


def apply_h13(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    if H13_MARKER in html:
        _log("H13", "index.html", "fetchpriority already applied, no change")
        return {"files_changed": [], "notes": "already applied"}

    # Look for the H4 preload line. We anchor on the unambiguous prefix and
    # then mutate only that tag. Two variants of the href tail are possible
    # depending on whether H12 has run (display=swap vs display=optional).
    anchor_prefix = (
        '<link rel="preload" as="style" '
        'href="https://fonts.googleapis.com/css2?family=DM+Serif+Text'
    )
    if anchor_prefix not in html:
        _log("H13", "index.html", "H4 preload tag not present, skipping (H4 may not have run)")
        return {
            "files_changed": [],
            "notes": "H4 preload tag missing; no-op",
        }

    # Find the full tag (up to the next `/>`) and inject fetchpriority="high"
    # before the closing `/>`. We do this on the first occurrence only.
    start = html.find(anchor_prefix)
    end = html.find("/>", start)
    if end == -1:
        _log("H13", "index.html", "couldn't find closing /> on preload tag, skipping")
        return {
            "files_changed": [],
            "notes": "preload tag closer not found; no-op",
        }

    tag = html[start:end + 2]
    if 'fetchpriority="high"' in tag:
        # Tag already has it — just lay down the marker so re-runs short-circuit.
        new_html = html.replace("</head>", "  " + H13_MARKER + "\n</head>", 1)
        _write(index, new_html)
        _log("H13", "index.html", "tag already had fetchpriority, marker dropped")
        return {
            "files_changed": ["index.html"],
            "notes": "fetchpriority already present; added marker",
        }

    # Inject ` fetchpriority="high"` before the trailing ` />` (preserve the
    # space that's already there in the H4-generated tag).
    new_tag = tag.replace(" />", ' fetchpriority="high" />', 1)
    if new_tag == tag:
        # Defensive fallback if there was no space before />
        new_tag = tag.replace("/>", 'fetchpriority="high" />', 1)
    new_html = html.replace(tag, H13_MARKER + "\n  " + new_tag, 1)
    _write(index, new_html)
    _log("H13", "index.html", "added fetchpriority=high to DM Serif Text preload")
    return {
        "files_changed": ["index.html"],
        "notes": 'added fetchpriority="high" to DM Serif Text preload (H4)',
    }


# ---------------------------------------------------------------------------
# H14 — prefetch summary_<default-year>.json
# ---------------------------------------------------------------------------

H14_MARKER = "<!-- H14 prefetch summary -->"


def _default_year(repo: Path) -> int:
    """Read data/years.json and return the default year. Fall back to max(years),
    and to 2026 as ultimate fallback."""
    years_path = repo / "data" / "years.json"
    try:
        payload = json.loads(years_path.read_text(encoding="utf-8"))
        default = payload.get("default")
        if isinstance(default, int):
            return default
        years = payload.get("years") or []
        if years:
            return int(max(years))
    except Exception:
        pass
    return 2026


def apply_h14(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    if H14_MARKER in html:
        _log("H14", "index.html", "summary prefetch already present, no change")
        return {"files_changed": [], "notes": "already present"}

    year = _default_year(repo)
    tag = (
        f'<link rel="prefetch" href="data/summary_{year}.json" '
        f'as="fetch" crossorigin>'
    )

    # Anchor near other preload/prefetch tags. Prefer to land right after the
    # DM Serif Text preload (added by H4); fall back to right before </head>.
    anchor_prefix = (
        '<link rel="preload" as="style" '
        'href="https://fonts.googleapis.com/css2?family=DM+Serif+Text'
    )
    if anchor_prefix in html:
        # Find end of that tag (closing `/>`) and insert after.
        start = html.find(anchor_prefix)
        end = html.find("/>", start)
        if end != -1:
            insert_at = end + 2
            new_html = (
                html[:insert_at]
                + "\n  " + H14_MARKER
                + "\n  " + tag
                + html[insert_at:]
            )
            _write(index, new_html)
            _log("H14", "index.html", f"prefetch summary_{year}.json (after H4 preload)")
            return {
                "files_changed": ["index.html"],
                "notes": f"prefetch data/summary_{year}.json (Overview view's first fetch)",
            }

    if "</head>" in html:
        new_html = html.replace(
            "</head>",
            "  " + H14_MARKER + "\n  " + tag + "\n</head>",
            1,
        )
        _write(index, new_html)
        _log("H14", "index.html", f"prefetch summary_{year}.json (before </head>)")
        return {
            "files_changed": ["index.html"],
            "notes": f"prefetch data/summary_{year}.json (Overview view's first fetch)",
        }

    _log("H14", "index.html", "no </head> anchor found, skipping")
    return {
        "files_changed": [],
        "notes": "no </head> anchor found; no-op",
    }
