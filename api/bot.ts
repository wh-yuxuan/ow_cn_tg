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
// 2. 英雄 / 地图 / 模式 映射与 GUID 兼容处理
// ============================================================================

/** 对齐 Overstats src/constants/chara.py 的英雄标准名与外号别名映射 */
const DASHEN_HERO_ALIASES: Record<string, string[]> = {
  安娜: ["ana", "安娜", "鸡妈", "恐怖老太太", "娜娜", "激素老太", "禁疗摩西"],
  艾什: ["ashe", "ash", "艾什", "艾许", "王母娘娘", "老八"],
  巴蒂斯特: ["baptiste", "巴蒂斯特", "巴蒂", "8d", "八弟", "大76"],
  堡垒: ["bastion", "堡垒"],
  布丽吉塔: [
    "brigitte",
    "brig",
    "布丽吉塔",
    "锤妹",
    "那个女人",
    "小锤",
    "锤女",
    "tiger",
    "布里",
    "nt",
    "脑瘫",
  ],
  卡西迪: [
    "cassidy",
    "卡西迪",
    "麦克雷",
    "天王老子",
    "幽默左轮人",
    "麦卡利",
    "麦爹",
    "午时已到",
  ],
  末日铁拳: [
    "doomfist",
    "末日铁拳",
    "铁拳",
    "那个男人",
    "牢肘",
    "牢大",
    "毁天灭地",
    "肘击王",
    "卤蛋",
    "屁王",
    "pva",
    "上勾拳",
  ],
  "D.Va": ["d.va", "dva", "宋哈娜", "机甲摩西", "宋荷娜", "网瘾少女"],
  回声: ["echo", "回声"],
  源氏: [
    "genji",
    "源氏",
    "忍者",
    "根基",
    "飞镖人",
    "源",
    "原",
    "源劈",
    "原始",
    "原氏",
    "有基佬开我裤链",
    "源批",
  ],
  半藏: ["hanzo", "半藏"],
  骇灾: ["hazard", "骇灾", "三体人", "唐人", "哈扎德", "嗨仔"],
  伊拉锐: ["illari", "伊拉锐", "太阳摩西", "光塔摩西", "依拉瑞", "日女"],
  渣客女王: ["junkerqueen", "junker-queen", "渣客女王", "女王", "渣女", "扎克"],
  狂鼠: ["junkrat", "狂鼠", "老鼠", "炸弹人"],
  朱诺: ["juno", "朱诺", "火星摩西", "轨投", "火星雨姐"],
  雾子: ["kiriko", "雾子", "物资", "污渍", "乌兹"],
  生命之梭: ["lifeweaver", "生命之梭", "花男", "男摩西", "大树摩西"],
  卢西奥: ["lucio", "dj", "卢西奥", "音乐摩西", "打碟摩西"],
  毛加: ["mauga", "ssvgg", "毛加", "体育生"],
  美: ["mei", "美", "小美", "美妈", "周美玲", "麦克美", "贾玲", "周美灵"],
  天使: [
    "mercy",
    "天使",
    "摩西",
    "摩西本西",
    "摩西女",
    "神秘摩西女",
    "安吉拉",
    "angel",
    "怜悯",
  ],
  莫伊拉: ["moira", "莫伊拉", "莫伊", "莫姨"],
  奥丽莎: [
    "orisa",
    "奥丽莎",
    "羊驼",
    "佐巴杨",
    "羊",
    "美羊羊",
    "左巴杨",
    "传奇机长",
    "传奇机长左巴杨",
    "佐巴扬",
    "肘巴羊",
    "金色答辩",
  ],
  法老之鹰: ["pharah", "法老之鹰", "法鸡", "法拉", "鸡", "瓦鸡", "挖机"],
  拉玛刹: [
    "ramattra",
    "拉玛刹",
    "拉玛",
    "牢玛",
    "拉答辩",
    "鲑鱼",
    "鲑鱼大帝",
    "老马",
    "鳜鱼",
    "紫色答辩",
  ],
  死神: ["reaper", "死神", "活神", "谐星"],
  莱因哈特: ["reinhardt", "莱因哈特", "莱因", "大锤", "大锤哥", "锤哥"],
  路霸: ["roadhog", "路霸", "猪猪", "猪", "🐖", "🐷"],
  西格玛: ["sigma", "西格玛", "老大爷", "大爷"],
  索杰恩: ["sojourn", "索杰恩", "索杰", "索姐", "索", "超人强"],
  "士兵：76": [
    "soldier76",
    "soldier-76",
    "士兵76",
    "士兵：76",
    "76",
    "士兵",
    "逃兵",
    "逃兵76",
    "跑男",
    "小巴蒂",
    "小8d",
    "幽默跑步男",
  ],
  黑影: ["sombra", "黑影", "邓紫琪", "邓紫棋"],
  秩序之光: ["symmetra", "秩序之光", "光子", "光子妹", "光妹", "三妹", "阿三", "辛梅塔"],
  托比昂: ["torbjorn", "托比昂", "托比", "托比昂哥", "托比哥", "中锤", "矮子", "炮台", "矮人"],
  猎空: ["tracer", "猎空", "闪光", "裂空"],
  探奇: [
    "venture",
    "探奇",
    "地鼠",
    "钻机",
    "轰轰钻机",
    "丁真",
    "顶针",
    "顶真",
    "末日铁钻",
    "土行孙",
    "钻地狗",
    "钻地婆",
    "钻头小子",
  ],
  黑百合: ["widowmaker", "黑百合", "百合", "黑寡妇", "狙", "大狙", "紫薯", "紫薯小人"],
  温斯顿: ["winston", "温斯顿", "猩猩", "星星", "老詹", "牢詹", "猴子", "詹姆斯"],
  破坏球: ["wreckingball", "wrecking-ball", "破坏球", "球球", "球", "仓鼠"],
  查莉娅: ["zarya", "查莉娅", "毛妹", "俄罗斯雨姐", "雨姐", "东北雨姐", "国潮", "国潮来袭"],
  禅雅塔: ["zenyatta", "禅雅塔", "和尚", "光头摩西", "悬浮摩西"],
  弗蕾娅: ["freja", "弗蕾娅", "弗蕾娅大人", "芙蕾雅", "芙蕾雅大人"],
  无漾: ["wuyang", "无漾", "玩水摩西", "水男", "无恙", "水摩西", "五羊"],
  斩仇: ["vendetta", "lupa", "斩仇", "狼女", "大剑"],
  安燃: ["anran", "安燃", "姐姐", "火女", "凤凰女", "不知火舞", "凤凰", "朱雀", "不知火", "火舞", "扇子摩西"],
  金驭: ["domina", "金驭", "金玉", "禁欲", "金御", "妈妈", "妈", "总裁", "金羽"],
  埃姆雷: ["emre", "埃姆雷", "m雷", "猫雷", "艾姆雷"],
  飞天猫: ["jetpackcat", "jetpack-cat", "飞天猫", "耄耋", "哈基米", "猫", "猫猫", "豪猫", "键帽"],
  瑞稀: ["mizuki", "瑞稀", "瑞希", "斗笠男", "绿帽", "乌龟", "锁链男", "斗笠摩西", "河童", "镰刀男"],
  西拉: ["sierra", "西拉", "鸟人", "拉稀", "埃科", "希拉", "茜拉", "拉西"],
  死怨: ["shion", "死怨"],
  "D.Mon": ["d.mon"],
  血律: ["doctrine", "血律", "吸血鬼"],
};

