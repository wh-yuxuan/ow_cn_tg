/**
 * 《守望先锋 2》(OW2) 国服战绩查询 Telegram 机器人（完整独立部署版）
 * 代码生成时间：2026-11-28 16:06:00 (Asia/Shanghai)
 * 项目地址：https://github.com/AddOneSecondL/Overstats 开源的
 * 运行环境：Vercel Serverless Functions (Node.js 20+ / TypeScript)
 * 机器人框架：grammY (Webhook 模式)
 * 数据来源：服务器反代 (https://ow.eyy8.top -> datamsapi.ds.163.com/v1/a19ld5tool)
 *         + 腾讯云/Docker 业务中转与 Redis 9 号库分层缓存 (/internal/*)
 *         + 多 AI 渠道锐评（支持 Vercel 默认执行与 Docker 120s 异步队列回推）
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Bot,
  Context,
  InlineKeyboard,
  Keyboard,
  webhookCallback,
} from "grammy";

// ============================================================================
// 1. 环境配置与常量定义
// ============================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ENV_BOT_USERNAME = (process.env.BOT_USERNAME || "")
  .replace(/^@+/, "")
  .trim();

let runtimeBotUsername = ENV_BOT_USERNAME;

const DASHEN_ROLE_ID = Number(process.env.DASHEN_ROLE_ID || "0");
const DASHEN_TOKEN = (process.env.DASHEN_TOKEN || "").trim();
const DASHEN_DTS = Number(process.env.DASHEN_DTS || "2026");
const DASHEN_SERVER = Number(process.env.DASHEN_SERVER || "1");
const DASHEN_CLIENT_TYPE = process.env.DASHEN_CLIENT_TYPE || "60";

const DASHEN_ORIGIN = process.env.DASHEN_ORIGIN || "https://act.ds.163.com";
const DASHEN_REFERER = process.env.DASHEN_REFERER || "https://act.ds.163.com/";
const DASHEN_USER_AGENT =
  process.env.DASHEN_USER_AGENT ||
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Godlike/4.27.1 (layout/full-screen) UEPay/com.netease.godlike/iOS_7.13.5";

const DASHEN_RELAY_ORIGIN = (
  process.env.DASHEN_RELAY_ORIGIN || "https://ow.eyy8.top"
).replace(/\/+$/, "");

const RELAY_SECRET = (process.env.RELAY_SECRET || "").trim();

const DASHEN_API_ROOT =
  process.env.DASHEN_API_ROOT?.replace(/\/+$/, "") ||
  `${DASHEN_RELAY_ORIGIN}/v1/a19ld5tool`;

const DASHEN_CUSTOMER_API_BASE =
  process.env.DASHEN_CUSTOMER_API_BASE?.replace(/\/+$/, "") ||
  `${DASHEN_API_ROOT}/customer`;

const SEARCH_BNET_ACCOUNT_URL =
  process.env.SEARCH_BNET_ACCOUNT_URL ||
  `${DASHEN_API_ROOT}/searchBnetAccount`;

const SEARCH_BNET_METHOD =
  (process.env.SEARCH_BNET_METHOD || "POST").trim().toUpperCase() === "GET"
    ? "GET"
    : "POST";
const SEARCH_BNET_PARAM_KEY = (
  process.env.SEARCH_BNET_PARAM_KEY || "name"
).trim();

const AI_BASE_URL = (
  process.env.AI_BASE_URL || "https://api.deepseek.com"
).replace(/\/+$/, "");
const AI_API_KEY = (process.env.AI_API_KEY || "").trim();
const AI_MODEL = (process.env.AI_MODEL || "deepseek-chat").trim();
const AI_TIMEOUT_MS = Math.min(
  Number(process.env.AI_TIMEOUT_MS || "26000") || 26000,
  26000
);
const DOCKER_AI_TIMEOUT_MS = 120_000;

const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || "12000");
const RELAY_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS || "10000");

const userLastMode = new Map<number, CnGameMode>();
const userLastBnet = new Map<number, string>();
const userRecentMatchIds = new Map<number, string[]>();
const userRecentMatchMap = new Map<number, Record<string, any>>();
const inFlightRoastTasks = new Set<string>();

type PendingUserAction =
  | { type: "redeem_input" }
  | { type: "cn_query_input" }
  | { type: "match_query_input" }
  | { type: "admin_user_query" }
  | { type: "admin_quota_add" }
  | { type: "admin_quota_deduct" }
  | { type: "admin_vip_manage" }
  | { type: "admin_user_ban" }
  | { type: "admin_redeem_create"; rewardType: "quota" | "vip_days" }
  | { type: "admin_redeem_view" }
  | { type: "admin_redeem_void" }
  | { type: "super_admin_add" }
  | { type: "super_setting_reg_quota" }
  | { type: "super_setting_inv_quota" }
  | { type: "super_setting_chk_quota" }
  | { type: "super_ai_provider_add" }
  | {
      type: "super_ai_provider_key";
      providerId: number;
      promptMessageId?: number;
    }
  | { type: "super_dashen_account_add"; promptMessageId?: number }
  | {
      type: "super_dashen_account_edit";
      accountId: number;
      promptMessageId?: number;
    };

const pendingUserInputs = new Map<
  number,
  { action: PendingUserAction; expiresAt: number }
>();

type CnGameMode = "sport" | "leisure";
type RoastType = "match" | "self" | "mmr";

interface DashenResponse<T = any> {
  code?: number;
  msg?: string;
  message?: string;
  data?: T;
  result?: T;
  [key: string]: any;
}

interface DashenPoolAccountDto {
  id: number;
  name: string;
  roleId: number;
  authToken?: string;
  maskedToken?: string;
  dts: number;
  server: number;
  clientType: string;
  origin: string;
  referer: string;
  userAgent: string;
  isEnabled: boolean;
  failCount?: number;
  lastUsedAt?: string | null;
  lastError?: string;
}

interface DashenRequestCredential {
  accountId?: number;
  name?: string;
  roleId: number;
  authToken: string;
  dts: number;
  server: number;
  clientType: string;
  origin: string;
  referer: string;
  userAgent: string;
}

interface SystemSettingsDto {
  botStatus: "normal" | "maintenance";
  registerRewardEnabled: boolean;
  registerRewardQuota: number;
  inviteRewardEnabled: boolean;
  inviteRewardQuota: number;
  checkinRewardEnabled: boolean;
  checkinRewardQuota: number;
  updatedBy: number | null;
  updatedAt: string | null;
}

interface UserProfileDto {
  tgId: number;
  nickname: string;
  username: string;
  quota: number;
  isBanned: boolean;
  vipExpireAt: string | null;
  vipActive: boolean;
  invitedBy: number | null;
  inviteCount: number;
  lastCheckinDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  isAdmin: boolean;
  adminRole: "super_admin" | "admin" | null;
  roastUnlimited: boolean;
}

interface AdminMeDto {
  tgId: number;
  remark: string;
  role: "super_admin" | "admin";
  permissions: string[];
  isActive: boolean;
  allPermissions?: string[];
  permissionLabels?: Record<string, string>;
}

interface AiProviderDto {
  id: number;
  name: string;
  baseUrl: string;
  apiKey?: string;
  maskedKey?: string;
  model: string;
  executionTarget?: "vercel" | "docker";
  isEnabled: boolean;
}

// ============================================================================
// 2. 英雄 / 地图 / 段位 / 权限名称映射表
// ============================================================================

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
  渣客女王: [
    "junkerqueen",
    "junker-queen",
    "渣客女王",
    "女王",
    "渣女",
    "扎克",
  ],
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
    "小8D",
    "幽默跑步男",
  ],
  黑影: ["sombra", "黑影", "邓紫琪", "邓紫棋"],
  秩序之光: [
    "symmetra",
    "秩序之光",
    "光子",
    "光子妹",
    "光妹",
    "三妹",
    "阿三",
    "辛梅塔",
  ],
  托比昂: [
    "torbjorn",
    "托比昂",
    "托比",
    "托比昂哥",
    "托比哥",
    "中锤",
    "矮子",
    "炮台",
    "矮人",
  ],
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
  黑百合: [
    "widowmaker",
    "黑百合",
    "百合",
    "黑寡妇",
    "狙",
    "大狙",
    "紫薯",
    "紫薯小人",
  ],
  温斯顿: [
    "winston",
    "温斯顿",
    "猩猩",
    "星星",
    "老詹",
    "牢詹",
    "猴子",
    "詹姆斯",
  ],
  破坏球: ["wreckingball", "wrecking-ball", "破坏球", "球球", "球", "仓鼠"],
  查莉娅: [
    "zarya",
    "查莉娅",
    "毛妹",
    "俄罗斯雨姐",
    "雨姐",
    "东北雨姐",
    "国潮",
    "国潮来袭",
  ],
  禅雅塔: ["zenyatta", "禅雅塔", "和尚", "光头摩西", "悬浮摩西"],
  弗蕾娅: ["freja", "弗蕾娅", "弗蕾娅大人", "芙蕾雅", "芙蕾雅大人"],
  无漾: ["wuyang", "无漾", "玩水摩西", "水男", "无恙", "水摩西", "五羊"],
  斩仇: ["vendetta", "lupa", "斩仇", "狼女", "大剑"],
  安燃: [
    "anran",
    "安燃",
    "姐姐",
    "火女",
    "凤凰女",
    "不知火舞",
    "凤凰",
    "朱雀",
    "不知火",
    "火舞",
    "扇子摩西",
  ],
  金驭: ["domina", "金驭", "金玉", "禁欲", "金御", "妈妈", "妈", "总裁", "金羽"],
  埃姆雷: ["emre", "埃姆雷", "m雷", "猫雷", "艾姆雷"],
  飞天猫: [
    "jetpackcat",
    "jetpack-cat",
    "飞天猫",
    "耄耋",
    "哈基米",
    "猫",
    "猫猫",
    "豪猫",
    "键帽",
  ],
  瑞稀: [
    "mizuki",
    "瑞稀",
    "瑞希",
    "斗笠男",
    "绿帽",
    "乌龟",
    "锁链男",
    "斗笠摩西",
    "河童",
    "镰刀男",
  ],
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

const DASHEN_HERO_GUID_NAMES: Record<string, string> = {
  "207165582859042818": "死神",
  "0x02e0000000000002": "死神",
  "207165582859042819": "猎空",
  "0x02e0000000000003": "猎空",
  "207165582859042820": "天使",
  "0x02e0000000000004": "天使",
  "207165582859042821": "半藏",
  "0x02e0000000000005": "半藏",
  "207165582859042822": "托比昂",
  "0x02e0000000000006": "托比昂",
  "207165582859042823": "莱因哈特",
  "0x02e0000000000007": "莱因哈特",
  "207165582859042824": "法老之鹰",
  "0x02e0000000000008": "法老之鹰",
  "207165582859042825": "温斯顿",
  "0x02e0000000000009": "温斯顿",
  "207165582859042826": "黑百合",
  "0x02e000000000000a": "黑百合",
  "207165582859042837": "堡垒",
  "0x02e0000000000015": "堡垒",
  "207165582859042838": "秩序之光",
  "0x02e0000000000016": "秩序之光",
  "207165582859042848": "禅雅塔",
  "0x02e0000000000020": "禅雅塔",
  "207165582859042857": "源氏",
  "0x02e0000000000029": "源氏",
  "207165582859042880": "路霸",
  "0x02e0000000000040": "路霸",
  "207165582859042882": "卡西迪",
  "0x02e0000000000042": "卡西迪",
  "207165582859042917": "狂鼠",
  "0x02e0000000000065": "狂鼠",
  "207165582859042920": "查莉娅",
  "0x02e0000000000068": "查莉娅",
  "207165582859042926": "士兵：76",
  "0x02e000000000006e": "士兵：76",
  "207165582859042937": "卢西奥",
  "0x02e0000000000079": "卢西奥",
  "207165582859042938": "D.Va",
  "0x02e000000000007a": "D.Va",
  "207165582859043037": "美",
  "0x02e00000000000dd": "美",
  "207165582859043118": "黑影",
  "0x02e000000000012e": "黑影",
  "207165582859043119": "末日铁拳",
  "0x02e000000000012f": "末日铁拳",
  "207165582859043131": "安娜",
  "0x02e000000000013b": "安娜",
  "207165582859043134": "奥丽莎",
  "0x02e000000000013e": "奥丽莎",
  "207165582859043221": "布丽吉塔",
  "0x02e0000000000195": "布丽吉塔",
  "207165582859043234": "莫伊拉",
  "0x02e00000000001a2": "莫伊拉",
  "207165582859043274": "破坏球",
  "0x02e00000000001ca": "破坏球",
  "207165582859043308": "索杰恩",
  "0x02e00000000001ec": "索杰恩",
  "207165582859043328": "艾什",
  "0x02e0000000000200": "艾什",
  "207165582859043334": "回声",
  "0x02e0000000000206": "回声",
  "207165582859043361": "巴蒂斯特",
  "0x02e0000000000221": "巴蒂斯特",
  "207165582859043377": "雾子",
  "0x02e0000000000231": "雾子",
  "207165582859043382": "渣客女王",
  "0x02e0000000000236": "渣客女王",
  "207165582859043387": "西格玛",
  "0x02e000000000023b": "西格玛",
  "207165582859043469": "拉玛刹",
  "0x02e000000000028d": "拉玛刹",
  "207165582859043473": "生命之梭",
  "0x02e0000000000291": "生命之梭",
  "207165582859043594": "毛加",
  "0x02e000000000030a": "毛加",
  "207165582859043612": "伊拉锐",
  "0x02e000000000031c": "伊拉锐",
  "207165582859043627": "探奇",
  "0x02e000000000032b": "探奇",
  "207165582859043682": "骇灾",
  "0x02e0000000000362": "骇灾",
  "207165582859043685": "朱诺",
  "0x02e0000000000365": "朱诺",
  "207165582859043626": "弗蕾娅",
  "0x02e000000000032a": "弗蕾娅",
  "207165582859043779": "无漾",
  "0x02e00000000003c3": "无漾",
  "207165582859044061": "安燃",
  "0x02e00000000004dd": "安燃",
  "207165582859044056": "埃姆雷",
  "0x02e00000000004d8": "埃姆雷",
  "207165582859044036": "金驭",
  "0x02e00000000004c4": "金驭",
  "207165582859044067": "瑞稀",
  "0x02e00000000004e3": "瑞稀",
  "207165582859044118": "飞天猫",
  "0x02e0000000000516": "飞天猫",
  "207165582859043954": "斩仇",
  "0x02e0000000000472": "斩仇",
  "207165582859044050": "西拉",
  "0x02e00000000004d2": "西拉",
  "207165582859044140": "死怨",
  "0x02e000000000052c": "死怨",
  "207165582859044162": "D.Mon",
  "0x02e0000000000542": "D.Mon",
  "207165582859044208": "血律",
  "0x02e0000000000570": "血律",
};

const DASHEN_MAP_NAMES: Record<string, string> = {
  "576460752303423579": "阿努比斯神殿",
  "0x080000000000005b": "阿努比斯神殿",
  "576460752303423700": "国王大道",
  "0x08000000000000d4": "国王大道",
  "576460752303423845": "花村",
  "0x0800000000000165": "花村",
  "576460752303423876": "监测站：直布罗陀",
  "0x0800000000000184": "监测站：直布罗陀",
  "576460752303423956": "努巴尼",
  "0x08000000000001d4": "努巴尼",
  "576460752303423963": "沃斯卡娅工业区",
  "0x08000000000001db": "沃斯卡娅工业区",
  "576460752303424175": "好莱坞",
  "0x08000000000002af": "好莱坞",
  "576460752303424195": "多拉多",
  "0x08000000000002c3": "多拉多",
  "576460752303424695": "尼泊尔",
  "0x08000000000004b7": "尼泊尔",
  "576460752303424955": "66号公路",
  "0x08000000000005bb": "66号公路",
  "576460752303425121": "教学模式",
  "0x0800000000000661": "教学模式",
  "576460752303425122": "漓江塔",
  "0x0800000000000662": "漓江塔",
  "576460752303425133": "伊利奥斯",
  "0x080000000000066d": "伊利奥斯",
  "576460752303425160": "训练靶场",
  "0x0800000000000688": "训练靶场",
  "576460752303425165": "艾兴瓦尔德",
  "0x080000000000068d": "艾兴瓦尔德",
  "576460752303425182": "绿洲城",
  "0x080000000000069e": "绿洲城",
  "576460752303425195": "好莱坞",
  "0x08000000000006ab": "好莱坞",
  "576460752303425201": "国王大道",
  "0x08000000000006b1": "国王大道",
  "576460752303425203": "弗格体育场",
  "0x08000000000006b3": "弗格体育场",
  "576460752303425205": "花村",
  "0x08000000000006b5": "花村",
  "576460752303425207": "漓江塔",
  "0x08000000000006b7": "漓江塔",
  "576460752303425223": "VPP Green Room",
  "0x08000000000006c7": "VPP Green Room",
  "576460752303425225": "怪鼠复仇",
  "0x08000000000006c9": "怪鼠复仇",
  "576460752303425233": "生态监测站：南极洲",
  "0x08000000000006d1": "生态监测站：南极洲",
  "576460752303425235": "“地平线”月球基地",
  "0x08000000000006d3": "“地平线”月球基地",
  "576460752303425285": "墓园",
  "0x0800000000000705": "墓园",
  "576460752303425292": "黑森林",
  "0x080000000000070c": "黑森林",
  "576460752303425293": "生态监测站：南极洲",
  "0x080000000000070d": "生态监测站：南极洲",
  "576460752303425297": "漓江塔庭院",
  "0x0800000000000711": "漓江塔庭院",
  "576460752303425298": "漓江塔夜市",
  "0x0800000000000712": "漓江塔夜市",
  "576460752303425303": "尼泊尔圣所",
  "0x0800000000000717": "尼泊尔圣所",
  "576460752303425306": "漓江塔控制中心",
  "0x080000000000071a": "漓江塔控制中心",
  "576460752303425308": "城堡",
  "0x080000000000071c": "城堡",
  "576460752303425334": "尼泊尔村庄",
  "0x0800000000000736": "尼泊尔村庄",
  "576460752303425336": "尼泊尔圣坛",
  "0x0800000000000738": "尼泊尔圣坛",
  "576460752303425338": "伊利奥斯深井",
  "0x080000000000073a": "伊利奥斯深井",
  "576460752303425341": "伊利奥斯灯塔",
  "0x080000000000073d": "伊利奥斯灯塔",
  "576460752303425342": "伊利奥斯废墟",
  "0x080000000000073e": "伊利奥斯废墟",
  "576460752303425348": "漓江塔控制中心",
  "0x0800000000000744": "漓江塔控制中心",
  "576460752303425349": "漓江塔庭院",
  "0x0800000000000745": "漓江塔庭院",
  "576460752303425350": "漓江塔夜市",
  "0x0800000000000746": "漓江塔夜市",
  "576460752303425354": "绿洲城中心",
  "0x080000000000074a": "绿洲城中心",
  "576460752303425356": "绿洲城花园",
  "0x080000000000074c": "绿洲城花园",
  "576460752303425357": "绿洲城大学",
  "0x080000000000074d": "绿洲城大学",
  "576460752303425366": "渣客镇",
  "0x0800000000000756": "渣客镇",
  "576460752303425374": "暴雪世界",
  "0x080000000000075e": "暴雪世界",
  "576460752303425441": "阿育陀耶",
  "0x08000000000007a1": "阿育陀耶",
  "576460752303425444": "吉拉德堡",
  "0x08000000000007a4": "吉拉德堡",
  "576460752303425506": "釜山",
  "0x08000000000007e2": "釜山",
  "576460752303425524": "阿德勒斯布鲁恩",
  "0x08000000000007f4": "阿德勒斯布鲁恩",
  "576460752303425527": "黑森林",
  "0x08000000000007f7": "黑森林",
  "576460752303425533": "圣诞节尼泊尔村庄",
  "0x08000000000007fd": "圣诞节尼泊尔村庄",
  "576460752303425575": "皇家赛道",
  "0x0800000000000827": "皇家赛道",
  "576460752303425590": "吉拉德堡",
  "0x0800000000000836": "吉拉德堡",
  "576460752303425649": "里阿尔托",
  "0x0800000000000871": "里阿尔托",
  "576460752303425680": "佩特拉",
  "0x0800000000000890": "佩特拉",
  "576460752303425681": "巴黎",
  "0x0800000000000891": "巴黎",
  "576460752303425848": "帕拉伊苏",
  "0x0800000000000938": "帕拉伊苏",
  "576460752303426116": "哈瓦那",
  "0x0800000000000a44": "哈瓦那",
  "576460752303426139": "暴雪世界",
  "0x0800000000000a5b": "暴雪世界",
  "576460752303426170": "釜山寺院",
  "0x0800000000000a7a": "釜山寺院",
  "576460752303426182": "釜山城区",
  "0x0800000000000a86": "釜山城区",
  "576460752303426283": "新皇后街",
  "0x0800000000000aeb": "新皇后街",
  "576460752303426300": "里约热内卢",
  "0x0800000000000afc": "里约热内卢",
  "576460752303426356": "斗兽场",
  "0x0800000000000b34": "斗兽场",
  "576460752303426380": "中城",
  "0x0800000000000b4c": "中城",
  "576460752303426496": "多伦多",
  "0x0800000000000bc0": "多伦多",
  "576460752303426518": "哥德堡",
  "0x0800000000000bd6": "哥德堡",
  "576460752303426624": "地图工坊岛屿",
  "0x0800000000000c40": "地图工坊岛屿",
  "576460752303426628": "地图工坊空地",
  "0x0800000000000c44": "地图工坊空地",
  "576460752303426632": "地图工坊室内",
  "0x0800000000000c48": "地图工坊室内",
  "576460752303426693": "香巴里寺院",
  "0x0800000000000c85": "香巴里寺院",
  "576460752303426734": "巴黎",
  "0x0800000000000cae": "巴黎",
  "576460752303426768": "地图工坊空地（夜间）",
  "0x0800000000000cd0": "地图工坊空地（夜间）",
  "576460752303426769": "地图工坊岛屿（夜间）",
  "0x0800000000000cd1": "地图工坊岛屿（夜间）",
  "576460752303426771": "铁坂",
  "0x0800000000000cd3": "铁坂",
  "576460752303426775": "马莱温多",
  "0x0800000000000cd7": "马莱温多",
  "576460752303426780": "釜山体育场",
  "0x0800000000000cdc": "釜山体育场",
  "576460752303426795": "悉尼海港竞技场",
  "0x0800000000000ceb": "悉尼海港竞技场",
  "576460752303426802": "南极半岛",
  "0x0800000000000cf2": "南极半岛",
  "576460752303426878": "苏拉瓦萨",
  "0x0800000000000d3e": "苏拉瓦萨",
  "576460752303426892": "地图工坊绿幕",
  "0x0800000000000d4c": "地图工坊绿幕",
  "576460752303426899": "埃斯佩兰萨",
  "0x0800000000000d53": "埃斯佩兰萨",
  "576460752303427091": "新渣客城",
  "0x0800000000000e13": "新渣客城",
  "576460752303427250": "鲁纳塞彼",
  "0x0800000000000eb2": "鲁纳塞彼",
  "576460752303427264": "萨摩亚",
  "0x0800000000000ec0": "萨摩亚",
  "576460752303427312": "教学模式",
  "0x0800000000000ef0": "教学模式",
  "576460752303427322": "铁坂",
  "0x0800000000000efa": "铁坂",
  "576460752303427345": "铁坂",
  "0x0800000000000f11": "铁坂",
  "576460752303427346": "铁坂",
  "0x0800000000000f12": "铁坂",
  "576460752303427554": "英雄精通：索杰恩",
  "0x0800000000000fe2": "英雄精通：索杰恩",
  "576460752303427574": "英雄精通：莱因哈特",
  "0x0800000000000ff6": "英雄精通：莱因哈特",
  "576460752303427575": "英雄精通",
  "0x0800000000000ff7": "英雄精通",
  "576460752303427579": "英雄精通：猎空",
  "0x0800000000000ffb": "英雄精通：猎空",
  "576460752303427585": "英雄精通：士兵：76",
  "0x0800000000001001": "英雄精通：士兵：76",
  "576460752303427608": "国王大道",
  "0x0800000000001018": "国王大道",
  "576460752303427634": "斗兽场",
  "0x0800000000001032": "斗兽场",
  "576460752303427654": "英雄精通：源氏",
  "0x0800000000001046": "英雄精通：源氏",
  "576460752303427662": "英雄精通：温斯顿",
  "0x080000000000104e": "英雄精通：温斯顿",
  "576460752303427666": "英雄精通：天使",
  "0x0800000000001052": "英雄精通：天使",
  "576460752303427679": "英雄精通：查莉娅",
  "0x080000000000105f": "英雄精通：查莉娅",
  "576460752303427683": "英雄精通：法老之鹰",
  "0x0800000000001063": "英雄精通：法老之鹰",
  "576460752303427686": "英雄精通：回声",
  "0x0800000000001066": "英雄精通：回声",
  "576460752303427719": "英雄精通：试炼场",
  "0x0800000000001087": "英雄精通：试炼场",
  "576460752303427770": "英雄精通：美",
  "0x08000000000010ba": "英雄精通：美",
  "576460752303427798": "南极半岛",
  "0x08000000000010d6": "南极半岛",
  "576460752303427814": "苏拉瓦萨",
  "0x08000000000010e6": "苏拉瓦萨",
  "576460752303427815": "苏拉瓦萨",
  "0x08000000000010e7": "苏拉瓦萨",
  "576460752303427816": "新渣客城",
  "0x08000000000010e8": "新渣客城",
  "576460752303427817": "新渣客城",
  "0x08000000000010e9": "新渣客城",
  "576460752303427868": "国王大道",
  "0x080000000000111c": "国王大道",
  "576460752303427869": "国王大道",
  "0x080000000000111d": "国王大道",
  "576460752303427907": "漓江塔",
  "0x0800000000001143": "漓江塔",
  "576460752303427920": "漓江塔",
  "0x0800000000001150": "漓江塔",
  "576460752303427947": "“地平线”月球基地",
  "0x080000000000116b": "“地平线”月球基地",
  "576460752303427968": "绿洲城",
  "0x0800000000001180": "绿洲城",
  "576460752303428025": "花村",
  "0x08000000000011b9": "花村",
  "576460752303428044": "好莱坞",
  "0x08000000000011cc": "好莱坞",
  "576460752303428064": "尼泊尔",
  "0x08000000000011e0": "尼泊尔",
  "576460752303428098": "黑森林",
  "0x0800000000001202": "黑森林",
  "576460752303428116": "釜山",
  "0x0800000000001214": "釜山",
  "576460752303428117": "釜山",
  "0x0800000000001215": "釜山",
  "576460752303428141": "里约热内卢",
  "0x080000000000122d": "里约热内卢",
  "576460752303428162": "新渣客城",
  "0x0800000000001242": "新渣客城",
  "576460752303428164": "新渣客城",
  "0x0800000000001244": "新渣客城",
  "576460752303428166": "苏拉瓦萨",
  "0x0800000000001246": "苏拉瓦萨",
  "576460752303428168": "苏拉瓦萨",
  "0x0800000000001248": "苏拉瓦萨",
  "576460752303428170": "萨摩亚",
  "0x080000000000124a": "萨摩亚",
  "576460752303428172": "萨摩亚",
  "0x080000000000124c": "萨摩亚",
  "576460752303428174": "鲁纳塞彼",
  "0x080000000000124e": "鲁纳塞彼",
  "576460752303428176": "鲁纳塞彼",
  "0x0800000000001250": "鲁纳塞彼",
  "576460752303428178": "阿努比斯神殿",
  "0x0800000000001252": "阿努比斯神殿",
  "576460752303428180": "铁坂",
  "0x0800000000001254": "铁坂",
  "576460752303428208": "弗格体育场",
  "0x0800000000001270": "弗格体育场",
  "576460752303428210": "直布罗陀",
  "0x0800000000001272": "直布罗陀",
  "576460752303428212": "阿育陀耶",
  "0x0800000000001274": "阿育陀耶",
  "576460752303428238": "努巴尼",
  "0x080000000000128e": "努巴尼",
  "576460752303428258": "阿德勒斯布鲁恩",
  "0x08000000000012a2": "阿德勒斯布鲁恩",
  "576460752303428268": "艾兴瓦尔德",
  "0x08000000000012ac": "艾兴瓦尔德",
  "576460752303428286": "埃斯佩兰萨",
  "0x08000000000012be": "埃斯佩兰萨",
  "576460752303428290": "花村",
  "0x08000000000012c2": "花村",
  "576460752303428308": "新皇后街",
  "0x08000000000012d4": "新皇后街",
  "576460752303428338": "哈瓦那",
  "0x08000000000012f2": "哈瓦那",
  "576460752303428358": "多拉多",
  "0x0800000000001306": "多拉多",
  "576460752303428368": "66号公路",
  "0x0800000000001310": "66号公路",
  "576460752303428394": "帕拉伊苏",
  "0x080000000000132a": "帕拉伊苏",
  "576460752303428408": "渣客镇",
  "0x0800000000001338": "渣客镇",
  "576460752303428430": "中城",
  "0x080000000000134e": "中城",
  "576460752303428438": "暴雪世界",
  "0x0800000000001356": "暴雪世界",
};

const DASHEN_RANK_TIERS: Record<string, string> = {
  bronze: "青铜",
  silver: "白银",
  gold: "黄金",
  platinum: "白金",
  diamond: "钻石",
  master: "大师",
  grandmaster: "宗师",
  champion: "冠军",
  top500: "500强",
  unranked: "未定级",
  "1": "青铜",
  "2": "白银",
  "3": "黄金",
  "4": "白金",
  "5": "钻石",
  "6": "大师",
  "7": "宗师",
  "8": "冠军",
};

const PERMISSION_LABELS: Record<string, string> = {
  "user:view": "查看用户资料",
  "quota:add": "添加锐评次数",
  "quota:deduct": "减少锐评次数",
  "vip:manage": "管理 VIP 会员",
  "redeem:create": "生成兑换卡密",
  "redeem:view": "查询卡密",
  "redeem:void": "作废卡密",
  "user:ban": "封禁/解封用户",
  "stats:view": "查看运营统计",
};

const ALL_ADMIN_PERMISSIONS = Object.keys(PERMISSION_LABELS);

// ============================================================================
// 3. 基础工具、消息防重复编辑与格式化辅助
// ============================================================================

function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeBnetQuery(raw: string): string {
  return String(raw || "")
    .replace(/＃/g, "#")
    .trim();
}

function isValidBnetTag(bnet: string): boolean {
  return /^[^#\s]{1,32}#\d{2,10}$/.test(bnet);
}

function getDisplayNameFromCtx(ctx: Context): string {
  const from = ctx.from;
  if (!from) return "";
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return full || from.username || `TG#${from.id}`;
}

function getUsernameFromCtx(ctx: Context): string {
  return String(ctx.from?.username || "").replace(/^@+/, "").trim();
}

function formatNumber(val: unknown): string {
  const n = Number(val);
  if (!Number.isFinite(n)) return String(val ?? "0");
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatWinRate(val: unknown): string {
  if (val === undefined || val === null || val === "") return "0.0%";
  const s = String(val).trim();
  if (s.endsWith("%")) return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  return `${pct.toFixed(1)}%`;
}

function formatDuration(secondsRaw: unknown): string {
  const sec = Number(secondsRaw);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}分钟`;
  const hrs = (mins / 60).toFixed(1);
  return `${hrs}小时`;
}

function formatMatchTimestamp(tsRaw: unknown): string {
  if (!tsRaw) return "未知时间";
  const num = Number(tsRaw);
  let date: Date;
  if (Number.isFinite(num) && num > 0) {
    const ms = num < 1e12 ? num * 1000 : num;
    date = new Date(ms);
  } else {
    const parsed = Date.parse(String(tsRaw));
    if (Number.isNaN(parsed)) return String(tsRaw);
    date = new Date(parsed);
  }
  if (Number.isNaN(date.getTime())) return String(tsRaw);

  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.month}/${map.day} ${map.hour}:${map.minute}`;
}

function resolveDashenHeroName(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  const s = String(raw).trim();
  if (!s) return "";
  if (DASHEN_HERO_GUID_NAMES[s]) return DASHEN_HERO_GUID_NAMES[s];
  const lowerHex = s.toLowerCase();
  if (DASHEN_HERO_GUID_NAMES[lowerHex]) return DASHEN_HERO_GUID_NAMES[lowerHex];
  if (HERO_ALIAS_TO_CN[lowerHex]) return HERO_ALIAS_TO_CN[lowerHex];
  return s;
}

function resolveDashenMapGuid(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  const s = String(raw).trim();
  if (!s) return "";
  if (DASHEN_MAP_NAMES[s]) return DASHEN_MAP_NAMES[s];
  const lower = s.toLowerCase();
  if (DASHEN_MAP_NAMES[lower]) return DASHEN_MAP_NAMES[lower];
  return s;
}

function translateRankTier(rawTier: unknown): string {
  if (rawTier === undefined || rawTier === null || rawTier === "") return "";
  const s = String(rawTier).trim();
  const lower = s.toLowerCase();
  if (DASHEN_RANK_TIERS[lower]) return DASHEN_RANK_TIERS[lower];
  for (const [k, v] of Object.entries(DASHEN_RANK_TIERS)) {
    if (lower.includes(k)) return v;
  }
  return s;
}

function formatRankSegment(rankObj: any): string {
  if (!rankObj) return "";
  if (typeof rankObj === "string") {
    const t = translateRankTier(rankObj);
    return t || rankObj;
  }
  if (typeof rankObj !== "object") return "";
  const rawName =
    rankObj.rankName ||
    rankObj.rank_name ||
    rankObj.tierName ||
    rankObj.tier_name ||
    rankObj.division ||
    rankObj.rank ||
    rankObj.tier ||
    "";
  const tierCn = translateRankTier(rawName);
  const divNum =
    rankObj.rankSubTier ??
    rankObj.rank_sub_tier ??
    rankObj.subTier ??
    rankObj.sub_tier ??
    rankObj.divisionNum ??
    rankObj.division_num ??
    rankObj.rankNum ??
    "";
  const sr =
    rankObj.rankScore ??
    rankObj.rank_score ??
    rankObj.score ??
    rankObj.sr ??
    rankObj.rating ??
    "";

  const mainLabel = tierCn || String(rawName || "").trim();
  if (!mainLabel && !sr) return "";
  const subLabel =
    divNum !== "" && divNum !== null && divNum !== undefined && Number(divNum) > 0
      ? ` ${divNum}`
      : "";
  const srLabel =
    sr !== "" && sr !== null && sr !== undefined && Number(sr) > 0
      ? ` (${sr}分)`
      : "";
  return `${mainLabel}${subLabel}${srLabel}`.trim();
}

function translateRoleType(roleVal: unknown): string {
  const s = String(roleVal || "").trim().toLowerCase();
  if (!s) return "";
  if (
    s === "tank" ||
    s.includes("tank") ||
    s.includes("重装") ||
    s.includes("坦克")
  )
    return "重装";
  if (
    s === "dps" ||
    s.includes("dps") ||
    s.includes("damage") ||
    s.includes("输出") ||
    s.includes("伤害")
  )
    return "输出";
  if (
    s === "support" ||
    s === "healer" ||
    s.includes("support") ||
    s.includes("healer") ||
    s.includes("支援") ||
    s.includes("治疗")
  )
    return "支援";
  if (s === "open") return "自由队列";
  return String(roleVal);
}

function translateModeCode(modeVal: unknown): string {
  const s = String(modeVal || "").trim().toLowerCase();
  if (!s) return "";
  if (
    s === "sport" ||
    s === "sportopen" ||
    s.includes("comp") ||
    s.includes("竞技")
  )
    return "竞技比赛";
  if (
    s === "leisure" ||
    s.includes("quick") ||
    s.includes("快速") ||
    s.includes("休闲")
  )
    return "快速/休闲";
  return String(modeVal);
}

function resolveGuideCountSection(
  countData: any,
  mode: CnGameMode
): { section: any; roleKey: string } {
  if (!countData || typeof countData !== "object") {
    return { section: {}, roleKey: "" };
  }
  const guide =
    countData.guideCountData && typeof countData.guideCountData === "object"
      ? countData.guideCountData
      : countData;

  const preferredKeys =
    mode === "sport"
      ? ["dps", "healer", "tank", "open"]
      : ["open", "dps", "healer", "tank"];

  for (const k of preferredKeys) {
    const sub = guide?.[k];
    if (sub && typeof sub === "object" && !Array.isArray(sub)) {
      const hasStats =
        sub.matchSum !== undefined ||
        sub.lastRankInfo !== undefined ||
        sub.maxRankInfo !== undefined ||
        Array.isArray(sub.presetsSummaryList) ||
        Array.isArray(sub.openQueueSummaryList);
      if (hasStats) {
        return { section: sub, roleKey: k };
      }
    }
  }

  return { section: guide, roleKey: "" };
}

function extractMatchItemsFromBody(body: any): any[] {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (typeof body !== "object") return [];

  const directKeys = [
    "list",
    "records",
    "matches",
    "matchList",
    "match_list",
    "items",
    "dataList",
    "gameList",
  ];
  for (const k of directKeys) {
    if (Array.isArray(body[k])) return body[k];
  }

  for (const val of Object.values(body)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
      return val;
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      for (const nk of directKeys) {
        if (Array.isArray((val as any)[nk])) return (val as any)[nk];
      }
    }
  }
  return [];
}

function maskTokenDisplay(token: string): string {
  const t = String(token || "").trim();
  if (!t) return "未配置";
  if (t.length <= 8) return `${t.slice(0, 2)}****`;
  return `${t.slice(0, 6)}****${t.slice(-4)}`;
}

async function safeEditTextMessage(
  ctx: Context,
  text: string,
  extra: Parameters<Context["editMessageText"]>[1],
  unchangedToast = "内容已是最新"
): Promise<void> {
  if (!ctx.callbackQuery?.message) {
    await ctx.reply(text, extra as any);
    return;
  }
  try {
    await ctx.editMessageText(text, extra);
  } catch (err: any) {
    const errMsg = String(err?.message || err || "");
    if (errMsg.includes("message is not modified")) {
      await ctx
        .answerCallbackQuery({ text: unchangedToast, show_alert: false })
        .catch(() => {});
      return;
    }
    throw err;
  }
}

function formatUserNameWithId(u: any): string {
  const nick =
    String(u?.nickname || "").trim() ||
    (u?.username ? `@${u.username}` : `TG#${u?.tgId || ""}`);
  return `${nick}-${Number(u?.tgId || 0)}`;
}

function formatRedeemTypeLabel(rewardType: unknown): string {
  const t = String(rewardType || "").trim();
  if (t === "vip_days") return "VIP 天数卡密";
  return "锐评次数卡密";
}

function formatRedeemRewardText(
  rewardType: unknown,
  rewardValue: unknown
): string {
  const val = Number(rewardValue || 0);
  if (String(rewardType || "").trim() === "vip_days") {
    return `${val} 天`;
  }
  return `+${val} 次`;
}

function formatRedeemStatusLabel(status: unknown): string {
  const s = String(status || "").trim().toLowerCase();
  if (s === "used") return "✅ 已使用";
  if (s === "voided") return "🚫 已作废";
  return "🟢 未使用";
}

async function replyQuoteUser(
  ctx: Context,
  htmlText: string,
  extra: Record<string, any> = {}
): Promise<void> {
  const replyToId = ctx.message?.message_id;
  await ctx.reply(htmlText, {
    parse_mode: "HTML",
    ...(replyToId ? { reply_to_message_id: replyToId } : {}),
    ...extra,
  });
}

// ============================================================================
// 4. 敏感消息自动删除工具
// ============================================================================

async function tryDeleteMessage(
  ctx: Context,
  chatId?: number,
  messageId?: number
): Promise<void> {
  const targetChatId = chatId ?? ctx.chat?.id;
  const targetMsgId = messageId ?? ctx.msg?.message_id;
  if (!targetChatId || !targetMsgId) return;
  try {
    await ctx.api.deleteMessage(targetChatId, targetMsgId);
  } catch {
    // 忽略删除失败
  }
}

// ============================================================================
// 5. 业务中转与分层缓存请求封装（/internal/*）
// ============================================================================

async function relayInternalRequest<T = any>(
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    query?: Record<string, string | number | undefined>;
    body?: Record<string, any>;
    operatorId?: number;
    userId?: number;
    timeoutMs?: number;
  } = {}
): Promise<T> {
  const url = new URL(`${DASHEN_RELAY_ORIGIN}${path}`);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null && String(v) !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (RELAY_SECRET) {
    headers["x-relay-secret"] = RELAY_SECRET;
  }
  if (options.operatorId && options.operatorId > 0) {
    headers["x-operator-id"] = String(options.operatorId);
  }
  if (options.userId && options.userId > 0) {
    headers["x-user-id"] = String(options.userId);
  }
  if (options.method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url.toString(), {
    method: options.method || "GET",
    headers,
    body:
      options.method === "POST"
        ? JSON.stringify(options.body || {})
        : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || RELAY_TIMEOUT_MS),
  });

  const rawText = await res.text().catch(() => "");
  let parsed: any = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const errMsg =
      parsed?.error ||
      parsed?.message ||
      rawText.slice(0, 200) ||
      `HTTP ${res.status}`;
    const err: any = new Error(errMsg);
    err.status = res.status;
    err.code = parsed?.code || "RELAY_ERROR";
    throw err;
  }

  return parsed as T;
}

async function lookupCachedBnetPlayer(
  exactBnet: string
): Promise<{ bnetName: string; customerToken: string } | null> {
  try {
    const res = await relayInternalRequest<{
      ok: boolean;
      hit: boolean;
      player?: {
        bnetKey?: string;
        bnetName?: string;
        customerToken?: string;
      } | null;
    }>("/internal/dashen/player-cache", {
      method: "GET",
      query: { bnet: exactBnet },
      timeoutMs: 6000,
    });
    const token = String(res?.player?.customerToken || "").trim();
    if (res?.hit && token) {
      return {
        bnetName: String(res.player?.bnetName || exactBnet).trim() || exactBnet,
        customerToken: token,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function persistCachedBnetPlayer(params: {
  bnetKey: string;
  bnetName: string;
  customerToken: string;
}): Promise<void> {
  try {
    await relayInternalRequest("/internal/dashen/player-cache", {
      method: "POST",
      body: {
        bnetKey: params.bnetKey,
        bnetName: params.bnetName,
        customerToken: params.customerToken,
      },
      timeoutMs: 6000,
    });
  } catch {
    // 忽略缓存写入异常
  }
}

async function ensureUserRegistered(
  ctx: Context,
  inviterId: number | null = null
): Promise<{
  isNewUser: boolean;
  inviteRewardGranted: boolean;
  inviteRewardQuota: number;
  user: UserProfileDto;
  settings: SystemSettingsDto;
}> {
  const tgId = ctx.from?.id;
  if (!tgId) {
    throw new Error("无法获取 Telegram 用户信息");
  }
  const res = await relayInternalRequest<{
    ok: boolean;
    data: {
      isNewUser: boolean;
      inviteRewardGranted: boolean;
      inviteRewardQuota: number;
      user: UserProfileDto;
      settings: SystemSettingsDto;
    };
  }>("/internal/user/ensure", {
    method: "POST",
    body: {
      tgId,
      nickname: getDisplayNameFromCtx(ctx),
      username: getUsernameFromCtx(ctx),
      inviterId,
    },
  });
  return res.data;
}

async function getUserProfile(ctx: Context): Promise<UserProfileDto> {
  const tgId = ctx.from?.id;
  if (!tgId) throw new Error("无法获取 Telegram 用户信息");
  const res = await relayInternalRequest<{ ok: boolean; data: UserProfileDto }>(
    "/internal/user/profile",
    {
      method: "GET",
      query: {
        tgId,
        nickname: getDisplayNameFromCtx(ctx),
        username: getUsernameFromCtx(ctx),
      },
    }
  );
  return res.data;
}

async function doUserCheckin(ctx: Context): Promise<{
  alreadyCheckedIn: boolean;
  today: string;
  rewardEnabled: boolean;
  rewardQuota: number;
  quota: number;
}> {
  const tgId = ctx.from?.id;
  if (!tgId) throw new Error("无法获取 Telegram 用户信息");
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/user/checkin",
    {
      method: "POST",
      body: {
        tgId,
        nickname: getDisplayNameFromCtx(ctx),
        username: getUsernameFromCtx(ctx),
      },
    }
  );
  return res.data;
}

async function doUserRedeem(
  ctx: Context,
  code: string
): Promise<{
  code: string;
  rewardType: "quota" | "vip_days";
  rewardValue: number;
  quota: number;
  vipExpireAt: string | null;
}> {
  const tgId = ctx.from?.id;
  if (!tgId) throw new Error("无法获取 Telegram 用户信息");
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/user/redeem",
    {
      method: "POST",
      body: {
        tgId,
        code,
        nickname: getDisplayNameFromCtx(ctx),
        username: getUsernameFromCtx(ctx),
      },
    }
  );
  return res.data;
}

async function authorizeRoastForUser(ctx: Context): Promise<{
  allowed: boolean;
  unlimited: boolean;
  exemptReason: "admin" | "vip" | null;
  quota: number;
}> {
  const tgId = ctx.from?.id;
  if (!tgId) throw new Error("无法获取 Telegram 用户信息");
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/roast/authorize",
    {
      method: "POST",
      body: {
        tgId,
        nickname: getDisplayNameFromCtx(ctx),
        username: getUsernameFromCtx(ctx),
      },
    }
  );
  return res.data;
}

async function consumeRoastQuotaForUser(
  tgId: number,
  roastType: RoastType,
  detail: string
): Promise<{ consumed: boolean; unlimited: boolean; quota: number }> {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/roast/consume",
    {
      method: "POST",
      body: {
        tgId,
        roastType: `roast_${roastType}`,
        detail,
      },
    }
  );
  return res.data;
}

async function fetchCachedRoast(
  cacheKey: string,
  roastType: RoastType
): Promise<{
  cacheKey: string;
  roastType: string;
  providerId: number;
  providerName: string;
  modelName: string;
  operatorNickname: string;
  reviewHtml: string;
  hitCount: number;
  updatedAt: string;
} | null> {
  const res = await relayInternalRequest<{
    ok: boolean;
    hit: boolean;
    record: any;
  }>("/internal/roast/cache/get", {
    method: "GET",
    query: { cacheKey, roastType },
  });
  return res?.hit && res?.record ? res.record : null;
}

async function saveRoastCacheRecord(params: {
  cacheKey: string;
  roastType: RoastType;
  providerId: number;
  providerName: string;
  modelName: string;
  gameMode: string;
  bnet: string;
  operatorNickname: string;
  matchId?: string;
  reviewHtml: string;
}): Promise<void> {
  await relayInternalRequest("/internal/roast/cache/set", {
    method: "POST",
    body: {
      ...params,
      operator_nickname: params.operatorNickname,
    },
  });
}

// ============================================================================
// 6. 管理员与超级管理员接口封装（两级权限编辑视图、每页 10 人用户分页、全量查卡密、AI 渠道、轮询账号）
// ============================================================================

async function fetchAdminMe(operatorId: number): Promise<AdminMeDto | null> {
  try {
    const res = await relayInternalRequest<{ ok: boolean; data: AdminMeDto }>(
      "/internal/admin/me",
      {
        method: "GET",
        operatorId,
      }
    );
    return res?.data || null;
  } catch {
    return null;
  }
}

async function adminQueryUserOrList(
  operatorId: number,
  queryText: string,
  page = 1,
  pageSize = 10
): Promise<any> {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/user",
    {
      method: "GET",
      operatorId,
      query: { query: queryText, page, pageSize },
    }
  );
  return res.data;
}

type UserPickerScene =
  | "query"
  | "quota_add"
  | "quota_deduct"
  | "vip"
  | "ban"
  | "admin_add";

function buildUserPageKeyboard(
  scene: UserPickerScene,
  page: number,
  totalPages: number,
  backCallback = "adm:home"
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (totalPages > 1) {
    if (page > 1) {
      kb.text("⬅️ 上一页", `adm:up:${scene}:${page - 1}`);
    }
    if (page < totalPages) {
      kb.text("➡️ 下一页", `adm:up:${scene}:${page + 1}`);
    }
    kb.row();
  }
  kb.text("🔙 返回控制台", backCallback);
  return kb;
}

async function renderUserPagePanel(
  ctx: Context,
  operatorId: number,
  scene: UserPickerScene,
  page = 1,
  editMessage = false
): Promise<void> {
  const data = await adminQueryUserOrList(operatorId, "all", page, 10);
  const currentPage = Number(data?.page || 1);
  const totalPages = Math.max(1, Number(data?.totalPages || 1));
  const totalUsers = Number(data?.totalUsers || 0);
  const users = Array.isArray(data?.users) ? data.users : [];
  const bannedUsers = Array.isArray(data?.bannedUsers) ? data.bannedUsers : [];

  const sceneHeader: Record<UserPickerScene, string[]> = {
    query: [
      `👥 <b>用户列表（每页 10 人 · 第 ${currentPage}/${totalPages} 页 · 共 ${totalUsers} 人）</b>`,
      `点击下方 <code>ID</code> 可复制，也可直接发送单个 TG ID 或 <code>@用户名</code> 精确查询：`,
    ],
    quota_add: [
      `➕ <b>为用户增加锐评次数（每页 10 人 · 第 ${currentPage}/${totalPages} 页）</b>`,
      `请按格式输入：<code>用户TG_ID 增加次数 原因</code>（如 <code>123456789 5 活动奖励</code>）`,
      `点击下方用户 <code>ID</code> 即可自动复制：`,
    ],
    quota_deduct: [
      `➖ <b>为用户扣减锐评次数（每页 10 人 · 第 ${currentPage}/${totalPages} 页）</b>`,
      `请按格式输入：<code>用户TG_ID 扣减次数 原因</code>（如 <code>123456789 2 违规扣除</code>）`,
      `点击下方用户 <code>ID</code> 即可自动复制：`,
    ],
    vip: [
      `👑 <b>VIP 会员管理（每页 10 人 · 第 ${currentPage}/${totalPages} 页）</b>`,
      `开通/续期：<code>用户TG_ID grant 天数 原因</code>`,
      `取消 VIP：<code>用户TG_ID revoke 原因</code>`,
      `点击下方用户 <code>ID</code> 即可自动复制：`,
    ],
    ban: [
      `🔒 <b>封禁 / 解封用户（每页 10 人 · 第 ${currentPage}/${totalPages} 页）</b>`,
      `格式：<code>用户TG_ID ban|unban 原因</code>（如 <code>123456789 ban 刷号</code> 或 <code>123456789 unban 申诉通过</code>）`,
    ],
    admin_add: [
      `➕ <b>添加普通管理员（每页 10 人 · 第 ${currentPage}/${totalPages} 页）</b>`,
      `格式：<code>目标用户TG_ID 备注名</code>（如 <code>123456789 运营小王</code>）`,
      `点击下方用户 <code>ID</code> 即可自动复制：`,
    ],
  };

  const lines: string[] = [
    ...(sceneHeader[scene] || []),
    `━━━━━━━━━━━━━━━━━━`,
  ];

  if (scene === "ban" && bannedUsers.length > 0) {
    lines.push(`🚫 <b>当前已封禁用户（解封点击 ID 复制）</b>`);
    for (const bu of bannedUsers.slice(0, 10)) {
      const nameWithId = formatUserNameWithId(bu);
      lines.push(
        `• <b>${escapeHtml(nameWithId)}</b> — ID：<code>${Number(bu.tgId)}</code>`
      );
    }
    lines.push(`━━━━━━━━━━━━━━━━━━`, `👥 <b>全部用户列表（本页 10 人）</b>`);
  }

  if (users.length === 0) {
    lines.push(`📭 <i>暂无用户数据。</i>`);
  } else {
    const startIdx = (currentPage - 1) * 10;
    users.forEach((u: any, idx: number) => {
      const nick = String(u.nickname || "无昵称");
      const tags: string[] = [];
      if (u.vipActive) tags.push("👑VIP");
      if (u.isBanned) tags.push("🔒已封禁");
      lines.push(
        `${startIdx + idx + 1}. <b>${escapeHtml(nick)}</b> — ID：<code>${Number(u.tgId)}</code>（剩余 <b>${Number(u.quota || 0)}</b> 次${tags.length ? ` · ${tags.join(" ")}` : ""}）`
      );
    });
  }

  const kb = buildUserPageKeyboard(
    scene,
    currentPage,
    totalPages,
    scene === "admin_add" ? "sup:admins" : "adm:home"
  );

  if (editMessage && ctx.callbackQuery?.message) {
    await safeEditTextMessage(
      ctx,
      lines.join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
      "已是当前页"
    );
  } else {
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }
}

async function adminAddUserQuota(
  operatorId: number,
  targetTgId: number,
  amount: number,
  reason: string
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/quota/add",
    {
      method: "POST",
      operatorId,
      body: { targetTgId, amount, reason },
    }
  );
  return res.data;
}

async function adminDeductUserQuota(
  operatorId: number,
  targetTgId: number,
  amount: number,
  reason: string
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/quota/deduct",
    {
      method: "POST",
      operatorId,
      body: { targetTgId, amount, reason },
    }
  );
  return res.data;
}

async function adminSetUserVip(
  operatorId: number,
  targetTgId: number,
  actionType: "grant" | "revoke",
  days: number,
  reason: string
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/vip",
    {
      method: "POST",
      operatorId,
      body: { targetTgId, actionType, days, reason },
    }
  );
  return res.data;
}

async function adminSetUserBan(
  operatorId: number,
  targetTgId: number,
  banned: boolean,
  reason: string
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/user/ban",
    {
      method: "POST",
      operatorId,
      body: { targetTgId, banned, reason },
    }
  );
  return res.data;
}

async function adminGenerateRedeemCodes(
  operatorId: number,
  rewardType: "quota" | "vip_days",
  rewardValue: number,
  count: number
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/redeem/create",
    {
      method: "POST",
      operatorId,
      body: { rewardType, rewardValue, count },
    }
  );
  return res.data;
}

async function adminLookupRedeemCode(operatorId: number, code: string) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/redeem/view",
    {
      method: "GET",
      operatorId,
      query: { code },
    }
  );
  return res.data;
}

async function adminRevokeRedeemCode(
  operatorId: number,
  code: string,
  reason: string
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/redeem/void",
    {
      method: "POST",
      operatorId,
      body: { code, reason },
    }
  );
  return res.data;
}

async function adminFetchStats(operatorId: number) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/stats",
    {
      method: "GET",
      operatorId,
    }
  );
  return res.data;
}

async function superFetchAdminsList(operatorId: number) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/admins",
    {
      method: "GET",
      operatorId,
    }
  );
  return res.data;
}

async function superCreateAdmin(
  operatorId: number,
  targetTgId: number,
  remark: string
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/admins",
    {
      method: "POST",
      operatorId,
      body: { targetTgId, remark },
    }
  );
  return res.data;
}

async function superToggleAdminPermItem(
  operatorId: number,
  targetTgId: number,
  permCode: string
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/admins/permission",
    {
      method: "POST",
      operatorId,
      body: { targetTgId, permCode },
    }
  );
  return res.data;
}

async function superPatchAdminMeta(
  operatorId: number,
  targetTgId: number,
  patch: { remark?: string; isActive?: boolean }
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/admins/meta",
    {
      method: "POST",
      operatorId,
      body: { targetTgId, ...patch },
    }
  );
  return res.data;
}

async function superRemoveAdmin(operatorId: number, targetTgId: number) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/admins",
    {
      method: "DELETE",
      operatorId,
      query: { targetTgId },
    }
  );
  return res.data;
}

/**
 * 第一级：管理员与权限管理列表页（不再把所有人的权限开关混在同一页，改为点击对应管理员进入专属权限编辑页）
 */
