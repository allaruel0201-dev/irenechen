function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function splitTopicTitle(title) {
  const raw = String(title || "").trim();
  const match = raw.match(/^(\d+)[\.\)）]?\s*(.+)$/);
  if (!match) return { index: "", title: raw };
  return {
    index: match[1].padStart(2, "0"),
    title: match[2].trim(),
  };
}

function sectionBlock(label, body) {
  const text = String(body || "").trim();
  if (!text) return "";
  return `
    <section class="memo-block">
      <div class="memo-label">${escapeHtml(label)}</div>
      <div class="memo-copy">${escapeHtml(text)}</div>
    </section>
  `;
}

function storyLink(url, text) {
  const href = String(url || "").trim();
  if (!href) return `<span class="topic-title">${escapeHtml(text)}</span>`;
  return `<a class="topic-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
}

function buildDayList(days, activeDate) {
  const el = document.getElementById("dayList");
  el.innerHTML = "";

  for (const day of days) {
    const btn = document.createElement("button");
    btn.className = "day-btn" + (day.date === activeDate ? " active" : "");
    const count = (day.top_topics || []).length;
    btn.innerHTML = `
      <span class="day-marker" aria-hidden="true"></span>
      <div class="day-copy">
        <div class="day-date">${escapeHtml(day.date)}</div>
        <div class="day-meta">必写 ${count} · 备选 ${(day.alternatives || []).length}</div>
      </div>
      <div class="day-chevron" aria-hidden="true">↗</div>
    `;
    btn.addEventListener("click", () => {
      state.activeDate = day.date;
      render();
    });
    el.appendChild(btn);
  }
}

function renderDay(day) {
  const container = document.getElementById("dayView");
  if (!day) {
    container.innerHTML = "";
    return;
  }

  const topCards = (day.top_topics || [])
    .map((t, idx) => {
      const parsed = splitTopicTitle(t.title);
      const primaryUrl =
        ((t.source_urls || []).find((url) => String(url || "").trim()) || "").trim() ||
        `../daily/${encodeURIComponent(day.date + "-topic-radar.md")}`;
      const sources = (t.sources || []).slice(0, 6);
      const summary = (t.summary || "").trim();
      const why = (t.why_it_matters || "").trim();
      const signal = (t.job_signal || "").trim();
      return `
        <article class="card topic-card">
          <div class="topic-head">
            <div class="topic-title-group">
              <div class="topic-index">${escapeHtml(parsed.index || String(idx + 1).padStart(2, "0"))}</div>
              ${storyLink(primaryUrl, parsed.title)}
            </div>
          </div>
          ${sectionBlock("这件事", summary)}
          ${sectionBlock("为什么值得写", why)}
          ${sectionBlock("可写角度", signal)}
          ${
            sources.length
              ? `<section class="memo-block">
                  <div class="memo-label">来源</div>
                  <ul class="source-list">${sources
                  .map((s) => `<li>${escapeHtml(s)}</li>`)
                  .join("")}</ul>
                </section>`
              : ""
          }
        </article>
      `;
    })
    .join("");

  const altCards = (day.alternatives || [])
    .sort((a, b) => (b.score_total || 0) - (a.score_total || 0))
    .map((a) => {
      const parsed = splitTopicTitle(a.title);
      const primaryUrl = String(a.source_url || "").trim() || `../daily/${encodeURIComponent(day.date + "-topic-radar.md")}`;
      return `
        <article class="card alt-card">
          <div class="alt-head">
            ${storyLink(primaryUrl, parsed.title)}
          </div>
          <div class="memo-copy alt-summary">${escapeHtml(a.summary || "")}</div>
        </article>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="day-header">
      <div class="day-header-meta">Daily Memo · ${escapeHtml(day.date)}</div>
      <h1 class="day-header-title">前一日选题概览</h1>
      <div class="day-header-sub">查看主选题和备选池。</div>
    </div>

    <section class="section">
      <div class="section-title-row">
        <div>
          <div class="section-kicker">Top Picks</div>
          <div class="section-title">主选题</div>
        </div>
        <div class="section-sub"><a class="link" href="../daily/${encodeURIComponent(day.date + "-topic-radar.md")}" target="_blank" rel="noreferrer">查看原文</a></div>
      </div>
      <div class="cards">${topCards || `<div class="empty-panel">当日未识别到“必写”结构。</div>`}</div>
    </section>

    <section class="section">
      <div class="section-title-row">
        <div>
          <div class="section-kicker">Watchlist</div>
          <div class="section-title">备选池</div>
        </div>
        <div class="section-sub">始终展示</div>
      </div>
      <div class="cards alt-cards">${altCards || `<div class="empty-panel">当日未识别到备选池结构。</div>`}</div>
    </section>
  `;
}

function applyFilters(data, query) {
  const q = String(query || "").trim().toLowerCase();

  const days = (data.days || []).map((d) => {
    const top = (d.top_topics || []).filter((t) => {
      const text = `${t.title || ""} ${(t.sources || []).join(" ")}`.toLowerCase();
      return !q || text.includes(q);
    });

    const alts = (d.alternatives || []).filter((a) => {
      const text = `${a.title || ""} ${a.summary || ""}`.toLowerCase();
      const passQ = !q || text.includes(q);
      return passQ;
    });

    return { ...d, top_topics: top, alternatives: alts };
  });

  const visibleDays = days.filter((d) => (d.top_topics || []).length > 0 || (d.alternatives || []).length > 0);
  return visibleDays;
}

const state = {
  activeDate: null,
};

function render() {
  const data = window.TOPIC_RADAR_DATA || { days: [] };
  const query = document.getElementById("q").value;

  const filteredDays = applyFilters(data, query);
  const empty = document.getElementById("empty");
  const dayView = document.getElementById("dayView");

  if (filteredDays.length === 0) {
    empty.classList.remove("hidden");
    dayView.innerHTML = "";
    buildDayList([], null);
    return;
  }

  empty.classList.add("hidden");

  if (!state.activeDate || !filteredDays.some((d) => d.date === state.activeDate)) {
    state.activeDate = filteredDays[0].date;
  }

  buildDayList(filteredDays, state.activeDate);
  renderDay(filteredDays.find((d) => d.date === state.activeDate));
}

document.getElementById("q").addEventListener("input", render);

render();
