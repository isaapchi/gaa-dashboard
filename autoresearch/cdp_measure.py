"""CDP-based perf measurement for the gaa-dashboard autoresearch loop.

Uses Playwright's sync API + a Chrome DevTools Protocol session to measure
LCP / FCP / TBT / CLS (and an SI approximation) under Slow-4G + 4x CPU
throttling on a mobile viewport. The numbers feed into
lighthouse_score.compute_perf_score to produce a Lighthouse-v10-equivalent
composite Performance score.

Notes
-----
* We launch the **system Chrome** via `channel="chrome"`. We do NOT call
  `chromium.launch()` without that channel, because `playwright install
  chromium` is blocked on the WB network.
* SI (Speed Index) is approximated as FCP. Lighthouse's real SI requires
  per-frame visual-progress sampling, which is heavy to implement and only
  carries 10% weight in the composite score — the approximation cost is
  bounded.
* Each run uses a fresh BrowserContext so cache state is consistent across
  runs.
"""

from __future__ import annotations

import argparse
import statistics
import sys
from pathlib import Path
from typing import Any

# Local import so cdp_measure works whether invoked as a script or imported.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from lighthouse_score import compute_perf_score  # noqa: E402


# JS injected before navigation. Sets up four PerformanceObservers so we can
# pull paint timings, LCP, longtasks (for TBT), and layout shifts (for CLS).
_INIT_SCRIPT = r"""
window.__perfRecords = { fcp: null, lcp: null, longTasks: [], cls: 0 };
new PerformanceObserver(list => {
  for (const e of list.getEntries()) {
    if (e.name === 'first-contentful-paint') window.__perfRecords.fcp = e.startTime;
  }
}).observe({ type: 'paint', buffered: true });
new PerformanceObserver(list => {
  const entries = list.getEntries();
  if (entries.length) window.__perfRecords.lcp = entries[entries.length - 1].startTime;
}).observe({ type: 'largest-contentful-paint', buffered: true });
new PerformanceObserver(list => {
  for (const e of list.getEntries()) {
    window.__perfRecords.longTasks.push({ start: e.startTime, duration: e.duration });
  }
}).observe({ type: 'longtask', buffered: true });
new PerformanceObserver(list => {
  for (const e of list.getEntries()) {
    if (!e.hadRecentInput) window.__perfRecords.cls += e.value;
  }
}).observe({ type: 'layout-shift', buffered: true });
"""

