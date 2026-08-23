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

const { buildSuggestionPrompt, buildStyleLines, hasAiFlavor } = await import("../tools/suggest_replies.js");

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

test("中文对话 → prompt 锁定中文输出（规则判定，非模型自判）", () => {
  const p = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "用户: 今天天气真好，我们去散步吧\n助手: 好呀", hint: "" });
  assert.ok(p.includes("这次对话主要是中文"));
  assert.ok(p.includes("必须全部用中文输出，不要用英文"));
  assert.ok(!p.includes("用英文输出"));
});

test("英文对话 → prompt 锁定英文输出", () => {
  const p = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "用户: Let's go for a walk today\n助手: Sure, great idea", hint: "" });
  assert.ok(p.includes("这次对话主要是英文"));
  assert.ok(p.includes("必须全部用英文输出，不要用中文"));
});

test("空上下文 → 默认锁定中文（中文用户兜底）", () => {
  const p = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "", hint: "" });
  assert.ok(p.includes("必须全部用中文输出"));
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

test("prompt 包含口语质量准则（杀八股，含错例→正例）", () => {
  const p = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "对话", hint: "" });
  assert.ok(p.includes("口语质量准则"));
  assert.ok(p.includes("不打比方"));
  assert.ok(p.includes("比…还…"));
  assert.ok(p.includes("哈哈确实"));
  assert.ok(p.includes("✗")); // 错例→正例对照格式
});

test("hasAiFlavor: 命中 AI 八股返回 true，正常口语返回 false", () => {
  assert.equal(hasAiFlavor("你这效率比开了挂还离谱"), true); // 比字句
  assert.equal(hasAiFlavor("仿佛打开了新世界的大门"), true); // 比喻词
  assert.equal(hasAiFlavor("我不是生气，而是一种更深的感觉"), true); // 不是…而是…
  assert.equal(hasAiFlavor("某种说不清的东西在心头绕"), true); // 模糊指代
  assert.equal(hasAiFlavor("这背后有一种诗意"), true); // 大词
  assert.equal(hasAiFlavor("心里泛起一丝涟漪"), true); // 模糊抒情词
  assert.equal(hasAiFlavor("哈哈确实"), true); // 万能敷衍
  assert.equal(hasAiFlavor("谢谢你的建议，我去试试"), true); // 礼貌腔
  assert.equal(hasAiFlavor("哇！！！这也太离谱了"), true); // 感叹号轰炸
  // 正常口语不误杀
  assert.equal(hasAiFlavor("你刚说的那个方案具体怎么操作"), false);
  assert.equal(hasAiFlavor("听你这么说我也想起一件事"), false);
  assert.equal(hasAiFlavor("那你帮我看看这个呗"), false);
  assert.equal(hasAiFlavor(""), false);
  assert.equal(hasAiFlavor(null), false);
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

test("prompt 按条数分配方向（buildStyleLines 衔接）", () => {
  const p = buildSuggestionPrompt({ count: 3, styles: STYLES, selected: undefined, contextText: "对话", hint: "" });
  assert.ok(p.includes("4. 3 条请分别按以下方向生成"));
  assert.ok(p.includes("追问/延伸"));
});

test("buildStyleLines 保持原行为（默认方向补位）", () => {
  const lines = buildStyleLines(3, STYLES, undefined);
  assert.equal(lines[0], "4. 3 条请分别按以下方向生成，不要雷同：");
  assert.equal(lines.length, 4);
});
