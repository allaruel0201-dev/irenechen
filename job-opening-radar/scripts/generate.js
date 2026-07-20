import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const inputDir = path.join(projectRoot, "input");
const assetsDir = path.join(projectRoot, "assets");
const distDir = path.join(projectRoot, "dist");
const outputFile = path.join(distDir, "index.html");
const tempDir = path.join(projectRoot, ".tmp");

const excelExts = new Set([".xlsx", ".xls", ".xlsm"]);
const excludedHeaders = new Set(["job direction", "qualification", "qualifications"]);

async function main() {
  const sourceArg = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : null;
  const sourceFile = sourceArg || await findDefaultSource();
  const workbookFiles = sourceFile ? await resolveWorkbookFiles(sourceFile) : [];
  const sheets = workbookFiles.flatMap((workbookFile) => {
    const workbook = XLSX.readFile(workbookFile.path, { cellDates: true });
    return workbook.SheetNames.map((sheetName) => {
      const displayName = workbookFiles.length > 1 ? `${workbookFile.name} / ${sheetName}` : sheetName;
      return parseSheet(workbook.Sheets[sheetName], displayName);
    });
  }).filter((sheet) => sheet.headers.length > 0);
  const mergedSheet = mergeSheets(sheets);

  await fsp.mkdir(distDir, { recursive: true });
  await copyAssets();
  const html = buildHtml({
    generatedAt: new Date().toISOString(),
    sourceName: sourceFile ? path.basename(sourceFile) : "",
    workbookName: workbookFiles.map((file) => file.name).join(", "),
    sheets: mergedSheet ? [mergedSheet] : []
  });
  await fsp.writeFile(outputFile, html, "utf8");
  console.log(`Generated ${outputFile}`);
}

async function copyAssets() {
  const assetNames = ["qr.png", "dbc-logo.png"];
  for (const assetName of assetNames) {
    const assetSource = path.join(assetsDir, assetName);
    if (fs.existsSync(assetSource)) {
      await fsp.copyFile(assetSource, path.join(distDir, assetName));
    }
  }
}

async function findDefaultSource() {
  await fsp.mkdir(inputDir, { recursive: true });
  const files = await fsp.readdir(inputDir);
  const candidates = files
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      return excelExts.has(ext) || ext === ".zip";
    })
    .map((name) => path.join(inputDir, name));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

async function resolveWorkbookFiles(sourceFile) {
  const ext = path.extname(sourceFile).toLowerCase();
  if (excelExts.has(ext)) return [{ path: sourceFile, name: path.basename(sourceFile) }];
  if (ext !== ".zip") throw new Error("Source must be an Excel workbook or a zip containing one.");

  await fsp.rm(tempDir, { recursive: true, force: true });
  await fsp.mkdir(tempDir, { recursive: true });

  const zip = new AdmZip(sourceFile);
  const entries = zip.getEntries()
    .filter((entry) => !entry.isDirectory)
    .filter((entry) => !entry.entryName.startsWith("__MACOSX/"))
    .filter((entry) => excelExts.has(path.extname(entry.entryName).toLowerCase()));

  if (entries.length === 0) {
    throw new Error("The zip file does not contain an Excel workbook.");
  }

  const datedTotalEntries = entries.filter((entry) => isDatedTotalWorkbook(path.basename(entry.entryName)));
  const selectedEntries = datedTotalEntries.length > 0
    ? datedTotalEntries
    : entries.filter((entry) => !isHistoricalSummaryWorkbook(path.basename(entry.entryName)));

  return Promise.all(selectedEntries.map(async (entry, index) => {
    const basename = path.basename(entry.entryName);
    const workbookPath = path.join(tempDir, `${String(index + 1).padStart(2, "0")}-${basename}`);
    await fsp.writeFile(workbookPath, entry.getData());
    return { path: workbookPath, name: basename };
  }));
}

function isDatedTotalWorkbook(filename) {
  return /^20\d{6}总表\.(xlsx|xls|xlsm)$/i.test(filename);
}

function isHistoricalSummaryWorkbook(filename) {
  return /^20\d{2}招聘信息汇总表\.(xlsx|xls|xlsm)$/i.test(filename);
}

