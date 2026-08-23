// 解语花 — 朗读收藏自动测试（node:test 零依赖）
// 覆盖：保存（写音频文件+登记列表）、同文本去重、删除（同步删文件）、空安全、孤儿清理
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  saveFavorite,
  listFavorites,
  favoriteFile,
  deleteFavorite,
  pruneOrphanFiles,
  groupFavorites,
} from "../lib/favorites.js";

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), "jgh-fav-"));
}

test("saveFavorite：保存音频文件并登记列表", () => {
  const dir = tmpDir();
  const it = saveFavorite(dir, { text: "你好呀，今天天气真好", audio: Buffer.from("hello").toString("base64"), format: "mp3", voiceId: "female-shaonv" });
  assert.ok(it && it.id);
  assert.equal(it.format, "mp3");
  // 音频文件落盘
  const file = path.join(dir, "tts-favorites", it.file);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, "utf-8"), "hello");
  // 列表可读
  const list = listFavorites(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "你好呀，今天天气真好");
  rmSync(dir, { recursive: true, force: true });
});

test("saveFavorite：记录来源助手 agentId，没传默认为空", () => {
  const dir = tmpDir();
  const it = saveFavorite(dir, { text: "小花说的", audio: Buffer.from("x").toString("base64"), format: "mp3", agentId: "hanako" });
  assert.equal(it.agentId, "hanako");
  const it2 = saveFavorite(dir, { text: "没带助手的", audio: Buffer.from("y").toString("base64"), format: "mp3" });
  assert.equal(it2.agentId, "");
  assert.equal(listFavorites(dir).length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("groupFavorites：按助手分组、旧收藏归其他、组间最新在前", async () => {
  const dir = tmpDir();
  const sleep = () => new Promise((r) => setTimeout(r, 5));
  saveFavorite(dir, { text: "a1", audio: Buffer.from("a").toString("base64"), agentId: "hanako" });
  await sleep();
  saveFavorite(dir, { text: "b1", audio: Buffer.from("b").toString("base64"), agentId: "yumi" });
  await sleep();
  saveFavorite(dir, { text: "c1", audio: Buffer.from("c").toString("base64"), agentId: "" });
  await sleep();
  saveFavorite(dir, { text: "a2", audio: Buffer.from("d").toString("base64"), agentId: "hanako" });
  const groups = groupFavorites(listFavorites(dir), new Map([["hanako", "小花"], ["yumi", "阿柚"]]));
  // 组间按组内最新收藏倒序：hanako（a2 最后存）→ 其他（c1 次新）→ yumi（b1 最旧）
  assert.equal(groups.length, 3);
  assert.equal(groups[0].agentId, "hanako");
  assert.equal(groups[0].agentName, "小花");
  assert.deepEqual(groups[0].items.map((x) => x.text), ["a2", "a1"]);
  assert.equal(groups[1].agentId, "");
  assert.equal(groups[1].agentName, "其他");
  assert.equal(groups[1].items.length, 1);
  assert.equal(groups[2].agentId, "yumi");
  assert.equal(groups[2].agentName, "阿柚");
  assert.equal(groups[2].items.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("groupFavorites：名字表里没有的助手 id 直接显示 id", () => {
  const groups = groupFavorites(
    [{ id: "x1", text: "t", agentId: "ghost", createdAt: 1 }],
    new Map()
  );
  assert.equal(groups[0].agentName, "ghost");
});

test("saveFavorite：完全相同的文本不重复收藏", () => {
  const dir = tmpDir();
  saveFavorite(dir, { text: "重复的话", audio: Buffer.from("a").toString("base64"), format: "mp3" });
  const dup = saveFavorite(dir, { text: "重复的话", audio: Buffer.from("b").toString("base64"), format: "mp3" });
  assert.equal(dup, null);
  assert.equal(listFavorites(dir).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("saveFavorite：空文本或空音频不入库", () => {
  const dir = tmpDir();
  assert.equal(saveFavorite(dir, { text: "  ", audio: "xxx" }), null);
  assert.equal(saveFavorite(dir, { text: "有字没音频", audio: "" }), null);
  assert.equal(listFavorites(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("saveFavorite：wav 格式落对应扩展名", () => {
  const dir = tmpDir();
  const it = saveFavorite(dir, { text: "wav 格式", audio: Buffer.from("w").toString("base64"), format: "wav" });
  assert.equal(it.format, "wav");
  assert.ok(it.file.endsWith(".wav"));
  rmSync(dir, { recursive: true, force: true });
});

test("deleteFavorite：删列表条目并删音频文件", () => {
  const dir = tmpDir();
  const it = saveFavorite(dir, { text: "待删除", audio: Buffer.from("d").toString("base64"), format: "mp3" });
  assert.ok(favoriteFile(dir, it.id));
  assert.equal(deleteFavorite(dir, it.id), true);
  assert.equal(listFavorites(dir).length, 0);
  assert.equal(favoriteFile(dir, it.id), null);
  assert.ok(!existsSync(path.join(dir, "tts-favorites", it.file)));
  rmSync(dir, { recursive: true, force: true });
});

test("deleteFavorite：id 不存在返回 false", () => {
  const dir = tmpDir();
  assert.equal(deleteFavorite(dir, "nope"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("listFavorites：无文件/损坏文件都返回空不炸", () => {
  const dir = tmpDir();
  assert.deepEqual(listFavorites(dir), []);
  writeFileSync(path.join(dir, "tts-favorites.json"), "{ broken", "utf-8");
  assert.deepEqual(listFavorites(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("pruneOrphanFiles：清掉列表里不存在的孤儿音频", () => {
  const dir = tmpDir();
  const it = saveFavorite(dir, { text: "留着", audio: Buffer.from("k").toString("base64"), format: "mp3" });
  // 塞一个孤儿文件
  writeFileSync(path.join(dir, "tts-favorites", "orphan.mp3"), "x");
  assert.equal(readdirSync(path.join(dir, "tts-favorites")).length, 2);
  const removed = pruneOrphanFiles(dir);
  assert.equal(removed, 1);
  assert.ok(existsSync(path.join(dir, "tts-favorites", it.file)));
  assert.ok(!existsSync(path.join(dir, "tts-favorites", "orphan.mp3")));
  rmSync(dir, { recursive: true, force: true });
});
