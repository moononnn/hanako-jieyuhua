// 解语花 — 数据读写模块
// 所有持久化读写集中在这里：配置 + 待用推荐（pending）
// 写锁串行化（防并发写损坏，坑 47）；读损坏自愈（保留备份）

import fs from "node:fs";
import path from "node:path";
import {
  ASK_MAX_PENDING,
  ASK_TTL_MS,
  normalizeAskEntry,
  normalizeAskOptions,
  normalizeAskSelection,
  validateAskInput,
} from "./ask.js";

// ─── 默认配置 ───
export const DEFAULT_CONFIG = {
  presentation: "card",   // 展示方式：card=回复卡片（默认）/ ball=解语花悬浮球 / off=关闭（三档互斥，2026-08-10 起不再有独立总开关）
  mode: "always",          // always=每次都推荐（默认）/ auto=看情况推荐（依赖模型自觉，可能不出卡）
  count: 3,               // 推荐条数 2|3|4
  action: "copy",         // copy=点击复制（默认）/ send=点击直接发送
  guideDismissed: false,  // 新用户指引是否已关闭
  styles: [               // 推荐方向（按条数分配，可通过聊一聊修改）：name = 名字，intent = 意图说明
    { name: "追问/延伸", intent: "顺着话题往下问一句，或延伸到自己关心的事" },
    { name: "分享/感慨", intent: "分享自己的感受或关联的事，带点情绪" },
    { name: "行动/请求", intent: "让助手帮忙做点什么、解释什么、推荐什么" },
    { name: "玩笑/俏皮", intent: "用俏皮、调侃的方式说话" }
  ],
  selectedByCount: {      // 每档条数各自的勾选（记住用户选过哪个）
    2: [0, 1],
    3: [0, 1, 2],
    4: [0, 1, 2, 3]
  },
  model: {
    source: "agent",      // agent=跟随助手当前模型 / hana=从 Hana 模型列表选 / custom=自定义 API
    providerId: "",
    modelId: "",
    custom: {
      baseUrl: "",
      apiKey: "",
      model: "",
      api: "openai-completions"
    }
  },
  tts: {                  // 语音朗读：悬浮球面板「朗读回复」用（分享版三档来源）
    enabled: false,       // 总开关
    source: "auto",       // auto=自动选 Hana 语音模型 / hana=手动选 / custom=自定义
    providerId: "",       // hana 档：选中的 provider id
    model: "",            // hana 档：选中的模型 id
    protocol: "chat",     // custom 档协议：chat=OpenAI 兼容聊天（MiMo 等）/ t2a=MiniMax
    apiKey: "",           // custom 档 API Key（Windows DPAPI；旧 enc: 仅作迁移兼容）
    groupId: "",          // t2a 协议必填（MiniMax GroupId）
    baseUrl: "",          // 自定义接口地址，t2a 留空用 https://api.minimaxi.com
    voiceId: "",          // 兼容旧数据；设置页不再提供全局音色，运行时统一回到模型默认音色
    voiceByAgent: {},      // 助手专属音色：agentId → voiceId，空值回退模型默认音色
    speed: 1.0,           // 语速 0.5~2
    vol: 1.0,             // 音量 0.1~2
    pitch: 0,             // 音调 -12~12
    scope: "whole",       // whole=整条回复 / quoted=只读引号内（「」『』""）
    maxLen: 800           // 朗读字数上限（超出截断，上限 10000）
  }
};

// 勾选索引校验：0~3 整数、去重、最多 4 个；空则按默认
function normalizeSelected(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const idx = [];
  for (const v of raw) {
    const i = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isInteger(i) && i >= 0 && i <= 3 && !idx.includes(i)) idx.push(i);
    if (idx.length >= 4) break;
  }
  return idx.length ? idx : null;
}

