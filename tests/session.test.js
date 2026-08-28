// 解语花 — 会话读取回归测试（node:test，零依赖）
// 覆盖 2026-08-11 实机事故的两个根因：
//   A. 超长 [hana_reference] 注入被 500 字符截断 → 闭标签丢失 → 工具清单残渣污染推荐上下文
//   B. findMostActiveSession 的 timestamp 字符串比较失效 → 会话跟随退化 mtime 兜底
//
// ⚠️ HANA_HOME 是 session.js 模块加载时读取的常量，必须先设置再动态 import。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-sess-test-"));
process.env.HANA_HOME = home;

const { extractConversationMessage, buildContextText, findMostActiveSession, findLatestSessionPath, lastUserMessageTs, lastTurnInputEntryId, readAllMessages } = await import("../lib/session.js");

// 构造一条带超长 hana_reference 注入的用户消息（模拟 Hana 实际注入，工具清单 > 旧截断 500）
function longRefMessage(userText) {
  const tools = Array.from({ length: 60 }, (_, i) => `- 工具${i} — 这是第${i}个工具的说明描述`.padEnd(40, "x"));
  const ref = `[hana_reference]\n${tools.join("\n")}\n[/hana_reference]`;
  return {
    type: "message",
    timestamp: "2026-08-11T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: `${ref}\n\n${userText}` }] },
  };
}

// ═══ 根因 A：注入块清洗 ═══

test("超长 hana_reference 注入不污染上下文，真实用户文本保留", () => {
  const entry = longRefMessage("哈喽小花，我想自己做美甲，那需要准备点啥工具？");
  const msg = extractConversationMessage(entry);
  const ctx = buildContextText([msg]);
  assert.ok(ctx.includes("哈喽小花，我想自己做美甲"), "用户真实文本应保留");
  assert.ok(!ctx.includes("工具0"), "工具清单残渣不应出现");
  assert.ok(!ctx.includes("hana_reference"), "注入标签不应出现");
});

test("截断导致闭标签丢失时，残留注入块整体丢弃（不把清单当对话）", () => {
  // 模拟旧截断 500 的输入：只有 [xxx] 开头、无闭标签
  const truncated = "[hana_reference]\n- 工具清单前半截（无闭标签）";
  const ctx = buildContextText([{ role: "user", content: truncated }]);
  assert.equal(ctx, "");
});

test("mood 块与注入块同时存在时只留干净对话", () => {
  const entry = {
    type: "message",
    timestamp: "2026-08-11T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "<mood>\nVibe: 一些内心想法\n</mood>\n\n正常回复正文内容" }],
    },
  };
  const ctx = buildContextText([extractConversationMessage(entry)]);
  assert.ok(ctx.includes("正常回复正文内容"));
  assert.ok(!ctx.includes("内心想法"));
});

test("readAllMessages 超过 4MB 时读取真实文件尾部", () => {
  const fp = path.join(home, "long-title.jsonl");
  const filler = JSON.stringify({ type: "toolResult", content: "x".repeat(8192) });
  const lines = [JSON.stringify({ role: "user", content: "开头消息" })];
  while (Buffer.byteLength(lines.join("\n")) < 5 * 1024 * 1024) lines.push(filler);
  lines.push(JSON.stringify({ role: "user", content: "真实文件尾部的最新消息" }));
  fs.writeFileSync(fp, lines.join("\n"));
  const messages = readAllMessages(fp);
  assert.ok(messages.some((message) => message.content === "真实文件尾部的最新消息"));
});

// ═══ 根因 B：最活跃会话跟随 ═══

function writeSession(agentId, fileName, lines) {
  const dir = path.join(home, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, fileName);
  fs.writeFileSync(fp, lines.join("\n") + "\n");
  return fp;
}

