import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
const sourceHtmlPath = path.join(root, "job-opening-radar", "dist", "index.html");
const outputHtmlPath = path.join(root, "outputs", "job-opening-radar", "index.html");
const functionDataPath = path.join(root, "netlify", "functions", "job-opening-radar-data.json");
const apiPath = "/.netlify/functions/job-opening-radar";

const sourceHtml = await fs.readFile(sourceHtmlPath, "utf8");
const dataMatch = sourceHtml.match(/<script>\s*window\.JOB_OPENING_DATA\s*=\s*([\s\S]*?);\s*<\/script>\s*<script>[\s\S]*?<\/script>/);

if (!dataMatch) {
  throw new Error("Could not find embedded job data in job-opening-radar/dist/index.html");
}

const data = JSON.parse(dataMatch[1]);
await fs.mkdir(path.dirname(outputHtmlPath), { recursive: true });
await fs.mkdir(path.dirname(functionDataPath), { recursive: true });
await fs.writeFile(functionDataPath, JSON.stringify(data), "utf8");

const protectedHtml = sourceHtml
  .replace(
    dataMatch[0],
    `<script>
${clientScript(apiPath)}
  </script>`
  )
  .replace(
    "DreambigCareer（DBC职梦）2013年成立于美国休斯顿，13年来已成为全球留学生高薪求职领导品牌，帮助全球留学生斩获15000+高薪offer，坚持用真实案例说话，每张offer都可查验，可追踪。",
    "DreambigCareer（DBC职梦）2013年成立于美国休斯顿，13年来已成为全球留学生求职领导品牌，帮助全球留学生斩获15000+offer，坚持用真实案例说话，每张offer都可查验，可追踪。"
  );

await fs.writeFile(outputHtmlPath, protectedHtml, "utf8");
console.log(`Wrote protected job radar page to ${outputHtmlPath}`);
console.log(`Wrote server-side job data to ${functionDataPath}`);

function clientScript(apiPath) {
  return `    const PROFILE_KEY = "dbcJobOpeningRadarProfile";
    const API_PATH = ${JSON.stringify(apiPath)};
    const state = {
      globalSearch: "",
      filters: {},
      page: 1,
      pageSize: 50,
      rows: [],
      total: 0,
      totalPages: 1
    };

    let sheet = { name: "全部岗位", headers: [], hasLink: false, jobTitleKey: null, filterOptions: {} };

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
    const textFilterHeaders = new Set([
      "company",
      "job title",
      "year of graduation",
      "educational background"
    ]);

    pageSizeEl.innerHTML = '<option value="25">25</option><option value="50" selected>50</option>';
    initResponsiveFilters();
    initProfileGate();
    initData();

    async function initData() {
      setLoading(true);
      try {
        const meta = await apiRequest({ meta: true });
        sheet = meta.sheet || sheet;
        renderFilters();
        await renderTable();
      } catch (error) {
        pageInfoEl.textContent = "岗位数据暂时无法加载，请稍后刷新。";
        emptyEl.classList.add("show");
      } finally {
        setLoading(false);
      }
    }

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

    searchEl.addEventListener("input", debounce(() => {
      state.globalSearch = searchEl.value.trim().toLowerCase();
      state.page = 1;
      renderTable();
    }, 220));

    clearBtn.addEventListener("click", () => {
      state.globalSearch = "";
      state.filters = {};
      state.page = 1;
      searchEl.value = "";
      renderFilters();
      renderTable();
    });

    pageSizeEl.addEventListener("change", () => {
      state.pageSize = Number(pageSizeEl.value) || 50;
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

    function renderFilters() {
      filtersEl.innerHTML = sheet.headers.filter((header) => isFilterableHeader(header)).map((header) => {
        const value = state.filters[header] || "";
        if (isTextFilterHeader(header)) {
          return '<div class="filter-item"><label title="' + escapeAttr(header) + '">' + escapeHtml(header) + '</label><input type="search" data-filter-text="' + escapeAttr(header) + '" value="' + escapeAttr(value) + '" placeholder="输入关键词筛选" autocomplete="off"></div>';
        }

        const options = sheet.filterOptions[header] || [];
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
        input.addEventListener("input", debounce(() => {
          const key = input.dataset.filterText;
          const value = input.value.trim().toLowerCase();
          if (value) {
            state.filters[key] = value;
          } else {
            delete state.filters[key];
          }
          state.page = 1;
          renderTable();
        }, 180));
      });
    }

    async function renderTable() {
      setLoading(true);
      try {
        const result = await apiRequest({
          page: state.page,
          pageSize: state.pageSize,
          globalSearch: state.globalSearch,
          filters: state.filters
        });
        state.rows = result.rows || [];
        state.total = result.total || 0;
        state.totalPages = result.totalPages || 1;
        state.page = result.page || 1;

        const start = state.total ? (state.page - 1) * state.pageSize : 0;
        pageInfoEl.textContent = state.total
          ? "当前显示第 " + (start + 1) + "-" + (start + state.rows.length) + " 条，共 " + state.total + " 条"
          : "当前没有可显示的岗位";
        prevPageEl.disabled = state.page <= 1;
        nextPageEl.disabled = state.page >= state.totalPages;

        const headers = sheet.headers;
        const colgroup = '<colgroup>' + headers.map((header) => '<col style="width:' + columnWidth(header) + 'px">').join("") + '</colgroup>';
        const thead = '<thead><tr>' + headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join("") + '</tr></thead>';
        const tbody = '<tbody>' + state.rows.map((row) => renderRow(row)).join("") + '</tbody>';
        tableEl.innerHTML = colgroup + thead + tbody;
        cardsEl.innerHTML = state.rows.map((row) => renderCard(row)).join("");
        emptyEl.classList.toggle("show", state.total === 0);
      } catch (error) {
        pageInfoEl.textContent = "岗位数据暂时无法加载，请稍后刷新。";
      } finally {
        setLoading(false);
      }
    }

    function renderRow(row) {
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

    function renderCard(row) {
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

    async function apiRequest(payload) {
      const response = await fetch(API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store"
      });
      if (!response.ok) throw new Error("Request failed");
      return response.json();
    }

    function setLoading(isLoading) {
      prevPageEl.disabled = isLoading || state.page <= 1;
      nextPageEl.disabled = isLoading || state.page >= state.totalPages;
    }

    function getCell(row, header) {
      return String(row.cells[header] || "").trim();
    }

    function isWrappingHeader(header) {
      const normalized = String(header || "").trim().toLowerCase();
      return normalized === "company" || normalized === "job title";
    }

    function isFilterableHeader(header) {
      const normalized = String(header || "").trim().toLowerCase();
      if (normalized === "posting date") return false;
      if (normalized === "application deadline") return false;
      if (["job direction", "qualification", "qualifications"].includes(normalized)) return false;
      if (isTextFilterHeader(header)) return true;
      return Boolean(sheet.filterOptions[header]);
    }

    function isTextFilterHeader(header) {
      return textFilterHeaders.has(String(header || "").trim().toLowerCase());
    }

    function columnWidth(header) {
      const normalized = String(header || "").trim().toLowerCase();
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

    function debounce(fn, delay) {
      let timer = null;
      return (...args) => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => fn(...args), delay);
      };
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
    }`;
}
