// 解语花 — 生命周期入口
// 纪律：onload 只做轻量注册，不做重活（坑 48/49：onload 超时会丢插件）

const HANA_BUS_SKIP = Symbol.for("hana.event-bus.skip");

export default class Plugin {
  async onload() {
    const ctx = this.ctx;
    if (ctx.bus.handle) {
      this.register(ctx.bus.handle("jiegehua:status", (payload) => {
        if (payload?.pluginId && payload.pluginId !== ctx.pluginId) return HANA_BUS_SKIP;
        return { ok: true, pluginId: ctx.pluginId, name: "解语花" };
      }));
    }
    ctx.log.info("解语花 loaded");
  }

  async onunload() {
    this.ctx.log.info("解语花 unloaded");
  }
}
