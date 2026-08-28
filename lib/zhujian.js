// 文件预算豁免：悬浮球生命周期、本地代理、目标状态与统一发送入口强耦合，拆分会放大跨线程和端口状态竞态。
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
  beginAskDelivery,
  markAskDeliveryRegistered,
  completeAskDelivery,
  markAskConsumed,
  dismissAskWithOlder,
  listAskSkips,
  clearAskSkips,
  createBranchRef,
  listBranchRefs,
  consumeResume,
  listResumeNotices,
  listResumePending,
  pruneResumePending,
  setConfig,
} from "./data.js";
import { readRecentMessages, readRecentAssistantMessages, selectRecentAssistantMessage, readAllMessages, buildContextText, buildTitleContext, resolveTargetSession, agentDisplayName, agentIdFromSessionPath, isSessionPathForAgent, listNamedSessions, lastTurnInputEntryId, readBranchHistory } from "./session.js";
import { forkBranch, friendlyForkError } from "./fork.js";
import { generateSuggestions, parseSuggestions, redactSecrets } from "./llm.js";
import { extractReadableText, resolveTtsVoiceId, stripHiddenMetaBlocks, synthesizeSpeech } from "./tts.js";
import { listFavorites, saveFavorite } from "./favorites.js";
import { stopPlaying } from "./play.js";
import { buildStyleLines, buildSuggestionPrompt, hasAiFlavor } from "../tools/suggest_replies.js";
import { claimAndSend, getSuggestionText } from "./send.js";
import { buildAskAnswerText, validateAskResponse } from "./ask.js";
import { RESUME_TEXT, sessionIdFromPath } from "./resume.js";

// 总线请求超时兜底（坑 56 铁律：请求不能永久挂起，否则「发送中」永远转圈）
const RESUME_SEND_TIMEOUT_MS = 6000;
function withTimeoutBus(promiseLike, timeoutMs) {
  let timer;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("TOO_SLOW")), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promiseLike), timed]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_DIR = path.join(__dirname, "..", "python");
const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const PROXY_PORT = Number(process.env.JIEGEHUA_BALL_PORT || 18903);
const PYTHON_STATE_PATH = path.join(HANA_HOME, "data", "jiegehua", "zhujian-state.json");
const TARGET_SESSION_LIMIT = 5;
const FUSION_STATUS_BUS_TOPIC = "work-visit:fusion:v1";
const FUSION_STATUS_TIMEOUT_MS = 1000;

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

export function shouldBlockOriginalStart(fusionStatus, { allowDuringRestore = false } = {}) {
  if (allowDuringRestore && fusionStatus?.mode === "restoring") return false;
  if (fusionStatus?.blocking !== true) return false;
  // 融合球进程句柄已丢（fusionPid 明确为 null）说明球其实已经不在跑；
  // mode 可能残留在"有球"中间态，不应再拦截原版解语花启动。
  if (fusionStatus?.fusionPid === null) return false;
  return true;
}

function fusionStartBlockedResult() {
  return {
    ok: false,
    status: 409,
    fusion: true,
    error: "融合球正在运行，原版解语花不会重复启动；先收起融合球再启动",
  };
}

