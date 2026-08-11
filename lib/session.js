// 解语花 — 会话读取模块
// 从会话 JSONL 尾部读最近消息（给推荐生成提供上下文）
// 会话定位优先用工具 ctx 的 sessionId/sessionPath（runtimeScope 展开），兜底扫描最近会话文件

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

// ─── 只读文件尾部（最多 256KB，避免大会话全量读），返回行数组 ───
function readTailLines(sessionPath) {
  const stat = fs.statSync(sessionPath);
  if (stat.size === 0) return [];
  const TAIL = 256 * 1024;
  const fd = fs.openSync(sessionPath, "r");
  let buffer;
  try {
    const start = Math.max(0, stat.size - TAIL);
    buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString("utf-8").split("\n").filter(Boolean);
}

// ─── 从一条会话 JSONL 条目提取对话消息（兼容新老格式） ───
// 新格式（Hana 现行）：{ type, timestamp, message: { role, content: [{type:"text",text}] } }
// 旧格式：{ role, content: "string" }
export function extractConversationMessage(entry) {
  if (!entry || typeof entry !== "object") return null;
  const msg = entry.message && typeof entry.message === "object" ? entry.message : entry;
  const role = msg.role;
  if (role !== "user" && role !== "assistant") return null;
  let text = "";
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content
      .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  if (!text.trim()) return null;
  return { role, content: text.slice(0, 500) };
}

// ─── 从 JSONL 尾部读最近 N 条有效消息（user/assistant） ───
export function readRecentMessages(sessionPath, max = 6) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return [];
    const lines = readTailLines(sessionPath);
    const messages = [];
    for (let i = lines.length - 1; i >= 0 && messages.length < max; i--) {
      try {
        const msg = extractConversationMessage(JSON.parse(lines[i]));
        if (msg) messages.unshift(msg);
      } catch {}
    }
    return messages;
  } catch (err) {
    console.error("[解语花] 读取会话失败:", err?.message || err);
    return [];
  }
}

// ─── 提取 prompt 上下文：清洗噪音（MOOD 块/引用块）+ 截断，只留干净的对话 ───
// 实机教训（2026-08-06）：不清理就把 MOOD/<mood> 块、[hana_reference] 引用喂给模型，
// 模型会被第一人称内容带偏，分不清「用户」是谁，生成助手口吻的推荐。
export function buildContextText(messages) {
  if (!messages.length) return "";
  const parts = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    let text = typeof m.content === "string" ? m.content : "";
    text = cleanContextText(text);
    if (!text) continue;
    parts.push(`${m.role === "user" ? "用户" : "助手"}: ${text}`);
  }
  // 只保留最近 4 条，太长会稀释推荐质量
  return parts.slice(-4).join("\n");
}

function cleanContextText(text) {
  let out = text || "";
  // 去 <mood>...</mood> 块
  out = out.replace(/<mood>[\s\S]*?<\/mood>/gi, "");
  // 去 [xxx] 引用块（如 [hana_reference]...[/hana_reference]）
  out = out.replace(/\[[^\]]*\][\s\S]*?\[\/[^\]]*\]/gi, "");
  // 去单行 [xxx] 标记
  out = out.replace(/\[[^\]]*\]/g, "");
  // 去成对的【xxx】...【/xxx】隐藏注入块
  out = out.replace(/【[^】]*】[\s\S]*?【\/[^】]*】/g, "");
  // 去隐藏注入块（【朋友圈生活视角】等，兜底到行尾）
  out = out.replace(/【[^】]*】[\s\S]*?(?=(用户|助手):|$)/g, "");
  out = out.replace(/\s+/g, " ").trim();
  // 每条最多 250 字（v0.2 提升：保留更多对话细节供推荐参考）
  return out.slice(0, 250);
}

