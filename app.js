const state = {
  data: null,
  activeView: "overview",
  projectFilter: "all",
  refreshing: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
};

const HEALTH_DATA_KEY = "privateSecretary.health.v1";
const HEALTH_REMINDER_LAST_KEY = "privateSecretary.lastHealthReminder";
const HEALTH_WEEKLY_LAST_KEY = "privateSecretary.lastHealthWeeklyReminder";

const HEALTH_MEAL_PLANS = [
  {
    breakfast: "燕麦片 + 无糖牛奶或豆浆 + 鸡蛋 + 一份水果",
    lunch: "半盘蔬菜 + 四分之一鱼、鸡胸或豆腐 + 四分之一杂粮饭",
    dinner: "清炒或蒸煮蔬菜 + 鱼虾、豆腐或瘦肉 + 小份主食",
    snack: "水果或无糖酸奶",
  },
  {
    breakfast: "全麦面包 + 鸡蛋 + 原味酸奶 + 小番茄",
    lunch: "深色蔬菜 + 菌菇 + 牛肉或豆制品 + 糙米或杂粮饭",
    dinner: "蔬菜汤 + 清蒸鱼或鸡胸 + 少量薯类",
    snack: "一份时令水果",
  },
  {
    breakfast: "杂粮粥 + 豆腐或鸡蛋 + 凉拌蔬菜",
    lunch: "两份蔬菜 + 一份优质蛋白 + 一份全谷物主食",
    dinner: "豆腐菌菇蔬菜锅 + 少量瘦肉或虾 + 小份主食",
    snack: "无糖酸奶或少量原味坚果；过敏者替换",
  },
];

const PERSONAL_HEALTH_PROFILE = {
  reportDate: "2025年12月",
  status: "可逆的代谢风险管理期",
  summary:
    "BMI约22.9，体重正常；腰围约100cm提示腹部脂肪偏多。2025年GGT、总胆固醇、ApoB和血钙偏高，肌酐与尿检需复查。甲状腺结节、右肾小囊肿和肺部微小结节总体稳定，但不能停止随访。",
  goals: [
    ["腰围目标", "低于90cm"],
    ["生活方式", "不吸烟、不饮酒"],
    ["运动目标", "每周150—250分钟"],
    ["睡眠目标", "每晚7—8.5小时"],
    ["近期重点", "复查代谢与影像"],
  ],
};

const PERSONAL_HEALTH_TASKS = [
  {
    id: "chest-ct",
    priority: "优先",
    title: "完成肺结节随访",
    detail:
      "2025年12月报告建议4—6个月复查，现已到期。若2026年尚未复查，尽快带历次原始CT咨询胸外科或呼吸科。",
  },
  {
    id: "metabolic-lab",
    priority: "近期",
    title: "复查代谢、肝肾功能与血钙",
    detail:
      "GGT、血脂+ApoB、肌酐、eGFR、尿常规、尿白蛋白/肌酐比值、血钙、白蛋白、PTH、维生素D和血糖。",
  },
  {
    id: "hepatitis-b",
    priority: "预防",
    title: "接种乙肝疫苗",
    detail:
      "乙肝五项全阴、表面抗体仅0.5 mIU/mL，没有保护力。完成全程接种后复查表面抗体。",
  },
  {
    id: "thyroid-kidney",
    priority: "2026年底前",
    title: "复查甲状腺和双肾超声",
    detail:
      "甲状腺右叶结节约5.3×3.1mm，右肾囊肿约12×11mm。2026年底前完成年度复查。",
  },
];

const cityOrder = ["石家庄", "保定", "邯郸", "沧州", "廊坊", "衡水", "唐山", "雄安"];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatAmount(yuan) {
  if (!Number.isFinite(yuan) || yuan <= 0) return "未披露";
  if (yuan >= 100_000_000) return `${(yuan / 100_000_000).toFixed(2)} 亿元`;
  if (yuan >= 10_000) return `${(yuan / 10_000).toFixed(1)} 万元`;
  return `${yuan.toFixed(0)} 元`;
}

function formatNumber(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)
    : "--";
}

function formatTurnover(value) {
  if (!Number.isFinite(value) || value <= 0) return "--";
  if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(2)} 万亿元`;
  return `${(value / 100_000_000).toFixed(0)} 亿元`;
}

function formatDate(value) {
  if (!value) return "--";
  const [year, month, day] = value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function dirClass(value) {
  if (!Number.isFinite(value) || value === 0) return "";
  return value > 0 ? "positive" : "negative";
}

function pctText(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

async function requestJson(url, options = {}) {
  const { timeoutMs = 10_000, ...fetchOptions } = options;
  const response = await fetch(url, {
    cache: "no-store",
    ...fetchOptions,
    headers: {
      ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
      ...(fetchOptions.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  }
  return payload;
}

async function fetchStaticSummary() {
  try {
    const response = await fetch(`data/latest.json?t=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (window.PRIVATE_SECRETARY_FALLBACK) {
      return structuredClone(window.PRIVATE_SECRETARY_FALLBACK);
    }
    throw error;
  }
}

function friendlyError(error) {
  const message = String(error?.message || error || "");
  if (/Failed to fetch|Load failed|NetworkError|Network request failed/i.test(message)) {
    return "网络连接暂时中断";
  }
  if (/timeout|timed out|超时/i.test(message)) return "服务器响应超时";
  if (/HTTP 502|HTTP 503|HTTP 504/i.test(message)) return "数据服务暂不可用";
  return message.replace(/^HTTP \d+:\s*/i, "") || "暂时无法获取最新数据";
}

function tenderAgeDays(publicationDate, referenceDate) {
  const published = /^(\d{4})-(\d{2})-(\d{2})$/.exec(publicationDate || "");
  const reference = /^(\d{4})-(\d{2})-(\d{2})$/.exec(referenceDate || "");
  if (!published || !reference) return 0;
  const publishedUtc = Date.UTC(
    Number(published[1]),
    Number(published[2]) - 1,
    Number(published[3]),
  );
  const referenceUtc = Date.UTC(
    Number(reference[1]),
    Number(reference[2]) - 1,
    Number(reference[3]),
  );
  return Math.floor((referenceUtc - publishedUtc) / 86_400_000);
}

function isEligibleTender(
  record,
  lookbackDays,
  referenceDate,
  projectStartDate = "2026-07-01",
) {
  const title = String(record?.title || "");
  const age = tenderAgeDays(record?.publicationDate, referenceDate);
  const reference = new Date(`${referenceDate}T00:00:00Z`);
  reference.setUTCDate(reference.getUTCDate() - lookbackDays);
  const cutoff = [
    projectStartDate || "2026-07-01",
    reference.toISOString().slice(0, 10),
  ]
    .sort()
    .at(-1);
  const withinWindow =
    record?.publicationDate >= cutoff && record?.publicationDate <= referenceDate;
  if (record?.recordType === "approval") {
    return (
      Array.isArray(record.industries) &&
      record.industries.length > 0 &&
      Boolean(record.city) &&
      withinWindow &&
      age >= 0 &&
      age < lookbackDays
    );
  }
  const isDesign = /设计/.test(title);
  const excluded =
    /(施工招标|土建|施工总承包|工程总承包|EPC|设计施工总承包|采购施工|监理招标|监理服务|设备采购|设备招标|采购设备|物资采购|物资招标|采购物资|材料采购|材料招标|采购材料|货物采购|设备及材料|设计.{0,24}(?:安装|采购).{0,24}设备|(?:设备|系统|软件|材料|物资|货物).{0,30}(?:设计|采购|安装)|采购及安装|设备安装|机电安装|安装工程|中标候选人|中标结果|结果公告|成交公告|终止公告|废标公告|流标公告)/i.test(
      title,
    );
  return (
    isDesign &&
    !excluded &&
    withinWindow &&
    age >= 0 &&
    age < lookbackDays
  );
}