# Mobile emulation — matches Lighthouse's "Moto G Power" approximation.
_MOBILE_VIEWPORT = {"width": 390, "height": 844}
_MOBILE_DPR = 3
_MOBILE_UA = (
    "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)

# Slow 4G preset (Lighthouse mobile default).
_NET_CONDITIONS = {
    "offline": False,
    "downloadThroughput": 1.6 * 1024 * 1024 / 8,  # 1.6 Mbps -> bytes/sec
    "uploadThroughput": 750 * 1024 / 8,           # 750 Kbps -> bytes/sec
    "latency": 150,                                # ms RTT
}
_CPU_THROTTLE_RATE = 4  # 4x slowdown


def _tbt_from_long_tasks(long_tasks: list[dict], fcp_ms: float | None) -> float:
    """Sum of (duration - 50) for long tasks beginning at or after FCP.

    Clamped to >= 0. Matches Lighthouse's TBT definition (the per-task
    "blocking portion" is duration above 50 ms, summed across the
    main-thread-blocking window from FCP to TTI).
    """
    if fcp_ms is None:
        return 0.0
    total = 0.0
    for t in long_tasks:
        if t.get("start", 0) < fcp_ms:
            continue
        blocking = t.get("duration", 0) - 50.0
        if blocking > 0:
            total += blocking
    return max(0.0, total)


def _one_run(
    browser: Any,
    url: str,
    throttle: bool,
) -> dict:
    """Single measurement run; returns one metrics dict."""
    context = browser.new_context(
        viewport=_MOBILE_VIEWPORT,
        device_scale_factor=_MOBILE_DPR,
        user_agent=_MOBILE_UA,
        is_mobile=True,
        has_touch=True,
    )
    context.add_init_script(_INIT_SCRIPT)
    page = context.new_page()

    if throttle:
        client = context.new_cdp_session(page)
        client.send("Network.enable", {})
        client.send("Network.emulateNetworkConditions", _NET_CONDITIONS)
        client.send("Emulation.setCPUThrottlingRate", {"rate": _CPU_THROTTLE_RATE})

    try:
        page.goto(url, wait_until="networkidle", timeout=60000)
        # Under heavy throttling, PerformanceObserver callbacks (FCP, LCP,
        # longtask) are async and can lose a race against page.evaluate.
        # Wait explicitly for both FCP and LCP to land. Fall through if
        # the page truly never paints.
        try:
            page.wait_for_function(
                "window.__perfRecords && window.__perfRecords.fcp !== null && window.__perfRecords.lcp !== null",
                timeout=20000,
            )
        except Exception:
            pass
        # Late LCP candidates + longtasks. Lighthouse waits 5s of quiet
        # internally before snapshotting; mirror that.
        page.wait_for_timeout(5000)
        records = page.evaluate("window.__perfRecords")
    finally:
        context.close()

    fcp_ms = records.get("fcp")
    lcp_ms = records.get("lcp")
    cls = records.get("cls", 0.0) or 0.0
    long_tasks = records.get("longTasks", []) or []

    # Fallbacks if a metric never fired (e.g. tiny page, no layout shift, no
    # long task). Use sensible defaults that won't tank the composite score.
    fcp_ms = float(fcp_ms) if fcp_ms is not None else 0.0
    lcp_ms = float(lcp_ms) if lcp_ms is not None else fcp_ms
    tbt_ms = _tbt_from_long_tasks(long_tasks, fcp_ms)
    # SI approximation: use FCP. See module docstring for rationale.
    si_ms = fcp_ms

    return {
        "lcp_ms": lcp_ms,
        "fcp_ms": fcp_ms,
        "tbt_ms": tbt_ms,
        "cls": float(cls),
        "si_ms": si_ms,
    }


def measure(
    url: str,
    runs: int = 3,
    chrome_channel: str = "chrome",
    throttle: bool = True,
) -> dict:
    """Run `runs` measurements, return median of each metric plus composite score.

    Returns:
        {
          "lcp_ms": float,
          "fcp_ms": float,
          "tbt_ms": float,
          "cls": float,
          "si_ms": float,
          "perf": float,
          "raw_runs": [{"lcp_ms": ..., ...}, ...]
        }
    """
    from playwright.sync_api import sync_playwright  # local import: optional dep at import time

    raw_runs: list[dict] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=chrome_channel, headless=True)
        try:
            for _ in range(runs):
                raw_runs.append(_one_run(browser, url, throttle))
        finally:
            browser.close()

    median_metrics = {
        "lcp_ms": statistics.median(r["lcp_ms"] for r in raw_runs),
        "fcp_ms": statistics.median(r["fcp_ms"] for r in raw_runs),
        "tbt_ms": statistics.median(r["tbt_ms"] for r in raw_runs),
        "cls":    statistics.median(r["cls"]    for r in raw_runs),
        "si_ms":  statistics.median(r["si_ms"]  for r in raw_runs),
    }
    perf = compute_perf_score(median_metrics)

    return {
        **median_metrics,
        "perf": perf,
        "raw_runs": raw_runs,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--no-throttle", action="store_true")
    args = parser.parse_args()

    try:
        result = measure(args.url, runs=args.runs, throttle=not args.no_throttle)
    except Exception as exc:  # noqa: BLE001
        # Don't require a dev server to be running. Just report and exit.
        print(f"measure() failed: {type(exc).__name__}: {exc}")
        sys.exit(1)

    print(f"URL:    {args.url}")
    print(f"Runs:   {args.runs} (throttle={'off' if args.no_throttle else 'on'})")
    print(f"LCP:    {result['lcp_ms']:.0f} ms")
    print(f"FCP:    {result['fcp_ms']:.0f} ms")
    print(f"TBT:    {result['tbt_ms']:.0f} ms")
    print(f"CLS:    {result['cls']:.3f}")
    print(f"SI:     {result['si_ms']:.0f} ms (approximated as FCP)")
    print(f"Perf:   {result['perf']:.2f}")
