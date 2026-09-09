// 解语花 — 选定 Hana 模型直连适配
// utility:call-text 只解析全局工具模型，不能可靠执行插件传入的 providerId/modelId。
// 这里通过 provider:credentials 取得运行时凭据，再由宿主 network.fetch 直连用户选定的模型。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const MODELS_FILE = path.join(HANA_HOME, "models.json");
const HIDDEN_TAGS = ["think", "analysis", "reasoning", "thinking", "pulse"];
const REASONING_KEYS = ["reasoning_content", "reasoning", "reasoning_text", "thinking"];

function normalizeApi(value) {
  return String(value || "").trim().toLowerCase();
}

function trimSlashes(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isPlaceholderKey(value) {
  const text = String(value || "").trim();
  return !text || text === "local" || text.startsWith("hana-runtime-api-key:");
}

function isLocalProvider(providerId, baseUrl) {
  if (["ollama", "lm-studio", "lmstudio", "local"].includes(String(providerId || "").toLowerCase())) return true;
  try {
    return ["127.0.0.1", "localhost", "::1"].includes(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isMiniMaxModel(baseUrl, modelId) {
  let hostname = "";
  try { hostname = new URL(baseUrl).hostname.toLowerCase(); } catch {}
  return /(^|\.)minimaxi?\.(com|io)$/.test(hostname)
    && /^minimax-m(?:2(?:\.\d+)?|3)(?:-[a-z0-9._-]+)?$/i.test(String(modelId || "").trim());
}

function isDeepSeekModel(providerId, modelId) {
  return String(providerId || "").toLowerCase() === "deepseek"
    || /deepseek/i.test(String(modelId || ""));
}

function readCatalog(modelsPath = MODELS_FILE) {
  const catalog = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
  if (!catalog || typeof catalog !== "object" || !catalog.providers || typeof catalog.providers !== "object") {
    throw new Error("Hana 模型目录格式无效");
  }
  return catalog;
}

// 只读取模型定义，不读取任何密钥。
export function readSelectedTextModel(providerId, modelId, modelsPath = MODELS_FILE) {
  const pid = String(providerId || "").trim();
  const mid = String(modelId || "").trim();
  if (!pid || !mid) throw new Error("还没有选择模型，请到设置页选一个");
  let catalog;
  try {
    catalog = readCatalog(modelsPath);
  } catch (error) {
    throw new Error(`读取 Hana 模型目录失败: ${error.message}`);
  }
  const provider = catalog.providers[pid];
  if (!provider || typeof provider !== "object") throw new Error(`Hana 模型供应商不存在: ${pid}`);
  const entry = (Array.isArray(provider.models) ? provider.models : [])
    .find((item) => (typeof item === "string" ? item : item?.id) === mid);
  if (!entry) throw new Error(`Hana 模型不存在: ${pid}/${mid}`);
  const model = typeof entry === "object" ? entry : { id: entry };
  return {
    providerId: pid,
    modelId: mid,
    baseUrl: model.baseUrl || provider.baseUrl || provider.base_url || "",
    api: normalizeApi(model.api || provider.api || ""),
    reasoning: model.reasoning === true,
  };
}

export function buildTextEndpoint(baseUrl, api) {
  const base = trimSlashes(baseUrl);
  if (!base) throw new Error("模型供应商未配置 API 地址");
  const kind = normalizeApi(api);
  if (kind === "openai-responses") return /\/responses$/i.test(base) ? base : `${base}/responses`;
  if (kind === "openai-completions") return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  if (kind === "anthropic-messages") {
    if (/\/messages$/i.test(base)) return base;
    return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  }
  throw new Error(`当前模型接口暂不支持直连: ${api}`);
}

function appendContent(value, parts, state) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const part of value) appendContent(part, parts, state);
    return;
  }
  if (typeof value !== "object") return;
  for (const key of REASONING_KEYS) {
    if (value[key] !== undefined && value[key] !== null && String(value[key]).trim()) state.hadThinking = true;
  }
  const kind = String(value.type || value.kind || "").trim().toLowerCase();
  if (["analysis", "reasoning", "thinking"].includes(kind)) {
    state.hadThinking = true;
    return;
  }
  if (typeof value.text === "string") {
    parts.push(value.text);
    return;
  }
  if (typeof value.output_text === "string") {
    parts.push(value.output_text);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(value, "content")) appendContent(value.content, parts, state);
}

export function stripHiddenThinking(value) {
  let text = String(value || "");
  for (const tag of HIDDEN_TAGS) {
    text = text
      .replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, "gi"), "")
      .replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*$`, "gi"), "")
      .replace(new RegExp(`<\\s*\\/\\s*${tag}\\s*>`, "gi"), "");
  }
  return text.replace(/```\s*(?:think|analysis|reasoning)\b[\s\S]*?```/gi, "").trim();
}

function responseFinishReason(payload) {
  const candidates = [
    payload?.finish_reason,
    payload?.choices?.[0]?.finish_reason,
    payload?.stop_reason,
    payload?.response?.finish_reason,
    payload?.incomplete_details?.reason,
    payload?.response?.incomplete_details?.reason,
  ];
  return String(candidates.find((value) => String(value || "").trim()) || "").trim().toLowerCase();
}

export function isTruncatedFinishReason(reason) {
  return /^(?:length|max_tokens|max_output_tokens|token_limit|content_filter)$/.test(String(reason || "").trim().toLowerCase());
}

export function extractApiModelResponse(payload, api) {
  const kind = normalizeApi(api);
  const state = { hadThinking: false };
  const parts = [];
  if (kind === "openai-responses") {
    if (typeof payload?.output_text === "string") parts.push(payload.output_text);
    else appendContent(payload?.output, parts, state);
  } else if (kind === "anthropic-messages") {
    appendContent(payload?.content, parts, state);
  } else {
    appendContent(payload?.choices?.[0]?.message, parts, state);
  }
  const raw = parts.join("");
  if (HIDDEN_TAGS.some((tag) => new RegExp(`<\\s*${tag}\\b`, "i").test(raw))) state.hadThinking = true;
  return {
    text: stripHiddenThinking(raw),
    hadThinking: state.hadThinking,
    finishReason: responseFinishReason(payload),
  };
}

// 统一处理 ctx.model.sample / bus 返回的字符串或对象，避免思考内容漏到用户输入框。
export function extractModelText(result) {
  const state = { hadThinking: false };
  const parts = [];
  if (typeof result === "string") parts.push(result);
  else if (result && typeof result === "object") {
    for (const key of REASONING_KEYS) {
      if (result[key] !== undefined && result[key] !== null && String(result[key]).trim()) state.hadThinking = true;
    }
    const candidates = [
      result.text,
      result.content,
      result.output_text,
      result.output,
      result.message,
      result.choices?.[0]?.message,
      result.response?.choices?.[0]?.message,
      result.data?.choices?.[0]?.message,
      result.data,
    ];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue;
      const before = parts.length;
      appendContent(candidate, parts, state);
      if (parts.slice(before).join("").trim()) break;
    }
  }
  const raw = parts.join("");
  if (HIDDEN_TAGS.some((tag) => new RegExp(`<\\s*${tag}\\b`, "i").test(raw))) state.hadThinking = true;
  return {
    text: stripHiddenThinking(raw),
    hadThinking: state.hadThinking,
    finishReason: responseFinishReason(result),
  };
}

function buildRequest(model, messages, options = {}) {
  const api = normalizeApi(model.api);
  const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? Math.floor(options.maxTokens) : 1200;
  const temperature = Number.isFinite(options.temperature) ? options.temperature : undefined;
  const disableReasoning = options.disableReasoning !== false;
  const input = Array.isArray(messages) ? messages : [];
  const headers = {
    "Content-Type": "application/json",
    ...(model.headers && typeof model.headers === "object" ? model.headers : {}),
  };
  if (!isPlaceholderKey(model.apiKey)) {
    if (api === "anthropic-messages") {
      headers["x-api-key"] = model.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.Authorization = `Bearer ${model.apiKey}`;
    }
  }

  if (api === "openai-responses") {
    const body = { model: model.modelId, input, max_output_tokens: maxTokens, stream: false };
    if (temperature !== undefined) body.temperature = temperature;
    if (disableReasoning && model.reasoning) body.reasoning = { effort: "none" };
    return { url: buildTextEndpoint(model.baseUrl, api), headers, body };
  }
  if (api === "anthropic-messages") {
    const system = input.filter((m) => m?.role === "system").map((m) => String(m.content || "")).filter(Boolean).join("\n\n");
    const chatMessages = input
      .filter((m) => m?.role !== "system")
      .map((m) => ({ role: m?.role === "assistant" ? "assistant" : "user", content: m?.content ?? "" }));
    const body = { model: model.modelId, messages: chatMessages, max_tokens: maxTokens, stream: false };
    if (system) body.system = system;
    if (temperature !== undefined) body.temperature = temperature;
    return { url: buildTextEndpoint(model.baseUrl, api), headers, body };
  }

  const body = { model: model.modelId, messages: input, max_tokens: maxTokens, stream: false };
  if (temperature !== undefined) body.temperature = temperature;
  if (disableReasoning && model.reasoning && (isMiniMaxModel(model.baseUrl, model.modelId) || isDeepSeekModel(model.providerId, model.modelId))) {
    body.thinking = { type: "disabled" };
  }
  return { url: buildTextEndpoint(model.baseUrl, api), headers, body };
}

export async function callConfiguredTextModel({ bus, fetcher }, providerId, modelId, messages, options = {}) {
  const definition = readSelectedTextModel(providerId, modelId, options.modelsPath || MODELS_FILE);
  let runtime = {};
  if (bus && typeof bus.request === "function") {
    try {
      const result = await bus.request("provider:credentials", { providerId: definition.providerId }, { timeoutMs: options.timeoutMs || 30000 });
      if (result && typeof result === "object") runtime = result;
    } catch (error) {
      throw new Error(`无法读取 Hana 供应商凭据：${error?.message || "请确认 Hana 已配置该供应商"}`);
    }
  }
  const baseUrl = String(runtime.baseUrl || runtime.base_url || definition.baseUrl || "").trim();
  const apiKey = String(runtime.apiKey || runtime.api_key || "").trim();
  const local = isLocalProvider(definition.providerId, baseUrl);
  if (!baseUrl) throw new Error(`Hana 供应商没有可用的 API 地址：${definition.providerId}`);
  if (!local && (runtime.error || isPlaceholderKey(apiKey))) {
    throw new Error(`Hana 供应商没有可用凭据：${definition.providerId}，请先在 Hana 模型设置里完成配置`);
  }
  const model = {
    ...definition,
    baseUrl,
    api: normalizeApi(definition.api || runtime.api || "openai-completions"),
    apiKey: apiKey || (local ? "local" : ""),
    headers: runtime.headers && typeof runtime.headers === "object" ? runtime.headers : {},
  };
  const request = buildRequest(model, messages, options);
  const requestFetch = fetcher || globalThis.fetch;
  if (typeof requestFetch !== "function") throw new Error("当前环境没有可用的网络请求通道");
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await requestFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
      timeoutMs,
      maxResponseBytes: 2 * 1024 * 1024,
    });
    const raw = await response.text().catch(() => "");
    if (!response.ok) throw new Error(`模型返回错误（HTTP ${response.status}${raw ? `：${raw.replace(/\s+/g, " ").slice(0, 200)}` : ""}）`);
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error("模型响应不是合法 JSON"); }
    const extracted = extractApiModelResponse(payload, model.api);
    if (isTruncatedFinishReason(extracted.finishReason)) throw new Error("模型输出被截断了，再试一次");
    if (!extracted.text) {
      const error = new Error(extracted.hadThinking ? "模型没有交付可见正文，请稍后再试" : "模型未回复正文，请稍后再试");
      error.code = "LLM_EMPTY_RESPONSE";
      throw error;
    }
    return extracted.text;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`模型请求超时（${timeoutMs}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
