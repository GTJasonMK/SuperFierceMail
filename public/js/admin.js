/**
 * admin.js - 管理后台脚本
 */

// API 请求封装
async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'include', ...options });
  return res;
}

// Toast 提示
function showToast(msg, type = 'info') {
  if (window.showToast) {
    window.showToast(msg, type);
  } else {
    alert(msg);
  }
}

// 模态框控制
function openModal(modal) {
  if (modal) modal.classList.add('show');
}

function closeModal(modal) {
  if (modal) modal.classList.remove('show');
}

// 全局状态
let domains = [];
let pendingEmail = null; // 待添加的邮箱地址

// DOM 元素
const els = {
  // 顶栏
  logout: document.getElementById('logout'),
  themeToggle: document.getElementById('theme-toggle'),

  // 邮箱生成
  domainSelect: document.getElementById('domain-select'),
  lenRange: document.getElementById('len-range'),
  lenVal: document.getElementById('len-val'),
  genRandom: document.getElementById('gen-random'),
  genName: document.getElementById('gen-name'),
  customLocal: document.getElementById('custom-local'),
  genCustom: document.getElementById('gen-custom'),
  generatedEmail: document.getElementById('generated-email'),
  emailText: document.getElementById('email-text'),
  addEmail: document.getElementById('add-email'),

  // 统计数据
  statTotalMailboxes: document.getElementById('stat-total-mailboxes'),
  statTotalMessages: document.getElementById('stat-total-messages'),
  statTodayMailboxes: document.getElementById('stat-today-mailboxes'),
  statTodayMessages: document.getElementById('stat-today-messages'),
  trendChart: document.getElementById('trend-chart'),
  activeMailboxes: document.getElementById('active-mailboxes'),
  sourceStats: document.getElementById('source-stats'),
  domainStats: document.getElementById('domain-stats'),
  permissionStats: document.getElementById('permission-stats'),

  // 确认模态框
  confirmModal: document.getElementById('confirm-modal'),
  confirmMessage: document.getElementById('confirm-message'),
  confirmOk: document.getElementById('confirm-ok'),

  // 添加邮箱配置模态框
  addEmailModal: document.getElementById('add-email-modal'),
  addEmailAddress: document.getElementById('add-email-address'),
  addEmailPassword: document.getElementById('add-email-password'),
  addEmailPasswordConfirm: document.getElementById('add-email-password-confirm'),
  addEmailCanLogin: document.getElementById('add-email-can-login'),
  addEmailConfirm: document.getElementById('add-email-confirm'),
  addEmailCancel: document.getElementById('add-email-cancel'),
  addEmailClose: document.getElementById('add-email-close'),
  customPasswordGroup: document.getElementById('custom-password-group'),

  toast: document.getElementById('toast')
};

let confirmCallback = null;

// ==================== 初始化 ====================

async function init() {
  // 加载域名列表
  await loadDomains();

  // 加载系统统计
  await loadSystemStats();

  // 绑定事件
  bindEvents();
}

// 加载域名
async function loadDomains() {
  try {
    const res = await api('/api/domains');
    if (res.ok) {
      domains = await res.json();
      renderDomains();
    }
  } catch (e) {
    console.error('加载域名失败:', e);
  }
}

function renderDomains() {
  if (!els.domainSelect) return;
  els.domainSelect.innerHTML = domains.map(d => `<option value="${d}">${d}</option>`).join('');
}

// 加载系统统计
async function loadSystemStats() {
  try {
    const res = await api('/api/admin/stats');
    if (res.ok) {
      const data = await res.json();
      renderStats(data);
    } else {
      showStatsError('加载统计数据失败');
    }
  } catch (e) {
    console.error('加载统计数据失败:', e);
    showStatsError('加载统计数据失败');
  }
}

function showStatsError(msg) {
  const errorHtml = `<div class="stats-loading">${msg}</div>`;
  if (els.trendChart) els.trendChart.innerHTML = errorHtml;
  if (els.activeMailboxes) els.activeMailboxes.innerHTML = errorHtml;
  if (els.sourceStats) els.sourceStats.innerHTML = errorHtml;
  if (els.domainStats) els.domainStats.innerHTML = errorHtml;
  if (els.permissionStats) els.permissionStats.innerHTML = errorHtml;
}

/**
 * 渲染所有统计数据
 */