async function readFusionStatus(ctx) {
  const bus = ctx?.bus || ctx?._bus;
  if (!bus || typeof bus.request !== "function") return null;
  try {
    const result = await bus.request(
      FUSION_STATUS_BUS_TOPIC,
      { action: "status" },
      { timeoutMs: FUSION_STATUS_TIMEOUT_MS },
    );
    if (result == null) return null;
    if (typeof result !== "object" || typeof result.blocking !== "boolean") {
      console.warn("[解语花] 融合状态桥返回异常，暂不启动原版悬浮球");
      return { blocking: true, mode: "unknown" };
    }
    return result;
  } catch {
    // 闲不住未安装/未加载时没有融合能力，原版解语花照常可启动。
    return null;
  }
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
let startPromise = null;
// 半自动启动：用户手动关过悬浮球后，本次运行打开插件页面不再自动弹（Hana 重启内存重置）
let dismissedByUser = false;

export function consumeZhujianDismissed() {
  const v = dismissedByUser;
  dismissedByUser = false;
  return v;
}

function readPythonFusionState() {
  try {
    return JSON.parse(fs.readFileSync(PYTHON_STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function getZhujianProxyInfo() {
  return {
    baseUrl: `http://127.0.0.1:${PROXY_PORT}`,
    token: proxyToken,
    running: !!appProcess,
  };
}

export function getZhujianFusionSnapshot() {
  const saved = readPythonFusionState();
  const x = Number(saved.x);
  const y = Number(saved.y);
  return {
    ok: true,
    running: !!appProcess,
    position: Number.isFinite(x) && Number.isFinite(y)
      ? { x, y, width: 80, height: 80 }
      : null,
    panel: typeof saved.fusionPanel === "string" ? saved.fusionPanel : "none",
    proxy: getZhujianProxyInfo(),
  };
}

// ─────────────────────────────
//  本地代理（悬浮球 ↔ 插件业务）
// ─────────────────────────────
export function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > maxBytes) {
        // 不能 destroy 请求：Python 端会只收到 ConnectionResetError，用户看到的就是“收藏失败”。
        // 继续排空请求后返回结构化错误，让调用方能给出明确提示。
        req.resume?.();
        finish({ __error: "body_too_large" });
        return;
      }
      chunks.push(part);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch {
        finish({ __error: "invalid_json" });
      }
    });
    req.on("error", () => finish({ __error: "body_read_failed" }));
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

// ─── 断联续接：往断联会话发「继续」 ───
// 手动入口带 resumeId（发送后标记已消费）；自动入口按 sessionPath 直发（不建待办）。
// 目标会话不存在时返回 { ok:false, notFound:true }，由调用方决定回退。
export async function sendResumeContinue(dataDir, bus, options = {}) {
  // 容错：早期路由把 resumeId 裸字符串错当 options 传（解构后为空 → 误报 notFound）。
  // 函数层防御，路由层也同步修了对（2026-08-27 实机踩到）。
  const resumeId = typeof options === "string" ? options : String(options?.resumeId || "");
  const sessionPathOpt = typeof options === "string" ? "" : String(options?.sessionPath || "");
  const entry =
    resumeId
      ? listResumePending(dataDir).find((item) => item.resumeId === resumeId) || null
      : null;
  if (resumeId) {
    if (!entry || entry.consumed) return { ok: false, error: "这条续接已失效" };
  }
  const sessionPath = (sessionPathOpt || entry?.sessionPath || "").trim();
  // 定位参数与生产验证过的推荐发送（claimAndSend）一致：sessionId + sessionPath 双传。
  // 不在本地 fs.existsSync 上做硬门禁（插件沙箱下该检查不可靠，2026-08-27 实机踩到假阴性）；
  // 会话是否存在交给宿主 session:send 裁决，与推荐发送同一通道同一行为。
  const sessionId = String(entry?.sessionId || sessionIdFromPath(sessionPath) || "").trim();
  if (!sessionPath && !sessionId) {
    if (resumeId) await consumeResume(dataDir, resumeId, { failed: true });
    return { ok: false, notFound: true, error: "找不到目标会话，可能已归档或删除" };
  }
  if (!bus || typeof bus.request !== "function") {
    if (resumeId) await consumeResume(dataDir, resumeId, { failed: true });
    return { ok: false, error: "消息通道不可用" };
  }
  // 待办创建时还没取到窗口标题，这里补一次（自动续接的通知要用）；
  // 顺便拿宿主正规 sessionId（sess_xxx）覆盖文件名字符串，否则 session:send 报 manifest not found
  let agentName = entry?.agentName || "";
  let title = entry?.title || "";
  let hostSessionId = "";
  if (!agentName || !title || !String(sessionId).startsWith("sess_")) {
    try {
      const info = await sessionTitleCached(bus, sessionPath);
      if (info?.title && !title) title = info.title;
      if (info?.agentName && !agentName) agentName = info.agentName;
      hostSessionId = info?.sessionId || "";
    } catch { /* 标题拿不到不影响发送 */ }
  }
  // 只发宿主认的 id（sess_xxx）；解析不到就只传 sessionPath，让宿主按路径反查 manifest。
  // 文件名/时间戳前缀格式绝不能当 sessionId 发（2026-08-27 多次实机踩到 manifest not found）。
  const sendSessionId = String(hostSessionId || (String(sessionId).startsWith("sess_") ? sessionId : "") || "").trim();
  // 会话忙（流式输出中）时等待重试：2s / 5s，最多 1 次重试（继续场景等不了太久）；
  // 其余任何挂起/超时都走 withTimeoutBus 兜底，不让界面无限「发送中」。
  const delays = [2000, 5000];
  console.log(`[解语花][resume] 发送开始 sessionId=${sendSessionId || "?"} target=${sessionPath}`);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await withTimeoutBus(
          bus.request("session:send", {
            text: RESUME_TEXT,
            sessionId: sendSessionId || undefined,
            sessionPath,
          }),
          RESUME_SEND_TIMEOUT_MS,
        );
        if (response && response.ok === false) throw new Error(response.error || "发送失败");
        break;
      } catch (e) {
        const busy = /busy/i.test(e?.message || String(e));
        if (!busy || attempt >= delays.length) throw e;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  } catch (err) {
    const message = err?.message === "TOO_SLOW"
      ? "窗口没回应，可能是正在忙或已经睡了，再试一次"
      : err?.message || "发送失败";
    console.log(`[解语花][resume] 发送失败: ${message}`);
    return { ok: false, error: message };
  }
  if (resumeId) await consumeResume(dataDir, resumeId, { auto: false });
  console.log(`[解语花][resume] 发送成功 target=${sessionPath}`);
  return { ok: true, sessionPath, agentName, title };
}

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

    const resultText = buildAskAnswerText(entry, answer.choice, answer.mode);
    const delivery = await beginAskDelivery(dataDir, askId, {
      choice: answer.choice,
      mode: answer.mode,
      resultText,
    });
    if (!delivery?.ok) return { ok: false, status: 409, error: delivery?.error || "这道题刚刚已经作答了" };

    const taskId = delivery.taskId;
    const deliveryChoice = delivery.choice;
    const deliveryMode = delivery.mode;
    const deliveryText = delivery.resultText || resultText;
    try {
      if (delivery.registered !== true) {
        const reg = await bus.request("deferred:register", {
          taskId,
          sessionPath: delivery.sessionPath || entry.sessionPath,
          ...((delivery.sessionId || entry.sessionId) ? { sessionId: delivery.sessionId || entry.sessionId } : {}),
          meta: {
            type: "jiegehua",
            label: "提问回传",
            deliveryIntent: "trigger_parent_turn",
          },
        }, { timeoutMs: 10000 });
        if (!reg || reg.ok !== true) {
          const message = reg?.error || "deferred:register failed";
          if (!isDeferredAlreadyDoneError(message)) throw new Error(message);
        }
        await markAskDeliveryRegistered(dataDir, askId, taskId);
      }
      const resolved = await bus.request("deferred:resolve", { taskId, result: deliveryText }, { timeoutMs: 10000 });
      if (resolved && resolved.ok === false && !isDeferredAlreadyDoneError(resolved.error)) {
        throw new Error(resolved.error || "deferred:resolve failed");
      }
    } catch (err) {
      // delivery 记录故意保留：下一次点击/重启后继续复用同一个 taskId，
      // 不重新创建一条可能重复唤醒父会话的 Deferred 通道。
      return { ok: false, status: 500, error: err?.message || "提问回传失败" };
    }

    const consumed = await completeAskDelivery(dataDir, askId, taskId, {
      choice: deliveryChoice,
      mode: deliveryMode,
    });
    if (!consumed) return { ok: false, status: 500, error: "提问已回传，但本地状态保存失败，请稍后重试" };
    return { ok: true, askId, mode: deliveryMode, choice: deliveryChoice };
  })();

  askResponseLocks.set(askId, task);
  try {
    return await task;
  } finally {
    if (askResponseLocks.get(askId) === task) askResponseLocks.delete(askId);
  }
}

