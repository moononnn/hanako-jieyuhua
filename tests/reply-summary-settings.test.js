// 回复速览频率设置回归：默认/迁移、API 保存、设置页档位与内联脚本语法。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, getConfig, normalizeConfig } from "../lib/data.js";
import registerApiRoutes from "../routes/api.js";
import registerUiRoutes from "../routes/ui.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function routeApp() {
  const handlers = new Map();
  const app = new Proxy({}, {
    get(_target, method) {
      return (route, handler) => handlers.set(`${String(method)} ${route}`, handler);
    },
  });
  return { app, handlers };
}

test("速览频率默认标准，兼容旧配置并将非法值回退到标准", () => {
  assert.equal(DEFAULT_CONFIG.replySummaryFrequency, "standard");
  assert.equal(normalizeConfig({}).replySummaryFrequency, "standard");
  assert.equal(normalizeConfig({ presentation: "ball" }).replySummaryFrequency, "standard");
  for (const value of ["less", "standard", "more"]) {
    assert.equal(normalizeConfig({ replySummaryFrequency: value }).replySummaryFrequency, value);
  }
  assert.equal(normalizeConfig({ replySummaryFrequency: "exact-417" }).replySummaryFrequency, "standard");
});

test("/api/config 只接受三档速览频率并即时落盘", async () => {
  const dataDir = tempDir("jiegehua-summary-api-");
  const { app, handlers } = routeApp();
  registerApiRoutes(app, { dataDir });
  const save = handlers.get("post /api/config");
  assert.equal(typeof save, "function");

  for (const value of ["less", "standard", "more"]) {
    const response = await save({ req: { async json() { return { replySummaryFrequency: value }; } } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(getConfig(dataDir).replySummaryFrequency, value);
  }

  await save({ req: { async json() { return { replySummaryFrequency: "exact-417" }; } } });
  assert.equal(getConfig(dataDir).replySummaryFrequency, "more", "非法档位不应覆盖上次有效设置");
});

test("设置页展示三档近似字数说明，内联客户端脚本可解析", async () => {
  const dataDir = tempDir("jiegehua-summary-ui-");
  const { app, handlers } = routeApp();
  registerUiRoutes(app, { dataDir, pluginId: "jiegehua" });
  const renderSettings = handlers.get("get /settings");
  assert.equal(typeof renderSettings, "function");

  const response = renderSettings({ req: { query() { return ""; } } });
  const html = await response.text();
  assert.match(html, /速览出现频率/);
  assert.match(html, /name="replySummaryFrequency"/);
  assert.match(html, /少一点/);
  assert.match(html, /标准/);
  assert.match(html, /默认档/);
  assert.match(html, /多一点/);
  assert.match(html, /800 字以上/);
  assert.match(html, /500 字以上/);
  assert.match(html, /300 字以上/);

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  assert.ok(scripts.length > 0, "设置页应包含内联客户端脚本");
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});
