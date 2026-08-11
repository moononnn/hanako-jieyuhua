// 解语花 — 页面路由（服务端渲染完整 HTML，坑 41：客户端只绑事件不做 DOM 构建）
// /suggest  — 推荐卡片页（渲染在消息流回复末尾）
// /settings — 设置页（插件抽屉入口）
//
// 纪律：客户端 JS 内联，零外部资源、零静态 import（坑 51）
//       客户端 JS 不用反引号模板字符串（坑 8：服务端模板会吞 ${}），全部字符串拼接

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, loadData } from "../lib/data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default function registerPluginUiRoutes(app, ctx) {
  const dataDir = ctx.dataDir;

  // ─── 推荐卡片页 ───
  app.get("/suggest", (c) => c.html(renderSuggestPage(c, ctx, dataDir)));

  // ─── 设置页 ───
  app.get("/settings", (c) => c.html(renderSettingsPage(c, ctx, dataDir)));
}

// ════════════════════════════════════════════
//  推荐卡片页
// ════════════════════════════════════════════
function renderSuggestPage(c, ctx, dataDir) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  const rid = String(c.req.query("r") || "");
  const cfg = getConfig(dataDir);
  const action = cfg.action === "copy" ? "copy" : "send";
  // 卡片提示跟随当前点击行为（复制/直接发送）
  const hintText = action === "send"
    ? "点一下直接发送"
    : "点一下复制，粘到输入框就发出去了";
  const apiBase = `/api/plugins/${encodeURIComponent(ctx.pluginId)}/api`;

  const clientJs = buildClientJs(apiBase, rid, action);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>解语花</title>
