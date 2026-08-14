// 解语花 — 推荐 prompt 公共构建测试（node:test，零依赖）
// 覆盖：新条款（模仿说话风格/语言跟随）、方向分配、hint 额外要求、空上下文兜底
//
// ⚠️ HANA_HOME 是 llm.js/session.js 模块加载时读取的常量，必须先设置再动态 import。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-prompt-test-"));
process.env.HANA_HOME = home;

const { buildSuggestionPrompt, buildStyleLines } = await import("../tools/suggest_replies.js");

const STYLES = [
  { name: "追问/延伸", intent: "顺着话题往下问一句" },
  { name: "分享/感慨", intent: "分享自己的感受" },
  { name: "行动/请求", intent: "让助手帮忙做点什么" },
];

test("prompt 包含模仿说话风格条款（含风险闸）", () => {
  const p = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "对话", hint: "" });
  assert.ok(p.includes("模仿用户说话的方式"));
  assert.ok(p.includes("不要为了模仿而把话说没"));
});

test("prompt 包含语言跟随条款", () => {
  const p = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "对话", hint: "" });
  assert.ok(p.includes("语言跟随对话的主要语言"));
  assert.ok(p.includes("别混"));
});

test("prompt 保留原有硬性要求（紧扣内容/口吻/长度/正反例/JSON 契约）", () => {
  const p = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "对话", hint: "" });
  assert.ok(p.includes("紧扣下面对话的具体内容"));
  assert.ok(p.includes("必须是用户的口吻"));
  assert.ok(p.includes("5~20 个字"));
  assert.ok(p.includes("反面例子"));
  assert.ok(p.includes("正面例子"));
  assert.ok(p.includes("只输出一个合法 JSON 数组"));
});

test("prompt 按条数分配方向（buildStyleLines 衔接）", () => {
  const p = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "对话", hint: "" });
  assert.ok(p.includes("4. 3 条请分别按以下方向生成"));
  assert.ok(p.includes("追问/延伸"));
});

test("prompt hint 作为额外要求附加，空 hint 不产生空行", () => {
  const withHint = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "对话", hint: "温柔一点" });
  assert.ok(withHint.includes("额外要求：温柔一点"));
  const noHint = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "对话", hint: "" });
  assert.ok(!noHint.includes("额外要求"));
});

test("prompt 空上下文给出兜底文案", () => {
  const p = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "", hint: "" });
  assert.ok(p.includes("（无可用对话，生成通用的用户对助手说的话）"));
});

test("buildStyleLines 保持原行为（默认方向补位）", () => {
  const lines = buildStyleLines(3, STYLES, undefined);
  assert.equal(lines[0], "4. 3 条请分别按以下方向生成，不要雷同：");
  assert.equal(lines.length, 4);
});
