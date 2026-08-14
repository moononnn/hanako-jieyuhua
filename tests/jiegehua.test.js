// 接个话 — 自动测试（node:test，零依赖）
// 覆盖：配置归一化/迁移、pending 生命周期、推荐解析、密钥混淆往返、版本比较

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CONFIG,
  normalizeConfig,
  normalizeData,
  normalizeStyles,
  loadData,
  saveData,
  createPending,
  getPending,
  markPendingUsed
} from "../lib/data.js";
import { parseSuggestions, encryptKey, decryptKey, extractResponseText, redactSecrets, validateBaseUrl } from "../lib/llm.js";
import { buildStyleLines, execute as executeSuggest } from "../tools/suggest_replies.js";
import { compareVersions } from "../lib/version.js";
import { buildContextText } from "../lib/session.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-test-"));
}

// ═══ 配置归一化 ═══

test("normalizeConfig 返回默认值（空输入）", () => {
  const cfg = normalizeConfig(null);
  assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test("新用户默认值：每次都推荐 + 3 条 + 点击复制 + 指引未关闭", () => {
  const cfg = normalizeConfig(null);
  assert.equal(cfg.mode, "always");
  assert.equal(cfg.count, 3);
  assert.equal(cfg.action, "copy");
  assert.equal(cfg.guideDismissed, false);
});

test("normalizeConfig guideDismissed 透传，非法值忽略", () => {
  assert.equal(normalizeConfig({ guideDismissed: true }).guideDismissed, true);
  assert.equal(normalizeConfig({ guideDismissed: false }).guideDismissed, false);
  // 非布尔（字符串/数字）忽略，保持默认 false
  assert.equal(normalizeConfig({ guideDismissed: "yes" }).guideDismissed, false);
  assert.equal(normalizeConfig({ guideDismissed: 1 }).guideDismissed, false);
});

test("normalizeConfig 接受合法值，忽略非法值", () => {
  const cfg = normalizeConfig({
    mode: "always",
    count: 4,
    action: "copy",
    model: { source: "custom", custom: { baseUrl: "https://x.example", apiKey: "enc:abc", model: "m1" } }
  });
  assert.equal(cfg.mode, "always");
  assert.equal(cfg.count, 4);
  assert.equal(cfg.action, "copy");
  assert.equal(cfg.model.source, "custom");
  assert.equal(cfg.model.custom.baseUrl, "https://x.example");
});

test("normalizeConfig 拒绝非法枚举（count=9 / mode=xxx / source=yyy）", () => {
  const cfg = normalizeConfig({ count: 9, mode: "xxx", model: { source: "yyy" } });
  assert.equal(cfg.count, DEFAULT_CONFIG.count);
  assert.equal(cfg.mode, DEFAULT_CONFIG.mode);
  assert.equal(cfg.model.source, DEFAULT_CONFIG.model.source);
});

test("normalizeData 迁移旧数据：缺字段自动补默认", () => {
  const data = normalizeData({ config: { mode: "always" } });
  assert.equal(data.config.mode, "always");
  assert.equal(data.config.count, DEFAULT_CONFIG.count);
  assert.deepEqual(data.pending, {});
});

test("数据损坏自愈：坏 JSON 回退备份，无备份回默认", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "data.json"), "{broken json", "utf-8");
  const data = loadData(dir);
  assert.deepEqual(data.config, DEFAULT_CONFIG);
});

// ═══ pending 生命周期 ═══

test("createPending → getPending → markPendingUsed 完整流程", async () => {
  const dir = tmpDir();
  const { rid, entry } = await createPending(dir, {
    items: [{ text: "好呀" }, { text: "然后呢？" }],
    sessionId: "s1",
    sessionPath: "/s1.jsonl"
  });
  assert.ok(rid.startsWith("r_"));
  assert.equal(entry.items.length, 2);
  assert.equal(entry.used, false);

  const got = getPending(dir, rid);
  assert.equal(got.items[0].text, "好呀");
  assert.equal(got.sessionId, "s1");

  assert.equal(await markPendingUsed(dir, rid), true);
  assert.equal(getPending(dir, rid).used, true);
  assert.equal(await markPendingUsed(dir, "r_nonexistent"), false);
});

