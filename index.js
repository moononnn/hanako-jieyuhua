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
import {
  ResumeTurnTracker,
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
    // 之前漏了这行导致 this._dataDir=undefined，断联候选 32 次但待办 0 次写入，悬浮球「继续」窗口从未弹出（2026-08-27 实机排查）。
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
    this._recentResumeSends = new Map(); // sessionId -> ts（自己刚发过「继续」，2 秒内不把回执当用户消息）
    this._resumeTracker = new ResumeTurnTracker({
      onAlert: (alert) => this._handleResumeAlert(alert).catch((error) => {
        ctx.log?.error?.("[解语花] 断联待办创建失败", { error: error?.message || String(error) });
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
      const selfSent = this._recentResumeSends.get(sid);
      if (selfSent && Date.now() - selfSent < 2000) return; // 自己发的「继续」，不算用户接手
      this._recentResumeSends.delete(sid);
      resetResumeConsecutive(this._dataDir, sid);
      dismissResumeBySession(this._dataDir, sid);
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
      return;
    }
    const sid = sessionIdFromPath(sessionPath);
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
      resetResumeConsecutive(this._dataDir, info.sessionId);
      dismissResumeBySession(this._dataDir, info.sessionId);
      dbgResume(`[健康] 正常回合完成 session=${info.sessionId}`);
    }
  }

  // ── 断联登记：自动模式直发「继续」；手动模式建悬浮球待办 ──
  async _handleResumeAlert(alert) {
    const sessionId = String(alert?.sessionId || "");
    const agentId = String(alert?.agentId || "");
    const sessionPath = String(alert?.sessionPath || "");
    if (!sessionId || sessionId === "unknown" || !sessionPath) return;
    if (!this._lastUserMsgAt.has(sessionId)) return;

    // 只对「悬浮球模式 + 断联功能开启」生效
    const cfg = getConfig(this._dataDir);
    if (!cfg.resume?.enabled || cfg.presentation !== "ball") return;

    const reason = buildResumeReason(alert.errorMessage, {
      aborted: alert.aborted === true,
      reason: alert.reason,
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
    });
    dbgResume(`[登记] 断联待办 session=${sessionId} reason=${reason}`);
    this.ctx.log?.info?.("[解语花] 断联已登记", { sessionId, agentId, reason });
  }

  // ── 自动续接：往断联会话直发「继续」；失败回退成待办弹窗 ──
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

  async onunload() {
    try {
      for (const timer of this._resumeTimers?.values() || []) clearTimeout(timer);
      this._resumeTimers?.clear();
      this._resumeTracker?.dispose();
      if (typeof this._offResumeEvents === "function") this._offResumeEvents();
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
