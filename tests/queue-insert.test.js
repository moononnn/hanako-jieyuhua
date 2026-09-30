// 解语花「等 ta 说完再发」回归测试（node:test，零依赖）
// 覆盖：
//  - enqueueInsert：入队 / 空文本 / 超长 / 无会话 / 同会话同句去重
//  - normalizeQueueInsert：脏数据清洗、卡住的 sending 回收、已完结历史裁剪、pending 绝不静默丢
//  - claimNextInsert：同会话 FIFO、只认领一条、按 sessionPath 过滤
//  - 状态流转：sent / skipped / 释放回 pending 带退避
//  - 语境漂移：排队期间会话里多出别的 user 消息 → 作废；读不到文件 → 判不了放行
//  - readUserMessagesAfter / hasLanded：会话文件对账
//  - describeInsertState：弹窗状态文案
//  - QueueInsertManager：送达、session_busy 释放重试、漂移作废、重启后恢复投递
//  - data.js 循环导入不炸，且 queueInsert 能落盘再读回

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-qi-"));
}

// 文件级固定 HANA_HOME：先设 env 再 import
const BASE = tmpDir();
process.env.HANA_HOME = BASE;

const {
  QueueInsertManager,
  cancelPendingInsert,
  claimNextInsert,
  describeInsertState,
  detectContextDrift,
  enqueueInsert,
  hasLanded,
  isBusyError,
  isTimeoutError,
  markInsertSent,
  markInsertSkipped,
  normalizeQueueInsert,
  normalizeRepeat,
  readUserMessagesAfter,
  releaseInsert,
  settleInsertAfterSend,
} = await import("../lib/queue-insert.js");
const { loadData, saveData, withDataLock } = await import("../lib/data.js");
const { enqueueUserInsert, cancelUserInsert } = await import("../lib/zhujian.js");

const SESSION_A = path.join(BASE, "agents", "hanako", "sessions", "sess_a.jsonl");
const SESSION_B = path.join(BASE, "agents", "hanako", "sessions", "sess_b.jsonl");

function writeSession(file, userMessages) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = userMessages.map((m, i) => JSON.stringify({
    type: "message",
    role: "user",
    content: m.text,
    timestamp: m.at ?? Date.UTC(2026, 0, 1, 0, 0, i),
  }));
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

function seedQueue(dataDir, queue) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "data.json"), JSON.stringify({ queueInsert: queue }, null, 2), "utf-8");
}

function readQueue(dataDir) {
  return loadData(dataDir).queueInsert;
}

// ─── 入队 ───

test("enqueueInsert：正常入队并返回 pending 项", () => {
  const now = Date.UTC(2026, 0, 2);
  const out = enqueueInsert({}, { text: "  那就这么说吧  ", sessionPath: SESSION_A, agentName: "hanako" }, now);
  assert.equal(out.ok, true);
  assert.equal(out.duplicated, false);
  assert.equal(out.item.text, "那就这么说吧");
  assert.equal(out.item.status, "pending");
  assert.equal(out.item.sessionPath, SESSION_A);
  assert.equal(out.item.queuedAt, now);
  assert.equal(out.queue.items.length, 1);
});

test("enqueueInsert：空白、超长、缺会话路径都拦下且不入队", () => {
  const empty = enqueueInsert({}, { text: "   ", sessionPath: SESSION_A });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /写点什么/);

  const long = enqueueInsert({}, { text: "字".repeat(501), sessionPath: SESSION_A });
  assert.equal(long.ok, false);
  assert.match(long.error, /太长/);

  const noTarget = enqueueInsert({}, { text: "在吗" });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.error, /找不到/);
});

test("enqueueInsert：同会话同句不重复排队，pending / sending 都返回既有那条", () => {
  const first = enqueueInsert({}, { text: "走起", sessionPath: SESSION_A });
  const second = enqueueInsert({ queueInsert: first.queue }, { text: "走起", sessionPath: SESSION_A });
  assert.equal(second.ok, true);
  assert.equal(second.duplicated, true);
  assert.equal(second.item.id, first.item.id);
  assert.equal(second.queue.items.length, 1);

  const claimed = claimNextInsert(first.queue);
  const retryWhileSending = enqueueInsert({ queueInsert: claimed.queue }, { text: "走起", sessionPath: SESSION_A });
  assert.equal(retryWhileSending.duplicated, true, "前一次请求断线重试时，sending 也不能再造第二条");
  assert.equal(retryWhileSending.item.id, first.item.id);
  assert.equal(retryWhileSending.queue.items.length, 1);
});