async function showAdminsPermissionPanel(
  ctx: Context,
  operatorId: number,
  editMessage = true
): Promise<void> {
  const d = await superFetchAdminsList(operatorId);
  const list = Array.isArray(d?.admins) ? d.admins : [];
  const permLabelsMap: Record<string, string> =
    d?.permissionLabels && typeof d.permissionLabels === "object"
      ? d.permissionLabels
      : PERMISSION_LABELS;

  const lines: string[] = [
    `🧩 <b>管理员与权限管理（列表页）</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `请选择某位普通管理员进入<b>专属权限编辑页</b>，避免多管理员时误改权限：`,
  ];

  const kb = new InlineKeyboard();

  for (const a of list) {
    const roleTag = a.role === "super_admin" ? "👑超管" : "🛡管理";
    const stTag = a.isActive ? "✅启用" : "⏸停用";
    const perms = Array.isArray(a.permissions) ? a.permissions : [];
    const permNamesText =
      a.role === "super_admin"
        ? "全部权限"
        : perms.map((p: string) => permLabelsMap[p] || p).join("、") || "无";

    lines.push(
      `\n• ${roleTag} <b>${escapeHtml(a.remark || String(a.tgId))}</b> (<code>${Number(a.tgId)}</code>) [${stTag}]`,
      `  已开权限：<i>${escapeHtml(permNamesText)}</i>`
    );

    if (a.role !== "super_admin") {
      const uid = Number(a.tgId);
      const adminLabel = String(a.remark || uid);
      kb.text(`🔧 编辑权限 · ${adminLabel} (${uid})`, `sup:adm:edit:${uid}`)
        .row()
        .text(
          a.isActive ? `⏸ 停用 ${uid}` : `▶️ 启用 ${uid}`,
          `sup:adm:tgl:${uid}`
        )
        .text(`🗑 移除 ${uid}`, `sup:adm:del:${uid}`)
        .row();
    }
  }

  kb.text("➕ 添加管理员", "sup:adm:add")
    .text("🔄 刷新列表", "sup:admins")
    .row()
    .text("🔙 返回控制台", "adm:home");

  const text = lines.join("\n");
  if (editMessage && ctx.callbackQuery?.message) {
    await safeEditTextMessage(
      ctx,
      text,
      { parse_mode: "HTML", reply_markup: kb },
      "列表已是最新"
    );
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

/**
 * 第二级：单个管理员专属权限编辑子页面（顶部醒目标识当前正在编辑哪位管理员）
 */
async function showSingleAdminEditPanel(
  ctx: Context,
  operatorId: number,
  targetTgId: number,
  editMessage = true
): Promise<void> {
  const d = await superFetchAdminsList(operatorId);
  const list = Array.isArray(d?.admins) ? d.admins : [];
  const allPerms: string[] =
    Array.isArray(d?.allPermissions) && d.allPermissions.length > 0
      ? d.allPermissions
      : ALL_ADMIN_PERMISSIONS;
  const permLabelsMap: Record<string, string> =
    d?.permissionLabels && typeof d.permissionLabels === "object"
      ? d.permissionLabels
      : PERMISSION_LABELS;

  const targetAdmin = list.find(
    (x: any) => Number(x.tgId) === Number(targetTgId)
  );
  if (!targetAdmin) {
    throw new Error(`未找到 TG ID 为 ${targetTgId} 的管理员`);
  }
  if (targetAdmin.role === "super_admin") {
    throw new Error("超级管理员默认拥有全部权限，无需单独编辑。");
  }

  const perms = Array.isArray(targetAdmin.permissions)
    ? targetAdmin.permissions
    : [];
  const stTag = targetAdmin.isActive ? "✅ 启用中" : "⏸ 已停用";
  const adminName = String(targetAdmin.remark || targetTgId);
  const permSummary =
    perms.map((p: string) => permLabelsMap[p] || p).join("、") || "暂无权限";

  const lines: string[] = [
    `🔧 <b>管理员权限专属编辑页</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🎯 <b>当前正在编辑管理员：${escapeHtml(adminName)}</b>`,
    `• 管理员 TG ID：<code>${Number(targetTgId)}</code>`,
    `• 当前账号状态：<b>${stTag}</b>`,
    `• 当前已开权限：<i>${escapeHtml(permSummary)}</i>`,
    `━━━━━━━━━━━━━━━━━━`,
    `点击下方按钮为 <b>${escapeHtml(adminName)}</b> 切换权限：`,
  ];

  const kb = new InlineKeyboard();
  allPerms.forEach((permCode: string, idx: number) => {
    const enabled = perms.includes(permCode);
    const label = permLabelsMap[permCode] || permCode;
    kb.text(
      `${enabled ? "✅" : "⬜"} ${label}`,
      `sup:adm:perm:${Number(targetTgId)}:${permCode}`
    );
    if (idx % 2 === 1) {
      kb.row();
    }
  });
  if (allPerms.length % 2 === 1) {
    kb.row();
  }

  kb.text("🔙 返回管理员列表", "sup:admins")
    .text("🛠 返回控制台", "adm:home");

  const text = lines.join("\n");
  if (editMessage && ctx.callbackQuery?.message) {
    await safeEditTextMessage(
      ctx,
      text,
      { parse_mode: "HTML", reply_markup: kb },
      "权限状态已是最新"
    );
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

async function superFetchAuditLogs(
  operatorId: number,
  page = 1,
  pageSize = 8
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/audit-logs",
    {
      method: "GET",
      operatorId,
      query: { page, pageSize },
    }
  );
  return res.data;
}

async function superFetchSettings(operatorId: number): Promise<SystemSettingsDto> {
  const res = await relayInternalRequest<{
    ok: boolean;
    data: SystemSettingsDto;
  }>("/internal/admin/settings", {
    method: "GET",
    operatorId,
  });
  return res.data;
}

async function superPatchSettings(
  operatorId: number,
  patch: Partial<SystemSettingsDto>
): Promise<SystemSettingsDto> {
  const res = await relayInternalRequest<{
    ok: boolean;
    data: SystemSettingsDto;
  }>("/internal/admin/settings", {
    method: "POST",
    operatorId,
    body: patch,
  });
  return res.data;
}

async function fetchActiveAiProviders(): Promise<{
  defaultDeepseekEnabled: boolean;
  providers: AiProviderDto[];
}> {
  const res = await relayInternalRequest<{
    ok: boolean;
    data: { defaultDeepseekEnabled: boolean; providers: AiProviderDto[] };
  }>("/internal/ai/providers/active", {
    method: "GET",
  });
  return res.data;
}

async function superFetchAiProviders(operatorId: number): Promise<{
  defaultDeepseekEnabled: boolean;
  providers: AiProviderDto[];
}> {
  const res = await relayInternalRequest<{
    ok: boolean;
    data: { defaultDeepseekEnabled: boolean; providers: AiProviderDto[] };
  }>("/internal/admin/ai-providers", {
    method: "GET",
    operatorId,
  });
  return res.data;
}

async function superAddAiProvider(
  operatorId: number,
  params: {
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    executionTarget?: "vercel" | "docker";
  }
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/ai-providers",
    {
      method: "POST",
      operatorId,
      body: params,
    }
  );
  return res.data;
}

async function superUpdateAiProviderApiKey(
  operatorId: number,
  providerId: number,
  apiKey: string
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/ai-providers/key",
    {
      method: "POST",
      operatorId,
      body: { providerId, apiKey },
    }
  );
  return res.data;
}

async function superSwitchAiProviderTarget(
  operatorId: number,
  providerId: number,
  executionTarget: "vercel" | "docker"
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/ai-providers/target",
    {
      method: "POST",
      operatorId,
      body: { providerId, executionTarget },
    }
  );
  return res.data;
}

async function superToggleAiProviderById(
  operatorId: number,
  providerId: number,
  enabled?: boolean
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/ai-providers/toggle",
    {
      method: "POST",
      operatorId,
      body: { providerId, enabled },
    }
  );
  return res.data;
}

async function superDeleteAiProviderById(
  operatorId: number,
  providerId: number
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/ai-providers",
    {
      method: "DELETE",
      operatorId,
      query: { providerId },
    }
  );
  return res.data;
}

// ============================================================================
// 6.2 网易大神轮询账号池管理与轮询调度
// ============================================================================

function parseRawDashenHeadersInput(rawText: string): {
  name?: string;
  roleId?: number;
  authToken?: string;
  dts?: number;
  server?: number;
  clientType?: string;
  origin?: string;
  referer?: string;
  userAgent?: string;
} {
  const lines = String(rawText || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const out: {
    name?: string;
    roleId?: number;
    authToken?: string;
    dts?: number;
    server?: number;
    clientType?: string;
    origin?: string;
    referer?: string;
    userAgent?: string;
  } = {};

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const val = line.slice(colonIdx + 1).trim();
      if (!val) continue;

      if (
        key === "gl-bigdata-auth-token" ||
        key === "auth-token" ||
        key === "token"
      ) {
        out.authToken = val;
      } else if (
        key === "gl-bigdata-role-id" ||
        key === "role-id" ||
        key === "roleid"
      ) {
        const rid = Number(val);
        if (Number.isSafeInteger(rid) && rid > 0) out.roleId = rid;
      } else if (key === "gl-bigdata-dts" || key === "dts") {
        const d = Number(val);
        if (Number.isInteger(d) && d > 0) out.dts = d;
      } else if (key === "gl-bigdata-server" || key === "server") {
        const s = Number(val);
        if (Number.isInteger(s) && s > 0) out.server = s;
      } else if (key === "gl-clienttype" || key === "clienttype") {
        out.clientType = val;
      } else if (key === "origin") {
        out.origin = val;
      } else if (key === "referer") {
        out.referer = val;
      } else if (key === "user-agent") {
        out.userAgent = val;
      } else if (
        (key === "名称" || key === "备注" || key === "name" || key === "remark") &&
        !out.name
      ) {
        out.name = val;
      }
    } else if (idx === 0 && !line.toLowerCase().startsWith("http")) {
      out.name = line.slice(0, 64);
    }
  }

  return out;
}

async function superFetchDashenAccounts(
  operatorId: number
): Promise<DashenPoolAccountDto[]> {
  const res = await relayInternalRequest<{
    ok: boolean;
    data: { accounts: DashenPoolAccountDto[] };
  }>("/internal/admin/dashen-accounts", {
    method: "GET",
    operatorId,
  });
  return Array.isArray(res?.data?.accounts) ? res.data.accounts : [];
}

async function superUpsertDashenAccountItem(
  operatorId: number,
  params: {
    id?: number;
    name: string;
    roleId: number;
    authToken: string;
    dts?: number;
    server?: number;
    clientType?: string;
    origin?: string;
    referer?: string;
    userAgent?: string;
    isEnabled?: boolean;
  }
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/dashen-accounts",
    {
      method: "POST",
      operatorId,
      body: params,
    }
  );
  return res.data;
}

async function superToggleDashenAccountItem(
  operatorId: number,
  accountId: number,
  enabled?: boolean
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/dashen-accounts/toggle",
    {
      method: "POST",
      operatorId,
      body: { accountId, enabled },
    }
  );
  return res.data;
}

async function superDeleteDashenAccountItem(
  operatorId: number,
  accountId: number
) {
  const res = await relayInternalRequest<{ ok: boolean; data: any }>(
    "/internal/admin/dashen-accounts",
    {
      method: "DELETE",
      operatorId,
      query: { accountId },
    }
  );
  return res.data;
}

function buildFallbackEnvCredential(): DashenRequestCredential | null {
  if (!DASHEN_ROLE_ID || !DASHEN_TOKEN) return null;
  return {
    name: "环境变量配置",
    roleId: DASHEN_ROLE_ID,
    authToken: DASHEN_TOKEN,
    dts: DASHEN_DTS || 2026,
    server: DASHEN_SERVER || 1,
    clientType: DASHEN_CLIENT_TYPE || "60",
    origin: DASHEN_ORIGIN,
    referer: DASHEN_REFERER,
    userAgent: DASHEN_USER_AGENT,
  };
}

async function fetchRotatedDashenCandidates(): Promise<DashenRequestCredential[]> {
  const candidates: DashenRequestCredential[] = [];
  try {
    const res = await relayInternalRequest<{
      ok: boolean;
      data: { accounts: DashenPoolAccountDto[] };
    }>("/internal/dashen/accounts/next", {
      method: "GET",
      timeoutMs: 6000,
    });
    const list = Array.isArray(res?.data?.accounts) ? res.data.accounts : [];
    for (const acc of list) {
      if (acc.isEnabled && acc.roleId && acc.authToken) {
        candidates.push({
          accountId: acc.id,
          name: acc.name || `账号#${acc.id}`,
          roleId: Number(acc.roleId),
          authToken: String(acc.authToken).trim(),
          dts: Number(acc.dts || DASHEN_DTS || 2026),
          server: Number(acc.server || DASHEN_SERVER || 1),
          clientType: String(acc.clientType || DASHEN_CLIENT_TYPE || "60"),
          origin: String(acc.origin || DASHEN_ORIGIN),
          referer: String(acc.referer || DASHEN_REFERER),
          userAgent: String(acc.userAgent || DASHEN_USER_AGENT),
        });
      }
    }
  } catch {
    // 轮询池读取异常时回退环境变量
  }

  const envCred = buildFallbackEnvCredential();
  if (envCred) {
    const exists = candidates.some(
      (c) =>
        c.roleId === envCred.roleId && c.authToken === envCred.authToken
    );
    if (!exists) candidates.push(envCred);
  }
  return candidates;
}

