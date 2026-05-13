/* ═══════════════════════════════════════════════════════════════════════════
   SUI A2A Registry Dashboard — Frontend App
═══════════════════════════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  agents:      [],
  total:       0,
  page:        1,
  limit:       15,
  filter:      "all",
  search:      "",
  sortCol:     "agentId",
  sortOrder:   "asc",
  stats:       null,
  historyChart: null,
  statusChart:  null,
  loading:     true,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  totalAgents:    $("totalAgents"),
  activeAgents:   $("activeAgents"),
  inactiveAgents: document.querySelector(".card-amber .stat-value"),
  totalFeedback:  $("totalFeedback"),
  avgScore:       $("avgScore"),
  reachableAgents:$("reachableAgents"),
  activeBar:      $("activeBar"),
  networkName:    $("networkName"),
  lastSync:       $("lastSync"),
  tableBody:      $("agentsTableBody"),
  pagination:     $("pagination"),
  leaderboard:    $("leaderboard"),
  refreshBtn:     $("refreshBtn"),
  agentSearch:    $("agentSearch"),
  donutCenter:    $("donutCenter"),
  toast:          $("toast"),
  modalOverlay:   $("modalOverlay"),
  modalClose:     $("modalClose"),
  modalContent:   $("modalContent"),
};

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg, dur = 3000) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), dur);
}

// ─── Number animation ─────────────────────────────────────────────────────────

function animateNumber(el, to, prefix = "", suffix = "") {
  const from = parseInt(el.dataset.val ?? "0", 10);
  if (from === to) return;
  el.dataset.val = to;
  const dur = 600, steps = 20;
  let i = 0;
  const step = () => {
    i++;
    const v = Math.round(from + (to - from) * i / steps);
    el.textContent = prefix + v.toLocaleString() + suffix;
    if (i < steps) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtTime(ts) {
  if (!ts) return "—";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr;
  return addr.slice(0, 8) + "…" + addr.slice(-6);
}

function scoreClass(n) {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "neu";
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function fetchStats() {
  const r = await fetch("/api/stats");
  return r.json();
}

async function fetchAgents({ page, limit, filter, search, sort, order }) {
  const params = new URLSearchParams({ page, limit, sort, order });
  if (filter === "active")   params.set("active", "true");
  if (filter === "inactive") params.set("active", "false");
  const r = await fetch(`/api/agents?${params}`);
  return r.json();
}

async function fetchLeaderboard() {
  const r = await fetch("/api/leaderboard");
  return r.json();
}

async function fetchAgent(id) {
  const r = await fetch(`/api/agents/${id}`);
  return r.json();
}

async function fetchHistory() {
  const r = await fetch("/api/history");
  return r.json();
}

// ─── Stats panel ──────────────────────────────────────────────────────────────

function renderStats(s) {
  animateNumber(els.totalAgents, s.totalAgents);
  animateNumber(els.activeAgents, s.activeAgents);
  animateNumber(els.totalFeedback, s.totalFeedback);
  animateNumber(els.reachableAgents, s.reachableAgents);

  const scoreEl = els.avgScore;
  const score = s.avgScore ?? 0;
  scoreEl.textContent = (score >= 0 ? "+" : "") + score.toFixed(1);
  scoreEl.style.color = score > 0 ? "var(--green)" : score < 0 ? "var(--rose)" : "var(--text-primary)";

  // Progress bar: active / total
  const pct = s.totalAgents > 0 ? (s.activeAgents / s.totalAgents) * 100 : 0;
  els.activeBar.style.width = pct + "%";

  // Last sync
  els.lastSync.textContent = fmtTime(s.lastSync);

  // Network
  els.networkName.textContent = s.network ?? "testnet";
}

// ─── History chart ────────────────────────────────────────────────────────────

function renderHistoryChart(history) {
  const ctx = document.getElementById("historyChart").getContext("2d");

  const labels  = history.map((h) => new Date(h.ts).toLocaleTimeString());
  const totals  = history.map((h) => h.total);
  const actives = history.map((h) => h.active);

  if (state.historyChart) {
    state.historyChart.data.labels         = labels;
    state.historyChart.data.datasets[0].data = totals;
    state.historyChart.data.datasets[1].data = actives;
    state.historyChart.update("none");
    return;
  }

  state.historyChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Total",
          data: totals,
          borderColor: "#6366f1",
          backgroundColor: "rgba(99,102,241,.1)",
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: "#6366f1",
          fill: true,
          tension: 0.4,
        },
        {
          label: "Active",
          data: actives,
          borderColor: "#10b981",
          backgroundColor: "rgba(16,185,129,.08)",
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: "#10b981",
          fill: true,
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: { color: "#8892a4", boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: "#0d1424",
          borderColor: "rgba(99,102,241,.3)",
          borderWidth: 1,
          titleColor: "#e2e8f0",
          bodyColor: "#8892a4",
        },
      },
      scales: {
        x: {
          ticks: { color: "#4b5563", font: { size: 10 }, maxTicksLimit: 8 },
          grid:  { color: "rgba(255,255,255,.04)" },
        },
        y: {
          ticks: { color: "#4b5563", font: { size: 10 } },
          grid:  { color: "rgba(255,255,255,.04)" },
          beginAtZero: true,
        },
      },
    },
  });
}

// ─── Status donut ─────────────────────────────────────────────────────────────

function renderStatusChart(active, inactive) {
  const ctx = document.getElementById("statusChart").getContext("2d");
  const total = active + inactive;

  els.donutCenter.textContent = total;

  if (state.statusChart) {
    state.statusChart.data.datasets[0].data = [active, inactive || (total === 0 ? 1 : 0)];
    state.statusChart.update("none");
    return;
  }

  state.statusChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Active", "Inactive"],
      datasets: [{
        data: [active, inactive || 1],
        backgroundColor: ["rgba(16,185,129,.8)", "rgba(244,63,94,.6)"],
        borderColor:     ["#10b981", "#f43f5e"],
        borderWidth: 1,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: "72%",
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: "#8892a4", boxWidth: 10, font: { size: 11 }, padding: 12 },
        },
        tooltip: {
          backgroundColor: "#0d1424",
          borderColor: "rgba(99,102,241,.3)",
          borderWidth: 1,
          titleColor: "#e2e8f0",
          bodyColor: "#8892a4",
        },
      },
    },
  });
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

function renderLeaderboard(items) {
  if (!items.length) {
    els.leaderboard.innerHTML = '<div class="loading-row">No agents yet.</div>';
    return;
  }

  const maxScore = Math.max(...items.map((i) => Math.abs(i.netScore)), 1);

  els.leaderboard.innerHTML = items.map((item, idx) => {
    const rankClass = idx === 0 ? "gold" : idx === 1 ? "silver" : idx === 2 ? "bronze" : "";
    const sc = item.netScore;
    const scClass = scoreClass(sc);
    const barPct = Math.round((Math.abs(sc) / maxScore) * 100);
    const barColor = sc >= 0 ? "var(--green)" : "var(--rose)";
    const displayUri = item.agentUri?.replace(/^https?:\/\//, "") ?? "—";

    return `
      <div class="lb-item" data-id="${item.agentId}">
        <div class="lb-rank ${rankClass}">${idx + 1}</div>
        <div class="lb-info">
          <div class="lb-uri" title="${item.agentUri}">${displayUri}</div>
          <div class="lb-id">Agent #${item.agentId}</div>
        </div>
        <div class="lb-bar-wrap">
          <div class="lb-bar"><div class="lb-bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
        </div>
        <div class="lb-score ${scClass}">${sc >= 0 ? "+" : ""}${sc}</div>
      </div>`;
  }).join("");

  // Click → open modal
  els.leaderboard.querySelectorAll(".lb-item").forEach((el) => {
    el.addEventListener("click", () => openModal(parseInt(el.dataset.id, 10)));
  });
}

// ─── Agents table ─────────────────────────────────────────────────────────────

function renderTable(data, total, page, limit) {
  if (!data.length) {
    els.tableBody.innerHTML = '<tr><td colspan="6" class="loading-cell">No agents found.</td></tr>';
    renderPagination(0, 1, limit);
    return;
  }

  els.tableBody.innerHTML = data.map((a) => {
    const rep    = a.reputation;
    const health = a.health;
    const score  = rep?.netScore ?? 0;
    const scCls  = scoreClass(score);

    const healthIcon  = health == null ? "unk" : health.reachable ? "up" : "down";
    const healthLabel = health == null ? "—" : health.reachable ? "Online" : "Offline";

    const displayUri = a.agentUri ?? "—";
    const shortUri   = displayUri.replace(/^https?:\/\//, "");

    return `
      <tr data-id="${a.agentId}">
        <td><span class="agent-id">#${a.agentId}</span></td>
        <td>
          <span class="status-pill ${a.active ? "status-active" : "status-inactive"}">
            <span class="status-dot ${a.active ? "active-dot" : "inactive-dot"}"></span>
            ${a.active ? "Active" : "Inactive"}
          </span>
        </td>
        <td class="uri-cell" title="${displayUri}">
          <a class="uri-link" href="${displayUri}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${shortUri}</a>
        </td>
        <td><span class="score-badge score-${scCls}">${score >= 0 ? "+" : ""}${score}</span></td>
        <td>
          <div class="health-cell">
            <span class="health-icon health-${healthIcon}"></span>
            <span class="health-label">${healthLabel}</span>
          </div>
        </td>
        <td class="date-cell">${fmtDate(a.createdAt)}</td>
      </tr>`;
  }).join("");

  // Row click → modal
  els.tableBody.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", () => openModal(parseInt(row.dataset.id, 10)));
  });

  renderPagination(total, page, limit);
}

// ─── Pagination ───────────────────────────────────────────────────────────────

function renderPagination(total, page, limit) {
  const pages = Math.ceil(total / limit);
  if (pages <= 1) { els.pagination.innerHTML = ""; return; }

  let html = "";

  // Prev
  html += `<button class="page-btn" ${page <= 1 ? "disabled" : ""} data-page="${page - 1}">‹</button>`;

  // Page numbers
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) {
    html += `<button class="page-btn ${p === page ? "active" : ""}" data-page="${p}">${p}</button>`;
  }

  // Next
  html += `<button class="page-btn" ${page >= pages ? "disabled" : ""} data-page="${page + 1}">›</button>`;

  els.pagination.innerHTML = html;
  els.pagination.querySelectorAll(".page-btn:not(:disabled)").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.page = parseInt(btn.dataset.page, 10);
      loadAgents();
    });
  });
}

// ─── Agent modal ──────────────────────────────────────────────────────────────

async function openModal(agentId) {
  els.modalContent.innerHTML = `<div class="loading-cell" style="padding:40px;text-align:center">Loading…</div>`;
  els.modalOverlay.classList.add("open");
  document.body.style.overflow = "hidden";

  try {
    const a = await fetchAgent(agentId);
    const rep    = a.reputation;
    const health = a.health;
    const score  = rep?.netScore ?? 0;
    const pos    = rep?.positiveSum ?? 0;
    const neg    = rep?.negativeSum ?? 0;
    const maxBar = Math.max(pos, neg, 1);

    els.modalContent.innerHTML = `
      <div class="modal-agent-header">
        <div class="modal-avatar">#${a.agentId}</div>
        <div>
          <div class="modal-agent-id">Agent ${a.agentId}</div>
          <div class="modal-global-id">${a.globalId}</div>
        </div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">Identity</div>
        <div class="modal-kv">
          <div class="modal-row">
            <div class="modal-key">Status</div>
            <div class="modal-val">
              <span class="status-pill ${a.active ? "status-active" : "status-inactive"}">
                <span class="status-dot ${a.active ? "active-dot" : "inactive-dot"}"></span>
                ${a.active ? "Active" : "Inactive"}
              </span>
            </div>
          </div>
          <div class="modal-row">
            <div class="modal-key">Agent URI</div>
            <div class="modal-val"><a href="${a.agentUri}" target="_blank" rel="noopener" style="color:var(--cyan)">${a.agentUri}</a></div>
          </div>
          <div class="modal-row">
            <div class="modal-key">Owner</div>
            <div class="modal-val">${a.owner}</div>
          </div>
          <div class="modal-row">
            <div class="modal-key">Created</div>
            <div class="modal-val">${new Date(a.createdAt).toUTCString()}</div>
          </div>
          <div class="modal-row">
            <div class="modal-key">Updated</div>
            <div class="modal-val">${new Date(a.updatedAt).toUTCString()}</div>
          </div>
        </div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">Reputation</div>
        <div class="modal-rep-bars">
          <div class="rep-bar-row">
            <div class="rep-bar-label">Net score</div>
            <div style="font-family:var(--font-mono);font-weight:700;color:${score >= 0 ? 'var(--green)' : 'var(--rose)'}">
              ${score >= 0 ? "+" : ""}${score}
            </div>
          </div>
          <div class="rep-bar-row">
            <div class="rep-bar-label">Positive</div>
            <div class="rep-bar-track"><div class="rep-bar-pos" style="width:${(pos/maxBar*100).toFixed(1)}%"></div></div>
            <div class="rep-bar-val" style="color:var(--green)">+${pos}</div>
          </div>
          <div class="rep-bar-row">
            <div class="rep-bar-label">Negative</div>
            <div class="rep-bar-track"><div class="rep-bar-neg" style="width:${(neg/maxBar*100).toFixed(1)}%"></div></div>
            <div class="rep-bar-val" style="color:var(--rose)">-${neg}</div>
          </div>
          <div class="rep-bar-row">
            <div class="rep-bar-label">Feedback</div>
            <div style="font-family:var(--font-mono);color:var(--text-secondary)">${rep?.count ?? 0} records</div>
          </div>
        </div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">Health Check</div>
        <div class="modal-kv">
          <div class="modal-row">
            <div class="modal-key">Reachable</div>
            <div class="modal-val">
              <div class="health-cell">
                <span class="health-icon ${health?.reachable ? 'health-up' : health ? 'health-down' : 'health-unk'}"></span>
                <span>${health?.reachable ? "Online" : health ? `Offline (${health.reason})` : "Unknown"}</span>
              </div>
            </div>
          </div>
          ${health?.checkedAt ? `
          <div class="modal-row">
            <div class="modal-key">Checked</div>
            <div class="modal-val">${fmtTime(health.checkedAt)}</div>
          </div>` : ""}
        </div>
      </div>

      <div style="margin-top:16px;text-align:center">
        <a href="https://suiscan.xyz/testnet/object/${a.owner}" target="_blank" rel="noopener"
           style="font-size:.75rem;color:var(--indigo);text-decoration:none">
          View on Suiscan ↗
        </a>
      </div>
    `;
  } catch (e) {
    els.modalContent.innerHTML = `<div class="loading-cell" style="color:var(--rose)">Error: ${e.message}</div>`;
  }
}

function closeModal() {
  els.modalOverlay.classList.remove("open");
  document.body.style.overflow = "";
}

// ─── Data loaders ─────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const stats = await fetchStats();
    state.stats = stats;
    renderStats(stats);
    renderStatusChart(stats.activeAgents, stats.inactiveAgents);
    if (stats.syncError) showToast("⚠ Sync error: " + stats.syncError, 5000);
  } catch (e) {
    console.error("Stats error:", e);
  }
}

async function loadAgents() {
  try {
    const result = await fetchAgents({
      page:   state.page,
      limit:  state.limit,
      filter: state.filter,
      search: state.search,
      sort:   state.sortCol,
      order:  state.sortOrder,
    });

    // Client-side search filter
    let data = result.data ?? [];
    if (state.search) {
      const q = state.search.toLowerCase();
      data = data.filter(
        (a) =>
          String(a.agentId).includes(q) ||
          (a.agentUri ?? "").toLowerCase().includes(q) ||
          (a.owner ?? "").toLowerCase().includes(q)
      );
    }

    renderTable(data, result.total, result.page, result.limit);
  } catch (e) {
    console.error("Agents error:", e);
    els.tableBody.innerHTML = `<tr><td colspan="6" class="loading-cell" style="color:var(--rose)">Failed to load agents</td></tr>`;
  }
}

async function loadLeaderboard() {
  try {
    const items = await fetchLeaderboard();
    renderLeaderboard(items);
  } catch (e) {
    console.error("Leaderboard error:", e);
  }
}

async function loadHistory() {
  try {
    const history = await fetchHistory();
    // Ensure at least one data point
    if (history.length === 0 && state.stats) {
      history.push({ ts: Date.now(), total: state.stats.totalAgents, active: state.stats.activeAgents });
    }
    renderHistoryChart(history);
  } catch (e) {
    console.error("History error:", e);
  }
}

// ─── Full refresh ─────────────────────────────────────────────────────────────

async function refresh(showSpinner = true) {
  if (showSpinner) {
    els.refreshBtn.classList.add("spinning");
  }
  await Promise.all([loadStats(), loadAgents(), loadLeaderboard(), loadHistory()]);
  if (showSpinner) {
    setTimeout(() => els.refreshBtn.classList.remove("spinning"), 400);
  }
}

// ─── Auto-refresh engine ──────────────────────────────────────────────────────

const INTERVALS = {
  5000:   "5s",
  60000:  "1m",
  600000: "10m",
  0:      "Off",
};

const autoRefresh = {
  intervalMs:  60_000,   // default: 1 minute
  timer:       null,
  countdownTimer: null,
  nextAt:      0,        // epoch ms when next refresh fires
  paused:      false,
};

// Wire interval selector buttons
document.querySelectorAll(".interval-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".interval-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    setAutoRefreshInterval(parseInt(btn.dataset.ms, 10));
  });
});

function setAutoRefreshInterval(ms) {
  autoRefresh.intervalMs = ms;
  clearInterval(autoRefresh.timer);
  clearInterval(autoRefresh.countdownTimer);
  autoRefresh.timer = null;

  if (ms === 0) {
    // Off
    updateCountdownDisplay(0, 0);
    return;
  }

  autoRefresh.nextAt = Date.now() + ms;

  autoRefresh.timer = setInterval(() => {
    autoRefresh.nextAt = Date.now() + ms;
    refresh(false);
  }, ms);

  // Tick every second to update countdown ring + value
  autoRefresh.countdownTimer = setInterval(tickCountdown, 1_000);
  tickCountdown();
}

function tickCountdown() {
  const remaining = Math.max(0, autoRefresh.nextAt - Date.now());
  const total     = autoRefresh.intervalMs;
  updateCountdownDisplay(remaining, total);
}

function updateCountdownDisplay(remaining, total) {
  const arc = document.getElementById("countdownArc");
  const val = document.getElementById("countdownVal");
  const wrap = document.getElementById("countdownWrap");

  if (!arc || !val) return;

  if (total === 0 || autoRefresh.intervalMs === 0) {
    arc.setAttribute("stroke-dasharray", "0 100");
    val.textContent = "—";
    wrap.classList.add("off");
    return;
  }

  wrap.classList.remove("off");
  const pct = (remaining / total) * 100;
  arc.setAttribute("stroke-dasharray", `${pct.toFixed(1)} 100`);

  // Display value
  const secs = Math.ceil(remaining / 1000);
  if (secs >= 60) {
    val.textContent = Math.ceil(secs / 60) + "m";
  } else {
    val.textContent = secs + "s";
  }

  // Color shift: green → amber → rose as time runs out
  if (pct > 50)      arc.style.stroke = "var(--green)";
  else if (pct > 20) arc.style.stroke = "var(--amber)";
  else               arc.style.stroke = "var(--rose)";
}

// Reset countdown on manual refresh
const _origRefresh = refresh;
async function refreshAndResetCountdown(showSpinner = true) {
  await _origRefresh(showSpinner);
  if (autoRefresh.intervalMs > 0) {
    autoRefresh.nextAt = Date.now() + autoRefresh.intervalMs;
    tickCountdown();
  }
}

// ─── SSE: real-time sync notifications ────────────────────────────────────────
// Gracefully degrades on Vercel (serverless): the /api/events stub closes
// immediately with {serverless:true}, so we stop reconnecting and let the
// interval-polling engine (5s/1m/10m) handle all updates.

function connectSSE() {
  let consecutiveFastFails = 0;

  function attempt() {
    const started = Date.now();
    const es = new EventSource("/api/events");

    es.addEventListener("connected", (e) => {
      try {
        const data = JSON.parse(e.data ?? "{}");
        if (data.serverless) {
          es.close(); // serverless stub — rely on polling only
        }
      } catch (_) {}
    });

    es.addEventListener("sync", (e) => {
      try {
        const data = JSON.parse(e.data ?? "{}");
        if (data.lastSync) {
          if (state.stats) state.stats.lastSync = data.lastSync;
          els.lastSync.textContent = fmtTime(data.lastSync);
        }
        refresh(false);
        showToast("Chain synced — data updated");
        if (autoRefresh.intervalMs > 0) {
          autoRefresh.nextAt = Date.now() + autoRefresh.intervalMs;
          tickCountdown();
        }
      } catch (_) {}
    });

    es.onerror = () => {
      es.close();
      const elapsed = Date.now() - started;
      // If we're failing immediately (< 500 ms) 3+ times, stop — it's serverless
      if (elapsed < 500 && ++consecutiveFastFails >= 3) return;
      if (elapsed >= 500) consecutiveFastFails = 0;
      setTimeout(attempt, 5000);
    };
  }

  attempt();
}

// ─── Sort column ─────────────────────────────────────────────────────────────

document.querySelectorAll(".sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (state.sortCol === col) {
      state.sortOrder = state.sortOrder === "asc" ? "desc" : "asc";
    } else {
      state.sortCol   = col;
      state.sortOrder = "asc";
    }
    document.querySelectorAll(".sortable").forEach((t) => t.classList.remove("sorted"));
    th.classList.add("sorted");
    th.querySelector(".sort-icon").textContent = state.sortOrder === "asc" ? "↑" : "↓";
    state.page = 1;
    loadAgents();
  });
});

// ─── Filter buttons ───────────────────────────────────────────────────────────

document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.filter = btn.dataset.filter;
    state.page   = 1;
    loadAgents();
  });
});

// ─── Search ───────────────────────────────────────────────────────────────────

let searchTimer;
els.agentSearch.addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim();
    state.page   = 1;
    loadAgents();
  }, 280);
});

// ─── Refresh button ───────────────────────────────────────────────────────────

els.refreshBtn.addEventListener("click", () => refreshAndResetCountdown(true));

// ─── Modal ────────────────────────────────────────────────────────────────────

els.modalClose.addEventListener("click", closeModal);
els.modalOverlay.addEventListener("click", (e) => {
  if (e.target === els.modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

refresh(true).then(() => {
  // Start default interval (1m) after first load
  setAutoRefreshInterval(autoRefresh.intervalMs);
  connectSSE();
});
