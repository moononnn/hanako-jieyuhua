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
  // 截断必须覆盖超长注入块（[hana_reference] 工具清单可达 3~5KB）。
  // 旧值 500 会把注入块拦腰截断：闭标签丢失 → 清洗正则匹配不上 → 工具清单残渣当成对话上下文喂给模型（2026-08-11 实机事故）。
  return { role, content: text.slice(0, 8000) };
}

// ─── 从 JSONL 全量读有效消息（user/assistant），供标题总结等需要整体内容的场景 ───
// 超大文件保护：> 4MB 时读开头 1MB + 尾部 3MB（被拦腰截断的 JSON 行 parse 失败自动跳过，安全）
const ALL_READ_MAX = 4 * 1024 * 1024;
const ALL_READ_HEAD = 1024 * 1024;

export function readAllMessages(sessionPath) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return [];
    const stat = fs.statSync(sessionPath);
    if (stat.size === 0) return [];

    const parts = [];
    if (stat.size <= ALL_READ_MAX) {
      parts.push(fs.readFileSync(sessionPath, "utf-8"));
    } else {
      const fd = fs.openSync(sessionPath, "r");
      try {
        const head = Buffer.alloc(ALL_READ_HEAD);
        fs.readSync(fd, head, 0, ALL_READ_HEAD, 0);
        parts.push(head.toString("utf-8"));
        const tailLen = stat.size - ALL_READ_HEAD;
        const tail = Buffer.alloc(Math.min(tailLen, ALL_READ_MAX - ALL_READ_HEAD));
        fs.readSync(fd, tail, 0, tail.length, ALL_READ_HEAD);
        parts.push(tail.toString("utf-8"));
      } finally {
        fs.closeSync(fd);
      }
    }

    const messages = [];
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = extractConversationMessage(JSON.parse(line));
          if (msg) messages.push(msg);
        } catch {}
      }
    }
    return messages;
  } catch (err) {
    console.error("[解语花] 全量读取会话失败:", err?.message || err);
    return [];
  }
}

// ─── 构建标题总结用的对话上下文：清洗 + 截断（短对话全保留，长对话取开头+最近） ───
// 标题要概括「整体主题」，开头定调、最近定现状，中间细节对 10 字标题贡献有限
const TITLE_CTX_BUDGET = 6000;
const TITLE_CTX_HEAD = 1500;

export function buildTitleContext(messages) {
  if (!Array.isArray(messages) || !messages.length) return "";
  const parts = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    let text = typeof m.content === "string" ? m.content : "";
    text = cleanContextText(text);
    if (!text) continue;
    parts.push(`${m.role === "user" ? "用户" : "助手"}: ${text}`);
  }
  if (!parts.length) return "";
  const joined = parts.join("\n");
  if (joined.length <= TITLE_CTX_BUDGET) return joined;
  // 开头 + 最近：分别从两端取，保证中间被裁掉也不破坏可读性
  let head = "";
  let tail = "";
  for (const p of parts) {
    if (head.length < TITLE_CTX_HEAD) {
      head += p + "\n";
    } else {
      break;
    }
  }
  let budget = TITLE_CTX_BUDGET - head.length - 8;
  for (let i = parts.length - 1; i >= 0 && budget > 0; i--) {
    const p = parts[i];
    if (tail.length + p.length + 1 > budget) {
      tail = p.slice(0, Math.max(0, budget - tail.length - 1)) + "\n" + tail;
      break;
    }
    tail = p + "\n" + tail;
    budget -= p.length + 1;
  }
  return head + "\n……（中间省略）……\n" + tail.trim();
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
  // 未闭合注入块残留（截断导致闭标签丢失时）：以 [xxx] 开头且没有任何闭标签 → 整条视为注入残留丢弃
  if (/^\[[^\]]*\]/.test(out) && !/\[\/[^\]]*\]/.test(out)) {
    return "";
  }
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

