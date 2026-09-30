// 解语花 — 排队插话
// 用户在悬浮球弹窗里写下一句想说的话，点发送后不立刻插话，而是排队挂起；
// 主对话框这一轮回复一结束，就自动把这句以 user 身份发进会话。
//
// 机制借鉴闲不住的普通互动/礼物投递队列（event + tick + session_busy 门），
// 但语义不同：插话要的是「原话、user 身份、进对话流」，
// 所以走 session:send，不用 deferred 通道（deferred 注入的是 hana-background-result，
// 模型会读成「系统告诉我的后台结果」，不是用户说的话）。
//
// 文件预算豁免：排队插话的状态机（入队/认领/送达/语境漂移作废/超时对账）聚合在一条时序里，
// 与 resume.js、zhujian.js 同类保持单体。

import fs from "node:fs";
import { loadData, saveData, withDataLock } from "./data.js";
import { extractConversationMessage } from "./session.js";

export const QUEUE_TICK_MS = 3000;
export const QUEUE_BUSY_RETRY_MS = 3000;
export const QUEUE_ERROR_RETRY_MS = 5000;
export const QUEUE_REQUEST_TIMEOUT_MS = 8000;
export const QUEUE_STALE_SENDING_MS = 30000;
export const QUEUE_DONE_HISTORY_MAX = 20;
export const QUEUE_TEXT_MAX = 500;
export const QUEUE_LOOP_MAX = 50;         // 循环轮数上限，跟轮末续接同一个天花板
export const QUEUE_LOOP_GAP_MS = 1500;    // 发完到下一轮认领的最小间隔：给宿主时间进入生成态，否则两轮挤在一起

const TERMINAL = new Set(["sent", "skipped"]);

let sequence = 0;

function textOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorText(error) {
  return error?.message || String(error || "未知错误");
}

export function isBusyError(error) {
  return /session_busy|busy/i.test(errorText(error));
}

