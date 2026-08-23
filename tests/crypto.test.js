// 解语花凭据存储回归：DPAPI 主通道 + enc:/明文旧数据兼容 + 页面脱敏

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptLegacyKey,
  decryptLegacyKey,
  protectKey,
  unprotectKey,
  maskKey,
  getStorageMode,
} from "../lib/crypto.js";

test("旧 enc: 存量仍可解密，但脱敏不暴露首尾片段", async () => {
  const plain = "sk-legacy-very-secret-123";
  const stored = encryptLegacyKey(plain);
  assert.match(stored, /^enc:/);
  assert.equal(decryptLegacyKey(stored), plain);
  assert.equal(await unprotectKey(stored), plain);
  assert.equal(maskKey(stored), "********");
  assert.equal(getStorageMode(stored), "legacy");
});

test("DPAPI/明文主通道可往返，文件与 API 不需要回传明文", async () => {
  const plain = "sk-special-&|$-secret-987";
  const stored = await protectKey(plain);
  assert.equal(await unprotectKey(stored), plain);
  assert.equal(maskKey(stored), "********");
  if (process.platform === "win32") assert.match(stored, /^dpapi:/);
  else assert.equal(stored, plain);
});

test("旧明文配置可读并能在 Windows 上迁移为 DPAPI", async () => {
  const plain = "plain-old-key";
  assert.equal(await unprotectKey(plain), plain);
  const migrated = await protectKey(await unprotectKey(plain));
  if (process.platform === "win32") assert.match(migrated, /^dpapi:/);
  else assert.equal(migrated, plain);
});
