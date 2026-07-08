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
  const qrSource = path.join(assetsDir, "qr.png");
  if (fs.existsSync(qrSource)) {
    await fsp.copyFile(qrSource, path.join(distDir, "qr.png"));
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

  return Promise.all(entries.map(async (entry, index) => {
    const basename = path.basename(entry.entryName);
    const workbookPath = path.join(tempDir, `${String(index + 1).padStart(2, "0")}-${basename}`);
    await fsp.writeFile(workbookPath, entry.getData());
    return { path: workbookPath, name: basename };
  }));
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
    .filter(({ header, index }) => index < ignoredStart && header.trim().toLowerCase() !== "link")
    .map(({ header, index }) => ({ key: header, index }));

  const dataRows = rows.slice(headerRowIndex + 1).map((row) => {
    const item = {};
    visibleIndexes.forEach(({ key, index }) => {
      item[key] = normalizeCell(row[index]);
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

  return {
    name: "全部岗位",
    headers,
    rows,
    hasLink,
    jobTitleKey
  };
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
  <title>DBC 秋招岗位开放表</title>
  <style>
    :root {
      --ink: #34261f;
      --muted: #78685d;
      --paper: #fffaf1;
      --panel: #fffdf8;
      --line: #e7d8c8;
      --line-strong: #d4bda6;
      --brand: #7a4d2e;
      --brand-dark: #54331f;
      --brand-soft: #ead7bf;
      --accent: #b57a48;
      --cream: #f5ead8;
      --shadow: 0 18px 48px rgba(64, 42, 25, 0.12);
      color-scheme: light;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(135deg, rgba(255, 250, 241, 0.96), rgba(240, 224, 204, 0.92)),
        radial-gradient(circle at top right, rgba(181, 122, 72, 0.18), transparent 34%);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
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
      width: min(1440px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 44px;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(320px, 440px);
      gap: 18px;
      align-items: stretch;
      margin-bottom: 18px;
    }

    .hero-main,
    .consult {
      border: 1px solid rgba(212, 189, 166, 0.82);
      background: rgba(255, 253, 248, 0.88);
      box-shadow: var(--shadow);
      border-radius: 8px;
    }

    .hero-main {
      padding: 26px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-height: 190px;
    }

    .eyebrow {
      margin: 0 0 12px;
      color: var(--brand);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.13em;
    }

    h1 {
      margin: 0;
      color: var(--brand-dark);
      font-size: clamp(30px, 4vw, 54px);
      line-height: 1.04;
      font-weight: 850;
      letter-spacing: 0;
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
        linear-gradient(135deg, rgba(255, 252, 246, 0.96), rgba(235, 214, 190, 0.96));
    }

    .consult strong {
      display: block;
      color: var(--brand-dark);
      font-size: 19px;
      line-height: 1.45;
      margin-bottom: 8px;
    }

    .consult p {
      margin: 0;
      color: #6b5140;
      font-size: 14px;
      line-height: 1.65;
    }

    .qr-box {
      width: 122px;
      aspect-ratio: 1;
      border: 1px dashed #a77a58;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.58);
      display: grid;
      place-items: center;
      color: #8a6248;
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
      border: 1px solid rgba(212, 189, 166, 0.82);
      background: rgba(255, 253, 248, 0.92);
      box-shadow: var(--shadow);
      border-radius: 8px;
      overflow: hidden;
    }

    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto;
      gap: 12px;
      padding: 14px;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      background: rgba(250, 241, 228, 0.72);
    }

    .search {
      width: 100%;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      padding: 12px 14px;
      outline: none;
    }

    .search:focus,
    .filter-grid select:focus,
    .profile-card input:focus,
    .profile-card select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(181, 122, 72, 0.16);
    }

    .clear {
      border: 1px solid #916446;
      background: var(--brand-dark);
      color: #fff;
      border-radius: 8px;
      padding: 0 18px;
      cursor: pointer;
      font-weight: 750;
      min-height: 44px;
      white-space: nowrap;
    }

    .meta-line {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      color: var(--muted);
      font-size: 14px;
      border-bottom: 1px solid var(--line);
    }

    .counts {
      color: var(--brand-dark);
      font-weight: 800;
    }

    .pager {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: #fffaf2;
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
      border-radius: 8px;
      background: #fff;
      color: var(--brand-dark);
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
      background: rgba(255, 252, 246, 0.8);
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
      color: #5a4030;
      font-size: 12px;
      font-weight: 850;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .filter-grid select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
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
      min-width: 1680px;
      border-collapse: separate;
      border-spacing: 0;
      table-layout: fixed;
    }

    th,
    td {
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
      font-size: 14px;
      line-height: 1.45;
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: normal;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #ead7bf;
      color: #3f2a1d;
      font-size: 13px;
      font-weight: 850;
      white-space: normal;
      line-height: 1.35;
    }

    tbody tr:nth-child(even) td {
      background: #fffbf4;
    }

    tbody tr:hover td {
      background: #f7eddf;
    }

    .job-link {
      color: #6d3f24;
      font-weight: 800;
      text-decoration: none;
      border-bottom: 1px solid rgba(109, 63, 36, 0.34);
    }

    .job-link:hover {
      border-bottom-color: currentColor;
    }

    .apply-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 72px;
      min-height: 34px;
      border-radius: 8px;
      background: var(--brand);
      color: #fff;
      text-decoration: none;
      font-weight: 800;
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
      background: rgba(47, 34, 25, 0.42);
    }

    body.locked .modal {
      display: flex;
    }

    .profile-card {
      width: min(480px, 100%);
      border: 1px solid rgba(212, 189, 166, 0.95);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 28px 80px rgba(35, 22, 14, 0.26);
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
      color: #513729;
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
      color: #8b2f23;
      font-weight: 750;
      line-height: 1.45;
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

    @media (max-width: 520px) {
      .consult {
        grid-template-columns: 1fr;
      }

      .qr-box {
        width: 136px;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <main class="shell">
      <section class="hero" aria-label="DBC Job Opening Radar">
        <div class="hero-main">
          <p class="eyebrow">DBC JOB OPENING RADAR</p>
          <h1>DBC 秋招岗位开放表</h1>
          <p class="subtitle">只包含本周新增岗位，如需秋招所有已更新的在招岗位，请联系扫码联系tutor获取（已添加可直接联系）</p>
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
          <input id="globalSearch" class="search" type="search" placeholder="搜索公司、岗位、方向、资格、毕业时间、Sponsor 等展示字段">
          <button id="clearBtn" class="clear" type="button">清空</button>
        </div>
        <div class="meta-line">
          <span id="sheetName"></span>
          <span class="counts" id="counts"></span>
        </div>
        <div class="filter-wrap">
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
          <table id="jobTable"></table>
          <div id="emptyState" class="empty">没有匹配结果，请调整搜索或筛选条件。</div>
        </div>
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
    const sheetNameEl = document.getElementById("sheetName");
    const countsEl = document.getElementById("counts");
    const filtersEl = document.getElementById("filters");
    const pageInfoEl = document.getElementById("pageInfo");
    const pageSizeEl = document.getElementById("pageSize");
    const prevPageEl = document.getElementById("prevPage");
    const nextPageEl = document.getElementById("nextPage");
    const tableEl = document.getElementById("jobTable");
    const emptyEl = document.getElementById("emptyState");
    const profileForm = document.getElementById("profileForm");
    const profileMessage = document.getElementById("profileMessage");
    const filterOptionCache = new Map();

    initProfileGate();
    render();

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
      sheetNameEl.textContent = sheet.name;

      filtersEl.innerHTML = sheet.headers.filter((header) => isFilterableHeader(sheet, header)).map((header) => {
        const value = state.filters[header] || "";
        const options = getFilterOptions(sheet, header);
        const optionHtml = ['<option value="">全部</option>'].concat(options.map((option) => {
          const selected = value === option.toLowerCase() ? ' selected' : '';
          return '<option value="' + escapeAttr(option) + '"' + selected + '>' + escapeHtml(option) + '</option>';
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
    }

    function renderTable() {
      const sheet = currentSheet();
      const filteredRows = sheet.rows.filter((row) => matchesRow(row, sheet));
      const totalPages = Math.max(1, Math.ceil(filteredRows.length / state.pageSize));
      state.page = Math.min(Math.max(1, state.page), totalPages);
      const start = (state.page - 1) * state.pageSize;
      const visibleRows = filteredRows.slice(start, start + state.pageSize);
      countsEl.textContent = "总岗位数 " + sheet.rows.length + "，筛选后 " + filteredRows.length;
      pageInfoEl.textContent = filteredRows.length
        ? "当前显示第 " + (start + 1) + "-" + (start + visibleRows.length) + " 条，共 " + filteredRows.length + " 条"
        : "当前没有可显示的岗位";
      prevPageEl.disabled = state.page <= 1;
      nextPageEl.disabled = state.page >= totalPages;

      const headers = sheet.hasLink ? [...sheet.headers, "Apply"] : sheet.headers;
      const colgroup = '<colgroup>' + headers.map((header) => '<col style="width:' + columnWidth(header) + 'px">').join("") + '</colgroup>';
      const thead = '<thead><tr>' + headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join("") + '</tr></thead>';
      const tbody = '<tbody>' + visibleRows.map((row) => renderRow(row, sheet)).join("") + '</tbody>';
      tableEl.innerHTML = colgroup + thead + tbody;
      emptyEl.classList.toggle("show", filteredRows.length === 0);
    }

    function renderRow(row, sheet) {
      const cells = sheet.headers.map((header) => {
        const rawValue = row.cells[header] || "";
        const isJobTitle = sheet.jobTitleKey && header === sheet.jobTitleKey;
        if (isJobTitle && row.link) {
          return '<td><a class="job-link" href="' + escapeAttr(row.link) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(rawValue) + '</a></td>';
        }
        return '<td>' + escapeHtml(rawValue) + '</td>';
      });

      if (sheet.hasLink) {
        const apply = row.link
          ? '<a class="apply-btn" href="' + escapeAttr(row.link) + '" target="_blank" rel="noopener noreferrer">Apply</a>'
          : "";
        cells.push('<td>' + apply + '</td>');
      }

      return '<tr>' + cells.join("") + '</tr>';
    }

    function matchesRow(row, sheet) {
      const searchableText = sheet.headers.map((header) => row.cells[header] || "").join(" ").toLowerCase();
      if (state.globalSearch && !searchableText.includes(state.globalSearch)) return false;

      return Object.entries(state.filters).every(([header, value]) => {
        return String(row.cells[header] || "").toLowerCase() === value;
      });
    }

    function isFilterableHeader(sheet, header) {
      const normalized = String(header || "").trim().toLowerCase();
      if (normalized === "qualification" || normalized === "qualifications") return false;
      return getFilterOptions(sheet, header).length <= 1000;
    }

    function getFilterOptions(sheet, header) {
      if (filterOptionCache.has(header)) return filterOptionCache.get(header);
      const values = new Set();
      sheet.rows.forEach((row) => {
        const value = String(row.cells[header] || "").trim();
        if (value) values.add(value);
      });

      const options = Array.from(values).sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
      filterOptionCache.set(header, options);
      return options;
    }

    function columnWidth(header) {
      const normalized = String(header || "").trim().toLowerCase();
      if (normalized === "apply") return 92;
      if (normalized.includes("job title") || normalized.includes("title")) return 320;
      if (normalized.includes("company")) return 210;
      if (normalized.includes("qualification")) return 360;
      if (normalized.includes("description") || normalized.includes("requirement")) return 360;
      if (normalized.includes("location")) return 180;
      if (normalized.includes("date") || normalized.includes("deadline")) return 145;
      if (normalized.includes("sponsor") || normalized.includes("visa")) return 155;
      if (normalized.includes("category") || normalized.includes("direction") || normalized.includes("season")) return 175;
      return 170;
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