function isDeferredAlreadyDoneError(value) {
  return /already|exists|duplicate|resolved|completed|consumed|重复|已存在|已完成|已处理/i.test(String(value || ""));
}

// ─── 固定的目标会话（null = 跟随最近） ───
export function validatePinnedTargetPath(sessionPath, agentId = "") {
  const cleanPath = String(sessionPath || "").trim();
  const suppliedAgentId = String(agentId || "").trim();
  const inferredAgentId = agentIdFromSessionPath(cleanPath);
  if (!cleanPath || !inferredAgentId || (suppliedAgentId && suppliedAgentId !== inferredAgentId)) {
    return { ok: false, error: "这段对话路径无效，请重新选择" };
  }
  if (!isSessionPathForAgent(cleanPath, inferredAgentId)) {
    return { ok: false, error: "这段对话已经不存在了，请重新选择" };
  }
  return { ok: true, sessionPath: cleanPath, agentId: inferredAgentId };
}

function readPinnedTarget(dataDir) {
  try {
    const data = loadData(dataDir);
    const p = data.pinnedTarget;
    if (p && typeof p === "object" && typeof p.sessionPath === "string" && p.sessionPath) {
      return {
        agentId: String(agentIdFromSessionPath(p.sessionPath) || p.agentId || ""),
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
    const sessionPath = String(pinned?.sessionPath || "");
    data.pinnedTarget = pinned && sessionPath
      ? {
          agentId: String(agentIdFromSessionPath(sessionPath) || pinned.agentId || ""),
          sessionPath,
          title: String(pinned.title || ""),
        }
      : null;
    saveData(dataDir, data);
  });
}

function clearPinnedTargetIfSame(dataDir, expected) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const currentPath = String(data.pinnedTarget?.sessionPath || "");
    if (!currentPath || path.normalize(currentPath) !== path.normalize(String(expected?.sessionPath || ""))) {
      return false;
    }
    data.pinnedTarget = null;
    saveData(dataDir, data);
    return true;
  });
}

// /pin 的业务层单独导出，HTTP 路由只负责鉴权/读写 body；这样合法、越权、失效和目录外
// 四类路径可以在不启动固定端口的情况下做端到端回归。
export async function pinTarget(dataDir, body = {}) {
  const sessionPath = typeof body?.sessionPath === "string" ? body.sessionPath.trim() : "";
  if (!sessionPath) {
    await setPinnedTarget(dataDir, null);
    return { status: 200, body: { ok: true, mode: "auto" } };
  }
  const validation = validatePinnedTargetPath(
    sessionPath,
    typeof body?.agentId === "string" ? body.agentId.trim() : "",
  );
  if (!validation.ok) {
    return {
      status: 400,
      body: { ok: false, code: "invalid_target", error: validation.error },
    };
  }
  await setPinnedTarget(dataDir, {
    agentId: validation.agentId,
    sessionPath: validation.sessionPath,
    title: typeof body?.title === "string" ? body.title : "",
  });
  return { status: 200, body: { ok: true, mode: "pinned", agentId: validation.agentId } };
}

// ─── 朗读回复：取目标会话最近一条助手回复 → 按配置提取 → MiniMax 合成 ───
// body.text 显式传入时优先读它（后续分支窗口等场景可复用）；不传则读当前目标会话
async function speakForBall(dataDir, body) {
  const cfg = getConfig(dataDir);
  const tts = cfg.tts || {};
  if (!tts.enabled) {
    return { ok: false, status: 400, code: "tts_disabled", error: "语音朗读还没开，去设置页打开并配好语音模型" };
  }

  let text = typeof body?.text === "string" ? body.text.trim() : "";
  let from = "custom";
  let replyIndex = 0;
  let targetAgentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
  if (!text) {
    const explicitSessionPath = typeof body?.sessionPath === "string" ? body.sessionPath.trim() : "";
    let target;
    if (explicitSessionPath) {
      if (!fs.existsSync(explicitSessionPath)) {
        return { ok: false, status: 400, code: "session_not_found", error: "这段对话已经不存在了，重新选一个窗口" };
      }
      target = {
        agentId: agentIdFromSessionPath(explicitSessionPath),
        sessionPath: explicitSessionPath,
      };
    } else {
      const pinned = await resolveBallTarget(dataDir);
      target = pinned || resolveTargetSession();
    }
    targetAgentId = target?.agentId || agentIdFromSessionPath(target?.sessionPath) || targetAgentId;
    if (!target?.sessionPath) {
      return { ok: false, status: 400, code: "session_not_found", error: "没有找到可朗读的对话" };
    }
    const rawIndex = body?.replyIndex;
    if (rawIndex !== undefined && (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex > 5)) {
      return { ok: false, status: 400, code: "invalid_reply_index", error: "只能选择最新回复或前 5 条回复" };
    }
    if (Number.isInteger(rawIndex)) replyIndex = rawIndex;
    const replies = readRecentAssistantMessages(target.sessionPath, 6);
    const requestedEntryId = typeof body?.replyEntryId === "string" ? body.replyEntryId.trim() : "";
    const requestedTs = Number.isFinite(Number(body?.replyTs)) ? Number(body.replyTs) : 0;
    // 默认最新没有稳定身份也要动态取第 0 条；旧格式没有 id/时间戳时才退回序号。
    const selected = selectRecentAssistantMessage(replies, {
      index: replyIndex,
      entryId: requestedEntryId,
      ts: requestedTs,
    });
    if (!selected?.content) {
      return {
        ok: false,
        status: 400,
        code: requestedEntryId || requestedTs > 0 ? "reply_changed" : "no_assistant_reply",
        error: requestedEntryId || requestedTs > 0
          ? "选中的回复刚刚变动了，重新展开朗读窗口再试"
          : (replyIndex > 0 ? "选中的回复已经不存在了，刷新列表再试" : "这段对话还没有助手回复，等小花回完再读"),
      };
    }
    replyIndex = replies.indexOf(selected);
    text = selected.content;
    from = "assistant";
  }

  const { text: readText, matched, truncated } = extractReadableText(text, tts.scope === "quoted" ? "quoted" : "whole", tts.maxLen);
  if (!readText) {
    return { ok: false, status: 400, code: "no_text", error: "没有找到可朗读的文字" };
  }

  try {
    const voiceId = resolveTtsVoiceId(tts, targetAgentId);
    const synthConfig = voiceId === String(tts.voiceId || "").trim() ? tts : { ...tts, voiceId };
    const { audio, format } = await synthesizeSpeech(synthConfig, readText);
    return {
      ok: true,
      audio,
      format,
      text: readText,
      from,
      replyIndex,
      matched,
      truncated,
      agentId: targetAgentId,
      voiceId,
    };
  } catch (err) {
    return { ok: false, status: 400, code: "tts_failed", error: redactSecrets(err?.message || "语音合成失败") };
  }
}

