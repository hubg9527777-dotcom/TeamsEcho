'use strict';

// ============================================================================
// TeamsEcho 主进程 main.js
//
// 架构要点
//   1. 持久化按键会话（KeySession）：整个运行期只拉起 1 个常驻 helper 进程
//      （macOS: osascript + JXA/CGEvent；Windows: powershell + WScript.Shell），
//      Node 通过 stdin 逐条下发 "key xxx"，helper 回 "OK"。冷启动与倒计时并行，
//      循环 @ 名单时不再有任何进程创建开销。
//   2. 时序锁全部留在 Node 侧（可中断的 sleep），数值与基准版逐项一致。
//   3. 每次任务一个 AbortController：停止 = abort()，所有等待与击键立即熔断。
//   4. 输入法防御：运行期间把输入源切到 ASCII/en-US，结束后（含异常/停止）还原。
//   5. helper 启动失败或中途异常时，自动回退到基准版的“逐次脚本”路径。
//   6. IPC 通道名与参数结构保持不变（preload / index.html / safety.html 无需改动）。
// ============================================================================

const {
  app, BrowserWindow, ipcMain, clipboard, dialog, screen, systemPreferences, globalShortcut, powerSaveBlocker,
} = require('electron');
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { setTimeout: timerSleep } = require('timers/promises');

const IS_MAC = process.platform === 'darwin';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// 经验证的基准时序锁：重构不得缩短、合并或删除。
const TIMING_LOCKS = Object.freeze({
  mentionStep: 60,
  mentionResult: 150,
  mentionConfirm: 180,
  richTextSwitch: 80,
  lineBreak: 100,
  postBreak: 150,
  windowsFallbackActivation: 350,
  stableSearchBuffer: 103,
  clipboardRestore: 500,
});

const WINDOWS_SPEED_RATES = Object.freeze({
  1: 3.00, 2: 2.28, 3: 1.73, 4: 1.32, 5: 1.00,
  6: 0.57, 7: 0.32, 8: 0.185, 9: 0.105, 10: 0.06,
});

// macOS 保留 1–10 档；仅平滑 9、10 档的加速幅度。
const MACOS_SPEED_RATES = Object.freeze({
  ...WINDOWS_SPEED_RATES,
  9: 0.145,
  10: 0.115,
});

const VALID_SEQUENCE_MODES = new Set(['mentionFirst', 'textFirst']);
const PROGRESS_INTERVAL = 3;
const DEFAULT_WINDOW_BOUNDS = Object.freeze({ width: 900, height: 600 });
const MIN_WINDOW_WIDTH = 760;
const MIN_WINDOW_HEIGHT = 520;
const WINDOW_STATE_SAVE_DELAY = 250;

// —— 可调参数（均不改变上面的基准时序锁）——
const COUNTDOWN_SECONDS = 2;
// 常驻 helper 冷启动超时（Windows 需要 Add-Type 编译，给得更宽松）。
const SESSION_READY_TIMEOUT = IS_MAC ? 8000 : 15000;
const SESSION_ACK_TIMEOUT = 5000;
const SESSION_CLOSE_TIMEOUT = 1500;
// 切换到英文输入后的一次性稳定等待（目标应用的输入上下文更新有延迟；仅整批开始前一次）。
const IME_SETTLE_MS = 200;
// 一次性：焦点刚落到目标输入框后的稳定等待（倒计时缩短后，用户可能在最后一刻才点击）。
const FOCUS_SETTLE_MS = 150;
// 第一位成员时 Teams 的 @ 候选面板处于冷启动（首次加载候选/索引，明显慢于后续），
// 因此第一位使用“不快于此档位”的时序；仅一次，约多花 0.5 秒，≤ 此档位的用户不受影响。
const FIRST_MENTION_MAX_LEVEL = 5;
// 10 档（最快）的关键等待窗口相对 9 档的比例下限：1.0 = 与 9 档完全一致（最稳）。
// 原因见 buildMentionPlan；若想让 10 档更快，可逐步调低（如 0.9）并实测，不建议低于 0.8。
const LEVEL10_FLOOR_RATIO_TO_LEVEL9 = 1.0;
// 常驻会话去掉了“每个按键一次 Apple Event / SendKeys 进程”的固有开销，
// 实际按键间隔会比基准版略紧。若 8–10 档在真机上出现漏字，可把它调到 10~25。
const SESSION_STEP_PAD_MS = 0;
// 连续多少次整名注入失败后判定为系统级故障（如缺少辅助功能权限）并中止。
const MAX_CONSECUTIVE_FAILURES = 3;

// 一次性步骤（换行、正文粘贴）只发生一次，且正文是整个流程里最重的一步（Teams 要解析 HTML），
// 因此即使在高速档也不快于此档位，总共只多花约 0.4 秒。
const ONE_TIME_STEP_MAX_LEVEL = 5;

// 周期性“喘息”：每隔 BREATH_EVERY 位停 BREATH_MS 毫秒，让 Teams 清空待处理工作。
// 默认关闭（0）：它只是一个未经证实的猜测，且会产生肉眼可见的周期性停顿；
// 卡顿感知（见下）已经会在系统真正变忙时自动放慢。若关闭后失败率明显上升，可改回 10。
const BREATH_EVERY = 0;
const BREATH_MS = 100;
const BREATH_MIN_LEVEL = 8;

// 卡顿感知：helper 回应一个按键本应只需几毫秒；若某次明显变慢，说明系统此刻很忙
// （CPU 突发、App Nap、磁盘/索引等），此时 Teams 往往也在卡，下一段等待就相应追加。
const STALL_WINDOW = 15;          // 用最近 N 次应答的中位数作为基线
const STALL_WARMUP_SAMPLES = 3;   // 前几次含冷启动开销，不参与判定
const STALL_MIN_MS = 20;          // 低于此值一律不算卡顿
const STALL_FACTOR = 4;           // 超过基线的多少倍才算卡顿
const STALL_MAX_EXTRA_MS = 300;   // 单次追加等待的上限

const MAX_NAMES = 2000;
const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;

const TEMP_FILE_PREFIX = 'teamsecho_';
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

