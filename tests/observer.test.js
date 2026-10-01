// 解语花 observer ask 引导回归测试
// 覆盖：实时悬浮球状态门、融合球状态门，以及非悬浮球模式不注入 ask 引导。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function writeData(home, presentation, replySummaryFrequency = "standard") {
  const dir = path.join(home, "plugin-data", "jiegehua");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({
    config: { presentation, mode: "always", replySummaryFrequency },
    pending: {},
    askPending: {},
    askSkips: [],
  }));
}

function hasAskGuidance(messages) {
  return messages.some((message) => {
    const content = message?.content;
    if (typeof content === "string") {
      return content.includes("只有用户明确让你在几个选项里选定")
        || content.includes("前者是普通对话");
    }
    if (Array.isArray(content)) {
      return content.some((part) => typeof part?.text === "string" && (
        part.text.includes("只有用户明确让你在几个选项里选定")
        || part.text.includes("前者是普通对话")
      ));
    }
    return false;
  });
}

function replySummarySystem(messages) {
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === "string" && content.includes("（解语花·回复速览）")) return content;
    if (Array.isArray(content)) {
      const part = content.find((item) => typeof item?.text === "string" && item.text.includes("（解语花·回复速览）"));
      if (part) return part.text;
    }
  }
  return "";
}

function hasReplySummarySystem(messages) {
  const system = replySummarySystem(messages);
  return system.includes("🌸 解语花 · 回复速览")
    && system.includes("Markdown 引用块")
    && system.includes("正文之后")
    && system.includes("最后一个内容")
    && system.includes("不能用速览替代、缩短或省略正文")
    && system.includes("标题必须逐字使用这一行")
    && system.includes("用户需要做的下一步")
    && system.includes("总计最多三条短要点");
}

function replySummaryNudge(messages) {
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === "string" && content.includes("💡 如果你这轮的回答正文")) return content;
    if (Array.isArray(content)) {
      const part = content.find((item) => typeof item?.text === "string" && item.text.includes("💡 如果你这轮的回答正文"));
      if (part) return part.text;
    }
  }
  return "";
}

function hasReplySummaryNudge(messages) {
  return Boolean(replySummaryNudge(messages));
}

