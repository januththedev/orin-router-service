/**
 * ORIN DESIGN SYSTEM — tiny helpers v1.0.0 (no dependencies).
 * toast(), copyText(), modal(), tabs() — wire by id, no framework.
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  let toastTimer = null;
  function toast(msg) {
    let el = $('orin-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'orin-toast';
      el.className = 'o-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function copyText(s) {
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* clipboard denied */ }
      ta.remove();
      return ok;
    }
  }

  /** Minimal modal: back element + dialog, Esc/backdrop close, focus into dialog. */
  function modal(backId) {
    const back = $(backId);
    if (!back) return { open() {}, close() {} };
    const close = () => {
      back.classList.remove('open');
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    return {
      open() {
        back.classList.add('open');
        document.addEventListener('keydown', onKey);
        const f = back.querySelector('input,select,textarea,button');
        if (f) setTimeout(() => f.focus(), 60);
      },
      close,
      el: back,
    };
  }

  /** Tab group: buttons with data-tab + panes with data-pane, synced. */
  function tabs(groupId, onChange) {
    const g = $(groupId);
    if (!g) return;
    const btns = [...g.querySelectorAll('[data-tab]')];
    const select = (name) => {
      btns.forEach((b) => {
        const on = b.dataset.tab === name;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        const pane = document.querySelector(`[data-pane="${b.dataset.tab}"]`);
        if (pane) pane.classList.toggle('o-hidden', !on);
      });
      if (onChange) onChange(name);
    };
    btns.forEach((b) => b.addEventListener('click', () => select(b.dataset.tab)));
  }

  /** Button busy state: spinner until fn settles. */
  async function busy(btn, fn) {
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="o-spin"></span>';
    try { return await fn(); }
    finally { btn.disabled = false; btn.innerHTML = old; }
  }

  window.OrinUI = { $, toast, copyText, modal, tabs, busy };
})();