// ─── 兜底：按 agentId 找最近会话文件（闲不住同款） ───
export function findLatestSessionPath(agentId) {
  try {
    const sessionsDir = path.join(HANA_HOME, "agents", agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) return "";
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fp = path.join(sessionsDir, f);
        try { return { fp, mtime: fs.statSync(fp).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? files[0].fp : "";
  } catch {
    return "";
  }
}

// ─── 从 JSONL 尾部找最后一条用户消息的时间（mtime 会被助手回复/推送扰动，不可靠） ───
function getLastUserMsgTime(sessionPath) {
  try {
    const lines = readTailLines(sessionPath);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const msg = entry.message && typeof entry.message === "object" ? entry.message : entry;
        if (msg.role === "user") {
          return entry.timestamp || entry.ts || null;
        }
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

// ─── 某助手最近的会话：优先有用户消息的，兜底 mtime ───
function findLatestSession(agentId) {
  try {
    const sessionsDir = path.join(HANA_HOME, "agents", agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      return { path: "", time: -Infinity, hasUser: false };
    }
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    if (!files.length) return { path: "", time: -Infinity, hasUser: false };

    let userPath = "", userTime = -Infinity;
    let fallbackPath = "", fallbackTime = -Infinity;
    for (const f of files) {
      const full = path.join(sessionsDir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.mtimeMs > fallbackTime) {
        fallbackTime = stat.mtimeMs;
        fallbackPath = full;
      }
      const lastUserTime = getLastUserMsgTime(full);
      if (lastUserTime !== null && lastUserTime > userTime) {
        userTime = lastUserTime;
        userPath = full;
      }
    }
    if (userPath) return { path: userPath, time: userTime, hasUser: true };
    return { path: fallbackPath, time: fallbackTime, hasUser: false };
  } catch {
    return { path: "", time: -Infinity, hasUser: false };
  }
}

// ─── 扫全部 agents 目录，找用户最后操作过的会话（悬浮球跟随用） ───
export function findMostActiveSession() {
  try {
    const agentsDir = path.join(HANA_HOME, "agents");
    if (!fs.existsSync(agentsDir)) return null;
    const agentIds = fs.readdirSync(agentsDir);

    let userBest = null, userBestTime = -Infinity;
    let fallbackBest = null, fallbackTime = -Infinity;
    for (const agentId of agentIds) {
      const session = findLatestSession(agentId);
      if (!session.path) continue;
      if (session.hasUser && session.time > userBestTime) {
        userBestTime = session.time;
        userBest = { agentId, sessionPath: session.path, sessionId: "" };
      } else if (!session.hasUser && session.time > fallbackTime) {
        fallbackTime = session.time;
        fallbackBest = { agentId, sessionPath: session.path, sessionId: "" };
      }
    }
    return userBest || fallbackBest;
  } catch {
    return null;
  }
}

// ─── 从会话文件名解析 sessionId（sess_ 前缀） ───
function sessionIdFromPath(sessionPath) {
  try {
    const base = path.basename(sessionPath);
    const m = base.match(/^(sess_[^_]+)/);
    if (m) return m[1];
  } catch {}
  return "";
}

// ─── 目标会话信息（悬浮球面板用） ───
export function resolveTargetSession() {
  const active = findMostActiveSession();
  if (!active) return null;
  return {
    agentId: active.agentId,
    sessionPath: active.sessionPath,
    sessionId: sessionIdFromPath(active.sessionPath) || active.sessionId || "",
  };
}

// ─── 助手显示名（agentId → config.yaml 的 agent.name，读不到回退 agentId） ───
export function agentDisplayName(agentId) {
  if (!agentId) return "";
  try {
    const yamlPath = path.join(HANA_HOME, "agents", agentId, "config.yaml");
    if (!fs.existsSync(yamlPath)) return agentId;
    const yaml = fs.readFileSync(yamlPath, "utf-8");
    // 只在 agent: 块内找 name:（防止未来 yaml 出现其他 name 字段时误读）
    const agentBlock = yaml.match(/^agent:\s*\r?\n([\s\S]*?)(?=^\S|\s*$)/m);
    const scope = agentBlock ? agentBlock[1] : yaml;
    const m = scope.match(/^\s*name:\s*(.+)$/m);
    if (!m) return agentId;
    return m[1].trim().replace(/^["']|["']$/g, "").trim() || agentId;
  } catch {
    return agentId;
  }
}
