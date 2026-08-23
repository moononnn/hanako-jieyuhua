// lib/play.js — 解语花「语音朗读」试听的后端播放
//
// 背景（2026-08-18 实机踩坑）：Hana 插件页面跑在 webview iframe 里，
// 前端 new Audio(...).play() 会被 autoplay 策略拒绝（play() promise reject，
// 试听永远"播放失败"）。正确姿势是后端生成音频后写临时文件、由系统播放器出声，
// 照提个醒插件 notify.ps1 的成熟方案：
//   wav  → .NET SoundPlayer.PlaySync（最稳）
//   mp3  → WinRT MediaPlayer（系统解码器；播完停在 Paused 不是 Ended，
//          判断要认 Paused + 已到末尾，超时兜底）

import { spawn } from "node:child_process";

let currentChild = null;

// 播放音频文件；format: "wav" | "mp3"（其他按 mp3 处理）
// 返回 Promise，播放进程退出后 resolve（wav 同步播完；mp3 轮询到播完或超时）
// 新试听会停掉上一次还在播的（防叠加）
export function playAudioFile(filePath, format) {
  return new Promise((resolve) => {
    try {
      if (currentChild && !currentChild.killed) {
        try { currentChild.kill(); } catch {}
      }
    } catch {}

    const script = format === "wav" ? buildWavScript(filePath) : buildMp3Script(filePath);
    let child;
    try {
      child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      resolve();
      return;
    }
    currentChild = child;

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve();
    }, 300000);

    child.on("exit", () => {
      clearTimeout(timer);
      if (currentChild === child) currentChild = null;
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timer);
      if (currentChild === child) currentChild = null;
      resolve();
    });
  });
}

// 停止正在播的（面板收起/新试听时用）
export function stopPlaying() {
  try {
    if (currentChild && !currentChild.killed) currentChild.kill();
  } catch {}
  currentChild = null;
}

function buildWavScript(filePath) {
  const p = String(filePath).replace(/'/g, "''");
  return `$sp = New-Object System.Media.SoundPlayer('${p}'); $sp.PlaySync(); $sp.Dispose();`;
}

function buildMp3Script(filePath) {
  const uri = "file:///" + String(filePath).replace(/\\/g, "/");
  // WinRT MediaPlayer 的自然结束状态可能停在 Paused，不认 Ended 会一直空转；
  // 按 NaturalDuration/Position 判断，未知时长再用 300 秒硬上限，不能把所有音频截成 20 秒。
  return [
    "[Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime] | Out-Null",
    "$mp = [Windows.Media.Playback.MediaPlayer]::new()",
    `$mp.Source = [Windows.Media.Core.MediaSource]::CreateFromUri([Uri]'${uri}')`,
    "$mp.Play()",
    "$deadline = (Get-Date).AddSeconds(300)",
    "while ((Get-Date) -lt $deadline) {",
    "  Start-Sleep -Milliseconds 120",
    "  try {",
    "    $duration = [double]$mp.NaturalDuration.TotalSeconds",
    "    $position = [double]$mp.Position.TotalSeconds",
    "    if ($duration -gt 0 -and $position -ge [Math]::Max(0, $duration - 0.15)) { break }",
    "  } catch { }",
    "}",
    "$mp.Dispose()", 
  ].join("\n");
}