test("enqueueInsert：不同会话的同一句各自排队，互不吞", () => {
  const first = enqueueInsert({}, { text: "走起", sessionPath: SESSION_A });
  const second = enqueueInsert({ queueInsert: first.queue }, { text: "走起", sessionPath: SESSION_B });
  assert.equal(second.duplicated, false);
  assert.equal(second.queue.items.length, 2);
});

test("enqueueUserInsert：显式选择只认 /pin 已保存目标，不重复依赖文件系统硬门禁", async () => {
  const dataDir = tmpDir();
  writeSession(SESSION_A, [{ text: "原对话" }]);
  const data = loadData(dataDir);
  data.pinnedTarget = { sessionPath: SESSION_A, agentId: "hanako", title: "固定窗口" };
  saveData(dataDir, data);
  const accepted = await enqueueUserInsert(dataDir, { text: "排到这里", sessionPath: SESSION_A });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.sessionPath, SESSION_A);
  assert.equal(loadData(dataDir).queueInsert.items[0].sessionPath, SESSION_A);

  const rejected = await enqueueUserInsert(dataDir, {
    text: "不能排出去",
    sessionPath: path.join(BASE, "outside.jsonl"),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 409);
  assert.match(rejected.error, /目标刚刚变了/);
});

// ─── 归一化 ───

test("normalizeQueueInsert：清洗脏数据，不让坏行进来", () => {
  const out = normalizeQueueInsert({
    items: [
      { id: "a", text: "好的" },
      { id: "", text: "   " },
      null,
      "字符串行",
      { text: "也排队", status: "乱写的状态" },
    ],
  });
  assert.equal(out.items.length, 2);
  assert.equal(out.items[1].status, "pending");
  assert.ok(out.items[0].id);
});

test("normalizeQueueInsert：卡在 sending 的陈旧项回收成 pending，活的 sending 不动", () => {
  const now = Date.UTC(2026, 0, 2);
  const out = normalizeQueueInsert({
    items: [
      { id: "old", text: "一", status: "sending", queuedAt: now - 60000 },
      { id: "fresh", text: "二", status: "sending", queuedAt: now - 1000 },
    ],
  }, now, 30000);
  assert.equal(out.items.find((i) => i.id === "old").status, "pending");
  assert.equal(out.items.find((i) => i.id === "fresh").status, "sending");
});

test("normalizeQueueInsert：已完结历史裁剪到上限，pending 一条都不丢", () => {
  const done = Array.from({ length: 30 }, (_, i) => ({
    id: `d${i}`, text: `历史${i}`, status: "sent", queuedAt: i,
  }));
  const live = Array.from({ length: 5 }, (_, i) => ({
    id: `p${i}`, text: `排队${i}`, status: "pending", queuedAt: 100 + i,
  }));
  const out = normalizeQueueInsert({ items: [...done, ...live] });
  const liveCount = out.items.filter((i) => i.status === "pending").length;
  assert.equal(liveCount, 5, "pending 必须全部保留");
  assert.equal(out.items.filter((i) => i.status === "sent").length, 20);
});

// ─── 认领与状态流转 ───

test("claimNextInsert：同会话 FIFO，一次只认领一条", () => {
  const now = Date.UTC(2026, 0, 2);
  let q = enqueueInsert({}, { text: "第一句", sessionPath: SESSION_A }, now).queue;
  q = enqueueInsert({ queueInsert: q }, { text: "第二句", sessionPath: SESSION_A }, now + 1).queue;

  const c1 = claimNextInsert(q, { now });
  assert.equal(c1.item.text, "第一句");
  assert.equal(c1.item.status, "sending");
  assert.equal(c1.queue.items.filter((i) => i.status === "pending").length, 1, "只认领一条");

  const c2 = claimNextInsert(c1.queue, { now });
  assert.equal(c2.item.text, "第二句");
});