async function reportDashenCallOutcome(
  accountId: number | undefined,
  ok: boolean,
  errorMsg = ""
): Promise<void> {
  if (!accountId) return;
  try {
    await relayInternalRequest("/internal/dashen/accounts/report", {
      method: "POST",
      body: { id: accountId, ok, error: errorMsg },
      timeoutMs: 5000,
    });
  } catch {
    // 忽略统计上报异常
  }
}

// ============================================================================
// 7. 网易大神接口请求封装（对齐 Overstats GET customer/* + POST searchBnetAccount）
// ============================================================================

function buildDashenHeaders(
  cred: DashenRequestCredential,
  dtsOverride?: number
): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "GL-Bigdata-Auth-Token": cred.authToken,
    "GL-Bigdata-Dts": String(dtsOverride ?? cred.dts ?? 2026),
    "GL-Bigdata-Role-Id": String(cred.roleId),
    "GL-Bigdata-Server": String(cred.server || 1),
    "GL-ClientType": String(cred.clientType || "60"),
    Origin: cred.origin || DASHEN_ORIGIN,
    Referer: cred.referer || DASHEN_REFERER,
    "User-Agent": cred.userAgent || DASHEN_USER_AGENT,
  };
}

function isDashenPayloadSuccessful(json: DashenResponse | null): boolean {
  if (!json || typeof json !== "object") return false;
  if (json.code !== undefined && Number(json.code) !== 0) return false;
  if (json.success === false) return false;
  return true;
}

