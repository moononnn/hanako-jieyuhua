// 解语花 — 模型调用模块
// 三档模型来源：agent（跟随助手当前模型）/ hana（从 Hana 已配置模型列表选）/ custom（自定义 API）
// agent 档由调用方用 ctx.model.sample() 执行；hana/custom 档在本模块走 HTTP（闲不住同款模式）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfig } from "./data.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const PROVIDERS_FILE = path.join(HANA_HOME, "added-models.yaml");
const PROVIDER_CATALOG_FILE = path.join(HANA_HOME, "provider-catalog.json");
const MODELS_CATALOG = path.join(HANA_HOME, "models.json");

// ─── API Key 混淆存储（XOR + base64，enc: 前缀，向后兼容明文） ───
const _OBF_SALT = Buffer.from("jiegehua-key-obfuscation-2026", "utf-8");

export function encryptKey(plain) {
  if (!plain) return "";
  const buf = Buffer.from(plain, "utf-8");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ _OBF_SALT[i % _OBF_SALT.length];
  }
  return "enc:" + out.toString("base64");
}

export function decryptKey(stored) {
  if (!stored) return "";
  if (!stored.startsWith("enc:")) return stored;
  const buf = Buffer.from(stored.slice(4), "base64");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ _OBF_SALT[i % _OBF_SALT.length];
  }
  return out.toString("utf-8");
}

// ─── 读取 Hana 已配置的供应商（provider-catalog.json 优先，回退 added-models.yaml） ───
export function loadProviderConfigs() {
  try {
    if (fs.existsSync(PROVIDER_CATALOG_FILE)) {
      const catalog = JSON.parse(fs.readFileSync(PROVIDER_CATALOG_FILE, "utf-8"));
      const providers = {};
      for (const [pid, info] of Object.entries(catalog.providers || {})) {
        providers[pid] = {
          api_key: info.api_key || "",
          base_url: info.base_url || "",
          api: info.api || "openai-completions",
          models: (info.models || []).filter((m) => typeof m === "string")
        };
      }
      return providers;
    }
    if (!fs.existsSync(PROVIDERS_FILE)) return {};
    const text = fs.readFileSync(PROVIDERS_FILE, "utf-8");
    const providers = {};
    let currentProvider = null;
    let baseIndent = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "providers:") { baseIndent = line.search(/\S/); break; }
    }
    const providerIndent = baseIndent + 2;
    const keyIndent = baseIndent + 4;
    const listIndent = baseIndent + 6;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = line.search(/\S/);
      if (indent === providerIndent && trimmed.endsWith(":") && !trimmed.startsWith("-")) {
        currentProvider = trimmed.slice(0, -1).trim();
        providers[currentProvider] = { models: [] };
        continue;
      }
      if (indent === keyIndent && currentProvider) {
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        let value = trimmed.slice(colonIdx + 1).trim();
        if (key === "models") continue;
        if (value === "") continue;
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        providers[currentProvider][key] = value;
      }
      if (indent === listIndent && currentProvider && trimmed.startsWith("- ")) {
        providers[currentProvider].models.push(trimmed.slice(2).trim());
      }
    }
    return providers;
  } catch (e) {
    console.error("[解语花] 读取供应商配置失败:", e.message);
    return {};
  }
}

// ─── 读取 models.json（模型目录） ───
export function loadModelsCatalog() {
  try {
    if (!fs.existsSync(MODELS_CATALOG)) return { providers: {} };
    return JSON.parse(fs.readFileSync(MODELS_CATALOG, "utf-8"));
  } catch (e) {
    console.error("[解语花] models.json 读取失败:", e.message);
    return { providers: {} };
  }
}

// ─── 完整供应商 + 模型列表（给设置页展示） ───
export function getAvailableModels() {
  const providerConfigs = loadProviderConfigs();
  const catalog = loadModelsCatalog();
  const result = [];
  for (const [pid, catalogProvider] of Object.entries(catalog.providers || {})) {
    const config = providerConfigs[pid] || {};
    const modelsList = [];
    for (const model of catalogProvider.models || []) {
      const modelId = typeof model === "string" ? model : model.id;
      const modelName = typeof model === "object" && model.name ? model.name : modelId;
      const contextWindow = typeof model === "object" && model.contextWindow
        ? `${Math.round(model.contextWindow / 1000)}K` : "";
      const reasoning = typeof model === "object" && !!model.reasoning;
      const hasKey = !!(config.api_key || config.apiKey);
      modelsList.push({ id: modelId, name: modelName, contextWindow, reasoning, available: hasKey });
    }
    result.push({
      id: pid,
      name: pid,
      baseUrl: config.base_url || config.baseUrl || catalogProvider.baseUrl || "",
      models: modelsList
    });
  }
  return result;
}