function renderStats(data) {
  // 核心指标
  if (els.statTotalMailboxes) els.statTotalMailboxes.textContent = formatNumber(data.totalMailboxes);
  if (els.statTotalMessages) els.statTotalMessages.textContent = formatNumber(data.totalMessages);
  if (els.statTodayMailboxes) els.statTodayMailboxes.textContent = formatNumber(data.todayMailboxes);
  if (els.statTodayMessages) els.statTodayMessages.textContent = formatNumber(data.todayMessages);

  // 7天趋势图
  renderTrendChart(data.trend || []);

  // 活跃邮箱榜
  renderActiveMailboxes(data.activeMailboxes || []);

  // 邮件来源
  renderSourceStats(data.sourceDomains || []);

  // 域名分布
  renderDomainStats(data.mailboxDomains || []);

  // 权限分布
  renderPermissionStats(data.permissionStats || {});
}

/**
 * 格式化数字（添加千分位）
 */
function formatNumber(num) {
  if (num === null || num === undefined) return '-';
  return num.toLocaleString();
}

/**
 * 渲染7天趋势图
 */
function renderTrendChart(trend) {
  if (!els.trendChart) return;

  if (!trend || trend.length === 0) {
    els.trendChart.innerHTML = '<div class="stats-loading">暂无数据</div>';
    return;
  }

  // 计算最大值用于缩放
  const maxMailboxes = Math.max(...trend.map(t => t.mailboxes), 1);
  const maxMessages = Math.max(...trend.map(t => t.messages), 1);
  const maxVal = Math.max(maxMailboxes, maxMessages);

  const barsHtml = trend.map(t => {
    const mailboxHeight = maxVal > 0 ? Math.max((t.mailboxes / maxVal) * 120, 4) : 4;
    const messageHeight = maxVal > 0 ? Math.max((t.messages / maxVal) * 120, 4) : 4;
    return `
      <div class="trend-bar">
        <div class="trend-bar-inner">
          <span class="trend-bar-value">${t.mailboxes}</span>
          <div class="trend-bar-fill mailbox" style="height:${mailboxHeight}px;"></div>
        </div>
        <div class="trend-bar-inner">
          <span class="trend-bar-value">${t.messages}</span>
          <div class="trend-bar-fill message" style="height:${messageHeight}px;"></div>
        </div>
        <span class="trend-bar-label">${t.date}</span>
      </div>
    `;
  }).join('');

  els.trendChart.innerHTML = `
    <div class="trend-bars">${barsHtml}</div>
    <div class="trend-legend">
      <div class="trend-legend-item">
        <span class="trend-legend-dot mailbox"></span>
        <span>新邮箱</span>
      </div>
      <div class="trend-legend-item">
        <span class="trend-legend-dot message"></span>
        <span>新邮件</span>
      </div>
    </div>
  `;
}

/**
 * 渲染活跃邮箱榜
 */
function renderActiveMailboxes(mailboxes) {
  if (!els.activeMailboxes) return;

  if (!mailboxes || mailboxes.length === 0) {
    els.activeMailboxes.innerHTML = '<div class="stats-loading">暂无数据</div>';
    return;
  }

  const html = mailboxes.map((item, idx) => `
    <div class="active-mailbox-item">
      <span class="active-mailbox-rank${idx < 3 ? ' top' : ''}">${idx + 1}</span>
      <span class="active-mailbox-addr" title="${item.address}">${item.address}</span>
      <span class="active-mailbox-count">${item.count}</span>
    </div>
  `).join('');

  els.activeMailboxes.innerHTML = `<div class="active-mailbox-list">${html}</div>`;
}

/**
 * 渲染邮件来源统计
 */
function renderSourceStats(sources) {
  if (!els.sourceStats) return;

  if (!sources || sources.length === 0) {
    els.sourceStats.innerHTML = '<div class="stats-loading">暂无数据</div>';
    return;
  }

  const maxCount = Math.max(...sources.map(s => s.count), 1);

  const html = sources.map((item, idx) => `
    <div class="stats-list-item">
      <span class="stats-list-rank${idx < 3 ? ' top' : ''}">${idx + 1}</span>
      <span class="stats-list-name" title="${item.domain}">${item.domain}</span>
      <div class="stats-list-bar">
        <div class="stats-list-bar-fill" style="width:${(item.count / maxCount) * 100}%;"></div>
      </div>
      <span class="stats-list-value">${item.count}</span>
    </div>
  `).join('');

  els.sourceStats.innerHTML = `<div class="stats-list">${html}</div>`;
}

/**
 * 渲染域名分布
 */
