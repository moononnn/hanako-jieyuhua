// 解语花 — 循环投递测试
// 重点覆盖外部改造者踩过的三个坑：
//   坑1 最后一轮掉回普通分支被提前收尾（设 N 轮只发 N-1 轮）
//   坑2 投递后竞态，两轮挤在一起不等回复
//   坑3 测试用假会话文件导致对账一路放行，测试全绿但线上翻车
// 本模块不排队、不做语境对账，坑1/坑3 从结构上不存在；坑2 用最小间隔挡住。
// 另加一条回归：自动续接的次数上限（原先只有「连续失败降级」，成功接一百次也不降级）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  ContinueLoopRegistry,
  LOOP_MIN_GAP_MS,
  describeLoop,
  looksLikeFinished,
  normalizeLoopRounds,
  normalizeMaxAuto,
} from "../lib/continue-loop.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  checkResumeAutoAllowed,
  createResumePending,
  getConfig,
  listResumePending,
  markResumeAutoFired,
  normalizeConfig,
  resetResumeConsecutive,
  setConfig,
} from "../lib/data.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-loop-"));
}

// 把自动续接冷却归零：真实断联潮里两次自动发相隔超过 60 秒，
// 不清冷却的话次数上限永远抢不到，测不出「次数封顶」这个限制。
function clearAutoCooldown(dir, sessionId) {
  const file = path.join(dir, "data.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.resumeState?.[sessionId]) data.resumeState[sessionId].lastAutoTs = 0;
  fs.writeFileSync(file, JSON.stringify(data));
}

// ─── 数值夹取 ───

test("循环轮数夹在 0~50，非法值归零（关掉循环）", () => {
  assert.equal(normalizeLoopRounds(0), 0);
  assert.equal(normalizeLoopRounds(7), 7);
  assert.equal(normalizeLoopRounds(999), 50);
  assert.equal(normalizeLoopRounds(-4), 0);
  assert.equal(normalizeLoopRounds("6"), 6);
  assert.equal(normalizeLoopRounds("abc"), 0);
  assert.equal(normalizeLoopRounds(3.9), 3);
});

test("自动续接次数夹在 1~10，非法值回落 3", () => {
  assert.equal(normalizeMaxAuto(1), 1);
  assert.equal(normalizeMaxAuto(10), 10);
  assert.equal(normalizeMaxAuto(999), 10);
  assert.equal(normalizeMaxAuto(0), 1);
  assert.equal(normalizeMaxAuto(undefined), 3);
});

// ─── 完成措辞判断 ───

test("完成类措辞：强完成词命中", () => {
  assert.equal(looksLikeFinished("三处都改完了，你看下还有没有漏的"), true);
  assert.equal(looksLikeFinished("任务完成，报告如下"), true);
});

test("完成类措辞：句尾的反问也算（ta 在收尾时问你）", () => {
  assert.equal(looksLikeFinished("都改完了，接下来要我做什么？"), true);
});

test("完成类措辞：中途提一嘴不算误报", () => {
  // 「需要我」在句子中段，不在句尾 → 判为还在干活，继续跑
  assert.equal(looksLikeFinished("需要我补充资料吗？我都从仓库里拿到了，够用。"), false);
  assert.equal(looksLikeFinished("我先按你上次的方案做了两步"), false);
  assert.equal(looksLikeFinished(""), false);
});

// ─── 状态机主流程 ───

test("循环走满 N 轮：每轮都判继续，跑满自己停", () => {
  let t = 1000;
  const loop = new ContinueLoopRegistry({ now: () => t });
  loop.start({ sessionId: "s1", sessionPath: "p", rounds: 3 });
  for (let i = 0; i < 3; i += 1) {
    const d = loop.decideAfterTurn("s1", { assistantText: "还在往下做", now: t });
    assert.equal(d.action, "continue", `第 ${i + 1} 轮应继续`);
    t += LOOP_MIN_GAP_MS;
    const after = loop.markFired("s1", t);
    assert.equal(after.done, i + 1);
    t += 8000; // 模拟 ta 回了一轮：真实间隔远大于最小间隔
  }
  assert.equal(loop.get("s1"), null, "跑满后状态应清掉");
});

// ─── 坑1：最后一轮不能被提前收尾 ───

test("坑1：最后一轮（剩 1 轮）照样发，不因「剩几轮」被提前收尾", () => {
  let t = 1000;
  const loop = new ContinueLoopRegistry({ now: () => t });
  loop.start({ sessionId: "s1", sessionPath: "p", rounds: 2 });
  // 第 1 轮：剩 2
  assert.equal(loop.decideAfterTurn("s1", { now: t }).action, "continue");
  t += LOOP_MIN_GAP_MS;
  loop.markFired("s1", t);
  t += 8000;
  // 第 2 轮：剩 1，正是会掉回普通分支的临界点
  const last = loop.decideAfterTurn("s1", { now: t });
  assert.equal(last.action, "continue", "最后一轮必须继续发，不能提前收尾");
  t += LOOP_MIN_GAP_MS;
  const done = loop.markFired("s1", t);
  assert.equal(done.done, 2);
  assert.equal(done.exhausted, true);
  assert.equal(loop.get("s1"), null);
});

test("轮数用尽后再来一轮直接判 finished", () => {
  const loop = new ContinueLoopRegistry({ now: () => 1 });
  loop.start({ sessionId: "s1", rounds: 1 });
  loop.markFired("s1", 1);
  loop.start({ sessionId: "s1", rounds: 1 });
  loop.markFired("s1", 1);
  // 再造一个已用尽的边界：done === total 时判 finished
  const l2 = new ContinueLoopRegistry({ now: () => 1 });
  l2.start({ sessionId: "s2", rounds: 1 });
  l2.markFired("s2", 1);
  assert.equal(l2.get("s2"), null, "刚好跑满就清掉，不会再判一次 finished");
});

// ─── 坑2：最小间隔防连发 ───

test("坑2：刚发完立刻又来一轮（没等回复）判 wait，等间隔到了再走", () => {
  let now = 1000;
  const loop = new ContinueLoopRegistry({ now: () => now });
  loop.start({ sessionId: "s1", rounds: 10 });
  loop.markFired("s1", now);
  now += 100; // 宿主还没进生成态就又来了一轮
  const d = loop.decideAfterTurn("s1", {});
  assert.equal(d.action, "wait");
  assert.equal(d.retryAt, 1000 + LOOP_MIN_GAP_MS);
  now += LOOP_MIN_GAP_MS;
  assert.equal(loop.decideAfterTurn("s1", {}).action, "continue");
});

// ─── 折中方案：像收工了只提示不停 ───

test("折中：命中完成措辞转 awaiting，用户确认后才继续", () => {
  const loop = new ContinueLoopRegistry({ now: () => 100 });
  loop.start({ sessionId: "s1", sessionPath: "p", rounds: 10 });
  const d = loop.decideAfterTurn("s1", { assistantText: "第一阶段做完了，接下来要我做什么？" });
  assert.equal(d.action, "confirm");
  assert.equal(loop.get("s1").status, "awaiting");
  assert.equal(loop.get("s1").done, 0, "询问本身不发消息，不消耗轮数");

  const back = loop.resumeAfterConfirm("s1");
  assert.equal(back.status, "running");
  assert.equal(loop.decideAfterTurn("s1", { assistantText: "那我接着往下做" }).action, "continue");
});

test("awaiting 状态下不再自动推进，等用户拍板", () => {
  const loop = new ContinueLoopRegistry({ now: () => 1 });
  loop.start({ sessionId: "s1", rounds: 5 });
  loop.decideAfterTurn("s1", { assistantText: "改完了" });
  assert.equal(loop.decideAfterTurn("s1", { assistantText: "改完了" }), null);
});

test("询问有冷却，不会一轮问一次", () => {
  let now = 1000;
  const loop = new ContinueLoopRegistry({ now: () => now });
  loop.start({ sessionId: "s1", rounds: 20 });
  loop.decideAfterTurn("s1", { assistantText: "做完了" });
  now += 1000;
  assert.equal(loop.canAskAgain("s1"), false);
  now += 60_000;
  assert.equal(loop.canAskAgain("s1"), true);
});

// ─── 用户接手与停止 ───

test("用户自己发消息：循环当场停，不跟人抢麦", () => {
  const loop = new ContinueLoopRegistry();
  loop.start({ sessionId: "s1", rounds: 10 });
  const stopped = loop.onUserMessage("s1");
  assert.equal(stopped.reason, "你自己接过话了");
  assert.equal(loop.get("s1"), null);
});

test("按停止：清状态且不误伤没在循环的会话", () => {
  const loop = new ContinueLoopRegistry();
  assert.equal(loop.stop("nope").ok, false);
  loop.start({ sessionId: "s1", rounds: 10 });
  assert.equal(loop.stop("s1", "用户停止").ok, true);
  assert.equal(loop.get("s1"), null);
});

test("启动循环必须拿到会话 id", () => {
  const loop = new ContinueLoopRegistry();
  assert.equal(loop.start({ sessionId: "" }).ok, false);
});

// ─── 面板文案 ───

test("面板进度文案带轮次", () => {
  const loop = new ContinueLoopRegistry();
  loop.start({ sessionId: "s1", rounds: 10 });
  assert.equal(describeLoop(loop.get("s1")), "正在续 第 1/10 轮");
  loop.markFired("s1", 1);
  assert.equal(describeLoop(loop.get("s1")), "正在续 第 2/10 轮");
  assert.equal(describeLoop(null), "");
});

// ─── 自动续接次数上限（本次新增的限制） ───

test("自动续接：超过设定次数就不再自动发，落回弹窗", async () => {
  const dir = tmpDir();
  await setConfig(dir, { resume: { mode: "auto", maxAuto: 2 } });
  assert.equal(checkResumeAutoAllowed(dir, "s1").canAuto, true);
  await markResumeAutoFired(dir, "s1");
  clearAutoCooldown(dir, "s1");
  assert.equal(checkResumeAutoAllowed(dir, "s1").canAuto, true);
  await markResumeAutoFired(dir, "s1");
  clearAutoCooldown(dir, "s1");
  const third = checkResumeAutoAllowed(dir, "s1");
  assert.equal(third.canAuto, false);
  assert.equal(third.reason, "auto_limit", "要能分清是次数上限而不是冷却");
});

test("断联潮结束（正常回合跑通）后次数重新计", async () => {
  const dir = tmpDir();
  await setConfig(dir, { resume: { mode: "auto", maxAuto: 1 } });
  await markResumeAutoFired(dir, "s1");
  clearAutoCooldown(dir, "s1");
  assert.equal(checkResumeAutoAllowed(dir, "s1").canAuto, false);
  await resetResumeConsecutive(dir, "s1");
  assert.equal(checkResumeAutoAllowed(dir, "s1").canAuto, true);
});

test("默认档是提醒，循环默认关但保留常用轮数", () => {
  const dir = tmpDir();
  const cfg = getConfig(dir);
  assert.equal(cfg.resume.mode, "notify");
  assert.equal(cfg.resume.autoContinue, false);
  assert.equal(cfg.resume.loopEnabled, false);
  assert.equal(cfg.resume.loopRounds, 5);
  assert.equal(DEFAULT_CONFIG.resume.loopEnabled, false);
  assert.equal(DEFAULT_CONFIG.resume.loopRounds, 5);
});

test("循环开关与轮数设置可独立持久化", async () => {
  const dir = tmpDir();
  await setConfig(dir, { resume: { loopEnabled: true, loopRounds: 8 } });
  const cfg = getConfig(dir);
  assert.equal(cfg.resume.loopEnabled, true);
  assert.equal(cfg.resume.loopRounds, 8);
  await setConfig(dir, { resume: { ...cfg.resume, loopEnabled: false } });
  const after = getConfig(dir);
  assert.equal(after.resume.loopEnabled, false);
  assert.equal(after.resume.loopRounds, 8);
});

test("切到 auto 档后派生开关跟着变", async () => {
  const dir = tmpDir();
  await setConfig(dir, { resume: { mode: "auto", maxAuto: 5, loopEnabled: true, loopRounds: 8 } });
  const cfg = getConfig(dir);
  assert.equal(cfg.resume.autoContinue, true);
  assert.equal(cfg.resume.enabled, true);
  assert.equal(cfg.resume.maxAuto, 5);
  assert.equal(cfg.resume.loopEnabled, true);
  assert.equal(cfg.resume.loopRounds, 8);
});

test("旧数据只有布尔开关时按旧语义折算，不丢用户设置", () => {
  const cfg = normalizeConfig({ resume: { enabled: false, autoContinue: true } });
  assert.equal(cfg.resume.mode, "auto");
  const cfg2 = normalizeConfig({ resume: { enabled: true, autoContinue: false } });
  assert.equal(cfg2.resume.mode, "notify");
  const cfg3 = normalizeConfig({ resume: { mode: "auto" } });
  assert.equal(cfg3.resume.mode, "auto");
});

// ── 循环确认卡的 source 标记（2026-09-30 发布前审查发现）──
// 回归背景：createResumePending 和归一化原本只认 stuck_turn，loop_confirm 被清成空串。
// 面板靠这个标记认出「循环跑到收工话」，认不出就只能当普通断联处理，
// 用户点「继续哈」只是发了一句话，原循环接不回来。

test("循环确认待办的 source 标记落盘后必须保住", async () => {
  const dir = tmpDir();
  const created = await createResumePending(dir, {
    agentId: "hanako",
    sessionId: "s1",
    sessionPath: "C:\\sessions\\s1.jsonl",
    reason: "ta 好像做完了",
    source: "loop_confirm",
  });
  assert.equal(created.entry.source, "loop_confirm");
  const listed = listResumePending(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].source, "loop_confirm", "归一化不能把 loop_confirm 清成空串");
});

test("断联待办仍是 stuck_turn，未知来源仍清空", async () => {
  const dir = tmpDir();
  await createResumePending(dir, { sessionId: "s2", sessionPath: "C:\\sessions\\s2.jsonl", source: "stuck_turn" });
  await createResumePending(dir, { sessionId: "s3", sessionPath: "C:\\sessions\\s3.jsonl", source: "乱填的" });
  const listed = listResumePending(dir);
  const byId = (sid) => listed.find((item) => item.sessionId === sid);
  assert.equal(byId("s2").source, "stuck_turn");
  assert.equal(byId("s3").source, "", "未知来源仍应清空，不能因为修了 loop_confirm 就来者不拒");
});
