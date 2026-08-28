// 解语花 — 钉住目标会话 + 会话列表回归测试（node:test，零依赖）
// 覆盖 2026-08-11 新增功能：跟随最近 / 固定指定会话 / 宿主真实会话标题
//
// ⚠️ HANA_HOME 是 session.js 模块加载时读取的常量，必须先设置再动态 import。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-pinned-test-"));
process.env.HANA_HOME = home;

const { listRecentSessions, listNamedSessions, findMostActiveSession, readRecentMessages, isSessionPathForAgent } = await import("../lib/session.js");
const { normalizeData } = await import("../lib/data.js");
const { resolveBallTarget, validatePinnedTargetPath, pinTarget } = await import("../lib/zhujian.js");

function tmpDataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-pin-data-"));
  fs.writeFileSync(path.join(d, "data.json"), JSON.stringify({ config: { presentation: "ball" } }));
  return d;
}

function writeSession(agentId, fileName, lines) {
  const dir = path.join(home, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, fileName);
  fs.writeFileSync(fp, lines.join("\n") + "\n");
  return fp;
}

function userLine(ts, text) {
  return JSON.stringify({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
}

// ═══ normalizeData：pinnedTarget 归一化 ═══

test("normalizeData 解析合法 pinnedTarget", () => {
  const data = normalizeData({ pinnedTarget: { agentId: "hanako", sessionPath: "C:/x.jsonl", title: "美甲" } });
  assert.deepEqual(data.pinnedTarget, { agentId: "hanako", sessionPath: "C:/x.jsonl", title: "美甲" });
});

test("normalizeData pinnedTarget 缺失/损坏时置 null", () => {
  assert.equal(normalizeData({}).pinnedTarget, null);
  assert.equal(normalizeData({ pinnedTarget: null }).pinnedTarget, null);
  assert.equal(normalizeData({ pinnedTarget: { sessionPath: "" } }).pinnedTarget, null);
  assert.equal(normalizeData({ pinnedTarget: "abc" }).pinnedTarget, null);
});

test("normalizeData 老数据（无 pinnedTarget 字段）返回 null 不报错", () => {
  const data = normalizeData({ config: { presentation: "ball" }, pending: {} });
  assert.equal(data.pinnedTarget, null);
});

test("固定目标路径校验：只接受真实 sessions 文件并拒绝越权路径", () => {
  const valid = writeSession("hanako", "valid-pin.jsonl", [userLine("2026-08-11T01:00:00.000Z", "合法目标")]);
  assert.deepEqual(validatePinnedTargetPath(valid, "hanako"), {
    ok: true,
    sessionPath: valid,
    agentId: "hanako",
  });
  assert.equal(validatePinnedTargetPath(valid, "yumi").ok, false, "助手身份不匹配应拒绝");
  assert.equal(
    validatePinnedTargetPath(path.join(home, "agents", "hanako", "sessions", "missing.jsonl"), "hanako").ok,
    false,
    "不存在的会话应拒绝",
  );

  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-outside-"));
  const outsideSessions = path.join(outsideRoot, "agents", "hanako", "sessions");
  fs.mkdirSync(outsideSessions, { recursive: true });
  const outside = path.join(outsideSessions, "escape.jsonl");
  fs.writeFileSync(outside, userLine("2026-08-11T01:00:00.000Z", "目录外目标") + "\n");
  assert.equal(isSessionPathForAgent(outside, "hanako"), false, "真实路径在 Hana 目录外应拒绝");
  assert.equal(validatePinnedTargetPath(outside, "hanako").ok, false);
  fs.rmSync(valid, { force: true });
});

test("pinTarget：合法 / 越权 / 不存在 / 目录外四类请求返回明确结果", async () => {
  const dataDir = tmpDataDir();
  const valid = writeSession("pin-agent", "endpoint-valid.jsonl", [userLine("2026-08-11T01:00:00.000Z", "端点合法目标")]);
  const ok = await pinTarget(dataDir, { agentId: "pin-agent", sessionPath: valid, title: "端点目标" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mode, "pinned");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "data.json"), "utf-8")).pinnedTarget.sessionPath, valid);

  assert.equal((await pinTarget(dataDir, { agentId: "yumi", sessionPath: valid })).status, 400, "越权助手应拒绝");
  assert.equal((await pinTarget(dataDir, { agentId: "pin-agent", sessionPath: path.join(home, "agents", "pin-agent", "sessions", "missing.jsonl") })).status, 400, "不存在路径应拒绝");
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-pin-endpoint-outside-"));
  const outsideDir = path.join(outsideRoot, "agents", "pin-agent", "sessions");
  fs.mkdirSync(outsideDir, { recursive: true });
  const outside = path.join(outsideDir, "outside.jsonl");
  fs.writeFileSync(outside, userLine("2026-08-11T01:00:00.000Z", "目录外") + "\n");
  assert.equal((await pinTarget(dataDir, { agentId: "pin-agent", sessionPath: outside })).status, 400, "目录外路径应拒绝");
  fs.rmSync(path.dirname(path.dirname(valid)), { recursive: true, force: true });
});

