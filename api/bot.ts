/**
 * 《守望先锋 2》(OW2) 国服战绩查询 Telegram 机器人（独立部署版）
 * 运行环境：Vercel Serverless Functions (Node.js 20+ / TypeScript)
 * 机器人框架：grammY (Webhook 模式)
 * 数据来源：网易大神上游接口 (datamsapi.ds.163.com)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Bot, Context, InlineKeyboard, webhookCallback } from "grammy";

// ============================================================================
// 1. 环境配置与常量定义
// ============================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const DASHEN_ROLE_ID = Number(process.env.DASHEN_ROLE_ID || "0");
const DASHEN_TOKEN = (process.env.DASHEN_TOKEN || "").trim();
const DASHEN_DTS = Number(process.env.DASHEN_DTS || "2026");
const DASHEN_SERVER = Number(process.env.DASHEN_SERVER || "1");
const DASHEN_CLIENT_TYPE = process.env.DASHEN_CLIENT_TYPE || "50";
const DASHEN_ORIGIN = process.env.DASHEN_ORIGIN || "https://ds.163.com";
const DASHEN_REFERER = process.env.DASHEN_REFERER || "https://ds.163.com/";
const DASHEN_USER_AGENT =
  process.env.DASHEN_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DASHEN_API_ROOT = "https://datamsapi.ds.163.com/v1/a19ld5tool";
const DASHEN_CUSTOMER_API_BASE = `${DASHEN_API_ROOT}/customer`;
const SEARCH_BNET_ACCOUNT_URL = `${DASHEN_API_ROOT}/searchBnetAccount`;

const API_TIMEOUT_MS = 12_000;

if (!BOT_TOKEN) {
  throw new Error("缺少环境变量 BOT_TOKEN，请在 Vercel 项目设置中配置。");
}

type CnGameMode = "sport" | "leisure";

interface DashenResponse<T = any> {
  code?: number;
  msg?: string;
  message?: string;
  data?: T;
  result?: T;
  [key: string]: any;
}

// ============================================================================
// 2. 网易大神 HTTP 客户端（严格对齐 apiclient.py）
// ============================================================================

class DashenError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "DashenError";
  }
}

function ensureDashenCredentials(): void {
  if (!DASHEN_ROLE_ID || !DASHEN_TOKEN) {
    throw new DashenError(
      500,
      "⚠️ 服务端尚未配置网易大神凭证（<code>DASHEN_ROLE_ID</code> / <code>DASHEN_TOKEN</code>），请先在 Vercel 环境变量中填写并重新部署。"
    );
  }
}

function buildAuthHeaders(): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "GL-Bigdata-Auth-Token": DASHEN_TOKEN,
    "GL-Bigdata-Dts": String(DASHEN_DTS),
    "GL-Bigdata-Role-Id": String(DASHEN_ROLE_ID),
    "GL-Bigdata-Server": String(DASHEN_SERVER),
    "GL-ClientType": DASHEN_CLIENT_TYPE,
    Origin: DASHEN_ORIGIN,
    Referer: DASHEN_REFERER,
    "User-Agent": DASHEN_USER_AGENT,
  };
}

async function dashenRequest<T = any>(
  method: "GET" | "POST",
  urlStr: string,
  options?: {
    params?: Record<string, string | number | undefined>;
    json?: Record<string, any>;
  }
): Promise<DashenResponse<T>> {
  ensureDashenCredentials();

  const url = new URL(urlStr);
  if (options?.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers = buildAuthHeaders();
  let body: string | undefined;
  if (method === "POST" && options?.json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    throw new DashenError(
      504,
      isTimeout
        ? "⏳ 请求网易大神接口超时，请稍后重试（建议在 Vercel 设置将 Function Region 改为香港 hkg1 或新加坡 sin1）。"
        : "🌐 网络异常，无法连接至网易大神接口。"
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new DashenError(
      response.status,
      "🔐 网易大神鉴权失败（HTTP 401/403），可能是 <code>DASHEN_TOKEN</code> 已过期，请重新登录网易大神网页版提取更新。"
    );
  }

  let payload: DashenResponse<T>;
  try {
    payload = (await response.json()) as DashenResponse<T>;
  } catch {
    throw new DashenError(
      response.status,
      `❌ 网易大神返回非 JSON 内容 (HTTP ${response.status})，可能触发了风控拦截。`
    );
  }

  if (!response.ok) {
    const reason = payload.msg || payload.message || `HTTP ${response.status}`;
    throw new DashenError(
      response.status,
      `❌ 上游接口错误：${escapeHtml(String(reason))}`
    );
  }

  if (
    typeof payload.code === "number" &&
    payload.code !== 0 &&
    payload.code !== 200
  ) {
    const reason = payload.msg || payload.message || `错误码 ${payload.code}`;
    throw new DashenError(
      400,
      `⚠️ 网易大神返回异常（code=${payload.code}）：${escapeHtml(String(reason))}`
    );
  }

  return payload;
}

/** 1. 搜索国服战网账号并解析 customer_token */
async function searchBnetAccount(bnet: string): Promise<DashenResponse> {
  const normalized = bnet.replace("＃", "#").trim();
  return dashenRequest("POST", SEARCH_BNET_ACCOUNT_URL, {
    json: {
      token: DASHEN_TOKEN,
      roleId: DASHEN_ROLE_ID,
      dts: DASHEN_DTS,
      server: DASHEN_SERVER,
      name: normalized,
    },
  });
}

