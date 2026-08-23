// 解语花 — 核心工具：生成推荐回复
// agent 在回复末尾调用；工具准备 .card.html，随后由内置 show_card 铸成真正的内联 Interactive Card
// 推荐文本仍存 pending，卡片点击发送/复制沿用同一条安全数据链路

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfig, createPending } from "../lib/data.js";
import { generateSuggestions, parseSuggestions } from "../lib/llm.js";
import { readRecentMessages, buildContextText, findLatestSessionPath } from "../lib/session.js";
import { detectConversationLang } from "../lib/zhujian.js";
import {
  buildShowCardInput,
  buildShowCardInstruction,
  buildSuggestionCardDocument,
  buildLegacyCardDetails,
  supportsInteractiveCard,
} from "../lib/suggestion-card.js";

export const name = "suggest_replies";
export const description = "生成推荐回复：根据最近对话，生成几条用户接下来可能会说的话。**请先写完回复正文，再调用本工具；工具返回后必须立即调用内置 show_card，把返回的参数原样传入，且让 show_card 作为最后一步，才能显示真正可点击的内联卡片**（正文不需要提及卡片）。对话性回复（闲聊、答疑、陪伴）适合调用；纯任务执行、用户已明确结束的对话不必调用。";
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

// ─── 口语质量准则（杀 AI 八股，2026-08-14 加） ───
// 借鉴：闲不住小纸条的写前禁令（按类禁大词/句式/抒情词）+ 在干嘛弹幕质量准则 + 玥饼预设的错例→正例对照格式
// 按"类"禁而不是逐句禁，保证通用性；错例→正例比纯禁令更有效
const QUALITY_RULES = `【口语质量准则】推荐语是真人打字，不是写文章：
1. 不打比方：不用「比…还…」「像…一样」「仿佛…」这类修辞，想说啥直接说。
   ✗ 「你这效率比开了挂还离谱」 → ✓ 「你这效率也太夸张了」
2. 不堆大词：「逻辑」「哲学」「诗意」「灵魂」「时光」这类词一个都不用。
3. 不用八股句式：「不是…而是…」「与其说…不如说…」「有一种…在蔓延」「某种说不清的东西」都不用。
4. 不空泛敷衍：「哈哈确实」「你说得对」「真不错」「原来如此」这种谁都能接的话，禁止。
5. 不堆感叹词：「哇！！太棒了吧！！」这种为显热情硬堆的感叹号，禁止；语气词点到为止。
6. 对自家助手不用客气：「谢谢你的建议」「麻烦你了」这种礼貌腔，禁止。
7. 允许短句、大白话，一句话一个意思，不用每句都精彩。`;

// ─── 八股检测（借鉴闲不住 hasAiFlavor，按类正则；宁漏杀不误杀，写前禁令已压源头） ───
const AI_FLAVOR_PATTERNS = [
  /比[^，。！？\s]{0,8}还/, // 比字句：你xx比xx还xx
  /仿佛|宛如|犹如/, // 文绉绉的比喻词
  /不是[^。！？]{0,10}而是/, // 八股句式（含带逗号形态：不是…，而是…）
  /与其说/, // 八股句式
  /某种|说不清/, // 模糊指代（某种说不清的东西）
  /逻辑|哲学|诗意|灵魂|时光/, // 大词
  /一丝|一抹|刹那/, // 模糊抒情词
  /哈哈确实|你说得对|真不错|原来如此/, // 万能敷衍
  /谢谢你的建议|麻烦你了/, // 对自家助手的礼貌腔
  /！{3,}/, // 感叹号轰炸
];

// 命中任一八股模式返回 true（推荐条目级过滤用）
export function hasAiFlavor(text) {
  if (!text || typeof text !== "string") return false;
  return AI_FLAVOR_PATTERNS.some((p) => p.test(text));
}

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

