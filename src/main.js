const { app, BrowserWindow, ipcMain, clipboard, dialog, screen } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

// 经验证的基准时序锁：重构不得缩短、合并或删除。
const TIMING_LOCKS = Object.freeze({
  mentionStep: 60,
  mentionResult: 150,
  mentionConfirm: 180,
  richTextSwitch: 80,
  lineBreak: 100,
  postBreak: 150,
  windowsFallbackActivation: 350,
  // Windows 稳妥模式中已验证的搜索/缓冲锁；极速模式不使用此锁。
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

let mainWindow;
let safetyWindow;
let isStopping = false;
let currentAutomationData = null;
let settingsWriteQueue = Promise.resolve();
let windowStateSaveTimer = null;
let storedSettings;
const trustedPageUrls = new WeakMap();

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function getSpeedRates() {
  return process.platform === 'darwin' ? MACOS_SPEED_RATES : WINDOWS_SPEED_RATES;
}

// 保持原有“逐项乘倍率、四舍五入、最低 1ms”的时序规则。
function getScaledDelay(ms, level) {
  return Math.max(1, Math.round(ms * (getSpeedRates()[level] || 1.00)));
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
  const requestedLevel = Number.parseInt(settings?.speedLevel, 10);
  return {
    sequenceMode: VALID_SEQUENCE_MODES.has(settings?.sequenceMode)
      ? settings.sequenceMode
      : 'mentionFirst',
    speedLevel: Number.isInteger(requestedLevel)
      ? Math.min(10, Math.max(1, requestedLevel))
      : 5,
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

function runWindowsPowerShell(scriptContent) {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `teamsecho_ps_${crypto.randomUUID()}.ps1`);

    fs.writeFile(tmpFile, scriptContent, { encoding: 'utf8', flag: 'wx', mode: 0o600 }, (writeError) => {
      if (writeError) {
        resolve({ err: writeError, stdout: '' });
        return;
      }

      // 参数化调用保留现有透明脚本内容，避免经由 shell 拼接命令行。
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
        { windowsHide: false },
        (err, stdout) => {
          fs.unlink(tmpFile, () => {});
          resolve({ err, stdout });
        },
      );
    });
  });
}

function runAppleScript(scriptContent) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', scriptContent], (err, stdout) => {
      resolve({ err, stdout });
    });
  });
}

function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function queueSettingsSave(partialSettings) {
  mergeStoredSettings(partialSettings);
  settingsWriteQueue = settingsWriteQueue
    .catch(() => {})
    .then(() => fs.promises.writeFile(settingsPath, JSON.stringify(storedSettings, null, 2), 'utf8'))
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
    fs.writeFileSync(settingsPath, JSON.stringify(storedSettings, null, 2), 'utf8');
  } catch (error) {
    console.error('保存窗口尺寸失败：', error);
  }
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
    persistWindowBoundsBeforeClose();
  });
}

app.whenReady().then(createWindow);

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

function getMacFrontmostSnapshot() {
  const script = `
    tell application "System Events"
      set frontProcess to first application process whose frontmost is true
      set windowTitle to ""
      try
        if (count of windows of frontProcess) > 0 then
          set windowTitle to name of first window of frontProcess
        end if
      end try
      return (name of frontProcess) & "||" & windowTitle
    end tell
  `;
  return runAppleScript(script);
}

function activateMacTeams() {
  const script = `
    tell application "System Events"
      set targetProc to missing value
      set targetWin to missing value
      repeat with proc in (application processes whose background only is false)
        try
          repeat with w in windows of proc
            if name of w contains "Teams" then
              set targetProc to proc
              set targetWin to w
              exit repeat
            end if
          end repeat
        end try
        if targetProc is not missing value then exit repeat
      end repeat
      if targetProc is not missing value then
        set frontmost of targetProc to true
        try
          perform action "AXRaise" of targetWin
        end try
      else
        tell application "Microsoft Teams" to activate
      end if
    end tell
  `;
  return runAppleScript(script);
}

