// 解语花 observer ask 引导回归测试
// 覆盖：实时悬浮球状态门、融合球状态门，以及非悬浮球模式不注入 ask 引导。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function writeData(home, presentation) {
  const dir = path.join(home, "plugin-data", "jiegehua");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({
    config: { presentation, mode: "always" },
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

test("observer 只在实时悬浮球或融合球运行时注入 ask 引导", async () => {
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
    assert.equal(stoppedResult, undefined);
    assert.equal(hasAskGuidance(stopped.messages), false);

    const fused = { messages: [{ role: "user", content: "请帮我拍板" }] };
    const fusedResult = await handlers.context(fused, {
      bus: { async request() { return { mode: "fused", blocking: true, fusionPid: 12345 }; } },
    });
    assert.ok(Array.isArray(fusedResult?.messages));
    assert.equal(hasAskGuidance(fused.messages), true);

    writeData(home, "card");
    const card = { messages: [{ role: "user", content: "帮我决定一下" }] };
    await handlers.context(card, { bus: { async request() { throw new Error("should not query fusion in card mode"); } } });
    assert.equal(hasAskGuidance(card.messages), false);
  } finally {
    if (previousHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previousHome;
  }
});
