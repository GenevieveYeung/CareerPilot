(function () {
  const originalMine = window.mine;
  const api = (url, options = {}) => window.__careerPilotApiRequest(url, options);
  const escLocal = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const uiDefaults = {
    oa: [{ key: 'D-3', days: 3, time: '09:00', enabled: true }, { key: 'D-2', days: 2, time: '09:00', enabled: true }, { key: 'D-1', days: 1, time: '09:00', enabled: true }, { key: 'D0', days: 0, time: '08:00', enabled: true }],
    interview: [{ key: 'D-1', days: 1, time: '09:00', enabled: true }, { key: 'D0', days: 0, time: '08:00', enabled: true }, { key: 'T-2H', minutes_before: 120, time: '', enabled: true }],
    offer: [{ key: 'D-3', days: 3, time: '09:00', enabled: true }, { key: 'D-2', days: 2, time: '09:00', enabled: true }, { key: 'D-1', days: 1, time: '09:00', enabled: true }, { key: 'D0', days: 0, time: '08:00', enabled: true }],
    application: [{ key: 'D-2', days: 2, time: '09:00', enabled: true }, { key: 'D-1', days: 1, time: '09:00', enabled: true }],
  };
  const labels = { oa: '在线测评截止', interview: '面试', offer: 'Offer 截止', application: '岗位申请截止' };
  let credentialStatusRequest = 0;
  let credentialConfigured = false;
  let editingCredential = false;
  const settingValue = key => (S.settings || []).find(row => row.key === key)?.value || '';
  function readConfig() {
    let saved = {};
    try { saved = JSON.parse(settingValue('reminder_settings') || '{}'); } catch (_) { saved = {}; }
    const schedule = {};
    Object.entries(uiDefaults).forEach(([kind, rules]) => { schedule[kind] = rules.map((rule, index) => ({ ...rule, ...(saved.schedule?.[kind]?.[index] || {}) })); });
    return { enabled: saved.enabled === true, sender_email: saved.sender_email || '', recipient_email: saved.recipient_email || '', schedule };
  }
  function tabs(active) { return window.CAREERPILOT_NAV.renderMyTabs(active); }
  function scheduleRows(config) {
    return Object.entries(config.schedule).map(([kind, rules]) => `<div class="section"><h2>${labels[kind]}</h2><div class="tablebox"><table class="table"><thead><tr><th>提醒节点</th><th>启用</th><th>${kind === 'interview' ? '提前天数/分钟' : '提前天数'}</th><th>发送时间</th></tr></thead><tbody>${rules.map(rule => `<tr data-rem-rule data-rem-kind="${kind}" data-rem-key="${escLocal(rule.key)}"><td>${escLocal(rule.key)}${rule.minutes_before != null ? '（距面试）' : ''}</td><td><input type="checkbox" data-rem-enabled ${rule.enabled !== false ? 'checked' : ''}></td><td>${rule.minutes_before != null ? `<input data-rem-minutes type="number" min="1" max="1440" value="${Number(rule.minutes_before) || 120}">` : `<input data-rem-days type="number" min="0" max="60" value="${Number(rule.days) || 0}">`}</td><td><input data-rem-time type="time" value="${escLocal(rule.time || '')}" ${rule.minutes_before != null ? 'disabled' : ''}></td></tr>`).join('')}</tbody></table></div></div>`).join('');
  }
  function renderReminderSettings() {
    const config = readConfig();
    $('mine').innerHTML = `<div class="head"><div><h1>提醒设置</h1><p>邮件提醒 · 只根据申请事件和截止日期提醒，不会创建另一套日历。</p></div></div>${tabs(5)}<div class="surface"><h2>邮件提醒</h2><div class="form"><div class="field"><label>发件 QQ 邮箱</label><input id="rem-sender" type="email" value="${escLocal(config.sender_email)}" placeholder="你的 QQ 邮箱"></div><div class="field"><label>收件邮箱</label><input id="rem-recipient" type="email" value="${escLocal(config.recipient_email)}"></div><div class="field"><label>邮件提醒开关</label><label><input id="rem-enabled" type="checkbox" ${config.enabled ? 'checked' : ''}> 启用截止日期提醒</label></div></div><div class="notice" style="margin-top:14px">QQ Mail 只使用 SMTP 授权码，不使用 QQ 登录密码。授权码不会写入主数据、页面或日志。</div><div class="pathbox" style="margin-top:14px"><div class="between"><b>SMTP 授权码</b><span id="rem-credential-status">正在检查…</span></div><div id="rem-credential-controls" class="pathline"><input id="rem-auth" type="password" autocomplete="new-password" placeholder="输入新的 QQ SMTP 授权码"><button class="btn" data-edit-reminder-credential>修改授权码</button><button class="btn" data-save-reminder-credential>保存授权码</button><button class="btn" data-cancel-reminder-credential>取消</button><button class="btn" data-delete-reminder-credential>删除授权码</button></div></div><div class="run"><span class="sub">电脑完全关机时无法发送；开机后 worker 会检查尚未发送的提醒。</span><div class="actions"><button class="btn" data-save-reminder-settings>保存设置</button><button class="btn primary" data-test-reminder>发送测试邮件</button></div></div></div><div style="margin-top:18px">${scheduleRows(config)}</div>`;
    renderCredentialControls();
    refreshCredentialStatus();
  }
  window.__renderReminderSettings = renderReminderSettings;
  function renderCredentialControls() {
    const input = $('rem-auth'); const edit = document.querySelector('[data-edit-reminder-credential]'); const save = document.querySelector('[data-save-reminder-credential]'); const cancel = document.querySelector('[data-cancel-reminder-credential]'); const del = document.querySelector('[data-delete-reminder-credential]');
    if (!input || !edit || !save || !cancel || !del) return;
    input.value = '';
    input.style.display = credentialConfigured && !editingCredential ? 'none' : '';
    input.placeholder = credentialConfigured ? '输入新的 QQ SMTP 授权码' : '输入 QQ SMTP 授权码';
    edit.style.display = credentialConfigured && !editingCredential ? '' : 'none';
    save.style.display = !credentialConfigured || editingCredential ? '' : 'none';
    save.textContent = editingCredential ? '确认替换' : '保存授权码';
    cancel.style.display = editingCredential ? '' : 'none';
    del.style.display = credentialConfigured && !editingCredential ? '' : 'none';
  }
  async function refreshCredentialStatus() {
    const node = $('rem-credential-status'); if (!node) return;
    const requestId = ++credentialStatusRequest;
    try { const result = await api('/api/reminders/settings'); if (requestId !== credentialStatusRequest) return; credentialConfigured = result.credential_configured === true; node.textContent = result.credential_storage_error ? '授权码需要重新配置' : result.credential_sender_mismatch ? '发件邮箱已更改，请重新配置授权码' : credentialConfigured ? '授权码：已配置' : '授权码：尚未配置'; renderCredentialControls(); } catch (_) { if (requestId === credentialStatusRequest) node.textContent = '授权码状态暂时无法读取'; }
  }
  function collectSettings() {
    const schedule = {};
    document.querySelectorAll('[data-rem-rule]').forEach(row => {
      const kind = row.dataset.remKind; schedule[kind] ||= [];
      const rule = { key: row.dataset.remKey, enabled: row.querySelector('[data-rem-enabled]').checked, time: row.querySelector('[data-rem-time]')?.value || '' };
      const minutes = row.querySelector('[data-rem-minutes]'); if (minutes) rule.minutes_before = Number(minutes.value || 120); else rule.days = Number(row.querySelector('[data-rem-days]')?.value || 0);
      schedule[kind].push(rule);
    });
    return { enabled: $('rem-enabled').checked, sender_email: $('rem-sender').value.trim(), recipient_email: $('rem-recipient').value.trim(), schedule };
  }
  window.mine = function () {
    if (tab === 5) return renderReminderSettings();
    originalMine();
  };
  document.addEventListener('click', async event => {
    const reminderTab = event.target.closest('#mine [data-tab="5"]');
    if (reminderTab) {
      event.preventDefault();
      event.stopImmediatePropagation();
      tab = 5;
      renderReminderSettings();
      return;
    }
    const button = event.target.closest('[data-save-reminder-settings],[data-save-reminder-credential],[data-delete-reminder-credential],[data-edit-reminder-credential],[data-cancel-reminder-credential],[data-test-reminder]');
    if (!button) return;
    event.stopImmediatePropagation();
    try {
      if (button.dataset.saveReminderSettings !== undefined) {
        const result = await api('/api/reminders/settings/save', { method: 'POST', body: collectSettings() });
        alert(result.credential_sender_mismatch ? result.message : '提醒设置已保存。'); await load(); tab = 5; renderReminderSettings(); return;
      }
      if (button.dataset.saveReminderCredential !== undefined) {
        const value = $('rem-auth').value; if (!value) throw Error('请输入 QQ Mail SMTP 授权码。');
        await api('/api/reminders/credential/save', { method: 'POST', body: { auth_code: value, sender_email: $('rem-sender').value.trim() } });
        credentialConfigured = true; editingCredential = false; credentialStatusRequest++; $('rem-auth').value = ''; $('rem-credential-status').textContent = '授权码：已配置'; renderCredentialControls(); alert('授权码已安全保存。'); return;
      }
      if (button.dataset.editReminderCredential !== undefined) { editingCredential = true; renderCredentialControls(); $('rem-auth').focus(); return; }
      if (button.dataset.cancelReminderCredential !== undefined) { editingCredential = false; renderCredentialControls(); return; }
      if (button.dataset.deleteReminderCredential !== undefined) {
        if (!confirm('删除已保存的 SMTP 授权码？删除后邮件提醒将无法发送。')) return;
        await api('/api/reminders/credential/delete', { method: 'POST', body: {} });
        credentialConfigured = false; editingCredential = false; credentialStatusRequest++; $('rem-auth').value = ''; $('rem-credential-status').textContent = '授权码：尚未配置'; renderCredentialControls(); alert('授权码已删除。'); return;
      }
      await api('/api/reminders/test', { method: 'POST', body: {} });
      alert(`测试邮件发送成功，已发送至 ${$('rem-recipient').value.trim()}。`); await refreshCredentialStatus();
    } catch (error) { if (/授权码|认证|SMTP_AUTH_FAILED/i.test(error.message || '')) { const node = $('rem-credential-status'); if (node) node.textContent = '授权码可能已失效'; } alert(error.message || '操作失败，请重试。'); }
  }, true);
})();
