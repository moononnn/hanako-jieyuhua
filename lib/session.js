// 文件预算豁免：会话格式解析、尾部扫描、目标合并和身份补全共享同一套路径/时间语义，保持集中以避免读取口径分裂。
// 解语花 — 会话读取模块
// 从会话 JSONL 尾部读最近消息（给推荐生成提供上下文）
// 会话定位优先用工具 ctx 的 sessionId/sessionPath（runtimeScope 展开），兜底扫描最近会话文件

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

// ─── 从文件尾按完整 JSONL 行向前扫描 ───
// 不能固定只读最后 256KB：长期会话里一条助手回复、工具结果或图片元数据
// 就可能把最新用户消息推到窗口之外，悬浮球随后会误选旧会话或读到空上下文。
const BACKWARD_CHUNK_SIZE = 64 * 1024;

function decodeLineParts(parts) {
  const nonEmpty = parts.filter((part) => part && part.length > 0);
  if (!nonEmpty.length) return "";
  if (nonEmpty.length === 1) return nonEmpty[0].toString("utf-8");
  return Buffer.concat(nonEmpty).toString("utf-8");
}

function forEachLineFromEnd(sessionPath, callback) {
  const stat = fs.statSync(sessionPath);
  if (stat.size === 0) return false;
  const fd = fs.openSync(sessionPath, "r");
  try {
    let position = stat.size;
    // 保存跨块的“较旧前缀 + 已读到的较新部分”，只在真正找到换行时拼一次。
    // 不能每读 64KB 都 Buffer.concat(carry)，否则超长单行会退化成 O(n²) 拷贝。
    let carryParts = [];
    while (position > 0) {
      const readSize = Math.min(BACKWARD_CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);

      let lineEnd = chunk.length;
      let foundNewline = false;
      const newerParts = carryParts;
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 0x0a) continue;
        const line = decodeLineParts([
          chunk.subarray(i + 1, lineEnd),
          ...(!foundNewline ? newerParts : []),
        ]);
        if (line.trim() && callback(line)) return true;
        lineEnd = i;
        foundNewline = true;
      }

      const olderPrefix = chunk.subarray(0, lineEnd);
      carryParts = olderPrefix.length
        ? (foundNewline ? [olderPrefix] : [olderPrefix, ...newerParts])
        : [];
    }
    const finalLine = decodeLineParts(carryParts);
    return finalLine.length > 0 && callback(finalLine);
  } finally {
    fs.closeSync(fd);
  }
}

function readTailLines(sessionPath) {
  const lines = [];
  forEachLineFromEnd(sessionPath, (line) => {
    lines.push(line);
    return false;
  });
  return lines.reverse().filter(Boolean);
}

function normalizeMessageTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function entryTimestamp(entry) {
  const message = entry?.message && typeof entry.message === "object" ? entry.message : null;
  return normalizeMessageTimestamp(message?.timestamp ?? entry?.timestamp ?? entry?.ts);
}

// 闲不住通过 session:send 写入的送达文本会顶着 user 身份进入会话，
// 但它们不是用户亲手发言，不能拿来把目标窗口“刷”成最近活跃。
function isSelfInjectedPushText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t === "重启！") return true;
  if (/^[📬📦🎁✉]/.test(t)) {
    return /收到来自|给你带了东西|拍了拍你|的一份回礼|的一份礼物|的一条互动|回礼恶作剧/.test(t);
  }
  // brainrot 普通推送沿用生成文本，没有统一 emoji 前缀；识别其固定输出格式。
  return /^(?:讲个冷笑话：|考考你：|你知道吗：|突然想到：|如果世界上有10种人)/.test(t);
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
        const tailStart = Math.max(ALL_READ_HEAD, stat.size - (ALL_READ_MAX - ALL_READ_HEAD));
        const tailLen = stat.size - tailStart;
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tail.length, tailStart);
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
    const limit = Number.isInteger(max) && max > 0 ? max : 0;
    if (!limit) return [];
    const messages = [];
    forEachLineFromEnd(sessionPath, (line) => {
      try {
        const msg = extractConversationMessage(JSON.parse(line));
        if (msg) {
          messages.unshift(msg);
          return messages.length >= limit;
        }
      } catch {}
      return false;
    });
    return messages;
  } catch (err) {
    console.error("[解语花] 读取会话失败:", err?.message || err);
    return [];
  }
}