// 生成目标选择：固定会话优先（文件失效则自动清除并回落），否则跟随最近对话
export async function resolveBallTarget(dataDir) {
  const pinned = readPinnedTarget(dataDir);
  if (!pinned) return null;
  const validation = validatePinnedTargetPath(pinned.sessionPath, pinned.agentId);
  if (validation.ok) {
    return {
      agentId: validation.agentId,
      sessionPath: validation.sessionPath,
      sessionId: "",
      title: pinned.title,
      pinned: true,
    };
  }
  // 钉住的会话已失效或路径越界 → 只在它仍是当前旧目标时清除，避免覆盖用户刚选的新窗口。
  await clearPinnedTargetIfSame(dataDir, pinned);
  return null;
}

export async function createBallBranch(dataDir) {  const pinned = await resolveBallTarget(dataDir);
  const target = pinned || resolveTargetSession();
  if (!target?.sessionPath) {
    return { ok: false, status: 400, code: "session_not_found", error: "没有找到可分叉的对话" };
  }

  const turnInputEntryId = lastTurnInputEntryId(target.sessionPath);
  if (!turnInputEntryId) {
    return { ok: false, status: 400, code: "invalid_target", error: "还没找到已完成的助手回合，等小花回复完再试" };
  }

  try {
    const forked = await forkBranch({
      sessionPath: target.sessionPath,
      target: { role: "assistant_turn", turnInputEntryId },
    });
    const branch = await createBranchRef(dataDir, {
      sourceSessionPath: target.sessionPath,
      sourceSessionId: forked.sourceSessionId || target.sessionId || "",
      sourceNode: { role: "assistant_turn", turnInputEntryId },
      branchSessionPath: forked.branchSessionPath,
      branchSessionId: forked.branchSessionId,
      title: "另一枝",
      status: "active",
    });
    return {
      ok: true,
      message: "已另开一枝，主线没有切过去",
      branch,
    };
  } catch (err) {
    return {
      ok: false,
      status: err?.status >= 400 && err.status < 600 ? err.status : 400,
      code: err?.code || "fork_failed",
      error: friendlyForkError(err),
    };
  }
}

// ─── 另一枝聊天窗：分支列表 / 历史 / 发消息 ───
// 分支会话是 Hana 的真实会话：读历史直接解析会话文件，发消息走 session:send（同推荐发送）。
function findBranchRef(dataDir, branchId) {
  if (!branchId || typeof branchId !== "string") return null;
  return listBranchRefs(dataDir).find((b) => b.id === branchId) || null;
}

export async function branchListPayload(dataDir) {
  const refs = listBranchRefs(dataDir);
  const branches = [];
  for (const b of refs) {
    let preview = "";
    let lastTs = 0;
    try {
      if (fs.existsSync(b.branchSessionPath)) {
        const msgs = readBranchHistory(b.branchSessionPath, 3);
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        if (lastUser) preview = lastUser.content.replace(/\s+/g, " ").slice(0, 24);
        if (msgs.length) lastTs = msgs[msgs.length - 1].ts || 0;
      }
    } catch {}
    branches.push({
      id: b.id,
      title: b.title || "另一枝",
      createdAt: b.createdAt || 0,
      lastTs,
      preview,
      branchSessionId: b.branchSessionId || "",
      branchSessionPath: b.branchSessionPath || "",
    });
  }
  return { ok: true, branches };
}

export async function branchHistoryPayload(dataDir, branchId) {
  const branch = findBranchRef(dataDir, branchId);
  if (!branch) return { ok: false, status: 404, error: "找不到这个分支，可能已被清理" };
  if (!fs.existsSync(branch.branchSessionPath)) {
    return { ok: false, status: 400, error: "分支会话文件不存在，可能已删除" };
  }
  return {
    ok: true,
    branch: { id: branch.id, title: branch.title || "另一枝" },
    messages: readBranchHistory(branch.branchSessionPath, 200),
  };
}