// ═══ listRecentSessions：排序 / 摘要 / 过滤 ═══

test("listRecentSessions 按最后用户消息时间倒序，摘要取清洗后用户文本", () => {
  const fpA = writeSession("hanako", "sess-a.jsonl", [
    userLine("2026-08-11T01:00:00.000Z", "[hana_reference]\n工具清单残渣\n[/hana_reference]\n\n早上的旧消息"),
  ]);
  const fpB = writeSession("hanako", "sess-b.jsonl", [
    userLine("2026-08-11T02:00:00.000Z", "上午的新消息"),
  ]);
  const fpC = writeSession("yumi", "sess-c.jsonl", [
    userLine("2026-08-11T03:00:00.000Z", "yumi 的更新消息"),
  ]);
  const list = listRecentSessions(10);
  assert.equal(list.length, 3);
  assert.equal(list[0].sessionPath, fpC, "最活跃的排最前");
  assert.equal(list[1].sessionPath, fpB);
  assert.equal(list[2].sessionPath, fpA);
  assert.equal(list[0].agentId, "yumi");
  assert.equal(list[1].title, "上午的新消息");
  assert.ok(!list[2].title.includes("工具清单"), "注入残渣不应进摘要");
  assert.equal(list[2].title, "早上的旧消息");
});