// ─── 最近助手回复（朗读弹窗：最新一条 + 往前最多 5 条） ───
// 返回顺序固定为「最新在前」，调用方传 0 就是默认朗读最新回复。
export function readRecentAssistantMessages(sessionPath, max = 6) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return [];
    const limit = Number.isInteger(max) && max > 0 ? Math.min(max, 20) : 6;
    const messages = [];
    forEachLineFromEnd(sessionPath, (line) => {
      try {
        const entry = JSON.parse(line);
        const msg = extractConversationMessage(entry);
        if (!msg || msg.role !== "assistant") return false;
        const ts = entryTimestamp(entry);
        messages.push({
          content: msg.content,
          ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
          entryId: String(entry.id || entry.entryId || msg.id || "").trim(),
        });
        return messages.length >= limit;
      } catch {
        return false;
      }
    });
    return messages;
  } catch (err) {
    console.error("[解语花] 读取助手回复失败:", err?.message || err);
    return [];
  }
}

// ─── 按稳定身份选择助手回复（朗读合成与列表共用） ───
export function selectRecentAssistantMessage(replies, { index = 0, entryId = "", ts = 0 } = {}) {
  if (!Array.isArray(replies)) return null;
  const id = String(entryId || "").trim();
  if (id) {
    const byId = replies.find((item) => item && item.entryId === id);
    if (byId) return byId;
  }
  const numericTs = Number(ts);
  if (Number.isFinite(numericTs) && numericTs > 0) {
    const byTs = replies.find((item) => item && item.ts === numericTs);
    if (byTs) return byTs;
  }
  if (id || (Number.isFinite(numericTs) && numericTs > 0)) return null;
  return replies[index] || null;
}

// ─── 读会话消息（带时间戳，供分支聊天窗渲染/轮询） ───
// 实验代码保留，正式版当前没有入口。
export function readBranchHistory(sessionPath, limit = 200) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return [];
    const max = Number.isInteger(limit) && limit > 0 ? limit : 0;
    if (!max) return [];
    const collected = [];
    forEachLineFromEnd(sessionPath, (line) => {
      try {
        const entry = JSON.parse(line);
        const msg = extractConversationMessage(entry);
        if (!msg) return false;
        const ts = entryTimestamp(entry);
        collected.push({
          role: msg.role,
          content: msg.content,
          ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
        });
        return collected.length >= max;
      } catch {
        return false;
      }
    });
    collected.reverse();
    return collected;
  } catch (err) {
    console.error("[解语花] 读分支会话失败:", err?.message || err);
    return [];
  }
}

// ─── 最后一条用户消息的时间戳（隐式跳过判定用） ───
// 只看提问归属会话本身有没有新用户消息：用户在提问窗口继续聊 → 返回新时间；
// 用户在别的窗口忙（提问窗口无动静）→ 返回提问前的时间，不误判。
// 新格式 { type, timestamp, message: { role } }，旧格式 { role, ts }。
export function lastUserMessageTs(sessionPath) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return 0;
    let result = 0;
    forEachLineFromEnd(sessionPath, (line) => {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message && typeof entry.message === "object" ? entry.message : entry;
        const extracted = extractConversationMessage(entry);
        if (msg?.role !== "user" || !extracted || isSelfInjectedPushText(extracted.content)) return false;
        const ts = entryTimestamp(entry);
        if (Number.isFinite(ts) && ts > 0) {
          result = ts;
          return true;
        }
      } catch {}
      return false;
    });
    return result;
  } catch {
    return 0;
  }
}