function enforceTenderRules(data) {
  if (!data?.tenders) return data;
  const lookbackDays = Number(data.lookbackDays || data.tenders.lookbackDays || 7);
  const referenceDate = data.dateLabel || new Date().toISOString().slice(0, 10);
  const projectStartDate = data.projectStartDate || "2026-07-01";
  const existingGroups = new Map(
    (data.tenders.cityGroups || []).map((group) => [group.city, group]),
  );
  const cityGroups = cityOrder.map((city) => {
    const group = existingGroups.get(city) || {};
    const qualified = (group.qualified || []).filter((record) =>
      isEligibleTender(record, lookbackDays, referenceDate, projectStartDate),
    );
    const pending = (group.pending || []).filter((record) =>
      isEligibleTender(record, lookbackDays, referenceDate, projectStartDate),
    );
    return { city, qualified, pending, total: qualified.length + pending.length };
  });
  const qualified = cityGroups.flatMap((group) => group.qualified);
  const pending = cityGroups.flatMap((group) => group.pending);
  const configuredIndustries = Array.isArray(data.industries) ? data.industries : [];
  const standardIndustries = [
    "公路",
    "铁路",
    "市政",
    "房建",
    "水利",
    "电力",
    "矿山",
  ];
  const industries = configuredIndustries.length
    ? standardIndustries.filter(
        (name) => name === "铁路" || configuredIndustries.includes(name),
      )
    : standardIndustries;
  const modules = (data.modules || []).map((module) =>
    module.id === "projects"
      ? {
          ...module,
          heading: "河北工程设计与新立项",
          description: "跟踪发改委新立项与设计招标项目，排除施工及采购安装公告。",
        }
      : module,
  );
  return {
    ...data,
    modules,
    industries,
    lookbackDays,
    tenders: {
      ...data.tenders,
      lookbackDays,
      recent: qualified.length + pending.length,
      qualifiedCount: qualified.length,
      pendingCount: pending.length,
      cityGroups,
      qualified,
      pending,
    },
  };
}

function setStatus(text, kind = "loading") {
  $("#statusText").textContent = text;
  $("#statusDot").className = `status-dot ${
    kind === "ready" ? "is-ready" : kind === "error" ? "is-error" : ""
  }`;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectAttempts += 1;
  const delay = Math.min(30_000, 3_000 * state.reconnectAttempts);
  setStatus("网络不稳定，正在自动重连", "loading");
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    loadData({ silent: true });
  }, delay);
}