test("pending 上限 20 条：超过时淘汰最旧", async () => {
  const dir = tmpDir();
  const rids = [];
  for (let i = 0; i < 25; i++) {
    const { rid } = await createPending(dir, { items: [{ text: "x" }], sessionId: "", sessionPath: "" });
    rids.push(rid);
  }
  const data = loadData(dir);
  const keys = Object.keys(data.pending);
  assert.equal(keys.length, 20);
  // 最旧的 5 条已被淘汰
  assert.equal(data.pending[rids[0]], undefined);
  assert.equal(data.pending[rids[4]], undefined);
  // 最新的还在
  assert.ok(data.pending[rids[24]]);
});

test("并发创建 pending 不丢数据（写锁串行）", async () => {
  const dir = tmpDir();
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      createPending(dir, { items: [{ text: `第${i}条` }], sessionId: "", sessionPath: "" })
    )
  );
  const data = loadData(dir);
  assert.equal(Object.keys(data.pending).length, 10);
});

// ═══ 推荐解析 ═══

test("parseSuggestions 解析 JSON 数组", () => {
  const items = parseSuggestions('["好呀", "然后呢？", "展开讲讲"]', 3);
  assert.deepEqual(items, [
    { text: "好呀", direction: "" },
    { text: "然后呢？", direction: "" },
    { text: "展开讲讲", direction: "" }
  ]);
});

test("parseSuggestions 去掉代码块围栏", () => {
  const items = parseSuggestions('```json\n["a", "b"]\n```', 2);
  assert.deepEqual(items, [
    { text: "a", direction: "" },
    { text: "b", direction: "" }
  ]);
});

test("parseSuggestions 解析每行一个对象的 JSONL，不把英文键名显示给用户", () => {
  const raw = [
    '{"text":"哈哈，原来是这样！","direction":"追问/延伸"}',
    '{"text":"我还以为能给你发红包呢","direction":"分享/感慨"}',
    '{"text":"那你能给我发红包吗？","direction":"行动/请求"}'
  ].join("\n");
  assert.deepEqual(parseSuggestions(raw, 3), [
    { text: "哈哈，原来是这样！", direction: "追问/延伸" },
    { text: "我还以为能给你发红包呢", direction: "分享/感慨" },
    { text: "那你能给我发红包吗？", direction: "行动/请求" }
  ]);
});

test("parseSuggestions 解析常见 suggestions 包裹对象", () => {
  const raw = JSON.stringify({ suggestions: [
    { text: "继续讲讲嘛", direction: "追问/延伸" },
    { text: "那你帮我看看", direction: "行动/请求" }
  ] });
  assert.deepEqual(parseSuggestions(raw, 2), [
    { text: "继续讲讲嘛", direction: "追问/延伸" },
    { text: "那你帮我看看", direction: "行动/请求" }
  ]);
});

test("parseSuggestions 从带尾逗号的多行数组中提取对象并过滤括号", () => {
  const raw = '[\n{"text":"第一条","direction":"追问"},\n{"text":"第二条","direction":"分享"},\n]';
  assert.deepEqual(parseSuggestions(raw, 2), [
    { text: "第一条", direction: "追问" },
    { text: "第二条", direction: "分享" }
  ]);
});

test("parseSuggestions 识别 JSONL 后丢弃模型前缀说明", () => {
  const raw = '好的，以下是推荐：\n{"text":"继续讲讲嘛","direction":"追问"}\n{"text":"那你帮我看看","direction":"行动"}';
  assert.deepEqual(parseSuggestions(raw, 2), [
    { text: "继续讲讲嘛", direction: "追问" },
    { text: "那你帮我看看", direction: "行动" }
  ]);
});

test("parseSuggestions 保留纯数字及数字开头的普通推荐", () => {
  assert.deepEqual(parseSuggestions("1. 520\n2. 2026年也要加油", 2), [
    { text: "520", direction: "" },
    { text: "2026年也要加油", direction: "" }
  ]);
});

