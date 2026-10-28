const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const { spawnSync } = require("node:child_process");

dns.setDefaultResultOrder("ipv4first");

const ROOT = path.resolve(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const DATA_DIR = path.join(ROOT, "data");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

function ensureDirectories() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: CONFIG.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function requestBuffer(url, options = {}, redirectCount = 0, attempt = 1) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(
      target,
      {
        method: options.method || "GET",
        family: 4,
        agent: false,
        timeout: options.timeout || 45_000,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          ...(options.headers || {}),
        },
      },
      (response) => {
        response.on("error", (error) => {
          if (attempt < 3) {
            setTimeout(() => {
              requestBuffer(url, options, redirectCount, attempt + 1).then(
                resolve,
                reject,
              );
            }, 300 * attempt);
            return;
          }
          reject(error);
        });
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          if (redirectCount >= 5) {
            reject(new Error(`Too many redirects: ${url}`));
            return;
          }
          resolve(
            requestBuffer(
              new URL(response.headers.location, target).toString(),
              options,
              redirectCount + 1,
              attempt,
            ),
          );
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message =
              `HTTP ${response.statusCode}: ${url} ${buffer
                .toString("utf8", 0, Math.min(buffer.length, 300))
                .replace(/\s+/g, " ")}`;
            if (response.statusCode >= 500 && attempt < 3) {
              setTimeout(
                () =>
                  requestBuffer(url, options, redirectCount, attempt + 1).then(
                    resolve,
                    reject,
                  ),
                250 * attempt,
              );
              return;
            }
            reject(new Error(message));
            return;
          }
          resolve({
            buffer,
            headers: response.headers,
            statusCode: response.statusCode,
          });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error(`Request timed out: ${url}`)));
    request.on("error", (error) => {
      if (attempt < 3) {
        setTimeout(() => {
          requestBuffer(url, options, redirectCount, attempt + 1).then(
            resolve,
            reject,
          );
        }, 250 * attempt);
        return;
      }
      reject(error);
    });
    request.end(options.body || undefined);
  });
}

function decodeResponse(buffer, contentType = "") {
  const charset = String(contentType).match(/charset=([^;\s]+)/i)?.[1]?.toLowerCase();
  const encoding =
    charset === "gbk" || charset === "gb2312" || charset === "gb18030"
      ? "gb18030"
      : "utf-8";
  return new TextDecoder(encoding).decode(buffer);
}

async function fetchText(url, options = {}) {
  const response = await requestBuffer(url, options);
  return decodeResponse(response.buffer, response.headers["content-type"]);
}

async function fetchJson(url) {
  const response = await requestBuffer(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      Referer: "https://quote.eastmoney.com/",
    },
    timeout: 30_000,
  });
  return JSON.parse(decodeResponse(response.buffer, response.headers["content-type"]));
}

function decodeHtml(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name) => named[name] || match);
}

function stripHtml(value) {
  return decodeHtml(
    value
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t\u3000]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[：:、，,\-\s]+|[：:、，,\-\s]+$/g, "")
    .trim();
}