function switchView(view, updateHash = true) {
  state.activeView = view;
  $$(".nav-item").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  $$("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  if (updateHash) {
    history.replaceState(null, "", `#${view}`);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function allProjectRecords() {
  const groups = state.data?.tenders?.cityGroups || [];
  return groups.flatMap((group) =>
    [...group.qualified, ...group.pending].map((record) => ({
      ...record,
      city: group.city,
    })),
  );
}

function qualifiedOnly() {
  return state.data?.tenders?.qualified || [];
}

function pendingOnly() {
  return state.data?.tenders?.pending || [];
}

function marketTone() {
  const recap = state.data?.market?.recap || "";
  return (
    ["整体偏强", "整体偏弱", "指数与个股分化", "指数承压、个股活跃", "震荡分化"].find(
      (item) => recap.includes(item),
    ) || "等待数据"
  );
}

function renderSecretaryModules(data) {
  const modules =
    data.modules?.length > 0
      ? data.modules
      : [
          {
            id: "projects",
            title: "工程情报官",
            heading: "跟踪河北八市重点工程机会",
            description: "按城市顺序查看项目、资金、进展和招标计划。",
            view: "projects",
            enabled: true,
          },
          {
            id: "market",
            title: "市场分析师",
            heading: "用完整维度复盘今日 A 股",
            description: "指数、涨跌停生态、市场风格、资金与行业。",
            view: "market",
            enabled: true,
          },
        ];
  $("#secretaryGateway").innerHTML = modules
    .map(
      (module) => `
      <article class="secretary-module module-${escapeHtml(module.id)}">
        <span class="module-kicker">${escapeHtml(module.title)}</span>
        <h2>${escapeHtml(module.heading)}</h2>
        <p>${escapeHtml(module.description)}</p>
        <div class="module-footer">
          <span>${
            module.id === "projects"
              ? `${data.tenders.qualifiedCount} 条符合 · ${data.tenders.pendingCount} 条待核实`
              : module.id === "market"
                ? marketTone()
                : module.id === "health"
                  ? (() => {
                      const healthData = loadHealthData();
                      const today = localDateAndMinutes().dateKey;
                      const log = ensureHealthLog(healthData, today);
                      const meals = ["breakfast", "lunch", "dinner", "snack"].filter(
                        (meal) => log.meals[meal],
                      ).length;
                      return `${meals} 餐完成 · 饮水 ${log.waterMl || 0} ml`;
                    })()
                  : module.badge || "后续开放"
          }</span>
          <button class="btn module-button" type="button" data-open-window="${escapeHtml(module.view)}" ${module.enabled ? "" : "disabled"}>
            ${
              module.enabled
                ? module.id === "projects"
                  ? "进入工程"
                  : module.id === "health"
                    ? "健康管理"
                    : "进入A股"
                : "规划中"
            }
          </button>
        </div>
      </article>`,
    )
    .join("");
}

function renderOverview() {
  const data = state.data;
  renderSecretaryModules(data);
  $("#overviewDate").textContent = formatDate(data.dateLabel);
  $("#overviewSubtitle").textContent =
    `已检查 ${data.tenders.scanned} 条公告及立项记录，保留2026年7月1日以来的设计招标与新立项项目，信息有效期半年。`;
  $("#qualifiedMetric").textContent = data.tenders.qualifiedCount;
  $("#pendingMetric").textContent = data.tenders.pendingCount;
  $("#cityMetric").textContent = data.cities.length;
  $("#projectNavCount").textContent =
    data.tenders.qualifiedCount + data.tenders.pendingCount;
  $("#nextPushTime").textContent = `A股 ${data.notificationTime}`;
  $("#engineeringPushTime").textContent =
    `工程 每周五 ${data.engineeringReminderTime || "18:00"}`;
  $("#marketToneMetric").textContent = marketTone();
  const breadth = data.market.breadth;
  $("#marketToneDetail").textContent = data.market.unavailable
    ? "行情接口暂不可用"
    : breadth.available === false
      ? "涨跌家数数据待恢复"
      : `${breadth.advancing} 涨 / ${breadth.declining} 跌`;
  $("#lastRefreshTime").textContent = data.generatedAtLocal;
  renderOverviewProjects();
  renderOverviewMarket();
  renderSettings();
}

function renderOverviewProjects() {
  const records = [...qualifiedOnly(), ...pendingOnly()].slice(0, 5);
  const root = $("#overviewProjects");
  if (!records.length) {
    root.innerHTML =
      '<div class="empty-state">2026年7月1日以来暂未发现符合条件的设计招标或立项项目。<br />每周五 18:00 会自动更新。</div>';
    return;
  }
  root.innerHTML = records
    .map(
      (record) => `
      <article class="opportunity-item">
        <span class="city-mark">${escapeHtml(record.city)}</span>
        <div class="opportunity-main">
          <p class="opportunity-title">
            <a href="${escapeHtml(record.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(record.title)}</a>
          </p>
          <div class="opportunity-meta">
            <span>${escapeHtml(record.industries.join(" / "))}</span>
            <span>${escapeHtml(record.recentProgress)}</span>
            <span class="amount">${escapeHtml(record.investmentAmount)}</span>
          </div>
        </div>
        <span class="badge ${record.qualified ? "badge-qualified" : "badge-pending"}">
          ${record.qualified ? "符合条件" : "待核实"}
        </span>
      </article>`,
    )
    .join("");
}

function indexCard(item, detailed = false) {
  return `
    <article class="index-card">
      <div class="index-card-top">
        <span>${escapeHtml(item.name)}</span>
        <span>${escapeHtml(item.code || "")}</span>
      </div>
      <div class="index-price ${dirClass(item.changePct)}">${formatNumber(item.price)}</div>
      <div class="index-change ${dirClass(item.changePct)}">
        ${pctText(item.changePct)}
        ${detailed && Number.isFinite(item.change) ? ` · ${item.change >= 0 ? "+" : ""}${item.change.toFixed(2)}` : ""}
      </div>
    </article>`;
}

function renderOverviewMarket() {
  const market = state.data.market;
  $("#marketIndexGrid").innerHTML = market.indices
    .slice(0, 4)
    .map((item) => indexCard(item))
    .join("");
  const breadth = market.breadth;
  $("#breadthReadout").innerHTML =
    breadth.available === false
      ? "涨跌家数暂不可用"
      : `<span class="positive">${breadth.advancing} 涨</span> · ` +
        `<span class="negative">${breadth.declining} 跌</span>`;
  $("#marketSummaryText").textContent = market.recap;
}

function projectRow(record) {
  const reasons = record.qualificationReasons?.length
    ? `<br /><span class="text-muted">${escapeHtml(record.qualificationReasons.join("；"))}</span>`
    : "";
  return `
    <tr>
      <td class="project-name">
        <a href="${escapeHtml(record.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(displayProjectTitle(record.title))}</a>
        <small class="project-source">来源：${escapeHtml(record.sourceName || "公开渠道")}</small>
        <div>${
          record.qualified
            ? '<span class="badge badge-qualified">符合条件</span>'
            : record.recordType === "approval"
              ? '<span class="badge badge-pending">新立项·待核实</span>'
              : '<span class="badge badge-pending">待核实</span>'
        }</div>
      </td>
      <td>${escapeHtml(record.owner)}</td>
      <td class="overview-cell">${escapeHtml(record.overview || "未披露")}</td>
      <td>${escapeHtml(record.recentProgress)}</td>
      <td class="amount">${escapeHtml(record.investmentAmount)}${reasons}</td>
      <td>${escapeHtml(record.plannedTenderTime)}</td>
      <td><a class="source-link" href="${escapeHtml(record.sourceUrl)}" target="_blank" rel="noreferrer">查看原文 ↗</a></td>
    </tr>`;
}

function displayProjectTitle(title) {
  return String(title || "").replace(/^【[^】]+】\s*/, "");
}

function projectTable(rows) {
  return `<div class="table-scroll">
    <table class="project-table">
      <thead>
        <tr>
          <th>项目名称</th>
          <th>业主单位</th>
          <th>项目概况</th>
          <th>近期进展情况</th>
          <th>投资金额</th>
          <th>计划招标时间</th>
          <th>信息来源链接</th>
        </tr>
      </thead>
      <tbody>${rows.map(projectRow).join("")}</tbody>
    </table>
  </div>`;
}

function renderProjects() {
  const data = state.data;
  const filter = state.projectFilter;
  const groups = data.tenders.cityGroups;
  const visibleCount = groups.reduce((sum, group) => {
    if (filter === "qualified") return sum + group.qualified.length;
    if (filter === "pending") return sum + group.pending.length;
    return sum + group.total;
  }, 0);
  const approvalCount = groups
    .flatMap((group) => [...group.qualified, ...group.pending])
    .filter((record) => record.recordType === "approval").length;
  $("#projectFilterNote").textContent =
    `当前显示 ${visibleCount} 个项目` +
    `${approvalCount ? `（其中 ${approvalCount} 个立项）` : ""}` +
    ` · 2026年7月1日起 · 有效期半年`;
  $("#projectGroups").innerHTML = groups
    .map((group, index) => {
      const rows =
        filter === "qualified"
          ? group.qualified
          : filter === "pending"
            ? group.pending
            : [...group.qualified, ...group.pending];
      const approvalRows = rows.filter(
        (record) => record.recordType === "approval",
      );
      const designRows = rows.filter(
        (record) => record.recordType !== "approval",
      );
      return `
        <section class="city-group">
          <header class="city-group-header">
            <div class="city-group-title">
              <span class="city-order">${String(index + 1).padStart(2, "0")}</span>
              <h2>${escapeHtml(group.city)}</h2>
            </div>
            <span class="city-group-summary">${group.qualified.length} 条符合 · ${group.pending.length} 条待核实</span>
          </header>
          ${
            rows.length
              ? `
                ${
                  approvalRows.length
                    ? `<section class="project-stage">
                        <h3>立项项目 <span>${approvalRows.length}</span></h3>
                        ${projectTable(approvalRows)}
                      </section>`
                    : ""
                }
                ${
                  designRows.length
                    ? `<section class="project-stage">
                        <h3>招标设计项目 <span>${designRows.length}</span></h3>
                        ${projectTable(designRows)}
                      </section>`
                    : ""
                }`
              : '<div class="empty-city">该城市暂无有效期内的立项或设计招标项目。</div>'
          }
        </section>`;
    })
    .join("");
}

function historyChart(history) {
  if (!history.length) return '<div class="empty-state">暂无历史行情数据</div>';
  const width = 760;
  const height = 290;
  const padding = { top: 18, right: 18, bottom: 36, left: 54 };
  const values = history.map((item) => item.close);
  const domainMin = Math.min(...values);
  const domainMax = Math.max(...values);
  const range = domainMax - domainMin || 1;
  const yMin = domainMin - range * 0.12;
  const yMax = domainMax + range * 0.12;
  const x = (index) =>
    padding.left +
    (index / Math.max(history.length - 1, 1)) *
      (width - padding.left - padding.right);
  const y = (value) =>
    padding.top +
    ((yMax - value) / (yMax - yMin)) *
      (height - padding.top - padding.bottom);
  const points = history.map((item, index) => `${x(index)},${y(item.close)}`).join(" ");
  const area = `${padding.left},${height - padding.bottom} ${points} ${x(history.length - 1)},${height - padding.bottom}`;
  const ticks = Array.from({ length: 4 }, (_, index) => {
    const ratio = index / 3;
    const value = yMax - (yMax - yMin) * ratio;
    const yPos = padding.top + (height - padding.top - padding.bottom) * ratio;
    return `
      <line class="chart-grid-line" x1="${padding.left}" x2="${width - padding.right}" y1="${yPos}" y2="${yPos}" />
      <text class="chart-axis-text" x="${padding.left - 9}" y="${yPos + 3}" text-anchor="end">${value.toFixed(0)}</text>`;
  }).join("");
  const xTicks = [0, Math.floor((history.length - 1) / 2), history.length - 1]
    .map((index) => {
      const item = history[index];
      return `<text class="chart-axis-text" x="${x(index)}" y="${height - 9}" text-anchor="${index === 0 ? "start" : index === history.length - 1 ? "end" : "middle"}">${item.date.slice(5)}</text>`;
    })
    .join("");
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="上证指数近30个交易日收盘走势图">
      <title>上证指数近30个交易日收盘走势</title>
      ${ticks}
      <polygon class="chart-area" points="${area}" />
      <polyline class="chart-line" points="${points}" />
      <circle class="chart-dot" cx="${x(history.length - 1)}" cy="${y(history.at(-1).close)}" r="4" />
      ${xTicks}
      <text class="chart-axis-text" x="${x(history.length - 1) - 7}" y="${y(history.at(-1).close) - 10}" text-anchor="end">${history.at(-1).close.toFixed(2)}</text>
    </svg>`;
}

function renderSectors(selector, sectors) {
  $(selector).innerHTML = sectors.length
    ? sectors
        .slice(0, 6)
        .map(
          (item) => `
      <li>
        <span>${escapeHtml(item.name)}</span>
        <span>${pctText(item.changePct)}</span>
      </li>`,
        )
        .join("")
    : '<li><span>暂无可用数据</span><span>--</span></li>';
}

function renderTradingPlan() {
  const plan = state.data.market.tradingPlan;
  if (!plan) {
    $("#tradingPlanVerdict").textContent = "次日剧本暂不可用";
    $("#tradingPlanSummary").textContent =
      "行情接口尚未返回足够的数据，刷新后再生成可执行计划。";
    $("#tradingPlanPosition").textContent = "--";
    $("#tradingPlanRisk").textContent = "风险 --";
    $("#tradingMainlines").innerHTML =
      '<div class="empty-state">主线与龙头梯队暂不可用。</div>';
    $("#tradingEntryConditions").innerHTML = "";
    $("#tradingInvalidConditions").innerHTML = "";
    $("#tradingAvoidSectors").innerHTML = "";
    $("#tradingFramework").innerHTML = "";
    return;
  }

  $("#tradingPlanVerdict").textContent = plan.regime;
  $("#tradingPlanSummary").textContent = plan.summary;
  $("#tradingPlanPosition").textContent = plan.positionGuide;
  $("#tradingPlanRisk").textContent = `风险 ${plan.riskLevel}`;
  $("#tradingMainlines").innerHTML = plan.mainlines?.length
    ? plan.mainlines
        .map(
          (line, index) => `
          <article class="mainline-card">
            <header>
              <span class="mainline-rank">${String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>${escapeHtml(line.name)}</h3>
                <small>${escapeHtml(line.mode)} · ${pctText(line.changePct)}</small>
              </div>
            </header>
            <div class="leader-list">
              ${
                line.leaders?.length
                  ? line.leaders
                      .map(
                        (stock) => `
                    <div class="leader-stock">
                      <div class="leader-stock-head">
                        <span>${escapeHtml(stock.role)}</span>
                        <strong>${escapeHtml(stock.name)}</strong>
                        <small>${escapeHtml(stock.code)} · ${pctText(stock.changePct)}</small>
                      </div>
                      <div class="leader-guidance">
                        <p><b>次日做法</b>${escapeHtml(stock.entry || "等待开盘后量价确认，不追无板块支撑的个股。")}</p>
                        <p class="leader-warning"><b>失效条件</b>${escapeHtml(stock.invalidation || "跌破昨收或板块转弱时取消关注。")}</p>
                      </div>
                    </div>`,
                      )
                      .join("")
                  : '<div class="leader-stock"><div class="leader-stock-head"><span>龙头</span><strong>等待个股数据</strong><small>不追无量脉冲</small></div></div>'
              }
            </div>
          </article>`,
        )
        .join("")
    : '<div class="empty-state">今日暂无可确认的上涨主线，明天以观察和防守为主。</div>';
  $("#tradingEntryConditions").innerHTML = (plan.entryConditions || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  $("#tradingInvalidConditions").innerHTML = (plan.invalidConditions || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  $("#tradingAvoidSectors").innerHTML = [
    ...(plan.avoidSectors || []),
    "无量脉冲与无板块支撑的高位股",
  ]
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  $("#tradingFramework").innerHTML = (plan.framework || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  $("#tradingPlanDisclaimer").textContent = plan.disclaimer;
}

function renderMarketDepth() {
  const market = state.data.market;
  const sentiment = market.sentiment;
  const technical = market.technical;
  const style = market.style;
  const flow = market.mainFlow;

  if (sentiment?.available) {
    $("#limitSummary").textContent =
      `涨停 ${sentiment.limitUp} · 跌停 ${sentiment.limitDown}`;
    $("#limitDetail").textContent =
      `炸板率 ${sentiment.breakRate.toFixed(1)}% · 最高 ${sentiment.highestBoard} 连板 · ` +
      `昨日涨停今日均涨幅 ${sentiment.yesterdayAverage == null ? "--" : pctText(sentiment.yesterdayAverage)}`;
  } else {
    $("#limitSummary").textContent = "涨跌停数据待恢复";
    $("#limitDetail").textContent = "公开接口暂时未返回涨停池、跌停池和炸板池。";
  }

  $("#styleSummary").textContent = style?.label || "风格数据待恢复";
  const large = market.indices.find((item) => item.code === "000300");
  const small = market.indices.find((item) => item.code === "000852");
  const mega = market.indices.find((item) => item.code === "000016");
  $("#styleDetail").textContent =
    `上证50 ${pctText(mega?.changePct)} · 沪深300 ${pctText(large?.changePct)} · ` +
    `中证1000 ${pctText(small?.changePct)}`;

  const shanghai = market.indices.find((item) => item.code === "000001");
  if (technical?.ma20 != null) {
    $("#technicalSummary").textContent =
      `上证 ${technical.aboveMa20 ? "站上" : "跌破"} MA20`;
    $("#technicalDetail").textContent =
      `MA5 ${formatNumber(technical.ma5)} · MA20 ${formatNumber(technical.ma20)} · ` +
      `MA60 ${formatNumber(technical.ma60)}`;
  } else {
    $("#technicalSummary").textContent = "技术数据待恢复";
    $("#technicalDetail").textContent = "均线数据暂不可用。";
  }

  const volumeLabel =
    market.volumeRatio == null
      ? "量能比待统计"
      : `量能为20日均值的 ${market.volumeRatio.toFixed(2)} 倍`;
  $("#flowSummary").textContent = volumeLabel;
  $("#flowDetail").textContent =
    market.mainFlow?.mainNet == null
      ? `成交额 ${formatTurnover(market.turnover)} · 主力资金暂不可用`
      : `成交额 ${formatTurnover(market.turnover)} · 主力净${flow.mainNet >= 0 ? "流入" : "流出"}${(Math.abs(flow.mainNet) / 100_000_000).toFixed(1)}亿元`;

  const missing = [];
  if (market.dataQuality?.breadth === false) missing.push("涨跌家数");
  if (market.dataQuality?.limitPools === false) missing.push("涨跌停池");
  if (market.dataQuality?.sectors === false) missing.push("行业排行");
  if (market.dataQuality?.mainFlow === false) missing.push("主力资金");
  if (market.dataQuality?.news === false) missing.push("消息面");
  const note = $("#marketQualityNote");
  if (missing.length) {
    note.hidden = false;
    note.textContent = `数据源提示：${missing.join("、")}本次未成功返回，已使用指数与历史行情完成其余复盘；稍后刷新会自动补全。`;
  } else if (market.staleFields?.length) {
    note.hidden = false;
    note.textContent = `本次接口受限，${market.staleFields.join("、")}采用当日最近一次成功抓取的数据；核心指数与走势已实时更新。`;
  } else {
    note.hidden = true;
  }
}

function renderMarket() {
  const market = state.data.market;
  $("#marketDate").textContent = formatDate(market.asOfDate);
  $("#marketSubtitle").textContent = market.unavailable
    ? "行情接口暂不可用，稍后点击“立即更新”重试。"
    : "收盘后自动更新指数、涨跌家数和行业表现。";
  $("#marketDetailIndices").innerHTML = market.indices
    .map((item) => indexCard(item, true))
    .join("");
  renderTradingPlan();
  renderMarketDepth();
  $("#historyChart").innerHTML = historyChart(market.history);
  const breadth = market.breadth;
  const total = breadth.advancing + breadth.flat + breadth.declining;
  const upPct = total ? (breadth.advancing / total) * 100 : 0;
  const flatPct = total ? (breadth.flat / total) * 100 : 0;
  const downPct = total ? (breadth.declining / total) * 100 : 0;
  $("#breadthBar").innerHTML =
    breadth.available === false
      ? '<span style="width:100%;background:color-mix(in srgb,var(--muted) 18%,transparent)"></span>'
      : `
        <span class="breadth-up" style="width:${upPct}%"></span>
        <span class="breadth-flat" style="width:${flatPct}%"></span>
        <span class="breadth-down" style="width:${downPct}%"></span>`;
  const breadthRows = [
    ["上涨", breadth.advancing, "var(--red)"],
    ["平盘", breadth.flat, "var(--muted)"],
    ["下跌", breadth.declining, "var(--green)"],
  ];
  $("#breadthLegend").innerHTML =
    breadth.available === false
      ? '<div class="breadth-legend-row"><span>涨跌家数暂不可用</span><strong>--</strong></div>'
      : breadthRows
          .map(
            ([label, count, color]) => `
      <div class="breadth-legend-row">
        <span><i class="legend-dot" style="background:${color}"></i>${label}</span>
        <strong>${count} 只</strong>
      </div>`,
          )
          .join("");
  $("#marketTurnover").textContent = formatTurnover(market.turnover);
  $("#recapCopy").textContent = market.recap;
  $("#watchPoints").innerHTML = (market.watchPoints || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  renderSectors("#leadingSectors", market.topSectors);
  renderSectors("#laggingSectors", market.laggingSectors);
  $("#marketNewsList").innerHTML = market.news?.length
    ? market.news
        .map(
          (item) => `
          <article class="news-item">
            <span class="news-category">${escapeHtml(item.category)}</span>
            <div>
              <a class="news-title" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>
              <div class="news-time">${escapeHtml(item.time)}</div>
            </div>
          </article>`,
        )
        .join("")
    : '<div class="empty-state">消息面数据暂不可用。</div>';
}

function defaultHealthData() {
  return {
    profile: {
      foodNotes: "",
    },
    settings: {
      reminderEnabled: true,
      breakfastTime: "08:00",
      lunchTime: "12:00",
      dinnerTime: "18:30",
      windDownTime: "22:00",
      sleepTime: "22:30",
      wakeTime: "07:00",
      waterGoalMl: 1600,
      weeklyEnabled: true,
      weeklyDay: 0,
      weeklyTime: "20:00",
    },
    checkup: {
      date: "",
      followup: "",
      summary: "",
    },
    personalTasks: {},
    logs: {},
  };
}

function loadHealthData() {
  const defaults = defaultHealthData();
  try {
    const saved = JSON.parse(localStorage.getItem(HEALTH_DATA_KEY) || "{}");
    return {
      ...defaults,
      ...saved,
      profile: { ...defaults.profile, ...(saved.profile || {}) },
      settings: { ...defaults.settings, ...(saved.settings || {}) },
      checkup: { ...defaults.checkup, ...(saved.checkup || {}) },
      personalTasks: saved.personalTasks || {},
      logs: saved.logs || {},
    };
  } catch {
    return defaults;
  }
}

function saveHealthData(data) {
  localStorage.setItem(HEALTH_DATA_KEY, JSON.stringify(data));
}

function ensureHealthLog(data, dateKey) {
  data.logs[dateKey] ||= {
    meals: {},
    waterMl: 0,
    sleepHours: null,
    sleepQuality: "",
    exerciseMinutes: 0,
    strength: false,
    weightKg: null,
    waistCm: null,
    energy: 3,
    stress: 3,
    note: "",
  };
  data.logs[dateKey].meals ||= {};
  return data.logs[dateKey];
}

function healthMealPlan(dateKey) {
  const sum = [...dateKey].reduce((total, char) => total + char.charCodeAt(0), 0);
  return HEALTH_MEAL_PLANS[sum % HEALTH_MEAL_PLANS.length];
}

function healthTimeToMinutes(value) {
  const [hour, minute] = String(value || "00:00").split(":").map(Number);
  return hour * 60 + minute;
}

function healthDurationText(sleepTime, wakeTime) {
  let sleep = healthTimeToMinutes(sleepTime);
  let wake = healthTimeToMinutes(wakeTime);
  if (wake <= sleep) wake += 24 * 60;
  const hours = Math.max(0, (wake - sleep) / 60);
  return `${hours.toFixed(1)} 小时`;
}

function recentHealthMinutes(data, field) {
  let total = 0;
  const today = new Date();
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const key = localDateAndMinutes(day).dateKey;
    total += Number(data.logs[key]?.[field] || 0);
  }
  return total;
}

function recentHealthDates(days = 7) {
  const today = new Date();
  return Array.from({ length: days }, (_, offset) => {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    return localDateAndMinutes(day).dateKey;
  }).reverse();
}

function buildWeeklyHealthSummary(data) {
  const logs = recentHealthDates()
    .map((dateKey) => data.logs[dateKey])
    .filter(Boolean);
  const mealCount = logs.reduce(
    (sum, log) =>
      sum +
      ["breakfast", "lunch", "dinner", "snack"].filter(
        (meal) => log.meals?.[meal],
      ).length,
    0,
  );
  const sleepValues = logs
    .map((log) => Number(log.sleepHours))
    .filter((value) => Number.isFinite(value) && value > 0);
  const sleepAverage = sleepValues.length
    ? sleepValues.reduce((sum, value) => sum + value, 0) / sleepValues.length
    : null;
  const exerciseMinutes = logs.reduce(
    (sum, log) => sum + Number(log.exerciseMinutes || 0),
    0,
  );
  const waterValues = logs
    .map((log) => Number(log.waterMl))
    .filter((value) => Number.isFinite(value));
  const waterAverage = waterValues.length
    ? Math.round(waterValues.reduce((sum, value) => sum + value, 0) / waterValues.length)
    : 0;
  const weights = logs
    .map((log) => Number(log.weightKg))
    .filter((value) => Number.isFinite(value) && value > 0);
  const weightChange =
    weights.length > 1 ? weights.at(-1) - weights[0] : null;
  const focus = [];
  if (mealCount < 14) {
    focus.push("饮食：下周每天至少完成并记录两餐，优先保证蔬菜、全谷物和优质蛋白。");
  } else {
    focus.push("饮食：保持餐盘法，继续控盐、控油、不饮酒。");
  }
  if (sleepAverage == null || sleepAverage < 7) {
    focus.push("睡眠：优先固定起床时间，尽量保证每晚7—8.5小时。");
  } else {
    focus.push("睡眠：当前平均时长基本达标，继续保持固定作息。");
  }
  if (exerciseMinutes < 150) {
    focus.push(`运动：本周完成${exerciseMinutes}分钟，下周争取补足到150分钟，并安排2次抗阻训练。`);
  } else {
    focus.push("运动：本周已达到150分钟目标，下周保持并完成2次抗阻训练。");
  }
  focus.push("其他：每周固定测量腰围；如仍在吸烟或饮酒，把戒烟、停酒作为首要目标。");
  const pendingMedicalTasks = PERSONAL_HEALTH_TASKS.filter(
    (task) => !data.personalTasks?.[task.id],
  ).map((task) => `报告重点：${task.title}。${task.detail}`);
  focus.splice(2, 0, ...pendingMedicalTasks.slice(0, 2));
  return {
    mealCount,
    mealTarget: 28,
    sleepAverage,
    exerciseMinutes,
    waterAverage,
    weightChange,
    focus,
    summary:
      `最近7天：饮食完成 ${mealCount}/28 餐；` +
      `睡眠${sleepAverage == null ? "记录不足" : `平均 ${sleepAverage.toFixed(1)} 小时`}；` +
      `运动 ${exerciseMinutes} 分钟；饮水日均 ${waterAverage} ml。` +
      (weightChange == null
        ? ""
        : ` 体重变化 ${weightChange >= 0 ? "+" : ""}${weightChange.toFixed(1)} kg。`),
  };
}

function nextWeeklyHealthReminder(data) {
  const now = localDateAndMinutes();
  const targetDay = Number(data.settings.weeklyDay ?? 0);
  const [hour, minute] = String(data.settings.weeklyTime || "20:00")
    .split(":")
    .map(Number);
  const targetMinutes = hour * 60 + minute;
  let daysAhead = (targetDay - now.weekday + 7) % 7;
  if (daysAhead === 0 && now.minutes >= targetMinutes) daysAhead = 7;
  const target = new Date();
  target.setDate(target.getDate() + daysAhead);
  const weekdays = [
    "星期日",
    "星期一",
    "星期二",
    "星期三",
    "星期四",
    "星期五",
    "星期六",
  ];
  return `${daysAhead === 0 ? "今天" : weekdays[targetDay]} ${data.settings.weeklyTime} · 健康周报`;
}

function healthReminderEvents(data, mealPlan) {
  return [
    {
      id: "breakfast",
      label: "早餐",
      time: data.settings.breakfastTime,
      title: "早餐时间到了",
      message: `今日建议：${mealPlan.breakfast}。先喝水，再慢慢吃。`,
    },
    {
      id: "lunch",
      label: "午餐",
      time: data.settings.lunchTime,
      title: "午餐时间到了",
      message: `今日建议：${mealPlan.lunch}。按蔬菜、蛋白质、主食的顺序搭配。`,
    },
    {
      id: "dinner",
      label: "晚餐",
      time: data.settings.dinnerTime,
      title: "晚餐时间到了",
      message: `今日建议：${mealPlan.dinner}。晚餐不宜过晚或过饱。`,
    },
    {
      id: "sleep",
      label: "睡前准备",
      time: data.settings.windDownTime,
      title: "开始睡前准备",
      message: "降低屏幕亮度，停止高强度工作，避免咖啡因和大量进食。今晚建议睡眠 7—9 小时。",
    },
  ].sort((left, right) => healthTimeToMinutes(left.time) - healthTimeToMinutes(right.time));
}

function nextHealthReminder(data, mealPlan) {
  const now = localDateAndMinutes();
  const events = healthReminderEvents(data, mealPlan);
  const next = events.find((event) => healthTimeToMinutes(event.time) > now.minutes);
  return next
    ? `今天 ${next.time} · ${next.label}`
    : `明天 ${events[0].time} · ${events[0].label}`;
}

function renderHealth() {
  const data = loadHealthData();
  const today = localDateAndMinutes().dateKey;
  const log = ensureHealthLog(data, today);
  const mealPlan = healthMealPlan(today);
  const meals = [
    ["breakfast", "早餐", data.settings.breakfastTime, mealPlan.breakfast],
    ["lunch", "午餐", data.settings.lunchTime, mealPlan.lunch],
    ["dinner", "晚餐", data.settings.dinnerTime, mealPlan.dinner],
    ["snack", "加餐", "按需", mealPlan.snack],
  ];
  $("#healthDate").textContent = formatDate(today);
  $("#healthReminderEnabled").checked = data.settings.reminderEnabled !== false;
  $("#healthNextReminder").textContent = `下一次健康提醒：${nextHealthReminder(data, mealPlan)}`;
  $("#personalHealthStatus").textContent = PERSONAL_HEALTH_PROFILE.status;
  $("#personalHealthSummary").textContent = PERSONAL_HEALTH_PROFILE.summary;
  $("#personalHealthGoals").innerHTML = PERSONAL_HEALTH_PROFILE.goals
    .map(
      ([label, value]) =>
        `<span><small>${escapeHtml(label)}</small>${escapeHtml(value)}</span>`,
    )
    .join("");
  $("#personalHealthTasks").innerHTML = PERSONAL_HEALTH_TASKS.map(
    (task) => `
      <label class="personal-task ${data.personalTasks?.[task.id] ? "is-done" : ""}">
        <input type="checkbox" data-personal-task="${escapeHtml(task.id)}" ${data.personalTasks?.[task.id] ? "checked" : ""} />
        <span class="personal-task-copy">
          <strong>${escapeHtml(task.title)}</strong>
          <small>${escapeHtml(task.detail)}</small>
        </span>
        <span class="personal-task-priority">${escapeHtml(task.priority)}</span>
      </label>`,
  ).join("");
  $("#healthFoodNotes").value = data.profile.foodNotes || "";
  $("#healthMealList").innerHTML = meals
    .map(
      ([id, title, time, description]) => `
      <label class="health-meal-item ${log.meals[id] ? "is-done" : ""}">
        <input type="checkbox" data-health-meal="${id}" ${log.meals[id] ? "checked" : ""} />
        <span class="health-meal-time">${escapeHtml(time)}</span>
        <span class="health-meal-copy">
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(description)}</small>
        </span>
        <span class="health-meal-check">${log.meals[id] ? "已完成" : "待完成"}</span>
      </label>`,
    )
    .join("");

  const mealsDone = ["breakfast", "lunch", "dinner", "snack"].filter(
    (meal) => log.meals[meal],
  ).length;
  const weeklyExercise = recentHealthMinutes(data, "exerciseMinutes");
  const waterGoal = Number(data.settings.waterGoalMl || 1600);
  const weeklyHealth = buildWeeklyHealthSummary(data);
  $("#healthMealsDone").textContent = `${mealsDone} / 4`;
  $("#healthWaterSummary").textContent = `${log.waterMl || 0} ml`;
  $("#healthSleepSummary").textContent =
    log.sleepHours == null ? "待记录" : `${Number(log.sleepHours).toFixed(1)} 小时`;
  $("#healthExerciseSummary").textContent = `${weeklyExercise} 分钟`;
  $("#healthWeeklySummary").textContent = weeklyHealth.summary;
  $("#healthWeeklyFocus").innerHTML = weeklyHealth.focus
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  $("#healthWeeklyNext").textContent =
    data.settings.weeklyEnabled === false
      ? "健康周报提醒已关闭"
      : `下一次健康周报：${nextWeeklyHealthReminder(data)}`;
  $("#healthSleepTime").value = data.settings.sleepTime;
  $("#healthWakeTime").value = data.settings.wakeTime;
  $("#healthSleepDuration").textContent = healthDurationText(
    data.settings.sleepTime,
    data.settings.wakeTime,
  );
  $("#healthSleepHours").value = log.sleepHours ?? "";
  $("#healthSleepQuality").value = log.sleepQuality || "";
  $("#healthExerciseMinutes").value = log.exerciseMinutes || "";
  $("#healthStrength").checked = Boolean(log.strength);
  $("#healthExerciseWeek").textContent = `${weeklyExercise} / 150 分钟`;
  $("#healthExerciseProgress").style.width = `${Math.min(100, (weeklyExercise / 150) * 100)}%`;
  $("#healthWaterValue").textContent = `${log.waterMl || 0} ml / ${waterGoal} ml`;
  $("#healthWeight").value = log.weightKg ?? data.profile.weightKg ?? "";
  $("#healthWaist").value = log.waistCm ?? "";
  $("#healthEnergy").value = log.energy || 3;
  $("#healthStress").value = log.stress || 3;
  $("#healthDailyNote").value = log.note || "";
  $("#healthBreakfastTime").value = data.settings.breakfastTime;
  $("#healthLunchTime").value = data.settings.lunchTime;
  $("#healthDinnerTime").value = data.settings.dinnerTime;
  $("#healthWindDownTime").value = data.settings.windDownTime;
  $("#healthWeeklyDay").value = String(data.settings.weeklyDay ?? 0);
  $("#healthWeeklyTime").value = data.settings.weeklyTime || "20:00";
  $("#healthWeeklyEnabled").checked = data.settings.weeklyEnabled !== false;
  $("#healthCheckupDate").value = data.checkup.date || "";
  $("#healthCheckupFollowup").value = data.checkup.followup || "";
  $("#healthCheckupSummary").value = data.checkup.summary || "";
}

function updateTodayHealth(mutator) {
  const data = loadHealthData();
  const today = localDateAndMinutes().dateKey;
  const log = ensureHealthLog(data, today);
  mutator(log, data);
  saveHealthData(data);
  renderHealth();
}

function optionalNumber(value) {
  return value === "" || value == null ? null : Number(value);
}

function renderSettings() {
  $("#cityTags").innerHTML = state.data.cities
    .map((city) => `<span>${escapeHtml(city)}</span>`)
    .join("");
  $("#industryTags").innerHTML = state.data.industries
    .map((industry) => `<span>${escapeHtml(industry)}</span>`)
    .join("");
  $("#settingPushTime").textContent =
    `A股：每个工作日 ${state.data.notificationTime}；` +
    `工程：每周五 ${state.data.engineeringReminderTime || "18:00"}`;
  const errors = [...(state.data.tenders.errors || [])];
  if (state.data.market.error) errors.push(`A股行情：${state.data.market.error}`);
  $("#sourceErrors").textContent = errors.length
    ? errors.join("\n")
    : "本次数据抓取正常。工程条目仍需以官方原文为最终依据。";
}

async function openModuleWindow(view) {
  if (matchMedia("(max-width: 820px)").matches || /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    switchView(view);
    return;
  }
  try {
    await requestJson(`/api/open-window?view=${encodeURIComponent(view)}`, {
      method: "POST",
      timeoutMs: 5_000,
    });
    showToast(
      view === "projects"
        ? "工程秘密窗口正在打开。"
        : view === "health"
          ? "健康管理窗口正在打开。"
          : "A股研判窗口正在打开。",
    );
  } catch (error) {
    showToast(`窗口打开失败：${error.message}`);
  }
}

async function loadExportMonths() {
  try {
    const response = await fetch(`data/months.json?t=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const months = await response.json();
    const select = $("#exportMonth");
    if (!months.length) {
      select.innerHTML = '<option value="">暂无月度文件</option>';
      return;
    }
    select.innerHTML = months
      .map(
        (item) =>
          `<option value="${escapeHtml(item.file)}" data-count="${item.count}">${escapeHtml(item.label)}（${item.count} 项）</option>`,
      )
      .join("");
  } catch {
    const month = state.data?.dateLabel?.slice(0, 7);
    $("#exportMonth").innerHTML = month
      ? `<option value="data/monthly/${month}.xlsx">${month.replace("-", "年")}月</option>`
      : '<option value="">暂无月度文件</option>';
  }
}

function downloadSelectedExcel() {
  const file = $("#exportMonth").value;
  if (!file) {
    showToast("当前没有可下载的月度 Excel。");
    return;
  }
  const link = document.createElement("a");
  link.href = file;
  link.download = "";
  link.click();
  showToast("正在下载月度 Excel 表格。");
}

function updateReportBanner(data, firstLoad = false) {
  const seen = localStorage.getItem("privateSecretary.lastReport");
  const banner = $("#newReportBanner");
  if (!seen) {
    localStorage.setItem("privateSecretary.lastReport", data.generatedAt);
    banner.hidden = true;
    return;
  }
  const hasNew = seen !== data.generatedAt;
  banner.hidden = !hasNew;
  if (hasNew && !firstLoad) {
    showToast("今日新日报已更新");
  }
}

const REMINDER_KEY = "privateSecretary.reminder";
const REMINDER_LAST_KEY = "privateSecretary.lastReminderDate";
const ENGINEERING_REMINDER_LAST_KEY =
  "privateSecretary.lastEngineeringReminderDate";

function loadReminderSettings() {
  try {
    return {
      enabled: true,
      time: "16:30",
      frequency: "weekdays",
      ...JSON.parse(localStorage.getItem(REMINDER_KEY) || "{}"),
    };
  } catch {
    return { enabled: true, time: "16:30", frequency: "weekdays" };
  }
}

function renderReminderSettings() {
  const settings = loadReminderSettings();
  $("#reminderEnabled").checked = settings.enabled;
  $("#reminderTime").value = settings.time;
  $("#reminderFrequency").value = settings.frequency;
}

function localDateAndMinutes(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: date.getDay(),
  };
}

