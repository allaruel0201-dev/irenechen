function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function scorePill(score) {
  if (typeof score !== "number") return `<span class="pill">总分：N/A</span>`;
  const cls = score >= 26 ? "good" : score >= 22 ? "" : "warn";
  return `<span class="pill ${cls}">总分：${score}</span>`;
}

function buildDayList(days, activeDate) {
  const el = document.getElementById("dayList");
  el.innerHTML = "";

  for (const day of days) {
    const btn = document.createElement("button");
    btn.className = "day-btn" + (day.date === activeDate ? " active" : "");
    const count = (day.top_topics || []).length;
    btn.innerHTML = `
      <div>
        <div style="font-weight:800">${escapeHtml(day.date)}</div>
        <div class="day-meta">必写：${count}｜备选：${(day.alternatives || []).length}</div>
      </div>
      <div class="day-meta">›</div>
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
    .map((t) => {
      const sources = (t.sources || []).slice(0, 6);
      const summary = (t.summary || "").trim();
      const why = (t.why_it_matters || "").trim();
      const signal = (t.job_signal || "").trim();
      return `
        <div class="card">
          <div class="card-title">${escapeHtml(t.title)}</div>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
            ${scorePill(t.score_total)}
          </div>
          ${summary ? `<div class="sources"><div style="margin-top:8px; font-weight:700; color:#cfd5ea">事件摘要</div><div style="margin-top:6px">${escapeHtml(summary)}</div></div>` : ""}
          ${why ? `<div class="sources"><div style="margin-top:10px; font-weight:700; color:#cfd5ea">和求职的关系（为什么重要）</div><div style="margin-top:6px">${escapeHtml(why)}</div></div>` : ""}
          ${signal ? `<div class="sources"><div style="margin-top:10px; font-weight:700; color:#cfd5ea">职业机会信号（可落地）</div><div style="margin-top:6px">${escapeHtml(signal)}</div></div>` : ""}
          ${
            sources.length
              ? `<div class="sources"><div>来源（节选）</div><ul>${sources
                  .map((s) => `<li>${escapeHtml(s)}</li>`)
                  .join("")}</ul></div>`
              : ""
          }
        </div>
      `;
    })
    .join("");

  const altCards = (day.alternatives || [])
    .sort((a, b) => (b.score_total || 0) - (a.score_total || 0))
    .map((a) => {
      return `
        <div class="card">
          <div class="card-title">${escapeHtml(a.title)}</div>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
            ${scorePill(a.score_total)}
          </div>
          <div class="sources">${escapeHtml(a.summary || "")}</div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="section">
      <div class="section-title">
        <div>必写 3 题</div>
        <div class="section-sub"><a class="link" href="../daily/${encodeURIComponent(day.date + "-topic-radar.md")}" target="_blank" rel="noreferrer">打开原文</a></div>
      </div>
      <div class="cards">${topCards || `<div class="sources">当日未识别到“必写”结构。</div>`}</div>
    </div>

    <div class="section">
      <div class="section-title">
        <div>备选池</div>
        <div class="section-sub">默认全部展示（不受最低总分影响）</div>
      </div>
      <div class="cards">${altCards || `<div class="sources">当日未识别到备选池结构。</div>`}</div>
    </div>
  `;
}

function applyFilters(data, query, minScore) {
  const q = String(query || "").trim().toLowerCase();
  const min = Number(minScore || 0);

  const days = (data.days || []).map((d) => {
    const top = (d.top_topics || []).filter((t) => {
      const text = `${t.title || ""} ${(t.sources || []).join(" ")}`.toLowerCase();
      const passQ = !q || text.includes(q);
      const passScore = typeof t.score_total !== "number" ? min <= 0 : t.score_total >= min;
      return passQ && passScore;
    });

    const alts = (d.alternatives || []).filter((a) => {
      const text = `${a.title || ""} ${a.summary || ""}`.toLowerCase();
      const passQ = !q || text.includes(q);
      // Alternatives should always be visible; minScore is for "top topics" only.
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
  const minScore = document.getElementById("minScore").value;

  const filteredDays = applyFilters(data, query, minScore);
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
document.getElementById("minScore").addEventListener("change", render);

render();
