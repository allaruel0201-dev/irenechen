#!/usr/bin/env python3
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
import importlib.util
import json
import ssl
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
DAILY_DIR = WORKSPACE_ROOT / "outputs" / "daily"
OUTPUTS_DASHBOARD_DIR = WORKSPACE_ROOT / "outputs" / "dashboard"
ROOT_DASHBOARD_DIR = WORKSPACE_ROOT / "dashboard"
NO_QUOTES = ("“", "”", "\"")


DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-topic-radar\.md$")
GITHUB_SSH_REMOTE_RE = re.compile(r"^git@github\.com:(?P<owner>[^/]+)/(?P<repo>.+?)(?:\.git)?$")
GITHUB_HTTPS_REMOTE_RE = re.compile(r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>.+?)(?:\.git)?$")


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


def git_remote_origin_url() -> str:
  code, out = try_run(["git", "config", "--get", "remote.origin.url"])
  if code != 0:
    return ""
  return out.strip()


def github_pages_data_url_from_remote(remote_url: str) -> str:
  if not remote_url:
    return ""

  match = GITHUB_SSH_REMOTE_RE.match(remote_url) or GITHUB_HTTPS_REMOTE_RE.match(remote_url)
  if not match:
    return ""

  owner = match.group("owner")
  repo = match.group("repo")
  if repo.endswith(".git"):
    repo = repo[:-4]

  if repo.lower() == f"{owner.lower()}.github.io":
    return f"https://{repo}/dashboard/data.js"
  return f"https://{owner}.github.io/{repo}/dashboard/data.js"


def public_dashboard_data_url() -> str:
  configured = (
    os.environ.get("PUBLIC_DASHBOARD_DATA_URL")
    or os.environ.get("DASHBOARD_DATA_URL")
    or ""
  ).strip()
  if configured:
    return configured
  return github_pages_data_url_from_remote(git_remote_origin_url())


def fetch_url_text(url: str) -> str:
  req = urllib.request.Request(
    url,
    headers={
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "User-Agent": "topic-radar-publisher/1.0",
    },
  )

  try:
    response = urllib.request.urlopen(req, timeout=20)
  except urllib.error.URLError as exc:
    # Some local Python installs miss the macOS CA bundle. This check only reads
    # the public static dashboard file; retry without local CA validation so the
    # publisher does not report a false failed deploy.
    if isinstance(exc.reason, ssl.SSLCertVerificationError):
      response = urllib.request.urlopen(req, timeout=20, context=ssl._create_unverified_context())
    else:
      raise

  with response:
    charset = response.headers.get_content_charset() or "utf-8"
    return response.read().decode(charset, errors="replace")


def with_cache_buster(url: str) -> str:
  sep = "&" if "?" in url else "?"
  return f"{url}{sep}publish_verify={int(time.time())}"


def verify_public_dashboard(date: str | None) -> None:
  if not date:
    return

  url = public_dashboard_data_url()
  if not url:
    print("Warning: unable to derive public dashboard URL; skipping public verification.")
    return

  timeout = int(os.environ.get("PUBLIC_DASHBOARD_VERIFY_TIMEOUT_SECONDS", "360"))
  interval = int(os.environ.get("PUBLIC_DASHBOARD_VERIFY_INTERVAL_SECONDS", "15"))
  deadline = time.monotonic() + timeout
  expected = f'"date": "{date}"'
  last_error = ""

  while time.monotonic() < deadline:
    try:
      text = fetch_url_text(with_cache_buster(url))
      if expected in text or date in text:
        print(f"Verified public dashboard contains {date}: {url}")
        return
      last_error = f"latest date not visible yet at {url}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
      last_error = str(exc)
    time.sleep(interval)

  raise RuntimeError(
    "Published commit was pushed, but the public dashboard did not expose the "
    f"latest date ({date}) within {timeout}s.\n"
    f"Checked: {url}\n"
    f"Last error: {last_error}\n"
    "If the production site is not GitHub Pages, set PUBLIC_DASHBOARD_DATA_URL "
    "to the deployed /dashboard/data.js URL."
  )


def write_publish_marker(date: str | None) -> None:
  if not date:
    return

  payload = {
    "latest_daily_date": date,
    "published_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
  }
  text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
  for directory in (OUTPUTS_DASHBOARD_DIR, ROOT_DASHBOARD_DIR):
    if not directory.exists():
      continue
    (directory / "publish-meta.json").write_text(text, encoding="utf-8")


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
  alternatives = module.parse_alternatives(markdown)

  missing: list[str] = []
  for topic in topics:
    if not any(str(url or "").strip() for url in topic.get("source_urls", [])):
      missing.append(str(topic.get("title", "")).strip())

  missing_alts: list[str] = []
  for alternative in alternatives:
    if not str(alternative.get("source_url", "") or "").strip():
      missing_alts.append(str(alternative.get("title", "")).strip())

  if missing or missing_alts:
    details: list[str] = []
    if missing:
      details.append("Top topics missing URLs:")
      details.extend(f"- {title}" for title in missing)
    if missing_alts:
      details.append("Alternative pool missing URLs:")
      details.extend(f"- {title}" for title in missing_alts)
    raise RuntimeError(
      "Latest daily report is missing source URLs. "
      "Add a raw article URL on the same line as each source or on the next line before publishing.\n"
      f"File: {latest_daily}\n"
      + "\n".join(details)
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
  write_publish_marker(date)

  # 2) Stage outputs (including updated data.js)
  # Netlify rebuilds from repo contents; also stage automation rule files that affect future runs.
  run(
    [
      "git",
      "add",
      "outputs",
      "dashboard",
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
    verify_public_dashboard(date)
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

  verify_public_dashboard(date)

  print("Published: committed and pushed successfully.")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
