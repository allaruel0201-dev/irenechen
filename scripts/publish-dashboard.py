#!/usr/bin/env python3
from __future__ import annotations

import os
import re
import subprocess
import sys
import importlib.util
from pathlib import Path


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DAILY_DIR = WORKSPACE_ROOT / "outputs" / "daily"
NO_QUOTES = ("“", "”", "\"")


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


def strip_quotes_in_file(path: Path) -> bool:
  if not path.exists() or not path.is_file():
    return False
  text = path.read_text(encoding="utf-8")
  updated = text
  for q in NO_QUOTES:
    updated = updated.replace(q, "")
  if updated == text:
    return False
  path.write_text(updated, encoding="utf-8")
  return True


def git_pull_rebase_autostash() -> tuple[int, str]:
  # Avoid non-fast-forward push failures when GitHub Actions (or others) push to main.
  return try_run(["git", "pull", "--rebase", "--autostash"])


def validate_latest_daily_links(date: str | None) -> None:
  if not date:
    return

  latest_daily = DAILY_DIR / f"{date}-topic-radar.md"
  if not latest_daily.exists():
    return

  spec = importlib.util.spec_from_file_location("build_dashboard", WORKSPACE_ROOT / "scripts" / "build-dashboard.py")
  if spec is None or spec.loader is None:
    raise RuntimeError("Unable to load scripts/build-dashboard.py for validation.")

  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  markdown = latest_daily.read_text(encoding="utf-8")
  topics = module.parse_top_topics(markdown)

  missing: list[str] = []
  for topic in topics:
    if not any(str(url or "").strip() for url in topic.get("source_urls", [])):
      missing.append(str(topic.get("title", "")).strip())

  if missing:
    bullet_list = "\n".join(f"- {title}" for title in missing)
    raise RuntimeError(
      "Latest daily report is missing source URLs for top topics. "
      "Add a raw article URL on the same line as each source or on the next line before publishing.\n"
      f"File: {latest_daily}\n"
      f"{bullet_list}"
    )


def main() -> int:
  # 0) Keep local branch up-to-date (robust for fully automated runs).
  code, out = git_pull_rebase_autostash()
  if code != 0:
    # Don't hard-fail here; later steps may still succeed (e.g., first run).
    sys.stderr.write("Warning: git pull --rebase failed; continuing.\n")
    sys.stderr.write(out + "\n")

  # 0.1) Enforce "no quotes" style on the latest daily file (post-process safety net).
  date = latest_daily_date()
  if date:
    latest_daily = DAILY_DIR / f"{date}-topic-radar.md"
    if strip_quotes_in_file(latest_daily):
      # Stage later with other outputs.
      pass

  # 1) Build dashboard data.js
  run([sys.executable, "scripts/build-dashboard.py"])
  validate_latest_daily_links(date)

  # 2) Stage outputs (including updated data.js)
  # Netlify rebuilds from repo contents; also stage automation rule files that affect future runs.
  run(
    [
      "git",
      "add",
      "outputs",
      "scripts/build-dashboard.py",
      "scripts/build-dashboard.mjs",
      "scripts/publish-dashboard.py",
      "AGENTS.md",
      "sources.md",
      "templates/daily-topic-report.md",
    ]
  )

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
  if code != 0 and ("fetch first" in out.lower() or "non-fast-forward" in out.lower()):
    # Remote moved (often GitHub Actions). Rebase and retry once.
    pull_code, pull_out = git_pull_rebase_autostash()
    if pull_code == 0:
      code, out = try_run(["git", "push"])
    else:
      out = out + "\n\n" + pull_out
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
