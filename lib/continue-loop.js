// 解语花 — 循环投递
// 断联续接的第二个形态：ta 正常说完一轮也接着续「继续哈」，跑满 N 轮自己停。
//
// 与断联续接（resume.js）的关系：
//   resume 管「出事了」——超时、报错、卡死才救；
//   本模块管「没出事」——ta 正常收工了也推下去，治长任务做到一半自己停下。
// 两者共用「继续哈」文案与发送通道，共用主面板的停止入口，互斥触发（同一会话同一刻只发一句）。
//
// 借鉴外部改造者的踩坑记录，本模块刻意绕开两处已知雷：
//   1. 不走排队插话那条路。排队要等回合结束再投递，而「等这轮结束」正是自我作废的来源——
//      先发的那条本身就成了后面的 user 消息，后面的被判语境漂移。这里在轮末直接发，不入队。
//   2. 循环是否继续看 done/total，不看「还剩几轮」。用剩余轮数判断会让最后一轮掉回普通分支被提前收尾。

export const LOOP_MAX_ROUNDS = 50;          // 轮数上限，防止无人值守时把 token 烧穿
export const LOOP_DEFAULT_ROUNDS = 5;
export const LOOP_MIN_GAP_MS = 1500;         // 发完到下一轮认领的最小间隔：给宿主时间进入生成态，否则两轮挤在一起
export const LOOP_CONFIRM_COOLDOWN_MS = 60_000; // 同一会话问「还继续吗」的冷却，别一轮问一次
export const LOOP_MAX_STATES = 40;           // 常驻状态条目上限

// 完成类措辞分两档，宁可多问一次，也别替用户瞎猜到半路：
//   强完成词——句子尾部附近出现就判定 ta 在收工；
//   弱询问词——只是 ta 在问你，只有落在句尾才算，中途提一嘴不算（否则「需要我补充资料吗？我都拿到了」会误报）。
const DONE_HINT_TAIL = 160;
const DONE_HINT_TAIL_TIGHT = 30;
const DONE_STRONG_RE = /(已完成|全部完成|任务完成|已经完成|这一步完成|做完了|搞定了|处理完了|写完了|改完了|修完了|完成了|收工了|结束一下)/;
const DONE_WEAK_RE = /(需要我|要不要我|接下来(要|需要)我|下一步(要|需要)我|是不是要我|还要我(做|来))[\s\S]{0,6}$/;

export function normalizeLoopRounds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(LOOP_MAX_ROUNDS, Math.floor(n)));
}

export function normalizeMaxAuto(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(10, Math.floor(n)));
}

/** ta 这句话像是在收工吗？只做「像不像」的判断，停不停交给用户。 */
export function looksLikeFinished(text) {
  if (typeof text !== "string") return false;
  if (DONE_STRONG_RE.test(text.slice(-DONE_HINT_TAIL))) return true;
  return DONE_WEAK_RE.test(text.slice(-DONE_HINT_TAIL_TIGHT));
}