test("listRecentSessions 跳过无用户消息的会话与 limit 截断", () => {
  writeSession("hanako", "empty.jsonl", [JSON.stringify({ type: "message", timestamp: "2026-08-11T04:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "只有助手消息" }] } })]);
  writeSession("hanako", "old.jsonl", [userLine("2026-08-10T00:00:00.000Z", "昨天的")]);
  const list = listRecentSessions(1);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "yumi 的更新消息", "空会话被跳过，limit=1 取最后用户消息最新的那条");
});

test("listNamedSessions 优先使用 Hana 返回的真实会话标题", async () => {
  const fp = writeSession("hanako", "named.jsonl", [userLine("2026-08-11T05:30:00.000Z", "最后一条消息摘要")]);
  const bus = {
    request: async (command) => {
      assert.equal(command, "session:list");
      return { sessions: [{
        path: fp,
        title: "解语花自动追踪改造",
        firstMessage: "最初消息",
        agentId: "hanako",
        agentName: "小花",
        modified: "2026-08-11T05:31:00.000Z",
      }] };
    },
  };
  const list = await listNamedSessions(bus, 8);
  const named = list.find((item) => item.sessionPath === fp);
  assert.ok(named, "宿主返回的窗口应保留在合并结果中");
  assert.equal(named.title, "解语花自动追踪改造");
  assert.equal(named.agentName, "小花");
});

test("listNamedSessions 从会话路径补出缺失的助手身份", async () => {
  fs.writeFileSync(
    path.join(home, "agents", "hanako", "config.yaml"),
    "agent:\n  name: 路径助手\n",
    "utf-8",
  );
  const fp = writeSession("hanako", "path-agent.jsonl", [userLine("2026-08-11T06:00:00.000Z", "路径里的助手")]);
  const list = await listNamedSessions({
    request: async () => ({ sessions: [{ path: fp, title: "路径识别", modified: "2026-08-11T06:01:00.000Z" }] }),
  }, 1);
  assert.equal(list[0].agentId, "hanako");
  assert.equal(list[0].agentName, "路径助手");
});

test("listNamedSessions 合并宿主窗口与本地窗口，并把秒级 modified 转成毫秒", async () => {
  const local = writeSession("merge-agent", "local.jsonl", [userLine("2026-08-11T09:00:00.000Z", "本地补齐窗口")]);
  const hostDir = path.join(home, "agents", "merge-agent", "sessions");
  const hostOnly = path.join(hostDir, "host-only.jsonl");
  fs.writeFileSync(hostOnly, JSON.stringify({ type: "session", status: "active" }) + "\n", "utf-8");
  const modifiedSeconds = Math.floor(Date.parse("2026-08-11T10:00:00.000Z") / 1000);
  const list = await listNamedSessions({
    request: async () => ({
      sessions: [{ path: hostOnly, agentId: "merge-agent", title: "宿主窗口", modified: modifiedSeconds }],
    }),
  }, 20);
  assert.ok(list.some((item) => item.sessionPath === local), "宿主缺失的本地窗口应保留");
  const hostItem = list.find((item) => item.sessionPath === hostOnly);
  assert.equal(hostItem.title, "宿主窗口");
  assert.equal(hostItem.lastUserTime, modifiedSeconds * 1000);
  fs.rmSync(path.dirname(path.dirname(local)), { recursive: true, force: true });
});

test("listNamedSessions 总线挂起时回退，不让目标选择一直等", async () => {
  const started = Date.now();
  const list = await listNamedSessions({ request: async () => new Promise(() => {}) }, 1);
  assert.ok(Date.now() - started < 4000, "目标列表应在 UI 超时前回退");
  assert.ok(Array.isArray(list));
});

test("listNamedSessions 按活跃时间排序并压缩为指定的 5 个窗口", async () => {
  const sessions = Array.from({ length: 7 }, (_, i) => ({
    path: `C:/sessions/${i}.jsonl`,
    title: `窗口 ${i}`,
    agentId: "hanako",
    modified: new Date(2099, 7, 11, 10, i).toISOString(),
  }));
  const list = await listNamedSessions({ request: async () => ({ sessions }) }, 5);
  assert.equal(list.length, 5);
  assert.deepEqual(list.map((item) => item.title), ["窗口 6", "窗口 5", "窗口 4", "窗口 3", "窗口 2"]);
});

test("listNamedSessions 总线失败时回退文件摘要", async () => {
  const fp = writeSession("hanako", "fallback-own.jsonl", [userLine("2026-08-11T07:00:00.000Z", "本测试自己的回退标题")]);
  const list = await listNamedSessions({ request: async () => { throw new Error("offline"); } }, 1);
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionPath, fp);
  assert.equal(list[0].title, "本测试自己的回退标题");
});

// ═══ resolveBallTarget：钉住优先 / 失效自动清除 ═══

test("resolveBallTarget 钉住会话存在时返回钉住目标", async () => {
  const dataDir = tmpDataDir();
  const fp = writeSession("hanako", "pin.jsonl", [userLine("2026-08-11T02:00:00.000Z", "钉住的消息")]);
  const data = { config: { presentation: "ball" }, pinnedTarget: { agentId: "hanako", sessionPath: fp, title: "钉住" } };
  fs.writeFileSync(path.join(dataDir, "data.json"), JSON.stringify(data));
  const target = await resolveBallTarget(dataDir);
  assert.ok(target, "应返回钉住目标");
  assert.equal(target.sessionPath, fp);
  assert.equal(target.pinned, true);
});

test("resolveBallTarget 从固定会话路径补出缺失的 agentId", async () => {
  const dataDir = tmpDataDir();
  const fp = writeSession("hanako", "pin-without-agent.jsonl", [userLine("2026-08-11T02:30:00.000Z", "缺失 agentId 的固定窗口")]);
  fs.writeFileSync(path.join(dataDir, "data.json"), JSON.stringify({
    config: { presentation: "ball" },
    pinnedTarget: { agentId: "old-wrong-id", sessionPath: fp, title: "固定窗口" },
  }));
  const target = await resolveBallTarget(dataDir);
  assert.equal(target.agentId, "hanako");
});

test("resolveBallTarget 钉住会话已失效时清除并返回 null", async () => {
  const dataDir = tmpDataDir();
  const data = { config: { presentation: "ball" }, pinnedTarget: { agentId: "hanako", sessionPath: "C:/不存在/xx.jsonl", title: "没了" } };
  fs.writeFileSync(path.join(dataDir, "data.json"), JSON.stringify(data));
  const target = await resolveBallTarget(dataDir);
  assert.equal(target, null, "失效钉住回自动模式");
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "data.json"), "utf-8"));
  assert.equal(saved.pinnedTarget, null, "失效钉住已从数据中清除");
});

