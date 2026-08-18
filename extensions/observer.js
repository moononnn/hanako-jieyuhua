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
    if (!fs.existsSync(fp)) return { presentation: "card", mode: "always" };
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return {
      presentation: data.config?.presentation === "ball" ? "ball" : data.config?.presentation === "off" ? "off" : "card",
      mode: data.config?.mode === "always" ? "always" : "auto"
    };
  } catch {
    return { presentation: "card", mode: "auto" };
  }
}

// 用户消息尾部的行动提示（通道 B）
// v6（2026-08-06）：实测 v4/v5「先写正文最后调工具」对 deepseek-v4-flash 不稳定——
// 模型 thinking 里计划了调用，但最终输出只写文本就结束，toolCall 被吞。
// 模型默认「先调工具再写正文」模式执行稳定，v6 顺应模型习惯：先调工具，后写正文。
const ALWAYS_NUDGE = "\n\n💡 请先调用 suggest_replies 工具生成推荐回复（在写正文之前），然后再正常写你的回复正文。推荐卡片会自动显示，正文里不需要提及它。";
const AUTO_NUDGE = "\n\n💡 如果你觉得这轮回复后用户可能还想继续聊：先调用 suggest_replies 工具生成推荐回复（在写正文之前），然后再写回复正文。";

// system 消息（通道 A）
const ALWAYS_SYSTEM = "（解语花）写正文之前，先调用 suggest_replies 工具生成推荐回复，然后再写正文。";
const AUTO_SYSTEM = "（解语花）如果这轮回复后用户可能还想继续聊：写正文之前，先调用 suggest_replies 工具。";

// ── ask 引导（悬浮球模式专用） ──
// ball 模式下不注入 suggest_replies（悬浮球自己管推荐区），但 ask_user_choice
// 没有别的提示通道：工具描述只在工具列表里，flash 模型在长工具列表里容易漏
//（2026-08-16 实测实锤：其他助手会话需要拍板却纯文本提问，弹窗没出现）。
// 这里注入一条条件式引导，让所有助手的会话（不只小花）需要拍板时都能想起调用它。
const ASK_NUDGE = "\n\n💡 如果这轮需要用户拍板、做选择或确认方向：写正文之前，先调用 ask_user_choice 工具，把问题和选项传进去（悬浮球会弹出提问面板）。";
const ASK_SYSTEM = "（解语花）如果这轮需要用户拍板或选择：写正文前先调用 ask_user_choice 工具，让悬浮球弹出提问面板。";

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
  const nudge = isAlways ? ALWAYS_NUDGE : AUTO_NUDGE;
  const sysMsg = isAlways ? ALWAYS_SYSTEM : AUTO_SYSTEM;

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

  pi.on("context", async (event) => {
    try {
      // 隐式跳过检测独立于注入：悬浮球模式（presentation=ball）下也生效
      await handleAskAutoSkip(event);

      const cfg = readConfig();
      if (cfg.presentation === "ball") {
        // 悬浮球模式：不注入推荐引导（悬浮球自己管），但注入拍板引导，
        // 否则其他助手的会话里没有任何提示通道，flash 模型想不起 ask 工具。
        const msgCount = event?.messages?.length || 0;
        if (msgCount === 0) return;
        if (injectAsk(event)) {
          appendLog(`[context] ✅ 已注入 ask 引导（ball）`);
          return { messages: event.messages };
        }
        appendLog("[context] 注入失败（没找到可注入的位置）");
        return;
      }
      if (cfg.presentation !== "card") {
        appendLog(`[context] 已跳过（presentation=${cfg.presentation}）`);
        return;
      }
      const msgCount = event?.messages?.length || 0;
      if (msgCount === 0) return;

      if (inject(event, cfg)) {
        appendLog(`[context] ✅ 已注入（${cfg.mode}），messages=${msgCount} → ${event.messages.length}`);
        return { messages: event.messages };
      }
      appendLog("[context] 注入失败（没找到可注入的位置）");
    } catch (e) {
      appendLog(`[context] ❌ 出错: ${e?.message || e}`);
    }
  });

  pi.on("agent_end", () => {
    appendLog("[agent_end] 回合结束");
  });
}
