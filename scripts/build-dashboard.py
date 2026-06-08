#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKSPACE_ROOT = Path(os.getcwd())
DAILY_DIR = WORKSPACE_ROOT / "outputs" / "daily"
DASHBOARD_DIR = WORKSPACE_ROOT / "outputs" / "dashboard"


DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-topic-radar\.md$")


def parse_date_from_filename(filename: str) -> str | None:
  m = DATE_RE.match(filename)
  return m.group(1) if m else None


def take_section(markdown: str, start_heading_re: re.Pattern[str], end_heading_re: re.Pattern[str]) -> str | None:
  start = start_heading_re.search(markdown)
  if not start:
    return None
  rest = markdown[start.end() :]
  end = end_heading_re.search(rest)
  return (rest[: end.start()] if end else rest).strip()


def _clean_line(line: str) -> str:
  text = re.sub(r"^\s*[-*]\s+", "", line).strip()
  # Dashboard展示用：去掉常见 Markdown 行内标记（避免出现 **加粗**）。
  text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
  text = re.sub(r"__(.+?)__", r"\1", text)
  return text


def _normalize_dashboard_text(text: str) -> str:
  out = text.strip()
  if not out:
    return out

  out = re.sub(
    r"对 AI [Pp]olicy、[Gg]overnance、[Cc]ompliance、trust and safety 是长期岗位信号，但离学生短期找工仍偏远。?",
    "和我们当前重点方向相关度偏弱，可先不优先写。",
    out,
  )
  out = re.sub(
    r"AI safety 和 policy 讨论继续升温.*",
    "和我们当前重点方向相关度偏弱，可先不优先写。",
    out,
  )
  out = re.sub(
    r"可转化为AI [Gg]overnance / [Cc]ompliance / [Pp]olicy职业路径.*",
    "和我们当前重点方向相关度偏弱，可先不优先写。",
    out,
  )
  out = re.sub(
    r"1\.\s*AI Security/AI Governance.*",
    "企业会更早投入评测、稳定性和风险控制相关工作。 对留学生更现实的启发，是优先准备更工程化、能落地的方向。",
    out,
  )

  replacements = [
    ("Governance", "流程"),
    ("Compliance", "流程"),
    ("Policy", "策略"),
    ("Payments Risk / Trust & Safety", "Growth PM / Full-stack"),
    ("Payments Risk", "支付产品"),
    ("Trust & Safety", "产品质量"),
    ("trust and safety", "产品质量"),
    ("AI governance / compliance / policy", "相关度偏弱"),
    ("AI policy、governance、compliance、trust and safety", "相关度偏弱"),
    ("AI safety 和 policy", "AI 风险讨论"),
    ("governance", "流程"),
    ("compliance tech", "流程系统"),
    ("compliance", "流程"),
    ("regulatory affairs", "运营协调"),
    ("public policy", "运营策略"),
    ("public affairs", "运营协调"),
    ("privacy/gov", "数据质量"),
    ("治理与合规", "基础设施效率与企业交付"),
    ("安全合规", "系统稳定性"),
    ("采购与合规", "采购与交付"),
    ("可观测、可合规", "可观测、可交付"),
    ("流程做合规", "流程做扎实"),
    ("合规优先", "流程更成熟"),
    ("合规边界", "业务边界"),
    ("更挑背景与合规要求", "更挑背景要求"),
    ("治理结构", "控制权结构"),
    ("合规岗位", "交付岗位"),
    ("合规相关岗位", "交付相关岗位"),
    ("政策岗位", "策略岗位"),
    ("政策与安全讨论升温", "相关度偏弱"),
    ("go-to-market、基础设施效率、治理与合规", "go-to-market、基础设施效率、企业交付"),
    ("平台工程、推理优化、企业交付、安全合规、产品分析、解决方案工程、技术 PM", "平台工程、推理优化、企业交付、产品分析、解决方案工程、技术 PM"),
    ("平台工程、推理成本优化、数据治理、可观测性、FinOps、采购与合规", "平台工程、推理成本优化、数据管理、可观测性、FinOps、采购与交付"),
    ("LLMOps（评测/监控/Prompt 管理/版本与回滚）、推理优化（缓存、蒸馏、量化、路由）、FinOps（用量计费与预算）会更热。", "LLMOps、推理优化、FinOps 这类更工程化的方向会更热。"),
    ("岗位更偏工程化与治理，机会结构改变而不是消失。", "岗位更偏工程化和交付，机会结构在变化。"),
    ("合规困惑", "流程困惑"),
    ("治理条款", "控制权条款"),
    ("AI Safety/治理岗位为何会变热", "AI 风险讨论为何升温"),
    ("政策拉扯", "政策变化"),
    ("AI Safety/治理岗位", "AI 风险讨论"),
    ("数据治理", "数据管理"),
    ("AI 安全、合规、评测、红队、隐私、供应链安全", "AI 安全、评测、红队、隐私、供应链安全"),
    ("电力、制冷、网络、运维、可靠性、合规 与融资能力", "电力、制冷、网络、运维、可靠性与融资能力"),
    ("采购与合规", "采购与交付"),
    ("AI 进入推理规模化阶段后，瓶颈往往不是模型，而是 电力、制冷、网络、运维、可靠性、合规 与融资能力。", "AI 进入推理规模化阶段后，瓶颈往往在电力、制冷、网络、运维、可靠性与融资能力。"),
    ("对商科与交叉背景同学也友好：基础设施投资会带来 project finance、infra PE、并购与估值、采购与合规、能源与碳排核算等需求。", "对商科与交叉背景同学也友好：基础设施投资会带来 project finance、infra PE、并购与估值、采购与交付、能源与碳排核算等需求。"),
    ("未来 6-18 个月，AI 行业的“增量岗位”不只在模型训练：还会在 AI 安全、合规、评测、红队、隐私、供应链安全 等方向出现结构性需求。", "未来 6-18 个月，AI 行业的增量岗位还会继续出现在 AI 安全、评测、红队、隐私和供应链安全等方向。"),
  ]
  for src, dst in replacements:
    out = out.replace(src, dst)

  out = re.sub(r"AI Security/AI 流程 变成“可被预算化”的工作.*?(?= \d+\.|$)", "企业会更早投入评测、稳定性和风险控制相关工作。", out)
  out = re.sub(r"网络安全与 AI 绑定更紧：.*?(?= \d+\.|$)", "安全和系统稳定性会继续跟 AI 落地绑定。", out)
  out = re.sub(r"对留学生最现实的启发：.*", "对留学生更现实的启发，是优先准备更工程化、能落地的方向。", out)
  out = re.sub(r"\s{2,}", " ", out).strip()
  return out


