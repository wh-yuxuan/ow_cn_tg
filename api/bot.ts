/**
 * 《守望先锋 2》(OW2) 国服战绩查询 Telegram 机器人（完整独立部署版）
 * 代码生成时间：2026-11-27 21:26:00 (Asia/Shanghai)
 * 运行环境：Vercel Serverless Functions (Node.js 20+ / TypeScript)
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
const DASHEN_CLIENT_TYPE = process.env.DASHEN_CLIENT_TYPE || "50";

const DASHEN_ORIGIN = process.env.DASHEN_ORIGIN || "https://ds.163.com";
const DASHEN_REFERER = process.env.DASHEN_REFERER || "https://ds.163.com/";
const DASHEN_USER_AGENT =
  process.env.DASHEN_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

const DASHEN_RELAY_ORIGIN = (
  process.env.DASHEN_RELAY_ORIGIN || "https://ow.eyy8.top"
).replace(/\/+$/, "");

const RELAY_SECRET = (process.env.RELAY_SECRET || "").trim();
const VERCEL_PUBLIC_ORIGIN = (
  process.env.VERCEL_PUBLIC_ORIGIN ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://owcntg.vercel.app")
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

// AI 锐评与隐性段位评估模型配置（支持 OpenAI 兼容格式，默认值作为 Vercel 兜底通道）
const AI_BASE_URL = (
  process.env.AI_BASE_URL || "https://api.deepseek.com"
).replace(/\/+$/, "");
const AI_API_KEY = (process.env.AI_API_KEY || "").trim();
const AI_MODEL = (process.env.AI_MODEL || "deepseek-chat").trim();
// Vercel 单次执行超时上限控制在 26s 以内（长思考模型请在后台切为 docker 节点，支持 120s 异步队列）
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

// 内存中保留的用户近期查询状态（仅用于翻页与内联按钮的短上下文恢复）
const userLastMode = new Map<number, CnGameMode>();
const userLastBnet = new Map<number, string>();
const userRecentMatchIds = new Map<number, string[]>();

// 锐评任务并发去重锁：防止同一用户对同一目标、同一类型、同一渠道重复提交并发请求
const inFlightRoastTasks = new Set<string>();

// 管理员与普通用户的多步交互输入等待态（仅暂存操作步骤）
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
  | { type: "super_ai_provider_add" };

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

// AI 锐评渠道结构定义（id = 0 表示 Vercel 环境变量默认 DeepSeek 兜底通道）
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
  operatorNickname?: string;
  providerId?: number;
  providerName?: string;
  modelName?: string;
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

async function fetchActiveAiProviders(): Promise<AiProviderDto[]> {
  let customProviders: AiProviderDto[] = [];
  let defaultDeepseekEnabled = true;

  try {
    const res = await relayInternalRequest<{
      ok: boolean;
      data: {
        defaultDeepseekEnabled: boolean;
        providers: AiProviderDto[];
      };
    }>("GET", "/internal/ai/providers/active");
    defaultDeepseekEnabled = res.data?.defaultDeepseekEnabled !== false;
    customProviders = Array.isArray(res.data?.providers)
      ? res.data.providers
      : [];
  } catch (err) {
    console.warn("[Fetch Active AI Providers Fallback]", err);
  }

  const list: AiProviderDto[] = [];
  if (defaultDeepseekEnabled && AI_API_KEY) {
    list.push({
      id: 0,
      name: "DeepSeek",
      baseUrl: AI_BASE_URL,
      apiKey: AI_API_KEY,
      maskedKey: AI_API_KEY ? `${AI_API_KEY.slice(0, 6)}****` : "",
      model: AI_MODEL,
      executionTarget: "vercel",
      isEnabled: true,
    });
  }

  for (const p of customProviders) {
    if (p && p.isEnabled && p.apiKey && p.baseUrl && p.model) {
      list.push(p);
    }
  }

  return list;
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

function getOperatorDisplayLabel(ctx: Context): string {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  if (nickname) return nickname;
  if (username) return `@${username}`;
  if (tgId > 0) return `TG#${tgId}`;
  return "";
}

async function ensureUserRegistered(
  ctx: Context,
  inviterId?: number | null
): Promise<{
  isNewUser: boolean;
  inviteRewardGranted: boolean;
  inviteRewardQuota: number;
  user?: UserProfileDto;
  settings?: SystemSettingsDto;
}> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  if (!tgId || tgId <= 0) {
    return {
      isNewUser: false,
      inviteRewardGranted: false,
      inviteRewardQuota: 0,
    };
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
  }>("POST", "/internal/user/ensure", {
    json: {
      tgId,
      nickname,
      username,
      inviterId: inviterId || null,
    },
  });
  return res.data;
}

async function tryGetActiveAdmin(tgId: number): Promise<AdminMeDto | null> {
  if (!tgId || tgId <= 0) return null;
  try {
    const res = await relayInternalRequest<{ ok: boolean; data: AdminMeDto }>(
      "GET",
      "/internal/admin/me",
      { operatorId: tgId }
    );
    return res.data || null;
  } catch {
    return null;
  }
}

async function resolveIsActiveAdminForCtx(ctx: Context): Promise<boolean> {
  const tgId = Number(ctx.from?.id || 0);
  if (!tgId || tgId <= 0) return false;
  const admin = await tryGetActiveAdmin(tgId);
  return Boolean(admin && admin.isActive);
}

function buildPersistentBottomKeyboard(isAdmin = false): Keyboard {
  const kb = new Keyboard()
    .text("👤 个人中心")
    .text("📅 每日签到")
    .text("🎟 兑换卡密")
    .row()
    .text("🇨🇳 战绩查询")
    .text("📋 战绩流水");
  if (isAdmin) {
    kb.text("🛠 管理员控制台");
  }
  kb.row();
  return kb.resized().persistent();
}

async function assertBotNotMaintenance(ctx: Context): Promise<void> {
  const tgId = Number(ctx.from?.id || 0);
  if (tgId <= 0) return;
  await relayInternalRequest("GET", "/internal/user/profile", {
    params: { tgId },
  });
}

async function authorizeRoastForCtx(ctx: Context): Promise<{
  allowed: boolean;
  unlimited: boolean;
  exemptReason: string | null;
  quota: number;
}> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  if (!tgId || tgId <= 0) {
    throw new RelayServiceError(400, "无法识别当前 Telegram 用户身份");
  }
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

async function consumeRoastByTgId(
  tgId: number,
  roastType: "roast_match" | "roast_self" | "roast_mmr",
  detail: string
): Promise<{ consumed: boolean; unlimited: boolean; quota: number }> {
  if (!tgId || tgId <= 0) {
    return { consumed: false, unlimited: false, quota: 0 };
  }
  const res = await relayInternalRequest<{
    ok: boolean;
    data: { consumed: boolean; unlimited: boolean; quota: number };
  }>("POST", "/internal/roast/consume", {
    json: { tgId, roastType, detail },
  });
  return res.data;
}

async function resolveBotUsernameForCtx(ctx: Context): Promise<string> {
  if (runtimeBotUsername) return runtimeBotUsername;
  const fromMe = String(ctx.me?.username || "")
    .replace(/^@+/, "")
    .trim();
  if (fromMe) {
    runtimeBotUsername = fromMe;
    return fromMe;
  }
  try {
    const meInfo = await ctx.api.getMe();
    const fetched = String(meInfo?.username || "")
      .replace(/^@+/, "")
      .trim();
    if (fetched) {
      runtimeBotUsername = fetched;
      return fetched;
    }
  } catch {
    // 忽略获取 Bot 用户名失败
  }
  return "";
}

async function fetchAdminMe(operatorId: number): Promise<AdminMeDto> {
  const res = await relayInternalRequest<{ ok: boolean; data: AdminMeDto }>(
    "GET",
    "/internal/admin/me",
    { operatorId }
  );
  return res.data;
}

function parseStartInvitePayload(matchText: string | undefined): number | null {
  if (!matchText) return null;
  const trimmed = matchText.trim();
  const m = trimmed.match(/^(?:inv_|invite_)?(\d{4,20})$/i);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function buildInviteLink(tgId: number, botUsername?: string): string {
  const uname = (botUsername || runtimeBotUsername || ENV_BOT_USERNAME || "")
    .replace(/^@+/, "")
    .trim();
  if (!uname) return `inv_${tgId}`;
  return `https://t.me/${uname}?start=inv_${tgId}`;
}

function buildUserCenterView(
  user: UserProfileDto,
  settings?: SystemSettingsDto,
  botUsername?: string
): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const vipStatusText = user.vipActive
    ? `✅ 有效（到期：<b>${escapeHtml(user.vipExpireAt || "")}</b>）`
    : user.vipExpireAt
      ? `⌛ 已过期（曾于 ${escapeHtml(user.vipExpireAt)} 到期）`
      : "❌ 未开通";

  const roastQuotaText = user.roastUnlimited
    ? `♾ <b>无限制</b>（${user.isAdmin ? "管理员特权" : "VIP 会员特权"} · 余额 ${user.quota} 次）`
    : `<b>${user.quota}</b> 次`;

  const regRewardStr = settings
    ? settings.registerRewardEnabled
      ? `新用户注册送 ${settings.registerRewardQuota} 次`
      : "新用户注册赠送已关闭"
    : `新用户注册送 ${DEFAULT_REGISTER_QUOTA} 次`;

  const invRewardStr = settings
    ? settings.inviteRewardEnabled
      ? `邀请好友首次启动送 +${settings.inviteRewardQuota} 次/人`
      : "邀请赠送已关闭"
    : `邀请好友首次启动送 +${INVITE_REWARD_QUOTA} 次/人`;

  const chkRewardStr = settings
    ? settings.checkinRewardEnabled
      ? `每日签到可领 +${settings.checkinRewardQuota} 次`
      : "每日签到赠送已关闭"
    : `每日签到可领 +${CHECKIN_REWARD_QUOTA} 次`;

  const inviteTarget = buildInviteLink(user.tgId, botUsername);
  const isFullInviteUrl = /^https:\/\/t\.me\//i.test(inviteTarget);

  const lines = [
    `👤 <b>个人中心 — ${escapeHtml(user.nickname || "玩家")}</b>`,
    `🆔 TG ID：<code>${user.tgId}</code>${user.username ? `  |  @${escapeHtml(user.username)}` : ""}`,
    `━━━━━━━━━━━━━━━━━━`,
    `⚡ <b>剩余 AI 锐评次数：</b>${roastQuotaText}`,
    `👑 <b>VIP 会员状态：</b>${vipStatusText}`,
    `🤝 <b>累计成功邀请：</b><b>${user.inviteCount}</b> 人`,
    `📅 <b>今日签到状态：</b>${user.lastCheckinDate ? `最近签到 <code>${escapeHtml(user.lastCheckinDate)}</code>（北京时间 00:00 刷新）` : "尚未签到"}`,
    `━━━━━━━━━━━━━━━━━━`,
    `🔗 <b>专属邀请链接：</b>`,
    isFullInviteUrl
      ? `<a href="${escapeHtml(inviteTarget)}">${escapeHtml(inviteTarget)}</a>\n<code>${escapeHtml(inviteTarget)}</code>`
      : `邀请码：<code>${escapeHtml(inviteTarget)}</code>`,
    `<i>（${escapeHtml(regRewardStr)}；${escapeHtml(invRewardStr)}；${escapeHtml(chkRewardStr)}）</i>`,
  ];

  const kb = new InlineKeyboard()
    .text("📅 每日签到", "u:checkin")
    .text("🎟 兑换卡密", "u:redeem_prompt")
    .row()
    .text("📋 复制邀请链接", "u:copy_invite")
    .text("🔄 刷新状态", "u:refresh");

  if (user.isAdmin) {
    kb.row().text("🛠 打开管理控制台", "u:open_admin");
  }

  return { text: lines.join("\n"), keyboard: kb };
}

// ============================================================================
// 5. 响应解包、安全文本清洗与工具函数
// ============================================================================

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeSafeText(raw: unknown, fieldLabel = "unknown"): string {
  const input = String(raw ?? "");
  const cleaned = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

  if (cleaned !== input) {
    console.warn("[Sanitized Unsafe Text]", {
      field: fieldLabel,
      originalLength: input.length,
      cleanedLength: cleaned.length,
    });
  }
  return cleaned;
}

function serializeSafeJsonBody(payload: unknown): {
  bodyStr: string;
  byteLength: number;
} {
  const bodyStr = JSON.stringify(payload, (_k, v) =>
    typeof v === "string" ? sanitizeSafeText(v, "json-field") : v
  );
  return {
    bodyStr,
    byteLength: Buffer.byteLength(bodyStr, "utf8"),
  };
}

function isSafeCallbackData(data: string): boolean {
  return Buffer.byteLength(data, "utf8") <= 64;
}

function unwrapData<T = any>(res: DashenResponse<T> | null | undefined): any {
  if (!res || typeof res !== "object") return null;
  if (res.data !== undefined && res.data !== null) return res.data;
  if (res.result !== undefined && res.result !== null) return res.result;
  return res;
}

function pickField(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") {
      return obj[k];
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
    obj.matchData,
    obj.match,
    obj.summary,
    obj.stat,
    obj.stats,
    obj.playerStat,
    obj.selfStat,
    obj.detail,
    obj.ext,
  ];
  for (const box of nestedContainers) {
    if (box && typeof box === "object") {
      const val = pickField(box, keys);
      if (val !== undefined) return val;
    }
  }
  return undefined;
}

function formatNum(val: unknown, decimals = 0): string {
  if (val === undefined || val === null || val === "") return "-";
  const num = Number(val);
  if (Number.isNaN(num)) return escapeHtml(String(val));
  if (decimals > 0) {
    return num.toFixed(decimals);
  }
  return Math.round(num).toLocaleString("en-US");
}

function formatRate(val: unknown): string {
  if (val === undefined || val === null || val === "") return "-";
  const str = String(val).trim();
  if (str.endsWith("%")) return str;
  const num = Number(str);
  if (Number.isNaN(num)) return escapeHtml(str);
  const pct = num > 0 && num <= 1 ? num * 100 : num;
  return `${pct.toFixed(1)}%`;
}

function formatTimestamp(val: unknown): string {
  if (val === undefined || val === null || val === "") return "";
  if (typeof val === "number") {
    const ms = val < 1e12 ? val * 1000 : val;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().replace("T", " ").slice(0, 16);
    }
  }
  const s = String(val).trim();
  if (/^\d{10,13}$/.test(s)) {
    const ms = Number(s) < 1e12 ? Number(s) * 1000 : Number(s);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().replace("T", " ").slice(0, 16);
    }
  }
  return s;
}

function formatDurationSeconds(val: unknown): string {
  if (val === undefined || val === null || val === "") return "";
  const num = Number(val);
  if (Number.isNaN(num) || num <= 0) return escapeHtml(String(val));
  const totalSec = num > 10000 ? Math.round(num / 1000) : Math.round(num);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}分${String(secs).padStart(2, "0")}秒`;
}

function parseCnQueryArgs(
  rawInput: string,
  fallbackMode: CnGameMode = "sport"
): { bnet: string; mode: CnGameMode } | null {
  const cleaned = rawInput.replace("＃", "#").trim();
  if (!cleaned) return null;

  const tokens = cleaned.split(/\s+/);
  let mode: CnGameMode = fallbackMode;
  const bnetParts: string[] = [];

  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (["sport", "comp", "competitive", "竞技", "排位"].includes(lower)) {
      mode = "sport";
    } else if (
      ["leisure", "quick", "qp", "快速", "休闲", "匹配"].includes(lower)
    ) {
      mode = "leisure";
    } else {
      bnetParts.push(tok);
    }
  }

  const bnet = bnetParts.join(" ").trim();
  if (!bnet || !bnet.includes("#")) return null;
  const [namePart, tagPart] = bnet.split("#");
  if (!namePart?.trim() || !tagPart?.trim() || !/^\d+$/.test(tagPart.trim())) {
    return null;
  }

  return { bnet: `${namePart.trim()}#${tagPart.trim()}`, mode };
}

function extractCustomerTokenAndAccount(payload: DashenResponse): {
  customerToken: string;
  matchedBnet: string;
} {
  const data = unwrapData(payload);
  const candidates: any[] = [];

  if (Array.isArray(data)) {
    candidates.push(...data);
  } else if (data && typeof data === "object") {
    for (const key of [
      "list",
      "accounts",
      "accountList",
      "roles",
      "roleList",
      "items",
      "records",
      "rows",
      "userList",
      "data",
      "result",
    ]) {
      if (Array.isArray(data[key])) {
        candidates.push(...data[key]);
      }
    }
    if (candidates.length === 0) {
      candidates.push(data);
    }
    if (data.account && typeof data.account === "object") {
      candidates.push(data.account);
    }
    if (data.user && typeof data.user === "object") {
      candidates.push(data.user);
    }
    if (data.info && typeof data.info === "object") {
      candidates.push(data.info);
    }
  }

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const token = pickField(item, [
      "customerToken",
      "customer_token",
      "token",
      "userToken",
      "roleToken",
      "playerToken",
      "accessToken",
      "guid",
      "roleId",
      "id",
    ]);
    if (token !== undefined && token !== null && String(token).trim() !== "") {
      const matchedBnet =
        pickField(item, [
          "bnetName",
          "battleTag",
          "battle_tag",
          "bnet",
          "nickname",
          "nickName",
          "name",
          "roleName",
          "accountName",
          "gameName",
        ]) || "";
      return {
        customerToken: String(token).trim(),
        matchedBnet: String(matchedBnet).trim(),
      };
    }
  }

  if (typeof data === "string" && data.trim()) {
    return { customerToken: data.trim(), matchedBnet: "" };
  }

  return { customerToken: "", matchedBnet: "" };
}

async function resolveCnAccount(
  bnet: string
): Promise<{ customerToken: string; resolvedBnet: string }> {
  const searchRes = await searchBnetAccount(bnet);
  const { customerToken, matchedBnet } =
    extractCustomerTokenAndAccount(searchRes);
  if (!customerToken) {
    throw new DashenError(
      404,
      `🔍 未查询到国服战网账号 <code>${escapeHtml(bnet)}</code>，请确认战网昵称与数字编号是否正确（例如：<code>玩家昵称#51234</code>），且该账号已在国服《守望先锋 2》有数据记录。`
    );
  }
  return {
    customerToken,
    resolvedBnet: matchedBnet || bnet,
  };
}

// ============================================================================
// 6. 战绩数据格式化与 AI 锐评模块（支持 Vercel 同步与 Docker 120s 异步队列）
// ============================================================================

function formatCnRankLine(roleLabel: string, rawNode: any): string {
  if (!rawNode || typeof rawNode !== "object") {
    return `• ${roleLabel}：<b>未定级</b>`;
  }
  const tierName = translateRankName(
    pickField(rawNode, [
      "tierName",
      "rankName",
      "rankLevelName",
      "divisionName",
      "tier",
      "rank",
    ])
  );
  const subTier = pickField(rawNode, [
    "subTier",
    "division",
    "level",
    "star",
    "subRank",
  ]);
  const srScore = pickField(rawNode, [
    "score",
    "sr",
    "rating",
    "rankScore",
    "points",
  ]);
  const games = pickField(rawNode, ["gameCount", "total", "matches", "played"]);
  const winRate = pickField(rawNode, ["winRate", "winRatio", "winPercent"]);
  const kda = pickField(rawNode, ["kda", "kd"]);

  if (!tierName) {
    return `• ${roleLabel}：<b>未定级</b>${games ? `（${formatNum(games)}场）` : "（暂无场次）"}`;
  }

  const rankTitle =
    subTier !== undefined && subTier !== null && String(subTier) !== ""
      ? `${tierName} ${subTier}`
      : tierName;

  const extras: string[] = [];
  if (games !== undefined && games !== null) {
    extras.push(`${formatNum(games)}场`);
  }
  if (winRate !== undefined && winRate !== null) {
    extras.push(`胜率${formatRate(winRate)}`);
  }
  if (kda !== undefined && kda !== null) {
    extras.push(`KDA ${formatNum(kda, 2)}`);
  }

  const scorePart =
    srScore !== undefined && srScore !== null && Number(srScore) > 0
      ? ` (${formatNum(srScore)}分)`
      : "";
  const extraPart = extras.length > 0 ? `（${extras.join(" · ")}）` : "";

  return `• ${roleLabel}：<b>${escapeHtml(rankTitle)}</b>${scorePart}${extraPart}`;
}

function buildCnOverviewHtml(
  bnet: string,
  mode: CnGameMode,
  cardPayload: DashenResponse,
  countPayload: DashenResponse
): {
  html: string;
  snapshotText: string;
  currentRankLabel: string;
} {
  const cardData = unwrapData(cardPayload) || {};
  const countData = unwrapData(countPayload) || {};

  const modeLabel = mode === "sport" ? "⚔️ 竞技比赛" : "🎮 快速比赛";
  const endorseLevel = pickField(cardData, [
    "endorsementLevel",
    "endorseLevel",
    "praiseLevel",
    "commendLevel",
  ]);
  const totalTime = pickField(cardData, [
    "totalPlayTime",
    "playTime",
    "gameTime",
    "onlineTime",
  ]);
  const totalGames = pickField(countData, [
    "gameCount",
    "totalGames",
    "matchCount",
    "total",
    "played",
  ]);
  const winGames = pickField(countData, ["winCount", "wins", "win"]);
  const loseGames = pickField(countData, ["loseCount", "losses", "lose"]);
  const winRate = pickField(countData, ["winRate", "winRatio", "winPercent"]);
  const kda = pickField(countData, ["kda", "kd"]);

  const avgElim = pickField(countData, [
    "avgEliminations",
    "avgKill",
    "killAvg",
    "eliminationsAvg",
  ]);
  const avgAssist = pickField(countData, [
    "avgAssists",
    "avgAssist",
    "assistAvg",
  ]);
  const avgDeath = pickField(countData, [
    "avgDeaths",
    "avgDeath",
    "deathAvg",
  ]);
  const avgDamage = pickField(countData, [
    "avgHeroDamage",
    "avgDamage",
    "damageAvg",
  ]);
  const avgHeal = pickField(countData, [
    "avgHealing",
    "avgHeal",
    "healAvg",
  ]);
  const avgMitigated = pickField(countData, [
    "avgDamageBlocked",
    "avgMitigated",
    "mitigatedAvg",
    "defenseAvg",
  ]);

  const rankContainer =
    cardData.rankInfo ||
    cardData.ranks ||
    cardData.competitiveRank ||
    cardData.tierInfo ||
    cardData;

  const tankNode =
    rankContainer?.tank ||
    rankContainer?.heavy ||
    rankContainer?.TANK ||
    cardData?.tankRank;
  const dpsNode =
    rankContainer?.damage ||
    rankContainer?.dps ||
    rankContainer?.offense ||
    rankContainer?.DAMAGE ||
    cardData?.damageRank;
  const supNode =
    rankContainer?.support ||
    rankContainer?.sup ||
    rankContainer?.SUPPORT ||
    cardData?.supportRank;
  const openNode =
    rankContainer?.open ||
    rankContainer?.openQueue ||
    rankContainer?.free ||
    cardData?.openRank;

  const tankLine = formatCnRankLine("🛡 坦克", tankNode);
  const dpsLine = formatCnRankLine("⚔️ 输出", dpsNode);
  const supLine = formatCnRankLine("💉 支援", supNode);
  const openLine = formatCnRankLine("🎲 开放", openNode);

  const heroListRaw =
    countData.heroList ||
    countData.topHeroes ||
    countData.heroes ||
    cardData.heroList ||
    [];
  const heroLines: string[] = [];
  if (Array.isArray(heroListRaw)) {
    for (const h of heroListRaw.slice(0, 5)) {
      if (!h || typeof h !== "object") continue;
      const hName =
        resolveDashenHeroName(
          pickField(h, ["heroName", "name", "hero", "heroId", "heroGuid"])
        ) || "未知英雄";
      const hGames = pickField(h, ["gameCount", "matches", "played", "total"]);
      const hWinRate = pickField(h, ["winRate", "winRatio"]);
      const hKda = pickField(h, ["kda", "kd"]);
      const parts: string[] = [];
      if (hGames !== undefined) parts.push(`${formatNum(hGames)} 场`);
      if (hWinRate !== undefined) parts.push(`胜率 ${formatRate(hWinRate)}`);
      if (hKda !== undefined) parts.push(`KDA ${formatNum(hKda, 2)}`);
      heroLines.push(
        `• <b>${escapeHtml(hName)}</b>${parts.length > 0 ? `：${parts.join(" | ")}` : ""}`
      );
    }
  }

  const lines: string[] = [
    `🇨🇳 <b>${escapeHtml(bnet)}</b>（国服总览）`,
    `模式：<b>${modeLabel}</b>${endorseLevel !== undefined ? `  |  赞赏 Lv.${formatNum(endorseLevel)}` : ""}${totalTime ? `  |  总时长 ${escapeHtml(String(totalTime))}` : ""}`,
    `━━━━━━━━━━━━━━━━━━`,
    `🏆 <b>竞技段位</b>`,
    tankLine,
    dpsLine,
    supLine,
    openLine,
    `━━━━━━━━━━━━━━━━━━`,
    `📊 <b>${mode === "sport" ? "赛季竞技汇总（职责预设）" : "快速比赛汇总"}</b>`,
  ];

  if (totalGames !== undefined) {
    const wlStr =
      winGames !== undefined && loseGames !== undefined
        ? ` (${formatNum(winGames)}胜 ${formatNum(loseGames)}负)`
        : "";
    lines.push(`🎮 场次：<b>${formatNum(totalGames)}</b>${wlStr}`);
  }
  if (winRate !== undefined) {
    lines.push(`📈 胜率：<b>${formatRate(winRate)}</b>`);
  }
  if (kda !== undefined) {
    lines.push(`🎯 综合 KDA：<b>${formatNum(kda, 2)}</b>`);
  }
  if (
    avgElim !== undefined ||
    avgAssist !== undefined ||
    avgDeath !== undefined
  ) {
    lines.push(
      `⚔️ 场均：消灭 <b>${formatNum(avgElim, 1)}</b> · 助攻 <b>${formatNum(avgAssist, 1)}</b> · 阵亡 <b>${formatNum(avgDeath, 1)}</b>`
    );
  }
  if (
    avgDamage !== undefined ||
    avgHeal !== undefined ||
    avgMitigated !== undefined
  ) {
    lines.push(
      `📊 场均数值：伤害 <b>${formatNum(avgDamage)}</b> · 治疗 <b>${formatNum(avgHeal)}</b> · 抵伤 <b>${formatNum(avgMitigated)}</b>`
    );
  }

  if (heroLines.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(
      `🔥 <b>${mode === "sport" ? "竞技常用英雄" : "快速常用英雄"}</b>`
    );
    lines.push(...heroLines);
  }

  const html = lines.join("\n");
  const snapshotText = html.replace(/<[^>]+>/g, "");
  const currentRankLabel = [tankLine, dpsLine, supLine]
    .map((l) => l.replace(/<[^>]+>/g, "").replace(/^•\s*/, ""))
    .join(" / ");

  return { html, snapshotText, currentRankLabel };
}

