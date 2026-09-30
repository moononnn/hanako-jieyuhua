// 解语花 — 生命周期入口
// 纪律：onload 只做轻量注册，不做重活（坑 48/49：onload 超时会丢插件）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getZhujianFusionSnapshot,
  getZhujianProxyInfo,
  getZhujianState,
  sendResumeContinue,
  startZhujian,
  stopZhujian,
} from "./lib/zhujian.js";
import {
  bumpResumeConsecutive,
  checkResumeAutoAllowed,
  createResumePending,
  dismissResumeBySession,
  getConfig,
  markResumeAutoFired,
  pushResumeNotice,
  resetResumeConsecutive,
  setConfig,
  updateTtsConfig,
} from "./lib/data.js";
import { getStorageMode, protectKey, unprotectKey } from "./lib/crypto.js";
import { QueueInsertManager } from "./lib/queue-insert.js";
import { ContinueLoopRegistry, LOOP_MIN_GAP_MS, bindContinueLoop, normalizeLoopRounds } from "./lib/continue-loop.js";
import { readRecentAssistantMessages } from "./lib/session.js";
import {
  ResumeTurnTracker,
  StuckTurnTracker,
  RESUME_AUTO_DELAY_MS,
  buildResumeReason,
  isFinalTurn,
  isUserInitiatedAbortReason,
  parseAutoRetryEndResume,
  parseAutoRetryStartResume,
  parseProviderErrorResume,
  parseSessionAbortResume,
  parseTurnEndResume,
  parseTurnFailureResume,
  sessionIdFromPath,
} from "./lib/resume.js";

const HANA_BUS_SKIP = Symbol.for("hana.event-bus.skip");

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

