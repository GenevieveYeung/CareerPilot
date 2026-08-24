/* Profile facts library.
 * Keeps the existing Profile worksheet contract while adding repeatable,
 * user-editable records for education, work authorization and languages.
 */
(() => {
  const originalMine = window.mine;
  const levelLabels = { Bachelor: '本科', Master: '硕士', PhD: '博士', Associate: '副学士', Diploma: '文凭', Exchange: '交换', Certificate: '证书', Other: '其他' };
  const statusLabels = { Active: '有效', Pending: '待处理', Expired: '已过期', 'Not Required': '不需要', Unknown: '未知', 'Needs Review': '待确认' };
  const field = (id, label, type = 'text', value = '', extra = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(value)}" ${extra}></div>`;
  const select = (id, label, options, value = '') => `<div class="field"><label for="${id}">${label}</label><select id="${id}">${options.map(option => `<option value="${esc(option[0])}" ${option[0] === value ? 'selected' : ''}>${esc(option[1])}</option>`).join('')}</select></div>`;
  const textArea = (id, label, value = '') => `<div class="field full"><label for="${id}">${label}</label><textarea id="${id}">${esc(value)}</textarea></div>`;
  const newId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const parseList = key => { try { const value = JSON.parse((S.profile || []).find(row => row.key === key)?.value || '[]'); return Array.isArray(value) ? value : []; } catch (_) { return []; } };
  const profileModel = () => ({
    candidate: parsed(S.profile, 'candidate'),
    currentStatus: parsed(S.profile, 'current_status'),
    legacyAuth: parsed(S.profile, 'work_authorization'),
    education: parseList('education_records'),
    authorizations: parseList('work_authorization_records'),
    languages: parseList('language_records'),
  });
  const rowValue = (rows, key, value, section = 'Profile') => {
    let row = rows.find(item => item.key === key);
    if (!row) { row = { section, key, value: '', value_type: 'json' }; rows.push(row); }
    row.value = typeof value === 'string' ? value : JSON.stringify(value);
    return row;
  };
  const dateRange = record => {
    const start = record.start_date || '—';
    const end = record.currently_studying ? (record.expected_graduation_date || record.end_date || '预计毕业时间待填') : (record.end_date || record.expected_graduation_date || '—');
    return `${start} → ${end}`;
  };
  const completeness = model => {
    const c = model.candidate || {};
    const education = model.education.some(item => (item.institution_official || item.institution_display) && (item.degree || item.programme) && (item.end_date || item.expected_graduation_date));
    const auth = model.authorizations.some(item => item.country_region && item.current_status && item.work_authorization && item.sponsorship_requirement && !item.needs_review);
    const basic = Boolean((c.legal_first_name && c.legal_last_name) && c.email && c.phone && (c.current_location || c.location));
    const checks = [{ ok: basic, text: '基本联系资料' }, { ok: education, text: '至少一条完整教育经历' }, { ok: auth, text: '签证与工作资格' }];
    const missing = checks.filter(item => !item.ok).map(item => item.text);
    const score = Math.round((checks.filter(item => item.ok).length / checks.length) * 100);
    return { score, missing };
  };
  const tabs = () => window.CAREERPILOT_NAV.renderMyTabs(tab);

  function renderBasic(model) {
    const c = model.candidate || {};
    return `<div class="surface profile-section"><div class="between"><div><h2>基本资料</h2><p class="sub">这些是可以在申请表、搜索提示词和简历提示词中复用的个人事实。</p></div><span class="tag blue">可复用事实</span></div><div class="form">
      ${field('pf-legal-first', '法定名字（英文）', 'text', c.legal_first_name)}
      ${field('pf-legal-last', '法定姓氏（英文）', 'text', c.legal_last_name)}
      ${field('pf-preferred', '常用名', 'text', c.preferred_name)}
      ${field('pf-chinese', '中文姓名（可选）', 'text', c.chinese_name)}
      ${field('pf-email', '邮箱', 'email', c.email)}
      ${field('pf-country-code', '电话国家/地区代码', 'text', c.phone_country_code)}
      ${field('pf-phone', '电话', 'tel', c.phone)}
      ${field('pf-location', '当前所在地', 'text', c.current_location || c.location)}
      ${field('pf-earliest', '最早入职日期', 'date', c.earliest_start_date || model.currentStatus.available_start_date)}
      ${select('pf-student-status', '当前学生状态', [['', '请选择'], ['Current Student', '在读学生'], ['Graduated', '已毕业'], ['Incoming Student', '即将入学'], ['Other', '其他']], c.current_student_status)}
      ${field('pf-notice', 'Notice Period（如适用）', 'text', c.notice_period || model.currentStatus.notice_period)}
      ${field('pf-address', '地址（可选）', 'text', c.address)}
      ${textArea('pf-legacy-name', '旧资料中的姓名记录（保留）', c.name || '')}
    </div><div class="run"><span class="sub">姓名旧记录不会被删除；正式申请建议补齐法定名字和姓氏。</span><button class="btn primary" data-profile-save-basic>保存基本资料</button></div></div>`;
  }

  function educationCard(record, index, total) {
    const title = record.institution_display || record.institution_official || '学校待填写';
    const detail = [record.degree, record.programme || record.major, record.location].filter(Boolean).join(' · ') || '详细信息待填写';
    return `<div class="profile-card"><div class="between"><div><h3>${esc(levelLabels[record.level] || record.level || '教育经历')}</h3><b>${esc(title)}</b><p class="sub">${esc(detail)}</p><p class="sub">${esc(dateRange(record))}${record.currently_studying ? ' · 在读' : ''}</p></div><div class="actions"><button class="btn" data-education-edit="${esc(record.education_id)}">编辑</button><button class="btn" data-education-delete="${esc(record.education_id)}">删除</button></div></div><div class="profile-card-foot">${record.needs_review ? '<span class="tag amber">待确认</span>' : '<span class="tag green">已记录</span>'}<span class="sub">第 ${index + 1} 条</span><span class="order-buttons">${index > 0 ? `<button class="btn" data-education-up="${esc(record.education_id)}">↑</button>` : ''}${index < total - 1 ? `<button class="btn" data-education-down="${esc(record.education_id)}">↓</button>` : ''}</span></div></div>`;
  }

  function renderEducation(model) {
    return `<div class="surface profile-section"><div class="between"><div><h2>教育经历</h2><p class="sub">本科、硕士、交换、证书等可以分别记录；正式学校名称和 UI 显示名称分开保存。</p></div><button class="btn primary" data-education-add>+ 添加教育经历</button></div><div class="profile-list">${model.education.map((item, index) => educationCard(item, index, model.education.length)).join('') || '<div class="empty">还没有教育经历，请添加本科或硕士记录。</div>'}</div></div>`;
  }

  function renderAuthorizations(model) {
    const legacy = model.legacyAuth;
    const records = model.authorizations;
    const legacyNotice = !records.length && (legacy.country || legacy.current_authorization) ? `<div class="notice">旧资料中已有工作资格描述，但尚未拆成结构化记录；不会删除原文，请点击“添加记录”补齐签证类型、有效期和工作资格。</div>` : '';
    return `<div class="surface profile-section"><div class="between"><div><h2>签证与工作资格</h2><p class="sub">签证类型、当前状态、工作资格和雇主担保要求分开保存，避免把签证误当成工作资格。</p></div><button class="btn primary" data-auth-add>+ 添加记录</button></div>${legacyNotice}<div class="profile-list">${records.map(record => `<div class="profile-card"><div class="between"><div><h3>${esc(record.country_region || '地区待填写')}</h3><b>${esc(record.visa_type || '签证类型待确认')}</b><p class="sub">${esc(statusLabels[record.current_status] || record.current_status || '状态待确认')} · ${esc(record.valid_from || '—')} → ${esc(record.valid_until || '无明确到期日')}</p><p class="sub">工作资格：${esc(record.work_authorization || '待确认')} · 未来需要雇主担保：${esc(record.sponsorship_requirement || '待确认')}</p></div><div class="actions"><button class="btn" data-auth-edit="${esc(record.authorization_id)}">编辑</button><button class="btn" data-auth-delete="${esc(record.authorization_id)}">删除</button></div></div><div class="profile-card-foot">${record.needs_review ? '<span class="tag amber">待确认</span>' : '<span class="tag green">已记录</span>'}</div></div>`).join('') || '<div class="empty">还没有结构化签证与工作资格记录。涉及签证、工作资格或雇主担保的内容请按实际文件填写。</div>'}</div></div>`;
  }

  function renderLanguages(model) {
    return `<div class="surface profile-section"><div class="between"><div><h2>语言能力</h2><p class="sub">支持多条语言记录，用于申请表和岗位匹配。</p></div><button class="btn" data-language-add>+ 添加语言</button></div><div class="profile-list">${model.languages.map(record => `<div class="profile-card"><div class="between"><div><b>${esc(record.language || '语言待填写')}</b><p class="sub">口语：${esc(record.speaking || '—')} · 阅读：${esc(record.reading || '—')} · 写作：${esc(record.writing || '—')}</p></div><div class="actions"><button class="btn" data-language-edit="${esc(record.language_id)}">编辑</button><button class="btn" data-language-delete="${esc(record.language_id)}">删除</button></div></div></div>`).join('') || '<div class="empty">还没有语言记录。</div>'}</div></div>`;
  }

  function renderPreview() {
    return `<div class="surface profile-section"><div class="between"><div><h2>AI / 自动填表会使用什么</h2><p class="sub">这里只展示会被读取的资料类型，不会自动替你确认不确定的签证、工作资格或毕业日期。</p></div><span class="tag">透明说明</span></div><div class="ai-preview"><div><b>搜索岗位</b><p>✓ 教育经历　✓ 毕业/预计毕业时间　✓ 工作资格　✓ 求职偏好</p></div><div><b>生成简历提示词</b><p>✓ 教育经历　✓ 已确认职业事实　✓ 满意简历库　✓ 求职偏好</p></div><div><b>自动填写申请</b><p>✓ 法定姓名　✓ 邮箱/电话　✓ 对应教育记录　✓ 签证与工作资格</p></div></div><div class="actions"><button class="btn" data-autofill-preview="undergraduate">预览本科填表映射</button><button class="btn" data-autofill-preview="postgraduate">预览硕士填表映射</button></div></div>`;
  }

  function renderProfilePage() {
    const model = profileModel();
    $('mine').innerHTML = `<div class="head"><div><h1>我的</h1><p>资料、偏好和设置</p></div></div>${tabs()}${renderBasic(model)}${renderEducation(model)}${renderAuthorizations(model)}${renderLanguages(model)}${renderPreview()}`;
  }

  function educationForm(record = {}) {
    const current = Boolean(record.currently_studying);
    openModal(`<h2>${record.education_id ? '编辑教育经历' : '添加教育经历'}</h2><div class="form">
      ${select('edu-level', '教育层级', [['', '请选择'], ...Object.entries(levelLabels)], record.level)}
      ${field('edu-institution-official', '学校正式名称', 'text', record.institution_official)}
      ${field('edu-institution-display', '显示名称', 'text', record.institution_display)}
      ${field('edu-faculty', '学院 / 学系（可选）', 'text', record.school_faculty)}
      ${field('edu-degree', '学位', 'text', record.degree)}
      ${field('edu-programme', '主修 / 课程', 'text', record.programme || record.major)}
      ${field('edu-secondary', '第二主修 / 副修（可选）', 'text', record.secondary_major_or_minor || record.minor)}
      ${field('edu-location', '地点', 'text', record.location)}
      ${field('edu-start', '开始时间', 'month', record.start_date)}
      ${field('edu-end', current ? '预计毕业时间' : '结束时间', 'month', current ? (record.expected_graduation_date || record.end_date) : (record.end_date || record.expected_graduation_date))}
      <div class="field full"><label><input id="edu-current" type="checkbox" ${current ? 'checked' : ''}> 当前在读</label></div>
      ${field('edu-gpa', 'GPA（可选）', 'text', record.gpa)}
      ${field('edu-gpa-scale', 'GPA 分制（可选）', 'text', record.gpa_scale)}
      ${field('edu-honours', '荣誉 / 等级（可选）', 'text', record.honours)}
      ${field('edu-expected-class', '预计等级（可选）', 'text', record.expected_classification)}
      ${field('edu-exchange', '交换 / 海外学习（可选）', 'text', record.exchange_study_abroad)}
      ${textArea('edu-coursework', '相关课程（可选）', record.relevant_coursework)}
      ${textArea('edu-notes', '备注', record.notes)}
    </div><div class="run"><span class="sub">不确定的字段可以留空，系统不会自行补值。</span><div class="actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-education-save="${esc(record.education_id || '')}">保存</button></div></div>`);
  }

  function authorizationForm(record = {}) {
    openModal(`<h2>${record.authorization_id ? '编辑签证与工作资格' : '添加签证与工作资格'}</h2><div class="form">
      ${field('auth-region', '国家 / 地区', 'text', record.country_region)}
      ${field('auth-visa', '签证类型', 'text', record.visa_type)}
      ${select('auth-status', '当前状态', [['', '请选择'], ['Active', '有效'], ['Pending', '待处理'], ['Expired', '已过期'], ['Not Required', '不需要'], ['Unknown', '未知'], ['Needs Review', '待确认']], record.current_status)}
      ${field('auth-from', '生效日期', 'date', record.valid_from)}
      ${field('auth-until', '失效日期', 'date', record.valid_until)}
      ${textArea('auth-work', '工作资格', record.work_authorization || record.current_authorization)}
      ${select('auth-sponsor', '未来是否需要雇主担保', [['', '待确认'], ['Yes', '是'], ['No', '否'], ['Depends', '视情况而定'], ['Unknown', '未知']], record.sponsorship_requirement)}
      ${textArea('auth-notes', '备注', record.notes)}
      <div class="field full"><label><input id="auth-review" type="checkbox" ${record.needs_review ? 'checked' : ''}> 标记为“待确认”</label></div>
    </div><div class="run"><span class="sub">签证类型不等于工作资格；请按实际文件填写。</span><div class="actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-auth-save="${esc(record.authorization_id || '')}">保存</button></div></div>`);
  }

  function languageForm(record = {}) {
    const levels = [['', '请选择'], ['Native', '母语'], ['Fluent', '流利'], ['Professional', '专业工作水平'], ['Intermediate', '中级'], ['Basic', '基础']];
    openModal(`<h2>${record.language_id ? '编辑语言能力' : '添加语言能力'}</h2><div class="form">${field('lang-name', '语言', 'text', record.language)}${select('lang-speaking', '口语', levels, record.speaking)}${select('lang-reading', '阅读', levels, record.reading)}${select('lang-writing', '写作', levels, record.writing)}</div><div class="run"><span></span><div class="actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-language-save="${esc(record.language_id || '')}">保存</button></div></div>`);
  }

  function buildRows(model, candidateOverride = model.candidate) {
    const rows = (S.profile || []).map(row => ({ ...row }));
    rowValue(rows, 'candidate', candidateOverride, 'Basic Information');
    rowValue(rows, 'education_records', model.education, 'Education');
    rowValue(rows, 'work_authorization_records', model.authorizations, 'Work Eligibility');
    rowValue(rows, 'language_records', model.languages, 'Languages');
    return rows;
  }
  async function saveModel(model, candidateOverride = model.candidate) {
    await post('/api/master/profile/save', { rows: buildRows(model, candidateOverride) });
    await load();
    tab = 0;
    window.mine();
  }
  const value = id => document.getElementById(id)?.value || '';
  const checkbox = id => Boolean(document.getElementById(id)?.checked);

  async function saveBasic() {
    const model = profileModel();
    const candidate = { ...model.candidate,
      legal_first_name: value('pf-legal-first'), legal_last_name: value('pf-legal-last'), preferred_name: value('pf-preferred'), chinese_name: value('pf-chinese'),
      email: value('pf-email'), phone_country_code: value('pf-country-code'), phone: value('pf-phone'), current_location: value('pf-location'), location: value('pf-location'),
      earliest_start_date: value('pf-earliest'), current_student_status: value('pf-student-status'), notice_period: value('pf-notice'), address: value('pf-address'), name: value('pf-legacy-name'),
    };
    await saveModel(model, candidate);
  }
  async function saveEducation(id) {
    const model = profileModel();
    const current = checkbox('edu-current');
    const end = value('edu-end');
    const record = { education_id: id || newId('edu'), order: model.education.length, level: value('edu-level'), institution_official: value('edu-institution-official'), institution_display: value('edu-institution-display'), school_faculty: value('edu-faculty'), degree: value('edu-degree'), programme: value('edu-programme'), secondary_major_or_minor: value('edu-secondary'), location: value('edu-location'), start_date: value('edu-start'), end_date: current ? '' : end, expected_graduation_date: current ? end : '', currently_studying: current, gpa: value('edu-gpa'), gpa_scale: value('edu-gpa-scale'), honours: value('edu-honours'), expected_classification: value('edu-expected-class'), relevant_coursework: value('edu-coursework'), exchange_study_abroad: value('edu-exchange'), notes: value('edu-notes'), needs_review: false, updated_at: new Date().toISOString() };
    if (!record.level || !(record.institution_official || record.institution_display)) throw Error('请至少填写教育层级和学校。');
    const index = model.education.findIndex(item => item.education_id === id);
    if (index >= 0) model.education[index] = { ...model.education[index], ...record }; else model.education.push(record);
    closeM();
    await saveModel(model);
  }
  async function saveAuthorization(id) {
    const model = profileModel();
    const record = { authorization_id: id || newId('auth'), order: model.authorizations.length, country_region: value('auth-region'), visa_type: value('auth-visa'), current_status: value('auth-status'), valid_from: value('auth-from'), valid_until: value('auth-until'), work_authorization: value('auth-work'), sponsorship_requirement: value('auth-sponsor'), notes: value('auth-notes'), needs_review: checkbox('auth-review'), updated_at: new Date().toISOString() };
    if (!record.country_region) throw Error('请填写国家 / 地区。');
    const index = model.authorizations.findIndex(item => item.authorization_id === id);
    if (index >= 0) model.authorizations[index] = { ...model.authorizations[index], ...record }; else model.authorizations.push(record);
    closeM();
    await saveModel(model);
  }
  async function saveLanguage(id) {
    const model = profileModel();
    const record = { language_id: id || newId('lang'), order: model.languages.length, language: value('lang-name'), speaking: value('lang-speaking'), reading: value('lang-reading'), writing: value('lang-writing'), updated_at: new Date().toISOString() };
    if (!record.language) throw Error('请填写语言名称。');
    const index = model.languages.findIndex(item => item.language_id === id);
    if (index >= 0) model.languages[index] = { ...model.languages[index], ...record }; else model.languages.push(record);
    closeM();
    await saveModel(model);
  }
  async function removeRecord(type, id) {
    if (!confirm('确认删除这条资料记录？原有其他 Profile 字段不会受影响。')) return;
    const model = profileModel();
    model[type] = model[type].filter(item => item[ type === 'education' ? 'education_id' : type === 'authorizations' ? 'authorization_id' : 'language_id' ] !== id);
    await saveModel(model);
  }
  async function moveEducation(id, direction) {
    const model = profileModel(); const index = model.education.findIndex(item => item.education_id === id); const next = index + direction;
    if (index < 0 || next < 0 || next >= model.education.length) return;
    [model.education[index], model.education[next]] = [model.education[next], model.education[index]];
    model.education.forEach((item, order) => { item.order = order; });
    await saveModel(model);
  }

  async function showAutofillPreview(level) {
    const response = await fetch(`/api/master/profile/autofill-map?education_level=${encodeURIComponent(level)}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw Error(result.message || result.error || '自动填表映射读取失败。');
    const mapped = result.profile || result.data?.profile || {};
    openModal(`<h2>${level === 'undergraduate' ? '本科' : '硕士'}自动填表映射预览</h2><p class="notice">这是预览，不会提交任何申请。实际遇到无法确定的字段仍会停在“需要用户确认”。</p><div class="tablebox"><table class="table">${Object.entries(mapped).filter(([key]) => !key.startsWith('source_')).map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(value || '—')}</td></tr>`).join('')}</table></div><div class="run"><span></span><button class="btn" data-cancel>关闭</button></div>`);
  }

  function renderMine() { renderProfilePage(); }
  window.mine = function () { if (tab === 0) renderMine(); else if (originalMine) originalMine(); };
  window.__careerPilotProfile = { profileModel, buildRows, buildProfileAutofillPreview: showAutofillPreview };

  const style = document.createElement('style');
  style.textContent = '.profile-section{margin-bottom:18px}.profile-list{display:grid;gap:10px}.profile-card{border-top:1px solid var(--line);padding:13px 0}.profile-card h3{margin:0 0 3px;font-size:14px}.profile-card p{margin:3px 0}.profile-card-foot{display:flex;align-items:center;gap:8px;margin-top:10px}.order-buttons{margin-left:auto;display:flex;gap:5px}.order-buttons .btn{padding:3px 8px}.ai-preview{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:12px 0 16px}.ai-preview>div{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:12px}.ai-preview p{font-size:12px;color:var(--muted);margin:5px 0 0}@media(max-width:850px){.ai-preview{grid-template-columns:1fr}}';
  document.head.appendChild(style);

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-tab],[data-profile-save-basic],[data-education-add],[data-education-edit],[data-education-delete],[data-education-up],[data-education-down],[data-auth-add],[data-auth-edit],[data-auth-delete],[data-language-add],[data-language-edit],[data-language-delete],[data-education-save],[data-auth-save],[data-language-save],[data-autofill-preview]');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try {
      if (button.dataset.tab !== undefined) { tab = Number(button.dataset.tab); window.mine(); return; }
      if (button.dataset.profileSaveBasic !== undefined) { await saveBasic(); return; }
      if (button.dataset.educationAdd !== undefined) { educationForm(); return; }
      if (button.dataset.educationEdit) { educationForm(profileModel().education.find(item => item.education_id === button.dataset.educationEdit) || {}); return; }
      if (button.dataset.educationDelete) { await removeRecord('education', button.dataset.educationDelete); return; }
      if (button.dataset.educationUp) { await moveEducation(button.dataset.educationUp, -1); return; }
      if (button.dataset.educationDown) { await moveEducation(button.dataset.educationDown, 1); return; }
      if (button.dataset.authAdd !== undefined) { authorizationForm(); return; }
      if (button.dataset.authEdit) { authorizationForm(profileModel().authorizations.find(item => item.authorization_id === button.dataset.authEdit) || {}); return; }
      if (button.dataset.authDelete) { await removeRecord('authorizations', button.dataset.authDelete); return; }
      if (button.dataset.languageAdd !== undefined) { languageForm(); return; }
      if (button.dataset.languageEdit) { languageForm(profileModel().languages.find(item => item.language_id === button.dataset.languageEdit) || {}); return; }
      if (button.dataset.languageDelete) { await removeRecord('languages', button.dataset.languageDelete); return; }
      if (button.dataset.educationSave !== undefined) { await saveEducation(button.dataset.educationSave); return; }
      if (button.dataset.authSave !== undefined) { await saveAuthorization(button.dataset.authSave); return; }
      if (button.dataset.languageSave !== undefined) { await saveLanguage(button.dataset.languageSave); return; }
      if (button.dataset.autofillPreview) { await showAutofillPreview(button.dataset.autofillPreview); return; }
    } catch (error) { alert(error.message || '保存失败，请重试。'); }
  }, true);
})();
