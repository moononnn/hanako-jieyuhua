// 解语花 — API 路由
// 配置读写 / 模型列表 / 测试 / 推荐取用 / 直接发送 / 检查更新

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, setConfig, loadData, getPending, withDataLock, normalizeStyles, DEFAULT_CONFIG, saveData } from "../lib/data.js";
import { getAvailableModels, generateSuggestions, parseSuggestions, encryptKey, redactSecrets, validateBaseUrl, callLLM } from "../lib/llm.js";
import { compareVersions } from "../lib/version.js";
import { claimAndSend } from "../lib/send.js";
import {
  startZhujian,
  stopZhujian,
  getZhujianState,
  checkZhujianDeps,
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
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  };

  // ─── 读配置 ───
  app.get("/api/config", (c) => {
    const cfg = getConfig(dataDir);
    return json({ ok: true, config: cfg });
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
        if (typeof custom.apiKey === "string" && custom.apiKey && custom.apiKey !== "********") {
          modelPatch.custom = { ...modelPatch.custom, apiKey: encryptKey(custom.apiKey) };
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
        const apiKey = String(m.custom?.apiKey || "").trim();
        const model = String(m.custom?.model || "").trim();
        const urlErr = validateBaseUrl(baseUrl);
        if (urlErr) return json({ ok: false, error: urlErr });
        if (!apiKey || !model) return json({ ok: false, error: "自定义模型配置不完整（缺少密钥或模型名）" });
        raw = await callLLM(prompt, {
          modelId: model,
          custom: { baseUrl, apiKey, model, api: "openai-completions" },
          maxTokens: 1500,
          temperature: 0.9
        });
      } else {
        if (!m.providerId || !m.modelId) return json({ ok: false, error: "还没有选择模型，请到设置页选一个" });
        raw = await callLLM(prompt, { providerId: m.providerId, modelId: m.modelId, maxTokens: 1500, temperature: 0.9 });
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
      const raw = await generateSuggestions(dataDir, prompt, { sampleFn, maxTokens: 800 });

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
    const res = startZhujian(ctx);
    return json(res, res.ok ? 200 : 400);
  });
  app.post("/api/ball/stop", async (c) => {
    const res = stopZhujian();
    return json(res, res.ok ? 200 : 400);
  });
  app.get("/api/ball/status", async (c) => {
    const st = getZhujianState();
    const deps = await checkZhujianDeps();
    return json({ ...st, ...deps });
  });
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