function maybeShowDailyReminder() {
  if (!state.data || state.reminderVisible) return false;
  const settings = loadReminderSettings();
  if (!settings.enabled) return false;
  const now = localDateAndMinutes();
  const [hour, minute] = settings.time.split(":").map(Number);
  const dueMinutes = hour * 60 + minute;
  if (now.minutes < dueMinutes) return false;
  if (settings.frequency === "weekdays" && (now.weekday === 0 || now.weekday === 6)) {
    return false;
  }
  if (localStorage.getItem(REMINDER_LAST_KEY) === now.dateKey) return false;
  if (state.reminderSnoozeUntil && Date.now() < state.reminderSnoozeUntil) {
    return false;
  }
  state.reminderMode = "daily";
  $("#reminderTitle").textContent = "今日A股复盘已经准备好";
  const plan = state.data.market.tradingPlan;
  const focus = plan?.mainlines?.slice(0, 2).map((line) => line.name).join("、");
  $("#reminderSummary").textContent =
    `A股：${plan?.regime || marketTone()}，情景仓位 ${plan?.positionGuide || "待确认"}` +
    `${focus ? `；关注${focus}` : ""}。工程情报每周五 18:00 单独更新。`;
  $("#reminderOverlay").hidden = false;
  state.reminderVisible = true;
  return true;
}