function trim(text, max = 40) {
  const value = String(text || "").trim().replace(/\s+/g, " ");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function describeLoop(state) {
  if (!state || state.status !== "running") return "";
  return `正在续 第 ${Math.min(state.done + 1, state.total)}/${state.total} 轮`;
}

/**
 * 循环状态机。纯内存 + 单一 now()，不碰文件系统，方便直接跑测试。
 * 每个会话一条 state，状态只有：running / awaiting（等用户答要不要继续） / finished / stopped。
 */
export class ContinueLoopRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._states = new Map();
  }

  get(sessionId) {
    return this._states.get(String(sessionId || "")) || null;
  }

  list() {
    return [...this._states.values()];
  }

  /** 主面板一键开循环：设定轮数上限，清掉上一轮的残留计数。 */
  start({ sessionId, sessionPath = "", agentId = "", agentName = "", title = "", rounds = LOOP_DEFAULT_ROUNDS } = {}) {
    const id = String(sessionId || "").trim();
    if (!id) return { ok: false, error: "找不到要续哪个对话" };
    const total = normalizeLoopRounds(rounds) || LOOP_DEFAULT_ROUNDS;
    this._prune();
    this._states.set(id, {
      sessionId: id,
      sessionPath,
      agentId,
      agentName,
      title,
      total,
      done: 0,
      status: "running",
      startedAt: this._now(),
      lastAskAt: 0,
      lastFiredAt: 0,
    });
    return { ok: true, state: this._states.get(id) };
  }

  /** 用户按停、或者轮数跑完。reason 只用于日志和面板显示。 */
  stop(sessionId, reason = "") {
    const id = String(sessionId || "");
    const state = this._states.get(id);
    if (!state) return { ok: false, error: "这个对话没在循环" };
    this._states.delete(id);
    return { ok: true, state, reason };
  }

  /** ta 说了收工的话：先屏住，把决定权交回用户，不自己替他停。 */
  pauseForConfirm(sessionId, reason = "ta 好像做完了") {
    const state = this._states.get(String(sessionId || ""));
    if (!state || state.status !== "running") return null;
    state.status = "awaiting";
    state.lastAskAt = this._now();
    return { ...state, reason };
  }

  /** 用户答「接着来」：继续跑，剩余轮数按已用掉的重算上限。 */
  resumeAfterConfirm(sessionId) {
    const state = this._states.get(String(sessionId || ""));
    if (!state || state.status !== "awaiting") return null;
    state.status = "running";
    state.total = Math.max(state.total, state.done + 1);
    return { ...state };
  }

  /** 用户自己在这个对话里说话了：活人接手，循环当场停，不跟人抢麦。 */
  onUserMessage(sessionId) {
    const state = this._states.get(String(sessionId || ""));
    if (!state) return null;
    this._states.delete(String(sessionId || ""));
    return { ...state, reason: "你自己接过话了" };
  }

  /** 这一轮该继续吗？返回 null 表示该停。 */
  decideAfterTurn(sessionId, { assistantText = "", now } = {}) {
    const id = String(sessionId || "");
    const state = this._states.get(id);
    if (!state || state.status !== "running") return null;
    const ts = Number.isFinite(now) ? now : this._now();

    if (state.done >= state.total) {
      this._states.delete(id);
      return { action: "finished", state: { ...state } };
    }
    if (looksLikeFinished(assistantText)) {
      state.status = "awaiting";
      state.lastAskAt = ts;
      return { action: "confirm", state: { ...state } };
    }
    const gapOk = !state.lastFiredAt || ts - state.lastFiredAt >= LOOP_MIN_GAP_MS;
    if (!gapOk) return { action: "wait", state: { ...state }, retryAt: state.lastFiredAt + LOOP_MIN_GAP_MS };
    return { action: "continue", state: { ...state } };
  }

  /** 真正把「继续哈」发出去之后记账：轮数 +1，并记下这次发送时刻供最小间隔判定。 */
  markFired(sessionId, now) {
    const state = this._states.get(String(sessionId || ""));
    if (!state) return null;
    state.done += 1;
    state.lastFiredAt = Number.isFinite(now) ? now : this._now();
    if (state.done >= state.total) {
      const snapshot = { ...state, status: "finished" };
      this._states.delete(String(sessionId || ""));
      return { ...snapshot, exhausted: true };
    }
    return { ...state };
  }

  /** 该不该再问一次「还继续吗」——冷却内不重复打扰。 */
  canAskAgain(sessionId, now) {
    const state = this._states.get(String(sessionId || ""));
    if (!state) return false;
    return this._now() - (state.lastAskAt || 0) >= LOOP_CONFIRM_COOLDOWN_MS;
  }

  dispose() {
    this._states.clear();
  }

  _prune() {
    if (this._states.size < LOOP_MAX_STATES) return;
    // 先扔掉已经结束的，再按最久没动的顺序砍，避免一直开的对话永远留着。
    const entries = [...this._states.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    for (const entry of entries) {
      if (this._states.size < LOOP_MAX_STATES) break;
      this._states.delete(entry.sessionId);
    }
  }
}

export function loopPanelText(agentName, title) {
  const who = trim(agentName) || trim(title) || "这个对话";
  return `🔁 ${who}：正在续，每轮说完自动接上「继续哈」，跑满设定轮数自己停。`;
}

// ── 与悬浮球代理（zhujian.js）的接线 ──
// 状态机活在插件进程里，悬浮球是另一个进程，只能经桥调起。
// 跟 queue-insert 的 activeManager 同款：插件 onload 时注册，卸载时置空。
let bridge = null;

export function bindContinueLoop(fn) {
  bridge = typeof fn === "function" ? fn : null;
}

export function getContinueLoopBridge() {
  return bridge;
}
