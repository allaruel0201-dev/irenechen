import fs from "node:fs/promises";
import path from "node:path";

const WORKSPACE_ROOT = process.cwd();
const DAILY_DIR = path.join(WORKSPACE_ROOT, "outputs", "daily");
const DASHBOARD_DIR = path.join(WORKSPACE_ROOT, "outputs", "dashboard");

function safeJsonStringify(value) {
  return JSON.stringify(value, null, 2);
}

function parseDateFromFilename(filename) {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})-topic-radar\.md$/);
  return match ? match[1] : null;
}

function takeSection(markdown, startHeadingRegex, endHeadingRegex) {
  const startMatch = markdown.match(startHeadingRegex);
  if (!startMatch) return null;
  const startIndex = startMatch.index ?? 0;
  const afterStartIndex = startIndex + startMatch[0].length;
  const rest = markdown.slice(afterStartIndex);

  const endMatch = rest.match(endHeadingRegex);
  const endIndex = endMatch ? afterStartIndex + (endMatch.index ?? 0) : markdown.length;
  return markdown.slice(afterStartIndex, endIndex).trim();
}

function cleanLineText(line) {
  let text = line.replace(/^\s*[-*]\s+/, "").trim();
  // Dashboard展示用：去掉常见 Markdown 行内标记（避免出现 **加粗**）。
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/__(.+?)__/g, "$1");
  return text;
}

function extractSubListAfterLabel(blockLines, labelLineIndex, maxItems = 8) {
  const items = [];
  for (let i = labelLineIndex + 1; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (/^\s*-\s+\*\*/.test(line)) break; // next label
    if (/^\s*\*\*[^*]+\*\*\s*$/.test(line.trim())) break;
    if (/^\s*###\s+/.test(line)) break;
    const bullet = line.match(/^\s*-\s+(.+)\s*$/);
    if (!bullet) continue;
    const text = cleanLineText(bullet[0]);
    if (!text) continue;
    items.push(text);
    if (items.length >= maxItems) break;
  }
  return items;
}

function isLabelLine(line, ...labels) {
  const stripped = String(line || "").trim();
  return labels.some((label) => {
    const bulletRe = new RegExp(`^\\s*-\\s+(?:\\*\\*)?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\*\\*)?\\s*$`);
    return bulletRe.test(line) || stripped === `**${label}**`;
  });
}

function extractPlainLinesAfterLabel(blockLines, labelLineIndex, maxItems = 10) {
  const items = [];
  const urls = [];
  for (let i = labelLineIndex + 1; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (/^\s*-\s+/.test(line)) break;
    if (/^\s*\*\*[^*]+\*\*\s*$/.test(line.trim())) break;
    if (/^\s*###\s+/.test(line)) break;
    const urlMatch = line.match(/https?:\/\/\S+/);
    if (urlMatch && items.length) {
      if (!urls[urls.length - 1]) urls[urls.length - 1] = urlMatch[0].replace(/\)$/, "");
      continue;
    }
    const text = cleanLineText(line);
    if (!text) continue;
    items.push(text);
    urls.push(urlMatch ? urlMatch[0].replace(/\)$/, "") : "");
    if (items.length >= maxItems) break;
  }
  return { items, urls };
}

function hasBulletItemsAfterLabel(blockLines, labelLineIndex) {
  for (let i = labelLineIndex + 1; i < blockLines.length; i++) {
    const stripped = blockLines[i].trim();
    if (!stripped) continue;
    return /^\s*-\s+/.test(blockLines[i]);
  }
  return false;
}

function extractTextAfterLabel(blockLines, labelLineIndex, maxChars = 420) {
  const out = [];
  for (let i = labelLineIndex + 1; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (/^\s*-\s+\*\*/.test(line)) break; // next label
    if (/^\s*\*\*[^*]+\*\*\s*$/.test(line.trim())) break;
    if (/^\s*###\s+/.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(cleanLineText(line));
  }
  const joined = out.join(" ");
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}

function parseTopTopics(markdown) {
  const section = takeSection(
    markdown,
    /^##\s*1[\)）]\s*今日最值得写的\s*3\s*个选题\s*$/m,
    /^##\s*2[\)）]\s*/m,
  );
  if (!section) return [];

  const headingMatches = [...section.matchAll(/^###\s+(.+)\s*$/gm)].map((m) => ({
    title: m[1].trim(),
    index: m.index ?? 0,
    length: m[0].length,
  }));

  const topics = [];
  for (let idx = 0; idx < headingMatches.length; idx++) {
    const current = headingMatches[idx];
    const next = headingMatches[idx + 1];
    const blockStart = current.index + current.length;
    const blockEnd = next ? next.index : section.length;

    let title = current.title;
    const block = section.slice(blockStart, blockEnd);
    const blockLines = block.split("\n");

    if (/^\d{1,2}$/.test(title)) {
      for (const line of blockLines) {
        const stripped = line.trim();
        if (!stripped) continue;
        if (stripped.startsWith("**")) break;
        if (stripped.startsWith("- ")) break;
        title = stripped;
        break;
      }
    }

    let scoreTotal = null;
    for (const line of blockLines) {
      const score = line.match(/\*\*总分\D*(\d{1,2})\b/);
      if (score) scoreTotal = Number(score[1]);
    }

    let sources = [];
    let sourceUrls = [];
    let summary = "";
    let why = "";
    let signal = "";
    for (let i = 0; i < blockLines.length; i++) {
      const line = blockLines[i];
      if (isLabelLine(line, "来源")) {
        if (/^\s*-\s+/.test(line) || hasBulletItemsAfterLabel(blockLines, i)) {
          sources = extractSubListAfterLabel(blockLines, i, 10);
          sourceUrls = new Array(sources.length).fill("");
        } else {
          const extracted = extractPlainLinesAfterLabel(blockLines, i, 10);
          sources = extracted.items;
          sourceUrls = extracted.urls;
        }
      }
      if (isLabelLine(line, "事件摘要", "这件事")) summary = extractTextAfterLabel(blockLines, i, 520);
      if (isLabelLine(line, "为什么对美国留学生重要", "为什么值得写")) why = extractTextAfterLabel(blockLines, i, 680);
      if (isLabelLine(line, "职业机会信号", "可写角度", "什么方向展开")) signal = extractTextAfterLabel(blockLines, i, 680);
    }

    topics.push({
      title,
      score_total: scoreTotal,
      sources,
      source_urls: sourceUrls,
      summary,
      why_it_matters: why,
      job_signal: signal,
    });
  }

  return topics.slice(0, 3);
}