test("claimNextInsert：按 sessionPath 过滤，只取指定会话的", () => {
  const now = Date.UTC(2026, 0, 2);
  let q = enqueueInsert({}, { text: "A会话", sessionPath: SESSION_A }, now).queue;
  q = enqueueInsert({ queueInsert: q }, { text: "B会话", sessionPath: SESSION_B }, now + 1).queue;

  const claim = claimNextInsert(q, { sessionPath: SESSION_B, now });
  assert.equal(claim.item.text, "B会话");
});

test("claimNextInsert：空队列返回 null，不抛", () => {
  const claim = claimNextInsert({ items: [] }, { now: Date.now() });
  assert.equal(claim.item, null);
});

test("markInsertSent / markInsertSkipped / releaseInsert 状态流转正确", () => {
  const now = Date.UTC(2026, 0, 2);
  const queue = enqueueInsert({}, { text: "排队一句", sessionPath: SESSION_A }, now).queue;
  const id = queue.items[0].id;

  const sent = markInsertSent(queue, id, now + 100);
  assert.equal(sent.items[0].status, "sent");
  assert.equal(sent.items[0].sentAt, now + 100);

  const skipped = markInsertSkipped(queue, id, "你自己接过话了");
  assert.equal(skipped.items[0].status, "skipped");
  assert.equal(skipped.items[0].skipReason, "你自己接过话了");

  const released = releaseInsert(queue, id, "会话忙", now + 3000);
  assert.equal(released.items[0].status, "pending");
  assert.equal(released.items[0].lastError, "会话忙");
  assert.equal(released.items[0].notBefore, now + 3000);
});

test("cancelPendingInsert：待发送可取消，已开始发送不能假装取消成功", () => {
  const queue = enqueueInsert({}, { text: "我再改改", sessionPath: SESSION_A }).queue;
  const id = queue.items[0].id;
  const cancelled = cancelPendingInsert(queue, id);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.text, "我再改改");
  assert.equal(cancelled.queue.items[0].status, "skipped");
  assert.equal(cancelled.queue.items[0].skipReason, "已撤下来");

  const sending = claimNextInsert(queue).queue;
  const tooLate = cancelPendingInsert(sending, id);
  assert.equal(tooLate.ok, false);
  assert.match(tooLate.error, /已经在发送/);
});

test("认领后 attempts 累加，释放不重置", () => {
  const now = Date.UTC(2026, 0, 2);
  const queue = enqueueInsert({}, { text: "排队一句", sessionPath: SESSION_A }, now).queue;
  const id = queue.items[0].id;
  const once = claimNextInsert(queue, { now });
  assert.equal(once.item.attempts, 1);
  const twice = claimNextInsert(releaseInsert(once.queue, id, "忙", 0), { now });
  assert.equal(twice.item.attempts, 2);
});

// ─── 错误分类 ───

test("isBusyError / isTimeoutError 能分开 busy、超时和其他错误", () => {
  assert.equal(isBusyError(new Error("session_busy")), true);
  assert.equal(isBusyError(new Error("The session is busy right now")), true);
  assert.equal(isBusyError(new Error("manifest not found")), false);

  const timeout = new Error("超时");
  timeout.code = "QUEUE_TIMEOUT";
  assert.equal(isTimeoutError(timeout), true);
  assert.equal(isTimeoutError(new Error("随便什么错")), false);
});

// ─── 会话文件对账 ───

test("readUserMessagesAfter：只返回 since 之后的 user 消息", () => {
  const base = Date.UTC(2026, 0, 1);
  const file = writeSession(SESSION_A, [
    { text: "旧消息", at: base },
    { text: "排队那句", at: base + 5000 },
    { text: "新消息", at: base + 9000 },
  ]);
  const got = readUserMessagesAfter(file, base + 1000);
  assert.equal(got.length, 2);
  assert.equal(got[0].text, "排队那句");
  assert.equal(got[1].text, "新消息");
});

test("readUserMessagesAfter：文件不存在返回 null（判不了，不是判没有）", () => {
  assert.equal(readUserMessagesAfter(path.join(BASE, "不存在.jsonl"), 0), null);
});

test("detectContextDrift：排队期间出现别的 user 消息 → 判定漂移并作废", () => {
  const item = { text: "我想说这个" };
  const drift = detectContextDrift(item, [
    { text: "我想说这个" },
    { text: "算了先吃饭" },
  ]);
  assert.equal(drift.drift, true);
  assert.match(drift.reason, /你自己已经接过话/);
});

