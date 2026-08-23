// 解语花 · 推荐卡片协议
// 新宿主走 show_card + SessionFile Interactive Card；旧宿主走现存的 details.card iframe。

const MAX_ITEMS = 4;
const INTERACTIVE_CARD_MIN_VERSION = [0, 680, 9];

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, MAX_ITEMS)
    .map((item) => ({
      text: typeof item?.text === "string" ? item.text.trim().slice(0, 80) : "",
      direction: typeof item?.direction === "string" ? item.direction.trim().slice(0, 40) : "",
    }))
    .filter((item) => item.text);
}

// JSON 会进入 script 文本，先转义 HTML 特殊起始字符，避免推荐内容闭合 script。
function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function safeCardId(value) {
  return String(value || "suggestions")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 80) || "suggestions";
}

export function parseHostVersion(version) {
  const match = String(version || "").trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

export function supportsInteractiveCard(version) {
  const current = parseHostVersion(version);
  if (!current) return false;
  for (let i = 0; i < INTERACTIVE_CARD_MIN_VERSION.length; i += 1) {
    if (current[i] !== INTERACTIVE_CARD_MIN_VERSION[i]) return current[i] > INTERACTIVE_CARD_MIN_VERSION[i];
  }
  return true;
}

export function estimateCardHeight(count) {
  const n = Math.max(2, Math.min(4, Number(count) || 3));
  return 58 * n + 56;
}

export function buildLegacyCardDetails({
  pluginId = "jiegehua",
  sessionId,
  sessionRef,
  sessionPath,
  rid,
  count,
  title = "解语花",
} = {}) {
  const details = {
    type: "iframe",
    pluginId,
    sessionId: sessionId || undefined,
    sessionRef: sessionRef || undefined,
    sessionPath: sessionPath || undefined,
    route: "/suggest?r=" + encodeURIComponent(String(rid || "")),
    aspectRatio: "400:" + estimateCardHeight(count),
    title,
  };
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

function buildManifest(rid, action) {
  const copy = {
    tool: "clipboard.writeText",
    input: {},
    slots: ["text"],
  };
  if (action === "send") {
    return {
      toolBindings: {
        send: {
          tool: "jiegehua_apply_suggestion",
          input: { rid },
          slots: ["index"],
        },
        copy,
      },
    };
  }
  return { toolBindings: { copy } };
}

function buildClientScript(payload) {
  const payloadJson = inlineJson(payload);
  return [
    "(function(){",
    `var data=${payloadJson};`,
    "var list=document.getElementById('jiegehua-items');",
    "var status=document.getElementById('jiegehua-status');",
    "function setStatus(text,error){status.textContent=text;status.style.color=error?'var(--danger)':'var(--text-muted)';}",
    "function failed(result){return !result||result.ok===false||result.success===false||(result.result&&(result.result.ok===false||result.result.success===false));}",
    "async function copyText(text){var result=await window.card.invoke('copy',{text:text});if(failed(result))throw new Error('copy failed');}",
    "data.items.forEach(function(item,index){",
    "var button=document.createElement('button');",
    "button.type='button';",
    "button.className='jiegehua-option';",
    "button.setAttribute('aria-label',item.text);",
    "button.textContent=item.text;",
    "button.addEventListener('click',async function(){",
    "button.disabled=true;",
    "var buttons=list.querySelectorAll('button');",
    "try{",
    "var result;",
    "if(data.action==='send'){",
    "try{",
    "result=await window.card.invoke('send',{index:index});",
    "if(failed(result))throw new Error('send failed');",
    "setStatus('已发送');",
    "buttons.forEach(function(node){node.disabled=true;});",
    "return;",
    "}catch(sendError){",
    "try{await copyText(item.text);button.disabled=true;setStatus('直接发送暂时不可用，已复制，可以粘贴发送');return;}",
    "catch(copyError){throw sendError;}",
    "}",
    "}",
    "result=await window.card.invoke('copy',{text:item.text});",
    "if(failed(result))throw new Error('copy failed');",
    "setStatus('已复制，可以粘贴到输入框');",
    "}catch(error){",
    "button.disabled=false;",
    "setStatus(data.action==='send'?'发送失败，请再试一次':'复制失败，请再试一次',true);",
    "}", 
    "});",
    "list.appendChild(button);",
    "});",
    "})();",
  ].join("\n");
}

export function buildSuggestionCardFragment({ items, rid, action = "copy" }) {
  const safeItems = normalizeItems(items);
  const safeAction = action === "send" ? "send" : "copy";
  const manifest = inlineJson(buildManifest(String(rid || ""), safeAction));
  const payload = { items: safeItems, action: safeAction };
  const hint = safeAction === "send" ? "点一下直接发送" : "点一下复制，粘到输入框就能发";

  return [
    "<style>",
    "#jiegehua-card{padding:12px 16px 10px;font-family:var(--font-ui);}",
    "#jiegehua-title{margin:0 0 8px;text-align:center;font-family:var(--font-serif);font-size:1.1rem;font-weight:500;color:var(--text);}",
    "#jiegehua-hint{margin:0 0 10px;text-align:center;font-size:11px;color:var(--text-muted);}",
    "#jiegehua-items{display:grid;gap:8px;}",
    ".jiegehua-empty{padding:12px;text-align:center;color:var(--text-muted);font-size:.85rem;}",
    ".jiegehua-option{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-chat-card);background:transparent;color:var(--text);font:500 0.9rem/1.45 var(--font-serif);text-align:left;cursor:pointer;outline:none;}",
    ".jiegehua-option:hover,.jiegehua-option:focus-visible{background:var(--accent-light);color:var(--accent-hover);border-color:var(--accent);outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px;}",
    ".jiegehua-option:disabled{cursor:default;opacity:.58;}",
    "#jiegehua-status{min-height:16px;margin:8px 0 0;text-align:center;font-size:11px;color:var(--text-muted);}",
    "</style>",
    "<div id=\"jiegehua-card\">",
    "<h2 id=\"jiegehua-title\">推荐回复</h2>",
    `<p id="jiegehua-hint">${hint}</p>`,
    `<div id="jiegehua-items">${safeItems.length ? "" : "<p class=\"jiegehua-empty\">暂时没有合适的推荐</p>"}</div>`,
    "<p id=\"jiegehua-status\" aria-live=\"polite\"></p>",
    "</div>",
    `<script type="application/json" data-card-manifest>${manifest}</script>`,
    `<script>${buildClientScript(payload)}</script>`,
  ].join("\n");
}

export function buildSuggestionCardDocument({ items, rid, action = "copy" }) {
  const cardId = `jiegehua-suggestions-${safeCardId(rid)}`;
  const fragment = buildSuggestionCardFragment({ items, rid, action });
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    `<meta name="card-id" content="${cardId}">`,
    "<title>解语花推荐回复</title>",
    "</head>",
    "<body>",
    "<!-- hana-card-fragment-begin -->",
    fragment,
    "<!-- hana-card-fragment-end -->",
    "</body>",
    "</html>",
  ].join("\n");
}

export function buildShowCardInput({ fileId, code, title = "解语花推荐回复" }) {
  const input = { title };
  if (fileId) input.file = { type: "session_file", fileId: String(fileId) };
  else input.code = String(code || "");
  return input;
}

export function buildShowCardInstruction(input) {
  return [
    "已生成推荐回复。下一步必须立即调用内置 show_card 工具，把下面的参数原样传入；不要把参数内容展示给用户：",
    JSON.stringify(input),
  ].join("\n");
}