def _extract_sublist_after_label(block_lines: list[str], label_index: int, max_items: int = 10) -> list[str]:
  items: list[str] = []
  for i in range(label_index + 1, len(block_lines)):
    line = block_lines[i]
    if re.match(r"^\s*-\s+\*\*", line):
      break
    m = re.match(r"^\s*-\s+(.+?)\s*$", line)
    if not m:
      continue
    text = _clean_line(line)
    if text:
      items.append(text)
    if len(items) >= max_items:
      break
  return items


def _extract_sources_after_label(
  block_lines: list[str], label_index: int, max_items: int = 10
) -> tuple[list[str], list[str]]:
  items: list[str] = []
  urls: list[str] = []
  current_idx: int | None = None
  for i in range(label_index + 1, len(block_lines)):
    line = block_lines[i]
    if re.match(r"^\s*-\s+\*\*", line):
      break
    bullet = re.match(r"^\s*-\s+(.+?)\s*$", line)
    if bullet:
      text = _clean_line(line)
      if text:
        items.append(text)
        current_idx = len(items) - 1
      if len(items) >= max_items:
        break
      continue

    url_match = re.search(r"https?://\S+", line)
    if url_match and current_idx is not None:
      while len(urls) <= current_idx:
        urls.append("")
      if not urls[current_idx]:
        urls[current_idx] = url_match.group(0).rstrip(")")

  while len(urls) < len(items):
    urls.append("")
  return items, urls


def _extract_text_after_label(block_lines: list[str], label_index: int, max_chars: int = 520) -> str:
  out: list[str] = []
  for i in range(label_index + 1, len(block_lines)):
    line = block_lines[i]
    if re.match(r"^\s*-\s+\*\*", line):
      break
    if re.match(r"^\s*###\s+", line):
      break
    t = line.strip()
    if not t:
      continue
    out.append(_clean_line(line))
  joined = " ".join(out).strip()
  if len(joined) > max_chars:
    return joined[: max_chars - 1] + "…"
  return joined


