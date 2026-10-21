// ==========================================================================
// quizzes.js — syllabus-linked quizzes (Typed or Voice-Spoken Answers + Book-Grounded AI Grading)
// Flow: cookies -> (setup gate) -> chapters from the API -> (syllabus gate with polling)
//       -> subject sections (with New Quiz button before Refresh) -> typed/spoken quiz runner
//       -> AI thinks & checks book/research -> submit -> back to the chapter
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
    if (id !== 'view-quiz') stopVoiceInput();
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

  async function api(path, opts, timeoutMs = 90000) {
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
  let manualGateOpen = false; // true when user clicked "New Quiz" to upload another PDF / send via Telegram
  let quiz = null; // { quizId, chapter, questions, answers: string[], index }

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
  async function loadChapters({ silent = false, forceChaptersView = false } = {}) {
    if (!silent) show('view-loading');
    try {
      const data = await api(`/api/quizzes/chapters?telegramUserId=${encodeURIComponent(userId)}`);
      banner('');
      if (!data.has_syllabus) {
        manualGateOpen = false;
        showGate(false);
        return false;
      }
      const prevCount = chapters.length;
      chapters = data.chapters;
      // If user opened "New Quiz" gate and a new syllabus/PDF arrived (or forceChaptersView is true), go to chapters
      if (forceChaptersView || (manualGateOpen && chapters.length !== prevCount)) {
        manualGateOpen = false;
      }
      if (manualGateOpen) {
        return true;
      }
      stopPolling();
      renderChapters();
      show('view-chapters');
      return true;
    } catch (e) {
      if (silent) return false; // a failed background poll shouldn't clobber the page
      showGate(chapters.length > 0);
      banner(`Couldn't reach the server: ${e.message}`);
      return false;
    }
  }

  // ---------- onboarding / "New Quiz" upload gate + polling ----------
  function showGate(isNewQuizFlow = false) {
    const backRow = $('gate-back-row');
    const heading = $('gate-heading');
    const subtext = $('gate-subtext');
    if (backRow) backRow.hidden = !isNewQuizFlow && chapters.length === 0;
    if (heading) {
      heading.textContent = isNewQuizFlow ? 'Start a new quiz from another source' : 'Add your syllabus or NCERT chapter PDF';
    }
    if (subtext) {
      subtext.textContent = isNewQuizFlow
        ? 'Send your new syllabus or NCERT chapter PDF to the Study Agent bot on Telegram, or upload it from your computer below.'
        : 'Send your syllabus or NCERT chapter PDF to the Study Agent bot on Telegram, or upload it from your computer below. This page picks it up automatically as soon as it has been read.';
    }
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

  // "New Quiz" button just before Refresh: opens the exact same Telegram / PDF / Text upload flow
  $('new-quiz-btn')?.addEventListener('click', () => {
    manualGateOpen = true;
    sylStatus('');
    if ($('syl-file-name')) $('syl-file-name').hidden = true;
    showGate(true);
    scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('gate-back-btn')?.addEventListener('click', () => {
    manualGateOpen = false;
    stopPolling();
    renderChapters();
    show('view-chapters');
  });

  $('refresh-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const found = await loadChapters({ silent: true, forceChaptersView: true });
    btn.disabled = false;
    if (!found) banner('No syllabus or chapter found yet. Send it to the bot and wait for its “Done!” reply, then refresh.');
    else banner('');
  });

  // ---------- Client-side NCERT Chapter PDF helper (fallback if backend returns "couldn't find any subjects") ----------
  const CLIENT_NCERT_MAP = {
    iesc1: { cls: 9, subject: 'Science', chapters: { 1: 'Matter in Our Surroundings', 2: 'Is Matter Around Us Pure?', 3: 'Atoms and Molecules', 4: 'Structure of the Atom', 5: 'The Fundamental Unit of Life', 6: 'Tissues', 7: 'Motion', 8: 'Force and Laws of Motion', 9: 'Gravitation', 10: 'Work and Energy', 11: 'Sound', 12: 'Improvement in Food Resources' } },
    iemh1: { cls: 9, subject: 'Mathematics', chapters: { 1: 'Number Systems', 2: 'Polynomials', 3: 'Coordinate Geometry', 4: 'Linear Equations in Two Variables', 5: "Introduction to Euclid's Geometry", 6: 'Lines and Angles', 7: 'Triangles', 8: 'Quadrilaterals', 9: 'Circles', 10: "Heron's Formula", 11: 'Surface Areas and Volumes', 12: 'Statistics' } },
    iess1: { cls: 9, subject: 'Geography', chapters: { 1: 'India - Size and Location', 2: 'Physical Features of India', 3: 'Drainage', 4: 'Climate', 5: 'Natural Vegetation and Wildlife', 6: 'Population' } },
    iess2: { cls: 9, subject: 'Economics', chapters: { 1: 'The Story of Village Palampur', 2: 'People as Resource', 3: 'Poverty as a Challenge', 4: 'Food Security in India' } },
    iess3: { cls: 9, subject: 'History', chapters: { 1: 'The French Revolution', 2: 'Socialism in Europe and the Russian Revolution', 3: 'Nazism and the Rise of Hitler', 4: 'Forest Society and Colonialism', 5: 'Pastoralists in the Modern World' } },
    iess4: { cls: 9, subject: 'Civics', chapters: { 1: 'What is Democracy? Why Democracy?', 2: 'Constitutional Design', 3: 'Electoral Politics', 4: 'Working of Institutions', 5: 'Democratic Rights' } },
    jesc1: { cls: 10, subject: 'Science', chapters: { 1: 'Chemical Reactions and Equations', 2: 'Acids, Bases and Salts', 3: 'Metals and Non-metals', 4: 'Carbon and its Compounds', 5: 'Life Processes', 6: 'Control and Coordination', 7: 'How do Organisms Reproduce?', 8: 'Heredity', 9: 'Light - Reflection and Refraction', 10: 'The Human Eye and the Colourful World', 11: 'Electricity', 12: 'Magnetic Effects of Electric Current', 13: 'Our Environment' } },
    jemh1: { cls: 10, subject: 'Mathematics', chapters: { 1: 'Real Numbers', 2: 'Polynomials', 3: 'Pair of Linear Equations in Two Variables', 4: 'Quadratic Equations', 5: 'Arithmetic Progressions', 6: 'Triangles', 7: 'Coordinate Geometry', 8: 'Introduction to Trigonometry', 9: 'Some Applications of Trigonometry', 10: 'Circles', 11: 'Areas Related to Circles', 12: 'Surface Areas and Volumes', 13: 'Statistics', 14: 'Probability' } },
    jess1: { cls: 10, subject: 'Geography', chapters: { 1: 'Resources and Development', 2: 'Forest and Wildlife Resources', 3: 'Water Resources', 4: 'Agriculture', 5: 'Minerals and Energy Resources', 6: 'Manufacturing Industries', 7: 'Lifelines of National Economy' } },
    jess2: { cls: 10, subject: 'Economics', chapters: { 1: 'Development', 2: 'Sectors of the Indian Economy', 3: 'Money and Credit', 4: 'Globalisation and the Indian Economy', 5: 'Consumer Rights' } },
    jess3: { cls: 10, subject: 'History', chapters: { 1: 'The Rise of Nationalism in Europe', 2: 'Nationalism in India', 3: 'The Making of a Global World', 4: 'The Age of Industrialisation', 5: 'Print Culture and the Modern World' } },
    jess4: { cls: 10, subject: 'Civics', chapters: { 1: 'Power-sharing', 2: 'Federalism', 3: 'Gender, Religion and Caste', 4: 'Political Parties', 5: 'Outcomes of Democracy' } },
  };

  async function buildFallbackSyllabusTextFromPdf(payload) {
    const fileName = String(payload.fileName || '');
    const m = /(?:^|[^a-z0-9])([a-z]{4}\d)(\d{2})(?:[^0-9]|$)/i.exec(fileName);
    if (m) {
      const code = m[1].toLowerCase();
      const chNum = parseInt(m[2], 10);
      const book = CLIENT_NCERT_MAP[code];
      if (book && chNum >= 1) {
        const chTitle = book.chapters[chNum] || `Chapter ${chNum}`;
        return `Class ${book.cls} NCERT Syllabus\nSubject: ${book.subject}\nChapter ${chNum}: ${chTitle} (NCERT code: ${code})`;
      }
    }

    const geminiKey = getCookie('sa_gemini_key');
    if (geminiKey && payload.dataBase64) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { inlineData: { mimeType: 'application/pdf', data: payload.dataBase64 } },
                    {
                      text:
                        'This PDF is an NCERT textbook chapter or study chapter. Identify its Class (e.g. 9 or 10), Subject (e.g. Science, Mathematics, History, Geography, Civics, Economics, English, Hindi), Chapter Number, and exact Chapter Title. Output ONLY in this exact format:\nClass <number> Syllabus\nSubject: <Subject Name>\nChapter <number>: <Chapter Title>',
                    },
                  ],
                },
              ],
            }),
          }
        );
        if (res.ok) {
          const data = await res.json();
          const extracted = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (extracted && extracted.length >= 10) return extracted;
        }
      } catch { /* fallback below */ }
    }

    const cleanName = fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || 'NCERT Study Chapter';
    return `Class 9 Syllabus\nSubject: Science\nChapter 1: ${cleanName}`;
  }

  // ---------- upload the syllabus / NCERT PDF from this computer (same result as sending it to the bot) ----------
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
    sylStatus('Reading your PDF / text… this can take up to a minute.');
    const geminiKey = getCookie('sa_gemini_key') || undefined;
    try {
      try {
        await postJson('/api/syllabus/upload', { telegramUserId: userId, geminiKey, ...payload }, 150000);
      } catch (firstErr) {
        // If an older backend rejected a single NCERT chapter PDF with "couldn't find any subjects",
        // automatically extract the chapter metadata and upload it as structured syllabus text.
        if (/couldn't find any subjects/i.test(firstErr.message || '') && payload.kind === 'pdf') {
          sylStatus('Detected single NCERT chapter PDF — extracting subject & chapter…');
          const fallbackText = await buildFallbackSyllabusTextFromPdf(payload);
          await postJson('/api/syllabus/upload', { telegramUserId: userId, geminiKey, kind: 'text', text: fallbackText }, 150000);
        } else {
          throw firstErr;
        }
      }
      sylStatus('Done! Loading your chapters…');
      manualGateOpen = false;
      await loadChapters({ silent: true, forceChaptersView: true });
      renderChapters();
      show('view-chapters');
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
      await sendSyllabus({ kind: 'pdf', fileName: file.name, dataBase64: await toBase64(file) }, [$('syl-pick-btn'), $('syl-text-send')]);
    } catch (err) { sylStatus(err.message, true); }
  });
  $('syl-text-toggle').addEventListener('click', () => {
    const panel = $('syl-text-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) $('syl-text').focus();
  });
  $('syl-text-send').addEventListener('click', () => {
    const text = $('syl-text').value.trim();
    if (text.length < 10) return sylStatus('Paste your syllabus or study text first.', true);
    sendSyllabus({ kind: 'text', text }, [$('syl-pick-btn'), $('syl-text-send')]);
  });

  $('refresh-chapters-btn').addEventListener('click', () => loadChapters({ silent: true, forceChaptersView: true }).then(renderChapters));

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
  addEventListener('scroll', () => { if (popAnchor) requestAnimationFrame(placePop); }, { passive: true });
  addEventListener('resize', placePop);

  // ---------- Voice Input (Web Speech API SpeechRecognition) ----------
  const answerInput = $('quiz-answer-input');
  const charCountEl = $('quiz-char-count');
  const aiThinkingEl = $('quiz-ai-thinking');
  const voiceBtn = $('voice-answer-btn');
  const voiceIcon = $('voice-answer-icon');
  const voiceLabel = $('voice-answer-label');
  const voiceStatusMsg = $('voice-status-msg');
  const DEFAULT_FOOT_HINT = 'Press <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to continue';

  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let isListening = false;
  let baseTextBeforeSpeech = '';
  let finalizedSpeech = '';

  function syncAnswerText(newVal) {
    if (!answerInput) return;
    const clipped = String(newVal || '').slice(0, 2000);
    answerInput.value = clipped;
    if (quiz) quiz.answers[quiz.index] = clipped;
    if (charCountEl) charCountEl.textContent = `${clipped.length} / 2000`;
    if ($('next-btn')) $('next-btn').disabled = clipped.trim().length === 0;
  }

  function updateVoiceUI(listening, customStatus = '') {
    isListening = listening;
    if (voiceBtn) {
      voiceBtn.classList.toggle('is-listening', listening);
      voiceBtn.setAttribute('aria-pressed', String(listening));
    }
    if (voiceIcon) {
      voiceIcon.className = listening ? 'fa-solid fa-stop' : 'fa-solid fa-microphone';
    }
    if (voiceLabel) {
      voiceLabel.textContent = listening ? 'Stop Listening' : 'Speak Answer';
    }
    if (voiceStatusMsg) {
      voiceStatusMsg.classList.toggle('is-listening', listening);
      if (customStatus) {
        voiceStatusMsg.textContent = customStatus;
      } else if (listening) {
        voiceStatusMsg.textContent = 'Listening… speak your answer clearly';
      } else {
        voiceStatusMsg.innerHTML = DEFAULT_FOOT_HINT;
      }
    }
  }

  function stopVoiceInput(customStatus = '') {
    if (recognition) {
      try {
        recognition.onend = null;
        recognition.stop();
      } catch { /* ignore */ }
      recognition = null;
    }
    updateVoiceUI(false, customStatus);
  }

  function toggleVoiceInput() {
    if (!quiz || !answerInput || answerInput.disabled) return;
    if (isListening) {
      stopVoiceInput();
      return;
    }
    if (!SpeechRecognitionAPI) {
      updateVoiceUI(false, 'Voice input is not supported in this browser. Please use Chrome, Edge, or Safari.');
      return;
    }

    try {
      recognition = new SpeechRecognitionAPI();
      recognition.lang = navigator.language || 'en-IN';
      recognition.continuous = true;
      recognition.interimResults = true;

      baseTextBeforeSpeech = answerInput.value.trim();
      finalizedSpeech = '';

      recognition.onstart = () => {
        updateVoiceUI(true, 'Listening… speak your answer clearly');
      };

      recognition.onresult = (event) => {
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalizedSpeech += (finalizedSpeech ? ' ' : '') + transcript.trim();
          } else {
            interimTranscript += transcript;
          }
        }
        const spoken = [finalizedSpeech, interimTranscript.trim()].filter(Boolean).join(' ');
        const combined = [baseTextBeforeSpeech, spoken].filter(Boolean).join(baseTextBeforeSpeech ? ' ' : '');
        syncAnswerText(combined);
      };

      recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          stopVoiceInput('Microphone access was denied. Allow microphone permissions in your browser.');
        } else if (event.error === 'no-speech') {
          stopVoiceInput('No speech detected. Click "Speak Answer" to try again.');
        } else {
          stopVoiceInput(`Voice input stopped (${event.error}).`);
        }
      };

      recognition.onend = () => {
        recognition = null;
        if (isListening) {
          updateVoiceUI(false);
        }
      };

      recognition.start();
    } catch (err) {
      stopVoiceInput(`Could not start microphone: ${err.message}`);
    }
  }

  voiceBtn?.addEventListener('click', toggleVoiceInput);

  // ---------- quiz runner (Typed or Spoken Answers verified by AI) ----------
  async function startQuiz(c) {
    hidePop();
    banner('');
    stopVoiceInput();
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ chapterId: c.id, subject: c.subject, exam: c.exam || '' }));
    $('loading-text').textContent = `Reading the chapter and writing a ${c.subject} quiz on “${c.title}”… this takes a few seconds.`;
    show('view-loading');
    try {
      const data = await postJson('/api/quizzes/generate', { telegramUserId: userId, chapterId: c.id });
      quiz = {
        quizId: data.quizId,
        chapter: data.chapter,
        questions: data.questions,
        answers: data.questions.map(() => ''),
        index: 0,
      };
      $('quiz-title').textContent = `${data.chapter.subject} · ${data.chapter.number != null ? 'Ch ' + data.chapter.number + ': ' : ''}${data.chapter.title}`;
      $('quiz-meta').textContent = `${data.questions.length} questions`;
      if (aiThinkingEl) aiThinkingEl.hidden = true;
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
    stopVoiceInput();
    const { questions, index, answers } = quiz;
    const q = questions[index];
    const last = index === questions.length - 1;
    quizError('');
    if (aiThinkingEl) aiThinkingEl.hidden = true;
    $('quiz-qcount').textContent = `Question ${index + 1} of ${questions.length}`;
    $('quiz-progress-bar').style.width = `${(index / questions.length) * 100}%`;
    $('quiz-subtopic').textContent = q.subtopic;
    $('quiz-question').textContent = q.question;

    const currentTyped = answers[index] || '';
    if (answerInput) {
      answerInput.disabled = false;
      answerInput.value = currentTyped;
      if (charCountEl) charCountEl.textContent = `${currentTyped.length} / 2000`;
    }
    if (voiceBtn) voiceBtn.disabled = false;

    $('prev-btn').disabled = index === 0;
    const next = $('next-btn');
    next.disabled = currentTyped.trim().length === 0;
    next.innerHTML = last ? 'Finish <i class="fa-solid fa-flag-checkered" aria-hidden="true"></i>' : 'Next <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
    setTimeout(() => answerInput?.focus(), 30);
  }

  answerInput?.addEventListener('input', () => {
    if (!quiz) return;
    const val = answerInput.value;
    quiz.answers[quiz.index] = val;
    if (charCountEl) charCountEl.textContent = `${val.length} / 2000`;
    $('next-btn').disabled = val.trim().length === 0;
  });

  answerInput?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!$('next-btn').disabled) $('next-btn').click();
    }
  });

  $('prev-btn').addEventListener('click', () => {
    if (!quiz || quiz.index <= 0) return;
    stopVoiceInput();
    if (answerInput) quiz.answers[quiz.index] = answerInput.value;
    quiz.index--;
    renderQuestion();
  });
  $('next-btn').addEventListener('click', () => {
    if (!quiz) return;
    stopVoiceInput();
    if (answerInput) quiz.answers[quiz.index] = answerInput.value;
    if (quiz.index < quiz.questions.length - 1) {
      quiz.index++;
      renderQuestion();
    } else {
      submitQuiz();
    }
  });
  $('quit-btn').addEventListener('click', () => {
    stopVoiceInput();
    if (quiz && quiz.answers.some((a) => String(a || '').trim().length > 0) && !confirm('Leave this quiz? Your answers will not be saved.')) return;
    quiz = null;
    backToChapters({ scroll: false });
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
    stopVoiceInput();
    submitting = true;
    quizError('');
    const next = $('next-btn');
    const prev = $('prev-btn');
    next.disabled = true;
    prev.disabled = true;
    if (answerInput) answerInput.disabled = true;
    if (voiceBtn) voiceBtn.disabled = true;
    if (aiThinkingEl) aiThinkingEl.hidden = false;
    next.textContent = 'Checking with AI…';
    let result;
    try {
      result = await postJson('/api/quizzes/submit', { telegramUserId: userId, quizId: quiz.quizId, answers: quiz.answers }, 90000);
    } catch (e) {
      submitting = false;
      if (aiThinkingEl) aiThinkingEl.hidden = true;
      if (answerInput) answerInput.disabled = false;
      if (voiceBtn) voiceBtn.disabled = false;
      prev.disabled = quiz.index === 0;
      next.disabled = false;
      next.innerHTML = 'Try again <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>';
      if (e.status === 410 || e.status === 409) {
        quiz = null;
        await backToChapters({ scroll: false });
        banner(e.message);
        return;
      }
      quizError(`Couldn't verify your result: ${e.message}`);
      return;
    }
    submitting = false;
    if (aiThinkingEl) aiThinkingEl.hidden = true;
    quiz = null;
    try {
      showDone(result);
    } catch (e) {
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
        <p><b>Your answer:</b> ${q.userAnswer ? esc(q.userAnswer) : 'Skipped'} ${q.correct ? '✓' : '✗'}</p>
        ${q.feedback ? `<p><b>AI book check:</b> ${esc(q.feedback)}</p>` : ''}
        ${q.correct ? '' : `<p><b>Correct answer:</b> ${esc(q.expectedAnswer || '')}</p>`}
        <p>${esc(q.explanation || '')}</p>
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
    const ok = await loadChapters({ silent: true, forceChaptersView: true });
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

  function afterScroll(cb) {
    let done = false;
    const go = () => { if (done) return; done = true; removeEventListener('scrollend', go); cb(); };
    addEventListener('scrollend', go, { once: true });
    setTimeout(go, 1000);
  }

  init();
})();