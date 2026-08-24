(() => {
  const baseMine = window.mine;
  let materialsSubtab = 'approved';
  const roleLabels = ['AI / ML', 'Data', 'Banking / Risk', 'Graduate / MT', 'FPGA / Hardware', 'General'];
  const isTrue = value => value === true || value === 1 || /^(true|yes|1)$/i.test(String(value || ''));
  const isCv = row => row && /CV \/ Resume|Resume|简历/i.test(String(row.material_type || ''));
  const activeLibraries = () => (typeof S !== 'undefined' ? (S.materialLibrary || []) : []).filter(row => !row.deleted_at && row.status !== 'Trash' && row.status !== 'Merged');
  const versionsFor = materialId => (typeof S !== 'undefined' ? (S.materialVersions || []) : []).filter(row => row.material_id === materialId && !row.deleted_at).sort((a, b) => String(b.modified_at || '').localeCompare(String(a.modified_at || '')));
  const allCvVersions = extension => (typeof S !== 'undefined' ? (S.materialVersions || []) : []).filter(version => !version.deleted_at && !version.missing_at && (!extension || new RegExp(extension, 'i').test(version.extension || '')) && isCv((S.materialLibrary || []).find(row => row.material_id === version.material_id)));
  const resumeStem = value => String(value || '').replace(/\.[^.]+$/, '').toLowerCase().replace(/\(\d+\)|\b(?:v|version)[\s._-]*\d+\b|\b(?:final|draft|latest|resume|cv)\b/gi, '').replace(/[^a-z0-9]+/g, '');
  const suspectedPairings = () => {
    const rows = activeLibraries().filter(isCv), pairs = [];
    for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
      const left = rows[i], right = rows[j];
      if (!resumeStem(left.display_name) || resumeStem(left.display_name) !== resumeStem(right.display_name)) continue;
      const leftFiles = versionsFor(left.material_id), rightFiles = versionsFor(right.material_id);
      const separatedRoles = (leftFiles.some(v => /DOCX|DOC/i.test(v.extension || '')) && rightFiles.some(v => /^PDF$/i.test(v.extension || ''))) || (rightFiles.some(v => /DOCX|DOC/i.test(v.extension || '')) && leftFiles.some(v => /^PDF$/i.test(v.extension || '')));
      if (separatedRoles) pairs.push([left, right]);
    }
    return pairs;
  };
  const latestVersion = material => versionsFor(material.material_id).find(row => !row.missing_at) || versionsFor(material.material_id)[0];
  const displayTags = material => String(material.tags || '').split(/[;,]/).map(x => x.trim()).filter(Boolean);
  const configuredApprovedPath = () => setting('approved_resumes_root') || (setting('materials_root') ? `${setting('materials_root')}/approved_resumes` : '');
  const pathIsApproved = material => versionsFor(material.material_id).some(version => String(version.file_path || '').replaceAll('\\', '/').toLowerCase().startsWith(configuredApprovedPath().replaceAll('\\', '/').toLowerCase()));
  const sourceName = material => `${material.display_name || '未命名简历'}${material.company ? ` · ${material.company}` : ''}`;
  const safeVersionButton = version => version && !version.missing_at ? `<button class="btn" data-material-open-version="${esc(version.material_version_id)}">${version.extension === 'PDF' ? '查看 PDF' : '打开 Word'}</button>` : '<span class="sub">文件未找到</span>';
  const resumeFiles = material => {
    const versions = versionsFor(material.material_id);
    const valid = versions.filter(version => !version.missing_at);
    const explicitDocx = valid.find(version => version.material_version_id === material.editable_version_id && /^(DOCX|DOC)$/i.test(version.extension || ''));
    const explicitPdf = valid.find(version => version.material_version_id === material.submission_version_id && /^PDF$/i.test(version.extension || ''));
    const docxCandidates = valid.filter(version => /^(DOCX|DOC)$/i.test(version.extension || ''));
    const pdfCandidates = valid.filter(version => /^PDF$/i.test(version.extension || ''));
    const docx = explicitDocx || (docxCandidates.length === 1 ? docxCandidates[0] : null);
    const pdf = explicitPdf || (pdfCandidates.length === 1 ? pdfCandidates[0] : null);
    const extras = versions.filter(version => version !== docx && version !== pdf);
    return { versions, docx, pdf, extras };
  };
  const versionRows = material => {
    const { versions, docx, pdf, extras } = resumeFiles(material);
    return `<div class="material-files">
      ${docx ? `<div><span class="sub">编辑版 Word</span><b>${esc(docx.file_name)}</b>${safeVersionButton(docx)}<button class="btn" data-material-slot="docx" data-material-slot-id="${esc(material.material_id)}">更换 Word</button></div>` : ''}
      ${pdf ? `<div><span class="sub">投递版 PDF</span><b>${esc(pdf.file_name)}</b>${safeVersionButton(pdf)}<button class="btn" data-material-slot="pdf" data-material-slot-id="${esc(material.material_id)}">更换 PDF</button></div>` : ''}
      ${extras.map(version => `<div><span class="sub">${esc(version.extension || '文件')}</span><b>${esc(version.file_name)}</b>${safeVersionButton(version)}</div>`).join('')}
      ${!docx ? `<div><span class="sub">编辑版 Word</span><span class="sub">尚未添加</span><button class="btn" data-material-slot="docx" data-material-slot-id="${esc(material.material_id)}">添加 Word</button></div>` : ''}${!pdf ? `<div><span class="sub">投递版 PDF</span><span class="sub">尚未添加</span><button class="btn" data-material-slot="pdf" data-material-slot-id="${esc(material.material_id)}">添加 PDF</button></div>` : ''}
      ${versions.length ? '' : '<div class="sub">尚未发现文件版本</div>'}
    </div>`;
  };
  const roleTagHtml = material => displayTags(material).map(tagValue => tag(tagValue, 'blue')).join(' ');
  const approvalLabel = material => isTrue(material.approved_for_use) ? '<span class="approved-mark">✓ 满意简历</span>' : (pathIsApproved(material) ? '<span class="tag amber">待确认加入</span>' : '');
  const materialCard = (material, { approved = false, company = false } = {}) => {
    const draft = !isTrue(material.approved_for_use) && (/draft|草稿|初稿/i.test(`${material.display_name} ${versionsFor(material.material_id).map(v => v.file_name).join(' ')}`) || /draft/i.test(material.status || ''));
    return `<article class="approved-resume-card" data-material-card="${esc(material.material_id)}">
      <div class="between material-card-title"><div><h3>${approved ? '✓ ' : ''}${esc(material.display_name || '未命名资料')}</h3><div class="sub">${esc(material.company || material.role_family || (company ? '公司资料' : '通用资料'))} ${draft ? tag('草稿', 'amber') : ''} ${approvalLabel(material)}</div></div><div>${roleTagHtml(material)}</div></div>
      ${materialCardFlags(material)}
      ${versionRows(material)}
      <div class="between material-card-foot"><span class="sub">最后更新：${fmt((latestVersion(material) || {}).modified_at || material.updated_at)}${pathIsApproved(material) ? ' · 满意简历文件夹' : ''}</span><div class="actions">${!isTrue(material.approved_for_use) ? `<button class="btn primary" data-material-approve="${esc(material.material_id)}">加入满意简历</button>` : `<button class="btn" data-material-remove-approved="${esc(material.material_id)}">移出满意简历</button>`}<button class="btn" data-material-edit="${esc(material.material_id)}">编辑信息</button></div></div>
    </article>`;
  };
  const materialCardFlags = material => {
    const { docx, pdf } = resumeFiles(material);
    const flags = [];
    if (isTrue(material.content_reference)) flags.push('内容参考');
    if (isTrue(material.format_template)) flags.push('格式模板');
    if (docx && pdf) flags.push('DOCX + PDF 已关联');
    else if (docx) flags.push('缺少投递版 PDF');
    else if (pdf) flags.push('缺少可编辑 DOCX');
    return `<div class="material-flags">${flags.length ? flags.map(x => tag(x, x.includes('缺少') ? 'amber' : 'green')).join(' ') : '<span class="sub">尚未指定用途 · 可在编辑信息中设置</span>'}</div>`;
  };
  const myTabs = () => window.CAREERPILOT_NAV.renderMyTabs(tab);
  const materialTabs = () => `<div class="tabs materials-tabs">${[['approved', '满意简历'], ['all', '全部资料'], ['company', '公司资料'], ['drafts', '草稿']].map(([key, label]) => `<button data-material-subtab="${key}" class="${materialsSubtab === key ? 'active' : ''}">${label}</button>`).join('')}</div>`;
  const folderPanel = () => `<div class="pathbox approved-folder-panel"><div class="between"><div><b>满意简历默认文件夹</b><div class="sub">文件放在哪里都可以；这里的文件夹只用于集中扫描，扫描到的新文件不会自动变成满意简历。</div></div><span class="tag">可选</span></div><div class="pathline"><input id="approved-mpath" value="${esc(configuredApprovedPath())}"><button class="btn" data-material-browse>浏览</button><button class="btn" data-material-open-folder>打开文件夹</button><button class="btn primary" data-material-rescan>重新扫描</button></div><div class="sub">上次扫描：${fmt(setting('approved_resumes_root_last_scanned'))} · ${esc(setting('approved_resumes_root_scan_status') || '尚未扫描')}</div></div>`;
  const addButton = `<button class="btn primary" data-material-add>+ 添加满意简历</button>`;
  const approvedPage = () => {
    const rows = activeLibraries().filter(isCv).filter(row => isTrue(row.approved_for_use));
    return `${folderPanel()}<div class="head material-inner-head"><div><h2>满意简历</h2><p>这里只放你已经完成并且认可的简历。生成定制简历时，只会从标记为“内容参考”的满意简历中挑选已有内容。</p></div>${addButton}</div><div class="notice">内容参考：允许 Codex 原文复制完整 bullet；格式模板：生成 DOCX 时沿用这份简历的排版。AI 默认只做选择、复制、排序和组合，不改写已认可的句子。</div><div class="approved-resume-list">${rows.map(row => materialCard(row, { approved: true })).join('') || '<div class="empty">还没有满意简历。点击右上角“+ 添加满意简历”，或在“全部资料”中把已有简历加入。</div>'}</div>`;
  };
  const allPage = () => {
    const rows = activeLibraries();
    const cvs = rows.filter(isCv), others = rows.filter(row => !isCv(row));
    const pairNotice = suspectedPairings().slice(0, 6).map(([left, right]) => `<div class="material-pair-suggestion"><b>疑似同一版本</b><span>${esc(left.display_name)} + ${esc(right.display_name)}</span><span class="sub">系统不会自动合并；打开其中一组的“编辑信息”，即可手动选择另一组的 DOCX/PDF。</span><button class="btn" data-material-edit="${esc(left.material_id)}">编辑并关联</button></div>`).join('');
    return `<div class="head material-inner-head"><div><h2>全部资料</h2><p>这里显示资料目录中已扫描到的文件。未点击“加入满意简历”的资料不会被定制简历提示词使用。</p></div>${addButton}</div>${pairNotice ? `<div class="notice material-pair-notice"><b>需要确认的文件配对</b>${pairNotice}</div>` : ''}<div class="section"><div class="between"><h2>简历</h2><span class="sub">${cvs.length} 组</span></div><div class="approved-resume-list">${cvs.map(row => materialCard(row)).join('') || '<div class="empty">尚未扫描到简历。</div>'}</div></div><div class="section"><div class="between"><h2>其他申请资料</h2><span class="sub">${others.length} 份</span></div><div class="approved-resume-list">${others.map(row => materialCard(row, { company: row.library_section === 'Company Application' })).join('') || '<div class="empty">暂无其他资料。</div>'}</div></div>`;
  };
  const companyPage = () => {
    const rows = activeLibraries().filter(row => row.library_section === 'Company Application' || row.company);
    const groups = new Map(); rows.forEach(row => { const key = row.company || '未标注公司'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); });
    return `<div class="head material-inner-head"><div><h2>公司资料</h2><p>按公司查看历史简历、求职信和其他申请材料；同一份简历可以同时出现在公司资料和满意简历中。</p></div>${addButton}</div>${[...groups.entries()].map(([name, group]) => `<div class="section company-material-group"><div class="between"><h2>${esc(name)}</h2><span class="sub">${group.length} 份</span></div><div class="approved-resume-list">${group.map(row => materialCard(row, { company: true })).join('')}</div></div>`).join('') || '<div class="empty">暂无公司资料。</div>'}`;
  };
  const draftsPage = () => {
    const rows = activeLibraries().filter(row => !isTrue(row.approved_for_use) && (/draft|草稿|初稿/i.test(`${row.display_name} ${row.status || ''} ${versionsFor(row.material_id).map(v => v.file_name).join(' ')}`)));
    return `<div class="head material-inner-head"><div><h2>草稿</h2><p>Codex 或你尚未确认的版本会留在这里。草稿不会自动进入满意简历，也不会作为内容来源。</p></div>${addButton}</div><div class="approved-resume-list">${rows.map(row => materialCard(row)).join('') || '<div class="empty">暂无已识别的草稿。新导入的资料仍需你手动确认后才会成为满意简历。</div>'}</div>`;
  };
  function renderMaterialsWorkspace() {
    const body = materialsSubtab === 'all' ? allPage() : materialsSubtab === 'company' ? companyPage() : materialsSubtab === 'drafts' ? draftsPage() : approvedPage();
    $('mine').innerHTML = `<div class="head"><div><h1>我的</h1><p>资料、偏好和设置</p></div></div>${myTabs()}${materialTabs()}<section data-materials-refactor>${body}</section>`;
  }
  window.__careerPilotMaterials = { render: renderMaterialsWorkspace, approved: () => activeLibraries().filter(row => isCv(row) && isTrue(row.approved_for_use)), contentSources: () => activeLibraries().filter(row => isCv(row) && isTrue(row.approved_for_use) && isTrue(row.content_reference)), formatTemplates: () => activeLibraries().filter(row => isCv(row) && isTrue(row.approved_for_use) && isTrue(row.format_template)) };
  window.mine = function () { if (tab === 2) renderMaterialsWorkspace(); else if (baseMine) baseMine(); };

  const readFileBase64 = async file => {
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const refreshMaterials = async () => { await load(); tab = 2; window.mine(); };
  const importOne = async (inputId, meta = {}) => {
    const file = $(inputId)?.files?.[0]; if (!file) throw Error('请选择一个 DOCX 或 PDF 文件。');
    return post('/api/master/material/import', { file_name: file.name, display_name: meta.displayName || file.name.replace(/\.[^.]+$/, ''), material_type: 'CV / Resume', pair_id: meta.pairId || '', pair_name: meta.pairName || '', base64: await readFileBase64(file) });
  };
  const addModal = () => openModal(`<h2>添加满意简历</h2><p class="notice">一份简历可以只有 Word、只有 PDF，也可以同时包含两个文件。两个槽位彼此独立，至少选择一个文件即可保存。</p><div class="form"><div class="field full"><label>简历名称</label><input id="approved-display-name" placeholder="例如：Finance CV"></div><div class="field full"><label>编辑版 Word（可选）</label><input id="approved-docx-file" type="file" accept=".docx"><div class="sub">只接受 .docx</div></div><div class="field full"><label>投递版 PDF（可选）</label><input id="approved-pdf-file" type="file" accept=".pdf"><div class="sub">只接受 .pdf</div></div></div><div id="material-add-error" class="resume-picker-error" hidden></div><div class="run"><span></span><div class="actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-material-save-new>保存简历</button></div></div>`);
  const existingModal = () => {
    const rows = activeLibraries().filter(row => isCv(row) && !isTrue(row.approved_for_use));
    openModal(`<h2>从已有资料选择</h2><p class="sub">选择后会把这组资料标记为满意简历；文件本身不会被删除或移动。</p><div class="approved-resume-list">${rows.map(row => `<div class="material-pick-row"><div><b>${esc(row.display_name)}</b><div class="sub">${esc(row.company || row.role_family || '通用资料')} · ${versionsFor(row.material_id).map(v => esc(v.extension)).join(' / ')}</div></div><button class="btn primary" data-material-approve="${esc(row.material_id)}">加入满意简历</button></div>`).join('') || '<div class="empty">没有待确认的简历资料。</div>'}</div><div class="run"><span></span><button class="btn" data-cancel>关闭</button></div>`);
  };
  const editModal = material => {
    const tags = displayTags(material), selected = new Set(tags), { versions, docx, pdf } = resumeFiles(material);
    const fileOptions = (extension, selectedId) => `<option value="">未指定</option>${allCvVersions(extension).map(version => { const owner = (S.materialLibrary || []).find(row => row.material_id === version.material_id); return `<option value="${esc(version.material_version_id)}" ${version.material_version_id === selectedId ? 'selected' : ''}>${esc(version.file_name)}${owner && owner.material_id !== material.material_id ? ` · 来自 ${esc(owner.display_name)}` : ''}</option>`; }).join('')}`;
    openModal(`<h2>编辑简历版本信息</h2><p class="sub">${esc(material.display_name)} · 一个版本可以同时关联编辑版和投递版</p><div class="form"><div class="field full"><label>显示名称</label><input id="material-display-name" value="${esc(material.display_name)}"></div><div class="field"><label>编辑版 DOCX</label><select id="material-editable-version">${fileOptions(/DOCX|DOC/i, material.editable_version_id || docx?.material_version_id)}</select></div><div class="field"><label>投递版 PDF</label><select id="material-submission-version">${fileOptions(/PDF/i, material.submission_version_id || pdf?.material_version_id)}</select></div><div class="field full"><label>用途标签</label><div class="check-grid">${roleLabels.map(label => `<label><input type="checkbox" data-material-role value="${esc(label)}" ${selected.has(label) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div><input id="material-custom-tags" placeholder="自定义标签，用分号分隔" value="${esc(tags.filter(item => !roleLabels.includes(item)).join('; '))}"></div><div class="field full"><label><input id="material-content-reference" type="checkbox" ${isTrue(material.content_reference) ? 'checked' : ''}> 作为内容参考（允许原文复制已有 bullet）</label><label><input id="material-format-template" type="checkbox" ${isTrue(material.format_template) ? 'checked' : ''}> 作为格式模板（生成 DOCX 时沿用排版）</label></div></div><p class="notice">默认严格复制模式：不会改写、拼接、缩短或编造已认可的 bullet。未确定的 DOCX/PDF 不会自动合并，请在这里手动关联。</p><div class="run"><span></span><div class="actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-material-save-info="${esc(material.material_id)}">保存信息</button></div></div>`);
  };
  const slotModal = (material, slot) => {
    const isDocx = slot === 'docx';
    openModal(`<h2>${isDocx ? '添加 / 更换 Word' : '添加 / 更换 PDF'}</h2><p class="sub">${esc(material.display_name)} · 只更新${isDocx ? '编辑版 Word 槽位' : '投递版 PDF 槽位'}，另一槽位保持不变。</p><input id="material-slot-file" type="file" accept="${isDocx ? '.docx' : '.pdf'}"><div id="material-slot-error" class="resume-picker-error" hidden></div><div class="run"><span></span><div class="actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-material-slot-save="${esc(material.material_id)}" data-material-slot-role="${slot}">保存</button></div></div>`);
  };

  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-material-subtab],[data-material-add],[data-material-show-existing],[data-material-approve],[data-material-remove-approved],[data-material-edit],[data-material-save-info],[data-material-open-version],[data-material-browse],[data-material-open-folder],[data-material-rescan],[data-material-import-single],[data-material-import-pair],[data-material-save-new],[data-material-slot],[data-material-slot-save]');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try {
      if (button.dataset.materialSubtab) { materialsSubtab = button.dataset.materialSubtab; renderMaterialsWorkspace(); return; }
      if (button.dataset.materialAdd !== undefined) { addModal(); return; }
      if (button.dataset.materialShowExisting !== undefined) { existingModal(); return; }
      if (button.dataset.materialOpenVersion) { window.open(`/api/master/material/version-file?id=${encodeURIComponent(button.dataset.materialOpenVersion)}`, '_blank', 'noopener'); return; }
      if (button.dataset.materialSlot) { const material = activeLibraries().find(row => row.material_id === button.dataset.materialSlotId); if (!material) throw Error('资料不存在，请刷新后重试。'); slotModal(material, button.dataset.materialSlot); return; }
      if (button.dataset.materialSlotSave) {
        const material = activeLibraries().find(row => row.material_id === button.dataset.materialSlotSave); const file = $('material-slot-file')?.files?.[0]; const slot = button.dataset.materialSlotRole; if (!material || !file) throw Error('请选择文件。');
        const ext = String(file.name || '').split('.').pop().toLowerCase(); if (slot === 'docx' && ext !== 'docx') throw Error('这里需要选择 Word 可编辑文件（.docx）。'); if (slot === 'pdf' && ext !== 'pdf') throw Error('这里需要选择 PDF 投递文件。');
        button.disabled = true; button.textContent = '正在保存…';
        await post('/api/master/material/resume-version/slot', { resume_id: material.material_id, slot: slot === 'docx' ? 'editable_docx' : 'submission_pdf', file: { file_name: file.name, base64: await readFileBase64(file) } }); closeM(); await refreshMaterials(); return;
      }
      if (button.dataset.materialSaveNew !== undefined) {
        const docx = $('approved-docx-file')?.files?.[0] || null; const pdf = $('approved-pdf-file')?.files?.[0] || null; const errorBox = $('material-add-error');
        if (!docx && !pdf) throw Error('至少选择一个 Word 或 PDF 文件。');
        if (docx && !/\.docx$/i.test(docx.name)) throw Error('编辑版需要 Word 文件（.docx）。');
        if (pdf && !/\.pdf$/i.test(pdf.name)) throw Error('投递版需要 PDF 文件（.pdf）。');
        button.disabled = true; button.textContent = '正在保存…';
        await post('/api/master/material/resume-version/import', { display_name: $('approved-display-name')?.value?.trim() || (docx || pdf).name.replace(/\.[^.]+$/, ''), approved_for_use: true, content_reference: true, editable: docx ? { file_name: docx.name, base64: await readFileBase64(docx) } : null, submission: pdf ? { file_name: pdf.name, base64: await readFileBase64(pdf) } : null });
        closeM(); await refreshMaterials(); return;
      }
      if (button.dataset.materialApprove) { await post('/api/master/material/update', { material_id: button.dataset.materialApprove, approved_for_use: true, content_reference: true }); await refreshMaterials(); return; }
      if (button.dataset.materialRemoveApproved) { await post('/api/master/material/update', { material_id: button.dataset.materialRemoveApproved, approved_for_use: false }); await refreshMaterials(); return; }
      if (button.dataset.materialEdit) { editModal(activeLibraries().find(row => row.material_id === button.dataset.materialEdit)); return; }
      if (button.dataset.materialSaveInfo) {
        const row = activeLibraries().find(item => item.material_id === button.dataset.materialSaveInfo); if (!row) throw Error('资料不存在，请重新扫描后重试。');
        const roleTags = [...document.querySelectorAll('[data-material-role]:checked')].map(input => input.value); const custom = String($('material-custom-tags')?.value || '').split(';').map(x => x.trim()).filter(Boolean);
        const editableId = $('material-editable-version')?.value || '', submissionId = $('material-submission-version')?.value || '';
        for (const versionId of [editableId, submissionId].filter(Boolean)) { const version = (S.materialVersions || []).find(item => item.material_version_id === versionId); if (version && version.material_id !== row.material_id) await post('/api/master/material/associate-version', { material_id: row.material_id, material_version_id: versionId }); }
        await post('/api/master/material/update', { material_id: row.material_id, display_name: $('material-display-name').value, editable_version_id: editableId, submission_version_id: submissionId, tags: [...roleTags, ...custom].join('; '), content_reference: Boolean($('material-content-reference').checked), format_template: Boolean($('material-format-template').checked) }); closeM(); await refreshMaterials(); return;
      }
      if (button.dataset.materialBrowse !== undefined) { const result = await post('/api/master/material/browse-folder'); if (!result.cancelled) $('approved-mpath').value = result.path; return; }
      if (button.dataset.materialOpenFolder !== undefined) { const result = await post('/api/master/material/ensure-approved-folder', { path: $('approved-mpath').value }); await post('/api/master/material/open-folder', { path: result.path }); return; }
      if (button.dataset.materialRescan !== undefined) { const folder = $('approved-mpath').value; await post('/api/master/material/ensure-approved-folder', { path: folder }); await post('/api/master/material/rescan-approved', { path: folder }); await refreshMaterials(); return; }
      if (button.dataset.materialImportSingle !== undefined) { button.disabled = true; await importOne('approved-single-file'); closeM(); await post('/api/master/material/rescan', { path: setting('materials_root') }); await refreshMaterials(); return; }
      if (button.dataset.materialImportPair !== undefined) { button.disabled = true; const docx = $('approved-docx-file')?.files?.[0]; const pdf = $('approved-pdf-file')?.files?.[0]; if (!docx || !pdf) throw Error('请同时选择编辑版 DOCX 和投递版 PDF。'); const pairId = `pair-${Date.now()}`; const pairName = docx.name.replace(/\.[^.]+$/, ''); await importOne('approved-docx-file', { pairId, pairName, displayName: pairName }); await importOne('approved-pdf-file', { pairId, pairName, displayName: pairName }); closeM(); await post('/api/master/material/rescan', { path: setting('materials_root') }); const refreshed = await fetch('/api/master/snapshot', { cache: 'no-store' }).then(response => response.json()); const paired = (refreshed.materialLibrary || []).find(row => (refreshed.materialVersions || []).some(version => version.material_id === row.material_id && String(version.file_name || '').includes(pairId))); if (paired) await post('/api/master/material/update', { material_id: paired.material_id, display_name: pairName }); await refreshMaterials(); return; }
    } catch (error) {
      const box = $('material-slot-error') || document.querySelector('#modal .resume-picker-error') || (() => { const node = document.createElement('div'); node.className = 'resume-picker-error'; node.id = 'material-action-error'; document.querySelector('#modal')?.appendChild(node); return node; })();
      if (box) { box.textContent = `⚠ ${error.message || '资料操作失败，请重试。'}`; box.hidden = false; }
      if (button) { button.disabled = false; button.textContent = button.dataset.materialSlotRole ? '保存' : '重试'; }
    }
  }, true);

  const resumePromptButton = () => {
    const actions = document.querySelector('#drawer .actions'); if (!actions || actions.querySelector('[data-generate-resume-prompt]')) return;
    const heading = document.querySelector('#drawer h2')?.textContent?.trim(); const job = (S.jobs || []).find(row => row.job_title === heading);
    if (job) { const button = document.createElement('button'); button.className = 'btn'; button.dataset.generateResumePrompt = job.job_id; button.textContent = '生成定制简历提示词'; actions.appendChild(button); }
  };
  const promptPreview = job => {
    const content = window.__careerPilotMaterials.contentSources(), templates = window.__careerPilotMaterials.formatTemplates();
    if (!content.length) { openModal(`<h2>生成定制简历提示词</h2><div class="notice">目前没有标记为“内容参考”的满意简历。请先到“我的 → 求职资料 → 满意简历”加入一份，并在编辑信息中勾选“作为内容参考”。</div><div class="run"><span></span><button class="btn" data-cancel>关闭</button></div>`); return; }
    openModal(`<h2>生成定制简历 Prompt</h2><p class="sub">${esc(job.company)} · ${esc(job.job_title)}</p><div class="form"><div class="field full"><label>内容参考（只从这些满意简历复制原文）</label><div class="check-grid">${content.map(row => `<label><input type="checkbox" data-resume-content="${esc(row.material_id)}" checked> ${esc(sourceName(row))}</label>`).join('')}</div></div><div class="field full"><label>格式模板</label><select id="resume-format-template">${templates.length ? templates.map(row => `<option value="${esc(row.material_id)}">${esc(sourceName(row))}</option>`).join('') : '<option value="">尚未指定格式模板</option>'}</select></div></div><div class="notice">本次将使用：<br>内容参考：${content.map(row => `✓ ${esc(row.display_name)}`).join('<br>')}<br>格式模板：${templates[0] ? esc(templates[0].display_name) : '待指定'}</div><div class="run"><span></span><div class="actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-resume-prompt-generate="${esc(job.job_id)}" ${templates.length ? '' : 'disabled'}>生成 Prompt</button></div></div>`);
  };
  const generateResumePrompt = jobId => {
    const job = (S.jobs || []).find(row => row.job_id === jobId); const contentIds = [...document.querySelectorAll('[data-resume-content]:checked')].map(input => input.dataset.resumeContent); const content = window.__careerPilotMaterials.contentSources().filter(row => contentIds.includes(row.material_id)); const template = window.__careerPilotMaterials.formatTemplates().find(row => row.material_id === $('resume-format-template')?.value) || window.__careerPilotMaterials.formatTemplates()[0];
    if (!content.length || !template) throw Error('请至少选择一份内容参考和一份格式模板。');
    const lines = [`TARGET JOB: ${job.company} — ${job.job_title}`, `JOB DESCRIPTION: ${job.description || job.job_description || '请读取当前岗位详情中的完整职位描述。'}`, '', 'STRICT COPY MODE', 'Only SELECT, COPY, REORDER, REMOVE, and COMBINE complete approved blocks or complete approved bullets.', 'Do not rewrite, paraphrase, shorten, expand, merge, split, optimize, or invent any approved bullet, metric, skill, or fact.', 'If the content does not fit exactly one A4 page, remove lower-priority approved content instead of rewriting it.', '', `FORMAT TEMPLATE: ${template.display_name}`, ...versionsFor(template.material_id).filter(v => /DOCX|DOC$/i.test(v.extension || '')).map(v => `Format file: ${v.file_name}`), '', 'CONTENT SOURCES (approved and content-reference only):', ...content.flatMap(row => [`- ${row.display_name}`, ...versionsFor(row.material_id).map(v => `  Source file: ${v.file_name}`)]), '', 'OUTPUT REQUIREMENTS:', 'Create a new versioned DOCX draft using the selected format template.', 'Keep a source report for every Experience / Project / bullet and state Copied verbatim: YES.', 'Render to PDF, verify EXACTLY ONE A4 PAGE, and do not submit or mark as approved automatically.'];
    openModal(`<h2>定制简历提示词</h2><textarea class="prompt-output" id="generated-resume-prompt" readonly>${esc(lines.join('\n'))}</textarea><div class="run"><span class="sub">来源已限定为满意简历；生成版本应保持草稿，待你确认后再加入满意简历。</span><div class="actions"><button class="btn" data-copy-resume-prompt>复制提示词</button><button class="btn" data-cancel>关闭</button></div></div>`);
  };
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-generate-resume-prompt],[data-resume-prompt-generate],[data-copy-resume-prompt]'); if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try {
      if (button.dataset.generateResumePrompt) { promptPreview((S.jobs || []).find(row => row.job_id === button.dataset.generateResumePrompt)); return; }
      if (button.dataset.resumePromptGenerate) { generateResumePrompt(button.dataset.resumePromptGenerate); return; }
      if (button.dataset.copyResumePrompt) { await navigator.clipboard.writeText($('generated-resume-prompt').value); button.textContent = '已复制'; }
    } catch (error) {
      const box = $('material-action-error') || document.querySelector('#modal .resume-picker-error') || (() => { const node = document.createElement('div'); node.className = 'resume-picker-error'; node.id = 'material-action-error'; document.querySelector('#modal')?.appendChild(node); return node; })();
      if (box) { box.textContent = `⚠ ${error.message || '提示词生成失败。'}`; box.hidden = false; }
    }
  }, true);
  const observer = new MutationObserver(() => setTimeout(resumePromptButton, 0));
  observer.observe(document.getElementById('drawer') || document.body, { childList:true, subtree:true });
  const style = document.createElement('style');
  style.textContent = `.materials-tabs{margin-top:12px}.material-inner-head{margin-top:20px}.approved-folder-panel{margin-top:14px}.approved-resume-list{display:grid;gap:12px}.approved-resume-card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px}.material-card-title h3{margin:0 0 4px}.approved-mark{color:#16803c;font-weight:700;font-size:12px}.material-flags{margin:12px 0 2px}.material-files{display:grid;gap:8px;margin:14px 0}.material-files>div{display:grid;grid-template-columns:110px minmax(0,1fr) auto auto;gap:8px;align-items:center;border-top:1px solid var(--line);padding-top:8px}.material-files b{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.material-files .btn{white-space:nowrap;min-width:max-content;flex-shrink:0}.material-card-foot{gap:12px;align-items:flex-end}.material-add-options{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.material-add-option{border:1px solid var(--line);border-radius:12px;padding:14px}.material-add-option h3{margin:0 0 7px;font-size:14px}.material-add-option input{display:block;margin:7px 0 12px}.material-pick-row{display:flex;justify-content:space-between;gap:12px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:12px}.material-pair-notice{display:grid;gap:8px}.material-pair-suggestion{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--line)}.check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:8px 0}.prompt-output{width:100%;min-height:360px;font:13px/1.5 Consolas,monospace;padding:12px;border:1px solid var(--line);border-radius:10px}@media(max-width:800px){.material-add-options{grid-template-columns:1fr}.material-files>div{grid-template-columns:110px minmax(0,1fr)}.material-files .btn{grid-column:auto;justify-self:start}.material-card-foot{display:block}.material-card-foot .actions{margin-top:10px}.check-grid{grid-template-columns:1fr}}`;
  document.head.appendChild(style);
})();
