/**
 * 《守望先锋 2》(OW2) 国服战绩查询 Telegram 机器人（完整独立部署版）
 * 运行环境：Vercel Serverless Functions (Node.js 20+ / TypeScript)
 * 机器人框架：grammY (Webhook 模式)
 * 数据来源：服务器反代 (https://ow.eyy8.top -> datamsapi.ds.163.com/v1/a19ld5tool)
 *         + 腾讯云中转与 MySQL 业务后端 (/internal/*)
 *         + DeepSeek AI 锐评
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
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@+/, "").trim();

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

// 指向腾讯云 Cloudflare Tunnel 暴露的 HTTPS 域名
const DASHEN_RELAY_ORIGIN =
  process.env.DASHEN_RELAY_ORIGIN?.replace(/\/+$/, "") || "https://ow.eyy8.top";
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
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || "25000");

const API_TIMEOUT_MS = 12_000;
const RELAY_TIMEOUT_MS = 12_000;

const DEFAULT_REGISTER_QUOTA = 3;
const CHECKIN_REWARD_QUOTA = 1;
const INVITE_REWARD_QUOTA = 1;

if (!BOT_TOKEN) {
  throw new Error("缺少环境变量 BOT_TOKEN，请在 Vercel 项目设置中配置。");
}

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
  "576460752303423700": "国王大道",
  "576460752303423845": "花村",
  "576460752303423876": "监测站：直布罗陀",
  "576460752303423956": "努巴尼",
  "576460752303423963": "沃斯卡娅工业区",
  "576460752303424175": "好莱坞",
  "576460752303424195": "多拉多",
  "576460752303424695": "尼泊尔",
  "576460752303424955": "66号公路",
  "576460752303425122": "漓江塔",
  "576460752303425133": "伊利奥斯",
  "576460752303425165": "艾兴瓦尔德",
  "576460752303425182": "绿洲城",
  "576460752303425366": "渣客镇",
  "576460752303425374": "暴雪世界",
  "576460752303425506": "釜山",
  "576460752303425649": "里阿尔托",
  "576460752303425848": "帕拉伊苏",
  "576460752303426116": "哈瓦那",
  "576460752303426283": "新皇后街",
  "576460752303426380": "中城",
  "576460752303426496": "多伦多",
  "576460752303426771": "铁坂",
  "576460752303426802": "南极半岛",
  "576460752303426878": "苏拉瓦萨",
  "576460752303426899": "埃斯佩兰萨",
  "576460752303427091": "新渣客城",
  "576460752303427264": "萨摩亚",
  "576460752303427628": "霓虹枢纽",
  "576460752303427927": "花冈",
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
// 3. 网易大神与腾讯云内部业务 HTTP 客户端
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
      "⚠️ 服务端尚未配置网易大神凭证（<code>DASHEN_ROLE_ID</code> / <code>DASHEN_TOKEN</code>），请先在 Vercel 环境变量中填写并重新部署。"
    );
  }
}

function buildAuthHeaders(operatorId?: number): Record<string, string> {
  const headers: Record<string, string> = {
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
  if (RELAY_SECRET) {
    headers["x-relay-secret"] = RELAY_SECRET;
  }
  if (operatorId && operatorId > 0) {
    headers["x-operator-id"] = String(operatorId);
  }
  return headers;
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
    console.error("[Relay Internal Request Error]", { method, path, err });
    throw new RelayServiceError(
      504,
      "⏳ 连接后端业务服务超时，请稍后再试。",
      "RELAY_TIMEOUT"
    );
  }

  const payload: any = await res.json().catch(() => null);
  if (!res.ok || !payload || payload.ok === false) {
    const errMsg =
      payload?.error ||
      payload?.message ||
      `后端业务服务请求失败 (HTTP ${res.status})`;
    throw new RelayServiceError(
      res.status,
      String(errMsg),
      String(payload?.code || "RELAY_FAILED")
    );
  }

  return payload as T;
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
        ? "⏳ 请求网易大神接口超时，请稍后重试。"
        : "🌐 网络异常，无法连接至网易大神接口。"
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new DashenError(
      response.status,
      "🔐 网易大神鉴权失败（HTTP 401/403），可能是 <code>DASHEN_TOKEN</code> 已过期，请重新登录网易大神网页版提取更新。"
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

async function searchBnetAccount(bnet: string): Promise<DashenResponse> {
  const normalized = bnet.replace("＃", "#").trim();
  if (SEARCH_BNET_METHOD === "GET") {
    return dashenRequest("GET", SEARCH_BNET_ACCOUNT_URL, {
      params: {
        token: DASHEN_TOKEN,
        roleId: DASHEN_ROLE_ID,
        dts: DASHEN_DTS,
        server: DASHEN_SERVER,
        [SEARCH_BNET_PARAM_KEY]: normalized,
      },
    });
  }
  return dashenRequest("POST", SEARCH_BNET_ACCOUNT_URL, {
    json: {
      token: DASHEN_TOKEN,
      roleId: DASHEN_ROLE_ID,
      dts: DASHEN_DTS,
      server: DASHEN_SERVER,
      [SEARCH_BNET_PARAM_KEY]: normalized,
    },
  });
}

async function queryCard(customerToken: string): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryCard`, {
    params: { token: customerToken },
  });
}

async function queryCountInfo(
  customerToken: string,
  gameMode: CnGameMode
): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryCountInfo`, {
    params: { gameMode, token: customerToken },
  });
}

async function queryMatchList(
  customerToken: string,
  gameMode: CnGameMode,
  page = 1
): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryMatchList`, {
    params: { token: customerToken, gameMode, page },
  });
}

async function queryMatchInfo(
  customerToken: string,
  matchId: string
): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryMatchInfo`, {
    params: { matchId, token: customerToken },
  });
}

// ============================================================================
// 4. 锐评缓存、计费扣次与系统维护状态封装
// ============================================================================

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
    if (res.hit && res.record?.reviewHtml) {
      return String(res.record.reviewHtml);
    }
  } catch (err) {
    console.warn("[Roast Cache Get Fallback]", { cacheKey, err });
  }
  return null;
}

async function setRoastCache(params: {
  cacheKey: string;
  roastType: RoastType;
  gameMode?: CnGameMode | "";
  bnet: string;
  matchId?: string;
  reviewHtml: string;
}): Promise<void> {
  try {
    await relayInternalRequest("POST", "/internal/roast/cache/set", {
      json: params,
    });
  } catch (err) {
    console.warn("[Roast Cache Set Fallback]", {
      cacheKey: params.cacheKey,
      err,
    });
  }
}

function getTgUserMeta(ctx: Context): {
  tgId: number;
  nickname: string;
  username: string;
} {
  const from = ctx.from;
  const tgId = Number(from?.id || 0);
  const nickname = [from?.first_name, from?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const username = String(from?.username || "").trim().replace(/^@+/, "");
  return { tgId, nickname, username };
}

function parseStartInvitePayload(rawMatch: string | undefined): number | null {
  const s = String(rawMatch || "").trim();
  const match = s.match(/^inv_(\d+)$/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function ensureUserRegistered(
  ctx: Context,
  inviterId: number | null = null
): Promise<{
  isNewUser: boolean;
  inviteRewardGranted: boolean;
  inviteRewardQuota: number;
  user: UserProfileDto | null;
  settings?: SystemSettingsDto;
}> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  if (!tgId || tgId <= 0) {
    return {
      isNewUser: false,
      inviteRewardGranted: false,
      inviteRewardQuota: 0,
      user: null,
    };
  }
  const res = await relayInternalRequest<{
    ok: boolean;
    data: {
      isNewUser?: boolean;
      inviteRewardGranted?: boolean;
      inviteRewardQuota?: number;
      user?: UserProfileDto;
      settings?: SystemSettingsDto;
    };
  }>("POST", "/internal/user/ensure", {
    json: { tgId, nickname, username, inviterId },
  });
  return {
    isNewUser: Boolean(res.data?.isNewUser),
    inviteRewardGranted: Boolean(res.data?.inviteRewardGranted),
    inviteRewardQuota: Number(res.data?.inviteRewardQuota || 0),
    user: res.data?.user || null,
    settings: res.data?.settings,
  };
}

async function fetchAdminMe(operatorId: number): Promise<AdminMeDto> {
  const res = await relayInternalRequest<{ ok: boolean; data: AdminMeDto }>(
    "GET",
    "/internal/admin/me",
    { operatorId }
  );
  return res.data;
}

async function tryGetActiveAdmin(operatorId: number): Promise<AdminMeDto | null> {
  if (!operatorId || operatorId <= 0) return null;
  try {
    return await fetchAdminMe(operatorId);
  } catch {
    return null;
  }
}

async function resolveIsActiveAdminForCtx(ctx: Context): Promise<boolean> {
  const userId = Number(ctx.from?.id || 0);
  if (!userId || userId <= 0) return false;
  const admin = await tryGetActiveAdmin(userId);
  return Boolean(admin && admin.isActive);
}

/** 维护状态准入检查：维护模式下仅启用管理员/超管可放行 */
async function assertBotNotMaintenance(ctx: Context): Promise<void> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  if (!tgId || tgId <= 0) return;
  await relayInternalRequest("POST", "/internal/user/ensure", {
    json: { tgId, nickname, username, inviterId: null },
  });
}

async function authorizeRoastForCtx(ctx: Context): Promise<{
  unlimited: boolean;
  quota: number;
}> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  if (!tgId || tgId <= 0) {
    throw new RelayServiceError(400, "无法识别你的 Telegram 账号信息。");
  }
  const res = await relayInternalRequest<{
    ok: boolean;
    data: { allowed: boolean; unlimited: boolean; quota: number };
  }>("POST", "/internal/roast/authorize", {
    json: { tgId, nickname, username },
  });
  return {
    unlimited: Boolean(res.data?.unlimited),
    quota: Number(res.data?.quota ?? 0),
  };
}

async function consumeRoastForCtx(
  ctx: Context,
  roastType: RoastType,
  detail: string
): Promise<{ consumed: boolean; unlimited: boolean; quota: number }> {
  const { tgId } = getTgUserMeta(ctx);
  const res = await relayInternalRequest<{
    ok: boolean;
    data: { consumed: boolean; unlimited: boolean; quota: number };
  }>("POST", "/internal/roast/consume", {
    json: { tgId, roastType, detail },
  });
  return {
    consumed: Boolean(res.data?.consumed),
    unlimited: Boolean(res.data?.unlimited),
    quota: Number(res.data?.quota ?? 0),
  };
}

function buildInviteLink(tgId: number): string {
  const botHandle = BOT_USERNAME || "ow_cn_bot";
  return `https://t.me/${botHandle}?start=inv_${tgId}`;
}

/** 构建输入框旁常驻底部键盘（超管与管理员额外附带「🛠 管理员控制台」按钮） */
function buildPersistentBottomKeyboard(isAdmin = false): Keyboard {
  const kb = new Keyboard()
    .text("👤 个人中心")
    .text("📅 每日签到")
    .text("🎟 兑换卡密")
    .row()
    .text("🇨🇳 战绩查询")
    .text("📋 战绩流水");

  if (isAdmin) {
    kb.row().text("🛠 管理员控制台");
  }

  return kb.resized().persistent();
}

function buildUserCenterView(
  user: UserProfileDto,
  settings?: SystemSettingsDto
): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const vipStatusText = user.vipActive
    ? `👑 VIP 会员（有效期至 ${escapeHtml(user.vipExpireAt || "")} · 锐评免限）`
    : user.isAdmin
      ? `👑 ${user.adminRole === "super_admin" ? "超级管理员" : "管理员"}（AI 锐评免限）`
      : `🆓 普通用户`;

  const quotaText =
    user.isAdmin || user.vipActive
      ? `♾ 无限次（${user.isAdmin ? "管理员" : "VIP"} 免限，当前库存 ${user.quota} 次）`
      : `<b>${user.quota}</b> 次`;

  const displayNick = escapeHtml(user.nickname || "未设置");
  const displayUsername = user.username
    ? `@${escapeHtml(user.username)}`
    : "未设置";
  const inviteUrl = buildInviteLink(user.tgId);

  const invEnabled = settings ? settings.inviteRewardEnabled : true;
  const invQuota = settings
    ? invEnabled
      ? settings.inviteRewardQuota
      : 0
    : INVITE_REWARD_QUOTA;
  const chkEnabled = settings ? settings.checkinRewardEnabled : true;
  const chkQuota = settings
    ? chkEnabled
      ? settings.checkinRewardQuota
      : 0
    : CHECKIN_REWARD_QUOTA;

  const chkBtnLabel =
    chkEnabled && chkQuota > 0
      ? `📅 每日签到 (+${chkQuota}次)`
      : `📅 每日签到`;

  const lines = [
    `👤 <b>个人中心</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🆔 <b>用户 ID：</b><code>${user.tgId}</code>`,
    `🏷 <b>昵称：</b>${displayNick}`,
    `📛 <b>用户名：</b>${displayUsername}`,
    `👑 <b>会员状态：</b>${vipStatusText}`,
    `📅 <b>注册时间：</b>${escapeHtml(user.createdAt || "未知")}`,
    `⚡ <b>剩余锐评次数：</b>${quotaText}`,
    `🤝 <b>已成功邀请：</b><b>${user.inviteCount}</b> 人`,
    `━━━━━━━━━━━━━━━━━━`,
    `🔗 <b>你的专属邀请链接：</b>`,
    `<code>${escapeHtml(inviteUrl)}</code>`,
    `<i>（好友通过链接首次启动机器人，新用户按当前注册规则得额度；${invEnabled && invQuota > 0 ? `邀请人立得 +${invQuota} 次` : "当前邀请赠送已关闭"}；每日 00:00 北京时间签到${chkEnabled && chkQuota > 0 ? `可领 +${chkQuota} 次` : "可完成签到"}）</i>`,
  ];

  const keyboard = new InlineKeyboard()
    .text(chkBtnLabel, "u:checkin")
    .text("🎟 兑换卡密", "u:redeem_prompt")
    .row()
    .text("🔄 刷新个人中心", "u:refresh");

  if (user.isAdmin) {
    keyboard.row().text("🛠 管理员控制台", "u:open_admin");
  }

  return { text: lines.join("\n"), keyboard };
}

