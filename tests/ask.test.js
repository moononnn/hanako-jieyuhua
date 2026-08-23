// 解语花提问模式回归测试（node:test，零依赖）
// 覆盖：参数边界、24h 过期、最多 10 条、消费幂等、Markdown 回传与 Deferred 链路。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ASK_INPUT_MAX_LENGTH,
  ASK_TTL_MS,
  buildAskAnswerText,
  validateAskInput,
} from "../lib/ask.js";
import {
  createAskPending,
  getAskPending,
  listAskPending,
  loadData,
  markAskConsumed,
  dismissAskWithOlder,
  saveData,
  queueAskSkip,
  listAskSkips,
  clearAskSkips,
} from "../lib/data.js";
import { respondToAsk, drainAskSkips } from "../lib/zhujian.js";
import { execute as executeAsk } from "../tools/ask_user_choice.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-ask-"));
}

function questionInput(overrides = {}) {
  return {
    question: "这次按哪个方向继续？",
    options: [
      { label: "先做核心功能", description: "先把主链路跑通" },
      { label: "先打磨界面" },
    ],
    header: "需要你拍板",
    ...overrides,
  };
}

test("ask_user_choice 工具在悬浮球未运行时不登记悬空提问", async () => {
  const dir = tmpDir();
  const data = loadData(dir);
  data.config.presentation = "ball";
  saveData(dir, data);
  const result = await executeAsk(questionInput(), {
    dataDir: dir,
    sessionId: "sess_test",
    sessionPath: "C:/agents/hanako/sessions/test.jsonl",
  });
  assert.match(result.content[0].text, /悬浮球没有运行/);
  assert.equal(result.details, undefined);
  assert.equal(listAskPending(dir).length, 0);
});

test("ask_user_choice 在融合球运行时登记提问，不把融合态误判成原版未运行", async () => {
  const dir = tmpDir();
  const data = loadData(dir);
  data.config.presentation = "ball";
  saveData(dir, data);
  const result = await executeAsk(questionInput(), {
    dataDir: dir,
    sessionId: "sess_fused",
    sessionPath: "C:/agents/hanako/sessions/fused.jsonl",
    bus: {
      async request(topic) {
        assert.equal(topic, "work-visit:fusion:v1");
        return { ok: true, mode: "fused", blocking: true, fusionPid: 12345 };
      },
    },
  });
  assert.match(result.content[0].text, /已弹出提问面板/);
  assert.equal(listAskPending(dir).length, 1);
});

test("提问参数校验覆盖空问题、选项数量、重复项和说明长度", () => {
  assert.equal(validateAskInput(questionInput()), null);
  assert.match(validateAskInput(questionInput({ question: "" })), /问题不能为空/);
  assert.match(validateAskInput(questionInput({ options: [{ label: "只有一个" }] })), /2～6/);
  assert.match(validateAskInput(questionInput({ options: [{ label: "重复" }, { label: "重复" }] })), /不能重复/);
  assert.match(validateAskInput(questionInput({ options: [{ label: "a" }, { label: "b", description: "x".repeat(301) }] })), /最多 300/);
});

test("createAskPending 写入完整字段，list 只返回未消费提问", async () => {
  const dir = tmpDir();
  const created = await createAskPending(dir, {
    ...questionInput(),
    sessionId: "sess_test",
    sessionPath: "C:/agents/hanako/sessions/test.jsonl",
  });
  assert.match(created.askId, /^ask_/);
  assert.equal(created.entry.question, "这次按哪个方向继续？");
  assert.equal(created.entry.options.length, 2);
  assert.equal(created.entry.sessionId, "sess_test");
  assert.equal(created.entry.consumed, false);
  assert.equal(listAskPending(dir).length, 1);
  assert.equal(getAskPending(dir, created.askId).askId, created.askId);
});

test("listAskPending 过滤已消费和超过 24h 的提问", async () => {
  const dir = tmpDir();
  const live = await createAskPending(dir, questionInput());
  const consumed = await createAskPending(dir, questionInput({ question: "已回答的问题" }));
  await markAskConsumed(dir, consumed.askId, { mode: "option", choice: "先做核心功能" });

  const data = loadData(dir);
  data.askPending.expired = {
    askId: "expired",
    ...questionInput(),
    ts: Date.now() - ASK_TTL_MS - 1,
    consumed: false,
    answer: null,
  };
  saveData(dir, data);

  const pending = listAskPending(dir);
  assert.deepEqual(pending.map((entry) => entry.askId), [live.askId]);
  assert.equal(getAskPending(dir, "expired"), null);
});

test("markAskConsumed 幂等，第二次不会覆盖第一次回答", async () => {
  const dir = tmpDir();
  const { askId } = await createAskPending(dir, questionInput());
  assert.equal(await markAskConsumed(dir, askId, { mode: "option", choice: "先做核心功能" }), true);
  assert.equal(await markAskConsumed(dir, askId, { mode: "skip", choice: "" }), false);
  assert.deepEqual(getAskPending(dir, askId).answer, { mode: "option", choice: "先做核心功能" });
});

