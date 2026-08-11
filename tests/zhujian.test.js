// 解语花 — 悬浮球测试（node:test，零依赖）
// 覆盖：presentation 配置、ballCache 归一化、会话跟随（多 agent 选最活跃）、
//      claimAndSend 原子性（并发防重复/失败回滚）、getSuggestionText（复制不标记）

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CONFIG,
  normalizeConfig,
  normalizeData,
  loadData,
  saveData,
  createPending,
  withDataLock
} from "../lib/data.js";
import { claimAndSend, getSuggestionText } from "../lib/send.js";
import {
  extractConversationMessage,
  readRecentMessages
} from "../lib/session.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-zhujian-"));
}

// ═══ presentation 配置 ═══

test("DEFAULT_CONFIG 默认展示方式为 card（老用户不跳变）", () => {
  assert.equal(DEFAULT_CONFIG.presentation, "card");
});

test("normalizeConfig 接受 presentation 三档", () => {
  assert.equal(normalizeConfig({ presentation: "card" }).presentation, "card");
  assert.equal(normalizeConfig({ presentation: "ball" }).presentation, "ball");
  assert.equal(normalizeConfig({ presentation: "off" }).presentation, "off");
});

test("normalizeConfig 拒绝非法 presentation，回退 card", () => {
  assert.equal(normalizeConfig({ presentation: "both" }).presentation, "card");
  assert.equal(normalizeConfig({ presentation: "xxx" }).presentation, "card");
  assert.equal(normalizeConfig({ presentation: 123 }).presentation, "card");
});

// ═══ ballCache 归一化 ═══

test("normalizeData 解析合法 ballCache", () => {
  const data = normalizeData({
    ballCache: {
      items: [{ text: "好呀" }, { text: "然后呢？" }],
      rid: "r_abc",
      ts: 123456,
      agentId: "hanako",
      sessionPath: "/x.jsonl"
    }
  });
  assert.ok(data.ballCache);
  assert.equal(data.ballCache.items.length, 2);
  assert.equal(data.ballCache.rid, "r_abc");
  assert.equal(data.ballCache.agentId, "hanako");
});

test("normalizeData ballCache 缺失/损坏时置 null", () => {
  assert.equal(normalizeData({}).ballCache, null);
  assert.equal(normalizeData({ ballCache: null }).ballCache, null);
  assert.equal(normalizeData({ ballCache: { items: "不是数组" } }).ballCache, null);
  assert.equal(normalizeData({ ballCache: { items: [] } }).ballCache, null);
});

test("normalizeData ballCache 旧 string[] items 迁移为对象", () => {
  const data = normalizeData({
    ballCache: { items: ["好呀", "然后呢？"] }
  });
  assert.deepEqual(data.ballCache.items, [
    { text: "好呀", direction: "" },
    { text: "然后呢？", direction: "" }
  ]);
});

// ═══ 会话跟随：多 agent 多会话选最活跃 ═══

