// 解语花「另一枝」— Hana 原生会话 fork 桥接
// 只负责调用宿主已有 fork 路由，不复制会话历史，也不切换主窗口。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const DEFAULT_TIMEOUT_MS = 10000;

export class ForkError extends Error {
  constructor(code, message, { status = 0, details = null } = {}) {
    super(message);
    this.name = "ForkError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function normalizeForkTarget(target) {
  const role = target?.role;
  if (role === "assistant_turn") {
    const turnInputEntryId = String(target.turnInputEntryId || "").trim();
    if (!turnInputEntryId) {
      throw new ForkError("invalid_target", "缺少助手回合的输入节点");
    }
    return { role, turnInputEntryId };
  }
  if (role === "user" || role === "assistant") {
    const entryId = String(target.entryId || "").trim();
    if (!entryId) {
      throw new ForkError("invalid_target", "缺少消息节点");
    }
    return { role, entryId };
  }
  throw new ForkError("invalid_target", "分叉目标不受支持");
}

export function readServerInfo(serverInfoPath = path.join(HANA_HOME, "server-info.json")) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(serverInfoPath, "utf-8"));
  } catch (err) {
    throw new ForkError("server_info_unavailable", "Hana 服务信息读取失败", { details: err?.message || String(err) });
  }

  const port = Number(raw?.port);
  const token = typeof raw?.token === "string" ? raw.token.trim() : "";
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
    throw new ForkError("server_info_invalid", "Hana 服务信息不完整");
  }
  return { port, token };
}

function errorCodeFromPayload(payload, status) {
  const raw = [
    payload?.code,
    payload?.errorCode,
    payload?.error?.code,
    typeof payload?.error === "string" ? payload.error : "",
    payload?.message,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/session_busy|session is busy|busy/.test(raw)) return "session_busy";
  if (/session_fork_active_task|active_task|active task|后台任务/.test(raw)) return "session_fork_active_task";
  if (/not.?found|不存在|归档/.test(raw) || status === 404) return "session_not_found";
  if (/invalid|node|target|entry|turn|节点|分叉/.test(raw)) return "invalid_target";
  return status >= 500 ? "fork_server_error" : "fork_failed";
}

async function readResponsePayload(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return {};
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function sessionIdFromPath(sessionPath) {
  const name = path.basename(String(sessionPath || ""));
  const match = name.match(/^(sess_[^_]+)/);
  return match ? match[1] : "";
}

export function parseForkResponse(payload, sourceSessionPath, target) {
  if (!payload || payload.ok === false) {
    throw new ForkError(errorCodeFromPayload(payload, 200), String(payload?.message || payload?.error || "fork 失败"), { details: payload });
  }
  const branchSessionPath = String(payload.sessionPath || payload.path || "").trim();
  if (!branchSessionPath) {
    throw new ForkError("fork_invalid_response", "Hana 没有返回分支会话路径", { details: payload });
  }
  return {
    sourceSessionPath,
    sourceSessionId: String(payload.sourceSessionId || sessionIdFromPath(sourceSessionPath)),
    branchSessionPath,
    branchSessionId: String(payload.sessionId || sessionIdFromPath(branchSessionPath)),
    forkedFromEntryId: String(payload.forkedFromEntryId || ""),
    target,
    sessionFiles: payload.sessionFiles || null,
  };
}

export async function forkBranch({
  sessionPath,
  target,
  serverInfoPath = path.join(HANA_HOME, "server-info.json"),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const sourceSessionPath = String(sessionPath || "").trim();
  if (!sourceSessionPath) throw new ForkError("session_not_found", "没有找到要分叉的对话");
  const normalizedTarget = normalizeForkTarget(target);
  if (typeof fetchImpl !== "function") throw new ForkError("fork_network", "当前环境没有可用的网络请求能力");

  const { port, token } = readServerInfo(serverInfoPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  let response;
  try {
    response = await fetchImpl(
      `http://127.0.0.1:${port}/api/sessions/fork?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionPath: sourceSessionPath, target: normalizedTarget }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    const code = err?.name === "AbortError" ? "fork_timeout" : "fork_network";
    throw new ForkError(code, code === "fork_timeout" ? "分支创建超时" : "Hana 分支接口暂时连不上", { details: err?.message || String(err) });
  } finally {
    clearTimeout(timer);
  }

  const payload = await readResponsePayload(response);
  if (!response?.ok || payload?.ok === false) {
    const code = errorCodeFromPayload(payload, Number(response?.status) || 0);
    throw new ForkError(code, String(payload?.message || payload?.error || "fork 失败"), {
      status: Number(response?.status) || 0,
      details: payload,
    });
  }
  return parseForkResponse(payload, sourceSessionPath, normalizedTarget);
}

export function friendlyForkError(error) {
  const code = error?.code || "";
  if (code === "session_busy") return "当前回合还没结束，等小花回复完再另开一枝";
  if (code === "session_fork_active_task") return "这条消息还有后台任务没收完，等任务完成或选更早一条";
  if (code === "session_not_found") return "这段对话已经不存在或已归档";
  if (code === "invalid_target") return "找不到可分叉的已完成回合，等小花回复完再试";
  if (code === "server_info_unavailable" || code === "server_info_invalid") return "Hana 服务信息不可用，重启 Hana 后再试";
  if (code === "fork_timeout" || code === "fork_network") return "Hana 分支接口暂时连不上，再试一次";
  if (code === "fork_invalid_response") return "Hana 没有返回有效的分支会话";
  return "另开一枝失败，再试一次";
}
