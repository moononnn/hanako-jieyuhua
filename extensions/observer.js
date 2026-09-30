// 解语花 — Pi SDK Extension（对话注入）
// 参考表情包插件生产验证过的注入姿势（2026-08-06 实测修正）：
//   工厂签名：export default function (pi) { pi.on('context', handler) }
//   事件名：'context'（LLM 调用前）
//   注入：双通道 = system 消息 + 用户消息尾部行动提示（💡 风格）
//   返回：{ messages: event.messages }（修改后的消息包在对象里返回）
//
// 模式：
//   auto（看情况）：软引导，让助手自己判断这轮适不适合出推荐
//   always（每次都）：强制引导，每轮回复末尾都出推荐
//
// 注入只发生在请求层，不写入会话文件；debug 日志写在插件数据目录

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listAskPending, queueAskSkip } from "../lib/data.js";
import { lastUserMessageTs } from "../lib/session.js";
import { supportsInteractiveCard } from "../lib/suggestion-card.js";
import { isZhujianPresentationRunning } from "../lib/zhujian.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const DATA_DIR = path.join(HANA_HOME, "plugin-data", "jiegehua");
const DEBUG_LOG = path.join(DATA_DIR, "observer-debug.log");
// 日志轮转：超过 500KB 截断保留后半段（防无限膨胀，表情包同款思路）
const MAX_LOG_SIZE = 500 * 1024;

function appendLog(entry) {
  try {
    try {
      const stat = fs.statSync(DEBUG_LOG);
      if (stat.size > MAX_LOG_SIZE) {
        const content = fs.readFileSync(DEBUG_LOG, "utf-8");
        fs.writeFileSync(DEBUG_LOG, content.slice(Math.floor(content.length / 2)), "utf-8");
      }
    } catch {}
    const line = `[${new Date().toISOString()}] ${entry}\n`;
    fs.appendFileSync(DEBUG_LOG, line, "utf-8");
  } catch {}
}

function readConfig() {
  try {
    const fp = path.join(DATA_DIR, "data.json");
    if (!fs.existsSync(fp)) return { presentation: "card", mode: "always", replySummaryFrequency: "standard" };
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const summaryFrequency = ["less", "standard", "more"].includes(data.config?.replySummaryFrequency)
      ? data.config.replySummaryFrequency
      : "standard";
    return {
      presentation: data.config?.presentation === "ball" ? "ball" : data.config?.presentation === "off" ? "off" : "card",
      mode: data.config?.mode === "always" ? "always" : "auto",
      replySummaryFrequency: summaryFrequency,
    };
  } catch {
    return { presentation: "card", mode: "auto", replySummaryFrequency: "standard" };
  }
}

function readHanaAppVersion() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(HANA_HOME, "server-info.json"), "utf8"));
    return typeof info?.version === "string" ? info.version : "";
  } catch {
    return "";
  }
}

export function shouldInjectAskGuidance(presentation, running) {
  return presentation === "ball" && running === true;
}

function cardGuidance() {
  if (supportsInteractiveCard(readHanaAppVersion())) {
    return {
      alwaysNudge: "\n\n💡 请先正常写完你的回复正文，正文结束后调用 suggest_replies 生成推荐数据；工具返回后，立即调用内置 show_card，把它返回的参数原样传入。show_card 必须是最后一步，正文里不需要提及卡片。",
      autoNudge: "\n\n💡 如果你觉得这轮回复后用户可能还想继续聊：请先正常写完回复正文，之后调用 suggest_replies；工具返回后立即调用内置 show_card，把返回参数原样传入，且让 show_card 作为最后一步。",
      alwaysSystem: "（解语花）请先写完正文；正文结束后调用 suggest_replies，随后立即调用内置 show_card 原样传入工具返回参数。show_card 必须是最后一步，才能得到真正的内联卡片。",
      autoSystem: "（解语花）如果这轮回复后用户可能还想继续聊：请先写完正文，调用 suggest_replies 后立即调用内置 show_card；show_card 必须是最后一步。",
    };
  }
  return {
    alwaysNudge: "\n\n💡 请先正常写完你的回复正文，正文结束后调用 suggest_replies 生成推荐数据；工具会自动把推荐卡片附在回复下方，正文里不需要提及卡片。",
    autoNudge: "\n\n💡 如果你觉得这轮回复后用户可能还想继续聊：请先正常写完回复正文，之后调用 suggest_replies；工具会自动把推荐卡片附在回复下方。",
    alwaysSystem: "（解语花）请先写完正文；正文结束后调用 suggest_replies，工具会自动附上推荐卡片，不需要调用其他卡片工具。",
    autoSystem: "（解语花）如果这轮回复后用户可能还想继续聊：请先写完正文，之后调用 suggest_replies；旧版宿主会自动附上推荐卡片。",
  };
}