function hasMeaningfulDashenData(json: DashenResponse | null): boolean {
  if (!isDashenPayloadSuccessful(json)) return false;
  const d = json?.data ?? json?.result;
  if (!d) return false;
  if (Array.isArray(d)) return d.length > 0;
  if (typeof d === "object") {
    const keys = Object.keys(d).filter(
      (k) => !["traceId", "trace_id", "requestId"].includes(k)
    );
    return keys.length > 0;
  }
  return Boolean(d);
}

async function callDashenWithRotation(
  executor: (cred: DashenRequestCredential) => Promise<DashenResponse>,
  requireData = false
): Promise<DashenResponse> {
  const candidates = await fetchRotatedDashenCandidates();
  if (candidates.length === 0) {
    throw new Error(
      "未配置可用的网易大神查询账号（请在超管后台「🔑 大神账号轮询」中添加账号或配置环境变量）"
    );
  }

  let lastErr: Error | null = null;
  let lastEmptyResp: DashenResponse | null = null;

  for (const cred of candidates) {
    try {
      const resp = await executor(cred);
      if (!isDashenPayloadSuccessful(resp)) {
        const code = resp?.code ?? "ERR";
        const msg =
          resp?.errorMsg || resp?.msg || resp?.message || `错误码 ${code}`;
        const err = new Error(`网易大神返回异常（code=${code}）：${msg}`);
        if (cred.accountId) {
          void reportDashenCallOutcome(cred.accountId, false, err.message);
        }
        lastErr = err;
        continue;
      }

      if (requireData && !hasMeaningfulDashenData(resp)) {
        lastEmptyResp = resp;
        continue;
      }

      if (cred.accountId) {
        void reportDashenCallOutcome(cred.accountId, true, "");
      }
      return resp;
    } catch (e: any) {
      const err =
        e instanceof Error
          ? e
          : new Error(String(e?.message || e || "请求异常"));
      if (cred.accountId) {
        void reportDashenCallOutcome(cred.accountId, false, err.message);
      }
      lastErr = err;
    }
  }

  if (lastEmptyResp) return lastEmptyResp;
  throw (
    lastErr ||
    new Error("所有网易大神查询账号均请求失败，请稍后重试")
  );
}

async function searchBnetAccount(bnet: string): Promise<DashenResponse> {
  const cleanName = normalizeBnetQuery(bnet);
  return callDashenWithRotation(async (cred) => {
    const headers = buildDashenHeaders(cred, cred.dts || 2026);
    if (SEARCH_BNET_METHOD === "GET") {
      const url = new URL(SEARCH_BNET_ACCOUNT_URL);
      url.searchParams.set(SEARCH_BNET_PARAM_KEY, cleanName);
      url.searchParams.set("token", cred.authToken);
      url.searchParams.set("roleId", String(cred.roleId));
      url.searchParams.set("dts", String(cred.dts || 2026));
      url.searchParams.set("server", String(cred.server || 1));
      const res = await fetch(url.toString(), {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      return (await res.json()) as DashenResponse;
    }

    const res = await fetch(SEARCH_BNET_ACCOUNT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: cred.authToken,
        roleId: cred.roleId,
        dts: cred.dts || 2026,
        server: cred.server || 1,
        [SEARCH_BNET_PARAM_KEY]: cleanName,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    return (await res.json()) as DashenResponse;
  }, false);
}

async function queryCustomerCard(
  customerToken: string,
  gameMode?: CnGameMode
): Promise<DashenResponse> {
  return callDashenWithRotation(async (cred) => {
    const url = new URL(`${DASHEN_CUSTOMER_API_BASE}/queryCard`);
    url.searchParams.set("token", customerToken);
    if (gameMode) {
      url.searchParams.set("gameMode", gameMode);
    }
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: buildDashenHeaders(cred, 2026),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    return (await res.json()) as DashenResponse;
  }, false);
}

async function queryCustomerCountInfo(
  customerToken: string,
  gameMode: CnGameMode
): Promise<DashenResponse> {
  return callDashenWithRotation(async (cred) => {
    const url = new URL(`${DASHEN_CUSTOMER_API_BASE}/queryCountInfo`);
    url.searchParams.set("token", customerToken);
    url.searchParams.set("gameMode", gameMode);
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: buildDashenHeaders(cred, 2026),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    return (await res.json()) as DashenResponse;
  }, false);
}

async function queryCustomerMatchList(
  customerToken: string,
  gameMode: CnGameMode,
  page = 1,
  pageSize = 6
): Promise<DashenResponse> {
  return callDashenWithRotation(async (cred) => {
    const url = new URL(`${DASHEN_CUSTOMER_API_BASE}/queryMatchList`);
    url.searchParams.set("token", customerToken);
    url.searchParams.set("gameMode", gameMode);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(pageSize));
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: buildDashenHeaders(cred, 2026),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    return (await res.json()) as DashenResponse;
  }, false);
}

async function queryCustomerMatchInfo(
  customerToken: string,
  matchId: string
): Promise<DashenResponse> {
  return callDashenWithRotation(async (cred) => {
    const url = new URL(`${DASHEN_CUSTOMER_API_BASE}/queryMatchInfo`);
    url.searchParams.set("token", customerToken);
    url.searchParams.set("matchId", matchId);
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: buildDashenHeaders(cred, 2026),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    return (await res.json()) as DashenResponse;
  }, false);
}

function extractCustomerTokenFromSearch(
  res: DashenResponse,
  exactBnet: string
): { bnet: string; customerToken: string } | null {
  const raw = res?.data ?? res?.result;
  if (!raw) return null;

  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.list)
      ? raw.list
      : Array.isArray(raw.records)
        ? raw.records
        : typeof raw === "object"
          ? [raw]
          : [];

  if (list.length === 0) return null;

  const exactMatched = list.find((item: any) => {
    const candidateName = String(
      item?.name ||
        item?.bnetName ||
        item?.bnet_name ||
        item?.battleTag ||
        item?.battle_tag ||
        item?.nickName ||
        ""
    ).trim();
    return candidateName === exactBnet;
  });

  const target = exactMatched || list[0];
  const token = String(
    target?.customerToken ||
      target?.customer_token ||
      target?.token ||
      ""
  ).trim();

  if (!token) return null;

  const resolvedName = String(
    target?.name ||
      target?.bnetName ||
      target?.bnet_name ||
      target?.battleTag ||
      exactBnet
  ).trim();

  return {
    bnet: resolvedName || exactBnet,
    customerToken: token,
  };
}

async function resolvePlayerWithTokenCache(
  rawBnet: string
): Promise<{ bnet: string; customerToken: string }> {
  const exactBnet = normalizeBnetQuery(rawBnet);
  if (!isValidBnetTag(exactBnet)) {
    throw new Error(
      "战网 ID 格式不正确，请输入完整战网 ID（例如：<code>玩家名#12345</code>）"
    );
  }

  const cached = await lookupCachedBnetPlayer(exactBnet);
  if (cached?.customerToken) {
    return {
      bnet: cached.bnetName || exactBnet,
      customerToken: cached.customerToken,
    };
  }

  const searchRes = await searchBnetAccount(exactBnet);
  const extracted = extractCustomerTokenFromSearch(searchRes, exactBnet);
  if (extracted?.customerToken) {
    void persistCachedBnetPlayer({
      bnetKey: exactBnet,
      bnetName: extracted.bnet || exactBnet,
      customerToken: extracted.customerToken,
    });
    return {
      bnet: extracted.bnet || exactBnet,
      customerToken: extracted.customerToken,
    };
  }

  const traceId = String(searchRes?.traceId || "").trim();
  throw new Error(
    `未在缓存中找到 <code>${escapeHtml(exactBnet)}</code>，且网易大神搜索接口当前未返回该玩家令牌` +
      `${traceId ? `（traceId: <code>${escapeHtml(traceId)}</code>）` : ""}。` +
      `若该玩家已录入缓存，请核对战网 ID 大小写是否完全一致。`
  );
}

// ============================================================================
// 8. 战绩视图构建与键盘渲染
// ============================================================================

function buildCnOverviewKeyboard(
  bnet: string,
  mode: CnGameMode,
  isAdmin = false
): InlineKeyboard {
  const switchMode: CnGameMode = mode === "sport" ? "leisure" : "sport";
  const switchLabel =
    mode === "sport" ? "🔄 切换至快速/休闲" : "🔄 切换至竞技比赛";

  const kb = new InlineKeyboard()
    .text(switchLabel, `cn:sw:${switchMode}:${bnet}`)
    .text("📋 近期战绩流水", `cn:ml:${mode}:1:${bnet}`)
    .row()
    .text("🤖 AI 锐评战绩", `cn:rs:${mode}:${bnet}`)
    .text("🔮 AI 隐性段位评估", `cn:rm:${mode}:${bnet}`);

  if (isAdmin) {
    kb.row().text("🛠 管理控制台", "adm:home");
  }
  return kb;
}

function buildCnMatchDetailKeyboard(
  bnet: string,
  matchId: string
): InlineKeyboard {
  return new InlineKeyboard()
    .text("🤖 AI 锐评本局", `cn:ar:${matchId}:${bnet}`)
    .text("⬅️ 返回战绩总览", `cn:back:${bnet}`);
}

async function buildCnOverviewView(
  bnet: string,
  mode: CnGameMode,
  isAdmin = false
): Promise<{
  text: string;
  keyboard: InlineKeyboard;
  snapshotText: string;
  currentRankLabel: string;
  customerToken: string;
}> {
  const player = await resolvePlayerWithTokenCache(bnet);

  const [cardRes, countRes] = await Promise.all([
    queryCustomerCard(player.customerToken, mode).catch(() => null),
    queryCustomerCountInfo(player.customerToken, mode).catch(() => null),
  ]);

  const cardData = cardRes?.data ?? cardRes?.result ?? {};
  const countData = countRes?.data ?? countRes?.result ?? {};
  const { section: guide, roleKey } = resolveGuideCountSection(
    countData,
    mode
  );

  const displayBnet = String(
    cardData.name || countData.name || player.bnet || bnet
  ).trim();
  const modeLabel = mode === "sport" ? "竞技比赛" : "快速/休闲";
  const roleLabel = translateRoleType(roleKey || guide.roleType);

  const rankLines: string[] = [];
  const lastRankSeg = formatRankSegment(guide.lastRankInfo);
  const maxRankSeg = formatRankSegment(guide.maxRankInfo);
  if (lastRankSeg) {
    rankLines.push(`• 当前/近期段位：<b>${escapeHtml(lastRankSeg)}</b>`);
  }
  if (maxRankSeg) {
    rankLines.push(`• 历史最高段位：<b>${escapeHtml(maxRankSeg)}</b>`);
  }

  const roleRankList =
    cardData.roleRankList ||
    cardData.role_rank_list ||
    cardData.ranks ||
    cardData.rankList ||
    guide.roleRankList ||
    [];
  if (Array.isArray(roleRankList) && roleRankList.length > 0) {
    for (const item of roleRankList) {
      const rCn =
        translateRoleType(
          item.role || item.roleName || item.role_name || item.duty
        ) || "综合";
      const seg = formatRankSegment(item);
      if (seg) {
        rankLines.push(`• ${rCn}：<b>${escapeHtml(seg)}</b>`);
      }
    }
  }

  const currentRankLabel =
    rankLines.length > 0
      ? rankLines.map((l) => l.replace(/<[^>]+>/g, "")).join(" | ")
      : "暂无公开段位";

  const totalGames = Number(
    guide.matchSum ??
      guide.matchCount ??
      guide.games ??
      guide.totalGames ??
      cardData.matchSum ??
      0
  );
  const winRateRaw =
    guide.winRate ??
    guide.win_rate ??
    cardData.winRate ??
    cardData.win_rate ??
    0;
  const kdaVal = guide.kda ?? "";
  const aveKill = guide.aveKill ?? guide.ave_kill ?? "";
  const aveAssist = guide.aveAssist ?? guide.ave_assist ?? "";
  const aveDeath = guide.aveDeath ?? guide.ave_death ?? "";
  const aveHeroDamage = guide.aveHeroDamage ?? guide.ave_hero_damage ?? "";
  const gameTimeRaw = guide.gameTime ?? cardData.gameTime ?? "";

  const heroListRaw =
    (Array.isArray(guide.presetsSummaryList) &&
    guide.presetsSummaryList.length > 0
      ? guide.presetsSummaryList
      : null) ||
    (Array.isArray(guide.openQueueSummaryList) &&
    guide.openQueueSummaryList.length > 0
      ? guide.openQueueSummaryList
      : null) ||
    countData.heroList ||
    countData.hero_list ||
    countData.heroes ||
    countData.heroStats ||
    cardData.heroList ||
    [];

  const heroLines: string[] = [];
  if (Array.isArray(heroListRaw) && heroListRaw.length > 0) {
    const sortedHeroes = [...heroListRaw]
      .sort((a, b) => {
        const ta = Number(
          a.matchSum ??
            a.playTime ??
            a.timePlayed ??
            a.gameTime ??
            a.duration ??
            0
        );
        const tb = Number(
          b.matchSum ??
            b.playTime ??
            b.timePlayed ??
            b.gameTime ??
            b.duration ??
            0
        );
        return tb - ta;
      })
      .slice(0, 5);

    for (const h of sortedHeroes) {
      const hName = resolveDashenHeroName(
        h.heroName ||
          h.hero_name ||
          h.name ||
          h.heroGuid ||
          h.hero_guid ||
          h.heroId
      );
      if (!hName) continue;
      const hMatches = Number(h.matchSum ?? h.matchCount ?? h.games ?? 0);
      const hWins = Number(h.winSum ?? h.winCount ?? 0);
      const hWinRate = formatWinRate(
        h.winRate ??
          h.win_rate ??
          (hMatches > 0 ? (hWins / hMatches) * 100 : 0)
      );
      const hLevel = Number(h.heroLevel ?? 0);
      heroLines.push(
        `• <b>${escapeHtml(hName)}</b>` +
          `${hLevel > 0 ? ` (Lv.${hLevel})` : ""}` +
          `${hMatches > 0 ? ` · ${hMatches}场` : ""}` +
          ` · 胜率 <b>${escapeHtml(hWinRate)}</b>`
      );
    }
  }

  const lines: string[] = [
    `🇨🇳 <b>国服战绩总览 — ${escapeHtml(displayBnet)}</b>`,
    `🎮 模式：<b>${escapeHtml(modeLabel)}</b>` +
      `${roleLabel ? `（${escapeHtml(roleLabel)}）` : ""}` +
      `${gameTimeRaw !== "" && gameTimeRaw !== null ? `  |  ⏱ 时长：<b>${escapeHtml(String(gameTimeRaw))}</b>` : ""}`,
    `━━━━━━━━━━━━━━━━━━`,
  ];

  if (rankLines.length > 0) {
    lines.push(`🏅 <b>段位信息</b>`, ...rankLines, `━━━━━━━━━━━━━━━━━━`);
  }

  lines.push(
    `📊 <b>对局统计</b>`,
    `• 累计场次：<b>${totalGames}</b> 场  |  胜率：<b>${escapeHtml(formatWinRate(winRateRaw))}</b>`
  );

  if (kdaVal !== "" || aveKill !== "" || aveDeath !== "") {
    lines.push(
      `• KDA：<b>${escapeHtml(String(kdaVal || "-"))}</b>` +
        `  |  场均 K/A/D：<b>${escapeHtml(String(aveKill || 0))}/${escapeHtml(String(aveAssist || 0))}/${escapeHtml(String(aveDeath || 0))}</b>`
    );
  }

  if (aveHeroDamage !== "") {
    lines.push(
      `• 场均英雄伤害：<b>${escapeHtml(formatNumber(aveHeroDamage))}</b>`
    );
  }

  if (heroLines.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━`, `🦸 <b>常用英雄 TOP5</b>`, ...heroLines);
  } else if (totalGames === 0 && rankLines.length === 0) {
    lines.push(`<i>当前模式暂无更多赛季/英雄统计明细。</i>`);
  }

  const text = lines.join("\n");
  const snapshotText = [
    `战网ID: ${displayBnet}`,
    `模式: ${modeLabel}${roleLabel ? ` (${roleLabel})` : ""}`,
    `段位: ${currentRankLabel}`,
    `总场次: ${totalGames}场, 胜率: ${formatWinRate(winRateRaw)}, KDA: ${kdaVal || "-"}`,
    aveKill !== "" || aveDeath !== ""
      ? `场均K/A/D: ${aveKill || 0}/${aveAssist || 0}/${aveDeath || 0}, 场均伤害: ${aveHeroDamage || 0}`
      : "",
    heroLines.length > 0
      ? `常用英雄:\n${heroLines.map((l) => l.replace(/<[^>]+>/g, "")).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    text,
    keyboard: buildCnOverviewKeyboard(displayBnet, mode, isAdmin),
    snapshotText,
    currentRankLabel,
    customerToken: player.customerToken,
  };
}

async function buildCnMatchListView(
  bnet: string,
  mode: CnGameMode,
  page = 1
): Promise<{
  text: string;
  keyboard: InlineKeyboard;
  matchIds: string[];
  matchSummaries: Record<string, any>;
  customerToken: string;
}> {
  const player = await resolvePlayerWithTokenCache(bnet);

  const pageSize = 6;
  const listRes = await queryCustomerMatchList(
    player.customerToken,
    mode,
    page,
    pageSize
  );
  const body = listRes?.data ?? listRes?.result ?? listRes ?? {};
  const rawList = extractMatchItemsFromBody(body);

  const modeLabel = mode === "sport" ? "竞技比赛" : "快速/休闲";
  const lines: string[] = [
    `📋 <b>近期战绩流水 — ${escapeHtml(player.bnet)}</b>`,
    `🎮 模式：<b>${escapeHtml(modeLabel)}</b>  |  第 <b>${page}</b> 页`,
    `━━━━━━━━━━━━━━━━━━`,
  ];

  const matchIds: string[] = [];
  const matchSummaries: Record<string, any> = {};
  const kb = new InlineKeyboard();

  if (!Array.isArray(rawList) || rawList.length === 0) {
    lines.push(
      `📭 当前模式（${escapeHtml(modeLabel)}）暂无对局记录。`,
      `<i>可尝试点击下方按钮切换另一模式查看。</i>`
    );
  } else {
    rawList.forEach((m: any, idx: number) => {
      const mId = String(
        m.matchId || m.match_id || m.gameId || m.id || ""
      ).trim();
      if (mId) {
        matchIds.push(mId);
        matchSummaries[mId] = m;
      }

      const retVal = Number(m.matchRet ?? m.result ?? m.win ?? -1);
      const retIcon =
        retVal === 1
          ? "🟢胜"
          : retVal === 0
            ? "🔴负"
            : retVal === 2
              ? "⚪平"
              : "🎮局";
      const mapName =
        m.mapName ||
        m.map_name ||
        resolveDashenMapGuid(m.mapGuid || m.map_guid || m.mapId);
      const heroName = resolveDashenHeroName(
        m.heroName || m.hero_name || m.heroGuid || m.hero_guid || m.heroId
      );
      const roleCn = translateRoleType(m.roleType || m.role_type);
      const k = Number(m.kill ?? m.kills ?? m.eliminations ?? 0);
      const a = Number(m.assist ?? m.assists ?? 0);
      const d = Number(m.death ?? m.deaths ?? 0);
      const scoreText =
        m.teamScore !== undefined && m.opponentScore !== undefined
          ? `比分 <b>${m.teamScore}:${m.opponentScore}</b> · `
          : "";
      const timeStr = formatMatchTimestamp(
        m.beginTs ||
          m.begin_ts ||
          m.ts ||
          m.startTime ||
          m.timestamp ||
          m.time
      );

      lines.push(
        `${idx + 1}. ${retIcon} <b>${escapeHtml(mapName || "未知地图")}</b>` +
          `${heroName ? ` · <i>${escapeHtml(heroName)}</i>` : ""}` +
          `${roleCn ? ` [${escapeHtml(roleCn)}]` : ""}`
      );
      lines.push(
        `   ${scoreText}K/A/D：<b>${k}/${a}/${d}</b>  |  🕒 ${escapeHtml(timeStr)}`
      );

      if (mId) {
        kb.text(`🔍 第${idx + 1}局详情`, `cn:md:${idx}:${player.bnet}`);
        if (idx % 2 === 1) kb.row();
      }
    });
  }

  if (rawList.length % 2 === 1) kb.row();

  const otherMode: CnGameMode = mode === "sport" ? "leisure" : "sport";
  if (page > 1) {
    kb.text("⬅️ 上一页", `cn:ml:${mode}:${page - 1}:${player.bnet}`);
  }
  if (Array.isArray(rawList) && rawList.length >= pageSize) {
    kb.text("➡️ 下一页", `cn:ml:${mode}:${page + 1}:${player.bnet}`);
  }
  kb.row()
    .text(
      mode === "sport" ? "🔄 切至快速流水" : "🔄 切至竞技流水",
      `cn:ml:${otherMode}:1:${player.bnet}`
    )
    .text("🔙 战绩总览", `cn:sw:${mode}:${player.bnet}`);

  return {
    text: lines.join("\n"),
    keyboard: kb,
    matchIds,
    matchSummaries,
    customerToken: player.customerToken,
  };
}

function extractFirstNonEmptyObj(...candidates: any[]): any {
  for (const c of candidates) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      return c;
    }
  }
  return {};
}