export async function chatToBranch(dataDir, bus, { branchId, text } = {}, busyDelays = [2000, 5000, 10000]) {
  const t = String(text || "").trim();
  if (!branchId || typeof branchId !== "string") {
    return { ok: false, status: 400, error: "分支编号不完整" };
  }
  if (!t) return { ok: false, status: 400, error: "消息不能为空" };
  if (t.length > 500) return { ok: false, status: 400, error: "消息太长了，收一收" };

  const branch = findBranchRef(dataDir, branchId);
  if (!branch) return { ok: false, status: 404, error: "找不到这个分支，可能已被清理" };
  if (!fs.existsSync(branch.branchSessionPath)) {
    return { ok: false, status: 400, error: "分支会话文件不存在，可能已删除" };
  }
  if (!bus || typeof bus.request !== "function") {
    return { ok: false, status: 500, error: "消息通道不可用" };
  }

  // 会话忙（流式输出中）时等待重试：2s / 5s / 10s，最多 3 次（与推荐发送同款）；测试可注入短延迟
  const delays = Array.isArray(busyDelays) && busyDelays.length ? busyDelays : [2000, 5000, 10000];
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await bus.request("session:send", { text: t, sessionPath: branch.branchSessionPath });
        break;
      } catch (e) {
        const busy = /busy/i.test(e?.message || String(e));
        if (!busy || attempt >= delays.length) throw e;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  } catch (err) {
    return { ok: false, status: 400, error: err?.message || "发送失败" };
  }
  return { ok: true, branchId, text: t };
}

// 实验代码保留在正式目录内但没有任何当前入口；完整快照另存于工作台归档。
// ─── 目标会话信息（悬浮球面板用） ───
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

// ─── 朗读弹窗选项：当前目标会话的最新 6 条助手回复（最新在前） ───
async function ttsRepliesPayload(dataDir, bus, requestedSessionPath = "") {
  const requested = String(requestedSessionPath || "").trim();
  const pinned = await resolveBallTarget(dataDir);
  let target;
  let targetIsPinned = Boolean(pinned);
  if (requested) {
    if (!fs.existsSync(requested)) {
      return { ok: false, status: 400, error: "这段对话已经不存在了，重新点刷新再试" };
    }
    const agentId = agentIdFromSessionPath(requested);
    if (!agentId) {
      return { ok: false, status: 400, error: "这段对话路径无效，重新点刷新再试" };
    }
    target = { agentId, sessionPath: requested, sessionId: "", title: "" };
    targetIsPinned = Boolean(pinned && path.normalize(pinned.sessionPath) === path.normalize(requested));
  } else {
    target = pinned || resolveTargetSession();
  }
  if (!target) return { ok: true, target: null, mode: "auto", pinned: null, replies: [] };

  let title = target.title || "";
  if (!title) {
    const sessions = await listNamedSessions(bus, 16);
    title = sessions.find((item) => path.normalize(item.sessionPath) === path.normalize(target.sessionPath))?.title || "";
  }
  const tts = getConfig(dataDir).tts || {};
  const readScope = tts.scope === "quoted" ? "quoted" : "whole";
  const replies = readRecentAssistantMessages(target.sessionPath, 6).map((item, index) => ({
    index,
    preview: extractReadableText(item.content, readScope, 120).text,
    entryId: item.entryId || "",
    ts: item.ts || 0,
  }));
  return {
    ok: true,
    target: { agentId: target.agentId, name: agentDisplayName(target.agentId), title },
    sessionPath: target.sessionPath,
    mode: targetIsPinned ? "pinned" : "auto",
    pinned: targetIsPinned && pinned
      ? { sessionPath: pinned.sessionPath, title: pinned.title || title }
      : null,
    replies,
  };
}

// ─── 重命名标题：总结当前对话生成新标题，写回宿主并记录旧标题（供退回） ───

// 读会话当前标题 + agentId + 宿主 sessionId
// session:list 只是列表投影（path/title/agentName…），不带宿主的 sess_xxx id；
// 宿主正规 id 要用 session:get 按 path 查（2026-08-27 实机踩到：列表投影无 id，
// 直接拿文件名当 sessionId 发送 → Session manifest not found）。
async function sessionInfoOf(bus, sessionPath) {
  let title = "";
  let agentId = "";
  let sessionId = "";
  try {
    if (!bus || typeof bus.request !== "function") return { title, agentId, sessionId };
    try {
      const got = await withTimeoutBus(bus.request("session:get", { sessionPath }), 3000);
      if (got && typeof got === "object") {
        // 注意：session:get 的 session.id 是归档用的文件名 uuid，不能当发送 id；
        // 只有 sess_ 开头的值才是宿主 manifest 认的会话 id（2026-08-27 实机确认：
        // 返回结构为 { session: { id: "<uuid>", ... } }，顶层无 sessionId）。
        const rawSessionId = String(got?.session?.id || got.sessionId || got.id || "").trim();
        sessionId = rawSessionId.startsWith("sess_") ? rawSessionId : "";
        if (!title) title = String(got?.session?.title || got.title || "").trim();
        if (!agentId) agentId = String(got?.session?.agentId || got.agentId || "").trim();
      }
    } catch { /* session:get 拿不到就退回 list 匹配 */ }
    if (!title || !sessionId) {
      const result = await bus.request("session:list", {});
      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      const hit = sessions.find((s) => s && s.path && path.normalize(s.path) === path.normalize(sessionPath));
      if (hit) {
        if (!title) title = String(hit?.title || "").trim();
        if (!agentId) agentId = String(hit?.agentId || "").trim();
        if (!sessionId) {
          // 同样只认 sess_ 开头的宿主 id；列表投影里的 id 也可能是归档 uuid
          const rawItemId = String(hit?.session_id || hit?.id || hit?.sessionId || "").trim();
          sessionId = rawItemId.startsWith("sess_") ? rawItemId : "";
        }
      }
    }
  } catch { /* 全挂也不用阻塞发送 */ }
  return {
    title,
    agentId: String(agentId || "") || agentIdFromSessionPath(sessionPath),
    sessionId,
  };
}

// 标题缓存：悬浮球每 1.5s 轮询 /ask/pending，避免每次都全量拉会话列表。
const sessionTitleCache = new Map(); // sessionPath -> { title, agentName, ts }
const SESSION_TITLE_TTL_MS = 10_000;

