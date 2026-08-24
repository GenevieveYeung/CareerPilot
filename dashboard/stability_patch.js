/* Small stability layer for existing UI actions. It does not add a feature:
 * it prevents duplicate writes, shows save progress, and injects an
 * idempotency key into the existing progress-event request. */
(() => {
  const style = document.createElement('style');
  style.textContent = '.tag.red{background:#fef2f2;color:#b42318}.btn:disabled{opacity:.65;cursor:wait}';
  document.head.appendChild(style);
  const selector = '[data-save-progress],[data-save-cv],[data-mark-save],[data-add-save],[data-event-save],[data-save-profile],[data-save-pref],[data-save-routine],[data-confirm-candidate],[data-rescan],[data-save-settings],[data-save-credential],[data-save-reminder-settings],[data-save-reminder-credential],[data-delete-reminder-credential],[data-test-reminder]';
  let activeButton = null;
  const restore = (button, success = false) => {
    if (!button) return;
    button.disabled = false;
    button.dataset.saving = '';
    if (success) {
      button.textContent = '✓ 已保存';
      setTimeout(() => { if (button.isConnected) button.textContent = button.dataset.originalText || '保存'; }, 1200);
    } else if (button.dataset.originalText) button.textContent = button.dataset.originalText;
  };

  document.addEventListener('click', event => {
    const button = event.target.closest(selector);
    if (!button) return;
    if (button.dataset.saving === '1') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    button.dataset.saving = '1';
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = '正在保存…';
    if (button.dataset.saveProgress && !button.dataset.eventKey) {
      button.dataset.eventKey = `ui-event-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    activeButton = button;
  }, true);

  const rawRequest = window.__careerPilotApiRequest;
  if (!rawRequest) return;
  window.__careerPilotApiRequest = async (url, options = {}) => {
    let next = options;
    if (activeButton?.dataset.saveProgress && String(url).endsWith('/api/master/application/event/add') && options.body) {
      next = { ...options, body: { ...options.body, client_event_key: activeButton.dataset.eventKey, deadline_time: document.getElementById('edeadline_time')?.value || '' } };
    }
    try {
      return await rawRequest(url, next);
    } catch (error) {
      if (activeButton) restore(activeButton, false);
      activeButton = null;
      throw error;
    } finally {
      if (activeButton && !String(url).endsWith('/api/master/application/event/add')) restore(activeButton, true);
      if (activeButton && String(url).endsWith('/api/master/application/event/add')) restore(activeButton, true);
      activeButton = null;
    }
  };
})();