const HERO_ALIAS_TO_CN: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [canonicalName, aliases] of Object.entries(DASHEN_HERO_ALIASES)) {
    map[canonicalName.toLowerCase()] = canonicalName;
    for (const alias of aliases) {
      map[String(alias).trim().toLowerCase()] = canonicalName;
    }
  }
  return map;
})();

/** 常见网易大神地图 GUID / 尾号映射（完整全量地图表可由 res/query_tool.json 补充） */
const DASHEN_MAP_NAMES: Record<string, string> = {
  "576460752303424195": "好莱坞",
  "424695": "漓江塔",
  "425122": "尼泊尔",
  "426283": "国王大道",
  "426693": "努巴尼",
  "427250": "直布罗陀监测站",
  "426356": "伊利奥斯",
  "425848": "绿洲城",
  "424195": "花冈",
  "424175": "新皇后街",
  "427628": "苏里南",
  "425182": "萨摩亚",
  "428538": "新垃圾镇",
  "426131": "多拉多",
  "426191": "66号公路",
  "426305": "监测站：直布罗陀",
  "426512": "艾兴瓦尔德",
  "426615": "暴雪世界",
  "426823": "渣客镇",
  "426912": "里阿尔托",
  "427045": "哈瓦那",
  "427188": "帕拉伊苏",
  "427319": "南极半岛",
  "427420": "新欢喜城",
  "427512": "萨摩亚海滩",
  "427810": "符文堡垒",
};