// ─── 推荐 prompt 公共构建（卡片工具与悬浮球共用，2026-08-14 抽出） ───
// 参数：count=条数，styles=方向配置，selected=按条数勾选索引，contextText=对话上下文，hint=额外要求（可选）
// 新条款：① 模仿用户说话风格（含风险闸：不为了模仿而把话说没）② 语言跟随对话
// 语言跟随与标题同款：由规则锁定后写进 prompt（让模型执行而不是判断，确定性更高），
// 避免模型自己判断语言时误判/抽风输出英文。
// 注意：编号顺序与 buildStyleLines 自带的「4.」保持衔接，改这里时留意
export function buildSuggestionPrompt({ count, styles, selected, contextText, hint }) {
  const sel = (selected && selected[count]) || undefined;
  const styleLines = buildStyleLines(count, styles, sel);
  const hintLine = hint ? `\n额外要求：${hint}` : "";
  const lang = detectConversationLang(contextText);
  const langLine =
    lang === "en"
      ? "6. 这次对话主要是英文，推荐语必须全部用英文输出，不要用中文"
      : "6. 这次对话主要是中文，推荐语必须全部用中文输出，不要用英文";
  return [
    "【红线】所有输出必须是「用户」在对话中对「助手」说的话。第一人称「我」、直接对助手喊，不要生成助手口吻、引导问句、旁观者描述这种不是用户在说的话。",
    "你是「解语花」推荐引擎，你是用户的「嘴替」。",
    "下面对话中，「用户」是发消息的人，「助手」是回复的人。",
    `你的任务：生成 ${count} 条「用户接下来准备发给助手的话」。`,
    "硬性要求：",
    "1. 紧扣下面对话的具体内容——顺着刚才聊的话题、细节、情绪往下走，不要生成与对话无关的泛泛之谈",
    "2. 必须是用户的口吻、第一人称（「我」），直接对助手说话",
    "3. 每条 5~20 个字，口语化",
    ...styleLines,
    "5. 模仿用户说话的方式：语气词、口头禅、用词风格、标点习惯都要像同一个人说出来的；但句子长短和内容饱满度优先保证推荐价值，不要为了模仿而把话说没",
    langLine,
    "7. 反面例子（不要生成）：「早啊，今天想干点啥」「今天天气不错」——这是助手口吻或与对话无关",
    "8. 正面例子（紧扣对话）：「你刚说的那个方案，具体怎么操作？」「听你这么说我也想起一件事…」「那你帮我看看这个呗」",
    "9. 只输出一个合法 JSON 数组，首字符必须是 [，末字符必须是 ]；不要逐行输出独立对象，不要任何其他文字、不要解释。数组元素是对象：{\"text\": \"推荐的话\", \"direction\": \"第N条对应的方向名，照抄上方给出的方向，如'撒娇'\"}",
    QUALITY_RULES,
    "对话：",
    contextText || "（无可用对话，生成通用的用户对助手说的话）",
    hintLine,
    "输出：",
  ].join("\n");
}

function safeCardFilePart(value) {
  return String(value || "suggestions")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 80) || "suggestions";
}

async function prepareCardArtifact(ctx, dataDir, { rid, items, action }) {
  const cardDir = path.join(dataDir, "interactive-cards");
  fs.mkdirSync(cardDir, { recursive: true });
  const cardPath = path.join(cardDir, `${safeCardFilePart(rid)}.card.html`);
  const tempPath = `${cardPath}.tmp-${process.pid}-${Date.now()}`;
  const code = buildSuggestionCardDocument({ rid, items, action });
  fs.writeFileSync(tempPath, code, "utf8");
  fs.renameSync(tempPath, cardPath);

  try {
    if (typeof ctx?.stageFile === "function") {
      try {
        const staged = await ctx.stageFile({
          sessionId: ctx.sessionId || undefined,
          sessionRef: ctx.sessionRef || undefined,
          sessionPath: ctx.sessionPath || undefined,
          filePath: cardPath,
          label: `解语花推荐-${safeCardFilePart(rid)}.card.html`,
        });
        const file = staged?.file || staged?.mediaItem || staged;
        const fileId = file?.fileId || staged?.fileId || "";
        if (fileId) return { fileId: String(fileId) };
        ctx.log?.warn?.("[解语花] 卡片文件已写入但未拿到 fileId，改用 code 兜底");
      } catch (err) {
        ctx.log?.warn?.("[解语花] stageFile 失败，改用 show_card code 兜底", { error: err?.message || String(err) });
      }
    }
    return { code };
  } finally {
    // stageFile 已完成登记；code 兜底也已经把内容带回，不让每轮推荐在 dataDir 留垃圾文件。
    try { fs.unlinkSync(cardPath); } catch {}
  }
}

