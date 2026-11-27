/**
 * 《守望先锋 2》(OW2) 国服战绩查询 Telegram 机器人（完整独立部署版）
 * 代码生成时间：2026-11-27 23:34:00 (Asia/Shanghai)
 * 运行环境：Vercel Serverless Functions (Node.js 20+ / TypeScript)
 * 项目地址：https://github.com/AddOneSecondL/Overstats 开源的
 * 机器人框架：grammY (Webhook 模式)
 * 数据来源：服务器反代 (https://ow.eyy8.top -> datamsapi.ds.163.com/v1/a19ld5tool)
 *         + 腾讯云/Docker 业务中转与异步队列 (/internal/*)
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
const VERCEL_PUBLIC_ORIGIN = (
  process.env.VERCEL_PUBLIC_ORIGIN ||
  (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://owcntg.vercel.app")
).replace(/\/+$/, "");

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

const DEFAULT_REGISTER_QUOTA = 3;
const CHECKIN_REWARD_QUOTA = 1;
const INVITE_REWARD_QUOTA = 1;

const userLastMode = new Map<number, CnGameMode>();
const userLastBnet = new Map<number, string>();
const userRecentMatchIds = new Map<number, string[]>();
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
  | { type: "super_admin_remark"; targetTgId: number }
  | { type: "super_setting_reg_quota" }
  | { type: "super_setting_inv_quota" }
  | { type: "super_setting_chk_quota" }
  | { type: "super_ai_provider_add" }
  | { type: "super_dashen_account_add" }
  | { type: "super_dashen_account_edit"; accountId: number };

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
// 2. 英雄 / 地图 / 段位 / 指标 映射表
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
  温斯顿: ["winston", "温斯顿", "猩猩", "星星", "老詹", "牢詹", "猴子", "詹姆斯"],
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
  "576460752303427799": "英雄精通：雾子",
  "0x08000000000010d7": "英雄精通：雾子",
  "576460752303427844": "哥德堡",
  "0x0800000000001104": "哥德堡",
  "576460752303427865": "英雄精通：D.Va",
  "0x0800000000001119": "英雄精通：D.Va",
  "576460752303427880": "寺院",
  "0x0800000000001128": "寺院",
  "576460752303427927": "花冈",
  "0x0800000000001157": "花冈",
  "576460752303427936": "阿努比斯王座",
  "0x0800000000001160": "阿努比斯王座",
  "576460752303427970": "英雄精通：布丽吉塔",
  "0x0800000000001182": "英雄精通：布丽吉塔",
  "576460752303427992": "英雄精通：艾什",
  "0x0800000000001198": "英雄精通：艾什",
  "576460752303428097": "英雄精通：卡西迪",
  "0x0800000000001201": "英雄精通：卡西迪",
  "576460752303428110": "监测站：直布罗陀",
  "0x080000000000120e": "监测站：直布罗陀",
  "576460752303428170": "黑森林",
  "0x080000000000124a": "黑森林",
  "576460752303428233": "阿努比斯王座",
  "0x0800000000001289": "阿努比斯王座",
  "576460752303428286": "阿德勒斯布鲁恩",
  "0x08000000000012be": "阿德勒斯布鲁恩",
  "576460752303428299": "巴黎",
  "0x08000000000012cb": "巴黎",
  "576460752303428186": "高架车站",
  "0x080000000000125a": "高架车站",
  "576460752303428190": "拉克瓦广场",
  "0x080000000000125e": "拉克瓦广场",
  "576460752303428192": "红杉水坝",
  "0x0800000000001260": "红杉水坝",
  "576460752303428219": "伊利奥斯 - 废墟",
  "0x080000000000127b": "伊利奥斯 - 废墟",
  "576460752303428266": "维多利亚竞技场",
  "0x08000000000012aa": "维多利亚竞技场",
  "576460752303428277": "阿努比斯王座",
  "0x08000000000012b5": "阿努比斯王座",
  "576460752303428278": "花冈",
  "0x08000000000012b6": "花冈",
  "576460752303428279": "斗兽场",
  "0x08000000000012b7": "斗兽场",
  "576460752303428337": "尼泊尔 - 圣坛",
  "0x08000000000012f1": "尼泊尔 - 圣坛",
  "576460752303428397": "哈瓦那",
  "0x080000000000132d": "哈瓦那",
  "576460752303427628": "霓虹枢纽",
  "0x080000000000102c": "霓虹枢纽",
  "576460752303427381": "阿特利斯",
  "0x0800000000000f35": "阿特利斯",
  "576460752303428538": "国服新/未收录地图(576460752303428538)",
};

const DASHEN_STAT_GUID_NAMES: Record<string, string> = {
  "603482350067646495": "消灭",
  "603482350067646497": "累计游戏时间",
  "603482350067646506": "阵亡",
  "603482350067646507": "最后一击",
  "603482350067646509": "单独消灭",
  "603482350067646511": "武器命中率",
  "603482350067646513": "射击命中",
  "603482350067646913": "治疗量",
  "603482350067647458": "暴击命中率",
  "603482350067647462": "自我治疗量",
  "603482350067647479": "治疗量",
  "603482350067647492": "拯救玩家",
  "603482350067647626": "强化伤害",
  "603482350067647671": "对英雄伤害量",
  "603482350067648392": "助攻",
  "603482350067648623": "英雄获胜",
};

const DASHEN_RANK_NAME_CN: Record<string, string> = {
  bronze: "青铜",
  silver: "白银",
  gold: "黄金",
  platinum: "白金",
  platium: "白金",
  emerald: "翡翠",
  diamond: "钻石",
  master: "大师",
  grandmaster: "宗师",
  gm: "宗师",
  champion: "英杰",
};

const PERMISSION_LABELS_FALLBACK: Record<string, string> = {
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

function translateRankName(rawRank: unknown): string {
  if (rawRank === undefined || rawRank === null) return "";
  const str = String(rawRank).trim();
  if (!str) return "";
  const lower = str.toLowerCase();
  if (["none", "null", "undefined", "unranked", "无", "未知"].includes(lower)) {
    return "";
  }
  return DASHEN_RANK_NAME_CN[lower] || str;
}

function resolveDashenHeroName(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  const str = String(raw).trim();
  if (!str) return "";
  const lower = str.toLowerCase();
  if (HERO_ALIAS_TO_CN[lower]) return HERO_ALIAS_TO_CN[lower];
  if (DASHEN_HERO_GUID_NAMES[lower]) return DASHEN_HERO_GUID_NAMES[lower];
  return str;
}

function translateModeCode(modeVal: unknown): string {
  if (!modeVal) return "";
  const s = String(modeVal).trim();
  const map: Record<string, string> = {
    sportpreset: "竞技预设",
    sport: "竞技预设",
    leisurepreset: "快速预设",
    leisure: "快速预设",
    sportopen: "竞技自由",
    leisureopen: "快速自由",
    sportfight: "决斗领域",
    leisurefight: "休闲决斗领域",
  };
  return map[s.toLowerCase()] || s;
}

function resolveDashenMapGuid(rawGuid: unknown): string {
  if (rawGuid === undefined || rawGuid === null) return "";
  const str = String(rawGuid).trim();
  if (!str) return "";
  const lower = str.toLowerCase();
  if (DASHEN_MAP_NAMES[lower]) return DASHEN_MAP_NAMES[lower];
  return `地图#${str}`;
}

function resolveDashenHeroGuid(rawGuid: unknown): string {
  if (rawGuid === undefined || rawGuid === null) return "";
  const str = String(rawGuid).trim();
  if (!str) return "";
  const lower = str.toLowerCase();
  if (HERO_ALIAS_TO_CN[lower]) return HERO_ALIAS_TO_CN[lower];
  if (DASHEN_HERO_GUID_NAMES[lower]) return DASHEN_HERO_GUID_NAMES[lower];
  return `英雄#${str}`;
}

// ============================================================================
// 3. 网易大神与服务器内部业务 HTTP 客户端
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

class RelayServiceError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "RELAY_ERROR"
  ) {
    super(message);
    this.name = "RelayServiceError";
  }
}

function ensureDashenCredentials(): void {
  if (!DASHEN_ROLE_ID || !DASHEN_TOKEN) {
    throw new DashenError(
      500,
      "⚠️ 服务端尚未配置网易大神凭证，且数据库轮询池中暂无可用账号。请先在超管后台「🔑 大神账号轮询」中添加账号，或在 Vercel 环境变量中配置 <code>DASHEN_ROLE_ID</code> / <code>DASHEN_TOKEN</code>。"
    );
  }
}

function getEnvFallbackCredential(): DashenRequestCredential | null {
  if (!DASHEN_ROLE_ID || !DASHEN_TOKEN) return null;
  return {
    name: "环境变量默认账号",
    roleId: DASHEN_ROLE_ID,
    authToken: DASHEN_TOKEN,
    dts: DASHEN_DTS,
    server: DASHEN_SERVER,
    clientType: DASHEN_CLIENT_TYPE,
    origin: DASHEN_ORIGIN,
    referer: DASHEN_REFERER,
    userAgent: DASHEN_USER_AGENT,
  };
}

async function fetchRotatedDashenCandidates(): Promise<DashenRequestCredential[]> {
  const poolList: DashenRequestCredential[] = [];
  try {
    const res = await relayInternalRequest<{
      ok: boolean;
      data?: { accounts?: DashenPoolAccountDto[] };
    }>("GET", "/internal/dashen/accounts/next");
    const items = Array.isArray(res?.data?.accounts) ? res.data.accounts : [];
    for (const acc of items) {
      if (acc && acc.isEnabled && acc.roleId && acc.authToken) {
        poolList.push({
          accountId: Number(acc.id),
          name: String(acc.name || `账号#${acc.id}`),
          roleId: Number(acc.roleId),
          authToken: String(acc.authToken).trim(),
          dts: Number(acc.dts || DASHEN_DTS || 2026),
          server: Number(acc.server || DASHEN_SERVER || 1),
          clientType: String(acc.clientType || DASHEN_CLIENT_TYPE || "60"),
          origin: String(acc.origin || DASHEN_ORIGIN || "https://act.ds.163.com"),
          referer: String(acc.referer || DASHEN_REFERER || "https://act.ds.163.com/"),
          userAgent: String(acc.userAgent || DASHEN_USER_AGENT),
        });
      }
    }
  } catch (err) {
    console.warn("[Fetch Rotated Dashen Pool Fallback]", err);
  }

  const envCred = getEnvFallbackCredential();
  if (poolList.length > 0) {
    if (
      envCred &&
      !poolList.some(
        (p) => p.roleId === envCred.roleId && p.authToken === envCred.authToken
      )
    ) {
      poolList.push(envCred);
    }
    return poolList;
  }

  if (envCred) return [envCred];
  ensureDashenCredentials();
  return [];
}

async function reportDashenPoolAccount(
  accountId: number | undefined,
  ok: boolean,
  errorMsg = ""
): Promise<void> {
  if (!accountId || accountId <= 0) return;
  try {
    await relayInternalRequest("POST", "/internal/dashen/accounts/report", {
      json: { id: accountId, ok, error: errorMsg },
    });
  } catch {
    // 忽略上报网络异常
  }
}

function parseRawDashenHeadersInput(
  rawInput: string,
  fallbackName?: string
): {
  ok: boolean;
  error?: string;
  parsed?: {
    name: string;
    roleId: number;
    authToken: string;
    dts: number;
    server: number;
    clientType: string;
    origin: string;
    referer: string;
    userAgent: string;
  };
} {
  const rawText = String(rawInput || "").trim();
  if (!rawText) {
    return { ok: false, error: "输入内容为空，请粘贴抓包请求头文本。" };
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const headerMap = new Map<string, string>();
  let customName = String(fallbackName || "").trim();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const remarkMatch = line.match(/^(?:备注|名称|账号名|name)\s*[:：]\s*(.+)$/i);
    if (remarkMatch && !customName) {
      customName = remarkMatch[1].trim().slice(0, 64);
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const val = line.slice(colonIdx + 1).trim();
      if (key === "cookie") {
        // 明确不提取与存储 Cookie
        continue;
      }
      headerMap.set(key, val);
    } else if (i === 0 && !customName && lines.length > 1 && line.length <= 40) {
      customName = line.slice(0, 64);
    }
  }

  const authToken = (
    headerMap.get("gl-bigdata-auth-token") ||
    headerMap.get("auth-token") ||
    headerMap.get("token") ||
    ""
  ).trim();

  const roleIdRaw = (
    headerMap.get("gl-bigdata-role-id") ||
    headerMap.get("role-id") ||
    headerMap.get("roleid") ||
    ""
  ).trim();
  const roleId = Number(roleIdRaw);

  if (!authToken) {
    return {
      ok: false,
      error: "未能从请求头中提取到 <code>GL-Bigdata-Auth-Token</code>。",
    };
  }
  if (!Number.isSafeInteger(roleId) || roleId <= 0) {
    return {
      ok: false,
      error: "未能从请求头中提取到有效的正整数 <code>GL-Bigdata-Role-Id</code>。",
    };
  }

  const dtsNum = Number(headerMap.get("gl-bigdata-dts") || "2026");
  const serverNum = Number(headerMap.get("gl-bigdata-server") || "1");
  const clientType = (headerMap.get("gl-clienttype") || "60").trim() || "60";
  const origin =
    (headerMap.get("origin") || "https://act.ds.163.com").trim() ||
    "https://act.ds.163.com";
  const referer =
    (headerMap.get("referer") || "https://act.ds.163.com/").trim() ||
    "https://act.ds.163.com/";
  const userAgent = (
    headerMap.get("user-agent") || DASHEN_USER_AGENT
  ).trim();

  const finalName = (customName || `大神账号-${roleId}`).slice(0, 64);

  return {
    ok: true,
    parsed: {
      name: finalName,
      roleId,
      authToken,
      dts: Number.isInteger(dtsNum) && dtsNum > 0 ? dtsNum : 2026,
      server: Number.isInteger(serverNum) && serverNum > 0 ? serverNum : 1,
      clientType,
      origin,
      referer,
      userAgent,
    },
  };
}

function buildAuthHeadersWithCredential(
  cred: DashenRequestCredential,
  operatorId?: number
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "GL-Bigdata-Auth-Token": cred.authToken,
    "GL-Bigdata-Dts": String(cred.dts),
    "GL-Bigdata-Role-Id": String(cred.roleId),
    "GL-Bigdata-Server": String(cred.server),
    "GL-ClientType": cred.clientType,
    Origin: cred.origin,
    Referer: cred.referer,
    "User-Agent": cred.userAgent || DASHEN_USER_AGENT,
  };
  if (RELAY_SECRET) {
    headers["x-relay-secret"] = RELAY_SECRET;
  }
  if (operatorId && operatorId > 0) {
    headers["x-operator-id"] = String(operatorId);
  }
  return headers;
}

function buildAuthHeaders(operatorId?: number): Record<string, string> {
  return buildAuthHeadersWithCredential(
    {
      roleId: DASHEN_ROLE_ID,
      authToken: DASHEN_TOKEN,
      dts: DASHEN_DTS,
      server: DASHEN_SERVER,
      clientType: DASHEN_CLIENT_TYPE,
      origin: DASHEN_ORIGIN,
      referer: DASHEN_REFERER,
      userAgent: DASHEN_USER_AGENT,
    },
    operatorId
  );
}

async function dashenRequestWithCredential<T = any>(
  cred: DashenRequestCredential,
  method: "GET" | "POST",
  urlStr: string,
  options?: {
    params?: Record<string, string | number | undefined>;
    json?: Record<string, any>;
  }
): Promise<DashenResponse<T>> {
  const url = new URL(urlStr);
  if (options?.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers = buildAuthHeadersWithCredential(cred);
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
        ? "⏳ 请求网易大神接口超时，请稍后重试。"
        : "🌐 网络异常，无法连接至网易大神接口。"
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new DashenError(
      response.status,
      "🔐 网易大神鉴权失败（HTTP 401/403），可能是账号 Token 已失效或触发风控。"
    );
  }

  const rawText = await response.text().catch(() => "");
  let payload: DashenResponse<T>;
  try {
    payload = JSON.parse(rawText) as DashenResponse<T>;
  } catch {
    throw new DashenError(
      response.status,
      `❌ 网易大神返回非 JSON 内容 (HTTP ${response.status})。`
    );
  }

  if (!response.ok) {
    const reason = payload?.msg || payload?.message || `HTTP ${response.status}`;
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

async function dashenRequest<T = any>(
  method: "GET" | "POST",
  urlStr: string,
  options?: {
    params?: Record<string, string | number | undefined>;
    json?: Record<string, any>;
  }
): Promise<DashenResponse<T>> {
  ensureDashenCredentials();
  return dashenRequestWithCredential<T>(
    {
      roleId: DASHEN_ROLE_ID,
      authToken: DASHEN_TOKEN,
      dts: DASHEN_DTS,
      server: DASHEN_SERVER,
      clientType: DASHEN_CLIENT_TYPE,
      origin: DASHEN_ORIGIN,
      referer: DASHEN_REFERER,
      userAgent: DASHEN_USER_AGENT,
    },
    method,
    urlStr,
    options
  );
}

async function searchBnetAccount(bnet: string): Promise<DashenResponse> {
  const normalized = bnet.replace("＃", "#").trim();
  const candidates = await fetchRotatedDashenCandidates();

  const runSearchOnce = async (
    cred: DashenRequestCredential
  ): Promise<DashenResponse> => {
    if (SEARCH_BNET_METHOD === "GET") {
      return dashenRequestWithCredential(cred, "GET", SEARCH_BNET_ACCOUNT_URL, {
        params: {
          token: cred.authToken,
          roleId: cred.roleId,
          dts: cred.dts,
          server: cred.server,
          [SEARCH_BNET_PARAM_KEY]: normalized,
        },
      });
    }
    return dashenRequestWithCredential(cred, "POST", SEARCH_BNET_ACCOUNT_URL, {
      json: {
        token: cred.authToken,
        roleId: cred.roleId,
        dts: cred.dts,
        server: cred.server,
        [SEARCH_BNET_PARAM_KEY]: normalized,
      },
    });
  };

  const hasCustomerToken = (res: DashenResponse | null | undefined): boolean => {
    try {
      const p = extractPlayerFromSearch(normalized, res as DashenResponse);
      return Boolean(p.customerToken);
    } catch {
      return false;
    }
  };

  let lastRes: DashenResponse | null = null;
  let lastErr: unknown = null;

  for (let i = 0; i < candidates.length; i++) {
    const cred = candidates[i];
    try {
      const res = await runSearchOnce(cred);
      lastRes = res;
      if (hasCustomerToken(res)) {
        void reportDashenPoolAccount(cred.accountId, true);
        return res;
      }
      void reportDashenPoolAccount(cred.accountId, false, "搜索返回无 customerToken");
    } catch (err) {
      lastErr = err;
      void reportDashenPoolAccount(
        cred.accountId,
        false,
        err instanceof Error ? err.message : String(err)
      );
      if (i === candidates.length - 1 && !lastRes) {
        throw err;
      }
    }
  }

  if (lastRes) return lastRes;
  if (lastErr) throw lastErr;
  return runSearchOnce({
    roleId: DASHEN_ROLE_ID,
    authToken: DASHEN_TOKEN,
    dts: DASHEN_DTS,
    server: DASHEN_SERVER,
    clientType: DASHEN_CLIENT_TYPE,
    origin: DASHEN_ORIGIN,
    referer: DASHEN_REFERER,
    userAgent: DASHEN_USER_AGENT,
  });
}

async function queryCustomerCard(
  customerToken: string,
  gameMode: CnGameMode
): Promise<DashenResponse> {
  const candidates = await fetchRotatedDashenCandidates();
  let lastErr: unknown = null;

  for (let i = 0; i < candidates.length; i++) {
    const cred = candidates[i];
    try {
      const res = await dashenRequestWithCredential(
        cred,
        "POST",
        `${DASHEN_CUSTOMER_API_BASE}/queryCard`,
        {
          json: {
            token: cred.authToken,
            roleId: cred.roleId,
            dts: cred.dts,
            server: cred.server,
            customerToken,
            gameMode,
          },
        }
      );
      if (res && (res.data || res.result)) {
        void reportDashenPoolAccount(cred.accountId, true);
        return res;
      }
      if (i === candidates.length - 1) return res;
    } catch (err) {
      lastErr = err;
      void reportDashenPoolAccount(
        cred.accountId,
        false,
        err instanceof Error ? err.message : String(err)
      );
      if (i === candidates.length - 1) throw err;
    }
  }
  if (lastErr) throw lastErr;
  return dashenRequest("POST", `${DASHEN_CUSTOMER_API_BASE}/queryCard`, {
    json: {
      token: DASHEN_TOKEN,
      roleId: DASHEN_ROLE_ID,
      dts: DASHEN_DTS,
      server: DASHEN_SERVER,
      customerToken,
      gameMode,
    },
  });
}

async function queryCustomerCountInfo(
  customerToken: string,
  gameMode: CnGameMode
): Promise<DashenResponse> {
  const candidates = await fetchRotatedDashenCandidates();
  let lastErr: unknown = null;

  for (let i = 0; i < candidates.length; i++) {
    const cred = candidates[i];
    try {
      const res = await dashenRequestWithCredential(
        cred,
        "POST",
        `${DASHEN_CUSTOMER_API_BASE}/queryCountInfo`,
        {
          json: {
            token: cred.authToken,
            roleId: cred.roleId,
            dts: cred.dts,
            server: cred.server,
            customerToken,
            gameMode,
          },
        }
      );
      if (res && (res.data || res.result)) {
        void reportDashenPoolAccount(cred.accountId, true);
        return res;
      }
      if (i === candidates.length - 1) return res;
    } catch (err) {
      lastErr = err;
      void reportDashenPoolAccount(
        cred.accountId,
        false,
        err instanceof Error ? err.message : String(err)
      );
      if (i === candidates.length - 1) throw err;
    }
  }
  if (lastErr) throw lastErr;
  return dashenRequest("POST", `${DASHEN_CUSTOMER_API_BASE}/queryCountInfo`, {
    json: {
      token: DASHEN_TOKEN,
      roleId: DASHEN_ROLE_ID,
      dts: DASHEN_DTS,
      server: DASHEN_SERVER,
      customerToken,
      gameMode,
    },
  });
}

async function queryCustomerMatchList(
  customerToken: string,
  gameMode: CnGameMode,
  page = 1,
  pageSize = 8
): Promise<DashenResponse> {
  const candidates = await fetchRotatedDashenCandidates();
  let lastErr: unknown = null;

  for (let i = 0; i < candidates.length; i++) {
    const cred = candidates[i];
    try {
      const res = await dashenRequestWithCredential(
        cred,
        "POST",
        `${DASHEN_CUSTOMER_API_BASE}/queryMatchList`,
        {
          json: {
            token: cred.authToken,
            roleId: cred.roleId,
            dts: cred.dts,
            server: cred.server,
            customerToken,
            gameMode,
            page,
            pageSize,
          },
        }
      );
      if (res && (res.data || res.result)) {
        void reportDashenPoolAccount(cred.accountId, true);
        return res;
      }
      if (i === candidates.length - 1) return res;
    } catch (err) {
      lastErr = err;
      void reportDashenPoolAccount(
        cred.accountId,
        false,
        err instanceof Error ? err.message : String(err)
      );
      if (i === candidates.length - 1) throw err;
    }
  }
  if (lastErr) throw lastErr;
  return dashenRequest("POST", `${DASHEN_CUSTOMER_API_BASE}/queryMatchList`, {
    json: {
      token: DASHEN_TOKEN,
      roleId: DASHEN_ROLE_ID,
      dts: DASHEN_DTS,
      server: DASHEN_SERVER,
      customerToken,
      gameMode,
      page,
      pageSize,
    },
  });
}

async function queryCustomerMatchInfo(
  customerToken: string,
  matchId: string
): Promise<DashenResponse> {
  const candidates = await fetchRotatedDashenCandidates();
  let lastErr: unknown = null;

  for (let i = 0; i < candidates.length; i++) {
    const cred = candidates[i];
    try {
      const res = await dashenRequestWithCredential(
        cred,
        "POST",
        `${DASHEN_CUSTOMER_API_BASE}/queryMatchInfo`,
        {
          json: {
            token: cred.authToken,
            roleId: cred.roleId,
            dts: cred.dts,
            server: cred.server,
            customerToken,
            matchId,
          },
        }
      );
      if (res && (res.data || res.result)) {
        void reportDashenPoolAccount(cred.accountId, true);
        return res;
      }
      if (i === candidates.length - 1) return res;
    } catch (err) {
      lastErr = err;
      void reportDashenPoolAccount(
        cred.accountId,
        false,
        err instanceof Error ? err.message : String(err)
      );
      if (i === candidates.length - 1) throw err;
    }
  }
  if (lastErr) throw lastErr;
  return dashenRequest("POST", `${DASHEN_CUSTOMER_API_BASE}/queryMatchInfo`, {
    json: {
      token: DASHEN_TOKEN,
      roleId: DASHEN_ROLE_ID,
      dts: DASHEN_DTS,
      server: DASHEN_SERVER,
      customerToken,
      matchId,
    },
  });
}

async function relayInternalRequest<T = any>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  options?: {
    params?: Record<string, string | number | undefined>;
    json?: Record<string, any>;
    operatorId?: number;
  }
): Promise<T> {
  const url = new URL(path, DASHEN_RELAY_ORIGIN);
  if (options?.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== "") {
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
  if (options?.operatorId && options.operatorId > 0) {
    headers["x-operator-id"] = String(options.operatorId);
  }

  let body: string | undefined;
  if (method === "POST" && options?.json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    throw new RelayServiceError(
      504,
      isTimeout
        ? "⏳ 业务中转服务响应超时，请稍后再试。"
        : "🌐 无法连接至业务中转服务，请检查服务状态。"
    );
  }

  const rawText = await res.text().catch(() => "");
  let payload: any = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new RelayServiceError(
      res.status,
      `❌ 业务中转服务返回非 JSON 响应 (HTTP ${res.status})`
    );
  }

  if (!res.ok || payload?.ok === false) {
    const msg =
      payload?.error ||
      payload?.message ||
      `业务服务请求失败 (HTTP ${res.status})`;
    throw new RelayServiceError(
      res.status,
      msg,
      payload?.code || "RELAY_ERROR"
    );
  }

  return payload as T;
}

// ============================================================================
// 4. 格式化、HTML 转义、时间处理与数据解析工具
// ============================================================================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0分";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs}小时${mins}分`;
  return `${Math.max(1, mins)}分`;
}

function formatMatchTimestamp(ts: unknown): string {
  if (!ts) return "时间未知";
  const num = Number(ts);
  if (!Number.isFinite(num) || num <= 0) return String(ts);
  const ms = num < 1e12 ? num * 1000 : num;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ts);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function formatNumber(n: unknown): string {
  const num = Number(n);
  if (!Number.isFinite(num)) return "0";
  return Math.round(num).toLocaleString("en-US");
}

function formatWinRate(val: unknown): string {
  if (val === undefined || val === null || val === "") return "0.0%";
  const num = Number(String(val).replace("%", ""));
  if (!Number.isFinite(num)) return String(val);
  const pct = num > 0 && num <= 1 ? num * 100 : num;
  return `${pct.toFixed(1)}%`;
}

function extractPlayerFromSearch(
  queryBnet: string,
  res: DashenResponse
): {
  bnet: string;
  customerToken: string;
  rawSummary: string;
} {
  const body = res?.data ?? res?.result ?? res;
  const candidates: any[] = [];
  if (Array.isArray(body)) {
    candidates.push(...body);
  } else if (body && typeof body === "object") {
    if (Array.isArray(body.list)) candidates.push(...body.list);
    if (Array.isArray(body.records)) candidates.push(...body.records);
    if (Array.isArray(body.items)) candidates.push(...body.items);
    if (Array.isArray(body.accounts)) candidates.push(...body.accounts);
    if (Array.isArray(body.players)) candidates.push(...body.players);
    candidates.push(body);
  }

  let matchedToken = "";
  let matchedName = queryBnet;

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const token =
      item.customerToken ||
      item.customer_token ||
      item.targetToken ||
      item.target_token ||
      item.token ||
      item.playerToken ||
      item.battleTagToken ||
      item.roleToken ||
      "";
    const name =
      item.name ||
      item.bnetId ||
      item.bnet_id ||
      item.battleTag ||
      item.battle_tag ||
      item.nickName ||
      item.nickname ||
      "";
    if (token) {
      matchedToken = String(token);
      if (name) matchedName = String(name);
      break;
    }
  }

  if (!matchedToken) {
    throw new DashenError(
      404,
      `未找到国服战网账号 <code>${escapeHtml(queryBnet)}</code>（可能未绑定网易大神或搜索接口正在官方维护中，请稍后再试）。`
    );
  }

  return {
    bnet: matchedName,
    customerToken: matchedToken,
    rawSummary: JSON.stringify(body).slice(0, 600),
  };
}

// ============================================================================
// 5. 战绩总览 / 战绩流水 / 对局详情 构建器
// ============================================================================

function formatRankSegment(entry: any): string {
  if (!entry || typeof entry !== "object") return "";
  const tierRaw =
    entry.rankName ||
    entry.rank_name ||
    entry.tierName ||
    entry.tier_name ||
    entry.rank ||
    entry.tier ||
    entry.grade ||
    entry.divisionName ||
    "";
  const tier = translateRankName(tierRaw);
  const subTier =
    entry.subRank ||
    entry.sub_rank ||
    entry.rankLevel ||
    entry.rank_level ||
    entry.star ||
    entry.division ||
    "";
  const score =
    entry.score ?? entry.point ?? entry.points ?? entry.mmr ?? entry.rating;

  const parts: string[] = [];
  if (tier) {
    parts.push(subTier && String(subTier) !== "0" ? `${tier}${subTier}` : tier);
  }
  if (score !== undefined && score !== null && String(score) !== "") {
    parts.push(`${score}分`);
  }
  return parts.join(" ");
}

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
    .text("🤖 AI 锐评战绩", `cn:r:self:${mode}:${bnet}`)
    .text("🔮 AI 隐性段位评估", `cn:r:mmr:${mode}:${bnet}`);

  if (isAdmin) {
    kb.row().text("🛠 管理控制台", "u:open_admin");
  }
  return kb;
}

function buildCnMatchDetailKeyboard(
  bnet: string,
  matchId: string
): InlineKeyboard {
  return new InlineKeyboard()
    .text("🤖 AI 锐评本局", `cn:r:match:${matchId}:${bnet}`)
    .text("🔙 返回战绩总览", `cn:sw:sport:${bnet}`);
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
}> {
  const searchRes = await searchBnetAccount(bnet);
  const player = extractPlayerFromSearch(bnet, searchRes);

  const [cardRes, countRes] = await Promise.all([
    queryCustomerCard(player.customerToken, mode).catch(() => null),
    queryCustomerCountInfo(player.customerToken, mode).catch(() => null),
  ]);

  const cardData = cardRes?.data ?? cardRes?.result ?? {};
  const countData = countRes?.data ?? countRes?.result ?? {};

  const modeLabel = mode === "sport" ? "竞技比赛" : "快速/休闲";
  const seasonText =
    cardData.seasonName ||
    cardData.season_name ||
    cardData.season ||
    countData.seasonName ||
    "当前赛季";

  const rankLines: string[] = [];
  const roleRankList =
    cardData.roleRankList ||
    cardData.role_rank_list ||
    cardData.ranks ||
    cardData.rankList ||
    [];
  if (Array.isArray(roleRankList) && roleRankList.length > 0) {
    for (const item of roleRankList) {
      const roleRaw = String(
        item.role || item.roleName || item.role_name || item.duty || ""
      ).toLowerCase();
      let roleCn = "综合";
      if (roleRaw.includes("tank") || roleRaw.includes("重装") || roleRaw.includes("坦克")) {
        roleCn = "重装";
      } else if (
        roleRaw.includes("dps") ||
        roleRaw.includes("damage") ||
        roleRaw.includes("输出") ||
        roleRaw.includes("伤害")
      ) {
        roleCn = "输出";
      } else if (
        roleRaw.includes("support") ||
        roleRaw.includes("healer") ||
        roleRaw.includes("支援") ||
        roleRaw.includes("治疗")
      ) {
        roleCn = "支援";
      }
      const seg = formatRankSegment(item);
      if (seg) {
        rankLines.push(`• ${roleCn}：<b>${escapeHtml(seg)}</b>`);
      }
    }
  }

  const currentRankLabel =
    rankLines.length > 0
      ? rankLines.map((l) => l.replace(/<[^>]+>/g, "")).join(" | ")
      : "暂无公开段位";

  const summaryObj =
    countData.summary ||
    countData.careerSummary ||
    countData.statSummary ||
    cardData.summary ||
    countData ||
    {};

  const wins = Number(
    summaryObj.winCount ??
      summaryObj.wins ??
      summaryObj.win ??
      cardData.winCount ??
      cardData.wins ??
      0
  );
  const losses = Number(
    summaryObj.loseCount ??
      summaryObj.losses ??
      summaryObj.loss ??
      cardData.loseCount ??
      cardData.losses ??
      0
  );
  const draws = Number(
    summaryObj.drawCount ?? summaryObj.draws ?? summaryObj.draw ?? 0
  );
  const totalGames = Number(
    summaryObj.matchCount ??
      summaryObj.games ??
      summaryObj.totalGames ??
      wins + losses + draws
  );
  const winRateRaw =
    summaryObj.winRate ??
    summaryObj.win_rate ??
    cardData.winRate ??
    cardData.win_rate ??
    (totalGames > 0 ? (wins / totalGames) * 100 : 0);

  const heroListRaw =
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
        const ta = Number(a.playTime ?? a.timePlayed ?? a.gameTime ?? a.duration ?? a.matchCount ?? 0);
        const tb = Number(b.playTime ?? b.timePlayed ?? b.gameTime ?? b.duration ?? b.matchCount ?? 0);
        return tb - ta;
      })
      .slice(0, 5);

    for (const h of sortedHeroes) {
      const hName = resolveDashenHeroName(
        h.heroName || h.hero_name || h.name || h.heroGuid || h.hero_guid || h.heroId
      );
      if (!hName) continue;
      const secs = Number(
        h.playTime ?? h.timePlayed ?? h.gameTime ?? h.duration ?? 0
      );
      const hWinRate = formatWinRate(
        h.winRate ?? h.win_rate ?? (h.winCount && h.matchCount ? (Number(h.winCount) / Number(h.matchCount)) * 100 : 0)
      );
      heroLines.push(
        `• <b>${escapeHtml(hName)}</b>：${secs > 0 ? `${formatDuration(secs)} · ` : ""}胜率 <b>${escapeHtml(hWinRate)}</b>`
      );
    }
  }

  const lines: string[] = [
    `🇨🇳 <b>国服战绩总览 — ${escapeHtml(player.bnet)}</b>`,
    `🎮 模式：<b>${escapeHtml(modeLabel)}</b>  |  🗓 ${escapeHtml(String(seasonText))}`,
    `━━━━━━━━━━━━━━━━━━`,
  ];

  if (rankLines.length > 0) {
    lines.push(`🏅 <b>当前职责段位</b>`);
    lines.push(...rankLines);
    lines.push(`━━━━━━━━━━━━━━━━━━`);
  }

  lines.push(
    `📊 <b>对局统计</b>`,
    `• 总场次：<b>${totalGames}</b> 场（胜 <b>${wins}</b> / 负 <b>${losses}</b>${draws > 0 ? ` / 平 <b>${draws}</b>` : ""}）`,
    `• 胜率：<b>${escapeHtml(formatWinRate(winRateRaw))}</b>`
  );

  if (heroLines.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━`, `🦸 <b>常用英雄 TOP5</b>`, ...heroLines);
  }

  const text = lines.join("\n");
  const snapshotText = [
    `战网ID: ${player.bnet}`,
    `模式: ${modeLabel}`,
    `赛季: ${seasonText}`,
    `段位: ${currentRankLabel}`,
    `胜负: ${wins}胜 ${losses}负 ${draws}平 (总${totalGames}场, 胜率${formatWinRate(winRateRaw)})`,
    heroLines.length > 0
      ? `常用英雄:\n${heroLines.map((l) => l.replace(/<[^>]+>/g, "")).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    text,
    keyboard: buildCnOverviewKeyboard(player.bnet, mode, isAdmin),
    snapshotText,
    currentRankLabel,
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
}> {
  const searchRes = await searchBnetAccount(bnet);
  const player = extractPlayerFromSearch(bnet, searchRes);

  const pageSize = 6;
  const listRes = await queryCustomerMatchList(
    player.customerToken,
    mode,
    page,
    pageSize
  );
  const body = listRes?.data ?? listRes?.result ?? {};
  const rawList = Array.isArray(body)
    ? body
    : body.list || body.records || body.matches || body.matchList || body.items || [];

  const modeLabel = mode === "sport" ? "竞技比赛" : "快速/休闲";
  const lines: string[] = [
    `📋 <b>近期战绩流水 — ${escapeHtml(player.bnet)}</b>`,
    `🎮 模式：<b>${escapeHtml(modeLabel)}</b>  |  第 <b>${page}</b> 页`,
    `━━━━━━━━━━━━━━━━━━`,
  ];

  const matchIds: string[] = [];
  const kb = new InlineKeyboard();

  if (!Array.isArray(rawList) || rawList.length === 0) {
    lines.push(`📭 当前页暂无对局记录。`);
  } else {
    rawList.forEach((m: any, idx: number) => {
      const mId = String(
        m.matchId || m.match_id || m.gameId || m.id || ""
      ).trim();
      if (mId) matchIds.push(mId);

      const retVal = Number(m.matchRet ?? m.result ?? m.win ?? -1);
      const retIcon =
        retVal === 1 ? "🟢胜" : retVal === 0 ? "🔴负" : retVal === 2 ? "⚪平" : "⚪完";
      const mapName =
        m.mapName ||
        m.map_name ||
        resolveDashenMapGuid(m.mapGuid || m.map_guid || m.mapId);
      const heroName = resolveDashenHeroName(
        m.heroName || m.hero_name || m.heroGuid || m.hero_guid || m.heroId
      );
      const k = Number(m.kill ?? m.kills ?? m.eliminations ?? 0);
      const a = Number(m.assist ?? m.assists ?? 0);
      const d = Number(m.death ?? m.deaths ?? 0);
      const timeStr = formatMatchTimestamp(
        m.beginTs || m.begin_ts || m.startTime || m.timestamp || m.time
      );

      lines.push(
        `${idx + 1}. ${retIcon} <b>${escapeHtml(mapName || "未知地图")}</b>` +
          `${heroName ? ` · <i>${escapeHtml(heroName)}</i>` : ""}`
      );
      lines.push(
        `   K/A/D：<b>${k}/${a}/${d}</b>  |  🕒 ${escapeHtml(timeStr)}`
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
  };
}

async function buildCnMatchDetailView(
  bnet: string,
  customerToken: string,
  matchId: string
): Promise<{
  text: string;
  keyboard: InlineKeyboard;
}> {
  const infoRes = await queryCustomerMatchInfo(customerToken, matchId);
  const info = infoRes?.data ?? infoRes?.result ?? {};

  const mapName =
    info.mapName ||
    info.map_name ||
    resolveDashenMapGuid(info.mapGuid || info.map_guid || info.mapId);
  const modeDesc = translateModeCode(
    info.gameMode || info.game_mode || info.mode || ""
  );
  const timeStr = formatMatchTimestamp(
    info.beginTs || info.begin_ts || info.startTime || info.timestamp
  );

  const playerStats =
    info.playerStat ||
    info.selfStat ||
    info.self ||
    info.stats ||
    info;

  const k = Number(
    playerStats.kill ?? playerStats.kills ?? playerStats.eliminations ?? 0
  );
  const a = Number(playerStats.assist ?? playerStats.assists ?? 0);
  const d = Number(playerStats.death ?? playerStats.deaths ?? 0);
  const dmg = Number(
    playerStats.heroDamage ?? playerStats.damage ?? playerStats.hero_damage ?? 0
  );
  const heal = Number(
    playerStats.cure ?? playerStats.healing ?? playerStats.heal ?? 0
  );
  const resist = Number(
    playerStats.resistDamage ??
      playerStats.damageBlocked ??
      playerStats.resist_damage ??
      0
  );

  const lines: string[] = [
    `🎯 <b>单局对局详情 — ${escapeHtml(bnet)}</b>`,
    `🗺 地图：<b>${escapeHtml(mapName || "未知地图")}</b>${modeDesc ? `（${escapeHtml(modeDesc)}）` : ""}`,
    `🕒 时间：${escapeHtml(timeStr)}`,
    `━━━━━━━━━━━━━━━━━━`,
    `• 击败 / 助攻 / 阵亡：<b>${k}</b> / <b>${a}</b> / <b>${d}</b>`,
    `• 英雄伤害：<b>${formatNumber(dmg)}</b>`,
    `• 治疗量：<b>${formatNumber(heal)}</b>`,
    `• 承受伤害：<b>${formatNumber(resist)}</b>`,
  ];

  const heroPerfList =
    info.heroList ||
    info.heroStats ||
    info.hero_list ||
    playerStats.heroList ||
    [];
  if (Array.isArray(heroPerfList) && heroPerfList.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━`, `🦸 <b>本局使用英雄</b>`);
    for (const h of heroPerfList.slice(0, 5)) {
      const hName = resolveDashenHeroName(
        h.heroName || h.hero_name || h.heroGuid || h.hero_guid || h.name
      );
      if (!hName) continue;
      const secs = Number(h.playTime ?? h.duration ?? h.timePlayed ?? 0);
      lines.push(
        `• <b>${escapeHtml(hName)}</b>${secs > 0 ? `（${formatDuration(secs)}）` : ""}`
      );
    }
  }

  return {
    text: lines.join("\n"),
    keyboard: buildCnMatchDetailKeyboard(bnet, matchId),
  };
}

// ============================================================================
// 6. 业务中转封装、用户中心、签到、卡密与多 AI 锐评调度
// ============================================================================

function getTgUserMeta(ctx: Context): {
  tgId: number;
  nickname: string;
  username: string;
} {
  const from = ctx.from;
  const tgId = Number(from?.id || 0);
  const nickname =
    [from?.first_name, from?.last_name].filter(Boolean).join(" ").trim() ||
    from?.username ||
    "";
  const username = String(from?.username || "").trim();
  return { tgId, nickname, username };
}

function getOperatorDisplayLabel(ctx: Context): string {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  if (nickname) return nickname;
  if (username) return `@${username}`;
  return tgId > 0 ? `TG#${tgId}` : "未知用户";
}

function parseStartInviterId(startPayload: string | undefined): number | null {
  const raw = String(startPayload || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(?:inv_|ref_|u_)?(\d+)$/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function buildInviteLink(tgId: number, botUsername: string): string {
  const uname = (botUsername || runtimeBotUsername || "").replace(/^@+/, "");
  if (uname) {
    return `https://t.me/${uname}?start=inv_${tgId}`;
  }
  return `邀请码：inv_${tgId}（启动机器人时发送 /start inv_${tgId}）`;
}

async function resolveBotUsernameForCtx(ctx: Context): Promise<string> {
  if (runtimeBotUsername) return runtimeBotUsername;
  if (ctx.me?.username) {
    runtimeBotUsername = ctx.me.username;
    return runtimeBotUsername;
  }
  try {
    const me = await ctx.api.getMe();
    if (me?.username) {
      runtimeBotUsername = me.username;
      return runtimeBotUsername;
    }
  } catch {
    // 忽略获取 Bot 用户名异常
  }
  return "";
}

async function assertBotNotMaintenance(ctx: Context): Promise<void> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  if (tgId <= 0) return;
  await relayInternalRequest("POST", "/internal/user/ensure", {
    json: { tgId, nickname, username },
  });
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
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  const res = await relayInternalRequest<{
    ok: boolean;
    data: {
      isNewUser: boolean;
      inviteRewardGranted: boolean;
      inviteRewardQuota: number;
      user: UserProfileDto;
      settings: SystemSettingsDto;
    };
  }>("POST", "/internal/user/ensure", {
    json: { tgId, nickname, username, inviterId },
  });
  return res.data;
}

async function resolveIsActiveAdminForCtx(ctx: Context): Promise<boolean> {
  const { tgId } = getTgUserMeta(ctx);
  if (tgId <= 0) return false;
  try {
    const res = await relayInternalRequest<{ ok: boolean; data: AdminMeDto }>(
      "GET",
      "/internal/admin/me",
      { operatorId: tgId }
    );
    return Boolean(res?.data?.isActive);
  } catch {
    return false;
  }
}

function buildMainReplyKeyboard(isAdmin = false): Keyboard {
  const kb = new Keyboard()
    .text("🇨🇳 战绩查询")
    .text("📋 战绩流水")
    .row()
    .text("👤 个人中心")
    .text("📅 每日签到")
    .text("🎟 兑换卡密")
    .row();

  if (isAdmin) {
    kb.text("🛠 管理员控制台").row();
  }
  return kb.resized().persistent();
}

function buildUserCenterView(
  user: UserProfileDto,
  settings: SystemSettingsDto,
  botUsername: string
): { text: string; keyboard: InlineKeyboard } {
  const inviteLink = buildInviteLink(user.tgId, botUsername);
  const statusBadge = user.isBanned
    ? "🚫 已封禁"
    : user.isAdmin
      ? user.adminRole === "super_admin"
        ? "👑 超级管理员（锐评无限）"
        : "👮 管理员（锐评无限）"
      : user.vipActive
        ? `👑 VIP 会员（锐评无限，至 ${escapeHtml(user.vipExpireAt || "")}）`
        : "🙋 普通用户";

  const lines = [
    `👤 <b>个人中心</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `• 昵称：<b>${escapeHtml(user.nickname || "未设置")}</b>（ID：<code>${user.tgId}</code>）`,
    `• 身份状态：<b>${statusBadge}</b>`,
    `• 剩余锐评次数：<b>${user.roastUnlimited ? "♾ 无限畅享" : `${user.quota} 次`}</b>`,
    `• 累计成功邀请：<b>${user.inviteCount}</b> 人`,
    `• 今日签到状态：${user.lastCheckinDate === getTodayBeijingStr() ? "✅ 今日已签到" : "⏳ 今日未签到"}`,
    `━━━━━━━━━━━━━━━━━━`,
    `🎁 <b>福利与邀请</b>`,
    settings.checkinRewardEnabled
      ? `• 每日签到可领 <b>+${settings.checkinRewardQuota}</b> 次锐评`
      : `• 每日签到奖励当前已关闭`,
    settings.inviteRewardEnabled
      ? `• 邀请好友首次注册可获 <b>+${settings.inviteRewardQuota}</b> 次锐评`
      : `• 邀请奖励当前已关闭`,
    `• 专属邀请链接：\n<code>${escapeHtml(inviteLink)}</code>`,
  ];

  const kb = new InlineKeyboard()
    .text("📅 立即签到", "u:checkin")
    .text("🎟 兑换卡密", "u:redeem_prompt")
    .row()
    .text("🔗 复制邀请链接", "u:copy_invite")
    .text("🔄 刷新状态", "u:refresh");

  if (user.isAdmin) {
    kb.row().text("🛠 打开管理员控制台", "u:open_admin");
  }

  return { text: lines.join("\n"), keyboard: kb };
}

function getTodayBeijingStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function notifyUserBenefitActivated(
  botInstance: Bot<Context>,
  targetTgId: number,
  htmlMessage: string
): Promise<boolean> {
  const uid = Number(targetTgId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return false;
  try {
    await botInstance.api.sendMessage(uid, htmlMessage, {
      parse_mode: "HTML",
    });
    return true;
  } catch (err) {
    console.warn("[Benefit Notification Push Failed]", { targetTgId: uid, err });
    return false;
  }
}

async function authorizeRoastForCtx(ctx: Context): Promise<{
  allowed: boolean;
  unlimited: boolean;
  exemptReason: string | null;
  quota: number;
}> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  const res = await relayInternalRequest<{
    ok: boolean;
    data: {
      allowed: boolean;
      unlimited: boolean;
      exemptReason: string | null;
      quota: number;
    };
  }>("POST", "/internal/roast/authorize", {
    json: { tgId, nickname, username },
  });
  return res.data;
}

async function consumeRoastQuotaForCtx(
  ctx: Context,
  roastType: RoastType,
  detail: string
): Promise<{
  consumed: boolean;
  unlimited: boolean;
  quota: number;
}> {
  const { tgId } = getTgUserMeta(ctx);
  const res = await relayInternalRequest<{
    ok: boolean;
    data: {
      consumed: boolean;
      unlimited: boolean;
      quota: number;
    };
  }>("POST", "/internal/roast/consume", {
    json: { tgId, roastType, detail },
  });
  return res.data;
}

async function getRoastCache(
  cacheKey: string,
  roastType: RoastType
): Promise<string | null> {
  try {
    const res = await relayInternalRequest<{
      ok: boolean;
      hit: boolean;
      record?: { reviewHtml?: string };
    }>("GET", "/internal/roast/cache/get", {
      params: { cacheKey, roastType },
    });
    if (res?.hit && res.record?.reviewHtml) {
      return String(res.record.reviewHtml);
    }
    return null;
  } catch {
    return null;
  }
}

async function setRoastCache(params: {
  cacheKey: string;
  roastType: RoastType;
  providerId: number;
  providerName: string;
  modelName: string;
  gameMode: string;
  bnet: string;
  operatorNickname: string;
  matchId: string;
  reviewHtml: string;
}): Promise<void> {
  try {
    await relayInternalRequest("POST", "/internal/roast/cache/set", {
      json: params,
    });
  } catch (err) {
    console.warn("[Save Roast Cache Warn]", err);
  }
}

async function fetchActiveAiProviders(): Promise<AiProviderDto[]> {
  const list: AiProviderDto[] = [];
  let defaultDeepseekEnabled = true;

  try {
    const res = await relayInternalRequest<{
      ok: boolean;
      data?: {
        defaultDeepseekEnabled?: boolean;
        providers?: AiProviderDto[];
      };
    }>("GET", "/internal/ai/providers/active");
    if (typeof res?.data?.defaultDeepseekEnabled === "boolean") {
      defaultDeepseekEnabled = res.data.defaultDeepseekEnabled;
    }
    if (Array.isArray(res?.data?.providers)) {
      for (const p of res.data.providers) {
        if (p && p.isEnabled && p.baseUrl && p.apiKey && p.model) {
          list.push({
            id: Number(p.id),
            name: String(p.name || `渠道#${p.id}`),
            baseUrl: String(p.baseUrl).trim().replace(/\/+$/, ""),
            apiKey: String(p.apiKey).trim(),
            model: String(p.model).trim(),
            executionTarget:
              p.executionTarget === "docker" ? "docker" : "vercel",
            isEnabled: true,
          });
        }
      }
    }
  } catch (err) {
    console.warn("[Fetch Active AI Providers Fallback]", err);
  }

  if (defaultDeepseekEnabled && AI_API_KEY) {
    list.unshift({
      id: 0,
      name: "DeepSeek",
      baseUrl: AI_BASE_URL,
      apiKey: AI_API_KEY,
      model: AI_MODEL,
      executionTarget: "vercel",
      isEnabled: true,
    });
  }

  return list;
}

function buildRoastProviderSelectKeyboard(
  rKind: RoastType,
  arg3: string,
  bnet: string,
  providers: AiProviderDto[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  providers.forEach((p, idx) => {
    const badge = p.executionTarget === "docker" ? "🐳 " : "";
    kb.text(`${badge}${p.name}`, `cn:rp:${p.id}:${rKind}:${arg3}:${bnet}`);
    if (idx % 2 === 1) kb.row();
  });
  if (providers.length % 2 === 1) kb.row();
  kb.text("❌ 取消选择", `cn:rc:${rKind}:${arg3}:${bnet}`);
  return kb;
}

function buildRoastPrompt(params: {
  rKind: RoastType;
  bnet: string;
  mode: CnGameMode;
  snapshotText?: string;
  currentRankLabel?: string;
  matchDetailText?: string;
}): { systemPrompt: string; userPrompt: string } {
  const { rKind, bnet, mode, snapshotText, currentRankLabel, matchDetailText } =
    params;
  const modeLabel = mode === "sport" ? "竞技比赛" : "快速/休闲";

  if (rKind === "match") {
    return {
      systemPrompt:
        "你是《守望先锋 2》国服高分段战术分析师兼毒舌锐评教练。请基于单局对局数据给出专业、犀利、幽默但不人身攻击的锐评与改进建议，输出纯文本或简洁段落，不要使用复杂 Markdown 表格。",
      userPrompt: `请锐评以下《守望先锋 2》国服单局表现：\n战网ID：${bnet}\n对局详情：\n${matchDetailText || "暂无详细数据"}`,
    };
  }

  if (rKind === "mmr") {
    return {
      systemPrompt:
        "你是《守望先锋 2》国服竞技匹配机制（MMR）与隐性段位分析师。请结合玩家的公开段位、胜率、场次与常用英雄表现，客观分析其“隐性分/真实实力定位”偏高、偏低还是匹配，给出简洁清晰的评估。",
      userPrompt: `请评估以下《守望先锋 2》国服玩家的隐性段位与真实水平：\n战网ID：${bnet}\n模式：${modeLabel}\n公开段位：${currentRankLabel || "暂无"}\n战绩总览：\n${snapshotText || "暂无"}`,
    };
  }

  return {
    systemPrompt:
      "你是《守望先锋 2》国服毒舌但懂行的竞技教练。请根据玩家的赛季总览、胜率与常用英雄池，给出风趣犀利又实用的个人战绩锐评与上分建议。",
    userPrompt: `请锐评以下《守望先锋 2》国服玩家战绩：\n战网ID：${bnet}\n模式：${modeLabel}\n战绩总览：\n${snapshotText || "暂无"}`,
  };
}

function formatFinalRoastHtml(params: {
  rKind: RoastType;
  bnet: string;
  mode: CnGameMode;
  providerName: string;
  modelName: string;
  operatorNickname: string;
  aiContent: string;
  unlimited: boolean;
  remainingQuota: number;
  nodeLabel?: string;
}): string {
  const {
    rKind,
    bnet,
    mode,
    providerName,
    modelName,
    operatorNickname,
    aiContent,
    unlimited,
    remainingQuota,
    nodeLabel,
  } = params;

  const titleMap: Record<RoastType, string> = {
    match: "🎯 单局 AI 锐评",
    self: "🤖 个人战绩 AI 锐评",
    mmr: "🔮 AI 隐性段位评估",
  };

  const quotaLine = unlimited
    ? "💎 额度状态：特权免扣（♾ 无限）"
    : `⚡ 额度状态：已扣减 1 次（剩余 <b>${remainingQuota}</b> 次）`;

  const cleanBody = escapeHtml(aiContent.trim() || "模型未返回有效内容");
  const modeNote = rKind === "match" ? "单局详情" : mode === "sport" ? "竞技比赛" : "快速/休闲";

  return (
    `${titleMap[rKind]} — <code>${escapeHtml(bnet)}</code>\n` +
    `🧠 模型：<b>${escapeHtml(providerName)}</b>${modelName ? ` (<code>${escapeHtml(modelName)}</code>)` : ""}${nodeLabel ? ` · ${escapeHtml(nodeLabel)}` : ""}\n` +
    `🎮 口径：<b>${escapeHtml(modeNote)}</b>  |  👤 发起：<b>${escapeHtml(operatorNickname)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${cleanBody}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `<i>${quotaLine}</i>`
  );
}

async function callAiProviderDirect(
  provider: AiProviderDto,
  systemPrompt: string,
  userPrompt: string
): Promise<{ content: string }> {
  const chatUrl = provider.baseUrl.endsWith("/chat/completions")
    ? provider.baseUrl
    : `${provider.baseUrl}/chat/completions`;

  const res = await fetch(chatUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
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
    throw new Error(`AI 接口返回错误 (HTTP ${res.status})：${rawText.slice(0, 200)}`);
  }

  let parsed: any = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    return { content: rawText };
  }

  const choice = parsed?.choices?.[0] ?? parsed?.data?.choices?.[0] ?? null;
  const msg = choice?.message ?? choice?.delta ?? null;
  const content =
    msg?.content ||
    msg?.reasoning_content ||
    parsed?.output_text ||
    choice?.text ||
    "";

  return {
    content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
  };
}

async function runVercelRoastTask(params: {
  ctx: Context;
  chatId: number;
  messageId: number;
  taskKey: string;
  rKind: RoastType;
  bnet: string;
  mode: CnGameMode;
  snapshotText: string;
  currentRankLabel: string;
  matchId: string;
  customerToken: string;
  operatorNickname: string;
  provider: AiProviderDto;
  unlimited: boolean;
  cacheKey: string;
}): Promise<void> {
  const {
    ctx,
    chatId,
    messageId,
    taskKey,
    rKind,
    bnet,
    mode,
    snapshotText,
    currentRankLabel,
    matchId,
    customerToken,
    operatorNickname,
    provider,
    unlimited,
    cacheKey,
  } = params;

  try {
    let matchDetailText = "";
    if (rKind === "match" && matchId) {
      const detailView = await buildCnMatchDetailView(
        bnet,
        customerToken,
        matchId
      );
      matchDetailText = detailView.text.replace(/<[^>]+>/g, "");
    }

    const { systemPrompt, userPrompt } = buildRoastPrompt({
      rKind,
      bnet,
      mode,
      snapshotText,
      currentRankLabel,
      matchDetailText,
    });

    const aiRes = await callAiProviderDirect(provider, systemPrompt, userPrompt);
    const content = String(aiRes.content || "").trim();
    if (!content) {
      throw new Error("AI 返回内容为空");
    }

    const consumeRes = await consumeRoastQuotaForCtx(
      ctx,
      rKind === "match" ? "roast_match" : rKind === "mmr" ? "roast_mmr" : "roast_self",
      `${rKind}:${bnet}:${provider.name}`
    );

    const finalHtml = formatFinalRoastHtml({
      rKind,
      bnet,
      mode,
      providerName: provider.name,
      modelName: provider.model,
      operatorNickname,
      aiContent: content,
      unlimited: consumeRes.unlimited || unlimited,
      remainingQuota: consumeRes.quota,
      nodeLabel: "⚡ Vercel 节点",
    });

    await setRoastCache({
      cacheKey,
      roastType: rKind,
      providerId: provider.id,
      providerName: provider.name,
      modelName: provider.model,
      gameMode: mode,
      bnet,
      operatorNickname,
      matchId,
      reviewHtml: finalHtml,
    });

    await ctx.api.editMessageText(chatId, messageId, finalHtml, {
      parse_mode: "HTML",
    });
  } catch (err) {
    const errMsg =
      err instanceof Error ? escapeHtml(err.message) : "AI 锐评生成失败";
    await ctx.api
      .editMessageText(
        chatId,
        messageId,
        `❌ <b>AI 锐评生成失败（未扣减次数）：</b>\n${errMsg}`,
        { parse_mode: "HTML" }
      )
      .catch(() => {});
  } finally {
    inFlightRoastTasks.delete(taskKey);
  }
}

async function enqueueDockerRoastTask(params: {
  ctx: Context;
  chatId: number;
  messageId: number;
  taskKey: string;
  rKind: RoastType;
  bnet: string;
  mode: CnGameMode;
  snapshotText: string;
  currentRankLabel: string;
  matchId: string;
  customerToken: string;
  operatorNickname: string;
  provider: AiProviderDto;
  unlimited: boolean;
  cacheKey: string;
}): Promise<void> {
  const {
    ctx,
    chatId,
    messageId,
    taskKey,
    rKind,
    bnet,
    mode,
    snapshotText,
    currentRankLabel,
    matchId,
    customerToken,
    operatorNickname,
    provider,
    unlimited,
    cacheKey,
  } = params;

  try {
    let matchDetailText = "";
    if (rKind === "match" && matchId) {
      const detailView = await buildCnMatchDetailView(
        bnet,
        customerToken,
        matchId
      );
      matchDetailText = detailView.text.replace(/<[^>]+>/g, "");
    }

    const { systemPrompt, userPrompt } = buildRoastPrompt({
      rKind,
      bnet,
      mode,
      snapshotText,
      currentRankLabel,
      matchDetailText,
    });

    const { tgId, nickname, username } = getTgUserMeta(ctx);
    const callbackUrl = `${VERCEL_PUBLIC_ORIGIN}/api/bot?action=docker_callback`;

    const enqueueRes = await relayInternalRequest<{
      ok: boolean;
      data: {
        jobId: string;
        aheadCount: number;
        queuePosition: number;
        timeoutMs: number;
      };
    }>("POST", "/internal/ai/queue/enqueue", {
      json: {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        systemPrompt,
        userPrompt,
        timeoutMs: DOCKER_AI_TIMEOUT_MS,
        callbackUrl,
        meta: {
          chatId,
          messageId,
          taskKey,
          rKind,
          bnet,
          mode,
          matchId,
          operatorNickname,
          providerId: provider.id,
          providerName: provider.name,
          modelName: provider.model,
          unlimited,
          cacheKey,
          tgUserMeta: { tgId, nickname, username },
        },
      },
    });

    const q = enqueueRes.data;
    const waitTip =
      q.aheadCount > 0
        ? `📍 当前前方还有 <b>${q.aheadCount}</b> 人/任务在等待`
        : `🚀 当前前方无人排队，即将开始深度思考`;

    await ctx.api
      .editMessageText(
        chatId,
        messageId,
        `⏳ <b>已进入 Docker 异步计算队列</b>\n` +
          `🤖 模型渠道：<b>${escapeHtml(provider.name)}</b>（🐳 Docker 节点）\n` +
          `🎯 目标战网：<code>${escapeHtml(bnet)}</code>\n` +
          `${waitTip}\n` +
          `<i>单次任务最长等待 120s，完成后将自动推送结果。</i>`,
        { parse_mode: "HTML" }
      )
      .catch(() => {});
  } catch (err) {
    inFlightRoastTasks.delete(taskKey);
    const errMsg =
      err instanceof Error ? escapeHtml(err.message) : "提交 Docker 队列失败";
    await ctx.api
      .editMessageText(
        chatId,
        messageId,
        `❌ <b>提交 Docker 队列失败（未扣减次数）：</b>\n${errMsg}`,
        { parse_mode: "HTML" }
      )
      .catch(() => {});
  }
}

async function handleDockerQueueCallback(
  botInstance: Bot<Context>,
  payload: any
): Promise<{ ok: boolean }> {
  const meta = payload?.meta || {};
  const chatId = Number(meta.chatId || 0);
  const messageId = Number(meta.messageId || 0);
  const taskKey = String(meta.taskKey || "");
  const rKind = (meta.rKind as RoastType) || "self";
  const bnet = String(meta.bnet || "");
  const mode = (meta.mode as CnGameMode) || "sport";
  const matchId = String(meta.matchId || "");
  const operatorNickname = String(meta.operatorNickname || "用户");
  const providerId = Number(meta.providerId ?? 0);
  const providerName = String(meta.providerName || "AI");
  const modelName = String(meta.modelName || "");
  const unlimited = Boolean(meta.unlimited);
  const cacheKey = String(meta.cacheKey || "");
  const tgMeta = meta.tgUserMeta || {};

  if (taskKey) {
    inFlightRoastTasks.delete(taskKey);
  }

  if (!chatId || !messageId) {
    return { ok: true };
  }

  if (payload?.status !== "succeeded" || !payload?.result?.content) {
    const errText = escapeHtml(
      String(payload?.error || "Docker AI 节点处理超时或失败")
    );
    await botInstance.api
      .editMessageText(
        chatId,
        messageId,
        `❌ <b>Docker AI 锐评未完成（未扣减次数）：</b>\n${errText}`,
        { parse_mode: "HTML" }
      )
      .catch(() => {});
    return { ok: true };
  }

  const content = String(payload.result.content || "").trim();
  let remainingQuota = 0;
  let finalUnlimited = unlimited;

  if (tgMeta?.tgId) {
    try {
      const cRes = await relayInternalRequest<{
        ok: boolean;
        data: { consumed: boolean; unlimited: boolean; quota: number };
      }>("POST", "/internal/roast/consume", {
        json: {
          tgId: Number(tgMeta.tgId),
          roastType:
            rKind === "match"
              ? "roast_match"
              : rKind === "mmr"
                ? "roast_mmr"
                : "roast_self",
          detail: `${rKind}:${bnet}:${providerName}(docker)`,
        },
      });
      finalUnlimited = Boolean(cRes?.data?.unlimited || unlimited);
      remainingQuota = Number(cRes?.data?.quota ?? 0);
    } catch {
      // 忽略扣次异常
    }
  }

  const finalHtml = formatFinalRoastHtml({
    rKind,
    bnet,
    mode,
    providerName,
    modelName,
    operatorNickname,
    aiContent: content,
    unlimited: finalUnlimited,
    remainingQuota,
    nodeLabel: "🐳 Docker 队列节点",
  });

  if (cacheKey) {
    await setRoastCache({
      cacheKey,
      roastType: rKind,
      providerId,
      providerName,
      modelName,
      gameMode: mode,
      bnet,
      operatorNickname,
      matchId,
      reviewHtml: finalHtml,
    });
  }

  await botInstance.api
    .editMessageText(chatId, messageId, finalHtml, { parse_mode: "HTML" })
    .catch(() => {});

  return { ok: true };
}

// ============================================================================
// 7. 机器人初始化与指令、键盘、后台面板及回调处理
// ============================================================================

if (!BOT_TOKEN) {
  throw new Error("缺少环境变量 BOT_TOKEN");
}

const bot = new Bot<Context>(BOT_TOKEN);

bot.catch((err) => {
  console.error("[grammY Bot Error]", err);
});

async function handleUserCenterCommand(ctx: Context): Promise<void> {
  await assertBotNotMaintenance(ctx);
  const botUsername = await resolveBotUsernameForCtx(ctx);
  const regRes = await ensureUserRegistered(ctx);
  const view = buildUserCenterView(regRes.user, regRes.settings, botUsername);
  await ctx.reply(view.text, {
    parse_mode: "HTML",
    reply_markup: view.keyboard,
  });
}

async function handleCheckinCommand(ctx: Context): Promise<void> {
  await assertBotNotMaintenance(ctx);
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  const res = await relayInternalRequest<{
    ok: boolean;
    data: {
      alreadyCheckedIn: boolean;
      today: string;
      rewardEnabled: boolean;
      rewardQuota: number;
      quota: number;
    };
  }>("POST", "/internal/user/checkin", {
    json: { tgId, nickname, username },
  });

  const d = res.data;
  if (d.alreadyCheckedIn) {
    await ctx.reply(
      `📅 <b>你今天（${escapeHtml(d.today)}）已经签到过了！</b>\n当前剩余锐评次数：<b>${d.quota}</b> 次`,
      { parse_mode: "HTML" }
    );
    return;
  }

  await ctx.reply(
    `🎉 <b>每日签到成功（${escapeHtml(d.today)}）！</b>\n` +
      `• 本次奖励：<b>${d.rewardEnabled ? `+${d.rewardQuota} 次 AI 锐评` : "当前签到奖励已关闭"}</b>\n` +
      `• 当前剩余锐评次数：<b>${d.quota}</b> 次`,
    { parse_mode: "HTML" }
  );
}

async function executeRedeemCode(ctx: Context, rawCode: string): Promise<void> {
  await assertBotNotMaintenance(ctx);
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  const res = await relayInternalRequest<{
    ok: boolean;
    data: {
      code: string;
      rewardType: "quota" | "vip_days";
      rewardValue: number;
      quota: number;
      vipExpireAt: string | null;
    };
  }>("POST", "/internal/user/redeem", {
    json: { tgId, code: rawCode, nickname, username },
  });

  const d = res.data;
  if (d.rewardType === "vip_days") {
    await ctx.reply(
      `👑 <b>卡密兑换成功！</b>\n` +
        `• 核销卡密：<code>${escapeHtml(d.code)}</code>\n` +
        `• 获得权益：VIP 会员 <b>+${d.rewardValue}</b> 天\n` +
        `• 最新 VIP 到期时间：<b>${escapeHtml(d.vipExpireAt || "")}</b>（北京时间）`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      `⚡ <b>卡密兑换成功！</b>\n` +
        `• 核销卡密：<code>${escapeHtml(d.code)}</code>\n` +
        `• 获得权益：AI 锐评次数 <b>+${d.rewardValue}</b> 次\n` +
        `• 当前剩余次数：<b>${d.quota}</b> 次`,
      { parse_mode: "HTML" }
    );
  }
}

bot.command("start", async (ctx) => {
  try {
    const inviterId = parseStartInviterId(ctx.match);
    const botUsername = await resolveBotUsernameForCtx(ctx);
    const regRes = await ensureUserRegistered(ctx, inviterId);
    const isAdmin = await resolveIsActiveAdminForCtx(ctx);

    const welcomeLines = [
      `👋 <b>欢迎使用《守望先锋 2》国服战绩查询机器人！</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `• 查询国服总览：<code>/cn 昵称#1234</code>（支持附带 <code>竞技</code> 或 <code>快速</code>）`,
      `• 查询近期流水：<code>/match 昵称#1234</code>`,
      `• 个人中心 / 签到 / 兑换：<code>/me</code>、<code>/checkin</code>、<code>/redeem 卡密</code>`,
    ];

    if (regRes.isNewUser && regRes.settings.registerRewardEnabled && regRes.settings.registerRewardQuota > 0) {
      welcomeLines.push(
        `🎁 <b>新用户福利：</b>已为你自动赠送 <b>+${regRes.settings.registerRewardQuota}</b> 次免费 AI 锐评！`
      );
    }
    if (regRes.inviteRewardGranted && regRes.inviteRewardQuota > 0) {
      welcomeLines.push(
        `🤝 <b>邀请奖励已发放：</b>邀请人已获得 <b>+${regRes.inviteRewardQuota}</b> 次锐评！`
      );
    }

    await ctx.reply(welcomeLines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: buildMainReplyKeyboard(isAdmin),
    });

    const view = buildUserCenterView(regRes.user, regRes.settings, botUsername);
    await ctx.reply(view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
  } catch (err) {
    const msg =
      err instanceof RelayServiceError || err instanceof DashenError
        ? err.message
        : "❌ 启动失败，请稍后再试。";
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

bot.command("me", handleUserCenterCommand);
bot.command("checkin", handleCheckinCommand);
bot.command("redeem", async (ctx) => {
  try {
    const arg = String(ctx.match || "").trim();
    if (!arg) {
      const tgId = Number(ctx.from?.id || 0);
      if (tgId > 0) {
        pendingUserInputs.set(tgId, {
          action: { type: "redeem_input" },
          expiresAt: Date.now() + 2 * 60 * 1000,
        });
      }
      await ctx.reply(
        `🎟 <b>请输入你要兑换的卡密编号：</b>\n<i>（例如：<code>OW2C-5-XXXXXXXX</code>，直接发送即可）</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }
    await executeRedeemCode(ctx, arg);
  } catch (err) {
    const msg =
      err instanceof RelayServiceError || err instanceof DashenError
        ? err.message
        : "❌ 卡密兑换失败，请稍后再试。";
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

async function executeCnOverviewQuery(
  ctx: Context,
  rawQuery: string,
  editMessage = false
): Promise<void> {
  await assertBotNotMaintenance(ctx);
  await ensureUserRegistered(ctx);

  const tokens = rawQuery.trim().split(/\s+/);
  const bnet = tokens[0]?.replace("＃", "#").trim() || "";
  if (!bnet) return;

  const tgId = Number(ctx.from?.id || 0);
  const secondTok = (tokens[1] || "").toLowerCase();
  let mode: CnGameMode = userLastMode.get(tgId) || "sport";
  if (["leisure", "quick", "qp", "快速", "休闲", "匹配"].includes(secondTok)) {
    mode = "leisure";
  } else if (
    ["sport", "comp", "competitive", "竞技", "排位"].includes(secondTok)
  ) {
    mode = "sport";
  }

  if (!editMessage) {
    await ctx.replyWithChatAction("typing");
  }

  const isAdmin = await resolveIsActiveAdminForCtx(ctx);
  const { text, keyboard } = await buildCnOverviewView(bnet, mode, isAdmin);

  if (tgId > 0) {
    userLastMode.set(tgId, mode);
    userLastBnet.set(tgId, bnet);
  }

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }
}

async function renderAdminHomePanel(
  ctx: Context,
  edit = false
): Promise<void> {
  const tgId = Number(ctx.from?.id || 0);
  const meRes = await relayInternalRequest<{
    ok: boolean;
    data: AdminMeDto;
  }>("GET", "/internal/admin/me", { operatorId: tgId });

  const admin = meRes.data;
  const isSuper = admin.role === "super_admin";
  const permSet = new Set(admin.permissions || []);
  const labels = admin.permissionLabels || PERMISSION_LABELS_FALLBACK;

  const lines = [
    `🛠 <b>管理员控制台</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `• 操作人：<b>${escapeHtml(admin.remark || "管理员")}</b>（<code>${admin.tgId}</code>）`,
    `• 角色身份：<b>${isSuper ? "👑 超级管理员" : "👮 普通管理员"}</b>`,
  ];

  if (!isSuper) {
    const grantedNames = Array.from(permSet).map((p) => labels[p] || p);
    lines.push(
      `• 已授权限：${grantedNames.length > 0 ? grantedNames.map((n) => `<code>${escapeHtml(n)}</code>`).join("、") : "<i>暂未分配细分权限</i>"}`
    );
  }

  const kb = new InlineKeyboard();
  if (isSuper || permSet.has("user:view")) {
    kb.text("👤 查用户/列表", "ad:user_q");
  }
  if (isSuper || permSet.has("quota:add")) {
    kb.text("➕ 加次数", "ad:q_add");
  }
  if (isSuper || permSet.has("quota:deduct")) {
    kb.text("➖ 扣次数", "ad:q_sub");
  }
  if (kb.inline_keyboard.length === 0 || kb.inline_keyboard[kb.inline_keyboard.length - 1].length >= 3) {
    kb.row();
  }

  if (isSuper || permSet.has("vip:manage")) {
    kb.text("👑 VIP 管理", "ad:vip");
  }
  if (isSuper || permSet.has("user:ban")) {
    kb.text("🚫 封禁/解封", "ad:ban");
  }
  if (isSuper || permSet.has("stats:view")) {
    kb.text("📊 运营统计", "ad:stats");
  }
  kb.row();

  if (isSuper || permSet.has("redeem:create")) {
    kb.text("🎟 生成卡密", "ad:rc_new");
  }
  if (isSuper || permSet.has("redeem:view")) {
    kb.text("🔍 查卡密", "ad:rc_view");
  }
  if (isSuper || permSet.has("redeem:void")) {
    kb.text("🗑 作废卡密", "ad:rc_void");
  }
  kb.row();

  if (isSuper) {
    kb.text("🤖 AI 锐评渠道", "ad:ai_list")
      .text("🔑 大神账号轮询", "ad:ds_list")
      .row()
      .text("⚙️ 系统与赠送", "ad:settings")
      .text("👮 管理员权限", "ad:admins")
      .row()
      .text("📜 操作审计日志", "ad:logs:1")
      .row();
  }

  const text = lines.join("\n");
  if (edit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }
}

async function renderAiProvidersPanel(
  ctx: Context,
  edit = true
): Promise<void> {
  const tgId = Number(ctx.from?.id || 0);
  const res = await relayInternalRequest<{
    ok: boolean;
    data: {
      defaultDeepseekEnabled: boolean;
      providers: AiProviderDto[];
    };
  }>("GET", "/internal/admin/ai-providers", { operatorId: tgId });

  const d = res.data;
  const lines: string[] = [
    `🤖 <b>AI 锐评渠道管理（仅超管）</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `• <b>#0 DeepSeek（默认通道）</b> — ${d.defaultDeepseekEnabled ? "✅ 开启" : "🔴 关闭"} | ⚡ Vercel 节点`,
  ];

  const kb = new InlineKeyboard().text(
    d.defaultDeepseekEnabled ? "🔴 关 DeepSeek" : "🟢 开 DeepSeek",
    `ad:ai_tog:0:${d.defaultDeepseekEnabled ? 0 : 1}`
  );

  const providers = Array.isArray(d.providers) ? d.providers : [];
  if (providers.length > 0) {
    kb.row();
    for (const p of providers) {
      const tgt = p.executionTarget === "docker" ? "docker" : "vercel";
      lines.push(
        `• <b>#${p.id} ${escapeHtml(p.name)}</b> — ${p.isEnabled ? "✅ 开启" : "🔴 关闭"} | ${tgt === "docker" ? "🐳 Docker(120s)" : "⚡ Vercel"}`
      );
      lines.push(
        `   模型：<code>${escapeHtml(p.model)}</code> | Key：<code>${escapeHtml(p.maskedKey || "")}</code>`
      );
      kb.text(
        p.isEnabled ? `🔴 关 #${p.id}` : `🟢 开 #${p.id}`,
        `ad:ai_tog:${p.id}:${p.isEnabled ? 0 : 1}`
      )
        .text(
          tgt === "docker" ? `⚡ 切Vercel #${p.id}` : `🐳 切Docker #${p.id}`,
          `ad:ai_tgt:${p.id}:${tgt === "docker" ? "vercel" : "docker"}`
        )
        .text(`🗑 删 #${p.id}`, `ad:ai_del:${p.id}`)
        .row();
    }
  } else {
    kb.row();
  }

  kb.text("🔙 返回管理主页", "ad:home");
  const text = lines.join("\n");
  if (edit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }
}

async function renderDashenAccountsPanel(
  ctx: Context,
  edit = true
): Promise<void> {
  const tgId = Number(ctx.from?.id || 0);
  const res = await relayInternalRequest<{
    ok: boolean;
    data: { accounts: DashenPoolAccountDto[] };
  }>("GET", "/internal/admin/dashen-accounts", { operatorId: tgId });

  const accounts = Array.isArray(res?.data?.accounts) ? res.data.accounts : [];
  const lines: string[] = [
    `🔑 <b>网易大神账号轮询池管理（仅超管）</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `<i>说明：只存储必要请求参数（含 User-Agent），不存易变 Cookie；查无数据或异常时自动轮询下一账号。</i>`,
  ];

  const kb = new InlineKeyboard();
  if (accounts.length === 0) {
    lines.push(`📭 当前轮询池暂无账号，请点击下方「➕ 粘贴请求头新增」添加。`);
  } else {
    for (const acc of accounts) {
      const uaPreview = acc.userAgent
        ? `${escapeHtml(acc.userAgent.slice(0, 38))}${acc.userAgent.length > 38 ? "..." : ""}`
        : "默认 UA";
      lines.push(
        `• <b>#${acc.id} ${escapeHtml(acc.name)}</b> — ${acc.isEnabled ? "✅ 启用" : "⏸ 停用"} | 失败 <b>${acc.failCount || 0}</b> 次`
      );
      lines.push(
        `   RoleId：<code>${acc.roleId}</code> | Token：<code>${escapeHtml(acc.maskedToken || "")}</code> | dts：<code>${acc.dts}</code> / srv：<code>${acc.server}</code>`
      );
      lines.push(`   UA：<code>${uaPreview}</code>`);

      kb.text(
        acc.isEnabled ? `⏸ 停用 #${acc.id}` : `▶️ 启用 #${acc.id}`,
        `ad:ds_tog:${acc.id}:${acc.isEnabled ? 0 : 1}`
      )
        .text(`✏️ 修改 #${acc.id}`, `ad:ds_edit:${acc.id}`)
        .text(`🗑 删 #${acc.id}`, `ad:ds_del:${acc.id}`)
        .row();
    }
  }

  kb.text("➕ 粘贴请求头新增", "ad:ds_add").text("🔙 返回管理主页", "ad:home");

  const text = lines.join("\n");
  if (edit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }
}

async function executeCnMatchListQuery(
  ctx: Context,
  rawQuery: string,
  page = 1,
  editMessage = false
): Promise<void> {
  await assertBotNotMaintenance(ctx);
  await ensureUserRegistered(ctx);

  const tokens = rawQuery.trim().split(/\s+/);
  const bnet = tokens[0]?.replace("＃", "#").trim() || "";
  if (!bnet) return;

  const tgId = Number(ctx.from?.id || 0);
  const secondTok = (tokens[1] || "").toLowerCase();
  let mode: CnGameMode = userLastMode.get(tgId) || "sport";
  if (["leisure", "quick", "qp", "快速", "休闲", "匹配"].includes(secondTok)) {
    mode = "leisure";
  } else if (
    ["sport", "comp", "competitive", "竞技", "排位"].includes(secondTok)
  ) {
    mode = "sport";
  }

  if (!editMessage) {
    await ctx.replyWithChatAction("typing");
  }

  const { text, keyboard, matchIds } = await buildCnMatchListView(
    bnet,
    mode,
    page
  );

  if (tgId > 0) {
    userLastMode.set(tgId, mode);
    userLastBnet.set(tgId, bnet);
    userRecentMatchIds.set(tgId, matchIds);
  }

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }
}

bot.command("cn", async (ctx) => {
  try {
    const arg = String(ctx.match || "").trim();
    if (!arg) {
      const tgId = Number(ctx.from?.id || 0);
      if (tgId > 0) {
        pendingUserInputs.set(tgId, {
          action: { type: "cn_query_input" },
          expiresAt: Date.now() + 2 * 60 * 1000,
        });
      }
      await ctx.reply(
        `🇨🇳 <b>请输入要查询的国服战网 ID：</b>\n<i>（格式：<code>玩家昵称#51234</code>，可选附带 <code>竞技</code> 或 <code>快速</code>）</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }
    await executeCnOverviewQuery(ctx, arg, false);
  } catch (err) {
    const msg =
      err instanceof DashenError || err instanceof RelayServiceError
        ? err.message
        : "❌ 查询国服战绩失败，请稍后重试。";
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

bot.command("match", async (ctx) => {
  try {
    const arg = String(ctx.match || "").trim();
    if (!arg) {
      const tgId = Number(ctx.from?.id || 0);
      if (tgId > 0) {
        pendingUserInputs.set(tgId, {
          action: { type: "match_query_input" },
          expiresAt: Date.now() + 2 * 60 * 1000,
        });
      }
      await ctx.reply(
        `📋 <b>请输入要查询近期对局流水的国服战网 ID：</b>\n<i>（格式：<code>玩家昵称#51234</code>）</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }
    await executeCnMatchListQuery(ctx, arg, 1, false);
  } catch (err) {
    const msg =
      err instanceof DashenError || err instanceof RelayServiceError
        ? err.message
        : "❌ 查询近期战绩流水失败，请稍后重试。";
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

bot.command("admin", async (ctx) => {
  try {
    await renderAdminHomePanel(ctx, false);
  } catch (err) {
    const msg =
      err instanceof RelayServiceError
        ? err.message
        : "⛔ 无权访问管理员控制台。";
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

bot.hears("👤 个人中心", async (ctx) => {
  try {
    await handleUserCenterCommand(ctx);
  } catch (err) {
    const msg =
      err instanceof RelayServiceError ? err.message : "❌ 获取个人中心失败。";
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

bot.hears("📅 每日签到", async (ctx) => {
  try {
    await handleCheckinCommand(ctx);
  } catch (err) {
    const msg =
      err instanceof RelayServiceError ? err.message : "❌ 签到失败，请稍后再试。";
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

bot.hears("🎟 兑换卡密", async (ctx) => {
  const tgId = Number(ctx.from?.id || 0);
  if (tgId > 0) {
    pendingUserInputs.set(tgId, {
      action: { type: "redeem_input" },
      expiresAt: Date.now() + 2 * 60 * 1000,
    });
  }
  await ctx.reply(
    `🎟 <b>请输入你要兑换的卡密编号：</b>\n<i>（例如：<code>OW2C-5-XXXXXXXX</code>）</i>`,
    { parse_mode: "HTML" }
  );
});

bot.hears("🇨🇳 战绩查询", async (ctx) => {
  const tgId = Number(ctx.from?.id || 0);
  if (tgId > 0) {
    pendingUserInputs.set(tgId, {
      action: { type: "cn_query_input" },
      expiresAt: Date.now() + 2 * 60 * 1000,
    });
  }
  await ctx.reply(
    `🇨🇳 <b>请输入要查询的国服战网 ID：</b>\n<i>（格式：<code>玩家昵称#51234</code>，可选附带 <code>竞技</code> 或 <code>快速</code>）</i>`,
    { parse_mode: "HTML" }
  );
});

bot.hears("📋 战绩流水", async (ctx) => {
  const tgId = Number(ctx.from?.id || 0);
  if (tgId > 0) {
    pendingUserInputs.set(tgId, {
      action: { type: "match_query_input" },
      expiresAt: Date.now() + 2 * 60 * 1000,
    });
  }
  await ctx.reply(
    `📋 <b>请输入要查询近期对局流水的国服战网 ID：</b>\n<i>（格式：<code>玩家昵称#51234</code>）</i>`,
    { parse_mode: "HTML" }
  );
});

bot.hears("🛠 管理员控制台", async (ctx) => {
  try {
    await renderAdminHomePanel(ctx, false);
  } catch (err) {
    const msg =
      err instanceof RelayServiceError
        ? err.message
        : "⛔ 无权访问管理员控制台。";
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

async function dispatchRoastWithProvider(params: {
  ctx: Context;
  rKind: RoastType;
  arg3: string;
  bnet: string;
  provider: AiProviderDto;
}): Promise<void> {
  const { ctx, rKind, arg3, bnet, provider } = params;
  const chatId = Number(ctx.chat?.id || ctx.from?.id || 0);
  const { tgId } = getTgUserMeta(ctx);
  if (!chatId || !tgId) return;

  const mode: CnGameMode = arg3 === "leisure" ? "leisure" : "sport";
  const matchId = rKind === "match" ? arg3 : "";
  const cacheKey =
    rKind === "match"
      ? `match:${matchId}:${bnet}:p${provider.id}`
      : `${rKind}:${mode}:${bnet}:p${provider.id}`;

  const cachedHtml = await getRoastCache(cacheKey, rKind);
  if (cachedHtml) {
    const ttlHint =
      rKind === "match" ? "单局永久缓存复用" : "24小时内缓存复用";
    await ctx.reply(
      `${cachedHtml}\n\n<i>♻️ 已命中${ttlHint}（未扣减次数）</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const auth = await authorizeRoastForCtx(ctx);

  const taskKey = `${tgId}:${rKind}:${arg3}:${bnet}:p${provider.id}`;
  if (inFlightRoastTasks.has(taskKey)) {
    await ctx.answerCallbackQuery({
      text: "⏳ 该锐评任务正在生成中，请勿重复点击！",
      show_alert: true,
    });
    return;
  }
  inFlightRoastTasks.add(taskKey);

  const execTarget =
    provider.executionTarget === "docker" ? "docker" : "vercel";
  const targetBadge =
    execTarget === "docker" ? "🐳 Docker 队列节点" : "⚡ Vercel 节点";

  let loadingMsg: { message_id: number };
  try {
    loadingMsg = await ctx.reply(
      `⏳ <b>已受理并开始生成${rKind === "mmr" ? "隐性段位评估" : rKind === "match" ? "单局锐评" : "个人赛季锐评"}</b>\n` +
        `🤖 模型渠道：<b>${escapeHtml(provider.name)}</b>（${targetBadge}）\n` +
        `🎯 目标战网：<code>${escapeHtml(bnet)}</code>\n` +
        `<i>${execTarget === "docker" ? "正在拉取数据并提交至 Docker 异步队列..." : "模型正在分析中，完成后将自动更新本条消息推送结果。"}</i>`,
      { parse_mode: "HTML" }
    );
  } catch (sendErr) {
    inFlightRoastTasks.delete(taskKey);
    throw sendErr;
  }

  const operatorNickname = getOperatorDisplayLabel(ctx);

  try {
    const searchRes = await searchBnetAccount(bnet);
    const player = extractPlayerFromSearch(bnet, searchRes);
    let snapshotText = "";
    let currentRankLabel = "";

    if (rKind !== "match") {
      const built = await buildCnOverviewView(player.bnet, mode, false);
      snapshotText = built.snapshotText;
      currentRankLabel = built.currentRankLabel;
    }

    if (execTarget === "docker") {
      await enqueueDockerRoastTask({
        ctx,
        chatId,
        messageId: loadingMsg.message_id,
        taskKey,
        rKind,
        bnet: player.bnet,
        mode,
        snapshotText,
        currentRankLabel,
        matchId,
        customerToken: player.customerToken,
        operatorNickname,
        provider,
        unlimited: auth.unlimited,
        cacheKey,
      });
    } else {
      await runVercelRoastTask({
        ctx,
        chatId,
        messageId: loadingMsg.message_id,
        taskKey,
        rKind,
        bnet: player.bnet,
        mode,
        snapshotText,
        currentRankLabel,
        matchId,
        customerToken: player.customerToken,
        operatorNickname,
        provider,
        unlimited: auth.unlimited,
        cacheKey,
      });
    }
  } catch (err) {
    inFlightRoastTasks.delete(taskKey);
    const errMsg =
      err instanceof DashenError || err instanceof RelayServiceError
        ? err.message
        : err instanceof Error
          ? escapeHtml(err.message)
          : "锐评准备阶段发生异常";
    await ctx.api
      .editMessageText(
        chatId,
        loadingMsg.message_id,
        `❌ <b>锐评任务启动失败（未扣减次数）：</b>\n${errMsg}`,
        { parse_mode: "HTML" }
      )
      .catch(() => {});
  }
}

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data || "";
  const tgId = Number(ctx.from?.id || 0);

  try {
    if (data === "u:checkin") {
      await ctx.answerCallbackQuery();
      await handleCheckinCommand(ctx);
      return;
    }

    if (data === "u:redeem_prompt") {
      await ctx.answerCallbackQuery();
      if (tgId > 0) {
        pendingUserInputs.set(tgId, {
          action: { type: "redeem_input" },
          expiresAt: Date.now() + 2 * 60 * 1000,
        });
      }
      await ctx.reply(
        `🎟 <b>请输入你要兑换的卡密编号：</b>\n<i>（例如：<code>OW2C-5-XXXXXXXX</code>）</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "u:copy_invite") {
      await ctx.answerCallbackQuery();
      const botUsername = await resolveBotUsernameForCtx(ctx);
      const link = buildInviteLink(tgId, botUsername);
      await ctx.reply(
        `🔗 <b>你的专属邀请链接：</b>\n<code>${escapeHtml(link)}</code>\n<i>好友通过该链接首次启动机器人后，你将自动获得邀请奖励次数！</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "u:refresh") {
      await ctx.answerCallbackQuery({ text: "已刷新个人状态" });
      const botUsername = await resolveBotUsernameForCtx(ctx);
      const regRes = await ensureUserRegistered(ctx);
      if (regRes.user && ctx.callbackQuery.message) {
        const view = buildUserCenterView(
          regRes.user,
          regRes.settings,
          botUsername
        );
        await ctx.editMessageText(view.text, {
          parse_mode: "HTML",
          reply_markup: view.keyboard,
        });
      }
      return;
    }

    if (data === "u:open_admin") {
      await ctx.answerCallbackQuery();
      await renderAdminHomePanel(ctx, false);
      return;
    }

    if (data.startsWith("cn:sw:")) {
      await ctx.answerCallbackQuery({ text: "正在切换模式..." });
      const rest = data.slice("cn:sw:".length);
      const sepIdx = rest.indexOf(":");
      const mode = (rest.slice(0, sepIdx) as CnGameMode) || "sport";
      const bnet = rest.slice(sepIdx + 1);
      await executeCnOverviewQuery(ctx, `${bnet} ${mode}`, true);
      return;
    }

    if (data.startsWith("cn:ml:")) {
      await ctx.answerCallbackQuery({ text: "正在加载战绩流水..." });
      const parts = data.split(":");
      const mode = (parts[2] as CnGameMode) || "sport";
      const page = Math.max(1, Number(parts[3] || 1));
      const bnet = parts.slice(4).join(":");
      await executeCnMatchListQuery(ctx, `${bnet} ${mode}`, page, true);
      return;
    }

    if (data.startsWith("cn:md:")) {
      await ctx.answerCallbackQuery({ text: "正在加载对局详情..." });
      const parts = data.split(":");
      const idx = Number(parts[2] || 0);
      const bnet = parts.slice(3).join(":");
      const matchIds = userRecentMatchIds.get(tgId) || [];
      const matchId = matchIds[idx];
      if (!matchId) {
        await ctx.reply(
          "⚠️ 对局列表已过期，请重新发送 <code>/match 战网ID</code> 获取最新列表。",
          { parse_mode: "HTML" }
        );
        return;
      }
      const searchRes = await searchBnetAccount(bnet);
      const player = extractPlayerFromSearch(bnet, searchRes);
      const { text, keyboard } = await buildCnMatchDetailView(
        player.bnet,
        player.customerToken,
        matchId
      );
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return;
    }

    if (data.startsWith("cn:r:")) {
      const parts = data.split(":");
      const rKind = (parts[2] as RoastType) || "self";
      const arg3 = parts[3] || "sport";
      const bnet = parts.slice(4).join(":");

      const providers = await fetchActiveAiProviders();
      if (providers.length === 0) {
        await ctx.answerCallbackQuery({
          text: "⚠️ 暂无已启用的 AI 锐评渠道，请联系管理员开启。",
          show_alert: true,
        });
        return;
      }

      if (providers.length === 1) {
        await ctx.answerCallbackQuery();
        await dispatchRoastWithProvider({
          ctx,
          rKind,
          arg3,
          bnet,
          provider: providers[0],
        });
        return;
      }

      await ctx.answerCallbackQuery({ text: "请选择 AI 锐评渠道" });
      const selectKb = buildRoastProviderSelectKeyboard(
        rKind,
        arg3,
        bnet,
        providers
      );
      await ctx.editMessageReplyMarkup({ reply_markup: selectKb });
      return;
    }

    if (data.startsWith("cn:rc:")) {
      await ctx.answerCallbackQuery({ text: "已取消选择" });
      const parts = data.split(":");
      const rKind = (parts[2] as RoastType) || "self";
      const arg3 = parts[3] || "sport";
      const bnet = parts.slice(4).join(":");
      const isAdmin = await resolveIsActiveAdminForCtx(ctx);

      const restoredKb =
        rKind === "match"
          ? buildCnMatchDetailKeyboard(bnet, arg3)
          : buildCnOverviewKeyboard(
              bnet,
              arg3 === "leisure" ? "leisure" : "sport",
              isAdmin
            );
      await ctx.editMessageReplyMarkup({ reply_markup: restoredKb });
      return;
    }

    if (data.startsWith("cn:rp:")) {
      const parts = data.split(":");
      const providerId = Number(parts[2] ?? 0);
      const rKind = (parts[3] as RoastType) || "self";
      const arg3 = parts[4] || "sport";
      const bnet = parts.slice(5).join(":");

      const providers = await fetchActiveAiProviders();
      const chosen = providers.find((p) => p.id === providerId);
      if (!chosen) {
        await ctx.answerCallbackQuery({
          text: "⚠️ 该 AI 渠道已关闭或不存在，请重新选择。",
          show_alert: true,
        });
        return;
      }

      const isAdmin = await resolveIsActiveAdminForCtx(ctx);
      const restoredKb =
        rKind === "match"
          ? buildCnMatchDetailKeyboard(bnet, arg3)
          : buildCnOverviewKeyboard(
              bnet,
              arg3 === "leisure" ? "leisure" : "sport",
              isAdmin
            );
      await ctx.editMessageReplyMarkup({ reply_markup: restoredKb }).catch(() => {});

      await ctx.answerCallbackQuery();
      await dispatchRoastWithProvider({
        ctx,
        rKind,
        arg3,
        bnet,
        provider: chosen,
      });
      return;
    }

    if (data === "ad:home") {
      await ctx.answerCallbackQuery();
      await renderAdminHomePanel(ctx, true);
      return;
    }

    if (data === "ad:user_q") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_user_query" },
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      await ctx.reply(
        `👤 <b>请输入要查询的用户 TG ID 或 @用户名</b>（输入 <code>all</code> 查看最近 20 位用户）：`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "ad:q_add") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_quota_add" },
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      await ctx.reply(
        `➕ <b>添加锐评次数</b>\n请按格式发送：<code>目标TG_ID 增加次数 原因</code>\n示例：<code>612158982 10 活动补偿</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "ad:q_sub") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_quota_deduct" },
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      await ctx.reply(
        `➖ <b>减少锐评次数</b>\n请按格式发送：<code>目标TG_ID 减少次数 原因</code>\n示例：<code>612158982 2 误发回收</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "ad:vip") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_vip_manage" },
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      await ctx.reply(
        `👑 <b>VIP 会员管理</b>\n• 开通/续期：<code>grant 目标TG_ID 天数 原因</code>（如 <code>grant 612158982 30 月卡开通</code>）\n• 取消 VIP：<code>revoke 目标TG_ID 原因</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "ad:ban") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_user_ban" },
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      await ctx.reply(
        `🚫 <b>封禁 / 解封用户</b>\n• 封禁：<code>ban 目标TG_ID 原因</code>\n• 解封：<code>unban 目标TG_ID 原因</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "ad:rc_new") {
      await ctx.answerCallbackQuery();
      const kb = new InlineKeyboard()
        .text("⚡ 生成次数卡密", "ad:rc_type:quota")
        .text("👑 生成 VIP 天数卡密", "ad:rc_type:vip_days");
      await ctx.reply(`🎟 <b>请选择要生成的卡密类型：</b>`, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
      return;
    }

    if (data.startsWith("ad:rc_type:")) {
      await ctx.answerCallbackQuery();
      const rType = data.endsWith("vip_days") ? "vip_days" : "quota";
      pendingUserInputs.set(tgId, {
        action: { type: "admin_redeem_create", rewardType: rType },
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      await ctx.reply(
        rType === "vip_days"
          ? `👑 请输入：<code>VIP天数 生成数量</code>（例如：<code>30 5</code>）`
          : `⚡ 请输入：<code>锐评次数 生成数量</code>（例如：<code>10 5</code>）`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "ad:rc_view") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_redeem_view" },
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      await ctx.reply(`🔍 请输入要查询的卡密编号：`, { parse_mode: "HTML" });
      return;
    }

    if (data === "ad:rc_void") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "admin_redeem_void" },
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      await ctx.reply(
        `🗑 请输入要作废的卡密编号与原因：<code>卡密编号 作废原因</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data === "ad:stats") {
      await ctx.answerCallbackQuery();
      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "GET",
        "/internal/admin/stats",
        { operatorId: tgId }
      );
      const s = res.data;
      const lines = [
        `📊 <b>运营数据统计（${escapeHtml(s.today)}）</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `👥 总注册用户：<b>${s.totalUsers}</b> 人（今日新增 <b>+${s.todayNewUsers}</b>）`,
        `📅 今日签到人数：<b>${s.todayCheckins}</b> 人`,
        `👑 有效 VIP 会员：<b>${s.activeVips}</b> 人`,
        `⚡ 今日普通用户锐评消耗：<b>${s.todayTotalRoasts}</b> 次（免费额度 ${s.todayFreeRoasts} / 充值卡密 ${s.todayPaidRoasts}）`,
        `🎟 未使用卡密库存：<b>${s.unusedRedeemCodes}</b> 张`,
      ];
      await ctx.editMessageText(lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🔙 返回管理主页", "ad:home"),
      });
      return;
    }

    if (data === "ad:ai_list") {
      await ctx.answerCallbackQuery();
      await renderAiProvidersPanel(ctx, true);
      return;
    }

    if (data === "ad:ds_list") {
      await ctx.answerCallbackQuery();
      await renderDashenAccountsPanel(ctx, true);
      return;
    }

    if (data === "ad:ds_add") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "super_dashen_account_add" },
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      await ctx.reply(
        `➕ <b>新增网易大神轮询账号</b>\n` +
          `请直接粘贴抓包复制的<strong>整段请求头文本</strong>（可选首行写 <code>备注: 小号名称</code>）：\n` +
          `• 自动提取 <code>GL-Bigdata-Auth-Token</code>、<code>GL-Bigdata-Role-Id</code>、<code>GL-Bigdata-Dts</code>、<code>GL-Bigdata-Server</code>、<code>GL-ClientType</code>、<code>Origin</code>、<code>Referer</code>、<code>User-Agent</code>\n` +
          `• <b>不会存储 Cookie</b>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data.startsWith("ad:ds_edit:")) {
      await ctx.answerCallbackQuery();
      const accountId = Number(data.split(":")[2] || 0);
      pendingUserInputs.set(tgId, {
        action: { type: "super_dashen_account_edit", accountId },
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      await ctx.reply(
        `✏️ <b>修改大神轮询账号 #${accountId}</b>\n` +
          `请粘贴新的<strong>整段请求头文本</strong>（可选首行写 <code>备注: 新名称</code>），机器人将自动提取覆盖该账号参数。`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data.startsWith("ad:ds_tog:")) {
      const parts = data.split(":");
      const accountId = Number(parts[2] ?? 0);
      const enabled = parts[3] === "1";
      await relayInternalRequest("POST", "/internal/admin/dashen-accounts/toggle", {
        operatorId: tgId,
        json: { accountId, enabled },
      });
      await ctx.answerCallbackQuery({
        text: enabled ? "✅ 已启用轮询账号" : "⏸ 已停用轮询账号",
      });
      await renderDashenAccountsPanel(ctx, true);
      return;
    }

    if (data.startsWith("ad:ds_del:")) {
      const accountId = Number(data.split(":")[2] ?? 0);
      await relayInternalRequest("DELETE", "/internal/admin/dashen-accounts", {
        operatorId: tgId,
        params: { accountId },
      });
      await ctx.answerCallbackQuery({ text: "🗑 已删除轮询账号" });
      await renderDashenAccountsPanel(ctx, true);
      return;
    }

    if (data.startsWith("ad:ai_tog:")) {
      const parts = data.split(":");
      const pid = Number(parts[2] ?? 0);
      const enabled = parts[3] === "1";
      await relayInternalRequest("POST", "/internal/admin/ai-providers/toggle", {
        operatorId: tgId,
        json: { providerId: pid, enabled },
      });
      await ctx.answerCallbackQuery({
        text: enabled ? "✅ 已开启渠道" : "🔴 已关闭渠道",
      });
      await renderAiProvidersPanel(ctx, true);
      return;
    }

    if (data.startsWith("ad:ai_tgt:")) {
      const parts = data.split(":");
      const pid = Number(parts[2] ?? 0);
      const nextTarget = parts[3] === "docker" ? "docker" : "vercel";
      await relayInternalRequest("POST", "/internal/admin/ai-providers/target", {
        operatorId: tgId,
        json: { providerId: pid, executionTarget: nextTarget },
      });
      await ctx.answerCallbackQuery({
        text:
          nextTarget === "docker"
            ? "🐳 已切换至 Docker 异步队列 (120s)"
            : "⚡ 已切换至 Vercel 节点",
      });
      await renderAiProvidersPanel(ctx, true);
      return;
    }

    if (data.startsWith("ad:ai_del:")) {
      const pid = Number(data.split(":")[2] ?? 0);
      await relayInternalRequest("DELETE", "/internal/admin/ai-providers", {
        operatorId: tgId,
        params: { providerId: pid },
      });
      await ctx.answerCallbackQuery({ text: "🗑 已删除该 AI 渠道" });
      await renderAiProvidersPanel(ctx, true);
      return;
    }

    if (data === "ad:settings") {
      await ctx.answerCallbackQuery();
      const res = await relayInternalRequest<{
        ok: boolean;
        data: SystemSettingsDto;
      }>("GET", "/internal/admin/settings", { operatorId: tgId });
      const s = res.data;
      const lines = [
        `⚙️ <b>系统与赠送规则设置（仅超管）</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        `🚦 运行状态：<b>${s.botStatus === "maintenance" ? "🛠 维护中（仅管理员可用）" : "✅ 正常运行"}</b>`,
        `🎁 新注册赠送：<b>${s.registerRewardEnabled ? `开启（+${s.registerRewardQuota} 次）` : "关闭"}</b>`,
        `🤝 邀请好友赠送：<b>${s.inviteRewardEnabled ? `开启（+${s.inviteRewardQuota} 次）` : "关闭"}</b>`,
        `📅 每日签到赠送：<b>${s.checkinRewardEnabled ? `开启（+${s.checkinRewardQuota} 次）` : "关闭"}</b>`,
      ];
      const kb = new InlineKeyboard()
        .text(
          s.botStatus === "maintenance" ? "✅ 切为正常模式" : "🛠 切为维护模式",
          `ad:set_status:${s.botStatus === "maintenance" ? "normal" : "maintenance"}`
        )
        .row()
        .text(
          s.registerRewardEnabled ? "🔴 关注册送" : "🟢 开注册送",
          `ad:set_flag:reg:${s.registerRewardEnabled ? 0 : 1}`
        )
        .text("✏️ 改注册次数", "ad:set_num:reg")
        .row()
        .text(
          s.inviteRewardEnabled ? "🔴 关邀请送" : "🟢 开邀请送",
          `ad:set_flag:inv:${s.inviteRewardEnabled ? 0 : 1}`
        )
        .text("✏️ 改邀请次数", "ad:set_num:inv")
        .row()
        .text(
          s.checkinRewardEnabled ? "🔴 关签到送" : "🟢 开签到送",
          `ad:set_flag:chk:${s.checkinRewardEnabled ? 0 : 1}`
        )
        .text("✏️ 改签到次数", "ad:set_num:chk")
        .row()
        .text("🔙 返回管理主页", "ad:home");

      await ctx.editMessageText(lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup: kb,
      });
      return;
    }

    if (data.startsWith("ad:set_status:")) {
      const nextStatus = data.endsWith("maintenance") ? "maintenance" : "normal";
      await relayInternalRequest("POST", "/internal/admin/settings", {
        operatorId: tgId,
        json: { botStatus: nextStatus },
      });
      await ctx.answerCallbackQuery({ text: "系统运行状态已更新" });
      await renderAdminHomePanel(ctx, true);
      return;
    }

    if (data.startsWith("ad:set_flag:")) {
      const parts = data.split(":");
      const key = parts[2];
      const val = parts[3] === "1";
      const patch: Record<string, any> = {};
      if (key === "reg") patch.registerRewardEnabled = val;
      if (key === "inv") patch.inviteRewardEnabled = val;
      if (key === "chk") patch.checkinRewardEnabled = val;
      await relayInternalRequest("POST", "/internal/admin/settings", {
        operatorId: tgId,
        json: patch,
      });
      await ctx.answerCallbackQuery({ text: "赠送开关已更新" });
      await renderAdminHomePanel(ctx, true);
      return;
    }

    if (data.startsWith("ad:set_num:")) {
      await ctx.answerCallbackQuery();
      const key = data.split(":")[2];
      const actionType =
        key === "reg"
          ? "super_setting_reg_quota"
          : key === "inv"
            ? "super_setting_inv_quota"
            : "super_setting_chk_quota";
      pendingUserInputs.set(tgId, {
        action: { type: actionType },
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      await ctx.reply(`✏️ 请输入新的赠送次数（0 ~ 10000 之间的整数）：`, {
        parse_mode: "HTML",
      });
      return;
    }

    if (data === "ad:admins") {
      await ctx.answerCallbackQuery();
      const res = await relayInternalRequest<{
        ok: boolean;
        data: { admins: AdminMeDto[] };
      }>("GET", "/internal/admin/admins", { operatorId: tgId });
      const admins = res.data?.admins || [];
      const lines = [
        `👮 <b>分级管理员列表（仅超管）</b>`,
        `━━━━━━━━━━━━━━━━━━`,
      ];
      const kb = new InlineKeyboard();
      for (const a of admins) {
        lines.push(
          `• <b>${escapeHtml(a.remark || "管理员")}</b>（<code>${a.tgId}</code>）— ${a.role === "super_admin" ? "👑 超管" : a.isActive ? "✅ 启用" : "⏸ 停用"}`
        );
        if (a.role !== "super_admin") {
          kb.text(`🔑 权限 #${a.tgId}`, `ad:adm_p:${a.tgId}`)
            .text(
              a.isActive ? "⏸ 停用" : "▶️ 启用",
              `ad:adm_t:${a.tgId}:${a.isActive ? 0 : 1}`
            )
            .text("🗑 删除", `ad:adm_d:${a.tgId}`)
            .row();
        }
      }
      kb.text("➕ 添加普通管理员", "ad:adm_add").text("🔙 返回主页", "ad:home");
      await ctx.editMessageText(lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup: kb,
      });
      return;
    }

    if (data === "ad:adm_add") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "super_admin_add" },
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      await ctx.reply(
        `➕ 请输入：<code>目标TG_ID 备注名称</code>（例如：<code>123456789 客服小王</code>）`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (data.startsWith("ad:adm_p:")) {
      await ctx.answerCallbackQuery();
      const targetId = Number(data.split(":")[2] || 0);
      const res = await relayInternalRequest<{
        ok: boolean;
        data: {
          admins: AdminMeDto[];
          allPermissions: string[];
          permissionLabels: Record<string, string>;
        };
      }>("GET", "/internal/admin/admins", { operatorId: tgId });
      const target = res.data.admins.find((a) => a.tgId === targetId);
      if (!target) return;
      const owned = new Set(target.permissions || []);
      const kb = new InlineKeyboard();
      (res.data.allPermissions || []).forEach((p, idx) => {
        const label = res.data.permissionLabels?.[p] || p;
        kb.text(
          `${owned.has(p) ? "✅" : "⬜"} ${label}`,
          `ad:adm_pt:${targetId}:${p}`
        );
        if (idx % 2 === 1) kb.row();
      });
      kb.row().text("🔙 返回管理员列表", "ad:admins");
      await ctx.editMessageText(
        `🔑 <b>编辑管理员权限 — ${escapeHtml(target.remark)}（<code>${targetId}</code>）</b>\n点击下方按钮可实时开关对应权限：`,
        { parse_mode: "HTML", reply_markup: kb }
      );
      return;
    }

    if (data.startsWith("ad:adm_pt:")) {
      const parts = data.split(":");
      const targetId = Number(parts[2] || 0);
      const permCode = parts.slice(3).join(":");
      await relayInternalRequest("POST", "/internal/admin/admins/permission", {
        operatorId: tgId,
        json: { targetTgId: targetId, permCode },
      });
      await ctx.answerCallbackQuery({ text: "权限已更新" });
      await renderAdminHomePanel(ctx, true);
      return;
    }

    if (data.startsWith("ad:adm_t:")) {
      const parts = data.split(":");
      const targetId = Number(parts[2] || 0);
      const isActive = parts[3] === "1";
      await relayInternalRequest("POST", "/internal/admin/admins/meta", {
        operatorId: tgId,
        json: { targetTgId: targetId, isActive },
      });
      await ctx.answerCallbackQuery({ text: isActive ? "已启用" : "已停用" });
      await renderAdminHomePanel(ctx, true);
      return;
    }

    if (data.startsWith("ad:adm_d:")) {
      const targetId = Number(data.split(":")[2] || 0);
      await relayInternalRequest("DELETE", "/internal/admin/admins", {
        operatorId: tgId,
        params: { targetTgId: targetId },
      });
      await ctx.answerCallbackQuery({ text: "已删除普通管理员" });
      await renderAdminHomePanel(ctx, true);
      return;
    }

    if (data.startsWith("ad:logs:")) {
      await ctx.answerCallbackQuery();
      const page = Math.max(1, Number(data.split(":")[2] || 1));
      const res = await relayInternalRequest<{
        ok: boolean;
        data: {
          page: number;
          totalPages: number;
          total: number;
          items: Array<{
            id: number;
            operatorNickname: string;
            action: string;
            targetId: string;
            detail: string;
            createdAt: string;
          }>;
        };
      }>("GET", "/internal/admin/audit-logs", {
        operatorId: tgId,
        params: { page, pageSize: 8 },
      });
      const d = res.data;
      const lines = [
        `📜 <b>操作审计日志（第 ${d.page}/${d.totalPages} 页 · 共 ${d.total} 条）</b>`,
        `━━━━━━━━━━━━━━━━━━`,
      ];
      for (const item of d.items || []) {
        lines.push(
          `• <code>${escapeHtml(item.createdAt)}</code> | 操作人 <b>${escapeHtml(item.operatorNickname || "未知昵称")}</b>`
        );
        lines.push(
          `   动作：<code>${escapeHtml(item.action)}</code>${item.targetId ? ` · 目标 <code>${escapeHtml(item.targetId)}</code>` : ""}`
        );
        if (item.detail) {
          lines.push(`   说明：${escapeHtml(item.detail)}`);
        }
      }
      const kb = new InlineKeyboard();
      if (d.page > 1) kb.text("⬅️ 上一页", `ad:logs:${d.page - 1}`);
      if (d.page < d.totalPages) kb.text("➡️ 下一页", `ad:logs:${d.page + 1}`);
      kb.row().text("🔙 返回管理主页", "ad:home");
      await ctx.editMessageText(lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup: kb,
      });
      return;
    }

    await ctx.answerCallbackQuery();
  } catch (err) {
    console.error("[Callback Query Error]", { data, err });
    const msg =
      err instanceof DashenError || err instanceof RelayServiceError
        ? err.message
        : err instanceof Error
          ? escapeHtml(err.message)
          : "❌ 操作执行失败，请稍后重试。";
    await ctx
      .answerCallbackQuery({
        text: msg.replace(/<[^>]+>/g, "").slice(0, 180),
        show_alert: true,
      })
      .catch(() => {});
  }
});

bot.on("message:text", async (ctx, next) => {
  const text = String(ctx.message.text || "").trim();
  if (!text || text.startsWith("/")) {
    return next();
  }

  const tgId = Number(ctx.from?.id || 0);
  if (!tgId) return next();

  const pending = pendingUserInputs.get(tgId);
  if (!pending) {
    if (ctx.chat.type === "private" && /^\S+[#＃]\d+$/.test(text)) {
      try {
        await executeCnOverviewQuery(ctx, text, false);
      } catch (err) {
        const msg =
          err instanceof DashenError || err instanceof RelayServiceError
            ? err.message
            : "❌ 查询国服战绩失败，请稍后重试。";
        await ctx.reply(msg, { parse_mode: "HTML" });
      }
      return;
    }
    return next();
  }

  if (Date.now() > pending.expiresAt) {
    pendingUserInputs.delete(tgId);
    return next();
  }

  pendingUserInputs.delete(tgId);
  const act = pending.action;

  try {
    if (act.type === "redeem_input") {
      await executeRedeemCode(ctx, text);
      return;
    }

    if (act.type === "cn_query_input") {
      await executeCnOverviewQuery(ctx, text, false);
      return;
    }

    if (act.type === "match_query_input") {
      await executeCnMatchListQuery(ctx, text, 1, false);
      return;
    }

    if (act.type === "admin_user_query") {
      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "GET",
        "/internal/admin/user",
        { operatorId: tgId, params: { query: text } }
      );
      const d = res.data;
      if (d.isList) {
        const lines = [
          `👥 <b>用户列表（总计 ${d.totalUsers} 人，展示最近 ${d.users.length} 人）</b>`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        for (const u of d.users) {
          lines.push(
            `• <b>${escapeHtml(u.nickname || "玩家")}</b>（<code>${u.tgId}</code>）| 余额 <b>${u.quota}</b> 次${u.vipActive ? " | 👑VIP" : ""}${u.isBanned ? " | 🚫封禁" : ""}`
          );
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      } else {
        const u = d.user;
        await ctx.reply(
          `👤 <b>用户详情</b>\n` +
            `昵称：<b>${escapeHtml(u.nickname || "玩家")}</b>（<code>${u.tgId}</code>）\n` +
            `剩余次数：<b>${u.quota}</b> 次  |  VIP：${u.vipActive ? `有效至 ${escapeHtml(u.vipExpireAt || "")}` : "未开通"}\n` +
            `邀请人数：<b>${u.inviteCount}</b> 人  |  状态：${u.isBanned ? "🚫 已封禁" : "✅ 正常"}`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    if (act.type === "admin_quota_add") {
      const [idStr, amtStr, ...reasonParts] = text.split(/\s+/);
      const targetTgId = Number(idStr);
      const amount = Number(amtStr);
      const reason = reasonParts.join(" ").trim();
      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/quota/add",
        {
          operatorId: tgId,
          json: { targetTgId, amount, reason },
        }
      );
      const d = res.data;
      const pushed = await notifyUserBenefitActivated(
        bot,
        targetTgId,
        `🎉 <b>权益已生效</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `⚡ <b>到账权益：</b>AI 锐评次数 <b>+${d.added}</b> 次\n` +
          `📊 <b>当前剩余：</b><b>${d.afterQuota}</b> 次\n` +
          `📝 <b>发放说明：</b>${escapeHtml(d.reason)}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `<i>现在即可前往查询国服战绩并体验 AI 锐评功能！</i>`
      );
      await ctx.reply(
        `✅ <b>添加锐评次数成功</b>\n` +
          `🎯 目标用户：<code>${targetTgId}</code>\n` +
          `📈 变动详情：${d.beforeQuota} → <b>${d.afterQuota}</b> 次（+${d.added}）\n` +
          `📩 用户通知：${pushed ? "已推送送达" : "发送失败（对方可能未私聊启动或已屏蔽机器人，但权益已正常入库）"}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (act.type === "admin_quota_deduct") {
      const [idStr, amtStr, ...reasonParts] = text.split(/\s+/);
      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/quota/deduct",
        {
          operatorId: tgId,
          json: {
            targetTgId: Number(idStr),
            amount: Number(amtStr),
            reason: reasonParts.join(" ").trim(),
          },
        }
      );
      const d = res.data;
      await ctx.reply(
        `✅ <b>扣减锐评次数成功</b>\n🎯 目标用户：<code>${d.tgId}</code>\n📉 变动详情：${d.beforeQuota} → <b>${d.afterQuota}</b> 次（-${d.deducted}）`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (act.type === "admin_vip_manage") {
      const tokens = text.split(/\s+/);
      const actionType = String(tokens[0] || "").toLowerCase();
      const targetTgId = Number(tokens[1] || 0);
      const days = actionType === "grant" ? Number(tokens[2] || 0) : 0;
      const reason =
        actionType === "grant"
          ? tokens.slice(3).join(" ").trim()
          : tokens.slice(2).join(" ").trim();

      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/vip",
        {
          operatorId: tgId,
          json: { targetTgId, actionType, days, reason },
        }
      );
      const d = res.data;
      if (actionType === "grant") {
        const pushed = await notifyUserBenefitActivated(
          bot,
          targetTgId,
          `🎉 <b>权益已生效</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👑 <b>到账权益：</b>VIP 会员（<b>+${days}</b> 天 · AI 锐评无限制）\n` +
            `⏳ <b>到期时间：</b><b>${escapeHtml(d.afterVip || "")}</b>（北京时间）\n` +
            `📝 <b>发放说明：</b>${escapeHtml(d.reason)}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `<i>VIP 有效期内使用所有 AI 锐评均免扣次数，祝你上分愉快！</i>`
        );
        await ctx.reply(
          `✅ <b>VIP 开通/续期成功</b>\n` +
            `🎯 目标用户：<code>${targetTgId}</code>\n` +
            `⏳ 最新到期时间：<b>${escapeHtml(d.afterVip || "")}</b>\n` +
            `📩 用户通知：${pushed ? "已推送送达" : "发送失败（对方可能未私聊启动或已屏蔽机器人，但权益已正常入库）"}`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(
          `✅ <b>已取消用户 <code>${targetTgId}</code> 的 VIP 会员资格。</b>`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    if (act.type === "admin_user_ban") {
      const [modeTok, idStr, ...reasonParts] = text.split(/\s+/);
      const banned = modeTok.toLowerCase() !== "unban";
      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/user/ban",
        {
          operatorId: tgId,
          json: {
            targetTgId: Number(idStr),
            banned,
            reason: reasonParts.join(" ").trim(),
          },
        }
      );
      await ctx.reply(
        `✅ <b>已${res.data.isBanned ? "封禁" : "解封"}用户 <code>${res.data.tgId}</code></b>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (act.type === "admin_redeem_create") {
      const [valStr, cntStr] = text.split(/\s+/);
      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/redeem/create",
        {
          operatorId: tgId,
          json: {
            rewardType: act.rewardType,
            rewardValue: Number(valStr),
            count: Number(cntStr || 1),
          },
        }
      );
      const d = res.data;
      const codeLines = (d.codes as string[]).map((c) => `<code>${c}</code>`);
      await ctx.reply(
        `🎟 <b>成功生成 ${d.count} 张${d.rewardType === "vip_days" ? `VIP ${d.rewardValue} 天` : `${d.rewardValue} 次锐评`}卡密：</b>\n${codeLines.join("\n")}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (act.type === "admin_redeem_view") {
      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "GET",
        "/internal/admin/redeem/view",
        { operatorId: tgId, params: { code: text } }
      );
      const c = res.data;
      await ctx.reply(
        `🔍 <b>卡密详情：<code>${escapeHtml(c.code)}</code></b>\n` +
          `类型：${c.rewardType === "vip_days" ? `VIP ${c.rewardValue} 天` : `${c.rewardValue} 次锐评`}  |  状态：<b>${escapeHtml(c.status)}</b>\n` +
          `${c.usedBy ? `核销人：<code>${c.usedBy}</code>（${escapeHtml(c.usedAt || "")}）` : ""}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (act.type === "admin_redeem_void") {
      const [codeStr, ...reasonParts] = text.split(/\s+/);
      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/redeem/void",
        {
          operatorId: tgId,
          json: {
            code: codeStr,
            reason: reasonParts.join(" ").trim(),
          },
        }
      );
      await ctx.reply(
        `🗑 <b>卡密 <code>${escapeHtml(res.data.code)}</code> 已成功作废。</b>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (act.type === "super_admin_add") {
      const [idStr, ...remarkParts] = text.split(/\s+/);
      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/admins",
        {
          operatorId: tgId,
          json: {
            targetTgId: Number(idStr),
            remark: remarkParts.join(" ").trim(),
          },
        }
      );
      await ctx.reply(
        `✅ <b>已添加普通管理员：${escapeHtml(res.data.remark)}（<code>${res.data.tgId}</code>）</b>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (
      act.type === "super_setting_reg_quota" ||
      act.type === "super_setting_inv_quota" ||
      act.type === "super_setting_chk_quota"
    ) {
      const num = Number(text);
      const patch: Record<string, any> = {};
      if (act.type === "super_setting_reg_quota")
        patch.registerRewardQuota = num;
      if (act.type === "super_setting_inv_quota") patch.inviteRewardQuota = num;
      if (act.type === "super_setting_chk_quota") patch.checkinRewardQuota = num;
      await relayInternalRequest("POST", "/internal/admin/settings", {
        operatorId: tgId,
        json: patch,
      });
      await ctx.reply(`✅ <b>赠送次数已更新为 ${num} 次。</b>`, {
        parse_mode: "HTML",
      });
      return;
    }

    if (act.type === "super_ai_provider_add") {
      const tokens = text.split(/\s+/);
      if (tokens.length < 4) {
        await ctx.reply(
          "⚠️ 格式不完整，请至少提供：<code>渠道名称 接口地址 API_Key 模型标识</code>",
          { parse_mode: "HTML" }
        );
        return;
      }
      const [name, baseUrl, apiKey, model, rawTarget] = tokens;
      const executionTarget =
        String(rawTarget || "vercel").trim().toLowerCase() === "docker"
          ? "docker"
          : "vercel";
      const res = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/ai-providers",
        {
          operatorId: tgId,
          json: {
            name,
            baseUrl,
            apiKey,
            model,
            executionTarget,
            isEnabled: true,
          },
        }
      );
      const d = res.data;
      await ctx.reply(
        `✅ <b>已成功新增并启用 AI 锐评渠道</b>\n` +
          `• 名称：<b>${escapeHtml(d.name)}</b>（ID #${d.id}）\n` +
          `• 模型：<code>${escapeHtml(d.model)}</code>\n` +
          `• 执行节点：<b>${d.executionTarget === "docker" ? "🐳 Docker 异步队列 (120s)" : "⚡ Vercel 节点"}</b>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (
      act.type === "super_dashen_account_add" ||
      act.type === "super_dashen_account_edit"
    ) {
      const parsedRes = parseRawDashenHeadersInput(text);
      if (!parsedRes.ok || !parsedRes.parsed) {
        await ctx.reply(
          `❌ <b>请求头解析失败：</b>\n${parsedRes.error || "参数不完整"}`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const payload: Record<string, any> = {
        ...parsedRes.parsed,
        isEnabled: true,
      };
      if (act.type === "super_dashen_account_edit") {
        payload.id = act.accountId;
      }

      const saveRes = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/dashen-accounts",
        {
          operatorId: tgId,
          json: payload,
        }
      );

      const d = saveRes.data;
      await ctx.reply(
        `✅ <b>已${act.type === "super_dashen_account_edit" ? "更新" : "新增"}网易大神轮询账号</b>\n` +
          `• 账号编号：<b>#${d.id}</b>\n` +
          `• 名称/备注：<b>${escapeHtml(parsedRes.parsed.name)}</b>\n` +
          `• Role ID：<code>${parsedRes.parsed.roleId}</code>\n` +
          `• ClientType：<code>${escapeHtml(parsedRes.parsed.clientType)}</code> | dts：<code>${parsedRes.parsed.dts}</code> | server：<code>${parsedRes.parsed.server}</code>\n` +
          `• User-Agent：已存储（<code>${escapeHtml(parsedRes.parsed.userAgent.slice(0, 42))}${parsedRes.parsed.userAgent.length > 42 ? "..." : ""}</code>）\n` +
          `• Cookie：<i>按方案未存储</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }
  } catch (err) {
    const msg =
      err instanceof RelayServiceError || err instanceof DashenError
        ? err.message
        : err instanceof Error
          ? escapeHtml(err.message)
          : "❌ 操作失败，请检查输入格式后重试。";
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

// ============================================================================
// 8. Vercel Serverless HTTP 入口（含 Telegram Webhook 与 Docker 队列结果回推）
// ============================================================================

const telegramWebhookHandler = webhookCallback(bot, "http", {
  secretToken: WEBHOOK_SECRET || undefined,
  timeoutMilliseconds: 29_000,
});

async function readRawHttpJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawStr = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawStr) return {};
  return JSON.parse(rawStr);
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const reqUrl = new URL(
    req.url || "/api/bot",
    `http://${req.headers.host || "localhost"}`
  );
  const action = reqUrl.searchParams.get("action") || "";

  if (action === "docker_callback" && req.method === "POST") {
    if (RELAY_SECRET && req.headers["x-relay-secret"] !== RELAY_SECRET) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    try {
      const body = await readRawHttpJson(req);
      const result = await handleDockerQueueCallback(bot, body);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error("[Docker Callback Handler Error]", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
    return;
  }

  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: true,
        service: "ow2-cn-tg-bot",
        generatedAt: "2026-11-27 23:34:00",
        dockerCallbackEnabled: true,
      })
    );
    return;
  }

  await telegramWebhookHandler(req, res);
}