function buildCnMatchListHtml(
  bnet: string,
  mode: CnGameMode,
  listPayload: DashenResponse,
  page = 1
): {
  html: string;
  matchIds: string[];
  matchMetaList: Array<{ matchId: string; label: string }>;
} {
  const data = unwrapData(listPayload);
  let items: any[] = [];
  if (Array.isArray(data)) {
    items = data;
  } else if (data && typeof data === "object") {
    for (const key of ["list", "matches", "records", "items", "rows"]) {
      if (Array.isArray(data[key])) {
        items = data[key];
        break;
      }
    }
  }

  const modeLabel = mode === "sport" ? "⚔️ 竞技比赛" : "🎮 快速比赛";
  if (items.length === 0) {
    return {
      html: `📋 <b>${escapeHtml(bnet)}</b>（${modeLabel} · 第 ${page} 页）\n暂无近期战绩流水记录。`,
      matchIds: [],
      matchMetaList: [],
    };
  }

  const lines: string[] = [
    `📋 <b>${escapeHtml(bnet)}</b>（${modeLabel} · 第 ${page} 页）`,
    `━━━━━━━━━━━━━━━━━━`,
  ];
  const matchIds: string[] = [];
  const matchMetaList: Array<{ matchId: string; label: string }> = [];

  items.slice(0, 8).forEach((item, idx) => {
    const matchId = String(
      pickDeepField(item, ["matchId", "id", "gameId", "recordId"]) || ""
    ).trim();
    if (matchId) matchIds.push(matchId);

    const rawResult = String(
      pickDeepField(item, ["result", "win", "isWin", "outcome", "status"]) ?? ""
    ).toLowerCase();
    const isWin = ["1", "true", "win", "victory", "胜", "胜利"].includes(
      rawResult
    );
    const isDraw = ["2", "draw", "tie", "平", "平局"].includes(rawResult);
    const resultBadge = isWin ? "✅ 胜" : isDraw ? "➖ 平" : "❌ 负";

    const rawMap = pickDeepField(item, ["mapName", "map", "mapGuid", "mapId"]);
    const mapName =
      typeof rawMap === "string" && !/^\d+$/.test(rawMap)
        ? rawMap
        : resolveDashenMapGuid(rawMap) || "未知地图";

    const rawHero = pickDeepField(item, [
      "heroName",
      "hero",
      "heroGuid",
      "heroId",
    ]);
    const heroName = resolveDashenHeroName(rawHero) || "未知英雄";

    const subMode = translateModeCode(
      pickDeepField(item, ["subMode", "modeType", "queueType", "gameSubMode"])
    );
    const kills = pickDeepField(item, ["eliminations", "kills", "kill"]);
    const deaths = pickDeepField(item, ["deaths", "death"]);
    const assists = pickDeepField(item, ["assists", "assist"]);
    const playedAt = formatTimestamp(
      pickDeepField(item, ["matchTime", "endTime", "createTime", "time"])
    );
    const duration = formatDurationSeconds(
      pickDeepField(item, ["duration", "gameTime", "playTime"])
    );

    const kdaPart =
      kills !== undefined || deaths !== undefined || assists !== undefined
        ? `${formatNum(kills)}/${formatNum(deaths)}/${formatNum(assists)}`
        : "";

    lines.push(
      `<b>#${idx + 1}</b> ${resultBadge}  |  <b>${escapeHtml(mapName)}</b>${subMode ? `（${escapeHtml(subMode)}）` : ""}`
    );
    lines.push(
      `   🦸 英雄：<b>${escapeHtml(heroName)}</b>${kdaPart ? `  |  ⚔️ K/D/A：<b>${kdaPart}</b>` : ""}`
    );
    if (playedAt || duration) {
      lines.push(
        `   🕒 ${playedAt ? escapeHtml(playedAt) : ""}${playedAt && duration ? " · " : ""}${duration ? `时长 ${duration}` : ""}`
      );
    }

    if (matchId) {
      matchMetaList.push({
        matchId,
        label: `#${idx + 1} ${isWin ? "胜" : isDraw ? "平" : "负"} · ${mapName} (${heroName})`,
      });
    }
  });

  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`<i>点击下方对局按钮可查看单场详细数据与 AI 单局锐评</i>`);

  return {
    html: lines.join("\n"),
    matchIds,
    matchMetaList,
  };
}