// ─── 最近一个已完成助手回合的输入 entry id（另一枝 fork 用） ───
// 实验代码保留，正式版当前没有入口。
export function lastTurnInputEntryId(sessionPath) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return "";
    const lines = readTailLines(sessionPath);
    let latestUserId = "";
    let latestCompletedId = "";
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message && typeof entry.message === "object" ? entry.message : entry;
        if (msg?.role === "user" && extractConversationMessage(entry)) {
          const id = String(entry.id || entry.entryId || msg.id || "").trim();
          latestUserId = id;
        } else if (msg?.role === "assistant" && latestUserId && extractConversationMessage(entry)) {
          latestCompletedId = latestUserId;
        }
      } catch {}
    }
    return latestCompletedId;
  } catch {
    return "";
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

// ─── 兜底：按 agentId 找最近会话文件（优先最后真实用户消息） ───
export function findLatestSessionPath(agentId) {
  return findLatestSession(agentId).path;
}

// ─── 从 JSONL 尾部找最后一条用户消息（时间+文本，mtime 会被助手回复/推送扰动，不可靠） ───
function getLastUserMsg(sessionPath) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return null;
    let result = null;
    forEachLineFromEnd(sessionPath, (line) => {
      try {
        const entry = JSON.parse(line);
        const rawMessage = entry.message && typeof entry.message === "object" ? entry.message : entry;
        const message = extractConversationMessage(entry);
        if (rawMessage.role !== "user" || !message || isSelfInjectedPushText(message.content)) return false;
        const time = entryTimestamp(entry);
        if (!Number.isFinite(time) || time <= 0) return false;
        result = { time, text: message.content };
        return true;
      } catch {
        return false;
      }
    });
    return result;
  } catch {
    return null;
  }
}

function getLastUserMsgTime(sessionPath) {
  const last = getLastUserMsg(sessionPath);
  return last ? last.time : null;
}

