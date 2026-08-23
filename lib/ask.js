// 解语花 — 提问卡片纯函数与约束
// UI 在樱花悬浮球里，Deferred 回传文本由这里统一构造，避免工具/路由各写一份。

export const ASK_TTL_MS = 24 * 60 * 60 * 1000;
export const ASK_MAX_PENDING = 10;
export const ASK_INPUT_MAX_LENGTH = 200;

const QUESTION_MAX_LENGTH = 600;
const HEADER_MAX_LENGTH = 80;
const OPTION_LABEL_MAX_LENGTH = 120;
const OPTION_DESCRIPTION_MAX_LENGTH = 300;

export function normalizeAskOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    if (!option || typeof option !== "object") return null;
    const label = typeof option.label === "string" ? option.label.trim() : "";
    const description = typeof option.description === "string" ? option.description.trim() : "";
    if (!label) return null;
    return { label, ...(description ? { description } : {}) };
  }).filter(Boolean);
}

export function validateAskInput({ question, options, header } = {}) {
  const q = typeof question === "string" ? question.trim() : "";
  if (!q) return "问题不能为空";
  if (q.length > QUESTION_MAX_LENGTH) return `问题太长了，最多 ${QUESTION_MAX_LENGTH} 字`;
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
    return "选项需要 2～6 个";
  }

  const labels = new Set();
  for (const option of options) {
    if (!option || typeof option !== "object") return "选项格式不正确";
    const label = typeof option.label === "string" ? option.label.trim() : "";
    const description = typeof option.description === "string" ? option.description.trim() : "";
    if (!label) return "每个选项都要有文字";
    if (label.length > OPTION_LABEL_MAX_LENGTH) return `选项文字最多 ${OPTION_LABEL_MAX_LENGTH} 字`;
    if (labels.has(label)) return "选项不能重复";
    labels.add(label);
    if (description.length > OPTION_DESCRIPTION_MAX_LENGTH) {
      return `选项说明最多 ${OPTION_DESCRIPTION_MAX_LENGTH} 字`;
    }
  }

  if (header !== undefined && header !== null) {
    if (typeof header !== "string") return "面板小标题格式不正确";
    if (header.trim().length > HEADER_MAX_LENGTH) return `面板小标题最多 ${HEADER_MAX_LENGTH} 字`;
  }
  return null;
}

function normalizeAskDelivery(raw) {
  if (!raw || typeof raw !== "object") return null;
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  if (!taskId) return null;
  return {
    taskId,
    mode: typeof raw.mode === "string" ? raw.mode : "option",
    choice: typeof raw.choice === "string" ? raw.choice : "",
    resultText: typeof raw.resultText === "string" ? raw.resultText : "",
    registered: raw.registered === true,
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
  };
}

export function normalizeAskEntry(raw, fallbackAskId = "") {
  if (!raw || typeof raw !== "object") return null;
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  const options = normalizeAskOptions(raw.options);
  const header = typeof raw.header === "string" ? raw.header.trim() : "";
  const ts = Number.isFinite(raw.ts) ? Number(raw.ts) : 0;
  const askId = typeof raw.askId === "string" && raw.askId ? raw.askId : fallbackAskId;
  if (!askId || !question || !options.length || ts <= 0 || validateAskInput({ question, options, header })) return null;
  return {
    askId,
    question,
    options,
    header,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
    sessionPath: typeof raw.sessionPath === "string" ? raw.sessionPath : "",
    ts,
    consumed: raw.consumed === true,
    answer: raw.answer && typeof raw.answer === "object" ? raw.answer : null,
    delivery: normalizeAskDelivery(raw.delivery),
  };
}

export function validateAskResponse(entry, mode, choice) {
  const selectedMode = mode === "custom" || mode === "skip" ? mode : "option";
  if (!entry || !Array.isArray(entry.options)) return { error: "提问不存在或已失效" };
  if (selectedMode === "skip") return { mode: selectedMode, choice: "" };

  const text = typeof choice === "string" ? choice.trim() : "";
  if (!text) return { error: "请选择一个选项或填写自定义答案" };
  if (selectedMode === "custom" && text.length > ASK_INPUT_MAX_LENGTH) {
    return { error: `自定义答案最多 ${ASK_INPUT_MAX_LENGTH} 字` };
  }
  if (selectedMode === "option" && !entry.options.some((option) => option.label === text)) {
    return { error: "这个选项已失效，请重新打开提问" };
  }
  return { mode: selectedMode, choice: text };
}

export function buildAskAnswerText(entry, choice, mode) {
  const selectedMode = mode === "custom" || mode === "skip" ? mode : "option";
  const answer = selectedMode === "skip" ? "跳过，不做选择" : String(choice || "").trim();
  return [
    "# 提问卡片",
    "",
    "## 问题",
    String(entry?.question || "").trim(),
    "",
    "## 回答",
    answer,
  ].join("\n");
}
