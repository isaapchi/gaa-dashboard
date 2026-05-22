"""Visual-regression gate for the autoresearch loop.

Captures Playwright screenshots of all SPA views at two viewports
(mobile 390x844 DPR=3, desktop 1280x800 DPR=1) and diffs them with
pixelmatch. Used by orchestrator.py to KEEP/REVERT iterations.

Routes were discovered by reading:
  - index.html       (#nav links)
  - js/app.js        (VIEWS map)

The SPA exposes these user-facing hash routes (the "View" dropdown
groups timeline/departments/regions/expense under one nav trigger,
but each is a separate route the user can land on):
  ""             -> Overview (default landing, no hash)
  "#timeline"    -> Across Time
  "#departments" -> Allocations
  "#regions"     -> By Region
  "#expense"     -> Expense Class
  "#compare"     -> Compare NEP vs enacted GAA
  "#explorer"    -> Explorer
  "#about"       -> About

"#glance" is an alias for "#overview" (same renderer) and is omitted
to avoid duplicate baselines. "#dept/..." is a dynamic drilldown
requiring an argument and is intentionally not covered by the gate;
it is reached from "#departments" and shares its rendering surface.

Browser: we MUST use channel="chrome" (system Chrome at
C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe) because
`python -m playwright install chromium` is blocked on this network.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Optional

from PIL import Image
from pixelmatch.contrib.PIL import pixelmatch
from playwright.sync_api import sync_playwright


# ---------------------------------------------------------------------------
# Public constants (orchestrator depends on these names)
# ---------------------------------------------------------------------------

VIEWS: list[str] = [
    "",              # default landing -> Overview
    "#timeline",
    "#departments",
    "#regions",
    "#expense",
    "#compare",
    "#explorer",
    "#about",
]

VIEWPORTS: dict[str, tuple[int, int]] = {
    "mobile":  (390, 844),
    "desktop": (1280, 800),
}

# Device pixel ratios per viewport (mobile retina, desktop standard).
_DPR: dict[str, int] = {"mobile": 3, "desktop": 1}

# CSS injected post-load: kills CSS transitions and animations so
# ECharts canvas paints and any CSS micro-interactions render at their
# settled state. Crucial for pixel-deterministic diffs.
_KILL_ANIM_CSS = (
    "*, *::before, *::after {"
    " animation-duration: 0s !important;"
    " animation-delay: 0s !important;"
    " transition-duration: 0s !important;"
    " transition-delay: 0s !important;"
    "}"
)

# Seconds to wait after networkidle for late-binding post-load animations
# (ECharts series reveal, font swap, etc.) before screenshotting.
_POST_LOAD_SETTLE_SEC = 1.5

# Per-view pixelmatch sensitivity: 0.1 is the project default in the plan.
_PIXELMATCH_THRESHOLD = 0.1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _view_slug(view: str) -> str:
    """Hash -> filesystem-safe slug. Empty hash -> 'home'."""
    if not view:
        return "home"
    return view.lstrip("#") or "home"


def _png_name(view: str, viewport: str) -> str:
    return f"{_view_slug(view)}-{viewport}.png"


def _capture_one(page, full_url: str, out_path: Path) -> None:
    """Navigate + settle + screenshot. Caller owns the page lifecycle."""
    page.goto(full_url, wait_until="networkidle", timeout=60_000)
    page.emulate_media(reduced_motion="reduce")
    page.add_style_tag(content=_KILL_ANIM_CSS)
    # Settle: let any post-networkidle async work (echarts series animation
    # that wasn't squashed by the CSS, font swap, IntersectionObserver
    # reveals) finish before we shoot.
    time.sleep(_POST_LOAD_SETTLE_SEC)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Viewport-only (not full_page) so screenshots have IDENTICAL dimensions
    # across runs. full_page heights vary with chart sizing / SPA data and
    # cause 100% diff (size-mismatch) on visually-equivalent loads.
    # Above-the-fold is where most layout regressions appear anyway.
    page.screenshot(full_page=False, path=str(out_path))


def _diff_pair(baseline_path: Path, after_path: Path, diff_path: Path) -> dict:
    """Pixelmatch two PNGs. If sizes differ, record 100% mismatch.

    Returns {"diff_pct": float, "diff_pixels": int, "total_pixels": int}.
    """
    img1 = Image.open(baseline_path).convert("RGBA")
    img2 = Image.open(after_path).convert("RGBA")

    if img1.size != img2.size:
        # Layout changed shape (full-page screenshots have variable height).
        # Mark as full mismatch; draw a side-by-side diff at the larger size
        # so the user can still inspect what changed.
        w = max(img1.width, img2.width)
        h = max(img1.height, img2.height)
        canvas = Image.new("RGBA", (w, h), (255, 0, 255, 255))  # magenta = size mismatch
        # Overlay the after image so the user has something visual.
        canvas.paste(img2, (0, 0))
        diff_path.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(diff_path)
        total = img1.width * img1.height
        return {
            "diff_pct": 100.0,
            "diff_pixels": total,
            "total_pixels": total,
            "size_mismatch": True,
            "baseline_size": list(img1.size),
            "after_size": list(img2.size),
        }

    diff_img = Image.new("RGBA", img1.size)
    mismatched = pixelmatch(
        img1, img2, diff_img,
        threshold=_PIXELMATCH_THRESHOLD,
        includeAA=True,
    )
    diff_path.parent.mkdir(parents=True, exist_ok=True)
    diff_img.save(diff_path)
    total = img1.width * img1.height
    diff_pct = (mismatched / total * 100.0) if total else 0.0
    return {
        "diff_pct": float(diff_pct),
        "diff_pixels": int(mismatched),
        "total_pixels": int(total),
        "size_mismatch": False,
    }


def _capture_all(
    url: str,
    out_dir: Path,
    chrome_channel: str,
) -> list[Path]:
    """Capture every VIEWS x VIEWPORTS PNG into out_dir.

    One browser, one context per viewport (so viewport+DPR applies cleanly).
    Reuses a single page per context across all views.
    Returns list of absolute paths written.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=chrome_channel, headless=True)
        try:
            for vp_name, (vw, vh) in VIEWPORTS.items():
                context = browser.new_context(
                    viewport={"width": vw, "height": vh},
                    device_scale_factor=_DPR[vp_name],
                )
                try:
                    page = context.new_page()
                    for view in VIEWS:
                        target = url.rstrip("/") + "/" + view if view else url
                        out_path = out_dir / _png_name(view, vp_name)
                        _capture_one(page, target, out_path)
                        written.append(out_path)
                finally:
                    context.close()
        finally:
            browser.close()
    return written


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def capture_baseline(
    url: str,
    baseline_dir: Path,
    chrome_channel: str = "chrome",
) -> dict:
    """Capture all VIEWS x VIEWPORTS PNGs into baseline_dir.

    Returns {"captured": N, "paths": [str, ...]}.
    """
    baseline_dir = Path(baseline_dir)
    paths = _capture_all(url, baseline_dir, chrome_channel)
    return {
        "captured": len(paths),
        "paths": [str(p) for p in paths],
    }


