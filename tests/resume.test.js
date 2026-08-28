// 解语花断联续接（resume）回归测试（node:test，零依赖）
// 覆盖：事件解析 / 断联原因文案 / 状态机（宽限期·重试联动·去重）/ 待办队列 / 防风暴 / 配置默认与迁移。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ResumeTurnTracker,
  buildResumeCard,
  buildResumeReason,
  isFinalTurn,
  isUserInitiatedAbortReason,
  parseAutoRetryEndResume,
  parseAutoRetryStartResume,
  parseProviderErrorResume,
  parseSessionAbortResume,
  parseTurnEndResume,
  parseTurnFailureResume,
  RESUME_GRACE_MS,
  RESUME_TEXT,
} from "../lib/resume.js";
import {
  DEFAULT_CONFIG,
  bumpResumeConsecutive,
  checkResumeAutoAllowed,
  consumeResume,
  createResumePending,
  dismissResumeBySession,
  listResumeNotices,
  listResumePending,
  loadData,
  markResumeAutoFired,
  normalizeData,
  pushResumeNotice,
  resetResumeConsecutive,
  RESUME_MAX_PENDING,
  RESUME_NOTICE_TTL_MS,
  RESUME_TTL_MS,
} from "../lib/data.js";

const SESSION_PATH = "C:\\agents\\hanako\\sessions\\sess_test.jsonl";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-resume-"));
}

function turnEndEvent(overrides = {}) {
  return {
    type: "turn_end",
    message: { stopReason: "error", errorMessage: "Connection timed out" },
    ...overrides,
  };
}

// ─── 事件解析 ───

test("parseTurnFailureResume：stopReason=error 记为失败", () => {
  const failure = parseTurnFailureResume(turnEndEvent(), SESSION_PATH);
  assert.ok(failure);
  assert.equal(failure.sessionId, "sess_test");
  assert.equal(failure.agentId, "hanako");
  assert.equal(failure.errorMessage, "Connection timed out");
});

test("parseTurnFailureResume：用户主动停止不算断联", () => {
  const failure = parseTurnFailureResume(
    turnEndEvent({ aborted: true, reason: "user_cancel", message: { stopReason: "stop" } }),
    SESSION_PATH,
  );
  assert.equal(failure, null);
});

test("parseTurnFailureResume：异常释放（aborted 非用户原因）记为失败", () => {
  const failure = parseTurnFailureResume(
    turnEndEvent({ aborted: true, reason: "provider_crash", message: { stopReason: "stop" } }),
    SESSION_PATH,
  );
  assert.ok(failure);
});

test("parseTurnFailureResume：正常回合不误报", () => {
  const failure = parseTurnFailureResume(
    turnEndEvent({ message: { stopReason: "stop", content: [{ type: "text", text: "好的" }] } }),
    SESSION_PATH,
  );
  assert.equal(failure, null);
});

test("parseProviderErrorResume：error 事件兜底", () => {
  const parsed = parseProviderErrorResume({ type: "error", message: "rate limit exceeded" }, SESSION_PATH);
  assert.ok(parsed);
  assert.equal(parsed.errorMessage, "rate limit exceeded");
});

test("parseSessionAbortResume：强制释放记录，用户 abort 不记录", () => {
  const forced = parseSessionAbortResume(
    { type: "session_status", isStreaming: false, aborted: true, reason: "session_timeout" },
    SESSION_PATH,
  );
  assert.ok(forced);
  const user = parseSessionAbortResume(
    { type: "session_status", isStreaming: false, aborted: true, reason: "abort" },
    SESSION_PATH,
  );
  assert.equal(user, null);
});

test("parseAutoRetryStartResume / EndResume 解析重试状态", () => {
  const start = parseAutoRetryStartResume({ type: "auto_retry_start", attempt: 2, maxAttempts: 3 }, SESSION_PATH);
  assert.ok(start);
  assert.equal(start.sessionId, "sess_test");
  const end = parseAutoRetryEndResume(
    { type: "auto_retry_end", success: false, finalError: "boom" },
    SESSION_PATH,
  );
  assert.ok(end);
  assert.equal(end.success, false);
});

test("isUserInitiatedAbortReason 白名单", () => {
  for (const reason of ["abort", "abort_all", "close", "close_all", "user_abort", "user_cancel"]) {
    assert.equal(isUserInitiatedAbortReason(reason), true, reason);
  }
  assert.equal(isUserInitiatedAbortReason("provider_crash"), false);
});