test("parseSuggestions 回退编号列表", () => {
  const items = parseSuggestions("1. 第一个\n2. 第二个\n3. 第三个", 3);
  assert.deepEqual(items, [
    { text: "第一个", direction: "" },
    { text: "第二个", direction: "" },
    { text: "第三个", direction: "" }
  ]);
});

test("parseSuggestions 截断到 count、过滤超长和空串", () => {
  const long = "太长了".repeat(40);
  const items = parseSuggestions(JSON.stringify(["a", "", long, "b"]), 2);
  assert.deepEqual(items, [
    { text: "a", direction: "" },
    { text: "b", direction: "" }
  ]);
});

test("parseSuggestions 空输入返回空数组", () => {
  assert.deepEqual(parseSuggestions("", 3), []);
  assert.deepEqual(parseSuggestions(null, 3), []);
});

test("parseSuggestions 单行截断兜底：从残缺 JSON 挖出完整 text 字段", () => {
  // 模型输出被切断（单行数组没写完），整体与逐行都解析失败
  const raw = '[{"text": "那明天还要接着改吗？", "direction": "追问/延伸"}, {"text": "这么一搞我今天白干了"';
  assert.deepEqual(parseSuggestions(raw, 3), [
    { text: "那明天还要接着改吗？", direction: "" },
    { text: "这么一搞我今天白干了", direction: "" }
  ]);
  // 截断到 count
  assert.equal(parseSuggestions(raw, 1).length, 1);
});

test("parseSuggestions 极端截断（键名都没写完）放弃，不硬捞", () => {
  assert.deepEqual(parseSuggestions('[{"text', 3), []);
});

// ═══ 风格方向数据迁移 ═══

test("normalizeStyles 旧 string[] 迁移到 {name, intent} 对象数组", () => {
  const styles = normalizeStyles(["追问/延伸", "分享/感慨", "行动/请求", "玩笑/俏皮"]);
  assert.equal(styles.length, 4);
  assert.equal(styles[0].name, "追问/延伸");
  assert.equal(styles[1].name, "分享/感慨");
  // intent 从默认同位置继承
  assert.ok(styles[0].intent.includes("顺着话题"));
  assert.ok(styles[1].intent.includes("分享"));
});

test("normalizeStyles 合法 {name, intent} 数组透传", () => {
  const styles = normalizeStyles([
    { name: "撒娇", intent: "用黏人撒娇的语气" },
    { name: "吐槽", intent: "用调侃的语气表达不满" }
  ]);
  assert.equal(styles.length, 4);
  assert.deepEqual(styles[0], { name: "撒娇", intent: "用黏人撒娇的语气" });
  assert.deepEqual(styles[1], { name: "吐槽", intent: "用调侃的语气表达不满" });
  // 缺位补默认
  assert.equal(styles[2].name, "行动/请求");
  assert.equal(styles[3].name, "玩笑/俏皮");
});

test("normalizeStyles 名字超长/空字符串被默认替换", () => {
  const styles = normalizeStyles(["", "超长的名字超过12个字哦哦"]);
  assert.equal(styles.length, 4);
  assert.equal(styles[0].name, "追问/延伸");
  assert.equal(styles[1].name, "分享/感慨");
});

test("normalizeStyles intent 超长被默认替换", () => {
  const styles = normalizeStyles([{ name: "撒娇", intent: "a".repeat(60) }]);
  // intent 超长 -> 整个 entry 丢 -> 补默认
  assert.equal(styles.length, 4);
  assert.equal(styles[0].name, "追问/延伸");
});

test("normalizeStyles 非法输入返回默认", () => {
  assert.equal(normalizeStyles(null).length, 4);
  assert.equal(normalizeStyles(undefined).length, 4);
  assert.equal(normalizeStyles("不是数组").length, 4);
});

// ═══ 响应文本提取 ═══

test("extractResponseText 解析 openai-responses 格式", () => {
  const text = extractResponseText({
    output: [
      { type: "message", content: [{ type: "output_text", text: "好呀" }] },
      { type: "message", content: [{ type: "output_text", text: "，然后呢？" }] }
    ]
  }, "openai-responses");
  assert.equal(text, "好呀，然后呢？");
});

