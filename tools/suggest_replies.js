// 解语花 — 核心工具：生成推荐回复
// agent 在回复末尾调用，返回 plugin_card 渲染在回复末尾
// 推荐文本存 pending，卡片 iframe 通过 r 参数取用

import { getConfig, createPending } from "../lib/data.js";
import { generateSuggestions, parseSuggestions } from "../lib/llm.js";
import { readRecentMessages, buildContextText, findLatestSessionPath } from "../lib/session.js";

export const name = "suggest_replies";
export const description = "生成推荐回复：根据最近对话，生成几条用户接下来可能会说的话，以可点击的推荐卡片显示。**在写回复正文之前先调用本工具**（推荐卡片会自动显示，正文不需要提及）。对话性回复（闲聊、答疑、陪伴）适合调用；纯任务执行、用户已明确结束的对话不必调用。";
export const parameters = {
  type: "object",
  properties: {
    hint: {
      type: "string",
      description: "可选：你想让推荐偏向的方向，比如「温柔一点」「多给几个选择」「像朋友一样」。不传就按对话自然生成。"
    }
  },
  required: []
};

// 按条数生成方向分配行（方向来自配置 styles，勾选来自 selected）
// styles 接受两种格式：旧 string[] 与新 {name, intent}[]，统一在内部映射为对象
export function buildStyleLines(count, styles, selected) {
  const n = [2, 3, 4].includes(count) ? count : 3;
  const defaults = [
    { name: "追问/延伸", intent: "顺着话题往下问一句，或延伸到自己关心的事" },
    { name: "分享/感慨", intent: "分享自己的感受或关联的事，带点情绪" },
    { name: "行动/请求", intent: "让助手帮忙做点什么、解释什么、推荐什么" },
    { name: "玩笑/俏皮", intent: "用俏皮、调侃的方式说话" }
  ];
  const list = (Array.isArray(styles) && styles.length >= n)
    ? styles.map((s, i) => {
        if (typeof s === "string") {
          return { name: s, intent: (defaults[i] || {}).intent || "" };
        }
        if (s && typeof s === "object") {
          return { name: String(s.name || ""), intent: String(s.intent || "") };
        }
        return { name: "", intent: "" };
      })
    : defaults;
  // 勾选索引：selected 无效时默认前 N 个
  let idx = [];
  if (Array.isArray(selected) && selected.length) {
    idx = selected.filter((i) => Number.isInteger(i) && i >= 0 && i < list.length).slice(0, n);
  }
  if (idx.length < n) {
    idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
  }
  const lines = [`4. ${n} 条请分别按以下方向生成，不要雷同：`];
  for (let i = 0; i < n; i++) {
    const s = list[idx[i]] || defaults[idx[i] % defaults.length] || { name: "", intent: "" };
    const intent = s.intent ? s.intent : "按方向名理解";
    lines.push(`   ${i + 1}. 方向【${s.name}】——意思是：${intent}`);
  }
  return lines;
}

// 按条数估算推荐卡片初始高度（2026-08-06 破案）：宿主 card 槽位初始高度 = 400/aspectRatio（无则固定 300px），
// 且 card 槽位的 ui.resize 上报实测不生效（之前误信朋友圈 page 槽位协议，朋友圈没做过这种卡片）。
// 正解：工具返回时按条数带上 aspectRatio，宿主初始高度直接精确匹配内容。
// 估算公式（宽度固定 400px）：body padding 20 + 头部 29 + N×52（卡片最小高度）+ gap 6(N-1) + 余量 13
function estimateCardHeight(n) {
  return 58 * n + 56;
}