// ============================================================================
// 5. 数据提取、代理对清理与格式化工具
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

function sanitizeSafeText(input: unknown, fieldLabel: string): string {
  const raw = String(input ?? "");
  const anomalies: Array<{ index: number; codeHex: string }> = [];
  let step1 = "";

  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      anomalies.push({
        index: i,
        codeHex: `0x${code.toString(16).toUpperCase().padStart(4, "0")}`,
      });
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      continue;
    }
    step1 += raw[i];
  }

  const step2 = step1.replace(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g, "");

  if (anomalies.length > 0 || step2 !== step1) {
    console.warn(`[DeepSeek Sanitize][${fieldLabel}] 清理异常代理对:`, {
      rawLength: raw.length,
      surrogateCount: anomalies.length,
      anomalies: anomalies.slice(0, 10),
      removedEscapedSurrogates: step1.length - step2.length,
    });
  }

  return step2;
}

function serializeSafeJsonBody(payload: Record<string, any>): {
  bodyStr: string;
  strippedEscapeCount: number;
} {
  const rawJson = JSON.stringify(payload);
  let strippedEscapeCount = 0;
  const cleanedJson = rawJson.replace(
    /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g,
    () => {
      strippedEscapeCount++;
      return "";
    }
  );

  try {
    JSON.parse(cleanedJson);
  } catch (parseErr) {
    console.error("[DeepSeek JSON Self-Check Failed]", {
      parseErr,
      strippedEscapeCount,
    });
  }

  return { bodyStr: cleanedJson, strippedEscapeCount };
}

function pickField(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return undefined;
}

function pickDeepField(obj: any, keys: string[]): any {
  const direct = pickField(obj, keys);
  if (direct !== undefined) return direct;
  if (!obj || typeof obj !== "object") return undefined;

  const nestedContainers = [
    obj.matchInfo,
    obj.match_info,
    obj.gameInfo,
    obj.game_info,
    obj.summary,
    obj.stats,
    obj.detail,
    obj.extra,
  ];
  for (const box of nestedContainers) {
    if (box && typeof box === "object") {
      const val = pickField(box, keys);
      if (val !== undefined) return val;
    }
  }
  return undefined;
}

function unwrapData<T = any>(res: DashenResponse<T>): any {
  if (!res || typeof res !== "object") return res;
  if (res.data !== undefined && res.data !== null) return res.data;
  if (res.result !== undefined && res.result !== null) return res.result;
  return res;
}

