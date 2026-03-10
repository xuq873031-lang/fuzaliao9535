#!/usr/bin/env python3
"""Run staged load scenarios (10/30/50 users) and save per-scenario result files."""

from __future__ import annotations

import subprocess
import sys
from datetime import datetime
from pathlib import Path


def run(cmd: list[str]) -> int:
    print("\n>>>", " ".join(cmd))
    proc = subprocess.run(cmd)
    return proc.returncode


def main() -> int:
    out_dir = Path("tests/load/results")
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    tasks: list[list[str]] = []
    for users in (10, 30, 50):
        tasks.append(
            [
                sys.executable,
                "tests/load/load_test.py",
                "--mode",
                "http",
                "--users",
                str(users),
                "--http-loops",
                "10",
                "--output",
                str(out_dir / f"{ts}_http_u{users}.json"),
            ]
        )
    for users in (10, 30, 50):
        tasks.append(
            [
                sys.executable,
                "tests/load/load_test.py",
                "--mode",
                "ws",
                "--users",
                str(users),
                "--duration-sec",
                "120",
                "--output",
                str(out_dir / f"{ts}_ws_u{users}.json"),
            ]
        )
    for users in (10, 30, 50):
        tasks.append(
            [
                sys.executable,
                "tests/load/load_test.py",
                "--mode",
                "chat",
                "--users",
                str(users),
                "--duration-sec",
                "120",
                "--send-interval-sec",
                "2.0" if users <= 30 else "2.5",
                "--output",
                str(out_dir / f"{ts}_chat_u{users}.json"),
            ]
        )

    for cmd in tasks:
        code = run(cmd)
        if code != 0:
            print(f"\nStopped due to failure: exit={code}")
            return code

    print("\nAll staged tests completed.")
    print(f"Results dir: {out_dir.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

