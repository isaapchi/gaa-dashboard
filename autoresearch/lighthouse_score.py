"""Lighthouse v10 mobile scoring math.

Pure Python, no third-party dependencies. Mirrors the documented log-normal
scoring curves used by Lighthouse-the-CLI so that perf scores computed here
agree with the official Lighthouse score to within ~1-3 points (the residual
gap is from SI being approximated as FCP — see cdp_measure.py).

References:
  - https://github.com/GoogleChrome/lighthouse/blob/main/core/lib/lh-error.js
  - https://googlechrome.github.io/lighthouse/scorecalc/
"""

from __future__ import annotations

import math


# Lighthouse v10 mobile scoring curve parameters.
# Each metric maps to (weight, p10, median).
#   p10    = value at which the metric scores 0.90 ("good" threshold)
#   median = value at which the metric scores 0.50 ("needs improvement")
# CLS is a unitless ratio; all others are milliseconds.
_CURVES = {
    "fcp_ms": {"weight": 0.10, "p10": 1800.0, "median": 3000.0},
    "si_ms":  {"weight": 0.10, "p10": 3387.0, "median": 5800.0},
    "lcp_ms": {"weight": 0.25, "p10": 2500.0, "median": 4000.0},
    "tbt_ms": {"weight": 0.30, "p10":  200.0, "median":  600.0},
    "cls":    {"weight": 0.25, "p10":    0.1, "median":    0.25},
}


def audit_score(value: float, p10: float, median: float) -> float:
    """Log-normal CDF mapping value -> [0..1] score.

    Higher value = lower score for time metrics (and for CLS, which is also
    "more = worse"). Implementation follows the Lighthouse v10 documented
    formula: build a log-normal distribution whose CDF passes through
    (p10, 0.90) and (median, 0.50), then score = 1 - CDF(value).
    """
    # 1.2816 is the standard-normal quantile at p=0.9 (so that CDF(p10)=0.10
    # in log-space, i.e. score=0.90).
    log_ratio = math.log(p10 / median)
    sigma = log_ratio / -1.2816
    mu = math.log(median)
    if value <= 0:
        return 1.0
    standardized = (math.log(value) - mu) / sigma
    # 1 - Phi(standardized), where Phi is the standard normal CDF.
    score = 1.0 - 0.5 * (1.0 + math.erf(standardized / math.sqrt(2.0)))
    return max(0.0, min(1.0, score))


def compute_perf_score(metrics: dict) -> float:
    """Compute Lighthouse v10 mobile composite Performance score.

    Args:
        metrics: dict with keys lcp_ms, fcp_ms, tbt_ms, cls, si_ms.

    Returns:
        Weighted composite score in [0, 1], rounded to 2 decimals.
    """
    total = 0.0
    for key, params in _CURVES.items():
        value = float(metrics[key])
        s = audit_score(value, params["p10"], params["median"])
        total += params["weight"] * s
    return round(total, 2)


if __name__ == "__main__":
    # Sanity checks against documented Lighthouse anchor points.
    good = compute_perf_score(
        {"lcp_ms": 2500, "fcp_ms": 1800, "tbt_ms": 200, "cls": 0.1, "si_ms": 3387}
    )
    mid = compute_perf_score(
        {"lcp_ms": 4000, "fcp_ms": 3000, "tbt_ms": 600, "cls": 0.25, "si_ms": 5800}
    )
    poor = compute_perf_score(
        {"lcp_ms": 8000, "fcp_ms": 6000, "tbt_ms": 1200, "cls": 0.5, "si_ms": 12000}
    )

    print(f"all p10 (good)        -> {good:.2f}  (expect ~0.90)")
    print(f"all median (mid)      -> {mid:.2f}  (expect ~0.50)")
    print(f"all 2x median (poor)  -> {poor:.2f}  (expect <0.20)")

    assert 0.88 <= good <= 0.92, f"good anchor off: {good}"
    assert 0.48 <= mid <= 0.52, f"median anchor off: {mid}"
    assert poor < 0.20, f"poor anchor too high: {poor}"
    print("OK: all anchor asserts passed.")