function compactExcerpt(text, maxLength = 220) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trim()}…`
    : normalized;
}

function parseDateOnly(value) {
  const match = String(value || "").match(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})/);
  return match
    ? `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`
    : "";
}

function daysAgo(dateKey, referenceKey = localDateKey()) {
  const left = new Date(`${dateKey}T00:00:00+08:00`);
  const right = new Date(`${referenceKey}T00:00:00+08:00`);
  return Math.round((right - left) / 86_400_000);
}

function projectWindowCutoff(referenceKey = localDateKey()) {
  const reference = new Date(`${referenceKey}T00:00:00Z`);
  const rolling = new Date(reference);
  rolling.setUTCDate(
    rolling.getUTCDate() -
      Number(CONFIG.lookbackDays || CONFIG.retentionDays || 183),
  );
  return [CONFIG.projectStartDate, rolling.toISOString().slice(0, 10)]
    .filter(Boolean)
    .sort()
    .at(-1);
}

function isWithinProjectWindow(dateKey, referenceKey = localDateKey()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || "")) return false;
  return dateKey >= projectWindowCutoff(referenceKey) && dateKey <= referenceKey;
}

function titleCaseAmount(yuan) {
  if (!Number.isFinite(yuan) || yuan <= 0) return "未披露";
  if (yuan >= 100_000_000) return `${(yuan / 100_000_000).toFixed(2)} 亿元`;
  if (yuan >= 10_000) return `${(yuan / 10_000).toFixed(1)} 万元`;
  return `${yuan.toFixed(0)} 元`;
}

function parseAmountToYuan(amountText) {
  const match = String(amountText || "").match(
    /([0-9]+(?:\.[0-9]+)?)\s*(亿元|万元|元)/,
  );
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2];
  if (unit === "亿元") return Math.round(value * 100_000_000);
  if (unit === "万元") return Math.round(value * 10_000);
  return Math.round(value);
}

function extractLabeledAmount(text) {
  const labels = [
    "项目总投资",
    "总投资",
    "投资估算",
    "工程投资",
    "最高投标限价",
    "招标控制价",
    "合同估算价",
    "预算金额",
  ];
  for (const label of labels) {
    const match = text.match(
      new RegExp(
        `${label}[^。；\\n]{0,60}?([0-9]+(?:\\.[0-9]+)?\\s*(?:亿元|万元|元))`,
      ),
    );
    if (match) {
      return {
        value: parseAmountToYuan(match[1]),
        label,
        display: match[1].replace(/\s+/g, ""),
      };
    }
  }
  return null;
}

function extractOwner(text) {
  const patterns = [
    /项目业主(?:单位)?(?:为|是|[:：])?\s*([^\n。；，,]{2,60})/,
    /招标人(?:为|是|[:：])\s*([^\n。；，,]{2,60})/,
    /建设单位(?:为|是|[:：])\s*([^\n。；，,]{2,60})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return cleanLine(match[1]).replace(/(?:，|,)?建设资金.*$/, "");
    }
  }
  return "未披露";
}

function locateCity(text) {
  const title = String(text || "").split("\n", 1)[0];
  const locationPatterns = [
    /(?:建设地点|项目地点|项目地址|服务地点|交货地点|实施地点)(?:为|是|[:：])?\s*([^\n。；]{0,120})/,
    /(?:位于|地处)\s*([^\n。；]{0,100})/,
  ];
  for (const pattern of locationPatterns) {
    const match = text.match(pattern);
    if (match) {
      const located = CONFIG.cities.find((city) => match[1].includes(city));
      if (located) return located;
      if (
        (CONFIG.nonTargetAliases || []).some((alias) =>
          match[1].includes(alias),
        )
      ) {
        return "";
      }
    }
  }
  const contactIndex = text.search(/(?:^|\n)\s*(?:13[.、]?\s*)?联系方式\s*[:：]?/);
  const projectText = contactIndex > 0 ? text.slice(0, contactIndex) : text;
  for (const hint of CONFIG.cityPriorityHints || []) {
    if (hint.aliases?.some((alias) => title.includes(alias))) {
      return hint.city;
    }
  }
  for (const [city, aliases] of Object.entries(CONFIG.cityAliases || {})) {
    if (
      title.includes(city) ||
      aliases.some((alias) => title.includes(alias))
    ) {
      return city;
    }
  }
  const scored = CONFIG.cities.map((city) => {
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      city,
      score: (projectText.match(new RegExp(escaped, "g")) || []).length,
    };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return CONFIG.cities.indexOf(a.city) - CONFIG.cities.indexOf(b.city);
  });
  if (scored[0]?.score > 0) return scored[0].city;
  return "";
}

function locateIndustries(text) {
  return CONFIG.industries
    .filter((industry) =>
      industry.keywords.some((keyword) => text.includes(keyword)),
    )
    .map((industry) => industry.name);
}

function extractOverview(text) {
  const markers = ["项目概况", "项目基本情况", "建设规模"];
  let start = -1;
  for (const marker of markers) {
    start = text.indexOf(marker);
    if (start >= 0) break;
  }
  if (start < 0) {
    const scope = text.indexOf("招标范围");
    return compactExcerpt(scope >= 0 ? text.slice(scope, scope + 360) : text.slice(0, 360));
  }
  let excerpt = text.slice(start, start + 800);
  const ends = ["招标范围", "投标人资格要求", "投标人资格", "3.投标人资格"];
  for (const end of ends) {
    const index = excerpt.indexOf(end, 4);
    if (index > 20) excerpt = excerpt.slice(0, index);
  }
  return compactExcerpt(excerpt.replace(/^[^：:]*[：:]/, ""), 260);
}

function detectProgress(title, text, publicationDate) {
  if (/中标候选人/.test(title)) return `中标候选人公示（${publicationDate}）`;
  if (/中标结果|结果公告|成交公告/.test(title)) return `招标结果公示（${publicationDate}）`;
  if (/更正|澄清|变更/.test(title)) return `公告更正/澄清（${publicationDate}）`;
  if (/资格预审/.test(title)) return `资格预审公告（${publicationDate}）`;
  if (/招标计划/.test(text)) return `招标计划/招标公告（${publicationDate}）`;
  return `招标公告发布（${publicationDate}）`;
}

function isDesignStageTitle(title) {
  const isDesign = /设计/.test(title);
  const excluded =
    /(施工招标|土建|施工总承包|工程总承包|EPC|设计施工总承包|采购施工|监理招标|监理服务|设备采购|设备招标|采购设备|物资采购|物资招标|采购物资|材料采购|材料招标|采购材料|货物采购|设备及材料|设计.{0,24}(?:安装|采购).{0,24}设备|(?:设备|系统|软件|材料|物资|货物).{0,30}(?:设计|采购|安装)|采购及安装|设备安装|机电安装|安装工程|中标候选人|中标结果|结果公告|成交公告|终止公告|废标公告|流标公告)/i.test(
      title,
    );
  return isDesign && !excluded;
}

function extractPlannedTenderTime(text, publicationDate) {
  const expected = text.match(
    /预计(?:发布)?招标公告时间\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/,
  );
  if (expected) {
    return { value: `预计 ${expected[1]} 发布招标公告`, basis: "official-plan" };
  }
  const explicit = text.match(
    /计划(?:招标|启动招标)(?:时间)?(?:为|于|[:：])?\s*([^。；\n]{4,40})/,
  );
  if (explicit) return { value: cleanLine(explicit[1]), basis: "official-plan" };
  return { value: `已发布招标公告（${publicationDate}）`, basis: "current-stage" };
}

function hasFundsSecured(text) {
  return /(?:资金|建设资金|项目资金|资金来源)[^。；\n]{0,30}(?:已落实|已经落实|已到位)|(?:已落实|已经落实)[^。；\n]{0,12}(?:建设资金|项目资金|资金来源)/.test(
    text,
  );
}

function isFundingSourceDisclosed(text) {
  return /(?:资金来源|建设资金|资本金)[^。；\n]{0,80}/.test(text);
}

function makeTenderRecord(item, detail) {
  const text = `${item.title}\n${detail.text}`;
  const city = CONFIG.cities.includes(item.city) ? item.city : locateCity(text);
  const industries = locateIndustries(text);
  const amount = extractLabeledAmount(text);
  const funded = hasFundsSecured(detail.text);
  const fundingSource = isFundingSourceDisclosed(detail.text);
  const amountQualified =
    amount?.value && amount.value > CONFIG.minInvestmentYuan;
  const amountRejected =
    amount?.value && amount.value <= CONFIG.minInvestmentYuan;
  const qualified = Boolean(
    city && industries.length && amountQualified && funded && !amountRejected,
  );
  const pending = Boolean(
    city &&
      industries.length &&
      !amountRejected &&
      (!amount || !funded),
  );
  const plannedTender = extractPlannedTenderTime(detail.text, item.date);
  const qualificationReasons = [];
  if (!amount) qualificationReasons.push("投资金额未在正文披露");
  if (amount && !amountQualified) qualificationReasons.push("投资金额不高于1.5亿元");
  if (!funded) qualificationReasons.push("未找到资金已落实的明确表述");
  if (!city) qualificationReasons.push("未能识别到目标城市");
  if (!industries.length) qualificationReasons.push("未匹配目标专业");

  const extractedOverview = extractOverview(detail.text);
  const overview =
    /详细内容.*用户登录|用户登录.*账号注册/.test(extractedOverview)
      ? item.publicationType === "招标计划"
        ? `招标计划公告：${cleanLine(item.title)}。官方页面未披露建设规模、投资金额和资金落实情况，需待正式招标文件进一步核验。`
        : `官方公告主要披露设计招标事项，未提供完整建设规模、投资金额或资金落实情况。`
      : extractedOverview;

  return {
    id: item.id,
    city,
    industries,
    title: item.title.replace(/\s+/g, " ").trim(),
    owner: extractOwner(detail.text),
    overview,
    recentProgress:
      item.publicationType === "招标计划"
        ? `设计招标计划发布（${item.date}）`
        : item.publicationType === "招标文件提前公示"
          ? `设计招标文件提前公示（${item.date}）`
          : item.publicationType === "招标预公示"
            ? `设计招标预公示（${item.date}）`
            : detectProgress(item.title, detail.text, item.date),
    investmentAmountYuan: amount?.value || null,
    investmentAmount: amount ? titleCaseAmount(amount.value) : "未披露",
    amountLabel: amount?.label || "",
    fundingSource,
    fundsSecured: funded,
    fundingStatus: funded
      ? "官方文本明确已落实"
      : fundingSource
        ? "已披露来源，落实情况未明确"
        : "未披露",
    plannedTenderTime: plannedTender.value,
    plannedTenderBasis: plannedTender.basis,
    publicationDate: item.date,
    sourceUrl: item.url,
    sourceKey: item.sourceKey || "public-resource",
    sourceName: item.sourceName || "河北省公共资源交易中心",
    publicationType: item.publicationType || "招标公告",
    sources: [
      {
        key: item.sourceKey || "public-resource",
        name: item.sourceName || "河北省公共资源交易中心",
        url: item.url,
      },
    ],
    qualified,
    pending,
    qualificationReasons,
    recordType: "design",
    stageLabel: "招标设计",
  };
}

function makeApprovalRecord(item) {
  const text = `${item.title}\n${item.owner || ""}\n${item.approvalContent || ""}`;
  const city = locateCity(text);
  const industries = locateIndustries(text);
  const investmentAmountYuan = Number.isFinite(item.investmentYuan)
    ? item.investmentYuan
    : null;
  if (
    !city ||
    !industries.length ||
    !isWithinProjectWindow(item.date) ||
    (investmentAmountYuan && investmentAmountYuan <= CONFIG.minInvestmentYuan)
  ) {
    return null;
  }
  const approvalContent =
    item.approvalContent ||
    `同意${item.title}${item.approvalItem ? `（${item.approvalItem}）` : ""}`;
  const documentRef = item.decisionNumber
    ? `；批复文号：${item.decisionNumber}`
    : "";
  const projectCode = item.projectCode
    ? `；项目代码：${item.projectCode}`
    : "";
  const totalInvestment = investmentAmountYuan
    ? `；项目总投资：${titleCaseAmount(investmentAmountYuan)}`
    : "";
  const tenderEstimate = Number.isFinite(item.tenderEstimateYuan)
    ? `；招标估算额：${titleCaseAmount(item.tenderEstimateYuan)}`
    : "";
  const planScope = item.designInApprovedPlan
    ? "；招标方案核准范围包含设计"
    : "";
  const qualificationReasons = [];
  if (!investmentAmountYuan) {
    qualificationReasons.push("投资金额未在官方核准页面披露");
  }
  qualificationReasons.push("未找到资金已落实的明确表述");
  return {
    id: item.id,
    city,
    industries,
    title: cleanLine(item.title),
    owner: item.owner || "未披露",
    overview:
      `${approvalContent}${documentRef}${projectCode}` +
      `${totalInvestment}${tenderEstimate}${planScope}`,
    recentProgress: `发改委核准立项及招标方案（${item.date}）`,
    investmentAmountYuan,
    investmentAmount: investmentAmountYuan
      ? titleCaseAmount(investmentAmountYuan)
      : "未披露",
    amountLabel: "",
    fundingSource: false,
    fundsSecured: false,
    fundingStatus: item.fundsStatement
      ? `${item.fundsStatement}，落实情况未明确`
      : "发改委已核准，但资金落实情况未披露",
    plannedTenderTime: item.designInApprovedPlan
      ? "招标方案已核准（含设计），待招标公告"
      : "立项已核准，待招标计划披露",
    plannedTenderBasis: "approval-only",
    publicationDate: item.date,
    sourceUrl: item.url,
    sourceName: item.approvalAuthority || "河北省发展和改革委员会",
    sourceKey: "approval",
    publicationType: "立项核准",
    sources: [
      {
        key: "approval",
        name: item.approvalAuthority || "河北省发展和改革委员会",
        url: item.url,
      },
    ],
    qualified: false,
    pending: true,
    qualificationReasons,
    progressHistory: [`发改委核准立项及招标方案（${item.date}）`],
    recordType: "approval",
    stageLabel: "立项",
    approvalItem: item.approvalItem || "",
    decisionNumber: item.decisionNumber || "",
    projectCode: item.projectCode || "",
  };
}

function canonicalProjectKey(title) {
  return String(title || "")
    .replace(/^【[^】]+】/, "")
    .replace(
      /[（(]\s*(?:二次|三次|重新招标|重新发布|含招标文件|预公示|暂定项目名称)\s*[)）]/g,
      "",
    )
    .replace(/(?:更正|澄清|变更)(?:公告)?$/g, "")
    .replace(
      /(?:公开招标公告|招标预公示|招标文件提前公示|预公示|招标计划|资格预审|中标候选人公示|中标结果|结果公告|招标公告|公开招标|招标|结果)(?:公告)?$/g,
      "",
    )
    .replace(/\b[GX]\d{10,}\b/gi, "")
    .replace(/[\s：:，,。.\-—_（）()]/g, "")
    .trim();
}

function mergeTenderRecords(records) {
  const grouped = new Map();
  for (const record of records) {
    const key = `${record.recordType}|${canonicalProjectKey(record.title)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  return [...grouped.values()].map((group) => {
    const ordered = [...group].sort((a, b) =>
      b.publicationDate.localeCompare(a.publicationDate),
    );
    const latest = ordered[0];
    const amounts = ordered
      .map((record) => record.investmentAmountYuan)
      .filter((value) => Number.isFinite(value) && value > 0);
    const investmentAmountYuan = amounts.length ? Math.max(...amounts) : null;
    const fundsSecured = ordered.some((record) => record.fundsSecured);
    const sources = [];
    for (const record of ordered) {
      for (const source of record.sources || []) {
        if (
          !sources.some(
            (item) => item.key === source.key && item.url === source.url,
          )
        ) {
          sources.push(source);
        }
      }
    }
    const merged = {
      ...latest,
      owner:
        ordered.find((record) => record.owner && record.owner !== "未披露")?.owner ||
        latest.owner,
      overview:
        [...ordered].sort((a, b) => b.overview.length - a.overview.length)[0]
          ?.overview || latest.overview,
      investmentAmountYuan,
      investmentAmount: investmentAmountYuan
        ? titleCaseAmount(investmentAmountYuan)
        : "未披露",
      fundsSecured,
      fundingSource: ordered.some((record) => record.fundingSource),
      recentProgress: latest.recentProgress,
      plannedTenderTime:
        ordered.find((record) => record.plannedTenderBasis === "official-plan")
          ?.plannedTenderTime || latest.plannedTenderTime,
      progressHistory: ordered.map((record) => record.recentProgress),
      sources,
      sourceName: [...new Set(sources.map((source) => source.name))].join("、"),
    };
    const amountQualified =
      investmentAmountYuan && investmentAmountYuan > CONFIG.minInvestmentYuan;
    const amountRejected =
      investmentAmountYuan && investmentAmountYuan <= CONFIG.minInvestmentYuan;
    merged.qualified = Boolean(
      merged.city &&
        merged.industries.length &&
        amountQualified &&
        fundsSecured &&
        !amountRejected,
    );
    merged.pending = Boolean(
      merged.city &&
        merged.industries.length &&
        !amountRejected &&
        (!investmentAmountYuan || !fundsSecured),
    );
    merged.qualificationReasons = [];
    if (!investmentAmountYuan) merged.qualificationReasons.push("投资金额未在正文披露");
    if (amountRejected) merged.qualificationReasons.push("投资金额不高于1.5亿元");
    if (!fundsSecured) merged.qualificationReasons.push("未找到资金已落实的明确表述");
    return merged;
  });
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        results[index] = { error, item: items[index] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function tenderPageUrl(pageNumber) {
  const base = CONFIG.sources.tendersUrl;
  if (pageNumber === 1) return base;
  return base.replace(/jyxxList\.html$/, `${pageNumber}.html`);
}

function parseTenderList(html, pageUrl) {
  const items = [];
  const itemBlocks =
    html.match(
      /<li[^>]+class=["'][^"']*\bewb-com-item\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi,
    ) || [];
  for (const block of itemBlocks) {
    const anchor = block.match(
      /<div[^>]+class=["'][^"']*\bewb-com-block\b[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    const date = block.match(/<span[^>]+class=["'][^"']*\br\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    if (!anchor || !date) continue;
    const title = cleanLine(stripHtml(anchor[2]));
    const publicationDate = parseDateOnly(stripHtml(date[1]));
    if (!title || !publicationDate) continue;
    const url = new URL(decodeHtml(anchor[1]), pageUrl).toString();
    const idMatch = url.match(/\/([0-9a-f-]{20,})\.html/i);
    items.push({
      id: idMatch?.[1] || url,
      title,
      date: publicationDate,
      url,
    });
  }
  return items;
}

function fetchTendersViaPython() {
  const python = findPythonExecutable();
  if (!python) return { ok: false, error: "Python runtime unavailable" };
  const script = path.join(__dirname, "tender_fetch.py");
  const outputPath = path.join(DATA_DIR, "python-tenders.json");
  if (process.env.TENDERS_CACHE === "1" && fs.existsSync(outputPath)) {
    try {
      return JSON.parse(fs.readFileSync(outputPath, "utf8"));
    } catch (error) {
      return { ok: false, error: `招标缓存解析失败：${error.message}` };
    }
  }
  const result = spawnSync(python, [script, ROOT, outputPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
    timeout: 900_000,
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return {
      ok: false,
      error: new TextDecoder("utf-8")
        .decode(result.stderr || [])
        .slice(0, 500),
    };
  }
  try {
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch (error) {
    return { ok: false, error: `招标数据解析失败：${error.message}` };
  }
}

async function fetchTenders() {
  const errors = [];
  let scanned = 0;
  let details = [];
  let approvalItems = [];
  let approvalScanned = 0;
  let sourceStatus = {};
  const pythonFetcher = fetchTendersViaPython();
  if (pythonFetcher.ok) {
    scanned = pythonFetcher.scanned || pythonFetcher.items.length;
    approvalScanned = pythonFetcher.approvalScanned || 0;
    approvalItems = pythonFetcher.approvals || [];
    sourceStatus = pythonFetcher.sourceStatus || {};
    errors.push(...(pythonFetcher.errors || []));
    details = pythonFetcher.items.map((item) => ({
      item,
      text: item.text,
    }));
  } else {
    const listItems = [];
    for (let page = 1; page <= CONFIG.maxTenderPages; page += 1) {
      try {
        const html = await fetchText(tenderPageUrl(page));
        const pageItems = parseTenderList(html, tenderPageUrl(page));
        listItems.push(...pageItems);
      } catch (error) {
        errors.push(`列表第${page}页：${error.message}`);
      }
    }
    const byId = new Map();
    for (const item of listItems) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    const recent = [...byId.values()]
      .filter(
        (item) =>
          isWithinProjectWindow(item.date) && isDesignStageTitle(item.title),
      )
      .slice(0, CONFIG.maxTenderDetails);
    scanned = byId.size;

    details = await mapConcurrent(recent, 3, async (item) => {
      const html = await fetchText(item.url);
      return {
        item,
        text: stripHtml(html),
      };
    });
  }

  const madeRecords = [];
  for (const detail of details) {
    if (!detail || detail.error) {
      errors.push(`${detail?.item?.title || "未知公告"}：${detail?.error?.message || "详情读取失败"}`);
      continue;
    }
    const record = makeTenderRecord(detail.item, detail);
    madeRecords.push(record);
  }
  for (const approvalItem of approvalItems) {
    const record = makeApprovalRecord(approvalItem);
    if (record) madeRecords.push(record);
  }
  const records = mergeTenderRecords(madeRecords).filter(
    (record) => record.qualified || record.pending,
  );

  const cityGroups = CONFIG.cities.map((city) => {
    const cityRecords = records
      .filter((record) => record.city === city)
      .sort((a, b) => {
        const stageCompare =
          Number(a.recordType !== "approval") -
          Number(b.recordType !== "approval");
        if (stageCompare !== 0) return stageCompare;
        const dateCompare = b.publicationDate.localeCompare(a.publicationDate);
        if (dateCompare !== 0) return dateCompare;
        return (b.investmentAmountYuan || 0) - (a.investmentAmountYuan || 0);
      });
    return {
      city,
      qualified: cityRecords.filter((record) => record.qualified),
      pending: cityRecords.filter((record) => record.pending),
      total: cityRecords.length,
    };
  });

  return {
    scanned: scanned + approvalScanned,
    approvalScanned,
    recent: details.length + approvalItems.length,
    qualifiedCount: records.filter((record) => record.qualified).length,
    pendingCount: records.filter((record) => record.pending).length,
    cityGroups,
    qualified: records.filter((record) => record.qualified),
    pending: records.filter((record) => record.pending),
    errors,
    sourceStatus,
    ...(process.env.DEBUG_TENDERS === "1"
      ? {
          debug: madeRecords.map((record) => ({
            title: record.title,
            city: record.city,
            industries: record.industries,
            investmentAmount: record.investmentAmount,
            fundsSecured: record.fundsSecured,
            qualificationReasons: record.qualificationReasons,
          })),
        }
      : {}),
  };
}

function eastmoneyIndexUrl(secids) {
  const params = new URLSearchParams({
    fltt: "2",
    invt: "2",
    fields: "f12,f14,f2,f3,f4,f5,f6,f104,f105,f106",
    secids,
  });
  return `https://push2.eastmoney.com/api/qt/ulist.np/get?${params}`;
}

function eastmoneySectorUrl(ascending = false) {
  const params = new URLSearchParams({
    pn: "1",
    pz: "12",
    po: ascending ? "0" : "1",
    np: "1",
    fltt: "2",
    invt: "2",
    fid: "f3",
    fs: "m:90+t:2+f:!50",
    fields: "f12,f14,f3,f6",
  });
  return `https://push2.eastmoney.com/api/qt/clist/get?${params}`;
}

function eastmoneyBoardStocksUrl(boardCode) {
  const params = new URLSearchParams({
    pn: "1",
    pz: "6",
    po: "1",
    np: "1",
    fltt: "2",
    invt: "2",
    fid: "f3",
    fs: `b:${boardCode}+f:!50`,
    fields: "f12,f14,f2,f3,f6,f8,f10,f20,f62,f100",
  });
  return `https://push2.eastmoney.com/api/qt/clist/get?${params}`;
}

function eastmoneyStocksUrl() {
  const params = new URLSearchParams({
    pn: "1",
    pz: "100",
    po: "1",
    np: "1",
    fltt: "2",
    invt: "2",
    fid: "f3",
    fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
    fields: "f12,f14,f2,f3,f6,f8,f10,f20,f62,f100",
  });
  return `https://push2.eastmoney.com/api/qt/clist/get?${params}`;
}

function eastmoneyHistoryUrl() {
  const params = new URLSearchParams({
    secid: "1.000001",
    klt: "101",
    fqt: "1",
    lmt: "90",
    end: "20500101",
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
  });
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`;
}

function limitPoolUrl(pool, date) {
  const params = new URLSearchParams({
    ut: "7eea3edcaed734bea9cbfc24409ed989",
    dpt: "wz.ztzt",
    Pageindex: "0",
    pagesize: "300",
    sort: pool === "dt" ? "fund:asc" : pool === "yesterday" ? "zs:desc" : "fbt:asc",
    date,
  });
  const endpoint =
    pool === "dt"
      ? "getTopicDTPool"
      : pool === "zb"
        ? "getTopicZBPool"
        : pool === "yesterday"
          ? "getYesterdayZTPool"
          : "getTopicZTPool";
  return `https://push2ex.eastmoney.com/${endpoint}?${params}`;
}

function mainFlowUrl() {
  const params = new URLSearchParams({
    lmt: "5",
    klt: "101",
    secid: "1.000001",
    fields1: "f1,f2,f3,f7",
    fields2: "f51,f52,f53,f54,f55,f56",
  });
  return `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?${params}`;
}

const EASTMONEY_LIVE_NEWS_URL =
  "https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_100_1_.html";

function classifyMarketNews(title) {
  if (/(中国人民银行|中国央行|证监会|国务院|发改委|财政部|降准|降息|PMI|CPI|社融|人民币|金融监管总局)/.test(title)) {
    return "宏观政策";
  }
  if (/(沪指|深成指|创业板|A股|涨停|板块|成交额|主力资金|融资)/.test(title)) {
    return "市场资金";
  }
  if (/(芯片|半导体|人工智能|机器人|新能源|光伏|锂电|算力|军工|汽车|地产|消费)/.test(title)) {
    return "产业主题";
  }
  return "公司动态";
}

async function fetchMarketNews(asOfDate) {
  const text = await fetchText(EASTMONEY_LIVE_NEWS_URL, {
    headers: { Referer: "https://finance.eastmoney.com/" },
  });
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("新闻数据格式异常");
  const payload = JSON.parse(text.slice(start, end + 1));
  const items = payload?.LivesList || [];
  const relevance =
    /(A股|沪指|深成指|创业板|科创板|涨停|跌停|连板|板块|成交额|沪深|两融|融资余额|证监会|国务院|发改委|财政部|中国人民银行|中国央行|降准|降息|PMI|CPI|社融|金融监管总局|北证50)/;
  return items
    .filter(
      (item) =>
        String(item.showtime || "").startsWith(asOfDate) &&
        relevance.test(`${item.title} ${item.digest}`),
    )
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      title: item.title,
      digest: compactExcerpt(item.digest, 120),
      time: item.showtime,
      url: item.url_w || item.url_m,
      category: classifyMarketNews(item.title),
    }));
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function friendlyDataError(error) {
  const message = String(error?.message || error || "");
  if (/EACCES|ECONNRESET|ENETUNREACH|ETIMEDOUT|fetch failed/i.test(message)) {
    return "官方数据源网络连接暂时中断";
  }
  return message || "官方数据源暂时不可用";
}

function isReadableText(value) {
  return !/[\uFFFD锟]/.test(String(value || ""));
}

function readableSectors(items) {
  return (Array.isArray(items) ? items : []).filter((item) =>
    isReadableText(item?.name),
  );
}

function movingAverage(values, period) {
  const slice = values.slice(-period);
  return slice.length === period
    ? slice.reduce((sum, value) => sum + value, 0) / period
    : null;
}

function analyzeTechnical(history) {
  const closes = history.map((item) => item.close);
  const latest = history.at(-1) || {};
  const ma5 = movingAverage(closes, 5);
  const ma20 = movingAverage(closes, 20);
  const ma60 = movingAverage(closes, 60);
  const last20 = history.slice(-20);
  const amount20 = last20.reduce((sum, item) => sum + (item.amount || 0), 0);
  const last5 = history.slice(-5);
  const amount5 = last5.reduce((sum, item) => sum + (item.amount || 0), 0);
  return {
    ma5,
    ma20,
    ma60,
    high20: last20.length ? Math.max(...last20.map((item) => item.high)) : null,
    low20: last20.length ? Math.min(...last20.map((item) => item.low)) : null,
    averageTurnover20: last20.length ? amount20 / last20.length : null,
    averageTurnover5: last5.length ? amount5 / last5.length : null,
    aboveMa20: ma20 && latest.close ? latest.close > ma20 : null,
    aboveMa60: ma60 && latest.close ? latest.close > ma60 : null,
  };
}

function styleSpread(indices) {
  const byCode = Object.fromEntries(indices.map((item) => [item.code, item]));
  const largeCap = byCode["000300"]?.changePct;
  const smallCap = byCode["000852"]?.changePct;
  const megaCap = byCode["000016"]?.changePct;
  const growth = byCode["399006"]?.changePct;
  const spread = Number.isFinite(largeCap) && Number.isFinite(smallCap)
    ? largeCap - smallCap
    : null;
  let label = "风格均衡";
  if (Number.isFinite(spread) && spread >= 0.6) label = "大盘权重相对占优";
  if (Number.isFinite(spread) && spread <= -0.6) label = "中小盘风格相对占优";
  return {
    largeCap,
    smallCap,
    megaCap,
    growth,
    spread,
    label,
  };
}

function buildWatchPoints(technical, breadth, sentiment, style, volumeRatio) {
  const points = [];
  if (technical.ma20 != null) {
    points.push(
      `上证指数20日均线位于${technical.ma20.toFixed(2)}点，当前收盘在均线${technical.aboveMa20 ? "上方" : "下方"}`,
    );
  }
  if (technical.low20 != null) {
    points.push(`近20个交易日低点${technical.low20.toFixed(2)}点，可作为短期区间风险参考`);
  }
  if (volumeRatio != null) {
    const state = volumeRatio >= 1.2 ? "明显放量" : volumeRatio < 0.8 ? "明显缩量" : "量能接近常态";
    points.push(`沪深成交额为20日均值的${volumeRatio.toFixed(2)}倍，${state}`);
  }
  if (breadth.available) {
    const total = breadth.advancing + breadth.declining;
    if (total) {
      points.push(
        `上涨家数占比${((breadth.advancing / total) * 100).toFixed(1)}%，观察次日能否回到50%以上`,
      );
    }
  }
  if (sentiment.available) {
    points.push(
      `炸板率${sentiment.breakRate.toFixed(1)}%、最高${sentiment.highestBoard}连板，观察高位股亏钱效应是否扩散`,
    );
  }
  if (style.spread != null) {
    points.push(`沪深300相对中证1000强弱为${style.spread >= 0 ? "+" : ""}${style.spread.toFixed(2)}个百分点`);
  }
  return points.slice(0, 5);
}

function sectorIndustryPattern(sectorName) {
  if (/电机|机器人|减速器/.test(sectorName)) return /电机|专用设备|通用设备|塑料/;
  if (/百货|零售|商业/.test(sectorName)) return /零售|商业/;
  if (/银行|保险/.test(sectorName)) return /银行|保险/;
  if (/会展|专业服务/.test(sectorName)) return /专业服务/;
  if (/粘胶|氨纶|化纤|纺织/.test(sectorName)) return /化学纤维|纺织/;
  if (/电网|电力/.test(sectorName)) return /电网设备|电力/;
  return null;
}

function sectorMode(sectorName) {
  if (/银行|保险|公用事业|电力/.test(sectorName)) return "防守";
  if (/电机|机器人|通信|算力|半导体|软件/.test(sectorName)) return "进攻";
  return "观察";
}

const SECTOR_FALLBACK_LEADERS = [
  {
    pattern: /电机|机器人|减速器/,
    stocks: [
      ["002249", "大洋电机"],
      ["002196", "方正电机"],
      ["002823", "凯中精密"],
    ],
  },
  {
    pattern: /百货|零售|商业|超市/,
    stocks: [
      ["600838", "上海九百"],
      ["600828", "茂业商业"],
      ["002187", "广百股份"],
    ],
  },
  {
    pattern: /银行|保险/,
    stocks: [
      ["601939", "建设银行"],
      ["601825", "沪农商行"],
      ["601963", "重庆银行"],
    ],
  },
  {
    pattern: /会展|专业服务/,
    stocks: [
      ["600826", "兰生股份"],
      ["300860", "锋尚文化"],
    ],
  },
  {
    pattern: /粘胶|氨纶|化纤|纺织/,
    stocks: [
      ["000949", "新乡化纤"],
      ["000420", "吉林化纤"],
      ["300877", "金春股份"],
    ],
  },
  {
    pattern: /电网|电力/,
    stocks: [
      ["301361", "众智科技"],
      ["002300", "太阳电缆"],
    ],
  },
  {
    pattern: /通信|算力/,
    stocks: [
      ["300504", "天邑股份"],
      ["301314", "科瑞思"],
    ],
  },
];

function fallbackSectorLeaders(sectorName) {
  const group = SECTOR_FALLBACK_LEADERS.find((item) =>
    item.pattern.test(sectorName),
  );
  if (!group) return [];
  return group.stocks.map(([code, name], index) => ({
    code,
    name,
    price: null,
    changePct: null,
    turnover: null,
    role: index === 0 ? "关注龙头" : "关注前排",
  }));
}

function stockOperationPlan(stock, index, mode) {
  const previousClose =
    Number.isFinite(stock.price) && Number.isFinite(stock.changePct)
      ? stock.price / (1 + stock.changePct / 100)
      : null;
  const previousCloseText = previousClose
    ? `昨收 ${previousClose.toFixed(2)} 元`
    : "昨收";
  if (mode === "防守") {
    return {
      entry:
        index === 0
          ? "不追急拉，观察指数走弱时能否回踩承接；板块保持红盘才看。"
          : "只跟随防守龙头，龙头维持强势后再看低吸，不主动追涨。",
      invalidation: `跌破${previousCloseText}或银行板块转绿，取消关注。`,
    };
  }
  if (index === 0) {
    return {
      entry:
        "不追高开超过5%；10:00后仍站稳分时均价、板块至少2只红盘，才考虑小仓试错。",
      invalidation: `跌破${previousCloseText}、分时均价或板块转绿，放弃。`,
    };
  }
  if (index === 1) {
    return {
      entry:
        "先等龙头维持强势，再看前排承接；不主动猜板、不接高开秒板。",
      invalidation: "龙头炸板或本股跌破分时均价，取消关注。",
    };
  }
  return {
    entry:
      "只做板块扩散后的低位补涨，不追连续加速，优先观察成交是否持续放大。",
    invalidation: "龙头转弱、板块红盘少于2只或本股跌破昨收，取消。",
  };
}

function buildMarketTradingPlan(market) {
  const totalBreadth =
    market.breadth.advancing + market.breadth.declining + market.breadth.flat;
  const upRatio = totalBreadth ? market.breadth.advancing / totalBreadth : 0.5;
  const mainIndices = market.indices.filter((item) =>
    ["000001", "399001", "399006", "000688", "000300", "000852"].includes(
      item.code,
    ),
  );
  const indexAverage =
    mainIndices.reduce((sum, item) => sum + (item.changePct || 0), 0) /
    Math.max(mainIndices.length, 1);
  const weak =
    upRatio < 0.4 ||
    (indexAverage < -0.35 && (market.volumeRatio || 0) > 1.15);
  const strong =
    upRatio > 0.55 &&
    indexAverage > 0.25 &&
    market.technical?.aboveMa20 === true;
  const regime = weak ? "防守优先" : strong ? "积极试错" : "震荡确认";
  const positionGuide = weak ? "0%—30%" : strong ? "40%—70%" : "20%—50%";

  const usedGroups = new Set();
  const mainlines = [];
  for (const sector of market.topSectors.slice(0, 10)) {
    if (!Number.isFinite(sector.changePct) || sector.changePct <= 0) continue;
    const groupKey = /银行|保险/.test(sector.name)
      ? "银行保险"
      : /电机|机器人|减速器/.test(sector.name)
        ? "电机机器人"
        : /百货|零售|商业|超市/.test(sector.name)
          ? "消费零售"
          : /粘胶|氨纶|化纤|纺织/.test(sector.name)
            ? "化纤纺织"
            : sector.name.replace(/[ⅡⅢ]/g, "").trim();
    if (usedGroups.has(groupKey)) continue;
    usedGroups.add(groupKey);
    const displayName = {
      银行保险: "银行防守",
      电机机器人: "电机机器人",
      消费零售: "消费零售",
      化纤纺织: "化纤纺织",
    }[groupKey] || sector.name.replace(/[ⅡⅢ]/g, "").trim();

    const directLeaders = market.sectorLeaders?.[sector.code] || [];
    const industryPattern = sectorIndustryPattern(sector.name);
    const industryLeaders =
      industryPattern && market.topStocks?.length
        ? market.topStocks.filter(
            (stock) =>
              industryPattern.test(stock.industry || "") &&
              Number.isFinite(stock.changePct) &&
              stock.changePct > 0,
          )
        : [];
    const byCode = new Map();
    for (const stock of [...directLeaders, ...industryLeaders]) {
      if (!stock?.code || byCode.has(stock.code)) continue;
      byCode.set(stock.code, stock);
    }
    let candidateStocks = [...byCode.values()]
      .sort(
        (left, right) =>
          (right.changePct || 0) - (left.changePct || 0) ||
          (right.turnover || 0) - (left.turnover || 0),
      )
      .slice(0, 3);
    if (!candidateStocks.length) {
      candidateStocks = fallbackSectorLeaders(sector.name);
    }
    const leaders = candidateStocks.map((stock, index) => ({
      code: stock.code,
      name: stock.name,
      changePct: stock.changePct,
      turnover: stock.turnover,
      role:
        stock.role ||
        (index === 0 ? "龙头候选" : index === 1 ? "前排" : "跟风"),
      ...stockOperationPlan(stock, index, sectorMode(sector.name)),
    }));
    if (!leaders.length && sector.changePct < 2) continue;
    mainlines.push({
      name: displayName,
      changePct: sector.changePct,
      mode: sectorMode(sector.name),
      leaders,
      score:
        sector.changePct +
        leaders.length * 0.25 +
        (weak && sectorMode(sector.name) === "防守" ? 0.8 : 0) +
        (!weak && sectorMode(sector.name) === "进攻" ? 0.5 : 0),
    });
  }
  mainlines.sort((left, right) => right.score - left.score);

  const latestDay = market.history?.at(-1) || {};
  const shanghai = market.indices.find((item) => item.code === "000001");
  const todayLow = Number.isFinite(latestDay.low)
    ? `今日低点 ${latestDay.low.toFixed(2)} 点`
    : "前一交易日低点";
  const entryConditions = [
    `上证指数不跌破${todayLow}，且10:00后上涨家数回到2500只以上，才考虑小仓试错。`,
    "只在涨幅居前且成交额靠前的主线中选1—2只，高开超过5%的股票不追。",
    "板块内至少2只个股保持红盘，龙头站稳分时均价后再确认。",
  ];
  const invalidConditions = [
    `上证指数跌破${todayLow}并继续放量。`,
    "上涨家数少于1800只，下跌家数继续扩大到3500只以上。",
    "候选龙头上半场跌破昨收，且板块由红转绿。",
  ];
  const avoidSectors = market.laggingSectors
    .slice(0, 4)
    .map((sector) => sector.name);
  return {
    asOfDate: market.asOfDate,
    regime,
    positionGuide,
    upRatio,
    indexAverage,
    riskLevel:
      upRatio < 0.3 || indexAverage < -1.5
        ? "高"
        : weak
          ? "较高"
          : strong
            ? "中低"
            : "中",
    summary:
      weak
        ? "市场处于弱势放量阶段，先控制回撤，只做最强主线中的前排机会。"
        : strong
          ? "指数、广度和主线共振，可逐步提高仓位，但仍以龙头确认为前提。"
          : "多空分歧较大，等待指数与上涨家数共同确认后再增加仓位。",
    mainlines: mainlines.slice(0, 5),
    entryConditions,
    invalidConditions,
    avoidSectors,
    framework: [
      "市场环境：指数趋势、成交额、市场广度与大小盘风格",
      "情绪周期：涨停跌停、炸板率、连板高度与昨日涨停溢价",
      "资金主线：板块涨幅、成交额与持续性",
      "龙头梯队：龙头候选、前排、跟风股的相对强弱",
      "次日执行：触发条件、失效条件、仓位纪律",
    ],
    disclaimer:
      "仅按公开行情生成条件式复盘，不构成投资建议；盘中数据会变化。",
    positionAnchor: shanghai?.price || null,
  };
}

function marketNarrative(
  indices,
  breadth,
  topSectors,
  laggingSectors,
  sentiment,
  technical,
  style,
  mainFlow,
) {
  const avg =
    indices.reduce((sum, item) => sum + (item.changePct || 0), 0) /
    Math.max(indices.length, 1);
  const breadthRate =
    breadth.advancing + breadth.declining > 0
      ? breadth.advancing / (breadth.advancing + breadth.declining)
      : 0.5;
  let tone = "震荡分化";
  if (avg >= 0.45 && breadthRate >= 0.52) tone = "整体偏强";
  if (avg <= -0.45 || breadthRate <= 0.38) tone = "整体偏弱";
  if (avg >= 0 && breadthRate < 0.45) tone = "指数与个股分化";
  if (avg < 0 && breadthRate >= 0.52) tone = "指数承压、个股活跃";

  const indexText = indices
    .slice(0, 4)
    .map((item) => `${item.name}${item.changePct >= 0 ? "涨" : "跌"}${Math.abs(item.changePct).toFixed(2)}%`)
    .join("，");
  const breadthText =
    breadth.available === false
      ? "涨跌家数暂不可用"
      : `${breadth.advancing}只上涨、${breadth.declining}只下跌` +
        (breadth.flat ? `、${breadth.flat}只平盘` : "");
  const sectorText = topSectors.length
    ? `领涨行业为${topSectors
        .slice(0, 3)
        .map((item) => `${item.name}${item.changePct >= 0 ? "+" : ""}${item.changePct.toFixed(2)}%`)
        .join("、")}`
    : "行业数据暂不可用";
  const laggingText = laggingSectors.length
    ? `，表现靠后的行业包括${laggingSectors
        .slice(0, 2)
        .map((item) => item.name)
        .join("、")}`
    : "";
  const sentimentText = sentiment.available
    ? `涨停${sentiment.limitUp}只、跌停${sentiment.limitDown}只` +
      `，炸板率${sentiment.breakRate == null ? "未知" : `${sentiment.breakRate.toFixed(1)}%`}` +
      `，最高${sentiment.highestBoard}连板`
    : "涨跌停生态数据暂不可用";
  const fundText =
    mainFlow?.mainNet != null
      ? `，主力资金净${mainFlow.mainNet >= 0 ? "流入" : "流出"}${Math.abs(mainFlow.mainNet / 100_000_000).toFixed(1)}亿元`
      : "";
  const technicalText =
    technical.ma20 != null
      ? `；上证指数收于20日均线${technical.aboveMa20 ? "上方" : "下方"}`
      : "";
  return `${tone}。${indexText}；全市场${breadthText}。${sentimentText}${fundText}。${style.label}，沪深300与中证1000日涨幅差${style.spread == null ? "未知" : `${style.spread >= 0 ? "+" : ""}${style.spread.toFixed(2)}个百分点`}。${sectorText}${laggingText}${technicalText}。`;
}

async function fetchTencentBase() {
  const quoteSymbols = [
    "sh000001",
    "sz399001",
    "sz399006",
    "sh000688",
    "sh000300",
    "sh000905",
    "sh000852",
    "sh000016",
    "bj899050",
  ];
  const quoteText = await fetchText(
    `https://qt.gtimg.cn/q=${quoteSymbols.map((symbol) => `s_${symbol}`).join(",")}`,
    { headers: { Referer: "https://gu.qq.com/" } },
  );
  const quoteMap = {};
  for (const match of quoteText.matchAll(/v_s_(\w+)="([^"]*)";/g)) {
    const fields = match[2].split("~");
    quoteMap[match[1]] = {
      code: fields[2],
      name: fields[1],
      price: numberOrNull(Number(fields[3])),
      change: numberOrNull(Number(fields[4])),
      changePct: numberOrNull(Number(fields[5])),
      volume: numberOrNull(Number(fields[6])),
      turnover: Number.isFinite(Number(fields[7]))
        ? Number(fields[7]) * 10_000
        : null,
    };
  }
  const indices = quoteSymbols
    .map((symbol) => quoteMap[symbol])
    .filter(Boolean);

  const historyText = await fetchText(
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=sh000001,day,,,90,qfq",
    { headers: { Referer: "https://gu.qq.com/" } },
  );
  const historyPayload = JSON.parse(historyText);
  const historyRows = historyPayload?.data?.sh000001?.day || [];
  const history = historyRows.map((row, index) => {
    const previousClose = index > 0 ? Number(historyRows[index - 1][2]) : Number(row[1]);
    return {
      date: row[0],
      open: Number(row[1]),
      close: Number(row[2]),
      high: Number(row[3]),
      low: Number(row[4]),
      volume: Number(row[5]),
      amplitude: Number(row[7]),
      amount: Number(row[8]) * 10_000,
      changePct: previousClose
        ? ((Number(row[2]) / previousClose) - 1) * 100
        : null,
    };
  });
  return {
    indices,
    history,
    asOfDate: history.at(-1)?.date || localDateKey(),
    sourceName: "腾讯证券公开行情",
    sourceUrl: "https://gu.qq.com/",
  };
}

function findPythonExecutable() {
  const fixedPython =
    "D:\\AI\\Deepseek\\resources\\runtime\\primary-runtime\\dependencies\\python\\python.exe";
  if (fs.existsSync(fixedPython)) return fixedPython;
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

function fetchMarketExtensions(asOfDate) {
  const script = path.join(__dirname, "market_extensions.py");
  const executable = findPythonExecutable();
  if (!executable) return { __error: "Python runtime unavailable" };
  const outputPath = path.join(DATA_DIR, "market-extensions.json");
  const result = spawnSync(executable, [script, asOfDate, outputPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
  });
  if (result.error) return { __error: result.error.message };
  if (result.status !== 0) {
    const stderr = result.stderr
      ? new TextDecoder("utf-8").decode(result.stderr)
      : `Python exited ${result.status}`;
    return {
      __error: stderr.slice(0, 500),
    };
  }
  try {
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch (error) {
    return { __error: `扩展行情解析失败：${error.message}` };
  }
}

function runMonthlyExcelExport() {
  const python = findPythonExecutable();
  if (!python) return { ok: false, error: "Python runtime unavailable" };
  const script = path.join(__dirname, "excel_export.py");
  const result = spawnSync(python, [script, ROOT], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return {
      ok: false,
      error: new TextDecoder("utf-8")
        .decode(result.stderr || [])
        .slice(0, 500),
    };
  }
  return { ok: true };
}

async function fetchMarket() {
  async function optionalJson(url) {
    try {
      return await fetchJson(url);
    } catch (error) {
      return { __error: error.message };
    }
  }

  const base = await fetchTencentBase();
  const asOfDate = base.asOfDate;
  const poolDate = asOfDate.replaceAll("-", "");
  const indices = base.indices;
  const history = base.history;
  const shanghai = indices.find((item) => item.code === "000001");
  const shenzhen = indices.find((item) => item.code === "399001");
  const turnover = (shanghai?.turnover || 0) + (shenzhen?.turnover || 0);

  const extensions = fetchMarketExtensions(asOfDate);
  const breadthAvailable = extensions.breadth?.available === true;
  const breadth = {
    advancing: Number(extensions.breadth?.advancing || 0),
    declining: Number(extensions.breadth?.declining || 0),
    flat: Number(extensions.breadth?.flat || 0),
    available: breadthAvailable,
  };
  const topSectors = readableSectors(extensions.topSectors);
  const laggingSectors = readableSectors(extensions.laggingSectors);
  const extensionErrors = Array.isArray(extensions.errors)
    ? extensions.errors
    : extensions.__error
      ? [extensions.__error]
      : [];
  const stockPayload = await optionalJson(eastmoneyStocksUrl());
  const sectorLeaderEntries = await mapConcurrent(
    topSectors.slice(0, 8),
    2,
    async (sector) => {
      const payload = await optionalJson(eastmoneyBoardStocksUrl(sector.code));
      if (payload.__error) {
        extensionErrors.push(`板块成分 ${sector.name}: ${payload.__error}`);
        return [sector.code, []];
      }
      const leaders = (payload?.data?.diff || []).slice(0, 4).map((row) => ({
        code: row.f12,
        name: row.f14,
        price: numberOrNull(row.f2),
        changePct: numberOrNull(row.f3),
        turnover: numberOrNull(row.f6),
        turnoverRate: numberOrNull(row.f8),
        marketCap: numberOrNull(row.f20),
        mainNet: numberOrNull(row.f62),
        industry: row.f100 || "",
      }));
      return [sector.code, leaders];
    },
  );
  const sectorLeaders = {
    ...(extensions.sectorLeaders || {}),
    ...Object.fromEntries(sectorLeaderEntries.filter((entry) => !entry?.error)),
  };
  const limitUpPool = Array.isArray(extensions.limitUp) ? extensions.limitUp : [];
  const limitDownPool = Array.isArray(extensions.limitDown)
    ? extensions.limitDown
    : [];
  const brokenPool = Array.isArray(extensions.broken) ? extensions.broken : [];
  const yesterdayPool = Array.isArray(extensions.yesterday)
    ? extensions.yesterday
    : [];
  const hasExtensionError = (name) =>
    extensionErrors.some((message) => String(message).startsWith(`${name}:`));
  let news = [];
  try {
    news = await fetchMarketNews(asOfDate);
  } catch {
    news = [];
  }

  const directStockRows = stockPayload?.data?.diff || [];
  const topStocks = directStockRows.length
    ? directStockRows.map((row) => ({
        code: row.f12,
        name: row.f14,
        price: numberOrNull(row.f2),
        changePct: numberOrNull(row.f3),
        turnover: numberOrNull(row.f6),
        turnoverRate: numberOrNull(row.f8),
        marketCap: numberOrNull(row.f20),
        mainNet: numberOrNull(row.f62),
        industry: row.f100 || "",
      }))
    : Array.isArray(extensions.topStocks)
      ? extensions.topStocks
      : [];
  const boardCounts = {};
  for (const item of limitUpPool) {
    const board = Number(item.lbc || 1);
    boardCounts[board] = (boardCounts[board] || 0) + 1;
  }
  const limitAvailable =
    !hasExtensionError("limitUp") &&
    !hasExtensionError("limitDown") &&
    !hasExtensionError("broken");
  const yesterdayAvailable =
    !hasExtensionError("yesterday") && yesterdayPool.length > 0;
  const sentiment = {
    available: limitAvailable,
    yesterdayAvailable,
    limitUp: limitUpPool.length,
    limitDown: limitDownPool.length,
    broken: brokenPool.length,
    breakRate:
      limitAvailable && limitUpPool.length + brokenPool.length > 0
        ? (brokenPool.length / (limitUpPool.length + brokenPool.length)) * 100
        : null,
    highestBoard: limitUpPool.length
      ? Math.max(...limitUpPool.map((item) => Number(item.lbc || 1)))
      : 0,
    multiBoard: limitUpPool.filter((item) => Number(item.lbc || 1) >= 2).length,
    boardCounts,
    yesterdayAverage:
      yesterdayPool.length > 0
        ? yesterdayPool.reduce((sum, item) => sum + Number(item.zdp || 0), 0) /
          yesterdayPool.length
        : null,
    yesterdayUpRatio:
      yesterdayPool.length > 0
        ? yesterdayPool.filter((item) => Number(item.zdp || 0) > 0).length /
          yesterdayPool.length
        : null,
    topBoards: [...limitUpPool]
      .sort((a, b) => Number(b.lbc || 1) - Number(a.lbc || 1))
      .slice(0, 8)
      .map((item) => ({
        code: item.c,
        name: item.n,
        board: Number(item.lbc || 1),
        changePct: Number(item.zdp || 0),
        industry: item.hybk,
      })),
  };

  const mainFlow = extensions.mainFlow?.mainNet != null ? extensions.mainFlow : null;
  const technical = analyzeTechnical(history);
  const style = styleSpread(indices);
  const volumeRatio =
    technical.averageTurnover20 && turnover
      ? turnover / technical.averageTurnover20
      : null;
  const watchPoints = buildWatchPoints(
    technical,
    breadth,
    sentiment,
    style,
    volumeRatio,
  );
  const dataQuality = {
    breadth: breadthAvailable,
    limitPools: limitAvailable,
    yesterdayLimitUp: yesterdayAvailable,
    sectors: topSectors.length > 0 && laggingSectors.length > 0,
    mainFlow: mainFlow !== null,
    news: news.length > 0,
  };
  const market = {
    asOfDate,
    indices,
    breadth,
    turnover,
    topSectors,
    laggingSectors,
    topStocks,
    sectorLeaders,
    history: history.slice(-30),
    history90: history,
    sentiment,
    mainFlow,
    news,
    technical,
    style,
    volumeRatio,
    watchPoints,
    dataQuality,
    recap: marketNarrative(
      indices,
      breadth,
      topSectors,
      laggingSectors,
      sentiment,
      technical,
      style,
      mainFlow,
    ),
    sourceName: "腾讯证券 + 东方财富公开行情",
    sourceUrl: "https://gu.qq.com/",
    extensionErrors,
    unavailable: false,
  };
  market.tradingPlan = buildMarketTradingPlan(market);
  return market;
}

function mergeMarketSnapshot(current, previous) {
  if (
    current.unavailable &&
    previous &&
    previous.asOfDate === current.asOfDate &&
    previous.indices?.length
  ) {
    const merged = structuredClone(previous);
    merged.error = current.error;
    merged.unavailable = false;
    merged.staleFields = [
      ...new Set([...(merged.staleFields || []), "整体行情"]),
    ];
    merged.tradingPlan = buildMarketTradingPlan(merged);
    return merged;
  }
  if (!previous || previous.asOfDate !== current.asOfDate) return current;
  const merged = structuredClone(current);
  const staleFields = [];
  if (merged.breadth?.available === false && previous.breadth?.available) {
    merged.breadth = { ...previous.breadth, stale: true };
    staleFields.push("市场广度");
  }
  const previousTopSectors = readableSectors(previous.topSectors);
  const previousLaggingSectors = readableSectors(previous.laggingSectors);
  if (!merged.topSectors?.length && previousTopSectors.length) {
    merged.topSectors = previousTopSectors;
    merged.laggingSectors = previousLaggingSectors;
    staleFields.push("行业排行");
  }
  if (!merged.sentiment?.available && previous.sentiment?.available) {
    merged.sentiment = { ...previous.sentiment, stale: true };
    staleFields.push("涨跌停生态");
  }
  if (!merged.mainFlow && previous.mainFlow) {
    merged.mainFlow = { ...previous.mainFlow, stale: true };
    staleFields.push("主力资金");
  }
  if (!merged.news?.length && previous.news?.length) {
    merged.news = previous.news;
    staleFields.push("消息面");
  }
  if (
    merged.technical?.ma20 == null &&
    previous.technical?.ma20 != null
  ) {
    merged.technical = { ...previous.technical, stale: true };
    staleFields.push("技术位置");
  }
  if (merged.style?.spread == null && previous.style?.spread != null) {
    merged.style = { ...previous.style, stale: true };
    staleFields.push("市场风格");
  }
  if (merged.volumeRatio == null && previous.volumeRatio != null) {
    merged.volumeRatio = previous.volumeRatio;
    staleFields.push("成交额比较");
  }
  merged.dataQuality = {
    breadth: merged.breadth?.available === true,
    limitPools: merged.sentiment?.available === true,
    yesterdayLimitUp: merged.sentiment?.yesterdayAvailable === true,
    sectors: merged.topSectors?.length > 0,
    mainFlow: merged.mainFlow?.mainNet != null,
    news: merged.news?.length > 0,
  };
  merged.staleFields = staleFields;
  merged.watchPoints = buildWatchPoints(
    merged.technical,
    merged.breadth,
    merged.sentiment || { available: false },
    merged.style,
    merged.volumeRatio,
  );
  merged.recap = marketNarrative(
    merged.indices,
    merged.breadth,
    merged.topSectors,
    merged.laggingSectors,
    merged.sentiment || {
      available: false,
      limitUp: 0,
      limitDown: 0,
      breakRate: null,
      highestBoard: 0,
    },
    merged.technical,
    merged.style,
    merged.mainFlow,
  );
  merged.tradingPlan = buildMarketTradingPlan(merged);
  return merged;
}

function fallbackMarket(error) {
  const emptyIndices = ["上证指数", "深证成指", "创业板指", "科创50"].map((name) => ({
    name,
    code: "",
    price: null,
    changePct: 0,
    change: null,
    turnover: 0,
  }));
  return {
    asOfDate: localDateKey(),
    indices: emptyIndices,
    breadth: { advancing: 0, declining: 0, flat: 0, available: false },
    turnover: 0,
    topSectors: [],
    laggingSectors: [],
    topStocks: [],
    history: [],
    history90: [],
    news: [],
    sentiment: {
      available: false,
      yesterdayAvailable: false,
      limitUp: 0,
      limitDown: 0,
      broken: 0,
      breakRate: null,
      highestBoard: 0,
      multiBoard: 0,
      boardCounts: {},
      yesterdayAverage: null,
      yesterdayUpRatio: null,
      topBoards: [],
    },
    mainFlow: null,
    technical: {
      ma5: null,
      ma20: null,
      ma60: null,
      high20: null,
      low20: null,
      averageTurnover20: null,
      averageTurnover5: null,
      aboveMa20: null,
      aboveMa60: null,
    },
    style: {
      largeCap: null,
      smallCap: null,
      megaCap: null,
      growth: null,
      spread: null,
      label: "风格暂时不可用",
    },
    volumeRatio: null,
    watchPoints: [],
    recap: "行情接口暂时不可用，稍后刷新即可。",
    sourceName: CONFIG.sources.market,
    sourceUrl: "https://quote.eastmoney.com/",
    unavailable: true,
    dataQuality: {
      breadth: false,
      limitPools: false,
      sectors: false,
      mainFlow: false,
      news: false,
    },
    error: error.message,
  };
}

function readLatest() {
  try {
    return JSON.parse(fs.readFileSync(LATEST_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function refreshData({ includeTenders = true, includeMarket = true } = {}) {
  ensureDirectories();
  const startedAt = new Date();
  const previous = readLatest();
  const [tenders, marketResult] = await Promise.allSettled([
    includeTenders ? fetchTenders() : Promise.resolve(null),
    includeMarket ? fetchMarket() : Promise.resolve(null),
  ]);
  const emptyTenderResult = {
          scanned: 0,
          recent: 0,
          qualifiedCount: 0,
          pendingCount: 0,
          cityGroups: CONFIG.cities.map((city) => ({
            city,
            qualified: [],
            pending: [],
            total: 0,
          })),
          qualified: [],
          pending: [],
      errors: includeTenders
        ? [tenders.reason?.message || String(tenders.reason)]
        : [],
        };
  const tenderResult =
    !includeTenders
      ? previous?.tenders || emptyTenderResult
      : tenders.status === "fulfilled" &&
    (tenders.value.scanned > 0 || !previous?.tenders)
      ? tenders.value
      : previous?.tenders
        ? {
            ...previous.tenders,
            errors: [
              ...(previous.tenders.errors || []),
              ...(tenders.status === "rejected"
                ? [friendlyDataError(tenders.reason)]
                : tenders.value.errors || []),
              "网络异常，已保留最近一次工程项目数据",
            ],
          }
        : emptyTenderResult;
  let market = includeMarket
    ? marketResult.status === "fulfilled"
      ? marketResult.value
      : fallbackMarket(marketResult.reason)
    : previous?.market || fallbackMarket(new Error("市场行情尚未初始化"));
  market = mergeMarketSnapshot(market, previous?.market);
  const summary = {
    generatedAt: startedAt.toISOString(),
    generatedAtLocal: localDateTime(startedAt),
    dateLabel: localDateKey(startedAt),
    notificationTime: CONFIG.notificationTime,
    engineeringReminderTime: CONFIG.engineeringReminderTime,
    engineeringReminderWeekday: CONFIG.engineeringReminderWeekday,
    modules: CONFIG.modules || [],
    cities: CONFIG.cities,
    industries: CONFIG.industries.map((industry) => industry.name),
    minInvestmentYuan: CONFIG.minInvestmentYuan,
    lookbackDays: CONFIG.lookbackDays,
    projectStartDate: CONFIG.projectStartDate,
    tenders: tenderResult,
    market,
    sources: CONFIG.sources,
  };
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  fs.writeFileSync(LATEST_PATH, serialized, "utf8");
  fs.writeFileSync(
    path.join(HISTORY_DIR, `${summary.dateLabel.replaceAll("-", "")}.json`),
    serialized,
    "utf8",
  );
  fs.writeFileSync(
    path.join(ROOT, "fallback-data.js"),
    `window.PRIVATE_SECRETARY_FALLBACK = ${JSON.stringify(summary)};\n`,
    "utf8",
  );
  if (includeTenders) {
    const excelExport = runMonthlyExcelExport();
    if (!excelExport.ok) {
      console.error(`月度 Excel 生成失败：${excelExport.error || "未知错误"}`);
    }
  }
  return summary;
}

module.exports = {
  CONFIG,
  ROOT,
  DATA_DIR,
  LATEST_PATH,
  buildMarketTradingPlan,
  ensureDirectories,
  fetchMarket,
  fetchMarketExtensions,
  fetchTenders,
  isDesignStageTitle,
  localDateKey,
  localDateTime,
  readLatest,
  refreshData,
  titleCaseAmount,
};
