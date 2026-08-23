// 解语花 — 语音朗读自动测试（node:test，零依赖）
// 覆盖：朗读文本提取（whole/quoted/清理/截断）、TTS 配置归一化、
//      Hana 语音模型候选扫描、三档配置解析（auto/hana/custom）、双协议合成

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, normalizeConfig, normalizeTts, normalizeTtsVoiceByAgent, updateTtsConfig, getConfig } from "../lib/data.js";
import {
  cleanReadableText,
  extractQuotedText,
  extractReadableText,
  clampNum,
  resolveTtsVoiceId,
  isTtsModelId,
  findTtsCandidatesFromProviders,
  resolveTtsConfig,
  synthesizeSpeech,
} from "../lib/tts.js";

// ═══ 朗读文本清理 ═══

test("cleanReadableText 去掉代码块与行内代码", () => {
  assert.equal(
    cleanReadableText("先看这段：\n```js\nconst a = 1;\n```\n然后 `const b = 2` 是这样"),
    "先看这段：\n然后 const b = 2 是这样"
  );
});

test("cleanReadableText 去掉 markdown 记号，保留内容", () => {
  assert.equal(
    cleanReadableText("**加粗** 和 *斜体* 和 ~~删除~~ 和 [链接文字](https://x.com)"),
    "加粗 和 斜体 和 删除 和 链接文字"
  );
});

test("cleanReadableText 去掉标题/引用/列表/表格符号，折叠空白", () => {
  const out = cleanReadableText("# 标题\n> 引用\n- 条目一\n1. 条目二\n| a | b |\n\n  尾行  ");
  assert.equal(out, "标题\n引用\n条目一\n条目二\na b\n尾行");
});

test("cleanReadableText 空输入安全", () => {
  assert.equal(cleanReadableText(""), "");
  assert.equal(cleanReadableText(null), "");
  assert.equal(cleanReadableText(undefined), "");
});

test("cleanReadableText 全文模式只保留可见正文，滤掉 mood 隐藏块", () => {
  const raw = [
    "<mood>",
    "Vibe: 这是 Hana 的内部心情",
    "Sparks:",
    "  - 这段也不能读",
    "</mood>",
    "",
    "真正给用户看的回复。",
  ].join("\n");
  assert.equal(cleanReadableText(raw), "真正给用户看的回复。");
});

test("cleanReadableText 兼容混搭 mood 与其他隐藏标签", () => {
  const raw = "[mood]内部心情</mood> <reasoning>内部推理</reasoning>可见正文";
  assert.equal(cleanReadableText(raw), "可见正文");
});

test("cleanReadableText 未闭合隐藏块不把内部内容送进朗读", () => {
  assert.equal(cleanReadableText("<mood>还没闭合的内部心情"), "");
  assert.equal(cleanReadableText("可见正文\n<think>后面的内部草稿"), "可见正文");
});

// ═══ 引号提取 ═══

test("extractQuotedText 提取弯引号/直角引号/双引号", () => {
  assert.equal(extractQuotedText("她说「今天天气真好」，还说“想去看海”和『明天见』"), "今天天气真好，想去看海，明天见");
});

test("extractQuotedText 无引号返回空", () => {
  assert.equal(extractQuotedText("今天天气真好"), "");
});

// ═══ 朗读范围 ═══

test("extractReadableText whole 模式：整条清理后返回", () => {
  const { text, matched, truncated } = extractReadableText("**你好呀**，今天过得怎么样？", "whole", 800);
  assert.equal(text, "你好呀，今天过得怎么样？");
  assert.equal(matched, true);
  assert.equal(truncated, false);
});

test("extractReadableText quoted 模式：只读引号内容", () => {
  const { text, matched } = extractReadableText("她笑着说：「晚上一起吃火锅吧」然后挥了挥手。", "quoted", 800);
  assert.equal(text, "晚上一起吃火锅吧");
  assert.equal(matched, true);
});

test("extractReadableText quoted 模式：没有引号时回退整条并标记 matched=false", () => {
  const { text, matched } = extractReadableText("今天没有引号内容", "quoted", 800);
  assert.equal(text, "今天没有引号内容");
  assert.equal(matched, false);
});

test("extractReadableText 超长截断（保留省略号）", () => {
  const long = "甲".repeat(100);
  const { text, truncated } = extractReadableText(long, "whole", 50);
  assert.equal(text.length, 50);
  assert.ok(text.endsWith("…"));
  assert.equal(truncated, true);
});

