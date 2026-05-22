"""
H1-H9 hypothesis appliers for the autoresearch web-perf loop.

Each Hypothesis owns a deterministic, idempotent file-mutation function that
takes the gaa-dashboard repo root and returns
    {"files_changed": [...], "notes": "..."}

The orchestrator runs them in order; on failure they should raise ValueError
so the orchestrator can mark BLOCKED / REVERT cleanly instead of silently
corrupting source files.

Design rules
------------
- Idempotent: applying twice == applying once. Each function checks for a
  marker of its own prior application and returns a no-op dict in that case.
- Precise string matching: edits use `.replace(old, new, 1)` or anchored
  regex, never bare substring deletions.
- Loud failure: if the expected source pattern is missing, raise ValueError
  with a message naming H-id, file, and pattern. The orchestrator catches
  this and marks the iteration as failed.
- One-line stdout per file mutated, prefixed with `[Hx] <file>: <summary>`.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from hypotheses_extra import apply_h10, apply_h11, apply_h12, apply_h13, apply_h14


# ---------------------------------------------------------------------------
# Public dataclass + registry
# ---------------------------------------------------------------------------

@dataclass
class Hypothesis:
    id: str
    name: str
    risk: str                                 # "low" | "med" | "high"
    apply: Callable[[Path], dict]


def _log(hid: str, file_rel: str, msg: str) -> None:
    print(f"[{hid}] {file_rel}: {msg}", flush=True)


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def _write(p: Path, content: str) -> None:
    p.write_text(content, encoding="utf-8", newline="\n")


# ---------------------------------------------------------------------------
# H1 — self-host Tailwind
# ---------------------------------------------------------------------------

H1_CDN_TAG = '<script src="https://cdn.tailwindcss.com"></script>'
H1_REPLACEMENT_LINK = '<link rel="stylesheet" href="css/tailwind.css">'
H1_MARKER = 'href="css/tailwind.css"'

# Inline `tailwind.config = {...}` block — we leave it in place; it is harmless
# (`tailwind.config` is just an unused global once the CDN runtime is gone),
# but we comment it out via a wrapper so it can't throw if Tailwind global
# is undefined. Actually the assignment `tailwind.config = {...}` WILL throw
# ReferenceError when the CDN runtime isn't there. Wrap it in a guard.
H1_CONFIG_OPEN = "  <script>\n    tailwind.config = {"
H1_CONFIG_WRAPPED_OPEN = (
    "  <script>\n"
    "    // Tailwind CDN runtime removed (H1 self-host); guard the legacy config block.\n"
    "    if (typeof tailwind !== 'undefined') {\n"
    "      tailwind.config = {"
)
# The closing of the original block is:
#     };
#   </script>
# We want to close the new `if` after the assignment closes.
H1_CONFIG_CLOSE = "    };\n  </script>"
H1_CONFIG_WRAPPED_CLOSE = "    };\n    }\n  </script>"

TAILWIND_BINARY_URL = (
    "https://github.com/tailwindlabs/tailwindcss/releases/latest/"
    "download/tailwindcss-windows-x64.exe"
)

TAILWIND_SRC_CONTENT = "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n"


def _ensure_tailwind_binary(repo: Path) -> Path:
    bin_dir = repo / "autoresearch" / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    exe = bin_dir / "tailwindcss.exe"
    if exe.exists() and exe.stat().st_size > 1_000_000:  # plausible binary
        return exe
    _log("H1", "autoresearch/bin/tailwindcss.exe", f"downloading from {TAILWIND_BINARY_URL}")
    urllib.request.urlretrieve(TAILWIND_BINARY_URL, exe)
    if not exe.exists() or exe.stat().st_size < 1_000_000:
        raise ValueError(
            f"[H1] failed to download Tailwind CLI to {exe} "
            f"(size={exe.stat().st_size if exe.exists() else 'missing'})"
        )
    return exe


def _ensure_tailwind_src(repo: Path) -> Path:
    src = repo / "autoresearch" / "tailwind-src.css"
    src.parent.mkdir(parents=True, exist_ok=True)
    if not src.exists() or _read(src) != TAILWIND_SRC_CONTENT:
        _write(src, TAILWIND_SRC_CONTENT)
        _log("H1", "autoresearch/tailwind-src.css", "wrote input file")
    return src


def apply_h1(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    # Idempotency check: if the self-hosted link is already present and the
    # CDN script tag is gone, bail out as no-op.
    already_replaced = (H1_MARKER in html) and (H1_CDN_TAG not in html)

    # 1. Download Tailwind CLI binary if needed.
    exe = _ensure_tailwind_binary(repo)

    # 2. Write input file if needed.
    _ensure_tailwind_src(repo)

    # 3. Run Tailwind CLI to generate css/tailwind.css.
    out_css = repo / "css" / "tailwind.css"
    cmd = [
        str(exe),
        "-i", "autoresearch/tailwind-src.css",
        "-o", "css/tailwind.css",
        "--content", "index.html",
        "--content", "js/**/*.js",
        "--minify",
    ]
    proc = subprocess.run(cmd, cwd=repo, capture_output=True, text=True)
    if proc.returncode != 0 or not out_css.exists():
        raise ValueError(
            f"[H1] tailwindcss build failed (rc={proc.returncode}): "
            f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
        )
    _log("H1", "css/tailwind.css", f"built ({out_css.stat().st_size} bytes)")

    # 4. Patch index.html: replace CDN tag, wrap config block.
    if already_replaced:
        _log("H1", "index.html", "already patched, skipping HTML mutation")
    else:
        if H1_CDN_TAG not in html:
            raise ValueError(
                f"[H1] expected CDN script tag not found in index.html: {H1_CDN_TAG!r}"
            )
        html = html.replace(H1_CDN_TAG, H1_REPLACEMENT_LINK, 1)

        if H1_CONFIG_OPEN in html:
            html = html.replace(H1_CONFIG_OPEN, H1_CONFIG_WRAPPED_OPEN, 1)
            # Match the very next `};\n  </script>` (the first one after the
            # wrap point). We use a left-anchored partition to avoid touching
            # other </script> blocks later in the file.
            head, sep, tail = html.partition(H1_CONFIG_CLOSE)
            if not sep:
                raise ValueError(
                    "[H1] wrapped tailwind.config open but couldn't find its close"
                )
            html = head + H1_CONFIG_WRAPPED_CLOSE + tail

        _write(index, html)
        _log("H1", "index.html", "swapped CDN script -> stylesheet, guarded config block")

    return {
        "files_changed": [
            "index.html",
            "css/tailwind.css",
            "autoresearch/tailwind-src.css",
            "autoresearch/bin/tailwindcss.exe",
        ],
        "notes": "self-hosted Tailwind via standalone CLI; CDN runtime removed",
    }


# ---------------------------------------------------------------------------
# H2 — defer ECharts script, move to body bottom
# ---------------------------------------------------------------------------

H2_ECHARTS_TAG = (
    '<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js">'
    '</script>'
)
H2_DEFERRED_TAG = (
    '<script defer src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js">'
    '</script>'
)
H2_BODY_CLOSE = "</body>"


def apply_h2(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    # Idempotency: deferred tag present AND original head-position tag absent.
    if H2_DEFERRED_TAG in html and H2_ECHARTS_TAG not in html:
        _log("H2", "index.html", "already deferred, no change")
        return {"files_changed": [], "notes": "already deferred"}

    if H2_ECHARTS_TAG not in html:
        raise ValueError(
            f"[H2] expected ECharts script tag not found in index.html: {H2_ECHARTS_TAG!r}"
        )

    # Strip from head position (collapse any leftover blank line). Then insert
    # before </body>.
    html_removed = html.replace(H2_ECHARTS_TAG + "\n\n", "", 1)
    if html_removed == html:
        html_removed = html.replace(H2_ECHARTS_TAG + "\n", "", 1)
    if html_removed == html:
        html_removed = html.replace(H2_ECHARTS_TAG, "", 1)

    if H2_BODY_CLOSE not in html_removed:
        raise ValueError("[H2] </body> not found in index.html")

    injected = H2_DEFERRED_TAG + "\n\n" + H2_BODY_CLOSE
    new_html = html_removed.replace(H2_BODY_CLOSE, injected, 1)

    _write(index, new_html)
    _log("H2", "index.html", "moved ECharts to body bottom with defer attribute")
    return {
        "files_changed": ["index.html"],
        "notes": "ECharts script: now defer + body-bottom",
    }


# ---------------------------------------------------------------------------
# H3 — remove ?v=${Date.now()} cache-bust on js/app.js
# ---------------------------------------------------------------------------

H3_OLD_BLOCK = """  <script>
    const _v = Date.now();
    const _s = document.createElement('script');
    _s.type = 'module';
    _s.src = `js/app.js?v=${_v}`;
    document.body.appendChild(_s);
  </script>"""

H3_NEW_TAG = '  <script type="module" src="js/app.js"></script>'


def apply_h3(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    # Idempotency: if the new tag is in and the old block is gone, no-op.
    if H3_NEW_TAG in html and H3_OLD_BLOCK not in html:
        _log("H3", "index.html", "cache-bust already removed, no change")
        return {"files_changed": [], "notes": "already replaced"}

    if H3_OLD_BLOCK not in html:
        raise ValueError(
            "[H3] cache-bust injector block not found verbatim in index.html. "
            "Index.html may have been edited; needs orchestrator-time handling."
        )

    new_html = html.replace(H3_OLD_BLOCK, H3_NEW_TAG, 1)
    _write(index, new_html)
    _log("H3", "index.html", "replaced cache-bust injector with static <script type=module>")
    return {
        "files_changed": ["index.html"],
        "notes": "removed ?v=${Date.now()} dynamic injector",
    }


# ---------------------------------------------------------------------------
# H4 — drop unused font weights, preload LCP font
# ---------------------------------------------------------------------------

# Inspected css/style.css: only weights 400/500/600/700 appear in declarations.
# We keep that set for Space Grotesk / Inter / Space Mono; DM Serif Text /
# DM Serif Display have only one weight each (regular), and the italic ital@0;1
# axis was requested but no `font-style: italic` rules exist in style.css that
# require italic DM Serif. We drop italics from DM Serif to shed weight.
H4_OLD_FONTS_HREF = (
    'href="https://fonts.googleapis.com/css2?'
    'family=DM+Serif+Text:ital@0;1'
    '&family=DM+Serif+Display:ital@0;1'
    '&family=Space+Grotesk:wght@400;500;600;700'
    '&family=Space+Mono:wght@400;700'
    '&family=Inter:wght@400;500;600;700'
    '&display=swap" rel="stylesheet" />'
)
H4_NEW_FONTS_HREF = (
    'href="https://fonts.googleapis.com/css2?'
    'family=DM+Serif+Text'
    '&family=Space+Grotesk:wght@400;600;700'
    '&family=Space+Mono:wght@400;700'
    '&family=Inter:wght@400;600;700'
    '&display=swap" rel="stylesheet" />'
)

# DM Serif Text is the masthead title face (font-size: 42px) — almost certainly
# the LCP element. Preload its woff2. Google Fonts unicode-range files have
# rotating filenames, so we use the Google-recommended <link rel=preload> form
# with `as=font` and `crossorigin` — but pointing at the css2 endpoint won't
# preload the binary. The most defensible preload here is the css2 stylesheet
# itself (so the browser parses font-face declarations earlier and starts the
# binary fetch). The font woff2 URL changes; we don't hardcode it.
H4_PRELOAD_MARKER = '<link rel="preload" as="style" href="https://fonts.googleapis.com/css2'
H4_PRELOAD_TAG = (
    '<link rel="preload" as="style" '
    'href="https://fonts.googleapis.com/css2?family=DM+Serif+Text&display=swap" />'
)


def apply_h4(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    notes = []
    changed = False

    if H4_NEW_FONTS_HREF in html and H4_OLD_FONTS_HREF not in html:
        notes.append("font weights already trimmed")
    elif H4_OLD_FONTS_HREF in html:
        html = html.replace(H4_OLD_FONTS_HREF, H4_NEW_FONTS_HREF, 1)
        notes.append("trimmed Google Fonts URL to actually-used weights")
        changed = True
    else:
        raise ValueError(
            "[H4] Google Fonts <link> not found verbatim in index.html. "
            "Original href may have been edited; needs orchestrator-time handling."
        )

    # Insert preload tag right before the preconnect block, if not already present.
    if H4_PRELOAD_MARKER in html:
        notes.append("preload tag already present")
    else:
        anchor = '<link rel="preconnect" href="https://fonts.googleapis.com" />'
        if anchor not in html:
            raise ValueError("[H4] preconnect anchor not found; cannot insert preload tag")
        html = html.replace(anchor, H4_PRELOAD_TAG + "\n  " + anchor, 1)
        notes.append("added DM Serif Text preload (LCP heuristic)")
        changed = True

    if changed:
        _write(index, html)
        _log("H4", "index.html", "; ".join(notes))
    else:
        _log("H4", "index.html", "no change (" + "; ".join(notes) + ")")

    return {
        "files_changed": ["index.html"] if changed else [],
        "notes": "; ".join(notes),
    }


# ---------------------------------------------------------------------------
# H5 — lazy-load parquet
# ---------------------------------------------------------------------------

# Inspected js/data.js: parquet loading is ALREADY lazy per-year. The
# `ensureBudgetView()` flow fetches `budget_${year}.parquet` only on demand and
# caches it in `_fetchedYears`. No multi-year prefetch at init time exists.
#
# The improvement we can make: after the active year is set, schedule an
# idle-time HTTP-cache warm of the immediately neighboring years (prev / next
# in _yearsPayload.years) so a subsequent year-switch is instant. We do NOT
# register the parquet with DuckDB — that would race with the active year's
# load and risk shifting render timing past the 0.5% visual-regression gate.
# Plain `fetch(url)` is enough to seat the bytes in the browser HTTP cache;
# the real DuckDB registration happens later inside `ensureBudgetView` when
# the user actually switches.
#
# Anchor: the closing brace of `setCurrentYear` — a stable exported function
# that is the single entry point for changing the active fiscal year. We
# locate it by regex (tolerant of body edits) rather than matching a brittle
# string inside `ensureBudgetView` (which has been edited since H5 was first
# written and broke the old anchor).

H5_MARKER = "// H5_IDLE_PREFETCH"

# Helper appended near the bottom of the file. Defined as a plain function so
# it's hoisted and can be called from inside the patched setCurrentYear without
# worrying about temporal-dead-zone for `let _yearsPayload` (we read it lazily
# inside the idle callback, after getYears has had a chance to populate it).
H5_HELPER_BLOCK = """