test("detectContextDrift：只有本插件自己那一句 → 不漂移；读不到文件 → 判不了", () => {
  assert.equal(detectContextDrift({ text: "我想说这个" }, [{ text: "我想说这个" }]), null);
  assert.equal(detectContextDrift({ text: "我想说这个" }, []), null);
  assert.equal(detectContextDrift({ text: "我想说这个" }, null), null);
});

test("hasLanded：原文已以 user 身份落进会话就认为已送达", () => {
  // 空白折叠后相同 → 认下（上次超时其实送到了）
  assert.equal(hasLanded([{ text: "别的" }, { text: "我  说了这句" }], "我 说了这句"), true);
  assert.equal(hasLanded([{ text: "别的" }], "我说的话"), false);
  assert.equal(hasLanded(null, "我说的话"), false);
});

// ─── 弹窗状态 ───

test("describeInsertState：空 / 排队中 / 已发送 / 已作废 四种说法", () => {
  assert.equal(describeInsertState({ items: [] }, SESSION_A).state, "empty");

  const queue = enqueueInsert({}, { text: "排一句", sessionPath: SESSION_A }).queue;
  assert.equal(describeInsertState(queue, SESSION_A).state, "pending");
  assert.equal(describeInsertState(queue, SESSION_A).text, "排一句");

  const id = queue.items[0].id;
  const sent = describeInsertState(markInsertSent(queue, id), SESSION_A);
  assert.equal(sent.state, "sent");
  assert.equal(sent.text, "排一句");

  const skipped = describeInsertState(markInsertSkipped(queue, id, "你自己接过话了"), SESSION_A);
  assert.equal(skipped.state, "skipped");
  assert.equal(skipped.reason, "你自己接过话了");
});

test("describeInsertState：只关心指定会话的排队", () => {
  const queue = enqueueInsert({}, { text: "A的", sessionPath: SESSION_A }).queue;
  assert.equal(describeInsertState(queue, SESSION_B).state, "empty");
});

test("describeInsertState：同一会话堆了多条历史时，报最新那条而不是最老那条", () => {
  // 真实回归：data.json 里最新一条排在数组最前，按位置取“最后一条”会永远回报旧编号，
  // 弹窗拿 id 对不上就一句“存好了”卡死。
  const sessionPath = SESSION_A;
  const items = [
    { id: "q-new", text: "最新那句", sessionPath, status: "sent", queuedAt: 2000, sentAt: 3000 },
    { id: "q-old", text: "最早那句", sessionPath, status: "sent", queuedAt: 1000, sentAt: 1500 },
  ];
  const state = describeInsertState({ items }, sessionPath, 4000);
  assert.equal(state.state, "sent");
  assert.equal(state.id, "q-new", "必须报刚发出去的那条");
  assert.equal(state.text, "最新那句");
});

test("describeInsertState：同时有在排的和已完结的，在排的优先", () => {
  const sessionPath = SESSION_A;
  const items = [
    { id: "q-live", text: "还在等", sessionPath, status: "pending", queuedAt: 2000, sentAt: 0 },
    { id: "q-done", text: "已发出去", sessionPath, status: "sent", queuedAt: 1000, sentAt: 1500 },
  ];
  const state = describeInsertState({ items }, sessionPath, 4000);
  assert.equal(state.state, "pending");
  assert.equal(state.text, "还在等");
});

// ─── 循环投递（等 ta 说完再发 · 多轮） ───

test("normalizeRepeat：夹在 0~50，空值走 fallback 不冒充跑完", () => {
  assert.equal(normalizeRepeat(undefined), 1);
  assert.equal(normalizeRepeat(null), 1);
  assert.equal(normalizeRepeat(""), 1);
  assert.equal(normalizeRepeat("乱写的"), 1);
  assert.equal(normalizeRepeat(0, 5), 0);
  assert.equal(normalizeRepeat(-3), 0);
  assert.equal(normalizeRepeat(3.8), 3);
  assert.equal(normalizeRepeat(999), 50);
  assert.equal(normalizeRepeat(undefined, 0), 0);
});