// ── ask 引导（悬浮球模式专用） ──
// ball 模式下不注入 suggest_replies（悬浮球自己管推荐区），但 ask_user_choice
// 没有别的提示通道：工具描述只在工具列表里，flash 模型在长工具列表里容易漏
//（2026-08-16 实测实锤：其他助手会话需要拍板却纯文本提问，弹窗没出现）。
// 这里注入一条条件式引导，让所有助手的会话（不只小花）需要拍板时都能想起调用它。
// 2026-08-22 修正：措辞优先级从「写正文之前先弹」改为「先自然写完正文、确实需要拍板再弹」。
// 实测（deepseek-v4-flash-vision-exp，各 3 遍）：改前后该拍板命中率都 100%，
// 但改前弹窗时正文空 6/9（模型一弹窗就不说话），改后正文空 0/9。
// 病灶是「弹窗优先」那句教模型把弹窗当正事、可选可无。
// 2026-08-22 二次修正：加意图分流，禁止把「想了解/想判断」话题改写成选择题。
// 实测：普通对话（解释/判断/闲聊）全部不弹窗且保留正文，拍板场景仍稳定弹窗。
const ASK_NUDGE = "\n\n💡 先看用户这轮是「想了解/想判断」还是「要你拍板」。前者是普通对话，直接清楚回答，绝不包装成选项让人选；只有用户明确让你在几个选项里选定、确认要不要做时，才调用 ask_user_choice 弹出提问面板。先自然写完正文，别为弹窗打断，也别把话题硬抛成选择题。";
const ASK_SYSTEM = "（解语花）先判断用户这轮的真实意图：\n- 用户在问知识、要解释、要你判断或给看法：直接清楚回答，这是普通对话，不要弹窗。\n- 用户在闲聊、倾诉、分享：自然接话就好，不要弹窗。\n- 只有用户明确让你在几个选项里选定、确认要不要做某件事、或明确让你帮他拍板时：才调用 ask_user_choice 弹出提问面板。\n绝不把「想了解/想判断」的话题改写成选择题来让用户选。先自然写完正文，确实需要拍板再弹窗。";

const REPLY_SUMMARY_TRIGGER = Object.freeze({
  less: "大约 800 字以上，或明显需要展开很多层步骤、层次或条件",
  standard: "大约 500 字以上，或需要展开多个步骤、层次或条件",
  more: "大约 300 字以上，或已经有几个需要分别说明的重点",
});

