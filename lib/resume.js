// 解语花 · 断联续接（resume）检测核心
// 订阅 bus 事件流，识别「异常回合」：turn_end(error)、provider error、会话被异常释放、
// 宿主自动重试耗尽，以及「思考卡死」（2026-08-29 新增：turn_start 后长时间无任何收尾事件）。
// 只负责识别与去重，不发送消息；发送/弹窗由上层处理。
// 事件源与提个醒同款（turn_end / error / session_status / auto_retry_start / auto_retry_end）+ turn_start / message_end。
//
// 行为约定（2026-08-27）：
//   - 用户主动停止（abort/close 等）不算断联，不弹
//   - 宿主自动重试中不打扰；重试成功不弹；重试耗尽才弹
//   - 只对「用户发过消息的会话」建待办，不翻旧账
//   - 悬浮球一键继续 = session:send 发一条用户消息；文本见 RESUME_TEXT

export const RESUME_GRACE_MS = 2500;            // 失败候选先等宿主决定是否进入自动重试
export const RESUME_AUTO_DELAY_MS = 4000;       // 自动续接的延迟（等事件落定）
export const RESUME_AUTO_COOLDOWN_MS = 60_000;  // 同一会话自动续接冷却
export const RESUME_AUTO_MAX_CONSECUTIVE = 3;   // 连续断联超过该次数，该会话降级为只弹窗

// ─── 思考卡死检测（stuck turn · 2026-08-29） ───
// 现象：DeepSeek 等思考模型流式响应中途静默断流——没有 error、没有 turn_end，bus 一片死寂。
// 锚点：turn_start 是回合真正开始生成（LLM 流）的信号；其后任何 message_end / turn_end 都说明回合在健康推进。
// 判定：turn_start 后超过 STUCK_TURN_TIMEOUT_MS 仍无任何收尾事件 → 判定卡死在生成里。
// 收尾事件：message_end（单条消息完成，含工具循环中的中间输出）、turn_end（整个回合结束）、
//   session_status isStreaming=false、新的 session_user_message（用户自己接手）。
export const STUCK_TURN_TIMEOUT_MS = 90_000;    // 90 秒无动静判停滞：够长思考与 subagent 间隙，够短不烦人
export const STUCK_ALERT_COOLDOWN_MS = 60_000;  // 同一会话提醒后 60 秒内不重复（防同一回合重复弹）

/**
 * 思考卡死状态机：turn_start 起心跳，任何收尾事件重置。
 * 与 ResumeTurnTracker 独立（那是失败候选宽限去重；这是无事件停滞），共享 onAlert 通道。
 */
export class StuckTurnTracker {
  constructor({ onAlert, timeoutMs = STUCK_TURN_TIMEOUT_MS, schedule = setTimeout, cancel = clearTimeout } = {}) {
    this._onAlert = typeof onAlert === "function" ? onAlert : () => {};
    this._timeoutMs = Math.max(1, Number(timeoutMs) || STUCK_TURN_TIMEOUT_MS);
    this._schedule = schedule;
    this._cancel = cancel;
    this._states = new Map();
  }

  _get(sessionId) {
    const id = String(sessionId || "").trim() || "unknown";
    let state = this._states.get(id);
    if (!state) {
      state = { sessionId: id, timer: null, startedAt: 0, alertedAt: 0 };
      this._states.set(id, state);
    }
    return state;
  }

  _clearTimer(state) {
    if (state.timer !== null) {
      this._cancel(state.timer);
      state.timer = null;
    }
    state.startedAt = 0;
  }

  /** 回合开始生成（turn_start）：若当前没有在计时，起心跳。同一回合重复的 turn_start 不重启。 */
  onTurnStart(sessionId) {
    const state = this._get(sessionId);
    if (state.timer !== null) return false; // 已在计时，不动
    const now = Date.now();
    // 提醒冷却内：不重复起心跳（等用户处理或新回合）
    if (state.alertedAt > 0 && now - state.alertedAt < STUCK_ALERT_COOLDOWN_MS) return false;
    state.startedAt = now;
    state.timer = this._schedule(() => {
      state.timer = null;
      state.startedAt = 0;
      state.alertedAt = Date.now();
      this._onAlert({ sessionId: state.sessionId, source: "stuck_turn", errorMessage: "" });
    }, this._timeoutMs);
    return true;
  }

  /** 任何收尾/推进事件（message_end / turn_end / streaming=false / 新用户消息）：取消心跳。 */
  onActivity(sessionId) {
    const state = this._states.get(String(sessionId || "").trim());
    if (!state) return false;
    this._clearTimer(state);
    return true;
  }

  /** 测试用：立即触发指定会话的心跳（生产逻辑不调用）。 */
  flush(sessionId) {
    const state = this._states.get(String(sessionId || "").trim());
    if (!state || state.timer === null) return false;
    this._clearTimer(state);
    state.alertedAt = Date.now();
    this._onAlert({ sessionId: state.sessionId, source: "stuck_turn", errorMessage: "" });
    return true;
  }

  dispose() {
    for (const state of this._states.values()) this._clearTimer(state);
    this._states.clear();
  }
}

