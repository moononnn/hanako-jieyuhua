// 解语花 — API Key 存储
// Windows 使用 DPAPI（CurrentUser）保护落盘；enc: 只为旧版本存量兼容，
// 非 Windows 或 DPAPI 不可用时诚实退回明文，不把 XOR/Base64 当成新安全方案。

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const LEGACY_SALT = Buffer.from("jiegehua-key-obfuscation-2026", "utf-8");
const DPAPI_PREFIX = "dpapi:";
const LEGACY_PREFIX = "enc:";

const PS_PROTECT = `
Add-Type -AssemblyName System.Security
$b = [Text.Encoding]::UTF8.GetBytes($env:DPAPI_PLAIN)
$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')
[Convert]::ToBase64String($e)`;

const PS_UNPROTECT = `
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String($env:DPAPI_STORED)
$d = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($d)`;

const dpapiCache = new Map();

function xorLegacy(plain) {
  const buf = Buffer.from(String(plain), "utf-8");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 1) out[i] = buf[i] ^ LEGACY_SALT[i % LEGACY_SALT.length];
  return out;
}

// 仅供读取旧版 enc: 存量，以及兼容旧测试/迁移逻辑；新写入不要调用它。
export function encryptLegacyKey(plain) {
  if (!plain) return "";
  return LEGACY_PREFIX + xorLegacy(plain).toString("base64");
}

export function decryptLegacyKey(stored) {
  if (!stored) return "";
  const value = String(stored);
  if (!value.startsWith(LEGACY_PREFIX)) return value;
  const body = value.slice(LEGACY_PREFIX.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0) return value;
  try {
    const buf = Buffer.from(body, "base64");
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i += 1) out[i] = buf[i] ^ LEGACY_SALT[i % LEGACY_SALT.length];
    return out.toString("utf-8");
  } catch {
    return value;
  }
}

export function getStorageMode(stored) {
  const value = String(stored || "");
  if (!value) return "none";
  if (value.startsWith(DPAPI_PREFIX)) return "dpapi";
  if (value.startsWith(LEGACY_PREFIX)) return "legacy";
  return "plain";
}

export function isDpapiAvailable() {
  return process.platform === "win32";
}

async function dpapiProtect(plain) {
  const { stdout } = await execFileP(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", PS_PROTECT],
    {
      env: { ...process.env, DPAPI_PLAIN: String(plain) },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  const body = String(stdout || "").trim();
  if (!body) return "";
  dpapiCache.set(body, String(plain));
  return DPAPI_PREFIX + body;
}

async function dpapiUnprotect(body) {
  const value = String(body || "");
  if (dpapiCache.has(value)) return dpapiCache.get(value);
  const { stdout } = await execFileP(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", PS_UNPROTECT],
    {
      env: { ...process.env, DPAPI_STORED: value },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  const plain = String(stdout || "").trim();
  if (plain) dpapiCache.set(value, plain);
  return plain;
}

export async function protectKey(plain) {
  const value = String(plain || "");
  if (!value) return "";
  if (isDpapiAvailable()) {
    try {
      const protectedValue = await dpapiProtect(value);
      if (protectedValue) return protectedValue;
    } catch {
      // DPAPI 不可用时走诚实的明文兜底；调用方会通过 storageMode 提示用户。
    }
  }
  return value;
}

export async function unprotectKey(stored) {
  const value = String(stored || "");
  if (!value) return "";
  if (value.startsWith(DPAPI_PREFIX)) {
    if (!isDpapiAvailable()) return "";
    try {
      return await dpapiUnprotect(value.slice(DPAPI_PREFIX.length));
    } catch {
      return "";
    }
  }
  return decryptLegacyKey(value);
}

// 页面只需要知道“已保存”，不回传前缀、首尾字符或任何可复原材料。
export function maskKey(stored) {
  return stored ? "********" : "";
}

export { DPAPI_PREFIX, LEGACY_PREFIX };