test("isFinalTurn：空/stop 是最终回合，toolUse 不是", () => {
  assert.equal(isFinalTurn(""), true);
  assert.equal(isFinalTurn("stop"), true);
  assert.equal(isFinalTurn("toolUse"), false);
});

test("parseTurnEndResume：文本拼接与字段提取", () => {
  const info = parseTurnEndResume(
    turnEndEvent({
      message: {
        stopReason: "stop",
        content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }],
      },
    }),
    SESSION_PATH,
  );
  assert.ok(info);
  assert.equal(info.text, "第一段第二段");
  assert.equal(info.stopReason, "stop");
});

// ─── 断联原因文案 ───

test("buildResumeReason 按错误分类成大白话", () => {
  assert.equal(buildResumeReason("Connection timed out"), "等太久了没等到回复");
  assert.equal(buildResumeReason("rate limit exceeded"), "这个窗口被限流了");
  assert.equal(buildResumeReason("ECONNRESET socket hang up"), "网络连接断了");
  assert.equal(buildResumeReason("401 unauthorized"), "模型连接出了点问题");
  assert.equal(buildResumeReason(""), "窗口断联了");
  assert.equal(buildResumeReason("", { aborted: true }), "窗口被意外中断了");
  assert.equal(buildResumeReason("unknown weird error"), "窗口断联了");
});

test("buildResumeCard 拼窗口名与原因", () => {
  const card = buildResumeCard({
    agentName: "小花",
    sessionTitle: "插件闲聊",
    reason: "网络连接断了",
  });
  assert.equal(card.title, "🌸 窗口断联了");
  assert.ok(card.body.includes("小花 · 插件闲聊"));
  assert.ok(card.body.includes("点「继续」接上话头"));
});

// ─── 状态机 ───

test("失败宽限期后触发断联提醒，正常回合到达则取消", () => {
  let alerted = null;
  const tracker = new ResumeTurnTracker({
    onAlert: (a) => { alerted = a; },
    graceMs: 10,
    schedule: (fn, ms) => setTimeout(fn, ms),
  });
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure({ sessionId: "s1", errorMessage: "timeout" });
  tracker.onTurnSuccess("s1");
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(alerted, null, "正常完成不应触发");
      resolve();
    }, 30);
  });
});

test("宿主自动重试开始取消兜底，重试耗尽才触发", async () => {
  let alerted = null;
  const tracker = new ResumeTurnTracker({
    onAlert: (a) => { alerted = a; },
    graceMs: 5,
    schedule: (fn, ms) => setTimeout(fn, ms),
  });
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure({ sessionId: "s1", errorMessage: "timeout" });
  tracker.onRetryStart("s1");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(alerted, null, "重试中不应触发");
  tracker.onRetryEnd({ sessionId: "s1", success: false, finalError: "still down" });
  assert.ok(alerted);
  assert.equal(alerted.sessionId, "s1");
  assert.equal(alerted.source, "retry_exhausted");
});

