// 解语花 — 压缩档案（只读）
//
// 会话被 Hana 压缩后，摘要作为 type === "compaction" 条目落在会话 JSONL 里，
// 主界面不渲染它，用户只看得到「上下文压缩中」。本模块把这个条目读出来，
// 让悬浮球把「模型当前看到的历史概要」摊给用户看。
//
// 纪律：
//   1. 只读，绝不写会话文件；
//   2. 不调模型，打开即显示，零消耗；
//   3. 流式分块扫描，不把整份会话读进内存（长期会话文件可达几十 MB）。

import fs from "node:fs";

const CHUNK_SIZE = 1024 * 1024;
const MAX_SUMMARY_CHARS = 60000; // 单条摘要返回上限，防御异常长摘要
const MAX_ITEMS = 60; // 档案列表上限，防御异常多的压缩记录

// 快筛正则：不解析整行 JSON，先按类型字段定位，只有命中才 parse。
const RE_MESSAGE = /"type"\s*:\s*"message"/;
const RE_COMPACTION = /"type"\s*:\s*"compaction"/;

// ─── 流式扫描会话文件，收集全部压缩条目与 message 条目总数 ───
function scanSession(sessionPath) {
  const compactions = [];
  let messageCount = 0;

  const stat = fs.statSync(sessionPath);
  if (!stat.size) return { compactions, messageCount };

  const fd = fs.openSync(sessionPath, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK_SIZE);
    let position = 0;
    // 跨块的不完整行：按字节保留，拼完整后再转 utf8，避免把多字节字符截成乱码
    let pending = [];
    let pendingSize = 0;

    const handleLine = (line) => {
      if (!line) return;
      if (RE_MESSAGE.test(line)) {
        messageCount += 1;
        return;
      }
      if (!RE_COMPACTION.test(line)) return;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (!entry || entry.type !== "compaction") return;
      compactions.push({
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
        tokensBefore: Number.isFinite(entry.tokensBefore) ? entry.tokensBefore : null,
        summary: typeof entry.summary === "string" ? entry.summary : "",
        firstKeptEntryId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : "",
        messageCountAt: messageCount,
      });
    };

    while (position < stat.size) {
      const want = Math.min(CHUNK_SIZE, stat.size - position);
      const read = fs.readSync(fd, buf, 0, want, position);
      if (read <= 0) break;
      position += read;

      let start = 0;
      for (let i = 0; i < read; i++) {
        if (buf[i] !== 0x0a) continue;
        const tail = buf.subarray(start, i);
        const line = pendingSize
          ? Buffer.concat([...pending, tail]).toString("utf8")
          : tail.toString("utf8");
        handleLine(line.trim());
        pending = [];
        pendingSize = 0;
        start = i + 1;
      }
      if (start < read) {
        const rest = Buffer.from(buf.subarray(start, read));
        pending.push(rest);
        pendingSize += rest.length;
      }
    }

    if (pendingSize) handleLine(Buffer.concat(pending).toString("utf8").trim());
  } finally {
    fs.closeSync(fd);
  }

  return { compactions, messageCount };
}

// ─── 对外：读一个会话的压缩档案 ───
// index：0 = 最近一次压缩，往前递增（历史快照）
export function readCompactionArchive(sessionPath, { index = 0 } = {}) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return { ok: false, status: 404, error: "这段对话的会话文件不在了" };
  }

  let scanned;
  try {
    scanned = scanSession(sessionPath);
  } catch (err) {
    return { ok: false, status: 500, error: `读会话失败：${err?.message || err}` };
  }

  const { compactions, messageCount } = scanned;
  if (!compactions.length) {
    return { ok: true, compacted: false, count: 0, items: [], entry: null, verbatim: null };
  }

  // 最新的在前，方便面板「往前翻」
  const ordered = compactions.slice().reverse();
  // 档案条目只给元信息，正文按需取，避免一次回传几十万字
  const items = ordered.slice(0, MAX_ITEMS).map((item, i) => ({
    index: i,
    timestamp: item.timestamp,
    tokensBefore: item.tokensBefore,
    summaryChars: item.summary.length,
  }));

  const pickedIndex = Math.max(0, Math.min(Math.trunc(index) || 0, ordered.length - 1));
  const picked = ordered[pickedIndex];
  const latest = ordered[0];

  return {
    ok: true,
    compacted: true,
    count: ordered.length,
    index: pickedIndex,
    items,
    entry: {
      index: pickedIndex,
      timestamp: picked.timestamp,
      tokensBefore: picked.tokensBefore,
      summaryChars: picked.summary.length,
      summary: picked.summary.slice(0, MAX_SUMMARY_CHARS),
      truncated: picked.summary.length > MAX_SUMMARY_CHARS,
      keptEntryId: picked.firstKeptEntryId,
    },
    // 只有最近一次压缩之后的原文还留在模型视野里；更早的已被后续压缩覆盖
    verbatim: pickedIndex === 0
      ? { entries: Math.max(0, messageCount - latest.messageCountAt) }
      : null,
  };
}
