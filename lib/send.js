// 解语花 — 推荐发送核心（卡片页与悬浮球共用）
// 原子性：写锁内检查 used + 预标记，发送失败回滚（防双击/并发重复发送）
// 通道：bus.request("session:send", { text, sessionId })（闲不住生产验证过的同款通道）

import { loadData, saveData, withDataLock } from "./data.js";

export async function claimAndSend(dataDir, { rid, index }, bus) {
  if (!rid || !Number.isInteger(index) || index < 0 || index > 3) {
    return { ok: false, error: "参数不完整" };
  }

  // 写锁内：校验存在 + 未用 + index 有效，同时预标记 used
  let text = "";
  const claimed = await withDataLock(() => {
    const data = loadData(dataDir);
    const e = data.pending[rid];
    if (!e || e.used) return false;
    const item = Array.isArray(e.items) ? e.items[index] : null;
    if (!item || typeof item.text !== "string") return false;
    const t = item.text.trim();
    if (!t || t.length > 500) return false;
    text = t;
    e.used = true;
    saveData(dataDir, data);
    return true;
  });
  if (!claimed) return { ok: false, error: "这条推荐已失效，重新生成一下吧" };

  if (!bus || typeof bus.request !== "function") {
    await rollbackUsed(dataDir, rid);
    return { ok: false, error: "消息通道不可用" };
  }

  const entry = getEntry(dataDir, rid);
  const sessionId = entry?.sessionId || "";
  const sessionPath = entry?.sessionPath || "";
  if (!sessionId && !sessionPath) {
    await rollbackUsed(dataDir, rid);
    return { ok: false, error: "找不到目标会话，换新窗口再试" };
  }

  const payload = { text, sessionId: sessionId || undefined, sessionPath: sessionPath || undefined };

  // 会话忙（流式输出中）时等待重试：2s / 5s / 10s，最多 3 次（闲不住同款）
  const delays = [2000, 5000, 10000];
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await bus.request("session:send", payload);
        break;
      } catch (e) {
        const busy = /busy/i.test(e?.message || String(e));
        if (!busy || attempt >= delays.length) throw e;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  } catch (err) {
    await rollbackUsed(dataDir, rid);
    return { ok: false, error: err?.message || "发送失败" };
  }

  return { ok: true, message: "已发送", text };
}

// ─── 发送失败回滚 used 标记 ───
function rollbackUsed(dataDir, rid) {
  return withDataLock(() => {
    const data = loadData(dataDir);
    if (data.pending && data.pending[rid]) {
      data.pending[rid].used = false;
      saveData(dataDir, data);
    }
  });
}

function getEntry(dataDir, rid) {
  return loadData(dataDir).pending[rid] || null;
}

// ─── 取推荐文本（复制模式用，不标记 used） ───
export function getSuggestionText(dataDir, { rid, index }) {
  if (!rid || !Number.isInteger(index) || index < 0 || index > 3) {
    return { ok: false, error: "参数不完整" };
  }
  const entry = getEntry(dataDir, rid);
  const item = entry && Array.isArray(entry.items) ? entry.items[index] : null;
  if (!item || typeof item.text !== "string") {
    return { ok: false, error: "这条推荐已失效，重新生成一下吧" };
  }
  const t = item.text.trim();
  if (!t || t.length > 500) return { ok: false, error: "推荐内容异常" };
  return { ok: true, text: t };
}
