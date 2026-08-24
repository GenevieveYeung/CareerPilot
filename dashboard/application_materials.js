(() => {
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-open-application-material]'); if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    window.open(`/api/master/application/material/file?id=${encodeURIComponent(button.dataset.openApplicationMaterial)}`, '_blank', 'noopener');
  }, true);
})();