def check(
    url: str,
    baseline_dir: Path,
    diff_dir: Path,
    threshold_pct: float = 0.5,
    chrome_channel: str = "chrome",
    noise_floor: dict | None = None,
) -> dict:
    """Re-capture, diff vs baseline. See module docstring for return shape.

    Per-view threshold = max(threshold_pct, noise_floor[view_key] + threshold_pct)
    so views with irreducible canvas/font-paint noise (regions-desktop,
    expense-desktop, explorer-mobile in practice) still get caught when a real
    visual change pushes them above their personal noise envelope. Without
    this, ECharts canvas anti-aliasing produces 4-6% false-positive blocks on
    chart-heavy views and the loop can never KEEP anything on noisy views.
    """
    baseline_dir = Path(baseline_dir)
    diff_dir = Path(diff_dir)
    diff_dir.mkdir(parents=True, exist_ok=True)
    noise_floor = noise_floor or {}

    # 1. Capture "after" images alongside the diffs.
    after_dir = diff_dir
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=chrome_channel, headless=True)
        try:
            for vp_name, (vw, vh) in VIEWPORTS.items():
                context = browser.new_context(
                    viewport={"width": vw, "height": vh},
                    device_scale_factor=_DPR[vp_name],
                )
                try:
                    page = context.new_page()
                    for view in VIEWS:
                        target = url.rstrip("/") + "/" + view if view else url
                        after_path = after_dir / f"after_{_png_name(view, vp_name)}"
                        _capture_one(page, target, after_path)
                finally:
                    context.close()
        finally:
            browser.close()

    # 2. Diff each pair.
    per_view: dict[str, dict] = {}
    max_diff_pct = 0.0
    failing: list[str] = []
    for vp_name in VIEWPORTS:
        for view in VIEWS:
            key = f"{_view_slug(view)}-{vp_name}"
            baseline_path = baseline_dir / _png_name(view, vp_name)
            after_path = after_dir / f"after_{_png_name(view, vp_name)}"
            diff_path = diff_dir / f"diff_{_png_name(view, vp_name)}"
            if not baseline_path.exists():
                # No baseline for this view -> treat as full mismatch so the
                # orchestrator surfaces the gap rather than silently passing.
                per_view[key] = {
                    "diff_pct": 100.0,
                    "diff_pixels": 0,
                    "total_pixels": 0,
                    "size_mismatch": False,
                    "missing_baseline": True,
                }
                max_diff_pct = 100.0
                failing.append(key)
                continue
            result = _diff_pair(baseline_path, after_path, diff_path)
            per_view[key] = result
            # Per-view threshold accounts for that view's irreducible noise.
            # A view's gate fails only when its diff exceeds its own envelope.
            view_floor = noise_floor.get(key, 0.0)
            view_threshold = max(threshold_pct, view_floor + threshold_pct)
            result["threshold_pct"] = view_threshold
            result["noise_floor_pct"] = view_floor
            if result["diff_pct"] > max_diff_pct:
                max_diff_pct = result["diff_pct"]
            if result["diff_pct"] > view_threshold:
                failing.append(key)

    return {
        "max_diff_pct": float(max_diff_pct),
        "per_view": per_view,
        "fail": bool(failing),
        "failing_views": failing,
    }