function replySummaryInstructions(frequency) {
  const trigger = REPLY_SUMMARY_TRIGGER[frequency] || REPLY_SUMMARY_TRIGGER.standard;
  const nudge = `\n\n💡 如果你这轮的回答正文达到「${trigger}」的程度，请先完整写完正文；若要加速览，必须放在全文最后，并逐字使用这一行标题，不能缩成「速览」或漏掉「解语花」：\n> **🌸 解语花 · 回复速览**\n速览只写最重要的结论，按需补用户下一步、重要限制或尚未确认之处，最多三条短要点；不要把次要细节全部抄一遍。短答、闲聊、用户明确要求简洁、或主要内容是代码时不要加。`;
  const system = `（解语花·回复速览）只有当本轮正文达到「${trigger}」的程度，且速览确实能帮助用户回看重点时才添加；短答、闲聊、用户明确要求简洁或主要内容是代码时不要添加。档位只是近似判断，不要为了凑字数或满足格式硬加。若添加，必须先完整写完回答正文，再把速览放在正文之后，作为整条回复最后一个内容；不能用速览替代、缩短或省略正文。若无法同时满足，保留完整正文并省略速览。\n标题必须逐字使用这一行，不得简写、换成「速览/总结/小结」或漏掉「解语花」：\n> **🌸 解语花 · 回复速览**\n正文用一句话概括最重要的结论或完成结果；其余最多补两条最有价值的信息，优先选择用户需要做的下一步、重要限制或未确认事项。不要罗列次要过程细节或无行动价值的数字；正文里的猜测仍标为猜测，不得写成事实。总计最多三条短要点，不要求填满。\n速览用 Markdown 引用块，标题和每条要点都要在引用块内；只压缩本轮正文，不添加新信息，不丢失关键条件、限制或不确定性。若本轮需输出 <mood> 块，仍让它保持最前；速览必须在完整正文结束之后，且不要总结 <mood> 内容。速览块后不要再添加其他正文。不要提及这是系统提示或注入规则。`;
  return { nudge, system };
}