function maybeShowEngineeringReminder() {
  if (!state.data || state.reminderVisible) return false;
  const now = localDateAndMinutes();
  const friday = Number(state.data.engineeringReminderWeekday || 5);
  const [hour, minute] = String(
    state.data.engineeringReminderTime || "18:00",
  )
    .split(":")
    .map(Number);
  if (now.weekday !== friday || now.minutes < hour * 60 + minute) return false;
  if (localStorage.getItem(ENGINEERING_REMINDER_LAST_KEY) === now.dateKey) {
    return false;
  }
  if (state.reminderSnoozeUntil && Date.now() < state.reminderSnoozeUntil) {
    return false;
  }
  state.reminderMode = "engineering";
  $("#reminderTitle").textContent = "本周工程情报已整理好";
  $("#reminderSummary").textContent =
    `已筛选2026年7月1日以来、仍在半年有效期内的立项和设计招标项目：` +
    `${state.data.tenders.qualifiedCount} 条符合全部条件，` +
    `${state.data.tenders.pendingCount} 条待核实。`;
  $("#reminderOverlay").hidden = false;
  state.reminderVisible = true;
  return true;
}

function maybeShowHealthReminder() {
  if (state.reminderVisible) return false;
  const data = loadHealthData();
  if (data.settings.reminderEnabled === false) return false;
  const now = localDateAndMinutes();
  const mealPlan = healthMealPlan(now.dateKey);
  const due = healthReminderEvents(data, mealPlan)
    .filter((event) => {
      const scheduled = healthTimeToMinutes(event.time);
      return now.minutes >= scheduled && now.minutes - scheduled <= 120;
    })
    .at(-1);
  if (!due) return false;
  const reminderKey = `${now.dateKey}:${due.id}`;
  if (localStorage.getItem(HEALTH_REMINDER_LAST_KEY) === reminderKey) {
    return false;
  }
  if (state.reminderSnoozeUntil && Date.now() < state.reminderSnoozeUntil) {
    return false;
  }
  state.reminderMode = "health";
  state.healthReminderKey = reminderKey;
  $("#reminderTitle").textContent = due.title;
  $("#reminderSummary").textContent = due.message;
  $("#reminderOverlay").hidden = false;
  state.reminderVisible = true;
  return true;
}