${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
<style>
  :root {
    --dgh-bg: #eef6f2;
    --dgh-ink: #2d3a35;
    --dgh-sub: #7a8a82;
    --dgh-accent: #5dae8e;
    --dgh-accent-deep: #4a9277;
    --dgh-accent-light: #e6f3ed;
    --dgh-paper: #faf6ec;
    --dgh-rule: #d5e5dd;
    --dgh-ok: #4a8a5e;
  }
  /* 暗色主题适配（2026-08-07）：宿主注入 data-hana-theme + hana-css 主题变量，
     夜间主题（midnight / midnight-contrast）下覆盖为深色系；
     优先引用宿主主题变量（var(--xxx, fallback) 双保险），宿主没传时退回本地暗色值。 */
  body[data-hana-theme="midnight"],
  body[data-hana-theme="midnight-contrast"] {
    --dgh-bg: var(--bg, #26333b);
    --dgh-ink: var(--text, #dce6ec);
    --dgh-sub: var(--text-muted, #a3b5c0);
    --dgh-accent: #7ec9a8;
    --dgh-accent-deep: #8fd6b4;
    --dgh-accent-light: rgba(126, 201, 168, 0.14);
    --dgh-paper: var(--bg-card, #33414a);
    --dgh-rule: var(--border, #4b5a63);
    --dgh-ok: var(--green, #8cc790);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "LXGW WenKai", "霞鹜文楷", "Kaiti SC", "STKaiti", serif;
    background: transparent;
    color: var(--dgh-ink);
    padding: 10px 12px;
  }
  .dgh-head {
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 8px;
  }
  .dgh-badge {
    font-size: 12px; color: var(--dgh-accent-deep);
    border: 1px solid var(--dgh-accent);
    border-radius: 999px;
    padding: 1px 8px;
    background: var(--dgh-paper);
  }
  .dgh-hint {
    font-size: 11px; color: var(--dgh-sub);
  }
  /* 高度策略（2026-08-06 定稿）：卡片固定最小高度，容器高度跟随条数自适应上报宿主。
     宿主对 card 槽位接受 >=30px 的高度上报并直接设置 iframe 高度（上限 600），
     所以 2/3/4 条各上报各的内容高度，iframe 精确收缩，卡片高度始终一致，下方不留白。 */
  .dgh-list {
    display: flex; flex-direction: column; gap: 6px;
  }
  .dgh-item {
    min-height: 52px;
    display: flex; flex-direction: column; justify-content: center;
    width: 100%;
    text-align: left;
    font-family: inherit;
    font-size: 13px;
    color: var(--dgh-ink);
    background: var(--dgh-paper);
    border: 1px solid var(--dgh-rule);
    border-radius: 12px;
    padding: 8px 12px;
    cursor: pointer;
    transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease;
    line-height: 1.45;
  }
  .dgh-item:hover { border-color: var(--dgh-accent); transform: translateY(-1px); }
  .dgh-item:active { transform: scale(.98); }
  .dgh-item.done {
    cursor: default; opacity: .55;
    border-color: var(--dgh-ok);
  }
  .dgh-item .dgh-tag {
    display: block; font-size: 10px; color: var(--dgh-ok);
    margin-top: 3px;
  }
  .dgh-empty {
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; color: var(--dgh-sub);
    padding: 12px; text-align: center;
  }
  .dgh-loading {
    font-size: 12px; color: var(--dgh-sub);
    padding: 12px; text-align: center;
  }
</style>
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="card">
  <div class="dgh-head">
    <span class="dgh-badge">解语花</span>
    <span class="dgh-hint">${hintText}</span>
  </div>
  <div class="dgh-list" id="dgh-list">
    <div class="dgh-loading">正在取推荐…</div>
  </div>
  <script>
${clientJs}
  </script>
</body>
</html>`;
}

// ════════════════════════════════════════════
//  设置页
// ════════════════════════════════════════════
function renderSettingsPage(c, ctx, dataDir) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  const cfg = getConfig(dataDir);
  const apiBase = `/api/plugins/${encodeURIComponent(ctx.pluginId)}/api`;

  // 当前版本（从 manifest 读）
  let version = "0.1.0";
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf-8"));
    version = manifest.version || version;
  } catch {}

  const model = cfg.model || {};
  const custom = model.custom || {};
  const apiKeyMasked = custom.apiKey ? "********" : "";

  const clientJs = buildSettingsClientJs(apiBase, {
    version,
    presentation: cfg.presentation || "card",
    mode: cfg.mode,
    count: cfg.count,
    action: cfg.action,
    styles: cfg.styles || [],
    selectedByCount: cfg.selectedByCount || {},
    source: model.source,
    providerId: model.providerId,
    modelId: model.modelId,
    customBaseUrl: escapeAttr(custom.baseUrl || ""),
    customApiKey: apiKeyMasked,
    customModel: escapeAttr(custom.model || ""),
    customApi: custom.api || "openai-completions"
  });

  const radio = (name, value, checked, label, desc) => `
    <label class="dgh-opt">
      <input type="radio" name="${name}" value="${value}"${checked ? " checked" : ""}>
      <span class="dgh-opt-body">
        <span class="dgh-opt-title">${label}</span>
        ${desc ? `<span class="dgh-opt-desc">${desc}</span>` : ""}
      </span>
    </label>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>解语花设置</title>
${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
<style>
  :root {
    --dgh-bg: #eef6f2;
    --dgh-ink: #2d3a35;
    --dgh-sub: #7a8a82;
    --dgh-accent: #5dae8e;
    --dgh-accent-deep: #4a9277;
    --dgh-accent-light: #e6f3ed;
    --dgh-pink: #e89bb0;
    --dgh-pink-light: #fce8ee;
    --dgh-paper: #fafdfb;
    --dgh-rule: #d5e5dd;
    --dgh-ok: #4a8a5e;
    --dgh-err: #c45a4e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "LXGW WenKai", "霞鹜文楷", "Kaiti SC", "STKaiti", serif;
    background: var(--dgh-bg);
    color: var(--dgh-ink);
    padding: 18px 16px 32px;
    max-width: 560px;
    margin: 0 auto;
  }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 2px; }
  .dgh-sub { font-size: 12px; color: var(--dgh-sub); margin-bottom: 18px; }
  /* 新用户指引 */
  .dgh-guide {
    background: var(--dgh-accent-light);
    border: 1px dashed var(--dgh-accent);
    border-radius: 14px;
    padding: 12px 16px;
    margin-bottom: 14px;
  }
  .dgh-guide-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
  .dgh-guide-body { font-size: 12px; color: var(--dgh-sub); line-height: 1.6; margin-bottom: 8px; }
  .dgh-card {
    background: var(--dgh-paper);
    border: 1px solid var(--dgh-rule);
    border-radius: 14px;
    padding: 14px 16px;
    margin-bottom: 14px;
  }
  .dgh-card-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
  .dgh-opt {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 7px 0;
    cursor: pointer;
  }
  .dgh-opt input[type=radio] { margin-top: 3px; accent-color: var(--dgh-accent-deep); }
  .dgh-opt-title { font-size: 13px; display: block; }
  .dgh-opt-desc { font-size: 11px; color: var(--dgh-sub); display: block; margin-top: 1px; }
  .dgh-field { margin: 8px 0; }
  .dgh-field label { display: block; font-size: 12px; color: var(--dgh-sub); margin-bottom: 3px; }
  .dgh-input, .dgh-select {
    width: 100%;
    font-family: inherit; font-size: 13px;
    color: var(--dgh-ink);
    background: var(--dgh-bg);
    border: 1px solid var(--dgh-rule);
    border-radius: 10px;
    padding: 7px 10px;
  }
  .dgh-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .dgh-btn {
    font-family: inherit; font-size: 13px;
    color: var(--dgh-paper);
    background: var(--dgh-accent-deep);
    border: none; border-radius: 10px;
    padding: 7px 16px;
    cursor: pointer;
    transition: opacity .15s ease;
  }
  .dgh-btn:hover { opacity: .88; }
  .dgh-btn:disabled { opacity: .5; cursor: default; }
  .dgh-btn.ghost {
    background: transparent; color: var(--dgh-accent-deep);
    border: 1px solid var(--dgh-accent);
  }
  .dgh-msg { font-size: 12px; margin-top: 8px; min-height: 18px; }
  .dgh-msg.ok { color: var(--dgh-ok); }
  .dgh-msg.err { color: var(--dgh-err); }
  .dgh-hidden { display: none; }
  /* 解语花悬浮球状态区 */
  .dgh-ball-box {
    margin-top: 8px;
    background: var(--dgh-accent-light);
    border: 1px dashed var(--dgh-accent);
    border-radius: 12px;
    padding: 10px 12px;
  }
  .dgh-ball-status { font-size: 12px; color: var(--dgh-sub); }
  .dgh-foot { font-size: 11px; color: var(--dgh-sub); text-align: center; margin-top: 6px; }
  /* 右上角按钮组（仿表情包 home-text-btn） */
  .dgh-topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 2px; flex-wrap: wrap; }
  .dgh-topbar h1 { margin: 0; }
  .dgh-topbar .dgh-ver { font-size: 11px; color: var(--dgh-sub); }
  .dgh-topbar .spacer { flex: 1; }
  .dgh-top-btn {
    font-family: inherit; font-size: 13px;
    padding: 5px 14px;
    border: 1px solid var(--dgh-rule);
    border-radius: 14px;
    background: var(--dgh-paper);
    cursor: pointer;
    color: var(--dgh-sub);
    display: inline-flex; align-items: center;
    white-space: nowrap;
    transition: all .15s ease;
  }
  .dgh-top-btn:hover { border-color: var(--dgh-accent); color: var(--dgh-accent-deep); background: var(--dgh-accent-light); }
  /* 模型设置弹窗 */
  .dgh-modal-overlay {
    position: fixed; inset: 0; z-index: 50;
    background: rgba(45, 58, 53, .28);
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .dgh-modal-overlay.dgh-hidden { display: none; }
  .dgh-modal-box {
    width: 480px; max-width: 100%; max-height: 88vh;
    background: var(--dgh-paper);
    border: 2px dashed var(--dgh-accent);
    border-radius: 20px;
    box-shadow: 0 8px 30px rgba(93, 174, 142, .15);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .dgh-modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px 10px;
    border-bottom: 1px solid var(--dgh-rule);
    flex-shrink: 0;
  }
  .dgh-modal-head h2 { font-size: 16px; font-weight: 600; }
  .dgh-modal-close {
    font-family: inherit; font-size: 14px; color: var(--dgh-sub);
    background: none; border: none; cursor: pointer;
    padding: 2px 8px; border-radius: 8px;
  }
  .dgh-modal-close:hover { color: var(--dgh-accent-deep); background: var(--dgh-accent-light); }
  .dgh-modal-body { padding: 12px 18px 6px; overflow-y: auto; flex: 1; }
  .dgh-modal-foot {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 18px 16px;
    border-top: 1px solid var(--dgh-rule);
    flex-shrink: 0;
  }
  .dgh-modal-foot .dgh-msg { flex: 1; margin: 0; min-height: 0; }
  /* toast */
  .dgh-toast {
    position: fixed; left: 50%; top: 18px; transform: translateX(-50%);
    z-index: 60;
    font-size: 13px;
    background: var(--dgh-accent-deep); color: #fff;
    border-radius: 999px;
    padding: 8px 18px;
    box-shadow: 0 4px 14px rgba(74, 146, 119, .25);
    opacity: 0; pointer-events: none;
    transition: opacity .2s ease, transform .2s ease;
  }
  .dgh-toast.show { opacity: 1; transform: translateX(-50%) translateY(2px); }
  .dgh-toast.err { background: var(--dgh-err); box-shadow: 0 4px 14px rgba(196, 90, 78, .25); }
  .dgh-toast.warn { background: var(--dgh-pink); box-shadow: 0 4px 14px rgba(232, 155, 176, .3); }
  /* 方向按钮 */
  .dgh-styles { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .dgh-style-btn {
    font-family: inherit; font-size: 13px;
    color: var(--dgh-ink);
    background: var(--dgh-paper);
    border: 1px solid var(--dgh-rule);
    border-radius: 999px;
    padding: 6px 14px;
    cursor: pointer;
    transition: all .15s ease;
  }
  .dgh-style-btn:hover { border-color: var(--dgh-accent); }
  .dgh-style-btn.on {
    background: var(--dgh-accent-deep); color: #fff;
    border-color: var(--dgh-accent-deep);
  }
  /* 聊一聊（精简） */
  .dgh-chat { margin-top: 12px; border: 1px solid var(--dgh-rule); border-radius: 12px; padding: 10px; background: var(--dgh-bg); }
  .dgh-chat-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .dgh-chat-title { font-size: 13px; font-weight: 600; }
  .dgh-chat-msgs { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 6px 0; }
  .dgh-bubble { max-width: 85%; padding: 7px 11px; border-radius: 12px; font-size: 13px; line-height: 1.5; word-wrap: break-word; white-space: pre-wrap; }
  .dgh-bubble.user { align-self: flex-end; background: var(--dgh-accent-deep); color: #fff; border-bottom-right-radius: 4px; }
  .dgh-bubble.assistant { align-self: flex-start; background: var(--dgh-paper); border: 1px solid var(--dgh-rule); border-bottom-left-radius: 4px; }
  /* 等待中的思考气泡 */
  .dgh-bubble-think { color: var(--dgh-sub); font-style: italic; }
  .dgh-bubble-think::after {
    content: "…"; display: inline-block; margin-left: 1px;
    animation: dgh-think-dots 1.2s ease-in-out infinite;
  }
  @keyframes dgh-think-dots {
    0%, 20% { opacity: .25; }
    50% { opacity: 1; }
    80%, 100% { opacity: .25; }
  }
  .dgh-chat-inputrow { display: flex; gap: 8px; margin-top: 8px; }
  .dgh-chat-inputrow .dgh-input { flex: 1; }
  .dgh-chat-sug { margin-top: 10px; background: var(--dgh-paper); border: 1px dashed var(--dgh-accent); border-radius: 12px; padding: 10px; }
  .dgh-sug-title { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
  .dgh-change { font-size: 12px; padding: 4px 0; }
  .dgh-change-old { color: var(--dgh-sub); text-decoration: line-through; }
  .dgh-change-new { color: var(--dgh-ink); }
</style>
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="page">
  <div class="dgh-topbar">
    <h1>解语花</h1>
    <span class="dgh-ver">v${escapeHtml(version)}</span>
    <span class="spacer"></span>
    <button class="dgh-top-btn" id="dgh-model-open" type="button" title="生成推荐的模型配置">模型设置</button>
    <button class="dgh-top-btn" id="dgh-update" type="button" title="检查 GitHub 上的新版本">检查更新</button>
    <button class="dgh-top-btn" id="dgh-feedback" type="button" title="遇到 bug 或有建议，来 GitHub 提 issue">反馈</button>
  </div>
  <div class="dgh-sub">AI 回复完之后，帮你想几句接得上的话</div>

  ${cfg.guideDismissed ? "" : `
  <div class="dgh-guide" id="dgh-guide">
    <div class="dgh-guide-title">第一次用解语花？</div>
    <div class="dgh-guide-body">聊天时 AI 回复下方会出现一张小卡片，上面是几条你可能想说的话，点一下复制（或直接发送），不用自己打字。默认已经开了，直接去聊就行。<br>生成推荐需要一个模型，默认已跟随当前聊天框的助手模型，不用额外配置。想换模型或单独配一个更省钱的，点右上角「模型设置」。</div>
    <div class="dgh-row">
      <button class="dgh-btn ghost" id="dgh-guide-close" type="button">知道了</button>
    </div>
  </div>`}

  <div class="dgh-card">
    <div class="dgh-card-title">展示方式</div>
    ${radio("presentation", "card", cfg.presentation !== "ball" && cfg.presentation !== "off", "回复卡片", "AI 回复后，推荐卡片出现在回复下方（原来的方式）")}
    ${radio("presentation", "ball", cfg.presentation === "ball", "解语花", "桌面一朵会接话的樱花，点开面板直接挑话发出去，不占对话流")}
    ${radio("presentation", "off", cfg.presentation === "off", "关闭", "不生成任何推荐")}
    <div class="dgh-ball-box dgh-hidden" id="dgh-ball-box">
      <div class="dgh-ball-status" id="dgh-ball-status">检测中…</div>
      <div class="dgh-row" style="margin-top:6px">
        <button class="dgh-btn" id="dgh-ball-activate" type="button" style="display:none">激活解语花</button>
        <button class="dgh-btn ghost" id="dgh-ball-stop" type="button" style="display:none">停止解语花</button>
      </div>
    </div>
  </div>

  <div class="dgh-card">
    <div class="dgh-card-title">什么时候出推荐</div>
    ${radio("mode", "always", cfg.mode === "always", "每次都推荐", "每轮回复都带推荐，方便稳定，多花一点模型费用")}
    ${radio("mode", "auto", cfg.mode === "auto", "看情况推荐", "助手觉得这轮聊完你可能想接话时才出，不打扰；但出不出看模型的自觉，偶尔可能整轮都没卡")}
  </div>

  <div class="dgh-card">
    <div class="dgh-card-title">推荐几条</div>
    ${radio("count", "2", cfg.count === 2, "2 条")}
    ${radio("count", "3", cfg.count === 3, "3 条")}
    ${radio("count", "4", cfg.count === 4, "4 条")}
  </div>

  <div class="dgh-card">
    <div class="dgh-card-title">推荐方向</div>
    <div class="dgh-sub">生成时每条推荐按一个方向来写，勾选数量跟推荐条数一致；方向不合适可以跟小花聊聊调整</div>
    <div class="dgh-styles" id="dgh-styles">
      ${(cfg.styles || []).map((s, i) => `
      <button class="dgh-style-btn${(cfg.selectedByCount && cfg.selectedByCount[cfg.count] || []).includes(i) ? " on" : ""}" data-idx="${i}" type="button">${escapeAttr(s && typeof s === "object" ? s.name : s)}</button>`).join("")}
    </div>
    <div class="dgh-sub" id="dgh-style-hint"></div>
    <div class="dgh-row" style="margin-top:10px">
      <button class="dgh-btn ghost" id="dgh-chat-open" type="button">💬 和小花聊一聊</button>
      <button class="dgh-btn ghost" id="dgh-reset-styles" type="button" style="margin-left:auto">恢复默认方向</button>
    </div>
    <div class="dgh-chat" id="dgh-chat" hidden>
      <div class="dgh-chat-head">
        <span class="dgh-chat-title">和小花聊一聊</span>
        <button class="dgh-btn ghost" id="dgh-chat-close" type="button">收起</button>
      </div>
      <div class="dgh-chat-msgs" id="dgh-chat-msgs"></div>
      <div class="dgh-chat-sug" id="dgh-chat-sug" hidden></div>
      <div class="dgh-chat-inputrow">
        <input class="dgh-input" id="dgh-chat-input" placeholder="比如：第 2 个方向改成温柔一点">
        <button class="dgh-btn" id="dgh-chat-send" type="button">发送</button>
      </div>
    </div>
  </div>

  <div class="dgh-card">
    <div class="dgh-card-title">点一下之后</div>
    ${radio("action", "send", cfg.action === "send", "直接发送", "点一下，这条话就以你的名义发出去")}
    ${radio("action", "copy", cfg.action === "copy", "复制", "复制到剪贴板，自己粘贴后再发")}
  </div>

  <div class="dgh-foot">解语花 · 推荐由模型生成，只是建议，发不发你说了算</div>

  <!-- 模型设置弹窗 -->
  <div class="dgh-modal-overlay dgh-hidden" id="dgh-modal">
    <div class="dgh-modal-box">
      <div class="dgh-modal-head">
        <h2>模型设置</h2>
        <button class="dgh-modal-close" id="dgh-modal-close" type="button">✕</button>
      </div>
      <div class="dgh-modal-body">
        ${radio("source", "agent", model.source === "agent", "跟随助手当前模型", "不额外配置，用的就是对话里的模型")}
        ${radio("source", "hana", model.source === "hana", "从已配置的模型里选", "选一个便宜轻量的模型，生成推荐更省钱")}
        ${radio("source", "custom", model.source === "custom", "自定义 API", "自己填地址和密钥，最灵活")}

        <div class="dgh-field dgh-hidden" id="dgh-hana-box">
          <label for="dgh-provider">供应商</label>
          <select class="dgh-select" id="dgh-provider"><option value="">（加载中…）</option></select>
          <label for="dgh-model" style="margin-top:8px">模型</label>
          <select class="dgh-select" id="dgh-model"><option value="">先选供应商</option></select>
        </div>

        <div class="dgh-field dgh-hidden" id="dgh-custom-box">
          <label for="dgh-custom-url">API 地址</label>
          <input class="dgh-input" id="dgh-custom-url" placeholder="https://api.example.com/v1" value="${escapeAttr(custom.baseUrl || "")}">
          <label for="dgh-custom-key" style="margin-top:8px">API 密钥</label>
          <input class="dgh-input" id="dgh-custom-key" type="password" placeholder="sk-..." value="${escapeAttr(apiKeyMasked)}">
          <label for="dgh-custom-model" style="margin-top:8px">模型名</label>
          <input class="dgh-input" id="dgh-custom-model" placeholder="例如 gpt-4o-mini" value="${escapeAttr(custom.model || "")}">
        </div>
      </div>
      <div class="dgh-modal-foot">
        <button class="dgh-btn ghost" id="dgh-test" type="button">测试一下</button>
        <button class="dgh-btn" id="dgh-save" type="button">保存</button>
        <div class="dgh-msg" id="dgh-msg"></div>
      </div>
    </div>
  </div>

  <div class="dgh-toast" id="dgh-toast"></div>

  <script>
${clientJs}
  </script>
</body>
</html>`;
}

// ════════════════════════════════════════════
//  推荐卡片页客户端 JS（内联）
// ════════════════════════════════════════════
function buildClientJs(apiBase, rid, action) {
  return `(function(){
  var API = ${JSON.stringify(apiBase)};
  var RID = ${JSON.stringify(rid)};
  var ACTION = ${JSON.stringify(action)}; // 服务端渲染的初始值，加载后会被实时配置覆盖
  var TOKEN = new URLSearchParams(location.search).get("token") || "";
  var HOST_ORIGIN = new URLSearchParams(location.search).get("hana-host-origin") || "*";

  window.parent.postMessage({ protocol: "hana.plugin.ui", version: 1, kind: "event", type: "hana.ready" }, "*");

  // ── 高度自适应：内容渲染后把实际高度上报宿主（朋友圈同款机制） ──
  // 注意：渲染完成前一律不上报——加载态高度只有几十像素，上报了宿主会把 iframe 缩成一条缝
  var rendered = false;
  var lastReportedH = -1;
  function reportHeight() {
    if (!rendered) return; // 渲染完成前不上报，避免加载态迷你高度把卡片缩没
    var h = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    if (h <= 0 || h === lastReportedH) return; // 高度没变化不重复上报，防 resize 循环
    lastReportedH = h;
    window.parent.postMessage({ protocol: "hana.plugin.ui", version: 1, kind: "event", type: "ui.resize", payload: { height: h } }, HOST_ORIGIN);
  }
  var reported = false;
  function reportHeightOnce() {
    if (reported) return;
    reported = true;
    reportHeight();
  }
  if (typeof ResizeObserver !== "undefined") {
    // 内容变化（推荐条数/状态文字）时自动上报；带防抖避免高频触发
    var roTimer = null;
    new ResizeObserver(function(){
      if (roTimer) return;
      roTimer = setTimeout(function(){ roTimer = null; reportHeight(); }, 120);
    }).observe(document.documentElement);
  } else {
    window.addEventListener("load", function(){ setTimeout(reportHeightOnce, 100); });
  }

  // 实时拉取最新配置（用户切了「直接发送/复制」后，旧卡片也能用新行为）
  apiGet("/config").then(function(res){
    if (res && res.ok && res.config) {
      ACTION = res.config.action === "copy" ? "copy" : "send";
    }
  }).catch(function(){});

  function apiUrl(p) {
    var u = new URL(API + p, location.origin);
    if (TOKEN) u.searchParams.set("token", TOKEN);
    return u.pathname + u.search;
  }

  function apiGet(p) {
    return fetch(apiUrl(p), { credentials: "same-origin" }).then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function apiPost(p, body) {
    return fetch(apiUrl(p), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function hostRequest(type, payload) {
    var id = "dgh-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    return new Promise(function(resolve, reject){
      var done = false;
      var timer = setTimeout(function(){ cleanup(); reject(new Error("宿主请求超时")); }, 4000);
      function cleanup(){ window.removeEventListener("message", onMsg); clearTimeout(timer); }
      function onMsg(ev){
        if (ev.source !== window.parent) return;
        if (HOST_ORIGIN !== "*" && ev.origin !== HOST_ORIGIN) return;
        var m = ev.data;
        if (!m || m.protocol !== "hana.plugin.ui" || m.version !== 1) return;
        if (m.id !== id || m.type !== type) return;
        cleanup(); done = true;
        if (m.kind === "response") resolve(m.payload);
        else reject(new Error((m.error && m.error.message) || type + " 失败"));
      }
      window.addEventListener("message", onMsg);
      window.parent.postMessage({ protocol: "hana.plugin.ui", version: 1, id: id, kind: "request", type: type, payload: payload }, HOST_ORIGIN);
    });
  }

  function copyText(text) {
    // 宿主桥优先（manifest 已声明 clipboard.writeText），失败再回退浏览器原生
    return hostRequest("clipboard.writeText", { text: text }).then(function(){
      return true;
    }).catch(function(){
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function(){ return true; }).catch(function(){ return fallbackCopy(text); });
      }
      return Promise.resolve(fallbackCopy(text));
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // 点击时实时确认行为（不依赖 iframe 加载时的配置快照）
  function currentAction() {
    return apiGet("/config").then(function(res){
      if (res && res.ok && res.config) {
        return res.config.action === "copy" ? "copy" : "send";
      }
      return ACTION;
    }).catch(function(){
      return ACTION;
    });
  }

  function renderItems(items) {
    var list = document.getElementById("dgh-list");
    if (!list) return;
    list.innerHTML = "";
    if (!items || !items.length) {
      list.innerHTML = '<div class="dgh-empty">没有可用的推荐了</div>';
      return;
    }
    for (var i = 0; i < items.length; i++) {
      (function(idx, item){
        var text = typeof item === "string" ? item : (item && item.text) || "";
        var btn = document.createElement("button");
        btn.className = "dgh-item";
        btn.type = "button";
        btn.textContent = text;
        btn.addEventListener("click", function(){
          if (btn.classList.contains("done")) return;
          btn.classList.add("done");
          currentAction().then(function(act){
            if (act === "copy") {
              copyText(text).then(function(ok){
                var tag = document.createElement("span");
                tag.className = "dgh-tag";
                tag.textContent = ok ? "已复制，去粘贴吧" : "复制失败，长按选中文本试试";
                btn.appendChild(tag);
                if (!ok) btn.classList.remove("done");
              });
            } else {
              apiPost("/apply", { r: RID, index: idx }).then(function(res){
                var tag = document.createElement("span");
                tag.className = "dgh-tag";
                if (res && res.ok) {
                  tag.textContent = "已发送";
                  markAllDone();
                } else {
                  tag.textContent = (res && res.error) || "发送失败";
                  btn.classList.remove("done");
                }
                btn.appendChild(tag);
              }).catch(function(err){
                var tag = document.createElement("span");
                tag.className = "dgh-tag";
                tag.textContent = "发送失败：" + err.message;
                btn.appendChild(tag);
                btn.classList.remove("done");
              });
            }
          });
        });
        list.appendChild(btn);
      })(i, items[i]);
    }
  }

  function markAllDone() {
    var list = document.getElementById("dgh-list");
    if (!list) return;
    var btns = list.querySelectorAll(".dgh-item");
    for (var i = 0; i < btns.length; i++) {
      if (!btns[i].classList.contains("done")) {
        btns[i].classList.add("done");
      }
    }
  }

  apiGet("/suggest?r=" + encodeURIComponent(RID)).then(function(res){
    if (res && res.ok) renderItems(res.items || []);
    else renderItems([]);
    // 渲染完成标记 + 上报一次高度（渲染前 RO 的初始触发会被 rendered 拦下，不会上报迷你高度）
    rendered = true;
    setTimeout(reportHeightOnce, 50);
  }).catch(function(){
    renderItems([]);
    rendered = true;
    setTimeout(reportHeightOnce, 50);
  });
})();`;
}

// ════════════════════════════════════════════
//  设置页客户端 JS（内联）
// ════════════════════════════════════════════
function buildSettingsClientJs(apiBase, state) {
  return `(function(){
  var API = ${JSON.stringify(apiBase)};
  var STATE = ${JSON.stringify(state)};
  var TOKEN = new URLSearchParams(location.search).get("token") || "";

  window.parent.postMessage({ protocol: "hana.plugin.ui", version: 1, kind: "event", type: "hana.ready" }, "*");

  function apiUrl(p) {
    var u = new URL(API + p, location.origin);
    if (TOKEN) u.searchParams.set("token", TOKEN);
    return u.pathname + u.search;
  }

  function apiGet(p) {
    return fetch(apiUrl(p), { credentials: "same-origin" }).then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function apiPost(p, body) {
    return fetch(apiUrl(p), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function $(id) { return document.getElementById(id); }
  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function radioValue(name) {
    var els = document.querySelectorAll("input[name=" + name + "]");
    for (var i = 0; i < els.length; i++) {
      if (els[i].checked) return els[i].value;
    }
    return "";
  }
  function setMsg(text, ok) {
    var el = $("dgh-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "dgh-msg" + (ok ? " ok" : text ? " err" : "");
  }
  var toastTimer = null;
  function showToast(text, kind) {
    var el = $("dgh-toast");
    if (!el) return;
    el.textContent = text;
    el.className = "dgh-toast" + (kind ? " " + kind : "");
    void el.offsetWidth; // 强制重排，保证过渡动画
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.classList.remove("show"); }, 2200);
  }

  // ── 即时生效：改了就存，不用点保存 ──
  function saveField(patch) {
    return apiPost("/config", patch).then(function(res){
      if (res && res.ok) {
        showToast("已保存");
      } else {
        showToast(((res && res.error) || "保存失败"), "err");
      }
      return res;
    }).catch(function(err){
      showToast("保存失败：" + err.message, "err");
    });
  }

  // ── 模型档位显隐 ──
  function syncSourceBoxes() {
    var src = radioValue("source");
    var hanaBox = $("dgh-hana-box");
    var customBox = $("dgh-custom-box");
    if (hanaBox) hanaBox.className = "dgh-field" + (src === "hana" ? "" : " dgh-hidden");
    if (customBox) customBox.className = "dgh-field" + (src === "custom" ? "" : " dgh-hidden");
  }
  document.querySelectorAll("input[name=source]").forEach(function(r){
    r.addEventListener("change", syncSourceBoxes);
  });
  syncSourceBoxes();

  // ── Hana 模型列表 ──
  var providers = [];
  function loadModels() {
    var sel = $("dgh-provider");
    if (!sel) return;
    apiGet("/models").then(function(res){
      if (!res || !res.ok) return;
      providers = (res.providers || []).filter(function(p){ return p.models && p.models.length; });
      sel.innerHTML = "";
      var placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = providers.length
        ? "选择供应商"
        : "还没有可用的模型，建议用『跟随助手当前模型』";
      sel.appendChild(placeholder);
      for (var i = 0; i < providers.length; i++) {
        var opt = document.createElement("option");
        opt.value = providers[i].id;
        opt.textContent = providers[i].name + (providers[i].models.some(function(m){ return !m.available; }) ? "（部分需补密钥）" : "");
        sel.appendChild(opt);
      }
      if (STATE.providerId) sel.value = STATE.providerId;
      syncModelSelect();
    }).catch(function(){});
  }

  function syncModelSelect() {
    var sel = $("dgh-provider");
    var modelSel = $("dgh-model");
    if (!sel || !modelSel) return;
    var pid = sel.value;
    modelSel.innerHTML = "";
    var prov = null;
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].id === pid) { prov = providers[i]; break; }
    }
    if (!prov) {
      var ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "先选供应商";
      modelSel.appendChild(ph);
      return;
    }
    var ph2 = document.createElement("option");
    ph2.value = "";
    ph2.textContent = "选择模型";
    modelSel.appendChild(ph2);
    for (var j = 0; j < prov.models.length; j++) {
      var m = prov.models[j];
      var opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name + (m.contextWindow ? "（" + m.contextWindow + "）" : "") + (m.available ? "" : " ⚠无密钥");
      modelSel.appendChild(opt);
    }
    if (STATE.modelId && pid === STATE.providerId) modelSel.value = STATE.modelId;
  }

  var provSel = $("dgh-provider");
  if (provSel) provSel.addEventListener("change", syncModelSelect);
  loadModels();

  // ── 方向按钮勾选（每档条数独立记忆，记住用户选过哪个） ──
  var styleBtns = [];
  var selByCount = {};
  for (var sc = 2; sc <= 4; sc++) {
    var defSel = sc === 2 ? [0, 1] : sc === 3 ? [0, 1, 2] : [0, 1, 2, 3];
    selByCount[sc] = (STATE.selectedByCount && STATE.selectedByCount[sc] && STATE.selectedByCount[sc].length)
      ? STATE.selectedByCount[sc].slice()
      : defSel;
  }
  var styleSelected = selByCount[parseInt(radioValue("count") || "3", 10)].slice();

  function bindStyleButtons() {
    var box = $("dgh-styles");
    if (!box) return;
    var btns = box.querySelectorAll(".dgh-style-btn");
    styleBtns = [];
    for (var i = 0; i < btns.length; i++) {
      styleBtns.push(btns[i]);
      (function(btn){
        btn.addEventListener("click", function(){
          var idx = parseInt(btn.getAttribute("data-idx") || "-1", 10);
          if (idx < 0) return;
          var need = parseInt(radioValue("count") || "3", 10);
          var pos = styleSelected.indexOf(idx);
          if (pos >= 0) {
            styleSelected.splice(pos, 1);
          } else {
            // 已满：自动取消最早勾选的，视觉与实际永远一致（不再静默截断）
            if (styleSelected.length >= need) {
              styleSelected.shift();
            }
            styleSelected.push(idx);
            styleSelected.sort(function(a, b){ return a - b; });
          }
          selByCount[need] = styleSelected.slice();
          refreshStyleUI();
          saveField({ selectedByCount: selByCount }); // 即时保存勾选
        });
      })(btns[i]);
    }
  }

  function refreshStyleUI() {
    if (!styleBtns.length) bindStyleButtons(); // 兜底：没绑上就重新绑
    var need = parseInt(radioValue("count") || "3", 10);
    for (var i = 0; i < styleBtns.length; i++) {
      var on = styleSelected.indexOf(i) >= 0;
      styleBtns[i].classList.toggle("on", on);
    }
    var hint = $("dgh-style-hint");
    if (hint) {
      var n = styleSelected.length;
      hint.textContent = n === need
        ? "已选 " + n + " 个方向"
        : "已选 " + n + " 个，推荐 " + need + " 条需要选 " + need + " 个方向";
    }
  }

  // 切条数：恢复该档记住的勾选
  document.querySelectorAll("input[name=count]").forEach(function(r){
    r.addEventListener("change", function(){
      var need = parseInt(radioValue("count") || "3", 10);
      styleSelected = selByCount[need].slice();
      refreshStyleUI();
      saveField({ count: need, selectedByCount: selByCount }); // 即时保存
    });
  });

  // 即时生效：展示方式 / 时机 / 发送方式 改动即存
  // 切到解语花 → 自动启动；切走 → 自动停止
  function syncBallBox() {
    var box = $("dgh-ball-box");
    if (!box) return;
    var isBall = radioValue("presentation") === "ball";
    box.classList.toggle("dgh-hidden", !isBall);
    if (isBall) refreshBallStatus();
  }

  function refreshBallStatus() {
    var st = $("dgh-ball-status");
    var act = $("dgh-ball-activate");
    var stop = $("dgh-ball-stop");
    if (!st) return;
    apiGet("/ball/status").then(function(res){
      if (res && res.ok && res.running) {
        st.textContent = "解语花运行中 · " + (res.python || "");
        if (act) act.style.display = "none";
        if (stop) stop.style.display = "";
      } else {
        var err = res && res.error ? ("（" + res.error + "）") : "";
        st.textContent = "解语花未在运行" + err;
        if (act) act.style.display = "";
        if (stop) stop.style.display = "none";
      }
    }).catch(function(){
      st.textContent = "状态查询失败";
    });
  }

  document.querySelectorAll("input[name=presentation]").forEach(function(r){
    r.addEventListener("change", function(){
      var v = radioValue("presentation") || "card";
      saveField({ presentation: v });
      if (v === "ball") {
        apiPost("/ball/start", {}).then(function(res){
          if (res && res.ok) showToast("解语花已激活");
          else showToast(((res && res.error) || "解语花启动失败"), "err");
          refreshBallStatus();
        }).catch(function(){ showToast("解语花启动失败", "err"); refreshBallStatus(); });
      } else {
        apiPost("/ball/stop", {}).then(function(){
          refreshBallStatus();
        }).catch(function(){ refreshBallStatus(); });
      }
      syncBallBox();
    });
  });
  var ballAct = $("dgh-ball-activate");
  if (ballAct) ballAct.addEventListener("click", function(){
    apiPost("/ball/start", {}).then(function(res){
      if (res && res.ok) showToast("解语花已激活");
      else showToast(((res && res.error) || "解语花启动失败"), "err");
      refreshBallStatus();
    }).catch(function(){ showToast("竹简启动失败", "err"); refreshBallStatus(); });
  });
  var ballStop = $("dgh-ball-stop");
  if (ballStop) ballStop.addEventListener("click", function(){
    apiPost("/ball/stop", {}).then(function(){
      showToast("竹简已停止");
      refreshBallStatus();
    }).catch(function(){ showToast("停止失败", "err"); refreshBallStatus(); });
  });
  syncBallBox();

  document.querySelectorAll("input[name=mode]").forEach(function(r){
    r.addEventListener("change", function(){
      saveField({ mode: radioValue("mode") || "auto" });
    });
  });
  document.querySelectorAll("input[name=action]").forEach(function(r){
    r.addEventListener("change", function(){
      saveField({ action: radioValue("action") || "send" });
    });
  });

  // 提前绑定（不依赖后面代码执行）
  bindStyleButtons();
  refreshStyleUI();

  // ── 模型弹窗开关 ──
  function openModelModal() {
    var m = $("dgh-modal");
    if (m) m.classList.remove("dgh-hidden");
    syncSourceBoxes();
    loadModels();
    setMsg("", false);
  }
  function closeModelModal() {
    var m = $("dgh-modal");
    if (m) m.classList.add("dgh-hidden");
  }
  var modelOpenBtn = $("dgh-model-open");
  if (modelOpenBtn) modelOpenBtn.addEventListener("click", openModelModal);
  var modalCloseBtn = $("dgh-modal-close");
  if (modalCloseBtn) modalCloseBtn.addEventListener("click", closeModelModal);
  var modalOverlay = $("dgh-modal");
  if (modalOverlay) modalOverlay.addEventListener("click", function(e){
    if (e.target === modalOverlay) closeModelModal();
  });

  // 保存（弹窗内，只存模型配置） ──
  $("dgh-save").addEventListener("click", function(){
    var body = {
      model: {
        source: radioValue("source") || "agent",
        providerId: $("dgh-provider") ? $("dgh-provider").value : "",
        modelId: $("dgh-model") ? $("dgh-model").value : "",
        custom: {
          baseUrl: $("dgh-custom-url") ? $("dgh-custom-url").value.trim() : "",
          apiKey: $("dgh-custom-key") ? $("dgh-custom-key").value : "",
          model: $("dgh-custom-model") ? $("dgh-custom-model").value.trim() : ""
        }
      }
    };
    setMsg("保存中…");
    apiPost("/config", body).then(function(res){
      if (res && res.ok) {
        setMsg("已保存", true);
        if (body.model.custom.apiKey && body.model.custom.apiKey !== "********") {
          $("dgh-custom-key").value = "********";
        }
        setTimeout(closeModelModal, 600);
      } else {
        setMsg((res && res.error) || "保存失败", false);
      }
    }).catch(function(err){
      setMsg("保存失败：" + err.message, false);
    });
  });

  // ── 测试（弹窗内） ──
  $("dgh-test").addEventListener("click", function(){
    var body = {
      count: parseInt(radioValue("count") || "3", 10),
      model: {
        source: radioValue("source") || "agent",
        providerId: $("dgh-provider") ? $("dgh-provider").value : "",
        modelId: $("dgh-model") ? $("dgh-model").value : "",
        custom: {
          baseUrl: $("dgh-custom-url") ? $("dgh-custom-url").value.trim() : "",
          apiKey: $("dgh-custom-key") ? $("dgh-custom-key").value : "",
          model: $("dgh-custom-model") ? $("dgh-custom-model").value.trim() : ""
        }
      }
    };
    setMsg("测试中…");
    apiPost("/test-model", body).then(function(res){
      if (res && res.ok) {
        setMsg("连接成功，示例推荐：" + (res.sample || "生成正常"), true);
      } else {
        setMsg("测试失败：" + ((res && res.error) || "未知错误"), false);
      }
    }).catch(function(err){
      setMsg("测试失败：" + err.message, false);
    });
  });

  // ── 检查更新 ──
  $("dgh-update").addEventListener("click", function(){
    showToast("检查中…");
    apiGet("/check-update").then(function(res){
      if (!res || !res.success) {
        showToast("检查失败：" + ((res && res.error) || "网络不可达"), "err");
        return;
      }
      if (res.hasUpdate) {
        showToast("发现新版本 v" + res.latest + "！去仓库看看", "warn");
        setTimeout(function(){
          var opened = null;
          try { opened = window.open(res.repoUrl || "", "_blank"); } catch (e) {}
          if (!opened && res.repoUrl) {
            try { navigator.clipboard.writeText(res.repoUrl); } catch (e) {}
            showToast("已复制仓库链接", "warn");
          }
        }, 1600);
      } else {
        showToast("已是最新版本 v" + (res.current || ""), false);
      }
    }).catch(function(err){
      showToast("检查失败：" + err.message, "err");
    });
  });

  // ── 反馈（GitHub Issues，弹窗被拦时降级复制链接） ──
  var fbBtn = $("dgh-feedback");
  if (fbBtn) fbBtn.addEventListener("click", function(){
    var issueUrl = "https://github.com/moononnn/hanako-jieyuhua/issues";
    var opened = null;
    try { opened = window.open(issueUrl, "_blank"); } catch (e) {}
    if (!opened) {
      try { navigator.clipboard.writeText(issueUrl); } catch (e) {}
      showToast("已复制反馈链接，粘贴到浏览器打开即可");
    }
  });

  // ── 新用户指引：点「知道了」后隐藏，不再打扰 ──
  var guideClose = $("dgh-guide-close");
  if (guideClose) guideClose.addEventListener("click", function(){
    var g = $("dgh-guide");
    if (g) g.hidden = true;
    apiPost("/config", { guideDismissed: true });
  });

  // ── 恢复默认方向（一键回出厂） ──
  var resetBtn = $("dgh-reset-styles");
  if (resetBtn) resetBtn.addEventListener("click", function(){
    apiPost("/reset-styles", {}).then(function(res){
      if (res && res.ok && Array.isArray(res.styles)) {
        // 刷新按钮文字 + 本地状态
        for (var i = 0; i < res.styles.length; i++) {
          if (styleBtns[i]) styleBtns[i].textContent = res.styles[i].name;
          STATE.styles[i] = res.styles[i];
        }
        showToast("已恢复默认方向", false);
      } else {
        showToast(((res && res.error) || "恢复失败"), "err");
      }
    }).catch(function(err){
      showToast("恢复失败：" + err.message, "err");
    });
  });

  // ── 和小花聊一聊（精简版：只调方向） ──
  var chatSid = "";
  var lastSuggestion = null;

  function appendChatMsg(role, text) {
    var box = $("dgh-chat-msgs");
    if (!box) return;
    var b = document.createElement("div");
    b.className = "dgh-bubble " + (role === "user" ? "user" : "assistant");
    b.textContent = text;
    box.appendChild(b);
    box.scrollTop = box.scrollHeight;
  }

  function closeChat() {
    $("dgh-chat").hidden = true;
    $("dgh-chat-msgs").innerHTML = "";
    $("dgh-chat-sug").hidden = true;
    $("dgh-chat-sug").innerHTML = "";
    chatSid = "";
    lastSuggestion = null;
    $("dgh-chat-open").hidden = false;
  }

  function sendChat() {
    var input = $("dgh-chat-input");
    var msg = input.value.trim();
    if (!msg) return;
    input.value = "";
    appendChatMsg("user", msg);

    // 等待提示：思考气泡 + 发送按钮禁用（防重复提交，也告诉用户在等）
    var box = $("dgh-chat-msgs");
    var think = document.createElement("div");
    think.className = "dgh-bubble assistant dgh-bubble-think";
    think.textContent = "小花正在想";
    if (box) { box.appendChild(think); box.scrollTop = box.scrollHeight; }
    var sendBtn = $("dgh-chat-send");
    if (sendBtn) sendBtn.disabled = true;
    if (input) input.disabled = true;

    function finish() {
      if (think && think.parentNode) think.parentNode.removeChild(think);
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.disabled = false;
      $("dgh-chat-input").focus();
    }

    apiPost("/chat", { message: msg, session_id: chatSid }).then(function(res){
      finish();
      if (res && res.ok) {
        chatSid = res.session_id;
        appendChatMsg("assistant", res.reply || "嗯嗯，你说～");
        if (res.suggestion && res.suggestion.length) {
          showSuggestion(res.suggestion);
        }
      } else {
        appendChatMsg("assistant", "（" + ((res && res.error) || "出错了") + "）");
      }
    }).catch(function(err){
      finish();
      appendChatMsg("assistant", "（聊一聊出错了：" + err.message + "）");
    });
  }

  function showSuggestion(suggestions) {
    lastSuggestion = suggestions;
    var box = $("dgh-chat-sug");
    var html = '<div class="dgh-sug-title">✨ 小花建议这样改</div>';
    for (var i = 0; i < suggestions.length; i++) {
      var s = suggestions[i];
      var old = STATE.styles[s.index];
      var oldName = (old && (typeof old === "object" ? old.name : old)) || ("方向" + (s.index + 1));
      var oldIntent = (old && typeof old === "object" && old.intent) ? old.intent : "（旧意图未填写）";
      var newIntent = s.intent || "（新意图未填写）";
      html += '<div class="dgh-change">'
        + '<div class="dgh-change-old">第' + (s.index + 1) + '个 · ' + escHtml(oldName) + ' · ' + escHtml(oldIntent) + '</div>'
        + '<div class="dgh-change-new">→ ' + escHtml(s.name) + ' · ' + escHtml(newIntent) + '</div>'
        + '</div>';
    }
    html += '<div class="dgh-row" style="margin-top:10px">'
      + '<button class="dgh-btn" id="dgh-apply-btn" type="button">应用修改</button>'
      + '<button class="dgh-btn ghost" id="dgh-again-btn" type="button">再看看</button>'
      + '</div>';
    box.innerHTML = html;
    box.hidden = false;
    $("dgh-apply-btn").addEventListener("click", function(){
      applySuggestion(lastSuggestion);
    });
    $("dgh-again-btn").addEventListener("click", function(){
      box.hidden = true;
      box.innerHTML = "";
    });
  }

  function applySuggestion(suggestions) {
    apiPost("/apply-suggestion", { suggestions: suggestions }).then(function(res){
      if (res && res.ok) {
        // 更新按钮文字 + 本地 state
        for (var i = 0; i < suggestions.length; i++) {
          var s = suggestions[i];
          if (styleBtns[s.index]) styleBtns[s.index].textContent = s.name;
          STATE.styles[s.index] = s.name;
        }
        appendChatMsg("assistant", "改好啦！");
        closeChat();
        showToast("方向已更新", false);
      } else {
        appendChatMsg("assistant", "（应用失败：" + ((res && res.error) || "未知") + "）");
      }
    }).catch(function(err){
      appendChatMsg("assistant", "（应用失败：" + err.message + "）");
    });
  }

  $("dgh-chat-open").addEventListener("click", function(){
    $("dgh-chat-open").hidden = true;
    $("dgh-chat").hidden = false;
    appendChatMsg("assistant", "你好呀，我是小花～哪个方向想改？想改成什么样？跟我说说～");
    $("dgh-chat-input").focus();
  });
  $("dgh-chat-close").addEventListener("click", closeChat);
  $("dgh-chat-send").addEventListener("click", sendChat);
  $("dgh-chat-input").addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
})();`;
}

// ════════════════════════════════════════════
//  转义
// ════════════════════════════════════════════
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return escapeAttr(value).replace(/>/g, "&gt;");
}
