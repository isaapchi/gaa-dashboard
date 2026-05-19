"""Atomic read/write of autoresearch/state.json.

Single source of truth for live loop state, polled by the dashboard.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

STATE_FILE = Path(__file__).parent / "state.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_state(baseline: dict | None = None) -> dict:
    s = {
        "status": "idle",
        "phase": "init",
        "started_at": _now(),
        "updated_at": _now(),
        "current_iter": 0,
        "current_hypothesis": None,
        "baseline": baseline,
        "iterations": [],
        "summary": {
            "totals_vs_baseline": {"lcp_ms": 0, "fcp_ms": 0, "tbt_ms": 0, "perf": 0.0},
            "credits_burned": 0,
            "deploy_count": 0,
        },
    }
    write(s)
    return s


def read() -> dict:
    if not STATE_FILE.exists():
        return init_state()
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def write(state: dict) -> None:
    state["updated_at"] = _now()
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".state.", suffix=".json", dir=STATE_FILE.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, STATE_FILE)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def update(**kwargs) -> dict:
    s = read()
    for k, v in kwargs.items():
        s[k] = v
    write(s)
    return s


def add_iter(iter_record: dict) -> dict:
    s = read()
    s["iterations"].append(iter_record)
    write(s)
    return s


def set_phase(phase: str) -> None:
    update(phase=phase)


def set_status(status: str) -> None:
    update(status=status)


def set_current_iter_record(record: dict | None) -> None:
    """Live snapshot of in-flight iteration (dashboard reads this to render the current card)."""
    update(current_iter_record=record)