function renderDomainStats(domains) {
  if (!els.domainStats) return;

  if (!domains || domains.length === 0) {
    els.domainStats.innerHTML = '<div class="stats-loading">暂无数据</div>';
    return;
  }

  const colors = ['primary', 'success', 'warning', 'danger'];

  const html = domains.map((item, idx) => `
    <div class="stats-progress-item">
      <div class="stats-progress-header">
        <span class="stats-progress-label">${item.domain}</span>
        <span class="stats-progress-value">${item.count} (${item.percentage}%)</span>
      </div>
      <div class="stats-progress-bar">
        <div class="stats-progress-fill ${colors[idx % colors.length]}" style="width:${item.percentage}%;"></div>
      </div>
    </div>
  `).join('');

  els.domainStats.innerHTML = `<div class="stats-progress">${html}</div>`;
}

/**
 * 渲染权限分布
 */
function renderPermissionStats(stats) {
  if (!els.permissionStats) return;

  const total = (stats.canLogin || 0) + (stats.cannotLogin || 0);
  const totalPwd = (stats.defaultPassword || 0) + (stats.customPassword || 0);

  if (total === 0) {
    els.permissionStats.innerHTML = '<div class="stats-loading">暂无数据</div>';
    return;
  }

  const canLoginPct = total > 0 ? Math.round((stats.canLogin / total) * 100) : 0;
  const customPwdPct = totalPwd > 0 ? Math.round((stats.customPassword / totalPwd) * 100) : 0;

  els.permissionStats.innerHTML = `
    <div class="stats-progress">
      <div class="stats-progress-item">
        <div class="stats-progress-header">
          <span class="stats-progress-label">允许登录</span>
          <span class="stats-progress-value">${stats.canLogin || 0} / ${total} (${canLoginPct}%)</span>
        </div>
        <div class="stats-progress-bar">
          <div class="stats-progress-fill primary" style="width:${canLoginPct}%;"></div>
        </div>
      </div>
      <div class="stats-progress-item">
        <div class="stats-progress-header">
          <span class="stats-progress-label">禁止登录</span>
          <span class="stats-progress-value">${stats.cannotLogin || 0} / ${total} (${100 - canLoginPct}%)</span>
        </div>
        <div class="stats-progress-bar">
          <div class="stats-progress-fill danger" style="width:${100 - canLoginPct}%;"></div>
        </div>
      </div>
      <div class="stats-progress-item">
        <div class="stats-progress-header">
          <span class="stats-progress-label">自定义密码</span>
          <span class="stats-progress-value">${stats.customPassword || 0} / ${totalPwd} (${customPwdPct}%)</span>
        </div>
        <div class="stats-progress-bar">
          <div class="stats-progress-fill success" style="width:${customPwdPct}%;"></div>
        </div>
      </div>
      <div class="stats-progress-item">
        <div class="stats-progress-header">
          <span class="stats-progress-label">默认密码</span>
          <span class="stats-progress-value">${stats.defaultPassword || 0} / ${totalPwd} (${100 - customPwdPct}%)</span>
        </div>
        <div class="stats-progress-bar">
          <div class="stats-progress-fill warning" style="width:${100 - customPwdPct}%;"></div>
        </div>
      </div>
    </div>
  `;
}

// ==================== 邮箱生成 ====================

