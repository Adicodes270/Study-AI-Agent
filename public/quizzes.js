// ==========================================================================
// quizzes.js — syllabus-linked quizzes
// Flow: cookies -> (setup gate) -> chapters from the API -> (syllabus gate with polling)
//       -> subject sections -> quiz runner -> submit -> back to the chapter the student started from
// ==========================================================================
(() => {
  'use strict';

  const BOT_URL = 'https://web.telegram.org/k/#@SylllabusBot';
  const POLL_MS = 5000;
  const REDIRECT_SECONDS = 5;
  const RETURN_KEY = 'sa_quiz_return';
  const $ = (id) => document.getElementById(id);

  // ---------- cookies ----------
  const getCookie = (name) => {
    const m = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    if (!m) return '';
    try { return decodeURIComponent(m.slice(name.length + 1)); } catch { return ''; }
  };
  const setCookie = (name, value) => {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=31536000; path=/; SameSite=Lax${secure}`;
  };

  // Students who saved their setup before the cookies existed: rebuild them from the saved setup state.
  function backfillCookiesFromSetup() {
    try {
      const st = JSON.parse(localStorage.getItem('study_agent_config') || 'null');
      if (!st) return;
      const id = String(st.telegram?.userId || st.telegram?.chatId || '');
      const key = (st.geminiKeys || []).map((k) => String(k.key || '').trim()).find((k) => k.length >= 20 && !/\s/.test(k));
      if (!getCookie('sa_telegram_id') && /^\d+$/.test(id)) setCookie('sa_telegram_id', id);
      if (!getCookie('sa_gemini_key') && key) setCookie('sa_gemini_key', key);
      if (!getCookie('sa_notebooklm_auth')) {
        setCookie('sa_notebooklm_auth', st.notebooklm?.status === 'connected' ? 'connected' : 'none');
      }
    } catch { /* no saved setup, or storage blocked */ }
  }

  // ---------- small helpers ----------
  const VIEWS = ['view-setup', 'view-gate', 'view-loading', 'view-chapters', 'view-quiz', 'view-done'];
  function show(id) {
    VIEWS.forEach((v) => { $(v).hidden = v !== id; });
    if (id !== 'view-chapters') hidePop();
  }
  function banner(msg) {
    const b = $('qz-banner');
    b.textContent = msg || '';
    b.hidden = !msg;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tone = (pct) => (pct >= 80 ? 'good' : pct >= 50 ? 'mid' : 'bad');
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  async function api(path, opts, timeoutMs = 60000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(path, { credentials: 'same-origin', signal: ctl.signal, ...opts });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'The server took too long to answer. Please try again.' : `Couldn't reach the server (${e.message}). Check your connection and try again.`);
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `Request failed (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return data;
  }
  const postJson = (path, body, timeoutMs) =>
    api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);

  // ---------- state ----------
  let userId = '';
  let chapters = [];
  let activeTab = 'all';
  let pollTimer = null;
  let redirectTimer = null;
  let quiz = null; // { quizId, chapter, questions, answers, index }

  // ---------- boot ----------
  async function init() {
    backfillCookiesFromSetup();
    userId = getCookie('sa_telegram_id');
    const key = getCookie('sa_gemini_key');

    // Step A: credentials
    if (!/^\d+$/.test(userId) || !key) {
      const missing = [!/^\d+$/.test(userId) && 'your Telegram ID', !key && 'your Gemini API key'].filter(Boolean).join(' and ');
      $('setup-missing-text').textContent = `Quizzes need ${missing}. Add ${missing.includes('and') ? 'them' : 'it'} on the setup page and press Save Configuration.`;
      show('view-setup');
      return;
    }
    await loadChapters();
  }

  // Step B: syllabus in the database?
  async function loadChapters({ silent = false } = {}) {
    if (!silent) show('view-loading');
    try {
      const data = await api(`/api/quizzes/chapters?telegramUserId=${encodeURIComponent(userId)}`);
      banner('');
      if (!data.has_syllabus) {
        showGate();
        return false;
      }
      stopPolling();
      chapters = data.chapters;
      renderChapters();
      show('view-chapters');
      return true;
    } catch (e) {
      if (silent) return false; // a failed background poll shouldn't clobber the page
      show('view-gate');
      banner(`Couldn't reach the server: ${e.message}`);
      startPolling();
      return false;
    }
  }

  // ---------- onboarding gate + polling ----------
  function showGate() {
    show('view-gate');
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
  $('refresh-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const found = await loadChapters({ silent: true });
    btn.disabled = false;
    if (!found) banner('No syllabus yet. Send it to the bot and wait for its “Done!” reply, then refresh.');
    else banner('');
  });
  // ---------- upload the syllabus from this computer (same result as sending it to the bot) ----------
  const MAX_PDF_BYTES = 20 * 1024 * 1024;
  const sylStatus = (msg, isErr = false) => {
    const el = $('syl-status');
    el.textContent = msg;
    el.classList.toggle('err', isErr);
    el.hidden = !msg;
  };
  const toBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read that file'));
    r.readAsDataURL(file);
  });
  async function sendSyllabus(payload, buttons) {
    buttons.forEach((b) => { b.disabled = true; });
    sylStatus('Reading your syllabus… this can take up to a minute.');
    try {
      await postJson('/api/syllabus/upload', { telegramUserId: userId, ...payload }, 150000);
      sylStatus('Done! Loading your chapters…');
      await loadChapters({ silent: true });
      renderChapters();
    } catch (e) {
      sylStatus(e.message, true);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }
  $('syl-pick-btn').addEventListener('click', () => $('syl-file').click());
  $('syl-file').addEventListener('change', async (e) => {
    const input = e.currentTarget;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const nameEl = $('syl-file-name');
    nameEl.textContent = file.name;
    nameEl.hidden = false;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return sylStatus('Please choose a PDF file.', true);
    if (file.size > MAX_PDF_BYTES) return sylStatus('That PDF is over 20 MB, which is too big.', true);
    try {
      await sendSyllabus({ kind: 'pdf', dataBase64: await toBase64(file) }, [$('syl-pick-btn'), $('syl-text-send')]);
    } catch (err) { sylStatus(err.message, true); }
  });
  $('syl-text-toggle').addEventListener('click', () => {
    const panel = $('syl-text-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) $('syl-text').focus();
  });
  $('syl-text-send').addEventListener('click', () => {
    const text = $('syl-text').value.trim();
    if (text.length < 10) return sylStatus('Paste your syllabus text first.', true);
    sendSyllabus({ kind: 'text', text }, [$('syl-pick-btn'), $('syl-text-send')]);
  });

  $('refresh-chapters-btn').addEventListener('click', () => loadChapters({ silent: true }).then(renderChapters));

  // ---------- subject sections ----------
  function groupSections() {
    const map = new Map();
    for (const c of chapters) {
      const key = `${c.subject}||${c.exam || ''}`;
      if (!map.has(key)) map.set(key, { key, subject: c.subject, exam: c.exam || '', chapters: [] });
      map.get(key).chapters.push(c);
    }
    return [...map.values()];
  }

  function renderChapters() {
    const sections = groupSections();
    const subjects = [...new Set(sections.map((s) => s.subject))];
    if (activeTab !== 'all' && !subjects.includes(activeTab)) activeTab = 'all';

    // tabs
    const tabs = $('subject-tabs');
    tabs.innerHTML = '';
    for (const name of ['all', ...subjects]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qz-tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(name === activeTab));
      b.textContent = name === 'all' ? 'All Subjects' : name;
      b.addEventListener('click', () => { activeTab = name; renderChapters(); });
      tabs.appendChild(b);
    }

    // sections
    const root = $('subject-sections');
    root.innerHTML = '';
    for (const sec of sections) {
      if (activeTab !== 'all' && sec.subject !== activeTab) continue;
      const attempted = sec.chapters.filter((c) => c.result).length;
      const mastered = sec.chapters.filter((c) => c.result && c.result.percentage >= 80).length;
      const el = document.createElement('section');
      el.className = 'qz-section';
      el.id = 'sec-' + slug(sec.key);
      el.dataset.subject = sec.subject;
      el.innerHTML = `
        <div class="qz-section-head">
          <h2>${esc(sec.subject)}</h2>
          ${sec.exam ? `<span class="qz-exam">${esc(sec.exam)}</span>` : ''}
          <div class="qz-mastery" title="Chapters scoring 80% or more">
            <span>${mastered} of ${sec.chapters.length} mastered${attempted ? ` · ${attempted} attempted` : ''}</span>
            <div class="qz-mastery-bar"><i style="width:${Math.round((mastered / sec.chapters.length) * 100)}%"></i></div>
          </div>
        </div>
        <div class="qz-grid"></div>`;
      const grid = el.querySelector('.qz-grid');
      for (const c of sec.chapters) grid.appendChild(chapterCard(c));
      root.appendChild(el);
    }
  }

  function chapterCard(c) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qz-chapter';
    btn.dataset.chapterId = c.id;
    const label = `${c.number != null ? `Chapter ${c.number}: ` : ''}${c.title}`;
    if (c.result) {
      // Already attempted: one attempt per chapter. aria-disabled (not disabled) so hover/focus still show the result.
      btn.classList.add('done');
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-label', `${label}, completed, score ${c.result.percentage} percent`);
    } else {
      btn.setAttribute('aria-label', label);
    }
    btn.innerHTML = `
      <div class="qz-ch-top">
        <span class="qz-ch-num">${c.number != null ? 'CH ' + String(c.number).padStart(2, '0') : 'CH —'}</span>
        <span class="chip ${c.matched ? 'ok' : 'wait'}">${c.matched ? 'NCERT' : 'By topic'}</span>
      </div>
      <div class="qz-ch-title">${esc(c.title)}</div>
      <div class="qz-ch-foot">
        ${c.result
          ? `<span class="qz-badge ${tone(c.result.percentage)}">${c.result.percentage}%</span><span>Completed · ${c.result.score}/${c.result.total}</span>`
          : `<span>Not attempted yet</span><span></span>`}
      </div>`;
    if (!c.result) btn.addEventListener('click', () => startQuiz(c));
    if (c.result) {
      btn.addEventListener('mouseenter', () => showPop(btn, c));
      btn.addEventListener('mouseleave', hidePop);
      btn.addEventListener('focus', () => showPop(btn, c));
      btn.addEventListener('blur', hidePop);
    }
    return btn;
  }

  // ---------- hover popover ----------
  const pop = $('result-pop');
  let popAnchor = null;
  function placePop() {
    if (!popAnchor) return;
    const a = popAnchor.getBoundingClientRect();
    if (a.bottom < 0 || a.top > innerHeight) { hidePop(); return; } // card scrolled out of view
    const p = pop.getBoundingClientRect();
    const gap = 10;
    let top = a.bottom + gap;
    if (top + p.height > innerHeight - 8) top = Math.max(8, a.top - p.height - gap);
    const left = Math.min(Math.max(8, a.left), innerWidth - p.width - 8);
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }
  function showPop(anchor, c) {
    const r = c.result;
    const t = tone(r.percentage);
    pop.innerHTML = `
      <div><span class="qz-pop-pct ${t}">${r.percentage}%</span><span class="qz-pop-score">${r.score}/${r.total} correct</span></div>
      <p class="qz-pop-msg">${esc(r.revision_message)}</p>
      ${r.weak_subtopics?.length ? `<div class="qz-pop-weak"><b>Weak subtopics</b>${r.weak_subtopics.map((w) => `<span>${esc(w)}</span>`).join('')}</div>` : ''}
      <div class="qz-pop-cta">Quiz completed. Each chapter can only be attempted once.</div>`;
    popAnchor = anchor;
    pop.hidden = false;
    placePop();
  }
  function hidePop() { pop.hidden = true; popAnchor = null; }
  // The popover follows its card while the page scrolls (e.g. the mouse is still, the page moves)
  addEventListener('scroll', () => { if (popAnchor) requestAnimationFrame(placePop); }, { passive: true });
  addEventListener('resize', placePop);

  // ---------- quiz runner ----------
  async function startQuiz(c) {
    hidePop();
    banner('');
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ chapterId: c.id, subject: c.subject, exam: c.exam || '' }));
    $('loading-text').textContent = `Writing a ${c.subject} quiz on “${c.title}”… this takes a few seconds.`;
    show('view-loading');
    try {
      const data = await postJson('/api/quizzes/generate', { telegramUserId: userId, chapterId: c.id });
      quiz = { quizId: data.quizId, chapter: data.chapter, questions: data.questions, answers: data.questions.map(() => null), index: 0 };
      $('quiz-title').textContent = `${data.chapter.subject} · ${data.chapter.number != null ? 'Ch ' + data.chapter.number + ': ' : ''}${data.chapter.title}`;
      $('quiz-meta').textContent = `${data.questions.length} questions`;
      show('view-quiz');
      scrollTo({ top: 0 });
      renderQuestion();
    } catch (e) {
      // 409 = already taken (e.g. in another tab): refresh so the card shows its result
      if (e.status === 409) await loadChapters({ silent: true }).catch(() => {});
      show('view-chapters');
      banner(e.message);
      scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function renderQuestion() {
    const { questions, index, answers } = quiz;
    const q = questions[index];
    const last = index === questions.length - 1;
    quizError('');
    $('quiz-qcount').textContent = `Question ${index + 1} of ${questions.length}`;
    $('quiz-progress-bar').style.width = `${(index / questions.length) * 100}%`;
    $('quiz-subtopic').textContent = q.subtopic;
    $('quiz-question').textContent = q.question;
    const box = $('quiz-options');
    box.innerHTML = '';
    q.options.forEach((text, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qz-opt';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(answers[index] === i));
      b.innerHTML = `<span class="qz-opt-key">${'ABCD'[i]}</span><span></span>`;
      b.lastChild.textContent = text;
      b.addEventListener('click', () => {
        answers[index] = i;
        box.querySelectorAll('.qz-opt').forEach((o, j) => o.setAttribute('aria-checked', String(j === i)));
        $('next-btn').disabled = false;
      });
      box.appendChild(b);
    });
    $('prev-btn').disabled = index === 0;
    const next = $('next-btn');
    next.disabled = answers[index] === null;
    next.innerHTML = last ? 'Finish <i class="fa-solid fa-flag-checkered" aria-hidden="true"></i>' : 'Next <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
    $('quiz-question').focus({ preventScroll: true });
  }

  $('prev-btn').addEventListener('click', () => {
    if (quiz.index > 0) { quiz.index--; renderQuestion(); }
  });
  $('next-btn').addEventListener('click', () => {
    if (quiz.index < quiz.questions.length - 1) { quiz.index++; renderQuestion(); }
    else submitQuiz();
  });
  $('quit-btn').addEventListener('click', () => {
    if (quiz && quiz.answers.some((a) => a !== null) && !confirm('Leave this quiz? Your answers will not be saved.')) return;
    quiz = null;
    backToChapters({ scroll: false });
  });
  // number / letter keys pick an option while the quiz is open
  addEventListener('keydown', (e) => {
    if ($('view-quiz').hidden || !quiz || e.ctrlKey || e.metaKey || e.altKey) return;
    const i = '1234'.indexOf(e.key) >= 0 ? '1234'.indexOf(e.key) : 'abcd'.indexOf(e.key.toLowerCase());
    if (i >= 0 && e.key.length === 1) $('quiz-options').children[i]?.click();
  });

  function quizError(msg) {
    const el = $('quiz-error');
    el.textContent = msg || '';
    el.hidden = !msg;
    if (msg) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  let submitting = false;
  async function submitQuiz() {
    if (submitting || !quiz) return;
    submitting = true;
    quizError('');
    const next = $('next-btn');
    next.disabled = true;
    next.textContent = 'Saving…';
    let result;
    try {
      result = await postJson('/api/quizzes/submit', { telegramUserId: userId, quizId: quiz.quizId, answers: quiz.answers }, 30000);
    } catch (e) {
      submitting = false;
      // Stay on the last question with the answers intact so Finish can simply be pressed again
      next.disabled = false;
      next.innerHTML = 'Try again <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>';
      if (e.status === 410 || e.status === 409) {
        quiz = null;
        await backToChapters({ scroll: false });
        banner(e.message);
        return;
      }
      quizError(`Couldn't save your result: ${e.message}`);
      return;
    }
    submitting = false;
    quiz = null;
    try {
      showDone(result);
    } catch (e) {
      // The result IS saved; if drawing the summary fails, don't leave the student stuck
      console.error(e);
      banner(`Saved: ${result.score}/${result.total} (${result.percentage}%).`);
      backToChapters({ scroll: true });
    }
  }

  // ---------- completion + auto return ----------
  function showDone(r) {
    const t = tone(r.percentage);
    $('done-ring').className = `qz-ring ${t}`;
    $('done-ring').style.setProperty('--p', r.percentage);
    $('done-pct').textContent = `${r.percentage}%`;
    $('done-title').textContent = r.percentage >= 80 ? 'Great work!' : r.percentage >= 50 ? 'Good effort' : 'Quiz complete';
    $('done-score').textContent = `${r.score} of ${r.total} correct · ${r.chapter.title}`;
    $('done-tier').textContent = r.revision_message;
    const weak = $('done-weak');
    weak.hidden = !r.weak_subtopics.length;
    weak.textContent = r.weak_subtopics.length ? `Focus on: ${r.weak_subtopics.join(', ')}` : '';

    const rv = $('done-review');
    rv.hidden = true;
    rv.innerHTML = r.review.map((q, i) => `
      <div class="qz-rv ${q.correct ? 'ok' : ''}">
        <h4>${i + 1}. ${esc(q.question)}</h4>
        <p><b>Your answer:</b> ${q.picked === null ? 'Skipped' : esc(q.options[q.picked])} ${q.correct ? '✓' : '✗'}</p>
        ${q.correct ? '' : `<p><b>Correct answer:</b> ${esc(q.options[q.correctIndex])}</p>`}
        <p>${esc(q.explanation)}</p>
      </div>`).join('');

    show('view-done');
    scrollTo({ top: 0 });
    let left = REDIRECT_SECONDS;
    const label = $('done-redirect');
    const tick = () => { label.textContent = `Taking you back to your chapters in ${left}s…`; };
    tick();
    clearInterval(redirectTimer);
    redirectTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(redirectTimer); backToChapters({ scroll: true }); } else tick();
    }, 1000);
  }
  function cancelRedirect() {
    clearInterval(redirectTimer);
    redirectTimer = null;
  }
  $('done-review-btn').addEventListener('click', () => {
    cancelRedirect();
    $('done-redirect').textContent = '';
    $('done-review').hidden = false;
    $('done-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('done-back-btn').addEventListener('click', () => { cancelRedirect(); backToChapters({ scroll: true }); });

  // Return to the subject section the student started from, with fresh results, and point at the card
  async function backToChapters({ scroll }) {
    cancelRedirect();
    let ret = null;
    try { ret = JSON.parse(sessionStorage.getItem(RETURN_KEY) || 'null'); } catch {}
    const ok = await loadChapters({ silent: true });
    if (!ok) { await loadChapters(); return; }
    if (ret && scroll) activeTab = 'all';
    renderChapters();
    show('view-chapters');
    if (!ret || !scroll) { scrollTo({ top: 0 }); return; }
    const card = document.querySelector(`.qz-chapter[data-chapter-id="${CSS.escape(String(ret.chapterId))}"]`);
    const section = card?.closest('.qz-section');
    if (!card) return;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    afterScroll(() => {
      card.classList.add('flash');
      const c = chapters.find((x) => String(x.id) === String(ret.chapterId));
      if (c?.result) {
        const a = card.getBoundingClientRect();
        if (a.top >= 0 && a.bottom <= innerHeight) {
          showPop(card, c);
          setTimeout(hidePop, 4500);
        }
      }
      sessionStorage.removeItem(RETURN_KEY);
    });
  }

  // Run cb once a smooth scroll has settled (scrollend where supported, otherwise a timer).
  // The popover hides on scroll, so the auto-shown one has to wait for the scroll to finish.
  function afterScroll(cb) {
    let done = false;
    const go = () => { if (done) return; done = true; removeEventListener('scrollend', go); cb(); };
    addEventListener('scrollend', go, { once: true });
    setTimeout(go, 1000);
  }

  init();
})();
