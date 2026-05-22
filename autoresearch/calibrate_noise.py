"""Capture the per-view rendering-noise floor.

Runs visual_check.check() with a huge threshold against an unchanged site,
records the per-view diff_pct (which represents pure render-to-render
variance), and writes autoresearch/noise-floor.json. The orchestrator loads
this file at run start and uses per-view threshold = max(0.5%, floor + 0.5%)
so noisy views (ECharts canvas anti-aliasing on regions-desktop /
expense-desktop, font-paint timing on explorer-mobile, etc.) don't false-
positive-block every iteration.

Run after:
  - Major site / CSS rewrites
  - Adding or removing a route
  - Suspect the gate is being too lenient (no recent KEEPs) or too strict
    (every iter BLOCKED_VISUAL)

Usage:
  python autoresearch/calibrate_noise.py
  # or to take the max of N runs (more conservative):
  python autoresearch/calibrate_noise.py --runs 3
"""
from __future__ import annotations

import argparse
import http.client
import json
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import visual_check  # noqa: E402

SERVE_PORT = 8765
SERVE_URL = f"http://localhost:{SERVE_PORT}"
BASELINE_DIR = HERE / "visual-baseline"
DIFF_DIR = HERE / "runs" / "visual-diffs"
NOISE_FLOOR_PATH = HERE / "noise-floor.json"


def _server_up(port: int = SERVE_PORT) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def _ensure_dev_server() -> subprocess.Popen | None:
    if _server_up():
        return None
    proc = subprocess.Popen(
        [sys.executable, "serve.py"],
        cwd=str(REPO_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(30):
        if _server_up():
            return proc
        time.sleep(0.5)
    raise RuntimeError("dev server failed to come up within 15s")


def _git_sha() -> str:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip()
    except Exception:
        return "unknown"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=1,
                        help="Number of noise-calibration runs; per-view floor = max across runs")
    parser.add_argument("--skip-baseline", action="store_true",
                        help="Skip the initial baseline recapture (use existing PNGs)")
    args = parser.parse_args(argv)

    proc = _ensure_dev_server()
    try:
        if not args.skip_baseline:
            print("Capturing fresh baseline screenshots...")
            BASELINE_DIR.mkdir(parents=True, exist_ok=True)
            visual_check.capture_baseline(SERVE_URL, BASELINE_DIR)
            print(f"  wrote {len(list(BASELINE_DIR.glob('*.png')))} baseline PNGs")

        per_view_max: dict[str, float] = {}
        for run_n in range(1, args.runs + 1):
            print(f"\nCalibration run {run_n}/{args.runs}...")
            result = visual_check.check(
                url=SERVE_URL,
                baseline_dir=BASELINE_DIR,
                diff_dir=DIFF_DIR,
                threshold_pct=999.0,  # any-fail disabled; we just want diff_pct
            )
            for key, view_result in result["per_view"].items():
                pct = float(view_result.get("diff_pct", 0.0))
                if pct > per_view_max.get(key, 0.0):
                    per_view_max[key] = pct
            top = sorted(per_view_max.items(), key=lambda kv: -kv[1])[:5]
            print(f"  top-5 max-so-far: {top}")

        payload = {
            "_description": (
                "Per-view rendering noise floor in percent pixel-diff. Captured by "
                "running visual_check.check() against the baseline with ZERO source "
                "changes — any non-zero value here is irreducible canvas anti-aliasing, "
                "font-paint timing, or scroll/IntersectionObserver variance. Gate "
                "threshold per view is max(0.5%, floor + 0.5%) so the gate still "
                "catches real visual changes on noisy views without false-positive-"
                "blocking every iteration. Regenerate via "
                "`python autoresearch/calibrate_noise.py` after major site/CSS rewrites."
            ),
            "_captured": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M"),
            "_baseline_commit": _git_sha(),
            "_runs": args.runs,
            "per_view": {k: round(per_view_max.get(k, 0.0), 4) for k in sorted(per_view_max)},
        }
        NOISE_FLOOR_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"\nwrote {NOISE_FLOOR_PATH}")
        noisy = {k: v for k, v in payload["per_view"].items() if v > 0.0}
        if noisy:
            print(f"non-zero noise floors ({len(noisy)} views):")
            for k, v in sorted(noisy.items(), key=lambda kv: -kv[1]):
                print(f"  {k:25s} {v:6.3f}%")
        else:
            print("all views clean (0.000% noise)")
        return 0
    finally:
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