function buildCnMatchDetailHtml(
  bnet: string,
  matchId: string,
  infoPayload: DashenResponse
): {
  html: string;
  matchContextText: string;
} {
  const data = unwrapData(infoPayload) || {};

  const rawResult = String(
    pickDeepField(data, ["result", "win", "isWin", "outcome"]) ?? ""
  ).toLowerCase();
  const isWin = ["1", "true", "win", "victory", "胜", "胜利"].includes(
    rawResult
  );
  const isDraw = ["2", "draw", "tie", "平", "平局"].includes(rawResult);
  const resultLabel = isWin ? "✅ 胜利" : isDraw ? "➖ 平局" : "❌ 失利";

  const rawMap = pickDeepField(data, ["mapName", "map", "mapGuid", "mapId"]);
  const mapName =
    typeof rawMap === "string" && !/^\d+$/.test(rawMap)
      ? rawMap
      : resolveDashenMapGuid(rawMap) || "未知地图";

  const subMode = translateModeCode(
    pickDeepField(data, ["subMode", "modeType", "queueType", "gameMode"])
  );
  const duration = formatDurationSeconds(
    pickDeepField(data, ["duration", "gameTime", "playTime"])
  );
  const playedAt = formatTimestamp(
    pickDeepField(data, ["matchTime", "endTime", "createTime", "time"])
  );

  const lines: string[] = [
    `🎯 <b>单局对局详情 — ${escapeHtml(bnet)}</b>`,
    `🆔 对局 ID：<code>${escapeHtml(matchId)}</code>`,
    `🗺 地图：<b>${escapeHtml(mapName)}</b>${subMode ? `（${escapeHtml(subMode)}）` : ""}  |  结果：<b>${resultLabel}</b>`,
  ];
  if (playedAt || duration) {
    lines.push(
      `🕒 时间：${playedAt ? escapeHtml(playedAt) : "-"}${duration ? `  |  时长：<b>${duration}</b>` : ""}`
    );
  }
  lines.push(`━━━━━━━━━━━━━━━━━━`);

  const kills = pickDeepField(data, ["eliminations", "kills", "kill"]);
  const assists = pickDeepField(data, ["assists", "assist"]);
  const deaths = pickDeepField(data, ["deaths", "death"]);
  const damage = pickDeepField(data, [
    "heroDamage",
    "damage",
    "damageDealt",
    "totalDamage",
  ]);
  const healing = pickDeepField(data, [
    "healing",
    "heal",
    "healingDone",
    "totalHeal",
  ]);
  const mitigated = pickDeepField(data, [
    "damageBlocked",
    "mitigated",
    "defense",
    "damageMitigated",
  ]);
  const rawHero = pickDeepField(data, [
    "heroName",
    "hero",
    "heroGuid",
    "heroId",
  ]);
  const heroName = resolveDashenHeroName(rawHero);

  if (heroName) {
    lines.push(`🦸 使用英雄：<b>${escapeHtml(heroName)}</b>`);
  }
  if (
    kills !== undefined ||
    assists !== undefined ||
    deaths !== undefined
  ) {
    lines.push(
      `⚔️ 战绩：消灭 <b>${formatNum(kills)}</b>  |  助攻 <b>${formatNum(assists)}</b>  |  阵亡 <b>${formatNum(deaths)}</b>`
    );
  }
  if (
    damage !== undefined ||
    healing !== undefined ||
    mitigated !== undefined
  ) {
    lines.push(
      `📊 数值：伤害 <b>${formatNum(damage)}</b>  |  治疗 <b>${formatNum(healing)}</b>  |  抵伤 <b>${formatNum(mitigated)}</b>`
    );
  }

  const statList =
    data.statList || data.statsList || data.heroStats || data.details || [];
  if (Array.isArray(statList) && statList.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`📌 <b>关键技术指标</b>`);
    for (const st of statList.slice(0, 12)) {
      if (!st || typeof st !== "object") continue;
      const guid = String(
        pickField(st, ["statId", "guid", "id", "key"]) || ""
      ).trim();
      const label =
        pickField(st, ["name", "statName", "label"]) ||
        DASHEN_STAT_GUID_NAMES[guid] ||
        (guid ? `指标#${guid}` : "指标");
      const val = pickField(st, ["value", "val", "num", "count"]);
      if (val !== undefined && val !== null) {
        lines.push(`• ${escapeHtml(String(label))}：<b>${formatNum(val, Number(val) % 1 !== 0 ? 2 : 0)}</b>`);
      }
    }
  }

  const players =
    data.players || data.playerList || data.members || data.teamPlayers || [];
  if (Array.isArray(players) && players.length > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`👥 <b>同局玩家表现（前 ${Math.min(10, players.length)} 人）</b>`);
    for (const p of players.slice(0, 10)) {
      if (!p || typeof p !== "object") continue;
      const pName =
        pickField(p, ["battleTag", "bnet", "name", "nickname", "playerName"]) ||
        "玩家";
      const pHero =
        resolveDashenHeroName(
          pickField(p, ["heroName", "hero", "heroGuid", "heroId"])
        ) || "-";
      const pk = pickField(p, ["eliminations", "kills", "kill"]);
      const pa = pickField(p, ["assists", "assist"]);
      const pd = pickField(p, ["deaths", "death"]);
      const pdmg = pickField(p, ["heroDamage", "damage"]);
      const pheal = pickField(p, ["healing", "heal"]);
      lines.push(
        `• <b>${escapeHtml(String(pName))}</b> (${escapeHtml(pHero)})：${formatNum(pk)}/${formatNum(pa)}/${formatNum(pd)} · 伤 ${formatNum(pdmg)} · 治 ${formatNum(pheal)}`
      );
    }
  }

  const html = lines.join("\n");
  const matchContextText = html.replace(/<[^>]+>/g, "");
  return { html, matchContextText };
}