function parseAlternativeTopics(markdown) {
  const section = takeSection(
    markdown,
    /^##\s*2[\)）]\s*备选选题池.*$/m,
    /^##\s*3[\)）]\s*/m,
  );
  if (!section) return [];

  const tableLines = section.split("\n").filter((line) => line.trim().startsWith("|"));
  if (tableLines.length >= 3) {
    const alternatives = [];
    for (const line of tableLines.slice(2)) {
      const trimmed = line.trim();
      const match = trimmed.match(/^\|(.+)\|\s*$/);
      if (!match) continue;
      const cols = match[1].split("|").map((c) => c.trim());
      if (cols.length < 4) continue;
      const [title, summary, _source, score] = cols;
      if (!title || title === "---") continue;
      const scoreMatch = score.match(/(\d{1,2})\s*\/\s*30/);
      alternatives.push({
        title,
        summary,
        score_total: scoreMatch ? Number(scoreMatch[1]) : null,
        source_url: "",
      });
    }
    if (alternatives.length) return alternatives;
  }

  const alternatives = [];
  const lines = section.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const inlineTitle = line.match(/^\s*\d+\.\s+\*\*(.+?)\*\*(.*)$/);
    if (inlineTitle) {
      const tail = inlineTitle[2].trim();
      const scoreMatch = tail.match(/（总分：(\d{1,2})(?:[^）]*)）/);
      if (scoreMatch) {
        const summary = tail.replace(/（总分：(\d{1,2})(?:[^）]*)）/, "").replace(/^[：:]\s*/, "").trim();
        alternatives.push({
          title: inlineTitle[1].trim(),
          summary,
          score_total: Number(scoreMatch[1]),
        });
        i += 1;
        continue;
      }
    }

    const plainLine = line.match(/^\s*\d+\.\s+(.+)$/);
    if (plainLine) {
      const tail = plainLine[1].trim();
      const scoreMatch = tail.match(/（总分：(\d{1,2})(?:[^）]*)）/);
      if (scoreMatch) {
        const body = tail.replace(/（总分：(\d{1,2})(?:[^）]*)）/, "").trim();
        let title = body;
        let summary = "";
        if (body.includes("：")) {
          [title, summary] = body.split(/：(.*)/s, 2);
        } else if (body.includes(":")) {
          [title, summary] = body.split(/:(.*)/s, 2);
        }
        alternatives.push({
          title: title.trim(),
          summary: (summary || "").trim(),
          score_total: Number(scoreMatch[1]),
        });
        i += 1;
        continue;
      }
    }

    const blockStart = line.match(/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/);
    if (!blockStart) {
      i += 1;
      continue;
    }

    if (/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/.test(line) === false) {
      i += 1;
      continue;
    }

    if (/^\s*\d+\.\s+\*\*(.+?)\*\*(.*)$/.test(line) && !/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/.test(line)) {
      i += 1;
      continue;
    }

    const title = blockStart[1].trim();
    const block = [];
    i += 1;
    while (i < lines.length) {
      const nextLine = lines[i];
      if (/^\s*\d+\.\s+\*\*(.+?)\*\*(.*)$/.test(nextLine) || /^##\s+/.test(nextLine)) break;
      block.push(nextLine.trim());
      i += 1;
    }

    let summary = "";
    let scoreTotal = null;
    for (const blockLine of block) {
      if (!blockLine) continue;
      if (!summary && (blockLine.startsWith("来源：") || blockLine.startsWith("角度："))) {
        summary = blockLine;
      }
      const scoreMatch = blockLine.match(/评分[：:]\s*(\d{1,2})\s*$/);
      if (scoreMatch) scoreTotal = Number(scoreMatch[1]);
    }

    alternatives.push({
      title,
      summary,
      score_total: scoreTotal,
    });
  }
  return alternatives;
}

async function build() {
  await fs.mkdir(DASHBOARD_DIR, { recursive: true });

  const entries = await fs.readdir(DAILY_DIR, { withFileTypes: true });
  const dailyFiles = entries
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name.endsWith("-topic-radar.md"));

  const days = [];
  for (const filename of dailyFiles) {
    const date = parseDateFromFilename(filename);
    if (!date) continue;
    const fullPath = path.join(DAILY_DIR, filename);
    const markdown = await fs.readFile(fullPath, "utf8");

    days.push({
      date,
      file: `outputs/daily/${filename}`,
      top_topics: parseTopTopics(markdown),
      alternatives: parseAlternativeTopics(markdown),
    });
  }

  days.sort((a, b) => (a.date < b.date ? 1 : -1));

  const data = {
    generated_at: new Date().toISOString(),
    days,
  };

  const js = `// Auto-generated by scripts/build-dashboard.mjs\nwindow.TOPIC_RADAR_DATA = ${safeJsonStringify(data)};\n`;
  await fs.writeFile(path.join(DASHBOARD_DIR, "data.js"), js, "utf8");
}

await build();
