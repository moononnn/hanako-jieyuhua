// 解语花 — 悬浮球提问工具
// 工具只负责登记问题；用户界面由正在运行的樱花悬浮球自动接管。

import { getConfig, createAskPending } from "../lib/data.js";
import { validateAskInput } from "../lib/ask.js";
import { findLatestSessionPath } from "../lib/session.js";
import { isZhujianPresentationRunning } from "../lib/zhujian.js";

export const name = "ask_user_choice";
export const description = [
  "当你需要用户拍板、选择或提供偏好才能继续时，必须先调用这个工具（用纯文本问选择题不会弹出提问面板）。",
  "樱花悬浮球会直接把推荐回复区替换成提问区，用户作答后你会收到结构化的 Markdown 回传；提问面板已弹出后，不要在正文里重复问一遍。",
  "能自己查到或推断的事实不要问，只问用户自己的选择，或确实查不到的关键歧义。",
  "适合：选方案、确认是否执行、选择风格/时间/目标、补充关键偏好。",
  "不适合：答案唯一、只是陈述、纯闲聊，或没有正在运行的解语花/融合悬浮球。",
  "参数：question 是要用户拍板的问题；options 是 2～6 个选项；header 可选，是面板上的小标题。",
  "需要推荐某个选项时，把它放在第一项，并在 label 末尾加 (Recommended)。",
].join("\n");

export const parameters = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "需要用户选择的问题，直接写问题本身，尽量简洁。",
    },
    options: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      description: "候选选项 2～6 个；每项包含简短 label，可带一句 description 说明影响。",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "选项文字，简短清楚。" },
          description: { type: "string", description: "可选，一句话说明这个选项。" },
        },
        required: ["label"],
      },
    },
    header: {
      type: "string",
      description: "可选，面板顶部的小标题，例如「确认」或「选模式」。",
    },
  },
  required: ["question", "options"],
};

function resolveSession(ctx) {
  let sessionPath = typeof ctx?.sessionPath === "string" ? ctx.sessionPath : "";
  let sessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId : "";
  if (!sessionPath && ctx?.sessionRef && typeof ctx.sessionRef === "object") {
    sessionPath = ctx.sessionRef.sessionPath || ctx.sessionRef.path || "";
    sessionId = sessionId || ctx.sessionRef.sessionId || "";
  }
  // 某些旧调用上下文只给 agentId；只在能明确按 agentId 找到会话时兜底，避免猜错会话。
  if (!sessionPath && sessionId && !sessionId.startsWith("sess_")) {
    sessionPath = findLatestSessionPath(sessionId);
  }
  return { sessionId, sessionPath };
}

export async function execute(input, ctx) {
  const dataDir = ctx?.dataDir;
  const cfg = getConfig(dataDir);
  if (cfg.presentation !== "ball") {
    return {
      content: [{ type: "text", text: "（解语花当前不是悬浮球模式，弹窗用不了；那就当作普通对话，直接在正文里自然说出你的看法或把需要用户决定的内容写清楚，不要强行列选项让人选。" }],
    };
  }
  if (!(await isZhujianPresentationRunning(ctx))) {
    return {
      content: [{ type: "text", text: "（解语花或融合悬浮球没有运行，提问面板弹不出来；没关系，这次就当作普通对话，直接在正文里自然回应，把判断/解释/观点说清楚，不要为了想弹窗而把话题硬拗成选项让用户选。）" }],
    };
  }

  const question = typeof input?.question === "string" ? input.question.trim() : "";
  const options = Array.isArray(input?.options) ? input.options : [];
  const header = typeof input?.header === "string" ? input.header.trim() : "";
  const error = validateAskInput({ question, options, header });
  if (error) {
    return { content: [{ type: "text", text: `提问参数有问题：${error}` }] };
  }

  const { sessionId, sessionPath } = resolveSession(ctx || {});
  if (!sessionPath) {
    return {
      content: [{ type: "text", text: "暂时找不到当前会话，提问面板没有弹出；请直接在正文里说明需要用户决定的内容。" }],
    };
  }

  try {
    await createAskPending(dataDir, {
      question,
      options,
      header,
      sessionId,
      sessionPath,
    });
    return {
      content: [{
        type: "text",
        text: `已弹出提问面板：${question}\n等待用户作答；不要在正文里重复提问。`,
      }],
    };
  } catch (err) {
    ctx?.log?.error?.("[解语花] 创建提问失败", { error: err?.message || String(err) });
    return { content: [{ type: "text", text: `提问面板打开失败：${err?.message || "请稍后再试"}` }] };
  }
}