function injectReplySummary(event, frequency = "standard") {
  if (!Array.isArray(event?.messages)) return false;
  let lastUserIdx = -1;
  for (let i = event.messages.length - 1; i >= 0; i--) {
    if (event.messages[i]?.role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return false;
  const instructions = replySummaryInstructions(frequency);
  event.messages.push({ role: "system", content: instructions.system });
  const userMsg = event.messages[lastUserIdx];
  if (typeof userMsg.content === "string") {
    userMsg.content += instructions.nudge;
  } else if (Array.isArray(userMsg.content)) {
    userMsg.content.push({ type: "text", text: instructions.nudge });
  }
  return true;
}

function injectAsk(event) {
  if (!Array.isArray(event?.messages)) return false;
  event.messages.push({ role: "system", content: ASK_SYSTEM });
  let lastUserIdx = -1;
  for (let i = event.messages.length - 1; i >= 0; i--) {
    if (event.messages[i]?.role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return false;
  const userMsg = event.messages[lastUserIdx];
  if (typeof userMsg.content === "string") {
    userMsg.content += ASK_NUDGE;
  } else if (Array.isArray(userMsg.content)) {
    userMsg.content.push({ type: "text", text: ASK_NUDGE });
  }
  return true;
}

function inject(event, cfg) {
  const isAlways = cfg.mode === "always";
  const guidance = cardGuidance();
  const nudge = isAlways ? guidance.alwaysNudge : guidance.autoNudge;
  const sysMsg = isAlways ? guidance.alwaysSystem : guidance.autoSystem;

  // 通道 A：system 消息
  if (Array.isArray(event?.messages)) {
    event.messages.push({ role: "system", content: sysMsg });
  } else {
    return false;
  }

  // 通道 B：最后一条用户消息尾部追加行动提示
  let lastUserIdx = -1;
  for (let i = event.messages.length - 1; i >= 0; i--) {
    if (event.messages[i]?.role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return false;

  const userMsg = event.messages[lastUserIdx];
  if (typeof userMsg.content === "string") {
    userMsg.content += nudge;
  } else if (Array.isArray(userMsg.content)) {
    userMsg.content.push({ type: "text", text: nudge });
  }
  return true;
}

// ── 隐式跳过：用户无视提问面板、直接在对话框继续交流时自动跳过 ──
// 判断依据：存在未作答提问，且当前这轮不是弹窗作答触发的回合
//（作答回合的消息里带「# 提问卡片」回传）。登记到跳过队列后，
// 代理在悬浮球轮询时回传「跳过，不做选择」并收起弹窗。
const recentAskSkips = new Map(); // askId -> ts
const ASK_SKIP_DEBOUNCE_MS = 60_000;

function messagesContainAskCard(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  // 弹窗作答回传（deferred resolve 注入）一定是最新追加的消息，只检查末尾最近 2 条。
  // 扫全量历史会让任意历史消息里的「# 提问卡片」字样（如工具结果里的源码、助手正文）
  // 把每一轮 context 都误判成「作答回合」，隐式跳过检测被永久短路（2026-08-18 实机踩坑）。
  for (const msg of messages.slice(-2)) {
    const content = msg?.content;
    if (typeof content === "string" && content.includes("# 提问卡片")) return true;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && typeof part.text === "string" && part.text.includes("# 提问卡片")) {
          return true;
        }
      }
    }
  }
  return false;
}

async function handleAskAutoSkip(event) {
  try {
    if (messagesContainAskCard(event?.messages)) return; // 这轮就是弹窗作答，不动
    const pending = listAskPending(DATA_DIR);
    if (!pending.length) return;
    const now = Date.now();
    for (const entry of pending) {
      const askId = entry.askId;
      if (!askId || !entry.sessionPath) continue;
      // 只看提问归属会话本身：用户是否在提问窗口里发了新消息（晚于提问创建）。
      // 用户在别的窗口忙不会误判；提问窗口有新的用户消息才算无视。
      const lastUserTs = lastUserMessageTs(entry.sessionPath);
      if (!lastUserTs || lastUserTs <= (entry.ts || 0)) continue;
      const last = recentAskSkips.get(askId);
      if (last && now - last < ASK_SKIP_DEBOUNCE_MS) continue;
      recentAskSkips.set(askId, now);
      await queueAskSkip(DATA_DIR, askId);
      appendLog(`[ask] 提问会话出现新用户消息（${lastUserTs} > ${entry.ts}），隐式跳过: ${askId}`);
    }
  } catch (e) {
    appendLog(`[ask] 隐式跳过检测出错: ${e?.message || e}`);
  }
}

export default function (pi) {
  appendLog("[启动] 解语花注入扩展加载（context 事件模式）");

  pi.on("context", async (event, ctx) => {
    try {
      // 隐式跳过检测独立于注入：悬浮球模式（presentation=ball）下也生效
      await handleAskAutoSkip(event);

      const cfg = readConfig();
      if (cfg.presentation === "off") {
        appendLog("[context] 已跳过（presentation=off）");
        return;
      }
      const msgCount = event?.messages?.length || 0;
      if (msgCount === 0) return;
      const summaryInjected = injectReplySummary(event, cfg.replySummaryFrequency);

      if (cfg.presentation === "ball") {
        // 速览与悬浮球运行状态无关；拍板引导仍只在原版悬浮球或融合球运行时注入。
        const running = await isZhujianPresentationRunning(ctx);
        if (!shouldInjectAskGuidance(cfg.presentation, running)) {
          appendLog(`[context] ${summaryInjected ? "已注入回复速览引导；" : ""}已跳过 ask 引导（悬浮球/融合悬浮球未运行）`);
          return summaryInjected ? { messages: event.messages } : undefined;
        }
        if (injectAsk(event)) {
          appendLog(`[context] ✅ 已注入 ask 引导（ball，running=${running}）${summaryInjected ? "与回复速览引导" : ""}`);
          return { messages: event.messages };
        }
        appendLog("[context] 注入 ask 引导失败（没找到可注入的位置）");
        return summaryInjected ? { messages: event.messages } : undefined;
      }
      if (cfg.presentation !== "card") {
        appendLog(`[context] 已跳过未知展示方式（presentation=${cfg.presentation}）`);
        return summaryInjected ? { messages: event.messages } : undefined;
      }

      if (inject(event, cfg)) {
        appendLog(`[context] ✅ 已注入（${cfg.mode}），messages=${msgCount} → ${event.messages.length}`);
        return { messages: event.messages };
      }
      if (summaryInjected) return { messages: event.messages };
      appendLog("[context] 注入失败（没找到可注入的位置）");
    } catch (e) {
      appendLog(`[context] ❌ 出错: ${e?.message || e}`);
    }
  });

  pi.on("agent_end", () => {
    appendLog("[agent_end] 回合结束");
  });
}