// 按条数记忆的勾选：{ 2: [...], 3: [...], 4: [...] }，每档独立
// 数量与条数不一致时按默认顺序补全/截断（count=4 必须 4 个，count=2 只能 2 个）
export function normalizeSelectedByCount(raw) {
  const defaults = { 2: [0, 1], 3: [0, 1, 2], 4: [0, 1, 2, 3] };
  const out = {};
  for (const n of [2, 3, 4]) {
    let idx = normalizeSelected(raw && raw[n]);
    if (!idx) {
      idx = defaults[n].slice();
    } else if (idx.length > n) {
      // 超出条数：截断
      idx = idx.slice(0, n);
    } else if (idx.length < n) {
      // 不足条数：按默认顺序补位，不重复
      for (const d of defaults[n]) {
        if (idx.length >= n) break;
        if (!idx.includes(d)) idx.push(d);
      }
    }
    out[n] = idx;
  }
  return out;
}

// 方向列表校验：[{name, intent}] 对象数组，迁移旧 string[]，补齐默认到 4 个
// name 2~12 字、intent 0~50 字；缺位或非法值用默认补位
export function normalizeStyles(raw) {
  const defaults = structuredClone(DEFAULT_CONFIG.styles);
  if (!Array.isArray(raw)) return defaults;

  const list = [];
  for (let i = 0; i < 4; i++) {
    const s = raw[i];
    const def = defaults[i] || { name: "", intent: "" };
    let entry = null;

    if (typeof s === "string") {
      // 旧 string[] 迁移：保留位置，intent 借用同位置默认
      const name = s.trim();
      if (name && name.length <= 12) {
        entry = { name, intent: def.intent };
      }
    } else if (s && typeof s === "object" && typeof s.name === "string") {
      const name = s.name.trim();
      const intent = typeof s.intent === "string" ? s.intent.trim() : "";
      if (name && name.length <= 12 && intent.length <= 50) {
        entry = { name, intent };
      }
    }

    list.push(entry || def);
  }

  return list;
}

// ─── 数据读写 ───
let _writeLock = Promise.resolve();

/** 串行化写操作：回调内必须是纯同步段（坑 47 纪律） */
export function withDataLock(fn) {
  const run = _writeLock.then(fn);
  _writeLock = run.catch(() => {});
  return run;
}

export function dataFilePath(dataDir) {
  return path.join(dataDir, "data.json");
}

function emptyData() {
  return { config: structuredClone(DEFAULT_CONFIG), pending: {}, askPending: {}, askSkipQueue: [], branchRefs: [] };
}

export function loadData(dataDir) {
  const fp = dataFilePath(dataDir);
  const bak = path.join(dataDir, "data.json.bak");
  // 主文件缺失或损坏时都尝试备份；原子写在崩溃窗口里可能只留下 bak。
  for (const candidate of [fp, bak]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      return normalizeData(raw);
    } catch {
      // 继续尝试下一份；两份都坏了才回默认配置。
    }
  }
  return emptyData();
}

