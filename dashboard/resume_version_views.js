/* Small, reliable application material picker.
   Selection is separate from the immutable submitted snapshot. */
(() => {
  const isType = (row, type) => row && String(row.material_type || '').toLowerCase() === type.toLowerCase();
  const isApproved = row => [true, 1, 'true', 'yes', '1', 'approved'].includes(
    typeof row?.approved_for_use === 'string' ? row.approved_for_use.trim().toLowerCase() : row?.approved_for_use
  );
  const isOneTime = row => /^one[- ]?time$/i.test(String(row?.status || '').trim());
  const liveVersions = material => (S.materialVersions || [])
    .filter(version => version.material_id === material?.material_id && !version.deleted_at && !version.missing_at)
    .sort((a, b) => String(b.modified_at || '').localeCompare(String(a.modified_at || '')));
  const fileRole = version => {
    const ext = String(version?.extension || '').toUpperCase();
    return ext === 'PDF' ? 'PDF' : /DOCX|DOC/i.test(ext) ? 'DOCX' : ext;
  };
  const resumeInfo = material => {
    const versions = liveVersions(material);
    const explicitDocx = versions.find(version => version.material_version_id === material.editable_version_id && fileRole(version) === 'DOCX');
    const explicitPdf = versions.find(version => version.material_version_id === material.submission_version_id && fileRole(version) === 'PDF');
    const docxCandidates = versions.filter(version => fileRole(version) === 'DOCX');
    const pdfCandidates = versions.filter(version => fileRole(version) === 'PDF');
    const docx = explicitDocx || (docxCandidates.length === 1 ? docxCandidates[0] : null);
    const pdf = explicitPdf || (pdfCandidates.length === 1 ? pdfCandidates[0] : null);
    return {
      docx,
      pdf,
      latest: versions[0],
      status: docx && pdf ? 'Word ✓  PDF ✓' : docx ? 'Word ✓  PDF 待补充' : pdf ? 'Word 待补充  PDF ✓' : '没有可用文件'
    };
  };
  const companyOf = material => material?.company || material?.role_family || '通用资料';
  const modified = material => String(resumeInfo(material).latest?.modified_at || material.updated_at || '').slice(0, 10) || '—';
  const activeLibraries = role => (S.materialLibrary || [])
    .filter(row => !row.deleted_at && row.status !== 'Trash' && row.status !== 'Merged' && !isOneTime(row))
    .filter(row => isType(row, role === 'Cover Letter' ? 'Cover Letter' : 'CV / Resume'))
    .filter(row => role === 'Cover Letter' ? liveVersions(row).length : liveVersions(row).some(version => /PDF|DOCX|DOC/i.test(String(version.extension || ''))));
  const sourceRows = (role, application, source) => {
    const rows = activeLibraries(role);
    if (source === 'approved') return rows.filter(isApproved).sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
    if (source === 'company') return rows.filter(row => application?.company && String(row.company || '').toLowerCase().includes(String(application.company).toLowerCase()));
    if (source === 'recent') {
      const used = new Map();
      for (const app of (S.applications || []).slice().sort((a, b) => String(b.attempt_date || b.updated_at || '').localeCompare(String(a.attempt_date || a.updated_at || '')))) {
        const id = role === 'CV' ? (app.selected_cv_resume_id || app.resume_version_id) : app.selected_cover_letter_material_id;
        if (id && !used.has(id)) used.set(id, String(app.attempt_date || app.updated_at || ''));
      }
      return rows.sort((a, b) => (used.has(b.material_id) ? 1 : 0) - (used.has(a.material_id) ? 1 : 0)
        || String(used.get(b.material_id) || modified(b)).localeCompare(String(used.get(a.material_id) || modified(a)))).slice(0, 10);
    }
    return rows.sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || '')));
  };
  const showError = message => {
    const box = $('resume-picker-error');
    if (box) { box.textContent = `⚠ ${message}`; box.hidden = false; }
  };
  const clearError = () => { const box = $('resume-picker-error'); if (box) box.hidden = true; };
  const setBusy = (busy, button, label = '使用这份简历') => {
    const modal = $('modal'); if (!modal) return;
    modal.querySelectorAll('button').forEach(item => { if (item.dataset.cancel === undefined) item.disabled = busy; });
    if (button) button.textContent = busy ? '正在保存…' : label;
  };
  const injectPickerStyle = () => {
    if ($('resume-picker-style')) return;
    const style = document.createElement('style');
    style.id = 'resume-picker-style';
    style.textContent = `
      #modal.resume-picker-modal{width:min(700px,94vw);max-height:86vh;padding:22px}
      .resume-picker-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0 10px}
      .resume-picker-tabs button{border:1px solid #d7dce4;background:#fff;border-radius:999px;padding:7px 12px;color:#596579;cursor:pointer}
      .resume-picker-tabs button.active{background:#172033;border-color:#172033;color:#fff}
      .resume-picker-list{display:grid;gap:8px;max-height:320px;overflow:auto;padding-right:2px}
      .resume-picker-row{display:flex;gap:11px;align-items:flex-start;border:1px solid #e4e8ef;border-radius:10px;padding:11px 12px;cursor:pointer;background:#fff}
      .resume-picker-row:hover,.resume-picker-row.selected{border-color:#8aa7e8;background:#f8fbff}
      .resume-picker-row input{margin-top:4px;flex:0 0 auto}
      .resume-picker-main{min-width:0;flex:1}.resume-picker-name{font-weight:700;overflow-wrap:anywhere}
      .resume-picker-meta{color:#707b8d;font-size:12px;margin-top:2px}.resume-picker-files{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
      .resume-picker-files button,.resume-picker-files a{border:0;background:transparent;color:#2563eb;padding:0;cursor:pointer;font-size:12px;text-decoration:none}
      .resume-picker-local{border-top:1px solid #e6e9ef;margin-top:17px;padding-top:15px}.resume-picker-local h3{font-size:15px;margin:0 0 12px}
      .resume-picker-upload-fields{display:grid;gap:12px}.resume-picker-upload-field{display:grid;gap:6px;min-width:0;padding:12px;border:1px solid #e4e8ef;border-radius:10px;background:#fbfcfe}
      .resume-picker-upload-field>label{display:block;font-weight:700;color:#172033}.resume-picker-upload-helper{font-size:12px;color:#707b8d}
      .resume-picker-hidden-file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
      .resume-picker-file-name{color:#596579;font-size:12px;min-height:18px;overflow-wrap:anywhere;word-break:normal;white-space:normal}
      .resume-picker-actions{display:flex;gap:8px;flex-wrap:wrap}.resume-picker-error{margin-top:10px;background:#fff2f2;color:#a12626;border:1px solid #f0b8b8;border-radius:8px;padding:9px 11px}
      .resume-picker-empty{padding:20px 8px;text-align:center;color:#707b8d;border:1px dashed #d7dce4;border-radius:10px}
    `;
    document.head.appendChild(style);
  };
  const choiceInfo = material => {
    const info = resumeInfo(material);
    return `<div class="resume-picker-meta">${esc(companyOf(material))} · ${esc(info.status)} · 更新于 ${esc(modified(material))}</div>`;
  };
  const renderRows = (role, application, source) => {
    const list = $('resume-picker-list'); if (!list) return;
    const rows = sourceRows(role, application, source);
    const selected = $('modal')?.dataset.selectedMaterialId || '';
    list.innerHTML = rows.map(material => {
      const info = role === 'CV' ? resumeInfo(material) : { docx: null, pdf: liveVersions(material)[0], status: '可用' };
      const checked = selected === material.material_id ? ' checked' : '';
      const files = role === 'CV'
        ? `<span>${info.docx ? 'Word ✓' : 'Word 待补充'}</span><span>${info.pdf ? 'PDF ✓' : 'PDF 待补充'}</span>`
        : '<span>文件 ✓</span>';
      const openButtons = role === 'CV'
        ? `${info.docx ? `<a data-resume-file href="/api/master/material/version-file?id=${encodeURIComponent(info.docx.material_version_id)}" target="_blank" rel="noopener">编辑 Word</a>` : ''}${info.pdf ? `<a data-resume-file href="/api/master/material/version-file?id=${encodeURIComponent(info.pdf.material_version_id)}" target="_blank" rel="noopener">查看 PDF</a>` : ''}`
        : '';
      return `<label class="resume-picker-row ${checked ? 'selected' : ''}" data-resume-row="${esc(material.material_id)}"><input type="radio" name="resume-library-choice" value="${esc(material.material_id)}"${checked}><div class="resume-picker-main"><div class="resume-picker-name">${esc(material.display_name || '未命名简历')}</div>${choiceInfo(material)}<div class="resume-picker-files">${files}${openButtons}</div></div></label>`;
    }).join('') || `<div class="resume-picker-empty">${source === 'approved' ? '还没有标记为满意简历；可以切换到“全部资料”选择。' : source === 'company' ? '没有找到该公司的相关资料。' : '暂时没有可用的资料版本。'}</div>`;
  };
  const selectedPayload = (role = 'CV') => {
    const modal = $('modal');
    const materialId = modal?.querySelector('input[name="resume-library-choice"]:checked')?.value || modal?.dataset.selectedMaterialId || '';
    const material = (S.materialLibrary || []).find(row => row.material_id === materialId);
    if (!material) throw Error(`请选择一份${role === 'Cover Letter' ? '求职信' : '简历'}。`);
    const info = resumeInfo(material); const chosen = role === 'CV' ? (info.pdf || info.docx) : info.latest;
    if (!chosen) throw Error('这份资料没有可用文件。');
    const mode = modal?.dataset.resumeMode || 'select';
    return role === 'CV'
      ? { resume_id: material.material_id, resume_material_id: material.material_id, material_id: material.material_id, material_version_id: chosen.material_version_id, actual_submitted_version_id: mode === 'correction' || mode === 'mark' ? chosen.material_version_id : '', editable_version_id: info.docx?.material_version_id || '', submission_version_id: info.pdf?.material_version_id || '', resume_version_name: material.display_name || '' }
      : { material_id: material.material_id, material_version_id: chosen.material_version_id, resume_version_name: material.display_name || '' };
  };
  const readLocalFile = file => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '').split(',')[1] || ''); reader.onerror = () => reject(Error('读取本地文件失败。')); reader.readAsDataURL(file);
  });
  const finishApplication = async applicationId => { closeM(); closeD(); await load(); appDrawer((S.applications || []).find(row => row.application_id === applicationId)); };
  const savePayload = async (payload, { role = 'CV', applicationId = '', jobId = '', mode = 'select' } = {}) => {
    if (jobId) { await post('/api/master/job/mark-applied', { job_id: jobId, application_date: $('resume-mark-date')?.value || today(), application_channel: $('resume-mark-channel')?.value || '', notes: $('resume-mark-notes')?.value || '', ...payload }); closeM(); await load(); return; }
    const endpoint = mode === 'correction' ? '/api/master/application/material/confirm' : '/api/master/application/material/select';
    await post(endpoint, { application_id: applicationId, role, selection_status: 'Selected', ...payload });
    await finishApplication(applicationId);
  };
  const importAndUseLocal = async (mode, { role = 'CV', applicationId = '', jobId = '', pickerMode = 'select', button } = {}) => {
    const docx = $('resume-local-docx')?.files?.[0] || null;
    const pdf = $('resume-local-pdf')?.files?.[0] || null;
    const single = $('resume-local-file')?.files?.[0] || null;
    if (role === 'CV' && !docx && !pdf) { showError('请至少选择一个 Word 或 PDF 文件。'); return; }
    if (role !== 'CV' && !single) { showError('请先选择文件。'); return; }
    clearError(); setBusy(true, button, mode === 'once' ? '仅本次使用' : '加入资料库并使用');
    try {
      if (role !== 'CV') {
        const imported = await post('/api/master/material/import', { file_name: single.name, display_name: single.name.replace(/\.[^.]+$/, ''), material_type: 'Cover Letter', base64: await readLocalFile(single) });
        await post('/api/master/material/rescan', { path: setting('materials_root') }); await load();
        const importedPath = String(imported.imported_file_path || imported.data?.imported_file_path || '').replaceAll('\\', '/').toLowerCase();
        const version = (S.materialVersions || []).find(row => importedPath && String(row.file_path || '').replaceAll('\\', '/').toLowerCase() === importedPath);
        if (!version) throw Error('文件已保存，但尚未建立可选择的资料版本，请重试。');
        const library = (S.materialLibrary || []).find(row => row.material_id === version.material_id);
        await savePayload({ material_id: library?.material_id || version.material_id, material_version_id: version.material_version_id, resume_version_name: library?.display_name || single.name.replace(/\.[^.]+$/, '') }, { role, applicationId, jobId, mode: pickerMode });
        return;
      }
      const imported = await post('/api/master/material/resume-version/import', { display_name: (docx || pdf).name.replace(/\.[^.]+$/, ''), one_time: mode === 'once', approved_for_use: mode !== 'once', editable: docx ? { file_name: docx.name, base64: await readLocalFile(docx) } : null, submission: pdf ? { file_name: pdf.name, base64: await readLocalFile(pdf) } : null });
      const editableId = imported.editable_version_id || imported.data?.editable_version_id || '';
      const submissionId = imported.submission_version_id || imported.data?.submission_version_id || '';
      const actualId = submissionId || editableId;
      const payload = { resume_id: imported.resume_id || imported.material_id, resume_material_id: imported.resume_id || imported.material_id, material_id: imported.material_id || imported.resume_id, material_version_id: actualId, editable_version_id: editableId, submission_version_id: submissionId, actual_submitted_version_id: (pickerMode === 'correction' || pickerMode === 'mark') ? actualId : '', resume_version_name: (docx || pdf).name.replace(/\.[^.]+$/, '') };
      await savePayload(payload, { role, applicationId, jobId, mode: pickerMode });
    } catch (error) {
      setBusy(false, button, mode === 'once' ? '仅本次使用' : '加入资料库并使用');
      showError(error.message || '文件导入失败，请重试。');
    }
  };
  const chooser = ({ applicationId = '', jobId = '', role = 'CV', correction = false } = {}) => {
    const application = (S.applications || []).find(row => row.application_id === applicationId);
    const mode = jobId ? 'mark' : correction ? 'correction' : 'select';
    injectPickerStyle();
    const title = role === 'Cover Letter' ? '选择求职信' : mode === 'correction' ? '补充 / 更正提交简历' : '选择简历';
    const explanation = mode === 'mark' ? '选择用于这次申请的简历；确认后会记录投递。' : mode === 'correction' ? '请选择当时实际提交的简历。保存只会更正 CareerPilot 的历史记录，不会改变已经发给公司的文件。' : '为本次申请选择准备使用的简历。提交成功前可以随时更换。';
    const fields = mode === 'mark' ? `<div class="form"><div class="field"><label>申请日期</label><input id="resume-mark-date" type="date" value="${today()}"></div><div class="field"><label>申请渠道</label><input id="resume-mark-channel"></div><div class="field full"><label>备注</label><textarea id="resume-mark-notes"></textarea></div></div>` : '';
    const localInputs = role === 'CV'
      ? '<div class="resume-picker-upload-fields"><div class="resume-picker-upload-field"><label for="resume-local-docx">编辑版 Word（可选）</label><div class="resume-picker-upload-helper">仅支持 .docx</div><label class="btn" for="resume-local-docx">选择 Word 文件</label><input id="resume-local-docx" class="resume-picker-hidden-file" type="file" accept=".docx"><div id="resume-local-docx-name" class="resume-picker-file-name">尚未选择文件</div></div><div class="resume-picker-upload-field"><label for="resume-local-pdf">投递版 PDF（可选）</label><div class="resume-picker-upload-helper">仅支持 .pdf</div><label class="btn" for="resume-local-pdf">选择 PDF 文件</label><input id="resume-local-pdf" class="resume-picker-hidden-file" type="file" accept=".pdf"><div id="resume-local-pdf-name" class="resume-picker-file-name">尚未选择文件</div></div></div>'
      : '<div class="resume-picker-upload-field"><label for="resume-local-file">选择文件</label><label class="btn" for="resume-local-file">选择文件</label><input id="resume-local-file" class="resume-picker-hidden-file" type="file" accept=".docx,.pdf"><div id="resume-local-name" class="resume-picker-file-name">尚未选择文件</div></div>';
    openModal(`<h2>${title}</h2><p class="sub">${explanation}</p><div class="resume-picker-tabs"><button type="button" data-resume-tab="approved">${role === 'CV' ? '满意简历' : '满意资料'}</button><button type="button" data-resume-tab="all">全部资料</button><button type="button" data-resume-tab="company">公司相关</button><button type="button" data-resume-tab="recent">最近使用</button></div><div id="resume-picker-list"></div><div class="resume-picker-local"><h3>从电脑选择</h3>${localInputs}<div class="resume-picker-actions"><button type="button" class="btn" data-resume-local-once disabled>仅本次使用</button><button type="button" class="btn" data-resume-local-library disabled>加入资料库并使用</button></div></div><div id="resume-picker-error" class="resume-picker-error" hidden></div>${fields}<div class="run"><span></span><div class="actions"><button class="btn" data-cancel>取消</button><button type="button" class="btn primary" ${mode === 'mark' ? `data-resume-save-job="${esc(jobId)}"` : `data-resume-save-application="${esc(applicationId)}"`} data-resume-role="${esc(role)}" data-resume-mode="${esc(mode)}">使用这份${role === 'CV' ? '简历' : '求职信'}</button></div></div>`);
    $('modal').classList.add('resume-picker-modal');
    $('modal').dataset.applicationId = applicationId;
    $('modal').dataset.jobId = jobId;
    $('modal').dataset.resumeRole = role;
    $('modal').dataset.resumeMode = mode;
    $('modal').dataset.resumeSource = 'approved';
    const hasApproved = sourceRows(role, application, 'approved').length > 0;
    if (!hasApproved) $('modal').dataset.resumeSource = 'all';
    document.querySelectorAll('[data-resume-tab]').forEach(button => button.classList.toggle('active', button.dataset.resumeTab === $('modal').dataset.resumeSource));
    renderRows(role, application, $('modal').dataset.resumeSource);
  };

  const openResumeSlotEditor = ({ resumeId = '', slot = 'submission_pdf', applicationId = '' } = {}) => {
    if (!resumeId) { showError('简历版本不存在，请刷新后重试。'); return; }
    const isDocx = slot === 'editable_docx';
    openModal(`<h2>${isDocx ? '添加 / 更换 Word' : '添加 / 更换 PDF'}</h2><p class="sub">只更新${isDocx ? '编辑版 Word' : '投递版 PDF'}槽位，另一文件保持不变。</p><input id="resume-slot-file" type="file" accept="${isDocx ? '.docx' : '.pdf'}"><div id="resume-slot-error" class="resume-picker-error" hidden></div><div class="run"><span></span><div class="actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-resume-slot-save data-resume-slot-id="${esc(resumeId)}" data-resume-slot-role="${esc(slot)}" data-resume-slot-application="${esc(applicationId)}">保存</button></div></div>`);
  };

  document.addEventListener('change', event => {
    if (['resume-local-file', 'resume-local-docx', 'resume-local-pdf'].includes(event.target?.id)) {
      const files = ['resume-local-file', 'resume-local-docx', 'resume-local-pdf'].map(id => $(id)?.files?.[0]).filter(Boolean);
      const selectedLabel = file => `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`;
      const name = $('resume-local-name');
      if (name && event.target?.id === 'resume-local-file') name.textContent = files.length ? selectedLabel(files[0]) : '尚未选择文件';
      const docxName = $('resume-local-docx-name'); const pdfName = $('resume-local-pdf-name');
      if (docxName && event.target?.id === 'resume-local-docx') docxName.textContent = event.target.files?.[0] ? selectedLabel(event.target.files[0]) : '尚未选择文件';
      if (pdfName && event.target?.id === 'resume-local-pdf') pdfName.textContent = event.target.files?.[0] ? selectedLabel(event.target.files[0]) : '尚未选择文件';
      document.querySelectorAll('[data-resume-local-once],[data-resume-local-library]').forEach(button => { button.disabled = files.length === 0; });
      clearError();
    }
    if (event.target?.name === 'resume-library-choice') {
      const row = event.target.closest('[data-resume-row]'); if (row) row.classList.add('selected');
      const modal = $('modal'); if (modal) modal.dataset.selectedMaterialId = event.target.value;
      clearError();
    }
  }, true);

  document.addEventListener('click', async event => {
    const row = event.target.closest('[data-resume-row]');
    if (row && !event.target.closest('[data-resume-file]')) {
      const radio = row.querySelector('input[name="resume-library-choice"]'); if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
      return;
    }
    const tab = event.target.closest('[data-resume-tab]');
    if (tab) {
      event.preventDefault(); event.stopImmediatePropagation();
      const modal = $('modal'); if (!modal) return;
      modal.dataset.resumeSource = tab.dataset.resumeTab;
      document.querySelectorAll('[data-resume-tab]').forEach(button => button.classList.toggle('active', button === tab));
      renderRows(modal.dataset.resumeRole || 'CV', (S.applications || []).find(row => row.application_id === modal.dataset.applicationId), tab.dataset.resumeTab);
      return;
    }
    const button = event.target.closest('[data-choose-cv],[data-choose-cover-letter],[data-relink-cv],[data-relink-cover-letter],[data-mark],[data-resume-save-application],[data-resume-save-job],[data-resume-local-once],[data-resume-local-library],[data-resume-correct-application],[data-correct-material],[data-confirm-selected],[data-ignore-selected],[data-view-material-source],[data-resume-slot],[data-resume-slot-save]');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try {
      if (button.dataset.confirmSelected) {
        const application = (S.applications || []).find(row => row.application_id === button.dataset.confirmSelected);
        if (!application) throw Error('申请不存在，请刷新后重试。');
        const selectedVersion = (S.materialVersions || []).find(row => row.material_version_id === button.dataset.selectedVersion) || (S.materialVersions || []).find(row => row.material_version_id === application.selected_cv_version_id);
        const material = (S.materialLibrary || []).find(row => row.material_id === (application.invalid_resume_role_mapping ? selectedVersion?.material_id : (application.selected_cv_resume_id || selectedVersion?.material_id)));
        if (!material || !selectedVersion) throw Error('请选择一份有效的简历版本。');
        const info = resumeInfo(material);
        const submitted = ['Applied', 'Online Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'].includes(String(application.current_stage || application.status));
        const payload = { application_id: application.application_id, role: 'CV', resume_id: material.material_id, material_id: material.material_id, material_version_id: selectedVersion.material_version_id, actual_submitted_version_id: submitted ? selectedVersion.material_version_id : '', editable_version_id: info.docx?.material_version_id || '', submission_version_id: info.pdf?.material_version_id || '', resume_version_name: material.display_name || '' };
        setBusy(true, button, submitted ? '确认这是当时提交的简历' : '使用这份简历');
        await post(submitted ? '/api/master/application/material/confirm' : '/api/master/application/material/select', submitted ? payload : { ...payload, selection_status: 'Selected', actual_submitted_version_id: '' });
        await finishApplication(application.application_id);
        return;
      }
      if (button.dataset.ignoreSelected) {
        const applicationId = button.dataset.ignoreSelected;
        setBusy(true, button, '忽略');
        await post('/api/master/application/material/select', { application_id: applicationId, role: button.dataset.selectedRole || 'CV', selection_status: 'Ignored' });
        await finishApplication(applicationId);
        return;
      }
      if (button.dataset.chooseCv) { const app = (S.applications || []).find(row => row.application_id === button.dataset.chooseCv); const submitted = ['Applied', 'Online Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'].includes(String(app?.current_stage || app?.status)); chooser({ applicationId: button.dataset.chooseCv, role: 'CV', correction: submitted }); return; }
      if (button.dataset.chooseCoverLetter) { chooser({ applicationId: button.dataset.chooseCoverLetter, role: 'Cover Letter' }); return; }
      if (button.dataset.relinkCv) { chooser({ applicationId: button.dataset.relinkCv, role: 'CV' }); return; }
      if (button.dataset.relinkCoverLetter) { chooser({ applicationId: button.dataset.relinkCoverLetter, role: 'Cover Letter' }); return; }
      if (button.dataset.correctMaterial) { chooser({ applicationId: button.dataset.correctMaterial, role: 'CV', correction: true }); return; }
      if (button.dataset.mark) { const job = (S.jobs || []).find(row => row.job_id === button.dataset.mark); if (job) chooser({ jobId: job.job_id, role: 'CV' }); return; }
      if (button.dataset.viewMaterialSource) return;
      if (button.dataset.resumeSlot !== undefined) { openResumeSlotEditor({ resumeId: button.dataset.resumeSlotId, slot: button.dataset.resumeSlotRole, applicationId: button.dataset.resumeSlotApplication || '' }); return; }
      if (button.dataset.resumeSlotSave !== undefined) {
        const file = $('resume-slot-file')?.files?.[0]; const slot = button.dataset.resumeSlotRole; if (!file) throw Error('请选择文件。');
        const ext = String(file.name || '').split('.').pop().toLowerCase(); if (slot === 'editable_docx' && ext !== 'docx') throw Error('编辑版需要 Word 文件（.docx）。'); if (slot === 'submission_pdf' && ext !== 'pdf') throw Error('投递版需要 PDF 文件（.pdf）。');
        button.disabled = true; button.textContent = '正在保存…';
        await post('/api/master/material/resume-version/slot', { resume_id: button.dataset.resumeSlotId, slot, file: { file_name: file.name, base64: await readLocalFile(file) } });
        if (button.dataset.resumeSlotApplication) await finishApplication(button.dataset.resumeSlotApplication); else { closeM(); await load(); tab = 2; window.mine(); }
        return;
      }
      const modal = $('modal'); const role = modal?.dataset.resumeRole || 'CV';
      if (button.dataset.resumeLocalOnce !== undefined) { await importAndUseLocal('once', { role, applicationId: modal?.dataset.applicationId || '', jobId: modal?.dataset.jobId || '', pickerMode: modal?.dataset.resumeMode || 'select', button }); return; }
      if (button.dataset.resumeLocalLibrary !== undefined) { await importAndUseLocal('library', { role, applicationId: modal?.dataset.applicationId || '', jobId: modal?.dataset.jobId || '', pickerMode: modal?.dataset.resumeMode || 'select', button }); return; }
      const payload = selectedPayload(role);
      if (button.dataset.resumeSaveApplication) { setBusy(true, button, `使用这份${role === 'CV' ? '简历' : '求职信'}`); await savePayload(payload, { role, applicationId: button.dataset.resumeSaveApplication, mode: button.dataset.resumeMode || 'select' }); return; }
      if (button.dataset.resumeSaveJob) { setBusy(true, button, '使用这份简历'); await savePayload(payload, { role, jobId: button.dataset.resumeSaveJob }); return; }
    } catch (error) {
      setBusy(false, button, `使用这份${(modal?.dataset.resumeRole || 'CV') === 'CV' ? '简历' : '求职信'}`);
      showError(error.message || '材料保存失败，请重试。');
    }
  }, true);
})();
