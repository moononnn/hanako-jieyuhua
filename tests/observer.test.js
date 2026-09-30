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

function hasReplySummarySystem(messages) {
  return messages.some((message) => typeof message?.content === "string"
    && message.content.includes("🌸 解语花 · 回复速览")
    && message.content.includes("Markdown 引用块")
    && message.content.includes("正文之后")
    && message.content.includes("最后一个内容")
    && message.content.includes("不能用速览替代、缩短或省略正文")
    && message.content.includes("标题必须逐字使用这一行")
    && message.content.includes("用户需要做的下一步")
    && message.content.includes("总计最多三条短要点"));
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