/** 2. 查询玩家基础名片与段位 */
async function queryCard(customerToken: string): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryCard`, {
    params: { token: customerToken },
  });
}

/** 3. 查询玩家赛季统计汇总 */
async function queryCountInfo(
  customerToken: string,
  gameMode: CnGameMode
): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryCountInfo`, {
    params: { gameMode, token: customerToken },
  });
}

/** 4. 查询玩家近期战绩列表 */
async function queryMatchList(
  customerToken: string,
  gameMode: CnGameMode,
  page = 1
): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryMatchList`, {
    params: { token: customerToken, gameMode, page },
  });
}

/** 5. 查询单场对局详情 */
async function queryMatchInfo(
  customerToken: string,
  matchId: string
): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryMatchInfo`, {
    params: { matchId, token: customerToken },
  });
}

// ============================================================================
// 3. 数据提取与格式化工具（高容错解析网易大神动态字段）
// ============================================================================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isSafeCallbackData(data: string): boolean {
  return Buffer.byteLength(data, "utf8") <= 64;
}

/** 从嵌套对象中按候选 Key 列表提取第一个非空值 */
function pickField(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return undefined;
}

/** 兼容拆包 data / result */
function unwrapData(res: DashenResponse): any {
  if (!res || typeof res !== "object") return res;
  return res.data ?? res.result ?? res;
}

interface ResolvedPlayer {
  bnet: string;
  customerToken: string;
  nickname: string;
  raw: any;
}

/** 从 searchBnetAccount 响应中提取最匹配的国服账号与 customer_token */
function extractPlayerFromSearch(
  bnetInput: string,
  res: DashenResponse
): ResolvedPlayer {
  const body = unwrapData(res);
  const candidates: any[] = [];

  if (Array.isArray(body)) {
    candidates.push(...body);
  } else if (body && typeof body === "object") {
    const list =
      body.list || body.records || body.accounts || body.items || body.users;
    if (Array.isArray(list)) {
      candidates.push(...list);
    } else {
      candidates.push(body);
    }
  }

  const normalizedInput = bnetInput.replace("＃", "#").trim().toLowerCase();

  let matched = candidates.find((item) => {
    const name = String(
      pickField(item, [
        "bnetName",
        "battleTag",
        "bnet",
        "name",
        "nickname",
        "nickName",
      ]) || ""
    ).toLowerCase();
    return name === normalizedInput;
  });

  if (!matched && candidates.length > 0) {
    matched = candidates[0];
  }

  const customerToken = pickField(matched, [
    "token",
    "customerToken",
    "customer_token",
    "userToken",
    "shareToken",
  ]);

  if (!matched || !customerToken) {
    throw new DashenError(
      404,
      `❌ 未在网易大神找到国服玩家 <code>${escapeHtml(bnetInput)}</code>。\n请确认：\n1. 战网 ID 含完整 <code>#数字</code> 且大小写正确\n2. 该玩家已绑定过网易大神或近期有过国服对局`
    );
  }

  const nickname = String(
    pickField(matched, [
      "bnetName",
      "battleTag",
      "nickname",
      "nickName",
      "name",
    ]) || bnetInput
  );

  return {
    bnet: bnetInput.replace("＃", "#").trim(),
    customerToken: String(customerToken),
    nickname,
    raw: matched,
  };
}

