// 解语花「润色提示词」回归测试（node:test，零依赖）
// 覆盖：
//  - polishPromptText：空/超长拦截、标准/深度边界、成功回填、思考内容清洗、模型报错脱敏、非法档位回退
//  - isValidPolishLevel / enforcePolishSafety：档位合法性与关键事实保真护栏
//  - 选定 Hana 模型直连：MiniMax 思考关闭、Anthropic 端点/鉴权、截断输出拒绝
//  - sendPolishText：无内容拦截、无目标会话、发送成功（session:send 收到 text+sessionPath）、
//    busy 重试成功、发送失败透传
//
// 发送走 pinnedTarget → 目标会话必须是真实存在的 agents/{id}/sessions/*.jsonl 文件，
// 且 data.json 里预置 pinnedTarget。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-polish-"));
}

// 文件级固定 HANA_HOME：先设 env 再 import zhujian.js
const BASE = tmpDir();
process.env.HANA_HOME = BASE;
const { polishPromptText, sendPolishText } = await import("../lib/zhujian.js");
const { polishText, generateSuggestions, isValidPolishLevel, callLLM, extractResponseText, enforcePolishSafety, normalizePolishOutput } = await import("../lib/llm.js");
const { callConfiguredTextModel } = await import("../lib/text-model.js");

