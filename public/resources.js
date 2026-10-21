// ==========================================================================
// resources.js — Dynamic Chapter Accordion & NotebookLM Resource Generation
// Features:
// 1. Dynamic chapter loading from user's syllabus in DB + expandable accordions
// 2. Supported NotebookLM resource types with strict exclusion of Infographics & Report
// 3. Full two-way checkbox synchronization (resource <-> chapter Select All <-> global Select All Chapters)
// 4. State persistence & strict No-Regeneration rule for already-generated resources
// 5. Graceful quota/rate-limit handling: "Limit Reached! try again after {time}"
// ==========================================================================
(() => {
  'use strict';

  const POLL_MS = 5000;
  const MAX_PDF_BYTES = 20 * 1024 * 1024;
  const $ = (id) => document.getElementById(id);

  // Strict exclusion rule: "Infographics" and "Report" are NEVER included
  const EXCLUDED_TYPES = new Set(['infographics', 'infographic', 'report', 'reports']);

  const DEFAULT_RESOURCE_TYPES = [
    {
      id: 'audio_overview',
      label: 'Audio Overview',
      icon: 'fa-solid fa-headphones',
      description: 'Two-host AI deep-dive conversation unpacking the chapter’s core ideas.',
    },
    {
      id: 'study_guide',
      label: 'Study Guide',
      icon: 'fa-solid fa-book-open-reader',
      description: 'Comprehensive concept review, key terms glossary, and practice questions.',
    },
    {
      id: 'briefing_doc',
      label: 'Briefing Doc',
      icon: 'fa-solid fa-file-lines',
      description: 'Structured executive summary of core principles and exam takeaways.',
    },
    {
      id: 'faq',
      label: 'FAQ',
      icon: 'fa-solid fa-circle-question',
      description: 'High-probability exam questions with step-by-step model answers.',
    },
    {
      id: 'timeline',
      label: 'Timeline',
      icon: 'fa-solid fa-timeline',
      description: 'Chronological sequence of events, processes, or step-by-step derivations.',
    },
    {
      id: 'flashcards',
      label: 'Flashcards',
      icon: 'fa-solid fa-layer-group',
      description: 'Active-recall Q&A cards for key definitions, formulas, and distinctions.',
    },
    {
      id: 'mind_map',
      label: 'Mind Map',
      icon: 'fa-solid fa-diagram-project',
      description: 'Hierarchical concept map showing how subtopics connect across the chapter.',
    },
    {
      id: 'slide_deck',
      label: 'Slide Deck',
      icon: 'fa-solid fa-chalkboard',
      description: 'Slide-by-slide visual revision outline for rapid pre-exam review.',
    },
  ];

  // ---------- Cookie & LocalStorage Setup Sync ----------
  const getCookie = (name) => {
    const m = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    if (!m) return '';
    try {
      return decodeURIComponent(m.slice(name.length + 1));
    } catch {
      return '';
    }
  };

  const setCookie = (name, value) => {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=31536000; path=/; SameSite=Lax${secure}`;
  };

  let savedSetupConfig = null;
  function backfillCookiesFromSetup() {
    try {
      const st = JSON.parse(localStorage.getItem('study_agent_config') || 'null');
      if (!st) return;
      savedSetupConfig = st;
      const id = String(st.telegram?.userId || st.telegram?.chatId || '');
      const key = (st.geminiKeys || [])
        .map((k) => String(k.key || '').trim())
        .find((k) => k.length >= 20 && !/\s/.test(k));
      if (!getCookie('sa_telegram_id') && /^\d+$/.test(id)) setCookie('sa_telegram_id', id);
      if (!getCookie('sa_gemini_key') && key) setCookie('sa_gemini_key', key);
      if (!getCookie('sa_notebooklm_auth')) {
        setCookie('sa_notebooklm_auth', st.notebooklm?.status === 'connected' ? 'connected' : 'none');
      }
    } catch {
      /* ignore storage errors */
    }
  }

  // ---------- View & Alert Helpers ----------
  const VIEWS = ['view-setup', 'view-gate', 'view-loading', 'view-resources'];
  function showView(id) {
    VIEWS.forEach((v) => {
      const el = $(v);
      if (el) el.hidden = v !== id;
    });
  }

  function showBanner(msg, tone = 'danger') {
    const b = $('res-banner');
    const txt = $('res-banner-text');
    if (!b || !txt) return;
    if (!msg) {
      b.hidden = true;
      txt.textContent = '';
      return;
    }
    b.className = `res-banner ${tone}`;
    txt.textContent = msg;
    b.hidden = false;
  }

  $('res-banner-close')?.addEventListener('click', () => showBanner(''));

  function showToast(message, isDanger = false) {
    const container = $('res-toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `res-toast${isDanger ? ' danger' : ''}`;
    const icon = isDanger ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-circle-check';
    const iconColor = isDanger ? 'var(--accent-danger)' : 'var(--accent-secondary)';
    toast.innerHTML = `<i class="${icon}" style="color:${iconColor}"></i><span></span>`;
    toast.querySelector('span').textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, 4500);
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  async function api(path, opts = {}, timeoutMs = 120000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(path, { credentials: 'same-origin', signal: ctl.signal, ...opts });
    } catch (e) {
      throw new Error(
        e.name === 'AbortError'
          ? 'The server took too long to respond. Please try again.'
          : `Couldn't reach the server (${e.message}).`
      );
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const postJson = (path, body, timeoutMs) =>
    api(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs
    );

  // ---------- Application State ----------
  let userId = '';
  let chapters = [];
  let resourceTypes = [...DEFAULT_RESOURCE_TYPES];
  let activeSubjectTab = 'all';
  let pollTimer = null;
  let isGenerating = false;

  // Track which chapter accordions are expanded (chapterId -> boolean)
  const expandedChapters = new Set();

  // Track currently ticked (non-generated) resource options: Map<chapterId (number), Set<resourceType (string)>>
  const selectedByChapter = new Map();

  function getSelectedSet(chapterId) {
    const id = Number(chapterId);
    if (!selectedByChapter.has(id)) selectedByChapter.set(id, new Set());
    return selectedByChapter.get(id);
  }

  function isResourceGenerated(chapter, resourceType) {
    return Boolean(chapter?.generated_resources && chapter.generated_resources[resourceType]);
  }

  function getAvailableResourceTypesForChapter(chapter) {
    return resourceTypes
      .map((rt) => rt.id)
      .filter((typeId) => !EXCLUDED_TYPES.has(typeId) && !isResourceGenerated(chapter, typeId));
  }

  // Clean up any selection that is already generated
  function pruneSelections() {
    for (const ch of chapters) {
      const set = getSelectedSet(ch.id);
      for (const typeId of [...set]) {
        if (isResourceGenerated(ch, typeId) || EXCLUDED_TYPES.has(typeId)) {
          set.delete(typeId);
        }
      }
    }
  }

  // ---------- Boot & Initial Data Fetch ----------
  async function init() {
    backfillCookiesFromSetup();
    userId = getCookie('sa_telegram_id');

    if (!/^\d+$/.test(userId)) {
      $('setup-missing-text').textContent =
        'Study resources need your paired Telegram ID and NotebookLM account. Pair them on the Setup page and press Save Configuration.';
      showView('view-setup');
      return;
    }

    await loadChapters();
  }

  async function loadChapters({ silent = false } = {}) {
    if (!silent) showView('view-loading');
    try {
      const data = await api(`/api/resources/chapters?telegramUserId=${encodeURIComponent(userId)}`);
      if (Array.isArray(data.resource_types) && data.resource_types.length) {
        // Strictly filter out Infographics and Report even if returned by a custom server
        resourceTypes = data.resource_types.filter(
          (t) =>
            !EXCLUDED_TYPES.has(String(t.id || '').toLowerCase()) &&
            !EXCLUDED_TYPES.has(String(t.label || '').toLowerCase())
        );
      }

      // Update NotebookLM session badge
      const sessionChip = $('nlm-session-chip');
      const sessionText = $('nlm-session-text');
      if (sessionChip && sessionText) {
        if (data.has_notebooklm_session || data.google_email) {
          sessionChip.className = 'chip ok';
          sessionText.textContent = data.google_email
            ? `NotebookLM (${data.google_email})`
            : 'NotebookLM Connected';
        } else {
          sessionChip.className = 'chip ok';
          sessionText.textContent = 'NotebookLM Studio Ready';
        }
      }

      if (!data.has_syllabus) {
        showGate();
        return false;
      }

      stopPolling();
      chapters = data.chapters || [];
      // Expand the first chapter automatically on initial load so the user sees the resource checkboxes immediately
      if (expandedChapters.size === 0 && chapters.length > 0) {
        expandedChapters.add(Number(chapters[0].id));
      }
      pruneSelections();
      renderAll();
      showView('view-resources');
      return true;
    } catch (e) {
      if (silent) return false;
      showView('view-gate');
      showBanner(`Couldn't reach the server: ${e.message}`);
      startPolling();
      return false;
    }
  }

  // ---------- Syllabus Gate & Upload From Computer ----------
  function showGate() {
    showView('view-gate');
    startPolling();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      loadChapters({ silent: true });
    }, POLL_MS);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  $('refresh-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const found = await loadChapters({ silent: true });
    btn.disabled = false;
    if (!found) {
      showBanner('No syllabus found yet. Send it to the Telegram bot or upload it below.', 'warn');
    } else {
      showBanner('');
    }
  });

  const sylStatus = (msg, isErr = false) => {
    const el = $('syl-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', isErr);
    el.hidden = !msg;
  };

  const toBase64 = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Could not read that file'));
      r.readAsDataURL(file);
    });

  async function sendSyllabus(payload, buttons) {
    buttons.forEach((b) => {
      if (b) b.disabled = true;
    });
    sylStatus('Reading your syllabus… this can take up to a minute.');
    try {
      await postJson('/api/syllabus/upload', { telegramUserId: userId, ...payload }, 150000);
      sylStatus('Done! Loading your chapters…');
      await loadChapters({ silent: true });
    } catch (e) {
      sylStatus(e.message, true);
    } finally {
      buttons.forEach((b) => {
        if (b) b.disabled = false;
      });
    }
  }

  $('syl-pick-btn')?.addEventListener('click', () => $('syl-file')?.click());
  $('syl-file')?.addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const nameEl = $('syl-file-name');
    if (nameEl) {
      nameEl.textContent = file.name;
      nameEl.hidden = false;
    }
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      return sylStatus('Please choose a PDF file.', true);
    }
    if (file.size > MAX_PDF_BYTES) {
      return sylStatus('That PDF is over 20 MB, which is too big.', true);
    }
    try {
      await sendSyllabus({ kind: 'pdf', dataBase64: await toBase64(file) }, [
        $('syl-pick-btn'),
        $('syl-text-send'),
      ]);
    } catch (err) {
      sylStatus(err.message, true);
    }
  });

  $('syl-text-toggle')?.addEventListener('click', () => {
    const panel = $('syl-text-panel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) $('syl-text')?.focus();
  });

  $('syl-text-send')?.addEventListener('click', () => {
    const text = ($('syl-text')?.value || '').trim();
    if (text.length < 10) return sylStatus('Paste your syllabus text first.', true);
    sendSyllabus({ kind: 'text', text }, [$('syl-pick-btn'), $('syl-text-send')]);
  });

  $('refresh-resources-btn')?.addEventListener('click', () => {
    loadChapters({ silent: true });
  });

  // Expand All / Collapse All button
  $('expand-all-btn')?.addEventListener('click', () => {
    const visibleChapters = getVisibleChapters();
    const allExpanded = visibleChapters.every((c) => expandedChapters.has(Number(c.id)));
    if (allExpanded) {
      visibleChapters.forEach((c) => expandedChapters.delete(Number(c.id)));
    } else {
      visibleChapters.forEach((c) => expandedChapters.add(Number(c.id)));
    }
    renderAll();
  });

  // ---------- Grouping & Filtering ----------
  function groupBySubject() {
    const map = new Map();
    for (const c of chapters) {
      const key = `${c.subject}||${c.exam || ''}`;
      if (!map.has(key)) {
        map.set(key, { key, subject: c.subject, exam: c.exam || '', chapters: [] });
      }
      map.get(key).chapters.push(c);
    }
    return [...map.values()];
  }

  function getVisibleChapters() {
    if (activeSubjectTab === 'all') return chapters;
    return chapters.filter((c) => c.subject === activeSubjectTab);
  }

  // ---------- Two-Way Checkbox Synchronization Logic ----------
  // 1. Toggling a single resource option inside a chapter updates:
  //    - That chapter's "Select All" checkbox (checked if all available in chapter are checked; unchecked if any is unticked)
  //    - The global "Select All Chapters" checkbox (checked if all available across ALL chapters are checked; unchecked if any is unticked)
  // 2. Toggling a chapter's "Select All" checkbox:
  //    - Checks/unchecks all available (non-generated) resources in that chapter
  //    - Updates the global "Select All Chapters" checkbox
  // 3. Toggling the global "Select All Chapters" checkbox:
  //    - Checks/unchecks all available (non-generated) resources across every chapter
  //    - Updates every chapter's "Select All" checkbox

  function syncAllCheckboxUI() {
    let totalGeneratedCount = 0;
    let totalAvailableCount = 0;
    let totalSelectedCount = 0;
    let chaptersWithSelection = 0;

    for (const ch of chapters) {
      const chId = Number(ch.id);
      const genMap = ch.generated_resources || {};
      const genCount = resourceTypes.filter((rt) => Boolean(genMap[rt.id])).length;
      const availIds = getAvailableResourceTypesForChapter(ch);
      const selectedSet = getSelectedSet(chId);

      // Ensure only available types remain in selectedSet
      for (const t of [...selectedSet]) {
        if (!availIds.includes(t)) selectedSet.delete(t);
      }

      const selCount = selectedSet.size;
      if (selCount > 0) chaptersWithSelection++;

      totalGeneratedCount += genCount;
      totalAvailableCount += availIds.length;
      totalSelectedCount += selCount;

      // Update chapter-level DOM elements if rendered
      const chItem = document.querySelector(`.res-chapter-item[data-chapter-id="${chId}"]`);
      if (chItem) {
        const chSelectAll = chItem.querySelector('.ch-select-all-cb');
        if (chSelectAll) {
          if (availIds.length === 0) {
            // Every resource in this chapter has already been generated
            chSelectAll.checked = true;
            chSelectAll.indeterminate = false;
            chSelectAll.disabled = true;
          } else {
            chSelectAll.disabled = isGenerating;
            const allChChecked = selCount === availIds.length;
            const someChChecked = selCount > 0 && selCount < availIds.length;
            chSelectAll.checked = allChChecked;
            chSelectAll.indeterminate = someChChecked;
          }
        }

        // Update individual resource checkboxes in this chapter
        chItem.querySelectorAll('.res-opt-cb').forEach((cb) => {
          const rType = cb.dataset.resourceType;
          const generated = isResourceGenerated(ch, rType);
          const card = cb.closest('.res-option-card');
          if (generated) {
            cb.checked = true;
            cb.disabled = true;
            card?.classList.remove('is-selected');
            card?.classList.add('is-generated');
          } else {
            const isChecked = selectedSet.has(rType);
            cb.checked = isChecked;
            cb.disabled = isGenerating;
            card?.classList.toggle('is-selected', isChecked);
          }
        });

        // Update chapter header pill for selected count
        const selPill = chItem.querySelector('[data-role="ch-selected-pill"]');
        if (selPill) {
          selPill.hidden = selCount === 0;
          selPill.textContent = `${selCount} selected`;
        }
      }
    }

    // Update Master "Select All Chapters" checkbox
    const masterCb = $('select-all-chapters');
    const masterSub = $('master-select-subtext');
    if (masterCb) {
      if (totalAvailableCount === 0 && chapters.length > 0) {
        masterCb.checked = true;
        masterCb.indeterminate = false;
        masterCb.disabled = true;
        if (masterSub) masterSub.textContent = 'All resources across every chapter have been generated!';
      } else {
        masterCb.disabled = isGenerating || chapters.length === 0;
        const allGlobalChecked = totalAvailableCount > 0 && totalSelectedCount === totalAvailableCount;
        const someGlobalChecked = totalSelectedCount > 0 && totalSelectedCount < totalAvailableCount;
        masterCb.checked = allGlobalChecked;
        masterCb.indeterminate = someGlobalChecked;
        if (masterSub) {
          masterSub.textContent = `${totalAvailableCount} available resource option${totalAvailableCount === 1 ? '' : 's'} across ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`;
        }
      }
    }

    // Update stats pills
    const genStat = $('overall-generated-stat');
    const selStat = $('overall-selected-stat');
    const totalPossible = chapters.length * resourceTypes.length;
    if (genStat) genStat.textContent = `${totalGeneratedCount} / ${totalPossible} Generated`;
    if (selStat) selStat.textContent = `${totalSelectedCount} Selected`;

    // Update fixed bottom Generate bar
    const countBadge = $('generate-count-badge');
    const summaryTitle = $('generate-summary-title');
    const summarySub = $('generate-summary-sub');
    const genBtn = $('generate-btn');
    const genBtnLabel = $('generate-btn-label');

    if (countBadge) countBadge.textContent = String(totalSelectedCount);
    if (summaryTitle) {
      if (isGenerating) {
        summaryTitle.textContent = 'Generating resources with NotebookLM…';
      } else if (totalSelectedCount === 0) {
        summaryTitle.textContent = 'No resources selected';
      } else {
        summaryTitle.textContent = `${totalSelectedCount} resource${totalSelectedCount === 1 ? '' : 's'} selected across ${chaptersWithSelection} chapter${chaptersWithSelection === 1 ? '' : 's'}`;
      }
    }
    if (summarySub && !isGenerating) {
      summarySub.textContent =
        totalSelectedCount > 0
          ? 'Ready to generate using your linked NotebookLM session. Generated items cannot be regenerated.'
          : 'Expand any chapter and tick the resource types you want to generate.';
    }
    if (genBtn) {
      genBtn.disabled = isGenerating || totalSelectedCount === 0;
    }
    if (genBtnLabel && !isGenerating) {
      genBtnLabel.textContent =
        totalSelectedCount > 0 ? `Generate (${totalSelectedCount})` : 'Generate';
    }
  }

  // Master "Select All Chapters" event listener
  $('select-all-chapters')?.addEventListener('change', (e) => {
    const shouldSelect = e.currentTarget.checked;
    for (const ch of chapters) {
      const availIds = getAvailableResourceTypesForChapter(ch);
      const set = getSelectedSet(ch.id);
      set.clear();
      if (shouldSelect) {
        availIds.forEach((t) => set.add(t));
      }
    }
    syncAllCheckboxUI();
  });

  // ---------- Rendering Chapters & Accordions ----------
  function renderAll() {
    const sections = groupBySubject();
    const subjects = [...new Set(sections.map((s) => s.subject))];
    if (activeSubjectTab !== 'all' && !subjects.includes(activeSubjectTab)) {
      activeSubjectTab = 'all';
    }

    // 1. Render Subject Filter Tabs
    const tabsEl = $('subject-tabs');
    if (tabsEl) {
      tabsEl.innerHTML = '';
      for (const name of ['all', ...subjects]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'res-tab';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(name === activeSubjectTab));
        b.textContent = name === 'all' ? 'All Subjects' : name;
        b.addEventListener('click', () => {
          activeSubjectTab = name;
          renderAll();
        });
        tabsEl.appendChild(b);
      }
    }

    // Update Expand/Collapse All button label
    const expandBtn = $('expand-all-btn');
    if (expandBtn) {
      const visible = getVisibleChapters();
      const allOpen = visible.length > 0 && visible.every((c) => expandedChapters.has(Number(c.id)));
      expandBtn.innerHTML = allOpen
        ? '<i class="fa-solid fa-angles-up" aria-hidden="true"></i> <span>Collapse All</span>'
        : '<i class="fa-solid fa-angles-down" aria-hidden="true"></i> <span>Expand All</span>';
    }

    // 2. Render Subject Sections & Chapter Accordions
    const root = $('chapters-accordion-root');
    if (!root) return;
    root.innerHTML = '';

    for (const sec of sections) {
      if (activeSubjectTab !== 'all' && sec.subject !== activeSubjectTab) continue;

      const secTotalPossible = sec.chapters.length * resourceTypes.length;
      const secGenerated = sec.chapters.reduce((acc, c) => {
        const g = c.generated_resources || {};
        return acc + resourceTypes.filter((rt) => Boolean(g[rt.id])).length;
      }, 0);

      const secEl = document.createElement('section');
      secEl.className = 'res-section';
      secEl.innerHTML = `
        <div class="res-section-head">
          <h2>${esc(sec.subject)}</h2>
          ${sec.exam ? `<span class="res-exam">${esc(sec.exam)}</span>` : ''}
          <span class="res-section-progress">${secGenerated} / ${secTotalPossible} resources generated</span>
        </div>
        <div class="res-accordion-list"></div>
      `;

      const listEl = secEl.querySelector('.res-accordion-list');
      for (const ch of sec.chapters) {
        listEl.appendChild(buildChapterAccordionItem(ch));
      }
      root.appendChild(secEl);
    }

    syncAllCheckboxUI();
  }

  function buildChapterAccordionItem(ch) {
    const chId = Number(ch.id);
    const isOpen = expandedChapters.has(chId);
    const genMap = ch.generated_resources || {};
    const genCount = resourceTypes.filter((rt) => Boolean(genMap[rt.id])).length;
    const totalTypes = resourceTypes.length;
    const allGenerated = genCount === totalTypes && totalTypes > 0;
    const selectedSet = getSelectedSet(chId);

    const item = document.createElement('article');
    item.className = `res-chapter-item${isOpen ? ' is-open' : ''}${allGenerated ? ' all-generated' : ''}`;
    item.dataset.chapterId = String(chId);

    const panelId = `ch-panel-${chId}`;
    const chNumberLabel = ch.number != null ? `CH ${String(ch.number).padStart(2, '0')}` : 'CH —';

    item.innerHTML = `
      <div class="res-accordion-header">
        <button type="button" class="res-accordion-trigger" aria-expanded="${isOpen}" aria-controls="${panelId}">
          <div class="res-ch-meta-left">
            <span class="res-ch-num">${esc(chNumberLabel)}</span>
            <span class="res-ch-title">${esc(ch.title)}</span>
            <span class="chip ${ch.matched ? 'ok' : 'wait'}">${ch.matched ? 'NCERT Matched' : 'Topic Scope'}</span>
          </div>
          <div class="res-ch-meta-right">
            <span class="res-ch-selected-pill" data-role="ch-selected-pill" ${selectedSet.size ? '' : 'hidden'}>${selectedSet.size} selected</span>
            <span class="res-ch-count ${allGenerated ? 'done' : ''}">
              ${allGenerated ? '<i class="fa-solid fa-circle-check"></i> All Generated' : `${genCount} / ${totalTypes} Generated`}
            </span>
            <span class="res-chevron" aria-hidden="true"><i class="fa-solid fa-chevron-down"></i></span>
          </div>
        </button>
      </div>
      <div class="res-accordion-panel" id="${panelId}" ${isOpen ? '' : 'hidden'}>
        <div class="res-chapter-toolbar">
          <label class="res-checkbox-label res-ch-select-label ${allGenerated ? 'is-disabled' : ''}">
            <input type="checkbox" class="res-checkbox ch-select-all-cb" data-chapter-id="${chId}" ${allGenerated ? 'checked disabled' : ''}>
            <span class="res-checkbox-box" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
            <span>
              <strong>Select All</strong>
              <small>${allGenerated ? '(All resources in this chapter are already generated)' : 'Select all available resources for this chapter'}</small>
            </span>
          </label>
          ${
            ch.pdf_url
              ? `<a href="${esc(ch.pdf_url)}" target="_blank" rel="noopener noreferrer" class="res-ncert-link">
                   <i class="fa-solid fa-file-pdf" aria-hidden="true"></i> NCERT Chapter PDF
                 </a>`
              : ''
          }
        </div>
        <div class="res-options-grid"></div>
      </div>
    `;

    // Accordion expand/collapse toggle
    const triggerBtn = item.querySelector('.res-accordion-trigger');
    const panelEl = item.querySelector('.res-accordion-panel');
    triggerBtn.addEventListener('click', () => {
      const nowOpen = !expandedChapters.has(chId);
      if (nowOpen) expandedChapters.add(chId);
      else expandedChapters.delete(chId);
      item.classList.toggle('is-open', nowOpen);
      triggerBtn.setAttribute('aria-expanded', String(nowOpen));
      panelEl.hidden = !nowOpen;

      // Update Expand/Collapse All button text
      const expandBtn = $('expand-all-btn');
      if (expandBtn) {
        const visible = getVisibleChapters();
        const allOpen = visible.length > 0 && visible.every((c) => expandedChapters.has(Number(c.id)));
        expandBtn.innerHTML = allOpen
          ? '<i class="fa-solid fa-angles-up" aria-hidden="true"></i> <span>Collapse All</span>'
          : '<i class="fa-solid fa-angles-down" aria-hidden="true"></i> <span>Expand All</span>';
      }
    });

    // Chapter-level "Select All" checkbox event listener
    const chSelectAllCb = item.querySelector('.ch-select-all-cb');
    chSelectAllCb.addEventListener('change', (e) => {
      const checked = e.currentTarget.checked;
      const availIds = getAvailableResourceTypesForChapter(ch);
      const set = getSelectedSet(chId);
      set.clear();
      if (checked) {
        availIds.forEach((t) => set.add(t));
      }
      syncAllCheckboxUI();
    });

    // Populate resource option cards inside the chapter
    const gridEl = item.querySelector('.res-options-grid');
    for (const rt of resourceTypes) {
      if (EXCLUDED_TYPES.has(rt.id)) continue;
      gridEl.appendChild(buildResourceOptionCard(ch, rt));
    }

    return item;
  }

  function buildResourceOptionCard(ch, rt) {
    const chId = Number(ch.id);
    const genRecord = ch.generated_resources?.[rt.id] || null;
    const isGenerated = Boolean(genRecord);
    const selectedSet = getSelectedSet(chId);
    const isSelected = !isGenerated && selectedSet.has(rt.id);

    const card = document.createElement('div');
    card.className = `res-option-card${isGenerated ? ' is-generated' : isSelected ? ' is-selected' : ''}`;
    card.dataset.chapterId = String(chId);
    card.dataset.resourceType = rt.id;

    card.innerHTML = `
      <div class="res-option-top">
        <div class="res-option-title-row">
          <span class="res-option-icon"><i class="${esc(rt.icon || 'fa-solid fa-sparkles')}" aria-hidden="true"></i></span>
          <span>${esc(rt.label)}</span>
        </div>
        <label class="res-checkbox-label ${isGenerated ? 'is-disabled' : ''}" title="${isGenerated ? 'Already generated — cannot be regenerated' : `Select ${rt.label}`}">
          <input
            type="checkbox"
            class="res-checkbox res-opt-cb ${isGenerated ? 'is-generated' : ''}"
            data-chapter-id="${chId}"
            data-resource-type="${esc(rt.id)}"
            aria-label="${esc(rt.label)} for ${esc(ch.title)}"
            ${isGenerated ? 'checked disabled' : isSelected ? 'checked' : ''}
          >
          <span class="res-checkbox-box" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
        </label>
      </div>
      <p class="res-option-desc">${esc(rt.description)}</p>
      <div class="res-option-foot">
        ${
          isGenerated
            ? `<span class="res-generated-badge"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Generated</span>
               <div class="res-option-actions">
                 <button type="button" class="res-action-btn" data-action="view">
                   <i class="fa-regular fa-eye" aria-hidden="true"></i> View
                 </button>
                 <button type="button" class="res-action-btn" data-action="download" title="Download Markdown">
                   <i class="fa-solid fa-download" aria-hidden="true"></i>
                 </button>
               </div>`
            : `<span style="font-size:0.75rem;color:var(--text-muted)">Not generated yet</span>
               <span></span>`
        }
      </div>
    `;

    const cb = card.querySelector('.res-opt-cb');
    if (!isGenerated) {
      // Clicking anywhere on an ungenerated card (except links/buttons) toggles its checkbox
      card.addEventListener('click', (e) => {
        if (isGenerating) return;
        if (e.target.closest('label') || e.target.closest('button') || e.target.closest('a')) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });

      cb.addEventListener('change', () => {
        const set = getSelectedSet(chId);
        if (cb.checked) set.add(rt.id);
        else set.delete(rt.id);
        syncAllCheckboxUI();
      });
    } else {
      card.querySelector('[data-action="view"]')?.addEventListener('click', () => {
        openResourceModal(ch, rt, genRecord);
      });
      card.querySelector('[data-action="download"]')?.addEventListener('click', () => {
        downloadResourceMarkdown(ch, rt, genRecord);
      });
    }

    return card;
  }

  // ---------- Generation Flow & Quota Rate-Limit Handling ----------
  $('generate-btn')?.addEventListener('click', handleGenerateSelected);

  async function handleGenerateSelected() {
    if (isGenerating) return;

    // Collect all currently ticked (non-generated) resources across chapters
    const selections = [];
    for (const ch of chapters) {
      const set = getSelectedSet(ch.id);
      const validTypes = [...set].filter(
        (t) => !isResourceGenerated(ch, t) && !EXCLUDED_TYPES.has(t)
      );
      if (validTypes.length > 0) {
        selections.push({
          chapterId: Number(ch.id),
          resourceTypes: validTypes,
        });
      }
    }

    if (selections.length === 0) return;

    isGenerating = true;
    showBanner('');
    const genBtn = $('generate-btn');
    const genBtnLabel = $('generate-btn-label');
    if (genBtn) genBtn.disabled = true;
    if (genBtnLabel) genBtnLabel.textContent = 'Generating…';
    syncAllCheckboxUI();

    const backendUrl = savedSetupConfig?.notebooklm?.backendUrl || undefined;
    const geminiKey = getCookie('sa_gemini_key') || undefined;

    try {
      const res = await fetch('/api/resources/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          telegramUserId: userId,
          selections,
          geminiKey,
          notebooklmBackendUrl: backendUrl,
        }),
      });

      const data = await res.json().catch(() => ({}));

      // 1. Always persist & mark any resources that finished generating before an error or quota limit
      const newlyGenerated = Array.isArray(data.generated) ? data.generated : [];
      if (newlyGenerated.length > 0) {
        applyNewlyGeneratedResources(newlyGenerated);
      }

      // Also apply any skipped items that were already generated in DB
      if (Array.isArray(data.skipped) && data.skipped.length > 0) {
        applyNewlyGeneratedResources(data.skipped);
      }

      // 2. Check for Quota / Rate-Limit Error
      if (res.status === 429 || data.quota_exceeded) {
        const retryTime = data.retry_after || '15 minutes';
        const quotaMsg =
          data.error && data.error.startsWith('Limit Reached! try again after ')
            ? data.error
            : `Limit Reached! try again after ${retryTime}`;
        showBanner(quotaMsg, 'danger');
        showToast(quotaMsg, true);
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || `Generation failed (HTTP ${res.status})`);
      }

      if (newlyGenerated.length > 0) {
        const msg = `Generated ${newlyGenerated.length} NotebookLM resource${newlyGenerated.length === 1 ? '' : 's'}!`;
        showBanner(msg, 'ok');
        showToast(msg, false);
      }
    } catch (err) {
      const isQuotaMsg = /limit reached!\s*try again after/i.test(err.message || '');
      showBanner(err.message || 'Could not generate resources. Please try again.', 'danger');
      showToast(err.message || 'Generation error', true);
      if (!isQuotaMsg) {
        // Reload chapter state from DB to ensure any completed items are reflected
        await loadChapters({ silent: true });
      }
    } finally {
      isGenerating = false;
      renderAll();
    }
  }

  function applyNewlyGeneratedResources(items) {
    for (const item of items) {
      const ch = chapters.find(
        (c) =>
          Number(c.id) === Number(item.chapter_id) ||
          (c.subject === item.subject &&
            (c.exam || '') === (item.exam || '') &&
            c.title === item.chapter_title)
      );
      if (!ch) continue;
      if (!ch.generated_resources) ch.generated_resources = {};
      ch.generated_resources[item.resource_type] = {
        id: item.id,
        resource_type: item.resource_type,
        title: item.title,
        summary: item.summary,
        content: item.content,
        resource_url: item.resource_url || null,
        created_at: item.created_at || new Date().toISOString(),
      };
      // Remove from active selections so it's locked as Generated
      getSelectedSet(ch.id).delete(item.resource_type);
      // Keep the chapter expanded so the user can immediately see and view their generated resource
      expandedChapters.add(Number(ch.id));
    }
  }

  // ---------- Interactive Resource Viewer Modal & Audio Player ----------
  let activeModalData = null;

  function stopAudioPlayback() {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    const playBtn = $('audio-play-btn');
    const stopBtn = $('audio-stop-btn');
    const statusTxt = $('audio-status-text');
    if (playBtn) playBtn.disabled = false;
    if (stopBtn) stopBtn.hidden = true;
    if (statusTxt) statusTxt.textContent = 'Two-host AI dialogue ready';
  }

  function openResourceModal(ch, rt, genRecord) {
    stopAudioPlayback();
    activeModalData = { ch, rt, genRecord };

    const modal = $('resource-modal');
    const badge = $('modal-resource-badge');
    const title = $('modal-resource-title');
    const meta = $('modal-resource-meta');
    const body = $('modal-resource-body');
    const audioBar = $('modal-audio-bar');

    if (!modal || !body) return;

    const content = genRecord.content || {};
    badge.textContent = rt.label;
    title.textContent = genRecord.title || `${rt.label}: ${ch.title}`;
    meta.textContent = `${ch.subject}${ch.exam ? ` (${ch.exam})` : ''} · ${
      ch.number != null ? `Chapter ${ch.number}` : ch.title
    }`;

    if (audioBar) {
      audioBar.hidden = rt.id !== 'audio_overview';
    }

    const sections = Array.isArray(content.sections) ? content.sections : [];
    const items = Array.isArray(content.items) ? content.items : [];
    const summaryText = genRecord.summary || content.summary || '';

    let html = '';
    if (summaryText) {
      html += `<div class="res-modal-summary">${esc(summaryText)}</div>`;
    }

    if (items.length > 0) {
      html += `<div class="res-items-grid">`;
      for (const it of items) {
        html += `
          <div class="res-item-card">
            <div class="res-item-card-top">
              <span class="res-item-tag">${esc(it.label || rt.label)}</span>
              <strong>${esc(it.prompt || '')}</strong>
            </div>
            <p>${esc(it.detail || '')}</p>
          </div>
        `;
      }
      html += `</div>`;
    }

    for (const sec of sections) {
      const bullets = Array.isArray(sec.bullets) ? sec.bullets : [];
      html += `
        <div class="res-modal-section">
          <h3>${esc(sec.heading || '')}</h3>
          <p>${esc(sec.body || '')}</p>
          ${
            bullets.length
              ? `<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
              : ''
          }
        </div>
      `;
    }

    if (!html && content.markdown) {
      html = `<div class="res-modal-section"><p style="white-space:pre-line">${esc(content.markdown)}</p></div>`;
    }

    body.innerHTML = html || '<p>Resource generated and saved.</p>';
    modal.hidden = false;
  }

  function closeResourceModal() {
    stopAudioPlayback();
    const modal = $('resource-modal');
    if (modal) modal.hidden = true;
    activeModalData = null;
  }

  $('modal-close-btn')?.addEventListener('click', closeResourceModal);
  $('resource-modal')?.addEventListener('click', (e) => {
    if (e.target === $('resource-modal')) closeResourceModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('resource-modal')?.hidden) closeResourceModal();
  });

  $('modal-download-btn')?.addEventListener('click', () => {
    if (!activeModalData) return;
    downloadResourceMarkdown(activeModalData.ch, activeModalData.rt, activeModalData.genRecord);
  });

  // Audio Overview TTS Player
  $('audio-play-btn')?.addEventListener('click', () => {
    if (!activeModalData || !('speechSynthesis' in window)) {
      showToast('Browser speech synthesis is not available on this device.', true);
      return;
    }
    window.speechSynthesis.cancel();
    const items = activeModalData.genRecord?.content?.items || [];
    if (!items.length) return;

    const playBtn = $('audio-play-btn');
    const stopBtn = $('audio-stop-btn');
    const statusTxt = $('audio-status-text');
    if (playBtn) playBtn.disabled = true;
    if (stopBtn) stopBtn.hidden = false;

    let idx = 0;
    const speakNext = () => {
      if (idx >= items.length || !activeModalData) {
        stopAudioPlayback();
        return;
      }
      const turn = items[idx++];
      if (statusTxt) statusTxt.textContent = `Speaking: ${turn.label} — ${turn.prompt}`;
      const utter = new SpeechSynthesisUtterance(`${turn.detail}`);
      utter.rate = 1.02;
      utter.pitch = String(turn.label).includes('Host B') ? 0.92 : 1.08;
      utter.onend = speakNext;
      utter.onerror = stopAudioPlayback;
      window.speechSynthesis.speak(utter);
    };
    speakNext();
  });

  $('audio-stop-btn')?.addEventListener('click', stopAudioPlayback);

  function buildMarkdownForDownload(ch, rt, genRecord) {
    const c = genRecord?.content || {};
    if (c.markdown && c.markdown.trim().length > 40) return c.markdown;

    const lines = [
      `# ${genRecord.title || `${rt.label}: ${ch.title}`}`,
      `**Subject:** ${ch.subject}${ch.exam ? ` (${ch.exam})` : ''}`,
      `**Resource Type:** ${rt.label}`,
      '',
    ];
    if (genRecord.summary || c.summary) {
      lines.push(`> ${genRecord.summary || c.summary}`, '');
    }
    if (Array.isArray(c.items) && c.items.length) {
      lines.push(`## ${rt.label} Items`, '');
      for (const it of c.items) {
        lines.push(`### [${it.label || 'Item'}] ${it.prompt || ''}`, `${it.detail || ''}`, '');
      }
    }
    if (Array.isArray(c.sections) && c.sections.length) {
      for (const s of c.sections) {
        lines.push(`## ${s.heading || 'Section'}`, `${s.body || ''}`, '');
        if (Array.isArray(s.bullets)) {
          for (const b of s.bullets) lines.push(`- ${b}`);
          lines.push('');
        }
      }
    }
    return lines.join('\n');
  }

  function downloadResourceMarkdown(ch, rt, genRecord) {
    const md = buildMarkdownForDownload(ch, rt, genRecord);
    const slug = `${ch.subject}-${ch.title}-${rt.id}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug || 'resource'}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  init();
})();