test("extractReadableText maxLen 非法值用默认 800", () => {
  const { text, truncated } = extractReadableText("短文本", "whole", "abc");
  assert.equal(text, "短文本");
  assert.equal(truncated, false);
});

test("extractReadableText 空文本安全", () => {
  const { text } = extractReadableText("   \n  ", "whole", 800);
  assert.equal(text, "");
});

// ═══ clampNum ═══

test("clampNum 边界与回退", () => {
  assert.equal(clampNum(0.3, 0.5, 2, 1), 0.5);
  assert.equal(clampNum(5, 0.5, 2, 1), 2);
  assert.equal(clampNum("1.2", 0.5, 2, 1), 1.2);
  assert.equal(clampNum(undefined, 0.5, 2, 1), 1);
  assert.equal(clampNum(NaN, 0.5, 2, 1), 1);
});

// ═══ TTS 配置归一化 ═══

test("normalizeTts 默认值（三档结构）", () => {
  const tts = normalizeTts(null);
  assert.deepEqual(tts, DEFAULT_CONFIG.tts);
  assert.equal(tts.enabled, false);
  assert.equal(tts.source, "auto");
  assert.equal(tts.protocol, "chat");
  assert.equal(tts.scope, "whole");
  assert.equal(tts.maxLen, 800);
});

test("normalizeTts 非法值收敛到默认", () => {
  const tts = normalizeTts({ enabled: true, source: "bogus", protocol: "bogus", speed: 99, vol: -1, scope: "bogus", maxLen: 1 });
  assert.equal(tts.enabled, true);
  assert.equal(tts.source, "auto");
  assert.equal(tts.protocol, "chat");
  assert.equal(tts.speed, 2);
  assert.equal(tts.vol, 0.1);
  assert.equal(tts.scope, "whole");
  assert.equal(tts.maxLen, 20);
});

test("normalizeTts hana/custom 与 t2a 保留，字符串数字转换", () => {
  const tts = normalizeTts({ source: "custom", protocol: "t2a", scope: "quoted", speed: "1.3", maxLen: "500" });
  assert.equal(tts.source, "custom");
  assert.equal(tts.protocol, "t2a");
  assert.equal(tts.scope, "quoted");
  assert.equal(tts.speed, 1.3);
  assert.equal(tts.maxLen, 500);
});

test("normalizeConfig 透传 tts 块", () => {
  const cfg = normalizeConfig({ tts: { enabled: true, source: "hana", providerId: "mimo", model: "mimo-v2.5-tts" } });
  assert.equal(cfg.tts.enabled, true);
  assert.equal(cfg.tts.source, "hana");
  assert.equal(cfg.tts.providerId, "mimo");
  assert.equal(cfg.tts.model, "mimo-v2.5-tts");
});

test("normalizeTts 老配置迁移：有 apiKey/groupId 的旧配置归为 custom/t2a", () => {
  const tts = normalizeTts({ enabled: true, apiKey: "enc:abc", groupId: "g1", voiceId: "female-shaonv" });
  assert.equal(tts.source, "custom");
  assert.equal(tts.protocol, "t2a");
  assert.equal(tts.groupId, "g1");
});

test("normalizeTts 无凭据的新配置保持 auto", () => {
  const tts = normalizeTts({ enabled: true });
  assert.equal(tts.source, "auto");
  assert.equal(tts.protocol, "chat");
});

test("normalizeTts 旧全局音色迁移为模型默认", () => {
  const tts = normalizeTts({ enabled: true, voiceId: "旧版音色" });
  assert.equal(tts.voiceId, "");
});

test("normalizeTtsVoiceByAgent 过滤非法项并限制数量", () => {
  const map = normalizeTtsVoiceByAgent({
    hanako: " 茉莉 ",
    empty: "",
    bad: 123,
    tooLong: "x".repeat(201),
  });
  assert.deepEqual(map, { hanako: "茉莉" });
});

test("resolveTtsVoiceId 专属音色优先，未配置时回退模型默认", () => {
  const tts = { voiceId: "旧版音色", voiceByAgent: { yumi: "苏打" } };
  assert.equal(resolveTtsVoiceId(tts, "yumi"), "苏打");
  assert.equal(resolveTtsVoiceId(tts, "hanako"), "");
  assert.equal(resolveTtsVoiceId(tts, ""), "");
});