async function importSessionFresh(hanaHome) {
  // 每次用新 HANA_HOME 重新加载模块（ESM 缓存按 URL 区分）
  const mod = await import(`../lib/session.js?h=${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return mod;
}

function writeSession(agentsDir, agentId, fileName, entries) {
  const dir = path.join(agentsDir, agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, fileName);
  fs.writeFileSync(fp, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");
  return fp;
}

test("findMostActiveSession 按最后用户消息时间选最活跃", async () => {
  const base = tmpDir();
  const agentsDir = path.join(base, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  const oldTime = Date.now() - 5000;
  const newTime = Date.now();

  // hanako：旧会话，最后用户消息 5 秒前
  writeSession(agentsDir, "hanako", "a.jsonl", [
    { role: "user", content: "早", ts: oldTime },
    { role: "assistant", content: "早呀", ts: oldTime + 1 }
  ]);
  // buddy-b：新会话，最后用户消息刚发生
  writeSession(agentsDir, "buddy-b", "b.jsonl", [
    { role: "user", content: "帮我看看这个", ts: newTime },
    { role: "assistant", content: "好", ts: newTime + 1 }
  ]);

  process.env.HANA_HOME = base;
  const sessionMod = await importSessionFresh(base);
  const active = sessionMod.findMostActiveSession();
  assert.ok(active);
  assert.equal(active.agentId, "buddy-b");
});

test("findMostActiveSession 无用户消息时按 mtime 兜底", async () => {
  const base = tmpDir();
  const agentsDir = path.join(base, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  // 只有 assistant 消息的会话（无 user 消息 → 走 mtime 兜底）
  writeSession(agentsDir, "hanako", "a.jsonl", [
    { role: "assistant", content: "你好呀" }
  ]);
  await new Promise((r) => setTimeout(r, 20));
  writeSession(agentsDir, "buddy-b", "b.jsonl", [
    { role: "assistant", content: "在呢" }
  ]);

  process.env.HANA_HOME = base;
  const sessionMod = await importSessionFresh(base);
  const active = sessionMod.findMostActiveSession();
  assert.ok(active);
  assert.equal(active.agentId, "buddy-b");
});

test("findMostActiveSession 空 agents 目录返回 null", async () => {
  const base = tmpDir();
  const agentsDir = path.join(base, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "hanako.jsonl"), "{}", "utf-8"); // 不是目录，忽略

  process.env.HANA_HOME = base;
  const sessionMod = await importSessionFresh(base);
  assert.equal(sessionMod.findMostActiveSession(), null);
  assert.equal(sessionMod.resolveTargetSession(), null);
});

test("resolveTargetSession 返回 sessionId 解析结果", async () => {
  const base = tmpDir();
  const agentsDir = path.join(base, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  writeSession(agentsDir, "hanako", "sess_abc123_2026-01-01.jsonl", [
    { role: "user", content: "hi", ts: Date.now() }
  ]);

  process.env.HANA_HOME = base;
  const sessionMod = await importSessionFresh(base);
  const target = sessionMod.resolveTargetSession();
  assert.ok(target);
  assert.equal(target.agentId, "hanako");
  assert.equal(target.sessionId, "sess_abc123");
  assert.ok(target.sessionPath.endsWith("sess_abc123_2026-01-01.jsonl"));
});

// ═══ 会话解析：Hana 现行格式（message.role + content 数组） ═══
// 2026-08-10 实测根因：老代码读顶层 entry.role，新格式实际在 entry.message.role，
// 且 content 是数组 → 所有消息被过滤 → 推荐永远拿不到上下文（答非所问）。

test("extractConversationMessage 解析新格式（message.role + content 数组）", () => {
  const msg = extractConversationMessage({
    type: "message",
    timestamp: "2026-08-10T00:27:29.440Z",
    message: { role: "user", content: [{ type: "text", text: "你好呀" }] }
  });
  assert.deepEqual(msg, { role: "user", content: "你好呀" });
});

test("extractConversationMessage 兼容旧格式（顶层 role + 字符串 content）", () => {
  assert.deepEqual(
    extractConversationMessage({ role: "assistant", content: "早呀" }),
    { role: "assistant", content: "早呀" }
  );
});

test("extractConversationMessage 忽略 toolResult / 纯 thinking / 空消息", () => {
  assert.equal(
    extractConversationMessage({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x" }] } }),
    null
  );
  assert.equal(
    extractConversationMessage({ message: { role: "assistant", content: [{ type: "thinking", thinking: "内部草稿" }] } }),
    null
  );
  assert.equal(extractConversationMessage(null), null);
  assert.equal(extractConversationMessage({ message: { role: "user", content: [] } }), null);
});

test("extractConversationMessage 多段 text 拼接、超长截断", () => {
  const msg = extractConversationMessage({
    message: { role: "user", content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] }
  });
  assert.equal(msg.content, "第一段\n第二段");
  const long = extractConversationMessage({ message: { role: "user", content: [{ type: "text", text: "x".repeat(800) }] } });
  assert.equal(long.content.length, 800);
});

test("readRecentMessages 读 Hana 现行格式文件（过滤工具消息）", () => {
  const base = tmpDir();
  const fp = path.join(base, "s.jsonl");
  fs.writeFileSync(fp, [
    JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "第一条" }] }, timestamp: "t1" }),
    JSON.stringify({ message: { role: "assistant", content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "回了" }] }, timestamp: "t2" }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "x", content: [{ type: "text", text: "工具" }] }, timestamp: "t3" }),
    JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "第二条" }] }, timestamp: "t4" })
  ].join("\n"), "utf-8");
  const msgs = readRecentMessages(fp, 6);
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[0], { role: "user", content: "第一条" });
  assert.deepEqual(msgs[1], { role: "assistant", content: "回了" });
  assert.deepEqual(msgs[2], { role: "user", content: "第二条" });
});

// ═══ claimAndSend：原子发送 ═══

function fakeBus(result) {
  return {
    async request(name, payload) {
      return result;
    }
  };
}

test("claimAndSend 发送成功并预标记 used", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "好呀" }, { text: "然后呢？" }],
    sessionId: "s1",
    sessionPath: "/s1.jsonl"
  });

  const res = await claimAndSend(dir, { rid, index: 0 }, fakeBus());
  assert.equal(res.ok, true);
  assert.equal(res.text, "好呀");
  // 已标记 used：再发失败
  const again = await claimAndSend(dir, { rid, index: 0 }, fakeBus());
  assert.equal(again.ok, false);
  assert.match(again.error, /失效/);
});

test("claimAndSend 仅 sessionPath 时按宿主契约发送到指定会话", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "固定会话回复" }],
    sessionId: "",
    sessionPath: "C:/agents/hanako/sessions/fixed.jsonl"
  });
  let called = null;
  const bus = {
    async request(name, payload) {
      called = { name, payload };
      return { accepted: true, sessionPath: payload.sessionPath };
    }
  };
  const res = await claimAndSend(dir, { rid, index: 0 }, bus);
  assert.equal(res.ok, true);
  assert.equal(called.name, "session:send");
  assert.equal(called.payload.sessionId, undefined);
  assert.equal(called.payload.sessionPath, "C:/agents/hanako/sessions/fixed.jsonl");
});

test("claimAndSend 并发双击只成功一次", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "唯一的推荐" }],
    sessionId: "s1",
    sessionPath: "/s1.jsonl"
  });

  const results = await Promise.all([
    claimAndSend(dir, { rid, index: 0 }, fakeBus()),
    claimAndSend(dir, { rid, index: 0 }, fakeBus()),
    claimAndSend(dir, { rid, index: 0 }, fakeBus())
  ]);
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 1);
});

test("claimAndSend 发送失败回滚 used，可重试", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "好呀" }],
    sessionId: "s1",
    sessionPath: "/s1.jsonl"
  });

  // 通道不可用 → 失败
  const fail = await claimAndSend(dir, { rid, index: 0 }, null);
  assert.equal(fail.ok, false);
  assert.match(fail.error, /通道不可用/);

  // 已回滚：换个正常通道可以重发
  const ok = await claimAndSend(dir, { rid, index: 0 }, fakeBus());
  assert.equal(ok.ok, true);
});

test("claimAndSend 找不到目标会话 → 回滚并可重试", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "好呀" }],
    sessionId: "",
    sessionPath: ""
  });
  const res = await claimAndSend(dir, { rid, index: 0 }, fakeBus());
  assert.equal(res.ok, false);
  assert.match(res.error, /目标会话/);
});

test("claimAndSend 参数校验：非法 rid/index", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "好呀" }],
    sessionId: "s1",
    sessionPath: "/s1.jsonl"
  });
  assert.equal((await claimAndSend(dir, { rid, index: 9 }, fakeBus())).ok, false);
  assert.equal((await claimAndSend(dir, { rid: "", index: 0 }, fakeBus())).ok, false);
  assert.equal((await claimAndSend(dir, { rid, index: 1.5 }, fakeBus())).ok, false);
});

test("claimAndSend 会话忙时按退避重试（busy 两次后成功）", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "好呀" }],
    sessionId: "s1",
    sessionPath: "/s1.jsonl"
  });

  let attempts = 0;
  const busyBus = {
    async request() {
      attempts++;
      if (attempts <= 2) throw new Error("session is busy");
      return {};
    }
  };
  const res = await claimAndSend(dir, { rid, index: 0 }, busyBus);
  assert.equal(res.ok, true);
  assert.equal(attempts, 3);
});

// ═══ getSuggestionText：复制模式 ═══

test("getSuggestionText 返回文本且不标记 used", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "复制这条" }, { text: "另一条" }],
    sessionId: "s1",
    sessionPath: "/s1.jsonl"
  });

  const res = getSuggestionText(dir, { rid, index: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.text, "另一条");

  // 未标记 used：还能再取/再发
  const again = getSuggestionText(dir, { rid, index: 1 });
  assert.equal(again.ok, true);
  const send = await claimAndSend(dir, { rid, index: 1 }, fakeBus());
  assert.equal(send.ok, true);
});

test("getSuggestionText 失效 rid / 越界 index 返回错误", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "好呀" }],
    sessionId: "s1",
    sessionPath: "/s1.jsonl"
  });
  assert.equal(getSuggestionText(dir, { rid: "r_none", index: 0 }).ok, false);
  assert.equal(getSuggestionText(dir, { rid, index: 5 }).ok, false);
});

// ═══ ballCache 写读（代理路径） ═══

test("ballCache 写入后可读回，单条覆盖不膨胀", async () => {
  const dir = tmpDir();
  await withDataLock(() => {
    const data = loadData(dir);
    data.ballCache = {
      items: [{ text: "第一版" }],
      rid: "r_1",
      ts: 1,
      agentId: "hanako",
      sessionPath: "/a.jsonl"
    };
    saveData(dir, data);
  });
  await withDataLock(() => {
    const data = loadData(dir);
    data.ballCache = {
      items: [{ text: "第二版" }],
      rid: "r_2",
      ts: 2,
      agentId: "hanako",
      sessionPath: "/a.jsonl"
    };
    saveData(dir, data);
  });
  const data = loadData(dir);
  assert.ok(data.ballCache);
  assert.equal(data.ballCache.items[0].text, "第二版");
  assert.equal(data.ballCache.rid, "r_2");
});
