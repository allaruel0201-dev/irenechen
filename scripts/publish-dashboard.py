#!/usr/bin/env python3
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DAILY_DIR = WORKSPACE_ROOT / "outputs" / "daily"


DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-topic-radar\.md$")


def run(cmd: list[str], *, cwd: Path | None = None) -> str:
  p = subprocess.run(
    cmd,
    cwd=str(cwd or WORKSPACE_ROOT),
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
  )
  if p.returncode != 0:
    raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(cmd)}\n{p.stdout}")
  return p.stdout


def try_run(cmd: list[str], *, cwd: Path | None = None) -> tuple[int, str]:
  p = subprocess.run(
    cmd,
    cwd=str(cwd or WORKSPACE_ROOT),
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
  )
  return p.returncode, p.stdout


def latest_daily_date() -> str | None:
  if not DAILY_DIR.exists():
    return None
  dates: list[str] = []
  for p in DAILY_DIR.iterdir():
    if not p.is_file():
      continue
    m = DATE_RE.match(p.name)
    if not m:
      continue
    dates.append(m.group(1))
  return max(dates) if dates else None


def main() -> int:
  # 1) Build dashboard data.js
  run([sys.executable, "scripts/build-dashboard.py"])

  # 2) Stage outputs (including updated data.js)
  # Netlify rebuilds from repo contents; commit both generated outputs and the build scripts.
  run(["git", "add", "outputs", "scripts/build-dashboard.py", "scripts/build-dashboard.mjs", "scripts/publish-dashboard.py"])

  # 3) If nothing changed, exit quietly
  status = run(["git", "status", "--porcelain"])
  if status.strip() == "":
    print("No changes to publish (git status clean).")
    return 0

  # 4) Commit with a deterministic message
  date = latest_daily_date()
  msg = f"dashboard: {date}" if date else "dashboard: update"

  # Allow automation environments to set bot identity via env, without forcing it here.
  author_name = os.environ.get("GIT_AUTHOR_NAME") or os.environ.get("GIT_COMMITTER_NAME")
  author_email = os.environ.get("GIT_AUTHOR_EMAIL") or os.environ.get("GIT_COMMITTER_EMAIL")
  if author_name:
    run(["git", "config", "user.name", author_name])
  if author_email:
    run(["git", "config", "user.email", author_email])

  run(["git", "commit", "-m", msg])

  # 5) Push
  code, out = try_run(["git", "push"])
  if code != 0:
    sys.stderr.write(
      "Commit created but push failed.\n"
      "Common fixes:\n"
      "- Ensure SSH is configured and reachable (github.com via port 443).\n"
      "- Ensure you have write access to the repo.\n\n"
    )
    sys.stderr.write(out)
    return code

  print("Published: committed and pushed successfully.")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