test("重试成功不触发且清掉候选", async () => {
  let alerted = null;
  const tracker = new ResumeTurnTracker({
    onAlert: (a) => { alerted = a; },
    graceMs: 5,
    schedule: (fn, ms) => setTimeout(fn, ms),
  });
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure({ sessionId: "s1", errorMessage: "timeout" });
  tracker.onRetryStart("s1");
  tracker.onRetryEnd({ sessionId: "s1", success: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(alerted, null);
});

test("同一周期只提醒一次，用户新消息重置周期", async () => {
  let count = 0;
  const tracker = new ResumeTurnTracker({
    onAlert: () => { count++; },
    graceMs: 5,
    schedule: (fn, ms) => setTimeout(fn, ms),
  });
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure({ sessionId: "s1", errorMessage: "a" });
  await new Promise((r) => setTimeout(r, 10));
  tracker.onTurnFailure({ sessionId: "s1", errorMessage: "b" }); // 已提醒，不再触发
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(count, 1);
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure({ sessionId: "s1", errorMessage: "c" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(count, 2);
});

test("flush 立即触发兜底（测试入口）", () => {
  let alerted = null;
  const tracker = new ResumeTurnTracker({
    onAlert: (a) => { alerted = a; },
    graceMs: 10000,
    schedule: (fn, ms) => setTimeout(fn, ms),
  });
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure({ sessionId: "s1", errorMessage: "x" });
  const fired = tracker.flush("s1");
  assert.equal(fired, true);
  assert.equal(alerted.source, "turn_failure");
});

test("RESUME_TEXT 使用分享版统一文案「继续」", () => {
  assert.equal(RESUME_TEXT, "继续");
});

// ─── 待办队列 ───

test("createResumePending 创建并可在列表读到", async () => {
  const dir = tmpDir();
  const { resumeId, entry } = await createResumePending(dir, {
    agentId: "hanako",
    sessionId: "s1",
    sessionPath: "C:\\agents\\hanako\\sessions\\s1.jsonl",
    reason: "网络连接断了",
  });
  assert.ok(resumeId.startsWith("resume_"));
  assert.equal(entry.consumed, false);
  const list = listResumePending(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].resumeId, resumeId);
  assert.equal(list[0].reason, "网络连接断了");
});

test("同会话已有未消费待办 → 刷新不重复建", async () => {
  const dir = tmpDir();
  const first = await createResumePending(dir, { sessionId: "s1", sessionPath: "p1" });
  const second = await createResumePending(dir, { sessionId: "s1", sessionPath: "p1", reason: "限流" });
  assert.equal(second.refreshed, true);
  assert.equal(first.resumeId, second.resumeId);
  assert.equal(listResumePending(dir).length, 1);
  assert.equal(listResumePending(dir)[0].reason, "限流");
});

test("consumeResume 后不再出现在列表", async () => {
  const dir = tmpDir();
  const { resumeId } = await createResumePending(dir, { sessionId: "s1", sessionPath: "p1" });
  await consumeResume(dir, resumeId);
  assert.equal(listResumePending(dir).length, 0);
});

test("dismissResumeBySession 清掉该会话未消费待办", async () => {
  const dir = tmpDir();
  await createResumePending(dir, { sessionId: "s1", sessionPath: "p1" });
  await createResumePending(dir, { sessionId: "s2", sessionPath: "p2" });
  const removed = await dismissResumeBySession(dir, "s1");
  assert.equal(removed, 1);
  const list = listResumePending(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, "s2");
});

test("待办 TTL 过期后不再出现，prune 可清理", async () => {
  const dir = tmpDir();
  const { resumeId } = await createResumePending(dir, { sessionId: "s1", sessionPath: "p1" });
  const data = loadData(dir);
  data.resumePending[resumeId].ts = Date.now() - RESUME_TTL_MS - 1000;
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data, null, 2));
  assert.equal(listResumePending(dir).length, 0);
});

test("待办上限 RESUME_MAX_PENDING：超出丢最旧", async () => {
  const dir = tmpDir();
  for (let i = 0; i < RESUME_MAX_PENDING + 3; i++) {
    await createResumePending(dir, { sessionId: `s${i}`, sessionPath: `p${i}` });
  }
  const list = listResumePending(dir);
  assert.equal(list.length, RESUME_MAX_PENDING);
  const sessions = list.map((e) => e.sessionId);
  assert.ok(!sessions.includes("s0"));
  assert.ok(sessions.includes(`s${RESUME_MAX_PENDING + 2}`));
});

test("normalizeData：同会话多条待办只保留最新一条", async () => {
  const data = normalizeData({
    resumePending: {
      a: { resumeId: "a", sessionId: "s1", sessionPath: "p1", ts: 100 },
      b: { resumeId: "b", sessionId: "s1", sessionPath: "p1", ts: 200 },
      c: { resumeId: "c", sessionId: "s2", sessionPath: "p2", ts: 300 },
    },
  });
  assert.deepEqual(Object.keys(data.resumePending).sort(), ["b", "c"]);
});

// ─── 防风暴 ───

test("连续断联计数：bump 累计、reset 清零", async () => {
  const dir = tmpDir();
  assert.equal(await bumpResumeConsecutive(dir, "s1"), 1);
  assert.equal(await bumpResumeConsecutive(dir, "s1"), 2);
  await resetResumeConsecutive(dir, "s1");
  assert.equal(checkResumeAutoAllowed(dir, "s1").consecutive, 0);
});

test("自动续接冷却：发送后 60 秒内不允许再次自动", async () => {
  const dir = tmpDir();
  await bumpResumeConsecutive(dir, "s1");
  assert.equal(checkResumeAutoAllowed(dir, "s1").canAuto, true);
  await markResumeAutoFired(dir, "s1");
  assert.equal(checkResumeAutoAllowed(dir, "s1").canAuto, false);
});

test("连续断联过多自动降级为只弹窗", async () => {
  const dir = tmpDir();
  await bumpResumeConsecutive(dir, "s1");
  await bumpResumeConsecutive(dir, "s1");
  await bumpResumeConsecutive(dir, "s1");
  assert.equal(checkResumeAutoAllowed(dir, "s1").canAuto, false);
  assert.equal(checkResumeAutoAllowed(dir, "s1").consecutive, 3);
});

// ─── 自动续接通知 ───

test("push/listResumeNotice：60 秒内可见，过期过滤", async () => {
  const dir = tmpDir();
  await pushResumeNotice(dir, { agentName: "小花", title: "插件闲聊" });
  const notices = listResumeNotices(dir);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].agentName, "小花");
  const data = loadData(dir);
  data.resumeNotices[0].ts = Date.now() - RESUME_NOTICE_TTL_MS - 1000;
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data, null, 2));
  assert.equal(listResumeNotices(dir).length, 0);
});

