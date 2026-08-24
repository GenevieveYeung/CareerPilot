/* Local search is a prompt generator. The browser must not imply that it has
 * performed a web search by merely creating a queued record. */
(() => {
  const clean = value => String(value || '').trim();
  const generate = (routine = null) => {
    const location = clean(document.getElementById('sloc')?.value || 'Hong Kong');
    const roles = clean(document.getElementById('sroles')?.value || routine?.name || 'Graduate / MT; AI / ML; Data; Risk');
    const year = clean(document.getElementById('syear')?.value || '2027');
    const companyTypes = clean(document.getElementById('sco')?.value || '大型企业；跨国公司；金融机构');
    const keywords = clean(document.getElementById('skw')?.value);
    const negative = clean(document.getElementById('sneg')?.value);
    const sources = [...document.querySelectorAll('[data-source]:checked')].map(x => x.value).join('、') || '公司官网、官方 ATS、LinkedIn、JobsDB、CTgoodjobs';
    const raw = routine?.prompt ? `\n\n以下是已保存模板的补充要求（只可作为搜索约束，不得跳过实际职位页验证）：\n${routine.prompt}` : '';
    return `你是我的香港求职搜索助手。请按以下条件寻找 ${year} 届仍开放、可实际申请的具体职位，并输出可导入 CareerPilot 的结构化结果。\n\n地区：${location}\n岗位方向：${roles}\n公司类型：${companyTypes}\n关键词：${keywords || '无'}\n排除关键词：${negative || '无'}\n优先来源：${sources}${raw}\n\n强制流程：Search → Open actual job page → Confirm concrete title/company/location → Confirm still open and has an apply entry → Deduplicate against the supplied job pool → Return only validated jobs. 不要把搜索结果页、公司招聘首页、人才库或旧缓存当成具体职位。请完整阅读 JD，区分 Required / Preferred / Optional，并标记不符合的硬性条件。每条结果给出公司、职位、地点、项目类型、官方职位链接、来源、截止日期（未知留空）、验证日期、验证结论、匹配理由和不匹配风险。${raw}`;
  };
  const show = routine => {
    if (typeof openModal !== 'function') return;
    const prompt = generate(routine);
    openModal(`<h2>搜索提示词已生成</h2><p class="notice">请复制下面的搜索提示词，打开 Codex 执行搜索；本地页面不会假装已经联网搜索。</p><textarea id="generated-search-prompt" style="width:100%;min-height:320px">${esc(prompt)}</textarea><div class="run"><span></span><div class="actions"><button class="btn" data-cancel>关闭</button><button class="btn primary" data-copy-search-prompt>复制提示词</button></div></div>`);
  };
  const relabel = () => {
    document.querySelectorAll('[data-start-search]').forEach(button => { if (button.textContent !== '生成搜索提示词') button.textContent = '生成搜索提示词'; });
    document.querySelectorAll('[data-run-routine]').forEach(button => { if (button.textContent !== '生成搜索提示词') button.textContent = '生成搜索提示词'; });
    document.querySelectorAll('#mine .notice').forEach(node => { if (node.textContent.includes('保存的搜索') && node.textContent !== '保存的搜索模板只保存条件；需要实际搜索时生成提示词并交给 Codex 执行。') node.textContent = '保存的搜索模板只保存条件；需要实际搜索时生成提示词并交给 Codex 执行。'; });
  };
  // The page already has a single render path. A document-wide
  // MutationObserver here would observe its own text changes and can starve
  // the renderer, so use bounded post-render passes instead.
  setTimeout(relabel, 250);
  setTimeout(relabel, 1200);
  document.addEventListener('click', event => {
    const search = event.target.closest('[data-start-search]');
    const routineButton = event.target.closest('[data-run-routine]');
    const copy = event.target.closest('[data-copy-search-prompt]');
    if (!search && !routineButton && !copy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (copy) {
      const text = document.getElementById('generated-search-prompt')?.value || '';
      navigator.clipboard?.writeText(text).then(() => { copy.textContent = '✓ 已复制'; }).catch(() => { document.getElementById('generated-search-prompt')?.select(); copy.textContent = '请手动复制'; });
      return;
    }
    const routine = routineButton ? (S.routines || []).find(x => x.routine_id === routineButton.dataset.runRoutine) : null;
    show(routine);
  }, true);
})();