function activateWindowsChromeTeams() {
  const psScript = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class TeamsChromeFinder {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    public static IntPtr FoundHandle = IntPtr.Zero;

    public static bool Callback(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) return true;
        int len = GetWindowTextLength(hWnd);
        if (len == 0) return true;
        var titleBuilder = new StringBuilder(len + 1);
        GetWindowText(hWnd, titleBuilder, titleBuilder.Capacity);
        if (titleBuilder.ToString().IndexOf("teams", StringComparison.OrdinalIgnoreCase) < 0) return true;
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        try {
            var process = System.Diagnostics.Process.GetProcessById((int)pid);
            if (process.ProcessName.IndexOf("chrome", StringComparison.OrdinalIgnoreCase) < 0) return true;
        } catch {
            return true;
        }
        FoundHandle = hWnd;
        return false;
    }

    public static IntPtr Find() {
        FoundHandle = IntPtr.Zero;
        EnumWindows(new EnumWindowsProc(Callback), IntPtr.Zero);
        return FoundHandle;
    }

    public static bool Activate(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return false;
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
        return SetForegroundWindow(hWnd);
    }
}
"@

$hwnd = [TeamsChromeFinder]::Find()
if ($hwnd -ne [IntPtr]::Zero) {
    [TeamsChromeFinder]::Activate($hwnd) | Out-Null
} else {
    $shell = New-Object -ComObject Wscript.Shell
    $shell.AppActivate('Chrome') | Out-Null
    Start-Sleep -m ${TIMING_LOCKS.windowsFallbackActivation}
    $fallbackHwnd = [TeamsChromeFinder]::Find()
    if ($fallbackHwnd -ne [IntPtr]::Zero) {
        [TeamsChromeFinder]::Activate($fallbackHwnd) | Out-Null
    }
}
`;
  return runWindowsPowerShell(psScript);
}

// 运行目标由平台配置决定，不再依据 TeamsEcho 取得焦点后的窗口标题进行猜测。
async function prepareConfirmedTarget() {
  sendToMain(
    'status-update',
    process.platform === 'darwin'
      ? '正在定位 Microsoft Teams 窗口…'
      : '正在定位 Chrome 中的 Teams 窗口…',
  );

  const result = process.platform === 'darwin'
    ? await activateMacTeams()
    : await activateWindowsChromeTeams();

  if (result.err) console.error('准备 Teams 目标失败：', result.err);
  return !isStopping;
}

function shouldPublishProgress(index, total) {
  return index === 0 || index === total - 1 || (index + 1) % PROGRESS_INTERVAL === 0;
}

async function checkAndMentionOnce(name, speedLevel, turboMode) {
  clipboard.writeText(name);

  const scaledSearchDelay = getScaledDelay(TIMING_LOCKS.mentionResult, speedLevel);
  // 仅极速 9 档：候选搜索等待不低于极速 8 档已验证值；其余档位与模式不变。
  const turboNineSearchFloor = turboMode && speedLevel === 9
    ? getScaledDelay(TIMING_LOCKS.mentionResult, 8)
    : 0;
  const searchReadyDelay = Math.max(scaledSearchDelay, turboNineSearchFloor);
  const d60 = getScaledDelay(TIMING_LOCKS.mentionStep, speedLevel) / 1000;
  const d150 = searchReadyDelay / 1000;
  const d180 = getScaledDelay(TIMING_LOCKS.mentionConfirm, speedLevel) / 1000;
  const win60 = getScaledDelay(TIMING_LOCKS.mentionStep, speedLevel);
  const win150 = searchReadyDelay;
  const win180 = getScaledDelay(TIMING_LOCKS.mentionConfirm, speedLevel);

  // 稳妥模式：@ → 左移 → 粘贴 → 1 → 删除 → 回车。
  // 极速模式：@ → 粘贴 → 1 → 删除 → 回车。
  // 每位成员的前台确认与键序放入同一脚本，恢复发布版的连续执行节奏。
  if (process.platform === 'darwin') {
    const stableLeftStep = turboMode ? '' : `
          delay ${d60}
          key code 123`;
    const result = await runAppleScript(`
      set isTeams to false
      tell application "System Events"
        set frontProcess to first application process whose frontmost is true
        set procName to name of frontProcess
        set windowTitle to ""
        try
          if (count of windows of frontProcess) > 0 then
            set windowTitle to name of first window of frontProcess
          end if
        end try
      end tell
      ignoring case
        if (procName contains "teams") or (windowTitle contains "teams") then
          set isTeams to true
        end if
      end ignoring
      if isTeams then
        delay ${d60}
        tell application "System Events"
          keystroke "@"${stableLeftStep}
          delay ${d60}
          keystroke "v" using command down
          delay ${d150}
          keystroke "1"
          delay ${d60}
          key code 51
          delay ${d180}
          key code 36
          delay ${d60}
        end tell
        "OK"
      else
        "NOT_TEAMS"
      end if
    `);
    return result.err ? '' : result.stdout.trim();
  }

  // Windows 仅识别用户指定的 Chrome 网页 Teams；不匹配时跳过，不暂停、不注入。
  const afterDelete = turboMode
    ? win180
    : Math.max(win180, TIMING_LOCKS.stableSearchBuffer);
  const stableLeftStep = turboMode ? '' : `
