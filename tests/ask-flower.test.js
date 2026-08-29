// 解语花「问问小花」回归测试（node:test，零依赖）
// 覆盖：参数校验 / 回答成功（用解语花自己的模型档位，不碰真实会话）/ 回答为空 / 模型报错。
//
// 语义：sendAskFlower 不再往真实会话发消息，而是直接用解语花配置的模型生成回答，
// 弹窗里问、弹窗里答。默认 model.source = "agent"，走 sampleFn；测试 mock 它。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-askflower-"));
}

// 文件级固定 HANA_HOME：先设 env 再 import zhujian.js（session.js 依赖缓存）
const BASE = tmpDir();
process.env.HANA_HOME = BASE;
const { sendAskFlower, zhujianConfigPayload } = await import("../lib/zhujian.js");

function okSample(answer = "侧边栏底部可以归档旧会话，归档后可在设置里恢复或永久删除。") {
  let calls = 0;
  const fn = async () => {
    calls++;
    return answer;
  };
  fn.calls = () => calls;
  return fn;
}

function failSample(error = "模型不可用") {
  return async () => {
    throw new Error(error);
  };
}

test("sendAskFlower：空问题 / 超长问题被拦截（不调模型）", async () => {
  const dir = tmpDir();
  const sample = okSample();
  const r1 = await sendAskFlower(dir, null, { text: "   " }, sample);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 400);
  const r2 = await sendAskFlower(dir, null, { text: "长".repeat(501) }, sample);
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 400);
  assert.equal(sample.calls(), 0, "参数非法时不该调模型");
});

test("sendAskFlower：agent 档用解语花配置的模型直接回答", async () => {
  const dir = tmpDir();
  const answer = "去设置 → 安全 → 文件备份 打开，修改前会自动保存原始内容。";
  const sample = okSample(answer);
  const r = await sendAskFlower(dir, null, { text: "怎么开文件备份？" }, sample);
  assert.equal(r.ok, true);
  assert.equal(r.answer, answer);
  assert.equal(sample.calls(), 1);
});

test("sendAskFlower：模型返回空文本 → 友好报错", async () => {
  const dir = tmpDir();
  const sample = okSample("   ");
  const r = await sendAskFlower(dir, null, { text: "问个问题" }, sample);
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
});

test("sendAskFlower：模型报错 → 错误透出（脱敏）", async () => {
  const dir = tmpDir();
  const sample = failSample("供应商 deepseek 未找到，请重新选择模型");
  const r = await sendAskFlower(dir, null, { text: "问个问题" }, sample);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /供应商/);
});

test("sendAskFlower：无 sampleFn 且 agent 档 → 明确报错", async () => {
  const dir = tmpDir();
  const r = await sendAskFlower(dir, null, { text: "问个问题" }, null);
  assert.equal(r.ok, false);
  assert.match(r.error, /模型/);
});

test("askFlower 配置：默认关闭，归一化后仍保持布尔", async () => {
  const { DEFAULT_CONFIG, normalizeConfig } = await import("../lib/data.js");
  assert.equal(DEFAULT_CONFIG.askFlower.enabled, false, "问问小花开关默认关闭");
  assert.equal(normalizeConfig(undefined).askFlower.enabled, false, "无配置时默认关闭");
  assert.equal(normalizeConfig({ askFlower: { enabled: true } }).askFlower.enabled, true);
  assert.equal(normalizeConfig({ askFlower: { enabled: "yes" } }).askFlower.enabled, false, "非法值归一为 false");
});

test("悬浮球配置代理只暴露问问小花的显隐状态", () => {
  assert.deepEqual(zhujianConfigPayload({ presentation: "ball", action: "send", askFlower: { enabled: true } }), {
    presentation: "ball",
    action: "send",
    askFlower: { enabled: true },
  });
  assert.equal(zhujianConfigPayload({}).askFlower.enabled, false, "缺省配置必须按关闭处理");
});
