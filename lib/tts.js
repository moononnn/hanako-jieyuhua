// lib/tts.js — 解语花「朗读回复」：语音合成（多协议）+ 朗读文本提取 + Hana 语音模型候选
//
// 分享版设计（2026-08-18 定）：不能只认 MiniMax。
// 三档模型来源（对齐模型设置的老习惯）：
//   auto   — 自动：扫 Hana 已配置模型里「像语音合成」的，用第一个可用的
//   hana   — 手动：从同一个候选列表里挑（设置页下拉）
//   custom — 自定义：协议二选一（t2a=MiniMax / chat=OpenAI 兼容聊天如 MiMo）
//
// 实测过的两条路：
//   MiniMax：POST {base}/v1/t2a_v2?GroupId=xxx，返回 data.audio（mp3 base64）
//   MiMo：  POST {base}/chat/completions，文本放 assistant 消息，返回
//            choices[0].message.audio.data（wav base64，RIFF 头已验证）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProviderConfigs, loadModelsCatalog } from "./llm.js";
import { unprotectKey } from "./crypto.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

export const DEFAULT_TTS_BASE_URL = "https://api.minimaxi.com";
export const DEFAULT_TTS_MODEL = "speech-2.8-hd";

export function clampNum(value, min, max, fallback) {
  const n = typeof value === "string" ? parseFloat(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ─── 音色预设 ───
// t2a 协议音色（MiniMax 官方 voice_id，2026-08-18 对照官方音色目录核实，全部真实存在；
// 之前凭印象写的四川话等 ID 不存在会报 2054，已全部换成官方列表）
export const T2A_VOICES = [
  { id: "female-shaonv", name: "少女（清亮温柔）" },
  { id: "female-yujie", name: "御姐（成熟优雅）" },
  { id: "female-chengshu", name: "成熟女性（沉稳）" },
  { id: "female-tianmei", name: "甜美女性（甜软）" },
  { id: "male-qn-qingse", name: "青涩青年（少年感）" },
  { id: "male-qn-jingying", name: "精英青年（清爽干练）" },
  { id: "male-qn-badao", name: "霸道青年（强势）" },
  { id: "male-qn-daxuesheng", name: "青年大学生" },
  { id: "presenter_male", name: "男主持人（播音腔）" },
  { id: "presenter_female", name: "女主持人（播音腔）" },
  { id: "audiobook_male_1", name: "男声有声书" },
  { id: "audiobook_female_1", name: "女声有声书" },
  { id: "Chinese (Mandarin)_News_Anchor", name: "新闻女声（专业）" },
  { id: "Chinese (Mandarin)_Warm_Girl", name: "温暖少女" },
  { id: "Chinese (Mandarin)_Gentleman", name: "温润男声（儒雅）" },
  { id: "Chinese (Mandarin)_Southern_Young_Man", name: "南方小哥（带南方口音）" },
  { id: "Chinese (Mandarin)_Warm_Bestie", name: "温暖闺蜜（亲近）" },
  { id: "junlang_nanyou", name: "俊朗男友（苏感）" },
  { id: "diadia_xuemei", name: "嗲嗲学妹" },
  { id: "qiaopi_mengmei", name: "俏皮萌妹（活泼）" },
];

// chat 协议（MiMo V2.5 预置音色；可用自然语言描述音色风格）
export const CHAT_VOICES = [
  { id: "mimo_default", name: "默认音色" },
  { id: "冰糖", name: "冰糖（清甜）" },
  { id: "茉莉", name: "茉莉（温柔）" },
  { id: "苏打", name: "苏打（清爽）" },
  { id: "白桦", name: "白桦（沉稳）" },
];

export function voicesForProtocol(protocol) {
  return protocol === "t2a" ? T2A_VOICES : CHAT_VOICES;
}

// 助手有专属音色时优先使用；没配置就回退到模型协议默认音色。
export function resolveTtsVoiceId(tts, agentId) {
  const id = String(agentId || "").trim();
  const overrides = tts?.voiceByAgent;
  const override = id && overrides && typeof overrides === "object" ? overrides[id] : "";
  return typeof override === "string" && override.trim() ? override.trim() : "";
}

// Hana 回复里的这些标签属于界面隐藏的内部元信息，不能进入朗读。
// 兼容尖括号、方括号，以及模型输出的混搭闭合形式。
const HIDDEN_META_TAGS = [
  "think", "thinking", "analysis", "reasoning", "echo", "read",
  "pulse", "will", "sparks", "reflections", "vibe", "mood",
];

export function stripHiddenMetaBlocks(text) {
  let t = String(text || "");
  for (const tag of HIDDEN_META_TAGS) {
    const open = `(?:<${tag}\\s*>|\\[${tag}\\])`;
    const close = `(?:</${tag}\\s*>|\\[/${tag}\\])`;
    // 先清完整块；内层标签在 mood 之前处理，避免嵌套时过早遇到内层闭合。
    t = t.replace(new RegExp(`\\s*${open}[\\s\\S]*?${close}\\s*`, "gi"), " ");
  }
  // 开头或正文中出现未闭合的隐藏块时，后面的内容也不能冒险送去合成。
  const names = HIDDEN_META_TAGS.join("|");
  t = t.replace(new RegExp(`\\s*(?:<(?:${names})\\s*>|\\[(?:${names})\\])[\\s\\S]*$`, "gi"), " ");
  return t.trim();
}

// ─── 朗读前清理：去掉隐藏元信息、markdown 痕迹，折叠空白 ───
export function cleanReadableText(text) {
  let t = stripHiddenMetaBlocks(text);
  t = t.replace(/```[\s\S]*?```/g, " ");        // 代码块整段去掉
  t = t.replace(/`([^`\n]+)`/g, "$1");           // 行内代码只留文字
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");     // 粗体
  t = t.replace(/\*([^*\n]+)\*/g, "$1");         // 斜体
  t = t.replace(/__([^_\n]+)__/g, "$1");         // 下划线强调
  t = t.replace(/~~([^~\n]+)~~/g, "$1");         // 删除线
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // 链接只留文字
  t = t.replace(/^#{1,6}\s*/gm, "");             // 标题符号
  t = t.replace(/^>\s?/gm, "");                  // 引用符
  t = t.replace(/^[-*+]\s+/gm, "");              // 列表符号（保留内容）
  t = t.replace(/^\d+[.、]\s*/gm, "");           // 有序列表符号
  t = t.replace(/[|]/g, " ");                    // 表格竖线
  t = t.replace(/\r\n?/g, "\n");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n\s*\n+/g, "\n");
  t = t.split("\n").map((line) => line.trim()).join("\n");
  return t.trim();
}

// 只提取引号内的内容："" 「」 『』（酒馆 TTS 同款思路，方便只念台词）
export function extractQuotedText(text) {
  const re = /["“]([^"”]+)["”]|「([^」]+)」|『([^』]+)』/g;
  const parts = [];
  let m;
  while ((m = re.exec(text)) !== null && parts.length < 10) {
    const piece = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (piece) parts.push(piece);
  }
  return parts.join("，");
}

// 按 scope 提取朗读文本；quoted 模式没有引号内容时回退整条（matched=false，调用方可提示）
export function extractReadableText(raw, scope, maxLen) {
  const cleaned = cleanReadableText(raw);
  let text = cleaned;
  let matched = true;
  if (scope === "quoted") {
    const quoted = extractQuotedText(cleaned);
    if (quoted) {
      text = quoted;
    } else {
      text = cleaned;
      matched = false;
    }
  }
  const limit = Math.round(clampNum(maxLen, 20, 10000, 800));
  const truncated = text.length > limit;
  if (truncated) {
    text = text.slice(0, Math.max(1, limit - 1)) + "…";
  }
  return { text, matched, truncated };
}

// ─── Hana 语音模型候选扫描 ───
// 匹配规则：模型 id 含 tts / speech / voice / audio 关键字（如 mimo-v2.5-tts）
const TTS_MODEL_RE = /(tts|speech|voice|audio)/i;

export function isTtsModelId(modelId) {
  return typeof modelId === "string" && TTS_MODEL_RE.test(modelId);
}

// 纯函数（可测）：provider 配置 + 模型目录 → TTS 候选列表（含 key，仅后端用）
export function findTtsCandidatesFromProviders(providerConfigs, catalog) {
  const result = [];
  const seen = new Set();
  for (const [pid, catalogProvider] of Object.entries(catalog?.providers || {})) {
    const config = providerConfigs?.[pid] || {};
    const baseUrl = config.base_url || config.baseUrl || catalogProvider?.baseUrl || "";
    const api = config.api || catalogProvider?.api || "openai-completions";
    const apiKey = config.api_key || config.apiKey || "";
    for (const model of catalogProvider?.models || []) {
      const modelId = typeof model === "string" ? model : model?.id;
      if (!isTtsModelId(modelId)) continue;
      const key = `${pid}|${modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        providerId: pid,
        model: modelId,
        baseUrl,
        api,
        apiKey,
        available: !!apiKey,
      });
    }
  }
  return result;
}

