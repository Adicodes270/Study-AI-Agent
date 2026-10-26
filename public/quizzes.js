// ==========================================================================
// quizzes.js — syllabus-linked quizzes
// Features:
// 1. Granular Subject Organization:
//    - Social Science chapters are always organized into History, Civics, Economics, and Geography
//    - Science chapters are always organized into Physics, Chemistry, and Biology
// 2. Pending Quiz State (HSL Yellow Button, Auto-Save & Resume Where User Left Off):
//    - Users can leave a quiz mid-way ("Mark as Pending & Leave" or "Back to chapters")
//    - Chapter shows a yellow HSL "Pending" button on the dashboard
//    - Clicking the yellow Pending button resumes at the exact question index where they left off
//      with all previous answers saved in order so all answers are graded together on finish
// 3. Open-ended Typed + Dual-Engine Voice-Spoken Answers + Book-Grounded AI Grading
// 4. Requiz (fresh question sets) + Review Answers + Configurable Question Counts (10–50)
// ==========================================================================
(() => {
  'use strict';

  const POLL_MS = 5000;
  const RETURN_KEY = 'sa_quiz_return';
  const GLOBAL_QCOUNT_KEY = 'sa_default_quiz_questions'; // 'auto' or '1'..'50'
  const CHAPTER_QCOUNT_KEY = 'sa_chapter_qcounts_v1'; // { [chapterKey]: number }
  const LOCAL_REVIEWS_KEY = 'sa_quiz_reviews_v1'; // backup cache of review arrays per chapter
  const PENDING_QUIZZES_KEY = 'sa_pending_quizzes_v1'; // { [chapterKey]: { quizId, attempt, chapter, questions, answers, currentIndex, updatedAt } }
  const MIN_AI_DEFAULT_QUESTIONS = 10;
  const MAX_QUESTIONS = 50;

  const $ = (id) => document.getElementById(id);

  // ---------- Granular Subject Classifier (History, Civics, Economics, Geography & Physics, Chemistry, Biology) ----------
  const SCIENCE_CHAPTER_DISCIPLINE = {
    // Class 9: new "Exploration" book (2026-27), 13 chapters. Keep in sync with src/intake/syllabusParser.js.
    iesc1: {
      1: 'Physics', 2: 'Biology', 3: 'Biology', 4: 'Physics',
      5: 'Chemistry', 6: 'Physics', 7: 'Physics',
      8: 'Chemistry', 9: 'Chemistry', 10: 'Physics',
      11: 'Biology', 12: 'Biology', 13: 'Biology',
    },
    jesc1: {
      1: 'Chemistry', 2: 'Chemistry', 3: 'Chemistry', 4: 'Chemistry',
      5: 'Biology', 6: 'Biology', 7: 'Biology', 8: 'Biology',
      9: 'Physics', 10: 'Physics', 11: 'Physics', 12: 'Physics',
      13: 'Biology',
    },
  };

  function classifyGranularSubjectClient(rawSubject, title = '', pdfUrl = '', bookCode = '', chNum = null) {
    const subj = String(rawSubject || '').trim();
    // The subject saved for a chapter comes from the database (ncert_chapters): never re-guess it from the title or number.
    if (subj) return subj;
    const text = `${title || ''} ${subj}`.toLowerCase();
    const urlMatch = /\/([a-z]{4,5}\d)(\d{2})\.pdf$/i.exec(String(pdfUrl || ''));
    const code = (bookCode || (urlMatch ? urlMatch[1] : '')).toLowerCase().trim();
    const num = chNum || (urlMatch ? parseInt(urlMatch[2], 10) : null);

    if (code === 'iess1' || code === 'jess1') return 'Geography';
    if (code === 'iess2' || code === 'jess2') return 'Economics';
    if (code === 'iess3' || code === 'jess3') return 'History';
    if (code === 'iess4' || code === 'jess4') return 'Civics';
    if ((code === 'iesc1' || code === 'jesc1') && num && SCIENCE_CHAPTER_DISCIPLINE[code]?.[num]) {
      return SCIENCE_CHAPTER_DISCIPLINE[code][num];
    }

    if (/^history$/i.test(subj)) return 'History';
    if (/^(civics|political science|polity)$/i.test(subj)) return 'Civics';
    if (/^geography$/i.test(subj)) return 'Geography';
    if (/^economics$/i.test(subj)) return 'Economics';
    if (/^physics$/i.test(subj)) return 'Physics';
    if (/^chemistry$/i.test(subj)) return 'Chemistry';
    if (/^biology$/i.test(subj)) return 'Biology';

    const isSocialScience = /^(social\s*science|social\s*studies|sst|s\.s\.t\.?)$/i.test(subj);
    const isScience = /^(science|general\s*science|sci)$/i.test(subj);

    if (isSocialScience || !subj) {
      if (
        /civics|politic|democracy|democratic|constitution|constitutional|electoral|election|parliament|judiciary|working of institutions|institution|fundamental rights|democratic rights|power.?sharing|federalism|gender,?\s*religion|caste|political parties|outcomes of democracy|government|panchayat|municipal|citizen|secularism|marginalisation|equality|legislature|executive/i.test(
          text
        )
      ) {
        return 'Civics';
      }
      if (
        /economic|palampur|people as resource|poverty|food security|sectors of|money and credit|globalisation|consumer rights|problem of choice|scarcity|microeconomics|macroeconomics|production|market|budget|banking|gdp|employment/i.test(
          text
        )
      ) {
        return 'Economics';
      }
      if (
        /geography|size and location|physical features|tectonic|himalaya|drainage|climate|monsoon|natural vegetation|wildlife|population|resources and development|forest and wildlife|water resources|agriculture|minerals|energy resources|manufacturing industries|lifelines of national economy|latitude|longitude|lithosphere|atmosphere|hydrosphere|biosphere|landform|drainage basin|peninsular/i.test(
          text
        )
      ) {
        return 'Geography';
      }
      if (
        /history|early human|civilisation|civilization|revolution|nationalism|colonial|empire|dynasty|mughal|sultan|british|east india|world war|hitler|nazism|socialism|russian|french|industrialisation|industrialization|print culture|global world|forest society|pastoralist|peasants|kings|chronicle|harappa|vedic|mesopotamia|stone age|medieval|ancient|modern world|revolt|1857|gandhi|indo.?china|making of/i.test(
          text
        )
      ) {
        return 'History';
      }
      if (isSocialScience) return 'History';
    }

    if (isScience || !subj) {
      if (
        /chemistry|chemical|matter in our surroundings|matter around us pure|atoms and molecules|structure of the atom|acids,?\s*bases|salts|metals and non.?metals|carbon and its compounds|periodic|element|compound|mixture|solution|suspension|colloid|mole concept|valency|isotope|isobar|combustion|flame|coal|petroleum|synthetic fibre|plastic|polymer|redox|corrosion|rancidity|electrolysis|organic|hydrocarbon/i.test(
          text
        )
      ) {
        return 'Chemistry';
      }
      if (
        /biology|fundamental unit of life|cell|tissues|diversity in living|living organism|life processes|control and coordination|reproduce|reproduction|heredity|evolution|our environment|ecosystem|food chain|ozone|improvement in food resources|crop|microorganism|why do we fall ill|disease|nutrition|respiration|transportation in|excretion|photosynthesis|nervous|hormone|endocrine|genetics|dna|chromosome|biodiversity/i.test(
          text
        )
      ) {
        return 'Biology';
      }
      if (
        /physics|motion|force and laws|laws of motion|inertia|momentum|newton|gravitation|gravity|thrust|pressure|archimedes|buoyancy|work and energy|kinetic|potential energy|sound|wave|echo|ultrasound|light|reflection|refraction|mirror|lens|human eye|colourful world|prism|dispersion|scattering|electricity|ohm|circuit|resistance|magnetic effects|electric current|electromagnet|motor|generator|fleming|friction|heat|temperature|optics/i.test(
          text
        )
      ) {
        return 'Physics';
      }
      if (isScience) return 'Physics';
    }

    return subj || 'General';
  }

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

  // ---------- Setup gate ----------
  // Setup is "complete" only with a real numeric Telegram ID (not the guest fallback setup.js
  // uses when nothing was entered) and a Gemini API key. Until then, uploading a syllabus /
  // fetching from Telegram is never offered: the page only points to setup.html.
  const GUEST_TELEGRAM_ID = '100000001';
  function getSetupStatus() {
    const id = getCookie('sa_telegram_id');
    const key = getCookie('sa_gemini_key');
    const hasId = /^\d+$/.test(id) && id !== GUEST_TELEGRAM_ID;
    const hasKey = key.length >= 20 && !/\s/.test(key);
    return { id, hasId, hasKey, complete: hasId && hasKey };
  }

  function showSetupRequired() {
    const { hasId, hasKey } = getSetupStatus();
    const missing = [!hasId && 'your Telegram ID', !hasKey && 'your Gemini API key'].filter(Boolean).join(' and ');
    const txt = $('setup-missing-text');
    if (txt) {
      txt.textContent = `Quizzes need ${missing}. Add ${missing.includes(' and ') ? 'them' : 'it'} on the setup page and press Save Configuration, then come back here.`;
    }
    manualGateOpen = false;
    gateLatestUploadedChapter = null;
    chapters = [];
    banner('');
    show('view-setup');
  }

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
    } catch { /* ignore */ }
  }

  // ---------- state ----------
  let userId = '';
  let chapters = [];
  let activeTab = 'all';
  let currentView = 'view-loading';
  let pollTimer = null;
  let manualGateOpen = false;
  let quiz = null; // { quizId, attempt, chapter, questions, answers: string[], index }
  let activeDoneChapter = null; // chapter object currently shown in #view-done
  let gateAiRecommendedCount = 12; // AI-analyzed default (min 10, max 50) in New Quiz
  let gateCountManuallyEdited = false;
  let gateLatestUploadedChapter = null;

  // ---------- Question Count Persistence & AI Chapter Heuristic (Min 10, Max 50) ----------
  function getGlobalQuestionSetting() {
    const raw = localStorage.getItem(GLOBAL_QCOUNT_KEY) || 'auto';
    if (raw === 'auto') return 'auto';
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < 1) return 'auto';
    return Math.min(MAX_QUESTIONS, n);
  }

  function setGlobalQuestionSetting(val) {
    if (val === 'auto' || val == null || val === '') {
      localStorage.setItem(GLOBAL_QCOUNT_KEY, 'auto');
    } else {
      const clamped = Math.max(1, Math.min(MAX_QUESTIONS, parseInt(val, 10) || 15));
      localStorage.setItem(GLOBAL_QCOUNT_KEY, String(clamped));
    }
    syncTopQuestionCountUI();
    if (chapters.length) renderChapters();
  }

  function chapterStorageKey(c) {
    if (!c) return '';
    return `${String(c.title || '').toLowerCase().trim()}`;
  }

  function getSavedChapterQuestionCount(c) {
    try {
      const map = JSON.parse(localStorage.getItem(CHAPTER_QCOUNT_KEY) || '{}');
      const v = map[chapterStorageKey(c)] ?? map[`${String(c.subject || '').toLowerCase()}||${String(c.title || '').toLowerCase()}`];
      if (v != null) {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n >= 1) return Math.min(MAX_QUESTIONS, n);
      }
    } catch {}
    return null;
  }

  function saveChapterQuestionCount(c, count) {
    if (!c) return;
    try {
      const map = JSON.parse(localStorage.getItem(CHAPTER_QCOUNT_KEY) || '{}');
      map[chapterStorageKey(c)] = Math.max(1, Math.min(MAX_QUESTIONS, parseInt(count, 10) || 12));
      localStorage.setItem(CHAPTER_QCOUNT_KEY, JSON.stringify(map));
    } catch {}
  }

  // AI chapter heuristic on the client: minimum default is ALWAYS 10, max 50
  function analyzeChapterQuestionsHeuristic(info = {}) {
    if (info.recommended_questions != null) {
      const r = parseInt(info.recommended_questions, 10);
      if (!Number.isNaN(r) && r >= 1) {
        return Math.max(MIN_AI_DEFAULT_QUESTIONS, Math.min(MAX_QUESTIONS, r));
      }
    }
    const title = String(info.title || info.fileName || '');
    const subject = String(info.subject || '');
    const textLen = String(info.text || '').length;
    const byteSize = Number(info.fileSize || 0);

    let score = 12; // baseline >= 10
    const topics = title.split(/\s*(?:,|;|\/|&|\band\b|\+|\s[-–—]\s)\s*/i).filter(Boolean).length;
    score += Math.min(Math.max(0, topics - 1) * 2, 6);
    const words = title.trim().split(/\s+/).filter(Boolean).length;
    if (words >= 7) score += 3;
    else if (words >= 4) score += 2;

    if (/math|physics|chemistry|science|biology|economics|history|geography|civics/i.test(subject || title)) {
      score += 3;
    }
    if (textLen > 12000 || byteSize > 2.5 * 1024 * 1024) score += 6;
    else if (textLen > 4000 || byteSize > 900 * 1024) score += 3;

    return Math.max(MIN_AI_DEFAULT_QUESTIONS, Math.min(MAX_QUESTIONS, score));
  }

  function getEffectiveQuestionCount(c) {
    const globalSetting = getGlobalQuestionSetting();
    if (typeof globalSetting === 'number') return globalSetting;
    const perChapter = getSavedChapterQuestionCount(c);
    if (perChapter != null) return perChapter;
    return analyzeChapterQuestionsHeuristic(c);
  }

  // ---------- Pending Quiz Storage (Local + Server Sync) ----------
  function getLocalPendingQuiz(chapter) {
    if (!chapter) return null;
    try {
      const map = JSON.parse(localStorage.getItem(PENDING_QUIZZES_KEY) || '{}');
      const chId = chapter.id != null ? String(chapter.id) : null;
      const k = chapterStorageKey(chapter);
      const rawTitle = String(chapter.title || '').toLowerCase().trim();
      const entry = (chId && map[chId]) || map[k] || (rawTitle && map[rawTitle]) || null;
      if (entry && Array.isArray(entry.questions) && entry.questions.length > 0) {
        return entry;
      }
    } catch {}
    return null;
  }

  function saveLocalPendingQuiz(quizState) {
    if (!quizState || !quizState.chapter || !Array.isArray(quizState.questions)) return;
    try {
      const map = JSON.parse(localStorage.getItem(PENDING_QUIZZES_KEY) || '{}');
      const k = chapterStorageKey(quizState.chapter);
      const chId = quizState.chapter.id != null ? String(quizState.chapter.id) : null;
      const rawTitle = String(quizState.chapter.title || '').toLowerCase().trim();
      const normalizedAnswers = quizState.questions.map((_, i) =>
        typeof quizState.answers?.[i] === 'string' ? quizState.answers[i] : ''
      );
      const answeredCount = normalizedAnswers.filter((a) => a.trim().length > 0).length;
      const savedObj = {
        quizId: quizState.quizId,
        attempt: quizState.attempt || 1,
        chapter: quizState.chapter,
        questions: quizState.questions,
        answers: normalizedAnswers,
        currentIndex: Math.max(0, Math.min(quizState.questions.length - 1, Number(quizState.index) || 0)),
        answeredCount,
        totalQuestions: quizState.questions.length,
        updatedAt: new Date().toISOString(),
      };
      if (k) map[k] = savedObj;
      if (chId) map[chId] = savedObj;
      if (rawTitle) map[rawTitle] = savedObj;
      localStorage.setItem(PENDING_QUIZZES_KEY, JSON.stringify(map));

      // Also update in-memory chapter card immediately
      const chInList = chapters.find(
        (c) =>
          (chId && String(c.id) === chId) ||
          chapterStorageKey(c) === k ||
          String(c.title || '').toLowerCase().trim() === rawTitle
      );
      if (chInList) {
        chInList.pending_quiz = savedObj;
      }
    } catch {}
  }

  function clearPendingQuizForChapter(chapter) {
    if (!chapter) return;
    try {
      const map = JSON.parse(localStorage.getItem(PENDING_QUIZZES_KEY) || '{}');
      const k = chapterStorageKey(chapter);
      const chId = chapter.id != null ? String(chapter.id) : null;
      const rawTitle = String(chapter.title || '').toLowerCase().trim();
      if (k) delete map[k];
      if (chId) delete map[chId];
      if (rawTitle) delete map[rawTitle];
      localStorage.setItem(PENDING_QUIZZES_KEY, JSON.stringify(map));
      const chInList = chapters.find(
        (c) =>
          (chId && String(c.id) === chId) ||
          chapterStorageKey(c) === k ||
          String(c.title || '').toLowerCase().trim() === rawTitle
      );
      if (chInList) {
        chInList.pending_quiz = null;
      }
    } catch {}
  }

  let syncPendingTimer = null;
  function syncQuizProgressToServer(quizState, { immediate = false } = {}) {
    if (!quizState || !quizState.quizId) return;
    saveLocalPendingQuiz(quizState);

    const sendNow = () => {
      postJson(
        '/api/quizzes/progress',
        {
          telegramUserId: userId,
          quizId: quizState.quizId,
          answers: quizState.answers,
          currentIndex: quizState.index,
          isPending: true,
        },
        15000
      ).catch(() => {});
    };

    clearTimeout(syncPendingTimer);
    if (immediate) {
      sendNow();
    } else {
      syncPendingTimer = setTimeout(sendNow, 500);
    }
  }

  // Backup storage for reviews in localStorage
  function saveLocalReviewBackup(chapter, resultObj) {
    if (!chapter || !resultObj) return;
    try {
      const map = JSON.parse(localStorage.getItem(LOCAL_REVIEWS_KEY) || '{}');
      map[chapterStorageKey(chapter)] = resultObj;
      localStorage.setItem(LOCAL_REVIEWS_KEY, JSON.stringify(map));
    } catch {}
  }

  function getLocalReviewBackup(chapter) {
    if (!chapter) return null;
    try {
      const map = JSON.parse(localStorage.getItem(LOCAL_REVIEWS_KEY) || '{}');
      return (
        map[chapterStorageKey(chapter)] ||
        map[`${String(chapter.subject || '').toLowerCase()}||${String(chapter.title || '').toLowerCase()}`] ||
        null
      );
    } catch {
      return null;
    }
  }

  // ---------- View Management ----------
  const VIEWS = ['view-setup', 'view-gate', 'view-loading', 'view-chapters', 'view-quiz', 'view-done'];
  function show(id) {
    currentView = id;
    if (id !== 'view-quiz') stopVoiceInput();
    if (id !== 'view-gate') stopPolling();
    VIEWS.forEach((v) => {
      const el = $(v);
      if (el) el.hidden = v !== id;
    });
    // "Finish setup" box sits in the middle of the page (same look as the Resources empty state)
    $('qz-root')?.classList.toggle('is-centered', id === 'view-setup');
    if (id !== 'view-chapters') hidePop();
  }

  function banner(msg) {
    const b = $('qz-banner');
    if (!b) return;
    b.textContent = msg || '';
    b.hidden = !msg;
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tone = (pct) => (pct >= 80 ? 'good' : pct >= 50 ? 'mid' : 'bad');
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  async function api(path, opts, timeoutMs = 120000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(path, { credentials: 'same-origin', signal: ctl.signal, ...opts });
    } catch (e) {
      throw new Error(
        e.name === 'AbortError'
          ? 'The server took too long to answer. Please try again.'
          : `Couldn't reach the server (${e.message}). Check your connection and try again.`
      );
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

  // ---------- Top Question-Count Panel UI (`#view-chapters` header) ----------
  function syncTopQuestionCountUI() {
    const setting = getGlobalQuestionSetting();
    const btnLabel = $('top-qcount-btn-label');
    const numInput = $('top-qcount-input');
    const rangeInput = $('top-qcount-range');
    if (btnLabel) {
      btnLabel.textContent =
        setting === 'auto' ? 'Questions: AI Auto (10–50)' : `Questions: ${setting} / chapter`;
    }
    const numVal = setting === 'auto' ? 15 : setting;
    if (numInput && document.activeElement !== numInput) numInput.value = String(numVal);
    if (rangeInput) rangeInput.value = String(numVal);

    document.querySelectorAll('[data-toppreset]').forEach((pill) => {
      const v = pill.getAttribute('data-toppreset');
      pill.classList.toggle('active', String(setting) === v);
    });
  }

  $('top-qcount-btn')?.addEventListener('click', () => {
    const panel = $('top-qcount-panel');
    if (!panel) return;
    const nowOpen = panel.hidden;
    panel.hidden = !nowOpen;
    $('top-qcount-btn')?.setAttribute('aria-expanded', String(nowOpen));
    syncTopQuestionCountUI();
  });

  $('top-qcount-close')?.addEventListener('click', () => {
    if ($('top-qcount-panel')) $('top-qcount-panel').hidden = true;
    $('top-qcount-btn')?.setAttribute('aria-expanded', 'false');
  });

  $('top-qcount-range')?.addEventListener('input', (e) => {
    if ($('top-qcount-input')) $('top-qcount-input').value = e.currentTarget.value;
  });

  $('top-qcount-input')?.addEventListener('input', (e) => {
    const n = Math.max(1, Math.min(MAX_QUESTIONS, parseInt(e.currentTarget.value, 10) || 10));
    if ($('top-qcount-range')) $('top-qcount-range').value = String(n);
  });

  $('top-qcount-apply-btn')?.addEventListener('click', () => {
    const n = Math.max(1, Math.min(MAX_QUESTIONS, parseInt($('top-qcount-input')?.value, 10) || 15));
    setGlobalQuestionSetting(n);
    if ($('top-qcount-panel')) $('top-qcount-panel').hidden = true;
    $('top-qcount-btn')?.setAttribute('aria-expanded', 'false');
  });

  $('top-qcount-auto-btn')?.addEventListener('click', () => {
    setGlobalQuestionSetting('auto');
    if ($('top-qcount-panel')) $('top-qcount-panel').hidden = true;
    $('top-qcount-btn')?.setAttribute('aria-expanded', 'false');
  });

  document.querySelectorAll('[data-toppreset]').forEach((pill) => {
    pill.addEventListener('click', () => {
      const v = pill.getAttribute('data-toppreset');
      if (v === 'auto') {
        setGlobalQuestionSetting('auto');
      } else {
        const n = Math.max(1, Math.min(MAX_QUESTIONS, parseInt(v, 10) || 15));
        if ($('top-qcount-input')) $('top-qcount-input').value = String(n);
        if ($('top-qcount-range')) $('top-qcount-range').value = String(n);
        setGlobalQuestionSetting(n);
      }
    });
  });

  // ---------- New Quiz Question-Count Selector UI (`#view-gate`) ----------
  function setGateQuestionCount(val, { fromAi = false, chapterTitle = '' } = {}) {
    const clamped = fromAi
      ? Math.max(MIN_AI_DEFAULT_QUESTIONS, Math.min(MAX_QUESTIONS, parseInt(val, 10) || 12))
      : Math.max(1, Math.min(MAX_QUESTIONS, parseInt(val, 10) || 12));

    if (fromAi) {
      gateAiRecommendedCount = clamped;
    }

    if ($('gate-qcount-input')) $('gate-qcount-input').value = String(clamped);
    if ($('gate-qcount-range')) $('gate-qcount-range').value = String(clamped);

    const badge = $('gate-ai-qcount-badge');
    const note = $('gate-qcount-note');
    const startLabel = $('gate-start-quiz-label');

    if (badge) {
      badge.textContent = fromAi
        ? `AI Default: ${clamped} Questions`
        : `Custom: ${clamped} Questions (AI Default: ${gateAiRecommendedCount})`;
    }
    if (note) {
      note.textContent = chapterTitle
        ? `AI analyzed “${chapterTitle}” and set a default of ${gateAiRecommendedCount} questions (min 10, max 50). You can edit this number above.`
        : `AI default for this chapter: ${gateAiRecommendedCount} questions (minimum 10, max 50). Edit the number anytime.`;
    }
    if (startLabel) {
      startLabel.textContent = `Start Quiz Now (${clamped} Questions)`;
    }

    document.querySelectorAll('[data-qpreset]').forEach((pill) => {
      const p = pill.getAttribute('data-qpreset');
      const active = (p === 'ai' && fromAi) || (!fromAi && p === String(clamped));
      pill.classList.toggle('active', active);
    });
  }

  $('gate-qcount-range')?.addEventListener('input', (e) => {
    gateCountManuallyEdited = true;
    setGateQuestionCount(e.currentTarget.value, { fromAi: false });
    if (gateLatestUploadedChapter) {
      saveChapterQuestionCount(gateLatestUploadedChapter, e.currentTarget.value);
    }
  });

  $('gate-qcount-input')?.addEventListener('input', (e) => {
    gateCountManuallyEdited = true;
    const raw = parseInt(e.currentTarget.value, 10);
    if (!Number.isNaN(raw)) {
      const clamped = Math.max(1, Math.min(MAX_QUESTIONS, raw));
      if ($('gate-qcount-range')) $('gate-qcount-range').value = String(clamped);
      if ($('gate-start-quiz-label')) $('gate-start-quiz-label').textContent = `Start Quiz Now (${clamped} Questions)`;
      if ($('gate-ai-qcount-badge')) {
        $('gate-ai-qcount-badge').textContent = `Custom: ${clamped} Questions (AI Default: ${gateAiRecommendedCount})`;
      }
      if (gateLatestUploadedChapter) {
        saveChapterQuestionCount(gateLatestUploadedChapter, clamped);
      }
    }
  });

  $('gate-qcount-input')?.addEventListener('blur', (e) => {
    const clamped = Math.max(1, Math.min(MAX_QUESTIONS, parseInt(e.currentTarget.value, 10) || gateAiRecommendedCount));
    e.currentTarget.value = String(clamped);
  });

  document.querySelectorAll('[data-qpreset]').forEach((pill) => {
    pill.addEventListener('click', () => {
      const p = pill.getAttribute('data-qpreset');
      if (p === 'ai') {
        gateCountManuallyEdited = false;
        setGateQuestionCount(gateAiRecommendedCount, {
          fromAi: true,
          chapterTitle: gateLatestUploadedChapter?.title || '',
        });
        if (gateLatestUploadedChapter) {
          saveChapterQuestionCount(gateLatestUploadedChapter, gateAiRecommendedCount);
        }
      } else {
        gateCountManuallyEdited = true;
        setGateQuestionCount(p, { fromAi: false });
        if (gateLatestUploadedChapter) {
          saveChapterQuestionCount(gateLatestUploadedChapter, p);
        }
      }
    });
  });

  // ---------- boot ----------
  async function init() {
    backfillCookiesFromSetup();
    syncTopQuestionCountUI();
    setGateQuestionCount(12, { fromAi: true });

    const setup = getSetupStatus();
    if (!setup.complete) {
      showSetupRequired();
      return;
    }
    userId = setup.id;
    await loadChapters();
  }

  // ---------- Load Chapters ----------
  async function loadChapters({ silent = false, forceChaptersView = false } = {}) {
    const setup = getSetupStatus();
    if (!setup.complete) {
      showSetupRequired();
      return false;
    }
    userId = setup.id;
    if (silent && (currentView === 'view-quiz' || currentView === 'view-done')) {
      return true;
    }
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
      chapters = (data.chapters || []).map((c) => {
        // Ensure every chapter is organized into granular subjects (History, Civics, Geography, Economics & Physics, Chemistry, Biology)
        const granularSubject = classifyGranularSubjectClient(c.subject, c.title, c.pdf_url, '', c.number);
        const localPending = getLocalPendingQuiz(c);
        const pendingQuiz = localPending || c.pending_quiz || null;
        return {
          ...c,
          subject: granularSubject,
          pending_quiz: pendingQuiz,
        };
      });

      // Merge any local review backup if a chapter result doesn't have review_json populated yet
      for (const c of chapters) {
        if (c.result && (!Array.isArray(c.result.review) || c.result.review.length === 0)) {
          const localBackup = getLocalReviewBackup(c);
          if (localBackup?.review?.length) {
            c.result.review = localBackup.review;
          }
        }
      }

      if (forceChaptersView || (manualGateOpen && chapters.length !== prevCount && !gateLatestUploadedChapter)) {
        manualGateOpen = false;
      }
      if (manualGateOpen) {
        return true;
      }
      if (currentView === 'view-quiz' || currentView === 'view-done') {
        return true;
      }
      stopPolling();
      renderChapters();
      show('view-chapters');
      return true;
    } catch (e) {
      if (silent) return false;
      showGate(chapters.length > 0);
      banner(`Couldn't reach the server: ${e.message}`);
      return false;
    }
  }

  // ---------- Onboarding / "New Quiz" Upload Gate ----------
  function showGate(isNewQuizFlow = false) {
    if (!getSetupStatus().complete) {
      showSetupRequired();
      return;
    }
    const backRow = $('gate-back-row');
    const heading = $('gate-heading');
    const subtext = $('gate-subtext');
    const readyBox = $('gate-ready-box');
    if (readyBox) readyBox.hidden = true;
    gateLatestUploadedChapter = null;
    gateCountManuallyEdited = false;

    const globalDefault = getGlobalQuestionSetting();
    const initialCount = typeof globalDefault === 'number' ? Math.max(MIN_AI_DEFAULT_QUESTIONS, globalDefault) : 12;
    setGateQuestionCount(initialCount, { fromAi: true });

    if (backRow) backRow.hidden = !isNewQuizFlow && chapters.length === 0;
    if (heading) {
      heading.textContent = isNewQuizFlow ? 'Start a new quiz from another source' : 'Add your syllabus or NCERT chapter PDF';
    }
    if (subtext) {
      subtext.textContent = isNewQuizFlow
        ? 'Choose how many questions you want (or let AI analyze the chapter for a 10–50 default), then upload your NCERT PDF or paste text below.'
        : 'Send your syllabus or NCERT chapter PDF to the Study Agent bot on Telegram, or upload it from your computer below.';
    }
    show('view-gate');
    startPolling();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (document.hidden || currentView !== 'view-gate' || gateLatestUploadedChapter) return;
      loadChapters({ silent: true });
    }, POLL_MS);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  $('new-quiz-btn')?.addEventListener('click', () => {
    if (!getSetupStatus().complete) return showSetupRequired();
    manualGateOpen = true;
    sylStatus('');
    if ($('syl-file-name')) $('syl-file-name').hidden = true;
    showGate(true);
    scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('gate-back-btn')?.addEventListener('click', () => {
    manualGateOpen = false;
    gateLatestUploadedChapter = null;
    stopPolling();
    renderChapters();
    show('view-chapters');
  });

  $('gate-view-chapters-btn')?.addEventListener('click', async () => {
    manualGateOpen = false;
    gateLatestUploadedChapter = null;
    stopPolling();
    await loadChapters({ silent: true, forceChaptersView: true });
    renderChapters();
    show('view-chapters');
  });

  $('gate-start-quiz-btn')?.addEventListener('click', () => {
    if (!gateLatestUploadedChapter) return;
    const chosenCount = Math.max(
      1,
      Math.min(MAX_QUESTIONS, parseInt($('gate-qcount-input')?.value, 10) || gateAiRecommendedCount)
    );
    saveChapterQuestionCount(gateLatestUploadedChapter, chosenCount);
    manualGateOpen = false;
    stopPolling();
    startQuiz(gateLatestUploadedChapter, chosenCount);
  });

  $('refresh-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const found = await loadChapters({ silent: true, forceChaptersView: true });
    btn.disabled = false;
    if (!found) banner('No syllabus or chapter found yet. Send it to the bot and wait for its “Done!” reply, then refresh.');
    else banner('');
  });

  // ---------- Client-side NCERT Chapter PDF helper (with granular subjects!) ----------
  const CLIENT_NCERT_MAP = {
    iesc1: { cls: 9, subject: 'Science', chapters: { 1: 'Exploration: Entering the World of Secondary Science', 2: 'Cell: The Building Block of Life', 3: 'Tissues in Action', 4: 'Describing Motion Around Us', 5: 'Exploring Mixtures and their Separation', 6: 'How Forces Affect Motion', 7: 'Work, Energy, and Simple Machines', 8: 'Journey Inside the Atom', 9: 'Atomic Foundations of Matter', 10: 'Sound Waves: Characteristics and Applications', 11: 'Reproduction: How Life Continues', 12: 'Patterns in Life: Diversity and Classification', 13: 'Earth as a System: Energy, Matter, and Life' } },
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
        const granularSubj = classifyGranularSubjectClient(book.subject, chTitle, '', code, chNum);
        return `Class ${book.cls} NCERT Syllabus\nSubject: ${granularSubj}\nChapter ${chNum}: ${chTitle} (NCERT code: ${code})`;
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
                        'This PDF is an NCERT textbook chapter or study chapter. Identify its Class (e.g. 9 or 10), specific Subject (MUST be one of Physics, Chemistry, Biology, History, Civics, Geography, Economics, Mathematics, English, Hindi, Sanskrit — NEVER generic Science or Social Science), Chapter Number, and exact Chapter Title. Output ONLY in this exact format:\nClass <number> Syllabus\nSubject: <Subject Name>\nChapter <number>: <Chapter Title>',
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
    const guessedSubj = classifyGranularSubjectClient('', cleanName, '', '', 1);
    return `Class 9 Syllabus\nSubject: ${guessedSubj !== 'General' ? guessedSubj : 'Physics'}\nChapter 1: ${cleanName}`;
  }

  // ---------- Upload PDF / Text in New Quiz ----------
  const MAX_PDF_BYTES = 20 * 1024 * 1024;
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
    if (!getSetupStatus().complete) return showSetupRequired();
    buttons.forEach((b) => { if (b) b.disabled = true; });
    if ($('gate-ready-box')) $('gate-ready-box').hidden = true;
    sylStatus('Finding which chapter this is…');
    const geminiKey = getCookie('sa_gemini_key') || undefined;

    if (!gateCountManuallyEdited) {
      const preEst = analyzeChapterQuestionsHeuristic(payload);
      setGateQuestionCount(preEst, { fromAi: true });
    }

    try {
      let uploadRes;
      try {
        uploadRes = await postJson('/api/syllabus/upload', { telegramUserId: userId, geminiKey, ...payload }, 150000);
      } catch (firstErr) {
        if (/couldn't find any subjects/i.test(firstErr.message || '') && payload.kind === 'pdf') {
          sylStatus('Detected single NCERT chapter PDF — extracting subject & chapter…');
          const fallbackText = await buildFallbackSyllabusTextFromPdf(payload);
          uploadRes = await postJson(
            '/api/syllabus/upload',
            { telegramUserId: userId, geminiKey, kind: 'text', text: fallbackText },
            150000
          );
        } else {
          throw firstErr;
        }
      }

      const aiCount = Math.max(
        MIN_AI_DEFAULT_QUESTIONS,
        Math.min(
          MAX_QUESTIONS,
          Number(uploadRes?.ai_recommended_questions) ||
            Number(uploadRes?.latest_chapter?.recommended_questions) ||
            analyzeChapterQuestionsHeuristic(payload)
        )
      );
      gateAiRecommendedCount = aiCount;

      if (!gateCountManuallyEdited) {
        setGateQuestionCount(aiCount, {
          fromAi: true,
          chapterTitle: uploadRes?.latest_chapter?.title || payload.fileName || '',
        });
      } else {
        const userChosen = Math.max(1, Math.min(MAX_QUESTIONS, parseInt($('gate-qcount-input')?.value, 10) || aiCount));
        setGateQuestionCount(userChosen, {
          fromAi: false,
          chapterTitle: uploadRes?.latest_chapter?.title || payload.fileName || '',
        });
      }

      await loadChapters({ silent: true });

      const targetChapter =
        (uploadRes?.latest_chapter &&
          chapters.find((c) => String(c.id) === String(uploadRes.latest_chapter.id))) ||
        uploadRes?.latest_chapter ||
        chapters[chapters.length - 1] ||
        null;

      if (targetChapter) {
        targetChapter.subject = classifyGranularSubjectClient(
          targetChapter.subject,
          targetChapter.title,
          targetChapter.pdf_url,
          '',
          targetChapter.number
        );
        gateLatestUploadedChapter = targetChapter;
        const finalCount = Math.max(
          1,
          Math.min(MAX_QUESTIONS, parseInt($('gate-qcount-input')?.value, 10) || aiCount)
        );
        saveChapterQuestionCount(targetChapter, finalCount);
        sylStatus('');
        const readyBox = $('gate-ready-box');
        const readyTitle = $('gate-ready-title');
        if (readyTitle) {
          const chNo = targetChapter.number != null ? `Chapter ${targetChapter.number} · ` : '';
          readyTitle.textContent = `✓ Loaded ${chNo}${targetChapter.subject} · “${targetChapter.title}” — ${aiCount} questions by default (editable above, max 50).`;
        }
        if (readyBox) readyBox.hidden = false;
      } else {
        sylStatus('Done! Loading your chapters…');
        manualGateOpen = false;
        await loadChapters({ silent: true, forceChaptersView: true });
        renderChapters();
        show('view-chapters');
      }
    } catch (e) {
      sylStatus(e.message, true);
    } finally {
      buttons.forEach((b) => { if (b) b.disabled = false; });
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
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return sylStatus('Please choose a PDF file.', true);
    if (file.size > MAX_PDF_BYTES) return sylStatus('That PDF is over 20 MB, which is too big.', true);
    try {
      await sendSyllabus(
        { kind: 'pdf', fileName: file.name, fileSize: file.size, dataBase64: await toBase64(file) },
        [$('syl-pick-btn'), $('syl-text-send')]
      );
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

  $('syl-text')?.addEventListener('input', (e) => {
    if (!gateCountManuallyEdited) {
      const est = analyzeChapterQuestionsHeuristic({ text: e.currentTarget.value });
      setGateQuestionCount(est, { fromAi: true });
    }
  });

  $('syl-text-send')?.addEventListener('click', () => {
    const text = ($('syl-text')?.value || '').trim();
    if (text.length < 10) return sylStatus('Paste your syllabus or study text first.', true);
    sendSyllabus({ kind: 'text', text }, [$('syl-pick-btn'), $('syl-text-send')]);
  });

  $('refresh-chapters-btn')?.addEventListener('click', () =>
    loadChapters({ silent: true, forceChaptersView: true }).then(renderChapters)
  );

  // ---------- Subject Sections & Chapter Cards ----------
  const SUBJECT_DISPLAY_ORDER = [
    'History',
    'Civics',
    'Geography',
    'Economics',
    'Physics',
    'Chemistry',
    'Biology',
    'Mathematics',
    'English',
    'Hindi',
    'Sanskrit',
  ];

  function groupSections() {
    const map = new Map();
    for (const c of chapters) {
      const granularSubj = classifyGranularSubjectClient(c.subject, c.title, c.pdf_url, '', c.number);
      c.subject = granularSubj;
      const key = `${granularSubj}||${c.exam || ''}`;
      if (!map.has(key)) map.set(key, { key, subject: granularSubj, exam: c.exam || '', chapters: [] });
      map.get(key).chapters.push(c);
    }
    return [...map.values()].sort((a, b) => {
      const idxA = SUBJECT_DISPLAY_ORDER.indexOf(a.subject);
      const idxB = SUBJECT_DISPLAY_ORDER.indexOf(b.subject);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.subject.localeCompare(b.subject);
    });
  }

  function renderChapters() {
    syncTopQuestionCountUI();
    const sections = groupSections();
    const subjects = [...new Set(sections.map((s) => s.subject))];
    if (activeTab !== 'all' && !subjects.includes(activeTab)) activeTab = 'all';

    const tabs = $('subject-tabs');
    tabs.innerHTML = '';
    for (const name of ['all', ...subjects]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qz-tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(name === activeTab));
      b.textContent = name === 'all' ? 'All Subjects' : name;
      b.addEventListener('click', () => {
        activeTab = name;
        renderChapters();
      });
      tabs.appendChild(b);
    }

    const root = $('subject-sections');
    root.innerHTML = '';
    for (const sec of sections) {
      if (activeTab !== 'all' && sec.subject !== activeTab) continue;
      const attempted = sec.chapters.filter((c) => c.result).length;
      const pendingCount = sec.chapters.filter((c) => c.pending_quiz || getLocalPendingQuiz(c)).length;
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
            <span>${mastered} of ${sec.chapters.length} mastered${attempted ? ` · ${attempted} attempted` : ''}${pendingCount ? ` · ${pendingCount} pending` : ''}</span>
            <div class="qz-mastery-bar"><i style="width:${Math.round((mastered / sec.chapters.length) * 100)}%"></i></div>
          </div>
        </div>
        <div class="qz-grid"></div>`;
      const grid = el.querySelector('.qz-grid');
      for (const c of sec.chapters) grid.appendChild(chapterCard(c));
      root.appendChild(el);
    }
  }

  function getEffectivePendingQuiz(c) {
    return getLocalPendingQuiz(c) || c.pending_quiz || null;
  }

  function computeResumeIndex(pending) {
    if (!pending || !Array.isArray(pending.questions) || !pending.questions.length) return 0;
    const total = pending.questions.length;
    const savedIdx = Math.max(0, Math.min(total - 1, Number(pending.currentIndex) || 0));
    const answers = Array.isArray(pending.answers) ? pending.answers : [];
    // If the question at savedIdx has not been answered yet, stay on savedIdx;
    // otherwise if there is a next unanswered question, advance to it or stay on savedIdx
    if (!String(answers[savedIdx] || '').trim()) {
      return savedIdx;
    }
    const firstUnansweredAfter = answers.findIndex((a, i) => i >= savedIdx && !String(a || '').trim());
    if (firstUnansweredAfter !== -1) return firstUnansweredAfter;
    const firstUnansweredAny = answers.findIndex((a) => !String(a || '').trim());
    return firstUnansweredAny !== -1 ? firstUnansweredAny : savedIdx;
  }

  function chapterCard(c) {
    const card = document.createElement('div');
    card.className = 'qz-chapter';
    card.dataset.chapterId = c.id;
    card.tabIndex = 0;

    const pending = getEffectivePendingQuiz(c);
    const qCount = pending?.totalQuestions || pending?.questions?.length || getEffectiveQuestionCount(c);

    if (pending) {
      card.classList.add('pending');
    } else if (c.result) {
      card.classList.add('done');
    }

    const resumeIdx = pending ? computeResumeIndex(pending) : 0;
    const answeredCount = pending
      ? (Array.isArray(pending.answers) ? pending.answers.filter((a) => String(a || '').trim().length > 0).length : pending.answeredCount || 0)
      : 0;
    const totalPendingQs = pending ? (pending.questions?.length || pending.totalQuestions || qCount) : qCount;

    let footHtml = '';
    if (pending) {
      footHtml = `
        <span class="qz-badge pending">Pending</span>
        <span>${answeredCount}/${totalPendingQs} saved · Resume at Q${resumeIdx + 1}</span>`;
    } else if (c.result) {
      footHtml = `
        <span class="qz-badge ${tone(c.result.percentage)}">${c.result.percentage}%</span>
        <span>${c.result.score}/${c.result.total} · Attempt #${c.result.attempts || 1}</span>`;
    } else {
      footHtml = `<span>Not attempted yet</span><span>${qCount} questions</span>`;
    }

    let actionsHtml = '';
    if (pending) {
      actionsHtml = `
        <button type="button" class="qz-ch-btn pending" data-action="pending" style="display:inline-flex !important; visibility:visible !important; opacity:1 !important;" title="Resume your pending quiz from Question ${resumeIdx + 1} with all ${answeredCount} previous answer(s) saved in order">
          <i class="fa-solid fa-clock" aria-hidden="true"></i> Pending · Resume (Q${resumeIdx + 1}/${totalPendingQs})
        </button>
        ${
          c.result
            ? `<button type="button" class="qz-ch-btn" data-action="review" title="Review answers from your last completed attempt">
                 <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Review
               </button>`
            : `<button type="button" class="qz-ch-btn" data-action="requiz" title="Discard pending quiz and start a fresh quiz">
                 <i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Restart
               </button>`
        }`;
    } else if (c.result) {
      actionsHtml = `
        <button type="button" class="qz-ch-btn primary" data-action="requiz" title="Take a new quiz on this chapter with fresh questions">
          <i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Requiz
        </button>
        <button type="button" class="qz-ch-btn" data-action="review" title="Review your answers and AI feedback from your last attempt">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Review Answers
        </button>`;
    } else {
      actionsHtml = `
        <button type="button" class="qz-ch-btn primary" data-action="start">
          <i class="fa-solid fa-play" aria-hidden="true"></i> Start Quiz (${qCount} Qs)
        </button>`;
    }

    card.innerHTML = `
      <div class="qz-ch-top">
        <span class="qz-ch-num">${c.number != null ? 'CH ' + String(c.number).padStart(2, '0') : 'CH —'} · ${qCount} Qs</span>
        <span class="chip ${c.matched ? 'ok' : 'wait'}">${c.matched ? 'NCERT' : 'By topic'}</span>
      </div>
      <div class="qz-ch-title">${esc(c.title)}</div>
      <div class="qz-ch-foot">${footHtml}</div>
      <div class="qz-ch-actions">${actionsHtml}</div>`;

    card.querySelector('[data-action="pending"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      resumePendingQuiz(c);
    });

    card.querySelector('[data-action="start"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      startQuiz(c, getEffectiveQuestionCount(c));
    });

    card.querySelector('[data-action="requiz"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearPendingQuizForChapter(c);
      startQuiz(c, getEffectiveQuestionCount(c));
    });

    card.querySelector('[data-action="review"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openSavedChapterReview(c);
    });

    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (getEffectivePendingQuiz(c)) {
        resumePendingQuiz(c);
      } else if (c.result) {
        openSavedChapterReview(c);
      } else {
        startQuiz(c, getEffectiveQuestionCount(c));
      }
    });

    if (c.result && !pending) {
      card.addEventListener('mouseenter', () => showPop(card, c));
      card.addEventListener('mouseleave', hidePop);
      card.addEventListener('focus', () => showPop(card, c));
      card.addEventListener('blur', hidePop);
    }
    return card;
  }

  function openSavedChapterReview(c) {
    if (!c || !c.result) return;
    hidePop();
    const localBackup = getLocalReviewBackup(c);
    const reviewList =
      Array.isArray(c.result.review) && c.result.review.length
        ? c.result.review
        : Array.isArray(localBackup?.review)
          ? localBackup.review
          : [];

    const payload = {
      score: c.result.score,
      total: c.result.total,
      percentage: c.result.percentage,
      revision_tier: c.result.revision_tier,
      revision_message: c.result.revision_message,
      weak_subtopics: c.result.weak_subtopics || [],
      attempts: c.result.attempts || 1,
      review: reviewList,
      chapter: {
        id: c.id,
        subject: c.subject,
        exam: c.exam,
        number: c.number,
        title: c.title,
      },
    };
    showDone(payload, { openReviewImmediately: true });
  }

  // ---------- Hover Popover ----------
  const pop = $('result-pop');
  let popAnchor = null;
  function placePop() {
    if (!popAnchor) return;
    const a = popAnchor.getBoundingClientRect();
    if (a.bottom < 0 || a.top > innerHeight) {
      hidePop();
      return;
    }
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
    if (!r) return;
    const t = tone(r.percentage);
    pop.innerHTML = `
      <div><span class="qz-pop-pct ${t}">${r.percentage}%</span><span class="qz-pop-score">${r.score}/${r.total} correct · Attempt #${r.attempts || 1}</span></div>
      <p class="qz-pop-msg">${esc(r.revision_message)}</p>
      ${r.weak_subtopics?.length ? `<div class="qz-pop-weak"><b>Weak subtopics</b>${r.weak_subtopics.map((w) => `<span>${esc(w)}</span>`).join('')}</div>` : ''}
      <div class="qz-pop-cta">Click "Review Answers" to inspect your answers or "Requiz" for a new set of questions.</div>`;
    popAnchor = anchor;
    pop.hidden = false;
    placePop();
  }
  function hidePop() {
    if (pop) pop.hidden = true;
    popAnchor = null;
  }
  addEventListener('scroll', () => { if (popAnchor) requestAnimationFrame(placePop); }, { passive: true });
  addEventListener('resize', placePop);

  // ==========================================================================
  // Dual-Engine Voice Input (#voice-answer-btn)
  // ==========================================================================
  const answerInput = $('quiz-answer-input');
  const charCountEl = $('quiz-char-count');
  const aiThinkingEl = $('quiz-ai-thinking');
  const voiceBtn = $('voice-answer-btn');
  const voiceIcon = $('voice-answer-icon');
  const voiceLabel = $('voice-answer-label');
  const voiceStatusMsg = $('voice-status-msg');
  const DEFAULT_FOOT_HINT = 'Press <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to continue · Progress auto-saved';

  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let userWantsMic = false;
  let restartTimer = null;
  let baseTextBeforeSpeech = '';
  let finalizedSpeech = '';
  let pendingInterimSpeech = '';
  let mediaStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];

  function syncAnswerText(newVal) {
    if (!answerInput) return;
    const clipped = String(newVal || '').slice(0, 2000);
    answerInput.value = clipped;
    if (quiz) {
      quiz.answers[quiz.index] = clipped;
      syncQuizProgressToServer(quiz, { immediate: false });
    }
    if (charCountEl) charCountEl.textContent = `${clipped.length} / 2000`;
    if ($('next-btn')) $('next-btn').disabled = clipped.trim().length === 0;
  }

  function updateVoiceUI(listening, customStatus = '') {
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
        voiceStatusMsg.textContent = '🎙️ Listening continuously… speak your answer, then click "Stop Listening"';
      } else {
        voiceStatusMsg.innerHTML = DEFAULT_FOOT_HINT;
      }
    }
  }

  function cleanupMediaStream() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch {}
    }
    mediaRecorder = null;
    if (mediaStream) {
      try { mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
      mediaStream = null;
    }
  }

  async function transcribeAudioBlobWithGemini(blob) {
    if (!blob || blob.size < 400) return '';
    const base64Audio = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
      r.onerror = () => resolve('');
      r.readAsDataURL(blob);
    });
    if (!base64Audio) return '';

    const mimeType = blob.type || 'audio/webm';
    const geminiKey = getCookie('sa_gemini_key') || undefined;

    try {
      const res = await postJson(
        '/api/quizzes/transcribe',
        { telegramUserId: userId, audioBase64: base64Audio, mimeType, geminiKey },
        45000
      );
      if (res?.transcript) return String(res.transcript).trim();
    } catch { /* fallback below */ }

    if (geminiKey) {
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
                    { inlineData: { mimeType: mimeType.split(';')[0] || 'audio/webm', data: base64Audio } },
                    {
                      text:
                        "Transcribe the student's spoken quiz answer into clean plain text. Output ONLY the exact words spoken, with no commentary.",
                    },
                  ],
                },
              ],
            }),
          }
        );
        if (res.ok) {
          const data = await res.json();
          return String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        }
      } catch {}
    }
    return '';
  }

  function stopVoiceInput(customStatus = '', { transcribeFallback = false } = {}) {
    userWantsMic = false;
    clearTimeout(restartTimer);
    restartTimer = null;

    if (pendingInterimSpeech.trim()) {
      finalizedSpeech += (finalizedSpeech ? ' ' : '') + pendingInterimSpeech.trim();
      pendingInterimSpeech = '';
      const combined = [baseTextBeforeSpeech, finalizedSpeech].filter(Boolean).join(baseTextBeforeSpeech ? ' ' : '');
      syncAnswerText(combined);
    }

    if (recognition) {
      try {
        recognition.onend = null;
        recognition.onerror = null;
        recognition.onresult = null;
        recognition.stop();
      } catch {}
      recognition = null;
    }

    const hadLiveSpeech = finalizedSpeech.trim().length > 0;

    if (transcribeFallback && !hadLiveSpeech && mediaRecorder && recordedChunks.length > 0) {
      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const recorderRef = mediaRecorder;
      updateVoiceUI(false, 'Transcribing your voice with AI…');
      recorderRef.onstop = async () => {
        const blob = new Blob(recordedChunks, { type: mimeType });
        recordedChunks = [];
        cleanupMediaStream();
        const transcript = await transcribeAudioBlobWithGemini(blob);
        if (transcript) {
          const combined = [baseTextBeforeSpeech, transcript].filter(Boolean).join(baseTextBeforeSpeech ? ' ' : '');
          syncAnswerText(combined);
          updateVoiceUI(false, '✓ Voice transcribed!');
          setTimeout(() => { if (!userWantsMic) updateVoiceUI(false); }, 2200);
        } else {
          updateVoiceUI(false, customStatus || 'No speech detected. Speak clearly and try again.');
        }
      };
      cleanupMediaStream();
      return;
    }

    recordedChunks = [];
    cleanupMediaStream();
    updateVoiceUI(false, customStatus);
  }

  function createAndStartSpeechRecognition() {
    if (!SpeechRecognitionAPI || !userWantsMic) return;
    try {
      const rec = new SpeechRecognitionAPI();
      recognition = rec;
      rec.lang = 'en-IN';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const t = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalizedSpeech += (finalizedSpeech ? ' ' : '') + t.trim();
          } else {
            interim += t;
          }
        }
        pendingInterimSpeech = interim;
        const spoken = [finalizedSpeech, interim.trim()].filter(Boolean).join(' ');
        const combined = [baseTextBeforeSpeech, spoken].filter(Boolean).join(baseTextBeforeSpeech ? ' ' : '');
        syncAnswerText(combined);
      };

      rec.onerror = (event) => {
        if (!userWantsMic) return;
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          stopVoiceInput('Microphone permission denied. Please allow microphone access in your browser.');
          return;
        }
      };

      rec.onend = () => {
        if (pendingInterimSpeech.trim()) {
          finalizedSpeech += (finalizedSpeech ? ' ' : '') + pendingInterimSpeech.trim();
          pendingInterimSpeech = '';
          const combined = [baseTextBeforeSpeech, finalizedSpeech].filter(Boolean).join(baseTextBeforeSpeech ? ' ' : '');
          syncAnswerText(combined);
        }
        if (userWantsMic) {
          clearTimeout(restartTimer);
          restartTimer = setTimeout(() => {
            if (userWantsMic) createAndStartSpeechRecognition();
          }, 140);
        }
      };

      rec.start();
    } catch {}
  }

  async function toggleVoiceInput() {
    if (!quiz || !answerInput || answerInput.disabled) return;
    if (userWantsMic) {
      stopVoiceInput('', { transcribeFallback: true });
      return;
    }

    baseTextBeforeSpeech = answerInput.value.trim();
    finalizedSpeech = '';
    pendingInterimSpeech = '';
    recordedChunks = [];
    userWantsMic = true;
    updateVoiceUI(true, '🎙️ Starting microphone…');

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!userWantsMic) {
          cleanupMediaStream();
          return;
        }
        if (typeof MediaRecorder !== 'undefined') {
          const preferredMime =
            MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')
              ? 'audio/webm;codecs=opus'
              : MediaRecorder.isTypeSupported?.('audio/mp4')
                ? 'audio/mp4'
                : '';
          mediaRecorder = preferredMime
            ? new MediaRecorder(mediaStream, { mimeType: preferredMime })
            : new MediaRecorder(mediaStream);
          mediaRecorder.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data);
          };
          mediaRecorder.start(250);
        }
      } catch (err) {
        stopVoiceInput(`Microphone access blocked (${err.message}). Allow microphone permission in your browser.`);
        return;
      }
    }

    updateVoiceUI(true, '🎙️ Listening continuously… speak your answer, then click "Stop Listening"');
    if (SpeechRecognitionAPI) {
      createAndStartSpeechRecognition();
    }
  }

  voiceBtn?.addEventListener('click', toggleVoiceInput);

  // ---------- Quiz Runner: Start, Resume Pending, Save Pending, Submit ----------
  function mountQuizToUI(quizObj) {
    quiz = quizObj;
    const ch = quiz.chapter;
    ch.subject = classifyGranularSubjectClient(ch.subject, ch.title, ch.pdf_url, '', ch.number);

    $('quiz-title').textContent = `${ch.subject} · ${
      ch.number != null ? 'Ch ' + ch.number + ': ' : ''
    }${ch.title}${quiz.attempt > 1 ? ` (Attempt #${quiz.attempt})` : ''}`;
    $('quiz-meta').textContent = `${quiz.questions.length} questions`;
    if (aiThinkingEl) aiThinkingEl.hidden = true;

    // Explicitly guarantee Mark as Pending buttons are visible and active
    const topPendingBtn = $('pending-quiz-btn');
    const navPendingBtn = $('nav-pending-quiz-btn');
    if (topPendingBtn) {
      topPendingBtn.hidden = false;
      topPendingBtn.style.display = 'inline-flex';
      topPendingBtn.style.visibility = 'visible';
      topPendingBtn.style.opacity = '1';
    }
    if (navPendingBtn) {
      navPendingBtn.hidden = false;
      navPendingBtn.style.display = 'inline-flex';
      navPendingBtn.style.visibility = 'visible';
      navPendingBtn.style.opacity = '1';
    }

    show('view-quiz');
    scrollTo({ top: 0 });
    renderQuestion();
  }

  async function resumePendingQuiz(c) {
    hidePop();
    banner('');
    stopVoiceInput();
    const pending = getEffectivePendingQuiz(c);
    if (!pending) {
      return startQuiz(c, getEffectiveQuestionCount(c));
    }

    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ chapterId: c.id, subject: c.subject, exam: c.exam || '' }));

    // If the pending object already has the full questions list in memory/localStorage, mount immediately!
    if (Array.isArray(pending.questions) && pending.questions.length > 0) {
      const normalizedAnswers = pending.questions.map((_, i) =>
        typeof pending.answers?.[i] === 'string' ? pending.answers[i] : ''
      );
      const resumeIdx = computeResumeIndex({ ...pending, answers: normalizedAnswers });
      mountQuizToUI({
        quizId: pending.quizId,
        attempt: pending.attempt || (c.result?.attempts ? c.result.attempts + 1 : 1),
        chapter: {
          id: c.id,
          subject: c.subject,
          exam: c.exam,
          number: c.number,
          title: c.title,
        },
        questions: pending.questions,
        answers: normalizedAnswers,
        index: resumeIdx,
      });
      return;
    }

    // Otherwise fetch the pending session from the server by quizId
    $('loading-text').textContent = `Resuming your pending ${c.subject} quiz on “${c.title}” from where you left off…`;
    show('view-loading');
    try {
      const data = await postJson(
        '/api/quizzes/generate',
        { telegramUserId: userId, chapterId: c.id, resumeQuizId: pending.quizId },
        60000
      );
      const normalizedAnswers = data.questions.map((_, i) =>
        typeof data.answers?.[i] === 'string' ? data.answers[i] : ''
      );
      const resumeIdx = computeResumeIndex({
        questions: data.questions,
        answers: normalizedAnswers,
        currentIndex: data.currentIndex || 0,
      });
      mountQuizToUI({
        quizId: data.quizId,
        attempt: data.attempt || 1,
        chapter: data.chapter,
        questions: data.questions,
        answers: normalizedAnswers,
        index: resumeIdx,
      });
    } catch (e) {
      show('view-chapters');
      banner(e.message);
    }
  }

  async function startQuiz(c, requestedCount = null) {
    hidePop();
    banner('');
    stopVoiceInput();
    const countToRequest = requestedCount || getEffectiveQuestionCount(c);
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ chapterId: c.id, subject: c.subject, exam: c.exam || '' }));
    $('loading-text').textContent = `Reading the chapter and writing a ${countToRequest}-question ${c.subject} quiz on “${c.title}”… this takes a few seconds.`;
    show('view-loading');
    try {
      const data = await postJson(
        '/api/quizzes/generate',
        { telegramUserId: userId, chapterId: c.id, questionCount: countToRequest },
        150000
      );
      const newQuiz = {
        quizId: data.quizId,
        attempt: data.attempt || 1,
        chapter: data.chapter,
        questions: data.questions,
        answers: data.questions.map(() => ''),
        index: 0,
      };
      // Save initial pending session so even if they close the tab on Q1, it's marked Pending
      syncQuizProgressToServer(newQuiz, { immediate: true });
      mountQuizToUI(newQuiz);
    } catch (e) {
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
    const savedCount = answers.filter((a) => String(a || '').trim().length > 0).length;
    $('quiz-qcount').textContent = `Question ${index + 1} of ${questions.length}${
      savedCount > 0 ? ` · ${savedCount} answer${savedCount === 1 ? '' : 's'} saved` : ''
    }`;
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
    next.innerHTML = last
      ? 'Finish <i class="fa-solid fa-flag-checkered" aria-hidden="true"></i>'
      : 'Next <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
    setTimeout(() => answerInput?.focus(), 30);
  }

  answerInput?.addEventListener('input', () => {
    if (!quiz) return;
    const val = answerInput.value;
    quiz.answers[quiz.index] = val;
    if (charCountEl) charCountEl.textContent = `${val.length} / 2000`;
    $('next-btn').disabled = val.trim().length === 0;
    syncQuizProgressToServer(quiz, { immediate: false });
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
    syncQuizProgressToServer(quiz, { immediate: true });
    renderQuestion();
  });

  $('next-btn').addEventListener('click', () => {
    if (!quiz) return;
    stopVoiceInput();
    if (answerInput) quiz.answers[quiz.index] = answerInput.value;
    if (quiz.index < quiz.questions.length - 1) {
      quiz.index++;
      syncQuizProgressToServer(quiz, { immediate: true });
      renderQuestion();
    } else {
      submitQuiz();
    }
  });

  async function pauseAndMarkQuizAsPending() {
    stopVoiceInput();
    if (quiz) {
      if (answerInput) quiz.answers[quiz.index] = answerInput.value;
      saveLocalPendingQuiz(quiz);
      syncQuizProgressToServer(quiz, { immediate: true });
      quiz = null;
    }
    await backToChapters({ scroll: true });
  }

  $('pending-quiz-btn')?.addEventListener('click', pauseAndMarkQuizAsPending);
  $('nav-pending-quiz-btn')?.addEventListener('click', pauseAndMarkQuizAsPending);
  $('quit-btn')?.addEventListener('click', pauseAndMarkQuizAsPending);

  addEventListener('beforeunload', () => {
    if (quiz) {
      if (answerInput) quiz.answers[quiz.index] = answerInput.value;
      saveLocalPendingQuiz(quiz);
    }
  });

  function quizError(msg) {
    const el = $('quiz-error');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
    if (msg) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  let submitting = false;
  async function submitQuiz() {
    if (submitting || !quiz) return;
    stopVoiceInput();
    if (answerInput) quiz.answers[quiz.index] = answerInput.value;
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
      result = await postJson(
        '/api/quizzes/submit',
        {
          telegramUserId: userId,
          quizId: quiz.quizId,
          answers: quiz.answers,
          chapter: quiz.chapter,
          questions: quiz.questions,
        },
        120000
      );
    } catch (e) {
      submitting = false;
      if (aiThinkingEl) aiThinkingEl.hidden = true;
      if (answerInput) answerInput.disabled = false;
      if (voiceBtn) voiceBtn.disabled = false;
      prev.disabled = quiz.index === 0;
      next.disabled = false;
      next.innerHTML = 'Try again <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>';
      if (e.status === 410) {
        clearPendingQuizForChapter(quiz.chapter);
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

    // Quiz is finished! Clear Pending status for this chapter and store the completed review
    clearPendingQuizForChapter(quiz.chapter);
    clearPendingQuizForChapter(result.chapter);
    saveLocalReviewBackup(result.chapter, result);

    const chInList = chapters.find(
      (x) =>
        String(x.id) === String(result.chapter?.id) ||
        chapterStorageKey(x) === chapterStorageKey(result.chapter)
    );
    if (chInList) {
      chInList.pending_quiz = null;
      chInList.result = {
        score: result.score,
        total: result.total,
        percentage: result.percentage,
        revision_tier: result.revision_tier,
        revision_message: result.revision_message,
        weak_subtopics: result.weak_subtopics || [],
        attempts: result.attempts || 1,
        review: result.review || [],
      };
    }

    quiz = null;
    showDone(result, { openReviewImmediately: false });
  }

  // ---------- Completion & Review Answers Screen (No Forced Auto-Redirect!) ----------
  function showDone(r, { openReviewImmediately = false } = {}) {
    activeDoneChapter =
      chapters.find(
        (x) =>
          String(x.id) === String(r.chapter?.id) ||
          chapterStorageKey(x) === chapterStorageKey(r.chapter)
      ) || r.chapter || null;

    const t = tone(r.percentage);
    $('done-ring').className = `qz-ring ${t}`;
    $('done-ring').style.setProperty('--p', r.percentage);
    $('done-pct').textContent = `${r.percentage}%`;
    $('done-title').textContent =
      r.percentage >= 80 ? 'Great work!' : r.percentage >= 50 ? 'Good effort' : 'Quiz complete';
    $('done-score').textContent = `${r.score} of ${r.total} correct · ${r.chapter?.title || ''}${
      r.attempts ? ` (Attempt #${r.attempts})` : ''
    }`;
    $('done-tier').textContent = r.revision_message || '';

    const weak = $('done-weak');
    const weakList = Array.isArray(r.weak_subtopics) ? r.weak_subtopics : [];
    weak.hidden = !weakList.length;
    weak.textContent = weakList.length ? `Focus on: ${weakList.join(', ')}` : '';

    const redirectMsg = $('done-redirect');
    if (redirectMsg) {
      redirectMsg.hidden = true;
      redirectMsg.textContent = '';
    }

    const rv = $('done-review');
    const reviewItems = Array.isArray(r.review) ? r.review : [];
    if (reviewItems.length > 0) {
      rv.innerHTML = reviewItems
        .map(
          (q, i) => `
        <div class="qz-rv ${q.correct ? 'ok' : ''}">
          <h4>${i + 1}. ${esc(q.question)}</h4>
          <p><b>Your answer:</b> ${q.userAnswer ? esc(q.userAnswer) : 'Skipped'} ${q.correct ? '✓' : '✗'}</p>
          ${q.feedback ? `<p><b>AI book check:</b> ${esc(q.feedback)}</p>` : ''}
          ${q.correct ? '' : `<p><b>Correct answer:</b> ${esc(q.expectedAnswer || '')}</p>`}
          <p>${esc(q.explanation || '')}</p>
        </div>`
        )
        .join('');
    } else {
      rv.innerHTML = `<div class="qz-rv ok"><p>Answer details for this earlier attempt were not stored. Click <b>Requiz (New Questions)</b> above to take a fresh quiz with full question-by-question AI book review!</p></div>`;
    }

    rv.hidden = !openReviewImmediately;
    const reviewBtnLabel = $('done-review-btn-label');
    if (reviewBtnLabel) {
      reviewBtnLabel.textContent = openReviewImmediately ? 'Hide review' : 'Review answers';
    }

    show('view-done');
    if (openReviewImmediately) {
      setTimeout(() => rv.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    } else {
      scrollTo({ top: 0 });
    }
  }

  $('done-review-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rv = $('done-review');
    const reviewBtnLabel = $('done-review-btn-label');
    if (!rv) return;
    const willShow = rv.hidden;
    rv.hidden = !willShow;
    if (reviewBtnLabel) {
      reviewBtnLabel.textContent = willShow ? 'Hide review' : 'Review answers';
    }
    if (willShow) {
      rv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  $('done-requiz-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (!activeDoneChapter) {
      backToChapters({ scroll: false });
      return;
    }
    clearPendingQuizForChapter(activeDoneChapter);
    startQuiz(activeDoneChapter, getEffectiveQuestionCount(activeDoneChapter));
  });

  $('done-back-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    backToChapters({ scroll: true });
  });

  async function backToChapters({ scroll }) {
    let ret = null;
    try { ret = JSON.parse(sessionStorage.getItem(RETURN_KEY) || 'null'); } catch {}
    currentView = 'view-chapters';
    const ok = await loadChapters({ silent: true, forceChaptersView: true });
    if (!ok) {
      await loadChapters();
      return;
    }
    if (ret && scroll) activeTab = 'all';
    renderChapters();
    show('view-chapters');
    if (!ret || !scroll) {
      scrollTo({ top: 0 });
      return;
    }
    const card = document.querySelector(`.qz-chapter[data-chapter-id="${CSS.escape(String(ret.chapterId))}"]`);
    const section = card?.closest('.qz-section');
    if (!card) return;
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    afterScroll(() => {
      card.classList.add('flash');
      sessionStorage.removeItem(RETURN_KEY);
    });
  }

  function afterScroll(cb) {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      removeEventListener('scrollend', go);
      cb();
    };
    addEventListener('scrollend', go, { once: true });
    setTimeout(go, 1000);
  }

  // Coming back from setup.html (other tab / back button): re-check and continue automatically.
  function recheckSetup() {
    if (currentView === 'view-setup' && getSetupStatus().complete) init();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheckSetup(); });
  addEventListener('pageshow', recheckSetup);
  addEventListener('focus', recheckSetup);

  init();
})();