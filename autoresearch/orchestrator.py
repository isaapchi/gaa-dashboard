"""Autoresearch orchestrator.

Runs the Karpathy-style closed loop:
  baseline (visual + perf) -> for each H1..H9: snapshot -> apply -> smoke
  -> visual gate -> perf gate -> KEEP/REVERT -> commit (or git restore) -> next.

Never runs `git push`. Final status is "complete" and the dashboard surfaces a
deploy-readiness banner; pushing requires explicit user approval in chat.
"""
from __future__ import annotations

import argparse
import http.client
import os
import socket
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import state  # noqa: E402
import hypotheses  # noqa: E402
import visual_check  # noqa: E402
import cdp_measure  # noqa: E402


SERVE_PORT = 8765
SERVE_URL = f"http://localhost:{SERVE_PORT}"
DASHBOARD_PATH = "/autoresearch/dashboard.html"
STOP_SENTINEL = HERE / "STOP"
BASELINE_DIR = HERE / "visual-baseline"
DIFF_DIR = HERE / "runs" / "visual-diffs"
RUNS_DIR = HERE / "runs"
BRANCH = "perf/autoresearch"


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def server_is_up(port: int = SERVE_PORT) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def ensure_dev_server() -> subprocess.Popen | None:
    if server_is_up():
        log(f"dev server already up on :{SERVE_PORT}")
        return None
    log(f"starting `python serve.py` on :{SERVE_PORT}")
    proc = subprocess.Popen(
        [sys.executable, "serve.py"],
        cwd=str(REPO_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )
    for _ in range(30):
        if server_is_up():
            log(f"dev server is up (PID {proc.pid})")
            return proc
        time.sleep(0.5)
    raise RuntimeError("dev server failed to come up within 15s")


def shutdown_dev_server(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def git(*args: str, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    cmd = ["git", "-C", str(REPO_ROOT), *args]
    res = subprocess.run(
        cmd,
        check=check,
        capture_output=capture,
        text=True,
    )
    return res


def ensure_branch() -> None:
    head = git("rev-parse", "--abbrev-ref", "HEAD", capture=True).stdout.strip()
    if head == BRANCH:
        log(f"on branch {BRANCH}")
        return
    log(f"switching from {head} to {BRANCH}")
    git("checkout", BRANCH)


def git_clean_or_snapshot(message: str) -> str | None:
    """Commit any current changes as a snapshot. Returns SHA, or None if nothing to commit."""
    status = git("status", "--porcelain", capture=True).stdout.strip()
    if not status:
        return None
    git("add", "-A")
    git("commit", "-m", message, "--no-verify")
    return git("rev-parse", "HEAD", capture=True).stdout.strip()


def git_restore_all() -> None:
    """Discard ALL working-tree changes back to HEAD, including new untracked files.

    `git restore .` alone only reverts tracked files. Applier-created files
    (e.g. css/tailwind.css from H1) are untracked and survive `restore`,
    polluting the next iteration's snapshot. `git clean -fd` removes them
    while respecting .gitignore (so state.json, runs/, bin/ are preserved).
    """
    git("restore", ".")
    git("clean", "-fd")


def smoke_check(url: str) -> bool:
    """Confirm the home URL returns 200 and contains <html>."""
    try:
        conn = http.client.HTTPConnection("127.0.0.1", SERVE_PORT, timeout=10)
        conn.request("GET", "/")
        resp = conn.getresponse()
        ok = resp.status == 200
        body = resp.read(2048).decode("utf-8", errors="ignore")
        conn.close()
        return ok and "<html" in body.lower()
    except Exception as e:
        log(f"smoke check error: {e}")
        return False


def relative_files_changed(files: list[str]) -> list[str]:
    return [str(Path(f).as_posix()) for f in files]


def fmt_metrics(m: dict | None) -> str:
    if m is None:
        return "n/a"
    return (
        f"LCP={m.get('lcp_ms', 0):.0f}ms "
        f"FCP={m.get('fcp_ms', 0):.0f}ms "
        f"TBT={m.get('tbt_ms', 0):.0f}ms "
        f"perf={m.get('perf', 0):.2f}"
    )


def delta(curr: dict, base: dict, fields: tuple[str, ...] = ("lcp_ms", "fcp_ms", "tbt_ms", "perf")) -> dict:
    return {f: round(curr.get(f, 0) - base.get(f, 0), 4) for f in fields}


# ---------- main loop ----------


def run(dry_run: bool = False, baseline_only: bool = False, measure_only: bool = False, runs: int = 3) -> int:
    proc = None
    try:
        ensure_branch()
        proc = ensure_dev_server()

        if measure_only:
            metrics = cdp_measure.measure(SERVE_URL, runs=runs)
            log(f"measured: {fmt_metrics(metrics)}")
            return 0

        log("init state.json")
        state.init_state()
        state.set_status("running")
        state.set_phase("baseline")

        log("capture baseline screenshots")
        BASELINE_DIR.mkdir(parents=True, exist_ok=True)
        visual_check.capture_baseline(SERVE_URL, BASELINE_DIR)

        if baseline_only:
            log("baseline-only mode complete")
            state.set_status("complete")
            return 0

        log(f"measure baseline perf (×{runs})")
        baseline_metrics = cdp_measure.measure(SERVE_URL, runs=runs)
        log(f"baseline: {fmt_metrics(baseline_metrics)}")
        state.update(baseline=baseline_metrics)

        # Add iter 0 (baseline) as a row in the iteration log for dashboard rendering
        state.add_iter({
            "n": 0,
            "hypothesis": {"id": "baseline", "name": "baseline"},
            "files_changed": [],
            "visual_diff_pct": {},
            "metrics": baseline_metrics,
            "delta_vs_last_kept": {"lcp_ms": 0, "fcp_ms": 0, "tbt_ms": 0, "perf": 0.0},
            "decision": "BASELINE",
            "commit_sha": None,
            "duration_sec": 0,
        })

        last_kept_metrics = baseline_metrics
        last_kept_iter = 0

        for n, h in enumerate(hypotheses.HYPOTHESES, start=1):
            if STOP_SENTINEL.exists():
                log("STOP sentinel present — halting")
                state.set_status("paused")
                STOP_SENTINEL.unlink(missing_ok=True)
                return 0

            iter_start = time.time()
            log(f"--- iter {n}: {h.id} {h.name} (risk={h.risk})")
            state.update(current_iter=n, current_hypothesis={"id": h.id, "name": h.name})
            iter_record = {
                "n": n,
                "hypothesis": {"id": h.id, "name": h.name, "risk": h.risk},
                "files_changed": [],
                "visual_diff_pct": {},
                "metrics": None,
                "delta_vs_last_kept": None,
                "decision": "PENDING",
                "commit_sha": None,
                "duration_sec": 0,
                "notes": "",
            }
            state.set_current_iter_record(iter_record)

            try:
                state.set_phase("snapshot")
                snap_sha = git_clean_or_snapshot(f"iter {n} snap before {h.id}")
                log(f"  snapshot: {snap_sha or 'clean'}")

                if dry_run:
                    log(f"  [dry-run] would apply {h.id}")
                    iter_record["decision"] = "DRY_RUN"
                    iter_record["notes"] = "dry-run: applier not invoked"
                    iter_record["duration_sec"] = round(time.time() - iter_start, 1)
                    state.add_iter(iter_record)
                    state.set_current_iter_record(None)
                    continue

                state.set_phase("applying")
                log(f"  applying {h.id}...")
                apply_result = h.apply(REPO_ROOT)
                iter_record["files_changed"] = relative_files_changed(apply_result.get("files_changed", []))
                iter_record["notes"] = apply_result.get("notes", "")
                state.set_current_iter_record(iter_record)
                log(f"  files_changed: {iter_record['files_changed']}")

                if not iter_record["files_changed"]:
                    log("  applier reported no changes — skipping gates, marking SKIPPED")
                    iter_record["decision"] = "SKIPPED"
                    iter_record["duration_sec"] = round(time.time() - iter_start, 1)
                    state.add_iter(iter_record)
                    state.set_current_iter_record(None)
                    continue

                state.set_phase("smoke")
                if not smoke_check(SERVE_URL):
                    log("  smoke check failed — reverting")
                    git_restore_all()
                    iter_record["decision"] = "REVERT"
                    iter_record["notes"] = "smoke check failed (page did not load)"
                    iter_record["duration_sec"] = round(time.time() - iter_start, 1)
                    state.add_iter(iter_record)
                    state.set_current_iter_record(None)
                    continue

                state.set_phase("visual_gate")
                log("  visual gate...")
                # Threshold 50% catches catastrophic layout breakage (view
                # gone blank, content shifted off-screen, fundamentally
                # different page) while tolerating run-to-run pixel noise
                # from ECharts canvas anti-aliasing and async render timing
                # (empirically 5-15% on chart-heavy views). All diffs are
                # saved to DIFF_DIR for manual review before any deploy.
                visual = visual_check.check(SERVE_URL, BASELINE_DIR, DIFF_DIR, threshold_pct=50.0)
                iter_record["visual_diff_pct"] = {
                    k: round(v["diff_pct"], 3) for k, v in visual.get("per_view", {}).items()
                }
                log(f"  visual max diff: {visual.get('max_diff_pct', 0):.3f}%")
                state.set_current_iter_record(iter_record)

                if visual.get("fail"):
                    log(f"  BLOCKED_VISUAL: {visual.get('failing_views', [])}")
                    git_restore_all()
                    iter_record["decision"] = "BLOCKED_VISUAL"
                    iter_record["duration_sec"] = round(time.time() - iter_start, 1)
                    state.add_iter(iter_record)
                    state.set_current_iter_record(None)
                    continue

                state.set_phase("perf_gate")
                log(f"  perf gate (×{runs})...")
                metrics = cdp_measure.measure(SERVE_URL, runs=runs)
                iter_record["metrics"] = metrics
                iter_record["delta_vs_last_kept"] = delta(metrics, last_kept_metrics)
                log(f"  {fmt_metrics(metrics)}")
                log(f"  delta vs iter {last_kept_iter}: {iter_record['delta_vs_last_kept']}")
                state.set_current_iter_record(iter_record)

                state.set_phase("deciding")
                if metrics["perf"] > last_kept_metrics["perf"]:
                    log("  KEEP")
                    state.set_phase("committing")
                    delta_str = (
                        f"LCP{iter_record['delta_vs_last_kept']['lcp_ms']:+.0f}ms "
                        f"FCP{iter_record['delta_vs_last_kept']['fcp_ms']:+.0f}ms "
                        f"TBT{iter_record['delta_vs_last_kept']['tbt_ms']:+.0f}ms "
                        f"perf{iter_record['delta_vs_last_kept']['perf']:+.3f}"
                    )
                    git("add", "-A")
                    git("commit", "-m", f"perf: {h.id} {h.name} ({delta_str})", "--no-verify")
                    iter_record["commit_sha"] = git("rev-parse", "HEAD", capture=True).stdout.strip()[:7]
                    iter_record["decision"] = "KEEP"
                    last_kept_metrics = metrics
                    last_kept_iter = n
                else:
                    log("  REVERT (perf did not improve vs last kept)")
                    git_restore_all()
                    iter_record["decision"] = "REVERT"

            except ValueError as e:
                log(f"  applier ValueError: {e}")
                git_restore_all()
                iter_record["decision"] = "FAILED_APPLY"
                iter_record["notes"] = f"applier raised: {e}"
            except Exception as e:
                log(f"  unexpected error: {e}")
                traceback.print_exc()
                git_restore_all()
                iter_record["decision"] = "ERROR"
                iter_record["notes"] = f"{type(e).__name__}: {e}"

            iter_record["duration_sec"] = round(time.time() - iter_start, 1)
            state.add_iter(iter_record)
            state.set_current_iter_record(None)

        # final summary
        state.set_phase("complete")
        state.set_status("complete")
        s = state.read()
        totals = delta(last_kept_metrics, baseline_metrics)
        s["summary"]["totals_vs_baseline"] = totals
        state.write(s)
        log("LOCAL LOOP COMPLETE.")
        log(f"totals vs baseline: {totals}")
        log("DO NOT push to Netlify without explicit user approval.")
        return 0

    finally:
        if proc:
            shutdown_dev_server(proc)


def main() -> int:
    ap = argparse.ArgumentParser(description="Autoresearch perf optimization loop")
    ap.add_argument("--dry-run", action="store_true", help="walk hypotheses without applying changes")
    ap.add_argument("--baseline-only", action="store_true", help="capture baseline screenshots and exit")
    ap.add_argument("--measure-only", action="store_true", help="measure current perf and exit")
    ap.add_argument("--runs", type=int, default=3, help="lighthouse runs per gate (default 3)")
    args = ap.parse_args()
    return run(
        dry_run=args.dry_run,
        baseline_only=args.baseline_only,
        measure_only=args.measure_only,
        runs=args.runs,
    )


if __name__ == "__main__":
    sys.exit(main())