// 读实际文件 → 候选（带 key，后端专用）
export function findTtsCandidates() {
  return findTtsCandidatesFromProviders(loadProviderConfigs(), loadModelsCatalog());
}

// 对外列表（不含 key，给设置页下拉）
export function listTtsCandidates() {
  return findTtsCandidates().map((c) => ({
    providerId: c.providerId,
    model: c.model,
    baseUrl: c.baseUrl,
    api: c.api,
    available: c.available,
  }));
}

// ─── 配置解析：tts 配置 → 可用的合成参数（auto/hana 从候选解析，custom 直接用） ───
// candidates 可注入（测试用）；不传则扫真实文件
export function resolveTtsConfig(cfg, candidates) {
  const tts = cfg || {};
  if (tts.source === "custom") {
    const protocol = tts.protocol === "t2a" ? "t2a" : "chat";
    return {
      source: "custom",
      protocol,
      apiKey: String(tts.apiKey || ""),
      groupId: String(tts.groupId || "").trim(),
      baseUrl: String(tts.baseUrl || "").trim(),
      model: String(tts.model || (protocol === "t2a" ? DEFAULT_TTS_MODEL : "")).trim(),
      voiceId: String(tts.voiceId || "").trim(),
      speed: clampNum(tts.speed, 0.5, 2, 1),
      vol: clampNum(tts.vol, 0.1, 2, 1),
      pitch: clampNum(tts.pitch, -12, 12, 0),
    };
  }

  const list = candidates || findTtsCandidates();
  let pick = null;
  if (tts.source === "hana") {
    pick = list.find((c) => c.providerId === tts.providerId && c.model === tts.model) || null;
  }
  if (!pick) pick = list.find((c) => c.available) || list[0] || null;
  if (!pick) {
    const err = new Error("Hana 里没找到可用的语音合成模型，去 Hana 模型设置加一个 TTS 模型，或者用自定义配置");
    err.code = "no_tts_candidate";
    throw err;
  }
  return {
    source: tts.source === "hana" ? "hana" : "auto",
    protocol: "chat", // Hana 模型目录里的 TTS 模型走 OpenAI 兼容聊天协议（MiMo 已验证）
    apiKey: String(pick.apiKey || ""),
    groupId: "",
    baseUrl: String(pick.baseUrl || ""),
    model: pick.model,
    voiceId: String(tts.voiceId || "").trim(),
    speed: clampNum(tts.speed, 0.5, 2, 1),
    vol: clampNum(tts.vol, 0.1, 2, 1),
    pitch: clampNum(tts.pitch, -12, 12, 0),
  };
}