function formatNum(val: any, decimals = 0): string {
  const n = Number(val);
  if (val === undefined || val === null || val === "" || Number.isNaN(n)) {
    return "-";
  }
  if (decimals > 0) return n.toFixed(decimals);
  return Math.round(n).toLocaleString("en-US");
}

function formatRate(val: any): string {
  if (val === undefined || val === null || val === "") return "-";
  const str = String(val);
  if (str.includes("%")) return str;
  const n = Number(val);
  if (Number.isNaN(n)) return str;
  const pct = n <= 1 && n > 0 ? n * 100 : n;
  return `${pct.toFixed(1)}%`;
}

function formatTimestamp(ts: any): string {
  if (!ts) return "";
  if (typeof ts === "string" && /[-/:]/.test(ts)) return ts;
  const n = Number(ts);
  if (Number.isNaN(n) || n <= 0) return "";
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms + 8 * 3600 * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 轻量内存缓存：为单场对局详情按钮分配短 Key（规避 Telegram 64 字节限制） */
const matchCache = new Map<
  string,
  {
    bnet: string;
    customerToken: string;
    matchId: string;
    mode: CnGameMode;
    expiresAt: number;
  }
>();

function cacheMatchRef(
  bnet: string,
  customerToken: string,
  matchId: string,
  mode: CnGameMode
): string {
  const shortId = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
  matchCache.set(shortId, {
    bnet,
    customerToken,
    matchId,
    mode,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });
  if (matchCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of matchCache.entries()) {
      if (v.expiresAt < now) matchCache.delete(k);
    }
  }
  return shortId;
}

// ============================================================================
// 4. 视图渲染：国服总览卡片 / 近期战绩列表 / 单场对局详情
// ============================================================================

