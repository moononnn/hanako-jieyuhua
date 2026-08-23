// 解语花 — 另一枝聊天窗后端测试（node:test，零依赖）
// 覆盖：分支历史读取（带时间戳）、分支列表摘要、发消息（mock bus 记录 session:send）、
//      分支不存在 / 消息校验等错误路径

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBranchRef, listBranchRefs } from "../lib/data.js";
import { branchHistoryPayload, branchListPayload, chatToBranch, proxyPathname } from "../lib/zhujian.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-branch-"));
}

// 写一条会话条目（新格式：{ type, timestamp, message: { role, content } }）
function writeEntry(fp, role, text, ts) {
  fs.appendFileSync(
    fp,
    JSON.stringify({ type: "message", timestamp: new Date(ts).toISOString(), message: { role, content: text } }) + "\n",
    "utf-8",
  );
}

// 造一个 dataDir + 分支引用 + 分支会话文件（带 4 条历史）
async function makeBranchEnv() {
  const dataDir = tmpDir();
  const agentDir = path.join(dataDir, "agents", "hanako", "sessions");
  fs.mkdirSync(agentDir, { recursive: true });
  const sourcePath = path.join(agentDir, "sess_main_abc.jsonl");
  const branchPath = path.join(agentDir, "sess_branch_xyz.jsonl");
  writeEntry(sourcePath, "user", "主线第一句", 1700000000000);
  writeEntry(sourcePath, "assistant", "主线回复", 1700000001000);

  const t0 = 1700000000000;
  writeEntry(branchPath, "user", "支线第一句", t0);
  writeEntry(branchPath, "assistant", "支线回复一", t0 + 1000);
  writeEntry(branchPath, "user", "支线第二句", t0 + 2000);
  writeEntry(branchPath, "assistant", "支线回复二", t0 + 3000);

  const branch = await createBranchRef(dataDir, {
    sourceSessionPath: sourcePath,
    sourceSessionId: "sess_main_abc",
    sourceNode: { role: "assistant_turn", turnInputEntryId: "e1" },
    branchSessionPath: branchPath,
    branchSessionId: "sess_branch_xyz",
    title: "另一枝",
    status: "active",
  });
  return { dataDir, branch, branchPath, sourcePath };
}

// ═══ 分支历史 ═══

test("本地代理带查询串时仍匹配分支历史路由路径", () => {
  assert.equal(proxyPathname("/branch/history?branchId=branch_test"), "/branch/history");
});

test("branchHistoryPayload 返回分支会话全部消息（按时间正序，带 ts）", async () => {
  const { dataDir, branch } = await makeBranchEnv();
  const result = await branchHistoryPayload(dataDir, branch.id);
  assert.equal(result.ok, true);
  assert.equal(result.messages.length, 4);
  assert.deepEqual(result.messages[0], { role: "user", content: "支线第一句", ts: 1700000000000 });
  assert.equal(result.messages[3].role, "assistant");
  assert.equal(result.messages[3].content, "支线回复二");
  assert.equal(result.messages[3].ts, 1700000003000);
});

test("branchHistoryPayload 超限时只返回最近 limit 条", async () => {
  const { dataDir, branch } = await makeBranchEnv();
  const result = await branchHistoryPayload(dataDir, branch.id);
  assert.ok(result.messages.length <= 200);
});

test("branchHistoryPayload 分支不存在返回 404", async () => {
  const { dataDir } = await makeBranchEnv();
  const result = await branchHistoryPayload(dataDir, "branch_nope");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test("branchHistoryPayload 分支会话文件丢失返回 400", async () => {
  const { dataDir, branch } = await makeBranchEnv();
  fs.unlinkSync(branch.branchSessionPath);
  const result = await branchHistoryPayload(dataDir, branch.id);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

// ═══ 分支列表 ═══

test("branchListPayload 返回分支列表并带最后一条用户消息摘要", async () => {
  const { dataDir, branch } = await makeBranchEnv();
  const result = await branchListPayload(dataDir);
  assert.equal(result.ok, true);
  assert.equal(result.branches.length, 1);
  const item = result.branches[0];
  assert.equal(item.id, branch.id);
  assert.equal(item.title, "另一枝");
  assert.equal(item.preview, "支线第二句");
  assert.ok(item.lastTs > 0);
  assert.equal(item.branchSessionId, "sess_branch_xyz");
});

test("branchListPayload 空列表返回空数组", async () => {
  const result = await branchListPayload(tmpDir());
  assert.equal(result.ok, true);
  assert.deepEqual(result.branches, []);
});

// ═══ 发消息 ═══

test("chatToBranch 往分支会话发送消息（mock bus 收到 session:send）", async () => {
  const { dataDir, branch } = await makeBranchEnv();
  const sent = [];
  const bus = {
    request: async (method, payload) => {
      sent.push({ method, payload });
      return { ok: true };
    },
  };
  const result = await chatToBranch(dataDir, bus, { branchId: branch.id, text: "支线第三句" });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "session:send");
  assert.equal(sent[0].payload.text, "支线第三句");
  assert.equal(sent[0].payload.sessionPath, branch.branchSessionPath);
});

test("chatToBranch 会话忙时重试后成功", async () => {
  const { dataDir, branch } = await makeBranchEnv();
  let calls = 0;
  const bus = {
    request: async () => {
      calls++;
      if (calls === 1) throw new Error("session is busy");
      return { ok: true };
    },
  };
  const result = await chatToBranch(dataDir, bus, { branchId: branch.id, text: "再试一次" }, [1, 1, 1]);
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test("chatToBranch 连续忙到超限返回失败", async () => {
  const { dataDir, branch } = await makeBranchEnv();
  const bus = {
    request: async () => {
      throw new Error("session is busy");
    },
  };
  const result = await chatToBranch(dataDir, bus, { branchId: branch.id, text: "一直忙" }, [1, 1, 1]);
  assert.equal(result.ok, false);
  assert.match(result.error, /busy/i);
});

test("chatToBranch 空消息/超长消息被拒", async () => {
  const { dataDir, branch } = await makeBranchEnv();
  const bus = { request: async () => ({ ok: true }) };
  assert.equal((await chatToBranch(dataDir, bus, { branchId: branch.id, text: "   " })).ok, false);
  assert.equal((await chatToBranch(dataDir, bus, { branchId: branch.id, text: "x".repeat(501) })).ok, false);
  assert.equal((await chatToBranch(dataDir, bus, { branchId: "", text: "hi" })).ok, false);
});

test("chatToBranch 分支不存在返回 404", async () => {
  const { dataDir } = await makeBranchEnv();
  const bus = { request: async () => ({ ok: true }) };
  const result = await chatToBranch(dataDir, bus, { branchId: "branch_nope", text: "hi" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test("chatToBranch 无消息通道返回 500", async () => {
  const { dataDir, branch } = await makeBranchEnv();
  const result = await chatToBranch(dataDir, null, { branchId: branch.id, text: "hi" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});