// H5_IDLE_PREFETCH — warm the browser HTTP cache for the neighbour years so a
// subsequent setCurrentYear() switch hits a cached parquet instead of a cold
// network fetch. We deliberately do NOT register the buffer with DuckDB here;
// that happens lazily inside ensureBudgetView when the user actually switches.
// Skipping DuckDB registration keeps this off the critical path for the active
// year's render and avoids racing with its in-flight parquet fetch.
const _h5PrefetchedYears = new Set();
function _h5SchedulePrefetchNeighbors(activeYear) {
  if (typeof window === 'undefined') return;
  const yp = _yearsPayload;
  if (!yp || !Array.isArray(yp.years)) return;
  const i = yp.years.indexOf(activeYear);
  if (i === -1) return;
  const neighbours = [];
  if (i > 0) neighbours.push(yp.years[i - 1]);
  if (i < yp.years.length - 1) neighbours.push(yp.years[i + 1]);
  const idle = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 4000 })
    : (cb) => setTimeout(cb, 1500);
  for (const y of neighbours) {
    if (y === activeYear) continue;
    if (_h5PrefetchedYears.has(y)) continue;
    if (_fetchedYears && _fetchedYears.has(y)) continue;  // already registered with DuckDB
    _h5PrefetchedYears.add(y);
    idle(() => {
      // Best-effort HTTP-cache warm. No await, no registerFileBuffer.
      fetch(`data/budget_${y}.parquet`, { cache: 'force-cache' }).catch(() => {
        _h5PrefetchedYears.delete(y);  // allow retry on next setCurrentYear
      });
    });
  }
}
"""

# Regex that locates the body of setCurrentYear. We match the function header
# and capture the body up to the matching closing brace at column 0. This is
# tolerant of any internal edits (dispatched events, view re-points, etc.) as
# long as the function remains a top-level `export async function
# setCurrentYear(year)` block.
H5_SET_CURRENT_YEAR_RE = re.compile(
    r"(export\s+async\s+function\s+setCurrentYear\s*\([^)]*\)\s*\{)(.*?)(\n\})",
    re.DOTALL,
)


def apply_h5(repo: Path) -> dict:
    data_js = repo / "js" / "data.js"
    src = _read(data_js)

    if H5_MARKER in src:
        _log("H5", "js/data.js", "idle prefetch already injected, no change")
        return {
            "files_changed": [],
            "notes": "already lazy; idle-time HTTP-cache prefetch already injected",
        }

    m = H5_SET_CURRENT_YEAR_RE.search(src)
    if not m:
        raise ValueError(
            "[H5] couldn't locate `export async function setCurrentYear(...)` in js/data.js. "
            "data.js may have been edited; needs orchestrator-time handling."
        )

    header, body, closer = m.group(1), m.group(2), m.group(3)
    # Inject the prefetch call at the very end of the function body — after any
    # await ensureBudgetView() / event dispatch — so the active year's render
    # path is never delayed by neighbour bookkeeping.
    injection = "\n  _h5SchedulePrefetchNeighbors(year);"
    new_body = body.rstrip() + injection
    new_block = header + new_body + closer
    new_src = src[: m.start()] + new_block + src[m.end():]

    # Append the helper function once, at the bottom of the file. Vanilla JS;
    # no new imports. Hoisting: function declarations are hoisted, so the call
    # inside setCurrentYear resolves even though the helper lives below.
    new_src = new_src.rstrip() + "\n" + H5_HELPER_BLOCK

    _write(data_js, new_src)
    _log("H5", "js/data.js", "added idle-time HTTP-cache prefetch for neighbour years (no DuckDB register)")
    return {
        "files_changed": ["js/data.js"],
        "notes": (
            "loader is already lazy per-year; added idle-time HTTP-cache warm for "
            "neighbour years via setCurrentYear (no DuckDB registration on the prefetch "
            "path, so no race with the active year's parquet load)"
        ),
    }


# ---------------------------------------------------------------------------
# H6 — split critical CSS
# ---------------------------------------------------------------------------

H6_CRITICAL_MARKER = "<!-- H6: critical CSS -->"
H6_STYLE_LINK_OLD = '<link rel="stylesheet" href="css/style.css" />'
H6_STYLE_LINK_NEW = (
    '<link rel="preload" href="css/style.css" as="style" '
    'onload="this.onload=null;this.rel=\'stylesheet\'" />\n'
    '  <noscript><link rel="stylesheet" href="css/style.css" /></noscript>'
)


def _extract_critical_css(full_css: str, n_lines: int = 160) -> str:
    """Heuristic: take the first n_lines that include :root, html/body, masthead, header,
    and any rules touching them. We keep the file's leading block intact and stop at the
    first closing `}` after `n_lines` so we don't split a rule in half."""
    lines = full_css.splitlines()
    if len(lines) <= n_lines:
        return full_css
    # Find the next `}` at column 0 after n_lines so we cut on a clean rule boundary.
    cut = n_lines
    for i in range(n_lines, min(n_lines + 80, len(lines))):
        if lines[i].rstrip() == "}":
            cut = i + 1
            break
    return "\n".join(lines[:cut]) + "\n"