async function sessionTitleCached(bus, sessionPath) {
  if (!sessionPath) return { title: "", agentName: "", sessionId: "" };
  const hit = sessionTitleCache.get(sessionPath);
  if (hit && Date.now() - hit.ts < SESSION_TITLE_TTL_MS) {
    return { title: hit.title, agentName: hit.agentName, sessionId: hit.sessionId || "" };
  }
  const info = await sessionInfoOf(bus, sessionPath);
  const value = {
    title: info.title,
    agentName: agentDisplayName(info.agentId),
    sessionId: info.sessionId || "",
    ts: Date.now(),
  };
  sessionTitleCache.set(sessionPath, value);
  if (sessionTitleCache.size > 50) {
    for (const [key, item] of sessionTitleCache) {
      if (Date.now() - item.ts >= SESSION_TITLE_TTL_MS) sessionTitleCache.delete(key);
    }
  }
  return { title: value.title, agentName: value.agentName, sessionId: value.sessionId };
}

// 消费隐式跳过队列：observer 检测到用户直接对话后登记，这里静默作废提问。
// 不回传、不唤醒、不产生任何消息——用户无视弹窗继续聊天时，
// 用户的新消息本身就是驱动助手的信号，回传纯属多余（还可能把「跳过」
// 语义漏进助手回复）。跨窗口场景下提问会话的挂起回合交给宿主超时收尾。
// 失败保留在队列里，下一轮轮询重试；/ask/pending 会等待本轮清理完成。
// 同一轮并发轮询复用同一个 Promise，避免第二个请求绕过正在进行的清理。
const ASK_DRAIN_ITEM_WAIT_MS = 800;
let askDrainInFlight = null;

function settleAskDrainStep(promiseLike, fallback) {
  let timer;
  const timed = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ASK_DRAIN_ITEM_WAIT_MS);
    timer.unref?.();
  });
  return Promise.race([
    Promise.resolve(promiseLike).catch(() => fallback),
    timed,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function drainAskSkips(dataDir) {
  if (askDrainInFlight) return askDrainInFlight;
  askDrainInFlight = (async () => {
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
          const ok = await settleAskDrainStep(
            Promise.resolve().then(() => markAskConsumed(dataDir, askId, { mode: "skip", choice: "" })),
            false,
          );
          if (ok) done.push(askId);
        } catch {
          // 单条失败不影响其他；下轮轮询再试
        }
      }
      if (done.length) {
        await settleAskDrainStep(
          Promise.resolve().then(() => clearAskSkips(dataDir, done)),
          false,
        );
      }
    } catch {
      // 队列消费整体失败时保留，下轮再试
    } finally {
      askDrainInFlight = null;
    }
  })();
  return askDrainInFlight;
}

const ASK_DRAIN_WAIT_MS = 1500;