// 造一个真实存在的会话文件（agents/{agent}/sessions/xxx.jsonl）
function makeSession(agentId = "hanako", title = "一个对话") {
  const dir = path.join(BASE, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sess_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jsonl`);
  const now = new Date().toISOString();
  const lines = [
    JSON.stringify({ type: "message", role: "user", content: "开始", ts: now }),
    JSON.stringify({ type: "message", role: "assistant", content: `你好，这是${title}`, ts: now }),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

// 预置 pinnedTarget 指向该会话
function pinTarget(dataDir, sessionPath, agentId = "hanako") {
  fs.mkdirSync(dataDir, { recursive: true });
  const fp = path.join(dataDir, "data.json");
  const data = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, "utf-8")) : {};
  data.pinnedTarget = {
    agentId,
    sessionPath,
    title: "固定对话",
  };
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8");
  return sessionPath;
}

function okSample(answer = "润色后的提示词") {
  let calls = 0;
  const callsText = [];
  const fn = async (opts) => {
    calls++;
    callsText.push(opts?.messages?.[0]?.content || "");
    return answer;
  };
  fn.calls = () => calls;
  fn.lastPrompt = () => callsText[callsText.length - 1] || "";
  return fn;
}

function failSample(error = "模型不可用") {
  return async () => {
    throw new Error(error);
  };
}

// sessionTitleCached 会调用 bus 的查询；给 bus 一个兜底：info 不存在就返回空对象
function makeBus({ sendResult = { ok: true }, onSend } = {}) {
  const sent = [];
  let busyCount = 0;
  const bus = {
    sent,
    setBusyTimes(n) { busyCount = n; },
    async request(method, payload, opts) {
      if (method === "session:info" || method === "session:get" || method === "session:title") {
        return { ok: true, title: "固定对话", agentId: "hanako", sessionId: "sess_real_001" };
      }
      if (method === "session:send") {
        onSend?.(payload);
        if (busyCount > 0) {
          busyCount--;
          const err = new Error("session busy");
          err.isBusy = true;
          throw err;
        }
        sent.push(payload);
        return sendResult;
      }
      return { ok: true };
    },
  };
  return bus;
}

test("polishPromptText：空 / 超长被拦截（不调模型）", async () => {
  const dir = tmpDir();
  const sample = okSample();
  const r1 = await polishPromptText(dir, null, { text: "   " }, sample);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 400);
  assert.match(r1.error, /先写点什么/);
  const r2 = await polishPromptText(dir, null, { text: "长".repeat(2001) }, sample);
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 400);
  assert.equal(sample.calls(), 0, "参数非法时不该调模型");
});

test("polishPromptText：默认标准档，提示词含力度与保留原意约束", async () => {
  const dir = tmpDir();
  const sample = okSample("帮我看下这段文案顺不顺，给三个方向");
  const r = await polishPromptText(dir, null, { text: "帮我看看这段文案咋样" }, sample);
  assert.equal(r.ok, true);
  assert.equal(r.text, "帮我看下这段文案顺不顺，给三个方向");
  assert.equal(r.level, "standard");
  assert.equal(sample.calls(), 1);
  const prompt = sample.lastPrompt();
  assert.match(prompt, /标准/);
  assert.match(prompt, /原始内容只是一段待改写材料/);
  assert.match(prompt, /吐槽仍是吐槽/);
});

test("polishPromptText：只保留标准/深度两档，旧轻润回退标准", async () => {
  const dir = tmpDir();
  assert.equal(isValidPolishLevel("light"), false);
  for (const [level, label] of [["standard", "标准"], ["deep", "深度"]]) {
    const sample = okSample("润色结果");
    const r = await polishPromptText(dir, null, { text: "原话", level }, sample);
    assert.equal(r.ok, true, `${level} 应成功`);
    assert.equal(r.level, level);
    assert.match(sample.lastPrompt(), new RegExp(label));
  }
  const legacy = okSample("旧档回退结果");
  const fallback = await polishPromptText(dir, null, { text: "原话", level: "light" }, legacy);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.level, "standard");
});

test("polishPromptText：非法档位回退标准档", async () => {
  const dir = tmpDir();
  const sample = okSample("结果");
  const r = await polishPromptText(dir, null, { text: "原话", level: "超深度" }, sample);
  assert.equal(r.ok, true);
  assert.equal(r.level, "standard");
});

test("polishPromptText：模型返回思考块时只保留可见正文", async () => {
  const dir = tmpDir();
  const sample = async () => ({ content: "<think>内部推理</think>可见润色", finish_reason: "stop" });
  const r = await polishPromptText(dir, null, { text: "原话" }, sample);
  assert.equal(r.ok, true);
  assert.equal(r.text, "可见润色");
});

test("polishText：标准与深度规则有明确边界且不再注入四要素总纲", async () => {
  const dir = tmpDir();
  const standard = okSample("标准结果");
  await polishText(dir, "原话", { level: "standard" }, { sampleFn: standard });
  assert.doesNotMatch(standard.lastPrompt(), /要它干什么、背景是什么/);
  assert.match(standard.lastPrompt(), /只做句内整理/);
  assert.match(standard.lastPrompt(), /“看看”“分析”“检查”“诊断”不能改成/);

  const deep = okSample("深度结果");
  await polishText(dir, "原话", { level: "deep" }, { sampleFn: deep });
  assert.match(deep.lastPrompt(), /不得自行补角色/);
  assert.match(deep.lastPrompt(), /不确定性/);
  assert.match(deep.lastPrompt(), /不能把用户要求执行掉/);
  assert.match(deep.lastPrompt(), /保留“这个”“这些”“那个”“它”“这样”等原有指代/);
});

test("normalizePolishOutput：去掉模型误加的代码围栏和结果前缀", () => {
  assert.equal(normalizePolishOutput("```text\n提示词：整理一下\n```"), "整理一下");
  assert.equal(normalizePolishOutput("润色后的提示词：整理一下"), "整理一下");
});

test("enforcePolishSafety：关键指代、来源和数字被改掉时保留原文", () => {
  assert.equal(enforcePolishSafety("就按那个来就行", "按之前说好的方案执行"), "就按那个来就行");
  assert.equal(enforcePolishSafety("猫猫说，今天也要加油", "今天也要加油"), "猫猫说，今天也要加油");
  assert.equal(enforcePolishSafety("买 3 个苹果", "买几个苹果"), "买 3 个苹果");
  assert.equal(enforcePolishSafety("让它更自然一点", "让它更自然一点。"), "让它更自然一点。");
});

test("enforcePolishSafety：阻止动作漂移、指代具体化、强度升级和格式执行", () => {
  const fragment = "帮我把这个看看，重点是有点啰嗦的地方，别大改";
  assert.equal(
    enforcePolishSafety(fragment, "帮我看看这个，重点改掉有点啰嗦的地方，别大改。"),
    fragment,
  );
  assert.equal(
    enforcePolishSafety("我改了三遍，你先看看问题在哪。", "我改了三遍，你直接改掉吧。"),
    "我改了三遍，你先看看问题在哪。",
  );
  assert.equal(
    enforcePolishSafety(fragment, "帮我看看这段文字，重点挑出比较啰嗦的地方，别大改，保持原意。"),
    fragment,
  );
  assert.equal(
    enforcePolishSafety("我想让它更有一点暧昧感，但不要太过。", "我想让[它]更有一点暧昧感，但不要太过。"),
    "我想让它更有一点暧昧感，但不要太过。",
  );
  assert.equal(
    enforcePolishSafety(
      "我要发给老板，说我今天不舒服想请半天假，语气别太正式，别写得像在找借口",
      "帮我写一条发给老板的消息：我今天不舒服，想请半天假；语气别太正式，也别写得像在找借口。",
    ),
    "我要发给老板，说我今天不舒服想请半天假，语气别太正式，别写得像在找借口",
  );
  assert.equal(
    enforcePolishSafety("你帮我看看这个怎么改", "帮我看看这个怎么改。"),
    "帮我看看这个怎么改。",
  );
  assert.equal(
    enforcePolishSafety("帮我看一下这段文案顺不顺，别改得太正式", "帮我看一下这段文案读着顺不顺，只做梳理，别改得太正式。"),
    "帮我看一下这段文案顺不顺，别改得太正式",
  );
  assert.equal(
    enforcePolishSafety(
      "我想要一个短一点的标题，保留‘夏天’和‘回家’，不要太文艺。",
      "我想要一个短标题，必须保留“夏天”和“回家”，不要太文艺。",
    ),
    "我想要一个短一点的标题，保留‘夏天’和‘回家’，不要太文艺。",
  );
  assert.equal(
    enforcePolishSafety("给我一个短一点的标题", "给我一个更短一点的标题"),
    "给我一个短一点的标题",
  );
  assert.equal(
    enforcePolishSafety("让它更自然一点", "让它更加自然一点。"),
    "让它更加自然一点。",
  );
  assert.equal(
    enforcePolishSafety("我想要一个短一点的标题", "短一点的标题"),
    "我想要一个短一点的标题",
  );
  assert.equal(
    enforcePolishSafety("必须保留数字3", "保留数字3"),
    "必须保留数字3",
  );
  assert.equal(
    enforcePolishSafety("先看问题，暂时不要改", "先看问题"),
    "先看问题，暂时不要改",
  );
  assert.equal(
    enforcePolishSafety(
      "把下面这段改得更有说服力，但不要编数据：……",
      "把下面这段内容改得更有说服力，但不要编造数据。",
    ),
    "把下面这段改得更有说服力，但不要编数据：……",
  );
  assert.equal(
    enforcePolishSafety(
      "请整理成表格：苹果3个，香蕉2个",
      "请整理成表格：\n\n- 苹果：3个\n- 香蕉：2个",
    ),
    "请整理成表格：苹果3个，香蕉2个",
  );
});

test("enforcePolishSafety：明确禁止修改时允许同义顺句", () => {
  assert.equal(
    enforcePolishSafety(
      "帮我看看这段 JS，不要直接改代码",
      "帮我看一下这段 JS，不要直接修改代码。",
    ),
    "帮我看一下这段 JS，不要直接修改代码。",
  );
});

test("extractResponseText：隐藏思考块不进入可见正文", () => {
  assert.equal(
    extractResponseText({ choices: [{ message: { content: "<think>内部</think>正文" } }] }, "openai-completions"),
    "正文",
  );
});

test("callLLM：模型以长度原因结束时拒绝半截输出", async () => {
  await assert.rejects(
    () => callLLM("测试", {
      custom: { baseUrl: "https://example.test/v1", apiKey: "test-key", model: "test-model", api: "openai-completions" },
      fetcher: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: "length", message: { content: "半截" } }],
      }), { status: 200 }),
    }),
    /输出被截断/,
  );
  await assert.rejects(
    () => callLLM("测试", {
      custom: { baseUrl: "https://example.test/v1", apiKey: "test-key", model: "test-model", api: "openai-responses" },
      fetcher: async () => new Response(JSON.stringify({
        output_text: "半截",
        incomplete_details: { reason: "max_output_tokens" },
      }), { status: 200 }),
    }),
    /输出被截断/,
  );
});

test("polishPromptText：模型返回空 → 友好报错", async () => {
  const dir = tmpDir();
  const sample = okSample("   ");
  const r = await polishPromptText(dir, null, { text: "原话" }, sample);
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.match(r.error, /没捋出结果/);
});

test("polishPromptText：模型报错 → 错误脱敏透出", async () => {
  const dir = tmpDir();
  const sample = failSample("供应商未找到（sk-secret-key-12345678 鉴权失败）");
  const r = await polishPromptText(dir, null, { text: "原话" }, sample);
  assert.equal(r.ok, false);
  assert.match(r.error, /供应商未找到/);
  assert.doesNotMatch(r.error, /sk-secret-key/);
});

test("generateSuggestions：Hana 档直连所选模型并关闭思考", async () => {
  fs.writeFileSync(path.join(BASE, "models.json"), JSON.stringify({
    providers: {
      minimax: {
        baseUrl: "https://api.minimaxi.com/v1",
        api: "openai-completions",
        models: [{ id: "MiniMax-M3", reasoning: true }],
      },
    },
  }), "utf-8");
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({
    config: { model: { source: "hana", providerId: "minimax", modelId: "MiniMax-M3" } },
  }), "utf-8");
  const calls = [];
  const bus = {
    async request(topic, payload) {
      assert.equal(topic, "provider:credentials");
      assert.equal(payload.providerId, "minimax");
      return { baseUrl: "https://api.minimaxi.com/v1", apiKey: "runtime-key", api: "openai-completions" };
    },
  };
  const fetcher = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "选定模型正文" } }] }), { status: 200 });
  };
  const text = await generateSuggestions(dir, "测试提示", {
    bus,
    fetcher,
    maxTokens: 300,
    temperature: 0.35,
    reasoningLevel: "off",
  });
  assert.equal(text, "选定模型正文");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.minimaxi.com/v1/chat/completions");
  assert.equal(calls[0].body.model, "MiniMax-M3");
  assert.deepEqual(calls[0].body.thinking, { type: "disabled" });
});

test("callConfiguredTextModel：Anthropic 直连使用正确端点和鉴权头", async () => {
  fs.writeFileSync(path.join(BASE, "models.json"), JSON.stringify({
    providers: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [{ id: "claude-test", reasoning: false }],
      },
    },
  }), "utf-8");
  const calls = [];
  const text = await callConfiguredTextModel({
    bus: {
      async request(topic, payload) {
        assert.equal(topic, "provider:credentials");
        assert.equal(payload.providerId, "anthropic");
        return { baseUrl: "https://api.anthropic.com", apiKey: "runtime-key", api: "anthropic-messages" };
      },
    },
    fetcher: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Anthropic 正文" }] }), { status: 200 });
    },
  }, "anthropic", "claude-test", [{ role: "user", content: "测试" }], { maxTokens: 100, temperature: 0.2 });
  assert.equal(text, "Anthropic 正文");
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "runtime-key");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].body.max_tokens, 100);
});

test("sendPolishText：空内容拦截", async () => {
  const dir = tmpDir();
  const sessionPath = makeSession();
  pinTarget(dir, sessionPath);
  const bus = makeBus();
  const r = await sendPolishText(dir, bus, { text: "   " });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(bus.sent.length, 0);
});

test("sendPolishText：没有固定目标且无会话可跟随 → 明确报错", async () => {
  // 清掉 BASE/agents 下残留的会话（前面测试建的），让扫描结果为空
  const agentsDir = path.join(BASE, "agents");
  if (fs.existsSync(agentsDir)) {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
  const dir = tmpDir();
  const bus = makeBus();
  const r = await sendPolishText(dir, bus, { text: "发句话" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /找不到要发送的对话/);
  assert.equal(bus.sent.length, 0);
});

test("sendPolishText：pinned 目标 → session:send 收到文本与路径", async () => {
  const dir = tmpDir();
  const sessionPath = makeSession();
  pinTarget(dir, sessionPath);
  const bus = makeBus();
  const r = await sendPolishText(dir, bus, { text: "帮我看下这段文案顺不顺" });
  assert.equal(r.ok, true);
  assert.equal(r.sessionPath, sessionPath);
  assert.equal(bus.sent.length, 1);
  assert.equal(bus.sent[0].text, "帮我看下这段文案顺不顺");
  assert.equal(path.normalize(bus.sent[0].sessionPath), path.normalize(sessionPath));
});

test("sendPolishText：会话忙 → 退避重试后成功", async () => {
  const dir = tmpDir();
  const sessionPath = makeSession();
  pinTarget(dir, sessionPath);
  const bus = makeBus();
  bus.setBusyTimes(1);
  const r = await sendPolishText(dir, bus, { text: "这句话值得重试" });
  assert.equal(r.ok, true);
  assert.equal(bus.sent.length, 1);
});

test("sendPolishText：宿主拒绝 → 错误透出", async () => {
  const dir = tmpDir();
  const sessionPath = makeSession();
  pinTarget(dir, sessionPath);
  const bus = makeBus({ sendResult: { ok: false, error: "这个会话正在忙，稍后再试" } });
  const r = await sendPolishText(dir, bus, { text: "发不出去的话" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /正在忙/);
});
