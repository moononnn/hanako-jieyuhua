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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getConfig, loadData, saveData, withDataLock, createPending } from "./data.js";
import { readRecentMessages, buildContextText, resolveTargetSession, agentDisplayName, listNamedSessions } from "./session.js";
import { generateSuggestions, parseSuggestions } from "./llm.js";
import { buildStyleLines } from "../tools/suggest_replies.js";
import { claimAndSend, getSuggestionText } from "./send.js";

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
  };
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

  // 2. 构建 prompt（复用卡片工具的 buildStyleLines）
  const sel = (cfg.selectedByCount && cfg.selectedByCount[cfg.count]) || undefined;
  const styleLines = buildStyleLines(cfg.count, cfg.styles, sel);
  const prompt = [
    "【红线】所有输出必须是「用户」在对话中对「助手」说的话。第一人称「我」、直接对助手喊，不要生成助手口吻、引导问句、旁观者描述这种不是用户在说的话。",
    "你是「解语花」推荐引擎，你是用户的「嘴替」。",
    "下面对话中，「用户」是发消息的人，「助手」是回复的人。",
    `你的任务：生成 ${cfg.count} 条「用户接下来准备发给助手的话」。`,
    "硬性要求：",
    "1. 紧扣下面对话的具体内容——顺着刚才聊的话题、细节、情绪往下走，不要生成与对话无关的泛泛之谈",
    "2. 必须是用户的口吻、第一人称（「我」），直接对助手说话",
    "3. 每条 5~20 个字，口语化",
    ...styleLines,
    "5. 反面例子（不要生成）：「早啊，今天想干点啥」「今天天气不错」——这是助手口吻或与对话无关",
    "6. 正面例子（紧扣对话）：「你刚说的那个方案，具体怎么操作？」「听你这么说我也想起一件事…」「那你帮我看看这个呗」",
    "7. 只输出一个合法 JSON 数组，首字符必须是 [，末字符必须是 ]；不要逐行输出独立对象，不要任何其他文字、不要解释。数组元素是对象：{\"text\": \"推荐的话\", \"direction\": \"第N条对应的方向名，照抄上方给出的方向，如'撒娇'\"}",
    "对话：",
    contextText || "（无可用对话，生成通用的用户对助手说的话）",
    "输出："
  ].join("\n");

  // 3. 调模型
  const sampleFn = (opts) => {
    if (!modelSample) return Promise.reject(new Error("当前会话模型不可用"));
    return modelSample(opts);
  };
  const raw = await generateSuggestions(dataDir, prompt, { sampleFn });

  // 4. 解析 + 存 pending + 写缓存
  const items = parseSuggestions(raw, cfg.count);
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
  const dataDir = ctx.dataDir;
  const modelSample = ctx.model?.sample ? (opts) => ctx.model.sample(opts) : null;
  const bus = ctx.bus || ctx._bus;

  proxyServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
