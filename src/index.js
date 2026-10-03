    const namesInput = document.getElementById('namesInput');
    const richEditor = document.getElementById('richEditor');
    const previewText = document.getElementById('previewText');
    const progressText = document.getElementById('progressText');
    const sequenceMode = document.getElementById('sequenceMode');
    const speedSlider = document.getElementById('speedSlider');
    const speedLabel = document.getElementById('speedLabel');
    const modeSafe = document.getElementById('modeSafe');
    const modeTurbo = document.getElementById('modeTurbo');
    const modeHint = document.getElementById('modeHint');

    let turboMode = false;
    let speedRates = {
      1: 3.00, 2: 2.28, 3: 1.73, 4: 1.32, 5: 1.00,
      6: 0.57, 7: 0.32, 8: 0.185, 9: 0.105, 10: 0.06,
    };
    let saveTimer = null;

    function getCleanNames() {
      return namesInput.value.split('\n')
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && !name.startsWith('#'));
    }

    function updateSpeedUI(value) {
      speedLabel.innerText = `${value} 档（${speedRates[value]}x）`;
    }

    function updatePreview() {
      const names = getCleanNames();
      const sample = names.slice(0, 3).join('、');
      const suffix = names.length > 3 ? ' 等' : '';
      previewText.innerText = names.length
        ? `待提及名单：${sample}${suffix}（共 ${names.length} 人）`
        : '待提及名单：共 0 人';
    }

    function getSettings() {
      return {
        sequenceMode: sequenceMode.value,
        speedLevel: Number.parseInt(speedSlider.value, 10),
        turboMode,
      };
    }

    function updateModeUI() {
      modeSafe.classList.toggle('active-safe', !turboMode);
      modeTurbo.classList.toggle('active-turbo', turboMode);
      modeHint.classList.toggle('turbo', turboMode);
      modeHint.innerText = turboMode
        ? '极速模式：@ → 粘贴 → 1 → 删除 → 回车。省去左移以提升速度；同名或相近姓名可能存在误选风险，请先在测试群验证。'
        : '稳妥模式：@ → 左移 → 粘贴 → 1 → 删除 → 回车。Windows 保留 103ms 搜索/缓冲锁。';
    }

    function setTurboMode(value) {
      turboMode = value;
      updateModeUI();
      persistSettings(true);
    }

    function persistSettings(immediate = false) {
      const save = () => window.teamsEchoAPI.saveSettings(getSettings());
      window.clearTimeout(saveTimer);
      if (immediate) {
        save();
        return;
      }
      saveTimer = window.setTimeout(save, 220);
    }

    speedSlider.addEventListener('input', (event) => {
      updateSpeedUI(event.target.value);
      persistSettings();
    });
    speedSlider.addEventListener('change', () => persistSettings(true));
    sequenceMode.addEventListener('change', () => persistSettings(true));
    modeSafe.addEventListener('click', () => setTurboMode(false));
    modeTurbo.addEventListener('click', () => setTurboMode(true));
    namesInput.addEventListener('input', updatePreview);

    document.getElementById('startBtn').addEventListener('click', () => {
      const names = getCleanNames();
      if (names.length === 0) {
        alert('请输入有效名单。');
        return;
      }
      window.teamsEchoAPI.triggerSafetyCheck({
        names,
        htmlContent: richEditor.innerHTML,
        textContent: richEditor.innerText,
        sequenceMode: sequenceMode.value,
        speedLevel: Number.parseInt(speedSlider.value, 10),
        turboMode,
      });
    });

    document.getElementById('stopBtn').addEventListener('click', () => {
      window.teamsEchoAPI.stopAutomation();
      progressText.innerText = '状态：正在安全停止当前步骤…';
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') document.getElementById('stopBtn').click();
    });

    window.teamsEchoAPI.onStatusUpdate((message) => {
      progressText.innerText = `状态：${message}`;
    });

    window.addEventListener('DOMContentLoaded', async () => {
      const [profile, settings] = await Promise.all([
        window.teamsEchoAPI.getRuntimeProfile(),
        window.teamsEchoAPI.loadSettings(),
      ]);
      if (profile?.speedRates) speedRates = profile.speedRates;
      if (settings?.sequenceMode) sequenceMode.value = settings.sequenceMode;
      if (settings?.speedLevel) speedSlider.value = settings.speedLevel;
      turboMode = Boolean(settings?.turboMode);
      updateSpeedUI(speedSlider.value);
      updateModeUI();
      updatePreview();
    });

    window.addEventListener('beforeunload', () => persistSettings(true));
