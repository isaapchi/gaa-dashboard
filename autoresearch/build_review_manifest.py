"""Emit a JSON manifest for visual-review.html.

Walks ``autoresearch/visual-baseline/`` and ``autoresearch/runs/visual-diffs/``
and produces ``autoresearch/runs/visual-diffs/manifest.json`` with one row
per (route x viewport) pairing. The row carries paths (relative to the
autoresearch/ folder so the static page can resolve them directly) plus a
freshly-recomputed diff_pct from pixelmatch.

Designed to be cheap to run after every loop iteration:

    python autoresearch/build_review_manifest.py

The page auto-refreshes the manifest every few seconds while the user is
reviewing, so just rebuilding the manifest is enough to push new diffs in
front of the human reviewer.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
from pathlib import Path

from PIL import Image
from pixelmatch.contrib.PIL import pixelmatch


# Keep these in lockstep with visual_check.VIEWS / VIEWPORTS so the manifest
# always presents the canonical 16 rows even when an image is missing
# (we'd rather surface a gap than silently drop it).
_ROUTES: list[tuple[str, str]] = [
    # (slug, human label)
    ("home",        "Overview"),
    ("timeline",    "Across Time"),
    ("departments", "Allocations"),
    ("regions",     "By Region"),
    ("expense",     "Expense Class"),
    ("compare",     "Compare NEP vs GAA"),
    ("explorer",    "Explorer"),
    ("about",       "About"),
]
_VIEWPORTS: list[str] = ["desktop", "mobile"]

# Pixelmatch sensitivity has to match visual_check.py so percentages on the
# review page line up with what the orchestrator was reading at decision time.
_PIXELMATCH_THRESHOLD = 0.1


def _diff_pct(baseline_path: Path, after_path: Path) -> float | None:
    """Recompute diff_pct using the same threshold as the gate.

    Returns None if either image is missing. Returns 100.0 on size mismatch
    (mirrors visual_check._diff_pair's contract).
    """
    if not baseline_path.exists() or not after_path.exists():
        return None
    try:
        img1 = Image.open(baseline_path).convert("RGBA")
        img2 = Image.open(after_path).convert("RGBA")
    except Exception:
        return None
    if img1.size != img2.size:
        return 100.0
    # We don't need the diff image (it was written by visual_check); just
    # the count. Passing output=None makes pixelmatch skip the raster.
    mismatched = pixelmatch(img1, img2, None,
                            threshold=_PIXELMATCH_THRESHOLD,
                            includeAA=True)
    total = img1.width * img1.height
    return float(mismatched / total * 100.0) if total else 0.0


def build_manifest(autoresearch_dir: Path) -> dict:
    baseline_dir = autoresearch_dir / "visual-baseline"
    diff_dir = autoresearch_dir / "runs" / "visual-diffs"

    rows: list[dict] = []
    for slug, label in _ROUTES:
        for vp in _VIEWPORTS:
            stem = f"{slug}-{vp}.png"
            baseline = baseline_dir / stem
            after = diff_dir / f"after_{stem}"
            diff = diff_dir / f"diff_{stem}"

            pct = _diff_pct(baseline, after)
            # Paths are written relative to the autoresearch/ folder so
            # visual-review.html (served from autoresearch/) can use them
            # verbatim in <img src>.
            def _rel(p: Path) -> str | None:
                if not p.exists():
                    return None
                return p.relative_to(autoresearch_dir).as_posix()

            rows.append({
                "route":     slug,
                "label":     label,
                "viewport":  vp,
                "baseline":  _rel(baseline),
                "after":     _rel(after),
                "diff":      _rel(diff),
                "diff_pct":  pct,
            })

    # Sort: rows with the biggest diff first. Missing diff_pct (no after
    # image yet) sinks to the bottom so problem views surface immediately.
    rows.sort(key=lambda r: (r["diff_pct"] is None,
                             -(r["diff_pct"] or 0.0)))

    pct_vals = [r["diff_pct"] for r in rows if r["diff_pct"] is not None]
    max_pct = max(pct_vals) if pct_vals else 0.0
    above_threshold = sum(1 for v in pct_vals if v > 0.5)

    return {
        "generated":       _dt.datetime.now(_dt.timezone.utc)
                             .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "max_diff_pct":    max_pct,
        "above_threshold": above_threshold,
        "threshold_pct":   0.5,
        "rows":            rows,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--autoresearch-dir",
        default=str(Path(__file__).parent),
        help="Path to the autoresearch/ folder (default: %(default)s).",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Manifest output path (default: <autoresearch>/runs/visual-diffs/manifest.json).",
    )
    args = parser.parse_args(argv)

    ar_dir = Path(args.autoresearch_dir).resolve()
    out_path = (Path(args.out) if args.out
                else ar_dir / "runs" / "visual-diffs" / "manifest.json")

    manifest = build_manifest(ar_dir)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"wrote {out_path}")
    print(f"  rows:            {len(manifest['rows'])}")
    print(f"  max_diff_pct:    {manifest['max_diff_pct']:.4f}%")
    print(f"  above_threshold: {manifest['above_threshold']} "
          f"(> {manifest['threshold_pct']}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