async function buildCnMatchDetailView(
  bnet: string,
  customerToken: string,
  matchId: string,
  fallbackMatchSummary: any = null
): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const infoRes = await queryCustomerMatchInfo(customerToken, matchId).catch(
    () => null
  );
  const rawInfo = infoRes?.data ?? infoRes?.result ?? infoRes ?? {};
  const info = extractFirstNonEmptyObj(
    Array.isArray(rawInfo) ? rawInfo[0] : rawInfo,
    rawInfo?.matchInfo,
    rawInfo?.detail,
    fallbackMatchSummary
  );
  const base =
    fallbackMatchSummary && typeof fallbackMatchSummary === "object"
      ? fallbackMatchSummary
      : {};

  const mapName =
    info.mapName ||
    info.map_name ||
    base.mapName ||
    base.map_name ||
    resolveDashenMapGuid(
      info.mapGuid ||
        info.map_guid ||
        info.mapId ||
        base.mapGuid ||
        base.map_guid
    );
  const modeDesc = translateModeCode(
    info.gameMode || info.game_mode || info.mode || base.gameMode || ""
  );
  const timeStr = formatMatchTimestamp(
    info.beginTs ||
      info.begin_ts ||
      info.ts ||
      info.startTime ||
      info.timestamp ||
      base.beginTs ||
      base.ts
  );

  const playerStats = extractFirstNonEmptyObj(
    info.playerStat,
    info.selfStat,
    info.self,
    info.stats,
    info,
    base
  );

  const k = Number(
    playerStats.kill ??
      playerStats.kills ??
      playerStats.eliminations ??
      base.kill ??
      0
  );
  const a = Number(
    playerStats.assist ?? playerStats.assists ?? base.assist ?? 0
  );
  const d = Number(
    playerStats.death ?? playerStats.deaths ?? base.death ?? 0
  );
  const dmg = Number(
    playerStats.heroDamage ??
      playerStats.damage ??
      playerStats.hero_damage ??
      base.heroDamage ??
      0
  );
  const heal = Number(
    playerStats.cure ?? playerStats.healing ?? playerStats.heal ?? base.cure ?? 0
  );
  const resist = Number(
    playerStats.resistDamage ??
      playerStats.damageBlocked ??
      playerStats.resist_damage ??
      base.resistDamage ??
      0
  );

  const scoreLine =
    (info.teamScore !== undefined && info.opponentScore !== undefined) ||
    (base.teamScore !== undefined && base.opponentScore !== undefined)
      ? `• 比分：<b>${info.teamScore ?? base.teamScore}:${info.opponentScore ?? base.opponentScore}</b>\n`
      : "";

  const lines: string[] = [
    `🎯 <b>单局对局详情 — ${escapeHtml(bnet)}</b>`,
    `🗺 地图：<b>${escapeHtml(mapName || "未知地图")}</b>${modeDesc ? `（${escapeHtml(modeDesc)}）` : ""}`,
    `🕒 时间：${escapeHtml(timeStr)}`,
    `━━━━━━━━━━━━━━━━━━`,
    scoreLine.trimEnd(),
    `• 击败 / 助攻 / 阵亡：<b>${k}</b> / <b>${a}</b> / <b>${d}</b>`,
    `• 英雄伤害：<b>${formatNumber(dmg)}</b>`,
    `• 治疗量：<b>${formatNumber(heal)}</b>`,
    `• 承受伤害：<b>${formatNumber(resist)}</b>`,
  ].filter(Boolean);

  const heroPerfList =
    info.heroList ||
    info.heroStats ||
    info.hero_list ||
    playerStats.heroList ||
    [];
  const heroItems: string[] = [];
  if (Array.isArray(heroPerfList) && heroPerfList.length > 0) {
    for (const h of heroPerfList.slice(0, 5)) {
      const hName = resolveDashenHeroName(
        h.heroName || h.hero_name || h.heroGuid || h.hero_guid || h.name
      );
      if (!hName) continue;
      const secs = Number(h.playTime ?? h.duration ?? h.timePlayed ?? 0);
      heroItems.push(
        `• <b>${escapeHtml(hName)}</b>${secs > 0 ? `（${formatDuration(secs)}）` : ""}`
      );
    }
  }
  if (heroItems.length === 0) {
    const fallbackHero = resolveDashenHeroName(
      info.heroName ||
        info.hero_name ||
        info.heroGuid ||
        info.hero_guid ||
        base.heroName ||
        base.heroGuid
    );
    if (fallbackHero) {
      const roleCn = translateRoleType(info.roleType || base.roleType);
      heroItems.push(
        `• <b>${escapeHtml(fallbackHero)}</b>${roleCn ? ` [${escapeHtml(roleCn)}]` : ""}`
      );
    }
  }

  if (heroItems.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━`, `🦸 <b>本局使用英雄</b>`, ...heroItems);
  }

  return {
    text: lines.join("\n"),
    keyboard: buildCnMatchDetailKeyboard(bnet, matchId),
  };
}

// ============================================================================
// 9. 多 AI 锐评生成（支持 Vercel 默认执行与 Docker 120s 异步队列回推）
// ============================================================================

function formatReviewToTelegramHtml(rawText: string): string {
  let s = String(rawText || "").trim();
  if (!s) return "暂无锐评内容生成。";
  s = s.replace(/^```(?:html|markdown|text)?\s*/i, "").replace(/```\s*$/i, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  s = s.replace(/<(p|div|ul|ol|table|thead|tbody|tr|h[1-6])[^>]*>/gi, "");
  s = s.replace(
    /<(?!\/?(?:b|i|u|s|code|pre|blockquote)\b)[^>]+>/gi,
    ""
  );
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s || "暂无锐评内容生成。";
}

function buildRoastSystemPrompt(roastType: RoastType): string {
  const base = [
    "你是《守望先锋 2》(OW2) 国服资深竞技分析师与毒舌锐评解说，说话犀利、幽默、一针见血，善用守望先锋黑话与梗。",
    "输出必须使用 Telegram 兼容的精简 HTML 标签（仅允许 <b>、<i>、<code>），严禁输出 Markdown 星号 ** 或复杂 HTML 标签。",
    "控制篇幅在 450~850 字之间，结构清晰、重点突出、不废话。",
  ];
  if (roastType === "match") {
    base.push(
      "本次任务是【单局对局锐评】：结合该局地图、击杀/助攻/阵亡、伤害/治疗/承伤等数据，点评本局发挥亮点与掉点/失误槽点，并给出 1 条改进建议。"
    );
  } else if (roastType === "mmr") {
    base.push(
      "本次任务是【AI 隐性段位评估】：结合玩家当前模式、段位、胜率、KDA、场均 K/A/D、伤害与常用英雄池，评估其真实隐性段位水平、打法风格与上分瓶颈。"
    );
  } else {
    base.push(
      "本次任务是【综合战绩锐评】：结合玩家总场次、胜率、KDA、场均数据与英雄池构成，给出一段既好笑又扎心的综合锐评与实战建议。"
    );
  }
  return base.join("\n");
}

function resolveAvailableChannels(activeCfg: {
  defaultDeepseekEnabled: boolean;
  providers: AiProviderDto[];
}): Array<{
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  executionTarget: "vercel" | "docker";
}> {
  const list: Array<{
    id: number;
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    executionTarget: "vercel" | "docker";
  }> = [];

  for (const p of activeCfg.providers || []) {
    if (p.isEnabled && p.baseUrl && p.apiKey && p.model) {
      list.push({
        id: Number(p.id),
        name: p.name || `渠道#${p.id}`,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model,
        executionTarget: p.executionTarget === "docker" ? "docker" : "vercel",
      });
    }
  }

  if (activeCfg.defaultDeepseekEnabled && AI_API_KEY && AI_BASE_URL) {
    list.push({
      id: 0,
      name: "DeepSeek",
      baseUrl: AI_BASE_URL,
      apiKey: AI_API_KEY,
      model: AI_MODEL || "deepseek-chat",
      executionTarget: "vercel",
    });
  }

  return list;
}

async function runVercelDirectCompletion(
  channel: {
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  },
  systemPrompt: string,
  userPrompt: string
): Promise<{ content: string; modelName: string }> {
  const endpoint = channel.baseUrl.endsWith("/chat/completions")
    ? channel.baseUrl
    : `${channel.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${channel.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: channel.model,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });

  const rawText = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `${channel.name} 接口错误 (HTTP ${res.status}): ${rawText.slice(0, 180)}`
    );
  }

  let parsed: any = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    return { content: rawText, modelName: channel.model };
  }

  const choice = parsed?.choices?.[0] ?? parsed?.data?.choices?.[0] ?? null;
  const msg = choice?.message ?? choice?.delta ?? null;
  const text =
    msg?.content ||
    parsed?.output_text ||
    parsed?.data?.output_text ||
    choice?.text ||
    msg?.reasoning_content ||
    "";

  if (!String(text || "").trim()) {
    throw new Error(`${channel.name} 返回空内容`);
  }

  return {
    content: String(text),
    modelName: String(parsed?.model || channel.model),
  };
}

async function runDockerQueueCompletion(
  channel: {
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  },
  systemPrompt: string,
  userPrompt: string,
  onQueuedNotice?: (queueInfo: {
    aheadCount: number;
    queuePosition: number;
  }) => Promise<void>
): Promise<{ content: string; modelName: string }> {
  const enqRes = await relayInternalRequest<{
    ok: boolean;
    data: {
      jobId: string;
      status: string;
      aheadCount: number;
      queuePosition: number;
    };
  }>("/internal/ai/queue/enqueue", {
    method: "POST",
    body: {
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      model: channel.model,
      systemPrompt,
      userPrompt,
      timeoutMs: DOCKER_AI_TIMEOUT_MS,
    },
    timeoutMs: 12_000,
  });

  const jobId = enqRes?.data?.jobId;
  if (!jobId) {
    throw new Error(`${channel.name} 队列入队失败`);
  }

  if (
    onQueuedNotice &&
    (enqRes.data.aheadCount > 0 || enqRes.data.status === "queued")
  ) {
    await onQueuedNotice({
      aheadCount: Number(enqRes.data.aheadCount || 0),
      queuePosition: Number(enqRes.data.queuePosition || 1),
    }).catch(() => {});
  }

  const deadline = Date.now() + DOCKER_AI_TIMEOUT_MS + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const stRes = await relayInternalRequest<{
      ok: boolean;
      data: {
        jobId: string;
        status: string;
        error?: string | null;
        result?: { content?: string } | null;
      };
    }>("/internal/ai/queue/status", {
      method: "GET",
      query: { jobId },
      timeoutMs: 8000,
    });

    const st = stRes?.data;
    if (!st) continue;

    if (st.status === "succeeded") {
      const content = String(st.result?.content || "").trim();
      if (!content) {
        throw new Error(`${channel.name} 任务完成但返回空内容`);
      }
      return { content, modelName: channel.model };
    }

    if (st.status === "failed") {
      throw new Error(st.error || `${channel.name} 推理任务失败`);
    }
  }

  throw new Error(`${channel.name} 队列等待超时（120s）`);
}

function buildRoastCacheKey(params: {
  roastType: RoastType;
  mode: CnGameMode;
  bnet: string;
  matchId?: string;
}): string {
  const b = normalizeBnetQuery(params.bnet);
  if (params.roastType === "match") {
    return `match:${b}:${String(params.matchId || "").trim()}`;
  }
  return `${params.roastType}:${params.mode}:${b}`;
}

function decorateRoastHtml(params: {
  roastType: RoastType;
  bnet: string;
  mode: CnGameMode;
  reviewHtml: string;
  providerName: string;
  modelName: string;
  fromCache: boolean;
  operatorNickname?: string;
}): string {
  const titleMap: Record<RoastType, string> = {
    match: "🎯 <b>AI 单局犀利锐评</b>",
    self: "🤖 <b>AI 综合战绩锐评</b>",
    mmr: "🔮 <b>AI 隐性段位评估</b>",
  };
  const modeLabel = params.mode === "sport" ? "竞技比赛" : "快速/休闲";
  const modelTag = params.modelName
    ? `${escapeHtml(params.providerName)} / <code>${escapeHtml(params.modelName)}</code>`
    : escapeHtml(params.providerName);

  const footerParts = [`模型：${modelTag}`];
  if (params.fromCache) {
    footerParts.push("24h 缓存命中");
  }
  if (params.operatorNickname) {
    footerParts.push(`点评人：${escapeHtml(params.operatorNickname)}`);
  }

  return [
    `${titleMap[params.roastType]} — <b>${escapeHtml(params.bnet)}</b>`,
    `🎮 模式：<b>${escapeHtml(modeLabel)}</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    params.reviewHtml,
    `━━━━━━━━━━━━━━━━━━`,
    `<i>${footerParts.join("  |  ")}</i>`,
  ].join("\n");
}