test("updateTtsConfig 在写锁内合并语音配置，不覆盖其他字段", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-tts-config-"));
  await updateTtsConfig(dir, { enabled: true, speed: 1.3, voiceId: "旧版音色" });
  await updateTtsConfig(dir, (current) => ({ voiceByAgent: { ...(current.voiceByAgent || {}), yumi: "苏打" } }));
  const tts = getConfig(dir).tts;
  assert.equal(tts.enabled, true);
  assert.equal(tts.speed, 1.3);
  assert.equal(tts.voiceId, "");
  assert.deepEqual(tts.voiceByAgent, { yumi: "苏打" });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ═══ Hana 语音模型候选扫描 ═══

test("isTtsModelId 匹配语音模型名", () => {
  assert.equal(isTtsModelId("mimo-v2.5-tts"), true);
  assert.equal(isTtsModelId("mimo-v2.5-tts-voicedesign"), true);
  assert.equal(isTtsModelId("speech-2.8-hd"), true);
  assert.equal(isTtsModelId("deepseek-v4-flash"), false);
  assert.equal(isTtsModelId(null), false);
});

test("findTtsCandidatesFromProviders 只收集 TTS 模型且去重", () => {
  const providers = {
    mimo: { api_key: "k1", base_url: "https://api.xiaomimimo.com/v1", api: "openai-completions" },
    deepseek: { api_key: "k2", base_url: "https://api.deepseek.com", api: "openai-completions" },
  };
  const catalog = {
    providers: {
      mimo: { baseUrl: "https://api.xiaomimimo.com/v1", models: ["mimo-v2.5-tts", "mimo-v2.5-tts", "mimo-v2.5-pro"] },
      deepseek: { baseUrl: "https://api.deepseek.com", models: ["deepseek-v4-flash"] },
    },
  };
  const list = findTtsCandidatesFromProviders(providers, catalog);
  assert.equal(list.length, 1);
  assert.equal(list[0].providerId, "mimo");
  assert.equal(list[0].model, "mimo-v2.5-tts");
  assert.equal(list[0].apiKey, "k1");
  assert.equal(list[0].available, true);
});

test("findTtsCandidatesFromProviders 空配置安全", () => {
  assert.deepEqual(findTtsCandidatesFromProviders({}, {}), []);
  assert.deepEqual(findTtsCandidatesFromProviders(null, null), []);
});

// ═══ 三档配置解析 ═══

const fakeCandidates = [
  { providerId: "mimo", model: "mimo-v2.5-tts", baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "k-mimo", available: true },
  { providerId: "mimo", model: "mimo-v2-tts", baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "", available: false },
];

test("resolveTtsConfig auto：自动选第一个可用候选", () => {
  const r = resolveTtsConfig({ source: "auto" }, fakeCandidates);
  assert.equal(r.source, "auto");
  assert.equal(r.protocol, "chat");
  assert.equal(r.model, "mimo-v2.5-tts");
  assert.equal(r.baseUrl, "https://api.xiaomimimo.com/v1");
  assert.equal(r.apiKey, "k-mimo");
});

test("resolveTtsConfig hana：按保存的 provider+model 精确匹配", () => {
  const r = resolveTtsConfig({ source: "hana", providerId: "mimo", model: "mimo-v2-tts" }, fakeCandidates);
  assert.equal(r.model, "mimo-v2-tts");
});

test("resolveTtsConfig hana：保存的模型已失效时回退第一个可用", () => {
  const r = resolveTtsConfig({ source: "hana", providerId: "deepseek", model: "nope" }, fakeCandidates);
  assert.equal(r.model, "mimo-v2.5-tts");
});

test("resolveTtsConfig custom：t2a 协议透传", () => {
  const r = resolveTtsConfig({ source: "custom", protocol: "t2a", apiKey: "enc:abc", groupId: "g1", model: "speech-2.8-hd" }, fakeCandidates);
  assert.equal(r.protocol, "t2a");
  assert.equal(r.groupId, "g1");
  assert.equal(r.model, "speech-2.8-hd");
});

test("resolveTtsConfig custom：chat 协议透传", () => {
  const r = resolveTtsConfig({ source: "custom", protocol: "chat", apiKey: "enc:abc", model: "mimo-v2.5-tts" }, fakeCandidates);
  assert.equal(r.protocol, "chat");
  assert.equal(r.model, "mimo-v2.5-tts");
});

test("resolveTtsConfig 无候选时抛 no_tts_candidate", () => {
  assert.throws(() => resolveTtsConfig({ source: "auto" }, []), (e) => e.code === "no_tts_candidate");
});

// ═══ 双协议合成（mock fetch，不真调网络） ═══

test("chatSynthesize：mock 返回 audio.data（wav）", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    choices: [{ message: { audio: { data: "UVdSQURBVUU=" } } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));

  const { audio, format } = await synthesizeSpeech(
    { source: "custom", protocol: "chat", apiKey: "enc:YWJj", baseUrl: "https://api.example.com/v1", model: "mimo-v2.5-tts" },
    "你好"
  );
  assert.equal(format, "wav");
  assert.equal(audio, "UVdSQURBVUU=");
});