Start-Sleep -m ${win60}
$wshell.SendKeys("{LEFT}")`;
  const result = await runWindowsPowerShell(`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class TeamsForeground {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

$handle = [TeamsForeground]::GetForegroundWindow()
$titleBuilder = New-Object System.Text.StringBuilder 256
[TeamsForeground]::GetWindowText($handle, $titleBuilder, 256) | Out-Null
$processId = 0
[TeamsForeground]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
$processName = if ($process) { $process.ProcessName } else { "" }
$title = $titleBuilder.ToString()

if ($processName -match "(?i)chrome" -and $title -match "(?i)teams") {
    $wshell = New-Object -ComObject Wscript.Shell
    Start-Sleep -m ${win60}
    $wshell.SendKeys("@")${stableLeftStep}
    Start-Sleep -m ${win60}
    $wshell.SendKeys("^v")
    Start-Sleep -m ${win150}
    $wshell.SendKeys("1")
    Start-Sleep -m ${win60}
    $wshell.SendKeys("{BACKSPACE}")
    Start-Sleep -m ${afterDelete}
    $wshell.SendKeys("{ENTER}")
    Write-Output "OK"
} else {
    Write-Output "NOT_TEAMS"
}
`);
  return result.err ? '' : result.stdout.trim();
}

async function pasteRichContent(speedLevel) {
  const d150 = getScaledDelay(TIMING_LOCKS.mentionResult, speedLevel) / 1000;
  const win150 = getScaledDelay(TIMING_LOCKS.mentionResult, speedLevel);

  if (process.platform === 'darwin') {
    await runAppleScript(`
      delay ${d150}
      tell application "System Events" to keystroke "v" using command down
    `);
  } else {
    await runWindowsPowerShell(`
$w = New-Object -ComObject Wscript.Shell
Start-Sleep -m ${win150}
$w.SendKeys('^v')
`);
  }
}

async function safeLineBreak(speedLevel) {
  const d100 = getScaledDelay(TIMING_LOCKS.lineBreak, speedLevel) / 1000;
  const win100 = getScaledDelay(TIMING_LOCKS.lineBreak, speedLevel);

  if (process.platform === 'darwin') {
    await runAppleScript(`
      delay ${d100}
      tell application "System Events" to keystroke return using shift down
    `);
  } else {
    await runWindowsPowerShell(`
$w = New-Object -ComObject Wscript.Shell
Start-Sleep -m ${win100}
$w.SendKeys('+{ENTER}')
`);
  }
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
    safetyWindow.webContents.send('safety-mode-info', Boolean(turboMode));
  });
  safetyWindow.on('closed', () => {
    safetyWindow = null;
  });
}

async function switchToRichTextInput() {
  const currentLevel = currentAutomationData?.speedLevel || 5;
  const d80 = getScaledDelay(TIMING_LOCKS.richTextSwitch, currentLevel) / 1000;
  const win80 = getScaledDelay(TIMING_LOCKS.richTextSwitch, currentLevel);

  await prepareConfirmedTarget();
  if (isStopping) return;

  if (process.platform === 'darwin') {
    await runAppleScript(`delay ${d80}\ntell application "System Events" to keystroke "x" using {command down, shift down}`);
  } else {
    await runWindowsPowerShell(`
$w = New-Object -ComObject Wscript.Shell
Start-Sleep -m ${win80}
$w.SendKeys('^+x')
`);
  }
}

async function runMentionPass(names, speedLevel, turboMode) {
  for (let index = 0; index < names.length; index += 1) {
    if (isStopping) break;

    if (shouldPublishProgress(index, names.length)) {
      sendToMain('status-update', `正在粘贴提及：${names[index]}（${index + 1}/${names.length}）`);
    }

    const result = await checkAndMentionOnce(names[index], speedLevel, turboMode);
    if (isStopping) break;
    if (result !== 'OK') {
      sendToMain('status-update', `未在 Teams 目标窗口中，已跳过：${names[index]}（${index + 1}/${names.length}）`);
    }
  }
}

ipcMain.on('trigger-safety-check', (event, data) => {
  if (!isWindowSender(event, mainWindow)) return;
  currentAutomationData = data;
  isStopping = false;
  openSafetyWindow(Boolean(data?.turboMode));
});

ipcMain.on('safety-response', async (event, responseType) => {
  if (!isWindowSender(event, safetyWindow)) return;
  if (responseType === 'cancel') {
    if (safetyWindow) safetyWindow.close();
    currentAutomationData = null;
    sendToMain('status-update', '操作已取消，未向 Teams 写入任何数据。');
    return;
  }

  if (responseType === 'switch') {
    await switchToRichTextInput();
    return;
  }

  if (responseType !== 'confirm' || !currentAutomationData) return;
  if (safetyWindow) safetyWindow.close();

  const { names, htmlContent, textContent, sequenceMode, speedLevel, turboMode } = currentAutomationData;
  const currentLevel = Math.min(10, Math.max(1, Number.parseInt(speedLevel, 10) || 5));
  const hasContent = Boolean(textContent && textContent.trim().length > 0);
  const postBreakWait = getScaledDelay(TIMING_LOCKS.postBreak, currentLevel);
  const originalClipboard = clipboard.readText();
  isStopping = false;

  try {
    sendToMain('status-update', '自动化开始执行。');
    // 关闭安全核对窗口后仅做一次初始定位；后续每位成员在同一脚本内确认前台并执行键序。
    if (!await prepareConfirmedTarget()) return;
    sendToMain('status-update', '正在按发布版连续节奏执行。');

    if (sequenceMode === 'mentionFirst') {
      await runMentionPass(names, currentLevel, Boolean(turboMode));
      if (!isStopping && hasContent) {
        await safeLineBreak(currentLevel);
        await new Promise((resolve) => setTimeout(resolve, postBreakWait));
        if (!isStopping) {
          clipboard.write({ html: htmlContent, text: textContent });
          await pasteRichContent(currentLevel);
        }
      }
    } else if (hasContent) {
      sendToMain('status-update', '正在粘贴消息正文内容。');
      clipboard.write({ html: htmlContent, text: textContent });
      await pasteRichContent(currentLevel);
      if (!isStopping) {
        await safeLineBreak(currentLevel);
        await new Promise((resolve) => setTimeout(resolve, postBreakWait));
        if (!isStopping) await runMentionPass(names, currentLevel);
      }
    } else {
      sendToMain('status-update', '未检测到有效正文内容，跳过粘贴步骤，直接开始 @ 提及。');
      await runMentionPass(names, currentLevel, Boolean(turboMode));
    }

    sendToMain('status-update', isStopping ? '自动化已停止。' : '自动化执行完毕。');
  } catch (error) {
    console.error('自动化执行失败：', error);
    sendToMain('status-update', '自动化执行出现异常，已停止。请检查 Teams 窗口后重试。');
  } finally {
    currentAutomationData = null;
    setTimeout(() => clipboard.writeText(originalClipboard), TIMING_LOCKS.clipboardRestore);
  }
});

ipcMain.on('stop-automation', (event) => {
  if (!isWindowSender(event, mainWindow)) return;
  isStopping = true;
});