function buildCnOverviewKeyboard(
  bnet: string,
  mode: CnGameMode,
  isAdmin = false
): InlineKeyboard {
  const otherMode: CnGameMode = mode === "sport" ? "leisure" : "sport";
  const otherModeLabel =
    otherMode === "sport" ? "⚔️ 切至竞技" : "🎮 切至快速";
  const kb = new InlineKeyboard();

  const swData = `cn:sw:${otherMode}:${bnet}`;
  const mlData = `cn:ml:${mode}:1:${bnet}`;
  const selfData = `cn:r:self:${mode}:${bnet}`;
  const mmrData = `cn:r:mmr:${mode}:${bnet}`;

  if (isSafeCallbackData(swData) && isSafeCallbackData(mlData)) {
    kb.text(otherModeLabel, swData).text("📋 近期战绩", mlData).row();
  }
  if (isSafeCallbackData(selfData) && isSafeCallbackData(mmrData)) {
    kb.text("🔥 个人赛季锐评", selfData).text("🔮 隐性段位评估", mmrData).row();
  }
  if (isAdmin) {
    kb.text("🛠 管理后台", "u:open_admin");
  }
  return kb;
}

function buildCnMatchListKeyboard(
  bnet: string,
  mode: CnGameMode,
  page: number,
  matchMetaList: Array<{ matchId: string; label: string }>
): InlineKeyboard {
  const kb = new InlineKeyboard();
  matchMetaList.slice(0, 6).forEach((m, idx) => {
    const mdData = `cn:md:${idx}:${bnet}`;
    if (isSafeCallbackData(mdData)) {
      kb.text(m.label.slice(0, 28), mdData).row();
    }
  });

  if (page > 1) {
    const prevData = `cn:ml:${mode}:${page - 1}:${bnet}`;
    if (isSafeCallbackData(prevData)) kb.text("⬅️ 上一页", prevData);
  }
  const nextData = `cn:ml:${mode}:${page + 1}:${bnet}`;
  if (isSafeCallbackData(nextData)) kb.text("➡️ 下一页", nextData);

  const backOv = `cn:sw:${mode}:${bnet}`;
  if (isSafeCallbackData(backOv)) {
    kb.row().text("🔙 返回战绩总览", backOv);
  }
  return kb;
}