function generateRandomString(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function generateRandomName() {
  const firstNames = ['john', 'jane', 'mike', 'lisa', 'tom', 'amy', 'david', 'emma', 'chris', 'sarah'];
  const lastNames = ['smith', 'johnson', 'williams', 'brown', 'jones', 'davis', 'miller', 'wilson'];
  const first = firstNames[Math.floor(Math.random() * firstNames.length)];
  const last = lastNames[Math.floor(Math.random() * lastNames.length)];
  const num = Math.floor(Math.random() * 100);
  return `${first}.${last}${num}`;
}

/**
 * 生成邮箱地址（只生成不创建）
 */
function generateEmail(localPart) {
  const domain = els.domainSelect?.value || domains[0];
  if (!localPart || !domain) {
    showToast('请输入用户名', 'warn');
    return;
  }

  const email = `${localPart}@${domain}`;
  pendingEmail = { local: localPart, domain, email };
  showGeneratedEmail(email);
}

function showGeneratedEmail(email) {
  if (els.emailText) els.emailText.textContent = email;
  if (els.generatedEmail) els.generatedEmail.classList.remove('hidden');
}

// ==================== 添加邮箱模态框 ====================

function showAddEmailModal() {
  if (!pendingEmail) {
    showToast('请先生成邮箱地址', 'warn');
    return;
  }

  // 显示邮箱地址
  if (els.addEmailAddress) {
    els.addEmailAddress.textContent = pendingEmail.email;
  }

  // 重置表单
  const defaultRadio = document.querySelector('input[name="password-type"][value="default"]');
  if (defaultRadio) defaultRadio.checked = true;
  if (els.customPasswordGroup) els.customPasswordGroup.classList.add('hidden');
  if (els.addEmailPassword) els.addEmailPassword.value = '';
  if (els.addEmailPasswordConfirm) els.addEmailPasswordConfirm.value = '';
  if (els.addEmailCanLogin) els.addEmailCanLogin.checked = true;

  openModal(els.addEmailModal);
}

function closeAddEmailModal() {
  closeModal(els.addEmailModal);
}

/**
 * 确认添加邮箱
 */
async function confirmAddEmail() {
  if (!pendingEmail) return;

  const passwordType = document.querySelector('input[name="password-type"]:checked')?.value;
  const canLogin = els.addEmailCanLogin?.checked ?? true;

  let password = null;

  // 如果选择自定义密码，验证密码
  if (passwordType === 'custom') {
    const pwd = els.addEmailPassword?.value || '';
    const pwdConfirm = els.addEmailPasswordConfirm?.value || '';

    if (pwd.length < 6) {
      showToast('密码至少6位', 'warn');
      return;
    }
    if (pwd !== pwdConfirm) {
      showToast('两次密码不一致', 'warn');
      return;
    }
    password = pwd;
  }

  // 获取域名索引
  const domainIndex = domains.indexOf(pendingEmail.domain);

  try {
    const body = {
      local: pendingEmail.local,
      domainIndex: domainIndex >= 0 ? domainIndex : 0,
      canLogin: canLogin
    };

    // 如果有自定义密码，添加到请求体
    if (password) {
      body.password = password;
    }

    const res = await api('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      showToast('邮箱创建成功', 'success');
      closeAddEmailModal();
      // 刷新统计
      loadSystemStats();
    } else {
      const text = await res.text();
      showToast(text || '创建失败', 'warn');
    }
  } catch (e) {
    showToast('创建失败: ' + e.message, 'warn');
  }
}

// ==================== 确认对话框 ====================

function showConfirm(message, callback) {
  if (els.confirmMessage) els.confirmMessage.textContent = message;
  confirmCallback = callback;
  openModal(els.confirmModal);
}

// ==================== 事件绑定 ====================

function bindEvents() {
  // 退出登录
  els.logout?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.replace('/login.html');
  });

  // 长度滑块
  els.lenRange?.addEventListener('input', () => {
    if (els.lenVal) els.lenVal.textContent = els.lenRange.value;
  });

  // 随机生成（只生成不创建）
  els.genRandom?.addEventListener('click', () => {
    const len = parseInt(els.lenRange?.value) || 8;
    generateEmail(generateRandomString(len));
  });

  // 随机人名（只生成不创建）
  els.genName?.addEventListener('click', () => {
    generateEmail(generateRandomName());
  });

  // 自定义生成（只生成不创建）
  els.genCustom?.addEventListener('click', () => {
    const local = els.customLocal?.value?.trim();
    if (local) {
      generateEmail(local);
      if (els.customLocal) els.customLocal.value = '';
    } else {
      showToast('请输入用户名', 'warn');
    }
  });

  // 添加邮箱按钮 - 打开配置模态框
  els.addEmail?.addEventListener('click', showAddEmailModal);

  // 添加邮箱模态框 - 确认添加
  els.addEmailConfirm?.addEventListener('click', confirmAddEmail);

  // 添加邮箱模态框 - 取消
  els.addEmailCancel?.addEventListener('click', closeAddEmailModal);
  els.addEmailClose?.addEventListener('click', closeAddEmailModal);

  // 密码类型切换
  document.querySelectorAll('input[name="password-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isCustom = radio.value === 'custom' && radio.checked;
      if (els.customPasswordGroup) {
        if (isCustom) {
          els.customPasswordGroup.classList.remove('hidden');
        } else {
          els.customPasswordGroup.classList.add('hidden');
        }
      }
    });
  });

  // 确认模态框
  els.confirmOk?.addEventListener('click', () => {
    if (confirmCallback) {
      confirmCallback();
      confirmCallback = null;
    }
  });

  // 模态框关闭按钮
  document.querySelectorAll('.modal-close, .modal .close').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal');
      if (modal) closeModal(modal);
    });
  });

  // 点击模态框背景关闭
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });
}

// 启动
init();