test("findMostActiveSession 按最后用户消息时间选会话（不受 mtime 干扰）", () => {
  // 会话 A：用户消息旧（09:00），但 mtime 被后续写入刷到最新
  // 会话 B：用户消息新（10:00），mtime 反而旧
  const userA = JSON.stringify({ type: "message", timestamp: "2026-08-11T01:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "早上的旧消息" }] } });
  const userB = JSON.stringify({ type: "message", timestamp: "2026-08-11T02:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "上午的新消息" }] } });
  const fpA = writeSession("hanako", "2026-08-10T00-00-00-000Z_sess-a.jsonl", [userA]);
  const fpB = writeSession("hanako", "2026-08-10T00-00-00-000Z_sess-b.jsonl", [userB]);

  // 把 A 的 mtime 刷成最新（模拟后台任务/助手回复扰动）
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(fpA, future, future);

  const result = findMostActiveSession();
  assert.ok(result, "应能找到最活跃会话");
  assert.equal(result.sessionPath, fpB, "应选最后用户消息更新的会话 B，而不是 mtime 最新的 A");
});

test("findMostActiveSession 多 agent 间也按用户消息时间选", () => {
  const userC = JSON.stringify({ type: "message", timestamp: "2026-08-11T03:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "yumi 的更新消息" }] } });
  const fpC = writeSession("yumi", "2026-08-10T00-00-00-000Z_sess-c.jsonl", [userC]);
  const result = findMostActiveSession();
  assert.equal(result.agentId, "yumi");
  assert.equal(result.sessionPath, fpC);
});

test("findLatestSessionPath 跳过闲不住送达文本，并兼容旧格式时间戳", () => {
  const injected = JSON.stringify({ role: "user", ts: "2026-08-11T05:00:00.000Z", content: "📬 收到来自小花的一条互动：🍵安静陪着～" });
  const real = JSON.stringify({ role: "user", ts: "2026-08-11T06:00:00.000Z", content: "旧格式真实消息" });
  const fp = writeSession("hanako", "session-pick.jsonl", [injected, real]);
  const picked = findLatestSessionPath("hanako");
  assert.equal(picked, fp);
});

// ═══ 隐式跳过判定：提问归属会话的最后用户消息时间 ═══

test("lastUserMessageTs 兼容 ISO 字符串与数字两种时间戳格式", () => {
  const iso = Date.parse("2026-08-11T10:00:00.000Z");
  const fp = writeSession("hanako", "2026-08-11T00-00-00-000Z_sess-ts.jsonl", [
    JSON.stringify({ type: "message", timestamp: "2026-08-11T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "早消息" }] } }),
    JSON.stringify({ role: "assistant", content: "回复" }),
    JSON.stringify({ role: "user", ts: iso, content: "旧格式新消息" }),
  ]);
  assert.equal(lastUserMessageTs(fp), iso, "数字 ts 旧格式应原样返回");
});

test("lastUserMessageTs 忽略 assistant 消息与空内容，文件不存在返回 0", () => {
  const fp = writeSession("hanako", "2026-08-11T00-00-00-000Z_sess-ts2.jsonl", [
    JSON.stringify({ type: "message", timestamp: "2026-08-11T08:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "唯一用户消息" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-08-11T09:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "助手回复" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-08-11T10:00:00.000Z", message: { role: "user", content: [] } }),
  ]);
  assert.equal(lastUserMessageTs(fp), Date.parse("2026-08-11T08:00:00.000Z"), "应跳过空内容用户消息，取上一条有效用户消息");
  assert.equal(lastUserMessageTs(path.join(home, "no-such-file.jsonl")), 0);
});

test("lastTurnInputEntryId 取最近一个已完成助手回合的 user entry id", () => {
  const fp = writeSession("hanako", "2026-08-11T00-00-00-000Z_sess-fork.jsonl", [
    JSON.stringify({ type: "message", id: "u-old", message: { role: "user", content: [{ type: "text", text: "旧问题" }] } }),
    JSON.stringify({ type: "message", id: "a-old", message: { role: "assistant", content: [{ type: "text", text: "旧回答" }] } }),
    JSON.stringify({ type: "message", id: "u-new", message: { role: "user", content: [{ type: "text", text: "新问题" }] } }),
    JSON.stringify({ type: "message", id: "custom", message: { role: "assistant", content: [{ type: "text", text: "中间答复" }] } }),
    JSON.stringify({ type: "message", id: "a-new", message: { role: "assistant", content: [{ type: "text", text: "新回答" }] } }),
    JSON.stringify({ type: "message", id: "u-pending", message: { role: "user", content: [{ type: "text", text: "还没回答" }] } }),
  ]);
  assert.equal(lastTurnInputEntryId(fp), "u-new");
});

test("lastTurnInputEntryId 不把未完成回合拿去 fork", () => {
  const fp = writeSession("hanako", "2026-08-11T00-00-00-000Z_sess-fork-pending.jsonl", [
    JSON.stringify({ type: "message", id: "u-only", message: { role: "user", content: [{ type: "text", text: "还在生成" }] } }),
  ]);
  assert.equal(lastTurnInputEntryId(fp), "");
});