// 发送文本：分享版统一使用「继续」，避免替用户预设口头禅
export const RESUME_TEXT = "继续";

// ─── 事件解析（纯逻辑，可单元测试） ───
// 事件源：bus.subscribe 全量订阅，回调第二参数 scopedSessionPath（如 .../agents/<id>/sessions/<s>.jsonl）

export function agentIdFromSessionPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return "";
  const match = String(sessionPath).match(/[\\/]agents[\\/]([^\\/]+)[\\/]sessions[\\/]/i);
  return match ? match[1] : "";
}

export function sessionIdFromPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return "";
  const base = String(sessionPath).split(/[\\/]/).pop() || "";
  return base.replace(/\.jsonl$/i, "");
}

const USER_ABORT_REASONS = new Set(["abort", "abort_all", "close", "close_all", "user_abort", "user_cancel"]);

/** 用户明确停止/关闭时，不把控制动作报成断联。 */
export function isUserInitiatedAbortReason(reason) {
  return USER_ABORT_REASONS.has(String(reason || "").trim().toLowerCase());
}

/** 是否最终回合（工具循环的中间轮 stopReason=toolUse 不参与判定）。 */
export function isFinalTurn(stopReason) {
  return !stopReason || stopReason === "stop";
}

function messageError(message) {
  if (!message || typeof message !== "object") return "";
  return String(message.errorMessage || message.error || "").trim();
}

/**
 * 从 turn_end 解析回合信息。
 * @returns {{ agentId, sessionId, sessionPath, text, stopReason, aborted, reason, wasSuccessful } | null}
 */
export function parseTurnEndResume(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "turn_end") return null;
  const message = event.message && typeof event.message === "object" ? event.message : null;
  let text = "";
  if (message && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown"),
    sessionId: sessionIdFromPath(sessionPath) || "unknown",
    sessionPath: sessionPath || null,
    text,
    stopReason: message ? message.stopReason || null : null,
    aborted: event.aborted === true,
    reason: String(event.reason || "").trim(),
    wasSuccessful: typeof event.wasSuccessful === "boolean" ? event.wasSuccessful : null,
  };
}

/** 解析失败回合，供断联状态机记录。 */
export function parseTurnFailureResume(event, sessionPath) {
  const info = parseTurnEndResume(event, sessionPath);
  if (!info) return null;
  const errorMessage = messageError(event.message) || String(event.errorMessage || event.error || "").trim();
  const abnormalAbort = info.aborted && !isUserInitiatedAbortReason(info.reason);
  const failedByStatus = info.wasSuccessful === false && info.stopReason !== "toolUse";
  if (info.stopReason !== "error" && !abnormalAbort && !failedByStatus) return null;
  return { ...info, errorMessage: errorMessage || info.reason };
}

/** provider 错误事件兜底；通常后面还会跟 turn_end/error。 */
export function parseProviderErrorResume(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "error") return null;
  const errorMessage = String(event.message || event.errorMessage || event.error || "").trim();
  if (!errorMessage) return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown"),
    sessionId: sessionIdFromPath(sessionPath) || "unknown",
    sessionPath: sessionPath || null,
    errorMessage,
  };
}

/** session_status 的强制释放兜底；turn_end 通常会先到，但不依赖时序。 */
export function parseSessionAbortResume(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "session_status") return null;
  if (event.isStreaming !== false || event.aborted !== true) return null;
  const reason = String(event.reason || "").trim();
  if (isUserInitiatedAbortReason(reason)) return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown"),
    sessionId: sessionIdFromPath(sessionPath) || "unknown",
    sessionPath: sessionPath || null,
    aborted: true,
    reason,
    errorMessage: reason || "会话被提前释放",
  };
}

/** 宿主开始自动重试；这里只传状态，不触发任何提醒。 */
export function parseAutoRetryStartResume(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "auto_retry_start") return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown"),
    sessionId: sessionIdFromPath(sessionPath) || "unknown",
    sessionPath: sessionPath || null,
    attempt: Number(event.attempt) || 0,
    maxAttempts: Number(event.maxAttempts) || 0,
    errorMessage: String(event.errorMessage || "").trim(),
  };
}

/** 宿主自动重试结束；只有 success=false 才是断联候选。 */
export function parseAutoRetryEndResume(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "auto_retry_end") return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown"),
    sessionId: sessionIdFromPath(sessionPath) || "unknown",
    sessionPath: sessionPath || null,
    success: event.success === true,
    attempt: Number(event.attempt) || 0,
    finalError: String(event.finalError || event.errorMessage || "").trim(),
  };
}

