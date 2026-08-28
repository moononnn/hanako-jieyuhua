// 文件预算豁免：配置、模型、发送、朗读和更新检查路由共享鉴权与数据锁，保持在同一聚合入口便于契约对照。
// 解语花 — API 路由
// 配置读写 / 模型列表 / 测试 / 推荐取用 / 直接发送 / 检查更新

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, setConfig, updateTtsConfig, loadData, getPending, withDataLock, normalizeStyles, DEFAULT_CONFIG, saveData } from "../lib/data.js";
import { getAvailableModels, generateSuggestions, parseSuggestions, redactSecrets, validateBaseUrl, callLLM } from "../lib/llm.js";
import { protectKey, maskKey, getStorageMode } from "../lib/crypto.js";
import { compareVersions } from "../lib/version.js";
import { listAgents } from "../lib/session.js";
import { synthesizeSpeech, listTtsCandidates, voicesForProtocol, clampNum } from "../lib/tts.js";
import { playAudioFile } from "../lib/play.js";
import { listFavorites, deleteFavorite, favoriteFile, groupFavorites } from "../lib/favorites.js";
import { claimAndSend } from "../lib/send.js";
import {
  startZhujian,
  stopZhujian,
  getZhujianState,
  checkZhujianDeps,
  consumeZhujianDismissed,
} from "../lib/zhujian.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default function registerPluginApiRoutes(app, ctx) {
  const dataDir = ctx.dataDir;

  // ─── 聊方向多轮会话（30 分钟无活动过期，表情包同款机制、精简版） ───
  const chatSessions = new Map();
  const CHAT_SESSION_TTL = 30 * 60 * 1000;
  function genSessionId() {
    return "chat_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }
  function cleanupChatSessions() {
    const now = Date.now();
    for (const [sid, s] of chatSessions) {
      if (now - s.lastActive > CHAT_SESSION_TTL) chatSessions.delete(sid);
    }
  }

  const json = (obj, status) => {
    const body = JSON.stringify(obj);
    return new Response(body, {
      status: status || 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      }
    });
  };

  function sanitizeConfigForClient(cfg) {
    const out = structuredClone(cfg || {});
    const modelKey = out.model?.custom?.apiKey || "";
    const ttsKey = out.tts?.apiKey || "";
    if (out.model?.custom) {
      out.model.custom.apiKey = maskKey(modelKey);
      out.model.custom.apiKeyStorage = getStorageMode(modelKey);
    }
    if (out.tts) {
      out.tts.apiKey = maskKey(ttsKey);
      out.tts.apiKeyStorage = getStorageMode(ttsKey);
    }
    return out;
  }

  // ─── 读配置 ───
  app.get("/api/config", (c) => {
    const cfg = getConfig(dataDir);
    return json({ ok: true, config: sanitizeConfigForClient(cfg) });
  });

  // ─── 写配置 ───
  app.post("/api/config", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const patch = {};

      if (body.presentation === "card" || body.presentation === "ball" || body.presentation === "off") patch.presentation = body.presentation;
      if (body.mode === "auto" || body.mode === "always") patch.mode = body.mode;
      if ([2, 3, 4].includes(body.count)) patch.count = body.count;
      if (body.action === "send" || body.action === "copy") patch.action = body.action;
      if (typeof body.guideDismissed === "boolean") patch.guideDismissed = body.guideDismissed;
      if (Array.isArray(body.styles)) patch.styles = body.styles;
      if (body.selectedByCount && typeof body.selectedByCount === "object") patch.selectedByCount = body.selectedByCount;

      const m = body.model || {};
      if (["agent", "hana", "custom"].includes(m.source)) {
        const cur = getConfig(dataDir);
        const modelPatch = { ...cur.model, source: m.source };
        if (typeof m.providerId === "string") modelPatch.providerId = m.providerId;
        if (typeof m.modelId === "string") modelPatch.modelId = m.modelId;
        const custom = m.custom || {};
        if (typeof custom.baseUrl === "string") modelPatch.custom = { ...modelPatch.custom, baseUrl: custom.baseUrl.trim() };
        if (typeof custom.model === "string") modelPatch.custom = { ...modelPatch.custom, model: custom.model.trim() };
        if (m.clearApiKey === true || custom.clearApiKey === true) {
          modelPatch.custom = { ...modelPatch.custom, apiKey: "" };
        } else if (typeof custom.apiKey === "string" && custom.apiKey && custom.apiKey !== "********") {
          modelPatch.custom = { ...modelPatch.custom, apiKey: await protectKey(custom.apiKey) };
        }
        patch.model = modelPatch;
      }

      await setConfig(dataDir, patch);
      return json({ ok: true, message: "已保存" });
    } catch (err) {
      return json({ ok: false, error: err?.message || "保存失败" }, 400);
    }
  });

  // ─── Hana 模型列表 ───
  app.get("/api/models", (c) => {
    try {
      return json({ ok: true, providers: getAvailableModels() });
    } catch (err) {
      return json({ ok: false, error: err?.message || "模型列表读取失败" });
    }
  });

  // ─── 测试模型（临时配置，内存调用，不落盘：避免明文 key 写入 data.json/.bak） ───
  app.post("/api/test-model", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const m = body.model || {};
      const source = ["agent", "hana", "custom"].includes(m.source) ? m.source : "agent";
      const count = [2, 3, 4].includes(body.count) ? body.count : 3;
      const prompt = testPrompt(count);

      let raw;
      if (source === "agent") {
        const sampleFn = (opts) => ctx.model?.sample ? ctx.model.sample(opts) : Promise.reject(new Error("当前会话模型不可用"));
        const response = await sampleFn({ messages: [{ role: "user", content: prompt }], maxTokens: 1500, temperature: 0.9 });
        raw = typeof response === "string" ? response : (response?.text ?? response?.content ?? "");
      } else if (source === "custom") {
        const baseUrl = String(m.custom?.baseUrl || "").trim();
        const submittedKey = String(m.custom?.apiKey || "").trim();
        const savedKey = String(getConfig(dataDir).model?.custom?.apiKey || "").trim();
        const apiKey = submittedKey && submittedKey !== "********" ? submittedKey : savedKey;
        const model = String(m.custom?.model || "").trim();
        const urlErr = validateBaseUrl(baseUrl);
        if (urlErr) return json({ ok: false, error: urlErr });
        if (!apiKey || !model) return json({ ok: false, error: "自定义模型配置不完整（缺少密钥或模型名）" });
        raw = await callLLM(prompt, {
          modelId: model,
          custom: { baseUrl, apiKey, model, api: "openai-completions" },
          fetcher: ctx.network?.fetch ? (url, options) => ctx.network.fetch(url, options) : undefined,
          maxTokens: 1500,
          temperature: 0.9
        });
      } else {
        if (!m.providerId || !m.modelId) return json({ ok: false, error: "还没有选择模型，请到设置页选一个" });
        if (!ctx.bus || typeof ctx.bus.request !== "function") {
          return json({ ok: false, error: "当前 Hana 没有可用的模型通道" });
        }
        const result = await ctx.bus.request("utility:call-text", {
          messages: [{ role: "user", content: prompt }],
          providerId: m.providerId,
          modelId: m.modelId,
          operation: "jiegehua-model-test",
        }, { timeoutMs: 30000 });
        raw = extractModelText(result);
      }

      const items = parseSuggestions(raw, count);
      const first = items[0];
      const sample = first && typeof first.text === "string" ? first.text : (typeof raw === "string" ? raw : "");
      return json({ ok: true, sample: sample.slice(0, 80) });
    } catch (err) {
      return json({ ok: false, error: redactSecrets(err?.message || "测试失败") });
    }
  });

  // ─── 取推荐（卡片页用） ───
  app.get("/api/suggest", (c) => {
    const rid = String(c.req.query("r") || "");
    const entry = getPending(dataDir, rid);
    if (!entry || entry.used) return json({ ok: false, items: [], error: "没有可用的推荐" });
    return json({ ok: true, items: entry.items || [] });
  });

  // ─── 直接发送（点击推荐 → 伪装成用户消息提交到会话） ───
  // 协议：只传 index（0~3），text 由服务端从推荐列表取（防注入：rid 泄露也不能塞任意内容）
  // 共用 lib/send.js claimAndSend（卡片页与解语花悬浮球同一套原子逻辑）
  app.post("/api/apply", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await claimAndSend(dataDir, { rid: body.r, index: body.index }, ctx.bus);
      if (!result.ok) return json({ ok: false, error: result.error });
      return json({ ok: true, message: "已发送" });
    } catch (err) {
      ctx.log?.error?.("[解语花] 发送失败", { error: redactSecrets(err?.message || String(err)) });
      return json({ ok: false, error: redactSecrets(err?.message || "发送失败") });
    }
  });

  // ─── 和小花聊方向（多轮：哪个方向想改、改成啥样） ───
  // 只做一件事：帮用户调整 4 个推荐方向的名字，不做别的（不过度借鉴）
  app.post("/api/chat", async (c) => {
    try {
      cleanupChatSessions();
      const body = await c.req.json().catch(() => ({}));
      const message = String(body.message || "").trim();
      let sid = String(body.session_id || "");
      if (!message) return json({ ok: false, error: "参数不完整" });
      if (message.length > 200) return json({ ok: false, error: "说短一点嘛，最多 200 字" });

      let session;
      if (sid && chatSessions.has(sid)) {
        session = chatSessions.get(sid);
      } else {
        sid = genSessionId();
        session = { history: [], lastActive: Date.now() };
        chatSessions.set(sid, session);
      }

      session.history.push({ role: "user", content: message });
      // 保留最近 10 轮（20 条），每条截断 500 字，防 prompt 无限膨胀
      if (session.history.length > 20) session.history.splice(0, session.history.length - 20);
      for (const h of session.history) {
        if (typeof h.content === "string" && h.content.length > 500) h.content = h.content.slice(0, 500);
      }
      session.lastActive = Date.now();

      const cfg = getConfig(dataDir);
      const stylesText = (cfg.styles || [])
        .map((s, i) => {
          const item = (typeof s === "object" && s !== null) ? s : { name: String(s || ""), intent: "" };
          return `${i + 1}. 【${item.name}】当前意图：${item.intent || "（未填）"}`;
        })
        .join("\n");
      const historyText = session.history
        .map((h) => `${h.role === "user" ? "用户" : "小花"}：${h.content}`)
        .join("\n");

      const prompt = [
        "你是「解语花」的方向设计师。这个插件的核心就是 4 个推荐方向——每次帮用户接话前，会按这些方向生成推荐语。",
        "这 4 个方向是你一手打磨出来的作品，你最清楚它们的脾气和用途：",
        stylesText,
        "",
        "用户来找你，就是想调整这些方向。聊起方向你像聊自己带出来的作品：",
        "- 对每个方向的本意、气质、适合的场景了如指掌，张口就来",
        "- 用户说『第 2 个太冷淡了』，你立刻知道他说的是哪个、现在意图是什么、往哪改更合适",
        "- 你会顺着用户的语感给建议，也会主动说『这个方向现在有点空，建议把意图写具体一点』",
        "- 口吻像懂行的朋友，口语化，先接住话再给意见，不端着、不啰嗦",
        "",
        "对话记录：",
        historyText,
        "",
        "你的工作方式：",
        "1. 用户还没确定要改时，自然聊，不超过 100 字，别急着下结论",
        "2. 用户明确说要改后，输出修改建议，格式：",
        '   <suggestion>[{"index": 0, "name": "新方向名", "intent": "新意图说明"}, ...]</suggestion>',
        "3. index 是方向编号减 1（0~3），name 是 2~12 个字的新方向名，intent 是 1~50 字的新意图说明（具体行为描述，不写废话）",
        "4. 一次可以改多个方向；用户没提的方向不要动",
        "5. 只有用户明确表示要改了，才输出 <suggestion>",
        "输出："
      ].join("\n");

      const sampleFn = (opts) => ctx.model?.sample ? ctx.model.sample(opts) : Promise.reject(new Error("当前会话模型不可用"));
      const raw = await generateSuggestions(dataDir, prompt, {
        sampleFn,
        bus: ctx.bus,
        agentId: ctx.agentId,
        sessionPath: ctx.sessionPath,
        fetcher: ctx.network?.fetch ? (url, options) => ctx.network.fetch(url, options) : undefined,
        maxTokens: 800,
      });

      const cleanReply = raw.replace(/<suggestion>[\s\S]*?<\/suggestion>/g, "").trim();
      let suggestion = null;
      const m = raw.match(/<suggestion>([\s\S]*?)<\/suggestion>/);
      if (m) {
        try {
          const parsed = JSON.parse(m[1].trim());
          if (Array.isArray(parsed)) {
            suggestion = parsed
              .map((s) => ({
                index: Number.isInteger(s?.index) && s.index >= 0 && s.index <= 3 ? s.index : -1,
                name: typeof s?.name === "string" ? s.name.trim() : "",
                intent: typeof s?.intent === "string" ? s.intent.trim() : ""
              }))
              .filter((s) => s.index >= 0 && s.name.length >= 2 && s.name.length <= 12 && s.intent.length >= 1 && s.intent.length <= 50);
            if (!suggestion.length) suggestion = null;
          }
        } catch {}
      }
      session.history.push({ role: "assistant", content: cleanReply || "（本条无文本）" });
      return json({
        ok: true,
        session_id: sid,
        reply: cleanReply || "嗯嗯，你说～",
        suggestion
      });
    } catch (err) {
      ctx.log?.error?.("[解语花] 聊方向失败", { error: redactSecrets(err?.message || String(err)) });
      return json({ ok: false, error: redactSecrets(err?.message || "聊一聊失败") });
    }
  });

  // ─── 恢复默认方向（一键回到出厂 4 个方向） ───
  app.post("/api/reset-styles", async (c) => {
    try {
      const defaults = structuredClone(DEFAULT_CONFIG.styles);
      await setConfig(dataDir, { styles: defaults });
      return json({ ok: true, styles: defaults });
    } catch (err) {
      return json({ ok: false, error: err?.message || "恢复失败" });
    }
  });

  // ─── 应用方向修改（用户确认后写入 styles） ───
  app.post("/api/apply-suggestion", async (c) => {    try {
      const body = await c.req.json().catch(() => ({}));
      const suggestions = body.suggestions;
      if (!Array.isArray(suggestions) || !suggestions.length || suggestions.length > 4) {
        return json({ ok: false, error: "参数不完整" });
      }
      const cfg = getConfig(dataDir);
      const baseStyles = Array.isArray(cfg.styles) ? cfg.styles : [];
      // 统一归一化（用已有 normalizeStyles 兼容旧 string[]）
      const normalized = normalizeStyles(baseStyles);
      let changed = false;
      for (const s of suggestions) {
        const i = Number.isInteger(s?.index) && s.index >= 0 && s.index <= 3 ? s.index : -1;
        const name = typeof s?.name === "string" ? s.name.trim() : "";
        const intent = typeof s?.intent === "string" ? s.intent.trim() : "";
        if (i >= 0 && name.length >= 2 && name.length <= 12 && intent.length >= 1 && intent.length <= 50) {
          normalized[i] = { name, intent };
          changed = true;
        }
      }
      if (!changed) return json({ ok: false, error: "没有有效的修改" });
      await setConfig(dataDir, { styles: normalized });
      return json({ ok: true, message: "已应用", styles: normalized });
    } catch (err) {
      ctx.log?.error?.("[解语花] 应用修改失败", { error: redactSecrets(err?.message || String(err)) });
      return json({ ok: false, error: redactSecrets(err?.message || "应用失败") });
    }
  });

  // ─── 保存语音朗读配置（三档来源：auto/hana/custom） ───
  app.post("/api/tts/save", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const patch = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (body.source === "auto" || body.source === "hana" || body.source === "custom") patch.source = body.source;
      if (typeof body.providerId === "string") patch.providerId = body.providerId;
      if (typeof body.model === "string") patch.model = body.model;
      if (body.protocol === "t2a" || body.protocol === "chat") patch.protocol = body.protocol;
      if (typeof body.groupId === "string") patch.groupId = body.groupId.trim();
      if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl.trim();
      if (body.speed !== undefined && body.speed !== "") patch.speed = clampNum(body.speed, 0.5, 2, 1);
      if (body.vol !== undefined && body.vol !== "") patch.vol = clampNum(body.vol, 0.1, 2, 1);
      if (body.pitch !== undefined && body.pitch !== "") patch.pitch = clampNum(body.pitch, -12, 12, 0);
      if (body.scope === "whole" || body.scope === "quoted") patch.scope = body.scope;
      if (body.maxLen !== undefined && body.maxLen !== "") patch.maxLen = Math.round(clampNum(body.maxLen, 20, 10000, 800));
      const keyErr = checkTtsKey(body);
      if (keyErr) return json({ ok: false, error: keyErr }, 400);
      if (body.clearApiKey === true) {
        patch.apiKey = "";
      } else if (typeof body.apiKey === "string" && body.apiKey && body.apiKey !== "********") {
        patch.apiKey = await protectKey(body.apiKey);
      }
      await updateTtsConfig(dataDir, patch);
      return json({ ok: true, message: "已保存" });
    } catch (err) {
      return json({ ok: false, error: redactSecrets(err?.message || "保存失败") }, 400);
    }
  });

  // ─── 试听语音（支持未保存的临时配置，key 从表单来；不落盘） ───
  app.post("/api/tts/test", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const cur = getConfig(dataDir);
      const tts = { ...(cur.tts || {}) };
      if (body.source === "auto" || body.source === "hana" || body.source === "custom") tts.source = body.source;
      if (typeof body.providerId === "string") tts.providerId = body.providerId;
      if (typeof body.model === "string") tts.model = body.model;
      if (body.protocol === "t2a" || body.protocol === "chat") tts.protocol = body.protocol;
      if (typeof body.apiKey === "string" && body.apiKey && body.apiKey !== "********") {
        // 试听配置只在内存里使用，不能为了测试把 Key 写入 data.json。
        tts.apiKey = body.apiKey;
      }
      if (typeof body.groupId === "string" && body.groupId.trim()) tts.groupId = body.groupId.trim();
      if (typeof body.baseUrl === "string" && body.baseUrl.trim()) tts.baseUrl = body.baseUrl.trim();
      if (typeof body.voiceId === "string") tts.voiceId = body.voiceId.trim();
      if (body.speed !== undefined && body.speed !== "") tts.speed = clampNum(body.speed, 0.5, 2, 1);
      if (body.vol !== undefined && body.vol !== "") tts.vol = clampNum(body.vol, 0.1, 2, 1);
      if (body.pitch !== undefined && body.pitch !== "") tts.pitch = clampNum(body.pitch, -12, 12, 0);
      const keyErr = checkTtsKey(body);
      if (keyErr) return json({ ok: false, error: keyErr }, 400);
      // 试听文案跟着助手名走（2026-08-20）：助手专属试听传了 agentName 就用它的名字，普通试听保持默认
      const previewName = typeof body.agentName === "string" && body.agentName.trim()
        ? body.agentName.trim()
        : "小花";
      const { audio, format } = await synthesizeSpeech(tts, `你好呀，我是${previewName}。这是解语花的语音朗读试听，这个声音你还满意吗？`);
      if (body.play === false) {
        return json({ ok: true, playing: false, message: "模型连接正常" });
      }
      // 前端 webview 不能直接播音频（autoplay 受限，实机踩坑），改为后端写临时文件 + 系统播放
      const tmpDir = path.join(dataDir, "tts-tmp");
      fs.mkdirSync(tmpDir, { recursive: true });
      // 清掉上一次试听残留（没播完就被替换的旧文件）
      try {
        for (const f of fs.readdirSync(tmpDir)) {
          if (f.startsWith("preview_")) {
            try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
          }
        }
      } catch {}
      const ext = format === "wav" ? "wav" : "mp3";
      const file = path.join(tmpDir, `preview_${Date.now()}.${ext}`);
      fs.writeFileSync(file, Buffer.from(audio, "base64"));
      playAudioFile(file, ext).finally(() => {
        try { fs.unlinkSync(file); } catch {}
      });
      return json({ ok: true, playing: true, message: "正在播放，听～" });
    } catch (err) {
      return json({ ok: false, error: redactSecrets(err?.message || "试听失败") });
    }
  });

  // ─── Hana 语音模型候选（设置页下拉用，不含 key） + 音色列表 ───
  app.get("/api/tts/candidates", (c) => {
    return json({ ok: true, candidates: listTtsCandidates() });
  });
  app.get("/api/tts/voices", (c) => {
    const protocol = String(c.req.query("protocol") || "") === "t2a" ? "t2a" : "chat";
    return json({ ok: true, voices: voicesForProtocol(protocol) });
  });

  // ─── 助手专属配音：列表按需扫描，音色覆盖单独即时保存 ───
  app.get("/api/tts/agents", (c) => {
    const cfg = getConfig(dataDir);
    const voiceByAgent = cfg.tts?.voiceByAgent || {};
    return json({
      ok: true,
      agents: listAgents().map((agent) => ({
        id: agent.id,
        name: agent.name,
        voiceId: typeof voiceByAgent[agent.id] === "string" ? voiceByAgent[agent.id] : "",
      })),
    });
  });

  app.post("/api/tts/agent-voice", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
      const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : "";
      if (!agentId || agentId.length > 120) return json({ ok: false, error: "助手信息不完整" }, 400);
      if (voiceId.length > 200) return json({ ok: false, error: "音色 id 太长了" }, 400);
      if (voiceId && !listAgents().some((agent) => agent.id === agentId)) {
        return json({ ok: false, error: "这位助手已经不存在了，先刷新列表" }, 400);
      }
      const tts = await updateTtsConfig(dataDir, (current) => {
        const voiceByAgent = { ...(current.voiceByAgent || {}) };
        if (voiceId) voiceByAgent[agentId] = voiceId;
        else delete voiceByAgent[agentId];
        return { voiceByAgent };
      });
      return json({ ok: true, agentId, voiceId: tts.voiceByAgent?.[agentId] || "", message: "已保存" });
    } catch (err) {
      return json({ ok: false, error: redactSecrets(err?.message || "保存专属音色失败") }, 400);
    }
  });

  // ─── 朗读收藏：列表（含按助手分组）/ 删除 / 试听（本地已存音频，不重新合成） ───
  app.get("/api/tts/favorites", (c) => {
    const items = listFavorites(dataDir);
    const groups = groupFavorites(items, new Map(listAgents().map((a) => [a.id, a.name])));
    return json({ ok: true, items, groups });
  });
  app.post("/api/tts/favorites/delete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return json({ ok: false, error: "缺收藏 id" }, 400);
    return json({ ok: deleteFavorite(dataDir, id), message: "已删除" });
  });
  app.post("/api/tts/favorites/play", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const id = typeof body.id === "string" ? body.id : "";
      const file = id ? favoriteFile(dataDir, id) : null;
      if (!file) return json({ ok: false, error: "收藏文件不存在" }, 404);
      const it = listFavorites(dataDir).find((x) => x.id === id);
      const ext = it && it.format === "wav" ? "wav" : "mp3";
      playAudioFile(file, ext).catch(() => {});
      return json({ ok: true, playing: true, message: "正在播放" });
    } catch (err) {
      return json({ ok: false, error: redactSecrets(err?.message || "播放失败") }, 400);
    }
  });

  // ─── 检查更新（分享版标配） ───
  const GITHUB_REPO = "moononnn/hanako-jieyuhua";  app.get("/api/check-update", async (c) => {
    try {
      const manifestPath = path.join(__dirname, "..", "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      const currentVersion = manifest.version || "0.1.0";

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let resp;
      try {
        resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=1`, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        return json({ success: false, error: "暂时不可用", repoUrl: `https://github.com/${GITHUB_REPO}` });
      }
      const tags = await resp.json();
      // 仓库还没打过 tag：视为已是最新，别报错吓到用户
      if (!Array.isArray(tags) || !tags.length) {
        return json({ success: true, hasUpdate: false, latest: "", current: currentVersion, repoUrl: `https://github.com/${GITHUB_REPO}`, message: "已是最新版本" });
      }
      const latestTag = String(tags[0].name || "").replace(/^v/, "");
      const hasUpdate = latestTag && compareVersions(latestTag, currentVersion) > 0;
      return json({
        success: true,
        hasUpdate: !!hasUpdate,
        latest: latestTag || "",
        current: currentVersion,
        repoUrl: `https://github.com/${GITHUB_REPO}`,
        message: hasUpdate ? `发现新版本 v${latestTag}` : "已是最新版本"
      });
    } catch (e) {
      return json({ success: false, error: "暂时不可用", repoUrl: `https://github.com/${GITHUB_REPO}` });
    }
  });

  // ────────────────────────────────────────────
  //  解语花悬浮球 — 启动 / 停止 / 状态 / 依赖检查
  // ────────────────────────────────────────────
  app.post("/api/ball/start", async (c) => {
    const res = await startZhujian(ctx);
    return json(res, res.ok ? 200 : (res.status || 400));
  });
  app.post("/api/ball/stop", async (c) => {
    const res = await stopZhujian();
    return json(res, res.ok ? 200 : 400);
  });
  app.get("/api/ball/status", async (c) => {
    const st = getZhujianState();
    const deps = await checkZhujianDeps();
    return json({ ...st, ...deps });
  });
  // 半自动启动状态（消费式读取：dismissed 读一次即清除；Hana 重启内存重置）
  app.get("/api/ball/autoboot", async (c) => {
    const st = getZhujianState();
    const dismissed = consumeZhujianDismissed();
    const deps = await checkZhujianDeps();
    return json({ ok: true, running: st.running, dismissed, pyQtOk: !!deps.pyQtOk });
  });
}