test("resolveBallTarget 无钉住时返回 null（自动跟随）", async () => {
  const dataDir = tmpDataDir();
  assert.equal(await resolveBallTarget(dataDir), null);
});

// ═══ findMostActiveSession 不受钉住影响（自动模式仍正常） ═══

test("findMostActiveSession 在钉住数据存在时仍正常工作", () => {
  const fp = writeSession("hanako", "active.jsonl", [userLine("2099-01-01T00:00:00.000Z", "最新消息")]);
  const result = findMostActiveSession();
  assert.equal(result.sessionPath, fp);
});

test("长会话末尾超过 256KB 时仍能定位并读取最新用户消息", () => {
  const longPath = writeSession("long-active", "long.jsonl", [
    userLine("2100-01-01T00:00:00.000Z", "当前窗口的最新用户消息"),
  ]);
  fs.appendFileSync(
    longPath,
    JSON.stringify({
      type: "message",
      timestamp: "2100-01-01T00:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "长回复".repeat(120_000) }] },
    }) + "\n",
    "utf-8",
  );
  assert.ok(fs.statSync(longPath).size > 256 * 1024);

  const olderPath = writeSession("older-window", "older.jsonl", [
    userLine("2099-12-31T23:00:00.000Z", "旧窗口消息"),
  ]);
  const target = findMostActiveSession();
  assert.equal(target.sessionPath, longPath, "不能因为固定尾窗漏读而退回旧窗口");

  const messages = readRecentMessages(longPath, 2);
  assert.deepEqual(messages.map((item) => item.role), ["user", "assistant"]);
  assert.match(messages[0].content, /当前窗口/);
  assert.ok(olderPath.endsWith("older.jsonl"));
});

test("反向扫描跨 64KB UTF-8 边界、无最终换行和截断尾行都能安全处理", () => {
  const dir = path.join(home, "agents", "edge-cases", "sessions");
  fs.mkdirSync(dir, { recursive: true });

  const utf8Path = path.join(dir, "utf8.jsonl");
  fs.writeFileSync(
    utf8Path,
    JSON.stringify({
      type: "message",
      timestamp: "2101-01-01T00:00:00.000Z",
      padding: "a".repeat(64 * 1024),
      message: { role: "user", content: [{ type: "text", text: "🌸跨块中文" }] },
    }),
    "utf-8",
  );
  assert.equal(readRecentMessages(utf8Path, 1)[0].content, "🌸跨块中文");

  const truncatedPath = path.join(dir, "truncated.jsonl");
  fs.writeFileSync(
    truncatedPath,
    userLine("2101-01-01T00:01:00.000Z", "前一条完整消息") + "\n{" + "\"type\":\"message\"",
    "utf-8",
  );
  assert.equal(readRecentMessages(truncatedPath, 1)[0].content, "前一条完整消息");
});