test("enqueueInsert：rounds > 1 入队成循环项，不传就是普通项", () => {
  const plain = enqueueInsert({}, { text: "只说一次", sessionPath: SESSION_A });
  assert.equal(plain.item.loopTotal, 1);
  assert.equal(plain.item.repeat, 1);
  assert.equal(plain.looping, false);

  const looped = enqueueInsert({}, { text: "推下去", sessionPath: SESSION_A, rounds: 4 });
  assert.equal(looped.item.loopTotal, 4);
  assert.equal(looped.item.repeat, 4);
  assert.equal(looped.looping, true);

  const clamped = enqueueInsert({}, { text: "太多轮", sessionPath: SESSION_A, rounds: 999 });
  assert.equal(clamped.item.loopTotal, 50);

  const zero = enqueueInsert({}, { text: "零轮", sessionPath: SESSION_A, rounds: 0 });
  assert.equal(zero.item.loopTotal, 1, "轮数下限是 1，不能真的一条都不发");
});

test("normalizeQueueInsert：老数据没有轮数字段按普通项处理，缺 repeat 跟随 loopTotal", () => {
  const out = normalizeQueueInsert({ items: [{ id: "old", text: "老句子", sessionPath: SESSION_A }] });
  assert.equal(out.items[0].loopTotal, 1);
  assert.equal(out.items[0].repeat, 1);

  const broken = normalizeQueueInsert({ items: [{ id: "b", text: "坏字段", sessionPath: SESSION_A, loopTotal: 3 }] });
  assert.equal(broken.items[0].repeat, 3, "repeat 缺失不能回落成 0，否则循环项会被当成已跑完直接收尾");
});

test("settleInsertAfterSend：普通项收尾，循环项减一轮重排", () => {
  const now = Date.UTC(2026, 0, 2);
  const plain = enqueueInsert({}, { text: "一句", sessionPath: SESSION_A }, now).queue;
  const settledPlain = settleInsertAfterSend(plain, plain.items[0].id, now + 10);
  assert.equal(settledPlain.items[0].status, "sent");
  assert.equal(settledPlain.items[0].repeat, 0);

  const looped = enqueueInsert({}, { text: "推", sessionPath: SESSION_A, rounds: 3 }, now).queue;
  const id = looped.items[0].id;
  const stage = settleInsertAfterSend(looped, id, now + 10, 1500);
  assert.equal(stage.items[0].status, "pending", "没跑完就要重排回待发");
  assert.equal(stage.items[0].repeat, 2);
  assert.equal(stage.items[0].loopTotal, 3, "loopTotal 不跟着减，它是「是不是循环项」的唯一依据");
  assert.equal(stage.items[0].notBefore, now + 1510, "重排后要给宿主留进入生成态的时间");
  assert.equal(stage.items[0].attempts, 0, "新一轮从零计退避，不被上一轮失败拖慢");
});

test("settleInsertAfterSend：最后一轮必须收尾，不能掉回普通分支", () => {
  const now = Date.UTC(2026, 0, 2);
  const looped = enqueueInsert({}, { text: "推", sessionPath: SESSION_A, rounds: 3 }, now).queue;
  const id = looped.items[0].id;
  // 推到最后一轮：repeat 正好是 1，用剩余轮数判断就会误收尾成 N-1 轮
  const last = { items: [{ ...looped.items[0], repeat: 1, status: "sending" }] };
  const settled = settleInsertAfterSend(last, id, now + 10);
  assert.equal(settled.items[0].status, "sent");
  assert.equal(settled.items[0].repeat, 0);
});

test("detectContextDrift：循环项自己的同句不算插话，用户真插话才停", () => {
  const item = { text: "继续推" };
  assert.equal(
    detectContextDrift(item, [{ text: "继续推" }, { text: "继续推" }], { looping: true }),
    null,
    "每轮发出去的同一句不是「别人接过话」",
  );
  const drift = detectContextDrift(item, [{ text: "继续推" }, { text: "算了先吃饭" }], { looping: true });
  assert.equal(drift.drift, true);
  assert.match(drift.reason, /循环就停在这儿/);
});