function extractPlayerFromSearch(
  bnetInput: string,
  res: DashenResponse
): {
  bnet: string;
  customerToken: string;
  nickname: string;
  raw: any;
} {
  const body = unwrapData(res);
  const candidates: any[] = [];

  if (Array.isArray(body)) {
    candidates.push(...body);
  } else if (body && typeof body === "object") {
    for (const k of ["list", "accounts", "players", "data", "result", "items"]) {
      if (Array.isArray(body[k])) {
        candidates.push(...body[k]);
      }
    }
    if (candidates.length === 0) {
      candidates.push(body);
    }
  }

  const targetLower = bnetInput.replace("＃", "#").trim().toLowerCase();
  const matched =
    candidates.find((item) => {
      if (!item || typeof item !== "object") return false;
      const tag = String(
        pickField(item, [
          "bnetName",
          "battleTag",
          "bnet",
          "name",
          "nickName",
          "nickname",
        ]) || ""
      )
        .trim()
        .toLowerCase();
      return tag === targetLower;
    }) || candidates[0];

  const customerToken = matched
    ? pickField(matched, [
        "customerToken",
        "customer_token",
        "token",
        "playerToken",
        "targetToken",
      ])
    : undefined;

  if (!customerToken) {
    throw new DashenError(
      404,
      `❌ 未找到国服战网账号 <code>${escapeHtml(bnetInput)}</code>，或该账号尚未在网易大神同步过战绩。`
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
    if (
      ["-1", "false", "lose", "lost", "loss", "defeat", "负", "失败"].includes(
        s
      )
    ) {
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

const profileContextCache = new Map<
  string,
  {
    bnet: string;
    customerToken: string;
    mode: CnGameMode;
    snapshotText: string;
    currentRankLabel: string;
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

function cacheProfileContext(
  bnet: string,
  customerToken: string,
  mode: CnGameMode,
  snapshotText: string,
  currentRankLabel = "未定级"
): string {
  const shortId = `p${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;
  profileContextCache.set(shortId, {
    bnet,
    customerToken,
    mode,
    snapshotText,
    currentRankLabel,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });
  if (profileContextCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of profileContextCache.entries()) {
      if (v.expiresAt < now) profileContextCache.delete(k);
    }
  }
  return shortId;
}

// ============================================================================
// 5.5 DeepSeek 电竞锐评生成逻辑（单局 / 个人赛季 / 隐性段位评估）
// ============================================================================

function getPlayerRoleHint(heroName: string): string {
  const s = String(heroName || "").trim();
  if (!s) return "未知";
  if (
    [
      "莱因哈特",
      "温斯顿",
      "路霸",
      "查莉娅",
      "D.Va",
      "末日铁拳",
      "奥丽莎",
      "破坏球",
      "渣客女王",
      "西格玛",
      "拉玛刹",
      "毛加",
      "骇灾",
      "金驭",
      "D.Mon",
    ].includes(s)
  ) {
    return "坦克";
  }
  if (
    [
      "天使",
      "禅雅塔",
      "卢西奥",
      "安娜",
      "布丽吉塔",
      "莫伊拉",
      "巴蒂斯特",
      "雾子",
      "生命之梭",
      "伊拉锐",
      "朱诺",
      "无漾",
      "瑞稀",
      "飞天猫",
      "血律",
    ].includes(s)
  ) {
    return "支援";
  }
  return "输出";
}

function summarizeTeamByRole(players: any[], label: string): string {
  if (!Array.isArray(players) || players.length === 0) {
    return sanitizeSafeText(`${label}：无阵容数据`, "team-empty");
  }
  const roleBuckets: Record<string, any[]> = {
    坦克: [],
    输出: [],
    支援: [],
    未知: [],
  };
  for (const p of players) {
    const hName = resolveDashenHeroGuid(
      pickField(p, ["heroGuid", "heroId", "heroName"])
    );
    const r = getPlayerRoleHint(hName);
    (roleBuckets[r] || roleBuckets["未知"]).push({ ...p, _heroName: hName });
  }

  const parts: string[] = [];
  for (const rName of ["坦克", "输出", "支援", "未知"]) {
    const group = roleBuckets[rName];
    if (!group || group.length === 0) continue;
    const itemDesc = group
      .map((p) => {
        const name = sanitizeSafeText(
          pickField(p, ["name", "bnetName", "nickname"]) || "玩家",
          "player-name"
        );
        const k = Number(pickField(p, ["kill", "eliminations", "kills"]) || 0);
        const a = Number(pickField(p, ["assist", "assists"]) || 0);
        const d = Number(pickField(p, ["death", "deaths"]) || 0);
        const dmg = Number(pickField(p, ["heroDamage", "damage"]) || 0);
        const heal = Number(pickField(p, ["cure", "healing"]) || 0);
        const resist = Number(pickField(p, ["resistDamage"]) || 0);
        return `${name}(${sanitizeSafeText(p._heroName || "未知", "player-hero")}) 击杀${k}/助${a}/死${d} 伤${dmg}/疗${heal}/挡${resist}`;
      })
      .join("；");
    parts.push(`[${rName}] ${itemDesc}`);
  }
  return sanitizeSafeText(`${label}：\n  ` + parts.join("\n  "), label);
}

function cleanAiJsonText(rawText: string): string {
  let s = sanitizeSafeText(rawText, "ai-raw-response").trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").trim();
  s = s.replace(/\s*```$/i, "").trim();
  return s;
}

function parseAiAnalysisJson(rawText: string): any | null {
  const cleaned = cleanAiJsonText(rawText);
  if (!cleaned) return null;
  const candidates = [cleaned];
  const matchedBlocks = cleaned.match(/\{[\s\S]*\}/g);
  if (matchedBlocks) {
    candidates.push(...matchedBlocks);
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // 继续尝试下一个候选 JSON 片段
    }
  }
  return null;
}

async function callDeepSeekJson(
  systemPrompt: string,
  userPrompt: string
): Promise<any | null> {
  if (!AI_API_KEY) {
    throw new DashenError(
      400,
      "⚠️ 尚未配置 DeepSeek 接口密钥（<code>AI_API_KEY</code>）。请在 Vercel 环境变量中添加 <code>AI_API_KEY</code> 后重新部署。"
    );
  }

  const chatUrl = AI_BASE_URL.endsWith("/chat/completions")
    ? AI_BASE_URL
    : `${AI_BASE_URL}/chat/completions`;

  const { bodyStr: requestBodyStr } = serializeSafeJsonBody({
    model: AI_MODEL,
    temperature: 0.25,
    messages: [
      { role: "system", content: sanitizeSafeText(systemPrompt, "sys") },
      { role: "user", content: sanitizeSafeText(userPrompt, "usr") },
    ],
  });

  let response: Response;
  try {
    response = await fetch(chatUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AI_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: requestBodyStr,
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    console.error("[DeepSeek Fetch Error]", err);
    throw new DashenError(
      504,
      isTimeout
        ? "⏳ DeepSeek 生成锐评超时，请稍后再试。"
        : "🌐 请求 DeepSeek 接口网络异常，请稍后再试。"
    );
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new DashenError(
      response.status,
      `❌ DeepSeek 接口调用失败 (HTTP ${response.status})：${escapeHtml(sanitizeSafeText(errText, "ai-error").slice(0, 180))}`
    );
  }

  const aiPayload: any = await response.json().catch(() => null);
  const content =
    aiPayload?.choices?.[0]?.message?.content ??
    aiPayload?.data?.choices?.[0]?.message?.content ??
    "";
  return parseAiAnalysisJson(String(content));
}

async function generateDeepSeekMatchReview(
  bnet: string,
  customerToken: string,
  matchId: string
): Promise<string> {
  const cacheKey = `match:${matchId.trim()}:${bnet.trim().toLowerCase()}`;
  const cachedHtml = await getRoastCache(cacheKey, "match");
  if (cachedHtml) {
    return cachedHtml;
  }

  const res = await queryMatchInfo(customerToken, matchId);
  const rawDetail = unwrapData(res);
  const detail =
    rawDetail &&
    typeof rawDetail === "object" &&
    rawDetail.data &&
    typeof rawDetail.data === "object"
      ? rawDetail.data
      : rawDetail;

  const mapName = parseMatchMapName(detail);
  const modeName = translateModeCode(
    pickDeepField(detail, ["gameModeName", "modeName", "gameMode"])
  );
  const resultBadge = parseMatchResultBadge(detail);
  const teamScore = pickDeepField(detail, ["teamScore", "myScore"]);
  const oppScore = pickDeepField(detail, ["opponentScore", "enemyScore"]);
  const durationSec = Number(
    pickDeepField(detail, [
      "gameTimeSec",
      "duration",
      "gameTime",
      "matchDuration",
    ]) || 0
  );

  const teammates: any[] = Array.isArray(detail?.teammateList)
    ? detail.teammateList
    : [];
  const enemies: any[] = Array.isArray(detail?.enemyList)
    ? detail.enemyList
    : [];
  const heroList: any[] = Array.isArray(detail?.heroList)
    ? detail.heroList
    : [];

  const targetLower = bnet.trim().toLowerCase();
  const targetPrefix = targetLower.split("#")[0];
  const focusPlayer = [...teammates, ...enemies].find((p: any) => {
    const pName = String(
      pickField(p, ["name", "bnetName", "nickname"]) || ""
    )
      .trim()
      .toLowerCase();
    const pToken = String(
      pickField(p, ["customerToken", "customer_token"]) || ""
    ).trim();
    return (
      (customerToken && pToken === customerToken) ||
      pName === targetLower ||
      (targetPrefix && pName.startsWith(`${targetPrefix}#`))
    );
  });

  const safeBnetForAi = sanitizeSafeText(bnet, "focus-bnet");
  const safeMapForAi = sanitizeSafeText(mapName, "map-name");
  const safeModeForAi = sanitizeSafeText(modeName, "mode-name");

  const focusLines: string[] = [
    `焦点玩家：${safeBnetForAi}`,
    `对局地图：${safeMapForAi}（模式：${safeModeForAi || "未知"}，结果：${resultBadge.replace(/^[🟢🔴⚪]/, "")}${teamScore !== undefined && oppScore !== undefined ? ` ${teamScore}:${oppScore}` : ""}，时长：${durationSec > 0 ? `${Math.floor(durationSec / 60)}分${Math.round(durationSec % 60)}秒` : "未知"}）`,
  ];

  if (focusPlayer) {
    focusLines.push(
      `焦点玩家本局统计：消灭 ${pickField(focusPlayer, ["kill", "eliminations", "kills"]) ?? "-"} / 助攻 ${pickField(focusPlayer, ["assist", "assists"]) ?? "-"} / 阵亡 ${pickField(focusPlayer, ["death", "deaths"]) ?? "-"}，伤害 ${pickField(focusPlayer, ["heroDamage", "damage"]) ?? "-"}，治疗 ${pickField(focusPlayer, ["cure", "healing"]) ?? "-"}，抵伤 ${pickField(focusPlayer, ["resistDamage"]) ?? "-"}`
    );
  }

  if (heroList.length > 0) {
    const hSummary = heroList
      .slice(0, 6)
      .map((h) => {
        const hName = sanitizeSafeText(
          resolveDashenHeroGuid(pickField(h, ["heroId", "heroGuid", "heroName"])),
          "focus-hero"
        );
        const sec = Number(pickField(h, ["userTimeSec", "playTime"]) || 0);
        return `${hName}(${sec}s)`;
      })
      .join("、");
    focusLines.push(`焦点玩家使用英雄：${hSummary}`);
  }

  const promptContext = [
    ...focusLines,
    summarizeTeamByRole(teammates, "焦点玩家所在队伍（友方）"),
    summarizeTeamByRole(enemies, "对手队伍（敌方）"),
  ].join("\n");

  const systemPrompt = [
    "你是一位犀利、专业、客观的《守望先锋 2》电竞数据分析师。",
    "请严格依据提供的单场对局数据生成分析报告，禁止虚构不存在的数据或技能细节。",
    "不要把坦克或输出的低助攻/零助攻机械地判为负面表现，除非英雄机制高度依赖增益/挂状态且整体协同极差。",
    "请只输出纯 JSON，格式如下：",
    '{ "score": "S/A/B/C/D", "general_summary": "一句话评价", "key_point": "胜负核心点", "mvp_or_scapegoat": "MVP或背锅位及依据", "role_diff": "三路对位简析", "comment": "犀利简评（100字以内）" }',
  ].join("\n");

  const parsed = await callDeepSeekJson(systemPrompt, promptContext);
  const scoreBadge = escapeHtml(
    sanitizeSafeText(parsed?.score || "B", "ai-score").trim()
  );
  const generalSummary = escapeHtml(
    sanitizeSafeText(parsed?.general_summary || "暂无总结", "ai-summary").trim()
  );
  const keyPoint = escapeHtml(
    sanitizeSafeText(parsed?.key_point || "-", "ai-key-point").trim()
  );
  const mvpOrScapegoat = escapeHtml(
    sanitizeSafeText(
      parsed?.mvp_or_scapegoat || "-",
      "ai-mvp-scapegoat"
    ).trim()
  );
  const roleDiff = escapeHtml(
    sanitizeSafeText(parsed?.role_diff || "-", "ai-role-diff").trim()
  );
  const comment = escapeHtml(
    sanitizeSafeText(parsed?.comment || "", "ai-comment").trim()
  );

  const reviewHtml = [
    `🤖 <b>DeepSeek 电竞锐评 — ${escapeHtml(safeMapForAi)}</b>`,
    `🎯 目标：<code>${escapeHtml(safeBnetForAi)}</code>  |  评级：<b>${scoreBadge}</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `📌 <b>一句话总结：</b>${generalSummary}`,
    `⚡ <b>胜负核心点：</b>${keyPoint}`,
    `🏅 <b>MVP / 背锅位：</b>${mvpOrScapegoat}`,
    `🔀 <b>三路对位对比：</b>${roleDiff}`,
    comment ? `💬 <b>分析师锐评：</b><i>${comment}</i>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await setRoastCache({
    cacheKey,
    roastType: "match",
    bnet,
    matchId,
    reviewHtml,
  });

  return reviewHtml;
}

async function generateDeepSeekProfileRoast(
  bnet: string,
  mode: CnGameMode,
  snapshotText: string
): Promise<string> {
  const cacheKey = `self:${mode}:${bnet.trim().toLowerCase()}`;
  const cachedHtml = await getRoastCache(cacheKey, "self");
  if (cachedHtml) {
    return cachedHtml;
  }

  const systemPrompt = [
    "你是一位犀利、毒舌但不失专业的《守望先锋 2》国服资深教练。",
    "请根据玩家当前模式的赛季段位、场均数据与常用英雄画像，生成一份个人赛季锐评（24小时内复用）。",
    "请只输出纯 JSON，格式如下：",
    '{ "rating": "S/A/B/C/D", "persona": "玩家风格标签", "strength": "核心优势", "flaw": "明显短板", "advice": "针对性提升建议", "roast": "毒舌犀利一句话锐评（100字以内）" }',
  ].join("\n");

  const parsed = await callDeepSeekJson(systemPrompt, snapshotText);
  const rawRating = sanitizeSafeText(parsed?.rating || "B", "p-rating")
    .trim()
    .toUpperCase();
  const ratingBadge = escapeHtml(
    /^[SABCD]$/.test(rawRating) ? rawRating : rawRating || "B"
  );
  const persona = escapeHtml(
    sanitizeSafeText(parsed?.persona || "全能路人王", "p-persona").trim()
  );
  const strength = escapeHtml(
    sanitizeSafeText(parsed?.strength || "-", "p-strength").trim()
  );
  const flaw = escapeHtml(
    sanitizeSafeText(parsed?.flaw || "-", "p-flaw").trim()
  );
  const advice = escapeHtml(
    sanitizeSafeText(parsed?.advice || "-", "p-advice").trim()
  );
  const roast = escapeHtml(
    sanitizeSafeText(parsed?.roast || "", "p-roast").trim()
  );

  const reviewHtml = [
    `🔥 <b>个人赛季锐评 — <code>${escapeHtml(bnet)}</code></b>`,
    `🏅 综合评级：<b>${ratingBadge}</b>  |  🏷 风格定位：<b>${persona}</b>  |  模式：${mode === "sport" ? "⚔️ 竞技" : "⚡ 快速"}`,
    `━━━━━━━━━━━━━━━━━━`,
    `💪 <b>核心优势：</b>${strength}`,
    `⚠️ <b>明显短板：</b>${flaw}`,
    `🎯 <b>进阶建议：</b>${advice}`,
    roast ? `🌶 <b>教练锐评：</b><i>${roast}</i>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await setRoastCache({
    cacheKey,
    roastType: "self",
    gameMode: mode,
    bnet,
    reviewHtml,
  });

  return reviewHtml;
}

async function generateDeepSeekMmrEvaluation(
  bnet: string,
  mode: CnGameMode,
  snapshotText: string,
  currentRankLabel = "未定级"
): Promise<string> {
  const cacheKey = `mmr:${mode}:${bnet.trim().toLowerCase()}`;
  const cachedHtml = await getRoastCache(cacheKey, "mmr");
  if (cachedHtml) {
    return cachedHtml;
  }

  const systemPrompt = [
    "你是一位熟悉《守望先锋 2》隐藏分（MMR）与匹配机制的国服数据分析师。",
    "请根据玩家当前展示的段位、胜率、KDA 与场均输出/治疗/承伤表现，评估其隐性段位水平与上分阻力（24小时内复用）。",
    "请只输出纯 JSON，格式如下：",
    '{ "estimated_tier": "预估隐性段位区间", "confidence": "评估置信度", "mmr_trend": "隐藏分走势判断", "key_factor": "决定隐性段位的关键指标", "summary": "综合评估小结（100字以内）" }',
  ].join("\n");

  const parsed = await callDeepSeekJson(systemPrompt, snapshotText);
  const safeCurrentRank = escapeHtml(
    sanitizeSafeText(currentRankLabel || "未定级", "m-cur-rank").trim() ||
      "未定级"
  );
  const estTier = escapeHtml(
    sanitizeSafeText(parsed?.estimated_tier || "当前段位附近", "m-tier").trim()
  );
  const confidence = escapeHtml(
    sanitizeSafeText(parsed?.confidence || "中等", "m-conf").trim()
  );
  const mmrTrend = escapeHtml(
    sanitizeSafeText(parsed?.mmr_trend || "-", "m-trend").trim()
  );
  const keyFactor = escapeHtml(
    sanitizeSafeText(parsed?.key_factor || "-", "m-factor").trim()
  );
  const summary = escapeHtml(
    sanitizeSafeText(parsed?.summary || "", "m-summary").trim()
  );

  const reviewHtml = [
    `🔮 <b>隐性段位评估 — <code>${escapeHtml(bnet)}</code></b>`,
    `🧭 当前段位【<b>${safeCurrentRank}</b>】->【<b>${estTier}</b>】`,
    `🎯 预估隐性水平：<b>${estTier}</b>  |  置信度：<b>${confidence}</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `📈 <b>隐藏分走势：</b>${mmrTrend}`,
    `🔑 <b>核心评估依据：</b>${keyFactor}`,
    summary ? `📝 <b>综合结论：</b><i>${summary}</i>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await setRoastCache({
    cacheKey,
    roastType: "mmr",
    gameMode: mode,
    bnet,
    reviewHtml,
  });

  return reviewHtml;
}

// ============================================================================
// 6. 视图渲染：国服总览卡片 / 近期战绩列表 / 单场对局详情
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
    metaParts.push(`总时长 ${gtStr}`);
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
    open: "🎲 开放",
    free: "🎲 开放",
  };

  const roleOrder = ["tank", "dps", "healer", "open"];
  const rankLines: string[] = [];
  const rankedRoleSummaries: string[] = [];

  if (gameMode === "sport" && cardData && typeof cardData === "object") {
    const rankList =
      countData?.guideCountData ||
      cardData.guideCountData ||
      cardData.rankList ||
      cardData.ranks ||
      cardData.roleRankList ||
      cardData.tierList ||
      cardData.competitiveRanks;

    if (Array.isArray(rankList) && rankList.length > 0) {
      const normalizedRoleKey = (rawVal: unknown): string => {
        const s = String(rawVal || "")
          .trim()
          .toLowerCase();
        if (s === "tank" || s.includes("坦克") || s.includes("重装"))
          return "tank";
        if (s === "dps" || s === "damage" || s.includes("输出")) return "dps";
        if (
          s === "healer" ||
          s === "support" ||
          s.includes("支援") ||
          s.includes("治疗")
        )
          return "healer";
        if (
          s === "open" ||
          s === "free" ||
          s.includes("开放") ||
          s.includes("自由")
        )
          return "open";
        return s || "other";
      };

      const entriesByRole = new Map<string, any>();
      const extraEntries: Array<{ key: string; item: any }> = [];

      for (const r of rankList) {
        const rawRole = pickField(r, [
          "roleType",
          "roleName",
          "role",
          "name",
          "typeName",
        ]);
        const rKey = normalizedRoleKey(rawRole);
        if (roleOrder.includes(rKey) && !entriesByRole.has(rKey)) {
          entriesByRole.set(rKey, r);
        } else {
          extraEntries.push({ key: rKey, item: r });
        }
      }

      const formatRoleLine = (
        rKey: string,
        r: any,
        fallbackLabel: string
      ): string => {
        const roleLabel = roleMapCn[rKey] || fallbackLabel || rKey;
        if (!r) {
          return `• ${escapeHtml(roleLabel)}：<b>未定级</b>（暂无场次）`;
        }
        const lastRank = r?.lastRankInfo || r?.rankInfo || r;
        const rawRankName = pickField(lastRank, [
          "rankName",
          "rank_name",
          "tierName",
          "divisionName",
          "rank",
        ]);
        const rNameCn = translateRankName(rawRankName);
        const rawSub = pickField(lastRank, ["rankSubTier", "rank_sub_tier"]);
        const subNum = Number(rawSub);
        const hasSubTier =
          rawSub !== undefined &&
          rawSub !== null &&
          String(rawSub).trim() !== "" &&
          Number.isFinite(subNum) &&
          subNum > 0;
        const rawScore = pickField(lastRank, ["rankScore", "rank_score"]);
        const scoreNum = Number(rawScore);
        const hasScore =
          rawScore !== undefined &&
          rawScore !== null &&
          String(rawScore).trim() !== "" &&
          Number.isFinite(scoreNum) &&
          scoreNum > 0;

        const tierText = rNameCn
          ? `${rNameCn}${hasSubTier ? ` ${subNum}` : ""}${hasScore ? ` (${scoreNum}分)` : ""}`
          : "未定级";
        if (rNameCn) {
          const shortRole = roleLabel.replace(/^[^\s]+\s*/, "").trim();
          rankedRoleSummaries.push(
            `${shortRole ? `${shortRole} ` : ""}${rNameCn}${hasSubTier ? ` ${subNum}` : ""}`
          );
        }
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

        return `• ${escapeHtml(roleLabel)}：<b>${escapeHtml(tierText)}</b>${extra ? `（${escapeHtml(extra)}）` : ""}`;
      };

      for (const rKey of roleOrder) {
        rankLines.push(
          formatRoleLine(rKey, entriesByRole.get(rKey), roleMapCn[rKey])
        );
      }
      for (const ex of extraEntries) {
        const rawLabel = String(
          pickField(ex.item, [
            "roleType",
            "roleName",
            "role",
            "name",
            "typeName",
          ]) || "其他"
        );
        rankLines.push(formatRoleLine(ex.key, ex.item, rawLabel));
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

    const modeSectionTitle =
      gameMode === "sport"
        ? "📊 赛季竞技汇总（职责预设）"
        : "📊 赛季快速汇总（职责预设）";

    if (statParts.length > 0) {
      lines.push(`<b>${modeSectionTitle}</b>`, ...statParts);
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
      const heroTitle =
        gameMode === "sport" ? "🔥 竞技常用英雄" : "🔥 快速常用英雄";
      lines.push(`━━━━━━━━━━━━━━━━━━`, `<b>${heroTitle}</b>`);
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

  const finalHtml = lines.join("\n");
  const plainSnapshot = sanitizeSafeText(
    finalHtml.replace(/<[^>]+>/g, ""),
    "profile-snapshot"
  );
  const currentRankLabel =
    rankedRoleSummaries.length > 0
      ? rankedRoleSummaries.join(" / ")
      : "未定级";
  const pRef = cacheProfileContext(
    player.bnet,
    player.customerToken,
    gameMode,
    plainSnapshot,
    currentRankLabel
  );

  const keyboard = new InlineKeyboard();
  const mCode = gameMode === "sport" ? "s" : "l";
  const nextM = gameMode === "sport" ? "l" : "s";

  const switchModeCb = `o:${nextM}:${player.bnet}`;
  const matchListCb = `m:${mCode}:1:${player.bnet}`;
  const refreshCb = `o:${mCode}:${player.bnet}`;
  const roastSelfCb = `r:self:${pRef}`;
  const roastMmrCb = `r:mmr:${pRef}`;

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
  if (isSafeCallbackData(roastSelfCb)) {
    keyboard.text("🔥 锐评自己", roastSelfCb);
  }
  if (isSafeCallbackData(roastMmrCb)) {
    keyboard.text("🔮 隐性段位评估", roastMmrCb);
  }
  keyboard.row();
  if (isSafeCallbackData(refreshCb)) {
    keyboard.text("🔄 刷新总览", refreshCb);
  }

  return { text: finalHtml, keyboard };
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
      "⏳ 该对局详情缓存已过期，请重新点击「近期战绩流水」刷新后再点详情。"
    );
  }

  const res = await queryMatchInfo(entry.customerToken, entry.matchId);
  const rawDetail = unwrapData(res);
  const detail =
    rawDetail &&
    typeof rawDetail === "object" &&
    rawDetail.data &&
    typeof rawDetail.data === "object"
      ? rawDetail.data
      : rawDetail;

  const mapName = parseMatchMapName(detail);
  const modeName = translateModeCode(
    pickDeepField(detail, ["gameModeName", "modeName", "gameMode"])
  );
  const durationSec = Number(
    pickDeepField(detail, [
      "gameTimeSec",
      "duration",
      "gameTime",
      "matchDuration",
    ])
  );
  const durationText =
    Number.isFinite(durationSec) && durationSec > 0
      ? `${Math.floor(durationSec / 60)}分${Math.round(durationSec % 60)}秒`
      : "";

  const teamScore = pickDeepField(detail, ["teamScore", "myScore"]);
  const oppScore = pickDeepField(detail, ["opponentScore", "enemyScore"]);
  const scoreText =
    teamScore !== undefined && oppScore !== undefined
      ? `  |  比分：<b>${formatNum(teamScore)} : ${formatNum(oppScore)}</b>`
      : "";

  const lines: string[] = [
    `🔍 <b>${escapeHtml(mapName)}</b>${modeName ? ` (${escapeHtml(modeName)})` : ""}`,
    `战网 ID：<code>${escapeHtml(entry.bnet)}</code>${durationText ? `  |  时长：${escapeHtml(durationText)}` : ""}${scoreText}`,
    `━━━━━━━━━━━━━━━━━━`,
  ];

  const teammates: any[] = Array.isArray(detail?.teammateList)
    ? detail.teammateList
    : [];
  const enemies: any[] = Array.isArray(detail?.enemyList)
    ? detail.enemyList
    : [];
  const heroList: any[] = Array.isArray(detail?.heroList)
    ? detail.heroList
    : [];

  const targetLower = entry.bnet.trim().toLowerCase();
  const targetPrefix = targetLower.split("#")[0];
  const matchedPlayer = [...teammates, ...enemies].find((p: any) => {
    const pName = String(
      pickField(p, ["name", "bnetName", "nickname"]) || ""
    )
      .trim()
      .toLowerCase();
    const pToken = String(
      pickField(p, ["customerToken", "customer_token"]) || ""
    ).trim();
    return (
      (entry.customerToken && pToken === entry.customerToken) ||
      pName === targetLower ||
      (targetPrefix && pName.startsWith(`${targetPrefix}#`))
    );
  });

  if (matchedPlayer) {
    const e = formatNum(
      pickField(matchedPlayer, ["kill", "eliminations", "kills"])
    );
    const a = formatNum(pickField(matchedPlayer, ["assist", "assists"]));
    const d = formatNum(pickField(matchedPlayer, ["death", "deaths"]));
    const dmg = formatNum(pickField(matchedPlayer, ["heroDamage", "damage"]));
    const heal = formatNum(pickField(matchedPlayer, ["cure", "healing"]));
    const resist = formatNum(pickField(matchedPlayer, ["resistDamage"]));
    const pHero = resolveDashenHeroGuid(
      pickField(matchedPlayer, ["heroGuid", "heroId", "heroName"])
    );

    lines.push(
      `<b>🎯 查询玩家本局表现</b>${pHero ? `（主玩：${escapeHtml(pHero)}）` : ""}`
    );
    lines.push(`• 消灭/助攻/阵亡：<b>${e} / ${a} / ${d}</b>`);
    lines.push(
      `• 英雄伤害：<b>${dmg}</b>  |  治疗量：<b>${heal}</b>  |  抵伤：<b>${resist}</b>`
    );
    lines.push(`━━━━━━━━━━━━━━━━━━`);
  }

  if (heroList.length > 0) {
    lines.push(`<b>🦸 本局英雄使用明细</b>`);
    for (const h of heroList.slice(0, 6)) {
      const hName = resolveDashenHeroGuid(
        pickField(h, ["heroId", "heroGuid", "heroName"])
      );
      const sec = Number(pickField(h, ["userTimeSec", "playTime"]) || 0);
      const timeStr = sec > 0 ? `${Math.floor(sec / 60)}m${sec % 60}s` : "-";
      const rateStr = pickField(h, ["useTimeRate"]);
      const statMap =
        h?.statMap && typeof h.statMap === "object" ? h.statMap : null;
      const topStats: string[] = [];
      if (statMap) {
        for (const [statGuid, statVal] of Object.entries(statMap).slice(0, 3)) {
          const sLabel = DASHEN_STAT_GUID_NAMES[String(statGuid)] || "";
          if (sLabel && statVal !== undefined && statVal !== null) {
            topStats.push(`${sLabel} ${formatNum(statVal, 1)}`);
          }
        }
      }
      lines.push(
        `• <b>${escapeHtml(hName)}</b>：时长 ${escapeHtml(timeStr)}${rateStr !== undefined ? ` (${escapeHtml(String(rateStr))}%)` : ""}${topStats.length > 0 ? ` · ${escapeHtml(topStats.join(" / "))}` : ""}`
      );
    }
    lines.push(`━━━━━━━━━━━━━━━━━━`);
  }

  const allPlayers = [
    ...teammates.map((p) => ({ ...p, _side: "友方" })),
    ...enemies.map((p) => ({ ...p, _side: "敌方" })),
  ];

  if (allPlayers.length > 0) {
    lines.push(`<b>👥 本局参战玩家（消灭/助攻/阵亡 | 伤害 | 治疗）</b>`);
    for (const p of allPlayers.slice(0, 16)) {
      const pName = String(
        pickField(p, ["name", "bnetName", "nickname", "playerName"]) || "玩家"
      );
      const pHero = resolveDashenHeroGuid(
        pickField(p, ["heroGuid", "heroId", "heroName"])
      );
      const e = formatNum(pickField(p, ["kill", "eliminations", "kills"]));
      const a = formatNum(pickField(p, ["assist", "assists"]));
      const d = formatNum(pickField(p, ["death", "deaths"]));
      const dmg = formatNum(pickField(p, ["heroDamage", "damage"]));
      const heal = formatNum(pickField(p, ["cure", "healing"]));
      lines.push(
        `• [${p._side}] <b>${escapeHtml(pName)}</b>${pHero ? `(${escapeHtml(pHero)})` : ""}：${e}/${a}/${d} | 伤 ${dmg} | 疗 ${heal}`
      );
    }
  } else if (!matchedPlayer && heroList.length === 0) {
    lines.push(`📭 该对局暂无详细阵容与英雄统计数据。`);
  }

  const keyboard = new InlineKeyboard();
  const mCode = entry.mode === "sport" ? "s" : "l";
  const backListCb = `m:${mCode}:1:${entry.bnet}`;
  const backHomeCb = `o:${mCode}:${entry.bnet}`;
  const aiCb = `a:${refId}`;

  if (isSafeCallbackData(aiCb)) {
    keyboard.text("🤖 DeepSeek 锐评", aiCb).row();
  }
  if (isSafeCallbackData(backListCb)) {
    keyboard.text("⬅️ 返回战绩列表", backListCb);
  }
  if (isSafeCallbackData(backHomeCb)) {
    keyboard.text("🏠 返回总览", backHomeCb);
  }

  return { text: lines.join("\n"), keyboard };
}

// ============================================================================
// 7. 分级权限管理控制台视图与交互（含超管「系统与赠送设置」）
// ============================================================================

type PendingAdminAction =
  | "admin_user_view"
  | "admin_quota_add"
  | "admin_quota_deduct"
  | "admin_vip_manage"
  | "admin_ban_manage"
  | "admin_redeem_create"
  | "admin_redeem_view"
  | "admin_redeem_void"
  | "super_admin_add"
  | "super_admin_remark"
  | "super_set_reg_quota"
  | "super_set_inv_quota"
  | "super_set_chk_quota";

interface PendingAdminState {
  action: PendingAdminAction;
  targetAdminId?: number;
  expiresAt: number;
}

const pendingAdminInputs = new Map<number, PendingAdminState>();

function setPendingAdminInput(
  operatorId: number | undefined,
  action: PendingAdminAction,
  targetAdminId?: number
): void {
  if (!operatorId || operatorId <= 0) return;
  pendingAdminInputs.set(operatorId, {
    action,
    targetAdminId,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

function consumePendingAdminInput(
  operatorId: number | undefined
): PendingAdminState | null {
  if (!operatorId || operatorId <= 0) return null;
  const st = pendingAdminInputs.get(operatorId);
  if (!st) return null;
  pendingAdminInputs.delete(operatorId);
  if (Date.now() > st.expiresAt) return null;
  return st;
}

function getPermLabel(perm: string, labels?: Record<string, string>): string {
  return (labels && labels[perm]) || PERMISSION_LABELS_FALLBACK[perm] || perm;
}

function buildAdminDashboardView(admin: AdminMeDto): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const isSuper = admin.role === "super_admin";
  const perms = isSuper
    ? Object.keys(PERMISSION_LABELS_FALLBACK)
    : admin.permissions || [];

  const permSummaryText = isSuper
    ? "全部 9 项业务权限 + 超管专属特权（AI 锐评无限制）"
    : perms.length > 0
      ? perms.map((p) => getPermLabel(p, admin.permissionLabels)).join("、")
      : "暂无业务权限（请联系超管授权 · AI 锐评无限制）";

  const lines = [
    `🛠 <b>${isSuper ? "超级管理员控制台" : "管理员控制台"}</b>`,
    `👤 <b>当前操作人：</b><code>${admin.tgId}</code>${admin.remark ? `（${escapeHtml(admin.remark)}）` : ""}`,
    `🎖 <b>角色身份：</b>${isSuper ? "超级管理员 · AI 锐评无限制" : "普通管理员 · AI 锐评无限制"}`,
    `🔑 <b>可用权限：</b>${escapeHtml(permSummaryText)}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<i>请选择下方功能按钮进行操作（仅展示你已获授权的功能）：</i>`,
  ];

  const kb = new InlineKeyboard();
  const has = (p: string) => isSuper || perms.includes(p);

  let rowCount = 0;
  const pushBtn = (label: string, data: string) => {
    kb.text(label, data);
    rowCount++;
    if (rowCount % 2 === 0) kb.row();
  };

  if (has("user:view")) pushBtn("👤 用户查询", "ad:u_view");
  if (has("stats:view")) pushBtn("📊 运营统计", "ad:stats");
  if (has("quota:add")) pushBtn("➕ 添加次数", "ad:q_add");
  if (has("quota:deduct")) pushBtn("➖ 减少次数", "ad:q_ded");
  if (has("vip:manage")) pushBtn("👑 VIP 管理", "ad:vip");
  if (has("user:ban")) pushBtn("🚫 封禁管理", "ad:ban");
  if (has("redeem:create")) pushBtn("🎟 生成卡密", "ad:c_gen");
  if (has("redeem:view")) pushBtn("🔍 查询卡密", "ad:c_view");
  if (has("redeem:void")) pushBtn("❌ 作废卡密", "ad:c_void");

  if (rowCount % 2 !== 0) kb.row();

  if (isSuper) {
    kb.text("⚙️ 系统与赠送设置", "ad:sys_cfg")
      .text("👥 管理员管理", "ad:a_list")
      .row();
    kb.text("📜 审计日志", "ad:logs:1").row();
  }

  return { text: lines.join("\n"), keyboard: kb };
}

function buildSuperSettingsView(settings: SystemSettingsDto): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const isMaint = settings.botStatus === "maintenance";
  const regOn = settings.registerRewardEnabled;
  const invOn = settings.inviteRewardEnabled;
  const chkOn = settings.checkinRewardEnabled;

  const lines = [
    `⚙️ <b>系统与赠送规则设置（超管专属）</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🤖 <b>机器人状态：</b>${isMaint ? "🛠 <b>维护中</b>（仅启用管理员/超管可调试）" : "🟢 <b>正常运行</b>（全员开放）"}`,
    `🎁 <b>新注册赠送：</b>${regOn ? `✅ 已开启（送 <b>${settings.registerRewardQuota}</b> 次）` : `⛔ 已关闭（送 0 次）`}`,
    `🤝 <b>邀请人赠送：</b>${invOn ? `✅ 已开启（邀 1 人送 <b>${settings.inviteRewardQuota}</b> 次）` : `⛔ 已关闭（送 0 次）`}`,
    `📅 <b>每日签到赠送：</b>${chkOn ? `✅ 已开启（每次送 <b>${settings.checkinRewardQuota}</b> 次）` : `⛔ 已关闭（签到不加次）`}`,
    settings.updatedAt
      ? `🕒 <b>最后更新：</b>${escapeHtml(settings.updatedAt)}${settings.updatedBy ? `（操作人 <code>${settings.updatedBy}</code>）` : ""}`
      : "",
    `━━━━━━━━━━━━━━━━━━`,
    `<i>点击下方按钮可实时切换状态/开关，或设置各项赠送次数：</i>`,
  ]
    .filter(Boolean)
    .join("\n");

  const kb = new InlineKeyboard()
    .text(
      isMaint ? "🟢 切为正常运行" : "🛠 切为维护模式",
      "ad:sys_toggle_status"
    )
    .row()
    .text(
      regOn ? "关闭新注册赠送" : "开启新注册赠送",
      "ad:sys_toggle_reg"
    )
    .text("✏️ 设新注册次数", "ad:sys_set_reg")
    .row()
    .text(invOn ? "关闭邀请赠送" : "开启邀请赠送", "ad:sys_toggle_inv")
    .text("✏️ 设邀请次数", "ad:sys_set_inv")
    .row()
    .text(chkOn ? "关闭签到赠送" : "开启签到赠送", "ad:sys_toggle_chk")
    .text("✏️ 设签到次数", "ad:sys_set_chk")
    .row()
    .text("⬅️ 返回控制台", "ad:home");

  return { text: lines, keyboard: kb };
}

async function handlePendingAdminInput(
  ctx: Context,
  operatorId: number,
  state: PendingAdminState,
  text: string
): Promise<void> {
  const parts = text.trim().split(/\s+/);

  try {
    if (state.action === "admin_user_view") {
      const r = await relayInternalRequest<{
        ok: boolean;
        data: {
          isList?: boolean;
          totalUsers?: number;
          users?: UserProfileDto[];
          user?: UserProfileDto;
          recentLogs?: any[];
        };
      }>("GET", "/internal/admin/user", {
        params: { query: text.trim() },
        operatorId,
      });

      if (r.data?.isList) {
        const list = r.data.users || [];
        const totalUsers = Number(r.data.totalUsers ?? list.length);
        const lines = [
          `👥 <b>用户列表概览（显示最近 ${list.length} 人 / 共 ${totalUsers} 人）</b>`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        if (list.length === 0) {
          lines.push("暂无已注册用户。");
        } else {
          for (const item of list) {
            const nick = escapeHtml(item.nickname || "未设置");
            const uname = item.username ? `@${escapeHtml(item.username)}` : "无";
            const vipFlag = item.vipActive ? "👑VIP" : "";
            const banFlag = item.isBanned ? "🚫封禁" : "";
            const admFlag = item.isAdmin
              ? item.adminRole === "super_admin"
                ? "超管"
                : "普管"
              : "";
            const tags = [admFlag, vipFlag, banFlag].filter(Boolean).join("·");
            lines.push(
              `• <code>${item.tgId}</code> ${nick} (${uname}) · <b>${item.quota}</b>次 · 邀${item.inviteCount}人${tags ? ` [${tags}]` : ""}`
            );
          }
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
        return;
      }

      const u = r.data?.user;
      if (!u) {
        await ctx.reply("⚠️ 未获取到用户详情数据。");
        return;
      }
      const logLines = (r.data.recentLogs || []).map((l) => {
        const sign = Number(l.changeAmount) >= 0 ? `+${l.changeAmount}` : `${l.changeAmount}`;
        return `• <code>${sign}</code> (${escapeHtml(l.reason)}) → 余额 ${l.balanceAfter}  <i>[${escapeHtml(l.createdAt)}]</i>${l.detail ? ` · ${escapeHtml(l.detail)}` : ""}`;
      });
      await ctx.reply(
        [
          `👤 <b>用户详情：<code>${u.tgId}</code></b>`,
          `• 昵称：${escapeHtml(u.nickname || "未设置")}  |  用户名：${u.username ? `@${escapeHtml(u.username)}` : "无"}`,
          `• 剩余次数：<b>${u.quota}</b>  |  状态：${u.isBanned ? "🚫 已封禁" : "✅ 正常"}`,
          `• VIP：${u.vipActive ? `✅ 至 ${escapeHtml(u.vipExpireAt || "")}` : "❌ 未开通/已过期"}`,
          `• 邀请人数：<b>${u.inviteCount}</b>  |  注册时间：${escapeHtml(u.createdAt || "-")}`,
          logLines.length > 0 ? `\n<b>📜 近期次数流水</b>\n${logLines.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (state.action === "admin_quota_add" || state.action === "admin_quota_deduct") {
      if (parts.length < 3) {
        await ctx.reply("⚠️ 格式错误，请输入：<code>用户TG_ID 次数 原因</code>", {
          parse_mode: "HTML",
        });
        return;
      }
      const targetTgId = Number(parts[0]);
      const amount = Number(parts[1]);
      const reason = parts.slice(2).join(" ");
      const endpoint =
        state.action === "admin_quota_add"
          ? "/internal/admin/quota/add"
          : "/internal/admin/quota/deduct";
      const r = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        endpoint,
        {
          json: { targetTgId, amount, reason },
          operatorId,
        }
      );
      const d = r.data;
      await ctx.reply(
        state.action === "admin_quota_add"
          ? `✅ <b>添加次数成功</b>\n用户 <code>${d.tgId}</code> 增加 <b>+${d.added}</b> 次（${d.beforeQuota} → <b>${d.afterQuota}</b>）\n原因：${escapeHtml(d.reason)}`
          : `✅ <b>减少次数成功</b>\n用户 <code>${d.tgId}</code> 扣除 <b>-${d.deducted}</b> 次（${d.beforeQuota} → <b>${d.afterQuota}</b>）\n原因：${escapeHtml(d.reason)}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (state.action === "admin_vip_manage") {
      if (parts.length < 2) {
        await ctx.reply(
          "⚠️ 格式错误，开通/续期请输入：<code>用户TG_ID 天数 原因</code>；取消请输入：<code>用户TG_ID revoke 原因</code>",
          { parse_mode: "HTML" }
        );
        return;
      }
      const targetTgId = Number(parts[0]);
      const second = parts[1].toLowerCase();
      const isRevoke = second === "revoke" || second === "cancel" || second === "0";
      const days = isRevoke ? undefined : Number(parts[1]);
      const reason = parts.slice(2).join(" ") || (isRevoke ? "取消 VIP" : "开通/续期 VIP");
      const r = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/vip",
        {
          json: {
            targetTgId,
            actionType: isRevoke ? "revoke" : "grant",
            days,
            reason,
          },
          operatorId,
        }
      );
      const d = r.data;
      await ctx.reply(
        d.mode === "revoke"
          ? `✅ 已取消用户 <code>${d.tgId}</code> 的 VIP 会员（原因：${escapeHtml(d.reason)}）`
          : `✅ 已更新用户 <code>${d.tgId}</code> VIP 到期时间为：<b>${escapeHtml(d.afterVip || "")}</b>（原因：${escapeHtml(d.reason)}）`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (state.action === "admin_ban_manage") {
      if (parts.length < 2) {
        await ctx.reply(
          "⚠️ 格式错误，请输入：<code>用户TG_ID ban|unban 原因</code>",
          { parse_mode: "HTML" }
        );
        return;
      }
      const targetTgId = Number(parts[0]);
      const op = parts[1].toLowerCase();
      if (!["ban", "unban", "1", "0"].includes(op)) {
        await ctx.reply("⚠️ 第二个参数请填 <code>ban</code> 或 <code>unban</code>。", {
          parse_mode: "HTML",
        });
        return;
      }
      const banned = op === "ban" || op === "1";
      const reason = parts.slice(2).join(" ");
      const r = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/user/ban",
        {
          json: { targetTgId, banned, reason },
          operatorId,
        }
      );
      await ctx.reply(
        r.data.isBanned
          ? `🚫 已封禁用户 <code>${r.data.tgId}</code>（原因：${escapeHtml(r.data.reason)}）`
          : `✅ 已解封用户 <code>${r.data.tgId}</code>（原因：${escapeHtml(r.data.reason)}）`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (state.action === "admin_redeem_create") {
      if (parts.length < 2) {
        await ctx.reply(
          "⚠️ 格式错误，请输入：<code>quota|vip_days 数值 [数量1~50]</code>",
          { parse_mode: "HTML" }
        );
        return;
      }
      const rewardType = parts[0] === "vip_days" ? "vip_days" : "quota";
      const rewardValue = Number(parts[1]);
      const count = parts[2] ? Number(parts[2]) : 1;
      const r = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/redeem/create",
        {
          json: { rewardType, rewardValue, count },
          operatorId,
        }
      );
      const codes: string[] = r.data.codes || [];
      await ctx.reply(
        [
          `🎟 <b>成功生成 ${codes.length} 张卡密</b>（类型：${rewardType === "vip_days" ? `VIP ${rewardValue}天` : `${rewardValue}次锐评`}）`,
          `━━━━━━━━━━━━━━━━━━`,
          ...codes.map((c) => `<code>${escapeHtml(c)}</code>`),
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (state.action === "admin_redeem_view") {
      const r = await relayInternalRequest<{ ok: boolean; data: any }>(
        "GET",
        "/internal/admin/redeem/view",
        {
          params: { code: text.trim().toUpperCase() },
          operatorId,
        }
      );
      const c = r.data;
      const statusMap: Record<string, string> = {
        unused: "🟢 未使用",
        used: "🔵 已核销",
        voided: "🔴 已作废",
      };
      await ctx.reply(
        [
          `🔍 <b>卡密详情：<code>${escapeHtml(c.code)}</code></b>`,
          `• 类型/面额：${c.rewardType === "vip_days" ? `VIP ${c.rewardValue} 天` : `锐评 ${c.rewardValue} 次`}`,
          `• 当前状态：<b>${statusMap[c.status] || escapeHtml(c.status)}</b>`,
          `• 生成时间：${escapeHtml(c.createdAt || "-")}${c.createdBy ? `（管理员 <code>${c.createdBy}</code>）` : ""}`,
          c.usedBy ? `• 核销用户：<code>${c.usedBy}</code>（${escapeHtml(c.usedAt || "-")}）` : "",
          c.status === "voided"
            ? `• 作废信息：${escapeHtml(c.voidReason || "无")}（${escapeHtml(c.voidedAt || "-")}）`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (state.action === "admin_redeem_void") {
      if (parts.length < 1 || !parts[0]) {
        await ctx.reply("⚠️ 请输入：<code>卡密编号 作废原因</code>", {
          parse_mode: "HTML",
        });
        return;
      }
      const code = parts[0].toUpperCase();
      const reason = parts.slice(1).join(" ") || "管理员作废";
      const r = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/redeem/void",
        {
          json: { code, reason },
          operatorId,
        }
      );
      await ctx.reply(
        `❌ 已作废卡密 <code>${escapeHtml(r.data.code)}</code>\n原因：${escapeHtml(r.data.voidReason)}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (state.action === "super_admin_add") {
      if (parts.length < 1 || !/^\d+$/.test(parts[0])) {
        await ctx.reply("⚠️ 格式错误，请输入：<code>新管理员TG_ID 备注名</code>", {
          parse_mode: "HTML",
        });
        return;
      }
      const targetTgId = Number(parts[0]);
      const remark = parts.slice(1).join(" ") || `管理员${targetTgId}`;
      const r = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/admins",
        {
          json: { targetTgId, remark },
          operatorId,
        }
      );
      await ctx.reply(
        `✅ 已添加普通管理员 <code>${r.data.tgId}</code>（备注：${escapeHtml(r.data.remark)}，初始 0 权限）。请在管理面板中为其勾选权限。`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (state.action === "super_admin_remark" && state.targetAdminId) {
      const r = await relayInternalRequest<{ ok: boolean; data: any }>(
        "POST",
        "/internal/admin/admins/meta",
        {
          json: { targetTgId: state.targetAdminId, remark: text.trim() },
          operatorId,
        }
      );
      await ctx.reply(
        `✅ 已将管理员 <code>${r.data.tgId}</code> 的备注更新为：<b>${escapeHtml(r.data.remark)}</b>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (
      state.action === "super_set_reg_quota" ||
      state.action === "super_set_inv_quota" ||
      state.action === "super_set_chk_quota"
    ) {
      const n = Number(text.trim());
      if (!Number.isInteger(n) || n < 0 || n > 10000) {
        await ctx.reply("⚠️ 请输入 0 ~ 10000 之间的整数。", {
          parse_mode: "HTML",
        });
        return;
      }
      const patch: Record<string, any> = {};
      let label = "";
      if (state.action === "super_set_reg_quota") {
        patch.registerRewardQuota = n;
        patch.registerRewardEnabled = n > 0 ? true : undefined;
        label = "新注册赠送次数";
      } else if (state.action === "super_set_inv_quota") {
        patch.inviteRewardQuota = n;
        patch.inviteRewardEnabled = n > 0 ? true : undefined;
        label = "邀请赠送次数";
      } else {
        patch.checkinRewardQuota = n;
        patch.checkinRewardEnabled = n > 0 ? true : undefined;
        label = "每日签到赠送次数";
      }
      const r = await relayInternalRequest<{
        ok: boolean;
        data: SystemSettingsDto;
      }>("POST", "/internal/admin/settings", {
        json: patch,
        operatorId,
      });
      const { text: cfgText, keyboard: cfgKb } = buildSuperSettingsView(r.data);
      await ctx.reply(`✅ 已更新<b>${label}</b>为 <b>${n}</b> 次：\n\n${cfgText}`, {
        parse_mode: "HTML",
        reply_markup: cfgKb,
      });
      return;
    }
  } catch (err) {
    await handleCommandError(ctx, err);
  }
}

// ============================================================================
// 8. 初始化 grammY Bot 与指令/按钮注册
// ============================================================================

const bot = new Bot(BOT_TOKEN);

type PendingUserAction = "cn" | "match" | "redeem";

const pendingUserActions = new Map<
  number,
  { action: PendingUserAction; expiresAt: number }
>();

const USER_PROMPT_TAGS: Record<PendingUserAction, string> = {
  cn: "国服战绩总览查询",
  match: "国服近期对局查询",
  redeem: "兑换卡密",
};

const ADMIN_PROMPT_TAGS: Record<PendingAdminAction, string> = {
  admin_user_view: "后台查询用户",
  admin_quota_add: "后台添加次数",
  admin_quota_deduct: "后台减少次数",
  admin_vip_manage: "后台 VIP 管理",
  admin_ban_manage: "后台封禁管理",
  admin_redeem_create: "后台生成卡密",
  admin_redeem_view: "后台查询卡密",
  admin_redeem_void: "后台作废卡密",
  super_admin_add: "后台添加普通管理员",
  super_admin_remark: "后台修改管理员备注",
  super_set_reg_quota: "设置新注册赠送次数",
  super_set_inv_quota: "设置邀请赠送次数",
  super_set_chk_quota: "设置每日签到赠送次数",
};

function setPendingUserAction(
  userId: number | undefined,
  action: PendingUserAction
): void {
  if (!userId) return;
  pendingUserActions.set(userId, {
    action,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

function consumePendingUserAction(
  userId: number | undefined
): PendingUserAction | null {
  if (!userId) return null;
  const entry = pendingUserActions.get(userId);
  if (!entry) return null;
  pendingUserActions.delete(userId);
  if (Date.now() > entry.expiresAt) return null;
  return entry.action;
}

async function openUserCenter(ctx: Context, isEdit = false): Promise<void> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  if (!tgId || tgId <= 0) {
    await ctx.reply("⚠️ 无法识别你的 Telegram 用户信息。");
    return;
  }

  const ensured = await ensureUserRegistered(ctx, null);
  let user = ensured.user;
  if (!user) {
    const profileRes = await relayInternalRequest<{
      ok: boolean;
      data: UserProfileDto;
    }>("GET", "/internal/user/profile", {
      params: { tgId, nickname, username },
    });
    user = profileRes.data;
  }

  const activeAdmin = await tryGetActiveAdmin(tgId);
  if (activeAdmin && activeAdmin.isActive) {
    user = {
      ...user,
      isAdmin: true,
      adminRole: activeAdmin.role,
      roastUnlimited: true,
    };
  }

  const { text, keyboard } = buildUserCenterView(user, ensured.settings);
  if (isEdit && ctx.callbackQuery?.message) {
    await safeEditMessage(ctx, text, keyboard);
  } else {
    const bottomKeyboard =
      ctx.chat?.type === "private"
        ? buildPersistentBottomKeyboard(Boolean(user.isAdmin))
        : undefined;
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: bottomKeyboard || keyboard,
    });
    if (bottomKeyboard) {
      await ctx.reply("快捷操作面板：", {
        reply_markup: keyboard,
      });
    }
  }
}

async function executeCheckin(ctx: Context): Promise<{
  text: string;
  alreadyCheckedIn: boolean;
}> {
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
    return {
      alreadyCheckedIn: true,
      text: `📅 你今天（北京时间 <code>${escapeHtml(d.today)}</code>）已经签过到啦！\n当前剩余锐评次数：<b>${d.quota}</b> 次（每日 00:00 刷新）。`,
    };
  }
  return {
    alreadyCheckedIn: false,
    text: d.rewardEnabled && d.rewardQuota > 0
      ? `🎉 <b>签到成功！</b>（北京时间 <code>${escapeHtml(d.today)}</code>）\n获得锐评次数 <b>+${d.rewardQuota}</b> 次，当前剩余：<b>${d.quota}</b> 次。`
      : `📅 <b>签到成功！</b>（北京时间 <code>${escapeHtml(d.today)}</code>）\n当前签到赠送次数已关闭，当前剩余：<b>${d.quota}</b> 次。`,
  };
}

async function executeRedeem(ctx: Context, rawCode: string): Promise<string> {
  const code = rawCode.trim().split(/\s+/)[0];
  if (!code) {
    return "⚠️ 请输入有效的兑换卡密。";
  }
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
    json: { tgId, code, nickname, username },
  });
  const d = res.data;
  if (d.rewardType === "vip_days") {
    return `👑 <b>卡密兑换成功！</b>\n卡密：<code>${escapeHtml(d.code)}</code>\n已增加 VIP <b>${d.rewardValue}</b> 天，当前 VIP 到期时间（北京时间）：<b>${escapeHtml(d.vipExpireAt || "")}</b>。`;
  }
  return `🎟 <b>卡密兑换成功！</b>\n卡密：<code>${escapeHtml(d.code)}</code>\n已增加锐评次数 <b>+${d.rewardValue}</b> 次，当前剩余：<b>${d.quota}</b> 次。`;
}

async function executeCnQuery(ctx: Context, rawInput: string): Promise<void> {
  const bnet = rawInput.trim().split(/\s+/)[0];
  if (!bnet) return;
  await ctx.replyWithChatAction("typing");
  try {
    await assertBotNotMaintenance(ctx);
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
    await assertBotNotMaintenance(ctx);
    const { text, keyboard } = await buildCnMatchListView(bnet, "sport", 1);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err) {
    await handleCommandError(ctx, err);
  }
}

bot.command(["start", "help"], async (ctx) => {
  const { tgId } = getTgUserMeta(ctx);
  const inviterId = parseStartInvitePayload(ctx.match);

  let isNewUser = false;
  let inviteRewardGranted = false;
  let inviteRewardQuota = 0;
  let settings: SystemSettingsDto | undefined;
  let isAdminUser = false;

  if (tgId > 0) {
    try {
      const ensured = await ensureUserRegistered(ctx, inviterId);
      isNewUser = ensured.isNewUser;
      inviteRewardGranted = ensured.inviteRewardGranted;
      inviteRewardQuota = ensured.inviteRewardQuota;
      settings = ensured.settings;
      isAdminUser = Boolean(ensured.user?.isAdmin);
    } catch (err) {
      if (err instanceof RelayServiceError && err.code === "BOT_MAINTENANCE") {
        await ctx.reply(err.message, { parse_mode: "HTML" });
        return;
      }
      console.error("[/start ensure user failed]", err);
    }
    if (!isAdminUser) {
      isAdminUser = await resolveIsActiveAdminForCtx(ctx);
    }
  }

  const regQuota = settings
    ? settings.registerRewardEnabled
      ? settings.registerRewardQuota
      : 0
    : DEFAULT_REGISTER_QUOTA;
  const invQuota = settings
    ? settings.inviteRewardEnabled
      ? settings.inviteRewardQuota
      : 0
    : INVITE_REWARD_QUOTA;
  const chkQuota = settings
    ? settings.checkinRewardEnabled
      ? settings.checkinRewardQuota
      : 0
    : CHECKIN_REWARD_QUOTA;

  const lines: string[] = [
    `🇨🇳 <b>欢迎使用《守望先锋 2》国服战绩查询机器人！</b>`,
    ``,
  ];

  if (isNewUser && regQuota > 0) {
    lines.push(
      `🎁 <b>新用户福利：</b>已为你发放 <b>+${regQuota} 次</b> 免费 AI 锐评体验额度！`
    );
  }
  if (inviteRewardGranted && inviteRewardQuota > 0) {
    lines.push(
      `🤝 <b>邀请奖励已生效：</b>你通过好友邀请注册，已为邀请人发放 <b>+${inviteRewardQuota} 次</b> 锐评额度！`
    );
  }

  lines.push(
    `📌 <b>可用指令：</b>`,
    `• <code>/cn 战网ID</code> — 查询国服段位、赛季统计与常用英雄`,
    `• <code>/match 战网ID</code> — 查询国服近期战绩流水与单场对局详情`,
    `• <code>/me</code> — 个人中心、签到（${chkQuota > 0 ? `+${chkQuota}次/天` : "已关闭加次"}）、邀请（${invQuota > 0 ? `+${invQuota}次/人` : "已关闭加次"}）与卡密兑换`,
    `• <code>/checkin</code> — 每日签到（北京时间 00:00 刷新）`,
    `• <code>/redeem 卡密</code> — 兑换锐评次数或 VIP 会员`,
    isAdminUser ? `• <code>/admin</code> — 打开管理控制台` : "",
    ``,
    `💡 已为你启用底部快捷菜单栏，也可随时在聊天框直接发送战网 ID。`
  );

  const bottomKeyboard =
    ctx.chat?.type === "private"
      ? buildPersistentBottomKeyboard(isAdminUser)
      : undefined;

  await ctx.reply(lines.filter(Boolean).join("\n"), {
    parse_mode: "HTML",
    reply_markup: bottomKeyboard,
  });
});

bot.command("me", async (ctx) => {
  try {
    await assertBotNotMaintenance(ctx);
    await openUserCenter(ctx, false);
  } catch (err) {
    await handleCommandError(ctx, err);
  }
});

bot.command("checkin", async (ctx) => {
  try {
    await assertBotNotMaintenance(ctx);
    const { text } = await executeCheckin(ctx);
    await ctx.reply(text, { parse_mode: "HTML" });
  } catch (err) {
    await handleCommandError(ctx, err);
  }
});

bot.command("redeem", async (ctx) => {
  const rawArg = ctx.match.trim();
  if (!rawArg) {
    try {
      await assertBotNotMaintenance(ctx);
      setPendingUserAction(ctx.from?.id, "redeem");
      await ctx.reply(
        `🎟 <b>${USER_PROMPT_TAGS.redeem}</b>\n请直接发送要兑换的卡密编号：`,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "输入卡密，如 OW2C-10-XXXX",
            selective: true,
          },
        }
      );
    } catch (err) {
      await handleCommandError(ctx, err);
    }
    return;
  }

  try {
    await assertBotNotMaintenance(ctx);
    const replyText = await executeRedeem(ctx, rawArg);
    await ctx.reply(replyText, { parse_mode: "HTML" });
  } catch (err) {
    await handleCommandError(ctx, err);
  }
});

bot.command("cn", async (ctx) => {
  const rawArg = ctx.match.trim();
  if (!rawArg) {
    try {
      await assertBotNotMaintenance(ctx);
      setPendingUserAction(ctx.from?.id, "cn");
      await ctx.reply(
        `🇨🇳 <b>${USER_PROMPT_TAGS.cn}</b>\n请直接发送国服战网 ID（例如：<code>玩家昵称#51234</code>）：`,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "输入国服战网 ID，如 玩家#51234",
            selective: true,
          },
        }
      );
    } catch (err) {
      await handleCommandError(ctx, err);
    }
    return;
  }
  await executeCnQuery(ctx, rawArg);
});

bot.command("match", async (ctx) => {
  const rawArg = ctx.match.trim();
  if (!rawArg) {
    try {
      await assertBotNotMaintenance(ctx);
      setPendingUserAction(ctx.from?.id, "match");
      await ctx.reply(
        `📋 <b>${USER_PROMPT_TAGS.match}</b>\n请直接发送国服战网 ID（例如：<code>玩家昵称#51234</code>）：`,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "输入国服战网 ID，如 玩家#51234",
            selective: true,
          },
        }
      );
    } catch (err) {
      await handleCommandError(ctx, err);
    }
    return;
  }
  await executeMatchQuery(ctx, rawArg);
});

bot.command("admin", async (ctx) => {
  if (ctx.chat?.type !== "private") {
    return;
  }
  try {
    const operatorId = Number(ctx.from?.id || 0);
    const admin = await fetchAdminMe(operatorId);
    const { text, keyboard } = buildAdminDashboardView(admin);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err) {
    await handleCommandError(ctx, err);
  }
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) return;

  // 处理输入框旁常驻底部快捷按钮点击
  if (text === "👤 个人中心") {
    try {
      await assertBotNotMaintenance(ctx);
      await openUserCenter(ctx, false);
    } catch (err) {
      await handleCommandError(ctx, err);
    }
    return;
  }

  if (text === "📅 每日签到") {
    try {
      await assertBotNotMaintenance(ctx);
      const { text: chkText } = await executeCheckin(ctx);
      await ctx.reply(chkText, { parse_mode: "HTML" });
    } catch (err) {
      await handleCommandError(ctx, err);
    }
    return;
  }

  if (text === "🎟 兑换卡密") {
    try {
      await assertBotNotMaintenance(ctx);
      setPendingUserAction(ctx.from?.id, "redeem");
      await ctx.reply(
        `🎟 <b>${USER_PROMPT_TAGS.redeem}</b>\n请直接发送要兑换的卡密编号：`,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "输入卡密，如 OW2C-10-XXXX",
            selective: true,
          },
        }
      );
    } catch (err) {
      await handleCommandError(ctx, err);
    }
    return;
  }

  if (text === "🇨🇳 战绩查询") {
    try {
      await assertBotNotMaintenance(ctx);
      setPendingUserAction(ctx.from?.id, "cn");
      await ctx.reply(
        `🇨🇳 <b>${USER_PROMPT_TAGS.cn}</b>\n请直接发送国服战网 ID（例如：<code>玩家昵称#51234</code>）：`,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "输入国服战网 ID，如 玩家#51234",
            selective: true,
          },
        }
      );
    } catch (err) {
      await handleCommandError(ctx, err);
    }
    return;
  }

  if (text === "📋 战绩流水") {
    try {
      await assertBotNotMaintenance(ctx);
      setPendingUserAction(ctx.from?.id, "match");
      await ctx.reply(
        `📋 <b>${USER_PROMPT_TAGS.match}</b>\n请直接发送国服战网 ID（例如：<code>玩家昵称#51234</code>）：`,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "输入国服战网 ID，如 玩家#51234",
            selective: true,
          },
        }
      );
    } catch (err) {
      await handleCommandError(ctx, err);
    }
    return;
  }

  if (text === "🛠 管理员控制台") {
    if (ctx.chat?.type !== "private") {
      await ctx.reply("⚠️ 管理控制台仅限私聊打开。");
      return;
    }
    try {
      const operatorId = Number(ctx.from?.id || 0);
      const admin = await fetchAdminMe(operatorId);
      const { text: dashText, keyboard } = buildAdminDashboardView(admin);
      await ctx.reply(dashText, { parse_mode: "HTML", reply_markup: keyboard });
    } catch (err) {
      await handleCommandError(ctx, err);
    }
    return;
  }

  const userId = Number(ctx.from?.id || 0);
  const replyMsg = ctx.message.reply_to_message;

  // 1. 优先匹配后台管理待输入状态
  if (replyMsg?.from?.is_bot && replyMsg.text && ctx.chat.type === "private") {
    const matchedAdminTag = (
      Object.entries(ADMIN_PROMPT_TAGS) as Array<[PendingAdminAction, string]>
    ).find(([, tag]) => replyMsg.text?.includes(tag));
    if (matchedAdminTag) {
      const pendingState = consumePendingAdminInput(userId) || {
        action: matchedAdminTag[0],
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
      await handlePendingAdminInput(ctx, userId, pendingState, text);
      return;
    }
  }

  const activeAdminPending =
    ctx.chat.type === "private" ? consumePendingAdminInput(userId) : null;
  if (activeAdminPending) {
    await handlePendingAdminInput(ctx, userId, activeAdminPending, text);
    return;
  }

  // 2. 普通用户待输入状态（战网查询 / 战绩流水 / 兑换卡密）
  let action: PendingUserAction | null = null;
  if (replyMsg?.from?.is_bot && replyMsg.text) {
    if (replyMsg.text.includes(USER_PROMPT_TAGS.cn)) action = "cn";
    else if (replyMsg.text.includes(USER_PROMPT_TAGS.match)) action = "match";
    else if (replyMsg.text.includes(USER_PROMPT_TAGS.redeem)) action = "redeem";
  }

  if (!action && ctx.chat.type === "private") {
    action = consumePendingUserAction(userId);
    if (!action && /^\S+[#＃]\d+$/.test(text)) {
      action = "cn";
    }
  } else if (action) {
    consumePendingUserAction(userId);
  }

  if (!action) return;

  if (action === "cn") await executeCnQuery(ctx, text);
  else if (action === "match") await executeMatchQuery(ctx, text);
  else if (action === "redeem") {
    try {
      await assertBotNotMaintenance(ctx);
      const out = await executeRedeem(ctx, text);
      await ctx.reply(out, { parse_mode: "HTML" });
    } catch (err) {
      await handleCommandError(ctx, err);
    }
  }
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const parts = data.split(":");
  const action = parts[0];

  try {
    // --- 个人中心 / 签到 / 兑卡 ---
    if (action === "u") {
      await assertBotNotMaintenance(ctx);
      const sub = parts[1];
      if (sub === "refresh") {
        await openUserCenter(ctx, true);
        await safeAnswerCallback(ctx, "已刷新个人中心");
        return;
      }
      if (sub === "checkin") {
        const { text: chkMsg } = await executeCheckin(ctx);
        await openUserCenter(ctx, true);
        await safeAnswerCallback(ctx, chkMsg.replace(/<[^>]+>/g, "").slice(0, 180), true);
        return;
      }
      if (sub === "redeem_prompt") {
        setPendingUserAction(ctx.from?.id, "redeem");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🎟 <b>${USER_PROMPT_TAGS.redeem}</b>\n请直接发送要兑换的卡密编号：`,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "输入卡密，如 OW2C-10-XXXX",
              selective: true,
            },
          }
        );
        return;
      }
      if (sub === "open_admin") {
        if (ctx.chat?.type !== "private") {
          await safeAnswerCallback(ctx, "请在与机器人的私聊中打开管理控制台", true);
          return;
        }
        const operatorId = Number(ctx.from?.id || 0);
        const admin = await fetchAdminMe(operatorId);
        const { text: dashText, keyboard } = buildAdminDashboardView(admin);
        await safeEditMessage(ctx, dashText, keyboard);
        await safeAnswerCallback(ctx);
        return;
      }
    }

    // --- 战绩总览 ---
    if (action === "o" && parts.length >= 3) {
      await assertBotNotMaintenance(ctx);
      const mode: CnGameMode = parts[1] === "l" ? "leisure" : "sport";
      const bnet = parts.slice(2).join(":");
      const { text, keyboard } = await buildCnOverviewView(bnet, mode);
      await safeEditMessage(ctx, text, keyboard);
      await safeAnswerCallback(ctx);
      return;
    }

    // --- 战绩流水 ---
    if (action === "m" && parts.length >= 4) {
      await assertBotNotMaintenance(ctx);
      const mode: CnGameMode = parts[1] === "l" ? "leisure" : "sport";
      const page = Math.max(1, Number(parts[2]) || 1);
      const bnet = parts.slice(3).join(":");
      const { text, keyboard } = await buildCnMatchListView(bnet, mode, page);
      await safeEditMessage(ctx, text, keyboard);
      await safeAnswerCallback(ctx);
      return;
    }

    // --- 单局详情 ---
    if (action === "d" && parts.length === 2) {
      await assertBotNotMaintenance(ctx);
      const { text, keyboard } = await buildCnMatchDetailView(parts[1]);
      await safeEditMessage(ctx, text, keyboard);
      await safeAnswerCallback(ctx);
      return;
    }

    // --- 个人赛季锐评 / 隐性段位评估 ---
    if (action === "r" && parts.length === 3) {
      await assertBotNotMaintenance(ctx);
      const rKind = parts[1] === "mmr" ? "mmr" : "self";
      const pRef = parts[2];
      const pEntry = profileContextCache.get(pRef);
      if (!pEntry || Date.now() > pEntry.expiresAt) {
        await safeAnswerCallback(
          ctx,
          "战绩快照已过期，请点击「刷新总览」后再试。",
          true
        );
        return;
      }

      const auth = await authorizeRoastForCtx(ctx);
      await safeAnswerCallback(ctx, "正在生成 AI 分析...");
      const titleLabel =
        rKind === "mmr" ? "隐性段位评估" : "个人赛季锐评";
      const loadingMsg = await ctx.reply(
        `🤖 正在为 <code>${escapeHtml(pEntry.bnet)}</code> 生成<b>${titleLabel}</b>，请稍候...`,
        { parse_mode: "HTML" }
      );

      try {
        const reviewHtml =
          rKind === "mmr"
            ? await generateDeepSeekMmrEvaluation(
                pEntry.bnet,
                pEntry.mode,
                pEntry.snapshotText,
                pEntry.currentRankLabel
              )
            : await generateDeepSeekProfileRoast(
                pEntry.bnet,
                pEntry.mode,
                pEntry.snapshotText
              );

        const consumeRes = await consumeRoastForCtx(
          ctx,
          rKind === "mmr" ? "roast_mmr" : "roast_self",
          `${titleLabel}:${pEntry.bnet}`
        );
        const quotaFooter =
          auth.unlimited || consumeRes.unlimited
            ? `\n\n⚡ <i>管理员/VIP 免限，未扣减次数</i>`
            : `\n\n⚡ <i>本次已消耗 1 次锐评额度，剩余 <b>${consumeRes.quota}</b> 次</i>`;

        await ctx.api.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          `${reviewHtml}${quotaFooter}`,
          { parse_mode: "HTML" }
        );
      } catch (aiErr) {
        const errHtml =
          aiErr instanceof DashenError || aiErr instanceof RelayServiceError
            ? aiErr.message
            : "❌ AI 分析生成失败，请稍后重试。";
        await ctx.api.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          errHtml,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    // --- 单局 DeepSeek 锐评 ---
    if (action === "a" && parts.length === 2) {
      await assertBotNotMaintenance(ctx);
      const cached = matchCache.get(parts[1]);
      if (!cached || Date.now() > cached.expiresAt) {
        await safeAnswerCallback(
          ctx,
          "对局缓存已过期，请返回战绩列表重新打开详情。",
          true
        );
        return;
      }

      const auth = await authorizeRoastForCtx(ctx);
      await safeAnswerCallback(ctx, "正在呼叫 DeepSeek 生成锐评...");
      const loadingMsg = await ctx.reply(
        `🤖 正在分析 <b>${escapeHtml(sanitizeSafeText(cached.bnet, "loading-bnet"))}</b> 的本局数据并生成 DeepSeek 锐评，请稍候...`,
        { parse_mode: "HTML" }
      );
      try {
        const reviewText = await generateDeepSeekMatchReview(
          cached.bnet,
          cached.customerToken,
          cached.matchId
        );
        const consumeRes = await consumeRoastForCtx(
          ctx,
          "roast_match",
          `单局锐评:${cached.matchId}:${cached.bnet}`
        );
        const quotaFooter =
          auth.unlimited || consumeRes.unlimited
            ? `\n\n⚡ <i>管理员/VIP 免限，未扣减次数</i>`
            : `\n\n⚡ <i>本次已消耗 1 次锐评额度，剩余 <b>${consumeRes.quota}</b> 次</i>`;

        await ctx.api.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          `${reviewText}${quotaFooter}`,
          { parse_mode: "HTML" }
        );
      } catch (aiErr) {
        const errHtml =
          aiErr instanceof DashenError || aiErr instanceof RelayServiceError
            ? aiErr.message
            : "❌ DeepSeek 锐评生成失败，请稍后重试。";
        await ctx.api.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          errHtml,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    // --- 后台管理回调（仅限私聊） ---
    if (action === "ad") {
      if (ctx.chat?.type !== "private") {
        await safeAnswerCallback(ctx, "管理功能仅限私聊使用", true);
        return;
      }
      const operatorId = Number(ctx.from?.id || 0);
      const sub = parts[1];

      if (sub === "home") {
        const admin = await fetchAdminMe(operatorId);
        const { text: dashText, keyboard } = buildAdminDashboardView(admin);
        await safeEditMessage(ctx, dashText, keyboard);
        await safeAnswerCallback(ctx);
        return;
      }

      if (sub === "u_view") {
        setPendingAdminInput(operatorId, "admin_user_view");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.admin_user_view}</b>\n请输入要查询的用户 TG 数字 ID 或 @用户名（输入 <code>all</code> 可查看最近用户列表）：`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "q_add") {
        setPendingAdminInput(operatorId, "admin_quota_add");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.admin_quota_add}</b>\n请输入：<code>用户TG_ID 次数 原因</code>\n例如：<code>612158982 5 补偿活动次数</code>`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "q_ded") {
        setPendingAdminInput(operatorId, "admin_quota_deduct");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.admin_quota_deduct}</b>\n请输入：<code>用户TG_ID 次数 原因</code>\n例如：<code>612158982 1 违规扣减</code>`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "vip") {
        setPendingAdminInput(operatorId, "admin_vip_manage");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.admin_vip_manage}</b>\n开通/续期请输入：<code>用户TG_ID 天数 原因</code>\n取消请输入：<code>用户TG_ID revoke 原因</code>`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "ban") {
        setPendingAdminInput(operatorId, "admin_ban_manage");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.admin_ban_manage}</b>\n请输入：<code>用户TG_ID ban|unban 原因</code>`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "c_gen") {
        setPendingAdminInput(operatorId, "admin_redeem_create");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.admin_redeem_create}</b>\n请输入：<code>quota|vip_days 数值 [数量1~50]</code>\n例如：<code>quota 10 5</code>`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "c_view") {
        setPendingAdminInput(operatorId, "admin_redeem_view");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.admin_redeem_view}</b>\n请输入要查询的卡密编号：`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "c_void") {
        setPendingAdminInput(operatorId, "admin_redeem_void");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.admin_redeem_void}</b>\n请输入：<code>卡密编号 作废原因</code>`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "stats") {
        const r = await relayInternalRequest<{ ok: boolean; data: any }>(
          "GET",
          "/internal/admin/stats",
          { operatorId }
        );
        const s = r.data;
        const admin = await fetchAdminMe(operatorId);
        const { keyboard } = buildAdminDashboardView(admin);
        await safeEditMessage(
          ctx,
          [
            `📊 <b>运营统计（北京时间 <code>${escapeHtml(s.today)}</code>）</b>`,
            `━━━━━━━━━━━━━━━━━━`,
            `• 累计用户数：<b>${s.totalUsers}</b>（今日新增：<b>${s.todayNewUsers}</b>）`,
            `• 今日签到人数：<b>${s.todayCheckins}</b>`,
            `• 当前有效 VIP：<b>${s.activeVips}</b>`,
            `• 今日付费锐评消耗：<b>${s.todayPaidRoasts}</b> 次`,
            `• 未使用卡密库存：<b>${s.unusedRedeemCodes}</b> 张`,
          ].join("\n"),
          keyboard
        );
        await safeAnswerCallback(ctx);
        return;
      }

      if (sub === "sys_cfg") {
        const r = await relayInternalRequest<{
          ok: boolean;
          data: SystemSettingsDto;
        }>("GET", "/internal/admin/settings", { operatorId });
        const { text: cfgText, keyboard } = buildSuperSettingsView(r.data);
        await safeEditMessage(ctx, cfgText, keyboard);
        await safeAnswerCallback(ctx);
        return;
      }

      if (
        sub === "sys_toggle_status" ||
        sub === "sys_toggle_reg" ||
        sub === "sys_toggle_inv" ||
        sub === "sys_toggle_chk"
      ) {
        const curRes = await relayInternalRequest<{
          ok: boolean;
          data: SystemSettingsDto;
        }>("GET", "/internal/admin/settings", { operatorId });
        const cur = curRes.data;
        const patch: Record<string, any> = {};
        if (sub === "sys_toggle_status") {
          patch.botStatus =
            cur.botStatus === "maintenance" ? "normal" : "maintenance";
        } else if (sub === "sys_toggle_reg") {
          patch.registerRewardEnabled = !cur.registerRewardEnabled;
        } else if (sub === "sys_toggle_inv") {
          patch.inviteRewardEnabled = !cur.inviteRewardEnabled;
        } else if (sub === "sys_toggle_chk") {
          patch.checkinRewardEnabled = !cur.checkinRewardEnabled;
        }
        const updRes = await relayInternalRequest<{
          ok: boolean;
          data: SystemSettingsDto;
        }>("POST", "/internal/admin/settings", {
          json: patch,
          operatorId,
        });
        const { text: cfgText, keyboard } = buildSuperSettingsView(updRes.data);
        await safeEditMessage(ctx, cfgText, keyboard);
        await safeAnswerCallback(ctx, "设置已保存");
        return;
      }

      if (sub === "sys_set_reg") {
        setPendingAdminInput(operatorId, "super_set_reg_quota");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.super_set_reg_quota}</b>\n请输入新注册赠送次数（0 ~ 10000 的整数，例如 <code>3</code> 或 <code>0</code>）：`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "sys_set_inv") {
        setPendingAdminInput(operatorId, "super_set_inv_quota");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.super_set_inv_quota}</b>\n请输入邀请人赠送次数（0 ~ 10000 的整数，例如 <code>1</code> 或 <code>0</code>）：`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "sys_set_chk") {
        setPendingAdminInput(operatorId, "super_set_chk_quota");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.super_set_chk_quota}</b>\n请输入每日签到赠送次数（0 ~ 10000 的整数，例如 <code>1</code> 或 <code>0</code>）：`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "a_list") {
        const r = await relayInternalRequest<{ ok: boolean; data: any }>(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const adminsList: any[] = r.data.admins || [];
        const lines = [
          `👥 <b>管理员列表（共 ${adminsList.length} 人）</b>`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        const kb = new InlineKeyboard();
        for (const a of adminsList) {
          const roleTag = a.role === "super_admin" ? "👑超管" : "🛡普管";
          const stTag = a.isActive ? "✅启用" : "⏸停用";
          lines.push(
            `• ${roleTag} <code>${a.tgId}</code>（${escapeHtml(a.remark || "无备注")}）· ${stTag} · ${a.permissions.length}项权限`
          );
          if (a.role !== "super_admin") {
            kb.text(`编辑 ${a.tgId}`, `ad:a_edit:${a.tgId}`).row();
          }
        }
        kb.text("➕ 添加普通管理员", "ad:a_add").row();
        kb.text("⬅️ 返回控制台", "ad:home");
        await safeEditMessage(ctx, lines.join("\n"), kb);
        await safeAnswerCallback(ctx);
        return;
      }

      if (sub === "a_add") {
        setPendingAdminInput(operatorId, "super_admin_add");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.super_admin_add}</b>\n请输入：<code>新管理员TG_ID 备注名</code>`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "a_edit" && parts[2]) {
        const targetId = Number(parts[2]);
        const r = await relayInternalRequest<{ ok: boolean; data: any }>(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const target = (r.data.admins || []).find(
          (x: any) => Number(x.tgId) === targetId
        );
        if (!target) {
          await safeAnswerCallback(ctx, "未找到该管理员", true);
          return;
        }
        const allPerms: string[] =
          r.data.allPermissions || Object.keys(PERMISSION_LABELS_FALLBACK);
        const labels: Record<string, string> =
          r.data.permissionLabels || PERMISSION_LABELS_FALLBACK;
        const owned: string[] = target.permissions || [];

        const lines = [
          `👤 <b>编辑普通管理员：<code>${target.tgId}</code></b>`,
          `• 备注：<b>${escapeHtml(target.remark || "无")}</b>  |  状态：${target.isActive ? "✅ 已启用" : "⏸ 已停用"}`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        const kb = new InlineKeyboard();
        allPerms.forEach((perm, idx) => {
          const on = owned.includes(perm);
          kb.text(`${on ? "✅" : "⬜"} ${getPermLabel(perm, labels)}`, `ad:a_perm:${target.tgId}:${perm}`);
          if (idx % 2 === 1) kb.row();
        });
        if (allPerms.length % 2 !== 0) kb.row();
        kb.text("✏️ 修改备注", `ad:a_rmk:${target.tgId}`)
          .text(
            target.isActive ? "⏸ 停用" : "✅ 启用",
            `ad:a_act:${target.tgId}:${target.isActive ? 0 : 1}`
          )
          .row();
        kb.text("🗑 删除管理员", `ad:a_del:${target.tgId}`)
          .text("⬅️ 返回列表", "ad:a_list");

        await safeEditMessage(ctx, lines.join("\n"), kb);
        await safeAnswerCallback(ctx);
        return;
      }

      if (sub === "a_perm" && parts[2] && parts[3]) {
        const targetId = Number(parts[2]);
        const permCode = parts.slice(3).join(":");
        await relayInternalRequest("POST", "/internal/admin/admins/permission", {
          json: { targetTgId: targetId, permCode },
          operatorId,
        });
        const r = await relayInternalRequest<{ ok: boolean; data: any }>(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const target = (r.data.admins || []).find(
          (x: any) => Number(x.tgId) === targetId
        );
        const allPerms: string[] =
          r.data.allPermissions || Object.keys(PERMISSION_LABELS_FALLBACK);
        const labels: Record<string, string> =
          r.data.permissionLabels || PERMISSION_LABELS_FALLBACK;
        const owned: string[] = target?.permissions || [];
        const kb = new InlineKeyboard();
        allPerms.forEach((perm, idx) => {
          const on = owned.includes(perm);
          kb.text(`${on ? "✅" : "⬜"} ${getPermLabel(perm, labels)}`, `ad:a_perm:${targetId}:${perm}`);
          if (idx % 2 === 1) kb.row();
        });
        if (allPerms.length % 2 !== 0) kb.row();
        kb.text("✏️ 修改备注", `ad:a_rmk:${targetId}`)
          .text(
            target?.isActive ? "⏸ 停用" : "✅ 启用",
            `ad:a_act:${targetId}:${target?.isActive ? 0 : 1}`
          )
          .row();
        kb.text("🗑 删除管理员", `ad:a_del:${targetId}`)
          .text("⬅️ 返回列表", "ad:a_list");
        await safeEditMessage(
          ctx,
          [
            `👤 <b>编辑普通管理员：<code>${targetId}</code></b>`,
            `• 备注：<b>${escapeHtml(target?.remark || "无")}</b>  |  状态：${target?.isActive ? "✅ 已启用" : "⏸ 已停用"}`,
            `━━━━━━━━━━━━━━━━━━`,
          ].join("\n"),
          kb
        );
        await safeAnswerCallback(ctx, "权限已更新");
        return;
      }

      if (sub === "a_rmk" && parts[2]) {
        const targetId = Number(parts[2]);
        setPendingAdminInput(operatorId, "super_admin_remark", targetId);
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🛠 <b>${ADMIN_PROMPT_TAGS.super_admin_remark}</b>\n请输入管理员 <code>${targetId}</code> 的新备注名：`,
          { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
        );
        return;
      }

      if (sub === "a_act" && parts[2] && parts[3] !== undefined) {
        const targetId = Number(parts[2]);
        const nextActive = Number(parts[3]) === 1;
        await relayInternalRequest("POST", "/internal/admin/admins/meta", {
          json: { targetTgId: targetId, isActive: nextActive },
          operatorId,
        });
        await safeAnswerCallback(ctx, nextActive ? "已启用" : "已停用");
        const r = await relayInternalRequest<{ ok: boolean; data: any }>(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const adminsList: any[] = r.data.admins || [];
        const lines = [
          `👥 <b>管理员列表（共 ${adminsList.length} 人）</b>`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        const kb = new InlineKeyboard();
        for (const a of adminsList) {
          const roleTag = a.role === "super_admin" ? "👑超管" : "🛡普管";
          const stTag = a.isActive ? "✅启用" : "⏸停用";
          lines.push(
            `• ${roleTag} <code>${a.tgId}</code>（${escapeHtml(a.remark || "无备注")}）· ${stTag} · ${a.permissions.length}项权限`
          );
          if (a.role !== "super_admin") {
            kb.text(`编辑 ${a.tgId}`, `ad:a_edit:${a.tgId}`).row();
          }
        }
        kb.text("➕ 添加普通管理员", "ad:a_add").row();
        kb.text("⬅️ 返回控制台", "ad:home");
        await safeEditMessage(ctx, lines.join("\n"), kb);
        return;
      }

      if (sub === "a_del" && parts[2]) {
        const targetId = Number(parts[2]);
        await relayInternalRequest("DELETE", "/internal/admin/admins", {
          params: { targetTgId: targetId },
          operatorId,
        });
        await safeAnswerCallback(ctx, "已删除普通管理员");
        const r = await relayInternalRequest<{ ok: boolean; data: any }>(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const adminsList: any[] = r.data.admins || [];
        const lines = [
          `👥 <b>管理员列表（共 ${adminsList.length} 人）</b>`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        const kb = new InlineKeyboard();
        for (const a of adminsList) {
          const roleTag = a.role === "super_admin" ? "👑超管" : "🛡普管";
          const stTag = a.isActive ? "✅启用" : "⏸停用";
          lines.push(
            `• ${roleTag} <code>${a.tgId}</code>（${escapeHtml(a.remark || "无备注")}）· ${stTag} · ${a.permissions.length}项权限`
          );
          if (a.role !== "super_admin") {
            kb.text(`编辑 ${a.tgId}`, `ad:a_edit:${a.tgId}`).row();
          }
        }
        kb.text("➕ 添加普通管理员", "ad:a_add").row();
        kb.text("⬅️ 返回控制台", "ad:home");
        await safeEditMessage(ctx, lines.join("\n"), kb);
        return;
      }

      if (sub === "logs") {
        const page = Math.max(1, Number(parts[2]) || 1);
        const r = await relayInternalRequest<{ ok: boolean; data: any }>(
          "GET",
          "/internal/admin/audit-logs",
          { params: { page, pageSize: 6 }, operatorId }
        );
        const d = r.data;
        const lines = [
          `📜 <b>操作审计日志（第 ${d.page}/${d.totalPages} 页 · 共 ${d.total} 条）</b>`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        if (!d.items || d.items.length === 0) {
          lines.push("暂无审计日志记录。");
        } else {
          for (const item of d.items) {
            lines.push(
              `• <code>${escapeHtml(item.createdAt)}</code> | 操作人 <code>${item.operatorId}</code> | <b>${escapeHtml(item.action)}</b> → ${escapeHtml(item.targetId || "-")}${item.detail ? `（${escapeHtml(item.detail)}）` : ""}`
            );
          }
        }
        const kb = new InlineKeyboard();
        if (d.page > 1) kb.text("⬅️ 上一页", `ad:logs:${d.page - 1}`);
        if (d.page < d.totalPages) kb.text("下一页 ➡️", `ad:logs:${d.page + 1}`);
        if (d.page > 1 || d.page < d.totalPages) kb.row();
        kb.text("⬅️ 返回控制台", "ad:home");
        await safeEditMessage(ctx, lines.join("\n"), kb);
        await safeAnswerCallback(ctx);
        return;
      }
    }

    await safeAnswerCallback(ctx, "无效的操作按钮");
  } catch (err) {
    const msg =
      err instanceof DashenError || err instanceof RelayServiceError
        ? err.message.replace(/<[^>]+>/g, "")
        : "操作失败，请稍后重试。";
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
  if (err instanceof DashenError || err instanceof RelayServiceError) {
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
// 9. Vercel Serverless Function 入口
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
        relayOrigin: DASHEN_RELAY_ORIGIN,
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