function buildCnMatchDetailKeyboard(
  bnet: string,
  matchId: string
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const roastData = `cn:r:match:${matchId}:${bnet}`;
  if (isSafeCallbackData(roastData)) {
    kb.text("🔥 AI 单局锐评", roastData).row();
  }
  const backList = `cn:ml:sport:1:${bnet}`;
  if (isSafeCallbackData(backList)) {
    kb.text("📋 返回战绩流水", backList);
  }
  return kb;
}

function buildRoastProviderSelectKeyboard(
  rKind: RoastType,
  arg3: string,
  bnet: string,
  providers: AiProviderDto[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  providers.forEach((p, idx) => {
    const targetTag = p.executionTarget === "docker" ? "🐳" : "⚡";
    const cbData = `cn:rp:${p.id}:${rKind}:${arg3}:${bnet}`;
    if (isSafeCallbackData(cbData)) {
      kb.text(`${targetTag} ${p.name}`, cbData);
      if (idx % 2 === 1) kb.row();
    }
  });
  if (providers.length % 2 === 1) kb.row();
  const cancelData = `cn:rc:${rKind}:${arg3}:${bnet}`;
  if (isSafeCallbackData(cancelData)) {
    kb.text("⬅️ 取消选择", cancelData);
  }
  return kb;
}

function parseAiAnalysisJson(rawContent: string): Record<string, any> | null {
  const trimmed = String(rawContent || "").trim();
  if (!trimmed) return null;

  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object") return direct;
  } catch {}

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const sliced = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      if (sliced && typeof sliced === "object") return sliced;
    } catch {}
  }

  return null;
}