export function saveData(dataDir, data) {
  const fp = dataFilePath(dataDir);
  const bak = path.join(dataDir, "data.json.bak");
  const tmp = `${fp}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let oldMoved = false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const serialized = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmp, serialized, "utf-8");
    // 先把临时文件刷到磁盘，再切换文件名，避免进程中断留下半截 JSON。
    try {
      const fd = fs.openSync(tmp, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch {}

    // Windows 上 rename 无法直接覆盖目标：先把旧主文件原子挪到备份，
    // 新文件切换失败时 loadData 仍能从 data.json.bak 恢复。
    if (fs.existsSync(fp)) {
      try { fs.rmSync(bak, { force: true }); } catch {}
      fs.renameSync(fp, bak);
      oldMoved = true;
    }
    fs.renameSync(tmp, fp);
    return true;
  } catch (err) {
    // 新文件尚未切换成功时尽量恢复原主文件；失败也保留备份供下次启动恢复。
    if (oldMoved && !fs.existsSync(fp) && fs.existsSync(bak)) {
      try { fs.renameSync(bak, fp); } catch {}
    }
    console.error("[解语花] 保存数据失败:", err?.message || err);
    throw err;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

// ─── 另一枝分支引用 ───
const BRANCH_REF_LIMIT = 50;

export function normalizeBranchRef(raw) {
  if (!raw || typeof raw !== "object") return null;
  const sourceNode = raw.sourceNode && typeof raw.sourceNode === "object" ? raw.sourceNode : {};
  const role = ["user", "assistant", "assistant_turn"].includes(sourceNode.role)
    ? sourceNode.role
    : "assistant_turn";
  const node = { role };
  if (role === "assistant_turn") {
    const id = String(sourceNode.turnInputEntryId || "").trim();
    if (id) node.turnInputEntryId = id;
  } else {
    const id = String(sourceNode.entryId || "").trim();
    if (id) node.entryId = id;
  }
  if ((role === "assistant_turn" && !node.turnInputEntryId) || (role !== "assistant_turn" && !node.entryId)) return null;
  const sourceSessionPath = String(raw.sourceSessionPath || "").trim();
  const branchSessionPath = String(raw.branchSessionPath || "").trim();
  if (!sourceSessionPath || !branchSessionPath) return null;
  const now = Date.now();
  return {
    id: String(raw.id || ("branch_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 8))),
    sourceSessionPath,
    sourceSessionId: String(raw.sourceSessionId || ""),
    sourceNode: node,
    branchSessionPath,    branchSessionId: String(raw.branchSessionId || ""),
    title: String(raw.title || "另一枝").slice(0, 80),
    status: ["active", "saved", "archived", "broken"].includes(raw.status) ? raw.status : "active",
    createdAt: Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : now,
  };
}

export function normalizeBranchRefs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeBranchRef).filter(Boolean).slice(0, BRANCH_REF_LIMIT);
}

// ─── 数据归一化（含旧数据迁移） ───
export function normalizeData(raw) {
  const data = (raw && typeof raw === "object") ? raw : {};
  const cfg = normalizeConfig(data.config);
  const pending = (data.pending && typeof data.pending === "object") ? data.pending : {};
  const askPending = {};
  if (data.askPending && typeof data.askPending === "object") {
    for (const [askId, raw] of Object.entries(data.askPending)) {
      const entry = normalizeAskEntry(raw, askId);
      if (entry) askPending[entry.askId] = entry;
    }
  }
  // 旧数据迁移：items 可能是 string[]，统一为 { text, direction }
  for (const entry of Object.values(pending)) {
    if (entry && typeof entry === "object" && Array.isArray(entry.items)) {
      entry.items = normalizeItems(entry.items);
    }
  }
  // 解语花悬浮球缓存（可选，不强制）
  let ballCache = null;
  if (data.ballCache && typeof data.ballCache === "object") {
    const c = data.ballCache;
    if (Array.isArray(c.items) && c.items.length) {
      ballCache = {
        items: normalizeItems(c.items),
        rid: typeof c.rid === "string" ? c.rid : "",
        ts: typeof c.ts === "number" ? c.ts : 0,
        agentId: typeof c.agentId === "string" ? c.agentId : "",
        sessionPath: typeof c.sessionPath === "string" ? c.sessionPath : "",
      };
    }
  }
  // 固定的目标会话（null=跟随最近对话）
  let pinnedTarget = null;
  if (data.pinnedTarget && typeof data.pinnedTarget === "object") {
    const p = data.pinnedTarget;
    if (typeof p.sessionPath === "string" && p.sessionPath) {
      pinnedTarget = {
        agentId: typeof p.agentId === "string" ? p.agentId : "",
        sessionPath: p.sessionPath,
        title: typeof p.title === "string" ? p.title : "",
      };
    }
  }
  // 最近一次重命名记录（退回用，null=无可退回）
  let lastRename = null;
  if (data.lastRename && typeof data.lastRename === "object") {
    const r = data.lastRename;
    if (typeof r.sessionPath === "string" && r.sessionPath) {
      lastRename = {
        sessionPath: r.sessionPath,
        agentId: typeof r.agentId === "string" ? r.agentId : "",
        oldTitle: typeof r.oldTitle === "string" ? r.oldTitle : "",
        newTitle: typeof r.newTitle === "string" ? r.newTitle : "",
        ts: typeof r.ts === "number" ? r.ts : 0,
      };
    }
  }
  // 隐式跳过队列（用户无视弹窗直接对话时登记，轮询时消费）
  const askSkipQueue = Array.isArray(data.askSkipQueue)
    ? data.askSkipQueue.filter((id) => typeof id === "string" && id)
    : [];
  const branchRefs = normalizeBranchRefs(data.branchRefs);
  return { config: cfg, pending, askPending, ballCache, pinnedTarget, lastRename, askSkipQueue, branchRefs };
}

export function normalizeConfig(raw) {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!raw || typeof raw !== "object") return base;

  const cfg = { ...base };

  if (raw.presentation === "card" || raw.presentation === "ball" || raw.presentation === "off") cfg.presentation = raw.presentation;
  if (raw.mode === "auto" || raw.mode === "always") cfg.mode = raw.mode;
  if ([2, 3, 4].includes(raw.count)) cfg.count = raw.count;
  if (raw.action === "send" || raw.action === "copy") cfg.action = raw.action;
  if (typeof raw.guideDismissed === "boolean") cfg.guideDismissed = raw.guideDismissed;
  if (Array.isArray(raw.styles)) cfg.styles = normalizeStyles(raw.styles);
  if (raw.selectedByCount && typeof raw.selectedByCount === "object") {
    cfg.selectedByCount = normalizeSelectedByCount(raw.selectedByCount);
  } else if (Array.isArray(raw.selected)) {
    // 旧字段迁移：只迁移当前条数那档（走补全/截断），其余默认
    cfg.selectedByCount = normalizeSelectedByCount({ [cfg.count]: raw.selected });
  }

  if (raw.model && typeof raw.model === "object") {
    const m = raw.model;
    if (["agent", "hana", "custom"].includes(m.source)) cfg.model.source = m.source;
    if (typeof m.providerId === "string") cfg.model.providerId = m.providerId;
    if (typeof m.modelId === "string") cfg.model.modelId = m.modelId;
    if (m.custom && typeof m.custom === "object") {
      const c = m.custom;
      if (typeof c.baseUrl === "string") cfg.model.custom.baseUrl = c.baseUrl;
      if (typeof c.apiKey === "string") cfg.model.custom.apiKey = c.apiKey;
      if (typeof c.model === "string") cfg.model.custom.model = c.model;
      if (typeof c.api === "string") cfg.model.custom.api = c.api;
    }
  }

  if (raw.tts && typeof raw.tts === "object") {
    cfg.tts = normalizeTts(raw.tts);
  }
  return cfg;
}

// ─── 语音朗读配置归一化（TTS） ───
function numIn(value, min, max, fallback) {
  const n = typeof value === "string" ? parseFloat(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeTtsVoiceByAgent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = [];
  for (const [rawAgentId, rawVoiceId] of Object.entries(raw).slice(0, 100)) {
    const agentId = String(rawAgentId || "").trim();
    const voiceId = typeof rawVoiceId === "string" ? rawVoiceId.trim() : "";
    if (!agentId || agentId.length > 120 || !voiceId || voiceId.length > 200) continue;
    entries.push([agentId, voiceId]);
  }
  return Object.fromEntries(entries);
}

export function normalizeTts(raw) {
  const base = structuredClone(DEFAULT_CONFIG.tts);
  if (!raw || typeof raw !== "object") return base;
  // 老配置迁移：旧版只有 MiniMax 自定义（apiKey/groupId）且没有 source 字段 → 归为 custom/t2a，
  // 避免用户配好的 MiniMax 被静默当成 auto 档（2026-08-18 分享版三档改造后）
  const legacyCustom = !raw.source && (raw.apiKey || raw.groupId);
  const source = raw.source === "hana" ? "hana" : raw.source === "custom" ? "custom" : legacyCustom ? "custom" : "auto";
  const protocol = raw.protocol === "t2a" ? "t2a" : raw.protocol === "chat" ? "chat" : legacyCustom ? "t2a" : "chat";
  return {
    enabled: raw.enabled === true,
    source,
    providerId: typeof raw.providerId === "string" ? raw.providerId : base.providerId,
    model: typeof raw.model === "string" ? raw.model : base.model,
    protocol,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : base.apiKey,
    groupId: typeof raw.groupId === "string" ? raw.groupId : base.groupId,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : base.baseUrl,
    // 旧版全局音色不再作为“跟随默认”的隐式回退，避免升级后试听与实际朗读不一致。
    voiceId: "",
    voiceByAgent: normalizeTtsVoiceByAgent(raw.voiceByAgent),
    speed: numIn(raw.speed, 0.5, 2, base.speed),
    vol: numIn(raw.vol, 0.1, 2, base.vol),
    pitch: numIn(raw.pitch, -12, 12, base.pitch),
    scope: raw.scope === "quoted" ? "quoted" : "whole",
    maxLen: Math.round(numIn(raw.maxLen, 20, 10000, base.maxLen))
  };
}

// ─── 配置读写 ───
export function getConfig(dataDir) {
  return loadData(dataDir).config;
}

export function setConfig(dataDir, patch) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    data.config = normalizeConfig({ ...data.config, ...patch, model: { ...data.config.model, ...(patch.model || {}) } });
    saveData(dataDir, data);
    return data.config;
  });
}

// 语音配置单独走同一把写锁，避免「全局保存」与「助手专属音色」并发时互相覆盖。
export function updateTtsConfig(dataDir, patchOrUpdater) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const current = data.config.tts || structuredClone(DEFAULT_CONFIG.tts);
    const patch = typeof patchOrUpdater === "function" ? patchOrUpdater(current) : patchOrUpdater;
    data.config = normalizeConfig({
      ...data.config,
      tts: { ...current, ...(patch && typeof patch === "object" ? patch : {}) },
    });
    saveData(dataDir, data);
    return data.config.tts;
  });
}

// ─── 推荐暂存（pending） ───
// items 结构：v0.2.0 起为 { text, direction }[]；旧 string[] 自动迁移
function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => {
      if (typeof it === "string") return { text: it.trim(), direction: "" };
      if (it && typeof it === "object" && typeof it.text === "string") {
        return {
          text: it.text.trim(),
          direction: typeof it.direction === "string" ? it.direction.trim() : ""
        };
      }
      return null;
    })
    .filter((it) => it && it.text.length > 0 && it.text.length <= 80)
    .slice(0, 4);
}

export function createPending(dataDir, { items, sessionId, sessionPath }) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const rid = "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const entry = {
      items: normalizeItems(items),
      sessionId: sessionId || "",
      sessionPath: sessionPath || "",
      ts: Date.now(),
      used: false
    };
    data.pending[rid] = entry;
    // 只保留最近 20 条，防无限膨胀
    const keys = Object.keys(data.pending);
    while (keys.length > 20) {
      const oldest = keys.sort((a, b) => (data.pending[a].ts || 0) - (data.pending[b].ts || 0))[0];
      delete data.pending[oldest];
      keys.splice(keys.indexOf(oldest), 1);
    }
    saveData(dataDir, data);
    return { rid, entry };
  });
}

export function getPending(dataDir, rid) {
  const data = loadData(dataDir);
  return data.pending[rid] || null;
}

export function markPendingUsed(dataDir, rid) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const entry = data.pending[rid];
    if (!entry) return false;
    entry.used = true;
    saveData(dataDir, data);
    return true;
  });
}

// ─── 另一枝分支引用持久化 ───
export function createBranchRef(dataDir, branch) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const entry = normalizeBranchRef(branch);
    if (!entry) throw new Error("分支引用无效");
    data.branchRefs = [entry, ...normalizeBranchRefs(data.branchRefs)]
      .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index)
      .slice(0, BRANCH_REF_LIMIT);
    saveData(dataDir, data);
    return entry;
  });
}

export function listBranchRefs(dataDir) {
  return normalizeBranchRefs(loadData(dataDir).branchRefs);
}

// ─── 提问暂存（askPending） ───
function pruneAskPendingObject(askPending, now = Date.now()) {
  let removed = 0;
  for (const [askId, entry] of Object.entries(askPending || {})) {
    if (!entry || !Number.isFinite(entry.ts) || now - entry.ts >= ASK_TTL_MS) {
      delete askPending[askId];
      removed++;
    }
  }
  const keys = Object.keys(askPending).sort((a, b) => (askPending[a].ts || 0) - (askPending[b].ts || 0));
  while (keys.length > ASK_MAX_PENDING) {
    delete askPending[keys.shift()];
    removed++;
  }
  return removed;
}

export function createAskPending(dataDir, {
  question,
  options,
  header,
  selectionMode,
  minSelections,
  maxSelections,
  sessionId,
  sessionPath,
}) {
  return withDataLock(() => {
    const error = validateAskInput({ question, options, header, selectionMode, minSelections, maxSelections });
    if (error) throw new Error(error);
    const normalizedOptions = normalizeAskOptions(options);
    const selection = normalizeAskSelection({ selectionMode, minSelections, maxSelections }, normalizedOptions.length);
    const data = loadData(dataDir);
    const askId = "ask_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const entry = {
      askId,
      question: String(question).trim(),
      options: normalizedOptions,
      header: typeof header === "string" ? header.trim() : "",
      ...selection,
      sessionId: typeof sessionId === "string" ? sessionId : "",
      sessionPath: typeof sessionPath === "string" ? sessionPath : "",
      ts: Date.now(),
      consumed: false,
      answer: null,
    };
    data.askPending[askId] = entry;
    pruneAskPendingObject(data.askPending);
    saveData(dataDir, data);
    return { askId, entry };
  });
}

export function getAskPending(dataDir, askId) {
  if (!askId) return null;
  const entry = loadData(dataDir).askPending[askId] || null;
  if (!entry || !Number.isFinite(entry.ts) || Date.now() - entry.ts >= ASK_TTL_MS) return null;
  return entry;
}

export function listAskPending(dataDir) {
  const now = Date.now();
  return Object.values(loadData(dataDir).askPending)
    .filter((entry) => entry && entry.consumed !== true && Number.isFinite(entry.ts) && now - entry.ts < ASK_TTL_MS)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map(({ delivery, ...entry }) => entry);
}

function makeAskDeliveryTaskId(askId) {
  return `ask-${askId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 为 Deferred 回传建立持久化幂等记录。外部回传成功而本地落盘失败时，
// 下次重试继续使用同一个 taskId，避免每次都注册一个新通道。
export function beginAskDelivery(dataDir, askId, { choice, mode, resultText } = {}) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const entry = data.askPending[askId];
    if (!entry || entry.consumed === true || !Number.isFinite(entry.ts) || Date.now() - entry.ts >= ASK_TTL_MS) {
      return { ok: false, error: "提问不存在或已失效" };
    }
    if (entry.delivery && entry.delivery.taskId) {
      return {
        ok: true,
        resumed: true,
        taskId: entry.delivery.taskId,
        registered: entry.delivery.registered === true,
        choice: entry.delivery.choice,
        mode: entry.delivery.mode,
        resultText: entry.delivery.resultText,
        sessionId: entry.sessionId,
        sessionPath: entry.sessionPath,
      };
    }
    const delivery = {
      taskId: makeAskDeliveryTaskId(askId),
      choice: Array.isArray(choice)
        ? choice.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
        : String(choice || ""),
      mode: String(mode || "option"),
      resultText: String(resultText || ""),
      registered: false,
      startedAt: Date.now(),
    };
    entry.delivery = delivery;
    saveData(dataDir, data);
    return {
      ok: true,
      resumed: false,
      taskId: delivery.taskId,
      registered: false,
      choice: delivery.choice,
      mode: delivery.mode,
      resultText: delivery.resultText,
      sessionId: entry.sessionId,
      sessionPath: entry.sessionPath,
    };
  });
}