test("extractResponseText 解析 openai-completions 格式", () => {
  const text = extractResponseText({ choices: [{ message: { content: "回复内容" } }] }, "openai-completions");
  assert.equal(text, "回复内容");
});

test("extractResponseText 解析 anthropic 格式", () => {
  const text = extractResponseText({ content: [{ text: "克劳德" }, { text: "回复" }] }, "anthropic-messages");
  assert.equal(text, "克劳德回复");
});

test("extractResponseText 空/异常输入返回空串", () => {
  assert.equal(extractResponseText(null, "openai-responses"), "");
  assert.equal(extractResponseText({}, "openai-responses"), "");
  assert.equal(extractResponseText({ output: [{ type: "other" }] }, "openai-responses"), "");
});

// ═══ 风格分配 ═══

test("buildStyleLines 按条数分配不同风格（3 条 = 追问/分享/行动）", () => {
  const lines = buildStyleLines(3);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes("3 条"));
  assert.ok(lines[1].includes("追问/延伸"));
  assert.ok(lines[2].includes("分享/感慨"));
  assert.ok(lines[3].includes("行动/请求"));
});

test("buildStyleLines 输出含意图说明（红线产物）", () => {
  const lines = buildStyleLines(3);
  // 每条方向行格式：方向【xxx】——意思是：xxx
  assert.match(lines[1], /方向【追问\/延伸】——意思是：/);
  assert.match(lines[2], /方向【分享\/感慨】——意思是：/);
  assert.match(lines[3], /方向【行动\/请求】——意思是：/);
});

test("buildStyleLines 2 条 / 4 条也正常（四种风格错开）", () => {
  const lines2 = buildStyleLines(2);
  assert.equal(lines2.length, 3);
  const lines4 = buildStyleLines(4);
  assert.equal(lines4.length, 5);
  // 4 条时第 4 条是玩笑/俏皮（不重复第一种）
  assert.ok(lines4[4].includes("玩笑/俏皮"));
});

test("buildStyleLines 非法输入回退 3 条", () => {
  assert.equal(buildStyleLines(99).length, 4);
  assert.equal(buildStyleLines(0).length, 4);
});

test("buildStyleLines 接受自定义 {name, intent} 数组", () => {
  const lines = buildStyleLines(2, [
    { name: "撒娇", intent: "黏人" },
    { name: "吐槽", intent: "调侃" }
  ]);
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes("撒娇"));
  assert.ok(lines[1].includes("黏人"));
  assert.ok(lines[2].includes("吐槽"));
  assert.ok(lines[2].includes("调侃"));
});

test("buildStyleLines 接受旧 string[] 兼容", () => {
  const lines = buildStyleLines(2, ["撒娇", "吐槽"]);
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes("撒娇"));
  assert.ok(lines[2].includes("吐槽"));
});

test("buildStyleLines 接受 selectedByCount 切档（恰好 n 个）", () => {
  // 3 条档位勾 [0, 2, 3]（跳过"分享/感慨"）
  const lines = buildStyleLines(3, undefined, [0, 2, 3]);
  assert.equal(lines.length, 4);
  assert.ok(lines[1].includes("追问/延伸"));
  assert.ok(lines[2].includes("行动/请求"));
  assert.ok(lines[3].includes("玩笑/俏皮"));
});

test("buildStyleLines selected 数量不够回退前 n 个", () => {
  // 3 条档只勾 1 个 -> 回退 [0, 1, 2]
  const lines = buildStyleLines(3, undefined, [0]);
  assert.equal(lines.length, 4);
  assert.ok(lines[1].includes("追问/延伸"));
  assert.ok(lines[2].includes("分享/感慨"));
  assert.ok(lines[3].includes("行动/请求"));
});

// ═══ 密钥混淆 ═══

test("encryptKey/decryptKey 往返一致", () => {
  const plain = "sk-test-123456";
  const stored = encryptKey(plain);
  assert.ok(stored.startsWith("enc:"));
  assert.notEqual(stored, plain);
  assert.equal(decryptKey(stored), plain);
});

