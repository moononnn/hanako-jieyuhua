// 解语花 — 生命周期入口
// 纪律：onload 只做轻量注册，不做重活（坑 48/49：onload 超时会丢插件）

import {
  getZhujianFusionSnapshot,
  getZhujianProxyInfo,
  getZhujianState,
  startZhujian,
  stopZhujian,
} from "./lib/zhujian.js";
import { getConfig, setConfig, updateTtsConfig } from "./lib/data.js";
import { getStorageMode, protectKey, unprotectKey } from "./lib/crypto.js";

const HANA_BUS_SKIP = Symbol.for("hana.event-bus.skip");

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
    ctx.log.info("解语花 loaded");
  }

  async onunload() {
    try {
      await stopZhujian({ closeProxy: true });
    } catch (error) {
      this.ctx.log?.warn?.("解语花卸载清理失败", { error: error?.message || String(error) });
    }
    this.ctx.log.info("解语花 unloaded");
  }
}