function parseSheet(worksheet, sheetName) {
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
    blankrows: false,
    raw: false
  });

  const headerRowIndex = rows.findIndex((row) => row.filter((cell) => normalizeCell(cell) !== "").length >= 2);
  if (headerRowIndex === -1) {
    return { name: sheetName, headers: [], rows: [], hasLink: false, jobTitleKey: null };
  }

  const originalHeaders = rows[headerRowIndex].map((cell, index) => normalizeHeader(cell, index));
  const uniqueHeaders = makeUniqueHeaders(originalHeaders);
  const ignoredStart = Math.max(0, uniqueHeaders.length - 2);
  const linkIndex = uniqueHeaders.findIndex((header) => header.trim().toLowerCase() === "link");
  const jobTitleIndex = uniqueHeaders.findIndex((header) => header.trim().toLowerCase() === "job title");

  const visibleIndexes = uniqueHeaders
    .map((header, index) => ({ header, index }))
    .filter(({ header, index }) => {
      const normalized = header.trim().toLowerCase();
      return index < ignoredStart && normalized !== "link" && !excludedHeaders.has(normalized);
    })
    .map(({ header, index }) => ({ key: header, index }));

  const dataRows = rows.slice(headerRowIndex + 1).map((row) => {
    const item = {};
    visibleIndexes.forEach(({ key, index }) => {
      item[key] = normalizeValueForHeader(key, normalizeCell(row[index]));
    });

    const link = linkIndex >= 0 ? normalizeCell(row[linkIndex]) : "";
    const hasDisplayValue = Object.values(item).some((value) => value !== "");
    if (!hasDisplayValue && !link) return null;
    return { cells: item, link };
  }).filter(Boolean);

  return {
    name: sheetName,
    headers: visibleIndexes.map(({ key }) => key),
    rows: dataRows,
    hasLink: linkIndex >= 0,
    jobTitleKey: jobTitleIndex >= 0 && jobTitleIndex < ignoredStart ? uniqueHeaders[jobTitleIndex] : null
  };
}

function mergeSheets(sheets) {
  if (sheets.length === 0) return null;

  const headers = [];
  const seenHeaders = new Set();
  let hasLink = false;
  let jobTitleKey = null;

  sheets.forEach((sheet) => {
    sheet.headers.forEach((header) => {
      if (!seenHeaders.has(header)) {
        seenHeaders.add(header);
        headers.push(header);
      }
    });
    hasLink = hasLink || sheet.hasLink;
    if (!jobTitleKey && sheet.jobTitleKey) jobTitleKey = sheet.jobTitleKey;
  });

  const rows = sheets.flatMap((sheet) => {
    return sheet.rows.map((row) => {
      const cells = {};
      headers.forEach((header) => {
        cells[header] = row.cells[header] || "";
      });
      return { cells, link: row.link || "" };
    });
  });
  rows.sort((a, b) => locationRank(a.cells.Location) - locationRank(b.cells.Location));

  return {
    name: "全部岗位",
    headers,
    rows,
    hasLink,
    jobTitleKey
  };
}

function locationRank(location) {
  const normalized = String(location || "").trim().toLowerCase();
  if (["united states", "us", "usa", "u.s.", "u.s.a.", "美国"].includes(normalized)) return 0;
  return 1;
}

function normalizeHeader(value, index) {
  const header = normalizeCell(value);
  return canonicalHeader(header) || `未命名列 ${index + 1}`;
}

function canonicalHeader(header) {
  const normalized = header.trim();
  const key = normalized.toLowerCase();
  const aliases = new Map([
    ["日期", "Posting Date"],
    ["招聘季", "Recruitment Season"],
    ["公司", "Company"],
    ["领域", "Job Category"],
    ["岗位方向", "Job Direction"],
    ["国家", "Location"],
    ["program类型", "Type of Program"],
    ["program 类型", "Type of Program"],
    ["岗位名称", "Job Title"],
    ["毕业时间", "Year of Graduation"],
    ["学历限制", "Educational Background"],
    ["网申截止时间", "Application Deadline"],
    ["链接", "Link"],
    ["申请链接", "Link"],
    ["岗位链接", "Link"]
  ]);

  return aliases.get(normalized) || aliases.get(key) || normalized;
}

function normalizeCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\r\n/g, "\n").trim();
}

function normalizeValueForHeader(header, value) {
  if (header.trim().toLowerCase() === "posting date") return normalizePostingDate(value);
  return value;
}

function normalizePostingDate(value) {
  const clean = String(value || "").trim();
  if (!clean) return "";

  const ymd = clean.match(/^(20\d{2})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (ymd) return formatDateParts(ymd[1], ymd[2], ymd[3]);

  const mdy = clean.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$/);
  if (mdy) return formatDateParts(`20${mdy[3]}`, mdy[1], mdy[2]);

  return clean;
}

function formatDateParts(year, month, day) {
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
}

function makeUniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((header) => {
    const count = seen.get(header) || 0;
    seen.set(header, count + 1);
    return count === 0 ? header : `${header} ${count + 1}`;
  });
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildHtml(data) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>2027秋招岗位汇总表</title>
  <style>
    :root {
      --ink: #1f2937;
      --muted: #5f6b7a;
      --paper: #f7f9fc;
      --panel: #ffffff;
      --line: #d9e2ef;
      --line-strong: #b7c7dc;
      --brand: #3366cc;
      --brand-dark: #244f9f;
      --brand-soft: #eef5ff;
      --accent: #3399ff;
      --cream: #eef5ff;
      --shadow: 0 18px 50px rgba(31, 41, 55, 0.08);
      --radius: 8px;
      color-scheme: light;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(51, 102, 204, 0.07), rgba(51, 153, 255, 0) 360px),
        var(--paper);
      color: var(--ink);
      font-family: Inter, "Noto Sans SC", "Source Han Sans CN", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
      letter-spacing: 0;
    }

    button,
    input,
    select {
      font: inherit;
    }

    a {
      color: inherit;
    }

    .page {
      min-height: 100vh;
      transition: filter 160ms ease, opacity 160ms ease;
    }

    body.locked .page {
      filter: blur(5px);
      pointer-events: none;
      user-select: none;
    }

    .shell {
      width: min(1440px, calc(100% - 40px));
      margin: 0 auto;
      padding: 32px 0 48px;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
      gap: 24px;
      align-items: stretch;
      margin-bottom: 20px;
    }

    .hero-main,
    .consult {
      border: 1px solid rgba(183, 199, 220, 0.86);
      background: rgba(255, 255, 255, 0.92);
      box-shadow: var(--shadow);
      border-radius: var(--radius);
    }

    .hero-main {
      padding: 26px 28px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-height: 220px;
    }

    .brand-lockup {
      display: flex;
      align-items: center;
      gap: 18px;
      margin-bottom: 22px;
    }

    .brand-logo {
      display: block;
      width: min(300px, 44vw);
      height: auto;
    }

    .eyebrow {
      margin: 0;
      color: var(--brand);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.08em;
      line-height: 1.4;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      color: var(--ink);
      font-size: clamp(32px, 4.4vw, 56px);
      line-height: 1.08;
      font-weight: 600;
      letter-spacing: -0.025em;
    }

    .subtitle {
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.7;
    }

    .consult {
      padding: 18px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 122px;
      gap: 16px;
      align-items: center;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(238, 245, 255, 0.96));
    }

    .consult strong {
      display: block;
      color: var(--ink);
      font-size: 16px;
      font-weight: 600;
      line-height: 1.45;
      margin-bottom: 8px;
    }

    .consult p {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.65;
    }

    .qr-box {
      width: 122px;
      aspect-ratio: 1;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fff;
      display: grid;
      place-items: center;
      color: #315c89;
      text-align: center;
      font-weight: 700;
      line-height: 1.45;
      padding: 12px;
    }

    .qr-box img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      border-radius: 6px;
    }

    .panel {
      border: 1px solid rgba(183, 199, 220, 0.86);
      background: rgba(255, 255, 255, 0.96);
      box-shadow: var(--shadow);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto;
      gap: 12px;
      padding: 14px;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      background: var(--brand-soft);
    }

    .search {
      width: 100%;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius);
      background: #fff;
      color: var(--ink);
      padding: 12px 14px;
      outline: none;
    }

    .search:focus,
    .filter-grid input:focus,
    .filter-grid select:focus,
    .profile-card input:focus,
    .profile-card select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(51, 153, 255, 0.18);
    }

    .clear {
      border: 1px solid var(--brand);
      background: var(--brand);
      color: #fff;
      border-radius: var(--radius);
      padding: 0 18px;
      cursor: pointer;
      font-weight: 750;
      min-height: 44px;
      white-space: nowrap;
    }

    .pager {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: #f7f9fc;
      color: var(--muted);
      font-size: 14px;
    }

    .pager-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .pager button,
    .pager select {
      min-height: 34px;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius);
      background: #fff;
      color: var(--brand);
      padding: 6px 10px;
      font-weight: 750;
    }

    .pager button {
      cursor: pointer;
    }

    .pager button:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    .filter-wrap {
      padding: 14px;
      border-bottom: 1px solid var(--line);
      background: #fff;
    }

    .filter-toggle {
      display: none;
    }

    .filter-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px;
    }

    .filter-item {
      min-width: 0;
    }

    .filter-item label {
      display: block;
      margin: 0 0 5px;
      color: #263f5f;
      font-size: 12px;
      font-weight: 850;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .filter-grid input,
    .filter-grid select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fff;
      color: var(--ink);
      padding: 10px 11px;
      outline: none;
      min-width: 0;
    }

    .table-wrap {
      max-height: calc(100vh - 360px);
      min-height: 360px;
      overflow: auto;
      background: #fff;
    }

    table {
      width: 100%;
      min-width: 1360px;
      border-collapse: separate;
      border-spacing: 0;
      table-layout: fixed;
    }

    th,
    td {
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      padding: 8px 9px;
      text-align: left;
      vertical-align: top;
      font-size: 13px;
      line-height: 1.38;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      word-break: keep-all;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #dcecff;
      color: var(--brand-dark);
      font-size: 12px;
      font-weight: 850;
      white-space: nowrap;
      line-height: 1.28;
    }

    td.wrap-cell {
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    tbody tr:nth-child(even) td {
      background: #f7f9fc;
    }

    tbody tr:hover td {
      background: var(--brand-soft);
    }

    .job-link {
      color: var(--brand);
      font-weight: 800;
      text-decoration: none;
      border-bottom: 1px solid rgba(23, 79, 145, 0.34);
    }

    .job-link:hover {
      border-bottom-color: currentColor;
    }

    .mobile-card-list {
      display: none;
    }

    .job-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 10px 11px;
      box-shadow: 0 6px 18px rgba(20, 55, 99, 0.07);
    }

    .job-card + .job-card {
      margin-top: 7px;
    }

    .job-card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }

    .job-card-company {
      min-width: 0;
      border: 1px solid #c8daf8;
      border-radius: 7px;
      background: var(--brand-soft);
      color: var(--brand);
      padding: 3px 7px;
      font-size: 13px;
      font-weight: 850;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }

    .job-card-season {
      flex: 0 0 auto;
      border: 1px solid #b8d5f5;
      border-radius: 999px;
      background: #eef6ff;
      color: #174f91;
      padding: 3px 7px;
      font-size: 11px;
      font-weight: 850;
      line-height: 1;
      white-space: nowrap;
    }

    .job-card-title {
      display: block;
      color: #174f91;
      font-size: 14px;
      font-weight: 850;
      line-height: 1.32;
      text-decoration: none;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .job-card-title:hover {
      text-decoration: underline;
      text-underline-offset: 3px;
    }

    .job-card-title.is-plain {
      color: var(--ink);
    }

    .job-card-meta {
      margin-top: 6px;
    }

    .job-card-line {
      color: #4b5f78;
      font-size: 11.5px;
      font-weight: 700;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .empty {
      display: none;
      padding: 46px 16px;
      text-align: center;
      color: var(--muted);
      background: #fff;
      border-top: 1px solid var(--line);
    }

    .empty.show {
      display: block;
    }

    .modal {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: rgba(20, 41, 68, 0.42);
    }

    body.locked .modal {
      display: flex;
    }

    .profile-card {
      width: min(480px, 100%);
      border: 1px solid rgba(183, 199, 220, 0.95);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 28px 80px rgba(20, 41, 68, 0.24);
      padding: 26px;
    }

    .profile-card h2 {
      margin: 0;
      color: var(--brand-dark);
      font-size: 24px;
      line-height: 1.25;
      letter-spacing: 0;
    }

    .profile-card .note {
      margin: 9px 0 20px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.65;
    }

    .field {
      margin-bottom: 14px;
    }

    .field label {
      display: block;
      margin-bottom: 7px;
      color: #173d73;
      font-weight: 800;
      font-size: 14px;
    }

    .field input,
    .field select {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      padding: 10px 12px;
      outline: none;
    }

    .submit {
      width: 100%;
      min-height: 46px;
      margin-top: 4px;
      border: 0;
      border-radius: 8px;
      background: var(--brand);
      color: #fff;
      cursor: pointer;
      font-weight: 850;
    }

    .message {
      min-height: 22px;
      margin: 12px 0 0;
      color: #9a3412;
      font-weight: 750;
      line-height: 1.45;
    }

    .about-dbc {
      margin-top: 18px;
      border: 1px solid rgba(183, 199, 220, 0.86);
      background: rgba(255, 255, 255, 0.94);
      box-shadow: var(--shadow);
      border-radius: 8px;
      padding: 22px 24px;
      color: var(--ink);
      line-height: 1.8;
      font-size: 15px;
    }

    .about-dbc p {
      margin: 0 0 10px;
    }

    .about-dbc p:last-child {
      margin-bottom: 0;
    }

    .about-dbc a {
      color: var(--brand);
      font-weight: 800;
      text-decoration: none;
      border-bottom: 1px solid rgba(37, 99, 169, 0.28);
    }

    .about-dbc a:hover {
      border-bottom-color: currentColor;
    }

    @media (max-width: 860px) {
      .shell {
        width: min(100% - 20px, 1440px);
        padding-top: 12px;
      }

      .hero {
        grid-template-columns: 1fr;
      }

      .hero-main {
        padding: 20px;
        min-height: 160px;
      }

      .consult {
        grid-template-columns: minmax(0, 1fr) 108px;
      }

      .qr-box {
        width: 108px;
      }

      .toolbar {
        grid-template-columns: 1fr;
      }

      .clear {
        min-height: 42px;
      }

      .table-wrap {
        max-height: none;
      }
    }

    @media (max-width: 720px) {
      body {
        background: #f3f7fd;
      }

      .shell {
        width: min(100% - 18px, 1440px);
        padding-bottom: 28px;
      }

      .hero {
        gap: 10px;
        margin-bottom: 10px;
      }

      .panel {
        display: flex;
        flex-direction: column;
      }

      .hero-main,
      .consult,
      .panel,
      .about-dbc {
        box-shadow: 0 10px 28px rgba(20, 55, 99, 0.1);
      }

      .hero-main {
        min-height: auto;
        padding: 14px;
      }

      .brand-lockup {
        margin-bottom: 12px;
      }

      .brand-logo {
        width: min(190px, 58vw);
      }

      .eyebrow {
        margin-bottom: 6px;
        font-size: 10px;
        line-height: 1.35;
      }

      h1 {
        font-size: 26px;
        line-height: 1.08;
      }

      .subtitle {
        display: none;
      }

      .consult {
        grid-template-columns: minmax(0, 1fr) 76px;
        padding: 10px;
        gap: 10px;
      }

      .consult strong {
        font-size: 12.5px;
        line-height: 1.35;
        margin-bottom: 4px;
      }

      .consult p {
        display: block;
        font-size: 11.5px;
        line-height: 1.35;
      }

      .qr-box {
        width: 76px;
      }

      .toolbar,
      .pager {
        padding: 10px;
      }

      .toolbar {
        grid-template-columns: minmax(0, 1fr) 64px;
        gap: 8px;
        order: 1;
      }

      .filter-wrap {
        order: 2;
      }

      .table-wrap {
        order: 3;
      }

      .pager {
        order: 4;
      }

      .clear {
        min-height: 42px;
        padding: 0 10px;
      }

      .filter-wrap {
        padding: 0;
        border-bottom: 1px solid var(--line);
        background: #f7f9fc;
      }

      .filter-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        min-height: 40px;
        border: 0;
        background: transparent;
        padding: 0 10px;
        color: var(--brand-dark);
        cursor: pointer;
        font-size: 13px;
        font-weight: 850;
      }

      .filter-toggle::after {
        content: "+";
        color: var(--brand);
        font-size: 18px;
        line-height: 1;
      }

      .filter-wrap:not(.is-collapsed) .filter-toggle::after {
        content: "-";
      }

      .filter-wrap.is-collapsed .filter-grid {
        display: none;
      }

      .search,
      .filter-grid input,
      .filter-grid select {
        min-height: 42px;
        font-size: 14px;
      }

      .filter-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        padding: 0 10px 10px;
      }

      .filter-item label {
        font-size: 11px;
      }

      .pager {
        align-items: stretch;
      }

      .pager-controls {
        width: 100%;
        display: grid;
        grid-template-columns: auto minmax(72px, 1fr) 1fr 1fr;
      }

      .pager button,
      .pager select {
        width: 100%;
      }

      .table-wrap {
        min-height: 240px;
        overflow: visible;
        padding: 8px;
        background: #f6faff;
      }

      table {
        display: none;
      }

      .mobile-card-list {
        display: block;
      }

      .empty {
        border: 1px solid var(--line);
        border-radius: 8px;
      }

      .about-dbc {
        padding: 18px;
        font-size: 14px;
      }
    }

    @media (max-width: 520px) {
      .consult {
        grid-template-columns: minmax(0, 1fr) 76px;
      }

      .qr-box {
        width: 76px;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <main class="shell">
      <section class="hero" aria-label="DBC Job Opening Radar">
        <div class="hero-main">
          <div class="brand-lockup">
            <img class="brand-logo" src="./dbc-logo.png" alt="DBC职梦">
            <p class="eyebrow">DBC职梦教研部 Job Opening Radar</p>
          </div>
          <h1>2027秋招岗位汇总表</h1>
          <p class="subtitle">仅收录当周新增岗位，如需秋招完整岗位表或内推码，请添加右侧DBC职业规划师领取</p>
        </div>
        <aside class="consult">
          <div>
            <strong>关于秋招的网测、面试、实习内推等问题</strong>
            <p>欢迎扫码免费咨询DBC职业规划导师</p>
          </div>
          <div class="qr-box">
            <img src="./qr.png" alt="DBC 咨询二维码">
          </div>
        </aside>
      </section>

      <section class="panel" aria-label="岗位表">
        <div class="toolbar">
          <input id="globalSearch" class="search" type="search" placeholder="搜索公司、岗位、毕业时间、Sponsor 等展示字段">
          <button id="clearBtn" class="clear" type="button">清空</button>
        </div>
        <div class="filter-wrap" id="filterWrap">
          <button class="filter-toggle" id="filterToggle" type="button" aria-expanded="true">筛选条件</button>
          <div class="filter-grid" id="filters"></div>
        </div>
        <div class="pager">
          <span id="pageInfo"></span>
          <div class="pager-controls">
            <label for="pageSize">每页</label>
            <select id="pageSize">
              <option value="50">50</option>
              <option value="100" selected>100</option>
              <option value="200">200</option>
              <option value="500">500</option>
            </select>
            <button id="prevPage" type="button">上一页</button>
            <button id="nextPage" type="button">下一页</button>
          </div>
        </div>
        <div class="table-wrap">
          <div id="jobCards" class="mobile-card-list"></div>
          <table id="jobTable"></table>
          <div id="emptyState" class="empty">没有匹配结果，请调整搜索或筛选条件。</div>
        </div>
      </section>
      <section class="about-dbc" aria-label="关于 DreambigCareer">
        <p>DreambigCareer（DBC职梦）2013年成立于美国休斯顿，13年来已成为全球留学生高薪求职领导品牌，帮助全球留学生斩获15000+高薪offer，坚持用真实案例说话，每张offer都可查验，可追踪。</p>
        <p>官网地址：<a href="https://www.dreambigcareer.com/" target="_blank" rel="noopener noreferrer">https://www.dreambigcareer.com/</a></p>
        <p>关注我们的公众号了解更多信息：DreambigCareer</p>
      </section>
    </main>
  </div>

  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="profileTitle">
    <form class="profile-card" id="profileForm">
      <h2 id="profileTitle">请先选择毕业年份</h2>
      <p class="note">岗位表仅面向适合秋招节奏的同学开放。</p>
      <div class="field">
        <label for="gradYear">毕业年份</label>
        <select id="gradYear" name="gradYear" required>
          <option value="" selected disabled>请选择</option>
          <option value="2024">2024</option>
          <option value="2025">2025</option>
          <option value="2026">2026</option>
          <option value="2027">2027</option>
          <option value="2028">2028</option>
          <option value="2029">2029</option>
          <option value="2030">2030</option>
        </select>
      </div>
      <button class="submit" type="submit">进入岗位表</button>
      <p class="message" id="profileMessage" aria-live="polite"></p>
    </form>
  </div>

  <script>
    window.JOB_OPENING_DATA = ${safeJson(data)};
  </script>
  <script>
    const PROFILE_KEY = "dbcJobOpeningRadarProfile";
    const state = {
      globalSearch: "",
      filters: {},
      page: 1,
      pageSize: 100
    };

    const data = window.JOB_OPENING_DATA;
    const searchEl = document.getElementById("globalSearch");
    const clearBtn = document.getElementById("clearBtn");
    const filterWrap = document.getElementById("filterWrap");
    const filterToggle = document.getElementById("filterToggle");
    const filtersEl = document.getElementById("filters");
    const pageInfoEl = document.getElementById("pageInfo");
    const pageSizeEl = document.getElementById("pageSize");
    const prevPageEl = document.getElementById("prevPage");
    const nextPageEl = document.getElementById("nextPage");
    const tableEl = document.getElementById("jobTable");
    const cardsEl = document.getElementById("jobCards");
    const emptyEl = document.getElementById("emptyState");
    const profileForm = document.getElementById("profileForm");
    const profileMessage = document.getElementById("profileMessage");
    const filterOptionCache = new Map();
    const textFilterHeaders = new Set([
      "company",
      "job title",
      "year of graduation",
      "educational background"
    ]);

    initResponsiveFilters();
    initProfileGate();
    render();

    function initResponsiveFilters() {
      if (!filterWrap || !filterToggle) return;
      if (window.matchMedia("(max-width: 720px)").matches) {
        filterWrap.classList.add("is-collapsed");
        filterToggle.setAttribute("aria-expanded", "false");
      }

      filterToggle.addEventListener("click", () => {
        const willCollapse = !filterWrap.classList.contains("is-collapsed");
        filterWrap.classList.toggle("is-collapsed", willCollapse);
        filterToggle.setAttribute("aria-expanded", willCollapse ? "false" : "true");
      });
    }

    function initProfileGate() {
      const saved = readProfile();
      if (!saved || !isProfileAllowed(saved)) {
        document.body.classList.add("locked");
      }

      profileForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const formData = new FormData(profileForm);
        const profile = {
          gradYear: String(formData.get("gradYear") || "").trim(),
          savedAt: new Date().toISOString()
        };

        if (!profile.gradYear) {
          profileMessage.textContent = "请选择毕业年份。";
          return;
        }

        if (!isProfileAllowed(profile)) {
          profileMessage.textContent = "抱歉，该岗位表没有适合你的岗位";
          return;
        }

        localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
        document.body.classList.remove("locked");
      });
    }

    function readProfile() {
      try {
        return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
      } catch {
        return null;
      }
    }

    function isProfileAllowed(profile) {
      const year = Number(profile && profile.gradYear);
      return Boolean(profile && Number.isFinite(year) && year >= 2026);
    }

    searchEl.addEventListener("input", () => {
      state.globalSearch = searchEl.value.trim().toLowerCase();
      state.page = 1;
      renderTable();
    });

    clearBtn.addEventListener("click", () => {
      state.globalSearch = "";
      state.filters = {};
      state.page = 1;
      searchEl.value = "";
      render();
    });

    pageSizeEl.addEventListener("change", () => {
      state.pageSize = Number(pageSizeEl.value) || 100;
      state.page = 1;
      renderTable();
    });

    prevPageEl.addEventListener("click", () => {
      state.page = Math.max(1, state.page - 1);
      renderTable();
    });

    nextPageEl.addEventListener("click", () => {
      state.page += 1;
      renderTable();
    });

    function render() {
      renderFilters();
      renderTable();
    }

    function currentSheet() {
      return data.sheets[0] || { name: "全部岗位", headers: [], rows: [], hasLink: false, jobTitleKey: null };
    }

    function renderFilters() {
      const sheet = currentSheet();

      filtersEl.innerHTML = sheet.headers.filter((header) => isFilterableHeader(sheet, header)).map((header) => {
        const value = state.filters[header] || "";
        if (isTextFilterHeader(header)) {
          return '<div class="filter-item"><label title="' + escapeAttr(header) + '">' + escapeHtml(header) + '</label><input type="search" data-filter-text="' + escapeAttr(header) + '" value="' + escapeAttr(value) + '" placeholder="输入关键词筛选" autocomplete="off"></div>';
        }

        const options = getFilterOptions(sheet, header);
        const optionHtml = ['<option value="">全部</option>'].concat(options.map((option) => {
          const selected = value === option.value ? ' selected' : '';
          return '<option value="' + escapeAttr(option.value) + '"' + selected + '>' + escapeHtml(option.label) + '</option>';
        })).join("");
        return '<div class="filter-item"><label title="' + escapeAttr(header) + '">' + escapeHtml(header) + '</label><select data-filter="' + escapeAttr(header) + '">' + optionHtml + '</select></div>';
      }).join("");

      filtersEl.querySelectorAll("select[data-filter]").forEach((select) => {
        select.addEventListener("change", () => {
          const key = select.dataset.filter;
          const value = select.value.trim().toLowerCase();
          if (value) {
            state.filters[key] = value;
          } else {
            delete state.filters[key];
          }
          state.page = 1;
          renderTable();
        });
      });

      filtersEl.querySelectorAll("input[data-filter-text]").forEach((input) => {
        input.addEventListener("input", () => {
          const key = input.dataset.filterText;
          const value = input.value.trim().toLowerCase();
          if (value) {
            state.filters[key] = value;
          } else {
            delete state.filters[key];
          }
          state.page = 1;
          renderTable();
        });
      });
    }

    function renderTable() {
      const sheet = currentSheet();
      const filteredRows = sheet.rows.filter((row) => matchesRow(row, sheet));
      const totalPages = Math.max(1, Math.ceil(filteredRows.length / state.pageSize));
      state.page = Math.min(Math.max(1, state.page), totalPages);
      const start = (state.page - 1) * state.pageSize;
      const visibleRows = filteredRows.slice(start, start + state.pageSize);
      pageInfoEl.textContent = filteredRows.length
        ? "当前显示第 " + (start + 1) + "-" + (start + visibleRows.length) + " 条，共 " + filteredRows.length + " 条"
        : "当前没有可显示的岗位";
      prevPageEl.disabled = state.page <= 1;
      nextPageEl.disabled = state.page >= totalPages;

      const headers = sheet.headers;
      const colgroup = '<colgroup>' + headers.map((header) => '<col style="width:' + columnWidth(header) + 'px">').join("") + '</colgroup>';
      const thead = '<thead><tr>' + headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join("") + '</tr></thead>';
      const tbody = '<tbody>' + visibleRows.map((row) => renderRow(row, sheet)).join("") + '</tbody>';
      tableEl.innerHTML = colgroup + thead + tbody;
      cardsEl.innerHTML = visibleRows.map((row) => renderCard(row, sheet)).join("");
      emptyEl.classList.toggle("show", filteredRows.length === 0);
    }

    function renderRow(row, sheet) {
      const cells = sheet.headers.map((header) => {
        const rawValue = row.cells[header] || "";
        const isJobTitle = sheet.jobTitleKey && header === sheet.jobTitleKey;
        const cellClass = isWrappingHeader(header) ? ' class="wrap-cell"' : '';
        if (isJobTitle && row.link) {
          return '<td' + cellClass + ' title="' + escapeAttr(rawValue) + '"><a class="job-link" href="' + escapeAttr(row.link) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(rawValue) + '</a></td>';
        }
        return '<td' + cellClass + ' title="' + escapeAttr(rawValue) + '">' + escapeHtml(rawValue) + '</td>';
      });

      return '<tr>' + cells.join("") + '</tr>';
    }

    function renderCard(row, sheet) {
      const company = getCell(row, "Company") || "未填写公司";
      const title = getCell(row, sheet.jobTitleKey || "Job Title") || "未填写岗位名称";
      const season = getCell(row, "Recruitment Season");
      const titleHtml = row.link
        ? '<a class="job-card-title" href="' + escapeAttr(row.link) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(title) + '</a>'
        : '<span class="job-card-title is-plain">' + escapeHtml(title) + '</span>';
      const seasonHtml = season ? '<span class="job-card-season">' + escapeHtml(season) + '</span>' : "";

      return [
        '<article class="job-card">',
          '<div class="job-card-top">',
            '<div class="job-card-company">' + escapeHtml(company) + '</div>',
            seasonHtml,
          '</div>',
          titleHtml,
          '<div class="job-card-meta">',
            renderCardLine([getCell(row, "Location"), getCell(row, "Type of Program"), getCell(row, "Job Category")]),
          '</div>',
        '</article>'
      ].join("");
    }

    function renderCardLine(values) {
      const displayValue = values.map((value) => String(value || "").trim()).filter(Boolean).join(" · ") || "-";
      return '<div class="job-card-line">' + escapeHtml(displayValue) + '</div>';
    }

    function getCell(row, header) {
      return String(row.cells[header] || "").trim();
    }

    function isWrappingHeader(header) {
      const normalized = String(header || "").trim().toLowerCase();
      return normalized === "company" || normalized === "job title";
    }

    function matchesRow(row, sheet) {
      const searchableText = sheet.headers.map((header) => row.cells[header] || "").join(" ").toLowerCase();
      if (state.globalSearch && !searchableText.includes(state.globalSearch)) return false;

      return Object.entries(state.filters).every(([header, value]) => {
        const cellValue = String(row.cells[header] || "").toLowerCase();
        return isTextFilterHeader(header) ? cellValue.includes(value) : cellValue === value;
      });
    }

    function isFilterableHeader(sheet, header) {
      const normalized = String(header || "").trim().toLowerCase();
      if (normalized === "posting date") return false;
      if (normalized === "application deadline") return false;
      if (["job direction", "qualification", "qualifications"].includes(normalized)) return false;
      if (isTextFilterHeader(header)) return true;
      return getFilterOptions(sheet, header).length <= 1000;
    }

    function isTextFilterHeader(header) {
      return textFilterHeaders.has(String(header || "").trim().toLowerCase());
    }

    function getFilterOptions(sheet, header) {
      if (filterOptionCache.has(header)) return filterOptionCache.get(header);
      const values = new Map();
      sheet.rows.forEach((row) => {
        const value = String(row.cells[header] || "").trim();
        const normalized = value.toLowerCase();
        if (value && !values.has(normalized)) values.set(normalized, value);
      });

      let options = Array.from(values.entries()).map(([value, label]) => ({ value, label }));
      if (String(header || "").trim().toLowerCase() === "recruitment season") {
        options = options.filter((option) => /^20\\d{2}$/.test(option.label));
      }
      options.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
      filterOptionCache.set(header, options);
      return options;
    }

    function columnWidth(header) {
      const normalized = String(header || "").trim().toLowerCase();
      if (normalized === "apply") return 68;
      if (normalized === "posting date") return 98;
      if (normalized === "recruitment season") return 88;
      if (normalized.includes("company")) return 150;
      if (normalized.includes("category")) return 82;
      if (normalized.includes("location")) return 96;
      if (normalized.includes("type of program")) return 92;
      if (normalized.includes("job title") || normalized.includes("title")) return 320;
      if (normalized.includes("year of graduation")) return 110;
      if (normalized.includes("sponsor") || normalized.includes("visa")) return 90;
      if (normalized.includes("educational background")) return 104;
      if (normalized.includes("deadline")) return 100;
      if (normalized.includes("description") || normalized.includes("requirement")) return 180;
      return 105;
    }

    function escapeHtml(value) {
      return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function escapeAttr(value) {
      return escapeHtml(value).replaceAll("\\n", " ");
    }
  </script>
</body>
</html>`;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