test("chatSynthesize：audio.data 缺失且 content 是 base64 时回退 content", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    choices: [{ message: { content: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));

  const { audio, format } = await synthesizeSpeech(
    { source: "custom", protocol: "chat", apiKey: "enc:YWJj", baseUrl: "https://api.example.com/v1", model: "mimo-v2.5-tts" },
    "你好"
  );
  assert.equal(format, "wav");
  assert.equal(audio, "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=");
});

test("chatSynthesize：没有音频时报错（不把普通文本当音频）", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    choices: [{ message: { content: "这是一个普通报错" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));

  await assert.rejects(
    () => synthesizeSpeech({ source: "custom", protocol: "chat", apiKey: "enc:YWJj", baseUrl: "https://api.example.com/v1", model: "m" }, "你好"),
    /没拿到音频/
  );
});

test("t2aSynthesize：mock 返回 hex 编码的 mp3 → 统一输出 base64", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    base_resp: { status_code: 0, status_msg: "success" },
    data: { audio: "4944330400000000" }, // hex 编码的 ID3/mp3 头（MiniMax 实机格式）
  }), { status: 200, headers: { "Content-Type": "application/json" } }));

  const { audio, format } = await synthesizeSpeech(
    { source: "custom", protocol: "t2a", apiKey: "enc:YWJj", groupId: "g1", baseUrl: "https://api.minimaxi.com" },
    "你好"
  );
  assert.equal(format, "mp3");
  // 输出是 base64，解码后是原始 mp3 字节（ID3 头）
  const bytes = Buffer.from(audio, "base64");
  assert.equal(bytes.slice(0, 4).toString("hex"), "49443304");
});

test("t2aSynthesize：HTTP 非 2xx 带出上游错误信息", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    base_resp: { status_code: 1004, status_msg: "invalid key" },
  }), { status: 401, headers: { "Content-Type": "application/json" } }));

  await assert.rejects(
    () => synthesizeSpeech({ source: "custom", protocol: "t2a", apiKey: "enc:YWJj", groupId: "g1", baseUrl: "https://api.minimaxi.com" }, "你好"),
    /invalid key/
  );
});

test("t2aSynthesize：请求成功但没音频时带 base_resp 详情", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    base_resp: { status_code: 2001, status_msg: "model not available" },
    data: {},
  }), { status: 200, headers: { "Content-Type": "application/json" } }));

  await assert.rejects(
    () => synthesizeSpeech({ source: "custom", protocol: "t2a", apiKey: "enc:YWJj", groupId: "g1", baseUrl: "https://api.minimaxi.com" }, "你好"),
    /model not available/
  );
});

// ═══ 合成参数校验（不真调网络） ═══

test("synthesizeSpeech 缺 key / groupId 时友好报错", async () => {
  await assert.rejects(() => synthesizeSpeech({ source: "custom", protocol: "t2a", apiKey: "", groupId: "g1" }, "你好"), /API Key/);
  await assert.rejects(() => synthesizeSpeech({ source: "custom", protocol: "t2a", apiKey: "enc:abc", groupId: "" }, "你好"), /GroupId/);
});

test("synthesizeSpeech 不合法接口地址被拒", async () => {
  await assert.rejects(
    () => synthesizeSpeech({ source: "custom", protocol: "t2a", apiKey: "enc:abc", groupId: "g1", baseUrl: "127.0.0.1:9999" }, "你好"),
    /http/
  );
});