export function markAskDeliveryRegistered(dataDir, askId, taskId) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const entry = data.askPending[askId];
    if (!entry || entry.consumed === true || entry.delivery?.taskId !== taskId) return false;
    if (!entry.delivery.registered) {
      entry.delivery.registered = true;
      saveData(dataDir, data);
    }
    return true;
  });
}

export function completeAskDelivery(dataDir, askId, taskId, answer) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const entry = data.askPending[askId];
    if (!entry) return false;
    if (entry.consumed === true) return true;
    if (!entry.delivery || entry.delivery.taskId !== taskId) return false;
    entry.consumed = true;
    entry.answer = answer && typeof answer === "object" ? answer : null;
    entry.delivery = null;
    saveData(dataDir, data);
    return true;
  });
}

export function markAskConsumed(dataDir, askId, answer) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const entry = data.askPending[askId];
    if (!entry || entry.consumed === true || !Number.isFinite(entry.ts) || Date.now() - entry.ts >= ASK_TTL_MS) {
      return false;
    }
    entry.consumed = true;
    entry.answer = answer && typeof answer === "object" ? answer : null;
    entry.delivery = null;
    saveData(dataDir, data);
    return true;
  });
}

// 用户折叠提问 = 放弃：除了当前题，把比它更旧的未消费题也一起作废。
// 旧题只显示最新的，用户根本没看到过更旧的，留着只会造成「折叠完又弹旧题」；
// 折叠动作的语义是「别烦我」，一次清干净。返回 { ok, count }。
export function dismissAskWithOlder(dataDir, askId) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const target = data.askPending[askId];
    if (!target || target.consumed === true || !Number.isFinite(target.ts) || Date.now() - target.ts >= ASK_TTL_MS) {
      return { ok: false, count: 0 };
    }
    let count = 0;
    for (const [id, entry] of Object.entries(data.askPending)) {
      if (!entry || entry.consumed === true || !Number.isFinite(entry.ts)) continue;
      if (id === askId || entry.ts <= target.ts) {
        entry.consumed = true;
        entry.answer = { mode: "skip", choice: "" };
        count++;
      }
    }
    saveData(dataDir, data);
    return { ok: true, count };
  });
}

