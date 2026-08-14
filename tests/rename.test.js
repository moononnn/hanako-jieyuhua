// 解语花 — 重命名标题回归测试（node:test，零依赖）
// 覆盖：标题输出清洗、全量会话读取、长对话截断策略、退回记录归一化、模型兜底
//
// ⚠️ HANA_HOME 是模块加载时读取的常量，必须先设置再动态 import。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-rename-test-"));
process.env.HANA_HOME = home;

const { readAllMessages, buildTitleContext } = await import("../lib/session.js");
const { cleanTitleOutput, buildTitlePrompt, detectConversationLang, summarizeSessionTitle } = await import("../lib/zhujian.js");
const { normalizeData, saveData } = await import("../lib/data.js");

function msg(role, text, ts) {
  return JSON.stringify({
    type: "message",
    timestamp: ts || "2026-08-13T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  });
}

function writeSession(agentId, lines) {
  const dir = path.join(home, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, "2026-08-13T00-00-00-000Z_sess-test.jsonl");
  fs.writeFileSync(fp, lines.join("\n") + "\n");
  return fp;
}

// ═══ 标题输出清洗 ═══

test("cleanTitleOutput 去掉引号包裹与结尾标点", () => {
  assert.equal(cleanTitleOutput("「插件开发」"), "插件开发");
  assert.equal(cleanTitleOutput('"插件开发"'), "插件开发");
  assert.equal(cleanTitleOutput("插件开发。"), "插件开发");
  assert.equal(cleanTitleOutput("  插件开发  "), "插件开发");
});

test("cleanTitleOutput 去掉代码块包裹", () => {
  assert.equal(cleanTitleOutput("```json\n插件开发\n```"), "插件开发");
});

test("cleanTitleOutput 超长截断 30 字，空输入返回 null", () => {
  const long = "很".repeat(50);
  assert.equal(cleanTitleOutput(long).length, 30);
  assert.equal(cleanTitleOutput(""), null);
  assert.equal(cleanTitleOutput("   "), null);
  assert.equal(cleanTitleOutput("。。"), null);
  assert.equal(cleanTitleOutput(123), null);
  assert.equal(cleanTitleOutput(null), null);
});

// ═══ 总结 prompt ═══

test("buildTitlePrompt 包含对话上下文", () => {
  const prompt = buildTitlePrompt("用户: 你好\n助手: 你好呀");
  assert.ok(prompt.includes("用户: 你好"));
  assert.ok(prompt.includes("对话标题生成器"));
  assert.ok(prompt.includes("不要只盯着第一句话"));
});

test("detectConversationLang 按字符比例判断中英文", () => {
  assert.equal(detectConversationLang("Hello! How are you doing today?"), "en");
  assert.equal(detectConversationLang("你好呀，今天天气不错"), "zh");
  assert.equal(detectConversationLang(""), "zh");
  // 混合文本：字母明显多于汉字按英文处理；反之按中文
  assert.equal(detectConversationLang("Hi 你好 mixed text here"), "en");
  assert.equal(detectConversationLang("你好 Hello 世界"), "zh");
});

test("buildTitlePrompt 英文对话锁定英文输出，中文对话锁定中文输出", () => {
  const enPrompt = buildTitlePrompt("user: Hey can you help me pick a name?\nassistant: Sure! What does it do?");
  assert.ok(enPrompt.includes("这次对话主要是英文，标题必须用英文输出"), "英文对话应锁定英文");
  const zhPrompt = buildTitlePrompt("用户: 帮我看看这个插件\n助手: 好的");
  assert.ok(zhPrompt.includes("这次对话主要是中文，标题必须用中文输出"), "中文对话应锁定中文");
});

test("buildTitlePrompt 上下文为空时给出兜底提示", () => {
  const prompt = buildTitlePrompt("");
  assert.ok(prompt.includes("（对话内容不可用）"));
});

// ═══ 全量读取 ═══

test("readAllMessages 全量读入 user/assistant，忽略其他类型", () => {
  const fp = writeSession("hanako", [
    JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/" }),
    msg("user", "第一条", "2026-08-13T00:00:00.000Z"),
    msg("assistant", "回复一", "2026-08-13T00:01:00.000Z"),
    JSON.stringify({ type: "message", timestamp: "t", message: { role: "system", content: [{ type: "text", text: "系统注入" }] } }),
    msg("user", "第二条", "2026-08-13T00:02:00.000Z"),
  ]);
  const all = readAllMessages(fp);
  assert.equal(all.length, 3);
  assert.equal(all[0].content, "第一条");
  assert.equal(all[2].content, "第二条");
});

test("readAllMessages 旧格式（无 message 包裹）也能读", () => {
  const fp = writeSession("hanako", [
    JSON.stringify({ role: "user", content: "旧格式消息" }),
  ]);
  const all = readAllMessages(fp);
  assert.equal(all.length, 1);
  assert.equal(all[0].content, "旧格式消息");
});

// ═══ 长对话截断 ═══

test("buildTitleContext 短对话全保留", () => {
  const ctx = buildTitleContext([
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好呀" },
  ]);
  assert.ok(ctx.includes("你好"));
  assert.ok(ctx.includes("你好呀"));
});

test("buildTitleContext 超长对话取开头+最近，带省略标记，总长不超预算", () => {
  const lines = [];
  const big = "这是第{0}段对话内容，用来把上下文撑得很长很长。".padEnd(200, "字");
  for (let i = 0; i < 60; i++) {
    lines.push({ role: i % 2 === 0 ? "user" : "assistant", content: big.replace("{0}", String(i)) });
  }
  const ctx = buildTitleContext(lines);
  assert.ok(ctx.includes("第0段"), "开头内容应保留");
  assert.ok(ctx.includes("第59段"), "最近内容应保留");
  assert.ok(ctx.includes("中间省略"), "应有省略标记");
  assert.ok(ctx.length <= 6050, `总长 ${ctx.length} 不应远超预算`);
});

test("buildTitleContext 注入块被清洗", () => {
  const ctx = buildTitleContext([
    { role: "user", content: "[hana_reference]\n工具清单\n[/hana_reference]\n真话" },
  ]);
  assert.ok(ctx.includes("真话"));
  assert.ok(!ctx.includes("hana_reference"));
});

// ═══ 退回记录归一化 ═══

test("normalizeData 保留合法 lastRename", () => {
  const data = normalizeData({
    lastRename: {
      sessionPath: "C:/x/sessions/a.jsonl",
      agentId: "hanako",
      oldTitle: "旧标题",
      newTitle: "新标题",
      ts: 123456,
    },
  });
  assert.equal(data.lastRename.sessionPath, "C:/x/sessions/a.jsonl");
  assert.equal(data.lastRename.oldTitle, "旧标题");
  assert.equal(data.lastRename.newTitle, "新标题");
});

test("normalizeData lastRename 缺 sessionPath / 非法时置 null", () => {
  assert.equal(normalizeData({ lastRename: { oldTitle: "x" } }).lastRename, null);
  assert.equal(normalizeData({ lastRename: "不是对象" }).lastRename, null);
  assert.equal(normalizeData({}).lastRename, null);
});

// ═══ 标题生成兜底 ═══

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-rename-data-"));
  saveData(dir, { config: {} });
  return dir;
}

test("summarizeSessionTitle 模型失败时兜底用最近用户消息前 30 字", async () => {
  const fp = writeSession("hanako", [
    msg("user", "第一条旧消息", "2026-08-13T00:00:00.000Z"),
    msg("assistant", "回复", "2026-08-13T00:01:00.000Z"),
    msg("user", "最近这条消息就是要用来兜底的", "2026-08-13T00:02:00.000Z"),
  ]);
  const dataDir = makeDataDir();
  // modelSample=null → sampleFn reject → 兜底
  const result = await summarizeSessionTitle(dataDir, null, fp);
  assert.equal(result.ok, true);
  assert.equal(result.title, "最近这条消息就是要用来兜底的");
  assert.equal(result.fallback, true);
});

test("summarizeSessionTitle 模型正常输出时走清洗", async () => {
  const fp = writeSession("hanako", [
    msg("user", "帮我看看这个插件", "2026-08-13T00:00:00.000Z"),
    msg("assistant", "好的", "2026-08-13T00:01:00.000Z"),
  ]);
  const dataDir = makeDataDir();
  const modelSample = async () => "「插件开发」。";
  const result = await summarizeSessionTitle(dataDir, modelSample, fp);
  assert.equal(result.ok, true);
  assert.equal(result.title, "插件开发");
  assert.equal(result.fallback, false);
});