async function buildCnOverviewView(
  bnet: string,
  gameMode: CnGameMode
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const searchRes = await searchBnetAccount(bnet);
  const player = extractPlayerFromSearch(bnet, searchRes);

  const [cardRes, countRes] = await Promise.allSettled([
    queryCard(player.customerToken),
    queryCountInfo(player.customerToken, gameMode),
  ]);

  const cardData =
    cardRes.status === "fulfilled" ? unwrapData(cardRes.value) : null;
  const countData =
    countRes.status === "fulfilled" ? unwrapData(countRes.value) : null;

  const modeLabel = gameMode === "sport" ? "⚔️ 竞技比赛" : "⚡ 快速比赛";
  const displayName = escapeHtml(
    String(
      pickField(cardData, [
        "bnetName",
        "battleTag",
        "nickname",
        "nickName",
        "name",
      ]) || player.nickname
    )
  );

  const levelVal = pickField(cardData, ["level", "endorsementLevel"]);
  const gameTimeVal = pickField(cardData, ["gameTime", "totalGameTime"]);
  const totalMatchVal = pickField(cardData, [
    "totalMatchNum",
    "matchCount",
    "totalCount",
  ]);

  const metaParts: string[] = [`模式：${modeLabel}`];
  if (levelVal !== undefined) metaParts.push(`赞赏 Lv.${escapeHtml(String(levelVal))}`);
  if (gameTimeVal !== undefined) {
    const gtStr =
      typeof gameTimeVal === "number"
        ? `${formatNum(gameTimeVal, 1)}h`
        : escapeHtml(String(gameTimeVal));
    metaParts.push(`时长 ${gtStr}`);
  }
  if (totalMatchVal !== undefined) {
    metaParts.push(`累计 ${formatNum(totalMatchVal)} 场`);
  }

  const lines: string[] = [
    `🇨🇳 <b>${displayName}</b>（国服）`,
    metaParts.join("  |  "),
    `━━━━━━━━━━━━━━━━━━`,
  ];

  // 1. 提取段位信息（兼容对象与数组两种常见结构）
  const rankLines: string[] = [];
  if (cardData && typeof cardData === "object") {
    const rankList =
      cardData.rankList ||
      cardData.ranks ||
      cardData.roleRankList ||
      cardData.tierList ||
      cardData.competitiveRanks;

    if (Array.isArray(rankList) && rankList.length > 0) {
      for (const r of rankList) {
        const roleName =
          pickField(r, ["roleName", "roleType", "role", "name", "typeName"]) ||
          "职责";
        const tierName =
          pickField(r, [
            "rankName",
            "tierName",
            "divisionName",
            "rank",
            "levelName",
          ]) || "未定级";
        rankLines.push(
          `• ${escapeHtml(String(roleName))}：<b>${escapeHtml(String(tierName))}</b>`
        );
      }
    } else {
      const tank = pickField(cardData, ["tankRank", "tankTier", "tankLevel"]);
      const dps = pickField(cardData, [
        "damageRank",
        "dpsRank",
        "damageTier",
        "attackRank",
      ]);
      const sup = pickField(cardData, [
        "supportRank",
        "healRank",
        "supportTier",
      ]);
      const open = pickField(cardData, ["openRank", "freeRank"]);
      if (tank || dps || sup || open) {
        if (tank) rankLines.push(`• 🛡 坦克：<b>${escapeHtml(String(tank))}</b>`);
        if (dps) rankLines.push(`• ⚔️ 输出：<b>${escapeHtml(String(dps))}</b>`);
        if (sup) rankLines.push(`• 💉 支援：<b>${escapeHtml(String(sup))}</b>`);
        if (open) rankLines.push(`• 🎲 自由：<b>${escapeHtml(String(open))}</b>`);
      }
    }
  }

  if (rankLines.length > 0) {
    lines.push(`<b>🏆 竞技段位</b>`, ...rankLines, `━━━━━━━━━━━━━━━━━━`);
  }

  // 2. 提取汇总统计信息
  const statsObj =
    (countData &&
      (countData.total || countData.summary || countData.overview || countData)) ||
    null;

  if (statsObj && typeof statsObj === "object") {
    const totalGames = pickField(statsObj, [
      "totalCount",
      "matchCount",
      "gamesPlayed",
      "totalGames",
      "gameCount",
      "totalMatchNum",
    ]);
    const winGames = pickField(statsObj, ["winCount", "gamesWon", "wins"]);
    const winRate = pickField(statsObj, [
      "winRate",
      "winRatio",
      "winPercent",
      "win_rate",
    ]);
    const kda = pickField(statsObj, ["kda", "avgKda", "kd"]);
    const avgElim = pickField(statsObj, [
      "avgEliminations",
      "avgKill",
      "elimAvg",
      "avgKills",
    ]);
    const avgDeath = pickField(statsObj, [
      "avgDeaths",
      "avgDeath",
      "deathAvg",
    ]);
    const avgDmg = pickField(statsObj, [
      "avgDamage",
      "avgHeroDamage",
      "damageAvg",
    ]);
    const avgHeal = pickField(statsObj, ["avgHeal", "avgHealing", "healAvg"]);

    const statParts: string[] = [];
    if (totalGames !== undefined) {
      statParts.push(
        `🎮 场次：<b>${formatNum(totalGames)}</b>${winGames !== undefined ? ` (${formatNum(winGames)}胜)` : ""}`
      );
    }
    if (winRate !== undefined || kda !== undefined) {
      statParts.push(
        `📈 胜率：<b>${formatRate(winRate)}</b>  |  KDA：<b>${formatNum(kda, 2)}</b>`
      );
    }
    if (
      avgElim !== undefined ||
      avgDeath !== undefined ||
      avgDmg !== undefined ||
      avgHeal !== undefined
    ) {
      statParts.push(
        `⚡ 场均：消灭 <b>${formatNum(avgElim, 1)}</b> · 阵亡 <b>${formatNum(avgDeath, 1)}</b> · 伤害 <b>${formatNum(avgDmg)}</b> · 治疗 <b>${formatNum(avgHeal)}</b>`
      );
    }

    if (statParts.length > 0) {
      lines.push(`<b>📊 赛季汇总战绩</b>`, ...statParts);
    } else {
      lines.push(
        `📭 已成功拉取该玩家数据，但当前模式下暂无汇总统计（可切换模式或查看近期战绩）。`
      );
    }

    // 常用英雄列表
    const heroList =
      countData?.heroList ||
      countData?.heroes ||
      countData?.topHeroes ||
      cardData?.heroList ||
      cardData?.heroes;
    if (Array.isArray(heroList) && heroList.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━━━━`, `<b>🔥 常用英雄</b>`);
      for (const h of heroList.slice(0, 5)) {
        const hName =
          pickField(h, ["heroName", "name", "hero_name", "cnName"]) ||
          "未知英雄";
        const hGames = pickField(h, [
          "totalCount",
          "matchCount",
          "games",
          "count",
        ]);
        const hWin = pickField(h, ["winRate", "winRatio", "winPercent"]);
        const hKda = pickField(h, ["kda", "avgKda"]);
        lines.push(
          `• <b>${escapeHtml(String(hName))}</b>：${hGames !== undefined ? `${formatNum(hGames)}场 | ` : ""}胜率 ${formatRate(hWin)}${hKda !== undefined ? ` | KDA ${formatNum(hKda, 2)}` : ""}`
        );
      }
    }
  } else {
    lines.push(
      `📭 该玩家在 <b>${modeLabel}</b> 下暂无有效数据，可点击下方按钮切换模式或查看近期对局。`
    );
  }

  // 构建交互按钮
  const keyboard = new InlineKeyboard();
  const mCode = gameMode === "sport" ? "s" : "l";
  const nextM = gameMode === "sport" ? "l" : "s";

  const switchModeCb = `o:${nextM}:${player.bnet}`;
  const matchListCb = `m:${mCode}:1:${player.bnet}`;
  const refreshCb = `o:${mCode}:${player.bnet}`;

  if (isSafeCallbackData(switchModeCb)) {
    keyboard.text(
      gameMode === "sport" ? "切换到 ⚡快速" : "切换到 ⚔️竞技",
      switchModeCb
    );
  }
  if (isSafeCallbackData(matchListCb)) {
    keyboard.text("📋 近期战绩流水", matchListCb);
  }
  keyboard.row();
  if (isSafeCallbackData(refreshCb)) {
    keyboard.text("🔄 刷新总览", refreshCb);
  }

  return { text: lines.join("\n"), keyboard };
}

async function buildCnMatchListView(
  bnet: string,
  gameMode: CnGameMode,
  page = 1
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const searchRes = await searchBnetAccount(bnet);
  const player = extractPlayerFromSearch(bnet, searchRes);
  const listRes = await queryMatchList(player.customerToken, gameMode, page);
  const listBody = unwrapData(listRes);

  const matches: any[] = Array.isArray(listBody)
    ? listBody
    : listBody?.list ||
      listBody?.matchList ||
      listBody?.records ||
      listBody?.items ||
      [];

  const modeLabel = gameMode === "sport" ? "⚔️ 竞技" : "⚡ 快速";
  const lines: string[] = [
    `📋 <b>${escapeHtml(player.nickname)} — 近期战绩（第 ${page} 页）</b>`,
    `模式：${modeLabel}  |  国服`,
    `━━━━━━━━━━━━━━━━━━`,
  ];

  const keyboard = new InlineKeyboard();
  const mCode = gameMode === "sport" ? "s" : "l";
  const nextM = gameMode === "sport" ? "l" : "s";

  if (matches.length === 0) {
    lines.push(`📭 当前模式下第 ${page} 页暂无对局记录。`);
  } else {
    let detailBtnCount = 0;
    for (let i = 0; i < Math.min(matches.length, 8); i++) {
      const m = matches[i];
      const matchId = String(
        pickField(m, ["matchId", "match_id", "id", "battleId"]) || ""
      );
      const mapName = String(
        pickField(m, ["mapName", "map", "mapCnName"]) || "未知地图"
      );
      const heroName = String(
        pickField(m, ["heroName", "hero", "mostHeroName", "mainHeroName"]) || ""
      );
      const rawResult = pickField(m, [
        "result",
        "win",
        "isWin",
        "matchResult",
        "battleResult",
      ]);
      const resultBadge =
        rawResult === 1 ||
        rawResult === true ||
        rawResult === "win" ||
        rawResult === "胜利"
          ? "🟢胜"
          : rawResult === 2 ||
              rawResult === 0 ||
              rawResult === false ||
              rawResult === "lose" ||
              rawResult === "失败"
            ? "🔴负"
            : "⚪平";

      const kills = pickField(m, ["eliminations", "kills", "kill", "elim"]);
      const deaths = pickField(m, ["deaths", "death"]);
      const assists = pickField(m, ["assists", "assist"]);
      const kdaStr =
        kills !== undefined || deaths !== undefined
          ? ` ${formatNum(kills)}/${formatNum(deaths)}${assists !== undefined ? `/${formatNum(assists)}` : ""}`
          : "";
      const timeStr = formatTimestamp(
        pickField(m, [
          "endTime",
          "createTime",
          "matchTime",
          "startTime",
          "timestamp",
        ])
      );

      lines.push(
        `<b>${i + 1}.</b> ${resultBadge} <b>${escapeHtml(mapName)}</b>${heroName ? ` · ${escapeHtml(heroName)}` : ""}${kdaStr}${timeStr ? `  <i>(${timeStr})</i>` : ""}`
      );

      if (matchId) {
        const ref = cacheMatchRef(
          player.bnet,
          player.customerToken,
          matchId,
          gameMode
        );
        keyboard.text(`详情 #${i + 1}`, `d:${ref}`);
        detailBtnCount++;
        if (detailBtnCount % 4 === 0) keyboard.row();
      }
    }
    if (detailBtnCount % 4 !== 0) keyboard.row();
  }

  const prevCb = `m:${mCode}:${Math.max(1, page - 1)}:${player.bnet}`;
  const nextCb = `m:${mCode}:${page + 1}:${player.bnet}`;
  const switchCb = `m:${nextM}:1:${player.bnet}`;
  const backCb = `o:${mCode}:${player.bnet}`;

  if (page > 1 && isSafeCallbackData(prevCb)) {
    keyboard.text("⬅️ 上一页", prevCb);
  }
  if (matches.length >= 5 && isSafeCallbackData(nextCb)) {
    keyboard.text("下一页 ➡️", nextCb);
  }
  if (page > 1 || matches.length >= 5) keyboard.row();

  if (isSafeCallbackData(switchCb)) {
    keyboard.text(
      gameMode === "sport" ? "切换 ⚡快速" : "切换 ⚔️竞技",
      switchCb
    );
  }
  if (isSafeCallbackData(backCb)) {
    keyboard.text("🏠 返回总览", backCb);
  }

  return { text: lines.join("\n"), keyboard };
}