// ─── 断联原因（大白话文案，不把底层错误原文甩给用户） ───
export function buildResumeReason(errorMessage, { aborted = false, reason = "", source = "" } = {}) {
  const text = String(errorMessage || reason || "").trim().toLowerCase();
  if (source === "stuck_turn") {
    return "窗口卡在思考里了，半天没吐一个字";
  }
  if (!text) {
    return aborted ? "窗口被意外中断了" : "窗口断联了";
  }
  if (/timeout|超时|timed ?out|timedout/i.test(text)) return "等太久了没等到回复";
  if (/rate|429|限流|quota|额度|token ?limit/i.test(text)) return "这个窗口被限流了";
  if (/network|econn|socket|connection|fetch failed|连接/i.test(text)) return "网络连接断了";
  if (/401|403|unauthor|未授权|api ?key|invalid key|没有权限/i.test(text)) return "模型连接出了点问题";
  if (/retry|cancel|cancelled|abort|aborted/i.test(text)) return "回复反复中断";
  return aborted ? "窗口被意外中断了" : "窗口断联了";
}

/** 悬浮球弹窗文案。 */
export function buildResumeCard({ agentName = "", sessionTitle = "", reason = "", source = "" } = {}) {
  const where = [agentName, sessionTitle].filter(Boolean).join(" · ");
  const title = source === "stuck_turn" ? "🌸 窗口卡住了" : "🌸 窗口断联了";
  const action = source === "stuck_turn" ? "点「继续」让它接上话头" : "点「继续」接上话头";
  return {
    title,
    body: `${where ? `${where} ` : ""}${reason || (source === "stuck_turn" ? "窗口卡在思考里了" : "窗口断联了")}，${action}`,
  };
}

// ─── 断联状态机（每会话去重 + 宽限期 + 与宿主自动重试联动） ───
export class ResumeTurnTracker {
  constructor({ onAlert, graceMs = RESUME_GRACE_MS, schedule = setTimeout, cancel = clearTimeout } = {}) {
    this._onAlert = typeof onAlert === "function" ? onAlert : () => {};
    this._graceMs = Math.max(0, Number(graceMs) || 0);
    this._schedule = schedule;
    this._cancel = cancel;
    this._states = new Map();
  }

  _get(sessionId) {
    const id = String(sessionId || "").trim() || "unknown";
    let state = this._states.get(id);
    if (!state) {
      state = { sessionId: id, retrying: false, alerted: false, lastFailure: null, timer: null, alertedAt: 0 };
      this._states.set(id, state);
    }
    return state;
  }

  _clearTimer(state) {
    if (state.timer !== null) {
      this._cancel(state.timer);
      state.timer = null;
    }
  }

  _alert(state, detail) {
    if (state.alerted) return false;
    state.alerted = true;
    state.alertedAt = Date.now();
    this._onAlert({ ...detail, sessionId: state.sessionId });
    return true;
  }

  /** 一条新的用户消息开始，开启新的断联周期。 */
  beginUserTurn(sessionId) {
    const state = this._get(sessionId);
    this._clearTimer(state);
    state.retrying = false;
    state.alerted = false;
    state.alertedAt = 0;
    state.lastFailure = null;
  }

  /** 宿主开始自动重试，取消 turn_end(error) 的兜底计时。 */
  onRetryStart(sessionId) {
    const state = this._get(sessionId);
    state.retrying = true;
    this._clearTimer(state);
  }

  /** 记录失败候选；宿主没进入自动重试时，宽限期后再触发。 */
  onTurnFailure(failure) {
    const state = this._get(failure?.sessionId);
    state.lastFailure = { ...failure };
    if (state.alerted || state.retrying || state.timer !== null) return false;

    const sessionId = state.sessionId;
    state.timer = this._schedule(() => {
      state.timer = null;
      if (state.retrying || state.alerted) return;
      this._alert(state, {
        ...state.lastFailure,
        source: "turn_failure",
      });
    }, this._graceMs);
    return true;
  }

  /** 正常最终回合到达，取消兜底计时。 */
  onTurnSuccess(sessionId) {
    const state = this._get(sessionId);
    this._clearTimer(state);
    state.retrying = false;
    state.lastFailure = null;
  }

  /** 自动重试结束：成功不提醒，耗尽才提醒；主动取消不提醒。 */
  onRetryEnd(result) {
    const state = this._get(result?.sessionId);
    this._clearTimer(state);
    state.retrying = false;

    if (result?.success === true) {
      state.lastFailure = null;
      return false;
    }
    if (result?.finalError && isRetryCancelledResume(result.finalError)) {
      state.lastFailure = null;
      return false;
    }
    if (state.alerted) return false;

    return this._alert(state, {
      ...state.lastFailure,
      ...result,
      errorMessage: result?.finalError || state.lastFailure?.errorMessage || "",
      source: "retry_exhausted",
    });
  }

  /** 测试用：立即执行指定会话的兜底计时。生产逻辑不调用它。 */
  flush(sessionId) {
    const state = this._states.get(String(sessionId || "").trim());
    if (!state || state.timer === null) return false;
    this._clearTimer(state);
    if (state.retrying || state.alerted || !state.lastFailure) return false;
    return this._alert(state, {
      ...state.lastFailure,
      source: "turn_failure",
    });
  }

  dispose() {
    for (const state of this._states.values()) this._clearTimer(state);
    this._states.clear();
  }
}

function isRetryCancelledResume(errorMessage) {
  const text = String(errorMessage || "").trim().toLowerCase();
  return /retry\s+cancelled|retry\s+canceled|\bcancelled\b|\bcanceled\b|\baborted\b/.test(text);
}