def parse_top_topics(markdown: str) -> list[dict[str, Any]]:
  section = take_section(
    markdown,
    re.compile(r"^##\s*1[\)）]\s*今日最值得写的\s*3\s*个选题\s*$", re.M),
    re.compile(r"^##\s*2[\)）]\s*", re.M),
  )
  if not section:
    return []

  headings = list(re.finditer(r"^###\s+(.+?)\s*$", section, re.M))
  topics: list[dict[str, Any]] = []
  for idx, h in enumerate(headings):
    title = h.group(1).strip()
    block_start = h.end()
    block_end = headings[idx + 1].start() if idx + 1 < len(headings) else len(section)
    block = section[block_start:block_end]
    block_lines = block.splitlines()

    score_total: int | None = None
    for line in block_lines:
      # Support both:
      # - "... **总分 26**"
      # - "... 总分 26"
      m = re.search(r"(?:\*\*)?总分\D*(\d{1,2})\b", line)
      if m:
        score_total = int(m.group(1))

    sources: list[str] = []
    source_urls: list[str] = []
    summary = ""
    why = ""
    signal = ""
    for i, line in enumerate(block_lines):
      if re.match(r"^\s*-\s+(?:\*\*)?来源(?:\*\*)?\s*$", line):
        sources, source_urls = _extract_sources_after_label(block_lines, i, 10)
      if re.match(r"^\s*-\s+(?:\*\*)?事件摘要(?:\*\*)?\s*$", line):
        summary = _extract_text_after_label(block_lines, i, 520)
      if re.match(r"^\s*-\s+(?:\*\*)?为什么对美国留学生重要(?:\*\*)?\s*$", line):
        why = _extract_text_after_label(block_lines, i, 680)
      if re.match(r"^\s*-\s+(?:\*\*)?职业机会信号(?:\*\*)?\s*$", line):
        signal = _extract_text_after_label(block_lines, i, 680)

    topics.append(
      {
        "title": _normalize_dashboard_text(title),
        "score_total": score_total,
        "sources": sources,
        "source_urls": source_urls,
        "summary": _normalize_dashboard_text(summary),
        "why_it_matters": _normalize_dashboard_text(why),
        "job_signal": _normalize_dashboard_text(signal),
      }
    )

  return topics[:3]


ALT_SINGLE_LINE_TITLE_RE = re.compile(r"^\s*\d+\.\s+\*\*(.+?)\*\*(.*)$")
ALT_PLAIN_LINE_RE = re.compile(r"^\s*\d+\.\s+(.+)$")
ALT_BLOCK_START_RE = re.compile(r"^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$")
ALT_SCORE_RE = re.compile(r"评分[：:]\s*(\d{1,2})\s*$")
ALT_INLINE_SCORE_RE = re.compile(r"（总分：(\d{1,2})(?:[^）]*)）")
ALT_ANY_NUMBERED_RE = re.compile(r"^\s*\d+\.\s+")
ALT_TOTAL_SCORE_RE = re.compile(r"总分[：:]\s*(\d{1,2})\s*/\s*30")