// 断联检测调试日志（排查用，写插件数据目录，不进发布包；500KB 轮转）
const RESUME_DEBUG_LOG = path.join(HANA_HOME, "plugin-data", "jiegehua", "debug-resume.log");
const RESUME_DEBUG_MAX = 500 * 1024;
function dbgResume(line) {
  try {
    try {
      const st = fs.statSync(RESUME_DEBUG_LOG);
      if (st.size > RESUME_DEBUG_MAX) {
        const content = fs.readFileSync(RESUME_DEBUG_LOG, "utf-8");
        fs.writeFileSync(RESUME_DEBUG_LOG, content.slice(Math.floor(content.length / 2)), "utf-8");
      }
    } catch {}
    fs.appendFileSync(RESUME_DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

async function migrateStoredKeys(ctx) {
  const cfg = getConfig(ctx.dataDir);
  const modelStored = String(cfg.model?.custom?.apiKey || "");
  const ttsStored = String(cfg.tts?.apiKey || "");
  let modelKey = modelStored;
  let ttsKey = ttsStored;

  if (modelStored && getStorageMode(modelStored) !== "dpapi") {
    const plain = await unprotectKey(modelStored);
    if (plain) modelKey = await protectKey(plain);
  }
  if (ttsStored && getStorageMode(ttsStored) !== "dpapi") {
    const plain = await unprotectKey(ttsStored);
    if (plain) ttsKey = await protectKey(plain);
  }

  if (modelKey !== modelStored) {
    await setConfig(ctx.dataDir, {
      model: { ...cfg.model, custom: { ...cfg.model.custom, apiKey: modelKey } },
    });
  }
  if (ttsKey !== ttsStored) {
    await updateTtsConfig(ctx.dataDir, { apiKey: ttsKey });
  }
}

export default class Plugin {
  async onload() {
    const ctx = this.ctx;
    // dataDir 必须先落位：resume 断联检测的所有读写（getConfig / createResumePending / 待办落盘）都走它。
    // 之前漏了这行导致 this._dataDir=undefined，断联候选 32 次但待办 0 次写入，悬浮球「继续哈」窗口从未弹出（2026-08-27 实机排查）。
    this._dataDir = ctx.dataDir || path.join(HANA_HOME, "plugin-data", ctx.pluginId);
    if (ctx.bus.handle) {
      this.register(ctx.bus.handle("jiegehua:status", (payload) => {
        if (payload?.pluginId && payload.pluginId !== ctx.pluginId) return HANA_BUS_SKIP;
        return { ok: true, pluginId: ctx.pluginId, name: "解语花" };
      }));
      this.register(ctx.bus.handle("jiegehua:fusion:v1", async (payload) => {
        if (payload?.pluginId && payload.pluginId !== ctx.pluginId) return HANA_BUS_SKIP;
        const action = payload?.action;
        if (action === "snapshot") return getZhujianFusionSnapshot();
        if (action === "proxy") return { ok: true, ...getZhujianProxyInfo() };
        if (action === "status") return getZhujianState();
        if (action === "start") {
          return startZhujian(ctx, { allowDuringRestore: payload?.internal === "restore" });
        }
        if (action === "stop") return stopZhujian({ closeProxy: false });
        return { ok: false, error: "不支持的融合桥动作" };
      }));
    }
    // 旧 enc:/明文存量在后台迁移到 DPAPI；失败只记脱敏状态，不阻塞插件加载。
    void migrateStoredKeys(ctx).catch((error) => {
      ctx.log?.warn?.("解语花 Key 迁移失败，暂保留原配置", { error: error?.message || String(error) });
    });

    // ── 断联续接（resume）：订阅 bus 事件流，识别异常回合，登记悬浮球待办 ──
    this._lastUserMsgAt = new Map();     // sessionId -> ts（用户最近一次发消息）
    this._resumeTimers = new Map();      // sessionId -> 自动续接定时器
    this._recentResumeSends = new Map(); // sessionId -> ts（自己刚发过「继续哈」，2 秒内不把回执当用户消息）
    this._resumeTracker = new ResumeTurnTracker({
      onAlert: (alert) => this._handleResumeAlert(alert).catch((error) => {
        ctx.log?.error?.("[解语花] 断联待办创建失败", { error: error?.message || String(error) });
      }),
    });
    // 思考卡死检测（2026-08-29）：turn_start 后 90 秒无任何收尾事件 → 判停滞，弹「继续哈」卡。
    // 与 ResumeTurnTracker 互补：那边管有事件可依的失败，这边管无事件的静默断流。
    this._stuckTracker = new StuckTurnTracker({
      onAlert: (alert) => this._handleResumeAlert(alert).catch((error) => {
        ctx.log?.error?.("[解语花] 停滞待办创建失败", { error: error?.message || String(error) });
      }),
    });
    try {
      this._offResumeEvents = ctx.bus.subscribe((event, scopedSessionPath) => {
        try {
          this._handleResumeEvent(event, scopedSessionPath);
        } catch (error) {
          ctx.log?.error?.("[解语花] 断联检测事件处理异常", { error: error?.message || String(error) });
        }
      });
      dbgResume("订阅成功");
    } catch (error) {
      ctx.log?.warn?.("[解语花] 断联检测订阅失败（悬浮球续接功能不可用）", { error: error?.message || String(error) });
      dbgResume(`订阅失败: ${error?.message || String(error)}`);
    }

    // ── 排队插话：悬浮球弹窗写入的句子挂在这里，等这一轮回复结束自动送达 ──
    // 生命周期跟着插件：onload 建、onunload 停；不打断当前回合，只排队。
    this._queueInsert = new QueueInsertManager({
      dataDir: this._dataDir,
      bus: ctx.bus,
      log: ctx.log || console,
    });
    this._offQueue = this._queueInsert.start();

    // ── 循环投递：正常回合结束也接上「继续哈」，跟断联续接共用文案与停止入口 ──
    this._loop = new ContinueLoopRegistry();
    this._loopTimers = new Map();          // sessionId -> 最小间隔等待定时器
    // 悬浮球是另一个进程，启停循环得经桥调起这里的状态机。
    bindContinueLoop((action, payload = {}) => this._loopBridgeAction(action, payload));

    ctx.log.info("解语花 loaded");
  }

  // ── 断联检测事件分发（只认用户参与过的会话，不翻旧账） ──
  _handleResumeEvent(event, sessionPath) {
    const type = event?.type;
    // 1) 用户消息：开启新断联周期；用户自己接手了对话 → 清掉该会话待办
    if (type === "session_user_message") {
      const sid = sessionIdFromPath(sessionPath);
      if (!sid) return;
      this._lastUserMsgAt.set(sid, Date.now());
      this._resumeTracker.beginUserTurn(sid);
      // 用户自己发新消息 = 回合有活人接手：停滞心跳取消，断联待办清掉
      this._stuckTracker.onActivity(sid);
      const selfSent = this._recentResumeSends.get(sid);
      if (selfSent && Date.now() - selfSent < 2000) {
        // 是我们自己发的「继续哈」。如果之前 ta 说过收工话、等的就是用户这句，那就在这里把循环放行。
        this._loop?.resumeAfterConfirm(sid);
        return; // 不算用户接手
      }
      this._recentResumeSends.delete(sid);
      // 活人接手：循环立刻停，不跟用户抢麦（2026-09-28 新增）。
      const stopped = this._loop?.onUserMessage(sid);
      if (stopped) this._clearLoopTimer(sid);
      resetResumeConsecutive(this._dataDir, sid);
      dismissResumeBySession(this._dataDir, sid);
      return;
    }
    // 1b) 回合真正开始生成（turn_start）：起停滞心跳。带 sessionPath 才认。
    if (type === "turn_start") {
      const sid = sessionIdFromPath(sessionPath);
      if (!sid) return;
      if (this._lastUserMsgAt.has(sid)) {
        this._stuckTracker.onTurnStart(sid);
        dbgResume(`[停滞] turn_start session=${sid} 心跳已起`);
      }
      return;
    }
    // 1c) 单条消息完成（message_end，含工具循环中间输出）：回合在健康推进，取消心跳。
    // 注意：message_end 每轮工具循环都会发，不是回合结束信号；真正结束看 turn_end。
    if (type === "message_end") {
      const sid = sessionIdFromPath(sessionPath);
      if (!sid) return;
      this._stuckTracker.onActivity(sid);
      return;
    }
    if (type !== "turn_end" && type !== "error" && type !== "session_status"
      && type !== "auto_retry_start" && type !== "auto_retry_end") {
      return;
    }
    // 2) 宿主自动重试：开始则取消兜底计时，结束按成败处理
    const retryStart = parseAutoRetryStartResume(event, sessionPath);
    if (retryStart) {
      this._resumeTracker.onRetryStart(retryStart.sessionId);
      return;
    }
    const retryEnd = parseAutoRetryEndResume(event, sessionPath);
    if (retryEnd) {
      this._resumeTracker.onRetryEnd(retryEnd);
      if (retryEnd.success) {
        resetResumeConsecutive(this._dataDir, retryEnd.sessionId);
        dismissResumeBySession(this._dataDir, retryEnd.sessionId);
      }
      // 无论成败，自动重试结束后回合不再悬空：取消停滞心跳
      this._stuckTracker.onActivity(retryEnd.sessionId);
      return;
    }
    const sid = sessionIdFromPath(sessionPath);
    // 2b) session_status isStreaming=false：流结束（可能回合完成，也可能是异常释放）。
    // 取消停滞心跳；aborted 分支由下方 parseSessionAbortResume 处理断联待办。
    if (type === "session_status" && event.isStreaming === false && sid) {
      this._stuckTracker.onActivity(sid);
    }
    const isActive = Boolean(sid) && this._lastUserMsgAt.has(sid);
    // 3) provider 错误 / 会话被强制释放：记失败候选
    if (isActive) {
      const providerError = parseProviderErrorResume(event, sessionPath);
      if (providerError) {
        dbgResume(`[候选] provider error session=${providerError.sessionId} err=${providerError.errorMessage.slice(0, 120)}`);
        this._resumeTracker.onTurnFailure(providerError);
        return;
      }
      const sessionAbort = parseSessionAbortResume(event, sessionPath);
      if (sessionAbort) {
        dbgResume(`[候选] 会话被释放 session=${sessionAbort.sessionId} reason=${sessionAbort.reason}`);
        this._resumeTracker.onTurnFailure(sessionAbort);
        return;
      }
      // 4) 失败回合
      const failure = parseTurnFailureResume(event, sessionPath);
      if (failure) {
        dbgResume(`[候选] 失败回合 session=${failure.sessionId} err=${failure.errorMessage.slice(0, 120)}`);
        this._resumeTracker.onTurnFailure(failure);
        return;
      }
    }
    // 5) 回合完成
    const info = parseTurnEndResume(event, sessionPath);
    if (!info) return;
    if (info.aborted && isUserInitiatedAbortReason(info.reason)) {
      // 用户主动停止：会话状态用户自己知道，清掉遗留待办
      if (isActive) dismissResumeBySession(this._dataDir, info.sessionId);
      return;
    }
    if (isFinalTurn(info.stopReason) && !info.aborted && info.stopReason !== "error") {
      // 正常最终回合：会话恢复健康
      if (isActive) this._resumeTracker.onTurnSuccess(info.sessionId);
      this._stuckTracker.onActivity(info.sessionId);
      resetResumeConsecutive(this._dataDir, info.sessionId);
      dismissResumeBySession(this._dataDir, info.sessionId);
      // 互斥：这一轮健康跑通就不该还挂着断联待办；有循环在跑才接续。
      this._advanceContinueLoop(info.sessionId);
      dbgResume(`[健康] 正常回合完成 session=${info.sessionId}`);
    }
  }

  // ── 循环投递推进 ──

  _clearLoopTimer(sessionId) {
    const timer = this._loopTimers?.get(sessionId);
    if (timer) clearTimeout(timer);
    this._loopTimers?.delete(sessionId);
  }

  /**
   * 一轮正常说完后决定要不要接上「继续哈」。
   * 与断联续接互斥：健康回合不会同时产生断联待办，所以这里直接发，不入队。
   * 完成判断只做提示不停手（折中方案）——像收工了就把决定权还给用户。
   */
  _advanceContinueLoop(sessionId) {
    const state = this._loop?.get(sessionId);
    if (!state) return;
    let reply = "";
    try {
      reply = readRecentAssistantMessages(state.sessionPath, 1)?.[0]?.content || "";
    } catch { /* 读不到就当没命中完成词，继续跑 */ }
    const decision = this._loop.decideAfterTurn(sessionId, { assistantText: reply });
    if (!decision) return;
    if (decision.action === "wait") {
      this._clearLoopTimer(sessionId);
      const timer = setTimeout(() => {
        this._loopTimers.delete(sessionId);
        this._advanceContinueLoop(sessionId);
      }, Math.max(decision.retryAt - Date.now(), 0));
      timer.unref?.();
      this._loopTimers.set(sessionId, timer);
      return;
    }
    if (decision.action === "finished") {
      dbgResume(`[循环] 轮数跑满 session=${sessionId}`);
      return;
    }
    if (decision.action === "confirm") {
      const who = decision.state.agentName || decision.state.title || "这个对话";
      pushResumeNotice(this._dataDir, { agentName: who, title: "ta 好像做完了，还继续吗？" });
      void createResumePending(this._dataDir, {
        agentId: decision.state.agentId,
        sessionId,
        sessionPath: decision.state.sessionPath,
        reason: "ta 好像做完了",
        source: "loop_confirm",
      });
      dbgResume(`[循环] 命中完成措辞，转为询问 session=${sessionId}`);
      return;
    }
    this._fireLoopContinue(sessionId);
  }

  async _fireLoopContinue(sessionId, { countRound = true } = {}) {
    const state = this._loop?.get(sessionId);
    if (!state) return;
    this._recentResumeSends.set(sessionId, Date.now());
    try {
      const result = await sendResumeContinue(this._dataDir, this.ctx.bus, { sessionPath: state.sessionPath });
      if (result?.ok) {
        // countRound=false 用于刚启动循环时的首条：那条是“把话头接回来”，
        // 不该吃掉一轮配额，轮数从 ta 回完第一轮之后开始算。
        if (countRound) {
          const after = this._loop.markFired(sessionId);
          dbgResume(`[循环] 已续 session=${sessionId} 轮次=${after?.done ?? "?"}/${after?.total ?? "?"}`);
          if (after?.exhausted) {
            pushResumeNotice(this._dataDir, {
              agentName: state.agentName || "",
              title: `🔁 ${after.total} 轮跑完了`,
            });
          }
        }
        return;
      }
      this._recentResumeSends.delete(sessionId);
      // 发不出去就不再纠缠：回落成待办弹窗，跟断联续接一样的处理。
      const sessionGone = Boolean(result?.notFound);
      // 刚启动的首条没发出去的话，循环就没人接着跑了，留着 running 状态只会变成僵尸
      // （启动接口早已返回成功，用户看不到后续），直接停掉让弹窗里的待办接管。
      if (sessionGone || !countRound) {
        this._loop?.stop(sessionId, sessionGone ? "会话没了" : "首条没发出去，循环没起来");
      }
      if (!sessionGone) {
        await createResumePending(this._dataDir, {
          agentId: state.agentId,
          sessionId,
          sessionPath: state.sessionPath,
          reason: countRound ? "循环续接没发出去" : "循环没能启动，续接没发出去",
        });
      }
    } catch (error) {
      this._recentResumeSends.delete(sessionId);
      if (!countRound) this._loop?.stop(sessionId, "首条没发出去，循环没起来");
      this.ctx.log?.warn?.("[解语花] 循环续接异常", { sessionId, error: error?.message || String(error) });
    }
  }

  /** 停止循环（主面板的「停」按钮），顺带收掉等待中的定时器。 */
  stopContinueLoop(sessionId, reason = "用户停止") {
    this._clearLoopTimer(sessionId);
    const result = this._loop?.stop(sessionId, reason);
    if (result?.ok) dbgResume(`[循环] 已停止 session=${sessionId} reason=${reason}`);
    return result || { ok: false, error: "这个对话没在循环" };
  }

  continueLoopState(sessionId) {
    return this._loop?.get(sessionId) || null;
  }

  // ── 断联登记：自动模式直发「继续哈」；手动模式建悬浮球待办 ──
  async _handleResumeAlert(alert) {
    const sessionId = String(alert?.sessionId || "");
    const agentId = String(alert?.agentId || "");
    const sessionPath = String(alert?.sessionPath || "");
    if (!sessionId || sessionId === "unknown" || !sessionPath) return;
    if (!this._lastUserMsgAt.has(sessionId)) return;

    // 只对「悬浮球模式 + 断联功能开启」生效
    const cfg = getConfig(this._dataDir);
    if (!cfg.resume?.enabled || cfg.presentation !== "ball") return;

    const source = alert?.source === "stuck_turn" ? "stuck_turn" : "";
    const reason = buildResumeReason(alert.errorMessage, {
      aborted: alert.aborted === true,
      reason: alert.reason,
      source,
    });
    await bumpResumeConsecutive(this._dataDir, sessionId);

    // 自动续接：开关开 + 未降级 + 未冷却 → 延迟直发，不弹窗不建待办
    if (cfg.resume.autoContinue) {
      const allow = checkResumeAutoAllowed(this._dataDir, sessionId);
      if (allow.canAuto) {
        const timer = setTimeout(() => {
          this._resumeTimers.delete(sessionId);
          this._fireAutoResume(sessionId, agentId, sessionPath, reason);
        }, RESUME_AUTO_DELAY_MS);
        this._resumeTimers.set(sessionId, timer);
        return;
      }
      // 降级（冷却中/连续断联过多）：落回弹窗，用户手动决定
    }

    await createResumePending(this._dataDir, {
      agentId,
      sessionId,
      sessionPath,
      reason,
      source,
    });
    dbgResume(`[登记] 断联待办 session=${sessionId} reason=${reason} source=${source || "turn_failure"}`);
    this.ctx.log?.info?.("[解语花] 断联已登记", { sessionId, agentId, reason });
  }

  // ── 自动续接：往断联会话直发「继续哈」；失败回退成待办弹窗 ──
  async _fireAutoResume(sessionId, agentId, sessionPath, reason) {
    try {
      this._recentResumeSends.set(sessionId, Date.now());
      const result = await sendResumeContinue(this._dataDir, this.ctx.bus, { sessionPath });
      if (result?.ok) {
        await markResumeAutoFired(this._dataDir, sessionId);
        await pushResumeNotice(this._dataDir, {
          agentName: result.agentName || "",
          title: result.title || "",
        });
        dbgResume(`[自动] 续接成功 session=${sessionId} target=${result.title || result.agentName || sessionPath}`);
        this.ctx.log?.info?.("[解语花] 已自动续接", { sessionId, agentId });
        return;
      }
      this._recentResumeSends.delete(sessionId);
      // 失败（发送被拒等）：回退成待办，悬浮球弹窗供手动继续；会话不存在则不再打扰
      if (result?.notFound) return;
      await createResumePending(this._dataDir, {
        agentId,
        sessionId,
        sessionPath,
        reason,
      });
      this.ctx.log?.warn?.("[解语花] 自动续接失败，已转为弹窗待办", {
        sessionId,
        error: result?.error || "",
      });
    } catch (error) {
      this._recentResumeSends.delete(sessionId);
      this.ctx.log?.error?.("[解语花] 自动续接异常", { sessionId, error: error?.message || String(error) });
    }
  }

  /** 悬浮球代理过来的循环操作。只认白名单里的几个动作。 */
  _loopBridgeAction(action, payload = {}) {
    if (action === "start") {
      const cfg = getConfig(this._dataDir);
      const rounds = normalizeLoopRounds(payload.rounds) || cfg.resume?.loopRounds || 0;
      if (!rounds) return { ok: false, error: "先在续接弹窗里设置循环轮数" };
      const result = this._loop.start({
        sessionId: payload.sessionId,
        sessionPath: payload.sessionPath,
        agentId: payload.agentId,
        agentName: payload.agentName,
        title: payload.title,
        rounds,
      });
      // 首条「继续哈」必须由插件自己发。悬浮球代理直接 /resume/continue 发消息时打不上
      // 「自家发送」标记，index.js 会把它当成用户插话，把刚建的循环当场删掉——
      // 2026-09-30 发布前审查用解压副本实测复现过。
      if (result?.ok && payload.primeSend !== false) {
        void this._fireLoopContinue(payload.sessionId, { countRound: false });
      }
      return result;
    }
    if (action === "stop") return this.stopContinueLoop(payload.sessionId, "悬浮球手动停止");
    if (action === "confirm") {
      if (payload.go !== true) {
        this._clearLoopTimer(payload.sessionId);
        const stopped = this._loop.stop(payload.sessionId, "用户选择收工");
        dbgResume(`[循环] 用户选择收工 session=${payload.sessionId}`);
        return { ok: Boolean(stopped?.ok), state: null };
      }
      const state = this._loop.resumeAfterConfirm(payload.sessionId);
      if (!state) return { ok: false, error: "这个对话没在等确认" };
      // 光放行状态机 ta 不会自己接着说，得真把「继续哈」发出去。
      // 走 _fireLoopContinue 是为了让它打上 _recentResumeSends 标记：否则这条自家消息
      // 会被 session_user_message 当成用户插话，把刚放行的循环又停掉（2026-09-30 审查发现）。
      void this._fireLoopContinue(payload.sessionId);
      return { ok: true, state };
    }
    if (action === "state") {
      return { ok: true, state: this._loop.get(payload.sessionId) };
    }
    if (action === "list") {
      return {
        ok: true,
        states: this._loop.list().map((item) => ({
          sessionId: item.sessionId,
          // 悬浮球比对的是当前固定的对话，带上真实路径才能对上是哪一个在循环
          sessionPath: item.sessionPath || "",
          agentName: item.agentName || "",
          title: item.title || "",
          done: item.done,
          total: item.total,
          status: item.status,
        })),
      };
    }
    return { ok: false, error: "不支持的操作" };
  }

  async onunload() {
    try {
      for (const timer of this._resumeTimers?.values() || []) clearTimeout(timer);
      this._resumeTimers?.clear();
      for (const timer of this._loopTimers?.values() || []) clearTimeout(timer);
      this._loopTimers?.clear();
      this._loop?.dispose();
      bindContinueLoop(null);
      this._resumeTracker?.dispose();
      this._stuckTracker?.dispose();
      if (typeof this._offResumeEvents === "function") this._offResumeEvents();
      if (typeof this._offQueue === "function") this._offQueue();
    } catch (error) {
      this.ctx.log?.warn?.("解语花断联检测清理失败", { error: error?.message || String(error) });
    }
    try {
      await stopZhujian({ closeProxy: true });
    } catch (error) {
      this.ctx.log?.warn?.("解语花卸载清理失败", { error: error?.message || String(error) });
    }
    this.ctx.log.info("解语花 unloaded");
  }
}