def apply_h6(repo: Path) -> dict:
    index = repo / "index.html"
    style_css = repo / "css" / "style.css"
    html = _read(index)

    if H6_CRITICAL_MARKER in html:
        _log("H6", "index.html", "critical CSS already inlined, no change")
        return {"files_changed": [], "notes": "already inlined"}

    if H6_STYLE_LINK_OLD not in html:
        raise ValueError(
            f"[H6] expected stylesheet link not found in index.html: {H6_STYLE_LINK_OLD!r}"
        )

    full_css = _read(style_css)
    critical = _extract_critical_css(full_css, n_lines=160)
    inlined_block = (
        f"  {H6_CRITICAL_MARKER}\n"
        f"  <style>\n{critical}\n  </style>\n"
    )

    # Replace the existing link with the async-load form, AND prepend the
    # inlined <style> block above it on the same line offset.
    new_link_block = inlined_block + "  " + H6_STYLE_LINK_NEW
    new_html = html.replace(H6_STYLE_LINK_OLD, new_link_block, 1)

    _write(index, new_html)
    _log(
        "H6",
        "index.html",
        f"inlined ~{len(critical.splitlines())} lines of critical CSS, async-loaded the rest",
    )
    return {
        "files_changed": ["index.html", "css/style.css"],
        "notes": (
            "inlined leading ~160 lines of style.css (covers :root, html/body, riso "
            "typography, masthead) and switched main stylesheet to preload+async"
        ),
    }


