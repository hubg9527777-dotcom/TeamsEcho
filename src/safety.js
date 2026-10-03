    const modeBanner = document.getElementById('modeBanner');
    document.getElementById('confirmBtn').addEventListener('click', () => window.teamsEchoAPI.safetyResponse('confirm'));
    document.getElementById('switchBtn').addEventListener('click', () => window.teamsEchoAPI.safetyResponse('switch'));
    document.getElementById('cancelBtn').addEventListener('click', () => window.teamsEchoAPI.safetyResponse('cancel'));
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') window.teamsEchoAPI.safetyResponse('cancel');
    });
    window.teamsEchoAPI.onSafetyModeInfo((turboMode) => {
      modeBanner.classList.toggle('turbo', turboMode);
      modeBanner.innerText = turboMode
        ? '极速模式：@ → 粘贴 → 1 → 删除 → 回车。请先在测试群确认同名或相近姓名不会误选。'
        : '稳妥模式：@ → 左移 → 粘贴 → 1 → 删除 → 回车。Windows 保留 103ms 搜索/缓冲锁。';
    });
