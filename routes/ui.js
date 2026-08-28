// 文件预算豁免：服务端渲染的设置页与推荐页共用一份 HTML/CSS/JS 模板，拆分会增加转义与路由漂移风险。
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
import { maskKey, getStorageMode } from "../lib/crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function htmlNoStore(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
}

export default function registerPluginUiRoutes(app, ctx) {
  const dataDir = ctx.dataDir;

  // ─── 推荐卡片页 ───
  app.get("/suggest", (c) => htmlNoStore(renderSuggestPage(c, ctx, dataDir)));

  // ─── 设置页 ───
  app.get("/settings", (c) => htmlNoStore(renderSettingsPage(c, ctx, dataDir)));
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
  /* 滚动条统一：细薄荷圆条（2026-08-26，明暗主题通用，与全部插件同一规范） */
  *::-webkit-scrollbar{width:8px;height:8px}
  *::-webkit-scrollbar-track{background:transparent}
  *::-webkit-scrollbar-thumb{background:#c9dfd3;border-radius:99px;border:2px solid var(--dgh-bg)}
  *::-webkit-scrollbar-thumb:hover{background:var(--dgh-accent)}
  *{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}
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
  /* Key 就地提示（2026-08-19 分享版）：粘进 sk-cp- 订阅 Key 马上提醒，不等点试听 */
  .dgh-key-tip {
    font-size: 11px; line-height: 1.5; margin-top: 4px;
    border-radius: 8px; padding: 4px 8px;
    background: #fdf3df; color: #8a6d1c;
  }
  .dgh-key-tip.ok {
    background: var(--dgh-accent-light); color: var(--dgh-ok);
  }
  /* 我的收藏：朗读收藏条（手帐卡） */
  .dgh-fav-item {
    background: var(--dgh-paper); border: 1px dashed var(--dgh-rule);
    border-radius: 12px; padding: 6px 9px; margin-top: 6px;
  }
  .dgh-fav-text { font-size: 12px; color: var(--dgh-ink); line-height: 1.5; word-break: break-all; }
  .dgh-fav-meta { font-size: 10px; color: var(--dgh-sub); margin-top: 2px; }
  .dgh-fav-actions { margin-top: 5px; display: flex; gap: 6px; }
  /* 语音收藏弹窗：按助手分组 */
  .dgh-fav-groups { margin-top: 10px; max-height: 46vh; overflow-y: auto; padding-right: 2px; }
  .dgh-fav-group { margin-bottom: 12px; }
  .dgh-fav-group-title { font-size: 13px; font-weight: 700; color: var(--dgh-ink); margin-bottom: 4px; }
  .dgh-fav-group-count { font-size: 11px; color: var(--dgh-sub); font-weight: 400; margin-left: 6px; }
  .dgh-fav-group-empty { font-size: 12px; color: var(--dgh-sub); padding: 10px 2px; line-height: 1.6; }
  body[data-hana-theme="midnight"] .dgh-key-tip,
  body[data-hana-theme="midnight-contrast"] .dgh-key-tip {
    background: rgba(240, 200, 120, 0.12); color: #e8c878;
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
  const modelKeyMode = getStorageMode(custom.apiKey);
  const apiKeyMasked = maskKey(custom.apiKey);
  const tts = cfg.tts || {};
  const ttsKeyMode = getStorageMode(tts.apiKey);
  const ttsKeyStatus = ttsKeyMode === "dpapi"
    ? "系统加密保存"
    : ttsKeyMode === "legacy"
      ? "旧版保护，保存后自动升级"
      : ttsKeyMode === "plain"
        ? "明文保存（仅作兼容兜底）"
        : "";

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
    customKeyMode: modelKeyMode,
    customModel: escapeAttr(custom.model || ""),
    customApi: custom.api || "openai-completions",
    tts: {
      enabled: !!(cfg.tts && cfg.tts.enabled),
      source: (cfg.tts && cfg.tts.source) || "auto",
      providerId: escapeAttr((cfg.tts && cfg.tts.providerId) || ""),
      model: escapeAttr((cfg.tts && cfg.tts.model) || ""),
      protocol: (cfg.tts && cfg.tts.protocol) === "t2a" ? "t2a" : "chat",
      groupId: escapeAttr((cfg.tts && cfg.tts.groupId) || ""),
      baseUrl: escapeAttr((cfg.tts && cfg.tts.baseUrl) || ""),
      voiceId: escapeAttr((cfg.tts && cfg.tts.voiceId) || ""),
      voiceByAgent: (cfg.tts && cfg.tts.voiceByAgent) || {},
      speed: String((cfg.tts && cfg.tts.speed) || 1),
      vol: String((cfg.tts && cfg.tts.vol) || 1),
      pitch: String((cfg.tts && cfg.tts.pitch) || 0),
      scope: (cfg.tts && cfg.tts.scope) === "quoted" ? "quoted" : "whole",
      maxLen: String((cfg.tts && cfg.tts.maxLen) || 800),
      apiKeyMasked: maskKey(cfg.tts && cfg.tts.apiKey),
      apiKeyMode: ttsKeyMode,
      apiKeyHint: ttsKeyStatus
    }
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
  /* 滚动条统一：细薄荷圆条（2026-08-26，与全部插件同一规范） */
  *::-webkit-scrollbar{width:8px;height:8px}
  *::-webkit-scrollbar-track{background:transparent}
  *::-webkit-scrollbar-thumb{background:#c9dfd3;border-radius:99px;border:2px solid var(--dgh-bg)}
  *::-webkit-scrollbar-thumb:hover{background:var(--dgh-accent)}
  *{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}
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
  /* 语音收藏弹窗：按助手分组（2026-08-23 手帐化） */
  #dgh-fav-modal .dgh-modal-box { border: none; box-shadow: 0 12px 40px rgba(45, 58, 53, .18); }
  .dgh-fav-groups { margin-top: 8px; max-height: 46vh; overflow-y: auto; padding-right: 2px; }
  .dgh-fav-group { margin-bottom: 14px; }
  .dgh-fav-group-head { display: flex; align-items: center; gap: 8px; }
  .dgh-fav-avatar {
    width: 24px; height: 24px; border-radius: 999px; flex-shrink: 0;
    background: var(--dgh-accent-light); color: var(--dgh-accent-deep);
    border: 1px solid var(--dgh-accent);
    font-size: 12px; font-weight: 700;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .dgh-fav-group.other .dgh-fav-avatar {
    background: var(--dgh-pink-light); color: var(--dgh-pink);
    border-color: var(--dgh-pink);
  }
  .dgh-fav-group-title { font-size: 13px; font-weight: 700; color: var(--dgh-ink); }
  .dgh-fav-group-count {
    font-size: 10px; color: var(--dgh-accent-deep); background: var(--dgh-accent-light);
    border-radius: 999px; padding: 1px 8px;
  }
  .dgh-fav-group.other .dgh-fav-group-count { color: var(--dgh-pink); background: var(--dgh-pink-light); }
  .dgh-fav-group-note { font-size: 10px; color: var(--dgh-sub); margin: 3px 0 0 32px; line-height: 1.5; }
  .dgh-fav-group-empty { font-size: 12px; color: var(--dgh-sub); padding: 14px 4px; line-height: 1.7; text-align: center; }
  /* 收藏条目：手帐卡，结构分隔用细实线 */
  .dgh-fav-item {
    background: var(--dgh-paper);
    border: 1px solid var(--dgh-rule);
    border-radius: 14px; padding: 8px 11px; margin-top: 8px;
    box-shadow: 0 2px 8px rgba(74, 146, 119, .06);
    transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease;
  }
  .dgh-fav-item:hover {
    border-color: var(--dgh-accent);
    box-shadow: 0 4px 12px rgba(74, 146, 119, .12);
    transform: translateY(-1px);
  }
  .dgh-fav-text { font-size: 12px; color: var(--dgh-ink); line-height: 1.55; word-break: break-all; }
  .dgh-fav-meta { font-size: 10px; color: var(--dgh-sub); margin-top: 4px; }
  .dgh-fav-actions { margin-top: 7px; display: flex; gap: 8px; }
  .dgh-fav-btn {
    font-family: inherit; font-size: 11px; line-height: 1;
    border-radius: 999px; padding: 5px 12px; cursor: pointer;
    transition: all .15s ease;
  }
  .dgh-fav-btn.play {
    color: var(--dgh-accent-deep); background: var(--dgh-accent-light);
    border: 1px solid var(--dgh-accent);
  }
  .dgh-fav-btn.play:hover { background: var(--dgh-accent); color: #fff; }
  .dgh-fav-btn.del {
    color: var(--dgh-pink); background: transparent;
    border: 1px solid var(--dgh-pink);
  }
  .dgh-fav-btn.del:hover { background: var(--dgh-pink-light); }
  .dgh-fav-btn.del.confirm {
    background: var(--dgh-pink); border-color: var(--dgh-pink); color: #fff;
  }
  .dgh-fav-btn[disabled] { opacity: .55; cursor: default; }
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
  .dgh-tts-block {
    margin-top: 12px; padding: 10px;
    background: var(--dgh-bg);
    border: 1px dashed var(--dgh-rule);
    border-radius: 12px;
  }
  .dgh-tts-block-title { font-size: 13px; font-weight: 600; margin-bottom: 5px; }
  /* 助手专属配音：每行选音色 + 试听，清除通过“跟随模型默认音色”完成 */
  .dgh-tts-agent-list {
    display: flex; flex-direction: column; gap: 6px;
    max-height: 260px; overflow-y: auto; margin-top: 8px;
    padding-right: 2px;
  }
  .dgh-tts-agent-row {
    display: grid; grid-template-columns: minmax(76px, .7fr) minmax(150px, 1.3fr) auto;
    gap: 6px; align-items: start;
    padding: 7px 8px;
    background: var(--dgh-paper);
    border: 1px dashed var(--dgh-rule);
    border-radius: 10px;
  }
  .dgh-tts-agent-name { font-size: 13px; line-height: 30px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dgh-tts-agent-control { min-width: 0; }
  .dgh-tts-agent-select { min-width: 0; }
  .dgh-tts-agent-custom { margin-top: 5px; }
  .dgh-tts-agent-action { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .dgh-tts-agent-test { padding: 6px 10px; white-space: nowrap; }
  .dgh-tts-agent-status { max-width: 92px; font-size: 10px; color: var(--dgh-sub); text-align: right; }
  .dgh-tts-agent-empty { font-size: 12px; color: var(--dgh-sub); padding: 8px 2px; }
  @media (max-width: 430px) {
    .dgh-tts-agent-row { grid-template-columns: 1fr auto; }
    .dgh-tts-agent-control { grid-column: 1 / -1; grid-row: 2; }
    .dgh-tts-agent-action { grid-column: 2; grid-row: 1; }
  }
</style>
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="page">
  <div class="dgh-topbar">
    <h1>解语花</h1>
    <span class="dgh-ver">v${escapeHtml(version)}</span>
    <span class="spacer"></span>
    <button class="dgh-top-btn" id="dgh-model-open" type="button" title="生成推荐的模型配置">模型设置</button>
    <button class="dgh-top-btn" id="dgh-tts-open" type="button" title="把回复朗读出来">语音朗读</button>
    <button class="dgh-top-btn" id="dgh-fav-open" type="button" title="听收藏过的语音">语音收藏</button>
    <button class="dgh-top-btn" id="dgh-update" type="button" title="检查 GitHub 上的新版本">检查更新</button>
    <button class="dgh-top-btn" id="dgh-feedback" type="button" title="遇到 bug 或有建议，来 GitHub 提 issue">反馈</button>
  </div>
  <div class="dgh-sub">小花回复完之后，帮你想几句接得上的话</div>

  ${cfg.guideDismissed ? "" : `
  <div class="dgh-guide" id="dgh-guide">
    <div class="dgh-guide-title">第一次用解语花？</div>
    <div class="dgh-guide-body">聊天时小花回复下方会出现一张小卡片，上面是几条你可能想说的话，点一下复制（或直接发送），不用自己打字。默认已经开了，直接去聊就行。<br>生成推荐需要一个模型，默认已跟随当前聊天框的小花模型，不用额外配置。想换模型或单独配一个更省钱的，点右上角「模型设置」。</div>
    <div class="dgh-row">
      <button class="dgh-btn ghost" id="dgh-guide-close" type="button">知道了</button>
    </div>
  </div>`}

  <div class="dgh-card">
    <div class="dgh-card-title">展示方式</div>
    ${radio("presentation", "card", cfg.presentation !== "ball" && cfg.presentation !== "off", "回复卡片", "小花回复后，推荐卡片出现在回复下方（原来的方式）")}
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

  <div class="dgh-card${cfg.presentation !== "ball" && cfg.presentation !== "off" ? "" : " dgh-hidden"}" id="dgh-mode-card">
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
          <input class="dgh-input" id="dgh-custom-key" type="password" placeholder="${apiKeyMasked ? "留空 = 用已保存的 Key；换 Key 直接贴新的" : "sk-..."}" value="">
          <div class="dgh-sub">${apiKeyMasked ? `已保存（${escapeHtml(modelKeyMode === "dpapi" ? "系统加密" : modelKeyMode === "legacy" ? "旧版保护" : "明文兼容保存")}），留空不会覆盖` : "Key 只保存在本机插件数据里"}</div>
          <button class="dgh-btn ghost" id="dgh-custom-key-clear" type="button" style="margin-top:6px"${apiKeyMasked ? "" : " disabled"}>清除已保存的 Key</button>
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

  <!-- 语音朗读设置弹窗 -->
  <div class="dgh-modal-overlay dgh-hidden" id="dgh-tts-modal">
    <div class="dgh-modal-box">
      <div class="dgh-modal-head">
        <h2>语音朗读</h2>
        <button class="dgh-modal-close" id="dgh-tts-modal-close" type="button">✕</button>
      </div>
      <div class="dgh-modal-body">
        <div class="dgh-sub">打开后，悬浮球面板会出现「念给我听」按钮，点一下就把当前助手最近一条回复用语音读出来。</div>
        ${radio("tts_enabled", "on", tts.enabled, "开启语音朗读", "悬浮球面板显示「念给我听」按钮")}
        ${radio("tts_enabled", "off", !tts.enabled, "关闭", "不显示按钮，不花语音额度")}

        <div class="dgh-tts-block" style="margin-top:10px">
          <div class="dgh-tts-block-title">语音模型</div>
          <div class="dgh-sub">先在这里配好模型，下面再给每位助手选音色和试听。</div>
          ${radio("tts_source", "auto", tts.source !== "hana" && tts.source !== "custom", "自动", "自动用 Hana 里已配置的语音合成模型，不用配任何东西")}
          ${radio("tts_source", "hana", tts.source === "hana", "手动选", "从 Hana 已配置的语音模型里挑一个")}
          ${radio("tts_source", "custom", tts.source === "custom", "自定义", "自己填接口，支持 MiniMax 和 OpenAI 兼容聊天（如 MiMo）")}

        <div class="dgh-field dgh-hidden" id="dgh-tts-auto-box">
          <div class="dgh-sub" id="dgh-tts-auto-info">正在查找 Hana 里的语音模型…</div>
        </div>

        <div class="dgh-field dgh-hidden" id="dgh-tts-hana-box">
          <label for="dgh-tts-candidate">语音模型</label>
          <select class="dgh-select" id="dgh-tts-candidate"><option value="">（加载中…）</option></select>
          <div class="dgh-sub">Hana 里没有合适的？去 Hana 的模型设置加一个 TTS 模型（名字带 tts/speech），或选自定义</div>
        </div>

        <div class="dgh-field dgh-hidden" id="dgh-tts-custom-box">
          <label for="dgh-tts-protocol">接口类型</label>
          <select class="dgh-select" id="dgh-tts-protocol">
            <option value="t2a"${tts.protocol === "t2a" ? " selected" : ""}>MiniMax（t2a_v2）</option>
            <option value="chat"${tts.protocol === "chat" ? " selected" : ""}>OpenAI 兼容聊天（MiMo 等）</option>
          </select>
          <div id="dgh-tts-t2a-fields">
            <label for="dgh-tts-key" style="margin-top:8px">API Key <span class="dgh-hint">（留空 = 用已保存的）</span></label>
            <input class="dgh-input" id="dgh-tts-key" type="password" placeholder="${ttsKeyStatus ? "留空 = 用已保存的 Key；换 Key 直接贴新的" : "粘贴 sk-api- 或 sk-cp- 开头的 Key（开放平台「接口密钥」页）"}" value="" autocomplete="off">
            <div class="dgh-sub">${ttsKeyStatus ? `已保存（${escapeHtml(ttsKeyStatus)}），去助手配音里试听就行。` : "两种 Key 都能用：sk-api- 开头 API Key 按量计费；sk-cp- 开头订阅 Key 走订阅套餐额度（不扣 API 余额）"}</div>
            <button class="dgh-btn ghost" id="dgh-tts-key-clear" type="button" style="margin-top:6px"${tts.apiKey ? "" : " disabled"}>清除已保存的 Key</button>
            <div class="dgh-key-tip dgh-hidden" id="dgh-tts-key-warn"></div>
            <label for="dgh-tts-group" style="margin-top:8px">GroupId（必填）</label>
            <input class="dgh-input" id="dgh-tts-group" placeholder="MiniMax 控制台里的团队 ID" value="${tts.groupId}">
          </div>
          <div id="dgh-tts-chat-fields" class="dgh-hidden">
            <label for="dgh-tts-key2" style="margin-top:8px">API Key <span class="dgh-hint">（留空 = 用已保存的）</span></label>
            <input class="dgh-input" id="dgh-tts-key2" type="password" placeholder="${ttsKeyStatus ? "留空 = 用已保存的 Key；换 Key 直接贴新的" : "粘贴该语音模型的 API Key"}" value="" autocomplete="off">
            <div class="dgh-sub">${ttsKeyStatus ? `已保存（${escapeHtml(ttsKeyStatus)}），去助手配音里试听就行` : "填该语音模型的 API Key（各家前缀没统一格式，填你实际的）"}</div>
            <button class="dgh-btn ghost" id="dgh-tts-key2-clear" type="button" style="margin-top:6px"${tts.apiKey ? "" : " disabled"}>清除已保存的 Key</button>
            <label for="dgh-tts-custom-model" style="margin-top:8px">模型名</label>
            <input class="dgh-input" id="dgh-tts-custom-model" placeholder="例如 mimo-v2.5-tts" value="${tts.model}">
          </div>
          <label for="dgh-tts-url" style="margin-top:8px">接口地址（可留空）</label>
          <input class="dgh-input" id="dgh-tts-url" placeholder="MiniMax 留空用 https://api.minimaxi.com" value="${tts.baseUrl}">
        </div>

        </div>

        <div class="dgh-tts-block">
          <div class="dgh-tts-block-title">助手配音</div>
          <div class="dgh-sub">先保存上面的模型；刷新后，每位助手都能单独选音色和试听。选“跟随模型默认音色”就不设置专属音色。</div>
          <div class="dgh-row" style="margin-top:7px">
            <button class="dgh-btn ghost" id="dgh-tts-refresh-agents" type="button">刷新模型和音色</button>
            <span class="dgh-hint" id="dgh-tts-agent-status"></span>
          </div>
          <div class="dgh-tts-agent-list" id="dgh-tts-agent-list">
            <div class="dgh-tts-agent-empty">打开这里时会读取 Hana 里的助手和音色…</div>
          </div>
        </div>

        <div class="dgh-tts-block">
          <div class="dgh-tts-block-title">朗读偏好</div>
          <label for="dgh-tts-speed">语速</label>
          <select class="dgh-select" id="dgh-tts-speed"></select>
          <div class="dgh-sub" style="margin-top:10px">朗读内容</div>
          ${radio("tts_scope", "whole", tts.scope === "whole", "整条回复", "把回复全文念出来")}
          ${radio("tts_scope", "quoted", tts.scope === "quoted", "只读引号里的内容", "只念「」『』“”里的台词，适合角色扮演；没有引号时读整条")}
          <div class="dgh-field dgh-hidden" id="dgh-tts-fav-box" style="margin-top:10px">
            <div class="dgh-sub" style="margin-top:10px">我的收藏 <span class="dgh-hint">（悬浮球朗读时点「♡ 收藏」存入；播放直接用存好的音频，不重新合成）</span></div>
            <div id="dgh-tts-fav-list"></div>
          </div>
        </div>
      </div>
      <div class="dgh-modal-foot">
        <button class="dgh-btn ghost" id="dgh-tts-test-model" type="button">测试模型连接</button>
        <button class="dgh-btn" id="dgh-tts-save" type="button">保存设置</button>
        <div class="dgh-msg" id="dgh-tts-msg"></div>
      </div>
    </div>
  </div>

  <!-- 语音收藏弹窗 -->
  <div class="dgh-modal-overlay dgh-hidden" id="dgh-fav-modal">
    <div class="dgh-modal-box">
      <div class="dgh-modal-head">
        <h2>语音收藏</h2>
        <button class="dgh-modal-close" id="dgh-fav-modal-close" type="button">✕</button>
      </div>
      <div class="dgh-modal-body">
        <div class="dgh-sub">朗读时点「♡ 收藏」的语音都在这里，按助手分好了类。播放直接用存好的音频，不重新合成。</div>
        <div class="dgh-fav-groups" id="dgh-fav-groups"></div>
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
  var PARAMS = new URLSearchParams(location.search);
  var TOKEN = PARAMS.get("token") || "";
  var SURFACE_SESSION = PARAMS.get("pluginSurfaceSession") || "";
  var HOST_ORIGIN = PARAMS.get("hana-host-origin") || "*";

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

  function surfaceHeaders() {
    var headers = {};
    if (SURFACE_SESSION) headers["X-Hana-Plugin-Surface-Session"] = SURFACE_SESSION;
    return headers;
  }

  function apiGet(p) {
    return fetch(apiUrl(p), { credentials: "same-origin", headers: surfaceHeaders() }).then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function apiPost(p, body) {
    return fetch(apiUrl(p), {
      method: "POST",
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, surfaceHeaders()),
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
  const safeState = JSON.stringify(state)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `(function(){
  var API = ${JSON.stringify(apiBase)};
  var STATE = ${safeState};
  var PARAMS = new URLSearchParams(location.search);
  var TOKEN = PARAMS.get("token") || "";
  var SURFACE_SESSION = PARAMS.get("pluginSurfaceSession") || "";

  window.parent.postMessage({ protocol: "hana.plugin.ui", version: 1, kind: "event", type: "hana.ready" }, "*");

  function apiUrl(p) {
    var u = new URL(API + p, location.origin);
    if (TOKEN) u.searchParams.set("token", TOKEN);
    return u.pathname + u.search;
  }

  function surfaceHeaders() {
    var headers = {};
    if (SURFACE_SESSION) headers["X-Hana-Plugin-Surface-Session"] = SURFACE_SESSION;
    return headers;
  }

  function apiGet(p) {
    return fetch(apiUrl(p), { credentials: "same-origin", headers: surfaceHeaders() }).then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function apiPost(p, body) {
    return fetch(apiUrl(p), {
      method: "POST",
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, surfaceHeaders()),
      body: JSON.stringify(body || {})
    }).then(function(r){
      return r.json().catch(function(){ return null; }).then(function(j){
        if (!r.ok) {
          // 后端错误详情优先（如 key 格式校验提示），避免只显示裸 HTTP 状态码
          var err = new Error((j && j.error) || ("HTTP " + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
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

  // 「什么时候出推荐」只对回复卡片有效：选了解语花/关闭就藏起来
  function syncModeCard() {
    var card = $("dgh-mode-card");
    if (!card) return;
    var isCard = radioValue("presentation") === "card";
    card.classList.toggle("dgh-hidden", !isCard);
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
      syncModeCard();
    });
  });
  var ballAct = $("dgh-ball-activate");
  if (ballAct) ballAct.addEventListener("click", function(){
    apiPost("/ball/start", {}).then(function(res){
      if (res && res.ok) showToast("解语花已激活");
      else showToast(((res && res.error) || "解语花启动失败"), "err");
      refreshBallStatus();
    }).catch(function(){ showToast("解语花启动失败", "err"); refreshBallStatus(); });
  });
  var ballStop = $("dgh-ball-stop");
  if (ballStop) ballStop.addEventListener("click", function(){
    apiPost("/ball/stop", {}).then(function(){
      showToast("解语花已停止");
      refreshBallStatus();
    }).catch(function(){ showToast("停止失败", "err"); refreshBallStatus(); });
  });
  syncBallBox();
  syncModeCard();

  // ─── 打开插件页面自动启动解语花（半自动：仅解语花模式；手动关过则本次不再弹）───
  function autoBootZhujian() {
    if (radioValue("presentation") !== "ball") return; // 回复卡片/关闭模式不自动启动
    apiGet("/ball/autoboot").then(function(st){
      if (!st || !st.ok) return;
      if (st.running) return; // 已经在跑不重复启动
      if (st.dismissed) return; // 上次手动关过：本次打开页面不弹
      if (!st.pyQtOk) {
        showToast("解语花需要 Python + PyQt6，当前环境还不能加载它", "err");
        return;
      }
      apiPost("/ball/start", {}).then(function(res){
        if (res && res.ok) showToast("解语花已飘出");
        else if (res && res.fusion) { /* 融合球在跑：不打扰，静默 */ }
        else showToast(((res && res.error) || "解语花启动失败"), "err");
        refreshBallStatus();
      }).catch(function(){ showToast("解语花启动失败", "err"); refreshBallStatus(); });
    }).catch(function(){ /* 查询失败不打扰 */ });
  }
  autoBootZhujian();

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
  var clearCustomKeyRequested = false;
  var customKeyInput = $("dgh-custom-key");
  if (customKeyInput) customKeyInput.addEventListener("input", function(){ clearCustomKeyRequested = false; });
  var customKeyClear = $("dgh-custom-key-clear");
  if (customKeyClear) customKeyClear.addEventListener("click", function(){
    clearCustomKeyRequested = true;
    if (customKeyInput) customKeyInput.value = "";
    customKeyClear.disabled = true;
    setMsg("已标记清除，点击保存后生效", false);
  });
  $("dgh-save").addEventListener("click", function(){
    var body = {
      model: {
        source: radioValue("source") || "agent",
        providerId: $("dgh-provider") ? $("dgh-provider").value : "",
        modelId: $("dgh-model") ? $("dgh-model").value : "",
        custom: {
          baseUrl: $("dgh-custom-url") ? $("dgh-custom-url").value.trim() : "",
          apiKey: $("dgh-custom-key") ? $("dgh-custom-key").value : "",
          clearApiKey: clearCustomKeyRequested,
          model: $("dgh-custom-model") ? $("dgh-custom-model").value.trim() : ""
        }
      }
    };
    setMsg("保存中…");
    apiPost("/config", body).then(function(res){
      if (res && res.ok) {
        setMsg("已保存", true);
        if (body.model.custom.apiKey && body.model.custom.apiKey !== "********") {
          $("dgh-custom-key").value = "";
        }
        clearCustomKeyRequested = false;
        if (customKeyClear) customKeyClear.disabled = true;
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

  // ── 语音朗读弹窗（三档来源：自动 / 手动选 / 自定义） ──
  function ttsRadio(name) { return radioValue("tts_" + name); }
  function ttsProtocol() {
    var sel = $("dgh-tts-protocol");
    return sel && sel.value === "t2a" ? "t2a" : "chat";
  }
  function syncTtsSourceBoxes(loadVoices) {
    var src = ttsRadio("source") || "auto";
    var autoBox = $("dgh-tts-auto-box");
    var hanaBox = $("dgh-tts-hana-box");
    var customBox = $("dgh-tts-custom-box");
    if (autoBox) autoBox.classList.toggle("dgh-hidden", src !== "auto");
    if (hanaBox) hanaBox.classList.toggle("dgh-hidden", src !== "hana");
    if (customBox) customBox.classList.toggle("dgh-hidden", src !== "custom");
    if (src === "custom") {
      syncTtsProtocolFields(loadVoices);
      return;
    }
    if (loadVoices !== false) loadTtsVoices(ttsVoiceProtocol()).catch(function(){});
  }
  function syncTtsProtocolFields(loadVoices) {
    var proto = ttsProtocol();
    var t2aFields = $("dgh-tts-t2a-fields");
    var chatFields = $("dgh-tts-chat-fields");
    if (t2aFields) t2aFields.classList.toggle("dgh-hidden", proto !== "t2a");
    if (chatFields) chatFields.classList.toggle("dgh-hidden", proto !== "chat");
    if (loadVoices !== false) loadTtsVoices(proto).catch(function(){});
  }
  var ttsAgents = [];
  var ttsVoices = [];
  var ttsVoicesProtocol = "";
  var ttsVoiceSeq = 0;
  var ttsAgentsSeq = 0;
  function setTtsAgentListEnabled(enabled) {
    var box = $("dgh-tts-agent-list");
    if (!box) return;
    var controls = box.querySelectorAll("select, input, button");
    for (var i = 0; i < controls.length; i++) controls[i].disabled = !enabled;
  }
  function ttsVoiceProtocol() {
    return ttsRadio("source") === "custom" ? ttsProtocol() : "chat";
  }
  function loadTtsVoices(proto) {
    var protocol = proto === "t2a" ? "t2a" : "chat";
    var requestSeq = ++ttsVoiceSeq;
    var status = $("dgh-tts-agent-status");
    if (status) status.textContent = "读取音色中…";
    setTtsAgentListEnabled(false);
    return apiGet("/tts/voices?protocol=" + encodeURIComponent(protocol)).then(function(res){
      if (requestSeq !== ttsVoiceSeq) return { stale: true, voices: [] };
      if (!res || !res.ok) throw new Error((res && res.error) || "读取音色列表失败");
      ttsVoices = Array.isArray(res.voices) ? res.voices : [];
      ttsVoicesProtocol = protocol;
      if (ttsAgents.length) renderTtsAgentVoices(ttsAgents, ttsVoices);
      return { stale: false, voices: ttsVoices };
    }).catch(function(err){
      if (requestSeq !== ttsVoiceSeq) return { stale: true, voices: [] };
      if (status) status.textContent = "音色列表读取失败";
      setTtsAgentListEnabled(false);
      throw err;
    });
  }
  function agentVoiceOptions(current, voices) {
    var known = !current;
    var html = '<option value=""' + (!current ? " selected" : "") + '>跟随模型默认音色</option>';
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      if (!v || !v.id) continue;
      if (v.id === current) known = true;
      html += '<option value="' + escHtml(v.id) + '"' + (v.id === current ? " selected" : "") + '>' + escHtml(v.name || v.id) + "</option>";
    }
    html += '<option value="__custom__"' + (current && !known ? " selected" : "") + '>自定义…</option>';
    return { html: html, custom: !!current && !known };
  }
  function renderTtsAgentVoices(agents, voices) {
    var box = $("dgh-tts-agent-list");
    if (!box) return;
    var list = Array.isArray(agents) ? agents : [];
    var voiceList = Array.isArray(voices) ? voices : [];
    if (!list.length) {
      box.innerHTML = '<div class="dgh-tts-agent-empty">还没有找到可配置的助手。</div>';
      setTtsAgentListEnabled(false);
      return;
    }
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var agent = list[i] || {};
      var agentId = String(agent.id || "");
      if (!agentId) continue;
      var current = typeof agent.voiceId === "string" ? agent.voiceId : "";
      var options = agentVoiceOptions(current, voiceList);
      html += '<div class="dgh-tts-agent-row" data-agent-id="' + escHtml(agentId) + '" data-saved-voice="' + escHtml(current) + '">'
        + '<div class="dgh-tts-agent-name" title="' + escHtml(agent.name || agentId) + '">' + escHtml(agent.name || agentId) + '</div>'
        + '<div class="dgh-tts-agent-control">'
        + '<select class="dgh-select dgh-tts-agent-select">' + options.html + '</select>'
        + '<input class="dgh-input dgh-tts-agent-custom' + (options.custom ? '' : ' dgh-hidden') + '" placeholder="自定义音色 id" value="' + (options.custom ? escHtml(current) : '') + '" autocomplete="off">'
        + '</div>'
        + '<div class="dgh-tts-agent-action">'
        + '<button class="dgh-btn ghost dgh-tts-agent-test" type="button">试听</button>'
        + '<span class="dgh-tts-agent-status"></span>'
        + '</div>'
        + '</div>';
    }
    box.innerHTML = html || '<div class="dgh-tts-agent-empty">还没有找到可配置的助手。</div>';

    box.querySelectorAll(".dgh-tts-agent-select").forEach(function(sel){
      sel.addEventListener("change", function(){
        var row = sel.closest(".dgh-tts-agent-row");
        if (!row) return;
        var custom = row.querySelector(".dgh-tts-agent-custom");
        if (sel.value === "__custom__") {
          if (custom) {
            custom.classList.remove("dgh-hidden");
            custom.focus();
          }
          return;
        }
        if (custom) custom.classList.add("dgh-hidden");
        saveTtsAgentVoice(row, sel.value || "");
      });
    });
    box.querySelectorAll(".dgh-tts-agent-custom").forEach(function(input){
      input.addEventListener("change", function(){ commitTtsAgentCustom(input); });
      input.addEventListener("blur", function(){ commitTtsAgentCustom(input); });
    });
    box.querySelectorAll(".dgh-tts-agent-test").forEach(function(btn){
      btn.addEventListener("click", function(){
        var row = btn.closest(".dgh-tts-agent-row");
        if (row) testTtsAgentVoice(row, btn);
      });
    });
    setTtsAgentListEnabled(true);
  }
  function commitTtsAgentCustom(input) {
    var row = input.closest(".dgh-tts-agent-row");
    if (!row) return;
    var sel = row.querySelector(".dgh-tts-agent-select");
    if (!sel || sel.value !== "__custom__") return;
    saveTtsAgentVoice(row, input.value.trim());
  }
  function ttsAgentVoiceId(row) {
    var sel = row && row.querySelector(".dgh-tts-agent-select");
    if (!sel) return "";
    if (sel.value === "__custom__") {
      var input = row.querySelector(".dgh-tts-agent-custom");
      return input ? input.value.trim() : "";
    }
    return sel.value || "";
  }
  function testTtsAgentVoice(row, btn) {
    var status = row.querySelector(".dgh-tts-agent-status");
    var body = ttsFormBody();
    body.voiceId = ttsAgentVoiceId(row);
    // 试听文案跟着助手名走（2026-08-20）：语音用当前助手的音色，文案也说这位助手的名字
    var nameEl = row.querySelector(".dgh-tts-agent-name");
    body.agentName = nameEl ? String(nameEl.textContent || "").trim() : "";
    var problem = ttsValidationMessage(body);
    if (problem) {
      if (status) status.textContent = problem;
      return;
    }
    btn.disabled = true;
    btn.textContent = "生成中…";
    if (status) status.textContent = "准备播放";
    apiPost("/tts/test", body).then(function(res){
      if (!res || !res.ok) throw new Error((res && res.error) || "试听失败");
      if (status) status.textContent = "正在播放";
      showToast((res && res.message) || "正在播放，听～");
    }).catch(function(err){
      if (status) status.textContent = "试听失败";
      showToast("试听失败：" + err.message, "err");
    }).finally(function(){
      btn.disabled = false;
      btn.textContent = "试听";
    });
  }
  function restoreTtsAgentRow(row, voiceId) {
    if (!row) return;
    var sel = row.querySelector(".dgh-tts-agent-select");
    var custom = row.querySelector(".dgh-tts-agent-custom");
    if (!sel) return;
    var known = !voiceId;
    for (var i = 0; i < sel.options.length; i++) {
      if (voiceId && sel.options[i].value === voiceId) { known = true; break; }
    }
    if (!voiceId || known) {
      sel.value = voiceId || "";
      if (custom) { custom.value = ""; custom.classList.add("dgh-hidden"); }
    } else {
      sel.value = "__custom__";
      if (custom) { custom.value = voiceId; custom.classList.remove("dgh-hidden"); }
    }
    row.setAttribute("data-saved-voice", voiceId || "");
  }
  function saveTtsAgentVoice(row, voiceId) {
    var agentId = row.getAttribute("data-agent-id") || "";
    if (!agentId) return;
    var oldValue = row.getAttribute("data-saved-voice") || "";
    if (oldValue === voiceId) return;
    var controls = row.querySelectorAll("select, input, button");
    for (var i = 0; i < controls.length; i++) controls[i].disabled = true;
    apiPost("/tts/agent-voice", { agentId: agentId, voiceId: voiceId }).then(function(res){
      if (!res || !res.ok) throw new Error((res && res.error) || "保存失败");
      row.setAttribute("data-saved-voice", voiceId);
      if (!voiceId) {
        var savedSel = row.querySelector(".dgh-tts-agent-select");
        var savedCustom = row.querySelector(".dgh-tts-agent-custom");
        if (savedSel) savedSel.value = "";
        if (savedCustom) { savedCustom.value = ""; savedCustom.classList.add("dgh-hidden"); }
      }
      STATE.tts.voiceByAgent = STATE.tts.voiceByAgent || {};
      if (voiceId) STATE.tts.voiceByAgent[agentId] = voiceId;
      else delete STATE.tts.voiceByAgent[agentId];
      for (var j = 0; j < ttsAgents.length; j++) {
        if (ttsAgents[j].id === agentId) ttsAgents[j].voiceId = voiceId;
      }
      showToast(voiceId ? "专属音色已保存" : "已回到默认音色");
    }).catch(function(err){
      restoreTtsAgentRow(row, oldValue);
      showToast("保存专属音色失败：" + err.message, "err");
      return loadTtsAgents();
    }).then(function(listReady){
      if (listReady === false) return;
      for (var k = 0; k < controls.length; k++) controls[k].disabled = false;
    });
  }
  function fillSpeedSelect() {
    var sel = $("dgh-tts-speed");
    if (!sel) return;
    var cur = (STATE.tts && STATE.tts.speed) || "1";
    var html = "";
    var v = 0.5;
    for (; v <= 2.001; v += 0.1) {
      var key = Math.round(v * 10) / 10;
      var label = key === 1 ? "1（正常）" : String(key);
      html += '<option value="' + key + '"' + (String(key) === String(cur) ? " selected" : "") + ">" + label + "</option>";
    }
    sel.innerHTML = html;
  }
  function loadTtsCandidates() {
    var candSel = $("dgh-tts-candidate");
    var autoInfo = $("dgh-tts-auto-info");
    apiGet("/tts/candidates").then(function(res){
      var list = (res && res.candidates) || [];
      var curProvider = (STATE.tts && STATE.tts.providerId) || "";
      var curModel = (STATE.tts && STATE.tts.model) || "";
      var known = false;
      var html = "";
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !c.model) continue;
        if (c.providerId === curProvider && c.model === curModel) known = true;
        html += '<option value="' + escHtml(c.providerId + "|" + c.model) + '"' + (c.available ? "" : " disabled") + ">" + escHtml(c.providerId + " / " + c.model) + (c.available ? "" : "（未配 Key）") + "</option>";
      }
      if (candSel) candSel.innerHTML = html ? html : '<option value="">（没有找到语音模型）</option>';
      if (known && candSel) candSel.value = curProvider + "|" + curModel;
      if (autoInfo) {
        if (list.length) {
          var first = list[0];
          autoInfo.textContent = "将自动使用：" + first.providerId + " / " + first.model + (first.available ? "" : "（这个还没配 Key，可能读不出来）");
        } else {
          autoInfo.textContent = "Hana 里没找到语音合成模型（名字带 tts/speech 的）。去 Hana 的模型设置加一个，或选自定义。";
        }
      }
    }).catch(function(){
      if (autoInfo) autoInfo.textContent = "读取模型列表失败，选自定义试试";
    });
  }
  function loadTtsAgents() {
    var status = $("dgh-tts-agent-status");
    var refresh = $("dgh-tts-refresh-agents");
    var requestSeq = ++ttsAgentsSeq;
    if (status) status.textContent = "读取中…";
    if (refresh) refresh.disabled = true;
    setTtsAgentListEnabled(false);
    return apiGet("/tts/agents").then(function(res){
      if (requestSeq !== ttsAgentsSeq) return { stale: true };
      if (!res || !res.ok) throw new Error((res && res.error) || "读取助手列表失败");
      ttsAgents = Array.isArray(res.agents) ? res.agents : [];
      STATE.tts.voiceByAgent = {};
      for (var i = 0; i < ttsAgents.length; i++) {
        var agent = ttsAgents[i];
        if (agent && agent.id && agent.voiceId) STATE.tts.voiceByAgent[agent.id] = agent.voiceId;
      }
      var protocol = ttsVoiceProtocol();
      var voiceReady = ttsVoicesProtocol === protocol
        ? Promise.resolve({ stale: false })
        : loadTtsVoices(protocol);
      return voiceReady.then(function(result){
        if (result && result.stale) return { stale: true };
        if (requestSeq !== ttsAgentsSeq) return { stale: true };
        renderTtsAgentVoices(ttsAgents, ttsVoices);
        return { stale: false };
      });
    }).then(function(result){
      if (requestSeq === ttsAgentsSeq && !(result && result.stale) && status) {
        status.textContent = "已读取 " + ttsAgents.length + " 位助手";
        return true;
      }
      return false;
    }).catch(function(err){
      if (requestSeq !== ttsAgentsSeq) return false;
      if (status) status.textContent = "读取失败（列表可能已过期）";
      setTtsAgentListEnabled(false);
      showToast(err.message || "读取助手列表失败", "err");
      return false;
    }).finally(function(){
      if (requestSeq === ttsAgentsSeq && refresh) refresh.disabled = false;
    });
  }
  function refreshTtsLists() {
    var refresh = $("dgh-tts-refresh-agents");
    if (refresh) refresh.disabled = true;
    loadTtsCandidates();
    return loadTtsVoices(ttsVoiceProtocol()).then(function(result){
      if (result && result.stale) return false;
      return loadTtsAgents();
    }).finally(function(){
      if (refresh) refresh.disabled = false;
    });
  }
  function favTime(ts) {
    try {
      var d = new Date(ts);
      var p = function(n){ return n < 10 ? "0" + n : "" + n; };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    } catch (e) { return ""; }
  }
  function renderTtsFavs(items) {
    var box = $("dgh-tts-fav-box");
    var list = $("dgh-tts-fav-list");
    if (!box || !list) return;
    if (!items || !items.length) { box.classList.add("dgh-hidden"); list.innerHTML = ""; return; }
    box.classList.remove("dgh-hidden");
    var html = "";
    for (var i = 0; i < items.length && i < 50; i++) {
      var it = items[i];
      var txt = (it.text || "").replace(/\\s+/g, " ");
      html += '<div class="dgh-fav-item" data-id="' + escHtml(it.id) + '">'
        + '<div class="dgh-fav-text">' + escHtml(txt.length > 80 ? txt.slice(0, 80) + "…" : txt) + "</div>"
        + '<div class="dgh-fav-meta">' + (it.voiceId ? escHtml(it.voiceId) + " · " : "") + (it.format || "mp3") + " · " + favTime(it.createdAt) + "</div>"
        + '<div class="dgh-fav-actions"><button class="dgh-btn ghost dgh-fav-play" type="button">试听</button><button class="dgh-btn ghost dgh-fav-del" type="button">删除</button></div>'
        + "</div>";
    }
    list.innerHTML = html;
    list.querySelectorAll(".dgh-fav-play").forEach(function(btn){
      btn.addEventListener("click", function(){
        var id = btn.closest(".dgh-fav-item").getAttribute("data-id");
        showToast("播放中…");
        apiPost("/tts/favorites/play", { id: id }).then(function(res){
          if (res && res.ok) showToast((res.message) || "正在播放");
          else showToast((res && res.error) || "播放失败", "err");
        }).catch(function(err){ showToast("播放失败：" + err.message, "err"); });
      });
    });
    list.querySelectorAll(".dgh-fav-del").forEach(function(btn){
      btn.addEventListener("click", function(){
        var id = btn.closest(".dgh-fav-item").getAttribute("data-id");
        apiPost("/tts/favorites/delete", { id: id }).then(function(res){
          if (res && res.ok) { showToast("已删除"); loadTtsFavorites(); }
          else showToast((res && res.error) || "删除失败", "err");
        }).catch(function(err){ showToast("删除失败：" + err.message, "err"); });
      });
    });
  }
  function loadTtsFavorites() {
    apiGet("/tts/favorites").then(function(res){
      renderTtsFavs((res && res.items) || []);
    }).catch(function(){});
  }

  // ── 主页「语音收藏」弹窗：按助手分组展示，试听/删除复用收藏接口 ──
  function renderFavGroups(groups) {
    var box = $("dgh-fav-groups");
    if (!box) return;
    var list = Array.isArray(groups) ? groups : [];
    if (!list.length) {
      box.innerHTML = '<div class="dgh-fav-group-empty">还没有收藏。<br>去悬浮球点「念给我听」朗读一段，再点「♡ 收藏」，这里就会存下带声音的小纸条。</div>';
      return;
    }
    var html = "";
    for (var g = 0; g < list.length; g++) {
      var group = list[g] || {};
      var items = Array.isArray(group.items) ? group.items : [];
      var agentId = group.agentId || "";
      var agentName = group.agentName || "其他";
      var isOther = !agentId;
      html += '<div class="dgh-fav-group' + (isOther ? " other" : "") + '" data-agent="' + escHtml(agentId) + '">'
        + '<div class="dgh-fav-group-head">'
        + '<span class="dgh-fav-avatar">' + escHtml((agentName || "?").slice(0, 1)) + "</span>"
        + '<span class="dgh-fav-group-title">' + escHtml(agentName) + "</span>"
        + '<span class="dgh-fav-group-count">' + items.length + " 条</span>"
        + "</div>"
        + (isOther ? '<div class="dgh-fav-group-note">早期收藏，没有记下是哪位助手说的</div>' : "");
      if (!items.length) {
        html += '<div class="dgh-fav-group-empty">这位助手还没有收藏</div>';
      } else {
        for (var i = 0; i < items.length; i++) {
          var it = items[i] || {};
          var txt = (it.text || "").replace(/\\s+/g, " ");
          var meta = [];
          if (it.voiceId) meta.push(escHtml(it.voiceId));
          meta.push(it.format || "mp3");
          meta.push(favTime(it.createdAt));
          html += '<div class="dgh-fav-item" data-id="' + escHtml(it.id) + '">'
            + '<div class="dgh-fav-text">' + escHtml(txt.length > 100 ? txt.slice(0, 100) + "…" : txt) + "</div>"
            + '<div class="dgh-fav-meta">' + meta.join(" · ") + "</div>"
            + '<div class="dgh-fav-actions">'
            + '<button class="dgh-fav-btn play" type="button">试听</button>'
            + '<button class="dgh-fav-btn del" type="button">删除</button>'
            + "</div>"
            + "</div>";
        }
      }
      html += "</div>";
    }
    box.innerHTML = html;
    box.querySelectorAll(".dgh-fav-btn.play").forEach(function(btn){
      btn.addEventListener("click", function(){
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = "播放中…";
        var id = btn.closest(".dgh-fav-item").getAttribute("data-id");
        apiPost("/tts/favorites/play", { id: id }).then(function(res){
          if (res && res.ok) showToast((res.message) || "正在播放");
          else showToast((res && res.error) || "播放失败", "err");
        }).catch(function(err){ showToast("播放失败：" + err.message, "err"); }).finally(function(){
          btn.disabled = false;
          btn.textContent = "试听";
        });
      });
    });
    box.querySelectorAll(".dgh-fav-btn.del").forEach(function(btn){
      btn.addEventListener("click", function(){
        if (btn.classList.contains("confirm")) {
          var id = btn.closest(".dgh-fav-item").getAttribute("data-id");
          apiPost("/tts/favorites/delete", { id: id }).then(function(res){
            if (res && res.ok) { showToast("已删除"); loadFavGroups(); }
            else showToast((res && res.error) || "删除失败", "err");
          }).catch(function(err){ showToast("删除失败：" + err.message, "err"); });
          return;
        }
        btn.classList.add("confirm");
        btn.textContent = "再点确认";
        clearTimeout(btn._favDelTimer);
        btn._favDelTimer = setTimeout(function(){
          btn.classList.remove("confirm");
          btn.textContent = "删除";
        }, 3000);
      });
    });
  }
  function loadFavGroups() {
    apiGet("/tts/favorites").then(function(res){
      renderFavGroups((res && res.groups) || []);
    }).catch(function(){
      var box = $("dgh-fav-groups");
      if (box) box.innerHTML = '<div class="dgh-fav-group-empty">收藏加载失败，刷新页面再试</div>';
    });
  }
  function openFavModal() {
    var m = $("dgh-fav-modal");
    if (m) m.classList.remove("dgh-hidden");
    loadFavGroups();
  }
  function closeFavModal() {
    var m = $("dgh-fav-modal");
    if (m) m.classList.add("dgh-hidden");
  }
  var favOpenBtn = $("dgh-fav-open");
  if (favOpenBtn) favOpenBtn.addEventListener("click", openFavModal);
  var favCloseBtn = $("dgh-fav-modal-close");
  if (favCloseBtn) favCloseBtn.addEventListener("click", closeFavModal);
  var favOverlay = $("dgh-fav-modal");
  if (favOverlay) favOverlay.addEventListener("click", function(e){
    if (e.target === favOverlay) closeFavModal();
  });
  function openTtsModal() {
    var m = $("dgh-tts-modal");
    if (m) m.classList.remove("dgh-hidden");
    var initialProto = $("dgh-tts-protocol");
    if (initialProto && STATE.tts && (STATE.tts.protocol === "t2a" || STATE.tts.protocol === "chat")) {
      initialProto.value = STATE.tts.protocol;
    }
    syncTtsSourceBoxes(false);
    loadTtsCandidates();
    loadTtsAgents();
    fillSpeedSelect();
    var tmsg = $("dgh-tts-msg");
    if (tmsg) tmsg.textContent = "";
    loadTtsFavorites();
  }
  function closeTtsModal() {
    var m = $("dgh-tts-modal");
    if (m) m.classList.add("dgh-hidden");
  }
  var ttsOpenBtn = $("dgh-tts-open");
  if (ttsOpenBtn) ttsOpenBtn.addEventListener("click", openTtsModal);
  var ttsCloseBtn = $("dgh-tts-modal-close");
  if (ttsCloseBtn) ttsCloseBtn.addEventListener("click", closeTtsModal);
  var ttsOverlay = $("dgh-tts-modal");
  if (ttsOverlay) ttsOverlay.addEventListener("click", function(e){
    if (e.target === ttsOverlay) closeTtsModal();
  });
  document.querySelectorAll("input[name=tts_source]").forEach(function(r){
    r.addEventListener("change", syncTtsSourceBoxes);
  });
  var ttsRefreshAgentsBtn = $("dgh-tts-refresh-agents");
  if (ttsRefreshAgentsBtn) ttsRefreshAgentsBtn.addEventListener("click", function(){
    refreshTtsLists().catch(function(err){ showToast("刷新模型和音色失败：" + err.message, "err"); });
  });
  var ttsProtoSel = $("dgh-tts-protocol");
  if (ttsProtoSel) ttsProtoSel.addEventListener("change", syncTtsProtocolFields);

  function ttsModelFormBody() {
    var src = ttsRadio("source") || "auto";
    var body = { source: src };
    if (src === "hana") {
      var cand = $("dgh-tts-candidate") ? $("dgh-tts-candidate").value : "";
      var sep = cand.indexOf("|");
      if (sep > 0) {
        body.providerId = cand.slice(0, sep);
        body.model = cand.slice(sep + 1);
      }
    } else if (src === "custom") {
      body.protocol = ttsProtocol();
      body.baseUrl = $("dgh-tts-url") ? $("dgh-tts-url").value.trim() : "";
      if (body.protocol === "t2a") {
        body.apiKey = $("dgh-tts-key") ? $("dgh-tts-key").value : "";
        body.groupId = $("dgh-tts-group") ? $("dgh-tts-group").value.trim() : "";
      } else {
        body.apiKey = $("dgh-tts-key2") ? $("dgh-tts-key2").value : "";
        body.model = $("dgh-tts-custom-model") ? $("dgh-tts-custom-model").value.trim() : "";
      }
    }
    return body;
  }
  function ttsFormBody() {
    var body = ttsModelFormBody();
    body.enabled = ttsRadio("enabled") === "on";
    body.scope = ttsRadio("scope") || "whole";
    body.speed = $("dgh-tts-speed") ? $("dgh-tts-speed").value : "1";
    return body;
  }
  function ttsValidationMessage(body) {
    if (body.source === "hana" && !body.model) return "先选一个语音模型";
    if (body.source === "custom" && body.protocol === "t2a" && !body.groupId) return "MiniMax 需要填 GroupId";
    if (body.source === "custom" && !body.apiKey && !ttsHasSavedKey) return "先填 API Key";
    return "";
  }
  var ttsHasSavedKey = !!(STATE.tts && STATE.tts.apiKeyMasked === "********");
  var clearTtsKeyRequested = false;
  function clearTtsKeyInput() {
    var a = $("dgh-tts-key"), b = $("dgh-tts-key2");
    if (a) a.value = "";
    if (b) b.value = "";
    clearTtsKeyRequested = true;
    var ca = $("dgh-tts-key-clear"), cb = $("dgh-tts-key2-clear");
    if (ca) ca.disabled = true;
    if (cb) cb.disabled = true;
    var msg = $("dgh-tts-msg");
    if (msg) msg.textContent = "已标记清除，点击保存后生效";
  }
  var ttsClear1 = $("dgh-tts-key-clear"), ttsClear2 = $("dgh-tts-key2-clear");
  if (ttsClear1) ttsClear1.addEventListener("click", clearTtsKeyInput);
  if (ttsClear2) ttsClear2.addEventListener("click", clearTtsKeyInput);
  // Key 就地提示（2026-08-19 分享版）：t2a/MiniMax 只认 sk-api-，粘进 sk-cp- 订阅 Key 立刻提醒，不等点试听；
  // chat 等通用协议各家 key 前缀不同，不卡前缀，只给轻提示。
  function hideTtsKeyTip() {
    var w = $("dgh-tts-key-warn");
    if (w) w.classList.add("dgh-hidden");
  }
  function checkTtsKeyTip(el, isT2a) {
    var w = $("dgh-tts-key-warn");
    if (!el || !w) return;
    var v = (el.value || "").trim();
    if (!v || v === "********") { hideTtsKeyTip(); return; }
    w.classList.remove("dgh-hidden", "ok");
    w.className = "dgh-key-tip";
    if (isT2a) {
      if (/^sk-cp-/i.test(v)) {
        // 订阅 Key：走订阅套餐额度（好消息，不扣 API 余额）
        w.className = "dgh-key-tip ok";
        w.textContent = "这是订阅 Key（sk-cp-），语音会走你的订阅套餐额度，不扣 API 余额。" + (ttsHasSavedKey ? "想换回已保存的，清空输入框即可。" : "");
        return;
      }
      if (/^sk-api-/i.test(v)) {
        w.className = "dgh-key-tip ok";
        w.textContent = "这是 API Key（sk-api-），语音按量计费。" + (ttsHasSavedKey ? "想换回已保存的，清空输入框即可。" : "");
        return;
      }
      w.textContent = "MiniMax 语音认两种 Key：sk-api-（按量计费）或 sk-cp-（订阅套餐额度），这个开头看着不像。";
      return;
    }
    // chat 通用协议：有值即用，给个状态说明
    w.textContent = ttsHasSavedKey ? "填了新 Key，助手试听会用这个；留空则用已保存的。" : "已填 Key，助手试听会用这个。";
  }
  var ttsKeyInput1 = $("dgh-tts-key"), ttsKeyInput2 = $("dgh-tts-key2");
  if (ttsKeyInput1) ttsKeyInput1.addEventListener("input", function(){ clearTtsKeyRequested = false; checkTtsKeyTip(ttsKeyInput1, true); });
  if (ttsKeyInput2) ttsKeyInput2.addEventListener("input", function(){ clearTtsKeyRequested = false; checkTtsKeyTip(ttsKeyInput2, false); });
  var ttsModelTestBtn = $("dgh-tts-test-model");
  if (ttsModelTestBtn) ttsModelTestBtn.addEventListener("click", function(){
    var tmsg = $("dgh-tts-msg");
    var body = ttsModelFormBody();
    body.voiceId = "";
    body.play = false;
    var problem = ttsValidationMessage(body);
    if (problem) { tmsg.textContent = problem; return; }
    ttsModelTestBtn.disabled = true;
    ttsModelTestBtn.textContent = "连接中…";
    tmsg.textContent = "正在检查模型连接…";
    apiPost("/tts/test", body).then(function(res){
      if (res && res.ok) {
        tmsg.textContent = (res && res.message) || "模型连接正常";
      } else {
        tmsg.textContent = (res && res.error) || "模型连接失败";
      }
    }).catch(function(err){
      tmsg.textContent = "模型连接失败：" + err.message;
    }).finally(function(){
      ttsModelTestBtn.disabled = false;
      ttsModelTestBtn.textContent = "测试模型连接";
    });
  });
  var ttsSaveBtn = $("dgh-tts-save");
  if (ttsSaveBtn) ttsSaveBtn.addEventListener("click", function(){
    var tmsg = $("dgh-tts-msg");
    var body = ttsFormBody();
    if (clearTtsKeyRequested) body.clearApiKey = true;
    var problem = ttsValidationMessage(body);
    if (problem) { tmsg.textContent = problem; return; }
    tmsg.textContent = "保存中…";
    apiPost("/tts/save", body).then(function(res){
      if (res && res.ok) {
        tmsg.textContent = "已保存";
        var keyEl = body.protocol === "t2a" ? $("dgh-tts-key") : $("dgh-tts-key2");
        // 保存后输入框清空，语义统一为「空 = 用已保存」，不再预填 ********（分享版：免得误以为没存又去粘 key）
        if (keyEl) keyEl.value = "";
        hideTtsKeyTip();
        STATE.tts = { ...STATE.tts, ...body, apiKeyMasked: body.clearApiKey ? "" : (body.apiKey ? "********" : STATE.tts.apiKeyMasked) };
        ttsHasSavedKey = !body.clearApiKey && (!!STATE.tts.apiKeyMasked || ttsHasSavedKey);
        clearTtsKeyRequested = false;
        if (ttsClear1) ttsClear1.disabled = !ttsHasSavedKey;
        if (ttsClear2) ttsClear2.disabled = !ttsHasSavedKey;
        setTimeout(closeTtsModal, 600);
      } else {
        tmsg.textContent = (res && res.error) || "保存失败";
      }
    }).catch(function(err){
      tmsg.textContent = "保存失败：" + err.message;
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
