// ==========================================================================
// resources.js — NotebookLM study material, one notebook per syllabus chapter.
// Flow: Telegram id cookie -> GET /api/resources -> subject tabs + chapter cards. Refreshes by itself
// while anything is still being prepared.
// ==========================================================================
(() => {
  'use strict';

  const POLL_MS = 15000;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const getCookie = (name) => {
    const m = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    if (!m) return '';
    try { return decodeURIComponent(m.slice(name.length + 1)); } catch { return ''; }
  };

  // Same fallback the quiz page uses: setup saved before the cookie existed
  function telegramId() {
    const fromCookie = getCookie('sa_telegram_id');
    if (/^\d+$/.test(fromCookie)) return fromCookie;
    try {
      const st = JSON.parse(localStorage.getItem('study_agent_config') || 'null');
      const id = String(st?.telegram?.userId || st?.telegram?.chatId || '');
      return /^\d+$/.test(id) ? id : '';
    } catch { return ''; }
  }

  const ASSET = {
    audio:       { label: 'Audio overview', icon: 'fa-headphones' },
    video:       { label: 'Video overview', icon: 'fa-film' },
    slide_deck:  { label: 'Slide deck',     icon: 'fa-display' },
    report:      { label: 'Study guide',    icon: 'fa-book-open' },
    flashcards:  { label: 'Flashcards',     icon: 'fa-clone' },
    quiz:        { label: 'Quiz',           icon: 'fa-circle-question' },
    mind_map:    { label: 'Mind map',       icon: 'fa-diagram-project' },
    infographic: { label: 'Infographic',    icon: 'fa-image' },
    data_table:  { label: 'Data table',     icon: 'fa-table' },
  };
  const STATUS = {
    done: { text: 'Ready', icon: 'fa-circle-check' },
    running: { text: 'Generating', icon: 'fa-spinner' },
    pending: { text: 'Queued', icon: 'fa-clock' },
    blocked_quota: { text: 'Waiting for daily limit', icon: 'fa-hourglass-half' },
    failed: { text: "Couldn't make", icon: 'fa-circle-xmark' },
  };
  const BUSY = new Set(['pending', 'running', 'blocked_quota']);

  const VIEWS = ['rs-gate', 'rs-loading', 'rs-empty', 'rs-list'];
  const show = (id) => VIEWS.forEach((v) => { $(v).hidden = v !== id; });
  function banner(html) { const b = $('rs-banner'); b.innerHTML = html || ''; b.hidden = !html; }

  let userId = '';
  let data = null;
  let activeTab = 'all';
  let timer = null;

  async function load(showSpinner) {
    clearTimeout(timer);
    if (showSpinner) show('rs-loading');
    try {
      const res = await fetch(`/api/resources?telegramUserId=${encodeURIComponent(userId)}`, { credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      data = body;
      render();
    } catch (e) {
      banner(`Couldn't load your resources: ${esc(e.message)}`);
      if (!data) show('rs-empty');
    }
    const busy = data && (!data.notebooks.length || data.notebooks.some((n) =>
      n.source_status === 'pending' || n.assets.some((a) => BUSY.has(a.status))));
    if (busy && !document.hidden && data?.session_status !== 'expired' && !data?.paused) timer = setTimeout(() => load(false), POLL_MS);
  }

  function render() {
    if (!data.has_session) {
      $('rs-gate-title').textContent = 'Connect NotebookLM to get study material';
      $('rs-gate-text').textContent = 'Resources are generated in your own NotebookLM account. Sign in to it on the setup page and press Save Configuration.';
      return show('rs-gate');
    }
    banner(
      data.session_status === 'expired'
        ? 'Your NotebookLM sign-in has expired, so nothing new is being made. <a href="setup.html">Sign in again on the setup page</a>.'
        : data.paused ? 'Paused. Send /resume to the bot to carry on.' : ''
    );
    if (!data.notebooks.length) return show('rs-empty');
    show('rs-list');

    const all = data.notebooks;
    const ready = all.reduce((n, nb) => n + nb.assets.filter((a) => a.status === 'done').length, 0);
    const working = all.reduce((n, nb) => n + nb.assets.filter((a) => BUSY.has(a.status)).length, 0);
    $('rs-summary').textContent = `${all.length} chapter${all.length === 1 ? '' : 's'} · ${ready} item${ready === 1 ? '' : 's'} ready` +
      (working ? ` · ${working} still on the way` : '');

    const subjects = [...new Set(all.map((n) => n.subject))];
    if (activeTab !== 'all' && !subjects.includes(activeTab)) activeTab = 'all';
    const tabs = $('rs-tabs');
    tabs.innerHTML = '';
    ['all', ...subjects].forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qz-tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(s === activeTab));
      b.textContent = s === 'all' ? 'All subjects' : s;
      b.addEventListener('click', () => { activeTab = s; render(); });
      tabs.appendChild(b);
    });

    $('rs-sections').innerHTML = subjects
      .filter((s) => activeTab === 'all' || s === activeTab)
      .map((s) => {
        const list = all.filter((n) => n.subject === s);
        return `<section class="rs-subject"><h2>${esc(s)} <small>${list.length} chapter${list.length === 1 ? '' : 's'}</small></h2>
          <div class="rs-grid">${list.map(card).join('')}</div></section>`;
      }).join('');
  }

  function notebookUrl(nb) {
    if (!nb.notebook_id) return '';
    const u = `https://notebooklm.google.com/notebook/${encodeURIComponent(nb.notebook_id)}`;
    return data.google_email ? `${u}?authuser=${encodeURIComponent(data.google_email)}` : u;
  }

  function card(nb) {
    const link = notebookUrl(nb);
    let body;
    if (nb.source_status === 'skipped_no_source') {
      body = '<p class="rs-note">No NCERT textbook PDF for this chapter, so there is nothing to build from.</p>';
    } else if (nb.source_status === 'source_failed') {
      body = '<p class="rs-note bad">The textbook PDF could not be loaded into NotebookLM.</p>';
    } else if (nb.source_status === 'pending' || !nb.assets.length) {
      body = '<p class="rs-note">Setting up the notebook…</p>';
    } else {
      body = `<div class="rs-chips">${nb.assets.map((a) => {
        const meta = ASSET[a.type] || { label: a.type, icon: 'fa-file' };
        const st = STATUS[a.status] || STATUS.pending;
        return `<span class="rs-chip ${esc(a.status)}" title="${esc(st.text)}"><i class="fa-solid ${st.icon}" aria-hidden="true"></i>${esc(meta.label)}<span class="qz-sr"> — ${esc(st.text)}</span></span>`;
      }).join('')}</div>`;
    }
    return `<article class="rs-card">
      <div class="rs-card-top">
        <div><h3>${esc(nb.chapter_title)}</h3>${nb.exam ? `<div class="rs-exam">${esc(nb.exam)}</div>` : ''}</div>
        ${link ? `<a class="rs-open" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : ''}
      </div>${body}</article>`;
  }

  function init() {
    userId = telegramId();
    $('rs-refresh').addEventListener('click', () => load(true));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false); });
    if (!userId) return show('rs-gate');
    load(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();