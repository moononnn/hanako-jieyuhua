// 接个话 — 助手显示名解析测试（node:test，零依赖）
// 覆盖：agentDisplayName 读 config.yaml 的 agent.name、引号清洗、
//      无 agent 块时回退、读不到时回退 agentId、空值返回空
//
// 注意：session.js 在模块加载时读 HANA_HOME，本文件必须先建好测试目录
// 再用动态 import 加载（独立进程，不与其他测试文件共享模块缓存）。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jiegehua-displayname-"));
process.env.HANA_HOME = tmp;

const agentsDir = path.join(tmp, "agents");
fs.mkdirSync(path.join(agentsDir, "hanako"), { recursive: true });
fs.writeFileSync(
  path.join(agentsDir, "hanako", "config.yaml"),
  "agent:\n  name: 小花\n  yuan: hanako\n",
  "utf-8"
);

fs.mkdirSync(path.join(agentsDir, "quoted"), { recursive: true });
fs.writeFileSync(
  path.join(agentsDir, "quoted", "config.yaml"),
  'agent:\n  name: "带引号"\n',
  "utf-8"
);

fs.mkdirSync(path.join(agentsDir, "plain"), { recursive: true });
fs.writeFileSync(
  path.join(agentsDir, "plain", "config.yaml"),
  "name: 裸name\n",
  "utf-8"
);

// 干扰项：agent 块之外出现 name（模拟未来 yaml 结构变化），不应被误读
fs.mkdirSync(path.join(agentsDir, "distract"), { recursive: true });
fs.writeFileSync(
  path.join(agentsDir, "distract", "config.yaml"),
  "api:\n  provider: deepseek\nagent:\n  name: 正主\n  yuan: xxx\nbridge:\n  name: 干扰\n",
  "utf-8"
);

const { agentDisplayName, listAgents } = await import("../lib/session.js");

test("agentDisplayName 读 config.yaml 的 agent.name", () => {
  assert.equal(agentDisplayName("hanako"), "小花");
});

test("agentDisplayName 清洗 YAML 字符串引号", () => {
  assert.equal(agentDisplayName("quoted"), "带引号");
});

test("agentDisplayName 无 agent 块时回退整文件 name 匹配", () => {
  assert.equal(agentDisplayName("plain"), "裸name");
});

test("agentDisplayName 只认 agent 块内的 name，不误读其他块", () => {
  assert.equal(agentDisplayName("distract"), "正主");
});

test("agentDisplayName 读不到配置时回退 agentId", () => {
  assert.equal(agentDisplayName("ghost"), "ghost");
});

test("agentDisplayName 空值返回空串", () => {
  assert.equal(agentDisplayName(""), "");
});

test("listAgents 刷新时扫描助手目录并返回显示名", () => {
  const list = listAgents();
  assert.deepEqual(list.map((item) => item.id), ["distract", "hanako", "plain", "quoted"]);
  assert.equal(list.find((item) => item.id === "hanako").name, "小花");
});