async function executeRoastFlow(
  ctx: Context,
  params: {
    roastType: RoastType;
    bnet: string;
    mode: CnGameMode;
    matchId?: string;
    promptContext: string;
    detailLabel: string;
  }
): Promise<void> {
  const tgId = ctx.from?.id;
  if (!tgId) return;

  const operatorNickname = getDisplayNameFromCtx(ctx);
  const exactBnet = normalizeBnetQuery(params.bnet);
  const cacheKey = buildRoastCacheKey({
    roastType: params.roastType,
    mode: params.mode,
    bnet: exactBnet,
    matchId: params.matchId,
  });

  const lockKey = `${tgId}:${cacheKey}`;
  if (inFlightRoastTasks.has(lockKey)) {
    await ctx.reply("⏳ 同一份锐评正在生成中，请稍候片刻...");
    return;
  }

  inFlightRoastTasks.add(lockKey);
  try {
    const cached = await fetchCachedRoast(cacheKey, params.roastType);
    if (cached?.reviewHtml) {
      const html = decorateRoastHtml({
        roastType: params.roastType,
        bnet: exactBnet,
        mode: params.mode,
        reviewHtml: cached.reviewHtml,
        providerName: cached.providerName || "DeepSeek",
        modelName: cached.modelName || "",
        fromCache: true,
        operatorNickname: cached.operatorNickname || operatorNickname,
      });
      await ctx.reply(html, { parse_mode: "HTML" });
      return;
    }

    const auth = await authorizeRoastForUser(ctx);
    if (!auth.allowed) {
      return;
    }

    const activeCfg = await fetchActiveAiProviders();
    const channels = resolveAvailableChannels(activeCfg);
    if (channels.length === 0) {
      await ctx.reply(
        "⚠️ 当前暂无已启用的 AI 锐评渠道，请联系超级管理员在后台开启或添加渠道。"
      );
      return;
    }

    const statusMsg = await ctx.reply(
      "🤖 正在调取战绩数据并生成 AI 锐评，请稍候..."
    );

    const systemPrompt = buildRoastSystemPrompt(params.roastType);
    const userPrompt = `请根据以下国服数据完成锐评：\n\n${params.promptContext}`;

    let generatedText = "";
    let usedChannelName = "";
    let usedModelName = "";
    let lastError: Error | null = null;

    for (const ch of channels) {
      try {
        let out: { content: string; modelName: string };
        if (ch.executionTarget === "docker") {
          out = await runDockerQueueCompletion(
            ch,
            systemPrompt,
            userPrompt,
            async ({ aheadCount, queuePosition }) => {
              try {
                await ctx.api.editMessageText(
                  statusMsg.chat.id,
                  statusMsg.message_id,
                  `⏳ 当前 AI 推理队列排队中（前方还有 <b>${aheadCount}</b> 个任务，当前第 <b>${queuePosition}</b> 位），最长等待 120 秒...`,
                  { parse_mode: "HTML" }
                );
              } catch {
                // 忽略编辑提示失败
              }
            }
          );
        } else {
          out = await runVercelDirectCompletion(ch, systemPrompt, userPrompt);
        }

        generatedText = out.content;
        usedChannelName = ch.name;
        usedModelName = out.modelName || ch.model;
        break;
      } catch (e: any) {
        lastError =
          e instanceof Error ? e : new Error(String(e?.message || e));
      }
    }

    if (!generatedText.trim()) {
      try {
        await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
      } catch {}
      await ctx.reply(
        `❌ AI 锐评生成失败：${escapeHtml(lastError?.message || "所有渠道均不可用")}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const formattedHtml = formatReviewToTelegramHtml(generatedText);

    const consumeRes = await consumeRoastQuotaForUser(
      tgId,
      params.roastType,
      `${params.detailLabel} (${exactBnet})`
    );

    await saveRoastCacheRecord({
      cacheKey,
      roastType: params.roastType,
      providerId: 0,
      providerName: usedChannelName || "DeepSeek",
      modelName: usedModelName || AI_MODEL,
      gameMode: params.mode,
      bnet: exactBnet,
      operatorNickname,
      matchId: params.matchId || "",
      reviewHtml: formattedHtml,
    }).catch(() => {});

    const finalHtml = decorateRoastHtml({
      roastType: params.roastType,
      bnet: exactBnet,
      mode: params.mode,
      reviewHtml: formattedHtml,
      providerName: usedChannelName || "DeepSeek",
      modelName: usedModelName || AI_MODEL,
      fromCache: false,
      operatorNickname,
    });

    const quotaNote = consumeRes.unlimited
      ? "\n💎 <i>当前享有免扣次特权（管理员/VIP）</i>"
      : `\n🎫 <i>本次消耗 1 次锐评次数，剩余 <b>${consumeRes.quota}</b> 次</i>`;

    try {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        finalHtml + quotaNote,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.reply(finalHtml + quotaNote, { parse_mode: "HTML" });
    }
  } finally {
    inFlightRoastTasks.delete(lockKey);
  }
}

// ============================================================================
// 10. 个人中心 / 签到 / 邀请 / 兑换 / 战绩查询指令处理
// ============================================================================

function buildMainReplyKeyboard(isAdmin = false): Keyboard {
  const kb = new Keyboard()
    .text("🇨🇳 查国服战绩")
    .text("📋 查战绩流水")
    .row()
    .text("👤 个人中心")
    .text("📅 每日签到")
    .row()
    .text("🎁 兑换卡密")
    .text("🔗 邀请好友");
  if (isAdmin) {
    kb.row().text("🛠 管理控制台");
  }
  return kb.resized();
}

async function showUserProfileCard(ctx: Context): Promise<void> {
  const profile = await getUserProfile(ctx);
  const botUsername =
    runtimeBotUsername ||
    ENV_BOT_USERNAME ||
    ctx.me?.username ||
    "your_bot";
  const inviteLink = `https://t.me/${botUsername}?start=inv_${profile.tgId}`;

  const vipStatusText = profile.vipActive
    ? `✅ 已生效（到期：<b>${escapeHtml(profile.vipExpireAt || "")}</b> · 锐评不限量）`
    : profile.vipExpireAt
      ? `⌛ 已过期（曾于 ${escapeHtml(profile.vipExpireAt)} 到期）`
      : "未开通";

  const quotaText = profile.roastUnlimited
    ? `♾ <b>不限量</b>（账户余额：${profile.quota} 次）`
    : `<b>${profile.quota}</b> 次`;

  const lines = [
    `👤 <b>个人中心</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `• 昵称：<b>${escapeHtml(profile.nickname || "未设置")}</b>`,
    `• TG ID：<code>${profile.tgId}</code>`,
    `• 锐评次数：${quotaText}`,
    `• VIP 状态：${vipStatusText}`,
    `• 累计邀请：<b>${profile.inviteCount}</b> 人`,
    `• 今日签到：${profile.lastCheckinDate ? `✅ 已签到（${escapeHtml(profile.lastCheckinDate)}）` : "❌ 未签到"}`,
    `━━━━━━━━━━━━━━━━━━`,
    `🔗 专属邀请链接：\n<code>${escapeHtml(inviteLink)}</code>`,
  ];

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function handleCheckinCommand(ctx: Context): Promise<void> {
  const res = await doUserCheckin(ctx);
  if (res.alreadyCheckedIn) {
    await ctx.reply(
      `📅 你今天（<b>${escapeHtml(res.today)}</b>）已经签到过啦！\n当前剩余锐评次数：<b>${res.quota}</b> 次。`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (!res.rewardEnabled || res.rewardQuota <= 0) {
    await ctx.reply(
      `📅 签到成功（<b>${escapeHtml(res.today)}</b>）！\n当前每日签到赠送已关闭，剩余锐评次数：<b>${res.quota}</b> 次。`,
      { parse_mode: "HTML" }
    );
    return;
  }

  await ctx.reply(
    `🎉 <b>签到成功（${escapeHtml(res.today)}）！</b>\n获赠 <b>+${res.rewardQuota}</b> 次 AI 锐评次数，当前剩余：<b>${res.quota}</b> 次。`,
    { parse_mode: "HTML" }
  );
}

async function handleRedeemCodeInput(
  ctx: Context,
  rawCode: string
): Promise<void> {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) {
    await ctx.reply(
      "🎁 请输入要兑换的卡密编号，例如：\n<code>/redeem OW2C-5-ABCD1234</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  await tryDeleteMessage(ctx);
  const res = await doUserRedeem(ctx, code);
  if (res.rewardType === "vip_days") {
    await ctx.reply(
      `🎉 <b>VIP 卡密兑换成功！</b>\n• 卡密：<code>${escapeHtml(res.code)}</code>\n• 获赠时长：<b>+${res.rewardValue}</b> 天\n• 最新到期时间：<b>${escapeHtml(res.vipExpireAt || "")}</b>`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      `🎉 <b>次数卡密兑换成功！</b>\n• 卡密：<code>${escapeHtml(res.code)}</code>\n• 获赠次数：<b>+${res.rewardValue}</b> 次\n• 当前剩余锐评次数：<b>${res.quota}</b> 次`,
      { parse_mode: "HTML" }
    );
  }
}

async function executeCnOverviewQuery(
  ctx: Context,
  rawQuery: string,
  forceMode?: CnGameMode
): Promise<void> {
  const tgId = ctx.from?.id || 0;
  const cleanQ = normalizeBnetQuery(rawQuery);
  if (!cleanQ) {
    await ctx.reply(
      "请提供战网 ID，例如：\n<code>/cn 玩家名#12345</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  await ctx.replyWithChatAction("typing");
  const adminMe = tgId > 0 ? await fetchAdminMe(tgId) : null;
  const isAdmin = Boolean(adminMe?.isActive);
  const mode: CnGameMode =
    forceMode || (tgId > 0 ? userLastMode.get(tgId) : null) || "sport";

  const view = await buildCnOverviewView(cleanQ, mode, isAdmin);
  if (tgId > 0) {
    userLastMode.set(tgId, mode);
    userLastBnet.set(tgId, cleanQ);
  }

  await ctx.reply(view.text, {
    parse_mode: "HTML",
    reply_markup: view.keyboard,
  });
}

async function executeCnMatchListQuery(
  ctx: Context,
  rawQuery: string,
  page = 1,
  editMessage = false,
  explicitMode?: CnGameMode
): Promise<void> {
  const tgId = ctx.from?.id || 0;
  const cleanQ = normalizeBnetQuery(rawQuery);
  if (!cleanQ) {
    await ctx.reply(
      "请提供战网 ID，例如：\n<code>/match 玩家名#12345</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  if (!editMessage) {
    await ctx.replyWithChatAction("typing");
  }
  const mode: CnGameMode =
    explicitMode || (tgId > 0 ? userLastMode.get(tgId) : null) || "sport";
  const { text, keyboard, matchIds, matchSummaries } = await buildCnMatchListView(
    cleanQ,
    mode,
    page
  );

  if (tgId > 0) {
    userLastMode.set(tgId, mode);
    userLastBnet.set(tgId, cleanQ);
    userRecentMatchIds.set(tgId, matchIds);
    userRecentMatchMap.set(tgId, matchSummaries);
  }

  if (editMessage && ctx.callbackQuery?.message) {
    await safeEditTextMessage(
      ctx,
      text,
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
      },
      "流水已是最新"
    );
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }
}

// ============================================================================
// 11. 管理员控制台与超级管理员面板（两级权限编辑视图、每页 10 人用户分页、🔑 大神账号轮询）
// ============================================================================

function buildAdminHomeKeyboard(adminMe: AdminMeDto): InlineKeyboard {
  const isSuper = adminMe.role === "super_admin";
  const hasPerm = (p: string) => isSuper || adminMe.permissions.includes(p);
  const kb = new InlineKeyboard();

  if (hasPerm("user:view")) {
    kb.text("👤 查用户/列表", "adm:u:query");
  }
  if (hasPerm("quota:add")) {
    kb.text("➕ 加次数", "adm:q:add");
  }
  if (kb.inline_keyboard[kb.inline_keyboard.length - 1]?.length) {
    kb.row();
  }

  if (hasPerm("quota:deduct")) {
    kb.text("➖ 减次数", "adm:q:deduct");
  }
  if (hasPerm("vip:manage")) {
    kb.text("👑 VIP管理", "adm:v:menu");
  }
  if (kb.inline_keyboard[kb.inline_keyboard.length - 1]?.length) {
    kb.row();
  }

  if (hasPerm("redeem:create")) {
    kb.text("🎟 造卡密", "adm:r:create");
  }
  if (hasPerm("redeem:view")) {
    kb.text("🔎 查卡密", "adm:r:view");
  }
  if (kb.inline_keyboard[kb.inline_keyboard.length - 1]?.length) {
    kb.row();
  }

  if (hasPerm("redeem:void")) {
    kb.text("🚫 作废卡密", "adm:r:void");
  }
  if (hasPerm("user:ban")) {
    kb.text("🔒 封禁/解封", "adm:u:ban");
  }
  if (kb.inline_keyboard[kb.inline_keyboard.length - 1]?.length) {
    kb.row();
  }

  if (hasPerm("stats:view")) {
    kb.text("📊 运营统计", "adm:stats");
  }

  if (isSuper) {
    kb.row()
      .text("🧩 管理员权限", "sup:admins")
      .text("⚙️ 系统赠送设置", "sup:settings");
    kb.row()
      .text("🤖 AI 渠道管理", "sup:ai:menu")
      .text("🔑 大神账号轮询", "sup:ds:menu");
    kb.row().text("📜 审计日志", "sup:logs:1");
  }

  return kb;
}

async function openAdminConsole(ctx: Context, editMessage = false): Promise<void> {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  const me = await fetchAdminMe(tgId);
  if (!me || !me.isActive) {
    await ctx.reply("⛔ 你不是启用中的管理员，无权打开管理控制台。");
    return;
  }

  const roleText =
    me.role === "super_admin" ? "超级管理员" : "普通管理员";
  const permNames =
    me.role === "super_admin"
      ? ["全部权限"]
      : me.permissions.map((p) => PERMISSION_LABELS[p] || p);

  const text = [
    `🛠 <b>管理控制台</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `• 当前身份：<b>${escapeHtml(roleText)}</b>（${escapeHtml(me.remark || String(tgId))}）`,
    `• 已获权限：${escapeHtml(permNames.join("、") || "无")}`,
    `━━━━━━━━━━━━━━━━━━`,
    `请选择要执行的管理操作：`,
  ].join("\n");

  const kb = buildAdminHomeKeyboard(me);
  if (editMessage && ctx.callbackQuery?.message) {
    await safeEditTextMessage(
      ctx,
      text,
      { parse_mode: "HTML", reply_markup: kb },
      "控制台已是最新"
    );
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

async function showDashenAccountsPanel(
  ctx: Context,
  operatorId: number,
  editMessage = true
): Promise<void> {
  const accounts = await superFetchDashenAccounts(operatorId);

  const lines: string[] = [
    `🔑 <b>网易大神账号轮询池管理</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `当前共有 <b>${accounts.length}</b> 个账号，查询时按轮询顺序自动切换（单账号失败或无数据时自动顺延下一个启用账号；仅存必要参数与 <code>User-Agent</code>，不存 Cookie）。`,
  ];

  const kb = new InlineKeyboard();

  if (accounts.length === 0) {
    lines.push(
      `\n📭 暂无轮询账号，请点击下方「➕ 添加大神账号」粘贴 Raw 请求头录入。`
    );
  } else {
    for (const acc of accounts) {
      const statusIcon = acc.isEnabled ? "✅启用" : "⏸停用";
      const uaFlag = acc.userAgent ? "UA已存" : "默认UA";
      lines.push(
        `\n<b>#${acc.id} ${escapeHtml(acc.name)}</b> [${statusIcon}] · <code>${escapeHtml(uaFlag)}</code>`,
        `• Role ID：<code>${acc.roleId}</code> | Token：<code>${escapeHtml(acc.maskedToken || maskTokenDisplay(acc.authToken || ""))}</code>`,
        `• DTS：<code>${acc.dts}</code> | Server：<code>${acc.server}</code> | ClientType：<code>${escapeHtml(acc.clientType)}</code>`,
        `• 失败计数：<b>${acc.failCount || 0}</b> | 最近使用：${escapeHtml(acc.lastUsedAt || "未使用")}` +
          `${acc.lastError ? ` | 状态：<i>${escapeHtml(acc.lastError)}</i>` : ""}`
      );

      kb.text(
        acc.isEnabled ? `⏸ 停用 #${acc.id}` : `▶️ 启用 #${acc.id}`,
        `sup:ds:tgl:${acc.id}`
      )
        .text(`✏️ 修改 #${acc.id}`, `sup:ds:edt:${acc.id}`)
        .text(`🗑 删除 #${acc.id}`, `sup:ds:del:${acc.id}`)
        .row();
    }
  }

  kb.text("➕ 添加大神账号", "sup:ds:add")
    .text("🔄 刷新列表", "sup:ds:menu")
    .row()
    .text("🔙 返回控制台", "adm:home");

  const text = lines.join("\n");
  if (editMessage && ctx.callbackQuery?.message) {
    await safeEditTextMessage(
      ctx,
      text,
      { parse_mode: "HTML", reply_markup: kb },
      "列表已是最新"
    );
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

async function handleSuperDashenTextInput(
  ctx: Context,
  operatorId: number,
  rawText: string,
  editAccountId?: number
): Promise<void> {
  await tryDeleteMessage(ctx);
  const parsed = parseRawDashenHeadersInput(rawText);

  if (!parsed.authToken || !parsed.roleId) {
    await ctx.reply(
      "❌ <b>解析失败</b>：未能从粘贴内容中识别出完整的 <code>GL-Bigdata-Auth-Token</code> 与 <code>GL-Bigdata-Role-Id</code>。\n" +
        "请直接粘贴包含这两项的 Raw 请求头文本（可顺便带上 <code>User-Agent</code>、<code>GL-Bigdata-Dts</code>、<code>GL-Bigdata-Server</code>、<code>GL-ClientType</code>、<code>Origin</code>、<code>Referer</code>，首行可写账号备注名）。",
      { parse_mode: "HTML" }
    );
    return;
  }

  const accName =
    parsed.name ||
    (editAccountId ? `轮询账号#${editAccountId}` : `账号-${parsed.roleId}`);

  const saved = await superUpsertDashenAccountItem(operatorId, {
    id: editAccountId,
    name: accName,
    roleId: parsed.roleId,
    authToken: parsed.authToken,
    dts: parsed.dts || 2026,
    server: parsed.server || 1,
    clientType: parsed.clientType || "60",
    origin: parsed.origin || DASHEN_ORIGIN,
    referer: parsed.referer || DASHEN_REFERER,
    userAgent: parsed.userAgent || DASHEN_USER_AGENT,
    isEnabled: true,
  });

  await ctx.reply(
    `✅ <b>大神轮询账号已${editAccountId ? "更新" : "添加"}</b>\n` +
      `• 编号：<b>#${saved.id}</b>\n` +
      `• 名称：<b>${escapeHtml(accName)}</b>\n` +
      `• Role ID：<code>${parsed.roleId}</code>\n` +
      `• Token：<code>${escapeHtml(maskTokenDisplay(parsed.authToken))}</code>\n` +
      `• UA 存储：<code>${escapeHtml((parsed.userAgent || DASHEN_USER_AGENT).slice(0, 48))}...</code>`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔑 查看轮询池", "sup:ds:menu")
        .text("🛠 返回控制台", "adm:home"),
    }
  );
}

// ============================================================================
// 12. Bot 初始化、指令注册、回调与文本交互
// ============================================================================

if (!BOT_TOKEN) {
  throw new Error("缺少环境变量 BOT_TOKEN");
}

const bot = new Bot(BOT_TOKEN);

bot.command("start", async (ctx) => {
  try {
    const payloadText = String(ctx.match || "").trim();
    let inviterId: number | null = null;
    if (payloadText.startsWith("inv_")) {
      const parsedInv = Number(payloadText.slice(4));
      if (Number.isSafeInteger(parsedInv) && parsedInv > 0) {
        inviterId = parsedInv;
      }
    }

    const regRes = await ensureUserRegistered(ctx, inviterId);
    const tgId = ctx.from?.id || 0;
    const adminMe = tgId > 0 ? await fetchAdminMe(tgId) : null;
    const isAdmin = Boolean(adminMe?.isActive);

    const welcomeLines = [
      `👋 欢迎使用 <b>《守望先锋 2》国服战绩查询机器人</b>！`,
      `━━━━━━━━━━━━━━━━━━`,
      `• <code>/cn 玩家名#12345</code> — 查询国服战绩总览（竞技/快速）`,
      `• <code>/match 玩家名#12345</code> — 查询近期对局流水与单局详情`,
      `• <code>/me</code> — 查看个人中心、剩余次数、VIP 与邀请链接`,
      `• <code>/checkin</code> — 每日签到领锐评次数`,
      `• <code>/redeem 卡密</code> — 兑换次数或 VIP 卡密`,
    ];

    if (
      regRes.isNewUser &&
      regRes.settings.registerRewardEnabled &&
      regRes.settings.registerRewardQuota > 0
    ) {
      welcomeLines.push(
        `━━━━━━━━━━━━━━━━━━`,
        `🎁 新用户注册已赠送 <b>+${regRes.settings.registerRewardQuota}</b> 次 AI 锐评次数！`
      );
    }

    await ctx.reply(welcomeLines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: buildMainReplyKeyboard(isAdmin),
    });
  } catch (err: any) {
    await ctx.reply(
      `⚠️ ${escapeHtml(err?.message || "启动失败，请稍后重试")}`,
      { parse_mode: "HTML" }
    );
  }
});

bot.command("me", async (ctx) => {
  try {
    await ensureUserRegistered(ctx);
    await showUserProfileCard(ctx);
  } catch (err: any) {
    await ctx.reply(`⚠️ ${escapeHtml(err?.message || "查询失败")}`, {
      parse_mode: "HTML",
    });
  }
});

bot.command("checkin", async (ctx) => {
  try {
    await handleCheckinCommand(ctx);
  } catch (err: any) {
    await ctx.reply(`⚠️ ${escapeHtml(err?.message || "签到失败")}`, {
      parse_mode: "HTML",
    });
  }
});

bot.command("redeem", async (ctx) => {
  try {
    const code = String(ctx.match || "").trim();
    await handleRedeemCodeInput(ctx, code);
  } catch (err: any) {
    await ctx.reply(`⚠️ ${escapeHtml(err?.message || "兑换失败")}`, {
      parse_mode: "HTML",
    });
  }
});

bot.command("cn", async (ctx) => {
  try {
    const tgId = ctx.from?.id;
    if (tgId) await ensureUserRegistered(ctx);
    await executeCnOverviewQuery(ctx, String(ctx.match || ""));
  } catch (err: any) {
    await ctx.reply(`⚠️ ${escapeHtml(err?.message || "查询失败")}`, {
      parse_mode: "HTML",
    });
  }
});

bot.command("match", async (ctx) => {
  try {
    const tgId = ctx.from?.id;
    if (tgId) await ensureUserRegistered(ctx);
    await executeCnMatchListQuery(ctx, String(ctx.match || ""), 1, false);
  } catch (err: any) {
    await ctx.reply(`⚠️ ${escapeHtml(err?.message || "查询失败")}`, {
      parse_mode: "HTML",
    });
  }
});

bot.command("admin", async (ctx) => {
  try {
    await openAdminConsole(ctx, false);
  } catch (err: any) {
    await ctx.reply(`⚠️ ${escapeHtml(err?.message || "打开控制台失败")}`, {
      parse_mode: "HTML",
    });
  }
});

bot.on("callback_query", async (ctx) => {
  const tgId = ctx.from?.id;
  const data = String(ctx.callbackQuery?.data || "");
  if (!tgId || !data) return;

  try {
    if (data.startsWith("cn:sw:")) {
      await ctx.answerCallbackQuery({ text: "正在切换模式..." });
      const parts = data.split(":");
      const nextMode: CnGameMode = parts[2] === "leisure" ? "leisure" : "sport";
      const bnet = parts.slice(3).join(":");
      const adminMe = await fetchAdminMe(tgId);
      const view = await buildCnOverviewView(
        bnet,
        nextMode,
        Boolean(adminMe?.isActive)
      );
      userLastMode.set(tgId, nextMode);
      userLastBnet.set(tgId, bnet);
      await safeEditTextMessage(
        ctx,
        view.text,
        {
          parse_mode: "HTML",
          reply_markup: view.keyboard,
        },
        "总览已是最新"
      );
      return;
    }

    if (data.startsWith("cn:back:")) {
      await ctx.answerCallbackQuery({ text: "返回战绩总览..." });
      const bnet = data.slice("cn:back:".length);
      const mode = userLastMode.get(tgId) || "sport";
      const adminMe = await fetchAdminMe(tgId);
      const view = await buildCnOverviewView(
        bnet,
        mode,
        Boolean(adminMe?.isActive)
      );
      await safeEditTextMessage(
        ctx,
        view.text,
        {
          parse_mode: "HTML",
          reply_markup: view.keyboard,
        },
        "总览已是最新"
      );
      return;
    }

    if (data.startsWith("cn:ml:")) {
      await ctx.answerCallbackQuery({ text: "正在加载战绩流水..." });
      const parts = data.split(":");
      const mode: CnGameMode = parts[2] === "leisure" ? "leisure" : "sport";
      const page = Math.max(1, Number(parts[3] || 1));
      const bnet = parts.slice(4).join(":");
      userLastMode.set(tgId, mode);
      await executeCnMatchListQuery(ctx, bnet, page, true, mode);
      return;
    }

    if (data.startsWith("cn:md:")) {
      await ctx.answerCallbackQuery({ text: "正在加载对局详情..." });
      const parts = data.split(":");
      const idx = Number(parts[2] || 0);
      const bnet = parts.slice(3).join(":");
      const matchIds = userRecentMatchIds.get(tgId) || [];
      const matchSummaries = userRecentMatchMap.get(tgId) || {};
      const matchId = matchIds[idx];
      if (!matchId) {
        await ctx.reply(
          "⚠️ 对局列表已过期，请重新发送 <code>/match 战网ID</code> 获取最新列表。",
          { parse_mode: "HTML" }
        );
        return;
      }
      const player = await resolvePlayerWithTokenCache(bnet);
      const { text, keyboard } = await buildCnMatchDetailView(
        player.bnet,
        player.customerToken,
        matchId,
        matchSummaries[matchId] || null
      );
      await safeEditTextMessage(
        ctx,
        text,
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        },
        "详情已是最新"
      );
      return;
    }

    if (data.startsWith("cn:rs:") || data.startsWith("cn:rm:")) {
      const roastType: RoastType = data.startsWith("cn:rm:") ? "mmr" : "self";
      await ctx.answerCallbackQuery({ text: "准备生成 AI 点评..." });
      const parts = data.split(":");
      const mode: CnGameMode = parts[2] === "leisure" ? "leisure" : "sport";
      const bnet = parts.slice(3).join(":");
      const view = await buildCnOverviewView(bnet, mode, false);
      await executeRoastFlow(ctx, {
        roastType,
        bnet,
        mode,
        promptContext: view.snapshotText,
        detailLabel: roastType === "mmr" ? "隐性段位评估" : "综合战绩锐评",
      });
      return;
    }

    if (data.startsWith("cn:ar:")) {
      await ctx.answerCallbackQuery({ text: "准备生成单局锐评..." });
      const rest = data.slice("cn:ar:".length);
      const sepIdx = rest.indexOf(":");
      if (sepIdx <= 0) return;
      const matchId = rest.slice(0, sepIdx);
      const bnet = rest.slice(sepIdx + 1);
      const mode = userLastMode.get(tgId) || "sport";
      const player = await resolvePlayerWithTokenCache(bnet);
      const summaries = userRecentMatchMap.get(tgId) || {};
      const detailView = await buildCnMatchDetailView(
        player.bnet,
        player.customerToken,
        matchId,
        summaries[matchId] || null
      );
      const cleanDetail = detailView.text.replace(/<[^>]+>/g, "");
      await executeRoastFlow(ctx, {
        roastType: "match",
        bnet: player.bnet,
        mode,
        matchId,
        promptContext: cleanDetail,
        detailLabel: `单局锐评 ${matchId}`,
      });
      return;
    }

    if (data === "adm:home") {
      await ctx.answerCallbackQuery();
      await openAdminConsole(ctx, true);
      return;
    }

    if (data === "adm:stats") {
      await ctx.answerCallbackQuery({ text: "正在统计..." });
      const st = await adminFetchStats(tgId);
      const text = [
        `📊 <b>运营统计（${escapeHtml(st.today)}）</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `• 总用户数：<b>${st.totalUsers}</b>  |  今日新增：<b>${st.todayNewUsers}</b>`,
        `• 今日签到：<b>${st.todayCheckins}</b> 人  |  有效 VIP：<b>${st.activeVips}</b> 人`,
        `• 今日锐评消耗：<b>${st.todayTotalRoasts}</b> 次（免费 ${st.todayFreeRoasts} / 付费 ${st.todayPaidRoasts}）`,
        `• 未使用卡密：<b>${st.unusedRedeemCodes}</b> 张`,
      ].join("\n");
      await safeEditTextMessage(
        ctx,
        text,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🔙 返回控制台", "adm:home"),
        },
        "统计已是最新"
      );
      return;
    }

    if (data === "adm:u:query") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_user_query" },
        expiresAt: Date.now() + 180_000,
      });
      await renderUserPagePanel(ctx, tgId, "query", 1, false);
      return;
    }

    if (data === "adm:q:add") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_quota_add" },
        expiresAt: Date.now() + 180_000,
      });
      await renderUserPagePanel(ctx, tgId, "quota_add", 1, false);
      return;
    }

    if (data === "adm:q:deduct") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_quota_deduct" },
        expiresAt: Date.now() + 180_000,
      });
      await renderUserPagePanel(ctx, tgId, "quota_deduct", 1, false);
      return;
    }

    if (data === "adm:v:menu") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_vip_manage" },
        expiresAt: Date.now() + 180_000,
      });
      await renderUserPagePanel(ctx, tgId, "vip", 1, false);
      return;
    }

    if (data === "adm:u:ban") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_user_ban" },
        expiresAt: Date.now() + 180_000,
      });
      await renderUserPagePanel(ctx, tgId, "ban", 1, false);
      return;
    }

    if (data.startsWith("adm:up:")) {
      await ctx.answerCallbackQuery({ text: "正在翻页..." });
      const parts = data.split(":");
      const scene = (parts[2] || "query") as UserPickerScene;
      const targetPage = Math.max(1, Number(parts[3] || 1));
      await renderUserPagePanel(ctx, tgId, scene, targetPage, true);
      return;
    }

    if (data === "adm:r:create") {
      await ctx.answerCallbackQuery();
      await safeEditTextMessage(
        ctx,
        "🎟 <b>生成兑换卡密</b>\n请选择要生成的卡密类型：",
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("🎫 生成次数卡密", "adm:r:c:quota")
            .text("👑 生成 VIP 卡密", "adm:r:c:vip_days")
            .row()
            .text("🔙 返回控制台", "adm:home"),
        },
        "面板已是最新"
      );
      return;
    }

    if (data === "adm:r:c:quota" || data === "adm:r:c:vip_days") {
      await ctx.answerCallbackQuery();
      const rewardType =
        data === "adm:r:c:vip_days" ? "vip_days" : "quota";
      const typeLabel =
        rewardType === "vip_days" ? "VIP 天数卡密" : "锐评次数卡密";
      const unitLabel = rewardType === "vip_days" ? "天" : "次";
      pendingUserInputs.set(tgId, {
        action: { type: "admin_redeem_create", rewardType },
        expiresAt: Date.now() + 180_000,
      });
      await ctx.reply(
        `🎟 <b>生成${escapeHtml(typeLabel)}</b>\n请输入：<code>单张面额 生成张数</code>（最多 50 张）\n例如：<code>5 10</code>（表示生成 10 张单张 ${escapeHtml(unitLabel)} 对应面额的卡密）`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "adm:r:view") {
      await ctx.answerCallbackQuery({ text: "正在查询全部卡密..." });
      const info = await adminLookupRedeemCode(tgId, "all");
      if (info?.isList) {
        const items = Array.isArray(info.items) ? info.items : [];
        const lines = [
          `🔎 <b>全部兑换卡密列表（共 ${Number(info.totalCodes || items.length)} 张，展示最新 ${items.length} 张）</b>`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        if (items.length === 0) {
          lines.push(`📭 <i>当前暂无卡密记录。</i>`);
        } else {
          for (const c of items) {
            lines.push(
              `• <code>${escapeHtml(c.code)}</code> | 类型：<b>${escapeHtml(formatRedeemTypeLabel(c.rewardType))}</b>（${escapeHtml(formatRedeemRewardText(c.rewardType, c.rewardValue))}） | 状态：<b>${escapeHtml(formatRedeemStatusLabel(c.status))}</b>`
            );
          }
        }
        lines.push(
          `━━━━━━━━━━━━━━━━━━`,
          `<i>提示：如需单独查询某张卡密，也可直接发送卡密编号。</i>`
        );
        pendingUserInputs.set(tgId, {
          action: { type: "admin_redeem_view" },
          expiresAt: Date.now() + 180_000,
        });
        await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      } else {
        await ctx.reply(
          `🔎 <b>卡密详情</b>\n• 编号：<code>${escapeHtml(info.code)}</code>\n• 类型：<b>${escapeHtml(formatRedeemTypeLabel(info.rewardType))}</b>（面额 <b>${escapeHtml(formatRedeemRewardText(info.rewardType, info.rewardValue))}</b>）\n• 状态：<b>${escapeHtml(formatRedeemStatusLabel(info.status))}</b>`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    if (data === "adm:r:void") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_redeem_void" },
        expiresAt: Date.now() + 180_000,
      });
      await ctx.reply(
        "🚫 请按格式输入：<code>卡密编号 作废原因</code>\n例如：<code>OW2C-5-ABCD1234 测试作废</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "sup:settings") {
      await ctx.answerCallbackQuery();
      const st = await superFetchSettings(tgId);
      const text = [
        `⚙️ <b>系统与赠送设置</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `• 机器人状态：<b>${st.botStatus === "maintenance" ? "🛠 维护中" : "✅ 正常运行"}</b>`,
        `• 新注册赠送：${st.registerRewardEnabled ? `✅ 开启（<b>${st.registerRewardQuota}</b> 次）` : "❌ 关闭"}`,
        `• 邀请赠送：${st.inviteRewardEnabled ? `✅ 开启（<b>${st.inviteRewardQuota}</b> 次）` : "❌ 关闭"}`,
        `• 签到赠送：${st.checkinRewardEnabled ? `✅ 开启（<b>${st.checkinRewardQuota}</b> 次）` : "❌ 关闭"}`,
      ].join("\n");

      const kb = new InlineKeyboard()
        .text(
          st.botStatus === "maintenance" ? "✅ 恢复正常服务" : "🛠 切换维护模式",
          "sup:st:toggle_maint"
        )
        .row()
        .text(
          st.registerRewardEnabled ? "❌ 关注册赠送" : "✅ 开注册赠送",
          "sup:st:tgl_reg"
        )
        .text("✏️ 改注册次数", "sup:st:val_reg")
        .row()
        .text(
          st.inviteRewardEnabled ? "❌ 关邀请赠送" : "✅ 开邀请赠送",
          "sup:st:tgl_inv"
        )
        .text("✏️ 改邀请次数", "sup:st:val_inv")
        .row()
        .text(
          st.checkinRewardEnabled ? "❌ 关签到赠送" : "✅ 开签到赠送",
          "sup:st:tgl_chk"
        )
        .text("✏️ 改签到次数", "sup:st:val_chk")
        .row()
        .text("🔙 返回控制台", "adm:home");

      await safeEditTextMessage(
        ctx,
        text,
        { parse_mode: "HTML", reply_markup: kb },
        "设置已是最新"
      );
      return;
    }

    if (data.startsWith("sup:st:")) {
      await ctx.answerCallbackQuery();
      const sub = data.slice("sup:st:".length);
      const st = await superFetchSettings(tgId);
      if (sub === "toggle_maint") {
        const refreshed = await superPatchSettings(tgId, {
          botStatus: st.botStatus === "maintenance" ? "normal" : "maintenance",
        });
        await safeEditTextMessage(
          ctx,
          `✅ 机器人状态已更新为：<b>${refreshed.botStatus === "maintenance" ? "🛠 维护中" : "✅ 正常运行"}</b>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text(
              "🔙 返回设置",
              "sup:settings"
            ),
          },
          "状态已是最新"
        );
        return;
      }
      if (sub === "tgl_reg") {
        await superPatchSettings(tgId, {
          registerRewardEnabled: !st.registerRewardEnabled,
        });
        await safeEditTextMessage(
          ctx,
          "✅ 新注册赠送开关已更新。",
          {
            reply_markup: new InlineKeyboard().text("🔙 返回设置", "sup:settings"),
          },
          "开关已是最新"
        );
        return;
      }
      if (sub === "tgl_inv") {
        await superPatchSettings(tgId, {
          inviteRewardEnabled: !st.inviteRewardEnabled,
        });
        await safeEditTextMessage(
          ctx,
          "✅ 邀请赠送开关已更新。",
          {
            reply_markup: new InlineKeyboard().text("🔙 返回设置", "sup:settings"),
          },
          "开关已是最新"
        );
        return;
      }
      if (sub === "tgl_chk") {
        await superPatchSettings(tgId, {
          checkinRewardEnabled: !st.checkinRewardEnabled,
        });
        await safeEditTextMessage(
          ctx,
          "✅ 签到赠送开关已更新。",
          {
            reply_markup: new InlineKeyboard().text("🔙 返回设置", "sup:settings"),
          },
          "开关已是最新"
        );
        return;
      }
      if (sub === "val_reg" || sub === "val_inv" || sub === "val_chk") {
        pendingUserInputs.set(tgId, {
          action: {
            type:
              sub === "val_reg"
                ? "super_setting_reg_quota"
                : sub === "val_inv"
                  ? "super_setting_inv_quota"
                  : "super_setting_chk_quota",
          },
          expiresAt: Date.now() + 180_000,
        });
        await ctx.reply("请输入新的赠送次数（0 ~ 10000 整数）：");
        return;
      }
    }

    if (data === "sup:admins") {
      await ctx.answerCallbackQuery();
      await showAdminsPermissionPanel(ctx, tgId, true);
      return;
    }

    if (data.startsWith("sup:adm:edit:")) {
      await ctx.answerCallbackQuery({ text: "进入专属权限编辑页..." });
      const targetId = Number(data.slice("sup:adm:edit:".length));
      await showSingleAdminEditPanel(ctx, tgId, targetId, true);
      return;
    }

    if (data.startsWith("sup:adm:perm:")) {
      await ctx.answerCallbackQuery({ text: "正在切换权限..." });
      const rest = data.slice("sup:adm:perm:".length);
      const colonIdx = rest.indexOf(":");
      if (colonIdx > 0) {
        const targetId = Number(rest.slice(0, colonIdx));
        const permCode = rest.slice(colonIdx + 1);
        await superToggleAdminPermItem(tgId, targetId, permCode);
        await showSingleAdminEditPanel(ctx, tgId, targetId, true);
      } else {
        await showAdminsPermissionPanel(ctx, tgId, true);
      }
      return;
    }

    if (data === "sup:adm:add") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "super_admin_add" },
        expiresAt: Date.now() + 180_000,
      });
      await renderUserPagePanel(ctx, tgId, "admin_add", 1, false);
      return;
    }

    if (data.startsWith("sup:adm:tgl:")) {
      await ctx.answerCallbackQuery();
      const targetId = Number(data.slice("sup:adm:tgl:".length));
      const d = await superFetchAdminsList(tgId);
      const found = (d.admins || []).find(
        (x: any) => Number(x.tgId) === targetId
      );
      await superPatchAdminMeta(tgId, targetId, {
        isActive: !(found?.isActive ?? true),
      });
      await showAdminsPermissionPanel(ctx, tgId, true);
      return;
    }

    if (data.startsWith("sup:adm:del:")) {
      await ctx.answerCallbackQuery();
      const targetId = Number(data.slice("sup:adm:del:".length));
      await superRemoveAdmin(tgId, targetId);
      await showAdminsPermissionPanel(ctx, tgId, true);
      return;
    }

    if (data.startsWith("sup:logs:")) {
      await ctx.answerCallbackQuery();
      const page = Math.max(1, Number(data.slice("sup:logs:".length) || 1));
      const logsData = await superFetchAuditLogs(tgId, page, 6);
      const lines = [
        `📜 <b>管理员审计日志（第 ${logsData.page}/${logsData.totalPages} 页）</b>`,
        `━━━━━━━━━━━━━━━━━━`,
      ];
      for (const item of logsData.items || []) {
        lines.push(
          `• [${escapeHtml(item.createdAt)}] <b>${escapeHtml(item.action)}</b>`,
          `  操作人：${escapeHtml(item.operatorNickname)} → ${escapeHtml(item.targetId)}`,
          `  详情：<i>${escapeHtml(item.detail || "-")}</i>`
        );
      }
      const kb = new InlineKeyboard();
      if (logsData.page > 1) {
        kb.text("⬅️ 上一页", `sup:logs:${logsData.page - 1}`);
      }
      if (logsData.page < logsData.totalPages) {
        kb.text("➡️ 下一页", `sup:logs:${logsData.page + 1}`);
      }
      kb.row().text("🔙 返回控制台", "adm:home");
      await safeEditTextMessage(
        ctx,
        lines.join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: kb,
        },
        "日志已是最新"
      );
      return;
    }

    if (data === "sup:ai:menu") {
      await ctx.answerCallbackQuery();
      const cfg = await superFetchAiProviders(tgId);
      const lines = [
        `🤖 <b>AI 锐评渠道管理</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `• 默认 DeepSeek 通道：${cfg.defaultDeepseekEnabled ? "✅ 开启" : "❌ 关闭"}`,
      ];
      const kb = new InlineKeyboard().text(
        cfg.defaultDeepseekEnabled
          ? "❌ 关闭默认 DeepSeek"
          : "✅ 开启默认 DeepSeek",
        "sup:ai:tgl:0"
      );

      for (const p of cfg.providers || []) {
        lines.push(
          `\n<b>#${p.id} ${escapeHtml(p.name)}</b> [${p.isEnabled ? "✅启用" : "⏸停用"}] · <code>${escapeHtml(p.executionTarget || "vercel")}</code>`,
          `• 模型：<code>${escapeHtml(p.model)}</code> | Key：<code>${escapeHtml(p.maskedKey || "")}</code>`
        );
        kb.row()
          .text(
            p.isEnabled ? `⏸ 停用 #${p.id}` : `▶️ 启用 #${p.id}`,
            `sup:ai:tgl:${p.id}`
          )
          .text(
            p.executionTarget === "docker" ? "☁️ 切Vercel" : "🐳 切Docker",
            `sup:ai:tgt:${p.id}:${p.executionTarget === "docker" ? "vercel" : "docker"}`
          )
          .text(`🔑 改Key`, `sup:ai:key:${p.id}`)
          .text(`🗑 删`, `sup:ai:del:${p.id}`);
      }

      kb.row()
        .text("➕ 添加 AI 渠道", "sup:ai:add")
        .text("🔙 返回控制台", "adm:home");

      await safeEditTextMessage(
        ctx,
        lines.join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: kb,
        },
        "渠道已是最新"
      );
      return;
    }

    if (data === "sup:ai:add") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "super_ai_provider_add" },
        expiresAt: Date.now() + 180_000,
      });
      await ctx.reply(
        "➕ 请按格式输入 AI 渠道：\n<code>渠道名称 | BaseURL | APIKey | 模型名 | vercel|docker</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data.startsWith("sup:ai:tgl:")) {
      await ctx.answerCallbackQuery();
      const pid = Number(data.slice("sup:ai:tgl:".length));
      await superToggleAiProviderById(tgId, pid);
      await safeEditTextMessage(
        ctx,
        "✅ AI 渠道开关已更新。",
        {
          reply_markup: new InlineKeyboard().text(
            "🔙 返回渠道列表",
            "sup:ai:menu"
          ),
        },
        "状态已是最新"
      );
      return;
    }

    if (data.startsWith("sup:ai:tgt:")) {
      await ctx.answerCallbackQuery();
      const parts = data.split(":");
      const pid = Number(parts[3]);
      const nextTarget = parts[4] === "docker" ? "docker" : "vercel";
      await superSwitchAiProviderTarget(tgId, pid, nextTarget);
      await safeEditTextMessage(
        ctx,
        "✅ AI 渠道执行节点已切换。",
        {
          reply_markup: new InlineKeyboard().text(
            "🔙 返回渠道列表",
            "sup:ai:menu"
          ),
        },
        "节点已是最新"
      );
      return;
    }

    if (data.startsWith("sup:ai:key:")) {
      await ctx.answerCallbackQuery();
      const pid = Number(data.slice("sup:ai:key:".length));
      const promptMsg = await ctx.reply(
        `🔑 请输入渠道 <b>#${pid}</b> 的新 API Key（输入后将自动删除该消息）：`,
        { parse_mode: "HTML" }
      );
      pendingUserInputs.set(tgId, {
        action: {
          type: "super_ai_provider_key",
          providerId: pid,
          promptMessageId: promptMsg.message_id,
        },
        expiresAt: Date.now() + 180_000,
      });
      return;
    }

    if (data.startsWith("sup:ai:del:")) {
      await ctx.answerCallbackQuery();
      const pid = Number(data.slice("sup:ai:del:".length));
      await superDeleteAiProviderById(tgId, pid);
      await safeEditTextMessage(
        ctx,
        "✅ AI 渠道已删除。",
        {
          reply_markup: new InlineKeyboard().text(
            "🔙 返回渠道列表",
            "sup:ai:menu"
          ),
        },
        "列表已是最新"
      );
      return;
    }

    if (data === "sup:ds:menu") {
      await ctx.answerCallbackQuery();
      await showDashenAccountsPanel(ctx, tgId, true);
      return;
    }

    if (data === "sup:ds:add") {
      await ctx.answerCallbackQuery();
      const promptMsg = await ctx.reply(
        "➕ <b>添加网易大神轮询账号</b>\n请直接粘贴完整的 Raw 请求头文本（包含 <code>GL-Bigdata-Auth-Token</code> 与 <code>GL-Bigdata-Role-Id</code>，可附带 <code>User-Agent</code>、<code>GL-Bigdata-Dts</code>、<code>GL-Bigdata-Server</code>、<code>GL-ClientType</code>、<code>Origin</code>、<code>Referer</code>，首行可写备注名）。提交后将自动删除消息：",
        { parse_mode: "HTML" }
      );
      pendingUserInputs.set(tgId, {
        action: {
          type: "super_dashen_account_add",
          promptMessageId: promptMsg.message_id,
        },
        expiresAt: Date.now() + 240_000,
      });
      return;
    }

    if (data.startsWith("sup:ds:edt:")) {
      await ctx.answerCallbackQuery();
      const aid = Number(data.slice("sup:ds:edt:".length));
      const promptMsg = await ctx.reply(
        `✏️ <b>修改轮询账号 #${aid}</b>\n请粘贴新的 Raw 请求头文本以覆盖更新该账号的凭证与参数（首行可写新备注名）。提交后将自动删除消息：`,
        { parse_mode: "HTML" }
      );
      pendingUserInputs.set(tgId, {
        action: {
          type: "super_dashen_account_edit",
          accountId: aid,
          promptMessageId: promptMsg.message_id,
        },
        expiresAt: Date.now() + 240_000,
      });
      return;
    }

    if (data.startsWith("sup:ds:tgl:")) {
      await ctx.answerCallbackQuery({ text: "正在切换状态..." });
      const aid = Number(data.slice("sup:ds:tgl:".length));
      await superToggleDashenAccountItem(tgId, aid);
      await showDashenAccountsPanel(ctx, tgId, true);
      return;
    }

    if (data.startsWith("sup:ds:del:")) {
      await ctx.answerCallbackQuery({ text: "正在删除..." });
      const aid = Number(data.slice("sup:ds:del:".length));
      await superDeleteDashenAccountItem(tgId, aid);
      await showDashenAccountsPanel(ctx, tgId, true);
      return;
    }

    await ctx.answerCallbackQuery();
  } catch (err: any) {
    await ctx.reply(
      `⚠️ ${escapeHtml(err?.message || "操作失败，请稍后重试")}`,
      { parse_mode: "HTML" }
    );
  }
});

