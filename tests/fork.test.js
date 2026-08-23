// 解语花「另一枝」— fork 桥接测试（node:test，零依赖）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ForkError,
  friendlyForkError,
  forkBranch,
  normalizeForkTarget,
  parseForkResponse,
  readServerInfo,
} from "../lib/fork.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-fork-"));
  return path.join(dir, "server-info.json");
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

function writeInfo(file, port, token) {
  fs.writeFileSync(file, JSON.stringify({ port, token }), "utf-8");
}

test("normalizeForkTarget 支持 user / assistant / assistant_turn 三种目标", () => {
  assert.deepEqual(normalizeForkTarget({ role: "user", entryId: "u1" }), { role: "user", entryId: "u1" });
  assert.deepEqual(normalizeForkTarget({ role: "assistant", entryId: "a1" }), { role: "assistant", entryId: "a1" });
  assert.deepEqual(
    normalizeForkTarget({ role: "assistant_turn", turnInputEntryId: "u2" }),
    { role: "assistant_turn", turnInputEntryId: "u2" },
  );
  assert.throws(() => normalizeForkTarget({ role: "assistant_turn" }), (err) => err.code === "invalid_target");
});

test("fork 每次调用现读 server-info.json，token 轮换后不使用旧值", async () => {
  const info = tmpFile();
  writeInfo(info, 1234, "token-a");
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options: JSON.parse(options.body) });
    return response({ ok: true, sessionPath: "C:/sessions/sess_child-a.jsonl", sessionId: "sess_child-a" });
  };

  await forkBranch({
    sessionPath: "C:/sessions/sess_parent.jsonl",
    target: { role: "assistant_turn", turnInputEntryId: "u1" },
    serverInfoPath: info,
    fetchImpl: fakeFetch,
  });
  writeInfo(info, 5678, "token-b");
  await forkBranch({
    sessionPath: "C:/sessions/sess_parent.jsonl",
    target: { role: "assistant_turn", turnInputEntryId: "u2" },
    serverInfoPath: info,
    fetchImpl: fakeFetch,
  });

  assert.match(calls[0].url, /127\.0\.0\.1:1234\/api\/sessions\/fork\?token=token-a/);
  assert.match(calls[1].url, /127\.0\.0\.1:5678\/api\/sessions\/fork\?token=token-b/);
  assert.equal(calls[1].options.target.turnInputEntryId, "u2");
});

test("fork 成功响应规范化分支引用", async () => {
  const info = tmpFile();
  writeInfo(info, 4321, "secret");
  const result = await forkBranch({
    sessionPath: "C:/sessions/sess_parent_2026.jsonl",
    target: { role: "assistant_turn", turnInputEntryId: "u9" },
    serverInfoPath: info,
    fetchImpl: async () => response({
      ok: true,
      path: "C:/sessions/sess_child_2026.jsonl",
      sessionId: "sess_child_2026",
      sourceSessionId: "sess_parent_2026",
      forkedFromEntryId: "u9",
      sessionFiles: { fileIdMap: {} },
    }),
  });
  assert.equal(result.branchSessionPath, "C:/sessions/sess_child_2026.jsonl");
  assert.equal(result.branchSessionId, "sess_child_2026");
  assert.equal(result.sourceSessionId, "sess_parent_2026");
  assert.equal(result.forkedFromEntryId, "u9");
  assert.deepEqual(result.sessionFiles, { fileIdMap: {} });
});

test("fork 错误映射为用户能看懂的提示", async () => {
  const info = tmpFile();
  writeInfo(info, 4321, "secret");
  const cases = [
    ["session_busy", "当前回合还没结束"],
    ["session_fork_active_task", "后台任务"],
    ["session_not_found", "不存在或已归档"],
  ];
  for (const [code, phrase] of cases) {
    await assert.rejects(
      forkBranch({
        sessionPath: "C:/sessions/sess_parent.jsonl",
        target: { role: "assistant_turn", turnInputEntryId: "u1" },
        serverInfoPath: info,
        fetchImpl: async () => response({ ok: false, code, message: code }, 409),
      }),
      (err) => {
        assert.equal(err.code, code);
        assert.match(friendlyForkError(err), new RegExp(phrase));
        return true;
      },
    );
  }
});

test("server-info 缺失或损坏时不发起请求", () => {
  const missing = path.join(os.tmpdir(), "jiegehua-no-server-info.json");
  assert.throws(() => readServerInfo(missing), (err) => err instanceof ForkError && err.code === "server_info_unavailable");
  const invalid = tmpFile();
  fs.writeFileSync(invalid, JSON.stringify({ port: 0, token: "" }), "utf-8");
  assert.throws(() => readServerInfo(invalid), (err) => err instanceof ForkError && err.code === "server_info_invalid");
});

test("parseForkResponse 拒绝没有分支路径的响应", () => {
  assert.throws(
    () => parseForkResponse({ ok: true }, "C:/sessions/sess_parent.jsonl", { role: "assistant_turn", turnInputEntryId: "u1" }),
    (err) => err.code === "fork_invalid_response",
  );
});