// ── 隐式跳过队列 ──
// 用户无视提问面板、直接在对话框继续交流时，observer 登记跳过请求，
// 代理在悬浮球轮询 /ask/pending 时消费（deferred 回传「跳过，不做选择」）。
// 失败保留在队列里，下一轮轮询重试；TTL 由 askPending 自身兜底。
export function queueAskSkip(dataDir, askId) {
  if (!askId || typeof askId !== "string") return;
  return withDataLock(() => {
    const data = loadData(dataDir);
    const queue = Array.isArray(data.askSkipQueue) ? data.askSkipQueue : [];
    if (!queue.includes(askId)) queue.push(askId);
    data.askSkipQueue = queue;
    saveData(dataDir, data);
  });
}

export function listAskSkips(dataDir) {
  const queue = loadData(dataDir).askSkipQueue;
  return Array.isArray(queue) ? queue.filter((id) => typeof id === "string" && id) : [];
}

export function clearAskSkips(dataDir, askIds) {
  if (!Array.isArray(askIds) || askIds.length === 0) return;
  return withDataLock(() => {
    const data = loadData(dataDir);
    const queue = Array.isArray(data.askSkipQueue) ? data.askSkipQueue : [];
    const before = queue.length;
    data.askSkipQueue = queue.filter((id) => !askIds.includes(id));
    if (data.askSkipQueue.length !== before) saveData(dataDir, data);
  });
}

export function pruneAskPending(dataDir) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    const removed = pruneAskPendingObject(data.askPending);
    if (removed) saveData(dataDir, data);
    return removed;
  });
}