function normalizeBaseUrl(baseUrl) {
  let base = String(baseUrl || "").trim();
  if (!base) throw new Error("接口地址没填");
  if (!/^https?:\/\//i.test(base)) throw new Error("接口地址不合法，要以 http(s):// 开头");
  return base.replace(/\/+$/, "");
}

// ─── t2a 协议（MiniMax）：文本 → mp3 base64 ───
// 2026-08-18 实机大坑：MiniMax 的 data.audio 是 **HEX 字符串**（文档示例变量名 audio_hex 印证），
// 按 base64 解码会得到周期性乱码 → 播放成电锯声。这里做 hex/base64 双兼容，统一输出 base64。
export async function t2aSynthesize(cfg, text) {
  const apiKey = await unprotectKey(String(cfg.apiKey || ""));
  const groupId = String(cfg.groupId || "").trim();
  if (!apiKey) throw new Error("还没配置 MiniMax API Key，去设置页填一下");
  if (!groupId) throw new Error("还没配置 MiniMax GroupId，去设置页填一下");
  const base = normalizeBaseUrl(cfg.baseUrl || DEFAULT_TTS_BASE_URL);

  const url = `${base}/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;
  const body = {
    model: String(cfg.model || DEFAULT_TTS_MODEL),
    text: String(text || "").slice(0, 10000),
    stream: false,
    voice_setting: {
      voice_id: cfg.voiceId || "female-shaonv",
      speed: clampNum(cfg.speed, 0.5, 2, 1),
      vol: clampNum(cfg.vol, 0.1, 2, 1),
      pitch: clampNum(cfg.pitch, -12, 12, 0),
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: "mp3",
      channel: 1,
    },
  };

  const resp = await postJson(url, { Authorization: `Bearer ${apiKey}` }, body);
  const data = await respJson(resp);
  if (!resp.ok) {
    throw new Error(pickApiError(data, `语音合成失败（HTTP ${resp.status}）`));
  }
  const audio = data?.data?.audio;
  if (!audio) {
    const br = data?.base_resp;
    const detail = br && (br.status_msg || br.status_code) ? `${br.status_msg || ""}${br.status_code ? ` (${br.status_code})` : ""}`.trim() : "";
    throw new Error(detail ? `语音合成没拿到音频：${detail}` : "语音合成返回异常，没有拿到音频");
  }
  // MiniMax 返回 HEX（如 49443304... = ID3/mp3）；全 hex 且偶数长度按 hex 解，否则按 base64 兜底
  const raw = String(audio);
  const isHex = raw.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(raw);
  const buf = isHex ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (!buf.length) throw new Error("语音合成返回的音频是空的");
  return { audio: buf.toString("base64"), format: "mp3" };
}

// ─── chat 协议（OpenAI 兼容聊天，MiMo V2.5 TTS 实测）：文本 → wav base64 ───
export async function chatSynthesize(cfg, text) {
  const apiKey = await unprotectKey(String(cfg.apiKey || ""));
  if (!apiKey) throw new Error("这个语音模型没配 Key，去 Hana 模型设置里检查一下");
  const base = normalizeBaseUrl(cfg.baseUrl);
  if (!cfg.model) throw new Error("语音模型名没填");
  const url = `${base}/chat/completions`;
  const body = {
    model: cfg.model,
    messages: [
      { role: "user", content: "自然、温柔的语气，语速正常。" },
      { role: "assistant", content: String(text || "").slice(0, 10000) },
    ],
  };
  // MiMo 实测：audio.voice 必填（缺了直接 500），空音色用默认
  body.audio = { voice: cfg.voiceId || "mimo_default" };

  const resp = await postJson(url, { Authorization: `Bearer ${apiKey}` }, body);
  const data = await respJson(resp);
  if (!resp.ok) {
    throw new Error(pickApiError(data, `语音合成失败（HTTP ${resp.status}）`));
  }
  const msg = data?.choices?.[0]?.message;
  const audio = msg?.audio?.data;
  if (audio) return { audio: String(audio), format: "wav" };
  // 部分实现把 base64 音频直接放 content（过一遍 base64 形状检查，避免把报错文本当音频）
  const content = typeof msg?.content === "string" ? msg.content : "";
  if (content.length >= 32 && /^[A-Za-z0-9+/=\s]+$/.test(content)) {
    return { audio: content.replace(/\s+/g, ""), format: "wav" };
  }
  throw new Error("语音合成没拿到音频：模型不可用或没有语音权限，试试别的模型");
}

// ─── 统一入口：按协议分派 ───
export async function synthesizeSpeech(cfg, text, candidates) {
  const resolved = resolveTtsConfig(cfg, candidates);
  if (resolved.protocol === "t2a") return t2aSynthesize(resolved, text);
  return chatSynthesize(resolved, text);
}

// ─── HTTP 小工具 ───
function postJson(url, headers, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
}

async function respJson(resp) {
  try {
    return await resp.json();
  } catch {
    return {};
  }
}

function pickApiError(data, fallback) {
  const candidates = [
    data?.base_resp?.status_msg,
    data?.message,
    data?.error?.message,
    data?.error,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c.slice(0, 200);
  }
  return fallback;
}
