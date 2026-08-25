// 解语花 — 提问卡片纯函数与约束
// UI 在樱花悬浮球里，Deferred 回传文本由这里统一构造，避免工具/路由各写一份。

export const ASK_TTL_MS = 24 * 60 * 60 * 1000;
export const ASK_MAX_PENDING = 10;
export const ASK_INPUT_MAX_LENGTH = 200;

const QUESTION_MAX_LENGTH = 600;
const HEADER_MAX_LENGTH = 80;
const OPTION_LABEL_MAX_LENGTH = 120;
const OPTION_DESCRIPTION_MAX_LENGTH = 300;
const ASK_SELECTION_MODES = new Set(["single", "multiple"]);

function hasSelectionValue(value) {
  return value !== undefined && value !== null && value !== "";
}

export function normalizeAskSelection({ selectionMode, minSelections, maxSelections } = {}, optionCount = 0) {
  const mode = selectionMode === "multiple" ? "multiple" : "single";
  if (mode === "single") {
    return { selectionMode: "single", minSelections: 1, maxSelections: 1 };
  }
  return {
    selectionMode: "multiple",
    minSelections: Number.isInteger(minSelections) ? minSelections : 1,
    maxSelections: Number.isInteger(maxSelections) ? maxSelections : optionCount,
  };
}

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

export function validateAskInput({
  question,
  options,
  header,
  selectionMode,
  minSelections,
  maxSelections,
} = {}) {
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

  const mode = selectionMode === undefined || selectionMode === null || selectionMode === ""
    ? "single"
    : selectionMode;
  if (!ASK_SELECTION_MODES.has(mode)) return "选择模式只能是 single 或 multiple";
  if (mode === "single") {
    if (hasSelectionValue(minSelections) && minSelections !== 1) return "单选题的最少选择数只能是 1";
    if (hasSelectionValue(maxSelections) && maxSelections !== 1) return "单选题的最多选择数只能是 1";
  } else {
    const min = hasSelectionValue(minSelections) ? minSelections : 1;
    const max = hasSelectionValue(maxSelections) ? maxSelections : options.length;
    if (!Number.isInteger(min) || min < 1) return "多选题至少要允许选择 1 项";
    if (!Number.isInteger(max) || max < 1) return "多选题最多要允许选择 1 项";
    if (max > options.length) return `最多选择数不能超过选项数量（${options.length}）`;
    if (min > max) return "多选题的最少选择数不能超过最多选择数";
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
  const choice = Array.isArray(raw.choice)
    ? raw.choice.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : typeof raw.choice === "string" ? raw.choice : "";
  return {
    taskId,
    mode: typeof raw.mode === "string" ? raw.mode : "option",
    choice,
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
  const selectionError = validateAskInput({
    question,
    options,
    header,
    selectionMode: raw.selectionMode,
    minSelections: raw.minSelections,
    maxSelections: raw.maxSelections,
  });
  if (!askId || !question || !options.length || ts <= 0 || selectionError) return null;
  const selection = normalizeAskSelection(raw, options.length);
  return {
    askId,
    question,
    options,
    header,
    ...selection,
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
  if (selectedMode === "custom") {
    if (!text) return { error: "请选择一个选项或填写自定义答案" };
    if (text.length > ASK_INPUT_MAX_LENGTH) {
      return { error: `自定义答案最多 ${ASK_INPUT_MAX_LENGTH} 字` };
    }
    return { mode: selectedMode, choice: text };
  }

  const selection = normalizeAskSelection(entry, entry.options.length);
  const labels = new Set(entry.options.map((option) => option.label));
  if (selection.selectionMode === "multiple") {
    const choices = Array.isArray(choice) ? choice : typeof choice === "string" ? [choice] : [];
    const selected = choices.map((item) => typeof item === "string" ? item.trim() : "");
    if (selected.some((item) => !item)) return { error: "多选答案里有空选项" };
    if (new Set(selected).size !== selected.length) return { error: "多选答案不能重复" };
    if (selected.length < selection.minSelections) {
      return { error: `至少选择 ${selection.minSelections} 项` };
    }
    if (selected.length > selection.maxSelections) {
      return { error: `最多选择 ${selection.maxSelections} 项` };
    }
    if (selected.some((item) => !labels.has(item))) {
      return { error: "这个选项已失效，请重新打开提问" };
    }
    return { mode: selectedMode, choice: selected };
  }

  if (Array.isArray(choice)) {
    if (choice.length !== 1) return { error: "这道题只能选择一个选项" };
    return validateAskResponse(entry, selectedMode, choice[0]);
  }
  if (!text) return { error: "请选择一个选项或填写自定义答案" };
  if (!labels.has(text)) return { error: "这个选项已失效，请重新打开提问" };
  return { mode: selectedMode, choice: text };
}

export function buildAskAnswerText(entry, choice, mode) {
  const selectedMode = mode === "custom" || mode === "skip" ? mode : "option";
  const answer = selectedMode === "skip"
    ? "跳过，不做选择"
    : Array.isArray(choice)
      ? choice.map((item) => String(item || "").trim()).filter(Boolean).map((item) => `- ${item}`).join("\n")
      : String(choice || "").trim();
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