function maybeShowWeeklyHealthReminder() {
  if (state.reminderVisible) return false;
  const data = loadHealthData();
  if (data.settings.weeklyEnabled === false) return false;
  const now = localDateAndMinutes();
  const targetDay = Number(data.settings.weeklyDay ?? 0);
  const [hour, minute] = String(data.settings.weeklyTime || "20:00")
    .split(":")
    .map(Number);
  const targetMinutes = hour * 60 + minute;
  if (
    now.weekday !== targetDay ||
    now.minutes < targetMinutes ||
    now.minutes - targetMinutes > 180
  ) {
    return false;
  }
  const reminderKey = `${now.dateKey}:health-weekly`;
  if (localStorage.getItem(HEALTH_WEEKLY_LAST_KEY) === reminderKey) {
    return false;
  }
  if (state.reminderSnoozeUntil && Date.now() < state.reminderSnoozeUntil) {
    return false;
  }
  const weekly = buildWeeklyHealthSummary(data);
  state.reminderMode = "health-weekly";
  state.healthReminderKey = reminderKey;
  $("#reminderTitle").textContent = "本周健康管理周报";
  $("#reminderSummary").textContent =
    `${weekly.summary} 下周重点：${weekly.focus.slice(0, 3).join(" ")}`;
  $("#reminderOverlay").hidden = false;
  state.reminderVisible = true;
  return true;
}

