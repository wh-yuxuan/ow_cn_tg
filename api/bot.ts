/**
 * 《守望先锋 2》(OW2) 国服战绩查询 Telegram 机器人（独立部署版）
 * 运行环境：Vercel Serverless Functions (Node.js 20+ / TypeScript)
 * 机器人框架：grammY (Webhook 模式)
 * 数据来源：腾讯云中转 + MySQL 5.7.44 (https://ow.eyy8.top -> datamsapi.ds.163.com/v1/a19ld5tool) + DeepSeek AI 锐评
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Bot, Context, InlineKeyboard, webhookCallback } from "grammy";

// ============================================================================
// 1. 环境配置与常量定义
// ============================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RELAY_SECRET = (process.env.RELAY_SECRET || "").trim();

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

const DASHEN_RELAY_ORIGIN =
  process.env.DASHEN_RELAY_ORIGIN?.replace(/\/+$/, "") || "https://ow.eyy8.top";
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

interface RelayResponse<T = any> {
  ok?: boolean;
  code?: string;
  error?: string;
  data?: T;
  hit?: boolean;
  record?: any;
  [key: string]: any;
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

interface AdminMeDto {
  tgId: number;
  remark: string;
  role: "super_admin" | "admin";
  permissions: string[];
  isActive: boolean;
  allPermissions: string[];
  permissionLabels: Record<string, string>;
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
// 3. 网易大神与腾讯云 MySQL 内部接口客户端
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    userId?: number;
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
  if (RELAY_SECRET) {
    headers["x-relay-secret"] = RELAY_SECRET;
  }
  if (options?.userId && options.userId > 0) {
    headers["x-user-id"] = String(options.userId);
  }

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
    if (response.status === 503 && payload?.code === "BOT_MAINTENANCE") {
      throw new DashenError(
        503,
        payload?.error ||
          "🛠 <b>机器人正在升级维护中</b>\n当前仅对管理员与超级管理员开放调试，普通用户请稍后再试。"
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new DashenError(
        response.status,
        "🔐 网易大神鉴权失败（HTTP 401/403），请检查 <code>DASHEN_TOKEN</code> 是否有效。"
      );
    }
    const reason =
      payload?.msg || payload?.message || payload?.error || `HTTP ${response.status}`;
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

async function searchBnetAccount(
  bnet: string,
  userId?: number
): Promise<DashenResponse> {
  const normalized = bnet.replace("＃", "#").trim();
  if (SEARCH_BNET_METHOD === "GET") {
    return dashenRequest("GET", SEARCH_BNET_ACCOUNT_URL, {
      userId,
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
    userId,
    json: {
      token: DASHEN_TOKEN,
      roleId: DASHEN_ROLE_ID,
      dts: DASHEN_DTS,
      server: DASHEN_SERVER,
      [SEARCH_BNET_PARAM_KEY]: normalized,
    },
  });
}

async function queryCard(
  customerToken: string,
  userId?: number
): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryCard`, {
    userId,
    params: { token: customerToken },
  });
}

async function queryCountInfo(
  customerToken: string,
  gameMode: CnGameMode,
  userId?: number
): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryCountInfo`, {
    userId,
    params: { gameMode, token: customerToken },
  });
}

async function queryMatchList(
  customerToken: string,
  gameMode: CnGameMode,
  page = 1,
  userId?: number
): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryMatchList`, {
    userId,
    params: { token: customerToken, gameMode, page },
  });
}

async function queryMatchInfo(
  customerToken: string,
  matchId: string,
  userId?: number
): Promise<DashenResponse> {
  return dashenRequest("GET", `${DASHEN_CUSTOMER_API_BASE}/queryMatchInfo`, {
    userId,
    params: { matchId, token: customerToken },
  });
}

/** 调用腾讯云中转的 MySQL 业务/管理内部接口 */
async function relayInternalRequest<T = any>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  options?: {
    params?: Record<string, string | number | undefined>;
    json?: Record<string, any>;
    operatorId?: number;
  }
): Promise<RelayResponse<T>> {
  const url = new URL(`${DASHEN_RELAY_ORIGIN}${path}`);
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
  if (options?.operatorId) {
    headers["x-operator-id"] = String(options.operatorId);
  }

  let body: string | undefined;
  if ((method === "POST" || method === "DELETE") && options?.json) {
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
  } catch {
    throw new DashenError(
      504,
      "🌐 无法连接至腾讯云业务服务（请检查中转服务与域名是否正常）。"
    );
  }

  const rawText = await response.text().catch(() => "");
  let payload: RelayResponse<T>;
  try {
    payload = JSON.parse(rawText) as RelayResponse<T>;
  } catch {
    throw new DashenError(
      response.status,
      `❌ 业务服务返回异常响应 (HTTP ${response.status})。`
    );
  }

  if (!response.ok || payload?.ok === false) {
    const errMsg = payload?.error || `HTTP ${response.status}`;
    throw new DashenError(response.status, errMsg);
  }

  return payload;
}

function getTgUserMeta(ctx: Context): {
  tgId: number;
  nickname: string;
  username: string;
} {
  const from = ctx.from;
  const tgId = Number(from?.id || 0);
  const fullName = [from?.first_name || "", from?.last_name || ""]
    .join(" ")
    .trim();
  const nickname = fullName || from?.username || (tgId ? `用户${tgId}` : "");
  const username = String(from?.username || "").replace(/^@+/, "");
  return { tgId, nickname, username };
}

async function ensureUserRecord(
  ctx: Context,
  inviterId?: number | null
): Promise<{
  isNewUser: boolean;
  inviteRewardGranted: boolean;
  inviterId: number | null;
  inviteRewardQuota: number;
  user: UserProfileDto;
  settings?: SystemSettingsDto;
}> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  const res = await relayInternalRequest("POST", "/internal/user/ensure", {
    json: { tgId, nickname, username, inviterId: inviterId || null },
  });
  return res.data;
}

// ============================================================================
// 4. 数据提取、代理对清理与格式化工具
// ============================================================================

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
// 4.5 锐评缓存（MySQL 持久化 + 内存热缓存）与资格扣次流程
// ============================================================================

interface RoastMemoryEntry {
  text: string;
  expiresAt: number;
  chatMessages: Map<number, number>;
}

const MATCH_ROAST_MEM_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_ROAST_TTL_MS = 24 * 60 * 60 * 1000;

const roastMemoryCache = new Map<string, RoastMemoryEntry>();
const roastInFlight = new Map<string, number>();

function pruneRoastMemory(): void {
  if (roastMemoryCache.size <= 300) return;
  const now = Date.now();
  for (const [k, v] of roastMemoryCache.entries()) {
    if (now > v.expiresAt) {
      roastMemoryCache.delete(k);
    }
  }
}

async function runPaidRoastFlow(
  ctx: Context,
  options: {
    cacheKey: string;
    roastType: RoastType;
    quotaReason: "roast_match" | "roast_self" | "roast_mmr";
    gameMode?: string;
    bnet: string;
    matchId?: string;
    startToast: string;
    loadingHtml: string;
    errorFallbackHtml: string;
    generator: () => Promise<string>;
  }
): Promise<void> {
  const {
    cacheKey,
    roastType,
    quotaReason,
    gameMode = "",
    bnet,
    matchId = "",
    startToast,
    loadingHtml,
    errorFallbackHtml,
    generator,
  } = options;

  const { tgId, nickname, username } = getTgUserMeta(ctx);
  if (!tgId) {
    await safeAnswerCallback(ctx, "无法识别你的 Telegram 账号信息。", true);
    return;
  }

  const now = Date.now();

  const inFlightSince = roastInFlight.get(cacheKey);
  if (inFlightSince && now - inFlightSince < AI_TIMEOUT_MS + 10_000) {
    await safeAnswerCallback(
      ctx,
      "⏳ 锐评正在全力生成中，请耐心等待几秒，不要重复点击哦~"
    );
    return;
  }

  let reusedHtml: string | null = null;

  const memCached = roastMemoryCache.get(cacheKey);
  if (memCached && now < memCached.expiresAt) {
    reusedHtml = memCached.text;
    const chatId = ctx.chat?.id;
    const prevMsgId = chatId ? memCached.chatMessages.get(chatId) : undefined;
    if (chatId && prevMsgId) {
      try {
        await safeAnswerCallback(
          ctx,
          "♻️ 已命中锐评缓存（不扣次数），已引用上方结果"
        );
        await ctx.reply(
          "♻️ <b>该数据已有缓存锐评</b>（不重复消耗次数），已为你引用上方结果 👆",
          {
            parse_mode: "HTML",
            reply_parameters: { message_id: prevMsgId },
          }
        );
        return;
      } catch {
        memCached.chatMessages.delete(chatId);
      }
    }
  } else {
    try {
      const dbRes = await relayInternalRequest(
        "GET",
        "/internal/roast/cache/get",
        {
          params: { cacheKey, roastType },
        }
      );
      if (dbRes?.hit && dbRes?.record?.reviewHtml) {
        reusedHtml = String(dbRes.record.reviewHtml);
      }
    } catch {
      // 缓存查询失败不阻断正常生成流程
    }
  }

  if (reusedHtml) {
    await safeAnswerCallback(
      ctx,
      "♻️ 已命中锐评缓存，直接展示（不扣次数）"
    );
    const noteSuffix =
      roastType === "match"
        ? "<i>♻️ 已复用单局历史锐评缓存（不扣次数）</i>"
        : "<i>♻️ 已命中 24 小时内锐评缓存（不扣次数）</i>";
    const sent = await ctx.reply(`${reusedHtml}\n\n${noteSuffix}`, {
      parse_mode: "HTML",
    });

    pruneRoastMemory();
    const existingMem = roastMemoryCache.get(cacheKey);
    const chatMap = existingMem?.chatMessages || new Map<number, number>();
    chatMap.set(sent.chat.id, sent.message_id);
    roastMemoryCache.set(cacheKey, {
      text: reusedHtml,
      expiresAt:
        now +
        (roastType === "match"
          ? MATCH_ROAST_MEM_TTL_MS
          : PROFILE_ROAST_TTL_MS),
      chatMessages: chatMap,
    });
    return;
  }

  try {
    await relayInternalRequest("POST", "/internal/roast/authorize", {
      json: { tgId, nickname, username },
    });
  } catch (authErr) {
    const rawMsg =
      authErr instanceof DashenError
        ? authErr.message
        : "⚠️ 锐评资格校验失败，请稍后重试。";
    await safeAnswerCallback(
      ctx,
      rawMsg.replace(/<[^>]+>/g, "").slice(0, 180),
      true
    );
    return;
  }

  roastInFlight.set(cacheKey, now);
  await safeAnswerCallback(ctx, startToast);

  const loadingMsg = await ctx.reply(loadingHtml, { parse_mode: "HTML" });
  try {
    const resultText = await generator();

    let quotaInfoText = "";
    try {
      const consumeRes = await relayInternalRequest(
        "POST",
        "/internal/roast/consume",
        {
          json: {
            tgId,
            roastType: quotaReason,
            detail: `${bnet}${matchId ? ` · #${matchId}` : ""}`,
          },
        }
      );
      if (consumeRes?.data?.unlimited) {
        quotaInfoText = "<i>👑 尊享免限（未扣次数）</i>";
      } else if (consumeRes?.data?.consumed) {
        quotaInfoText = `<i>⚡ 本次消耗 1 次，剩余 <b>${Number(consumeRes.data.quota ?? 0)}</b> 次</i>`;
      }
    } catch (consumeErr) {
      console.error("[Consume Quota After Roast Error]", consumeErr);
    }

    const finalHtml = quotaInfoText
      ? `${resultText}\n\n${quotaInfoText}`
      : resultText;

    await ctx.api.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      finalHtml,
      { parse_mode: "HTML" }
    );

    try {
      await relayInternalRequest("POST", "/internal/roast/cache/set", {
        json: {
          cacheKey,
          roastType,
          gameMode,
          bnet,
          matchId,
          reviewHtml: resultText,
        },
      });
    } catch (saveErr) {
      console.error("[Save Roast Cache Error]", saveErr);
    }

    pruneRoastMemory();
    const chatMessages = new Map<number, number>();
    chatMessages.set(loadingMsg.chat.id, loadingMsg.message_id);
    roastMemoryCache.set(cacheKey, {
      text: resultText,
      expiresAt:
        Date.now() +
        (roastType === "match"
          ? MATCH_ROAST_MEM_TTL_MS
          : PROFILE_ROAST_TTL_MS),
      chatMessages,
    });
  } catch (aiErr) {
    const errHtml =
      aiErr instanceof DashenError ? aiErr.message : errorFallbackHtml;
    await ctx.api.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      errHtml,
      { parse_mode: "HTML" }
    );
  } finally {
    roastInFlight.delete(cacheKey);
  }
}