// 紧急停止全局快捷键：目标窗口在前台时点不到“停止”按钮，仅在任务运行期间注册。
const EMERGENCY_STOP_ACCELERATOR = 'CommandOrControl+Alt+Shift+S';
const EMERGENCY_STOP_LABEL = IS_MAC ? '⌘⌥⇧S' : 'Ctrl+Alt+Shift+S';

// 调试开关（环境变量）
const FORCE_LEGACY_INJECTOR = process.env.TEAMSECHO_LEGACY_INJECTOR === '1';
const ALLOW_SELF_TARGET = process.env.TEAMSECHO_ALLOW_SELF_TARGET === '1';

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

let mainWindow;
let safetyWindow;
let currentAutomationData = null;
let activeRun = null; // { kind: 'run' | 'switch', controller: AbortController }
let emergencyStopRegistered = false;
let pendingClipboardRestore = null; // { snapshot, timer }
let settingsWriteQueue = Promise.resolve();
let windowStateSaveTimer = null;
let storedSettings;

const trustedPageUrls = new WeakMap();
const liveChildren = new Set();
const liveInjectors = new Set();
let quitCleanupDone = false;
let powerBlockerId = null;
const liveTempFiles = new Set();

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const noop = () => {};

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

// 可被 AbortSignal 立即打断的 sleep。
function sleep(ms, signal) {
  return timerSleep(ms, undefined, { signal });
}

function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

class InjectionError extends Error {}

// ---------------------------------------------------------------------------
// 速度与设置
// ---------------------------------------------------------------------------

function getSpeedRates() {
  return IS_MAC ? MACOS_SPEED_RATES : WINDOWS_SPEED_RATES;
}

function getScaledDelay(ms, level) {
  return Math.max(1, Math.round(ms * (getSpeedRates()[level] || 1.00)));
}

function clampSpeedLevel(value) {
  const level = Number.parseInt(value, 10);
  return Number.isInteger(level) ? Math.min(10, Math.max(1, level)) : 5;
}

function normalizeWindowBounds(bounds) {
  const width = Number.parseInt(bounds?.width, 10);
  const height = Number.parseInt(bounds?.height, 10);
  return {
    width: Number.isInteger(width) ? Math.max(MIN_WINDOW_WIDTH, width) : DEFAULT_WINDOW_BOUNDS.width,
    height: Number.isInteger(height) ? Math.max(MIN_WINDOW_HEIGHT, height) : DEFAULT_WINDOW_BOUNDS.height,
  };
}

function normalizeSettings(settings) {
  return {
    sequenceMode: VALID_SEQUENCE_MODES.has(settings?.sequenceMode)
      ? settings.sequenceMode
      : 'mentionFirst',
    speedLevel: clampSpeedLevel(settings?.speedLevel),
    turboMode: Boolean(settings?.turboMode),
    windowBounds: normalizeWindowBounds(settings?.windowBounds),
  };
}

function loadStoredSettings() {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('读取设置失败：', error);
    return normalizeSettings(null);
  }
}

function mergeStoredSettings(partialSettings) {
  storedSettings = normalizeSettings({
    ...storedSettings,
    ...partialSettings,
    windowBounds: {
      ...storedSettings.windowBounds,
      ...partialSettings?.windowBounds,
    },
  });
  return storedSettings;
}

function getRestoredWindowBounds() {
  const { width, height } = storedSettings.windowBounds;
  const { width: displayWidth, height: displayHeight } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(width, Math.max(MIN_WINDOW_WIDTH, displayWidth)),
    height: Math.min(height, Math.max(MIN_WINDOW_HEIGHT, displayHeight)),
  };
}

// 先写临时文件再 rename，避免崩溃/断电时 settings.json 被写成半截。
async function writeSettingsAtomic() {
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(storedSettings, null, 2), 'utf8');
  await fs.promises.rename(tmp, settingsPath);
}

function writeSettingsAtomicSync() {
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(storedSettings, null, 2), 'utf8');
  fs.renameSync(tmp, settingsPath);
}

function queueSettingsSave(partialSettings) {
  mergeStoredSettings(partialSettings);
  settingsWriteQueue = settingsWriteQueue
    .catch(noop)
    .then(writeSettingsAtomic)
    .catch((error) => console.error('保存设置失败：', error));
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getSize();
  mergeStoredSettings({ windowBounds: { width, height } });
}

function scheduleWindowBoundsSave() {
  clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    saveWindowBounds();
    queueSettingsSave({});
  }, WINDOW_STATE_SAVE_DELAY);
}

function persistWindowBoundsBeforeClose() {
  clearTimeout(windowStateSaveTimer);
  saveWindowBounds();
  try {
    writeSettingsAtomicSync();
  } catch (error) {
    console.error('保存窗口尺寸失败：', error);
  }
}

// ---------------------------------------------------------------------------
// 剪贴板：快照 / 延迟还原
//   Electron 的 clipboard.write 只能一次性写入 text / html / rtf / image / bookmark，
//   所以“全格式”在 API 层面的上限就是这几种；Finder 复制的文件列表等自定义格式无法保全。
// ---------------------------------------------------------------------------

function snapshotClipboard() {
  try {
    const image = clipboard.readImage();
    return {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: image.isEmpty() ? null : image,
    };
  } catch (error) {
    console.error('读取剪贴板快照失败：', error);
    return null;
  }
}

function restoreClipboardNow(snapshot) {
  if (!snapshot) return;
  try {
    // 必须一次 write 写入所有格式；分多次写会互相覆盖（例如图片+HTML 会丢掉 HTML）。
    const payload = {};
    if (snapshot.text) payload.text = snapshot.text;
    if (snapshot.html) payload.html = snapshot.html;
    if (snapshot.rtf) payload.rtf = snapshot.rtf;
    if (snapshot.image) payload.image = snapshot.image;
    if (Object.keys(payload).length > 0) clipboard.write(payload);
    else clipboard.clear();
  } catch (error) {
    console.error('恢复剪贴板失败：', error);
  }
}

function flushClipboardRestore() {
  if (!pendingClipboardRestore) return;
  clearTimeout(pendingClipboardRestore.timer);
  const { snapshot } = pendingClipboardRestore;
  pendingClipboardRestore = null;
  restoreClipboardNow(snapshot);
}

function scheduleClipboardRestore(snapshot) {
  flushClipboardRestore();
  const timer = setTimeout(() => {
    pendingClipboardRestore = null;
    restoreClipboardNow(snapshot);
  }, TIMING_LOCKS.clipboardRestore);
  pendingClipboardRestore = { snapshot, timer };
}