async function buildCnMatchDetailView(refId: string): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const entry = matchCache.get(refId);
  if (!entry || Date.now() > entry.expiresAt) {
    throw new DashenError(
      410,
      "⏳ 该对局详情缓存已过期（无服务器实例已回收），请重新点击「近期战绩流水」刷新后再点详情。"
    );
  }

  const res = await queryMatchInfo(entry.customerToken, entry.matchId);
  const detail = unwrapData(res);

  const mapName = String(
    pickField(detail, ["mapName", "map", "mapCnName"]) || "单场对局详情"
  );
  const modeName = String(
    pickField(detail, ["gameModeName", "modeName", "gameMode"]) || ""
  );
  const duration = pickField(detail, ["duration", "gameTime", "matchDuration"]);

  const lines: string[] = [
    `🔍 <b>${escapeHtml(mapName)}</b>${modeName ? ` (${escapeHtml(modeName)})` : ""}`,
    `战网 ID：<code>${escapeHtml(entry.bnet)}</code>${duration ? `  |  时长：${escapeHtml(String(duration))}` : ""}`,
    `━━━━━━━━━━━━━━━━━━`,
  ];

  const players: any[] =
    detail?.players ||
    detail?.playerList ||
    detail?.teamList?.flatMap((t: any) => t.players || t.playerList || []) ||
    detail?.members ||
    [];

  if (Array.isArray(players) && players.length > 0) {
    lines.push(`<b>👥 本局玩家数据（消灭/助攻/阵亡 | 伤害 | 治疗）</b>`);
    for (const p of players.slice(0, 12)) {
      const pName = String(
        pickField(p, [
          "bnetName",
          "nickname",
          "nickName",
          "name",
          "playerName",
        ]) || "玩家"
      );
      const pHero = String(
        pickField(p, ["heroName", "hero", "mainHeroName"]) || ""
      );
      const e = formatNum(pickField(p, ["eliminations", "kills", "kill"]));
      const a = formatNum(pickField(p, ["assists", "assist"]));
      const d = formatNum(pickField(p, ["deaths", "death"]));
      const dmg = formatNum(
        pickField(p, ["heroDamage", "damage", "damageDone"])
      );
      const heal = formatNum(
        pickField(p, ["healing", "heal", "healingDone"])
      );
      lines.push(
        `• <b>${escapeHtml(pName)}</b>${pHero ? `(${escapeHtml(pHero)})` : ""}：${e}/${a}/${d} | 伤 ${dmg} | 疗 ${heal}`
      );
    }
  } else {
    const e = formatNum(pickField(detail, ["eliminations", "kills", "kill"]));
    const a = formatNum(pickField(detail, ["assists", "assist"]));
    const d = formatNum(pickField(detail, ["deaths", "death"]));
    const dmg = formatNum(
      pickField(detail, ["heroDamage", "damage", "damageDone"])
    );
    const heal = formatNum(
      pickField(detail, ["healing", "heal", "healingDone"])
    );
    lines.push(
      `• 消灭/助攻/阵亡：<b>${e} / ${a} / ${d}</b>`,
      `• 英雄伤害：<b>${dmg}</b>  |  治疗量：<b>${heal}</b>`
    );
  }

  const keyboard = new InlineKeyboard();
  const mCode = entry.mode === "sport" ? "s" : "l";
  const backListCb = `m:${mCode}:1:${entry.bnet}`;
  const backHomeCb = `o:${mCode}:${entry.bnet}`;

  if (isSafeCallbackData(backListCb)) {
    keyboard.text("⬅️ 返回战绩列表", backListCb);
  }
  if (isSafeCallbackData(backHomeCb)) {
    keyboard.text("🏠 返回总览", backHomeCb);
  }

  return { text: lines.join("\n"), keyboard };
}