function checkReminders() {
  if (maybeShowWeeklyHealthReminder()) return;
  if (maybeShowHealthReminder()) return;
  if (maybeShowEngineeringReminder()) return;
  maybeShowDailyReminder();
}

function dismissReminder() {
  const now = localDateAndMinutes();
  if (state.reminderMode === "health") {
    localStorage.setItem(
      HEALTH_REMINDER_LAST_KEY,
      state.healthReminderKey || now.dateKey,
    );
  } else if (state.reminderMode === "health-weekly") {
    localStorage.setItem(
      HEALTH_WEEKLY_LAST_KEY,
      state.healthReminderKey || now.dateKey,
    );
  } else {
    localStorage.setItem(
      state.reminderMode === "engineering"
        ? ENGINEERING_REMINDER_LAST_KEY
        : REMINDER_LAST_KEY,
      now.dateKey,
    );
  }
  state.reminderVisible = false;
  state.reminderSnoozeUntil = 0;
  state.reminderMode = "";
  state.healthReminderKey = "";
  $("#reminderOverlay").hidden = true;
}

function openReminderView(view) {
  dismissReminder();
  switchView(view);
}

function renderAll() {
  renderOverview();
  renderProjects();
  renderMarket();
  renderHealth();
  renderSettings();
}

async function loadData({ silent = false } = {}) {
  if (!silent) setStatus("正在加载", "loading");
  try {
    let nextData;
    try {
      nextData = await requestJson("/api/data", { timeoutMs: 3_500 });
    } catch {
      nextData = await fetchStaticSummary();
    }
    const hadData = Boolean(state.data);
    const previousGeneratedAt = state.data?.generatedAt;
    state.data = enforceTenderRules(nextData);
    state.reconnectAttempts = 0;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    renderAll();
    loadExportMonths();
    updateReportBanner(
      state.data,
      !hadData || silent || previousGeneratedAt === state.data.generatedAt,
    );
    setStatus(`更新于 ${state.data.generatedAtLocal}`, "ready");
    checkReminders();
  } catch (error) {
    console.error(error);
    if (state.data) {
      setStatus("网络不稳定，正在自动重连", "loading");
      showToast("网络暂时中断，已保留上次日报，正在自动重连。");
    } else {
      setStatus("网络不稳定，正在自动重连", "loading");
      showToast(`暂时无法获取日报：${friendlyError(error)}，正在自动重连。`);
    }
    scheduleReconnect();
  }
}