test("describeInsertState：循环项回报总轮数与剩余轮数", () => {
  const queue = enqueueInsert({}, { text: "推", sessionPath: SESSION_A, rounds: 5 }).queue;
  const before = describeInsertState(queue, SESSION_A);
  assert.equal(before.loopTotal, 5);
  assert.equal(before.repeat, 5);

  const after = settleInsertAfterSend(queue, queue.items[0].id, Date.now() + 10);
  const state = describeInsertState(after, SESSION_A);
  assert.equal(state.loopTotal, 5);
  assert.equal(state.repeat, 4, "发过一轮要能算出还剩几轮，弹窗靠它显示进度");
});

// ─── 与 data.js 的往返（含循环导入） ───

test("queueInsert 能落盘并读回，循环导入不炸", async () => {
  const dataDir = tmpDir();
  const now = Date.UTC(2026, 0, 2);
  await withDataLock(() => {
    const data = loadData(dataDir);
    data.queueInsert = enqueueInsert(data, { text: "落盘一句", sessionPath: SESSION_A }, now).queue;
    saveData(dataDir, data);
  });
  const reloaded = loadData(dataDir).queueInsert;
  assert.equal(reloaded.items.length, 1);
  assert.equal(reloaded.items[0].text, "落盘一句");
  assert.equal(reloaded.items[0].status, "pending");
});

// ─── 管理器 ───

function fakeBus(behaviors) {
  const sent = [];
  return {
    sent,
    subscribe: () => () => {},
    request: async (method, payload) => {
      sent.push({ method, payload });
      const behavior = typeof behaviors === "function" ? behaviors(payload, sent.length) : behaviors;
      if (behavior instanceof Error) throw behavior;
      return behavior || { ok: true };
    },
  };
}

test("QueueInsertManager：回合空闲时一次 drain 就送达", async () => {
  const dataDir = tmpDir();
  writeSession(SESSION_A, [{ text: "之前聊的", at: Date.UTC(2026, 0, 1) }]);
  seedQueue(dataDir, enqueueInsert({}, { text: "这句等会儿说", sessionPath: SESSION_A }).queue);
  const bus = fakeBus({ ok: true });
  const manager = new QueueInsertManager({ dataDir, bus, tickMs: 0 });

  await manager.drain();

  assert.equal(bus.sent.length, 1);
  assert.equal(bus.sent[0].method, "session:send");
  assert.equal(bus.sent[0].payload.text, "这句等会儿说");
  assert.equal(bus.sent[0].payload.sessionPath, SESSION_A);
  assert.equal("sessionId" in bus.sent[0].payload, false, "sessionPath 已足够，不能把文件名误传成 sessionId");
  assert.equal(readQueue(dataDir).items[0].status, "sent");
  manager.stop();
});

test("QueueInsertManager：session_busy 时不丢，释放回 pending 等下一轮", async () => {
  const dataDir = tmpDir();
  writeSession(SESSION_A, []);
  seedQueue(dataDir, enqueueInsert({}, { text: "先别插话", sessionPath: SESSION_A }).queue);
  const bus = fakeBus(new Error("session_busy"));
  const manager = new QueueInsertManager({ dataDir, bus, tickMs: 0, busyRetryMs: 0, log: { warn() {}, info() {} } });

  await manager.drain();

  const item = readQueue(dataDir).items[0];
  assert.equal(item.status, "pending", "busy 不能把排队句丢掉");
  assert.match(item.lastError, /busy/);
  manager.stop();
});

test("QueueInsertManager：排队期间用户自己接过话 → 作废不硬发", async () => {
  const dataDir = tmpDir();
  const base = Date.UTC(2026, 0, 1);
  writeSession(SESSION_A, [
    { text: "我先走了", at: base },
    { text: "算了先吃饭", at: base + 5000 },
  ]);
  seedQueue(dataDir, enqueueInsert({}, { text: "我先走了", sessionPath: SESSION_A }, base + 1000).queue);
  const bus = fakeBus({ ok: true });
  const manager = new QueueInsertManager({ dataDir, bus, tickMs: 0, log: { warn() {}, info() {} } });

  await manager.drain();

  assert.equal(bus.sent.length, 0, "已经接过话了就不该再发这句");
  const item = readQueue(dataDir).items[0];
  assert.equal(item.status, "skipped");
  assert.match(item.skipReason, /你自己已经接过话/);
  manager.stop();
});