def parse_alternatives(markdown: str) -> list[dict[str, Any]]:
  section = take_section(
    markdown,
    re.compile(r"^##\s*2[\)）]\s*备选选题池.*$", re.M),
    re.compile(r"^##\s*3[\)）]\s*", re.M),
  )
  if not section:
    return []

  alternatives: list[dict[str, Any]] = []
  lines = section.splitlines()
  i = 0
  while i < len(lines):
    line = lines[i]

    inline_title = ALT_SINGLE_LINE_TITLE_RE.match(line)
    if not inline_title:
      plain_line = ALT_PLAIN_LINE_RE.match(line)
      if plain_line:
        tail = plain_line.group(1).strip()
        score_match = ALT_INLINE_SCORE_RE.search(tail)
        if score_match:
          body = ALT_INLINE_SCORE_RE.sub("", tail).strip()
          title, _, summary = body.partition("：")
          if not summary:
            title, _, summary = body.partition(":")
          source_url = ""
          alternatives.append(
            {
              "title": _normalize_dashboard_text(title.strip()),
              "summary": _normalize_dashboard_text(summary.strip()),
              "score_total": int(score_match.group(1)),
              "source_url": source_url,
            }
          )
          i += 1
          continue

        title, sep, summary = tail.partition("：")
        if not sep:
          title, sep, summary = tail.partition(":")

        block: list[str] = []
        i += 1
        while i < len(lines):
          next_line = lines[i]
          if ALT_ANY_NUMBERED_RE.match(next_line) or re.match(r"^##\s+", next_line):
            break
          block.append(next_line.rstrip())
          i += 1

        score_total: int | None = None
        source_url = ""
        if not summary:
          for block_line in block:
            stripped = block_line.strip()
            if not stripped or stripped.startswith("来源："):
              continue
            score_match = ALT_TOTAL_SCORE_RE.search(stripped)
            if score_match:
              score_total = int(score_match.group(1))
              continue
            summary = stripped
            break
        for block_line in block:
          url_match = re.search(r"https?://\S+", block_line.strip())
          if url_match and not source_url:
            source_url = url_match.group(0).rstrip(")")
          score_match = ALT_TOTAL_SCORE_RE.search(block_line.strip())
          if score_match:
            score_total = int(score_match.group(1))
            break

        alternatives.append(
          {
            "title": _normalize_dashboard_text(title.strip()),
            "summary": _normalize_dashboard_text(summary.strip()),
            "score_total": score_total,
            "source_url": source_url,
          }
        )
        continue

      block_start = ALT_BLOCK_START_RE.match(line)
      if not block_start:
        i += 1
        continue

      title = block_start.group(2).strip()
      block: list[str] = []
      i += 1
      while i < len(lines):
        next_line = lines[i]
        if ALT_BLOCK_START_RE.match(next_line) or re.match(r"^##\s+", next_line):
          break
        block.append(next_line.rstrip())
        i += 1

      summary = ""
      score_total: int | None = None
      source_url = ""
      for block_line in block:
        stripped = block_line.strip()
        if not stripped:
          continue
        if stripped.startswith("来源：") or stripped.startswith("角度："):
          if not summary:
            summary = stripped
        url_match = re.search(r"https?://\S+", stripped)
        if url_match and not source_url:
          source_url = url_match.group(0).rstrip(")")
        score_match = ALT_SCORE_RE.search(stripped)
        if score_match:
          score_total = int(score_match.group(1))

      alternatives.append(
        {
          "title": _normalize_dashboard_text(title),
          "summary": _normalize_dashboard_text(summary),
          "score_total": score_total,
          "source_url": source_url,
        }
      )
      continue

    tail = inline_title.group(2).strip()
    score_match = ALT_INLINE_SCORE_RE.search(tail)
    if not score_match:
      i += 1
      continue
    title = inline_title.group(1).strip()
    summary = ALT_INLINE_SCORE_RE.sub("", tail).strip()
    summary = summary.lstrip("：:").strip()
    alternatives.append(
      {
        "title": _normalize_dashboard_text(title),
        "summary": _normalize_dashboard_text(summary),
        "score_total": int(score_match.group(1)),
        "source_url": "",
      }
    )
    i += 1
  return alternatives


def build() -> None:
  DASHBOARD_DIR.mkdir(parents=True, exist_ok=True)

  if not DAILY_DIR.exists():
    raise SystemExit(f"Missing daily dir: {DAILY_DIR}")

  days: list[dict[str, Any]] = []
  for p in DAILY_DIR.iterdir():
    if not p.is_file():
      continue
    date = parse_date_from_filename(p.name)
    if not date:
      continue
    markdown = p.read_text(encoding="utf-8")
    days.append(
      {
        "date": date,
        "file": f"outputs/daily/{p.name}",
        "top_topics": parse_top_topics(markdown),
        "alternatives": parse_alternatives(markdown),
      }
    )

  days.sort(key=lambda d: d["date"], reverse=True)
  data = {
    "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "days": days,
  }

  js = "// Auto-generated by scripts/build-dashboard.py\nwindow.TOPIC_RADAR_DATA = "
  js += json.dumps(data, ensure_ascii=False, indent=2)
  js += ";\n"
  (DASHBOARD_DIR / "data.js").write_text(js, encoding="utf-8")


if __name__ == "__main__":
  build()