// ============================================================================
// 5. DeepSeek 电竞锐评生成逻辑
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
  userPrompt: string,
  debugTag: string
): Promise<{ parsed: any | null; rawContent: string }> {
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
    temperature: 0.35,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
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
    console.error("[DeepSeek Fetch Error]", { debugTag, err });
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
      `❌ DeepSeek 接口调用失败 (HTTP ${response.status})：${escapeHtml(sanitizeSafeText(errText, "ai-error-text").slice(0, 180))}`
    );
  }

  const aiPayload: any = await response.json().catch(() => null);
  const content = String(
    aiPayload?.choices?.[0]?.message?.content ??
      aiPayload?.data?.choices?.[0]?.message?.content ??
      ""
  );

  return { parsed: parseAiAnalysisJson(content), rawContent: content };
}

async function generateDeepSeekMatchReview(
  bnet: string,
  customerToken: string,
  matchId: string,
  userId?: number
): Promise<string> {
  const res = await queryMatchInfo(customerToken, matchId, userId);
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

  const promptContext = sanitizeSafeText(
    [
      ...focusLines,
      summarizeTeamByRole(teammates, "焦点玩家所在队伍（友方）"),
      summarizeTeamByRole(enemies, "对手队伍（敌方）"),
    ].join("\n"),
    "matchPromptContext"
  );

  const systemPrompt = sanitizeSafeText(
    [
      "你是一位犀利、专业、客观的《守望先锋 2》电竞数据分析师。",
      "请严格依据提供的单场对局数据生成分析报告，禁止虚构不存在的数据或技能细节。",
      "不要把坦克或输出的低助攻/零助攻机械地判为负面表现，除非英雄机制高度依赖增益/挂状态且整体协同极差。",
      "请只输出纯 JSON（不要 markdown 代码块包裹，不要额外解释文字），格式如下：",
      "{",
      '  "score": "S/A/B/C/D",',
      '  "general_summary": "一句话评价焦点玩家本场表现",',
      '  "key_point": "决定胜负的唯一核心点",',
      '  "mvp_or_scapegoat": "本场真正MVP或最明显背锅位及数据依据",',
      '  "role_diff": "坦克/输出/辅助三路对位对比简析",',
      '  "comment": "犀利简评与人格化小结（100字以内）"',
      "}",
    ].join("\n"),
    "matchSystemPrompt"
  );

  const { parsed, rawContent } = await callDeepSeekJson(
    systemPrompt,
    promptContext,
    `match:${matchId}:${safeBnetForAi}`
  );

  const scoreBadge = escapeHtml(
    sanitizeSafeText(parsed?.score || "B", "ai-score").trim()
  );
  const generalSummary = escapeHtml(
    sanitizeSafeText(
      parsed?.general_summary || cleanAiJsonText(rawContent) || "暂无总结",
      "ai-summary"
    ).trim()
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

  return [
    `🤖 <b>DeepSeek 单局锐评 — ${escapeHtml(safeMapForAi)}</b>`,
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
}

async function generateDeepSeekPlayerReview(
  bnet: string,
  gameMode: CnGameMode,
  userId?: number
): Promise<string> {
  const searchRes = await searchBnetAccount(bnet, userId);
  const player = extractPlayerFromSearch(bnet, searchRes);

  const [cardRes, countRes] = await Promise.allSettled([
    queryCard(player.customerToken, userId),
    queryCountInfo(player.customerToken, gameMode, userId),
  ]);

  const cardData =
    cardRes.status === "fulfilled" ? unwrapData(cardRes.value) : null;
  const countData =
    countRes.status === "fulfilled" ? unwrapData(countRes.value) : null;

  const safeBnetForAi = sanitizeSafeText(player.bnet, "self-bnet");
  const modeLabel = gameMode === "sport" ? "竞技比赛" : "快速比赛";

  const profileLines: string[] = [
    `玩家战网 ID：${safeBnetForAi}`,
    `当前分析模式：${modeLabel}`,
  ];

  const levelVal = pickField(cardData, ["level", "endorsementLevel"]);
  const gameTimeVal = pickField(cardData, ["gameTime", "totalGameTime"]);
  const totalMatchVal = pickField(cardData, [
    "totalMatchNum",
    "matchCount",
    "totalCount",
  ]);
  if (
    levelVal !== undefined ||
    gameTimeVal !== undefined ||
    totalMatchVal !== undefined
  ) {
    profileLines.push(
      `账号基础概况：赞赏等级 ${levelVal ?? "-"}，总游戏时长 ${gameTimeVal ?? "-"}，历史累计场次 ${totalMatchVal ?? "-"}`
    );
  }

  const rankList =
    countData?.guideCountData ||
    cardData?.guideCountData ||
    cardData?.rankList ||
    cardData?.ranks ||
    cardData?.roleRankList;
  if (Array.isArray(rankList) && rankList.length > 0) {
    const roleSummary = rankList
      .map((r: any) => {
        const rName = sanitizeSafeText(
          pickField(r, ["roleType", "roleName", "role", "name"]) || "位置",
          "role-name"
        );
        const lastRank = r?.lastRankInfo || r?.rankInfo || r;
        const tierCn = translateRankName(
          pickField(lastRank, ["rankName", "tierName", "rank"])
        );
        const sub = pickField(lastRank, ["rankSubTier"]);
        const matches = pickField(r, ["matchSum", "matches"]);
        const winRate = pickField(r, ["winRate", "win_rate"]);
        const kda = pickField(r, ["kda"]);
        return `${rName}: ${tierCn ? `${tierCn}${sub ? sub : ""}` : "未定级"}(场次${matches ?? "-"}, 胜率${winRate ?? "-"}%, KDA ${kda ?? "-"})`;
      })
      .join("；");
    profileLines.push(`各位置竞技段位与表现：${roleSummary}`);
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
    const mSum = pickField(statsObj, ["matchSum", "totalCount", "matchCount"]);
    const wSum = pickField(statsObj, ["matchWinSum", "winCount", "wins"]);
    const lSum = pickField(statsObj, ["matchLossSum", "lossCount", "losses"]);
    const wRate = pickField(statsObj, ["winRate", "winRatio", "win_rate"]);
    const kda = pickField(statsObj, ["kda", "avgKda"]);
    const avgK = pickField(statsObj, ["aveKill", "avgEliminations"]);
    const avgA = pickField(statsObj, ["aveAssist", "avgAssists"]);
    const avgD = pickField(statsObj, ["aveDeath", "avgDeaths"]);
    const avgDmg = pickField(statsObj, ["aveHeroDamage", "avgDamage"]);
    const avgHeal = pickField(statsObj, ["aveCure", "avgHeal"]);
    const avgRes = pickField(statsObj, ["aveResistDamage"]);

    profileLines.push(
      `本赛季${modeLabel}汇总：总场次 ${mSum ?? "-"}（${wSum ?? "-"}胜 ${lSum ?? "-"}负，胜率 ${wRate ?? "-"}%），综合 KDA ${kda ?? "-"}，场均消灭 ${avgK ?? "-"} / 助攻 ${avgA ?? "-"} / 阵亡 ${avgD ?? "-"}，场均伤害 ${avgDmg ?? "-"}，场均治疗 ${avgHeal ?? "-"}，场均抵伤 ${avgRes ?? "-"}`
    );
  }

  const heroList =
    countData?.presetsHeroUseSummaryList ||
    countData?.heroList ||
    countData?.heroes ||
    countData?.topHeroes ||
    cardData?.heroList;
  if (Array.isArray(heroList) && heroList.length > 0) {
    const heroSummary = heroList
      .slice(0, 8)
      .map((h: any) => {
        const hRaw = pickField(h, [
          "heroName",
          "name",
          "cnName",
          "heroGuid",
          "heroId",
        ]);
        const hCn = sanitizeSafeText(
          resolveDashenHeroName(hRaw) || "未知英雄",
          "pool-hero"
        );
        const hGames = pickField(h, ["matchSum", "totalCount", "matchCount"]);
        const hWin = pickField(h, ["winRate", "winRatio"]);
        const hKda = pickField(h, ["kda", "avgKda"]);
        return `${hCn}(${hGames ?? "-"}场, 胜率${hWin ?? "-"}%, KDA ${hKda ?? "-"})`;
      })
      .join("；");
    profileLines.push(`常用英雄池（按出场排序）：${heroSummary}`);
  }

  const promptContext = sanitizeSafeText(
    profileLines.join("\n"),
    "selfPromptContext"
  );

  const systemPrompt = sanitizeSafeText(
    [
      "你是一位精通《守望先锋 2》国服生态、毒舌幽默但数据严谨的资深电竞教练兼脱口秀毒舌解说。",
      "请根据提供的玩家赛季段位、场均数据、常用英雄池胜率与 KDA，对这位玩家进行一次立体、精准、有节目效果的“个人赛季画像锐评”。",
      "严格基于提供的数据说话，禁止编造不存在的英雄或战绩；如果某项数据缺失（显示为-），直接跳过不要编造。",
      "请只输出纯 JSON（不要 markdown 代码块包裹，不要额外解释文字），格式如下：",
      "{",
      '  "tier": "S/A/B/C/D",',
      '  "persona_tag": "4-10字的玩家画像称号",',
      '  "strength_and_weakness": "最强上分密码与最明显短板/重灾区点名",',
      '  "playstyle_diagnosis": "从场均击杀/阵亡/伤害/治疗比例诊断其真实打法风格",',
      '  "roast_comment": "一针见血、接地气、带点幽默吐槽的赛季综合锐评与上分建议（120字以内）"',
      "}",
    ].join("\n"),
    "selfSystemPrompt"
  );

  const { parsed, rawContent } = await callDeepSeekJson(
    systemPrompt,
    promptContext,
    `self:${gameMode}:${safeBnetForAi}`
  );

  const tierBadge = escapeHtml(
    sanitizeSafeText(parsed?.tier || "B", "self-tier").trim()
  );
  const personaTag = escapeHtml(
    sanitizeSafeText(
      parsed?.persona_tag || "守望先锋神秘战士",
      "self-tag"
    ).trim()
  );
  const strengthWeakness = escapeHtml(
    sanitizeSafeText(
      parsed?.strength_and_weakness || "-",
      "self-sw"
    ).trim()
  );
  const playstyle = escapeHtml(
    sanitizeSafeText(
      parsed?.playstyle_diagnosis || "-",
      "self-style"
    ).trim()
  );
  const roastComment = escapeHtml(
    sanitizeSafeText(
      parsed?.roast_comment || cleanAiJsonText(rawContent) || "暂无锐评",
      "self-roast"
    ).trim()
  );

  return [
    `🪞 <b>DeepSeek 个人赛季锐评 — ${escapeHtml(safeBnetForAi)}</b>`,
    `🏷 画像标签：<b>「${personaTag}」</b>  |  综合评级：<b>${tierBadge}</b>（${modeLabel}）`,
    `━━━━━━━━━━━━━━━━━━`,
    `🎯 <b>强弱项点名：</b>${strengthWeakness}`,
    `🧠 <b>打法风格诊断：</b>${playstyle}`,
    `💬 <b>毒舌教练锐评：</b><i>${roastComment}</i>`,
  ].join("\n");
}

async function generateDeepSeekHiddenMmrReview(
  bnet: string,
  gameMode: CnGameMode,
  userId?: number
): Promise<string> {
  const searchRes = await searchBnetAccount(bnet, userId);
  const player = extractPlayerFromSearch(bnet, searchRes);

  const [cardRes, countRes, matchListRes] = await Promise.allSettled([
    queryCard(player.customerToken, userId),
    queryCountInfo(player.customerToken, gameMode, userId),
    queryMatchList(player.customerToken, gameMode, 1, userId),
  ]);

  const cardData =
    cardRes.status === "fulfilled" ? unwrapData(cardRes.value) : null;
  const countData =
    countRes.status === "fulfilled" ? unwrapData(countRes.value) : null;
  const listBody =
    matchListRes.status === "fulfilled" ? unwrapData(matchListRes.value) : null;

  const safeBnetForAi = sanitizeSafeText(player.bnet, "mmr-bnet");
  const modeLabel = gameMode === "sport" ? "竞技比赛" : "快速比赛";

  const mmrLines: string[] = [
    `玩家战网 ID：${safeBnetForAi}`,
    `评估模式：${modeLabel}`,
  ];

  const tierBaseRank: Record<string, number> = {
    青铜: 1,
    白银: 2,
    黄金: 3,
    白金: 4,
    翡翠: 5,
    钻石: 6,
    大师: 7,
    宗师: 8,
    英杰: 9,
  };
  const tierNamesByIndex = [
    "",
    "青铜",
    "白银",
    "黄金",
    "白金",
    "翡翠",
    "钻石",
    "大师",
    "宗师",
    "英杰",
  ];

  const rankList =
    countData?.guideCountData ||
    cardData?.guideCountData ||
    cardData?.rankList ||
    cardData?.ranks ||
    cardData?.roleRankList;

  const roleDetails: string[] = [];
  const heuristicHints: string[] = [];

  if (Array.isArray(rankList) && rankList.length > 0) {
    for (const r of rankList) {
      const rName = sanitizeSafeText(
        pickField(r, ["roleType", "roleName", "role", "name"]) || "位置",
        "mmr-role"
      );
      const lastRank = r?.lastRankInfo || r?.rankInfo || r;
      const tierCn = translateRankName(
        pickField(lastRank, ["rankName", "tierName", "rank"])
      );
      const sub = Number(pickField(lastRank, ["rankSubTier"]) || 0);
      const matches = Number(pickField(r, ["matchSum", "matches"]) || 0);
      const winRate = Number(pickField(r, ["winRate", "win_rate"]) || NaN);
      const kda = Number(pickField(r, ["kda"]) || NaN);

      const rankStr = tierCn
        ? `${tierCn}${sub > 0 ? ` ${sub}` : ""}`
        : "未定级";
      roleDetails.push(
        `${rName}：明面 ${rankStr}（场次 ${matches || "-"}，胜率 ${Number.isFinite(winRate) ? `${winRate.toFixed(1)}%` : "-"}，KDA ${Number.isFinite(kda) ? kda.toFixed(2) : "-"}）`
      );

      if (
        tierCn &&
        tierBaseRank[tierCn] &&
        matches >= 5 &&
        Number.isFinite(winRate)
      ) {
        const baseIdx = tierBaseRank[tierCn];
        const currentSub = sub >= 1 && sub <= 5 ? sub : 3;
        const winDelta = winRate - 50;
        const kdaBonus = Number.isFinite(kda) ? (kda - 2.3) * 0.6 : 0;
        const sampleWeight = Math.min(1.2, Math.max(0.5, matches / 25));
        const divisionShift = Math.round(
          (winDelta * 0.16 + kdaBonus) * sampleWeight
        );
        const totalDivs = baseIdx * 5 + (5 - currentSub) + divisionShift;
        const estTierIdx = Math.min(
          9,
          Math.max(1, Math.floor(totalDivs / 5))
        );
        const estSub = Math.min(5, Math.max(1, 5 - (totalDivs % 5)));
        const estName = `${tierNamesByIndex[estTierIdx]} ${estSub}`;
        heuristicHints.push(
          `${rName}量化初算参考：明面 ${rankStr} -> 隐性约 ${estName}（胜率偏差 ${winDelta >= 0 ? "+" : ""}${winDelta.toFixed(1)}%）`
        );
      }
    }
  }

  if (roleDetails.length > 0) {
    mmrLines.push(`各位置明面段位与样本：${roleDetails.join("；")}`);
  }
  if (heuristicHints.length > 0) {
    mmrLines.push(`算法侧胜率/KDA 偏移初算：${heuristicHints.join("；")}`);
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
    const mSum = pickField(statsObj, ["matchSum", "totalCount", "matchCount"]);
    const wSum = pickField(statsObj, ["matchWinSum", "winCount", "wins"]);
    const lSum = pickField(statsObj, ["matchLossSum", "lossCount", "losses"]);
    const wRate = pickField(statsObj, ["winRate", "winRatio", "win_rate"]);
    const kda = pickField(statsObj, ["kda", "avgKda"]);
    const avgK = pickField(statsObj, ["aveKill", "avgEliminations"]);
    const avgA = pickField(statsObj, ["aveAssist", "avgAssists"]);
    const avgD = pickField(statsObj, ["aveDeath", "avgDeaths"]);
    const avgDmg = pickField(statsObj, ["aveHeroDamage", "avgDamage"]);
    const avgHeal = pickField(statsObj, ["aveCure", "avgHeal"]);
    const avgRes = pickField(statsObj, ["aveResistDamage"]);

    mmrLines.push(
      `赛季${modeLabel}实战效率：总场次 ${mSum ?? "-"}（${wSum ?? "-"}胜 ${lSum ?? "-"}负，胜率 ${wRate ?? "-"}%），综合 KDA ${kda ?? "-"}，场均消灭 ${avgK ?? "-"} / 助攻 ${avgA ?? "-"} / 阵亡 ${avgD ?? "-"}，场均伤害 ${avgDmg ?? "-"}，场均治疗 ${avgHeal ?? "-"}，场均抵伤 ${avgRes ?? "-"}`
    );
  }

  const heroList =
    countData?.presetsHeroUseSummaryList ||
    countData?.heroList ||
    countData?.heroes ||
    countData?.topHeroes ||
    cardData?.heroList;
  if (Array.isArray(heroList) && heroList.length > 0) {
    const heroSummary = heroList
      .slice(0, 6)
      .map((h: any) => {
        const hRaw = pickField(h, [
          "heroName",
          "name",
          "cnName",
          "heroGuid",
          "heroId",
        ]);
        const hCn = sanitizeSafeText(
          resolveDashenHeroName(hRaw) || "未知英雄",
          "mmr-hero"
        );
        const hGames = pickField(h, ["matchSum", "totalCount", "matchCount"]);
        const hWin = pickField(h, ["winRate", "winRatio"]);
        const hKda = pickField(h, ["kda", "avgKda"]);
        return `${hCn}(${hGames ?? "-"}场, 胜率${hWin ?? "-"}%, KDA ${hKda ?? "-"})`;
      })
      .join("；");
    mmrLines.push(`主力英雄池表现：${heroSummary}`);
  }

  const recentMatches: any[] = Array.isArray(listBody)
    ? listBody
    : Array.isArray(listBody?.matchList)
      ? listBody.matchList
      : listBody?.list || listBody?.records || listBody?.items || [];

  if (recentMatches.length > 0) {
    const recentSlice = recentMatches.slice(0, 8);
    let winStreak = 0;
    let lossStreak = 0;
    const seqTags: string[] = [];

    for (const m of recentSlice) {
      const badge = parseMatchResultBadge(m);
      const isWin = badge.includes("胜");
      const isLoss = badge.includes("负");
      seqTags.push(isWin ? "胜" : isLoss ? "负" : "平");
    }

    for (const tag of seqTags) {
      if (tag === "胜" && lossStreak === 0) winStreak++;
      else if (tag === "负" && winStreak === 0) lossStreak++;
      else break;
    }

    const recentWins = seqTags.filter((t) => t === "胜").length;
    const recentLosses = seqTags.filter((t) => t === "负").length;
    const streakNote =
      winStreak >= 2
        ? `当前 ${winStreak} 连胜`
        : lossStreak >= 2
          ? `当前 ${lossStreak} 连败`
          : "胜负交替";

    mmrLines.push(
      `近期战绩走势（最近${recentSlice.length}场）：${recentWins}胜${recentLosses}负（序列：${seqTags.join("-")}，${streakNote}）`
    );
  }

  const promptContext = sanitizeSafeText(
    mmrLines.join("\n"),
    "mmrPromptContext"
  );

  const systemPrompt = sanitizeSafeText(
    [
      "你是一位精通《守望先锋 2》匹配机制（MMR/隐藏分）与排位算法的数据分析师。",
      "请综合玩家的【各位置明面段位、胜率背离度、场均KDA/伤害/治疗/死亡效率、主力英雄池胜率、近期连胜/连败动量】，反推其当前真实的“隐性隐藏分（MMR）段位”与系统匹配状态。",
      "请为每一个在数据中出现的职责（如 坦克 / 输出 / 支援 / 开放）单独生成一条段位对照。",
      "严格基于提供的数据推理，禁止编造不存在的数据。",
      "请只输出纯 JSON（不要 markdown 代码块包裹，不要额外解释文字），格式如下：",
      "{",
      '  "role_comparisons": [',
      '    {',
      '      "role": "职责名称，如 坦克 / 输出 / 支援 / 开放",',
      '      "current_rank": "当前明面段位，如 白金 2（若未定级写 未定级）",',
      '      "hidden_rank": "隐藏分推演段位，如 白金 4 ~ 白金 3（若未定级写 等效白金 3）",',
      '      "tag": "简短状态标签，如 承压掉分期 / 抬分上分期 / 分段匹配"',
      "    }",
      "  ],",
      '  "mmr_status": "总体MMR状态标签",',
      '  "evidence": "核心数据推导依据（90字以内）",',
      '  "trend_advice": "冲分建议与下一步预测（70字以内）"',
      "}",
    ].join("\n"),
    "mmrSystemPrompt"
  );

  const { parsed, rawContent } = await callDeepSeekJson(
    systemPrompt,
    promptContext,
    `mmr:${gameMode}:${safeBnetForAi}`
  );

  const roleIconMap: Record<string, string> = {
    坦克: "🛡",
    重装: "🛡",
    输出: "⚔️",
    dps: "⚔️",
    支援: "💉",
    辅助: "💉",
    开放: "🎲",
    自由: "🎲",
  };

  const rawComparisons = Array.isArray(parsed?.role_comparisons)
    ? parsed.role_comparisons
    : [];
  const comparisonLines: string[] = [];

  for (const item of rawComparisons) {
    const roleRaw = sanitizeSafeText(item?.role || "", "mmr-comp-role").trim();
    const curRank = sanitizeSafeText(
      item?.current_rank || "未定级",
      "mmr-comp-cur"
    ).trim();
    const hidRank = sanitizeSafeText(
      item?.hidden_rank || "推演中",
      "mmr-comp-hid"
    ).trim();
    const tag = sanitizeSafeText(item?.tag || "", "mmr-comp-tag").trim();
    if (!roleRaw) continue;

    const icon = roleIconMap[roleRaw.toLowerCase()] || roleIconMap[roleRaw] || "•";
    comparisonLines.push(
      `${icon} <b>${escapeHtml(roleRaw)}</b>：<code>${escapeHtml(curRank)}</code>  ➔  <b>${escapeHtml(hidRank)}</b>${tag ? `（${escapeHtml(tag)}）` : ""}`
    );
  }

  if (comparisonLines.length === 0) {
    comparisonLines.push(`📌 <b>综合</b>：<code>综合评估</code>  ➔  <b>推演中</b>`);
  }

  const mmrStatus = escapeHtml(
    sanitizeSafeText(
      parsed?.mmr_status || "实力与当前分段基本匹配",
      "mmr-status"
    ).trim()
  );
  const evidence = escapeHtml(
    sanitizeSafeText(
      parsed?.evidence || cleanAiJsonText(rawContent) || "暂无推导依据",
      "mmr-evidence"
    ).trim()
  );
  const trendAdvice = escapeHtml(
    sanitizeSafeText(parsed?.trend_advice || "-", "mmr-advice").trim()
  );

  return [
    `🔮 <b>DeepSeek 隐性段位评估 — ${escapeHtml(safeBnetForAi)}</b>`,
    `📋 <b>各职责段位对照（当前段位 ➔ 隐藏分推演）：</b>`,
    ...comparisonLines,
    `⚖️ <b>总体状态：</b>「${mmrStatus}」（${modeLabel}）`,
    `━━━━━━━━━━━━━━━━━━`,
    `📊 <b>数据推导依据：</b>${evidence}`,
    `🧭 <b>冲分趋势预测：</b><i>${trendAdvice}</i>`,
  ].join("\n");
}

// ============================================================================
// 6. 视图渲染：国服总览 / 近期战绩 / 对局详情 / 个人中心 / 管理员面板
// ============================================================================

async function buildCnOverviewView(
  bnet: string,
  gameMode: CnGameMode,
  userId?: number
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const searchRes = await searchBnetAccount(bnet, userId);
  const player = extractPlayerFromSearch(bnet, searchRes);

  const [cardRes, countRes] = await Promise.allSettled([
    queryCard(player.customerToken, userId),
    queryCountInfo(player.customerToken, gameMode, userId),
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

  const keyboard = new InlineKeyboard();
  const mCode = gameMode === "sport" ? "s" : "l";
  const nextM = gameMode === "sport" ? "l" : "s";

  const selfRoastCb = `r:${mCode}:${player.bnet}`;
  const hiddenMmrCb = `h:${mCode}:${player.bnet}`;
  const switchModeCb = `o:${nextM}:${player.bnet}`;
  const matchListCb = `m:${mCode}:1:${player.bnet}`;
  const refreshCb = `o:${mCode}:${player.bnet}`;

  if (isSafeCallbackData(selfRoastCb)) {
    keyboard.text("🤖 锐评自己", selfRoastCb);
  }
  if (isSafeCallbackData(hiddenMmrCb)) {
    keyboard.text("🔮 隐性段位评估", hiddenMmrCb);
  }
  if (isSafeCallbackData(selfRoastCb) || isSafeCallbackData(hiddenMmrCb)) {
    keyboard.row();
  }
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
  page = 1,
  userId?: number
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const searchRes = await searchBnetAccount(bnet, userId);
  const player = extractPlayerFromSearch(bnet, searchRes);
  const listRes = await queryMatchList(
    player.customerToken,
    gameMode,
    page,
    userId
  );
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

async function buildCnMatchDetailView(
  refId: string,
  userId?: number
): Promise<{
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

  const res = await queryMatchInfo(entry.customerToken, entry.matchId, userId);
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

function buildUserCenterView(
  ctx: Context,
  user: UserProfileDto,
  settings?: SystemSettingsDto
): { text: string; keyboard: InlineKeyboard } {
  const botUsername = String(ctx.me?.username || "").trim();
  const inviteLink = botUsername
    ? `https://t.me/${botUsername}?start=inv_${user.tgId}`
    : `/start inv_${user.tgId}`;

  const vipLabel = user.isAdmin
    ? user.adminRole === "super_admin"
      ? "👑 超级管理员（AI 锐评免限）"
      : "🛡 管理员（AI 锐评免限）"
    : user.vipActive
      ? `👑 VIP 会员（有效期至 ${escapeHtml(user.vipExpireAt || "长期")}）`
      : "🆓 免费用户";

  const quotaLabel = user.roastUnlimited
    ? "♾ 无限次（管理员/VIP 免限）"
    : `<b>${user.quota}</b> 次`;

  const regRuleText =
    settings === undefined
      ? "新用户首次启动赠送次数"
      : settings.registerRewardEnabled && settings.registerRewardQuota > 0
        ? `新用户首次启动赠送 <b>${settings.registerRewardQuota}</b> 次`
        : "当前新注册赠送已关闭";

  const invRuleText =
    settings === undefined
      ? "邀请好友首次启动奖励次数"
      : settings.inviteRewardEnabled && settings.inviteRewardQuota > 0
        ? `你立得 <b>+${settings.inviteRewardQuota}</b> 次`
        : "当前邀请赠送已关闭";

  const chkRuleText =
    settings === undefined
      ? "每日 00:00 签到可领次数"
      : settings.checkinRewardEnabled && settings.checkinRewardQuota > 0
        ? `每日 00:00 签到可再领 <b>+${settings.checkinRewardQuota}</b> 次`
        : "每日 00:00 可签到（当前签到赠送已关闭）";

  const checkinBtnLabel =
    settings &&
    (!settings.checkinRewardEnabled || settings.checkinRewardQuota <= 0)
      ? "📅 每日签到"
      : `📅 每日签到 (+${settings?.checkinRewardQuota ?? 1}次)`;

  const text = [
    `👤 <b>个人中心</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🆔 <b>用户 ID：</b><code>${user.tgId}</code>`,
    `🏷 <b>昵称：</b>${escapeHtml(user.nickname || "未设置")}`,
    `📛 <b>用户名：</b>${user.username ? `@${escapeHtml(user.username)}` : "未设置"}`,
    `👑 <b>会员状态：</b>${vipLabel}`,
    `📅 <b>注册时间：</b>${escapeHtml(user.createdAt || "-")}`,
    `⚡ <b>剩余锐评次数：</b>${quotaLabel}`,
    `🤝 <b>已成功邀请：</b><b>${user.inviteCount}</b> 人`,
    `━━━━━━━━━━━━━━━━━━`,
    `🔗 <b>你的专属邀请链接：</b>`,
    `<code>${escapeHtml(inviteLink)}</code>`,
    `<i>（${regRuleText}；${invRuleText}；${chkRuleText}）</i>`,
  ].join("\n");

  const keyboard = new InlineKeyboard()
    .text(checkinBtnLabel, "u:checkin")
    .text("🎟 兑换卡密", "u:redeem_prompt")
    .row()
    .text("🔄 刷新个人中心", "u:me");

  return { text, keyboard };
}

function buildAdminDashboardView(admin: AdminMeDto): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const isSuper = admin.role === "super_admin";
  const hasPerm = (p: string) => isSuper || admin.permissions.includes(p);

  const permNames = isSuper
    ? ["全部 9 项业务权限 + 超管专属特权（AI 锐评无限制）"]
    : admin.permissions.length > 0
      ? admin.permissions.map((p) => admin.permissionLabels?.[p] || p)
      : ["暂无已授权功能（请联系超管勾选）"];

  const text = [
    isSuper ? `🛠 <b>超级管理员控制台</b>` : `🛠 <b>管理员控制台</b>`,
    `👤 <b>当前操作人：</b><code>${admin.tgId}</code>${admin.remark ? `（${escapeHtml(admin.remark)}）` : ""}`,
    `🎖 <b>角色身份：</b>${isSuper ? "超级管理员" : "普通管理员"} · <i>AI 锐评无限制</i>`,
    `🔑 <b>可用权限：</b>${escapeHtml(permNames.join("、"))}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<i>请选择下方功能按钮进行操作（仅展示你已获授权的功能）：</i>`,
  ].join("\n");

  const kb = new InlineKeyboard();
  let btnInRow = 0;
  const pushBtn = (label: string, cb: string) => {
    if (!isSafeCallbackData(cb)) return;
    kb.text(label, cb);
    btnInRow++;
    if (btnInRow % 2 === 0) {
      kb.row();
      btnInRow = 0;
    }
  };

  if (hasPerm("user:view")) pushBtn("👤 用户查询", "ad:q_user");
  if (hasPerm("stats:view")) pushBtn("📊 运营统计", "ad:stats");
  if (hasPerm("quota:add")) pushBtn("➕ 添加次数", "ad:q_add");
  if (hasPerm("quota:deduct")) pushBtn("➖ 减少次数", "ad:q_deduct");
  if (hasPerm("vip:manage")) pushBtn("👑 VIP 管理", "ad:q_vip");
  if (hasPerm("user:ban")) pushBtn("🚫 封禁管理", "ad:q_ban");
  if (hasPerm("redeem:create")) pushBtn("🎟 生成卡密", "ad:q_genkey");
  if (hasPerm("redeem:view")) pushBtn("🔍 查询卡密", "ad:q_viewkey");
  if (hasPerm("redeem:void")) pushBtn("❌ 作废卡密", "ad:q_voidkey");

  if (isSuper) {
    if (btnInRow > 0) {
      kb.row();
      btnInRow = 0;
    }
    kb.text("⚙️ 系统与赠送设置", "ad:settings:0")
      .text("👥 管理员管理", "ad:admins:1")
      .row()
      .text("📜 审计日志", "ad:audit:1");
  }

  return { text, keyboard: kb };
}

function buildSystemSettingsView(s: SystemSettingsDto): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const isMaint = s.botStatus === "maintenance";
  const text = [
    `⚙️ <b>系统与赠送规则设置（仅超管）</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🤖 <b>机器人状态：</b>${isMaint ? "🛠 <b>维护中</b>（仅启用管理员/超管可调试）" : "✅ <b>正常运行</b>（全体用户可用）"}`,
    `🆕 <b>新注册赠送：</b>${s.registerRewardEnabled ? `✅ 开启（送 <b>${s.registerRewardQuota}</b> 次）` : "⛔ 关闭（送 0 次）"}`,
    `🤝 <b>邀请人赠送：</b>${s.inviteRewardEnabled ? `✅ 开启（送 <b>${s.inviteRewardQuota}</b> 次）` : "⛔ 关闭（送 0 次）"}`,
    `📅 <b>每日签到赠送：</b>${s.checkinRewardEnabled ? `✅ 开启（送 <b>${s.checkinRewardQuota}</b> 次）` : "⛔ 关闭（送 0 次）"}`,
    s.updatedAt ? `🕒 <b>最近更新：</b><code>${escapeHtml(s.updatedAt)}</code>` : "",
    `━━━━━━━━━━━━━━━━━━`,
    `<i>点击按钮可即时切换状态或开关；输入数字可自定义赠送次数（0~10000）。</i>`,
  ]
    .filter(Boolean)
    .join("\n");

  const kb = new InlineKeyboard()
    .text(
      isMaint ? "✅ 切换为正常运行" : "🛠 切换为维护模式",
      "ad:st_bot"
    )
    .row()
    .text(
      s.registerRewardEnabled ? "⛔ 关闭新注册送" : "✅ 开启新注册送",
      "ad:st_reg_tog"
    )
    .text("🔢 设新注册次数", "ad:q_st_reg")
    .row()
    .text(
      s.inviteRewardEnabled ? "⛔ 关闭邀请送" : "✅ 开启邀请送",
      "ad:st_inv_tog"
    )
    .text("🔢 设邀请次数", "ad:q_st_inv")
    .row()
    .text(
      s.checkinRewardEnabled ? "⛔ 关闭签到送" : "✅ 开启签到送",
      "ad:st_chk_tog"
    )
    .text("🔢 设签到次数", "ad:q_st_chk")
    .row()
    .text("⬅️ 返回控制台", "ad:home");

  return { text, keyboard: kb };
}

function buildAdminDetailView(
  target: {
    tgId: number;
    remark: string;
    role: string;
    permissions: string[];
    isActive: boolean;
  },
  allPermissions: string[],
  labels: Record<string, string>
): { text: string; keyboard: InlineKeyboard } {
  const permListText =
    target.permissions.length > 0
      ? target.permissions.map((p) => labels[p] || p).join("、")
      : "无";

  const text = [
    `👤 <b>编辑普通管理员</b>`,
    `🆔 <b>TG ID：</b><code>${target.tgId}</code>`,
    `🏷 <b>备注：</b>${escapeHtml(target.remark || "未设置")}`,
    `📌 <b>状态：</b>${target.isActive ? "✅ 已启用（AI 锐评免限）" : "⏸ 已停用"}`,
    `🔑 <b>已授权：</b>${escapeHtml(permListText)}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<i>点击下方权限按钮可实时开启或关闭对应权限：</i>`,
  ].join("\n");

  const kb = new InlineKeyboard();
  allPermissions.forEach((perm, idx) => {
    const enabled = target.permissions.includes(perm);
    const label = `${enabled ? "✅" : "⬜"} ${labels[perm] || perm}`;
    const cb = `ad:pt:${target.tgId}:${idx}`;
    if (isSafeCallbackData(cb)) {
      kb.text(label, cb);
      if (idx % 2 === 1) kb.row();
    }
  });
  if (allPermissions.length % 2 === 1) kb.row();

  kb.text(
    target.isActive ? "⏸ 停用管理员" : "✅ 启用管理员",
    `ad:tog:${target.tgId}`
  )
    .text("🗑 删除管理员", `ad:del:${target.tgId}`)
    .row()
    .text("⬅️ 返回管理员列表", "ad:admins:1");

  return { text, keyboard: kb };
}

// ============================================================================
// 7. 初始化 grammY Bot 与指令注册
// ============================================================================

const bot = new Bot(BOT_TOKEN);

type PendingAction =
  | "cn"
  | "match"
  | "redeem"
  | "admin_user"
  | "admin_quota_add"
  | "admin_quota_deduct"
  | "admin_vip"
  | "admin_ban"
  | "admin_genkey"
  | "admin_viewkey"
  | "admin_voidkey"
  | "admin_add_admin"
  | "admin_set_reg_quota"
  | "admin_set_inv_quota"
  | "admin_set_chk_quota";

const pendingActions = new Map<
  number,
  { action: PendingAction; expiresAt: number }
>();

const PROMPT_TAGS: Record<PendingAction, string> = {
  cn: "国服战绩总览查询",
  match: "国服近期对局查询",
  redeem: "兑换卡密",
  admin_user: "后台查询用户",
  admin_quota_add: "后台添加次数",
  admin_quota_deduct: "后台减少次数",
  admin_vip: "后台 VIP 管理",
  admin_ban: "后台封禁管理",
  admin_genkey: "后台生成卡密",
  admin_viewkey: "后台查询卡密",
  admin_voidkey: "后台作废卡密",
  admin_add_admin: "后台添加普通管理员",
  admin_set_reg_quota: "设置新注册赠送次数",
  admin_set_inv_quota: "设置邀请人赠送次数",
  admin_set_chk_quota: "设置每日签到赠送次数",
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

function parseStartInviterId(rawPayload: string): number | null {
  const s = String(rawPayload || "").trim();
  const match = s.match(/^inv_(\d{3,20})$/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function executeCnQuery(ctx: Context, rawInput: string): Promise<void> {
  const bnet = rawInput.trim().split(/\s+/)[0];
  if (!bnet) return;
  const userId = ctx.from?.id;
  await ctx.replyWithChatAction("typing");
  try {
    await ensureUserRecord(ctx);
    const { text, keyboard } = await buildCnOverviewView(bnet, "sport", userId);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err) {
    await handleCommandError(ctx, err);
  }
}

async function executeMatchQuery(ctx: Context, rawInput: string): Promise<void> {
  const bnet = rawInput.trim().split(/\s+/)[0];
  if (!bnet) return;
  const userId = ctx.from?.id;
  await ctx.replyWithChatAction("typing");
  try {
    await ensureUserRecord(ctx);
    const { text, keyboard } = await buildCnMatchListView(
      bnet,
      "sport",
      1,
      userId
    );
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err) {
    await handleCommandError(ctx, err);
  }
}

async function executeRedeemCode(ctx: Context, rawCode: string): Promise<void> {
  const code = rawCode.trim().split(/\s+/)[0];
  if (!code) {
    setPendingAction(ctx.from?.id, "redeem");
    await ctx.reply(
      `🎟 <b>${PROMPT_TAGS.redeem}</b>\n请直接发送你的兑换卡密（例如：<code>OW2C-10-A1B2C3D4</code>）：`,
      {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true },
      }
    );
    return;
  }

  const { tgId, nickname, username } = getTgUserMeta(ctx);
  await ctx.replyWithChatAction("typing");
  try {
    const res = await relayInternalRequest("POST", "/internal/user/redeem", {
      json: { tgId, code, nickname, username },
    });
    const d = res.data;
    const rewardDesc =
      d.rewardType === "vip_days"
        ? `👑 VIP 会员 <b>+${d.rewardValue}</b> 天（到期时间：<code>${escapeHtml(d.vipExpireAt || "-")}</code>）`
        : `⚡ 锐评次数 <b>+${d.rewardValue}</b> 次（当前剩余：<b>${d.quota}</b> 次）`;

    await ctx.reply(
      `✅ <b>卡密兑换成功！</b>\n🎟 卡密：<code>${escapeHtml(d.code)}</code>\n🎁 获得：${rewardDesc}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    await handleCommandError(ctx, err);
  }
}

async function executeCheckin(ctx: Context): Promise<void> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  const res = await relayInternalRequest("POST", "/internal/user/checkin", {
    json: { tgId, nickname, username },
  });
  const d = res.data;
  if (d.alreadyCheckedIn) {
    await ctx.reply(
      `📅 你今天（<code>${escapeHtml(d.today)}</code>）已经签过到啦！\n⚡ 当前剩余锐评次数：<b>${d.quota}</b> 次（每日 00:00 刷新）。`,
      { parse_mode: "HTML" }
    );
    return;
  }
  const rewardLine =
    d.rewardEnabled && d.rewardQuota > 0
      ? `🎁 奖励：<b>+${d.rewardQuota}</b> 次锐评机会\n`
      : `🎁 当前签到赠送已关闭（未额外增加次数）\n`;
  await ctx.reply(
    `✅ <b>每日签到成功！</b>（<code>${escapeHtml(d.today)}</code>）\n${rewardLine}⚡ 当前剩余锐评次数：<b>${d.quota}</b> 次`,
    { parse_mode: "HTML" }
  );
}

async function openUserCenter(ctx: Context, editExisting = false): Promise<void> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  const res = await relayInternalRequest("POST", "/internal/user/ensure", {
    json: { tgId, nickname, username },
  });
  const user: UserProfileDto = res.data.user;
  const settings: SystemSettingsDto | undefined = res.data.settings;
  const { text, keyboard } = buildUserCenterView(ctx, user, settings);

  if (editExisting) {
    await safeEditMessage(ctx, text, keyboard);
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
}

async function fetchAdminMe(operatorId: number): Promise<AdminMeDto> {
  const res = await relayInternalRequest("GET", "/internal/admin/me", {
    operatorId,
  });
  return res.data;
}

async function handlePendingAdminInput(
  ctx: Context,
  action: PendingAction,
  text: string
): Promise<boolean> {
  const operatorId = Number(ctx.from?.id || 0);
  if (!operatorId) return false;

  try {
    if (action === "admin_user") {
      const res = await relayInternalRequest("GET", "/internal/admin/user", {
        params: { query: text },
        operatorId,
      });
      const u: UserProfileDto = res.data.user;
      const logs: any[] = res.data.recentLogs || [];
      const logLines =
        logs.length > 0
          ? logs
              .slice(0, 5)
              .map(
                (l) =>
                  `• ${l.changeAmount >= 0 ? `+${l.changeAmount}` : l.changeAmount} (${escapeHtml(l.reason)}) → 余额 ${l.balanceAfter} [${escapeHtml(l.createdAt)}]`
              )
          : ["• 暂无流水记录"];

      await ctx.reply(
        [
          `👤 <b>用户档案详情</b>`,
          `🆔 ID：<code>${u.tgId}</code>  |  昵称：${escapeHtml(u.nickname || "-")}  |  用户名：${u.username ? `@${escapeHtml(u.username)}` : "无"}`,
          `⚡ 剩余次数：<b>${u.quota}</b>  |  VIP：${u.vipActive ? `至 ${escapeHtml(u.vipExpireAt || "")}` : "否"}  |  封禁：${u.isBanned ? "🚫是" : "✅否"}`,
          `🤝 邀请人数：<b>${u.inviteCount}</b>  |  注册：${escapeHtml(u.createdAt || "-")}`,
          `━━━━━━━━━━━━━━━━━━`,
          `<b>📜 近期次数流水</b>`,
          ...logLines,
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return true;
    }

    if (action === "admin_quota_add" || action === "admin_quota_deduct") {
      const parts = text.trim().split(/\s+/);
      const targetTgId = Number(parts[0]);
      const amount = Number(parts[1]);
      const reason = parts.slice(2).join(" ").trim();
      const endpoint =
        action === "admin_quota_add"
          ? "/internal/admin/quota/add"
          : "/internal/admin/quota/deduct";
      const res = await relayInternalRequest("POST", endpoint, {
        operatorId,
        json: { targetTgId, amount, reason },
      });
      const d = res.data;
      await ctx.reply(
        action === "admin_quota_add"
          ? `✅ <b>添加次数成功</b>\n👤 用户：<code>${d.tgId}</code>\n➕ 增加：<b>+${d.added}</b> 次（${d.beforeQuota} → <b>${d.afterQuota}</b>）\n📝 原因：${escapeHtml(d.reason)}`
          : `✅ <b>减少次数成功</b>\n👤 用户：<code>${d.tgId}</code>\n➖ 扣除：<b>-${d.deducted}</b> 次（${d.beforeQuota} → <b>${d.afterQuota}</b>）\n📝 原因：${escapeHtml(d.reason)}`,
        { parse_mode: "HTML" }
      );
      return true;
    }

    if (action === "admin_vip") {
      const parts = text.trim().split(/\s+/);
      const targetTgId = Number(parts[0]);
      const modeArg = (parts[1] || "").toLowerCase();
      if (modeArg === "revoke" || modeArg === "cancel" || modeArg === "取消") {
        const reason = parts.slice(2).join(" ").trim() || "取消 VIP";
        const res = await relayInternalRequest("POST", "/internal/admin/vip", {
          operatorId,
          json: { targetTgId, actionType: "revoke", reason },
        });
        await ctx.reply(
          `✅ <b>已取消用户 VIP</b>\n👤 用户：<code>${res.data.tgId}</code>\n📝 原因：${escapeHtml(res.data.reason)}`,
          { parse_mode: "HTML" }
        );
      } else {
        const days = Number(parts[1]);
        const reason = parts.slice(2).join(" ").trim() || "开通/续期 VIP";
        const res = await relayInternalRequest("POST", "/internal/admin/vip", {
          operatorId,
          json: { targetTgId, actionType: "grant", days, reason },
        });
        await ctx.reply(
          `✅ <b>VIP 开通/续期成功</b>\n👤 用户：<code>${res.data.tgId}</code>\n👑 到期时间：<code>${escapeHtml(res.data.afterVip || "-")}</code>\n📝 原因：${escapeHtml(res.data.reason)}`,
          { parse_mode: "HTML" }
        );
      }
      return true;
    }

    if (action === "admin_ban") {
      const parts = text.trim().split(/\s+/);
      const targetTgId = Number(parts[0]);
      const opArg = (parts[1] || "").toLowerCase();
      const banned = !["0", "false", "unban", "解封"].includes(opArg);
      const reason = parts.slice(2).join(" ").trim();
      const res = await relayInternalRequest("POST", "/internal/admin/user/ban", {
        operatorId,
        json: { targetTgId, banned, reason },
      });
      await ctx.reply(
        `✅ <b>用户状态已更新</b>\n👤 用户：<code>${res.data.tgId}</code>\n📌 状态：${res.data.isBanned ? "🚫 已封禁" : "✅ 已解封"}\n📝 原因：${escapeHtml(res.data.reason)}`,
        { parse_mode: "HTML" }
      );
      return true;
    }

    if (action === "admin_genkey") {
      const parts = text.trim().split(/\s+/);
      const rawType = (parts[0] || "quota").toLowerCase();
      const rewardType =
        rawType === "vip" || rawType === "vip_days" ? "vip_days" : "quota";
      const rewardValue = Number(parts[1]);
      const count = Number(parts[2] || 1);
      const res = await relayInternalRequest(
        "POST",
        "/internal/admin/redeem/create",
        {
          operatorId,
          json: { rewardType, rewardValue, count },
        }
      );
      const codes: string[] = res.data.codes || [];
      const typeLabel = rewardType === "vip_days" ? "VIP天数" : "锐评次数";
      await ctx.reply(
        [
          `🎟 <b>卡密生成成功（共 ${codes.length} 张）</b>`,
          `🎁 类型：${typeLabel}  |  面额：<b>${rewardValue}</b>`,
          `━━━━━━━━━━━━━━━━━━`,
          ...codes.map((c) => `<code>${escapeHtml(c)}</code>`),
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return true;
    }

    if (action === "admin_viewkey") {
      const code = text.trim().split(/\s+/)[0];
      const res = await relayInternalRequest(
        "GET",
        "/internal/admin/redeem/view",
        {
          params: { code },
          operatorId,
        }
      );
      const c = res.data;
      const statusMap: Record<string, string> = {
        unused: "🟢 未使用",
        used: "🔵 已核销",
        voided: "🔴 已作废",
      };
      await ctx.reply(
        [
          `🔍 <b>卡密详情</b>`,
          `🎟 卡密：<code>${escapeHtml(c.code)}</code>`,
          `🎁 奖励：${c.rewardType === "vip_days" ? `VIP ${c.rewardValue} 天` : `次数 +${c.rewardValue}`}`,
          `📌 状态：${statusMap[c.status] || c.status}`,
          c.usedBy
            ? `👤 核销人：<code>${c.usedBy}</code>（${escapeHtml(c.usedAt || "")}）`
            : "",
          c.voidedBy
            ? `❌ 作废人：<code>${c.voidedBy}</code>（${escapeHtml(c.voidReason || "无原因")} · ${escapeHtml(c.voidedAt || "")}）`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        { parse_mode: "HTML" }
      );
      return true;
    }

    if (action === "admin_voidkey") {
      const parts = text.trim().split(/\s+/);
      const code = parts[0];
      const reason = parts.slice(1).join(" ").trim();
      const res = await relayInternalRequest(
        "POST",
        "/internal/admin/redeem/void",
        {
          operatorId,
          json: { code, reason },
        }
      );
      await ctx.reply(
        `✅ <b>卡密已作废</b>\n🎟 卡密：<code>${escapeHtml(res.data.code)}</code>\n📝 原因：${escapeHtml(res.data.voidReason)}`,
        { parse_mode: "HTML" }
      );
      return true;
    }

    if (action === "admin_add_admin") {
      const parts = text.trim().split(/\s+/);
      const targetTgId = Number(parts[0]);
      const remark = parts.slice(1).join(" ").trim();
      const res = await relayInternalRequest("POST", "/internal/admin/admins", {
        operatorId,
        json: { targetTgId, remark },
      });
      await ctx.reply(
        `✅ <b>已添加普通管理员（初始 0 权限）</b>\n👤 TG ID：<code>${res.data.tgId}</code>\n🏷 备注：${escapeHtml(res.data.remark)}\n<i>请返回「👥 管理员管理」为其勾选授权。</i>`,
        { parse_mode: "HTML" }
      );
      return true;
    }

    if (
      action === "admin_set_reg_quota" ||
      action === "admin_set_inv_quota" ||
      action === "admin_set_chk_quota"
    ) {
      const num = Number(text.trim());
      if (!Number.isInteger(num) || num < 0 || num > 10000) {
        await ctx.reply(
          "❌ 请输入 0 ~ 10000 之间的整数次数（例如：<code>3</code> 或 <code>0</code>）。",
          { parse_mode: "HTML" }
        );
        return true;
      }
      const fieldKey =
        action === "admin_set_reg_quota"
          ? "registerRewardQuota"
          : action === "admin_set_inv_quota"
            ? "inviteRewardQuota"
            : "checkinRewardQuota";
      const res = await relayInternalRequest(
        "POST",
        "/internal/admin/settings",
        {
          operatorId,
          json: { [fieldKey]: num },
        }
      );
      const { text: viewText, keyboard } = buildSystemSettingsView(res.data);
      await ctx.reply(`✅ 次数设置已更新！\n\n${viewText}`, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return true;
    }
  } catch (err) {
    await handleCommandError(ctx, err);
    return true;
  }

  return false;
}

bot.command(["start", "help"], async (ctx) => {
  const inviterId = parseStartInviterId(ctx.match.trim());
  let regQuotaText = "3";
  let invQuotaText = "1";
  try {
    const info = await ensureUserRecord(ctx, inviterId);
    if (info.settings) {
      regQuotaText = info.settings.registerRewardEnabled
        ? String(info.settings.registerRewardQuota)
        : "0";
      invQuotaText = info.settings.inviteRewardEnabled
        ? String(info.settings.inviteRewardQuota)
        : "0";
    }
    if (info.inviteRewardGranted && info.inviterId) {
      await ctx.api
        .sendMessage(
          info.inviterId,
          `🎉 <b>邀请奖励到账！</b>\n好友 <code>${info.user.tgId}</code> 通过你的邀请链接首次启动了机器人，你获得了 <b>+${info.inviteRewardQuota}</b> 次锐评机会！`,
          { parse_mode: "HTML" }
        )
        .catch(() => {
          // 忽略通知发送失败
        });
    }
  } catch (err) {
    console.error("[/start ensureUserRecord error]", err);
  }

  const helpText = [
    `🇨🇳 <b>欢迎使用《守望先锋 2》国服战绩查询机器人！</b>`,
    ``,
    `📌 <b>战绩查询指令：</b>`,
    `• <code>/cn 战网ID</code> — 查询国服段位、赛季统计、常用英雄、个人锐评与隐性段位`,
    `• <code>/match 战网ID</code> — 查询国服近期战绩流水与单场对局详情/锐评`,
    ``,
    `👤 <b>个人中心与福利：</b>`,
    `• <code>/me</code> — 查看个人中心、剩余次数、邀请人数与专属邀请链接`,
    `• <code>/checkin</code> — 每日签到领锐评机会（每日 00:00 刷新）`,
    `• <code>/redeem 卡密</code> — 兑换次数卡密或 VIP 会员卡密`,
    ``,
    `💡 <i>当前规则：新注册默认送 <b>${regQuotaText}</b> 次；邀请 1 位新用户注册奖励 <b>+${invQuotaText}</b> 次。</i>`,
  ].join("\n");

  await ctx.reply(helpText, { parse_mode: "HTML" });
});

bot.command("me", async (ctx) => {
  try {
    await openUserCenter(ctx, false);
  } catch (err) {
    await handleCommandError(ctx, err);
  }
});

bot.command("checkin", async (ctx) => {
  try {
    await executeCheckin(ctx);
  } catch (err) {
    await handleCommandError(ctx, err);
  }
});

bot.command("redeem", async (ctx) => {
  await executeRedeemCode(ctx, ctx.match.trim());
});

bot.command("admin", async (ctx) => {
  if (ctx.chat.type !== "private") {
    return;
  }
  const operatorId = Number(ctx.from?.id || 0);
  if (!operatorId) return;

  try {
    const admin = await fetchAdminMe(operatorId);
    const { text, keyboard } = buildAdminDashboardView(admin);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch (err) {
    await handleCommandError(ctx, err);
  }
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
    for (const [actKey, tag] of Object.entries(PROMPT_TAGS) as Array<
      [PendingAction, string]
    >) {
      if (replyMsg.text.includes(tag)) {
        action = actKey;
        break;
      }
    }
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

  if (action === "cn") {
    await executeCnQuery(ctx, text);
  } else if (action === "match") {
    await executeMatchQuery(ctx, text);
  } else if (action === "redeem") {
    await executeRedeemCode(ctx, text);
  } else if (action.startsWith("admin_")) {
    await handlePendingAdminInput(ctx, action, text);
  }
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const parts = data.split(":");
  const action = parts[0];
  const userId = ctx.from?.id;

  try {
    if (action === "u") {
      const sub = parts[1];
      if (sub === "me") {
        await openUserCenter(ctx, true);
        await safeAnswerCallback(ctx);
        return;
      }
      if (sub === "checkin") {
        await safeAnswerCallback(ctx);
        await executeCheckin(ctx);
        return;
      }
      if (sub === "redeem_prompt") {
        setPendingAction(ctx.from?.id, "redeem");
        await safeAnswerCallback(ctx);
        await ctx.reply(
          `🎟 <b>${PROMPT_TAGS.redeem}</b>\n请直接发送你的兑换卡密（例如：<code>OW2C-10-A1B2C3D4</code>）：`,
          {
            parse_mode: "HTML",
            reply_markup: { force_reply: true, selective: true },
          }
        );
        return;
      }
    }

    if (action === "ad") {
      if (ctx.chat?.type !== "private") {
        await safeAnswerCallback(ctx, "管理面板仅限私聊使用", true);
        return;
      }
      const operatorId = Number(ctx.from?.id || 0);
      const sub = parts[1];

      if (sub === "home") {
        const admin = await fetchAdminMe(operatorId);
        const { text, keyboard } = buildAdminDashboardView(admin);
        await safeEditMessage(ctx, text, keyboard);
        await safeAnswerCallback(ctx);
        return;
      }

      if (sub === "settings") {
        const res = await relayInternalRequest(
          "GET",
          "/internal/admin/settings",
          { operatorId }
        );
        const { text, keyboard } = buildSystemSettingsView(res.data);
        await safeEditMessage(ctx, text, keyboard);
        await safeAnswerCallback(ctx);
        return;
      }

      if (
        sub === "st_bot" ||
        sub === "st_reg_tog" ||
        sub === "st_inv_tog" ||
        sub === "st_chk_tog"
      ) {
        const curRes = await relayInternalRequest(
          "GET",
          "/internal/admin/settings",
          { operatorId }
        );
        const cur: SystemSettingsDto = curRes.data;
        const patch: Record<string, any> = {};
        if (sub === "st_bot") {
          patch.botStatus =
            cur.botStatus === "maintenance" ? "normal" : "maintenance";
        } else if (sub === "st_reg_tog") {
          patch.registerRewardEnabled = !cur.registerRewardEnabled;
        } else if (sub === "st_inv_tog") {
          patch.inviteRewardEnabled = !cur.inviteRewardEnabled;
        } else if (sub === "st_chk_tog") {
          patch.checkinRewardEnabled = !cur.checkinRewardEnabled;
        }

        const updRes = await relayInternalRequest(
          "POST",
          "/internal/admin/settings",
          { operatorId, json: patch }
        );
        const { text, keyboard } = buildSystemSettingsView(updRes.data);
        await safeEditMessage(ctx, text, keyboard);
        await safeAnswerCallback(ctx, "设置已更新");
        return;
      }

      const promptMap: Record<string, { act: PendingAction; tip: string }> = {
        q_user: {
          act: "admin_user",
          tip: "请输入要查询的用户 <b>TG 数字 ID</b> 或 <b>@用户名</b>：",
        },
        q_add: {
          act: "admin_quota_add",
          tip: "请输入格式：<code>用户TG_ID 正整数次数 原因</code>\n例如：<code>123456789 5 活动补偿</code>",
        },
        q_deduct: {
          act: "admin_quota_deduct",
          tip: "请输入格式：<code>用户TG_ID 正整数次数 原因</code>\n例如：<code>123456789 2 误发回收</code>（剩余次数不可小于 0）",
        },
        q_vip: {
          act: "admin_vip",
          tip: "开通/续期请输入：<code>用户TG_ID 天数 原因</code>\n取消 VIP 请输入：<code>用户TG_ID revoke 原因</code>",
        },
        q_ban: {
          act: "admin_ban",
          tip: "封禁请输入：<code>用户TG_ID ban 原因</code>\n解封请输入：<code>用户TG_ID unban 原因</code>",
        },
        q_genkey: {
          act: "admin_genkey",
          tip: "请输入格式：<code>quota|vip_days 面额数值 [生成数量1-50]</code>\n例如：<code>quota 10 5</code> 或 <code>vip_days 30 3</code>",
        },
        q_viewkey: {
          act: "admin_viewkey",
          tip: "请输入要查询的<b>卡密编号</b>：",
        },
        q_voidkey: {
          act: "admin_voidkey",
          tip: "请输入格式：<code>卡密编号 作废原因</code>\n例如：<code>OW2C-10-A1B2C3D4 批次作废</code>",
        },
        q_addadmin: {
          act: "admin_add_admin",
          tip: "请输入格式：<code>新管理员TG_ID 备注名</code>\n例如：<code>987654321 客服小王</code>（初始为 0 权限）",
        },
        q_st_reg: {
          act: "admin_set_reg_quota",
          tip: "请输入<b>新注册赠送次数</b>（0 ~ 10000 的整数，例如 <code>3</code> 或 <code>0</code>）：",
        },
        q_st_inv: {
          act: "admin_set_inv_quota",
          tip: "请输入<b>邀请人赠送次数</b>（0 ~ 10000 的整数，例如 <code>1</code> 或 <code>0</code>）：",
        },
        q_st_chk: {
          act: "admin_set_chk_quota",
          tip: "请输入<b>每日签到赠送次数</b>（0 ~ 10000 的整数，例如 <code>1</code> 或 <code>0</code>）：",
        },
      };

      if (sub && promptMap[sub]) {
        const cfg = promptMap[sub];
        setPendingAction(operatorId, cfg.act);
        await safeAnswerCallback(ctx);
        await ctx.reply(`🛠 <b>${PROMPT_TAGS[cfg.act]}</b>\n${cfg.tip}`, {
          parse_mode: "HTML",
          reply_markup: { force_reply: true, selective: true },
        });
        return;
      }

      if (sub === "stats") {
        const res = await relayInternalRequest("GET", "/internal/admin/stats", {
          operatorId,
        });
        const s = res.data;
        const text = [
          `📊 <b>运营数据统计（${escapeHtml(s.today)}）</b>`,
          `━━━━━━━━━━━━━━━━━━`,
          `👥 累计用户总数：<b>${s.totalUsers}</b>`,
          `🆕 今日新增注册：<b>${s.todayNewUsers}</b>`,
          `📅 今日签到人数：<b>${s.todayCheckins}</b>`,
          `👑 当前有效 VIP：<b>${s.activeVips}</b>`,
          `🤖 今日 AI 锐评调用：<b>${s.todayPaidRoasts}</b>`,
          `🎟 未使用卡密库存：<b>${s.unusedRedeemCodes}</b>`,
        ].join("\n");
        const kb = new InlineKeyboard().text("⬅️ 返回控制台", "ad:home");
        await safeEditMessage(ctx, text, kb);
        await safeAnswerCallback(ctx);
        return;
      }

      if (sub === "admins") {
        const res = await relayInternalRequest(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const list: any[] = res.data.admins || [];
        const lines = [
          `👥 <b>管理员列表（仅超管可见）</b>`,
          `<i>超管不可修改或删除；普通管理员默认 0 权限，点击可编辑。</i>`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        const kb = new InlineKeyboard();
        for (const adm of list) {
          const isSuper = adm.role === "super_admin";
          lines.push(
            `• <code>${adm.tgId}</code> — <b>${escapeHtml(adm.remark || "未命名")}</b> [${isSuper ? "超管" : adm.isActive ? "启用" : "停用"}]（权限 ${adm.permissions.length} 项）`
          );
          if (!isSuper) {
            kb.text(
              `编辑 ${adm.remark || adm.tgId}`,
              `ad:edit:${adm.tgId}`
            ).row();
          }
        }
        kb.text("➕ 添加普通管理员", "ad:q_addadmin").text(
          "⬅️ 返回控制台",
          "ad:home"
        );
        await safeEditMessage(ctx, lines.join("\n"), kb);
        await safeAnswerCallback(ctx);
        return;
      }

      if (sub === "edit" && parts[2]) {
        const targetId = Number(parts[2]);
        const res = await relayInternalRequest(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const target = (res.data.admins || []).find(
          (a: any) => Number(a.tgId) === targetId
        );
        if (!target) {
          await safeAnswerCallback(ctx, "管理员不存在", true);
          return;
        }
        const { text, keyboard } = buildAdminDetailView(
          target,
          res.data.allPermissions || [],
          res.data.permissionLabels || {}
        );
        await safeEditMessage(ctx, text, keyboard);
        await safeAnswerCallback(ctx);
        return;
      }

      if (sub === "pt" && parts[2] && parts[3] !== undefined) {
        const targetId = Number(parts[2]);
        const permIdx = Number(parts[3]);
        const listRes = await relayInternalRequest(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const allPerms: string[] = listRes.data.allPermissions || [];
        const permCode = allPerms[permIdx];
        if (!permCode) {
          await safeAnswerCallback(ctx, "权限项无效", true);
          return;
        }
        await relayInternalRequest("POST", "/internal/admin/admins/permission", {
          operatorId,
          json: { targetTgId: targetId, permCode },
        });
        const afterRes = await relayInternalRequest(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const target = (afterRes.data.admins || []).find(
          (a: any) => Number(a.tgId) === targetId
        );
        if (target) {
          const { text, keyboard } = buildAdminDetailView(
            target,
            afterRes.data.allPermissions || [],
            afterRes.data.permissionLabels || {}
          );
          await safeEditMessage(ctx, text, keyboard);
        }
        await safeAnswerCallback(ctx, "权限已更新");
        return;
      }

      if (sub === "tog" && parts[2]) {
        const targetId = Number(parts[2]);
        const listRes = await relayInternalRequest(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const target = (listRes.data.admins || []).find(
          (a: any) => Number(a.tgId) === targetId
        );
        if (!target) {
          await safeAnswerCallback(ctx, "管理员不存在", true);
          return;
        }
        await relayInternalRequest("POST", "/internal/admin/admins/meta", {
          operatorId,
          json: { targetTgId: targetId, isActive: !target.isActive },
        });
        const afterRes = await relayInternalRequest(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const updated = (afterRes.data.admins || []).find(
          (a: any) => Number(a.tgId) === targetId
        );
        if (updated) {
          const { text, keyboard } = buildAdminDetailView(
            updated,
            afterRes.data.allPermissions || [],
            afterRes.data.permissionLabels || {}
          );
          await safeEditMessage(ctx, text, keyboard);
        }
        await safeAnswerCallback(ctx, "状态已切换");
        return;
      }

      if (sub === "del" && parts[2]) {
        const targetId = Number(parts[2]);
        await relayInternalRequest("DELETE", "/internal/admin/admins", {
          operatorId,
          params: { targetTgId: targetId },
        });
        await safeAnswerCallback(ctx, "已删除普通管理员");
        const listRes = await relayInternalRequest(
          "GET",
          "/internal/admin/admins",
          { operatorId }
        );
        const list: any[] = listRes.data.admins || [];
        const lines = [
          `👥 <b>管理员列表（仅超管可见）</b>`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        const kb = new InlineKeyboard();
        for (const adm of list) {
          const isSuper = adm.role === "super_admin";
          lines.push(
            `• <code>${adm.tgId}</code> — <b>${escapeHtml(adm.remark || "未命名")}</b> [${isSuper ? "超管" : adm.isActive ? "启用" : "停用"}]（权限 ${adm.permissions.length} 项）`
          );
          if (!isSuper) {
            kb.text(
              `编辑 ${adm.remark || adm.tgId}`,
              `ad:edit:${adm.tgId}`
            ).row();
          }
        }
        kb.text("➕ 添加普通管理员", "ad:q_addadmin").text(
          "⬅️ 返回控制台",
          "ad:home"
        );
        await safeEditMessage(ctx, lines.join("\n"), kb);
        return;
      }

      if (sub === "audit") {
        const page = Math.max(1, Number(parts[2]) || 1);
        const res = await relayInternalRequest(
          "GET",
          "/internal/admin/audit-logs",
          {
            operatorId,
            params: { page, pageSize: 6 },
          }
        );
        const d = res.data;
        const lines = [
          `📜 <b>操作审计日志（第 ${d.page}/${d.totalPages} 页，共 ${d.total} 条）</b>`,
          `━━━━━━━━━━━━━━━━━━`,
        ];
        for (const item of d.items || []) {
          lines.push(
            `• [<code>${escapeHtml(item.createdAt.slice(5, 16))}</code>] 操作者 <code>${item.operatorId}</code>(${escapeHtml(item.operatorRole)}) → <b>${escapeHtml(item.action)}</b> 目标 <code>${escapeHtml(item.targetId || "-")}</code>：${escapeHtml(item.detail || "-")}`
          );
        }
        const kb = new InlineKeyboard();
        if (d.page > 1) {
          kb.text("⬅️ 上一页", `ad:audit:${d.page - 1}`);
        }
        if (d.page < d.totalPages) {
          kb.text("下一页 ➡️", `ad:audit:${d.page + 1}`);
        }
        if (d.page > 1 || d.page < d.totalPages) kb.row();
        kb.text("⬅️ 返回控制台", "ad:home");
        await safeEditMessage(ctx, lines.join("\n"), kb);
        await safeAnswerCallback(ctx);
        return;
      }
    }

    if (action === "o" && parts.length >= 3) {
      const mode: CnGameMode = parts[1] === "l" ? "leisure" : "sport";
      const bnet = parts.slice(2).join(":");
      const { text, keyboard } = await buildCnOverviewView(bnet, mode, userId);
      await safeEditMessage(ctx, text, keyboard);
      await safeAnswerCallback(ctx);
      return;
    }

    if (action === "r" && parts.length >= 3) {
      const mode: CnGameMode = parts[1] === "l" ? "leisure" : "sport";
      const bnet = parts.slice(2).join(":");
      const cacheKey = `self:${mode}:${bnet.trim().toLowerCase()}`;
      await runPaidRoastFlow(ctx, {
        cacheKey,
        roastType: "self",
        quotaReason: "roast_self",
        gameMode: mode,
        bnet,
        startToast: "正在呼叫 DeepSeek 锐评你的赛季生涯...",
        loadingHtml: `🪞 正在整理 <b>${escapeHtml(sanitizeSafeText(bnet, "self-loading-bnet"))}</b> 的段位、赛季数据与常用英雄池，生成 DeepSeek 个人锐评中...`,
        errorFallbackHtml: "❌ DeepSeek 个人锐评生成失败，请稍后重试。",
        generator: () => generateDeepSeekPlayerReview(bnet, mode, userId),
      });
      return;
    }

    if (action === "h" && parts.length >= 3) {
      const mode: CnGameMode = parts[1] === "l" ? "leisure" : "sport";
      const bnet = parts.slice(2).join(":");
      const cacheKey = `mmr:${mode}:${bnet.trim().toLowerCase()}`;
      await runPaidRoastFlow(ctx, {
        cacheKey,
        roastType: "mmr",
        quotaReason: "roast_mmr",
        gameMode: mode,
        bnet,
        startToast: "正在反推你的隐性隐藏分与真实段位...",
        loadingHtml: `🔮 正在综合分析 <b>${escapeHtml(sanitizeSafeText(bnet, "mmr-loading-bnet"))}</b> 的明面段位、胜率背离度、实战效率与近期战绩走势，推演隐性段位中...`,
        errorFallbackHtml: "❌ DeepSeek 隐性段位评估生成失败，请稍后重试。",
        generator: () => generateDeepSeekHiddenMmrReview(bnet, mode, userId),
      });
      return;
    }

    if (action === "m" && parts.length >= 4) {
      const mode: CnGameMode = parts[1] === "l" ? "leisure" : "sport";
      const page = Math.max(1, Number(parts[2]) || 1);
      const bnet = parts.slice(3).join(":");
      const { text, keyboard } = await buildCnMatchListView(
        bnet,
        mode,
        page,
        userId
      );
      await safeEditMessage(ctx, text, keyboard);
      await safeAnswerCallback(ctx);
      return;
    }

    if (action === "d" && parts.length === 2) {
      const { text, keyboard } = await buildCnMatchDetailView(
        parts[1],
        userId
      );
      await safeEditMessage(ctx, text, keyboard);
      await safeAnswerCallback(ctx);
      return;
    }

    if (action === "a" && parts.length === 2) {
      const cached = matchCache.get(parts[1]);
      if (!cached || Date.now() > cached.expiresAt) {
        await safeAnswerCallback(
          ctx,
          "对局缓存已过期，请返回战绩列表重新打开详情。",
          true
        );
        return;
      }
      const cacheKey = `match:${cached.matchId}:${cached.bnet.trim().toLowerCase()}`;
      await runPaidRoastFlow(ctx, {
        cacheKey,
        roastType: "match",
        quotaReason: "roast_match",
        gameMode: cached.mode,
        bnet: cached.bnet,
        matchId: cached.matchId,
        startToast: "正在呼叫 DeepSeek 生成锐评...",
        loadingHtml: `🤖 正在分析 <b>${escapeHtml(sanitizeSafeText(cached.bnet, "loading-bnet"))}</b> 的本局数据并生成 DeepSeek 锐评，请稍候...`,
        errorFallbackHtml: "❌ DeepSeek 锐评生成失败，请稍后重试。",
        generator: () =>
          generateDeepSeekMatchReview(
            cached.bnet,
            cached.customerToken,
            cached.matchId,
            userId
          ),
      });
      return;
    }

    await safeAnswerCallback(ctx, "无效的操作按钮");
  } catch (err) {
    const msg =
      err instanceof DashenError
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
// 8. Vercel Serverless Function 入口
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


// ... existing code ...
async function fetchAdminMe(operatorId: number): Promise<AdminMeDto> {
  const res = await relayInternalRequest("GET", "/internal/admin/me", {
    operatorId,
  });
  return res.data;
}

/** 静默检查当前用户是否为启用中的管理员或超级管理员 */
async function tryGetActiveAdmin(operatorId: number): Promise<AdminMeDto | null> {
  if (!operatorId || operatorId <= 0) return null;
  try {
    return await fetchAdminMe(operatorId);
  } catch {
    return null;
  }
}

async function handlePendingAdminInput(
// ... existing code ...
  const keyboard = new InlineKeyboard()
    .text(checkinBtnLabel, "u:checkin")
    .text("🎟 兑换卡密", "u:redeem_prompt")
    .row()
    .text("🔄 刷新个人中心", "u:me");

  if (user.isAdmin) {
    keyboard.row().text("🛠 管理员控制台", "u:open_admin");
  }

  return { text, keyboard };
}

function buildAdminDashboardView(admin: AdminMeDto): {
// ... existing code ...
async function openUserCenter(ctx: Context, editExisting = false): Promise<void> {
  const { tgId, nickname, username } = getTgUserMeta(ctx);
  const res = await relayInternalRequest("POST", "/internal/user/ensure", {
    json: { tgId, nickname, username },
  });
  const user: UserProfileDto = res.data.user;
  const settings: SystemSettingsDto | undefined = res.data.settings;
  if (!user.isAdmin && tgId > 0) {
    const adminInfo = await tryGetActiveAdmin(tgId);
    if (adminInfo && adminInfo.isActive) {
      user.isAdmin = true;
      user.adminRole = adminInfo.role;
      user.roastUnlimited = true;
    }
  }
  const { text, keyboard } = buildUserCenterView(ctx, user, settings);

  if (editExisting) {
    await safeEditMessage(ctx, text, keyboard);
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
}
// ... existing code ...
    if (action === "u") {
      const sub = parts[1];
      if (sub === "me") {
        await openUserCenter(ctx, true);
        await safeAnswerCallback(ctx);
        return;
      }
      if (sub === "open_admin") {
        if (ctx.chat?.type !== "private") {
          await safeAnswerCallback(ctx, "管理控制台仅限私聊打开", true);
          return;
        }
        const operatorId = Number(ctx.from?.id || 0);
        const admin = await fetchAdminMe(operatorId);
        const { text, keyboard } = buildAdminDashboardView(admin);
        await safeEditMessage(ctx, text, keyboard);
        await safeAnswerCallback(ctx);
        return;
      }
      if (sub === "checkin") {
// ... existing code ...