test("QueueInsertManager：发送其实成功但回包超时 → 对账认下，不重复发", async () => {
  const dataDir = tmpDir();
  const base = Date.UTC(2026, 0, 1);
  // 模拟：drain 之前这条已经落进会话（说明上一次超时其实送到了）
  writeSession(SESSION_A, [{ text: "其实已经发出去了", at: base + 5000 }]);
  seedQueue(dataDir, enqueueInsert({}, { text: "其实已经发出去了", sessionPath: SESSION_A }, base + 1000).queue);
  const bus = fakeBus({ ok: true });
  const manager = new QueueInsertManager({ dataDir, bus, tickMs: 0, log: { warn() {}, info() {} } });

  await manager.drain();

  assert.equal(bus.sent.length, 0, "原文已在会话里，不该再发一次");
  assert.equal(readQueue(dataDir).items[0].status, "sent");
  manager.stop();
});

test("QueueInsertManager：读不到会话文件时照发（判不了不等于作废）", async () => {
  const dataDir = tmpDir();
  const queue = enqueueInsert({}, { text: "文件没了也得发", sessionPath: path.join(BASE, "gone.jsonl") }).queue;
  seedQueue(dataDir, queue);
  const bus = fakeBus({ ok: true });
  const manager = new QueueInsertManager({ dataDir, bus, tickMs: 0, log: { warn() {}, info() {} } });

  await manager.drain();

  assert.equal(bus.sent.length, 1);
  assert.equal(readQueue(dataDir).items[0].status, "sent");
  manager.stop();
});

test("QueueInsertManager：排队中重启，新管理器能把上次留下的句送出去", async () => {
  const dataDir = tmpDir();
  writeSession(SESSION_A, []);
  seedQueue(dataDir, enqueueInsert({}, { text: "重启前排队的", sessionPath: SESSION_A }).queue);
  const bus = fakeBus({ ok: true });
  const restarted = new QueueInsertManager({ dataDir, bus, tickMs: 0, log: { warn() {}, info() {} } });

  await restarted.drain();

  assert.equal(bus.sent.length, 1);
  assert.equal(readQueue(dataDir).items[0].status, "sent");
  restarted.stop();
});

test("多行原话入队时保留换行，不替用户改写", () => {
  const item = enqueueInsert({}, { text: "  第一行\n第二行  ", sessionPath: SESSION_A }).item;
  assert.equal(item.text, "第一行\n第二行");
});

test("新格式会话正文数组能对账，缺时间戳不能冒充新消息", () => {
  const file = path.join(BASE, "modern.jsonl");
  const since = Date.now() - 1000;
  fs.writeFileSync(file, [
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "老消息" }] } }),
    JSON.stringify({ type: "message", timestamp: since + 50, message: { role: "user", content: [{ type: "text", text: "新消息" }] } }),
  ].join("\n") + "\n");
  assert.deepEqual(readUserMessagesAfter(file, since).map((m) => m.text), ["新消息"]);
});

test("退避时间落盘且定向唤醒能越过其他会话队首", async () => {
  const now = Date.now();
  const a = enqueueInsert({}, { text: "A", sessionPath: SESSION_A }, now).queue;
  const b = enqueueInsert({ queueInsert: a }, { text: "B", sessionPath: SESSION_B }, now).queue;
  const delayed = releaseInsert(b, a.items[0].id, "busy", now + 3000);
  assert.equal(claimNextInsert(normalizeQueueInsert(delayed, now + 100), { sessionPath: SESSION_A, now: now + 100 }).item, null);
  assert.equal(claimNextInsert(normalizeQueueInsert(delayed, now + 100), { sessionPath: SESSION_B, now: now + 100 }).item.text, "B");
  const dataDir = tmpDir();
  seedQueue(dataDir, b);
  writeSession(SESSION_A, []);
  writeSession(SESSION_B, []);
  const sent = [];
  const manager = new QueueInsertManager({ dataDir, now: () => now + 100, bus: { request: async (_, args) => { sent.push(args.sessionPath); return { accepted: true }; } } });
  manager._started = true;
  manager._wanted = new Set([SESSION_B.replace(/\\/g, "/").toLowerCase()]);
  await manager.drain();
  assert.deepEqual(sent, [SESSION_B]);
  assert.equal(readQueue(dataDir).items.find((item) => item.sessionPath === SESSION_A).status, "pending");
});