/** 常见网易大神英雄 GUID / 尾号映射（对齐 queryMatchInfo.md 与常用英雄 ID） */
const DASHEN_HERO_GUID_NAMES: Record<string, string> = {
  "207165582859043685": "雾子",
  "207165582859043119": "卡西迪",
  "207165582859043274": "莱因哈特",
  "207165582859044118": "源氏",
  "43131": "雾子",
  "43118": "天使",
  "44067": "朱诺",
  "43234": "莫伊拉",
  "44208": "安娜",
  "44118": "卡西迪",
  "43134": "巴蒂斯特",
};

function resolveDashenHeroName(raw: any): string {
  if (raw === undefined || raw === null) return "";
  const str = String(raw).trim();
  if (!str) return "";
  const lower = str.toLowerCase();
  if (HERO_ALIAS_TO_CN[lower]) {
    return HERO_ALIAS_TO_CN[lower];
  }
  if (DASHEN_HERO_GUID_NAMES[str]) {
    return DASHEN_HERO_GUID_NAMES[str];
  }
  for (const [fullId, name] of Object.entries(DASHEN_HERO_GUID_NAMES)) {
    if (fullId.endsWith(str) || str.endsWith(fullId)) {
      return name;
    }
  }
  return str;
}

function translateModeCode(modeVal: any): string {
  if (!modeVal) return "";
  const s = String(modeVal).trim();
  const map: Record<string, string> = {
    sportpreset: "竞技预设",
    sport: "竞技预设",
    leisurepreset: "快速预设",
    leisure: "快速预设",
    sportopen: "竞技自由",
    leisureopen: "快速自由",
  };
  return map[s.toLowerCase()] || s;
}

function resolveDashenMapGuid(rawGuid: any): string {
  if (rawGuid === undefined || rawGuid === null) return "";
  const str = String(rawGuid).trim();
  if (!str) return "";
  if (DASHEN_MAP_NAMES[str]) return DASHEN_MAP_NAMES[str];
  for (const [fullId, name] of Object.entries(DASHEN_MAP_NAMES)) {
    if (fullId.endsWith(str) || str.endsWith(fullId)) {
      return name;
    }
  }
  return `地图ID:${str.slice(-6)}`;
}

function resolveDashenHeroGuid(rawGuid: any): string {
  if (rawGuid === undefined || rawGuid === null) return "";
  const str = String(rawGuid).trim();
  if (!str) return "";
  if (HERO_ALIAS_TO_CN[str.toLowerCase()]) {
    return HERO_ALIAS_TO_CN[str.toLowerCase()];
  }
  if (DASHEN_HERO_GUID_NAMES[str]) return DASHEN_HERO_GUID_NAMES[str];
  for (const [fullId, name] of Object.entries(DASHEN_HERO_GUID_NAMES)) {
    if (fullId.endsWith(str) || str.endsWith(fullId)) {
      return name;
    }
  }
  return `英雄ID:${str.slice(-5)}`;
}

// ============================================================================
// 3. 网易大神 HTTP 客户端
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
// 4. 数据提取与格式化工具
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