test("dismissAskWithOlder 折叠当前题并作废更旧的堆积题，保留更新题", async () => {
  const dir = tmpDir();
  const old = await createAskPending(dir, { ...questionInput({ question: "旧题" }), sessionPath: "C:/s/a.jsonl" });
  const mid = await createAskPending(dir, { ...questionInput({ question: "中题" }), sessionPath: "C:/s/a.jsonl" });
  const newer = await createAskPending(dir, { ...questionInput({ question: "新题" }), sessionPath: "C:/s/a.jsonl" });
  // 毫秒级时间戳可能相同，手动错开
  const data = loadData(dir);
  data.askPending[old.askId].ts = Date.now() - 60000;
  data.askPending[mid.askId].ts = Date.now() - 30000;
  data.askPending[newer.askId].ts = Date.now();
  saveData(dir, data);

  const result = await dismissAskWithOlder(dir, mid.askId);
  assert.equal(result.ok, true);
  assert.equal(result.count, 2); // 旧题 + 当前题
  assert.deepEqual(listAskPending(dir).map((entry) => entry.askId), [newer.askId]);
});

test("dismissAskWithOlder 折叠最新题 = 全部作废（所有题都比它旧，一次清干净）", async () => {
  const dir = tmpDir();
  const old = await createAskPending(dir, { ...questionInput({ question: "旧题" }) });
  const latest = await createAskPending(dir, { ...questionInput({ question: "最新题" }) });
  const data = loadData(dir);
  data.askPending[old.askId].ts = Date.now() - 60000;
  data.askPending[latest.askId].ts = Date.now();
  saveData(dir, data);

  // 用户看到的永远是最新题；折叠它 = 放弃所有待答堆积，旧题不留着下次烦人
  const result = await dismissAskWithOlder(dir, latest.askId);
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.deepEqual(listAskPending(dir), []);
});

test("dismissAskWithOlder 已消费或不存在时失败且不动其他题", async () => {
  const dir = tmpDir();
  const live = await createAskPending(dir, { ...questionInput({ question: "活题" }) });
  const missing = await dismissAskWithOlder(dir, "ask_不存在的id");
  assert.equal(missing.ok, false);
  assert.equal(missing.count, 0);

  const consumed = await createAskPending(dir, { ...questionInput({ question: "已答题" }) });
  await markAskConsumed(dir, consumed.askId, { mode: "skip", choice: "" });
  const again = await dismissAskWithOlder(dir, consumed.askId);
  assert.equal(again.ok, false);
  assert.equal(listAskPending(dir).length, 1);
  assert.equal(listAskPending(dir)[0].askId, live.askId);
});

test("提问暂存最多保留 10 条最新记录", async () => {
  const dir = tmpDir();
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const { askId } = await createAskPending(dir, questionInput({ question: `第${i}个问题` }));
    ids.push(askId);
  }
  const data = loadData(dir);
  assert.equal(Object.keys(data.askPending).length, 10);
  assert.equal(data.askPending[ids[0]], undefined);
  assert.equal(data.askPending[ids[1]], undefined);
  assert.ok(data.askPending[ids[11]]);
});