// ─── 解析模型档位，返回执行描述 ───
// 返回 { source, needSample }：needSample=true 表示应走 ctx.model.sample（agent 档）
export function resolveModelPlan(dataDir) {
  const cfg = getConfig(dataDir);
  const m = cfg.model;
  if (m.source === "agent") {
    return { source: "agent", needSample: true };
  }
  if (m.source === "custom") {
    if (!m.custom.baseUrl || !m.custom.apiKey || !m.custom.model) {
      throw new Error("自定义模型配置不完整，请到设置页补全地址、密钥和模型名");
    }
    return { source: "custom", needSample: false };
  }
  // hana 档
  if (!m.providerId || !m.modelId) {
    throw new Error("还没有选择模型，请到设置页选一个");
  }
  return { source: "hana", needSample: false, providerId: m.providerId, modelId: m.modelId };
}

// ─── 错误信息脱敏：上游错误体可能回显 API key（one-api 类网关 401 常见），回传前统一打码 ───
export function redactSecrets(text) {
  if (!text) return text || "";
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1***")
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi, "$1***")
    .replace(/("?api[_-]?key"?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi, "$1***");
}

// ─── 自定义 baseUrl 协议校验（防 SSRF：拒绝内网/文件协议，限长度） ───
export function validateBaseUrl(baseUrl) {
  const url = String(baseUrl || "").trim();
  if (!url) return "模型地址不能为空";
  if (url.length > 500) return "模型地址太长了";
  if (!/^https?:\/\//i.test(url)) return "模型地址需要以 http:// 或 https:// 开头";
  return null;
}

// ─── hana / custom 档的 HTTP 调用 ───
export async function callLLM(prompt, options = {}) {
  const { providerId, modelId, custom } = options;
  let baseUrl = "", apiKey = "", api = "openai-completions";

  if (custom) {
    baseUrl = custom.baseUrl || "";
    apiKey = decryptKey(custom.apiKey || "");
    api = custom.api || "openai-completions";
  } else {
    const providerConfigs = loadProviderConfigs();
    const config = providerConfigs[providerId];
    if (!config) throw new Error(`供应商 ${providerId} 未找到，请重新选择模型`);
    baseUrl = config.base_url || config.baseUrl || "";
    apiKey = config.api_key || config.apiKey || "";
    api = config.api || "openai-completions";
  }

  if (!baseUrl || !apiKey) throw new Error("模型配置不完整（缺少地址或密钥）");
  const urlErr = validateBaseUrl(baseUrl);
  if (urlErr) throw new Error(urlErr);

  let url, body;
  if (api === "openai-completions") {
    url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    body = {
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      temperature: options.temperature ?? 0.8,
      max_tokens: options.maxTokens ?? 600
    };
  } else if (api === "openai-responses") {
    // OpenAI 新版 Responses API（zen 网关等供应商用）
    url = `${baseUrl.replace(/\/+$/, "")}/responses`;
    body = {
      model: modelId,
      input: [{ role: "user", content: prompt }],
      max_output_tokens: options.maxTokens ?? 600,
      temperature: options.temperature ?? 0.8
    };
  } else if (api === "anthropic-messages") {
    url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
    body = {
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options.maxTokens ?? 600,
      temperature: options.temperature ?? 0.8
    };
  } else {
    throw new Error(`不支持的 API 协议: ${api}`);
  }

  const headers = {
    "Content-Type": "application/json",
    ...(api === "anthropic-messages"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${apiKey}` })
  };

  const ctrl = new AbortController();
  const timeoutTimer = setTimeout(() => ctrl.abort(), options.timeout || 30000);
  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`模型调用失败 (${response.status}): ${redactSecrets(errText).slice(0, 200)}`);
  }
  const data = await response.json();
  return extractResponseText(data, api);
}

// ─── 响应文本提取（按协议） ───
export function extractResponseText(data, api) {
  if (!data || typeof data !== "object") return "";
  if (api === "anthropic-messages") {
    return data.content
      ?.map((c) => c.text)
      .filter(Boolean)
      .join("") || "";
  }
  if (api === "openai-responses") {
    // output: [{ type: "message", content: [{ type: "output_text", text }] }]
    const out = data.output || [];
    let text = "";
    for (const item of out) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if ((c?.type === "output_text" || c?.type === "text") && typeof c.text === "string") {
            text += c.text;
          }
        }
      }
    }
    return text;
  }
  return data.choices?.[0]?.message?.content || "";
}

// ─── 统一入口：按配置生成推荐文本（JSON 数组字符串） ───
// sampleFn 为 agent 档时调用方传入的 ctx.model.sample
export async function generateSuggestions(dataDir, prompt, { sampleFn, maxTokens = 1500 } = {}) {
  const plan = resolveModelPlan(dataDir);
  if (plan.needSample) {
    if (!sampleFn) throw new Error("跟随助手模式缺少模型调用通道");
    const response = await sampleFn({
      messages: [{ role: "user", content: prompt }],
      maxTokens,
      temperature: 0.9
    });
    const text = typeof response === "string" ? response : (response?.text ?? response?.content ?? "");
    return typeof text === "string" ? text : "";
  }
  if (plan.source === "custom") {
    const cfg = getConfig(dataDir);
    return callLLM(prompt, {
      modelId: cfg.model.custom.model,
      custom: cfg.model.custom,
      maxTokens,
      temperature: 0.9
    });
  }
  return callLLM(prompt, {
    providerId: plan.providerId,
    modelId: plan.modelId,
    maxTokens,
    temperature: 0.9
  });
}

// ─── 截断 JSON 兜底提取（2026-08-14 加）：整体 JSON 与逐行解析都失败时，
// 从残缺文本里挖出完整的 "text":"..." 字段，尽量救回几条（单行截断场景） ───
function extractTruncatedItems(text) {
  const items = [];
  const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
    if (raw && raw.length <= 80) items.push({ text: raw, direction: "" });
  }
  return items;
}

// ─── 解析模型输出为 { text, direction } 数组（容错：去代码块/引号/逐行） ───
// 兼容对象数组、字符串数组、常见包裹对象，以及部分模型输出的 JSONL（每行一个对象）
export function parseSuggestions(raw, count) {
  if (!raw || typeof raw !== "string") return [];
  let text = raw.trim();
  // 去 ```json / ```jsonl ``` 代码块
  text = text.replace(/^```(?:jsonl?|JSONL?)?\s*/i, "").replace(/\s*```$/, "");

  const normalizeItem = (s) => {
    if (typeof s === "string") return { text: s.trim(), direction: "" };
    if (s && typeof s === "object" && typeof s.text === "string") {
      return {
        text: s.text.trim(),
        direction: typeof s.direction === "string" ? s.direction.trim() : ""
      };
    }
    return null;
  };
  const finish = (arr) => arr
    .map(normalizeItem)
    .filter((s) => s && s.text.length > 0 && s.text.length <= 80)
    .slice(0, count);

  // 优先解析标准 JSON；同时兼容 {suggestions:[...]} 等常见包裹
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return finish(parsed);
    if (parsed && typeof parsed === "object") {
      for (const key of ["suggestions", "replies", "items", "data"]) {
        if (Array.isArray(parsed[key])) return finish(parsed[key]);
      }
      const single = finish([parsed]);
      if (single.length) return single;
    }
  } catch {}

  // 逐行回退：结构化结果与普通文本分开收集；只要识别出 JSONL，就丢弃前缀说明和括号噪音
  const structuredItems = [];
  const plainItems = [];
  for (const rawLine of text.split(/\n+/)) {
    const line = rawLine
      .replace(/^\s*(?:[-*]\s+|\d+[.)、]\s*)/, "")
      .replace(/,\s*$/, "")
      .trim();
    if (!line || /^[\[\]{}]+$/.test(line)) continue;
    try {
      const parsedLine = JSON.parse(line);
      const item = normalizeItem(parsedLine);
      if (item && item.text.length > 0 && item.text.length <= 80) {
        structuredItems.push(item);
      } else if (line.length <= 80) {
        plainItems.push({ text: line, direction: "" });
      }
    } catch {
      // 解析失败的残缺结构行不展示；普通编号列表仍保留
      if (!/^[{\[]/.test(line) && line.length <= 80) {
        plainItems.push({ text: line, direction: "" });
      }
    }
  }
  const structured = structuredItems.length ? structuredItems : plainItems;
  if (structured.length) return structured.slice(0, count);
  // 单行截断兜底：整体 JSON 与逐行都失败时，从残缺文本挖 "text":"..." 字段（极端截断如 `[{"text` 挖不到就放弃）
  return extractTruncatedItems(text).slice(0, count);
}
