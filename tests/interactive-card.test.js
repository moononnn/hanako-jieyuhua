// 解语花 · Interactive Card 协议回归

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildShowCardInput,
  buildShowCardInstruction,
  buildSuggestionCardDocument,
  buildSuggestionCardFragment,
  buildLegacyCardDetails,
  supportsInteractiveCard,
} from "../lib/suggestion-card.js";
import { createPending, getPending, saveData } from "../lib/data.js";
import { execute as applySuggestion } from "../tools/apply_suggestion.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-card-"));
}

test("宿主版本按能力分流：0.680.9 才进入 Interactive Card，新旧公开版走旧卡片", () => {
  assert.equal(supportsInteractiveCard("0.680.9"), true);
  assert.equal(supportsInteractiveCard("0.680.10"), true);
  assert.equal(supportsInteractiveCard("0.679.9"), false);
  assert.equal(supportsInteractiveCard("0.450.0"), false);
  assert.equal(supportsInteractiveCard(""), false);
  assert.deepEqual(buildLegacyCardDetails({ rid: "r_old", sessionPath: "C:/s.jsonl", count: 3 }), {
    type: "iframe",
    pluginId: "jiegehua",
    sessionPath: "C:/s.jsonl",
    route: "/suggest?r=r_old",
    aspectRatio: "400:230",
    title: "解语花",
  });
});

test("推荐卡文档带唯一导入标记、标题和真实推荐文本", () => {
  const document = buildSuggestionCardDocument({
    rid: "r_test_1",
    action: "copy",
    items: [
      { text: "你刚才那个方案咋个落地嘛", direction: "追问" },
      { text: "我也想试一下这个方法", direction: "分享" },
      { text: "你帮我列个步骤呗", direction: "行动" },
    ],
  });
  assert.equal((document.match(/hana-card-fragment-begin/g) || []).length, 1);
  assert.equal((document.match(/hana-card-fragment-end/g) || []).length, 1);
  assert.match(document, /<title>解语花推荐回复<\/title>/);
  assert.match(document, /你刚才那个方案咋个落地嘛/);
  assert.match(document, /data-card-manifest/);
  assert.doesNotMatch(document, /details\.card/);
});

test("空推荐也有明确空态，键盘焦点有可见反馈", () => {
  const fragment = buildSuggestionCardFragment({ rid: "r_empty", action: "copy", items: [] });
  assert.match(fragment, /暂时没有合适的推荐/);
  assert.match(fragment, /focus-visible/);
});

test("复制模式只声明 clipboard binding，不把推荐文本写成 HTML", () => {
  const fragment = buildSuggestionCardFragment({
    rid: "r_x",
    action: "copy",
    items: [{ text: "<这句不能打穿 script>" }],
  });
  assert.match(fragment, /clipboard\.writeText/);
  assert.match(fragment, /slots/);
  assert.match(fragment, /\\u003c这句不能打穿 script\\u003e/);
  assert.doesNotMatch(fragment, /<这句不能打穿 script>/);
});

test("发送模式固定 rid，并声明复制兜底", () => {
  const fragment = buildSuggestionCardFragment({
    rid: "r_send",
    action: "send",
    items: [{ text: "直接发这句" }],
  });
  assert.match(fragment, /jiegehua_apply_suggestion/);
  assert.match(fragment, /\"rid\":\"r_send\"/);
  assert.match(fragment, /\"slots\":\[\"index\"\]/);
  assert.match(fragment, /clipboard\.writeText/);
  assert.match(fragment, /直接发送暂时不可用，已复制/);
});

test("show_card 参数优先使用当前 session 的 .card.html fileId", () => {
  const input = buildShowCardInput({ fileId: "sf_card_1" });
  assert.deepEqual(input, {
    title: "解语花推荐回复",
    file: { type: "session_file", fileId: "sf_card_1" },
  });
  const instruction = buildShowCardInstruction(input);
  assert.match(instruction, /show_card/);
  assert.match(instruction, /sf_card_1/);
});

test("suggest_replies 在旧版宿主返回 details.card，不泄漏 show_card 内部指令", async () => {
  const dir = tmpDir();
  const home = tmpDir();
  const oldHome = process.env.HANA_HOME;
  process.env.HANA_HOME = home;
  fs.writeFileSync(path.join(home, "server-info.json"), JSON.stringify({ version: "0.450.0" }));
  saveData(dir, { config: { presentation: "card", count: 3, action: "copy" } });
  try {
    const { execute } = await import("../tools/suggest_replies.js");
    const result = await execute({}, {
      dataDir: dir,
      pluginId: "jiegehua",
      sessionId: "sess_old",
      model: { async sample() { return JSON.stringify([{ text: "我想继续聊聊", direction: "追问" }, { text: "我也有点想法", direction: "分享" }, { text: "你帮我看看嘛", direction: "行动" }]); } },
    });
    assert.ok(result.details?.card);
    assert.equal(result.details.suggestionCard, undefined);
    assert.doesNotMatch(result.content[0].text, /show_card/);
  } finally {
    process.env.HANA_HOME = oldHome;
  }
});

test("suggest_replies 在 0.680.9 走 show_card Interactive Card", async () => {
  const dir = tmpDir();
  const home = tmpDir();
  const oldHome = process.env.HANA_HOME;
  process.env.HANA_HOME = home;
  fs.writeFileSync(path.join(home, "server-info.json"), JSON.stringify({ version: "0.680.9" }));
  saveData(dir, { config: { presentation: "card", count: 3, action: "copy" } });
  try {
    const { execute } = await import("../tools/suggest_replies.js");
    const result = await execute({}, {
      dataDir: dir,
      pluginId: "jiegehua",
      sessionId: "sess_new",
      sessionPath: "C:/sessions/new.jsonl",
      stageFile: async () => ({ file: { fileId: "sf_new_card" }, mediaItem: { fileId: "sf_new_card" } }),
      model: { async sample() { return JSON.stringify([{ text: "我想继续聊聊", direction: "追问" }, { text: "我也有点想法", direction: "分享" }, { text: "你帮我看看嘛", direction: "行动" }]); } },
    });
    assert.equal(result.details?.suggestionCard?.protocol, "show_card");
    assert.match(result.content[0].text, /show_card/);
  } finally {
    process.env.HANA_HOME = oldHome;
  }
});

test("卡片发送工具只从 pending 记录取文本", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "服务端取出的推荐" }],
    sessionId: "sess_card",
    sessionPath: "C:/sessions/card.jsonl",
  });
  let call = null;
  const result = await applySuggestion({ rid, index: 0 }, {
    dataDir: dir,
    bus: {
      async request(name, payload) {
        call = { name, payload };
        return { ok: true };
      },
    },
  });
  assert.equal(result.content[0].text, "已发送");
  assert.deepEqual(call, {
    name: "session:send",
    payload: {
      text: "服务端取出的推荐",
      sessionId: "sess_card",
      sessionPath: "C:/sessions/card.jsonl",
    },
  });
  assert.equal(getPending(dir, rid).used, true);
});

test("卡片发送工具把总线返回的失败标成 ok:false", async () => {
  const dir = tmpDir();
  const { rid } = await createPending(dir, {
    items: [{ text: "这次应该失败" }],
    sessionId: "sess_card",
    sessionPath: "C:/sessions/card.jsonl",
  });
  const result = await applySuggestion({ rid, index: 0 }, {
    dataDir: dir,
    bus: {
      async request() {
        return { ok: false, error: "session not found" };
      },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.content[0].text, /session not found/);
  assert.equal(getPending(dir, rid).used, false);
});