# ---------------------------------------------------------------------------
# Self-test CLI
# ---------------------------------------------------------------------------

def _main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Visual-regression gate for the autoresearch loop."
    )
    parser.add_argument("--baseline", action="store_true",
                        help="Capture baseline PNGs into --baseline-dir.")
    parser.add_argument("--check", action="store_true",
                        help="Re-capture and diff vs --baseline-dir.")
    parser.add_argument("--list-views", action="store_true",
                        help="Print discovered VIEWS and exit (no network).")
    parser.add_argument("--url", default="http://localhost:8000",
                        help="Base URL (default: %(default)s).")
    parser.add_argument(
        "--baseline-dir",
        default=str(Path(__file__).parent / "visual-baseline"),
        help="Where baseline PNGs live (default: %(default)s).",
    )
    parser.add_argument(
        "--diff-dir",
        default=str(Path(__file__).parent / "visual-diff"),
        help="Where after_*.png and diff_*.png are written (default: %(default)s).",
    )
    parser.add_argument("--threshold-pct", type=float, default=0.5,
                        help="Per-view fail threshold in percent (default: %(default)s).")
    parser.add_argument("--chrome-channel", default="chrome",
                        help="Playwright browser channel (default: %(default)s).")
    args = parser.parse_args(argv)

    if args.list_views:
        print("Discovered hash routes:")
        for v in VIEWS:
            label = v if v else "(empty -> overview)"
            print(f"  {label}")
        print()
        print("Viewports:")
        for name, (w, h) in VIEWPORTS.items():
            print(f"  {name}: {w}x{h} @ DPR={_DPR[name]}")
        print()
        print(f"Total screenshots per run: {len(VIEWS) * len(VIEWPORTS)}")
        return 0

    if args.baseline:
        result = capture_baseline(
            url=args.url,
            baseline_dir=Path(args.baseline_dir),
            chrome_channel=args.chrome_channel,
        )
        print(f"Captured {result['captured']} baseline PNGs into "
              f"{args.baseline_dir}")
        for p in result["paths"]:
            print(f"  {p}")
        return 0

    if args.check:
        result = check(
            url=args.url,
            baseline_dir=Path(args.baseline_dir),
            diff_dir=Path(args.diff_dir),
            threshold_pct=args.threshold_pct,
            chrome_channel=args.chrome_channel,
        )
        print(f"max_diff_pct: {result['max_diff_pct']:.4f}% "
              f"(threshold {args.threshold_pct}%)")
        print(f"fail: {result['fail']}")
        if result["failing_views"]:
            print("failing views:")
            for k in result["failing_views"]:
                d = result["per_view"][k]
                print(f"  {k}: {d['diff_pct']:.4f}% "
                      f"({d['diff_pixels']}/{d['total_pixels']} px)")
        print()
        print("per-view detail:")
        for k, d in result["per_view"].items():
            print(f"  {k:30s} {d['diff_pct']:.4f}%")
        return 1 if result["fail"] else 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(_main())
