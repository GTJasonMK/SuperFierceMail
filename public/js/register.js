/**
 * 注册申请页面逻辑
 */
(function() {
  'use strict';

  const localPartInput = document.getElementById('local-part');
  const domainSelect = document.getElementById('domain-select');
  const passwordInput = document.getElementById('password');
  const confirmPasswordInput = document.getElementById('confirm-password');
  const submitBtn = document.getElementById('submit-btn');
  const errDiv = document.getElementById('err');
  const registerForm = document.getElementById('register-form');
  const successCard = document.getElementById('success-card');
  const successEmail = document.getElementById('success-email');
  const successPassword = document.getElementById('success-password');
  const exportAccountBtn = document.getElementById('export-account');
  const copyAllBtn = document.getElementById('copy-all');

  // 保存注册信息用于导出
  let registeredAccount = null;

  /**
   * 显示错误信息
   * @param {string} msg - 错误信息
   */
  function showError(msg) {
    errDiv.textContent = msg;
    errDiv.style.display = msg ? 'block' : 'none';
  }

  /**
   * 加载可用域名列表
   */
  async function loadDomains() {
    try {
      const response = await fetch('/api/domains');
      if (!response.ok) {
        throw new Error('获取域名列表失败');
      }
      const domains = await response.json();

      domainSelect.innerHTML = '';
      if (Array.isArray(domains) && domains.length > 0) {
        domains.forEach(function(domain, index) {
          const option = document.createElement('option');
          option.value = domain;
          option.textContent = '@' + domain;
          domainSelect.appendChild(option);
        });
      } else {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '无可用域名';
        domainSelect.appendChild(option);
      }
    } catch (e) {
      console.error('加载域名失败:', e);
      domainSelect.innerHTML = '<option value="">加载失败</option>';
    }
  }

  /**
   * 验证表单
   * @returns {object|null} 验证通过返回表单数据，否则返回null
   */
  function validateForm() {
    const localPart = localPartInput.value.trim().toLowerCase();
    const domain = domainSelect.value;
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (!localPart) {
      showError('请输入用户名');
      localPartInput.focus();
      return null;
    }

    if (!/^[a-z0-9._-]{1,64}$/i.test(localPart)) {
      showError('用户名格式不正确（只能包含字母、数字、点、下划线、横线）');
      localPartInput.focus();
      return null;
    }

    if (!domain) {
      showError('请选择域名');
      domainSelect.focus();
      return null;
    }

    if (!password) {
      showError('请输入密码');
      passwordInput.focus();
      return null;
    }

    if (password.length < 6) {
      showError('密码长度至少6位');
      passwordInput.focus();
      return null;
    }

    if (password !== confirmPassword) {
      showError('两次输入的密码不一致');
      confirmPasswordInput.focus();
      return null;
    }

    showError('');
    return {
      local_part: localPart,
      domain: domain,
      password: password
    };
  }

  /**
   * 提交注册申请
   */
  async function submitRegistration() {
    const formData = validateForm();
    if (!formData) return;

    submitBtn.disabled = true;
    submitBtn.textContent = '提交中...';

    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(formData)
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { message: text };
      }

      if (response.ok && data.success) {
        // 保存注册信息
        const email = formData.local_part + '@' + formData.domain;
        registeredAccount = {
          email: email,
          password: formData.password
        };

        // 显示成功界面
        successEmail.textContent = email;
        successPassword.textContent = formData.password;
        registerForm.style.display = 'none';
        successCard.style.display = 'block';

        if (window.showToast) {
          window.showToast('申请已提交', 'success');
        }
      } else {
        showError(data.message || text || '提交失败');
        if (window.showToast) {
          window.showToast(data.message || text || '提交失败', 'error');
        }
      }
    } catch (e) {
      console.error('提交注册申请失败:', e);
      showError('网络错误，请稍后重试');
      if (window.showToast) {
        window.showToast('网络错误', 'error');
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '提交申请';
    }
  }

  /**
   * 复制文本到剪贴板
   */
  window.copyText = async function(text) {
    try {
      await navigator.clipboard.writeText(text);
      if (window.showToast) {
        window.showToast('已复制', 'success');
      }
    } catch (e) {
      // 降级方案
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      if (window.showToast) {
        window.showToast('已复制', 'success');
      }
    }
  };

  /**
   * 一键复制所有信息
   */
  function copyAllInfo() {
    if (!registeredAccount) return;
    const text = '邮箱: ' + registeredAccount.email + '\n密码: ' + registeredAccount.password;
    window.copyText(text);
  }

  /**
   * 导出账号信息为文本文件
   */
  function exportAccount() {
    if (!registeredAccount) return;

    const content = [
      '=== 临时邮箱账号信息 ===',
      '',
      '邮箱地址: ' + registeredAccount.email,
      '密码: ' + registeredAccount.password,
      '',
      '提示: 请等待管理员审核通过后再登录',
      '导出时间: ' + new Date().toLocaleString('zh-CN')
    ].join('\r\n');

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'account_' + registeredAccount.email.split('@')[0] + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (window.showToast) {
      window.showToast('已导出账号信息', 'success');
    }
  }

  // 绑定事件
  submitBtn.addEventListener('click', submitRegistration);

  // 回车提交
  [localPartInput, passwordInput, confirmPasswordInput].forEach(function(input) {
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        submitRegistration();
      }
    });
  });

  // 导出和复制按钮
  if (exportAccountBtn) {
    exportAccountBtn.addEventListener('click', exportAccount);
  }
  if (copyAllBtn) {
    copyAllBtn.addEventListener('click', copyAllInfo);
  }

  // 初始化
  loadDomains();
})();
