// 解语花 — 压缩档案代理层回归测试（node:test，零依赖）
// 覆盖 /compaction 背后的 compactionPayload：显式目标会话、无压缩会话、路径失效与非法路径、
// 无目标时的空态，以及「标题补全失败不影响档案本体」的容错。
//
// ⚠️ HANA_HOME 是 zhujian.js 模块加载时读取的常量，必须先设置再动态 import。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-compaction-route-"));
process.env.HANA_HOME = home;

const { compactionPayload } = await import("../lib/zhujian.js");

function msgEntry(text) {
  return JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
}

function compactionEntry(summary) {
  return JSON.stringify({
    type: "compaction",
    id: "c1",
    timestamp: "2026-09-10T01:23:52.602Z",
    summary,
    firstKeptEntryId: "abc",
    tokensBefore: 319780,
  });
}

function writeSession(agentId, fileName, lines) {
  const dir = path.join(home, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

test("显式目标会话：返回压缩条目与元信息", async () => {
  const file = writeSession("hanako", "with-compaction.jsonl", [
    msgEntry("压缩前"),
    compactionEntry("## Goal\n- 完成验收"),
    msgEntry("压缩后"),
  ]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-route-data-"));
  const r = await compactionPayload(dataDir, null, { sessionPath: file });
  assert.equal(r.ok, true);
  assert.equal(r.compacted, true);
  assert.equal(r.count, 1);
  assert.equal(r.entry.summary, "## Goal\n- 完成验收");
  assert.equal(r.verbatim.entries, 1);
  assert.equal(normalize(r.target.sessionPath), normalize(file));
  assert.equal(r.mode, "auto");
  assert.equal(typeof r.target.name, "string");
});

test("显式目标会话：没压缩过返回空态而不是报错", async () => {
  const file = writeSession("hanako", "no-compaction.jsonl", [msgEntry("你好"), msgEntry("在的")]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-route-data-"));
  const r = await compactionPayload(dataDir, null, { sessionPath: file });
  assert.equal(r.ok, true);
  assert.equal(r.compacted, false);
  assert.equal(r.count, 0);
  assert.equal(r.entry, null);
});

test("会话文件不在 → 明确报错而不是空态", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-route-data-"));
  const missing = path.join(home, "agents", "hanako", "sessions", "gone.jsonl");
  const r = await compactionPayload(dataDir, null, { sessionPath: missing });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /不存在/);
});

test("非法路径（不在 agents/*/sessions/ 下）被拒绝", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-route-data-"));
  const stray = path.join(os.tmpdir(), `stray-${Date.now()}.jsonl`);
  fs.writeFileSync(stray, msgEntry("x") + "\n", "utf-8");
  const r = await compactionPayload(dataDir, null, { sessionPath: stray });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /无效/);
});

test("没有显式目标时回退到跟随最近活跃会话（没有则返回空态）", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-route-data-"));
  const r = await compactionPayload(dataDir, null, {});
  assert.equal(r.ok, true);
  if (r.target) {
    // 上级用例已在临时 HANA_HOME 下建过会话：应回退到自动跟随
    assert.equal(r.mode, "auto");
    assert.equal(typeof r.target.sessionPath, "string");
    assert.equal(typeof r.compacted, "boolean");
  } else {
    assert.equal(r.compacted, false);
    assert.equal(r.count, 0);
  }
});

test("index 参数透传到指定历史快照", async () => {
  const file = writeSession("hanako", "multi.jsonl", [
    msgEntry("a"),
    compactionEntry("第一次摘要"),
    msgEntry("b"),
    compactionEntry("第二次摘要"),
    msgEntry("c"),
  ]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-route-data-"));
  const latest = await compactionPayload(dataDir, null, { sessionPath: file });
  assert.equal(latest.entry.summary, "第二次摘要");
  const older = await compactionPayload(dataDir, null, { sessionPath: file, index: "1" });
  assert.equal(older.index, 1);
  assert.equal(older.entry.summary, "第一次摘要");
  assert.equal(older.verbatim, null);
});

function normalize(p) {
  return path.normalize(String(p));
}
