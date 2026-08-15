// lib/zhujian.js — 解语花悬浮球：进程管理 + 本地代理
//
// 悬浮球（python/zhujian_app.py）不直接访问 Hana 插件 API，
// 所有请求打到本模块维护的本地代理端口（127.0.0.1:18903），
// 由代理在插件进程内执行与页面完全一致的业务逻辑（lib/send.js + 生成逻辑）。
// 端口避开闲不住风铃的 18902。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getConfig,
  loadData,
  saveData,
  withDataLock,
  createPending,
  getAskPending,
  listAskPending,
  markAskConsumed,
  dismissAskWithOlder,
  listAskSkips,
  clearAskSkips,
} from "./data.js";
import { readRecentMessages, readAllMessages, buildContextText, buildTitleContext, resolveTargetSession, agentDisplayName, listNamedSessions } from "./session.js";
import { generateSuggestions, parseSuggestions } from "./llm.js";
import { buildStyleLines, buildSuggestionPrompt, hasAiFlavor } from "../tools/suggest_replies.js";
import { claimAndSend, getSuggestionText } from "./send.js";
import { buildAskAnswerText, validateAskResponse } from "./ask.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_DIR = path.join(__dirname, "..", "python");
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const PROXY_PORT = Number(process.env.JIEGEHUA_BALL_PORT || 18903);
const TARGET_SESSION_LIMIT = 5;

const PYTHON_CANDIDATES = [
  "C:\\Python314\\python.exe",
  "C:\\Python313\\python.exe",
  "C:\\Python312\\python.exe",
  "python",
  "python3",
];

function detectPython() {
  for (const p of PYTHON_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return "python";
}

let appProcess = null;
let proxyServer = null;
let proxyToken = "";
let state = {
  running: false,
  startedAt: null,
  exitCode: null,
  error: null,
};

// ─────────────────────────────
//  本地代理（悬浮球 ↔ 插件业务）
// ─────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 64 * 1024) {
        resolve({});
        req.destroy();
        return;
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// 同一提问的重复点击在 Deferred resolve 完成前串行化，避免双击产生两条后台回传。
const askResponseLocks = new Map();

function hasProxyToken(req) {
  const provided = req.headers["x-jiegehua-token"];
  if (!proxyToken || typeof provided !== "string" || provided.length !== proxyToken.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(proxyToken));
  } catch {
    return false;
  }
}