// ─── 从 JSONL 尾部找最后一条用户消息（时间+文本，mtime 会被助手回复/推送扰动，不可靠） ───
function getLastUserMsg(sessionPath) {
  try {
    const lines = readTailLines(sessionPath);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const msg = entry.message && typeof entry.message === "object" ? entry.message : entry;
        if (msg.role === "user") {
          const raw = entry.timestamp || entry.ts || null;
          if (raw == null) return null;
          // 转成可比较的毫秒数（原始值是 ISO UTC 字符串，字符串 > -Infinity 恒为 false，
          // 会导致 findLatestSession 的用户时间分支永远失效、退化到 mtime 兜底 —— 2026-08-11 实机事故）
          const t = new Date(raw).getTime();
          if (!Number.isFinite(t)) return null;
          let text = "";
          if (typeof msg.content === "string") {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
              .map((c) => c.text)
              .join("\n");
          }
          return { time: t, text };
        }
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

function getLastUserMsgTime(sessionPath) {
  const last = getLastUserMsg(sessionPath);
  return last ? last.time : null;
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

// ─── 最近会话列表（文件扫描兜底）：跨 agent 按最后用户消息时间倒序 ───
// 摘要取最后一条用户消息清洗后的前 20 字；archived 子目录天然跳过（readdirSync 不递归）
export function listRecentSessions(limit = 12) {
  try {
    const agentsDir = path.join(HANA_HOME, "agents");
    if (!fs.existsSync(agentsDir)) return [];
    const agentIds = fs.readdirSync(agentsDir);
    const list = [];
    for (const agentId of agentIds) {
      const sessionsDir = path.join(agentsDir, agentId, "sessions");
      let files;
      try {
        files = fs.readdirSync(sessionsDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(sessionsDir, f);
        let stat;
        try {
          stat = fs.statSync(fp);
        } catch {
          continue;
        }
        if (stat.size === 0) continue;
        const last = getLastUserMsg(fp);
        if (!last) continue;
        const clean = cleanContextText(last.text || "");
        list.push({
          agentId,
          agentName: agentDisplayName(agentId),
          sessionPath: fp,
          title: clean ? clean.slice(0, 20) : "",
          lastUserTime: last.time,
        });
      }
    }
    list.sort((a, b) => b.lastUserTime - a.lastUserTime);
    return list.slice(0, limit);
  } catch {
    return [];
  }
}

// ─── 优先走 Hana session:list，拿宿主保存的真实会话标题；失败时回退文件扫描 ───
export async function listNamedSessions(bus, limit = 8) {
  const fallback = listRecentSessions(Math.max(limit * 3, 24));
  const fallbackByPath = new Map(fallback.map((item) => [path.normalize(item.sessionPath), item]));
  try {
    if (!bus || typeof bus.request !== "function") return fallback.slice(0, limit);
    const result = await bus.request("session:list", {});
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    const normalized = sessions
      .filter((item) => item && typeof item.path === "string" && item.path)
      .map((item) => {
        const matched = fallbackByPath.get(path.normalize(item.path));
        const title = String(item.title || item.firstMessage || matched?.title || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40);
        const modifiedRaw = item.modified ?? 0;
        const modified = typeof modifiedRaw === "number" ? modifiedRaw : new Date(modifiedRaw).getTime();
        return {
          agentId: String(item.agentId || matched?.agentId || ""),
          agentName: String(item.agentName || matched?.agentName || agentDisplayName(item.agentId) || ""),
          sessionPath: item.path,
          title,
          lastUserTime: Number.isFinite(modified) && modified > 0 ? modified : (matched?.lastUserTime || 0),
        };
      })
      .sort((a, b) => b.lastUserTime - a.lastUserTime);
    return normalized.length ? normalized.slice(0, limit) : fallback.slice(0, limit);
  } catch {
    return fallback.slice(0, limit);
  }
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