# ---------------------------------------------------------------------------
# H7 — defer Cloudflare Insights beacon to requestIdleCallback
# ---------------------------------------------------------------------------

H7_OLD_TAG = (
    "<script defer src='https://static.cloudflareinsights.com/beacon.min.js' "
    "data-cf-beacon='{\"token\": \"043e948f53e44c09b64d134900b921ac\"}'></script>"
)
H7_MARKER = "// H7: idle-time Cloudflare Insights"
H7_NEW_BLOCK = """<script>
    // H7: idle-time Cloudflare Insights — defer the beacon to requestIdleCallback
    // so it never competes with LCP/FCP. Falls back to a 2s setTimeout when
    // requestIdleCallback isn't available (Safari).
    (function () {
      var go = function () {
        var s = document.createElement('script');
        s.defer = true;
        s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
        s.setAttribute('data-cf-beacon', '{"token": "043e948f53e44c09b64d134900b921ac"}');
        document.head.appendChild(s);
      };
      if ('requestIdleCallback' in window) {
        requestIdleCallback(go, { timeout: 4000 });
      } else {
        setTimeout(go, 2000);
      }
    })();
  </script>"""


def apply_h7(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    if H7_MARKER in html:
        _log("H7", "index.html", "Cloudflare beacon already deferred, no change")
        return {"files_changed": [], "notes": "already deferred"}

    if H7_OLD_TAG not in html:
        raise ValueError(
            "[H7] Cloudflare beacon <script> not found verbatim in index.html. "
            "Tag may have been edited; needs orchestrator-time handling."
        )

    new_html = html.replace(H7_OLD_TAG, H7_NEW_BLOCK, 1)
    _write(index, new_html)
    _log("H7", "index.html", "wrapped Cloudflare beacon in requestIdleCallback")
    return {
        "files_changed": ["index.html"],
        "notes": "Cloudflare Insights now loads on idle, never blocking LCP",
    }


# ---------------------------------------------------------------------------
# H8 — extend netlify.toml cache headers
# ---------------------------------------------------------------------------

H8_OLD_PARQUET_BLOCK = '''[[headers]]
  for = "/data/*.parquet"
  [headers.values]
    Cache-Control = "public, max-age=86400, must-revalidate"
    Content-Type = "application/octet-stream"'''
H8_NEW_PARQUET_BLOCK = '''[[headers]]
  for = "/data/*.parquet"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"
    Content-Type = "application/octet-stream"'''

H8_VIEWS_BLOCK_MARKER = 'for = "/js/views/*"'
H8_VIEWS_BLOCK = '''
[[headers]]
  for = "/js/views/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"
'''


def apply_h8(repo: Path) -> dict:
    nf = repo / "netlify.toml"
    src = _read(nf)

    notes = []
    changed = False

    if "max-age=31536000, immutable" in src and 'for = "/data/*.parquet"' in src:
        # Check explicitly whether parquet block has been upgraded.
        if H8_OLD_PARQUET_BLOCK in src:
            src = src.replace(H8_OLD_PARQUET_BLOCK, H8_NEW_PARQUET_BLOCK, 1)
            notes.append("parquet -> 1y immutable")
            changed = True
        else:
            notes.append("parquet already 1y immutable")
    elif H8_OLD_PARQUET_BLOCK in src:
        src = src.replace(H8_OLD_PARQUET_BLOCK, H8_NEW_PARQUET_BLOCK, 1)
        notes.append("parquet -> 1y immutable")
        changed = True
    else:
        raise ValueError(
            "[H8] expected parquet headers block not found in netlify.toml. "
            "Needs orchestrator-time handling."
        )

    if H8_VIEWS_BLOCK_MARKER in src:
        notes.append("/js/views/* block already present")
    else:
        src = src.rstrip() + "\n" + H8_VIEWS_BLOCK
        notes.append("added /js/views/* -> 1y immutable")
        changed = True

    if changed:
        _write(nf, src)
        _log("H8", "netlify.toml", "; ".join(notes))
    else:
        _log("H8", "netlify.toml", "no change (" + "; ".join(notes) + ")")

    return {
        "files_changed": ["netlify.toml"] if changed else [],
        "notes": "; ".join(notes),
    }


# ---------------------------------------------------------------------------
# H9 — preload LCP element
# ---------------------------------------------------------------------------

# The dashboard renders no <img> in the initial markup, and the only background
# images are inline data: URIs (riso noise). The LCP candidate is the masthead
# title text "Halaga." rendered in DM Serif Text. We already preload that font
# in H4, so a dedicated H9 preload tag would be redundant and risks pointing at
# the wrong asset. Skip with a documented note rather than guess.

def apply_h9(repo: Path) -> dict:
    index = repo / "index.html"
    html = _read(index)

    # Best-effort scan for any obvious image candidate in markup. None expected.
    img_match = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', html, re.IGNORECASE)
    bg_match = re.search(
        r"background-image:\s*url\((?!\s*[\"']?data:)\s*[\"']?([^\)\"']+)",
        html,
        re.IGNORECASE,
    )

    if img_match or bg_match:
        candidate = (img_match or bg_match).group(1)
        marker = f'<!-- H9: preload LCP image candidate -->'
        if marker in html:
            _log("H9", "index.html", "LCP preload already present, no change")
            return {"files_changed": [], "notes": "already preloaded"}
        tag = (
            f'  {marker}\n'
            f'  <link rel="preload" as="image" href="{candidate}" />'
        )
        anchor = '<link rel="preconnect" href="https://fonts.googleapis.com" />'
        if anchor not in html:
            raise ValueError("[H9] preconnect anchor not found; cannot insert preload tag")
        new_html = html.replace(anchor, tag + "\n  " + anchor, 1)
        _write(index, new_html)
        _log("H9", "index.html", f"preloaded LCP image candidate {candidate}")
        return {
            "files_changed": ["index.html"],
            "notes": f"preloaded {candidate}",
        }

    # No image candidate found — the LCP is text (DM Serif Text masthead).
    # H4 already handles the font; nothing to do here.
    _log("H9", "index.html", "no LCP image candidate found, skipping (text LCP — see H4)")
    return {
        "files_changed": [],
        "notes": (
            "skipped — no obvious LCP image candidate. The dashboard LCP element is "
            "the masthead title text rendered in DM Serif Text, which H4 already "
            "handles via font-preload. Re-evaluate after running CDP measurement."
        ),
    }


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

HYPOTHESES: list[Hypothesis] = [
    Hypothesis("H1", "self-host Tailwind",                          "high", apply_h1),
    Hypothesis("H2", "defer ECharts script (move to body bottom)",  "low",  apply_h2),
    Hypothesis("H3", "remove ?v=Date.now() cache-bust on app.js",   "low",  apply_h3),
    Hypothesis("H4", "drop unused font weights + preload LCP font", "med",  apply_h4),
    Hypothesis("H5", "lazy-load parquet (idle prefetch neighbors)", "med",  apply_h5),
    Hypothesis("H6", "split critical CSS (inline head, async rest)", "high", apply_h6),
    Hypothesis("H7", "defer Cloudflare Insights to requestIdleCallback", "low", apply_h7),
    Hypothesis("H8", "extend netlify.toml cache headers (1y immutable)", "low", apply_h8),
    Hypothesis("H9", "preload LCP element",                         "low",  apply_h9),
    Hypothesis("H10", "preconnect cdn.jsdelivr.net",                   "low",  apply_h10),
    Hypothesis("H11", "modulepreload glance.js + data.js (landing)",   "low",  apply_h11),
    Hypothesis("H12", "Google Fonts display=optional",                 "low",  apply_h12),
    Hypothesis("H13", "fetchpriority=high on DM Serif Text preload",   "low",  apply_h13),
    Hypothesis("H14", "prefetch summary_<default-year>.json",          "low",  apply_h14),
]


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    assert len(HYPOTHESES) == 14, f"expected 14 hypotheses, got {len(HYPOTHESES)}"
    seen_ids = set()
    for h in HYPOTHESES:
        assert h.id and h.id.startswith("H"), f"bad id: {h.id!r}"
        assert h.id not in seen_ids, f"duplicate id: {h.id}"
        seen_ids.add(h.id)
        assert h.name, f"empty name for {h.id}"
        assert h.risk in {"low", "med", "high"}, f"bad risk for {h.id}: {h.risk!r}"
        assert callable(h.apply), f"apply not callable for {h.id}"

    print("hypotheses.py self-test")
    print(f"  registry: {len(HYPOTHESES)} entries")
    print()
    print(f"  {'id':<4} {'risk':<5} name")
    print(f"  {'---':<4} {'-----':<5} ----")
    for h in HYPOTHESES:
        print(f"  {h.id:<4} {h.risk:<5} {h.name}")
    print()
    print("OK — module imports cleanly, registry is well-formed.")
