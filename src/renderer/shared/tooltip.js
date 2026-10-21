// In-page tooltips. Native tooltips are separate OS windows that ignore capture exclusion,
// so they would leak into recordings; this replaces every [title] with a DOM tooltip.
(function () {
  const tip = document.createElement('div');
  tip.className = 'cp-tooltip';
  tip.hidden = true;
  Object.assign(tip.style, {
    position: 'fixed', zIndex: 99999, pointerEvents: 'none', padding: '4px 8px', borderRadius: '5px', maxWidth: '280px',
    background: '#222838', color: '#e9edf5', border: '1px solid #343c50', font: '12px "Segoe UI", system-ui, sans-serif',
    boxShadow: '0 6px 18px rgba(0,0,0,.4)', whiteSpace: 'nowrap',
  });
  document.addEventListener('DOMContentLoaded', () => document.body.append(tip));
  let timer = null;
  let current = null;

  function adopt(el) {
    if (el.hasAttribute('title')) {
      el.dataset.tip = el.getAttribute('title');
      if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.dataset.tip);
      el.removeAttribute('title');
    }
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[title],[data-tip]');
    if (!el || el === current) return;
    adopt(el);
    current = el;
    clearTimeout(timer);
    tip.hidden = true;
    timer = setTimeout(() => {
      if (current !== el || !document.body.contains(el)) return;
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
      let top = r.bottom + 6;
      if (top + t.height > innerHeight) top = r.top - t.height - 6;
      tip.style.top = `${Math.max(2, top)}px`;
      tip.style.left = `${Math.min(Math.max(2, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 2)}px`;
    }, 450);
  });
  document.addEventListener('mouseout', (e) => {
    if (current && !current.contains(e.relatedTarget)) { current = null; clearTimeout(timer); tip.hidden = true; }
  });
  document.addEventListener('mousedown', () => { clearTimeout(timer); tip.hidden = true; });
})();