export async function execute(input, ctx) {
  const dataDir = ctx.dataDir;
  const cfg = getConfig(dataDir);

  // 展示模式防线（2026-08-10）：observer 只拦「引导层」，模型仍可能自发调用本工具。
  // 非卡片模式（竹简/关闭）下绝不返回卡片数据，从根上保证回复里不会出现推荐卡片。
  if (cfg.presentation !== "card") {
    const label = cfg.presentation === "ball" ? "竹简" : "关闭";
    return {
      content: [{ type: "text", text: `（解语花当前是${label}模式，不生成推荐卡片）` }]
    };
  }

  try {
    // ── 1. 定位会话 ──
    let sessionPath = ctx.sessionPath || "";
    let sessionId = ctx.sessionId || "";
    if (!sessionPath && ctx.sessionRef) {
      sessionPath = ctx.sessionRef.sessionPath || ctx.sessionRef.path || "";
      sessionId = sessionId || ctx.sessionRef.sessionId || "";
    }
    if (!sessionPath && sessionId && !sessionId.startsWith("sess_")) {
      sessionPath = findLatestSessionPath(sessionId);
    }

    // ── 2. 读最近对话 ──
    let contextText = "";
    if (sessionPath) {
      const messages = readRecentMessages(sessionPath, 6);
      contextText = buildContextText(messages);
    }
    const rawHint = typeof input?.hint === "string" ? input.hint.trim() : "";
    // hint 限长 200 字 + 清洗控制字符（防止长文本/控制符进 prompt）
    const cleanHint = rawHint.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
    if (!contextText && cleanHint) {
      contextText = `（对话内容不可用）用户希望推荐方向：${cleanHint}`;
    }

    const hintLine = cleanHint ? `\n额外要求：${cleanHint}` : "";

    // 按条数分配方向（配置 styles + 该档勾选 selectedByCount）
    const sel = (cfg.selectedByCount && cfg.selectedByCount[cfg.count]) || undefined;
    const styleLines = buildStyleLines(cfg.count, cfg.styles, sel);

    const prompt = [
      "【红线】所有输出必须是「用户」在对话中对「助手」说的话。第一人称「我」、直接对助手喊，不要生成助手口吻、引导问句、旁观者描述这种不是用户在说的话。",
      "你是「解语花」推荐引擎，你是用户的「嘴替」。",
      "下面对话中，「用户」是发消息的人，「助手」是回复的人。",
      `你的任务：生成 ${cfg.count} 条「用户接下来准备发给助手的话」。`,
      "硬性要求：",
      "1. 紧扣下面对话的具体内容——顺着刚才聊的话题、细节、情绪往下走，不要生成与对话无关的泛泛之谈",
      "2. 必须是用户的口吻、第一人称（「我」），直接对助手说话",
      "3. 每条 5~20 个字，口语化",
      ...styleLines,
      "5. 反面例子（不要生成）：「早啊，今天想干点啥」「今天天气不错」——这是助手口吻或与对话无关",
      "6. 正面例子（紧扣对话）：「你刚说的那个方案，具体怎么操作？」「听你这么说我也想起一件事…」「那你帮我看看这个呗」",
      "7. 只输出 JSON 数组，不要任何其他文字、不要解释。数组元素是对象：{\"text\": \"推荐的话\", \"direction\": \"第N条对应的方向名，照抄上方给出的方向，如'撒娇'\"}",
      "对话：",
      contextText || "（无可用对话，生成通用的用户对助手说的话）",
      hintLine,
      "输出："
    ].join("\n");

    // ── 3. 生成 ──
    // agent 档走 ctx.model.sample（跟随助手当前模型）；hana/custom 档走 HTTP
    const sampleFn = (opts) => ctx.model?.sample ? ctx.model.sample(opts) : Promise.reject(new Error("当前会话模型不可用"));
    const raw = await generateSuggestions(dataDir, prompt, { sampleFn });

    // ── 4. 解析 + 存 pending ──
    const items = parseSuggestions(raw, cfg.count);
    if (!items.length) {
      return { content: [{ type: "text", text: "没能生成合适的推荐，可以再试一次" }] };
    }
    // 方向兜底：模型没输出 direction 时，用配置里对应位置的方向名
    for (let i = 0; i < items.length; i++) {
      if (!items[i].direction && cfg.styles && cfg.styles[i]) {
        const s = cfg.styles[i];
        items[i].direction = typeof s === "object" ? (s.name || "") : String(s);
      }
    }

    const { rid } = await createPending(dataDir, { items, sessionId, sessionPath });

    // ── 返回卡片（结构参照表情包 express：content 显示文本 + details.card 卡片数据） ──
    // aspectRatio 按条数估算（宿主 card 槽位初始高度 = 400/aspectRatio），让 iframe 初始高度精确贴合内容，不留白
    return {
      content: [{ type: "text", text: `已生成 ${items.length} 条推荐回复，附在回复下方` }],
      details: {
        card: {
          type: "iframe",
          pluginId: "jiegehua",
          sessionId: ctx.sessionId || sessionId || undefined,
          sessionRef: ctx.sessionRef || undefined,
          sessionPath: ctx.sessionPath || sessionPath || undefined,
          route: "/suggest?r=" + encodeURIComponent(rid),
          aspectRatio: "400:" + estimateCardHeight(items.length),
          title: "解语花"
        }
      }
    };
  } catch (err) {
    ctx.log?.error?.("[解语花] 生成推荐失败", { error: err?.message || String(err) });
    return { content: [{ type: "text", text: `推荐生成失败：${err?.message || String(err)}` }] };
  }
}