test("decryptKey 兼容明文（旧数据）", () => {
  assert.equal(decryptKey("sk-plain-old"), "sk-plain-old");
  assert.equal(decryptKey(""), "");
});

// ═══ 版本比较 ═══

test("compareVersions 基本比较", () => {
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.1"), -1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
});

test("compareVersions 兼容 2 段版本号", () => {
  assert.equal(compareVersions("0.2", "0.1.9"), 1);
  assert.equal(compareVersions("0.1", "0.1.0"), 0);
});

// ═══ 会话上下文拼接 ═══

test("buildContextText 拼接最近消息，保持顺序", () => {
  const text = buildContextText([
    { role: "user", content: "今天好累" },
    { role: "assistant", content: "抱抱，辛苦啦" },
    { role: "user", content: "嗯嗯" }
  ]);
  assert.ok(text.includes("用户: 今天好累"));
  assert.ok(text.includes("助手: 抱抱，辛苦啦"));
  assert.ok(text.includes("用户: 嗯嗯"));
  assert.ok(text.indexOf("用户: 今天好累") < text.indexOf("助手: 抱抱，辛苦啦"));
});

test("buildContextText 空输入返回空串", () => {
  assert.equal(buildContextText([]), "");
});

// ═══ 安全：错误脱敏 + baseUrl 校验 ═══

test("redactSecrets 打码 sk- 密钥", () => {
  assert.equal(redactSecrets("invalid api key: sk-abc12345def"), "invalid api key: sk-***");
  assert.equal(redactSecrets("no secret here"), "no secret here");
});

test("redactSecrets 打码 Bearer / x-api-key / api_key 值", () => {
  assert.equal(redactSecrets("Authorization: Bearer token12345"), "Authorization: Bearer ***");
  assert.equal(redactSecrets('x-api-key: "abc12345def"'), 'x-api-key: "***"');
  assert.equal(redactSecrets('"api_key": "zzz99988877"'), '"api_key": "***"');
});

test("redactSecrets 空输入安全", () => {
  assert.equal(redactSecrets(""), "");
  assert.equal(redactSecrets(null), "");
});

test("validateBaseUrl 接受 http/https，拒绝其他协议与超长", () => {
  assert.equal(validateBaseUrl("https://api.openai.com/v1"), null);
  assert.equal(validateBaseUrl("http://127.0.0.1:8000/v1"), null);
  assert.ok(validateBaseUrl("file:///etc/passwd"));
  assert.ok(validateBaseUrl("ftp://x.com"));
  assert.ok(validateBaseUrl(""));
  assert.ok(validateBaseUrl("x".repeat(600)));
});

test("cleanContextText 清理成对【隐藏注入块】且保留正常内容", () => {
  const out = buildContextText([
    { role: "user", content: "今天好累【朋友圈生活视角】隐藏内容…【/朋友圈生活视角】晚上吃什么" }
  ]);
  assert.ok(!out.includes("隐藏内容"));
  assert.ok(out.includes("晚上吃什么"));
});

// ═══ 展示模式防线（2026-08-10）：非卡片模式绝不返回卡片 ═══
// observer 只拦「引导层」，模型仍可能自发调用工具；工具层必须兜底

test("悬浮球模式下 execute 不返回卡片，只返回提示文本", async () => {
  const dir = tmpDir();
  saveData(dir, { config: { presentation: "ball", mode: "always", count: 3, action: "copy", styles: [] } });
  const out = await executeSuggest({}, { dataDir: dir });
  assert.ok(out.content && out.content.length > 0);
  assert.ok(out.content[0].text.includes("悬浮球"));
  assert.equal(out.details, undefined);
});

test("关闭模式下 execute 不返回卡片", async () => {
  const dir = tmpDir();
  saveData(dir, { config: { presentation: "off", mode: "always", count: 3, action: "copy", styles: [] } });
  const out = await executeSuggest({}, { dataDir: dir });
  assert.ok(out.content && out.content.length > 0);
  assert.ok(out.content[0].text.includes("关闭"));
  assert.equal(out.details, undefined);
});
