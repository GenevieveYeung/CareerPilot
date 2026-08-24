/* Single source of truth for the CareerPilot “我的” navigation. */
(() => {
  const tabs = Object.freeze([
    Object.freeze({ key: 'profile', label: '个人资料' }),
    Object.freeze({ key: 'preferences', label: '求职偏好' }),
    Object.freeze({ key: 'materials', label: '求职资料' }),
    Object.freeze({ key: 'search_templates', label: '搜索模板' }),
    Object.freeze({ key: 'data_settings', label: '数据与设置' }),
    Object.freeze({ key: 'reminders', label: '提醒设置' }),
  ]);
  const byIndex = index => tabs[Math.max(0, Math.min(tabs.length - 1, Number(index) || 0))];
  const keyIndex = key => Math.max(0, tabs.findIndex(item => item.key === key));
  const initialTab = () => {
    const match = String(location.hash || '').match(/^#mine\/([^/?#]+)/);
    return match ? keyIndex(decodeURIComponent(match[1])) : 0;
  };
  const nav = {
    tabs,
    activeIndex: initialTab(),
    byIndex,
    initialTab,
    setActive(index, { replace = false } = {}) {
      const item = byIndex(index);
      nav.activeIndex = tabs.indexOf(item);
      const nextHash = `#mine/${item.key}`;
      if (location.hash !== nextHash) {
        const method = replace ? 'replaceState' : 'pushState';
        history[method]({ mineTab: nav.activeIndex }, '', nextHash);
      }
      return nav.activeIndex;
    },
    renderMyTabs(activeIndex) {
      return `<div class="tabs my-tabs" data-my-navigation>${tabs.map((item, index) => `<button type="button" data-tab="${index}" data-my-tab="${item.key}" class="${Number(activeIndex) === index ? 'active' : ''}">${item.label}</button>`).join('')}</div>`;
    },
    normalizeMyTabs(root = document) {
      root.querySelectorAll('#mine .tabs:not(.materials-tabs):not(.my-tabs)').forEach(container => {
        const active = [...container.querySelectorAll('[data-tab]')].find(button => button.classList.contains('active'))?.dataset.tab || nav.activeIndex || 0;
        const replacement = document.createElement('div');
        replacement.innerHTML = nav.renderMyTabs(active);
        container.replaceWith(replacement.firstElementChild);
      });
    },
    labelFor: key => tabs.find(item => item.key === key)?.label || key,
  };
  window.CAREERPILOT_NAV = nav;

  const start = () => {
    const style = document.createElement('style');
    style.textContent = '.my-tabs{display:flex;flex-wrap:wrap;gap:0;overflow-x:auto;scrollbar-width:thin}.my-tabs button{flex:0 0 auto}';
    document.head.appendChild(style);
    nav.normalizeMyTabs();
    new MutationObserver(() => nav.normalizeMyTabs()).observe(document.body, { childList: true, subtree: true });
    setTimeout(restoreRoute, 0);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  document.addEventListener('click', event => {
    const button = event.target.closest('#mine [data-my-tab]');
    if (button) nav.setActive(button.dataset.tab);
  }, true);
  const restoreRoute = () => {
    nav.activeIndex = initialTab();
    if (String(location.hash || '').startsWith('#mine/') && typeof go === 'function') go('mine');
    if (typeof tab !== 'undefined') {
      tab = nav.activeIndex;
      if (typeof window.mine === 'function') window.mine();
    }
  };
  window.addEventListener('popstate', restoreRoute);
  window.addEventListener('hashchange', restoreRoute);
})();