// ---------------------------------------------------------------------------
// 按键计划（Plan）：时序的唯一来源
//   Plan = [{ wait: ms } | { key: name }]，持久会话与逐次脚本回退共用同一份，
//   因此两条路径的等待序列严格一致。
// ---------------------------------------------------------------------------

const wait = (ms) => ({ wait: ms });
const key = (name) => ({ key: name });

// 不含任何保底的基准等待（与基准版脚本逐项一致）。
function computeMentionWaits(level, turboMode) {
  const step = getScaledDelay(TIMING_LOCKS.mentionStep, level);
  const confirm = getScaledDelay(TIMING_LOCKS.mentionConfirm, level);
  const scaledSearch = getScaledDelay(TIMING_LOCKS.mentionResult, level);
  const turboNineSearchFloor = turboMode && level === 9
    ? getScaledDelay(TIMING_LOCKS.mentionResult, 8)
    : 0;
  return { step, confirm, search: Math.max(scaledSearch, turboNineSearchFloor) };
}

// settleAfter：强制在末尾保留一次收尾等待（Windows 基准脚本没有；首位成员提及落定最慢，需要它）。
function buildMentionPlan(level, turboMode, { settleAfter = false } = {}) {
  let { step, search, confirm } = computeMentionWaits(level, turboMode);

  // 10 档保底。基准版每位成员都要新建进程，Enter → 下一个 @ 之间天然隔着 100ms 以上，
  // 且每个按键还有 10~25ms 的 Apple Event / SendKeys 调度开销；常驻会话把这些全部去掉后，
  // 10 档的关键窗口只剩 7~21ms，低于 Teams 异步粘贴、候选刷新与提及落定所需时间，
  // 因而偶发失败。这里让 10 档的关键窗口不低于 9 档（已验证稳定），其余档位原样不动。
  let gapFloor = 0; // 一次提及结束 → 下一位 @ 之间的最小总间隔
  if (level >= 10) {
    const ref = computeMentionWaits(9, turboMode);
    const ratio = LEVEL10_FLOOR_RATIO_TO_LEVEL9;
    step = Math.max(step, Math.ceil(ref.step * ratio));
    search = Math.max(search, Math.ceil(ref.search * ratio));
    confirm = Math.max(confirm, Math.ceil(ref.confirm * ratio));
    gapFloor = Math.ceil(ref.step * (IS_MAC ? 2 : 1) * ratio);
  }

  // macOS 恒用 confirm；Windows 稳妥模式额外保证 stableSearchBuffer。
  const afterBackspace = (IS_MAC || turboMode)
    ? confirm
    : Math.max(confirm, TIMING_LOCKS.stableSearchBuffer);
  // 基准版 macOS 脚本末尾有一次 delay；Windows 没有。该等待与下一位的起始等待合成提及间隔。
  const trailing = Math.max(IS_MAC || settleAfter ? step : 0, gapFloor - step);

  const plan = [wait(step), key('at')];
  if (!turboMode) plan.push(wait(step), key('left'));
  plan.push(
    wait(step), key('paste'),
    wait(search), key('one'),
    wait(step), key('backspace'),
    wait(afterBackspace), key('enter'),
  );
  if (trailing > 0) plan.push(wait(trailing));
  return plan;
}

function buildPastePlan(level) {
  return [wait(getScaledDelay(TIMING_LOCKS.mentionResult, level)), key('paste')];
}

function buildLineBreakPlan(level) {
  return [wait(getScaledDelay(TIMING_LOCKS.lineBreak, level)), key('shiftenter')];
}

function buildRichSwitchPlan(level) {
  return [wait(getScaledDelay(TIMING_LOCKS.richTextSwitch, level)), key('richswitch')];
}

// ---------------------------------------------------------------------------
// 回退路径：把 Plan 编译成基准版风格的“一次性脚本”
//   数字 1 改用 key code 18（物理键位），与 Backspace/Enter/← 的 key code 风格一致。
// ---------------------------------------------------------------------------

const APPLESCRIPT_KEYS = Object.freeze({
  at: 'keystroke "@"',
  left: 'key code 123',
  paste: 'keystroke "v" using command down',
  one: 'key code 18',
  backspace: 'key code 51',
  enter: 'key code 36',
  shiftenter: 'keystroke return using shift down',
  richswitch: 'keystroke "x" using {command down, shift down}',
});

const SENDKEYS_KEYS = Object.freeze({
  at: '@',
  left: '{LEFT}',
  paste: '^v',
  one: '1',
  backspace: '{BACKSPACE}',
  enter: '{ENTER}',
  shiftenter: '+{ENTER}',
  richswitch: '^+x',
});

function compileAppleScript(plan) {
  const lines = plan.map((op) => (op.wait !== undefined
    ? `delay ${(op.wait / 1000).toFixed(3)}`
    : APPLESCRIPT_KEYS[op.key]));
  return `tell application "System Events"\n${lines.join('\n')}\nend tell\nreturn "OK"`;
}

function compilePowerShell(plan) {
  const lines = plan.map((op) => (op.wait !== undefined
    ? `Start-Sleep -m ${op.wait}`
    : `$w.SendKeys('${SENDKEYS_KEYS[op.key]}')`));
  return ['$w = New-Object -ComObject Wscript.Shell', ...lines, 'Write-Output "OK"'].join('\n');
}

function handleExecResult(err, stdout, resolve, reject, label) {
  if (err) {
    if (isAbortError(err)) reject(err);
    else {
      console.warn(`${label} 执行失败：`, err.message);
      resolve(false);
    }
    return;
  }
  resolve(String(stdout).trim() === 'OK');
}

function runAppleScript(script, signal) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { signal }, (err, stdout) => {
      handleExecResult(err, stdout, resolve, reject, 'osascript');
    });
  });
}

function runWindowsPowerShell(script, signal) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `${TEMP_FILE_PREFIX}ps_${crypto.randomUUID()}.ps1`);
    fs.writeFile(tmpFile, script, { encoding: 'utf8', flag: 'wx', mode: 0o600 }, (writeError) => {
      if (writeError) {
        console.warn('写入临时脚本失败：', writeError.message);
        resolve(false);
        return;
      }
      liveTempFiles.add(tmpFile);
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
        { windowsHide: false, signal }, // 保持基准版取值
        (err, stdout) => {
          liveTempFiles.delete(tmpFile);
          fs.unlink(tmpFile, noop);
          handleExecResult(err, stdout, resolve, reject, 'powershell');
        },
      );
    });
  });
}