bot.on("message:text", async (ctx) => {
  const tgId = ctx.from?.id;
  const text = String(ctx.message?.text || "").trim();
  if (!tgId || !text || text.startsWith("/")) return;

  try {
    const pending = pendingUserInputs.get(tgId);
    if (pending) {
      if (Date.now() > pending.expiresAt) {
        pendingUserInputs.delete(tgId);
      } else {
        const act = pending.action;
        pendingUserInputs.delete(tgId);

        if (act.type === "redeem_input") {
          await handleRedeemCodeInput(ctx, text);
          return;
        }

        if (act.type === "cn_query_input") {
          await executeCnOverviewQuery(ctx, text);
          return;
        }

        if (act.type === "match_query_input") {
          await executeCnMatchListQuery(ctx, text, 1, false);
          return;
        }

        if (act.type === "admin_user_query") {
          const d = await adminQueryUserOrList(tgId, text, 1, 10);
          if (d.isList) {
            const lines = [
              `👥 <b>用户列表（每页 10 人 · 第 ${d.page || 1}/${d.totalPages || 1} 页 · 共 ${d.totalUsers} 人）</b>`,
              `━━━━━━━━━━━━━━━━━━`,
            ];
            for (const u of d.users || []) {
              lines.push(
                `• <b>${escapeHtml(u.nickname || "无昵称")}</b> (<code>${u.tgId}</code>) | 次数：<b>${u.quota}</b>${u.vipActive ? " | 👑VIP" : ""}${u.isBanned ? " | 🔒已封禁" : ""}`
              );
            }
            await replyQuoteUser(ctx, lines.join("\n"));
          } else {
            const u = d.user;
            const lines = [
              `👤 <b>用户详情</b>`,
              `━━━━━━━━━━━━━━━━━━`,
              `• 昵称：<b>${escapeHtml(u.nickname || "无昵称")}</b>`,
              `• TG ID：<code>${u.tgId}</code> | 用户名：${u.username ? `@${escapeHtml(u.username)}` : "无"}`,
              `• 剩余次数：<b>${u.quota}</b> | VIP：${u.vipActive ? `✅ 至 ${escapeHtml(u.vipExpireAt || "")}` : "否"}`,
              `• 状态：${u.isBanned ? "🔒 已封禁" : "✅ 正常"} | 邀请数：<b>${u.inviteCount}</b>`,
            ];
            await replyQuoteUser(ctx, lines.join("\n"));
          }
          return;
        }

        if (act.type === "admin_quota_add") {
          const [idStr, amtStr, ...rParts] = text.split(/\s+/);
          const reasonText = rParts.join(" ");
          const res = await adminAddUserQuota(
            tgId,
            Number(idStr),
            Number(amtStr),
            reasonText
          );
          await replyQuoteUser(
            ctx,
            `✅ <b>加次数操作成功</b>\n• 目标用户：<code>${res.tgId}</code>\n• 增加次数：<b>+${res.added}</b> 次\n• 最新余额：<b>${res.afterQuota}</b> 次\n• 原因：${escapeHtml(res.reason)}`
          );
          return;
        }

        if (act.type === "admin_quota_deduct") {
          const [idStr, amtStr, ...rParts] = text.split(/\s+/);
          const reasonText = rParts.join(" ");
          const res = await adminDeductUserQuota(
            tgId,
            Number(idStr),
            Number(amtStr),
            reasonText
          );
          await replyQuoteUser(
            ctx,
            `✅ <b>减次数操作成功</b>\n• 目标用户：<code>${res.tgId}</code>\n• 扣减次数：<b>-${res.deducted}</b> 次\n• 最新余额：<b>${res.afterQuota}</b> 次\n• 原因：${escapeHtml(res.reason)}`
          );
          return;
        }

        if (act.type === "admin_vip_manage") {
          const parts = text.split(/\s+/);
          const uid = Number(parts[0]);
          const modeType = parts[1]?.toLowerCase();
          if (modeType === "revoke") {
            const res = await adminSetUserVip(
              tgId,
              uid,
              "revoke",
              0,
              parts.slice(2).join(" ")
            );
            await replyQuoteUser(
              ctx,
              `✅ <b>取消 VIP 操作成功</b>\n• 目标用户：<code>${res.tgId}</code>\n• 原因：${escapeHtml(res.reason)}`
            );
          } else {
            const res = await adminSetUserVip(
              tgId,
              uid,
              "grant",
              Number(parts[2]),
              parts.slice(3).join(" ")
            );
            await replyQuoteUser(
              ctx,
              `✅ <b>开通/续期 VIP 操作成功</b>\n• 目标用户：<code>${res.tgId}</code>\n• 到期时间：<b>${escapeHtml(res.afterVip || "")}</b>\n• 原因：${escapeHtml(res.reason)}`
            );
          }
          return;
        }

        if (act.type === "admin_user_ban") {
          const [idStr, modeStr, ...rParts] = text.split(/\s+/);
          const banned = modeStr?.toLowerCase() !== "unban";
          const res = await adminSetUserBan(
            tgId,
            Number(idStr),
            banned,
            rParts.join(" ")
          );
          await replyQuoteUser(
            ctx,
            banned
              ? `✅ <b>封禁操作成功</b>\n• 目标用户：<code>${res.tgId}</code>\n• 原因：${escapeHtml(res.reason)}`
              : `✅ <b>解封操作成功</b>\n• 目标用户：<code>${res.tgId}</code>\n• 原因：${escapeHtml(res.reason)}`
          );
          return;
        }

        if (act.type === "admin_redeem_create") {
          const [valStr, cntStr] = text.split(/\s+/);
          const created = await adminGenerateRedeemCodes(
            tgId,
            act.rewardType,
            Number(valStr),
            Number(cntStr || 1)
          );
          await replyQuoteUser(
            ctx,
            `✅ <b>造卡密成功（共 ${created.count} 张）</b>\n\n<code>${escapeHtml((created.codes || []).join("\n"))}</code>`
          );
          return;
        }

        if (act.type === "admin_redeem_view") {
          const info = await adminLookupRedeemCode(tgId, text);
          if (info?.isList) {
            const items = Array.isArray(info.items) ? info.items : [];
            const lines = [
              `🔎 <b>全部兑换卡密列表（共 ${Number(info.totalCodes || items.length)} 张，展示最新 ${items.length} 张）</b>`,
              `━━━━━━━━━━━━━━━━━━`,
            ];
            for (const c of items) {
              lines.push(
                `• <code>${escapeHtml(c.code)}</code> | 类型：<b>${escapeHtml(formatRedeemTypeLabel(c.rewardType))}</b>（${escapeHtml(formatRedeemRewardText(c.rewardType, c.rewardValue))}） | 状态：<b>${escapeHtml(formatRedeemStatusLabel(c.status))}</b>`
              );
            }
            await replyQuoteUser(ctx, lines.join("\n"));
          } else {
            await replyQuoteUser(
              ctx,
              `🔎 <b>卡密详情</b>\n• 编号：<code>${escapeHtml(info.code)}</code>\n• 类型：<b>${escapeHtml(formatRedeemTypeLabel(info.rewardType))}</b>（面额 <b>${escapeHtml(formatRedeemRewardText(info.rewardType, info.rewardValue))}</b>）\n• 状态：<b>${escapeHtml(formatRedeemStatusLabel(info.status))}</b>`
            );
          }
          return;
        }

        if (act.type === "admin_redeem_void") {
          const [codeStr, ...rParts] = text.split(/\s+/);
          const res = await adminRevokeRedeemCode(
            tgId,
            codeStr,
            rParts.join(" ")
          );
          await replyQuoteUser(
            ctx,
            `✅ <b>作废卡密成功</b>\n• 卡密编号：<code>${escapeHtml(res.code)}</code>\n• 原因：${escapeHtml(res.voidReason)}`
          );
          return;
        }

        if (act.type === "super_admin_add") {
          const [idStr, ...remParts] = text.split(/\s+/);
          const res = await superCreateAdmin(
            tgId,
            Number(idStr),
            remParts.join(" ")
          );
          await replyQuoteUser(
            ctx,
            `✅ <b>添加普通管理员成功</b>\n• 管理员 ID：<code>${res.tgId}</code>\n• 备注：<b>${escapeHtml(res.remark)}</b>`
          );
          return;
        }

        if (
          act.type === "super_setting_reg_quota" ||
          act.type === "super_setting_inv_quota" ||
          act.type === "super_setting_chk_quota"
        ) {
          const num = Number(text);
          if (act.type === "super_setting_reg_quota") {
            await superPatchSettings(tgId, { registerRewardQuota: num });
          } else if (act.type === "super_setting_inv_quota") {
            await superPatchSettings(tgId, { inviteRewardQuota: num });
          } else {
            await superPatchSettings(tgId, { checkinRewardQuota: num });
          }
          await replyQuoteUser(ctx, "✅ <b>赠送次数更新成功</b>。");
          return;
        }

        if (act.type === "super_ai_provider_add") {
          const [name, baseUrl, apiKey, model, targetRaw] = text
            .split("|")
            .map((s) => s.trim());
          const res = await superAddAiProvider(tgId, {
            name,
            baseUrl,
            apiKey,
            model,
            executionTarget: targetRaw === "docker" ? "docker" : "vercel",
          });
          await replyQuoteUser(
            ctx,
            `✅ <b>添加 AI 渠道成功</b>\n• 名称：<b>${escapeHtml(res.name)}</b>（#${res.id}）\n• 模型：<code>${escapeHtml(res.model)}</code>`
          );
          return;
        }

        if (act.type === "super_ai_provider_key") {
          await tryDeleteMessage(ctx);
          if (act.promptMessageId) {
            await tryDeleteMessage(ctx, ctx.chat?.id, act.promptMessageId);
          }
          await superUpdateAiProviderApiKey(tgId, act.providerId, text);
          await ctx.reply("✅ <b>AI 渠道密钥更新成功</b>。", {
            parse_mode: "HTML",
          });
          return;
        }

        if (act.type === "super_dashen_account_add") {
          if (act.promptMessageId) {
            await tryDeleteMessage(ctx, ctx.chat?.id, act.promptMessageId);
          }
          await handleSuperDashenTextInput(ctx, tgId, text);
          return;
        }

        if (act.type === "super_dashen_account_edit") {
          if (act.promptMessageId) {
            await tryDeleteMessage(ctx, ctx.chat?.id, act.promptMessageId);
          }
          await handleSuperDashenTextInput(ctx, tgId, text, act.accountId);
          return;
        }
      }
    }

    if (text === "🇨🇳 查国服战绩") {
      await ensureUserRegistered(ctx);
      pendingUserInputs.set(tgId, {
        action: { type: "cn_query_input" },
        expiresAt: Date.now() + 180_000,
      });
      await ctx.reply(
        "请输入要查询的国服战网 ID（例如：<code>玩家名#12345</code>）：",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (text === "📋 查战绩流水") {
      await ensureUserRegistered(ctx);
      pendingUserInputs.set(tgId, {
        action: { type: "match_query_input" },
        expiresAt: Date.now() + 180_000,
      });
      await ctx.reply(
        "请输入要查流水的国服战网 ID（例如：<code>玩家名#12345</code>）：",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (text === "👤 个人中心") {
      await ensureUserRegistered(ctx);
      await showUserProfileCard(ctx);
      return;
    }

    if (text === "📅 每日签到") {
      await handleCheckinCommand(ctx);
      return;
    }

    if (text === "🎁 兑换卡密") {
      await ensureUserRegistered(ctx);
      pendingUserInputs.set(tgId, {
        action: { type: "redeem_input" },
        expiresAt: Date.now() + 180_000,
      });
      await ctx.reply("🎁 请输入你的兑换卡密（输入后将自动删除消息）：");
      return;
    }

    if (text === "🔗 邀请好友") {
      await ensureUserRegistered(ctx);
      await showUserProfileCard(ctx);
      return;
    }

    if (text === "🛠 管理控制台") {
      await openAdminConsole(ctx, false);
      return;
    }

    const normalized = normalizeBnetQuery(text);
    if (isValidBnetTag(normalized)) {
      await ensureUserRegistered(ctx);
      await executeCnOverviewQuery(ctx, normalized);
    }
  } catch (err: any) {
    await replyQuoteUser(
      ctx,
      `❌ <b>操作失败</b>：${escapeHtml(err?.message || "处理失败，请稍后重试")}`
    );
  }
});

// ============================================================================
// 13. Vercel Serverless Webhook 入口导出
// ============================================================================

const handleTelegramUpdate = webhookCallback(bot, "http", {
  secretToken: WEBHOOK_SECRET || undefined,
});

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!runtimeBotUsername && BOT_TOKEN) {
    try {
      const me = await bot.api.getMe();
      if (me?.username) {
        runtimeBotUsername = me.username;
      }
    } catch {
      // 忽略 getMe 失败
    }
  }

  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "ow2-cn-tg-bot",
        botUsername: runtimeBotUsername || ENV_BOT_USERNAME || null,
      })
    );
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    return;
  }

  await handleTelegramUpdate(req, res);
}