export function isTimeoutError(error) {
  return error?.code === "QUEUE_TIMEOUT" || /超时|timeout/i.test(errorText(error));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label}超时（${ms}ms）`);
      error.code = "QUEUE_TIMEOUT";
      reject(error);
    }, ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

/** 轮数夹取：0~QUEUE_LOOP_MAX 的整数。空值走 fallback，别把「没写」当成「跑完了」。 */
export function normalizeRepeat(value, fallback = 1) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(QUEUE_LOOP_MAX, Math.floor(n)));
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = textOrEmpty(raw.text);
  if (!text) return null;
  const status = TERMINAL.has(raw.status) || raw.status === "sending" ? raw.status : "pending";
  // 老数据没有这两个字段：loopTotal 缺失 = 普通项（1 轮）；repeat 缺失跟随 loopTotal，
  // 不能回落成 0，否则一条坏了字段的循环项会被当成「已跑完」直接收尾。
  const loopTotal = normalizeRepeat(raw.loopTotal);
  const repeat = raw.repeat === undefined || raw.repeat === null ? loopTotal : normalizeRepeat(raw.repeat, loopTotal);
  return {
    id: textOrEmpty(raw.id) || `q${Date.now().toString(36)}${(sequence++).toString(36)}`,
    text,
    sessionPath: textOrEmpty(raw.sessionPath),
    sessionId: textOrEmpty(raw.sessionId),
    agentName: textOrEmpty(raw.agentName),
    queuedAt: Number.isFinite(Number(raw.queuedAt)) ? Number(raw.queuedAt) : 0,
    sendingAt: Number(raw.sendingAt) || 0,
    notBefore: Number(raw.notBefore) || 0,
    status,
    attempts: Number.isFinite(Number(raw.attempts)) ? Math.max(0, Number(raw.attempts)) : 0,
    lastError: textOrEmpty(raw.lastError),
    sentAt: Number.isFinite(Number(raw.sentAt)) ? Number(raw.sentAt) : 0,
    skipReason: textOrEmpty(raw.skipReason),
    loopTotal,
    repeat,
  };
}

/**
 * 归一化整条队列：丢弃脏数据、回收卡在 sending 的陈旧项、裁剪已完结历史。
 * 不静默删 pending —— 用户排队的句子必须活到送达或作废。
 */
export function normalizeQueueInsert(raw, now = Date.now(), staleSendingMs = QUEUE_STALE_SENDING_MS) {
  const source = Array.isArray(raw?.items) ? raw.items : [];
  const items = [];
  for (const entry of source) {
    const item = normalizeItem(entry);
    if (!item) continue;
    if (item.status === "sending" && now - (item.sendingAt || item.queuedAt) > staleSendingMs) {
      item.status = "pending";
      item.lastError = "上次投递没回音，重新排队";
    }
    items.push(item);
  }
  const live = items.filter((item) => !TERMINAL.has(item.status));
  const done = items.filter((item) => TERMINAL.has(item.status)).slice(-QUEUE_DONE_HISTORY_MAX);
  return { items: [...live, ...done] };
}

/** 入队：同会话已有同样的排队句时不重复排，直接返回既有那条。rounds > 1 时入队的是循环项。 */
export function enqueueInsert(data, { text, sessionPath, sessionId, agentName, rounds } = {}, now = Date.now()) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return { ok: false, error: "写点什么再发嘛" };
  if (raw.length > QUEUE_TEXT_MAX) return { ok: false, error: `太长了，精简到 ${QUEUE_TEXT_MAX} 字以内吧` };
  const path = textOrEmpty(sessionPath);
  if (!path) return { ok: false, error: "找不到要发进哪个对话，换个窗口再试" };

  const queue = normalizeQueueInsert(data?.queueInsert, now);
  const duplicated = queue.items.find(
    (item) => (item.status === "pending" || item.status === "sending")
      && item.sessionPath === path && normalizeText(item.text) === raw,
  );
  if (duplicated) {
    return {
      ok: true,
      duplicated: true,
      looping: (Number(duplicated.loopTotal) || 1) > 1,
      item: duplicated,
      queue,
    };
  }

  const loopTotal = Math.max(1, normalizeRepeat(rounds));
  const item = normalizeItem({
    id: `q${now.toString(36)}${(sequence++).toString(36)}`,
    text: raw,
    sessionPath: path,
    sessionId,
    agentName,
    queuedAt: now,
    status: "pending",
    loopTotal,
    repeat: loopTotal,
  });
  const next = { items: [...queue.items, item] };
  return { ok: true, duplicated: false, looping: loopTotal > 1, item, queue: next };
}

/** 认领：同会话 FIFO，只取一条；避免并发重复投递同一条。 */
export function claimNextInsert(queue, { sessionPath = "", now = Date.now() } = {}) {
  const normalized = normalizeQueueInsert(queue, now);
  const wanted = textOrEmpty(sessionPath);
  const index = normalized.items.findIndex(
    (item) => item.status === "pending" && isReadyNow(item, now) && (!wanted || pathKey(item.sessionPath) === pathKey(wanted)),
  );
  if (index < 0) return { item: null, queue: normalized };
  const items = [...normalized.items];
  const item = { ...items[index], status: "sending", sendingAt: now, attempts: (items[index].attempts || 0) + 1 };
  items[index] = item;
  return { item, queue: { items } };
}

export function markInsertSent(queue, id, now = Date.now()) {
  return patchInsert(queue, id, { status: "sent", sentAt: now, lastError: "" });
}

/**
 * 投递成功后的结算：普通项收尾；循环项把剩余轮数减一后重排回 pending，等下一轮。
 *
 * 判断「这一条是不是循环项」必须看 loopTotal，不能看剩余 repeat：
 * 循环项的最后一轮 repeat 正好等于 1，用剩余轮数判断会让它掉回普通分支直接被收尾，
 * 结果是设 N 轮只发出 N-1 轮（外部改造者在同一处栽过，这里刻意绕开）。
 */
export function settleInsertAfterSend(queue, id, now = Date.now(), gapMs = QUEUE_LOOP_GAP_MS) {
  const normalized = normalizeQueueInsert(queue, now);
  const item = normalized.items.find((entry) => entry.id === id);
  if (!item) return normalized;
  const remaining = (Number(item.repeat) || 0) - 1;
  if (remaining <= 0) {
    return patchInsert(normalized, id, { repeat: 0, status: "sent", sentAt: now, lastError: "" });
  }
  return patchInsert(normalized, id, {
    repeat: remaining,
    status: "pending",
    sendingAt: 0,
    queuedAt: now,
    notBefore: now + Math.max(0, Number(gapMs) || 0),
    attempts: 0,
    lastError: "",
  });
}

export function markInsertSkipped(queue, id, skipReason) {
  return patchInsert(queue, id, { status: "skipped", skipReason: textOrEmpty(skipReason) || "这次没发出去" });
}

/** 用户主动取消：只有还在 pending 的句子能撤回，已开始投递时不能假装取消成功。 */
export function cancelPendingInsert(queue, id) {
  const normalized = normalizeQueueInsert(queue);
  const item = normalized.items.find((entry) => entry.id === id);
  if (!item) return { ok: false, error: "这句已经不在队列里了", queue: normalized };
  if (item.status !== "pending") {
    return { ok: false, error: item.status === "sending" ? "这句已经在发送，来不及取消了" : "这句已经处理完了", queue: normalized };
  }
  return {
    ok: true,
    text: item.text,
    queue: markInsertSkipped(normalized, id, "已撤下来"),
  };
}

export function releaseInsert(queue, id, lastError, delayUntil = 0) {
  return patchInsert(queue, id, { status: "pending", sendingAt: 0, lastError: textOrEmpty(lastError), notBefore: delayUntil });
}

function patchInsert(queue, id, patch) {
  const normalized = normalizeQueueInsert(queue);
  const items = normalized.items.map((item) => {
    if (item.id !== id) return item;
    const next = { ...item, ...patch };
    return next;
  });
  return { items };
}

// 重试等待时间落盘，重启后也不能绕过退避。
export function isReadyNow(item, now = Date.now()) {
  return !item?.notBefore || now >= Number(item.notBefore);
}

export function withNotBefore(item, until) {
  return { ...item, notBefore: Number(until) || 0 };
}

/** 弹窗状态查询用：给某会话一条最直接的当前状态描述。 */
export function describeInsertState(queue, sessionPath, now = Date.now()) {
  const path = textOrEmpty(sessionPath);
  const items = normalizeQueueInsert(queue, now).items;
  const mine = items.filter((item) => !path || item.sessionPath === path);
  // 队列落盘时最新的一条排在最前，不能靠位置取“最后一条”，得按时间挑真正最新/最老的那条；
  // 取错会永远回报旧编号，弹窗对不上 id 就一直停在“存好了”。
  const stamp = (item) => Math.max(Number(item?.sentAt) || 0, Number(item?.queuedAt) || 0);
  const newest = (list) => list.reduce((best, item) => (!best || stamp(item) >= stamp(best) ? item : best), null);
  const pending = newest(mine.filter((item) => item.status === "pending" || item.status === "sending"));
  if (pending) {
    return {
      state: pending.status === "sending" ? "sending" : "pending",
      text: pending.text,
      id: pending.id,
      sessionPath: pending.sessionPath,
      loopTotal: Number(pending.loopTotal) || 1,
      repeat: Number(pending.repeat) || 1,
    };
  }
  const last = newest(mine.filter((item) => TERMINAL.has(item.status)));
  if (!last) return { state: "empty" };
  const loopTotal = Number(last.loopTotal) || 1;
  if (last.status === "sent") return { state: "sent", text: last.text, id: last.id, sessionPath: last.sessionPath, at: last.sentAt, loopTotal };
  return { state: "skipped", text: last.text, id: last.id, sessionPath: last.sessionPath, reason: last.skipReason, at: last.sentAt, loopTotal };
}

// ─── 会话文件对账 ───

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 读会话文件里 queuedAt 之后的 user 消息。
 * 从文件尾按完整行向前扫，长会话只读尾部若干字节，避免整文件读进内存。
 */
export function readUserMessagesAfter(sessionPath, sinceMs, maxBytes = 4 * 1024 * 1024) {
  try {
    let raw = fs.readFileSync(sessionPath);
    if (raw.length > maxBytes) raw = raw.subarray(raw.length - maxBytes);
    const since = Number(sinceMs) || 0;
    return raw
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => {
        try {
          const record = JSON.parse(line);
          const message = extractConversationMessage(record);
          if (message?.role !== "user") return null;
          const ts = normalizeTimestamp(record?.message?.timestamp ?? record.timestamp ?? record.ts);
          if (since > 0 && (ts === null || ts < since)) return null;
          return { text: normalizeText(message.content), timestamp: ts };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return null; // 读不到不等于没有，交给调用方按「无法判定」处理
  }
}

/**
 * 语境漂移判定：排队期间用户（或别的插件）已经往这个会话发过别的 user 消息，
 * 这句插话就变成隔轮的旧话，硬发出去语义错位。读不到文件时返回 null 表示「判不了，放行」。
 * 循环项也走这一关：同一句自己发的不算「别人接过话」，但用户中途插嘴就该停。
 */
export function detectContextDrift(item, userMessages, { looping = false } = {}) {
  if (!Array.isArray(userMessages)) return null;
  const mine = normalizeText(item?.text);
  const others = userMessages.filter((msg) => normalizeText(msg.text) !== mine);
  if (!others.length) return null;
  const preview = normalizeText(others[others.length - 1].text).slice(0, 20);
  return {
    drift: true,
    reason: looping
      ? `你接过话了（${preview}…），循环就停在这儿`
      : `你自己已经接过话（${preview}…），这句就不重复发了`,
  };
}

/** 超时对账：同一条原文已经以 user 身份落进会话就算送达，不重复发。 */
export function hasLanded(userMessages, text) {
  if (!Array.isArray(userMessages)) return false;
  const mine = normalizeText(text);
  return userMessages.some((msg) => normalizeText(msg.text) === mine);
}

// ─── 管理器：事件唤醒 + 定时兜底 + 认领投递 ───

function finalTurnEvent(event) {
  const stopReason = event?.message?.stopReason ?? event?.stopReason ?? null;
  return !stopReason || stopReason === "stop";
}

function pathKey(value) {
  const text = textOrEmpty(value);
  return text ? text.replace(/\\/g, "/").toLowerCase() : "";
}

let activeManager = null;

/** 插件启动时登记当前投递器，路由层（入队后立即踢一次）靠它拿到同一个实例。 */
export function getQueueInsertManager() {
  return activeManager;
}

export class QueueInsertManager {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.bus = options.bus || null;
    this.tickMs = Number(options.tickMs) > 0 ? Number(options.tickMs) : QUEUE_TICK_MS;
    this.busyRetryMs = Number.isFinite(Number(options.busyRetryMs)) ? Math.max(0, Number(options.busyRetryMs)) : QUEUE_BUSY_RETRY_MS;
    this.errorRetryMs = Number.isFinite(Number(options.errorRetryMs)) ? Math.max(0, Number(options.errorRetryMs)) : QUEUE_ERROR_RETRY_MS;
    this.requestTimeoutMs = Number(options.requestTimeoutMs) > 0 ? Number(options.requestTimeoutMs) : QUEUE_REQUEST_TIMEOUT_MS;
    this.staleSendingMs = Number(options.staleSendingMs) > 0 ? Number(options.staleSendingMs) : QUEUE_STALE_SENDING_MS;
    this.loopGapMs = Number.isFinite(Number(options.loopGapMs)) ? Math.max(0, Number(options.loopGapMs)) : QUEUE_LOOP_GAP_MS;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this._started = false;
    this._timer = null;
    this._off = null;
    this._drainPromise = null;
    this._kickTimer = null;
    this._log = options.log || console;
  }

  start() {
    if (this._started) return this.stop.bind(this);
    this._started = true;
    if (!this.bus || typeof this.bus.request !== "function" || !this.dataDir) {
      this._log.warn?.("[解语花] 排队插话等待 bus，暂不启动投递");
      this._started = false;
      return this.stop.bind(this);
    }
    if (activeManager === this) activeManager = null;
    activeManager = this;
    if (typeof this.bus.subscribe === "function") {
      try {
        this._off = this.bus.subscribe((event, scopedSessionPath) => {
          try {
            const type = event?.type;
            const released = type === "agent_end"
              || (type === "session_status" && event?.isStreaming === false)
              || (type === "turn_end" && finalTurnEvent(event));
            if (released) this.kick(scopedSessionPath || "");
          } catch (error) {
            this._log.warn?.("[解语花] 排队插话事件处理失败:", errorText(error));
          }
        });
      } catch (error) {
        this._log.warn?.("[解语花] 排队插话订阅失败，将使用定时兜底:", errorText(error));
      }
    }
    this._timer = setInterval(() => {
      this.drain().catch((error) => {
        this._log.error?.("[解语花] 排队插话轮询失败:", errorText(error));
      });
    }, this.tickMs);
    this._timer.unref?.();
    this.kick();
    return this.stop.bind(this);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._kickTimer) clearTimeout(this._kickTimer);
    this._timer = null;
    this._kickTimer = null;
    try { this._off?.(); } catch {}
    this._off = null;
    this._started = false;
    if (activeManager === this) activeManager = null;
  }

  /** 唤醒投递：只针对刚释放的那个会话，没带路径就全量排。 */
  kick(sessionPath = "") {
    this._wanted = this._wanted || new Set();
    this._allPaths = this._allPaths || false;
    const key = pathKey(sessionPath);
    if (key) this._wanted.add(key);
    else this._allPaths = true;
    if (!this._started || this._kickTimer) return;
    this._kickTimer = setTimeout(() => {
      this._kickTimer = null;
      this.drain().catch((error) => {
        this._log.error?.("[解语花] 排队插话投递失败:", errorText(error));
      });
    }, 0);
    this._kickTimer.unref?.();
  }

  drain() {
    if (this._drainPromise) return this._drainPromise;
    // 没被事件指定过会话（首次全量、定时兜底）时 wanted 为空 → 当作全量排，别把队列全过滤掉。
    const pendingPaths = this._wanted || new Set();
    const wanted = this._allPaths || pendingPaths.size === 0 ? null : new Set(pendingPaths);
    this._wanted = new Set();
    this._allPaths = false;
    this._drainPromise = this._drainOnce(wanted).finally(() => {
      this._drainPromise = null;
    });
    return this._drainPromise;
  }

  _updateItem(id, update) {
    return withDataLock(() => {
      const data = loadData(this.dataDir);
      if (!data.queueInsert?.items?.some((entry) => entry.id === id)) return;
      data.queueInsert = update(data.queueInsert);
      saveData(this.dataDir, data);
    });
  }

  async _drainOnce(wantedPaths) {
    const now = this.now();
    let item = null;
    await withDataLock(() => {
      const data = loadData(this.dataDir);
      const queue = normalizeQueueInsert(data.queueInsert, now, this.staleSendingMs);
      const pending = queue.items.find((entry) => entry.status === "pending"
        && isReadyNow(entry, now) && (!wantedPaths || wantedPaths.has(pathKey(entry.sessionPath))));
      if (!pending) return;
      const claimed = claimNextInsert(queue, { sessionPath: pending.sessionPath, now });
      item = claimed.item;
      data.queueInsert = claimed.queue;
      saveData(this.dataDir, data);
    });
    if (!item) return;

    // 投递前对账。
    // 普通项：原文已经在会话里就认作送达，不重复发。
    // 循环项：每轮发的是同一句，上一轮的落盘会被误判成「这一轮已送达」，所以跳过这层；
    //       但语境对账仍然保留——用户中途自己接过话时，循环就该停。
    const looping = (Number(item.loopTotal) || 1) > 1;
    const landed = readUserMessagesAfter(item.sessionPath, item.queuedAt);
    if (!looping && Array.isArray(landed) && hasLanded(landed, item.text)) {
      await this._updateItem(item.id, (queue) => markInsertSent(queue, item.id, this.now()));
      return;
    }
    const drift = detectContextDrift(item, landed, { looping });
    if (drift?.drift) {
      await this._updateItem(item.id, (queue) => markInsertSkipped(queue, item.id, drift.reason));
      this._log.info?.(`[解语花] 排队插话作废：${drift.reason}`);
      return;
    }

    try {
      const result = await withTimeout(
        // sessionPath 是宿主可直接校验的真实会话定位；文件名不等于 Hana 的 sessionId，不能混传。
        Promise.resolve().then(() => this.bus.request("session:send", {
          text: item.text,
          sessionPath: item.sessionPath,
        })),
        this.requestTimeoutMs,
        "session:send",
      );
      if (result?.ok === false || result?.accepted === false) throw new Error(result?.error || "发送失败");
      let remainingAfter = 0;
      await this._updateItem(item.id, (queue) => {
        const settled = settleInsertAfterSend(queue, item.id, this.now(), this.loopGapMs);
        const entry = settled.items.find((candidate) => candidate.id === item.id);
        remainingAfter = entry ? Number(entry.repeat) || 0 : 0;
        return settled;
      });
      if (looping) {
        this._log.info?.(`[解语花] 排队插话已送达（循环 ${Number(item.loopTotal) || 1} 轮，还剩 ${remainingAfter} 轮）→ ${item.sessionPath}`);
      } else {
        this._log.info?.(`[解语花] 排队插话已送达 → ${item.sessionPath}`);
      }
    } catch (error) {
      if (isTimeoutError(error)) {
        // 超时不等于失败：交给下一轮对账，读到原文就算送达。
        await this._updateItem(item.id, (queue) => releaseInsert(queue, item.id, `投递超时，等对账：${errorText(error)}`, this.now() + this.busyRetryMs));
        this.kick(item.sessionPath);
        return;
      }
      const delay = isBusyError(error)
        ? this.busyRetryMs
        : Math.min(60000, this.errorRetryMs * 2 ** Math.min(Math.max(item.attempts - 1, 0), 4));
      await this._updateItem(item.id, (queue) => releaseInsert(queue, item.id, errorText(error), this.now() + delay));
      this._log.warn?.(`[解语花] 排队插话未送达，稍后重试：${errorText(error)}`);
      setTimeout(() => this.kick(item.sessionPath), Math.max(delay, 0)).unref?.();
    }
  }
}