function runLegacyPlan(plan, signal) {
  return IS_MAC
    ? runAppleScript(compileAppleScript(plan), signal)
    : runWindowsPowerShell(compilePowerShell(plan), signal);
}

// ---------------------------------------------------------------------------
// 常驻 helper 脚本
//   协议（逐行文本，单条在途）：
//     Node → helper:  key <name> | ime-on | ime-off | ping | quit
//     helper → Node:  READY trusted=<0|1|-1> tis=<0|1>
//                     OK [detail] | ERR <message>
//   脚本内一律使用纯 ASCII，避免 osascript/PowerShell 的参数编码问题；
//   名字通过 Electron 剪贴板 + 粘贴传递，从不经过 helper。
// ---------------------------------------------------------------------------

// macOS：JXA + CGEvent。直接发物理键码并显式清除 flags，不依赖字符→键码映射，
// 也不再需要 System Events 的 Automation 授权（只需“辅助功能”）。
const MAC_HELPER_SCRIPT = String.raw`
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');

var tisReady = false;
try {
  ObjC.import('Carbon');
  tisReady = (typeof $.TISCopyCurrentKeyboardInputSource === 'function') &&
             (typeof $.TISCopyCurrentASCIICapableKeyboardInputSource === 'function') &&
             (typeof $.TISSelectInputSource === 'function');
} catch (e) { tisReady = false; }

var CMD = 0x100000, SHIFT = 0x20000;
var KEYS = {
  at: [19, SHIFT],
  left: [123, 0],
  paste: [9, CMD],
  one: [18, 0],
  backspace: [51, 0],
  enter: [36, 0],
  shiftenter: [36, SHIFT],
  richswitch: [7, CMD | SHIFT]
};

var eventSource = $.CGEventSourceCreate(0);

function pressKey(def) {
  var down = $.CGEventCreateKeyboardEvent(eventSource, def[0], true);
  var up = $.CGEventCreateKeyboardEvent(eventSource, def[0], false);
  $.CGEventSetFlags(down, def[1]);
  $.CGEventSetFlags(up, def[1]);
  $.CGEventPost(1, down);
  $.CGEventPost(1, up);
}

var savedSource = null;
var hasSaved = false;

function enterAscii() {
  if (!tisReady) return 'unsupported';
  savedSource = $.TISCopyCurrentKeyboardInputSource();
  hasSaved = true;
  var ascii = $.TISCopyCurrentASCIICapableKeyboardInputSource();
  var status = $.TISSelectInputSource(ascii);
  return status === 0 ? 'ok' : ('err' + status);
}

function leaveAscii() {
  if (!tisReady || !hasSaved) return 'noop';
  var status = $.TISSelectInputSource(savedSource);
  hasSaved = false;
  return status === 0 ? 'ok' : ('err' + status);
}

var stdinHandle = $.NSFileHandle.fileHandleWithStandardInput;
var stdoutHandle = $.NSFileHandle.fileHandleWithStandardOutput;
function say(text) {
  stdoutHandle.writeData($(text + '\n').dataUsingEncoding(4));
}

var trusted = -1;
try { trusted = $.AXIsProcessTrusted() ? 1 : 0; } catch (e) { trusted = -1; }
say('READY trusted=' + trusted + ' tis=' + (tisReady ? 1 : 0));

var pending = '';
var running = true;
while (running) {
  var chunk = stdinHandle.availableData;
  if (Number(chunk.length) === 0) break;
  pending += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(chunk, 4));
  var idx;
  while ((idx = pending.indexOf('\n')) >= 0) {
    var line = pending.slice(0, idx).replace(/\s+$/, '');
    pending = pending.slice(idx + 1);
    if (!line) continue;
    var parts = line.split(' ');
    try {
      if (parts[0] === 'key' && KEYS[parts[1]]) { pressKey(KEYS[parts[1]]); say('OK'); }
      else if (parts[0] === 'ime-on') { say('OK ' + enterAscii()); }
      else if (parts[0] === 'ime-off') { say('OK ' + leaveAscii()); }
      else if (parts[0] === 'ping') { say('OK'); }
      else if (parts[0] === 'quit') { say('OK'); running = false; break; }
      else { say('ERR unknown'); }
    } catch (e) { say('ERR ' + String(e)); }
  }
}
leaveAscii();
`;

// Windows：保持基准版的 WScript.Shell.SendKeys 语义，只是把进程常驻；
// 额外用 P/Invoke 把前台窗口的键盘布局切到 en-US（绕开拼音 IME），结束后还原。
const WINDOWS_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TeamsEchoNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadKeyboardLayout(string pwszKLID, uint Flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
'@

$shell = New-Object -ComObject Wscript.Shell
$map = @{ at = '@'; left = '{LEFT}'; paste = '^v'; one = '1'; backspace = '{BACKSPACE}'; enter = '{ENTER}'; shiftenter = '+{ENTER}'; richswitch = '^+x' }
$script:savedLayout = $null
$script:savedWnd = [IntPtr]::Zero

function Enter-Ascii {
  $h = [TeamsEchoNative]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return 'nowindow' }
  $tid = [TeamsEchoNative]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
  $cur = [TeamsEchoNative]::GetKeyboardLayout($tid)
  if (($cur.ToInt64() -band 0xFFFF) -eq 0x0409) { return 'already' }
  $en = [TeamsEchoNative]::LoadKeyboardLayout('00000409', 0)
  if ($en -eq [IntPtr]::Zero) { return 'loadfail' }
  $script:savedLayout = $cur
  $script:savedWnd = $h
  [void][TeamsEchoNative]::PostMessage($h, 0x0050, [IntPtr]::Zero, $en)
  return 'ok'
}

function Leave-Ascii {
  if ($null -eq $script:savedLayout) { return 'noop' }
  [void][TeamsEchoNative]::PostMessage($script:savedWnd, 0x0050, [IntPtr]::Zero, $script:savedLayout)
  $script:savedLayout = $null
  return 'ok'
}