export async function respondToAsk(dataDir, bus, { askId, choice, mode } = {}) {
  if (!askId || typeof askId !== "string") {
    return { ok: false, status: 400, error: "提问编号不完整" };
  }
  const active = askResponseLocks.get(askId);
  if (active) return active;

  const task = (async () => {
    const entry = getAskPending(dataDir, askId);
    if (!entry) return { ok: false, status: 400, error: "提问不存在或已失效" };
    if (entry.consumed) return { ok: false, status: 400, error: "这道题已经作答了" };

    const answer = validateAskResponse(entry, mode, choice);
    if (answer.error) return { ok: false, status: 400, error: answer.error };
    if (!entry.sessionPath) return { ok: false, status: 400, error: "找不到提问对应的会话" };
    if (!bus || typeof bus.request !== "function") {
      return { ok: false, status: 500, error: "消息通道不可用" };
    }

    const taskId = `ask-${askId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const resultText = buildAskAnswerText(entry, answer.choice, answer.mode);
    try {
      const reg = await bus.request("deferred:register", {
        taskId,
        sessionPath: entry.sessionPath,
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        meta: {
          type: "jiegehua",
          label: "提问回传",
          deliveryIntent: "trigger_parent_turn",
        },
      }, { timeoutMs: 10000 });
      if (!reg || reg.ok !== true) throw new Error(reg?.error || "deferred:register failed");
      const resolved = await bus.request("deferred:resolve", { taskId, result: resultText }, { timeoutMs: 10000 });
      if (resolved && resolved.ok === false) throw new Error(resolved.error || "deferred:resolve failed");
    } catch (err) {
      return { ok: false, status: 500, error: err?.message || "提问回传失败" };
    }

    const consumed = await markAskConsumed(dataDir, askId, {
      choice: answer.choice,
      mode: answer.mode,
    });
    if (!consumed) return { ok: false, status: 409, error: "这道题刚刚已经作答了" };
    return { ok: true, askId, mode: answer.mode, choice: answer.choice };
  })();

  askResponseLocks.set(askId, task);
  try {
    return await task;
  } finally {
    if (askResponseLocks.get(askId) === task) askResponseLocks.delete(askId);
  }
}

// ─── 固定的目标会话（null = 跟随最近） ───
function readPinnedTarget(dataDir) {
  try {
    const data = loadData(dataDir);
    const p = data.pinnedTarget;
    if (p && typeof p === "object" && typeof p.sessionPath === "string" && p.sessionPath) {
      return {
        agentId: String(p.agentId || ""),
        sessionPath: p.sessionPath,
        title: String(p.title || ""),
      };
    }
  } catch {}
  return null;
}

function setPinnedTarget(dataDir, pinned) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    data.pinnedTarget = pinned
      ? {
          agentId: String(pinned.agentId || ""),
          sessionPath: String(pinned.sessionPath || ""),
          title: String(pinned.title || ""),
        }
      : null;
    saveData(dataDir, data);
  });
}

// 生成目标选择：固定会话优先（文件失效则自动清除并回落），否则跟随最近对话
export async function resolveBallTarget(dataDir) {
  const pinned = readPinnedTarget(dataDir);
  if (!pinned) return null;
  try {
    if (fs.existsSync(pinned.sessionPath)) {
      return {
        agentId: pinned.agentId,
        sessionPath: pinned.sessionPath,
        sessionId: "",
        title: pinned.title,
        pinned: true,
      };
    }
  } catch {}
  // 钉住的会话已失效 → 清除钉住，下次自动跟随
  await setPinnedTarget(dataDir, null);
  return null;
}

async function targetPayload(dataDir, bus) {
  const pinned = await resolveBallTarget(dataDir);
  const target = pinned || resolveTargetSession();
  if (!target) return { ok: true, target: null, mode: "auto", pinned: null };
  let title = target.title || "";
  if (!title) {
    const sessions = await listNamedSessions(bus, 16);
    title = sessions.find((item) => path.normalize(item.sessionPath) === path.normalize(target.sessionPath))?.title || "";
  }
  return {
    ok: true,
    target: {
      agentId: target.agentId,
      name: agentDisplayName(target.agentId),
      title,
    },
    mode: pinned ? "pinned" : "auto",
    pinned: pinned ? { sessionPath: pinned.sessionPath, title: pinned.title || title } : null,
    undoAvailable: !!readLastRename(dataDir),
  };
}

// ─── 重命名标题：总结当前对话生成新标题，写回宿主并记录旧标题（供退回） ───

// 从会话路径推断 agentId（…/agents/{agentId}/sessions/xxx.jsonl）
function agentIdFromSessionPath(sessionPath) {
  try {
    return path.basename(path.dirname(path.dirname(sessionPath)));
  } catch {
    return "";
  }
}

// 读会话当前标题 + agentId（bus session:list 全量匹配，拿不到返回空）
async function sessionInfoOf(bus, sessionPath) {
  try {
    if (!bus || typeof bus.request !== "function") return { title: "", agentId: "" };
    const result = await bus.request("session:list", {});
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    const hit = sessions.find((s) => s && s.path && path.normalize(s.path) === path.normalize(sessionPath));
    return {
      title: String(hit?.title || "").trim(),
      agentId: String(hit?.agentId || "") || agentIdFromSessionPath(sessionPath),
    };
  } catch {
    return { title: "", agentId: agentIdFromSessionPath(sessionPath) };
  }
}

// 标题缓存：悬浮球每 1.5s 轮询 /ask/pending，避免每次都全量拉会话列表。
const sessionTitleCache = new Map(); // sessionPath -> { title, agentName, ts }
const SESSION_TITLE_TTL_MS = 10_000;

async function sessionTitleCached(bus, sessionPath) {
  if (!sessionPath) return { title: "", agentName: "" };
  const hit = sessionTitleCache.get(sessionPath);
  if (hit && Date.now() - hit.ts < SESSION_TITLE_TTL_MS) {
    return { title: hit.title, agentName: hit.agentName };
  }
  const info = await sessionInfoOf(bus, sessionPath);
  const value = {
    title: info.title,
    agentName: agentDisplayName(info.agentId),
    ts: Date.now(),
  };
  sessionTitleCache.set(sessionPath, value);
  if (sessionTitleCache.size > 50) {
    for (const [key, item] of sessionTitleCache) {
      if (Date.now() - item.ts >= SESSION_TITLE_TTL_MS) sessionTitleCache.delete(key);
    }
  }
  return { title: value.title, agentName: value.agentName };
}

// 消费隐式跳过队列：observer 检测到用户直接对话后登记，这里静默作废提问。
// 不回传、不唤醒、不产生任何消息——用户无视弹窗继续聊天时，
// 用户的新消息本身就是驱动助手的信号，回传纯属多余（还可能把「跳过」
// 语义漏进助手回复）。跨窗口场景下提问会话的挂起回合交给宿主超时收尾。
// 失败保留在队列里，下一轮轮询重试；不阻塞 /ask/pending 响应。
let askDrainInFlight = false;

export async function drainAskSkips(dataDir) {
  if (askDrainInFlight) return;
  askDrainInFlight = true;
  try {
    const queue = listAskSkips(dataDir);
    if (!queue.length) return;
    const done = [];
    for (const askId of queue) {
      try {
        const entry = getAskPending(dataDir, askId);
        if (!entry || entry.consumed) {
          done.push(askId);
          continue;
        }
        const ok = await markAskConsumed(dataDir, askId, { mode: "skip", choice: "" });
        if (ok) done.push(askId);
      } catch {
        // 单条失败不影响其他；下轮轮询再试
      }
    }
    if (done.length) await clearAskSkips(dataDir, done);
  } catch {
    // 队列消费整体失败时保留，下轮再试
  } finally {
    askDrainInFlight = false;
  }
}

// 标题输出清洗：去代码块/首尾引号/结尾标点/空白，限 30 字；空返回 null
export function cleanTitleOutput(raw) {
  if (typeof raw !== "string") return null;
  let t = raw.trim();
  t = t.replace(/^```(?:json|text)?\s*/i, "").replace(/\s*```$/, "");
  // 循环剥成对包裹引号（「」""『』《》 等）
  for (let i = 0; i < 3; i++) {
    t = t.replace(/^(["'“”‘’「」『』《》])(.*)\1$/, "$2");
  }
  // 去结尾标点（标题不带句号）
  t = t.replace(/[。．.，,；;：:！!？?\s]+$/, "");
  // 去剩余孤立引号（半包裹残留；标题里本就不需要引号）
  t = t.replace(/["'“”‘’「」『』《》()（）【】]/g, "");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.slice(0, 30);
}

// 对话主要语言检测：ASCII 字母明显多于汉字 → 英文；否则默认中文
// 标题语言由规则锁定后写进 prompt（让模型执行而不是判断，确定性更高）
export function detectConversationLang(contextText) {
  if (!contextText || typeof contextText !== "string") return "zh";
  const cjk = (contextText.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const ascii = (contextText.match(/[A-Za-z]/g) || []).length;
  return ascii > cjk * 2 ? "en" : "zh";
}

// 标题总结 prompt：概括整段对话主题，参考宿主官方标题生成器的风格（极短/无标点/语言跟随）
export function buildTitlePrompt(contextText) {
  const lang = detectConversationLang(contextText);
  const langLine =
    lang === "en"
      ? "2. 这次对话主要是英文，标题必须用英文输出，不要用中文"
      : "2. 这次对话主要是中文，标题必须用中文输出";
  return [
    "你是对话标题生成器。根据下面整段对话，用一句极短的话概括这段对话的主题。",
    "规则：",
    "1. 标题约 10 个字（中文）或 5 个单词（英文），保持极短",
    langLine,
    "3. 概括整段对话在做的事、聊的主题，不要只盯着第一句话",
    "4. 不要加引号、句号或其他标点",
    "5. 直接输出标题，不要解释",
    "对话：",
    contextText || "（对话内容不可用）",
    "输出：",
  ].join("\n");
}

// 总结目标会话 → 新标题。返回 { ok, title, fallback }；fallback=true 表示走了兜底
export async function summarizeSessionTitle(dataDir, modelSample, sessionPath) {
  const messages = readAllMessages(sessionPath);
  const contextText = buildTitleContext(messages);
  let title = null;
  let fallback = false;
  try {
    const sampleFn = (opts) => {
      if (!modelSample) return Promise.reject(new Error("当前会话模型不可用"));
      return modelSample(opts);
    };
    const raw = await generateSuggestions(dataDir, buildTitlePrompt(contextText), { sampleFn, maxTokens: 300 });
    title = cleanTitleOutput(raw);
  } catch (err) {
    console.error("[解语花] 标题生成失败:", err?.message || err);
  }
  if (!title) {
    // 兜底：最近一条用户消息前 30 字（宿主官方同款思路）
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) title = cleanTitleOutput(lastUser.content) || null;
    fallback = true;
  }
  return { ok: !!title, title, fallback };
}

// 重命名目标：body.sessionPath 显式指定 → 固定会话 → 最近活跃
export async function resolveRenameTarget(dataDir, body) {
  if (body && typeof body.sessionPath === "string" && body.sessionPath) {
    return { sessionPath: body.sessionPath, agentId: agentIdFromSessionPath(body.sessionPath) };
  }
  const pinned = await resolveBallTarget(dataDir);
  if (pinned) {
    return { sessionPath: pinned.sessionPath, agentId: pinned.agentId || agentIdFromSessionPath(pinned.sessionPath) };
  }
  const target = resolveTargetSession();
  if (!target) return null;
  return { sessionPath: target.sessionPath, agentId: target.agentId || agentIdFromSessionPath(target.sessionPath) };
}

// ─── 退回记录读写（data.json 持久化，重启后仍可退一次） ───
function readLastRename(dataDir) {
  return loadData(dataDir).lastRename || null;
}

function writeLastRename(dataDir, rec) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    data.lastRename = rec;
    saveData(dataDir, data);
  });
}

function clearLastRename(dataDir) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    data.lastRename = null;
    saveData(dataDir, data);
  });
}

// ─── 生成推荐（与卡片工具同一套 prompt 逻辑） ───
async function generateForBall(dataDir, modelSample) {
  const cfg = getConfig(dataDir);
  const pinnedTarget = await resolveBallTarget(dataDir);
  const target = pinnedTarget || resolveTargetSession();

  // 1. 读最近对话（跟随最活跃会话）
  let contextText = "";
  let sessionId = "";
  let sessionPath = "";
  if (target) {
    sessionPath = target.sessionPath;
    sessionId = target.sessionId;
    const messages = readRecentMessages(sessionPath, 6);
    contextText = buildContextText(messages);
  }

  // 2. 构建 prompt（复用卡片工具的 buildSuggestionPrompt）
  const prompt = buildSuggestionPrompt({
    count: cfg.count,
    styles: cfg.styles,
    selected: cfg.selectedByCount,
    contextText,
    hint: "",
  });

  // 3. 调模型
  const sampleFn = (opts) => {
    if (!modelSample) return Promise.reject(new Error("当前会话模型不可用"));
    return modelSample(opts);
  };
  const raw = await generateSuggestions(dataDir, prompt, { sampleFn });

  // 4. 解析 + 八股过滤 + 存 pending + 写缓存
  // （与卡片同一套杀八股：过滤命中正则的条目，宁缺毋滥；悬浮球手动点刷新，不重试）
  const items = parseSuggestions(raw, cfg.count).filter((it) => !hasAiFlavor(it.text));
  if (!items.length) {
    return { ok: false, error: "没能生成合适的推荐，可以再点一次试试" };
  }
  for (let i = 0; i < items.length; i++) {
    if (!items[i].direction && cfg.styles && cfg.styles[i]) {
      const s = cfg.styles[i];
      items[i].direction = typeof s === "object" ? (s.name || "") : String(s);
    }
  }

  const { rid, entry } = await createPending(dataDir, { items, sessionId, sessionPath });

  // 缓存覆盖（面板秒开用）
  await withDataLock(() => {
    const data = loadData(dataDir);
    data.ballCache = {
      items,
      rid,
      ts: Date.now(),
      agentId: target ? target.agentId : "",
      sessionPath: sessionPath || "",
    };
    saveData(dataDir, data);
  });

  return {
    ok: true,
    items,
    rid,
    target: target ? { agentId: target.agentId, name: agentDisplayName(target.agentId) } : null,
    mode: pinnedTarget ? "pinned" : "auto",
    fromCache: false,
  };
}

// ─── 读缓存（面板先显示） ───
function cachedPayload(dataDir) {
  try {
    const data = loadData(dataDir);
    const cache = data.ballCache;
    if (!cache || !Array.isArray(cache.items) || !cache.items.length) {
      return { ok: true, cached: null };
    }
    // 缓存秒开路径也要带 target，否则面板打开时标签永远停在「读取中」
    const target = cache.agentId ? { agentId: cache.agentId, name: agentDisplayName(cache.agentId) } : null;
    return { ok: true, cached: { items: cache.items, rid: cache.rid || "", ts: cache.ts || 0, target } };
  } catch {
    return { ok: true, cached: null };
  }
}

function startProxy(ctx) {
  if (proxyServer) return;
  proxyToken = crypto.randomBytes(32).toString("hex");
  const dataDir = ctx.dataDir;
  const modelSample = ctx.model?.sample ? (opts) => ctx.model.sample(opts) : null;
  const bus = ctx.bus || ctx._bus;

  proxyServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Jiegehua-Token");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      const url = req.url || "/";
      if (req.method === "GET" && url === "/health") {
        return sendJson(res, 200, { ok: true, running: !!appProcess });
      }
      if (req.method === "GET" && url === "/target") {
        return sendJson(res, 200, await targetPayload(dataDir, bus));
      }
      if (req.method === "GET" && url === "/sessions") {
        const pinned = await resolveBallTarget(dataDir);
        return sendJson(res, 200, {
          ok: true,
          sessions: await listNamedSessions(bus, TARGET_SESSION_LIMIT),
          mode: pinned ? "pinned" : "auto",
          pinned: pinned ? { sessionPath: pinned.sessionPath, title: pinned.title || "" } : null,
        });
      }
      if (req.method === "POST" && url === "/pin") {
        const body = await readBody(req);
        const sessionPath = typeof body.sessionPath === "string" && body.sessionPath ? body.sessionPath : "";
        if (!sessionPath) {
          await setPinnedTarget(dataDir, null);
          return sendJson(res, 200, { ok: true, mode: "auto" });
        }
        await setPinnedTarget(dataDir, {
          agentId: typeof body.agentId === "string" ? body.agentId : "",
          sessionPath,
          title: typeof body.title === "string" ? body.title : "",
        });
        return sendJson(res, 200, { ok: true, mode: "pinned" });
      }
      if (req.method === "GET" && url === "/cache") {
        return sendJson(res, 200, cachedPayload(dataDir));
      }
      if (url === "/ask/pending" || url === "/ask/respond" || url === "/ask/dismiss") {
        if (!hasProxyToken(req)) {
          return sendJson(res, 403, { ok: false, error: "提问面板通道未授权" });
        }
      }
      if (req.method === "GET" && url === "/ask/pending") {
        // 消费隐式跳过队列（不阻塞响应）；标题缓存后附带每条提问的归属窗口
        drainAskSkips(dataDir).catch(() => {});
        const pending = listAskPending(dataDir);
        const enriched = [];
        for (const entry of pending) {
          const info = await sessionTitleCached(bus, entry.sessionPath);
          enriched.push({ ...entry, sessionTitle: info.title, agentName: info.agentName });
        }
        return sendJson(res, 200, { ok: true, pending: enriched });
      }
      if (req.method === "POST" && url === "/ask/respond") {
        const body = await readBody(req);
        const result = await respondToAsk(dataDir, bus, {
          askId: body.askId,
          choice: body.choice,
          mode: body.mode,
        });
        return sendJson(res, result.status || (result.ok ? 200 : 400), result);
      }
      if (req.method === "POST" && url === "/ask/dismiss") {
        // 用户折叠提问 = 主动放弃：静默作废（不回传不唤醒），不再打扰；
        // 比当前题更旧的堆积题也一起作废（旧题用户从未看到，留着只会弹了又弹）
        const body = await readBody(req);
        const askId = typeof body.askId === "string" ? body.askId : "";
        if (!askId) return sendJson(res, 400, { ok: false, error: "提问编号不完整" });
        const result = await dismissAskWithOlder(dataDir, askId);
        return sendJson(res, result.ok ? 200 : 400, result.ok ? { ok: true, askId, count: result.count } : { ok: false, error: "提问不存在或已作答" });
      }
      if (req.method === "GET" && url === "/suggest") {
        const result = await generateForBall(dataDir, modelSample);
        return sendJson(res, result.ok ? 200 : 500, result);
      }
      if (req.method === "POST" && url === "/apply") {
        const body = await readBody(req);
        const result = await claimAndSend(dataDir, { rid: body.rid, index: body.index }, bus);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && url === "/copy") {
        const body = await readBody(req);
        const result = getSuggestionText(dataDir, { rid: body.rid, index: body.index });
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && url === "/rename") {
        const body = await readBody(req);
        const target = await resolveRenameTarget(dataDir, body);
        if (!target) return sendJson(res, 400, { ok: false, error: "没有找到可操作的会话" });
        const sessionPath = target.sessionPath;
        if (!fs.existsSync(sessionPath)) {
          return sendJson(res, 400, { ok: false, error: "会话文件不存在，可能已归档或删除" });
        }
        const info = await sessionInfoOf(bus, sessionPath);
        const oldTitle = info.title;
        const { ok: genOk, title, fallback } = await summarizeSessionTitle(dataDir, modelSample, sessionPath);
        if (!genOk || !title) {
          return sendJson(res, 500, { ok: false, error: "标题生成失败，再试一次" });
        }
        const update = await bus.request("session:update", { sessionPath, title });
        if (!update || update.ok !== true) {
          return sendJson(res, 500, { ok: false, error: "宿主拒绝了标题更新，看看 Hana 还正常不" });
        }
        await writeLastRename(dataDir, {
          sessionPath,
          agentId: info.agentId || target.agentId || "",
          oldTitle,
          newTitle: title,
          ts: Date.now(),
        });
        return sendJson(res, 200, {
          ok: true,
          title,
          oldTitle,
          fallback: !!fallback,
          sessionPath,
          agentId: info.agentId || target.agentId || "",
          agentName: agentDisplayName(info.agentId || target.agentId),
        });
      }
      if (req.method === "POST" && url === "/rename/undo") {
        const rec = readLastRename(dataDir);
        if (!rec || !rec.sessionPath) {
          return sendJson(res, 400, { ok: false, error: "没有可退回的记录" });
        }
        if (!fs.existsSync(rec.sessionPath)) {
          await clearLastRename(dataDir);
          return sendJson(res, 400, { ok: false, error: "原会话文件已不存在，无法退回" });
        }
        const update = await bus.request("session:update", { sessionPath: rec.sessionPath, title: rec.oldTitle || "" });
        if (!update || update.ok !== true) {
          return sendJson(res, 500, { ok: false, error: "宿主拒绝了退回操作，看看 Hana 还正常不" });
        }
        await clearLastRename(dataDir);
        return sendJson(res, 200, {
          ok: true,
          restoredTitle: rec.oldTitle || "",
          sessionPath: rec.sessionPath,
          agentId: rec.agentId || "",
          agentName: agentDisplayName(rec.agentId),
        });
      }
      if (req.method === "POST" && url === "/action") {
        const body = await readBody(req);
        const action = body.action === "send" ? "send" : body.action === "copy" ? "copy" : null;
        if (!action) return sendJson(res, 400, { ok: false, error: "无效的 action" });
        const { setConfig } = await import("./data.js");
        await setConfig(dataDir, { action });
        return sendJson(res, 200, { ok: true, message: "已切换" });
      }
      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      console.error("[解语花] 本地代理错误:", e?.message || e);
      return sendJson(res, 500, { ok: false, error: "内部错误" });
    }
  });
  proxyServer.on("error", (e) => {
    console.error("[解语花] 本地代理端口 " + PROXY_PORT + " 异常:", e?.message || e);
    proxyServer = null;
  });
  proxyServer.listen(PROXY_PORT, "127.0.0.1");
}

// ─────────────────────────────
//  悬浮球进程管理
// ─────────────────────────────
export function startZhujian(ctx) {
  if (appProcess) return { ok: true, message: "已在运行" };
  const python = detectPython();
  const script = path.join(PY_DIR, "zhujian_app.py");
  if (!fs.existsSync(script)) {
    return { ok: false, error: "zhujian_app.py 不存在" };
  }

  startProxy(ctx);

  const env = { ...process.env };
  env.JIEGEHUA_API = `http://127.0.0.1:${PROXY_PORT}`;
  env.JIEGEHUA_API_TOKEN = proxyToken;
  env.HANA_HOME = HANA_HOME;
  env.PYTHONDONTWRITEBYTECODE = "1";

  try {
    appProcess = spawn(python, [script], {
      cwd: PY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
  } catch (e) {
    state.error = e?.message || String(e);
    return { ok: false, error: state.error };
  }

  appProcess.stdout?.on("data", (d) => {
    const s = d.toString().trim();
    if (s) console.log("[解语花] " + s);
  });
  appProcess.stderr?.on("data", (d) => {
    const s = d.toString().trim();
    if (s) console.warn("[解语花] " + s);
  });
  appProcess.on("exit", (code) => {
    console.log("[解语花] 进程退出, code:", code);
    appProcess = null;
    state.running = false;
    state.exitCode = code;
  });
  appProcess.on("error", (err) => {
    console.error("[解语花] 启动失败:", err.message);
    appProcess = null;
    state.running = false;
    state.error = err.message;
  });

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.exitCode = null;
  state.error = null;
  return { ok: true, message: "已启动" };
}

export function stopZhujian() {
  if (!appProcess) return { ok: true, message: "未在运行" };
  try {
    appProcess.kill();
  } catch (e) {
    console.error("[解语花] 停止失败:", e?.message || e);
  }
  appProcess = null;
  state.running = false;
  return { ok: true, message: "已停止" };
}

export function getZhujianState() {
  return {
    ok: true,
    running: !!appProcess,
    startedAt: state.startedAt,
    exitCode: state.exitCode,
    error: state.error,
    python: detectPython(),
    pyQtOk: null, // 由 checkZhujianDeps 填充
  };
}

// ─────────────────────────────
//  依赖检查（Python + PyQt6 + QtSvg，30 秒缓存）
// ─────────────────────────────
let _depsCache = null;
let _depsCacheTime = 0;

export async function checkZhujianDeps() {
  const now = Date.now();
  if (_depsCache && now - _depsCacheTime < 30_000) {
    return _depsCache;
  }
  const python = detectPython();
  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, ["-c", "import PyQt6; import PyQt6.QtSvg"], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, python, pyQtOk: false, error: "无法启动 Python" });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ ok: false, python, pyQtOk: false, error: "依赖检查超时" });
    }, 15000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, python, pyQtOk: false, error: "Python 不存在" });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const pyQtOk = code === 0;
      resolve({ ok: pyQtOk, python, pyQtOk, error: pyQtOk ? null : "缺少 PyQt6（pip install PyQt6）" });
    });
  });
  _depsCache = result;
  _depsCacheTime = now;
  return result;
}