// ============================================================================
// 5. 初始化 grammY Bot 与指令注册（支持一步指令 + 两步 ForceReply）
// ============================================================================

const bot = new Bot(BOT_TOKEN);

type PendingAction = "cn" | "match";

const pendingActions = new Map<
  number,
  { action: PendingAction; expiresAt: number }
>();

const PROMPT_TAGS: Record<PendingAction, string> = {
  cn: "国服战绩总览查询",
  match: "国服近期对局查询",
};

function setPendingAction(
  userId: number | undefined,
  action: PendingAction
): void {
  if (!userId) return;
  pendingActions.set(userId, {
    action,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

function consumePendingAction(userId: number | undefined): PendingAction | null {
  if (!userId) return null;
  const entry = pendingActions.get(userId);
  if (!entry) return null;
  pendingActions.delete(userId);
  if (Date.now() > entry.expiresAt) return null;
  return entry.action;
}

async function executeCnQuery(ctx: Context, rawInput: string): Promise<void> {
  const bnet = rawInput.trim().split(/\s+/)[0];
  if (!bnet) return;
  await ctx.replyWithChatAction("typing");
  try {
    const { text, keyboard } = await buildCnOverviewView(bnet, "sport");
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err) {
    await handleCommandError(ctx, err);
  }
}

async function executeMatchQuery(ctx: Context, rawInput: string): Promise<void> {
  const bnet = rawInput.trim().split(/\s+/)[0];
  if (!bnet) return;
  await ctx.replyWithChatAction("typing");
  try {
    const { text, keyboard } = await buildCnMatchListView(bnet, "sport", 1);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err) {
    await handleCommandError(ctx, err);
  }
}

bot.command(["start", "help"], async (ctx) => {
  const helpText = [
    `🇨🇳 <b>欢迎使用《守望先锋 2》国服战绩查询机器人！</b>`,
    ``,
    `📌 <b>可用指令（支持一步输入，也支持先点指令再发战网 ID）：</b>`,
    `• <code>/cn 战网ID</code> — 查询国服段位、赛季统计与常用英雄`,
    `  <i>示例：</i><code>/cn 你的昵称#51234</code>（私聊可直接发战网 ID）`,
    `• <code>/match 战网ID</code> — 查询国服近期战绩流水与单场对局详情`,
    `  <i>示例：</i><code>/match 你的昵称#51234</code>`,
    ``,
    `💡 <b>提示：</b>数据来自网易大神，需输入完整的国服战网 ID（含 <code>#数字</code>）。`,
  ].join("\n");

  await ctx.reply(helpText, { parse_mode: "HTML" });
});

bot.command("cn", async (ctx) => {
  const rawArg = ctx.match.trim();
  if (!rawArg) {
    setPendingAction(ctx.from?.id, "cn");
    await ctx.reply(
      `🇨🇳 <b>${PROMPT_TAGS.cn}</b>\n请直接发送国服战网 ID（例如：<code>玩家昵称#51234</code>）：`,
      {
        parse_mode: "HTML",
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "输入国服战网 ID，如 玩家#51234",
          selective: true,
        },
      }
    );
    return;
  }
  await executeCnQuery(ctx, rawArg);
});

bot.command("match", async (ctx) => {
  const rawArg = ctx.match.trim();
  if (!rawArg) {
    setPendingAction(ctx.from?.id, "match");
    await ctx.reply(
      `📋 <b>${PROMPT_TAGS.match}</b>\n请直接发送国服战网 ID（例如：<code>玩家昵称#51234</code>）：`,
      {
        parse_mode: "HTML",
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "输入国服战网 ID，如 玩家#51234",
          selective: true,
        },
      }
    );
    return;
  }
  await executeMatchQuery(ctx, rawArg);
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) return;

  let action: PendingAction | null = null;

  const replyMsg = ctx.message.reply_to_message;
  if (replyMsg?.from?.is_bot && replyMsg.text) {
    if (replyMsg.text.includes(PROMPT_TAGS.cn)) action = "cn";
    else if (replyMsg.text.includes(PROMPT_TAGS.match)) action = "match";
  }

  if (!action && ctx.chat.type === "private") {
    action = consumePendingAction(ctx.from?.id);
    if (!action && /^\S+[#＃]\d+$/.test(text)) {
      action = "cn";
    }
  } else if (action) {
    consumePendingAction(ctx.from?.id);
  }

  if (!action) return;

  if (action === "cn") await executeCnQuery(ctx, text);
  else if (action === "match") await executeMatchQuery(ctx, text);
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const parts = data.split(":");
  const action = parts[0];

  try {
    if (action === "o" && parts.length >= 3) {
      const mode: CnGameMode = parts[1] === "l" ? "leisure" : "sport";
      const bnet = parts.slice(2).join(":");
      const { text, keyboard } = await buildCnOverviewView(bnet, mode);
      await safeEditMessage(ctx, text, keyboard);
      await safeAnswerCallback(ctx);
      return;
    }

    if (action === "m" && parts.length >= 4) {
      const mode: CnGameMode = parts[1] === "l" ? "leisure" : "sport";
      const page = Math.max(1, Number(parts[2]) || 1);
      const bnet = parts.slice(3).join(":");
      const { text, keyboard } = await buildCnMatchListView(bnet, mode, page);
      await safeEditMessage(ctx, text, keyboard);
      await safeAnswerCallback(ctx);
      return;
    }

    if (action === "d" && parts.length === 2) {
      const { text, keyboard } = await buildCnMatchDetailView(parts[1]);
      await safeEditMessage(ctx, text, keyboard);
      await safeAnswerCallback(ctx);
      return;
    }

    await safeAnswerCallback(ctx, "无效的操作按钮");
  } catch (err) {
    const msg =
      err instanceof DashenError
        ? err.message.replace(/<[^>]+>/g, "")
        : "拉取国服数据失败，请稍后重试。";
    await safeAnswerCallback(ctx, msg.slice(0, 180), true);
  }
});

async function safeAnswerCallback(
  ctx: Context,
  text?: string,
  showAlert = false
): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text, show_alert: showAlert });
  } catch {
    // 忽略超时应答错误
  }
}

async function safeEditMessage(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboard
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("message is not modified")
    ) {
      return;
    }
    throw err;
  }
}

async function handleCommandError(ctx: Context, err: unknown): Promise<void> {
  if (err instanceof DashenError) {
    await ctx.reply(err.message, { parse_mode: "HTML" });
    return;
  }
  console.error("[OW2 CN Bot Error]", err);
  await ctx.reply("⚠️ 服务器内部异常，请稍后再试。");
}

bot.catch((err) => {
  console.error("[grammY CN Global Catch]", err.error);
});

// ============================================================================
// 6. Vercel Serverless Function 入口
// ============================================================================

const handleWebhook = webhookCallback(bot, "http", {
  secretToken: WEBHOOK_SECRET,
  timeoutMilliseconds: 25_000,
});

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: true,
        service: "OW2 CN Stats Telegram Bot",
        runtime: "Vercel Node.js Serverless",
        dashenConfigured: Boolean(DASHEN_ROLE_ID && DASHEN_TOKEN),
      })
    );
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  await handleWebhook(req, res);
}