test("observer 为启用的解语花模式注入长回复速览引导，ask 引导仍受悬浮球状态门控", async () => {
  const previousHome = process.env.HANA_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-observer-"));
  process.env.HANA_HOME = home;

  try {
    writeData(home, "ball");
    const { default: installObserver } = await import(`../extensions/observer.js?observer-test=${Date.now()}`);
    const handlers = {};
    installObserver({ on(name, handler) { handlers[name] = handler; } });

    const stopped = { messages: [{ role: "user", content: "帮我决定一下" }] };
    const stoppedResult = await handlers.context(stopped, {
      bus: { async request() { return { mode: "separate", blocking: false }; } },
    });
    assert.ok(Array.isArray(stoppedResult?.messages), "悬浮球关闭时仍应返回速览引导");
    assert.equal(hasAskGuidance(stopped.messages), false);
    assert.equal(hasReplySummarySystem(stopped.messages), true);
    assert.equal(hasReplySummaryNudge(stopped.messages), true);
    assert.match(replySummaryNudge(stopped.messages), /> \*\*🌸 解语花 · 回复速览\*\*/);
    assert.match(replySummaryNudge(stopped.messages), /最多三条短要点/);

    const fused = { messages: [{ role: "user", content: "请帮我拍板" }] };
    const fusedResult = await handlers.context(fused, {
      bus: { async request() { return { mode: "fused", blocking: true, fusionPid: 12345 }; } },
    });
    assert.ok(Array.isArray(fusedResult?.messages));
    assert.equal(hasAskGuidance(fused.messages), true);
    assert.equal(hasReplySummarySystem(fused.messages), true);

    writeData(home, "card");
    const card = { messages: [{ role: "user", content: "帮我决定一下" }] };
    await handlers.context(card, { bus: { async request() { throw new Error("should not query fusion in card mode"); } } });
    assert.equal(hasAskGuidance(card.messages), false);
    assert.equal(hasReplySummarySystem(card.messages), true);
    assert.equal(hasReplySummaryNudge(card.messages), true);

    const multipart = { messages: [{ role: "user", content: [{ type: "text", text: "请展开讲讲" }] }] };
    await handlers.context(multipart, { bus: { async request() { throw new Error("should not query fusion in card mode"); } } });
    assert.equal(hasReplySummarySystem(multipart.messages), true);
    assert.match(replySummaryNudge(multipart.messages), /大约 500 字以上/, "标准档应使用约 500 字的参照");

    writeData(home, "card", "less");
    const less = { messages: [{ role: "user", content: "给我讲讲" }] };
    await handlers.context(less, { bus: { async request() { throw new Error("should not query fusion in card mode"); } } });
    assert.match(replySummaryNudge(less.messages), /大约 800 字以上/, "少一点档应提高触发门槛");

    writeData(home, "card", "more");
    const more = { messages: [{ role: "user", content: "展开说说" }] };
    await handlers.context(more, { bus: { async request() { throw new Error("should not query fusion in card mode"); } } });
    assert.match(replySummaryNudge(more.messages), /大约 300 字以上/, "多一点档应降低触发门槛");

    writeData(home, "off");
    const off = { messages: [{ role: "user", content: "来段长解释" }] };
    const offResult = await handlers.context(off, { bus: { async request() { throw new Error("off mode should not query fusion"); } } });
    assert.equal(offResult, undefined);
    assert.equal(hasReplySummarySystem(off.messages), false);
  } finally {
    if (previousHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previousHome;
  }
});

test("速览引导要求写大白话，并在需要用户拍板时无视字数门槛也触发", async () => {
  const previousHome = process.env.HANA_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-observer-plain-"));
  process.env.HANA_HOME = home;

  try {
    writeData(home, "card", "less");
    const { default: installObserver } = await import(`../extensions/observer.js?observer-plain=${Date.now()}`);
    const handlers = {};
    installObserver({ on(name, handler) { handlers[name] = handler; } });

    const messages = [{ role: "user", content: "帮我决定一下" }];
    await handlers.context({ messages }, { bus: { async request() { throw new Error("card mode"); } } });

    const system = replySummarySystem(messages);
    const nudge = replySummaryNudge(messages);
    assert.ok(system && nudge, "应同时注入 system 引导和用户消息 nudge");

    // 大白话：禁术语/公文腔，而不是只要求「压缩」
    assert.match(system, /速览的语言必须是人话/);
    assert.match(system, /不得出现术语、缩写、英文标识、字段名、组件名和内部流程黑话/);
    assert.match(system, /禁止「结论如下」「综上」「需要注意的点」这类公文腔/);
    assert.match(system, /不能拿内部模块当主语/);
    assert.match(nudge, /速览要写成人话/);

    // 拍板场景不看字数门槛
    for (const text of [system, nudge]) {
      assert.match(text, /或者正文里有需要用户拍板、选一条路或确认要不要做的事/);
      assert.match(text, /哪怕还没到字数门槛/);
    }
    assert.match(system, /现在轮到你定……/);
    assert.match(system, /不能只丢一句「请回复 1\/2」/);
    assert.match(system, /看不懂、太长了、说人话、懒得看/);
    assert.match(nudge, /现在轮到你定/);

    // 旧的硬约束一条都不能因为加料而丢掉
    assert.match(nudge, /> \*\*🌸 解语花 · 回复速览\*\*/);
    assert.match(nudge, /最多三条短要点/);
    assert.match(nudge, /大约 800 字以上/, "少一点档仍应保留原有字数参照");
    assert.equal(hasReplySummarySystem(messages), true);
  } finally {
    if (previousHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previousHome;
  }
});