// ─── 粗筛：返回 sessionsDir 下按 mtime 降序的前 maxScan 个 jsonl 候选 ───
// 不读文件内容，只 stat 拿 mtime。最后一条用户消息必然发生在最近读写过的文件里，
// 所以只对候选读尾部找最后用户消息，不必扫全部会话文件（对几百文件的助手省 90%+ IO）。
function recentSessionCandidates(sessionsDir, maxScan = 60) {
  let entries = [];
  let files;
  try {
    files = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const de of files) {
    if (!de.isFile() || !de.name.toLowerCase().endsWith(".jsonl")) continue;
    const full = path.join(sessionsDir, de.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    entries.push({ full, mtime: st.mtimeMs, size: st.size });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, maxScan);
}

const MAX_SCAN_CANDIDATES = 60;

// ─── 某助手最近的会话：优先有用户消息的，兜底 mtime ───
function findLatestSession(agentId) {
  try {
    const sessionsDir = path.join(HANA_HOME, "agents", agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      return { path: "", time: -Infinity, hasUser: false };
    }
    const candidates = recentSessionCandidates(sessionsDir, MAX_SCAN_CANDIDATES);
    if (!candidates.length) return { path: "", time: -Infinity, hasUser: false };

    let userPath = "", userTime = -Infinity;
    let fallbackPath = "", fallbackTime = -Infinity;
    for (const { full, mtime } of candidates) {
      if (mtime > fallbackTime) {
        fallbackTime = mtime;
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

// ─── 从会话路径推断 agentId（…/agents/{agentId}/sessions/xxx.jsonl） ───
export function agentIdFromSessionPath(sessionPath) {
  try {
    const full = path.normalize(String(sessionPath || ""));
    if (!full || path.extname(full).toLowerCase() !== ".jsonl") return "";
    const sessionsDir = path.dirname(full);
    if (path.basename(sessionsDir).toLowerCase() !== "sessions") return "";
    const agentDir = path.dirname(sessionsDir);
    if (path.basename(path.dirname(agentDir)).toLowerCase() !== "agents") return "";
    return path.basename(agentDir);
  } catch {
    return "";
  }
}

// 固定目标的路径校验不能只看字符串层级：符号链接可能把 agents/{id}/sessions
// 指到目录外。先校验目录形状，再用 realpath + stat 把目标钉死在该助手的真实会话目录内。
export function isSessionPathForAgent(sessionPath, agentId) {
  const expected = String(agentId || "").trim();
  if (!expected || agentIdFromSessionPath(sessionPath) !== expected) return false;
  try {
    const fullPath = path.resolve(String(sessionPath || ""));
    const sessionsRoot = path.resolve(path.join(HANA_HOME, "agents", expected, "sessions"));
    const realPath = fs.realpathSync(fullPath);
    const realRoot = fs.realpathSync(sessionsRoot);
    const relative = path.relative(realRoot, realPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    return fs.statSync(realPath).isFile() && path.extname(realPath).toLowerCase() === ".jsonl";
  } catch {
    return false;
  }
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
      const candidates = recentSessionCandidates(sessionsDir, MAX_SCAN_CANDIDATES);
      for (const { full: fp, size } of candidates) {
        if (size === 0) continue;
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

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("session:list timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── 优先走 Hana session:list，拿宿主保存的真实会话标题；再与本地扫描结果合并 ───
export async function listNamedSessions(bus, limit = 8) {
  let fallback = null;
  const getFallback = () => {
    if (!fallback) fallback = listRecentSessions(Math.max(limit * 3, 24));
    return fallback;
  };
  const fallbackByPath = () => new Map(
    getFallback().map((item) => [path.normalize(path.resolve(item.sessionPath)), item]),
  );
  try {
    if (!bus || typeof bus.request !== "function") return getFallback().slice(0, limit);
    const result = await withTimeout(
      Promise.resolve().then(() => bus.request("session:list", {}, { timeoutMs: 2500 })),
      2500,
    );
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    const byPath = fallbackByPath();
    const normalized = sessions
      .filter((item) => item && typeof item.path === "string" && item.path)
      .map((item) => {
        const sessionPath = path.resolve(item.path);
        const inferredAgentId = agentIdFromSessionPath(sessionPath);
        const matched = byPath.get(path.normalize(sessionPath));
        const agentId = String(item.agentId || inferredAgentId || matched?.agentId || "");
        const title = String(item.title || item.firstMessage || matched?.title || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 40);
        const modified = normalizeMessageTimestamp(item.modified ?? 0);
        return {
          agentId,
          agentName: String(item.agentName || matched?.agentName || agentDisplayName(agentId) || agentId || ""),
          sessionPath,
          title,
          lastUserTime: matched?.lastUserTime || (Number.isFinite(modified) && modified > 0 ? modified : 0),
        };
      });

    // session:list 可能只给当前/部分窗口，本地扫描负责补齐；同一路径以宿主标题为准，
    // 但活跃排序优先保留本地找到的最后真实用户消息时间，避免 assistant/mtime 抢走位置。
    const merged = new Map(getFallback().map((item) => [path.normalize(path.resolve(item.sessionPath)), item]));
    for (const item of normalized) {
      const key = path.normalize(path.resolve(item.sessionPath));
      const previous = merged.get(key);
      merged.set(key, {
        ...previous,
        ...item,
        title: item.title || previous?.title || "",
        agentName: item.agentName || previous?.agentName || "",
        lastUserTime: previous?.lastUserTime || item.lastUserTime || 0,
      });
    }
    return [...merged.values()]
      .sort((a, b) => b.lastUserTime - a.lastUserTime)
      .slice(0, limit);
  } catch {
    return getFallback().slice(0, limit);
  }
}

// ─── 助手列表（设置页按需刷新，不缓存，保证新助手无需重启就能出现） ───
export function listAgents() {
  try {
    const agentsDir = path.join(HANA_HOME, "agents");
    if (!fs.existsSync(agentsDir)) return [];
    return fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name)
      .map((entry) => ({ id: entry.name, name: agentDisplayName(entry.name) || entry.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
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
