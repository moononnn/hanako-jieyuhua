// 解语花 — 压缩档案读取回归测试（node:test，零依赖）
// 覆盖：无压缩会话空态、单次/多次压缩、index 语义与越界收敛、历史条目 verbatim 语义、
//       坏行容错、文件缺失、以及「压缩条目横跨 1MB 扫描块边界（含多字节中文）」不被截断。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { readCompactionArchive } = await import("../lib/compaction.js");

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-compaction-test-"));
  return path.join(dir, name);
}

function msgEntry(text, ts = "2026-09-10T00:00:00.000Z") {
  return JSON.stringify({ type: "message", id: `m${Math.random().toString(36).slice(2, 8)}`, timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
}

function compactionEntry(summary, { ts = "2026-09-10T01:23:52.602Z", tokensBefore = 319780, firstKept = "abc123" } = {}) {
  return JSON.stringify({ type: "compaction", id: `c${Math.random().toString(36).slice(2, 8)}`, parentId: "p1", timestamp: ts, summary, firstKeptEntryId: firstKept, tokensBefore });
}

test("没有压缩条目的会话返回空态", () => {
  const file = tmpFile("plain.jsonl");
  fs.writeFileSync(file, [msgEntry("你好"), msgEntry("在的")].join("\n") + "\n", "utf-8");
  const r = readCompactionArchive(file);
  assert.equal(r.ok, true);
  assert.equal(r.compacted, false);
  assert.equal(r.count, 0);
  assert.equal(r.entry, null);
  assert.deepEqual(r.items, []);
});

test("单次压缩给出条目字段与后续原文条数", () => {
  const file = tmpFile("single.jsonl");
  fs.writeFileSync(file, [
    msgEntry("压缩前 1"),
    msgEntry("压缩前 2"),
    compactionEntry("## Goal\n- 完成验收", { tokensBefore: 123456 }),
    msgEntry("压缩后 1"),
    msgEntry("压缩后 2"),
    msgEntry("压缩后 3"),
  ].join("\n") + "\n", "utf-8");

  const r = readCompactionArchive(file);
  assert.equal(r.compacted, true);
  assert.equal(r.count, 1);
  assert.equal(r.index, 0);
  assert.equal(r.entry.summaryChars, "## Goal\n- 完成验收".length);
  assert.equal(r.entry.tokensBefore, 123456);
  assert.equal(r.entry.keptEntryId, "abc123");
  assert.equal(r.verbatim.entries, 3, "最近一次压缩之后应还剩 3 条原始记录");
  assert.equal(r.items.length, 1);
});

test("多次压缩按最新在前排序，index 越界收敛到最早一条", () => {
  const file = tmpFile("multi.jsonl");
  fs.writeFileSync(file, [
    msgEntry("a"),
    compactionEntry("第一次摘要", { ts: "2026-09-09T06:55:48.355Z" }),
    msgEntry("b"),
    compactionEntry("第二次摘要", { ts: "2026-09-09T23:58:56.046Z" }),
    msgEntry("c"),
    compactionEntry("第三次摘要", { ts: "2026-09-10T01:23:52.602Z" }),
    msgEntry("d"),
  ].join("\n") + "\n", "utf-8");

  const latest = readCompactionArchive(file);
  assert.equal(latest.count, 3);
  assert.equal(latest.entry.summary, "第三次摘要");
  assert.equal(latest.verbatim.entries, 1);
  assert.deepEqual(latest.items.map((i) => i.index), [0, 1, 2]);
  assert.deepEqual(latest.items.map((i) => i.summaryChars), [5, 5, 5]);

  const older = readCompactionArchive(file, { index: 2 });
  assert.equal(older.index, 2);
  assert.equal(older.entry.summary, "第一次摘要");
  assert.equal(older.verbatim, null, "历史快照不应声称原文仍在视野里");

  const overflow = readCompactionArchive(file, { index: 99 });
  assert.equal(overflow.index, 2);
  assert.equal(overflow.entry.summary, "第一次摘要");

  const negative = readCompactionArchive(file, { index: -5 });
  assert.equal(negative.index, 0);
});

test("坏行、空行与非压缩条目不影响识别", () => {
  const file = tmpFile("dirty.jsonl");
  fs.writeFileSync(file, [
    "",
    "这不是 JSON",
    '{"type":"model_change","provider":"deepseek"}',
    msgEntry("正常消息"),
    "{半截 JSON",
    compactionEntry("干净摘要"),
    "   ",
    '{"type":"compaction","summary":""}',
  ].join("\n") + "\n", "utf-8");

  const r = readCompactionArchive(file);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2, "空摘要条目也是压缩记录");
  assert.equal(r.entry.summary, "", "最新一条是空摘要的那次");
  assert.equal(r.items[0].summaryChars, 0);
  assert.equal(r.items[1].summaryChars, "干净摘要".length);

  const older = readCompactionArchive(file, { index: 1 });
  assert.equal(older.entry.summary, "干净摘要");
});

test("文件不存在返回 404 语义", () => {
  const r = readCompactionArchive(path.join(os.tmpdir(), "jiegehua-not-exist-" + Date.now() + ".jsonl"));
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test("压缩条目横跨 1MB 扫描块边界时中文摘要不被截断", () => {
  const CHUNK = 1024 * 1024;
  const fillerLine = msgEntry("填充内容".repeat(20));
  let head = "";
  while (head.length < CHUNK - 200) head += fillerLine + "\n";
  const summary = "## 目标\n- 把这块跨边界的中文摘要原样读回来，不能变成乱码。\n" + "跨块测试".repeat(40);
  const file = tmpFile("boundary.jsonl");
  fs.writeFileSync(file, head + compactionEntry(summary) + "\n" + msgEntry("尾巴") + "\n", "utf-8");
  assert.ok(fs.statSync(file).size > CHUNK, "测试文件应确实超过一个扫描块");

  const r = readCompactionArchive(file);
  assert.equal(r.compacted, true);
  assert.equal(r.count, 1);
  assert.equal(r.entry.summary, summary, "跨块的中文摘要必须完整且无乱码");
  assert.equal(r.verbatim.entries, 1);
});

test("超长摘要按上限截断并标记", () => {
  const file = tmpFile("huge.jsonl");
  const summary = "长".repeat(70000);
  fs.writeFileSync(file, compactionEntry(summary) + "\n", "utf-8");
  const r = readCompactionArchive(file);
  assert.equal(r.entry.truncated, true);
  assert.equal(r.entry.summary.length, 60000);
  assert.equal(r.entry.summaryChars, 70000);
});