function formatRoastHtmlFromRawContent(params: {
  rKind: RoastType;
  bnet: string;
  mode?: CnGameMode;
  matchId?: string;
  providerName: string;
  rawContent: string;
}): string | null {
  const { rKind, bnet, mode, matchId, providerName, rawContent } = params;
  const parsed = parseAiAnalysisJson(rawContent);
  const cleanText = sanitizeSafeText(rawContent, "ai-raw-content").trim();
  if (!parsed && !cleanText) return null;

  if (rKind === "mmr") {
    if (!parsed) {
      return [
        `🔮 <b>${escapeHtml(providerName)} 隐性段位评估 — ${escapeHtml(bnet)}</b>`,
        `━━━━━━━━━━━━━━━━━━`,
        escapeHtml(cleanText.slice(0, 1200)),
      ].join("\n");
    }
    const tier = escapeHtml(
      String(parsed.estimated_tier || parsed.tier || "综合评估中")
    );
    const conf = escapeHtml(String(parsed.confidence || "中等"));
    const trend = escapeHtml(String(parsed.mmr_trend || "平稳"));
    const factor = escapeHtml(String(parsed.key_factor || "综合表现"));
    const summary = escapeHtml(
      String(parsed.summary || parsed.comment || cleanText.slice(0, 400))
    );
    return [
      `🔮 <b>${escapeHtml(providerName)} 隐性段位评估 — ${escapeHtml(bnet)}</b>`,
      `🏅 预估隐性段位：<b>${tier}</b>`,
      `📊 置信度：<b>${conf}</b>  |  📈 走势：<b>${trend}</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `🔑 <b>关键决定指标：</b>${factor}`,
      `📝 <b>综合评估小结：</b>${summary}`,
    ].join("\n");
  }

  const modeLabel =
    rKind === "match"
      ? `单局 #${escapeHtml(matchId || "")}`
      : mode === "leisure"
        ? "🎮 快速"
        : "⚔️ 竞技";

  if (!parsed) {
    return [
      `🔥 <b>${escapeHtml(providerName)} ${rKind === "match" ? "单局锐评" : "个人赛季锐评"} — ${escapeHtml(bnet)}</b>`,
      `模式：<b>${modeLabel}</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      escapeHtml(cleanText.slice(0, 1400)),
    ].join("\n");
  }

  const rating = escapeHtml(String(parsed.rating || parsed.grade || "B"));
  const persona = escapeHtml(
    String(parsed.persona || parsed.tag || "潜行竞技者")
  );
  const strength = escapeHtml(String(parsed.strength || "基本功尚可"));
  const flaw = escapeHtml(String(parsed.flaw || "细节仍需打磨"));
  const advice = escapeHtml(String(parsed.advice || "稳住节奏，减少无谓阵亡"));
  const roast = escapeHtml(
    String(parsed.roast || parsed.comment || cleanText.slice(0, 400))
  );

  return [
    `🔥 <b>${escapeHtml(providerName)} ${rKind === "match" ? "单局锐评" : "个人赛季锐评"} — ${escapeHtml(bnet)}</b>`,
    `🏅 综合评级：<b>${rating}</b>  |  🏷 风格定位：<b>${persona}</b>  |  模式：<b>${modeLabel}</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `💪 <b>核心优势：</b>${strength}`,
    `⚠️ <b>明显短板：</b>${flaw}`,
    `🎯 <b>进阶建议：</b>${advice}`,
    `🌶 <b>教练锐评：</b><i>${roast}</i>`,
  ].join("\n");
}

async function callAiProviderJson(
  provider: AiProviderDto,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const baseUrl = String(provider.baseUrl || AI_BASE_URL).replace(/\/+$/, "");
  const apiKey = String(provider.apiKey || AI_API_KEY).trim();
  const model = String(provider.model || AI_MODEL).trim();

  if (!apiKey) {
    throw new Error(`渠道「${provider.name}」未配置 API Key`);
  }

  const chatUrl = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  const { bodyStr, byteLength } = serializeSafeJsonBody({
    model,
    temperature: 0.25,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  console.info("[AI Provider Request Payload]", {
    provider: provider.name,
    model,
    chatUrl,
    requestBodyBytes: byteLength,
    systemPrompt: systemPrompt.slice(0, 600),
    userPrompt: userPrompt.slice(0, 1200),
  });

  const response = await fetch(chatUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: bodyStr,
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });

  const rawRespText = await response.text().catch(() => "");
  let payload: any = null;
  try {
    payload = rawRespText ? JSON.parse(rawRespText) : null;
  } catch {
    payload = null;
  }

  const firstChoice =
    payload?.choices?.[0] ?? payload?.data?.choices?.[0] ?? null;
  const msgObj = firstChoice?.message ?? firstChoice?.delta ?? null;
  const reasoningCandidate =
    msgObj?.reasoning_content ??
    msgObj?.reasoning ??
    msgObj?.thought ??
    payload?.reasoning_content ??
    payload?.reasoning ??
    "";
  const contentCandidate =
    msgObj?.content ||
    payload?.output_text ||
    payload?.data?.output_text ||
    payload?.response?.output_text ||
    firstChoice?.text ||
    reasoningCandidate ||
    "";

  const extractedStr =
    typeof contentCandidate === "string"
      ? contentCandidate
      : JSON.stringify(contentCandidate ?? "");

  console.info("[AI Provider Raw Response]", {
    provider: provider.name,
    model,
    httpStatus: response.status,
    finishReason: firstChoice?.finish_reason ?? payload?.finish_reason ?? "",
    hasContent: Boolean(msgObj?.content),
    hasReasoningContent: Boolean(reasoningCandidate),
    contentSnippet: extractedStr.slice(0, 300),
    payloadSnippet: rawRespText.slice(0, 400),
  });

  if (!response.ok) {
    throw new Error(
      `AI 接口请求失败 (HTTP ${response.status})：${rawRespText.slice(0, 200)}`
    );
  }

  if (extractedStr.trim()) {
    return extractedStr;
  }
  return rawRespText;
}

function buildRoastPrompts(params: {
  rKind: RoastType;
  bnet: string;
  mode?: CnGameMode;
  snapshotText?: string;
  currentRankLabel?: string;
  matchId?: string;
  matchContextText?: string;
}): { systemPrompt: string; userPrompt: string } {
  const { rKind, bnet, mode, snapshotText, currentRankLabel, matchId, matchContextText } =
    params;

  if (rKind === "mmr") {
    return {
      systemPrompt:
        "你是一位熟悉《守望先锋 2》隐藏分（MMR）与匹配机制的国服数据分析师。\n" +
        "请根据玩家当前展示的段位、胜率、KDA 与场均输出/治疗/承伤表现，评估其隐性段位水平与上分阻力（24小时内复用）。\n" +
        "注意：estimated_tier 必须明确写明对应职责（如：单职责写“坦克 钻石 3 - 钻石 1”或“支援 大师 5 - 大师 3”；若多职责均有段位且表现差异明显，可写“坦克 钻石 2 / 输出 钻石 5 / 支援 钻石 4”）。\n" +
        "请只输出纯 JSON，格式如下：\n" +
        '{\n  "estimated_tier": "带职责的预估隐性段位区间",\n  "confidence": "评估置信度",\n  "mmr_trend": "隐藏分走势判断",\n  "key_factor": "决定隐性段位的关键指标",\n  "summary": "综合评估小结（100字以内）"\n}',
      userPrompt: `玩家：${bnet}\n当前展示段位：${currentRankLabel || "未知"}\n战绩快照：\n${snapshotText || ""}`,
    };
  }

  if (rKind === "match") {
    return {
      systemPrompt:
        "你是一位犀利、专业、幽默且一针见血的《守望先锋 2》电竞数据分析师。\n" +
        "请根据玩家本局比赛的地图、英雄、击杀/助攻/阵亡、伤害/治疗/抵伤以及同局队友对手数据，生成一份单局表现锐评。\n" +
        "请只输出纯 JSON，格式如下：\n" +
        '{\n  "rating": "S/A/B/C/D",\n  "persona": "本局高光或下饭标签",\n  "strength": "本局亮点表现",\n  "flaw": "本局明显失误或短板",\n  "advice": "下一局改进建议",\n  "roast": "毒舌犀利教练锐评（100字以内）"\n}',
      userPrompt: `对局ID：${matchId || ""}\n玩家：${bnet}\n对局详情：\n${matchContextText || ""}`,
    };
  }

  return {
    systemPrompt:
      "你是一位犀利、专业、幽默且一针见血的《守望先锋 2》电竞数据分析师。\n" +
      "请根据玩家当前模式的赛季段位、场均数据与常用英雄画像，生成一份个人赛季锐评（24小时内复用）。\n" +
      "请只输出纯 JSON，格式如下：\n" +
      '{\n  "rating": "S/A/B/C/D",\n  "persona": "玩家风格标签",\n  "strength": "核心优势",\n  "flaw": "明显短板",\n  "advice": "针对性提升建议",\n  "roast": "毒舌犀利一句话锐评（100字以内）"\n}',
    userPrompt: `玩家：${bnet}（${mode === "leisure" ? "快速" : "竞技"}）\n战绩快照：\n${snapshotText || ""}`,
  };
}

// ============================================================================
// 7. 锐评异步执行器（支持 Vercel 同步直调 与 Docker 120s 队列回推）
// ============================================================================

async function runVercelRoastTask(params: {
  ctx: Context;
  chatId: number;
  messageId: number;
  taskKey: string;
  rKind: RoastType;
  bnet: string;
  mode: CnGameMode;
  snapshotText?: string;
  currentRankLabel?: string;
  matchId?: string;
  customerToken?: string;
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

  const { tgId } = getTgUserMeta(ctx);

  try {
    let matchContextText = "";
    if (rKind === "match" && customerToken && matchId) {
      const infoRes = await queryMatchInfo(customerToken, matchId);
      matchContextText = buildCnMatchDetailHtml(
        bnet,
        matchId,
        infoRes
      ).matchContextText;
    }

    const { systemPrompt, userPrompt } = buildRoastPrompts({
      rKind,
      bnet,
      mode,
      snapshotText,
      currentRankLabel,
      matchId,
      matchContextText,
    });

    const rawAiOutput = await callAiProviderJson(
      provider,
      systemPrompt,
      userPrompt
    );

    const formattedHtml = formatRoastHtmlFromRawContent({
      rKind,
      bnet,
      mode,
      matchId,
      providerName: provider.name,
      rawContent: rawAiOutput,
    });

    if (!formattedHtml) {
      await ctx.api
        .editMessageText(
          chatId,
          messageId,
          `⚠️ <b>${escapeHtml(provider.name)} 返回的分析结果为空或格式无法解析，请稍后再试（未扣减次数且未缓存空结果）。</b>`,
          { parse_mode: "HTML" }
        )
        .catch(() => {});
      return;
    }

    await setRoastCache({
      cacheKey,
      roastType: rKind,
      gameMode: rKind === "match" ? "" : mode,
      bnet,
      matchId: rKind === "match" ? matchId : "",
      operatorNickname,
      providerId: provider.id,
      providerName: provider.name,
      modelName: provider.model,
      reviewHtml: formattedHtml,
    });

    const consumeType =
      rKind === "match"
        ? "roast_match"
        : rKind === "mmr"
          ? "roast_mmr"
          : "roast_self";
    const consumeRes = await consumeRoastByTgId(
      tgId,
      consumeType,
      `${provider.name}(${provider.model}) ${rKind}:${bnet}`
    );

    const footerNote =
      unlimited || consumeRes.unlimited
        ? `\n\n<i>⚡ 管理员/VIP 免限，未扣减次数</i>`
        : `\n\n<i>⚡ 已消耗 1 次锐评额度，当前剩余 <b>${consumeRes.quota}</b> 次</i>`;

    try {
      await ctx.api.editMessageText(
        chatId,
        messageId,
        `${formattedHtml}${footerNote}`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.api
        .sendMessage(chatId, `${formattedHtml}${footerNote}`, {
          parse_mode: "HTML",
        })
        .catch(() => {});
    }
  } catch (err) {
    console.error("[Vercel Roast Task Error]", { taskKey, err });
    const errMsg =
      err instanceof Error ? escapeHtml(err.message) : "未知执行异常";
    await ctx.api
      .editMessageText(
        chatId,
        messageId,
        `❌ <b>${escapeHtml(provider.name)} 分析失败（未扣减次数）：</b>\n${errMsg}`,
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
  snapshotText?: string;
  currentRankLabel?: string;
  matchId?: string;
  customerToken?: string;
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

  const { tgId } = getTgUserMeta(ctx);

  try {
    let matchContextText = "";
    if (rKind === "match" && customerToken && matchId) {
      const infoRes = await queryMatchInfo(customerToken, matchId);
      matchContextText = buildCnMatchDetailHtml(
        bnet,
        matchId,
        infoRes
      ).matchContextText;
    }

    const { systemPrompt, userPrompt } = buildRoastPrompts({
      rKind,
      bnet,
      mode,
      snapshotText,
      currentRankLabel,
      matchId,
      matchContextText,
    });

    const callbackUrl = `${VERCEL_PUBLIC_ORIGIN}/api/bot?action=docker_callback`;
    const enqueueRes = await relayInternalRequest<{
      ok: boolean;
      data: {
        jobId: string;
        status: string;
        aheadCount: number;
        queuePosition: number;
        runningCount: number;
        queuedCount: number;
        maxConcurrency: number;
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
          tgId,
          rKind,
          bnet,
          mode,
          matchId: matchId || "",
          operatorNickname,
          providerId: provider.id,
          providerName: provider.name,
          modelName: provider.model,
          unlimited,
          cacheKey,
        },
      },
    });

    const q = enqueueRes.data;
    const aheadCount = Number(q?.aheadCount ?? 0);
    const queueTip =
      aheadCount > 0
        ? `📍 <b>排队状态：</b>当前前方还有 <b>${aheadCount}</b> 人/任务在等待（并发 ${q?.maxConcurrency || 2}）`
        : `🚀 <b>排队状态：</b>当前前方无人排队，已进入 Docker 节点深度思考`;

    await ctx.api
      .editMessageText(
        chatId,
        messageId,
        `⏳ <b>已进入 Docker 计算队列</b>\n` +
          `🤖 模型渠道：<b>${escapeHtml(provider.name)}</b>（<code>${escapeHtml(provider.model)}</code>）\n` +
          `🎯 目标战网：<code>${escapeHtml(bnet)}</code>\n` +
          `${queueTip}\n` +
          `⏱ <i>单次最长等待 120s，完成后将自动更新本条消息推送结果。</i>`,
        { parse_mode: "HTML" }
      )
      .catch(() => {});
  } catch (err) {
    inFlightRoastTasks.delete(taskKey);
    const errMsg =
      err instanceof Error ? escapeHtml(err.message) : "入队 Docker 节点失败";
    await ctx.api
      .editMessageText(
        chatId,
        messageId,
        `❌ <b>提交 Docker 计算队列失败（未扣减次数）：</b>\n${errMsg}`,
        { parse_mode: "HTML" }
      )
      .catch(() => {});
  }
}

async function handleDockerQueueCallback(
  botInstance: Bot,
  body: any
): Promise<{ ok: boolean; error?: string }> {
  const status = String(body?.status || "");
  const meta = body?.meta && typeof body.meta === "object" ? body.meta : {};
  const chatId = Number(meta.chatId || 0);
  const messageId = Number(meta.messageId || 0);
  const taskKey = String(meta.taskKey || "");
  const tgId = Number(meta.tgId || 0);
  const rKind = (String(meta.rKind || "self") as RoastType) || "self";
  const bnet = String(meta.bnet || "");
  const mode = (String(meta.mode || "sport") as CnGameMode) || "sport";
  const matchId = String(meta.matchId || "");
  const operatorNickname = String(meta.operatorNickname || "");
  const providerId = Number(meta.providerId ?? 0);
  const providerName = String(meta.providerName || "DeepSeek");
  const modelName = String(meta.modelName || "");
  const unlimited = Boolean(meta.unlimited);
  const cacheKey = String(meta.cacheKey || "");

  if (taskKey) {
    inFlightRoastTasks.delete(taskKey);
  }

  if (!chatId || !messageId) {
    return { ok: false, error: "Missing chatId or messageId in callback meta" };
  }

  if (status !== "succeeded") {
    const errText = escapeHtml(
      String(body?.error || "Docker 节点执行超时或上游返回异常")
    );
    await botInstance.api
      .editMessageText(
        chatId,
        messageId,
        `❌ <b>${escapeHtml(providerName)} 分析失败（未扣减次数）：</b>\n${errText}`,
        { parse_mode: "HTML" }
      )
      .catch(() => {});
    return { ok: true };
  }

  const rawContent = String(body?.result?.content || "");
  const formattedHtml = formatRoastHtmlFromRawContent({
    rKind,
    bnet,
    mode,
    matchId,
    providerName,
    rawContent,
  });

  if (!formattedHtml) {
    await botInstance.api
      .editMessageText(
        chatId,
        messageId,
        `⚠️ <b>${escapeHtml(providerName)} 返回的分析结果为空或格式无法解析，请稍后再试（未扣减次数且未缓存空结果）。</b>`,
        { parse_mode: "HTML" }
      )
      .catch(() => {});
    return { ok: true };
  }

  await setRoastCache({
    cacheKey,
    roastType: rKind,
    gameMode: rKind === "match" ? "" : mode,
    bnet,
    matchId: rKind === "match" ? matchId : "",
    operatorNickname,
    providerId,
    providerName,
    modelName,
    reviewHtml: formattedHtml,
  });

  let footerNote = `\n\n<i>⚡ 管理员/VIP 免限，未扣减次数</i>`;
  if (!unlimited && tgId > 0) {
    try {
      const consumeType =
        rKind === "match"
          ? "roast_match"
          : rKind === "mmr"
            ? "roast_mmr"
            : "roast_self";
      const consumeRes = await consumeRoastByTgId(
        tgId,
        consumeType,
        `[Docker] ${providerName}(${modelName}) ${rKind}:${bnet}`
      );
      footerNote = consumeRes.unlimited
        ? `\n\n<i>⚡ 管理员/VIP 免限，未扣减次数</i>`
        : `\n\n<i>⚡ 已消耗 1 次锐评额度，当前剩余 <b>${consumeRes.quota}</b> 次</i>`;
    } catch (consumeErr) {
      console.warn("[Docker Callback Consume Warning]", consumeErr);
    }
  }

  try {
    await botInstance.api.editMessageText(
      chatId,
      messageId,
      `${formattedHtml}${footerNote}`,
      { parse_mode: "HTML" }
    );
  } catch {
    await botInstance.api
      .sendMessage(chatId, `${formattedHtml}${footerNote}`, {
        parse_mode: "HTML",
      })
      .catch(() => {});
  }

  return { ok: true };
}

// ============================================================================
// 8. 管理员控制台与超级管理员配置面板渲染与交互
// ============================================================================

function buildAdminHomeKeyboard(admin: AdminMeDto): InlineKeyboard {
  const kb = new InlineKeyboard();
  const perms = new Set(admin.permissions || []);
  const isSuper = admin.role === "super_admin";

  if (isSuper || perms.has("user:view")) {
    kb.text("👤 查询用户", "ad:user_q");
  }
  if (isSuper || perms.has("stats:view")) {
    kb.text("📊 运营统计", "ad:stats");
  }
  kb.row();

  if (isSuper || perms.has("quota:add")) {
    kb.text("➕ 添加次数", "ad:q_add");
  }
  if (isSuper || perms.has("quota:deduct")) {
    kb.text("➖ 减少次数", "ad:q_sub");
  }
  kb.row();

  if (isSuper || perms.has("vip:manage")) {
    kb.text("👑 VIP 管理", "ad:vip");
  }
  if (isSuper || perms.has("user:ban")) {
    kb.text("🚫 封禁/解封", "ad:ban");
  }
  kb.row();

  if (isSuper || perms.has("redeem:create")) {
    kb.text("🎟 生成卡密", "ad:rc_new");
  }
  if (isSuper || perms.has("redeem:view")) {
    kb.text("🔍 查询卡密", "ad:rc_view");
  }
  if (isSuper || perms.has("redeem:void")) {
    kb.text("🗑 作废卡密", "ad:rc_void");
  }
  kb.row();

  if (isSuper) {
    kb.text("🤖 AI 锐评渠道", "ad:ai_list")
      .text("⚙️ 系统与赠送", "ad:settings")
      .row()
      .text("👮 管理员权限", "ad:admins")
      .text("📜 操作审计日志", "ad:logs:1")
      .row();
  }

  return kb;
}

async function renderAdminHomePanel(
  ctx: Context,
  edit = false
): Promise<void> {
  const tgId = Number(ctx.from?.id || 0);
  const admin = await fetchAdminMe(tgId);
  const roleLabel =
    admin.role === "super_admin" ? "👑 超级管理员" : "🛡 普通管理员";
  const permNames =
    admin.role === "super_admin"
      ? "拥有全部管理与系统配置权限"
      : admin.permissions.length > 0
        ? admin.permissions
            .map((p) => PERMISSION_LABELS_FALLBACK[p] || p)
            .join("、")
        : "暂未分配细分权限（请联系超管开启）";

  const text = [
    `🛠 <b>管理员控制台</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `👤 当前身份：<b>${escapeHtml(admin.remark || "管理员")}</b>（${roleLabel}）`,
    `🆔 TG ID：<code>${admin.tgId}</code>`,
    `🔑 拥有权限：${escapeHtml(permNames)}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<i>请选择下方管理功能：</i>`,
  ].join("\n");

  const kb = buildAdminHomeKeyboard(admin);
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

  const defaultEnabled = res.data?.defaultDeepseekEnabled !== false;
  const providers = res.data?.providers || [];

  const lines: string[] = [
    `🤖 <b>AI 锐评渠道与执行节点管理（仅超管）</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `• <b>[0] DeepSeek（环境变量默认）</b>：${defaultEnabled ? "✅ 已启用" : "❌ 已关闭"} | 节点：<code>vercel</code>`,
  ];

  const kb = new InlineKeyboard();
  kb.text(
    defaultEnabled ? "🔴 关闭默认 DeepSeek" : "🟢 开启默认 DeepSeek",
    `ad:ai_tog:0:${defaultEnabled ? 0 : 1}`
  ).row();

  for (const p of providers) {
    const target = p.executionTarget === "docker" ? "docker" : "vercel";
    const targetBadge =
      target === "docker"
        ? "🐳 <b>Docker 队列 (120s/并发2)</b>"
        : "⚡ <b>Vercel 节点 (26s)</b>";
    lines.push(
      `• <b>[${p.id}] ${escapeHtml(p.name)}</b>：${p.isEnabled ? "✅ 已启用" : "❌ 已关闭"}`
    );
    lines.push(
      `   模型：<code>${escapeHtml(p.model)}</code>  |  节点：${targetBadge}`
    );
    lines.push(
      `   地址：<code>${escapeHtml(p.baseUrl)}</code>  |  Key：<code>${escapeHtml(p.maskedKey || "")}</code>`
    );

    const nextTarget = target === "docker" ? "vercel" : "docker";
    kb.text(
      p.isEnabled ? `🔴 停用 #${p.id}` : `🟢 启用 #${p.id}`,
      `ad:ai_tog:${p.id}:${p.isEnabled ? 0 : 1}`
    )
      .text(
        nextTarget === "docker" ? `🐳 切为Docker #${p.id}` : `⚡ 切为Vercel #${p.id}`,
        `ad:ai_tgt:${p.id}:${nextTarget}`
      )
      .text(`🗑 删 #${p.id}`, `ad:ai_del:${p.id}`)
      .row();
  }

  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(
    `<i>说明：默认执行节点为 <b>vercel</b>；对于深度思考较慢的模型（如 <code>deepseek-v4-pro</code>），建议切换为 <b>docker</b> 节点（最长等待 120s + 排队提示）。</i>`
  );

  kb.text("➕ 新增 AI 渠道", "ad:ai_add")
    .text("🔙 返回管理主页", "ad:home");

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

async function notifyUserBenefitActivated(
  botInstance: Bot,
  targetTgId: number,
  contentHtml: string
): Promise<boolean> {
  try {
    await botInstance.api.sendMessage(targetTgId, contentHtml, {
      parse_mode: "HTML",
    });
    return true;
  } catch (err) {
    console.warn("[Benefit Notification Push Failed]", { targetTgId, err });
    return false;
  }
}

// ============================================================================
// 9. 初始化 Bot 实例与所有命令/按钮/输入流处理
// ============================================================================

if (!BOT_TOKEN) {
  throw new Error("缺少环境变量 BOT_TOKEN，请在 Vercel 中配置后重新部署。");
}

const bot = new Bot(BOT_TOKEN);

// 全局错误捕获
bot.catch((err) => {
  console.error("[grammY Bot Error]", err);
});

// ----------------------------------------------------------------------------
// 9.1 /start 与个人中心 / 签到 / 卡密兑换
// ----------------------------------------------------------------------------

bot.command("start", async (ctx) => {
  try {
    const inviterId = parseStartInvitePayload(ctx.match);
    const botUsername = await resolveBotUsernameForCtx(ctx);
    const regRes = await ensureUserRegistered(ctx, inviterId);
    const isAdmin = await resolveIsActiveAdminForCtx(ctx);

    const welcomeLines = [
      `👋 <b>欢迎使用《守望先锋 2》国服战绩查询与 AI 锐评机器人！</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `🇨🇳 <b>战绩查询：</b>发送 <code>/cn 战网ID#编号</code>（如 <code>/cn 宇轩#51672</code>）`,
      `📋 <b>近期流水：</b>发送 <code>/match 战网ID#编号</code> 查看近期对局与单局锐评`,
      `👤 <b>个人中心：</b>发送 <code>/me</code> 查看锐评次数、VIP 与专属邀请链接`,
      `📅 <b>每日签到：</b>发送 <code>/checkin</code> 每日领取免费 AI 锐评次数`,
      `🎟 <b>兑换卡密：</b>发送 <code>/redeem 卡密编号</code> 兑换次数或 VIP 会员`,
    ];

    if (regRes.isNewUser && regRes.user && regRes.user.quota > 0) {
      welcomeLines.push(`━━━━━━━━━━━━━━━━━━`);
      welcomeLines.push(
        `🎁 <b>新用户礼遇已到账：</b>已自动赠送 <b>${regRes.user.quota}</b> 次 AI 锐评体验额度！`
      );
    }

    await ctx.reply(welcomeLines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: buildPersistentBottomKeyboard(isAdmin),
    });

    if (
      regRes.isNewUser &&
      regRes.inviteRewardGranted &&
      inviterId &&
      inviterId > 0
    ) {
      const { nickname, tgId } = getTgUserMeta(ctx);
      await bot.api
        .sendMessage(
          inviterId,
          `🎉 <b>邀请奖励已到账！</b>\n好友 <b>${escapeHtml(nickname || `TG#${tgId}`)}</b> 通过你的专属邀请链接启动了机器人，你已获得 <b>+${regRes.inviteRewardQuota}</b> 次 AI 锐评额度！`,
          { parse_mode: "HTML" }
        )
        .catch(() => {});
    }

    if (botUsername && regRes.user) {
      const view = buildUserCenterView(
        regRes.user,
        regRes.settings,
        botUsername
      );
      await ctx.reply(view.text, {
        parse_mode: "HTML",
        reply_markup: view.keyboard,
      });
    }
  } catch (err) {
    const msg =
      err instanceof RelayServiceError || err instanceof DashenError
        ? err.message
        : "❌ 初始化用户信息失败，请稍后重试。";
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

async function handleUserCenterCommand(ctx: Context): Promise<void> {
  await assertBotNotMaintenance(ctx);
  const botUsername = await resolveBotUsernameForCtx(ctx);
  const regRes = await ensureUserRegistered(ctx);
  if (!regRes.user) {
    await ctx.reply("⚠️ 无法获取当前账号资料，请稍后再试。");
    return;
  }
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
      `📅 <b>今日（${escapeHtml(d.today)}）已签到过啦！</b>\n当前剩余 AI 锐评次数：<b>${d.quota}</b> 次（北京时间 00:00 刷新）。`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (!d.rewardEnabled || d.rewardQuota <= 0) {
    await ctx.reply(
      `📅 <b>签到成功（${escapeHtml(d.today)}）！</b>\n当前系统暂未开启签到次数赠送，剩余额度：<b>${d.quota}</b> 次。`,
      { parse_mode: "HTML" }
    );
    return;
  }

  await ctx.reply(
    `🎉 <b>每日签到成功（${escapeHtml(d.today)}）！</b>\n⚡ 签到奖励已到账：<b>+${d.rewardQuota}</b> 次\n📊 当前剩余 AI 锐评次数：<b>${d.quota}</b> 次`,
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
      `🎉 <b>卡密兑换成功！</b>\n` +
        `🎟 卡密编号：<code>${escapeHtml(d.code)}</code>\n` +
        `👑 到账权益：<b>VIP 会员 +${d.rewardValue} 天（AI 锐评无限制）</b>\n` +
        `⏳ 最新到期时间：<b>${escapeHtml(d.vipExpireAt || "")}</b>（北京时间）`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      `🎉 <b>卡密兑换成功！</b>\n` +
        `🎟 卡密编号：<code>${escapeHtml(d.code)}</code>\n` +
        `⚡ 到账权益：<b>AI 锐评次数 +${d.rewardValue} 次</b>\n` +
        `📊 当前剩余次数：<b>${d.quota}</b> 次`,
      { parse_mode: "HTML" }
    );
  }
}

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

// ----------------------------------------------------------------------------
// 9.2 国服战绩总览（/cn）与近期流水（/match）
// ----------------------------------------------------------------------------

async function executeCnOverviewQuery(
  ctx: Context,
  rawQuery: string,
  editMessage = false
): Promise<void> {
  await assertBotNotMaintenance(ctx);
  await ensureUserRegistered(ctx);

  const tgId = Number(ctx.from?.id || 0);
  const fallbackMode = userLastMode.get(tgId) || "sport";
  const parsed = parseCnQueryArgs(rawQuery, fallbackMode);
  if (!parsed) {
    await ctx.reply(
      `⚠️ <b>请输入完整的国服战网 ID（含 # 与数字编号）</b>\n示例：<code>/cn 宇轩#51672</code> 或 <code>/cn 宇轩#51672 快速</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const { bnet, mode } = parsed;
  if (tgId > 0) {
    userLastMode.set(tgId, mode);
    userLastBnet.set(tgId, bnet);
  }

  const { customerToken, resolvedBnet } = await resolveCnAccount(bnet);
  const [cardRes, countRes] = await Promise.all([
    queryCard(customerToken),
    queryCountInfo(customerToken, mode),
  ]);

  const isAdmin = await resolveIsActiveAdminForCtx(ctx);
  const { html } = buildCnOverviewHtml(resolvedBnet, mode, cardRes, countRes);
  const kb = buildCnOverviewKeyboard(resolvedBnet, mode, isAdmin);

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(html, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else {
    await ctx.reply(html, {
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

  const tgId = Number(ctx.from?.id || 0);
  const fallbackMode = userLastMode.get(tgId) || "sport";
  const parsed = parseCnQueryArgs(rawQuery, fallbackMode);
  if (!parsed) {
    await ctx.reply(
      `⚠️ <b>请输入完整的国服战网 ID（含 # 与数字编号）</b>\n示例：<code>/match 宇轩#51672</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const { bnet, mode } = parsed;
  const { customerToken, resolvedBnet } = await resolveCnAccount(bnet);
  const listRes = await queryMatchList(customerToken, mode, page);
  const { html, matchIds, matchMetaList } = buildCnMatchListHtml(
    resolvedBnet,
    mode,
    listRes,
    page
  );

  if (tgId > 0) {
    userLastMode.set(tgId, mode);
    userLastBnet.set(tgId, resolvedBnet);
    userRecentMatchIds.set(tgId, matchIds);
  }

  const kb = buildCnMatchListKeyboard(resolvedBnet, mode, page, matchMetaList);
  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(html, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else {
    await ctx.reply(html, {
      parse_mode: "HTML",
      reply_markup: kb,
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

// ----------------------------------------------------------------------------
// 9.3 底部常驻快捷键盘文本处理
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// 9.4 触发 AI 锐评（支持缓存命中、多渠道展开、去重锁与 Vercel/Docker 双节点调度）
// ----------------------------------------------------------------------------

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

  // 1. 先检查缓存（命中缓存直接展示，不扣减次数）
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

  // 2. 校验用户权限与剩余次数
  const auth = await authorizeRoastForCtx(ctx);

  // 3. 并发唯一性去重锁
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
    const { customerToken, resolvedBnet } = await resolveCnAccount(bnet);
    let snapshotText = "";
    let currentRankLabel = "";

    if (rKind !== "match") {
      const [cardRes, countRes] = await Promise.all([
        queryCard(customerToken),
        queryCountInfo(customerToken, mode),
      ]);
      const built = buildCnOverviewHtml(resolvedBnet, mode, cardRes, countRes);
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
        bnet: resolvedBnet,
        mode,
        snapshotText,
        currentRankLabel,
        matchId,
        customerToken,
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
        bnet: resolvedBnet,
        mode,
        snapshotText,
        currentRankLabel,
        matchId,
        customerToken,
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

// ----------------------------------------------------------------------------
// 9.5 Inline Callback 回调统一处理
// ----------------------------------------------------------------------------

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
      const { customerToken, resolvedBnet } = await resolveCnAccount(bnet);
      const infoRes = await queryMatchInfo(customerToken, matchId);
      const { html } = buildCnMatchDetailHtml(resolvedBnet, matchId, infoRes);
      const kb = buildCnMatchDetailKeyboard(resolvedBnet, matchId);
      await ctx.editMessageText(html, {
        parse_mode: "HTML",
        reply_markup: kb,
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

    if (data === "ad:ai_add") {
      await ctx.answerCallbackQuery();
      pendingUserInputs.set(tgId, {
        action: { type: "super_ai_provider_add" },
        expiresAt: Date.now() + 3 * 60 * 1000,
      });
      await ctx.reply(
        `➕ <b>新增 AI 锐评渠道</b>\n` +
          `请按以下格式发送（空格分隔，第 5 项执行节点可省略，默认为 <code>vercel</code>）：\n` +
          `<code>渠道名称 接口地址 API_Key 模型标识 [vercel|docker]</code>\n\n` +
          `示例 1（默认 Vercel 跑）：\n` +
          `<code>DeepSeek-Chat https://api.deepseek.com sk-xxx deepseek-chat</code>\n\n` +
          `示例 2（长思考模型指定 Docker 120s 队列跑）：\n` +
          `<code>DeepSeek-Pro https://api.deepseek.com sk-xxx deepseek-v4-pro docker</code>`,
        { parse_mode: "HTML" }
      );
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
      ctx.callbackQuery.data = "ad:settings";
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
      ctx.callbackQuery.data = `ad:adm_p:${targetId}`;
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

// ----------------------------------------------------------------------------
// 9.6 多步交互文本输入捕获（兑换卡密 / 快捷查询 / 管理员表单提交）
// ----------------------------------------------------------------------------

bot.on("message:text", async (ctx, next) => {
  const text = String(ctx.message.text || "").trim();
  if (!text || text.startsWith("/")) {
    return next();
  }

  const tgId = Number(ctx.from?.id || 0);
  if (!tgId) return next();

  const pending = pendingUserInputs.get(tgId);
  if (!pending) return next();

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
// 10. Vercel Serverless HTTP 入口（含 Telegram Webhook 与 Docker 队列结果回推）
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

  // 内部路由：接收 Docker 异步队列完成后的结果回推，由 Vercel 统一更新 TG 消息
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
        generatedAt: "2026-11-27 21:26:00",
        dockerCallbackEnabled: true,
      })
    );
    return;
  }

  await telegramWebhookHandler(req, res);
}
