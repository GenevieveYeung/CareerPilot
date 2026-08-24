(() => {
  const actionLabels = {
    approved_for_use: ['标记为满意', '已满意'],
    format_template: ['设为格式模板', '格式模板'],
    content_reference: ['设为内容参考', '内容参考'],
  };
  const decorate = () => {
    if (!window.S?.materialLibrary) return;
    document.querySelectorAll('#mine .material').forEach(row => {
      if (row.querySelector('[data-material-update]')) return;
      const name = row.querySelector('b')?.textContent?.trim();
      const item = (S.materialLibrary || []).find(material => material.display_name === name);
      if (!item) return;
      const actions = document.createElement('div'); actions.className = 'actions';
      for (const key of Object.keys(actionLabels)) {
        const button = document.createElement('button'); button.className = 'btn'; button.dataset.materialUpdate = item.material_id; button.dataset.materialAction = key; button.dataset.materialValue = item[key] === true ? 'true' : 'false'; button.textContent = item[key] === true ? actionLabels[key][1] : actionLabels[key][0]; actions.appendChild(button);
      }
      row.appendChild(actions);
    });
  };
  setTimeout(decorate, 250); setTimeout(decorate, 1200);
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-material-update]'); if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (button.disabled) return; button.disabled = true; const old = button.textContent; button.textContent = '正在保存…';
    try {
      await window.__careerPilotApiRequest('/api/master/material/update', { method: 'POST', body: { material_id: button.dataset.materialUpdate, [button.dataset.materialAction]: button.dataset.materialValue !== 'true' } });
      document.querySelector('[data-refresh]')?.click();
    } catch (error) { button.disabled = false; button.textContent = old; alert(error.message); }
  }, true);
})();
