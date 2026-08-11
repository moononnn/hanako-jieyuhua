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

export default function (pi) {
  appendLog("[启动] 解语花注入扩展加载（context 事件模式）");

  pi.on("context", async (event) => {
    try {
      const cfg = readConfig();
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