async function refreshData() {
  if (state.refreshing) return;
  state.refreshing = true;
  const button = $("#refreshButton");
  button.disabled = true;
  button.textContent = "正在更新…";
  setStatus("正在抓取官方数据", "loading");
  try {
    let nextData;
    try {
      nextData = await requestJson("/api/refresh", {
        method: "POST",
        timeoutMs: 90_000,
      });
    } catch {
      nextData = await fetchStaticSummary();
    }
    state.data = enforceTenderRules(nextData);
    state.reconnectAttempts = 0;
    renderAll();
    loadExportMonths();
    updateReportBanner(state.data, false);
    setStatus(`更新于 ${state.data.generatedAtLocal}`, "ready");
    showToast(
      nextData
        ? "已同步最新日报。"
        : "工程公告与 A 股行情已更新。",
    );
  } catch (error) {
    console.error(error);
    if (state.data) {
      setStatus("网络不稳定，正在自动重连", "loading");
      showToast("暂时无法连接数据服务，已保留当前日报，正在自动重连。");
    } else {
      setStatus("网络不稳定，正在自动重连", "loading");
      showToast(`暂时无法更新：${friendlyError(error)}，正在自动重连。`);
    }
    scheduleReconnect();
  } finally {
    state.refreshing = false;
    button.disabled = false;
    button.innerHTML =
      '<span aria-hidden="true">↻</span><span class="refresh-label">立即更新</span>';
  }
}

$$(".nav-item").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

$$("[data-go-view]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.goView));
});

$$("[data-project-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.projectFilter = button.dataset.projectFilter;
    $$("[data-project-filter]").forEach((item) =>
      item.classList.toggle("is-active", item === button),
    );
    if (state.data) renderProjects();
  });
});

$("#refreshButton").addEventListener("click", refreshData);

$("#exportButton").addEventListener("click", downloadSelectedExcel);

$("#newReportBanner").addEventListener("click", () => {
  if (state.data) {
    localStorage.setItem("privateSecretary.lastReport", state.data.generatedAt);
  }
  $("#newReportBanner").hidden = true;
  switchView("overview");
});

$("#secretaryGateway").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-window]");
  if (button && !button.disabled) openModuleWindow(button.dataset.openWindow);
});

$("#healthReminderEnabled").addEventListener("change", (event) => {
  const data = loadHealthData();
  data.settings.reminderEnabled = event.target.checked;
  saveHealthData(data);
  renderHealth();
  showToast(event.target.checked ? "健康提醒已启用。" : "健康提醒已暂停。");
});

$("#healthMealList").addEventListener("change", (event) => {
  const meal = event.target.closest("[data-health-meal]")?.dataset.healthMeal;
  if (!meal) return;
  updateTodayHealth((log) => {
    log.meals[meal] = event.target.checked;
  });
});

$("#personalHealthTasks").addEventListener("change", (event) => {
  const task = event.target.closest("[data-personal-task]")?.dataset.personalTask;
  if (!task) return;
  const data = loadHealthData();
  data.personalTasks ||= {};
  data.personalTasks[task] = event.target.checked;
  saveHealthData(data);
  renderHealth();
  showToast(event.target.checked ? "该健康任务已标记完成。" : "该健康任务已恢复为待完成。");
});

["healthSleepTime", "healthWakeTime"].forEach((id) => {
  $(`#${id}`).addEventListener("change", () => {
    const data = loadHealthData();
    if (id === "healthSleepTime") {
      data.settings.sleepTime = $("#healthSleepTime").value || "22:30";
    } else {
      data.settings.wakeTime = $("#healthWakeTime").value || "07:00";
    }
    saveHealthData(data);
    renderHealth();
  });
});

$("#healthSleepHours").addEventListener("change", () => {
  updateTodayHealth((log) => {
    log.sleepHours = optionalNumber($("#healthSleepHours").value);
  });
});

$("#healthSleepQuality").addEventListener("change", () => {
  updateTodayHealth((log) => {
    log.sleepQuality = $("#healthSleepQuality").value;
  });
});

$("#healthExerciseMinutes").addEventListener("change", () => {
  updateTodayHealth((log) => {
    log.exerciseMinutes = optionalNumber($("#healthExerciseMinutes").value) || 0;
  });
});

$("#healthStrength").addEventListener("change", () => {
  updateTodayHealth((log) => {
    log.strength = $("#healthStrength").checked;
  });
});

$("#healthWaterMinus").addEventListener("click", () => {
  updateTodayHealth((log) => {
    log.waterMl = Math.max(0, Number(log.waterMl || 0) - 250);
  });
});

$("#healthWaterPlus").addEventListener("click", () => {
  updateTodayHealth((log) => {
    log.waterMl = Number(log.waterMl || 0) + 250;
  });
});

$("#healthSaveDaily").addEventListener("click", () => {
  const data = loadHealthData();
  const today = localDateAndMinutes().dateKey;
  const log = ensureHealthLog(data, today);
  log.weightKg = optionalNumber($("#healthWeight").value);
  data.profile.weightKg = log.weightKg;
  log.waistCm = optionalNumber($("#healthWaist").value);
  log.energy = Number($("#healthEnergy").value || 3);
  log.stress = Number($("#healthStress").value || 3);
  log.note = $("#healthDailyNote").value.trim();
  data.profile.foodNotes = $("#healthFoodNotes").value.trim();
  saveHealthData(data);
  renderHealth();
  showToast("今日健康记录已保存在本机。");
});

$("#healthSaveReminder").addEventListener("click", () => {
  const data = loadHealthData();
  data.settings.breakfastTime = $("#healthBreakfastTime").value || "08:00";
  data.settings.lunchTime = $("#healthLunchTime").value || "12:00";
  data.settings.dinnerTime = $("#healthDinnerTime").value || "18:30";
  data.settings.windDownTime = $("#healthWindDownTime").value || "22:00";
  data.settings.weeklyDay = Number($("#healthWeeklyDay").value || 0);
  data.settings.weeklyTime = $("#healthWeeklyTime").value || "20:00";
  data.settings.weeklyEnabled = $("#healthWeeklyEnabled").checked;
  data.settings.reminderEnabled = $("#healthReminderEnabled").checked;
  saveHealthData(data);
  renderHealth();
  showToast("健康提醒时间已保存。");
});

$("#healthSaveCheckup").addEventListener("click", () => {
  const data = loadHealthData();
  data.checkup.date = $("#healthCheckupDate").value;
  data.checkup.followup = $("#healthCheckupFollowup").value;
  data.checkup.summary = $("#healthCheckupSummary").value.trim();
  saveHealthData(data);
  showToast("体检记录已保存在本机。");
});

$("#healthExportData").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(loadHealthData(), null, 2)], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `私人秘书健康数据-${localDateAndMinutes().dateKey}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  showToast("健康数据已导出。");
});

$("#healthClearData").addEventListener("click", () => {
  if (!window.confirm("确定清空本机全部健康记录吗？此操作无法撤销。")) return;
  localStorage.removeItem(HEALTH_DATA_KEY);
  localStorage.removeItem(HEALTH_REMINDER_LAST_KEY);
  localStorage.removeItem(HEALTH_WEEKLY_LAST_KEY);
  renderHealth();
  showToast("本机健康数据已清空。");
});

$("#saveReminderButton").addEventListener("click", () => {
  const settings = {
    enabled: $("#reminderEnabled").checked,
    time: $("#reminderTime").value || "16:30",
    frequency: $("#reminderFrequency").value,
  };
  localStorage.setItem(REMINDER_KEY, JSON.stringify(settings));
  $("#reminderSettingsStatus").textContent = "提醒设置已保存";
  state.reminderVisible = false;
  state.reminderSnoozeUntil = 0;
  checkReminders();
});

$$("[data-reminder-view]").forEach((button) => {
  button.addEventListener("click", () => openReminderView(button.dataset.reminderView));
});

$("#snoozeReminder").addEventListener("click", () => {
  state.reminderVisible = false;
  state.reminderSnoozeUntil = Date.now() + 15 * 60 * 1000;
  $("#reminderOverlay").hidden = true;
});

$("#dismissReminder").addEventListener("click", dismissReminder);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    loadData({ silent: true });
    checkReminders();
  }
});

window.addEventListener("online", () => {
  state.reconnectAttempts = 0;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  loadData({ silent: true });
});

const initialView = location.hash.slice(1);
if (["overview", "projects", "market", "health", "settings"].includes(initialView)) {
  switchView(initialView, false);
}

if (window.PRIVATE_SECRETARY_FALLBACK) {
  state.data = enforceTenderRules(
    structuredClone(window.PRIVATE_SECRETARY_FALLBACK),
  );
  renderAll();
  loadExportMonths();
  setStatus(`显示最近日报 · ${state.data.generatedAtLocal}`, "loading");
}

loadData();
renderReminderSettings();
setInterval(() => loadData({ silent: true }), 5 * 60 * 1000);
setInterval(checkReminders, 30 * 1000);

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("service-worker.js?v=20261027-17").catch(() => {});
}