function extractModelText(result) {
  if (typeof result === "string") return result;
  const value = result?.text ?? result?.content ?? result?.output ?? "";
  if (Array.isArray(value)) {
    return value.map((part) => typeof part === "string" ? part : (part?.text || part?.content || "")).join("");
  }
  return String(value || "");
}

function testPrompt(count) {
  return [
    "你是「解语花」推荐引擎，你是用户的「嘴替」。这是一次连通测试，",
    "请生成", String(count),
    "条「用户准备发给小花的话」（任意日常话题）。",
    "必须是用户的第一人称口吻（「我」），对助手说话，每条 5~20 个字，口语化，",
    "只输出 JSON 字符串数组，不要任何其他文字。"
  ].join("");
}

// MiniMax 语音（t2a）认两种 Key：sk-api- 的 API Key（按量计费）和 sk-cp- 的订阅 Key（走订阅套餐额度）。
// 官方 mmx CLI 就是拿订阅 Key 直连 t2a_v2（2026-08-19 实测 200 成功），此前「只认 sk-api-」的拦截是误判，已放开。
// chat（OpenAI 兼容，如 MiMo）各家 key 前缀不同，不做前缀校验（分享版通用）。
function checkTtsKey(body) {
  const protocol = body.protocol === "t2a" ? "t2a" : body.protocol === "chat" ? "chat" : null;
  const key = typeof body.apiKey === "string" ? body.apiKey : "";
  if (!key || key === "********") return "";
  if (protocol !== "t2a") return "";
  if (/^sk-api-/i.test(key)) return "";
  if (/^sk-cp-/i.test(key)) return "";
  return "MiniMax 语音接口认两种 Key：sk-api- 开头的 API Key（按量计费）或 sk-cp- 开头的订阅 Key（走订阅套餐额度）。你填的这个开头不太对，检查一下。";
}