[Console]::Out.WriteLine('READY trusted=1 tis=1')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  $parts = $line.Split(' ')
  try {
    switch ($parts[0]) {
      'key'     { $shell.SendKeys($map[$parts[1]]); [Console]::Out.WriteLine('OK') }
      'ime-on'  { [Console]::Out.WriteLine('OK ' + (Enter-Ascii)) }
      'ime-off' { [Console]::Out.WriteLine('OK ' + (Leave-Ascii)) }
      'ping'    { [Console]::Out.WriteLine('OK') }
      'quit'    { [Console]::Out.WriteLine('OK'); exit 0 }
      default   { [Console]::Out.WriteLine('ERR unknown') }
    }
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)
  }
}
$null = Leave-Ascii
`;

// ---------------------------------------------------------------------------
// KeySession：对常驻 helper 的封装（单条在途、FIFO 应答、可中断）
// ---------------------------------------------------------------------------

class KeySession {
  constructor(child, onDispose) {
    this.child = child;
    this.onDispose = onDispose;
    this.alive = true;
    this.info = {};
    this.pending = [];
    this.buffer = '';
    this.stderrTail = '';
    liveChildren.add(child);

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyPromise.catch(noop); // 防止在 waitReady 之前失败导致 unhandledRejection

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-1000);
    });
    child.stdin.on('error', noop);
    child.once('error', (err) => this.fail(err));
    child.once('exit', (code, signal) => {
      this.fail(new Error(`helper 已退出（${code ?? signal}）${this.stderrTail.trim()}`));
    });
  }

  static async start(signal) {
    let child;
    let onDispose = noop;
    if (IS_MAC) {
      child = spawn('osascript', ['-l', 'JavaScript', '-e', MAC_HELPER_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      const file = path.join(os.tmpdir(), `${TEMP_FILE_PREFIX}helper_${crypto.randomUUID()}.ps1`);
      fs.writeFileSync(file, WINDOWS_HELPER_SCRIPT, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      liveTempFiles.add(file);
      onDispose = () => {
        liveTempFiles.delete(file);
        fs.unlink(file, noop);
      };
      try {
        child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, // 隐藏控制台，避免抢走目标窗口焦点
        );
      } catch (error) {
        onDispose();
        throw error;
      }
    }

    const session = new KeySession(child, onDispose);
    try {
      await session.waitReady(SESSION_READY_TIMEOUT, signal);
    } catch (error) {
      session.kill();
      throw error;
    }
    return session;
  }

  async waitReady(timeoutMs, signal) {
    let timer;
    let onAbort;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('helper 启动超时')), timeoutMs);
      onAbort = () => reject(signal.reason);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      await Promise.race([this.readyPromise, guard]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    if (line.startsWith('READY')) {
      for (const part of line.split(' ').slice(1)) {
        const [name, value] = part.split('=');
        if (name) this.info[name] = Number(value);
      }
      this.readyResolve();
      return;
    }
    const isOk = line.startsWith('OK');
    if (!isOk && !line.startsWith('ERR')) return; // 忽略 osascript 收尾输出等杂项
    const entry = this.pending.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    if (isOk) entry.resolve(line.slice(2).trim());
    else entry.reject(new Error(line));
  }

  send(command, signal) {
    if (!this.alive) return Promise.reject(new Error('helper 未运行'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const entry = {};
      const onAbort = () => entry.reject(signal.reason);
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      entry.resolve = (value) => { cleanup(); resolve(value); };
      entry.reject = (error) => { cleanup(); reject(error); };
      entry.timer = setTimeout(() => {
        this.fail(new Error(`helper 应答超时：${command}`));
      }, SESSION_ACK_TIMEOUT);
      // 中断时只让调用方立刻返回；条目留在队列里，等 helper 的应答自然消费，保证 FIFO 不错位。
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.push(entry);
      this.child.stdin.write(`${command}\n`);
    });
  }

  fail(error) {
    if (!this.alive) return;
    this.alive = false;
    this.readyReject(error);
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    liveChildren.delete(this.child);
    try { this.child.kill(); } catch (_) { /* 已退出 */ }
    this.onDispose();
  }

  kill() {
    try { this.child.stdin.end(); } catch (_) { /* 已关闭 */ }
    this.fail(new Error('会话已关闭'));
  }
}

// ---------------------------------------------------------------------------
// Injector：对上层暴露统一接口；优先常驻会话，失败自动回退逐次脚本
// ---------------------------------------------------------------------------

// 根据 helper 的应答耗时判断系统是否正在卡顿，并给出需要追加的等待。
class PaceMonitor {
  constructor() {
    this.window = [];
    this.count = 0;
    this.sum = 0;
    this.maxAck = 0;
    this.stalls = 0;
  }

  median() {
    if (this.window.length === 0) return 0;
    const sorted = [...this.window].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  get average() {
    return this.count ? this.sum / this.count : 0;
  }

  // 返回需要追加的等待毫秒数（0 = 一切正常）。
  observe(ackMs) {
    const baseline = this.median();
    this.count += 1;
    this.sum += ackMs;
    this.maxAck = Math.max(this.maxAck, ackMs);
    this.window.push(ackMs);
    if (this.window.length > STALL_WINDOW) this.window.shift();
    if (this.count <= STALL_WARMUP_SAMPLES) return 0;
    if (ackMs <= Math.max(STALL_MIN_MS, baseline * STALL_FACTOR)) return 0;
    this.stalls += 1;
    return Math.min(STALL_MAX_EXTRA_MS, Math.round(ackMs));
  }
}

class Injector {
  constructor() {
    this.session = null;
    this.imeEntered = false;
    this.pace = new PaceMonitor();
    this.closePromise = null;
  }

  get mode() {
    return this.session ? 'session' : 'legacy';
  }

  // helper 握手信息（如 macOS 辅助功能授权状态）；回退到逐次脚本时为 null。
  get info() {
    return this.session ? this.session.info : null;
  }

  async init(signal) {
    if (FORCE_LEGACY_INJECTOR) return;
    try {
      this.session = await KeySession.start(signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.warn('常驻按键会话启动失败，回退到逐次脚本模式：', error.message);
      this.session = null;
    }
  }

  // 返回 false 表示本次注入失败（已被跳过）；中断则抛 AbortError。
  async runPlan(plan, signal) {
    if (!this.session) return runLegacyPlan(plan, signal);
    try {
      for (const op of plan) {
        if (op.wait !== undefined) {
          await sleep(op.wait, signal);
        } else {
          const startedAt = performance.now();
          await this.session.send(`key ${op.key}`, signal);
          const ackMs = performance.now() - startedAt;
          if (SESSION_STEP_PAD_MS > 0) await sleep(SESSION_STEP_PAD_MS, signal);
          const extra = this.pace.observe(ackMs);
          if (extra > 0) {
            console.warn(`检测到系统卡顿：按键应答 ${Math.round(ackMs)}ms，追加等待 ${extra}ms`);
            await sleep(extra, signal);
          }
        }
      }
      return true;
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.warn('常驻会话执行失败，后续改用逐次脚本：', error.message);
      this.dropSession();
      return false;
    }
  }

  async enterAsciiInput(signal) {
    if (!this.session) return false;
    try {
      const detail = await this.session.send('ime-on', signal);
      this.imeEntered = true;
      return detail === 'ok' || detail === 'already';
    } catch (error) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }

  dropSession() {
    this.session?.kill();
    this.session = null;
    this.imeEntered = false;
  }

  // 幂等：无论谁先调用（任务收尾 / 应用退出），都等同一个收尾流程。
  close() {
    if (!this.closePromise) this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  // 无论正常结束、异常还是停止都要走到这里：先还原输入法，再退出 helper。
  async closeInternal() {
    const session = this.session;
    this.session = null;
    if (!session) return;
    const graceful = (async () => {
      if (this.imeEntered) await session.send('ime-off').catch(noop);
      await session.send('quit').catch(noop);
    })();
    await Promise.race([
      graceful,
      timerSleep(SESSION_CLOSE_TIMEOUT, undefined, { ref: false }).catch(noop),
    ]);
    session.kill();
    this.imeEntered = false;
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function isWindowSender(event, window) {
  if (!window || window.isDestroyed()) return false;
  const webContents = window.webContents;
  const senderFrame = event.senderFrame;
  return event.sender === webContents
    && senderFrame === webContents.mainFrame
    && senderFrame.url === trustedPageUrls.get(webContents);
}

function hardenLocalWindow(window, pagePath) {
  const expectedUrl = pathToFileURL(pagePath).href;
  trustedPageUrls.set(window.webContents, expectedUrl);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== expectedUrl) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function createWindow() {
  storedSettings = loadStoredSettings();
  const restoredBounds = getRestoredWindowBounds();
  mainWindow = new BrowserWindow({
    ...restoredBounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  hardenLocalWindow(mainWindow, path.join(__dirname, 'index.html'));
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('resize', scheduleWindowBoundsSave);
  mainWindow.on('close', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['确认退出', '取消'],
      title: '确认退出？',
      message: '安全提示：退出后当前输入的所有消息及名单将在内存中彻底销毁，软件不留任何本地草稿。',
    });
    if (choice === 1) {
      event.preventDefault();
      return;
    }
    stopActiveRun();
    persistWindowBoundsBeforeClose();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function openSafetyWindow(turboMode) {
  if (safetyWindow) {
    safetyWindow.webContents.send('safety-mode-info', Boolean(turboMode));
    safetyWindow.focus();
    return;
  }

  safetyWindow = new BrowserWindow({
    width: 560,
    height: 390,
    useContentSize: true,
    parent: mainWindow,
    modal: true,
    alwaysOnTop: true,
    resizable: false,
    frame: true,
    title: '安全核对栏',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  hardenLocalWindow(safetyWindow, path.join(__dirname, 'safety.html'));
  safetyWindow.loadFile(path.join(__dirname, 'safety.html'));
  safetyWindow.webContents.once('did-finish-load', () => {
    safetyWindow?.webContents.send('safety-mode-info', Boolean(turboMode));
  });
  safetyWindow.on('closed', () => {
    safetyWindow = null;
  });
}

// ---------------------------------------------------------------------------
// 任务生命周期：单例互斥 + AbortController + 紧急停止快捷键
// ---------------------------------------------------------------------------

function stopActiveRun() {
  if (!activeRun) return false;
  if (!activeRun.controller.signal.aborted) activeRun.controller.abort();
  return true;
}

function registerEmergencyStop() {
  try {
    emergencyStopRegistered = globalShortcut.register(EMERGENCY_STOP_ACCELERATOR, () => {
      if (stopActiveRun()) sendToMain('status-update', '收到紧急停止指令，正在停止…');
    });
  } catch (error) {
    emergencyStopRegistered = false;
    console.warn('注册紧急停止快捷键失败：', error.message);
  }
}

function unregisterEmergencyStop() {
  if (!emergencyStopRegistered) return;
  emergencyStopRegistered = false;
  try { globalShortcut.unregister(EMERGENCY_STOP_ACCELERATOR); } catch (_) { /* 忽略 */ }
}

async function runExclusive(kind, task) {
  if (activeRun) {
    sendToMain('status-update', '已有任务正在执行，请先停止或等待完成。');
    return;
  }
  const controller = new AbortController();
  activeRun = { kind, controller };
  registerEmergencyStop();
  // 任务期间本软件在后台（目标程序在前台），防止系统因“应用被挂起/降频”拉长我们的计时与 helper 应答。
  try { powerBlockerId = powerSaveBlocker.start('prevent-app-suspension'); } catch (_) { powerBlockerId = null; }
  try {
    await task(controller.signal);
  } catch (error) {
    console.error('任务异常：', error);
  } finally {
    if (powerBlockerId !== null) {
      try { powerSaveBlocker.stop(powerBlockerId); } catch (_) { /* 忽略 */ }
      powerBlockerId = null;
    }
    unregisterEmergencyStop();
    activeRun = null;
  }
}

// ---------------------------------------------------------------------------
// 自动化流程
// ---------------------------------------------------------------------------

function normalizeAutomationData(data) {
  if (!data || typeof data !== 'object') return null;
  const rawNames = Array.isArray(data.names) ? data.names : [];
  if (rawNames.length > MAX_NAMES) return null;
  const names = rawNames
    .filter((name) => typeof name === 'string')
    .map((name) => name.replace(/[\r\n]+/g, ' ').trim())
    .filter(Boolean);
  const text = (value) => (typeof value === 'string' ? value.slice(0, MAX_CONTENT_LENGTH) : '');
  return {
    names,
    textContent: text(data.textContent),
    htmlContent: text(data.htmlContent),
    sequenceMode: VALID_SEQUENCE_MODES.has(data.sequenceMode) ? data.sequenceMode : 'mentionFirst',
    speedLevel: clampSpeedLevel(data.speedLevel),
    turboMode: data.turboMode === true || data.turboMode === 1 || data.turboMode === 'true',
  };
}

function shouldPublishProgress(index, total) {
  return index === 0 || index === total - 1 || (index + 1) % PROGRESS_INTERVAL === 0;
}

// 倒计时让出焦点；结束时确认焦点已不在本软件内，避免把按键注入到自己的输入框。
async function prepareConfirmedTarget(signal) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.blur();

  for (let i = COUNTDOWN_SECONDS; i > 0; i -= 1) {
    signal.throwIfAborted();
    sendToMain('status-update', `请在 ${i} 秒内点击目标输入框（建议保持英文输入状态）…`);
    await sleep(1000, signal);
  }
  signal.throwIfAborted();

  if (!ALLOW_SELF_TARGET && BrowserWindow.getFocusedWindow()) {
    sendToMain('status-update', '检测到焦点仍在 TeamsEcho 窗口内，为避免误输入已中止，请重新开始并点击目标输入框。');
    return false;
  }
  sendToMain('status-update', '倒计时结束，正在当前焦点位置执行自动化…');
  return true;
}

// 返回 true 表示可以继续注入。
function ensureInjectionPermission(injector) {
  if (!IS_MAC) return true;
  const trusted = injector.info
    ? injector.info.trusted !== 0
    : systemPreferences.isTrustedAccessibilityClient(false);
  if (trusted) return true;
  systemPreferences.isTrustedAccessibilityClient(true); // 弹出系统授权提示
  sendToMain('status-update', '缺少“辅助功能”权限：请在 系统设置 → 隐私与安全性 → 辅助功能 中允许 TeamsEcho，然后重试。');
  return false;
}

async function runMentionPass(injector, names, plans, signal) {
  let consecutiveFailures = 0;
  for (let index = 0; index < names.length; index += 1) {
    signal.throwIfAborted();

    if (shouldPublishProgress(index, names.length)) {
      sendToMain('status-update', `正在粘贴提及：${names[index]}（${index + 1}/${names.length}）`);
    }

    if (plans.breathe && BREATH_EVERY > 0 && index > 0 && index % BREATH_EVERY === 0) {
      await sleep(BREATH_MS, signal);
    }

    clipboard.writeText(names[index]);
    const ok = await injector.runPlan(index === 0 ? plans.first : plans.rest, signal);
    if (ok) {
      consecutiveFailures = 0;
      continue;
    }
    sendToMain('status-update', `跳过：${names[index]}（${index + 1}/${names.length}）`);
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw new InjectionError('连续注入失败');
  }
}

async function runAutomation(data, signal) {
  const {
    names, htmlContent, textContent, sequenceMode, speedLevel, turboMode,
  } = data;
  const level = speedLevel;
  const hasContent = textContent.trim().length > 0;

  if (names.length === 0 && !hasContent) {
    sendToMain('status-update', '名单与正文均为空，未执行。');
    return;
  }

  const oneTimeLevel = Math.min(level, ONE_TIME_STEP_MAX_LEVEL);
  const plans = {
    mention: {
      first: buildMentionPlan(Math.min(level, FIRST_MENTION_MAX_LEVEL), turboMode, { settleAfter: true }),
      rest: buildMentionPlan(level, turboMode),
      breathe: level >= BREATH_MIN_LEVEL,
    },
    paste: buildPastePlan(oneTimeLevel),
    lineBreak: buildLineBreakPlan(oneTimeLevel),
  };
  const postBreakWait = getScaledDelay(TIMING_LOCKS.postBreak, oneTimeLevel);

  flushClipboardRestore(); // 上一轮的延迟还原必须先落地，否则快照会抓到我们自己写入的内容
  const clipboardSnapshot = snapshotClipboard();

  const injector = new Injector();
  liveInjectors.add(injector);
  const initPromise = injector.init(signal); // 与倒计时并行完成冷启动
  initPromise.catch(noop);

  const mustSucceed = (ok) => {
    if (!ok) throw new InjectionError('按键注入失败');
  };
  const pasteRich = async () => {
    clipboard.write({ html: htmlContent, text: textContent });
    mustSucceed(await injector.runPlan(plans.paste, signal));
  };
  const lineBreak = async () => {
    mustSucceed(await injector.runPlan(plans.lineBreak, signal));
    await sleep(postBreakWait, signal);
  };
  const mentions = () => runMentionPass(injector, names, plans.mention, signal);

  let imeApplied = true;
  let injectStartedAt = 0;
  let finalStatus = null; // null：提前返回的分支已自行给出提示，finally 不再覆盖
  try {
    sendToMain('status-update', '正在准备执行…');
    if (!await prepareConfirmedTarget(signal)) return;
    await initPromise;
    if (!ensureInjectionPermission(injector)) return;

    if (injector.mode === 'session') {
      imeApplied = await injector.enterAsciiInput(signal);
      if (imeApplied) await sleep(IME_SETTLE_MS, signal);
    } else {
      imeApplied = false;
    }
    await sleep(FOCUS_SETTLE_MS, signal);

    sendToMain('status-update', `正在按发布版连续节奏执行。（紧急停止：${EMERGENCY_STOP_LABEL}）`);
    injectStartedAt = Date.now();

    if (sequenceMode === 'mentionFirst') {
      await mentions();
      if (hasContent) {
        await lineBreak();
        await pasteRich();
      }
    } else if (hasContent) {
      sendToMain('status-update', '正在粘贴消息正文内容。');
      await pasteRich();
      await lineBreak();
      await mentions();
    } else {
      sendToMain('status-update', '未检测到有效正文内容，直接开始 @ 提及。');
      await mentions();
    }

    const notes = [];
    if (names.length > 0) notes.push(`${names.length} 位，用时 ${((Date.now() - injectStartedAt) / 1000).toFixed(1)} 秒`);
    if (injector.pace.stalls > 0) notes.push(`运行中检测到 ${injector.pace.stalls} 次系统卡顿，已自动放慢`);
    if (!imeApplied) notes.push('提示：未能自动切换输入法，如遇异常请先手动切到英文输入');
    finalStatus = `自动化执行完毕。${notes.length ? `（${notes.join('；')}）` : ''}`;
    console.log(`[TeamsEcho] 按键应答均值 ${injector.pace.average.toFixed(1)}ms，最大 ${Math.round(injector.pace.maxAck)}ms，卡顿 ${injector.pace.stalls} 次`);
  } catch (error) {
    if (isAbortError(error)) {
      finalStatus = '自动化已停止。';
    } else if (error instanceof InjectionError) {
      finalStatus = IS_MAC
        ? '按键注入连续失败，已停止。请检查“辅助功能”权限。'
        : '按键注入连续失败，已停止。若目标程序以管理员身份运行，请同样以管理员身份启动 TeamsEcho。';
    } else {
      console.error('自动化执行失败：', error);
      finalStatus = '自动化执行出现异常，已停止。';
    }
  } finally {
    await initPromise.catch(noop);
    await injector.close().catch(noop);
    liveInjectors.delete(injector);
    scheduleClipboardRestore(clipboardSnapshot);
    if (finalStatus) sendToMain('status-update', finalStatus);
  }
}

async function switchToRichTextInput(signal) {
  const level = Math.min(currentAutomationData?.speedLevel ?? 5, ONE_TIME_STEP_MAX_LEVEL);
  const injector = new Injector();
  liveInjectors.add(injector);
  const initPromise = injector.init(signal);
  initPromise.catch(noop);

  try {
    if (!await prepareConfirmedTarget(signal)) return;
    await initPromise;
    if (!ensureInjectionPermission(injector)) return;
    const ok = await injector.runPlan(buildRichSwitchPlan(level), signal);
    sendToMain('status-update', ok ? '已发送切换到富文本输入的快捷键。' : '切换快捷键发送失败。');
  } catch (error) {
    if (isAbortError(error)) sendToMain('status-update', '已停止。');
    else {
      console.error('切换富文本输入失败：', error);
      sendToMain('status-update', '切换富文本输入出现异常。');
    }
  } finally {
    await initPromise.catch(noop);
    await injector.close().catch(noop);
    liveInjectors.delete(injector);
  }
}

// ---------------------------------------------------------------------------
// IPC（通道名与参数结构保持不变）
// ---------------------------------------------------------------------------

ipcMain.handle('load-settings', async (event) => (
  isWindowSender(event, mainWindow) ? storedSettings || loadStoredSettings() : null
));

ipcMain.handle('get-runtime-profile', (event) => {
  if (!isWindowSender(event, mainWindow)) return null;
  return {
    platform: process.platform,
    speedRates: getSpeedRates(),
  };
});

ipcMain.on('save-settings', (event, settings) => {
  if (!isWindowSender(event, mainWindow)) return;
  queueSettingsSave(settings);
});

ipcMain.on('trigger-safety-check', (event, data) => {
  if (!isWindowSender(event, mainWindow)) return;
  if (activeRun) {
    sendToMain('status-update', '已有任务正在执行，请先停止或等待完成。');
    return;
  }
  const normalized = normalizeAutomationData(data);
  if (!normalized) {
    sendToMain('status-update', '参数无效或名单过长，未执行。');
    return;
  }
  currentAutomationData = normalized;
  openSafetyWindow(normalized.turboMode);
});

ipcMain.on('safety-response', (event, responseType) => {
  if (!isWindowSender(event, safetyWindow)) return;

  if (responseType === 'cancel') {
    if (safetyWindow) safetyWindow.close();
    currentAutomationData = null;
    sendToMain('status-update', '操作已取消，未写入任何数据。');
    return;
  }

  if (responseType === 'switch') {
    runExclusive('switch', switchToRichTextInput).catch(console.error);
    return;
  }

  if (responseType !== 'confirm' || !currentAutomationData || activeRun) return;

  const data = currentAutomationData;
  currentAutomationData = null; // 立刻消费，防止重复点击触发第二次执行
  if (safetyWindow) safetyWindow.close();
  runExclusive('run', (signal) => runAutomation(data, signal)).catch(console.error);
});

ipcMain.on('stop-automation', (event) => {
  if (!isWindowSender(event, mainWindow)) return;
  if (stopActiveRun()) sendToMain('status-update', '正在停止自动化操作…');
});

// ---------------------------------------------------------------------------
// 应用生命周期与垃圾清理
// ---------------------------------------------------------------------------

// 清理上次异常退出遗留的临时脚本。
function cleanupStaleTempFiles() {
  const dir = os.tmpdir();
  fs.readdir(dir, (error, entries) => {
    if (error) return;
    const cutoff = Date.now() - STALE_TEMP_AGE_MS;
    for (const entry of entries) {
      if (!entry.startsWith(TEMP_FILE_PREFIX) || !entry.endsWith('.ps1')) continue;
      const file = path.join(dir, entry);
      fs.stat(file, (statError, stats) => {
        if (!statError && stats.mtimeMs < cutoff) fs.unlink(file, noop);
      });
    }
  });
}

app.whenReady().then(() => {
  cleanupStaleTempFiles();
  createWindow();
});

app.on('will-quit', (event) => {
  // 运行中直接退出时，先让 helper 还原输入法再退出，否则用户的拼音输入法会停在英文。
  if (!quitCleanupDone && liveInjectors.size > 0) {
    event.preventDefault();
    stopActiveRun();
    const closing = Promise.all([...liveInjectors].map((injector) => injector.close().catch(noop)));
    Promise.race([
      closing,
      timerSleep(SESSION_CLOSE_TIMEOUT + 500, undefined, { ref: false }).catch(noop),
    ]).finally(() => {
      quitCleanupDone = true;
      app.quit();
    });
    return;
  }

  stopActiveRun();
  try { globalShortcut.unregisterAll(); } catch (_) { /* 忽略 */ }
  for (const child of liveChildren) {
    try { child.kill(); } catch (_) { /* 已退出 */ }
  }
  liveChildren.clear();
  for (const file of liveTempFiles) {
    try { fs.unlinkSync(file); } catch (_) { /* 已删除 */ }
  }
  liveTempFiles.clear();
  flushClipboardRestore();
});