/** 从对象及常见嵌套子对象（mapInfo / gameInfo / battleInfo 等）中提取字段 */
function pickDeepField(obj: any, keys: string[]): any {
  const direct = pickField(obj, keys);
  if (direct !== undefined) return direct;
  if (!obj || typeof obj !== "object") return undefined;

  const nestedContainers = [
    obj.mapInfo,
    obj.map,
    obj.battleInfo,
    obj.gameInfo,
    obj.matchInfo,
    obj.stat,
    obj.stats,
    obj.data,
  ];
  for (const sub of nestedContainers) {
    if (sub && typeof sub === "object" && !Array.isArray(sub)) {
      const found = pickField(sub, keys);
      if (found !== undefined) return found;
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
  const str = String(val).trim();
  if (str.endsWith("%")) return escapeHtml(str);
  const num = Number(str);
  if (Number.isNaN(num)) return escapeHtml(str);
  return `${num.toFixed(1)}%`;
}

function formatTimestamp(ts: any): string {
  if (ts === undefined || ts === null || ts === "") return "";
  let ms = Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) {
    const parsed = Date.parse(String(ts));
    if (!Number.isFinite(parsed) || parsed <= 0) return "";
    ms = parsed;
  } else if (ms < 1e12) {
    ms *= 1000;
  }
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

/** 解析单条对局的胜负状态（对齐 queryMatchList.md 的 matchRet 字段，并兼容比分与逆向编码） */
function parseMatchResultBadge(m: any): string {
  const rawResult = pickDeepField(m, [
    "matchRet",
    "result",
    "win",
    "isWin",
    "is_win",
    "winFlag",
    "win_flag",
    "matchResult",
    "match_result",
    "battleResult",
    "battle_result",
    "gameResult",
    "outcome",
    "status",
  ]);

  const teamScoreNum = Number(pickDeepField(m, ["teamScore", "myScore"]));
  const oppScoreNum = Number(pickDeepField(m, ["opponentScore", "enemyScore"]));
  const hasValidScores =
    Number.isFinite(teamScoreNum) &&
    Number.isFinite(oppScoreNum) &&
    teamScoreNum !== oppScoreNum;

  if (typeof rawResult === "boolean") {
    return rawResult ? "🟢胜" : "🔴负";
  }

  if (typeof rawResult === "number") {
    if (rawResult === 1) return "🟢胜";
    if (rawResult === -1) return "🔴负";
    if (rawResult === 0) {
      if (hasValidScores) return teamScoreNum > oppScoreNum ? "🟢胜" : "🔴负";
      return "⚪平";
    }
    if (rawResult === 2) {
      if (hasValidScores) return teamScoreNum > oppScoreNum ? "🟢胜" : "🔴负";
      return "🔴负";
    }
    if (rawResult === 3) return "⚪平";
  }

  if (rawResult !== undefined && rawResult !== null && rawResult !== "") {
    const s = String(rawResult).trim().toLowerCase();
    if (["1", "true", "win", "won", "victory", "胜", "胜利"].includes(s)) {
      return "🟢胜";
    }
    if (["-1", "false", "lose", "lost", "loss", "defeat", "负", "失败"].includes(s)) {
      return "🔴负";
    }
    if (["0", "2"].includes(s)) {
      if (hasValidScores) return teamScoreNum > oppScoreNum ? "🟢胜" : "🔴负";
      return s === "0" ? "⚪平" : "🔴负";
    }
    if (["3", "draw", "tie", "平", "平局"].includes(s)) {
      return "⚪平";
    }
  }

  if (hasValidScores) {
    return teamScoreNum > oppScoreNum ? "🟢胜" : "🔴负";
  }

  return "⚪平";
}

/** 解析单条对局的地图名称（兼容文字地图名与 mapGuid 编号） */
function parseMatchMapName(m: any): string {
  const mapVal = pickDeepField(m, [
    "mapName",
    "map_name",
    "mapCnName",
    "map_cn_name",
    "battleMapName",
    "sceneName",
    "scene_name",
    "stageName",
    "mapTitle",
  ]);

  if (typeof mapVal === "string" && mapVal.trim()) {
    return mapVal.trim();
  }
  if (mapVal && typeof mapVal === "object") {
    const nestedName = pickField(mapVal, [
      "name",
      "mapName",
      "cnName",
      "title",
    ]);
    if (nestedName) return String(nestedName);
  }

  const mapGuid = pickDeepField(m, ["mapGuid", "map_guid", "mapId"]);
  if (mapGuid !== undefined) {
    return resolveDashenMapGuid(mapGuid);
  }

  const modeVal = pickDeepField(m, [
    "gameModeName",
    "modeName",
    "subModeName",
    "gameMode",
  ]);
  if (typeof modeVal === "string" && modeVal.trim()) {
    return `${translateModeCode(modeVal)}对局`;
  }

  return "未标注地图";
}

/** 解析单条对局的英雄名称或英雄编号提示 */
function parseMatchHeroLabel(m: any): string {
  const heroVal = pickDeepField(m, [
    "heroName",
    "hero_name",
    "hero",
    "mostHeroName",
    "mainHeroName",
  ]);
  if (typeof heroVal === "string" && heroVal.trim()) {
    return resolveDashenHeroName(heroVal);
  }

  const heroGuid = pickDeepField(m, ["heroGuid", "hero_guid", "heroId"]);
  if (heroGuid !== undefined) {
    return resolveDashenHeroGuid(heroGuid);
  }

  return "";
}

/** 轻量内存缓存：为单场对局详情按钮分配短 Key */
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
// 5. 视图渲染：国服总览卡片 / 近期战绩列表 / 单场对局详情
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
  if (levelVal !== undefined) {
    metaParts.push(`赞赏 Lv.${escapeHtml(String(levelVal))}`);
  }
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
    `🇨🇳 <b>${displayName}</b>（国服总览）`,
    metaParts.join("  |  "),
    `━━━━━━━━━━━━━━━━━━`,
  ];

  const roleMapCn: Record<string, string> = {
    tank: "🛡 坦克",
    dps: "⚔️ 输出",
    damage: "⚔️ 输出",
    healer: "💉 支援",
    support: "💉 支援",
  };

  const rankLines: string[] = [];
  if (cardData && typeof cardData === "object") {
    const rankList =
      countData?.guideCountData ||
      cardData.guideCountData ||
      cardData.rankList ||
      cardData.ranks ||
      cardData.roleRankList ||
      cardData.tierList ||
      cardData.competitiveRanks;

    if (Array.isArray(rankList) && rankList.length > 0) {
      for (const r of rankList) {
        const rawRole = String(
          pickField(r, ["roleType", "roleName", "role", "name", "typeName"]) ||
            "职责"
        ).toLowerCase();
        const roleLabel = roleMapCn[rawRole] || rawRole;
        const lastRank = r?.lastRankInfo || r?.rankInfo || r;
        const rName = pickField(lastRank, [
          "rankName",
          "rank_name",
          "tierName",
          "divisionName",
          "rank",
        ]);
        const rSub = pickField(lastRank, ["rankSubTier", "rank_sub_tier"]);
        const rScore = pickField(lastRank, ["rankScore", "rank_score"]);
        const tierText = rName
          ? `${rName}${rSub !== undefined && rSub !== null ? ` ${rSub}` : ""}${rScore !== undefined && rScore !== null ? ` (${rScore}分)` : ""}`
          : "未定级";
        const rMatches = pickField(r, ["matchSum", "matches"]);
        const rWin = pickField(r, ["winRate", "win_rate"]);
        const rKda = pickField(r, ["kda"]);
        const extra = [
          rMatches !== undefined ? `${formatNum(rMatches)}场` : "",
          rWin !== undefined ? `胜率${formatRate(rWin)}` : "",
          rKda !== undefined ? `KDA ${formatNum(rKda, 2)}` : "",
        ]
          .filter(Boolean)
          .join(" · ");

        rankLines.push(
          `• ${escapeHtml(roleLabel)}：<b>${escapeHtml(tierText)}</b>${extra ? `（${escapeHtml(extra)}）` : ""}`
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

  const statsObj =
    (countData &&
      (countData.presetsSummaryData ||
        countData.total ||
        countData.summary ||
        countData.overview ||
        countData)) ||
    null;

  if (statsObj && typeof statsObj === "object") {
    const totalGames = pickField(statsObj, [
      "matchSum",
      "totalCount",
      "matchCount",
      "gamesPlayed",
      "totalGames",
      "gameCount",
      "totalMatchNum",
    ]);
    const winGames = pickField(statsObj, [
      "matchWinSum",
      "winCount",
      "gamesWon",
      "wins",
    ]);
    const lossGames = pickField(statsObj, [
      "matchLossSum",
      "lossCount",
      "gamesLost",
      "losses",
    ]);
    const winRate = pickField(statsObj, [
      "winRate",
      "winRatio",
      "winPercent",
      "win_rate",
    ]);
    const kda = pickField(statsObj, ["kda", "avgKda", "kd"]);
    const avgElim = pickField(statsObj, [
      "aveKill",
      "avgEliminations",
      "avgKill",
      "elimAvg",
      "avgKills",
    ]);
    const avgAssist = pickField(statsObj, ["aveAssist", "avgAssists"]);
    const avgDeath = pickField(statsObj, [
      "aveDeath",
      "avgDeaths",
      "avgDeath",
      "deathAvg",
    ]);
    const avgDmg = pickField(statsObj, [
      "aveHeroDamage",
      "avgDamage",
      "avgHeroDamage",
      "damageAvg",
    ]);
    const avgHeal = pickField(statsObj, [
      "aveCure",
      "avgHeal",
      "avgHealing",
      "healAvg",
    ]);
    const avgResist = pickField(statsObj, [
      "aveResistDamage",
      "avgResistDamage",
    ]);

    const statParts: string[] = [];
    if (totalGames !== undefined) {
      const wlStr =
        winGames !== undefined || lossGames !== undefined
          ? ` (${winGames !== undefined ? `${formatNum(winGames)}胜` : ""}${lossGames !== undefined ? ` ${formatNum(lossGames)}负` : ""})`
          : "";
      statParts.push(`🎮 场次：<b>${formatNum(totalGames)}</b>${wlStr}`);
    }
    if (winRate !== undefined || kda !== undefined) {
      statParts.push(
        `📈 胜率：<b>${formatRate(winRate)}</b>${kda !== undefined ? `  |  KDA：<b>${formatNum(kda, 2)}</b>` : ""}`
      );
    }
    if (
      avgElim !== undefined ||
      avgAssist !== undefined ||
      avgDeath !== undefined ||
      avgDmg !== undefined ||
      avgHeal !== undefined ||
      avgResist !== undefined
    ) {
      const kdaItems = [
        avgElim !== undefined ? `消灭 <b>${formatNum(avgElim, 1)}</b>` : "",
        avgAssist !== undefined ? `助攻 <b>${formatNum(avgAssist, 1)}</b>` : "",
        avgDeath !== undefined ? `阵亡 <b>${formatNum(avgDeath, 1)}</b>` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const valItems = [
        avgDmg !== undefined ? `伤害 <b>${formatNum(avgDmg)}</b>` : "",
        avgHeal !== undefined ? `治疗 <b>${formatNum(avgHeal)}</b>` : "",
        avgResist !== undefined ? `抵伤 <b>${formatNum(avgResist)}</b>` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      if (kdaItems) statParts.push(`⚔️ 场均：${kdaItems}`);
      if (valItems) statParts.push(`📊 场均数值：${valItems}`);
    }

    if (statParts.length > 0) {
      lines.push(`<b>📊 赛季汇总战绩</b>`, ...statParts);
    } else {
      lines.push(
        `📭 已成功拉取该玩家数据，但当前模式下暂无汇总统计（可切换模式或查看近期战绩）。`
      );
    }

    const heroList =
      countData?.presetsHeroUseSummaryList ||
      countData?.heroList ||
      countData?.heroes ||
      countData?.topHeroes ||
      cardData?.heroList ||
      cardData?.heroes;
    if (Array.isArray(heroList) && heroList.length > 0) {
      lines.push(`━━━━━━━━━━━━━━━━━━`, `<b>🔥 常用英雄</b>`);
      for (const h of heroList.slice(0, 5)) {
        const hName =
          pickField(h, [
            "heroName",
            "name",
            "hero_name",
            "cnName",
            "heroGuid",
            "heroId",
          ]) || "未知英雄";
        const hGames = pickField(h, [
          "matchSum",
          "totalCount",
          "matchCount",
          "games",
          "count",
        ]);
        const hWin = pickField(h, ["winRate", "winRatio", "winPercent"]);
        const hKda = pickField(h, ["kda", "avgKda"]);
        const hLabel = resolveDashenHeroName(hName) || "未知英雄";
        lines.push(
          `• <b>${escapeHtml(hLabel)}</b>：${hGames !== undefined ? `${formatNum(hGames)}场 | ` : ""}胜率 ${formatRate(hWin)}${hKda !== undefined ? ` | KDA ${formatNum(hKda, 2)}` : ""}`
        );
      }
    }
  } else {
    lines.push(
      `📭 该玩家在 <b>${modeLabel}</b> 下暂无有效数据，可点击下方按钮切换模式或查看近期对局。`
    );
  }

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
    : Array.isArray(listBody?.matchList)
      ? listBody.matchList
      : listBody?.list || listBody?.records || listBody?.items || [];

  const modeLabel = gameMode === "sport" ? "⚔️ 竞技" : "⚡ 快速";
  const lines: string[] = [
    `📋 <b>${escapeHtml(player.nickname)} — 近期战绩（第 ${page} 页）</b>`,
    `模式：${modeLabel}  |  国服`,
    `<i>说明：数字格式为 消灭/助攻/阵亡（含比分与时间戳）</i>`,
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
        pickDeepField(m, ["matchId", "match_id", "id", "battleId"]) || ""
      );
      const mapName = parseMatchMapName(m);
      const heroName = parseMatchHeroLabel(m);
      const resultBadge = parseMatchResultBadge(m);

      const teamScore = pickDeepField(m, ["teamScore", "myScore"]);
      const oppScore = pickDeepField(m, ["opponentScore", "enemyScore"]);
      const scoreStr =
        teamScore !== undefined && oppScore !== undefined
          ? ` [${formatNum(teamScore)}:${formatNum(oppScore)}]`
          : "";

      const kills = pickDeepField(m, [
        "kill",
        "eliminations",
        "kills",
        "elim",
        "elimNum",
      ]);
      const assists = pickDeepField(m, ["assist", "assists", "assistNum"]);
      const deaths = pickDeepField(m, ["death", "deaths", "deathNum"]);
      const kdaStr =
        kills !== undefined || assists !== undefined || deaths !== undefined
          ? ` <b>${formatNum(kills)}/${formatNum(assists)}/${formatNum(deaths)}</b>`
          : "";
      const timeStr = formatTimestamp(
        pickDeepField(m, [
          "beginTs",
          "endTime",
          "createTime",
          "matchTime",
          "startTime",
          "timestamp",
        ])
      );

      lines.push(
        `<b>${i + 1}.</b> ${resultBadge}${scoreStr} <b>${escapeHtml(mapName)}</b>${heroName ? ` · ${escapeHtml(heroName)}` : ""}${kdaStr}${timeStr ? `  <i>(${timeStr})</i>` : ""}`
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

  const mapName = parseMatchMapName(detail);
  const modeName = translateModeCode(
    pickDeepField(detail, ["gameModeName", "modeName", "gameMode"])
  );
  const duration = pickDeepField(detail, [
    "duration",
    "gameTime",
    "matchDuration",
  ]);

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
        pickField(p, ["heroName", "hero_name", "hero", "mainHeroName"]) || ""
      );
      const e = formatNum(
        pickField(p, ["eliminations", "kills", "kill", "elimNum"])
      );
      const a = formatNum(pickField(p, ["assists", "assist", "assistNum"]));
      const d = formatNum(pickField(p, ["deaths", "death", "deathNum"]));
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
    const e = formatNum(
      pickDeepField(detail, ["eliminations", "kills", "kill", "elimNum"])
    );
    const a = formatNum(
      pickDeepField(detail, ["assists", "assist", "assistNum"])
    );
    const d = formatNum(pickDeepField(detail, ["deaths", "death", "deathNum"]));
    const dmg = formatNum(
      pickDeepField(detail, ["heroDamage", "damage", "damageDone"])
    );
    const heal = formatNum(
      pickDeepField(detail, ["healing", "heal", "healingDone"])
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
// 6. 初始化 grammY Bot 与指令注册（支持一步指令 + 两步 ForceReply）
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
// 7. Vercel Serverless Function 入口
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