function readHanaAppVersion(ctx) {
  const direct = ctx?.hanaVersion || ctx?.appVersion || ctx?.hostVersion;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const hanaHome = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
  try {
    const info = JSON.parse(fs.readFileSync(path.join(hanaHome, "server-info.json"), "utf8"));
    return typeof info?.version === "string" ? info.version : "";
  } catch {
    return "";
  }
}

export async function execute(input, ctx) {
  const dataDir = ctx.dataDir;
  const cfg = getConfig(dataDir);

  // 展示模式防线（2026-08-10）：observer 只拦「引导层」，模型仍可能自发调用本工具。
  // 非卡片模式（悬浮球/关闭）下绝不返回卡片数据，从根上保证回复里不会出现推荐卡片。
  if (cfg.presentation !== "card") {
    const label = cfg.presentation === "ball" ? "悬浮球" : "关闭";
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

    const prompt = buildSuggestionPrompt({
      count: cfg.count,
      styles: cfg.styles,
      selected: cfg.selectedByCount,
      contextText,
      hint: cleanHint,
    });

    // ── 3. 生成 ──
    // agent 档走 ctx.model.sample（跟随助手当前模型）；hana/custom 档走 HTTP
    const sampleFn = (opts) => ctx.model?.sample ? ctx.model.sample(opts) : Promise.reject(new Error("当前会话模型不可用"));

    // ── 4. 生成 + 八股过滤（最多补一次） ──
    // 写前禁令已压源头；这里对解析结果逐条扫八股正则，命中剔除（宁缺毋滥）
    // 过滤后不够条数时原样重试一次（模型温度 0.9 有随机性），最多 2 次调用
    let items = [];
    for (let attempt = 1; attempt <= 2 && items.length < cfg.count; attempt++) {
      const raw = await generateSuggestions(dataDir, prompt, {
        sampleFn,
        bus: ctx.bus,
        agentId: ctx.agentId,
        sessionPath,
        fetcher: ctx.network?.fetch ? (url, options) => ctx.network.fetch(url, options) : undefined,
      });
      const clean = parseSuggestions(raw, cfg.count).filter((it) => !hasAiFlavor(it.text));
      // 保留两次中较好的一次（第二次更差时用第一次的）
      if (clean.length > items.length) items = clean;
    }
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
    const hostVersion = readHanaAppVersion(ctx);

    if (!supportsInteractiveCard(hostVersion)) {
      // 公开旧版（如 0.450.0）没有 show_card；沿用原有 iframe 卡片，
      // 并且绝不把“请调用 show_card”的内部指令泄漏到用户正文里。
      const card = buildLegacyCardDetails({
        pluginId: ctx.pluginId || "jiegehua",
        sessionId,
        sessionRef: ctx.sessionRef,
        sessionPath,
        rid,
        count: items.length,
      });
      return {
        content: [{ type: "text", text: `已生成 ${items.length} 条推荐回复，附在回复下方` }],
        details: { card },
      };
    }

    const artifact = await prepareCardArtifact(ctx, dataDir, {
      rid,
      items,
      action: cfg.action,
    });
    const cardInput = buildShowCardInput({
      ...artifact,
      title: "解语花推荐回复",
    });

    // 新版宿主只有内置 show_card 工具会进入 interactive_card 渲染链；
    // details.card 无论写 iframe/webview 还是自定义 type，都只会成为 plugin_card 占位卡。
    return {
      content: [{ type: "text", text: buildShowCardInstruction(cardInput) }],
      details: {
        suggestionCard: {
          protocol: "show_card",
          hostVersion,
          rid,
          count: items.length,
          input: cardInput,
        },
      },
    };
  } catch (err) {
    ctx.log?.error?.("[解语花] 生成推荐失败", { error: err?.message || String(err) });
    return { content: [{ type: "text", text: `推荐生成失败：${err?.message || String(err)}` }] };
  }
}
