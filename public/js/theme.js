// 主题切换模块
// 支持亮色(light)和暗色(dark)主题，默认跟随系统偏好

const THEME_KEY = 'mf:theme';

// 获取系统主题偏好
function getSystemTheme() {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

// 获取保存的主题偏好
function getSavedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch (_) {
    return null;
  }
}

// 保存主题偏好
function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) {
    // 忽略存储错误
  }
}

// 应用主题
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  updateToggleButton(theme);
}

// 更新切换按钮图标
function updateToggleButton(theme) {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  if (theme === 'dark') {
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
    btn.title = '切换到亮色主题';
  } else {
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    btn.title = '切换到暗色主题';
  }
}

// 切换主题
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  saveTheme(next);
}

// 初始化主题
function initTheme() {
  const saved = getSavedTheme();
  const theme = saved || getSystemTheme();
  applyTheme(theme);

  // 监听系统主题变化（仅当用户未手动设置时）
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!getSavedTheme()) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  }
}

// 绑定切换按钮事件
function bindToggleButton() {
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', toggleTheme);
  }
}

// 页面加载时初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    bindToggleButton();
  });
} else {
  initTheme();
  bindToggleButton();
}

// 导出供其他模块使用
export { initTheme, toggleTheme, applyTheme };
