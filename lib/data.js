// 解语花 — 数据读写模块
// 所有持久化读写集中在这里：配置 + 待用推荐（pending）
// 写锁串行化（防并发写损坏，坑 47）；读损坏自愈（保留备份）

import fs from "node:fs";
import path from "node:path";

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

export function loadData(dataDir) {
  try {
    const fp = dataFilePath(dataDir);
    if (!fs.existsSync(fp)) return { config: structuredClone(DEFAULT_CONFIG), pending: {} };
    const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return normalizeData(raw);
  } catch (err) {
    // 损坏自愈：尝试用备份恢复，备份也没有就用默认
    try {
      const bak = path.join(dataDir, "data.json.bak");
      if (fs.existsSync(bak)) {
        const raw = JSON.parse(fs.readFileSync(bak, "utf-8"));
        return normalizeData(raw);
      }
    } catch {}
    return { config: structuredClone(DEFAULT_CONFIG), pending: {} };
  }
}

export function saveData(dataDir, data) {
  try {
    const fp = dataFilePath(dataDir);
    if (fs.existsSync(fp)) {
      fs.copyFileSync(fp, path.join(dataDir, "data.json.bak"));
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    // 写失败不抛出（调用方继续跑），但留日志痕迹
    console.error("[解语花] 保存数据失败:", err?.message || err);
  }
}

// ─── 数据归一化（含旧数据迁移） ───
export function normalizeData(raw) {
  const data = (raw && typeof raw === "object") ? raw : {};
  const cfg = normalizeConfig(data.config);
  const pending = (data.pending && typeof data.pending === "object") ? data.pending : {};
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
  return { config: cfg, pending, ballCache, pinnedTarget };
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
  return cfg;
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