export async function listAskPendingAfterSkipDrain(dataDir) {
  // 先记住队列两端的快照：observer 可能恰好在 drain 前后写入 skip，
  // 本轮都不能再把这些题交给 Python 面板，否则重启首轮仍会闪回旧题。
  const queuedBefore = new Set(listAskSkips(dataDir));
  const drain = drainAskSkips(dataDir);
  let timer;
  await Promise.race([
    drain,
    new Promise((resolve) => {
      timer = setTimeout(resolve, ASK_DRAIN_WAIT_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  const skippedIds = new Set([...queuedBefore, ...listAskSkips(dataDir)]);
  return listAskPending(dataDir).filter((entry) => !skippedIds.has(entry.askId));
}

// 标题输出清洗：去代码块/首尾引号/结尾标点/空白，限 30 字；空返回 null
export function cleanTitleOutput(raw) {
  if (typeof raw !== "string") return null;
  // MiniMax-M3 可能把思考链放进 message.content；标题入口必须先沿用朗读层的隐藏元信息清洗。
  let t = stripHiddenMetaBlocks(raw);
  t = t.replace(/^```(?:json|text)?\s*/i, "").replace(/\s*```$/, "");
  // 循环剥成对包裹引号（「」""『』《》 等）
  for (let i = 0; i < 3; i++) {
    t = t.replace(/^(["'“”‘’「」『』《》])(.*)\1$/, "$2");
  }
  // 模型或附件包装误传进来时，不允许把元数据当标题写回宿主。
  if (/^\s*(?:\[SessionFile\]|\[attached_image:|<file\b)/i.test(t) || /["']fileId["']\s*:/i.test(t)) {
    return null;
  }
  // 去结尾标点（标题不带句号）
  t = t.replace(/[。．.，,；;：:！!？?\s]+$/, "");
  // 去剩余孤立引号（半包裹残留；标题里本就不需要引号）
  t = t.replace(/["'“”‘’「」『』《》()（）【】]/g, "");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.slice(0, 30);
}

// 兜底标题只取用户真正写的文字，剥掉 SessionFile/图片附件包装。
export function cleanTitleFallbackText(raw) {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/<file\b[^>]*>[\s\S]*?<\/file>/gi, " ")
    .replace(/\[attached_image:[^\]]*\]/gi, " ")
    .replace(/\[SessionFile\]\s*\{[\s\S]*?\}\s*/gi, " ")
    .replace(/<attached_image\b[^>]*>[\s\S]*?<\/attached_image>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleanTitleOutput(text);
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
export async function summarizeSessionTitle(dataDir, modelSample, sessionPath, bus) {
  const messages = readAllMessages(sessionPath);
  const contextText = buildTitleContext(messages);
  let title = null;
  let fallback = false;
  try {
    const sampleFn = (opts) => {
      if (!modelSample) return Promise.reject(new Error("当前会话模型不可用"));
      return modelSample(opts);
    };
    const raw = await generateSuggestions(dataDir, buildTitlePrompt(contextText), {
      sampleFn,
      bus,
      sessionPath,
      maxTokens: 300,
    });
    title = cleanTitleOutput(raw);
  } catch (err) {
    console.error("[解语花] 标题生成失败:", err?.message || err);
  }
  if (!title) {
    // 兜底：取最近一条用户可见文字；附件包装不能直接当标题。
    for (const message of [...messages].reverse()) {
      if (message.role !== "user") continue;
      const candidate = cleanTitleFallbackText(message.content);
      if (candidate) {
        title = candidate;
        break;
      }
    }
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
async function generateForBall(dataDir, modelSample, bus) {
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
  const raw = await generateSuggestions(dataDir, prompt, {
    sampleFn,
    bus,
    sessionPath,
  });

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

// 实验版分支路由的路径归一化保留在这里，方便未来从归档恢复；正式版当前没有调用方。
export function proxyPathname(rawUrl) {
  return new URL(rawUrl || "/", "http://127.0.0.1").pathname;
}

function startProxy(ctx) {
  if (proxyServer) return false;
  proxyToken = crypto.randomBytes(32).toString("hex");
  const dataDir = ctx.dataDir;
  const modelSample = ctx.model?.sample ? (opts) => ctx.model.sample(opts) : null;
  const bus = ctx.bus || ctx._bus;

  proxyServer = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!hasProxyToken(req)) {
      return sendJson(res, 403, { ok: false, error: "本地代理未授权" });
    }
    try {
      const url = req.url || "/";
      if (req.method === "GET" && url === "/health") {
        return sendJson(res, 200, { ok: true, running: !!appProcess });
      }
      if (req.method === "GET" && url === "/target") {
        return sendJson(res, 200, await targetPayload(dataDir, bus));
      }
      if (req.method === "GET" && new URL(url, "http://127.0.0.1").pathname === "/tts/replies") {
        const parsed = new URL(url, "http://127.0.0.1");
        const result = await ttsRepliesPayload(dataDir, bus, parsed.searchParams.get("sessionPath") || "");
        return sendJson(res, result.ok ? 200 : (result.status || 400), result);
      }
      if (req.method === "GET" && url === "/sessions") {
        const pinned = await resolveBallTarget(dataDir);
        const sessions = await listNamedSessions(bus, TARGET_SESSION_LIMIT * 3);
        const safeSessions = sessions
          .filter((item) => validatePinnedTargetPath(item.sessionPath, item.agentId).ok)
          .slice(0, TARGET_SESSION_LIMIT);
        return sendJson(res, 200, {
          ok: true,
          sessions: safeSessions,
          mode: pinned ? "pinned" : "auto",
          pinned: pinned ? {
            sessionPath: pinned.sessionPath,
            title: pinned.title || "",
            agentId: pinned.agentId || agentIdFromSessionPath(pinned.sessionPath),
            agentName: agentDisplayName(pinned.agentId || agentIdFromSessionPath(pinned.sessionPath)),
          } : null,
        });
      }
      if (req.method === "POST" && url === "/pin") {
        const body = await readBody(req);
        const result = await pinTarget(dataDir, body);
        return sendJson(res, result.status, result.body);
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
        // 先消费隐式跳过队列，再读取 pending，避免悬浮球重启后短暂闪回旧题。
        const pending = await listAskPendingAfterSkipDrain(dataDir);
        const enriched = [];
        for (const entry of pending) {
          const info = await sessionTitleCached(bus, entry.sessionPath);
          enriched.push({ ...entry, sessionTitle: info.title, agentName: info.agentName });
        }
        // 断联续接待办：与提问同轮询通道带回，悬浮球一并渲染
        pruneResumePending(dataDir);
        const resume = [];
        for (const entry of listResumePending(dataDir)) {
          const info = await sessionTitleCached(bus, entry.sessionPath);
          resume.push({ ...entry, sessionTitle: info.title, agentName: info.agentName || entry.agentName });
        }
        const resumeCfg = getConfig(dataDir).resume || {};
        return sendJson(res, 200, {
          ok: true,
          pending: enriched,
          resume,
          resumeAuto: resumeCfg.autoContinue === true,
          resumeNotices: listResumeNotices(dataDir),
        });
      }
      if (req.method === "POST" && url === "/resume/continue") {
        const body = await readBody(req);
        // 传参必须是对象 { resumeId }：早期裸传 resumeId 字符串时，
        // sendResumeContinue 解构拿不到参数 → 直接 notFound（2026-08-27 实机踩到，用户点「继续」永远 400）。
        const result = await sendResumeContinue(
          dataDir,
          bus,
          typeof body.resumeId === "string" ? { resumeId: body.resumeId } : {},
        );
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && url === "/resume/dismiss") {
        // 用户关闭断联卡 = 放弃这条待办（不再打扰，即使重启也不弹）
        const body = await readBody(req);
        const resumeId = typeof body.resumeId === "string" ? body.resumeId : "";
        if (!resumeId) return sendJson(res, 400, { ok: false, error: "续接编号不完整" });
        await consumeResume(dataDir, resumeId);
        return sendJson(res, 200, { ok: true, resumeId });
      }
      if (req.method === "POST" && url === "/resume/auto") {
        const body = await readBody(req);
        const enabled = body.enabled === true;
        const current = getConfig(dataDir).resume || {};
        await setConfig(dataDir, { resume: { ...current, autoContinue: enabled } });
        return sendJson(res, 200, { ok: true, enabled });
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
        const result = await generateForBall(dataDir, modelSample, bus);
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
        const { ok: genOk, title, fallback } = await summarizeSessionTitle(dataDir, modelSample, sessionPath, bus);
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
      if (req.method === "POST" && url === "/tts/speak") {
        const body = await readBody(req);
        const result = await speakForBall(dataDir, body);
        return sendJson(res, result.ok ? 200 : (result.status || 400), result);
      }
      if (req.method === "POST" && url === "/tts/favorite") {
        const body = await readBody(req, 8 * 1024 * 1024);
        if (body?.__error === "body_too_large") {
          return sendJson(res, 413, { ok: false, error: "这段音频太大了，换短一点的回复再收藏" });
        }
        if (body?.__error) {
          return sendJson(res, 400, { ok: false, error: "收藏内容没读完整，再点一次试试" });
        }
        const text = String(body?.text || "").trim();
        const audio = String(body?.audio || "");
        if (!text || !audio) {
          return sendJson(res, 400, { ok: false, error: "这条没有可收藏的内容" });
        }
        // 收藏打上来源助手标签：朗读回包里已带 agentId（speak 返回），老前端没传时按当前目标推断
        let favAgentId = String(body?.agentId || "").trim();
        // 兜底①：请求带了会话路径就从路径推断（agentIdFromSessionPath 按目录结构取，很可靠）
        if (!favAgentId && typeof body?.sessionPath === "string" && body.sessionPath.trim()) {
          favAgentId = agentIdFromSessionPath(body.sessionPath) || "";
        }
        // 兜底②：悬浮球固定目标 → 最近活跃会话
        if (!favAgentId) {
          const pinned = await resolveBallTarget(dataDir);
          const target = pinned || resolveTargetSession();
          favAgentId = target?.agentId || agentIdFromSessionPath(target?.sessionPath) || "";
        }
        const existing = listFavorites(dataDir).find((item) => item && item.text === text);
        if (existing) {
          return sendJson(res, 200, { ok: true, already: true, item: existing, message: "这段已经收藏过了" });
        }
        const item = saveFavorite(dataDir, {
          text,
          audio,
          format: body?.format,
          voiceId: body?.voiceId,
          agentId: favAgentId,
        });
        if (!item) return sendJson(res, 400, { ok: false, error: "收藏没有保存下来，再点一次试试" });
        return sendJson(res, 200, { ok: true, item, message: "已收藏" });
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
  return true;
}

function closeProxy() {
  const server = proxyServer;
  proxyServer = null;
  proxyToken = "";
  if (!server) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
    try {
      server.close(finish);
      if (!server.listening) finish();
    } catch {
      finish();
    }
  });
}

// ─────────────────────────────
//  悬浮球进程管理
// ─────────────────────────────
export async function startZhujian(ctx, options = {}) {
  if (startPromise) return startPromise;
  const task = startZhujianInternal(ctx, options).finally(() => {
    if (startPromise === task) startPromise = null;
  });
  startPromise = task;
  return task;
}

async function startZhujianInternal(ctx, { allowDuringRestore = false } = {}) {
  const fusionStatus = await readFusionStatus(ctx);
  if (shouldBlockOriginalStart(fusionStatus, { allowDuringRestore })) {
    return fusionStartBlockedResult();
  }
  if (appProcess) return { ok: true, message: "已在运行" };
  const python = detectPython();
  const script = path.join(PY_DIR, "zhujian_app.py");
  if (!fs.existsSync(script)) {
    return { ok: false, error: "zhujian_app.py 不存在" };
  }

  const startedProxy = !proxyServer;
  startProxy(ctx);

  const env = { ...process.env };
  env.JIEGEHUA_API = `http://127.0.0.1:${PROXY_PORT}`;
  env.JIEGEHUA_API_TOKEN = proxyToken;
  env.HANA_HOME = HANA_HOME;
  env.PYTHONDONTWRITEBYTECODE = "1";

  // 融合协调器可能在第一次查询返回后刚好进入切换，真正 spawn 前再确认一次。
  const latestFusionStatus = await readFusionStatus(ctx);
  if (shouldBlockOriginalStart(latestFusionStatus, { allowDuringRestore })) {
    if (startedProxy) await closeProxy();
    return fusionStartBlockedResult();
  }
  if (appProcess) return { ok: true, message: "已在运行" };

  try {
    appProcess = spawn(python, [script], {
      cwd: PY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
  } catch (e) {
    state.error = e?.message || String(e);
    if (startedProxy) await closeProxy();
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
    // 进程退出（右键关闭/崩溃/被用户停）：视为用户已关闭，本次运行期间不再自动弹
    dismissedByUser = true;
  });
  appProcess.on("error", (err) => {
    console.error("[解语花] 启动失败:", err.message);
    appProcess = null;
    state.running = false;
    state.error = err.message;
    if (proxyServer && !appProcess) void closeProxy();
  });

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.exitCode = null;
  state.error = null;
  dismissedByUser = false; // 用户重新要球了，下次打开页面恢复自动
  return { ok: true, message: "已启动" };
}

function waitForProcessExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", () => finish(true));
    child.once("error", () => finish(true));
  });
}

export async function stopZhujian({ closeProxy: shouldCloseProxy = true } = {}) {
  const child = appProcess;
  if (!child) {
    stopPlaying();
    if (shouldCloseProxy) await closeProxy();
    return { ok: true, message: "未在运行", exited: true };
  }
  dismissedByUser = true; // 用户手动收起：本次打开页面不再自动弹，下次再弹
  try {
    child.kill();
  } catch (e) {
    console.error("[解语花] 停止失败:", e?.message || e);
  }
  let exited = await waitForProcessExit(child);
  if (!exited) {
    try { child.kill("SIGKILL"); } catch {}
    exited = await waitForProcessExit(child, 1000);
  }
  if (!exited) {
    return { ok: false, error: "解语花进程退出超时，暂不重新启动，避免出现两个悬浮球" };
  }
  if (appProcess === child) {
    appProcess = null;
    state.running = false;
  }
  stopPlaying();
  if (shouldCloseProxy) await closeProxy();
  return { ok: true, message: "已停止", exited: true };
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

// 原版球停止是融合流程的正常中间态；对 Ask 工具来说，运行中的融合球同样是可接管提问的悬浮球。
export async function isZhujianPresentationRunning(ctx) {
  if (appProcess) return true;
  const fusionStatus = await readFusionStatus(ctx);
  return fusionStatus?.mode === "fused" && fusionStatus?.blocking === true;
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