// ─── 配置默认与归一化 ───

test("默认配置：resume 提醒开、自动续接关", () => {
  assert.equal(DEFAULT_CONFIG.resume.enabled, true);
  assert.equal(DEFAULT_CONFIG.resume.autoContinue, false);
});

test("normalizeConfig 收 resume 布尔开关并忽略非法值", async () => {
  const dir = tmpDir();
  const data = loadData(dir);
  data.config = { presentation: "ball", resume: { enabled: false, autoContinue: true } };
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data));
  const cfg = loadData(dir).config;
  assert.equal(cfg.resume.enabled, false);
  assert.equal(cfg.resume.autoContinue, true);
  // 非法值回默认
  const data2 = loadData(dir);
  data2.config = { resume: { enabled: "yes", autoContinue: 1 } };
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data2));
  const cfg2 = loadData(dir).config;
  assert.equal(cfg2.resume.enabled, true);
  assert.equal(cfg2.resume.autoContinue, false);
});

// ─── 续接发送（sendResumeContinue，zhujian.js） ───

import { sendResumeContinue } from "../lib/zhujian.js";

function realSessionPath(dir) {
  const p = path.join(dir, "sess_target.jsonl");
  fs.writeFileSync(p, "");
  return p;
}

function okBus() {
  return { request: async () => ({ ok: true }) };
}

function failBus(error) {
  return { request: async () => ({ ok: false, error }) };
}

test("sendResumeContinue：发送成功并消费待办", async () => {
  const dir = tmpDir();
  const sessionPath = realSessionPath(dir);
  const { resumeId } = await createResumePending(dir, { sessionId: "s1", sessionPath });
  const result = await sendResumeContinue(dir, okBus(), { resumeId });
  assert.equal(result.ok, true);
  assert.equal(result.sessionPath, sessionPath);
  assert.equal(listResumePending(dir).length, 0);
});

test("sendResumeContinue：裸字符串 resumeId 容错（早期路由错传形态，不误报 notFound）", async () => {
  const dir = tmpDir();
  const sessionPath = realSessionPath(dir);
  const { resumeId } = await createResumePending(dir, { sessionId: "s1", sessionPath });
  const result = await sendResumeContinue(dir, okBus(), resumeId);
  assert.equal(result.ok, true, "字符串参数应等价于 { resumeId }，而不是 notFound");
  assert.equal(result.notFound, undefined);
  assert.equal(listResumePending(dir).length, 0);
});

test("sendResumeContinue：按 sessionPath 直发（自动模式）不消费任何待办", async () => {
  const dir = tmpDir();
  const sessionPath = realSessionPath(dir);
  const result = await sendResumeContinue(dir, okBus(), { sessionPath });
  assert.equal(result.ok, true);
});

test("sendResumeContinue：宿主拒绝时失败且待办保留", async () => {
  const dir = tmpDir();
  const sessionPath = realSessionPath(dir);
  const { resumeId } = await createResumePending(dir, { sessionId: "s1", sessionPath });
  const result = await sendResumeContinue(dir, failBus("窗口正忙"), { resumeId });
  assert.equal(result.ok, false);
  assert.equal(result.error, "窗口正忙");
  assert.equal(listResumePending(dir).length, 1, "失败保留待办，可再点");
});

test("sendResumeContinue：本地文件检查不再是门禁，指向不存在文件也走宿主发送裁决", async () => {
  const dir = tmpDir();
  const { resumeId } = await createResumePending(dir, {
    sessionId: "s1",
    sessionPath: path.join(dir, "does-not-exist.jsonl"),
  });
  const result = await sendResumeContinue(dir, okBus(), { resumeId });
  assert.equal(result.ok, true, "发送交给宿主 session:send 裁决，不做本地 fs.existsSync 硬门禁");
  assert.equal(result.notFound, undefined);
  assert.equal(listResumePending(dir).length, 0);
});