test("QueueInsertManager：没有 bus 时不启动，也不抛", () => {
  const manager = new QueueInsertManager({ dataDir: tmpDir(), bus: null, log: { warn() {} } });
  const stop = manager.start();
  assert.doesNotThrow(() => stop());
});

// ─── 循环投递端到端（会话文件真实落盘） ───

/** 真实模拟：每轮投递都把这句话写进会话文件，否则测不到「上一轮自己那句话」。 */
function loopBus(file, state) {
  const bus = {
    sent: [],
    request: async (method, payload) => {
      bus.sent.push(payload.text);
      fs.appendFileSync(file, JSON.stringify({
        type: "message",
        role: "user",
        content: payload.text,
        timestamp: state.now,
      }) + "\n");
      return { accepted: true };
    },
  };
  return bus;
}

test("QueueInsertManager：循环 3 轮真的发满 3 次（最后一轮不能掉回普通分支）", async () => {
  const dataDir = tmpDir();
  const file = path.join(BASE, "loop-three.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  const state = { now: Date.UTC(2026, 0, 1) };
  const bus = loopBus(file, state);
  seedQueue(dataDir, enqueueInsert({}, { text: "继续", sessionPath: file, rounds: 3 }, state.now).queue);
  const manager = new QueueInsertManager({
    dataDir, bus, tickMs: 0, now: () => state.now, loopGapMs: 1500, log: { warn() {}, info() {} },
  });

  for (let i = 0; i < 4; i += 1) {
    await manager.drain();
    state.now += 2000;
  }

  assert.equal(bus.sent.length, 3, "设 3 轮就该发 3 次，不能只发 2 次");
  assert.deepEqual(bus.sent, ["继续", "继续", "继续"]);
  assert.equal(fs.readFileSync(file, "utf-8").trim().split("\n").length, 3, "三轮都要真的落进会话");
  assert.equal(readQueue(dataDir).items[0].status, "sent");
  assert.equal(readQueue(dataDir).items[0].repeat, 0);
  manager.stop();
});

test("QueueInsertManager：循环途中用户自己接过话 → 循环停下，不硬发下一轮", async () => {
  const dataDir = tmpDir();
  const file = path.join(BASE, "loop-drift.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  const state = { now: Date.UTC(2026, 0, 1) };
  const bus = loopBus(file, state);
  seedQueue(dataDir, enqueueInsert({}, { text: "继续推", sessionPath: file, rounds: 5 }, state.now).queue);
  const manager = new QueueInsertManager({
    dataDir, bus, tickMs: 0, now: () => state.now, loopGapMs: 0, log: { warn() {}, info() {} },
  });

  await manager.drain(); // 第 1 轮发出去
  state.now += 1000;
  fs.appendFileSync(file, JSON.stringify({
    type: "message", role: "user", content: "等一下，我先说个别的", timestamp: state.now,
  }) + "\n");
  state.now += 1000;
  await manager.drain();

  assert.equal(bus.sent.length, 1, "用户接过话就不该再把循环推下去");
  const item = readQueue(dataDir).items[0];
  assert.equal(item.status, "skipped");
  assert.match(item.skipReason, /循环就停在这儿/);
  manager.stop();
});

test("QueueInsertManager：循环途中用户撤回 → 停住且不再发", async () => {
  const dataDir = tmpDir();
  const file = path.join(BASE, "loop-cancel.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  const state = { now: Date.UTC(2026, 0, 1) };
  const bus = loopBus(file, state);
  const queued = enqueueInsert({}, { text: "继续推", sessionPath: file, rounds: 5 }, state.now).queue;
  const id = queued.items[0].id;
  seedQueue(dataDir, queued);
  const manager = new QueueInsertManager({
    dataDir, bus, tickMs: 0, now: () => state.now, loopGapMs: 0, log: { warn() {}, info() {} },
  });

  await manager.drain();
  state.now += 1000;
  const cancelled = await cancelUserInsert(dataDir, { id });
  assert.equal(cancelled.ok, true, "循环排在待发时可以撤回");
  state.now += 1000;
  await manager.drain();

  assert.equal(bus.sent.length, 1, "撤回了就不该再接着发");
  assert.equal(readQueue(dataDir).items[0].status, "skipped");
  manager.stop();
});
