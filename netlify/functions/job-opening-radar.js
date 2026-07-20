const fs = require("node:fs");
const path = require("node:path");

const DATA_PATH = path.join(__dirname, "job-opening-radar-data.json");
const TEXT_FILTER_HEADERS = new Set([
  "company",
  "job title",
  "year of graduation",
  "educational background"
]);

let cachedData = null;
let cachedMeta = null;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method not allowed" });
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return response(400, { error: "Invalid request" });
  }

  const data = loadData();
  const sheet = currentSheet(data);

  if (body.meta) {
    return response(200, getMeta(data, sheet));
  }

  const pageSize = clampNumber(body.pageSize, 50, 1, 50);
  const requestedPage = clampNumber(body.page, 1, 1, 100000);
  const globalSearch = String(body.globalSearch || "").trim().toLowerCase();
  const filters = normalizeFilters(body.filters || {});
  const filteredRows = sheet.rows.filter((row) => matchesRow(row, sheet, globalSearch, filters));
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  const rows = filteredRows.slice(start, start + pageSize);

  return response(200, {
    page,
    pageSize,
    total: filteredRows.length,
    totalPages,
    rows
  });
};

function loadData() {
  if (!cachedData) {
    cachedData = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  }
  return cachedData;
}

function currentSheet(data) {
  return data.sheets?.[0] || { name: "全部岗位", headers: [], rows: [], hasLink: false, jobTitleKey: null };
}

function getMeta(data, sheet) {
  if (cachedMeta) return cachedMeta;
  cachedMeta = {
    generatedAt: data.generatedAt,
    sourceName: data.sourceName,
    workbookName: data.workbookName,
    sheet: {
      name: sheet.name,
      headers: sheet.headers,
      hasLink: sheet.hasLink,
      jobTitleKey: sheet.jobTitleKey,
      filterOptions: buildFilterOptions(sheet)
    }
  };
  return cachedMeta;
}

function buildFilterOptions(sheet) {
  const result = {};
  for (const header of sheet.headers) {
    if (!isFilterableHeader(sheet, header) || isTextFilterHeader(header)) continue;
    const values = new Map();
    for (const row of sheet.rows) {
      const value = String(row.cells[header] || "").trim();
      const normalized = value.toLowerCase();
      if (value && !values.has(normalized)) values.set(normalized, value);
    }

    let options = Array.from(values.entries()).map(([value, label]) => ({ value, label }));
    if (String(header || "").trim().toLowerCase() === "recruitment season") {
      options = options.filter((option) => /^20\d{2}$/.test(option.label));
    }
    options.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
    if (options.length <= 1000) result[header] = options;
  }
  return result;
}

function matchesRow(row, sheet, globalSearch, filters) {
  const searchableText = sheet.headers.map((header) => row.cells[header] || "").join(" ").toLowerCase();
  if (globalSearch && !searchableText.includes(globalSearch)) return false;

  return Object.entries(filters).every(([header, value]) => {
    const cellValue = String(row.cells[header] || "").toLowerCase();
    return isTextFilterHeader(header) ? cellValue.includes(value) : cellValue === value;
  });
}

function normalizeFilters(filters) {
  return Object.fromEntries(
    Object.entries(filters)
      .map(([header, value]) => [header, String(value || "").trim().toLowerCase()])
      .filter(([, value]) => value)
  );
}

function isFilterableHeader(sheet, header) {
  const normalized = String(header || "").trim().toLowerCase();
  if (normalized === "posting date") return false;
  if (normalized === "application deadline") return false;
  if (["job direction", "qualification", "qualifications"].includes(normalized)) return false;
  if (isTextFilterHeader(header)) return true;
  return Boolean(sheet.filterOptions?.[header]) || true;
}

function isTextFilterHeader(header) {
  return TEXT_FILTER_HEADERS.has(String(header || "").trim().toLowerCase());
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow"
    },
    body: JSON.stringify(body)
  };
}
