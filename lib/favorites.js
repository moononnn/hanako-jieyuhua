// lib/favorites.js — 解语花「朗读收藏」
// 收藏的音视频文件直接存插件数据目录（tts-favorites/），列表存独立 json，
// 以后点开直接播本地文件，不重新合成（零额度）。
// 存储约定：
//   dataDir/tts-favorites.json      → { items: [{id,text,format,voiceId,createdAt,file}] }
//   dataDir/tts-favorites/<id>.ext  → 音频文件（mp3/wav）
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

function favListFile(dataDir) {
  return join(dataDir, "tts-favorites.json");
}
function favDir(dataDir) {
  return join(dataDir, "tts-favorites");
}

function loadFavs(dataDir) {
  for (const fp of [favListFile(dataDir), favListFile(dataDir) + ".bak"]) {
    try {
      const raw = readFileSync(fp, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.items)) return parsed.items;
    } catch {}
  }
  return [];
}

function saveFavs(dataDir, items) {
  mkdirSync(dataDir, { recursive: true });
  const fp = favListFile(dataDir);
  const bak = fp + ".bak";
  const tmp = `${fp}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let oldMoved = false;
  try {
    writeFileSync(tmp, JSON.stringify({ items }, null, 2), "utf-8");
    if (existsSync(fp)) {
      try { rmSync(bak, { force: true }); } catch {}
      renameSync(fp, bak);
      oldMoved = true;
    }
    renameSync(tmp, fp);
  } catch (error) {
    if (oldMoved && !existsSync(fp) && existsSync(bak)) {
      try { renameSync(bak, fp); } catch {}
    }
    throw error;
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

const idChars = "abcdefghijklmnopqrstuvwxyz0123456789";
function newId() {
  let s = "";
  for (let i = 0; i < 10; i++) s += idChars[Math.floor(Math.random() * idChars.length)];
  return s;
}

// 新增收藏：text + audio(base64) + 格式 + 音色 + 来源助手。返回新增条目。
export function saveFavorite(dataDir, { text, audio, format = "mp3", voiceId = "", agentId = "" }) {
  const t = String(text || "").trim();
  const a = String(audio || "");
  if (!t || !a) return null;
  const ext = format === "wav" ? "wav" : "mp3";
  const items = loadFavs(dataDir);
  // 完全相同的文本不再重复收藏（避免刷屏）
  const dup = items.find((it) => it.text === t);
  if (dup) return null;
  const id = newId();
  const file = id + "." + ext;
  mkdirSync(favDir(dataDir), { recursive: true });
  writeFileSync(join(favDir(dataDir), file), Buffer.from(a, "base64"));
  const item = { id, text: t.slice(0, 2000), format: ext, voiceId: String(voiceId || ""), agentId: String(agentId || ""), createdAt: Date.now(), file };
  items.unshift(item);
  saveFavs(dataDir, items);
  return item;
}

export function listFavorites(dataDir) {
  return loadFavs(dataDir);
}

// 按来源助手分组（组内保持原顺序最新在前；组间按组内最新收藏倒序）。
// nameOf：Map/对象，agentId → 显示名；没有 agentId 的旧收藏归到「其他」。
export function groupFavorites(items, nameOf) {
  const nameMap = nameOf instanceof Map ? nameOf : new Map(Object.entries(nameOf || {}));
  const groups = [];
  const byAgent = new Map();
  for (const it of items || []) {
    const key = String(it?.agentId || "");
    if (!byAgent.has(key)) {
      const group = {
        agentId: key,
        agentName: key ? nameMap.get(key) || key : "其他",
        items: [],
      };
      byAgent.set(key, group);
      groups.push(group);
    }
    byAgent.get(key).items.push(it);
  }
  groups.sort((a, b) => (b.items[0]?.createdAt || 0) - (a.items[0]?.createdAt || 0));
  return groups;
}

export function favoriteFile(dataDir, id) {
  const items = loadFavs(dataDir);
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  const p = join(favDir(dataDir), it.file);
  return existsSync(p) ? p : null;
}

export function deleteFavorite(dataDir, id) {
  const items = loadFavs(dataDir);
  const idx = items.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  const [removed] = items.splice(idx, 1);
  try {
    unlinkSync(join(favDir(dataDir), removed.file));
  } catch {}
  saveFavs(dataDir, items);
  return true;
}

// 清理孤儿文件：列表里已删除/不存在于列表的音频文件（安全，供外部调用）
export function pruneOrphanFiles(dataDir, log) {
  const items = loadFavs(dataDir);
  const seen = new Set(items.map((x) => x.file));
  let removed = 0;
  try {
    for (const f of readdirSync(favDir(dataDir))) {
      if (!seen.has(f)) {
        try {
          unlinkSync(join(favDir(dataDir), f));
          removed++;
        } catch {}
      }
    }
  } catch {}
  return removed;
}