test("buildAskAnswerText 三种回传都带提问卡片身份和问题", () => {
  const entry = { question: "选哪一个？" };
  assert.match(buildAskAnswerText(entry, "A", "option"), /^# 提问卡片/);
  assert.match(buildAskAnswerText(entry, "A", "option"), /## 问题\n选哪一个？/);
  assert.match(buildAskAnswerText(entry, "自定义答案", "custom"), /## 回答\n自定义答案/);
  assert.match(buildAskAnswerText(entry, "", "skip"), /## 回答\n跳过，不做选择/);
});

test("respondToAsk 的 Deferred 失败不会提前消费提问", async () => {
  const dir = tmpDir();
  const { askId } = await createAskPending(dir, {
    ...questionInput(),
    sessionPath: "C:/agents/hanako/sessions/test.jsonl",
  });
  const bus = {
    async request(name) {
      if (name === "deferred:resolve") throw new Error("resolve unavailable");
      return { ok: true };
    },
  };
  const result = await respondToAsk(dir, bus, { askId, mode: "option", choice: "先做核心功能" });
  assert.equal(result.ok, false);
  assert.equal(getAskPending(dir, askId).consumed, false);
});

test("respondToAsk Deferred 失败后重试复用同一个 taskId，不重复注册", async () => {
  const dir = tmpDir();
  const { askId } = await createAskPending(dir, {
    ...questionInput(),
    sessionPath: "C:/agents/hanako/sessions/test.jsonl",
  });
  let first = true;
  const firstCalls = [];
  const bus = {
    async request(name) {
      firstCalls.push(name);
      if (name === "deferred:resolve" && first) {
        first = false;
        throw new Error("temporary resolve failure");
      }
      return { ok: true };
    },
  };
  const failed = await respondToAsk(dir, bus, { askId, mode: "option", choice: "先做核心功能" });
  assert.equal(failed.ok, false);
  const delivery = getAskPending(dir, askId).delivery;
  assert.ok(delivery?.taskId);
  assert.equal(delivery.registered, true);

  const retryCalls = [];
  const retryBus = { async request(name, payload) { retryCalls.push({ name, payload }); return { ok: true }; } };
  const retried = await respondToAsk(dir, retryBus, { askId, mode: "option", choice: "先做核心功能" });
  assert.equal(retried.ok, true);
  assert.deepEqual(retryCalls.map((item) => item.name), ["deferred:resolve"]);
  assert.equal(retryCalls[0].payload.taskId, delivery.taskId);
  assert.equal(getAskPending(dir, askId).consumed, true);
});

test("respondToAsk 同一提问并发点击只回传一次", async () => {
  const dir = tmpDir();
  const { askId } = await createAskPending(dir, {
    ...questionInput(),
    sessionPath: "C:/agents/hanako/sessions/test.jsonl",
  });
  const calls = [];
  const bus = {
    async request(name) {
      calls.push(name);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true };
    },
  };
  const results = await Promise.all([
    respondToAsk(dir, bus, { askId, mode: "option", choice: "先做核心功能" }),
    respondToAsk(dir, bus, { askId, mode: "option", choice: "先做核心功能" }),
  ]);
  assert.deepEqual(calls, ["deferred:register", "deferred:resolve"]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
});

test("respondToAsk 先 Deferred 回传，成功后才标记 consumed", async () => {
  const dir = tmpDir();
  const { askId } = await createAskPending(dir, {
    ...questionInput(),
    sessionId: "sess_test",
    sessionPath: "C:/agents/hanako/sessions/test.jsonl",
  });
  const calls = [];
  const bus = {
    async request(name, payload) {
      calls.push({ name, payload });
      return { ok: true };
    },
  };
  const result = await respondToAsk(dir, bus, {
    askId,
    mode: "custom",
    choice: "x".repeat(ASK_INPUT_MAX_LENGTH),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((item) => item.name), ["deferred:register", "deferred:resolve"]);
  assert.equal(calls[0].payload.meta.deliveryIntent, "trigger_parent_turn");
  assert.match(calls[1].payload.result, /# 提问卡片/);
  assert.equal(getAskPending(dir, askId).consumed, true);
});

test("隐式跳过队列：登记去重、列表过滤、清除只删指定项", async () => {
  const dir = tmpDir();
  assert.deepEqual(listAskSkips(dir), []);
  await queueAskSkip(dir, "ask_a");
  await queueAskSkip(dir, "ask_a");
  await queueAskSkip(dir, "ask_b");
  assert.deepEqual(listAskSkips(dir), ["ask_a", "ask_b"]);
  await clearAskSkips(dir, ["ask_a"]);
  assert.deepEqual(listAskSkips(dir), ["ask_b"]);
  await clearAskSkips(dir, []);
  assert.deepEqual(listAskSkips(dir), ["ask_b"]);
  await clearAskSkips(dir, ["ask_b", "ask_missing"]);
  assert.deepEqual(listAskSkips(dir), []);
});

test("respondToAsk mode=skip 回传「跳过，不做选择」并消费提问", async () => {
  const dir = tmpDir();
  const { askId } = await createAskPending(dir, {
    ...questionInput(),
    sessionId: "sess_test",
    sessionPath: "C:/agents/hanako/sessions/test.jsonl",
  });
  const calls = [];
  const bus = {
    async request(name, payload) {
      calls.push({ name, payload });
      return { ok: true };
    },
  };
  const result = await respondToAsk(dir, bus, { askId, mode: "skip", choice: "" });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "skip");
  assert.match(calls[1].payload.result, /## 回答\n跳过，不做选择/);
  assert.equal(getAskPending(dir, askId).consumed, true);
});

test("drainAskSkips 隐式跳过：静默作废提问，零回传零消息", async () => {
  const dir = tmpDir();
  const { askId } = await createAskPending(dir, {
    ...questionInput(),
    sessionId: "sess_test",
    sessionPath: "C:/agents/hanako/sessions/test.jsonl",
  });
  await queueAskSkip(dir, askId);
  await queueAskSkip(dir, "ask_ghost");
  await drainAskSkips(dir);
  // 提问被静默作废（不回传、不唤醒），队列清空（含不存在的幽灵条目）
  assert.equal(getAskPending(dir, askId).consumed, true);
  assert.deepEqual(getAskPending(dir, askId).answer, { mode: "skip", choice: "" });
  assert.deepEqual(listAskSkips(dir), []);
  assert.deepEqual(listAskPending(dir), []);
});
