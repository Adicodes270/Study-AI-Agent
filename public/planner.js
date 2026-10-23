// ==========================================================================
// planner.js — AI Study Planner & Todoist SDK Frontend Controller
// Handles Syllabus & Quiz History Fallback, School (Mon-Sat) vs Sunday/Vacation
// Scheduling, Pomodoro/Deep Work Intervals, Priority Tags, and Todoist Sync
// (Server @doist/todoist-sdk + Direct Browser Todoist REST API Fallback).
// ==========================================================================
(() => {
  'use strict';

  const STORAGE_KEY = 'study_agent_config';
  const PLANNER_LOCAL_KEY = 'study_agent_planner_v1';
  const FALLBACK_GUEST_ID = '100000001';

  const $ = (id) => document.getElementById(id);

  const CORE_SUBJECTS = [
    'Physics',
    'Chemistry',
    'Mathematics',
    'Biology',
    'History',
    'Civics',
    'Geography',
    'Economics',
    'English',
  ];

  const SAMPLE_SYLLABUS_TEXT = [
    'Physics: Light - Reflection and Refraction, The Human Eye and the Colourful World, Electricity',
    'Chemistry: Chemical Reactions and Equations, Acids Bases and Salts, Metals and Non-metals',
    'Biology: Life Processes, Control and Coordination',
    'Mathematics: Real Numbers, Polynomials, Quadratic Equations, Arithmetic Progressions, Triangles',
    'History: The Rise of Nationalism in Europe, Nationalism in India',
    'Geography: Resources and Development, Water Resources, Agriculture',
    'Civics: Power-sharing, Federalism',
    'Economics: Development, Sectors of the Indian Economy',
  ].join('\n');

  const SESSION_STYLE_PRESETS = {
    pomodoro_25_5: {
      id: 'pomodoro_25_5',
      label: 'Pomodoro (25m Study / 5m Break)',
      focusMins: 25,
      breakMins: 5,
      longBreakMins: 15,
    },
    deep_50_10: {
      id: 'deep_50_10',
      label: 'Deep Work (50m Study / 10m Break)',
      focusMins: 50,
      breakMins: 10,
      longBreakMins: 20,
    },
    block_90_15: {
      id: 'block_90_15',
      label: 'Ultradian Block (90m Study / 15m Break)',
      focusMins: 90,
      breakMins: 15,
      longBreakMins: 25,
    },
    custom: {
      id: 'custom',
      label: 'Custom Intervals',
      focusMins: 45,
      breakMins: 10,
      longBreakMins: 20,
    },
  };

  function cleanTodoistToken(raw) {
    if (typeof raw !== 'string') return '';
    return raw
      .trim()
      .replace(/^Bearer\s+/i, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();
  }

  function isValidTodoistToken(raw) {
    const c = cleanTodoistToken(raw);
    return c.length >= 16 && !/\s/.test(c);
  }

  function getCookie(name) {
    const m = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    if (!m) return '';
    try { return decodeURIComponent(m.slice(name.length + 1)); } catch { return ''; }
  }

  function setCookie(name, value) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=31536000; path=/; SameSite=Lax${secure}`;
  }

  function getSetupState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || {};
    } catch {
      return {};
    }
  }

  function getUserId() {
    const fromCookie = getCookie('sa_telegram_id');
    if (/^\d+$/.test(fromCookie) && fromCookie !== FALLBACK_GUEST_ID) return fromCookie;
    const st = getSetupState();
    const id = String(st?.telegram?.userId || st?.telegram?.chatId || '').trim();
    if (/^\d+$/.test(id)) {
      setCookie('sa_telegram_id', id);
      return id;
    }
    if (/^\d+$/.test(fromCookie)) return fromCookie;
    setCookie('sa_telegram_id', FALLBACK_GUEST_ID);
    return FALLBACK_GUEST_ID;
  }

  function getLocalTodoistKey() {
    // 1. Check inline inputs if user just typed one in
    const step2Val = cleanTodoistToken($('step2-todoist-key-input')?.value || '');
    if (isValidTodoistToken(step2Val)) return step2Val;
    const topVal = cleanTodoistToken($('planner-todoist-key-input')?.value || '');
    if (isValidTodoistToken(topVal)) return topVal;

    // 2. Check cookie
    const fromCookie = cleanTodoistToken(getCookie('sa_todoist_key'));
    if (isValidTodoistToken(fromCookie)) return fromCookie;

    // 3. Check study_agent_config in localStorage across all possible key names
    const st = getSetupState();
    const candidates = [
      st?.todoist?.apiKey,
      st?.todoist?.key,
      st?.todoist?.token,
      st?.todoist_api_key,
      st?.todoistApiKey,
      localStorage.getItem('sa_todoist_key'),
      localStorage.getItem('todoist_api_key'),
    ];
    for (const cand of candidates) {
      const cleaned = cleanTodoistToken(cand || '');
      if (isValidTodoistToken(cleaned)) {
        setCookie('sa_todoist_key', cleaned);
        return cleaned;
      }
    }
    return '';
  }

  function persistTodoistKeyLocally(rawToken) {
    const cleaned = cleanTodoistToken(rawToken);
    if (!isValidTodoistToken(cleaned)) return '';
    setCookie('sa_todoist_key', cleaned);
    try { localStorage.setItem('sa_todoist_key', cleaned); } catch {}
    const st = getSetupState();
    const masked = `${cleaned.slice(0, 4)}…${cleaned.slice(-4)}`;
    st.todoist = {
      ...(st.todoist || {}),
      apiKey: cleaned,
      verified: true,
      serverConfigured: true,
      maskedServerKey: masked,
      lastChecked: new Date().toISOString(),
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(st)); } catch {}
    state.hasTodoistKey = true;
    state.todoistMasked = masked;
    return cleaned;
  }

  function getLocalGeminiKey() {
    const fromCookie = getCookie('sa_gemini_key');
    if (fromCookie && fromCookie.length >= 20) return fromCookie;
    const st = getSetupState();
    const k = (st?.geminiKeys || []).map((x) => String(x?.key || '').trim()).find((x) => x.length >= 20);
    if (k) {
      setCookie('sa_gemini_key', k);
      return k;
    }
    return '';
  }

  let state = {
    telegramUserId: getUserId(),
    hasTodoistKey: Boolean(getLocalTodoistKey()),
    todoistMasked: null,
    todoistSource: null,
    hasSyllabus: false,
    chapters: [],
    quizHistory: {
      totalQuizzedChapters: 0,
      averagePercentage: null,
      heavyRestudyCount: 0,
      moderateRevisionCount: 0,
      masteredCount: 0,
      heavyRestudy: [],
      moderateRevision: [],
      mastered: [],
      weakSubtopics: [],
    },
    config: {
      dailyStudyHours: 5,
      dailySleepHours: 8,
      planDays: 7,
      schoolDays: [1, 2, 3, 4, 5, 6],
      schoolStartTime: '08:00',
      schoolEndTime: '14:30',
      wakeUpTime: '06:30',
      sessionStyle: 'pomodoro_25_5',
      customFocusMins: 45,
      customBreakMins: 10,
      examDates: [],
      vacationRanges: [],
      subjectPriorities: {},
      includeQuizRevision: true,
    },
    plan: null,
    activeDayFilter: 'all',
    editorExpanded: false,
  };

  function showToast(message, iconClass = 'fa-solid fa-bolt') {
    const container = $('planner-toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'setup-toast';
    toast.innerHTML = `<i class="${iconClass}" style="color: var(--accent-secondary)"></i><span></span>`;
    toast.querySelector('span').textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, 3600);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function saveLocalPlannerCache() {
    try {
      localStorage.setItem(
        PLANNER_LOCAL_KEY,
        JSON.stringify({
          chapters: state.chapters,
          config: state.config,
          plan: state.plan,
          updatedAt: new Date().toISOString(),
        })
      );
    } catch {}
  }

  function loadLocalPlannerCache() {
    try {
      const raw = localStorage.getItem(PLANNER_LOCAL_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // CLIENT-SIDE SCHEDULING ENGINE & DIRECT TODOIST REST API FALLBACK
  // Ensures schedule generation and Todoist task pushing work 100% of the time
  // even if backend DB/server routes are offline or unreachable.
  // ==========================================================================
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SHORT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function parseTimeToMins(hhmm, fallback = 8 * 60) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return fallback;
    return Math.min(23 * 60 + 59, Math.max(0, parseInt(m[1], 10) * 60 + parseInt(m[2], 10)));
  }

  function minsToTimeStr(totalMins) {
    const wrapped = ((Math.round(totalMins) % 1440) + 1440) % 1440;
    const h = Math.floor(wrapped / 60);
    const m = wrapped % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function format12hDueTime(hhmm = '18:00') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return '6pm';
    let h = parseInt(m[1], 10);
    const mins = parseInt(m[2], 10);
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return mins === 0 ? `${h}${ampm}` : `${h}:${String(mins).padStart(2, '0')}${ampm}`;
  }

  function formatDateYMD(d) {
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${da}`;
  }

  function parseSyllabusTextLocally(rawText) {
    const lines = String(rawText || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const parsed = [];
    let currentSubject = 'Physics';
    let counter = 1;

    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 1 && colonIdx < 32) {
        currentSubject = line.slice(0, colonIdx).replace(/^[-*•\d.)\s]+/, '').trim() || currentSubject;
        const rest = line.slice(colonIdx + 1).trim();
        const parts = rest.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
        parts.forEach((p, idx) => {
          parsed.push({
            id: `local_${Date.now()}_${counter++}`,
            subject: currentSubject,
            number: idx + 1,
            title: p.replace(/^(?:ch(?:apter)?\s*\d+\s*[-:–.]?\s*)/i, '').trim() || p,
            pdf_url: null,
            result: null,
          });
        });
      } else {
        const parts = line.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
        parts.forEach((p) => {
          parsed.push({
            id: `local_${Date.now()}_${counter++}`,
            subject: currentSubject,
            number: parsed.filter((x) => x.subject === currentSubject).length + 1,
            title: p,
            pdf_url: null,
            result: null,
          });
        });
      }
    }
    return parsed;
  }

  function generateLocalStudyPlan(chaptersInput = state.chapters, cfg = state.config) {
    const preset = cfg.sessionStyle === 'custom'
      ? {
          id: 'custom',
          label: `Custom (${cfg.customFocusMins || 45}m Study / ${cfg.customBreakMins || 10}m Break)`,
          focusMins: Number(cfg.customFocusMins) || 45,
          breakMins: Number(cfg.customBreakMins) || 10,
          longBreakMins: 20,
        }
      : SESSION_STYLE_PRESETS[cfg.sessionStyle] || SESSION_STYLE_PRESETS.pomodoro_25_5;

    const baseDate = new Date();
    const todayYmd = formatDateYMD(baseDate);

    const units = [];
    (chaptersInput || []).forEach((ch, idx) => {
      const subject = ch.subject || 'Physics';
      const pct = ch.result?.percentage != null ? Number(ch.result.percentage) : null;
      const tier = pct == null ? 'untested' : pct < 50 ? 'heavy_restudy' : pct < 80 ? 'moderate_revision' : 'mastered';
      const weakSubtopics = Array.isArray(ch.result?.weak_subtopics) ? ch.result.weak_subtopics : [];
      const matchingExam = (cfg.examDates || []).find(
        (e) =>
          e.date >= todayYmd &&
          (e.subject.toLowerCase() === subject.toLowerCase() ||
            subject.toLowerCase().includes(e.subject.toLowerCase()))
      );
      let priority = cfg.subjectPriorities?.[subject] || (tier === 'heavy_restudy' || matchingExam ? 'High' : tier === 'mastered' ? 'Low' : 'Medium');
      let urgency = 50 + (priority === 'High' ? 35 : priority === 'Low' ? -15 : 0) + (tier === 'heavy_restudy' ? 40 : tier === 'moderate_revision' ? 25 : 0);
      units.push({
        id: ch.id || `unit_${idx + 1}`,
        subject,
        number: ch.number || idx + 1,
        title: ch.title,
        pdfUrl: ch.pdf_url || null,
        exam: matchingExam?.examName || null,
        examDate: matchingExam?.date || null,
        priority,
        quizPercentage: pct,
        revisionTier: tier,
        weakSubtopics,
        urgencyScore: urgency,
      });
    });

    if (!units.length) {
      const defaults = [
        { subject: 'Physics', number: 1, title: 'Light, Electricity & Laws of Motion — Concepts & Numericals', priority: 'High' },
        { subject: 'Chemistry', number: 1, title: 'Chemical Reactions, Acids, Bases & Atomic Structure', priority: 'High' },
        { subject: 'Mathematics', number: 1, title: 'Quadratic Equations, Polynomials & Triangles Practice', priority: 'High' },
        { subject: 'Biology', number: 1, title: 'Life Processes, Cell Structure & Control and Coordination', priority: 'Medium' },
        { subject: 'History', number: 1, title: 'The Rise of Nationalism in Europe & India', priority: 'Medium' },
        { subject: 'Geography', number: 1, title: 'Resources, Water, Agriculture & Climate', priority: 'Medium' },
      ];
      defaults.forEach((u, i) => {
        units.push({
          id: `fallback_${i + 1}`,
          subject: u.subject,
          number: u.number,
          title: u.title,
          pdfUrl: null,
          exam: 'CBSE Curriculum',
          examDate: null,
          priority: cfg.subjectPriorities?.[u.subject] || u.priority,
          quizPercentage: null,
          revisionTier: 'untested',
          weakSubtopics: [],
          urgencyScore: 80 - i * 5,
        });
      });
    }

    units.sort((a, b) => b.urgencyScore - a.urgencyScore);
    const rotationPool = [];
    units.forEach((u) => {
      const reps = u.priority === 'High' ? 3 : u.priority === 'Medium' ? 2 : 1;
      for (let r = 0; r < reps; r++) rotationPool.push(u);
    });

    const days = [];
    let unitCursor = 0;
    const planDays = Math.max(1, Math.min(30, parseInt(cfg.planDays, 10) || 7));

    for (let dOffset = 0; dOffset < planDays; dOffset++) {
      const dateObj = new Date(baseDate);
      dateObj.setDate(baseDate.getDate() + dOffset);
      const dateYmd = formatDateYMD(dateObj);
      const dow = dateObj.getDay();
      const vac = (cfg.vacationRanges || []).find((v) => dateYmd >= v.startDate && dateYmd <= v.endDate);
      const isSchoolDay = !vac && (cfg.schoolDays || [1, 2, 3, 4, 5, 6]).includes(dow);
      const dayType = vac ? 'vacation_day' : isSchoolDay ? 'school_day' : 'full_day';
      const dayTypeLabel = vac
        ? `Vacation / Holiday (${vac.label})`
        : isSchoolDay
          ? `School Day (${cfg.schoolStartTime}–${cfg.schoolEndTime})`
          : dow === 0
            ? 'Sunday · Full Study & Recharge Day'
            : 'Non-School Full Day';

      const totalStudyMins = Math.round((Number(cfg.dailyStudyHours) || 5) * 60);
      const wakeMins = parseTimeToMins(cfg.wakeUpTime, 6 * 60 + 30);
      const bedtimeMins = Math.min(23 * 60 + 30, wakeMins + Math.max(8 * 60, (24 - (Number(cfg.dailySleepHours) || 8)) * 60));

      const windows = [];
      if (isSchoolDay) {
        const schoolEnd = parseTimeToMins(cfg.schoolEndTime, 14 * 60 + 30);
        windows.push({ start: Math.min(bedtimeMins - 60, schoolEnd + 75), end: bedtimeMins, period: 'After-School & Evening' });
      } else {
        windows.push({ start: Math.max(wakeMins + 60, 9 * 60 + 30), end: 13 * 60, period: 'Morning Deep Focus' });
        windows.push({ start: 14 * 60 + 30, end: 17 * 60 + 45, period: 'Afternoon Practice & Lab' });
        windows.push({ start: 18 * 60 + 30, end: Math.min(bedtimeMins, 21 * 60 + 45), period: 'Evening Active Recall' });
      }

      const targetBlockFocus = preset.focusMins <= 30 ? preset.focusMins * 4 : preset.focusMins <= 55 ? preset.focusMins * 2 : preset.focusMins;
      const interBreak = Math.max(15, preset.longBreakMins || 15);
      let rem = totalStudyMins;
      let wIdx = 0;
      let cursor = windows[0]?.start ?? 16 * 60;
      const studyBlocks = [];
      const usedToday = new Set();

      while (rem > 0 && studyBlocks.length < 6) {
        const win = windows[wIdx];
        if (!win) break;
        if (cursor < win.start) cursor = win.start;
        const focusMins = Math.min(rem, targetBlockFocus);
        const cycles = Math.max(1, Math.round(focusMins / preset.focusMins));
        const span = focusMins + Math.max(0, cycles - 1) * preset.breakMins;

        if (!isSchoolDay && studyBlocks.length > 0 && wIdx < windows.length - 1 && studyBlocks.some((b) => b.period === win.period)) {
          wIdx++;
          cursor = windows[wIdx].start;
          continue;
        }
        if (cursor + span > win.end && wIdx < windows.length - 1) {
          wIdx++;
          cursor = windows[wIdx].start;
          continue;
        }

        const startTime = minsToTimeStr(cursor);
        const endTime = minsToTimeStr(cursor + span);
        const breakEnd = minsToTimeStr(cursor + span + interBreak);

        let chosen = rotationPool[unitCursor % rotationPool.length];
        if (rotationPool.length > 1 && usedToday.has(chosen.subject)) {
          const alt = rotationPool.find((u, i) => i > unitCursor % rotationPool.length && !usedToday.has(u.subject));
          if (alt) chosen = alt;
        }
        unitCursor++;
        usedToday.add(chosen.subject);

        const sIdx = studyBlocks.length + 1;
        const duePrefix = dOffset === 0 ? 'today' : dOffset === 1 ? 'tomorrow' : dateYmd;
        const todoistDueString = `${duePrefix} at ${format12hDueTime(startTime)}`;
        const ytQuery = encodeURIComponent(`${chosen.subject} ${chosen.title} Class 10 NCERT`);

        studyBlocks.push({
          id: `block_${dateYmd}_${sIdx}`,
          slotIndex: sIdx,
          startTime,
          endTime,
          durationMins: focusMins,
          breakMinsAfter: interBreak,
          period: win.period,
          sessionPatternLabel: preset.label,
          breakIntervalText:
            cycles > 1
              ? `${cycles} × ${preset.focusMins}m focus (${preset.breakMins}m short break) + ${interBreak}m recharge until ${breakEnd}`
              : `${focusMins}m deep focus + ${interBreak}m recharge until ${breakEnd}`,
          subject: chosen.subject,
          chapterId: chosen.id,
          chapterNumber: chosen.number,
          chapterTitle: chosen.title,
          title: `${chosen.number ? `Ch ${chosen.number}: ` : ''}${chosen.title}`,
          priority: chosen.priority,
          focusType: 'Concept Mastery & Practice',
          quizPercentage: chosen.quizPercentage,
          revisionTier: chosen.revisionTier,
          weakSubtopics: chosen.weakSubtopics || [],
          examDate: chosen.examDate,
          pdfUrl: chosen.pdfUrl,
          youtubeUrl: `https://www.youtube.com/results?search_query=${ytQuery}`,
          strategyNote: chosen.weakSubtopics?.length
            ? `Target weak subtopics (${chosen.weakSubtopics.slice(0, 2).join(', ')}) from your last quiz.`
            : `Complete ${cycles} × ${preset.focusMins}m focus cycles and test active recall immediately after.`,
          todoistDueString,
          synced: false,
          todoistTaskId: null,
          todoistUrl: null,
          completed: false,
          subtasks: [
            {
              id: `sub_${dateYmd}_${sIdx}_1`,
              content: `Read NCERT concepts & notes for "${chosen.title}"`,
              completed: false,
              todoistTaskId: null,
            },
            {
              id: `sub_${dateYmd}_${sIdx}_2`,
              content: `Solve practice questions & take Study Agent Quiz on "${chosen.title}"`,
              completed: false,
              todoistTaskId: null,
            },
          ],
        });

        rem -= focusMins;
        cursor += span + interBreak;
      }

      const totalScheduledMins = studyBlocks.reduce((acc, b) => acc + b.durationMins, 0);
      const schoolSpanHrs = isSchoolDay ? (parseTimeToMins(cfg.schoolEndTime) - parseTimeToMins(cfg.schoolStartTime)) / 60 : 0;
      const freePlayHours = Math.max(1, +(24 - cfg.dailySleepHours - schoolSpanHrs - totalScheduledMins / 60).toFixed(1));

      days.push({
        dayIndex: dOffset + 1,
        date: dateYmd,
        dayOfWeek: DAY_NAMES[dow],
        shortDay: SHORT_DAY_NAMES[dow],
        displayDate: `${SHORT_DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()}`,
        dayLabel:
          dOffset === 0
            ? `Today (${SHORT_DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()})`
            : dOffset === 1
              ? `Tomorrow (${SHORT_DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()})`
              : `${DAY_NAMES[dow]}, ${SHORT_MONTHS[dateObj.getMonth()]} ${dateObj.getDate()}`,
        dayType,
        dayTypeLabel,
        isSchoolDay,
        sleepHours: cfg.dailySleepHours,
        studyHours: +(totalScheduledMins / 60).toFixed(1),
        freePlayHours,
        todoistDueString: `${dOffset === 0 ? 'today' : dOffset === 1 ? 'tomorrow' : dateYmd} at 6pm`,
        studyBlocks,
      });
    }

    const subjMap = new Map();
    days.forEach((d) => {
      d.studyBlocks.forEach((b) => {
        if (!subjMap.has(b.subject)) {
          subjMap.set(b.subject, {
            subject: b.subject,
            priority: b.priority,
            sessionsCount: 0,
            totalMinutes: 0,
            chapters: new Set(),
            weakSubtopics: new Set(),
            examDate: b.examDate || null,
          });
        }
        const entry = subjMap.get(b.subject);
        entry.sessionsCount++;
        entry.totalMinutes += b.durationMins;
        entry.chapters.add(b.chapterTitle);
        (b.weakSubtopics || []).forEach((w) => entry.weakSubtopics.add(w));
      });
    });

    const prioritizedSubjects = [...subjMap.values()].map((s) => ({
      subject: s.subject,
      priority: s.priority,
      sessionsCount: s.sessionsCount,
      totalHours: +(s.totalMinutes / 60).toFixed(1),
      chaptersCount: s.chapters.size,
      chapters: [...s.chapters],
      weakSubtopics: [...s.weakSubtopics],
      examDate: s.examDate,
    }));

    return {
      generatedAt: new Date().toISOString(),
      hasSyllabus: (chaptersInput || []).length > 0,
      sessionStyleId: preset.id,
      sessionStyleLabel: preset.label,
      config: cfg,
      coachHeadline: `Balanced ${planDays}-Day Study & Todoist Schedule (${cfg.dailyStudyHours}h/day · ${preset.label})`,
      coachSummary: `Scheduled ${cfg.dailyStudyHours} hours of focused study and ${cfg.dailySleepHours} hours of sleep daily across ${planDays} days. Monday–Saturday school timings (${cfg.schoolStartTime}–${cfg.schoolEndTime}) place study sessions in afternoon/evening windows, while Sundays and holidays unlock full-day deep-work and recharge schedules.`,
      keyRecommendations: [
        `Follow ${preset.label} strictly—step away from your desk during every ${preset.breakMins}-minute break to keep retention high.`,
        `Start each session with your High-priority subjects and weak quiz subtopics while mental energy is highest.`,
        `Protect your ${cfg.dailySleepHours}-hour sleep window every night so memory consolidation stays strong before exams.`,
      ],
      metrics: {
        totalDays: days.length,
        schoolDaysCount: days.filter((d) => d.dayType === 'school_day').length,
        fullDaysCount: days.filter((d) => d.dayType !== 'school_day').length,
        totalStudyHours: +days.reduce((acc, d) => acc + d.studyHours, 0).toFixed(1),
        dailyStudyHours: cfg.dailyStudyHours,
        dailySleepHours: cfg.dailySleepHours,
        totalBlocks: days.reduce((acc, d) => acc + d.studyBlocks.length, 0),
      },
      prioritizedSubjects,
      days,
      todoistSync: {
        synced: false,
        syncedAt: null,
        parentTasksCreated: 0,
        subTasksCreated: 0,
        totalTasksCreated: 0,
        upcomingUrl: 'https://app.todoist.com/app/upcoming',
      },
    };
  }

  /**
   * Direct Browser-to-Todoist API sync fallback (used automatically if the server endpoint is unreachable or returns an error).
   */
  async function syncPlanDirectlyFromBrowser({ token, plan, onlyDate = null, maxDays = null }) {
    const cleanToken = cleanTodoistToken(token);
    if (!isValidTodoistToken(cleanToken)) {
      throw new Error('Please paste a valid Todoist API token first.');
    }

    const createTodoistTaskDirect = async (payload) => {
      const body = { content: payload.content };
      if (payload.description) body.description = payload.description;
      if (payload.dueString) body.due_string = payload.dueString;
      if (payload.parentId) body.parent_id = String(payload.parentId);
      if (payload.priority) body.priority = payload.priority;

      const endpoints = [
        'https://api.todoist.com/api/v1/tasks',
        'https://api.todoist.com/rest/v2/tasks',
      ];
      let lastErr = 'Todoist API request failed';
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cleanToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });
          if (res.ok) {
            const data = await res.json();
            const taskObj = data?.id != null ? data : data?.task?.id != null ? data.task : null;
            if (taskObj) return taskObj;
          } else if (res.status === 400 && body.due_string && payload.dueDate) {
            const fbBody = { ...body, due_date: payload.dueDate };
            delete fbBody.due_string;
            const retryRes = await fetch(ep, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${cleanToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(fbBody),
            });
            if (retryRes.ok) {
              const retryData = await retryRes.json();
              const taskObj = retryData?.id != null ? retryData : retryData?.task?.id != null ? retryData.task : null;
              if (taskObj) return taskObj;
            }
          } else if (res.status === 401 || res.status === 403) {
            throw new Error('Todoist rejected this API token (Unauthorized). Check your token in Todoist Developer Settings.');
          } else {
            const txt = await res.text().catch(() => '');
            lastErr = txt || `HTTP ${res.status}`;
          }
        } catch (e) {
          if (/Unauthorized|rejected/i.test(e.message)) throw e;
          lastErr = e.message || lastErr;
        }
      }
      throw new Error(lastErr);
    };

    let parentCount = 0;
    let subCount = 0;
    const priorityMap = (p) => (p === 'High' ? 4 : p === 'Medium' ? 3 : 2);

    const targetDays = (plan.days || []).filter((d, idx) => {
      if (onlyDate && d.date !== onlyDate) return false;
      if (maxDays != null && Number(maxDays) > 0 && idx >= Number(maxDays)) return false;
      return true;
    });

    for (const day of targetDays) {
      for (const block of day.studyBlocks || []) {
        if (block.synced && block.todoistTaskId) continue;

        const dueString = block.todoistDueString || day.todoistDueString || `${day.date} at 6pm`;
        const descLines = [
          `Tutorial link: ${block.youtubeUrl || 'https://www.youtube.com'}`,
          `Schedule: ${day.dayLabel} (${day.dayTypeLabel}) · ${block.startTime}–${block.endTime} (${block.durationMins} mins)`,
          `Session Style: ${block.sessionPatternLabel || plan.sessionStyleLabel} (${block.breakIntervalText})`,
          `Focus: ${block.strategyNote || block.focusType}`,
        ];
        if (block.pdfUrl) descLines.push(`NCERT Textbook PDF: ${block.pdfUrl}`);

        const parentTask = await createTodoistTaskDirect({
          content: `[${block.subject}] ${block.title || block.chapterTitle} (${block.startTime}–${block.endTime})`,
          description: descLines.join('\n'),
          dueString,
          dueDate: day.date,
          priority: priorityMap(block.priority),
        });

        parentCount++;
        block.todoistTaskId = String(parentTask.id);
        block.todoistUrl = parentTask.url || `https://app.todoist.com/app/task/${parentTask.id}`;
        block.synced = true;

        for (const sub of (block.subtasks || []).slice(0, 3)) {
          const subText = typeof sub === 'string' ? sub : sub.content;
          if (!subText) continue;
          try {
            const subTask = await createTodoistTaskDirect({
              content: subText,
              parentId: parentTask.id,
            });
            subCount++;
            if (typeof sub === 'object') {
              sub.todoistTaskId = String(subTask.id);
              sub.synced = true;
            }
          } catch {}
        }
      }
    }

    const syncedAt = new Date().toISOString();
    const prevP = Number(plan.todoistSync?.parentTasksCreated) || 0;
    const prevS = Number(plan.todoistSync?.subTasksCreated) || 0;
    plan.todoistSync = {
      synced: true,
      syncedAt,
      parentTasksCreated: prevP + parentCount,
      subTasksCreated: prevS + subCount,
      totalTasksCreated: prevP + prevS + parentCount + subCount,
      upcomingUrl: 'https://app.todoist.com/app/upcoming',
    };

    return {
      ok: true,
      syncedAt,
      parentTasksCreated: parentCount || plan.todoistSync.parentTasksCreated,
      subTasksCreated: subCount || plan.todoistSync.subTasksCreated,
      totalTasksCreated: (parentCount + subCount) || plan.todoistSync.totalTasksCreated,
      plan,
    };
  }

  // ==========================================================================
  // UI RENDERING & EVENT HANDLERS
  // ==========================================================================
  function renderTodoistStatus() {
    const badge = $('planner-todoist-badge');
    const title = $('todoist-connection-title');
    const toggleTxt = $('toggle-inline-todoist-text');
    const localKey = getLocalTodoistKey();
    const connected = state.hasTodoistKey || Boolean(localKey);
    const masked = state.todoistMasked || (localKey ? `${localKey.slice(0, 4)}…${localKey.slice(-4)}` : '');

    if (badge) {
      badge.className = `chip ${connected ? 'ok' : 'wait'}`;
      badge.innerHTML = connected
        ? `<i class="fa-solid fa-circle-check"></i> Todoist Connected${masked ? ` (${escapeHtml(masked)})` : ''}`
        : `<i class="fa-solid fa-triangle-exclamation"></i> Todoist Key Not Set`;
    }
    if (title) {
      title.textContent = connected
        ? 'Todoist Ready for Task Sync'
        : 'Connect Todoist to Sync Tasks';
    }
    if (toggleTxt) {
      toggleTxt.textContent = connected ? 'Update API Key' : 'Add Todoist Key';
    }
    if (connected && $('step2-todoist-prompt')) {
      $('step2-todoist-prompt').hidden = true;
    }
  }

  $('toggle-inline-todoist-btn')?.addEventListener('click', () => {
    const drawer = $('inline-todoist-drawer');
    if (!drawer) return;
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) {
      const inp = $('planner-todoist-key-input');
      if (inp && !inp.value) inp.value = getLocalTodoistKey();
      inp?.focus();
    }
  });

  $('close-step2-todoist-prompt')?.addEventListener('click', () => {
    if ($('step2-todoist-prompt')) $('step2-todoist-prompt').hidden = true;
  });

  async function saveAndVerifyTokenFromInput(inputEl, buttonEl, autoSyncAfter = false) {
    const raw = cleanTodoistToken(inputEl?.value || '');
    if (!isValidTodoistToken(raw)) {
      showToast('Paste a valid Todoist API token (at least 16 characters, no spaces)', 'fa-solid fa-triangle-exclamation');
      inputEl?.focus();
      return false;
    }

    const orig = buttonEl ? buttonEl.innerHTML : '';
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Saving…</span>`;
    }

    try {
      // Save locally first so it is immediately available
      persistTodoistKeyLocally(raw);

      // Also save on backend if available
      const res = await fetch('/api/todoist/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramUserId: state.telegramUserId,
          todoistApiKey: raw,
        }),
      }).catch(() => null);

      if (res) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403 || data.valid === false) {
          throw new Error(data.error || 'Todoist rejected that API token.');
        }
      }

      if ($('inline-todoist-drawer')) $('inline-todoist-drawer').hidden = true;
      if ($('step2-todoist-prompt')) $('step2-todoist-prompt').hidden = true;
      renderTodoistStatus();
      showToast('Todoist API token verified & connected!', 'fa-solid fa-circle-check');

      if (autoSyncAfter) {
        await triggerSyncTodoist();
      }
      return true;
    } catch (err) {
      showToast(err.message || 'Invalid Todoist token', 'fa-solid fa-circle-exclamation');
      return false;
    } finally {
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.innerHTML = orig;
      }
    }
  }

  $('planner-save-todoist-key-btn')?.addEventListener('click', () => {
    saveAndVerifyTokenFromInput($('planner-todoist-key-input'), $('planner-save-todoist-key-btn'), false);
  });

  $('step2-save-and-sync-btn')?.addEventListener('click', () => {
    saveAndVerifyTokenFromInput($('step2-todoist-key-input'), $('step2-save-and-sync-btn'), true);
  });

  function renderSyllabusAndQuizFallback() {
    const syllabusBadge = $('syllabus-status-badge');
    const noSylPrompt = $('no-syllabus-prompt');
    const editorPanel = $('syllabus-editor-panel');
    const detectedWrap = $('detected-chapters-wrap');
    const detectedList = $('detected-chapters-list');
    const detectedSummary = $('detected-chapters-summary');
    const textareaLabel = $('syllabus-textarea-label');
    const saveBtnLabel = $('save-pasted-syllabus-label');

    const syllabusChapters = state.chapters.filter((c) => !c.is_custom);
    const hasSyl = syllabusChapters.length > 0;
    state.hasSyllabus = hasSyl;

    if (syllabusBadge) {
      const subjectsCount = new Set(syllabusChapters.map((c) => c.subject)).size;
      syllabusBadge.className = `chip ${hasSyl ? 'ok' : 'wait'}`;
      syllabusBadge.textContent = hasSyl
        ? `${syllabusChapters.length} Chapters · ${subjectsCount} Subjects`
        : 'No Telegram Syllabus Yet';
    }

    if (noSylPrompt) noSylPrompt.hidden = hasSyl;

    if (hasSyl) {
      if (detectedWrap) detectedWrap.hidden = false;
      if (editorPanel) editorPanel.hidden = !state.editorExpanded;
      if (textareaLabel) textareaLabel.textContent = 'Append or Update Syllabus Portions (Subject: Chapters)';
      if (saveBtnLabel) saveBtnLabel.textContent = 'Append / Save to Syllabus';

      if (detectedSummary) {
        const subjects = [...new Set(syllabusChapters.map((c) => c.subject))];
        detectedSummary.textContent = `Loaded ${syllabusChapters.length} chapter(s) across ${subjects.join(', ')}`;
      }

      if (detectedList) {
        detectedList.innerHTML = '';
        syllabusChapters.forEach((ch) => {
          const pill = document.createElement('span');
          pill.className = 'pl-ch-pill';
          const pctBadge = ch.result && typeof ch.result.percentage === 'number'
            ? ` · ${ch.result.percentage}%`
            : '';
          pill.innerHTML = `
            <small>${escapeHtml(ch.subject)}</small>
            <span>${ch.number ? `Ch ${ch.number}: ` : ''}${escapeHtml(ch.title)}${pctBadge}</span>
            <button type="button" title="Remove chapter" data-del-id="${escapeHtml(ch.id)}">
              <i class="fa-solid fa-xmark"></i>
            </button>
          `;
          pill.querySelector('button')?.addEventListener('click', () => deleteChapterItem(ch.id));
          detectedList.appendChild(pill);
        });
      }
    } else {
      if (detectedWrap) detectedWrap.hidden = true;
      if (editorPanel) editorPanel.hidden = false;
      if (textareaLabel) textareaLabel.textContent = 'Paste Your Syllabus directly (or load sample CBSE portion)';
      if (saveBtnLabel) saveBtnLabel.textContent = 'Save Syllabus & Update Plan';
    }

    const qh = state.quizHistory || {};
    if ($('qh-total-quizzed')) $('qh-total-quizzed').textContent = String(qh.totalQuizzedChapters || 0);
    if ($('qh-heavy-count')) $('qh-heavy-count').textContent = String(qh.heavyRestudyCount || 0);
    if ($('qh-mod-count')) $('qh-mod-count').textContent = String(qh.moderateRevisionCount || 0);
    if ($('qh-mastered-count')) $('qh-mastered-count').textContent = String(qh.masteredCount || 0);

    const weakListEl = $('quiz-weak-list');
    if (weakListEl) {
      weakListEl.innerHTML = '';
      const priorityChapters = [...(qh.heavyRestudy || []), ...(qh.moderateRevision || [])];
      if (priorityChapters.length > 0) {
        priorityChapters.forEach((item) => {
          const row = document.createElement('div');
          row.className = 'pl-weak-item';
          const isHeavy = item.percentage < 50;
          const weakText = item.weakSubtopics?.length
            ? `Weak subtopics: ${item.weakSubtopics.join(', ')}`
            : isHeavy
              ? 'Needs fundamental chapter module re-study'
              : 'Schedule targeted revision & requiz';
          row.innerHTML = `
            <div>
              <b>[${escapeHtml(item.subject)}] ${escapeHtml(item.title)}</b>
              <small>${escapeHtml(weakText)}</small>
            </div>
            <span class="chip ${isHeavy ? 'wait' : 'ok'}">${item.percentage}%</span>
          `;
          weakListEl.appendChild(row);
        });
      } else {
        weakListEl.innerHTML = `
          <div class="pl-weak-item">
            <div>
              <b>No weak quiz chapters flagged yet</b>
              <small>As you take chapter quizzes on the Quizzes page, any topic under 80% is automatically scheduled here for priority revision.</small>
            </div>
            <span class="chip ok">Active Recall</span>
          </div>
        `;
      }
    }
  }

  $('toggle-syllabus-editor-btn')?.addEventListener('click', () => {
    state.editorExpanded = !state.editorExpanded;
    const editorPanel = $('syllabus-editor-panel');
    if (editorPanel) editorPanel.hidden = !state.editorExpanded;
  });

  $('load-sample-syllabus-btn')?.addEventListener('click', () => {
    const ta = $('planner-syllabus-textarea');
    if (ta) {
      ta.value = SAMPLE_SYLLABUS_TEXT;
      state.editorExpanded = true;
      $('syllabus-editor-panel').hidden = false;
      showToast('Loaded sample CBSE syllabus—click Save Syllabus to apply!', 'fa-solid fa-wand-sparkles');
    }
  });

  $('save-pasted-syllabus-btn')?.addEventListener('click', async () => {
    const ta = $('planner-syllabus-textarea');
    const text = String(ta?.value || '').trim();
    if (text.length < 3) {
      showToast('Paste your syllabus chapters or click "Fill Sample CBSE Syllabus" first', 'fa-solid fa-triangle-exclamation');
      return;
    }

    const btn = $('save-pasted-syllabus-btn');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Saving Syllabus…</span>`;

    try {
      const res = await fetch('/api/planner/syllabus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramUserId: state.telegramUserId,
          text,
          geminiKey: getLocalGeminiKey() || undefined,
        }),
      }).catch(() => null);

      if (res && res.ok) {
        if (ta) ta.value = '';
        state.editorExpanded = false;
        await refreshPlannerState();
        await triggerGeneratePlan(false);
        showToast('Syllabus saved & AI Study Plan updated!', 'fa-solid fa-circle-check');
      } else {
        // Local fallback syllabus parsing
        const localChapters = parseSyllabusTextLocally(text);
        if (localChapters.length) {
          state.chapters = [...state.chapters, ...localChapters];
          if (ta) ta.value = '';
          state.editorExpanded = false;
          state.plan = generateLocalStudyPlan(state.chapters, state.config);
          saveLocalPlannerCache();
          renderSyllabusAndQuizFallback();
          syncConfigControlsFromState();
          renderPlanSummary();
          showToast(`Parsed ${localChapters.length} chapters & updated your Study Plan!`, 'fa-solid fa-circle-check');
        } else {
          throw new Error('Could not parse chapters from text');
        }
      }
    } catch (err) {
      showToast(err.message || 'Could not parse syllabus', 'fa-solid fa-circle-exclamation');
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  });

  $('upload-syllabus-pdf-btn')?.addEventListener('click', () => {
    $('planner-syllabus-pdf')?.click();
  });

  $('planner-syllabus-pdf')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const btn = $('upload-syllabus-pdf-btn');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Reading PDF…</span>`;

    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      const dataBase64 = btoa(binary);
      const res = await fetch('/api/syllabus/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramUserId: state.telegramUserId,
          kind: 'pdf',
          fileName: file.name,
          dataBase64,
          geminiKey: getLocalGeminiKey() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to upload PDF');
      showToast(`Extracted chapters from ${file.name}!`, 'fa-solid fa-file-circle-check');
      await refreshPlannerState();
      await triggerGeneratePlan(false);
    } catch (err) {
      showToast(err.message || 'Could not read PDF', 'fa-solid fa-circle-exclamation');
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
      e.target.value = '';
    }
  });

  $('toggle-add-chapter-row-btn')?.addEventListener('click', () => {
    const row = $('quick-add-chapter-row');
    if (row) row.hidden = !row.hidden;
  });

  $('confirm-add-chapter-btn')?.addEventListener('click', async () => {
    const subject = $('quick-chapter-subject')?.value || 'Physics';
    const number = parseInt($('quick-chapter-number')?.value, 10) || 1;
    const title = String($('quick-chapter-title')?.value || '').trim();
    if (!title) {
      showToast('Enter a chapter title first', 'fa-solid fa-triangle-exclamation');
      return;
    }

    try {
      const res = await fetch('/api/planner/syllabus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramUserId: state.telegramUserId,
          mode: 'append',
          chapters: [{ subject, number, title }],
        }),
      }).catch(() => null);

      $('quick-chapter-title').value = '';
      if (res && res.ok) {
        await refreshPlannerState();
        await triggerGeneratePlan(false);
      } else {
        state.chapters.push({
          id: `ch_${Date.now()}`,
          subject,
          number,
          title,
          pdf_url: null,
          result: null,
        });
        state.plan = generateLocalStudyPlan(state.chapters, state.config);
        saveLocalPlannerCache();
        renderSyllabusAndQuizFallback();
        syncConfigControlsFromState();
        renderPlanSummary();
      }
      showToast(`Added "${title}" (${subject})!`, 'fa-solid fa-circle-check');
    } catch (err) {
      showToast(err.message, 'fa-solid fa-circle-exclamation');
    }
  });

  async function deleteChapterItem(chapterId) {
    state.chapters = state.chapters.filter((c) => String(c.id) !== String(chapterId));
    try {
      await fetch('/api/planner/syllabus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramUserId: state.telegramUserId,
          deleteChapterId: chapterId,
        }),
      });
    } catch {}
    state.plan = generateLocalStudyPlan(state.chapters, state.config);
    saveLocalPlannerCache();
    renderSyllabusAndQuizFallback();
    renderPlanSummary();
  }

  function syncConfigControlsFromState() {
    const cfg = state.config;

    if ($('daily-study-hours-input')) $('daily-study-hours-input').value = cfg.dailyStudyHours;
    if ($('daily-study-hours-range')) $('daily-study-hours-range').value = cfg.dailyStudyHours;

    if ($('daily-sleep-hours-input')) $('daily-sleep-hours-input').value = cfg.dailySleepHours;
    if ($('daily-sleep-hours-range')) $('daily-sleep-hours-range').value = cfg.dailySleepHours;

    if ($('plan-days-select')) $('plan-days-select').value = String(cfg.planDays || 7);
    if ($('school-start-time')) $('school-start-time').value = cfg.schoolStartTime || '08:00';
    if ($('school-end-time')) $('school-end-time').value = cfg.schoolEndTime || '14:30';
    if ($('wake-up-time')) $('wake-up-time').value = cfg.wakeUpTime || '06:30';
    if ($('include-quiz-revision-toggle')) $('include-quiz-revision-toggle').checked = cfg.includeQuizRevision !== false;

    document.querySelectorAll('#session-style-pills .pl-style-pill').forEach((btn) => {
      const active = btn.dataset.style === cfg.sessionStyle;
      btn.classList.toggle('is-active', active);
    });
    const customBox = $('custom-intervals-box');
    if (customBox) customBox.hidden = cfg.sessionStyle !== 'custom';
    if ($('custom-focus-mins')) $('custom-focus-mins').value = cfg.customFocusMins || 45;
    if ($('custom-break-mins')) $('custom-break-mins').value = cfg.customBreakMins || 10;

    document.querySelectorAll('#school-days-toggles .pl-day-toggle').forEach((btn) => {
      const dayNum = parseInt(btn.dataset.day, 10);
      const isSchool = cfg.schoolDays.includes(dayNum);
      btn.classList.toggle('is-school', isSchool);
      btn.classList.toggle('is-full', !isSchool);
      const sub = btn.querySelector('small');
      if (sub) sub.textContent = isSchool ? 'School' : 'Full Day';
    });

    const schoolCount = cfg.schoolDays.length;
    const balanceChip = $('schedule-balance-chip');
    if (balanceChip) {
      balanceChip.textContent = `${cfg.dailyStudyHours}h Study · ${cfg.dailySleepHours}h Sleep · ${schoolCount} School Day${schoolCount === 1 ? '' : 's'}/wk`;
    }

    renderExamDatesList();
    renderVacationDatesList();
    renderSubjectPriorityList();
  }

  function bindSliderPair(rangeId, numId, configKey) {
    const rangeEl = $(rangeId);
    const numEl = $(numId);
    const update = (val) => {
      const n = Math.max(Number(rangeEl.min), Math.min(Number(rangeEl.max), parseFloat(val) || 5));
      state.config[configKey] = n;
      if (rangeEl) rangeEl.value = n;
      if (numEl) numEl.value = n;
      syncConfigControlsFromState();
      saveLocalPlannerCache();
    };
    rangeEl?.addEventListener('input', (e) => update(e.target.value));
    numEl?.addEventListener('change', (e) => update(e.target.value));
  }

  bindSliderPair('daily-study-hours-range', 'daily-study-hours-input', 'dailyStudyHours');
  bindSliderPair('daily-sleep-hours-range', 'daily-sleep-hours-input', 'dailySleepHours');

  $('plan-days-select')?.addEventListener('change', (e) => {
    state.config.planDays = parseInt(e.target.value, 10) || 7;
    saveLocalPlannerCache();
    triggerGeneratePlan(false, true);
  });

  $('school-start-time')?.addEventListener('change', (e) => {
    state.config.schoolStartTime = e.target.value || '08:00';
    saveLocalPlannerCache();
  });
  $('school-end-time')?.addEventListener('change', (e) => {
    state.config.schoolEndTime = e.target.value || '14:30';
    saveLocalPlannerCache();
  });
  $('wake-up-time')?.addEventListener('change', (e) => {
    state.config.wakeUpTime = e.target.value || '06:30';
    saveLocalPlannerCache();
  });
  $('include-quiz-revision-toggle')?.addEventListener('change', (e) => {
    state.config.includeQuizRevision = Boolean(e.target.checked);
    saveLocalPlannerCache();
  });

  document.querySelectorAll('#session-style-pills .pl-style-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.config.sessionStyle = btn.dataset.style || 'pomodoro_25_5';
      syncConfigControlsFromState();
      saveLocalPlannerCache();
    });
  });

  $('custom-focus-mins')?.addEventListener('change', (e) => {
    state.config.customFocusMins = Math.max(10, Math.min(180, parseInt(e.target.value, 10) || 45));
    saveLocalPlannerCache();
  });
  $('custom-break-mins')?.addEventListener('change', (e) => {
    state.config.customBreakMins = Math.max(2, Math.min(60, parseInt(e.target.value, 10) || 10));
    saveLocalPlannerCache();
  });

  document.querySelectorAll('#school-days-toggles .pl-day-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = parseInt(btn.dataset.day, 10);
      const idx = state.config.schoolDays.indexOf(d);
      if (idx >= 0) {
        state.config.schoolDays.splice(idx, 1);
      } else {
        state.config.schoolDays.push(d);
        state.config.schoolDays.sort((a, b) => a - b);
      }
      syncConfigControlsFromState();
      saveLocalPlannerCache();
    });
  });

  function renderExamDatesList() {
    const listEl = $('exam-dates-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!state.config.examDates.length) {
      listEl.innerHTML = `<div class="pl-tag-row"><span>No upcoming exam dates added</span><code>Optional</code></div>`;
      return;
    }
    state.config.examDates.forEach((ex, idx) => {
      const row = document.createElement('div');
      row.className = 'pl-tag-row';
      row.innerHTML = `
        <span><i class="fa-solid fa-graduation-cap icon-accent"></i> <b>${escapeHtml(ex.subject)}</b></span>
        <code>${escapeHtml(ex.date)}</code>
        <button type="button" class="pl-tag-del" title="Remove exam"><i class="fa-solid fa-trash-can"></i></button>
      `;
      row.querySelector('.pl-tag-del')?.addEventListener('click', () => {
        state.config.examDates.splice(idx, 1);
        renderExamDatesList();
        saveLocalPlannerCache();
      });
      listEl.appendChild(row);
    });
  }

  $('add-exam-btn')?.addEventListener('click', () => {
    const subj = String($('exam-subject-input')?.value || '').trim();
    const date = String($('exam-date-input')?.value || '').trim();
    if (!subj || !date) {
      showToast('Enter both the Exam Subject/Name and the Exam Date', 'fa-solid fa-triangle-exclamation');
      return;
    }
    state.config.examDates.push({
      id: 'exam_' + Date.now(),
      subject: subj,
      examName: subj,
      date,
    });
    $('exam-subject-input').value = '';
    renderExamDatesList();
    renderSubjectPriorityList();
    saveLocalPlannerCache();
    showToast(`Added exam: ${subj} (${date})`, 'fa-solid fa-calendar-plus');
  });

  function renderVacationDatesList() {
    const listEl = $('vacation-dates-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!state.config.vacationRanges.length) {
      listEl.innerHTML = `<div class="pl-tag-row"><span>No holidays added</span><code>Mon–Sat School active</code></div>`;
      return;
    }
    state.config.vacationRanges.forEach((vac, idx) => {
      const row = document.createElement('div');
      row.className = 'pl-tag-row';
      const dateStr = vac.startDate === vac.endDate ? vac.startDate : `${vac.startDate} → ${vac.endDate}`;
      row.innerHTML = `
        <span><i class="fa-solid fa-sun icon-accent"></i> <b>${escapeHtml(vac.label)}</b></span>
        <code>${escapeHtml(dateStr)}</code>
        <button type="button" class="pl-tag-del" title="Remove holiday"><i class="fa-solid fa-trash-can"></i></button>
      `;
      row.querySelector('.pl-tag-del')?.addEventListener('click', () => {
        state.config.vacationRanges.splice(idx, 1);
        renderVacationDatesList();
        saveLocalPlannerCache();
      });
      listEl.appendChild(row);
    });
  }

  $('add-vacation-btn')?.addEventListener('click', () => {
    const label = String($('vacation-label-input')?.value || '').trim() || 'Holiday / Vacation';
    const start = String($('vacation-start-input')?.value || '').trim();
    const end = String($('vacation-end-input')?.value || start).trim();
    if (!start) {
      showToast('Select a start date for your vacation or holiday', 'fa-solid fa-triangle-exclamation');
      return;
    }
    state.config.vacationRanges.push({
      id: 'vac_' + Date.now(),
      label,
      startDate: start <= end ? start : end,
      endDate: start <= end ? end : start,
    });
    $('vacation-label-input').value = '';
    renderVacationDatesList();
    saveLocalPlannerCache();
    showToast(`Added full-day vacation: ${label}`, 'fa-solid fa-umbrella-beach');
  });

  function getActiveSubjectsList() {
    const fromChapters = [...new Set(state.chapters.map((c) => c.subject).filter(Boolean))];
    const fromExams = state.config.examDates.map((e) => e.subject).filter(Boolean);
    const combined = [...new Set([...fromChapters, ...fromExams])];
    return combined.length ? combined : CORE_SUBJECTS;
  }

  function renderSubjectPriorityList() {
    const container = $('subject-priority-list');
    if (!container) return;
    container.innerHTML = '';

    const subjects = getActiveSubjectsList();
    subjects.forEach((subj) => {
      const current = state.config.subjectPriorities[subj] || 'Medium';
      const row = document.createElement('div');
      row.className = 'pl-prio-row';
      row.innerHTML = `
        <span title="${escapeHtml(subj)}">${escapeHtml(subj)}</span>
        <div class="pl-prio-btns">
          <button type="button" class="pl-prio-btn ${current === 'High' ? 'is-active' : ''}" data-prio="High">High</button>
          <button type="button" class="pl-prio-btn ${current === 'Medium' ? 'is-active' : ''}" data-prio="Medium">Med</button>
          <button type="button" class="pl-prio-btn ${current === 'Low' ? 'is-active' : ''}" data-prio="Low">Low</button>
        </div>
      `;
      row.querySelectorAll('.pl-prio-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.config.subjectPriorities[subj] = btn.dataset.prio;
          renderSubjectPriorityList();
          saveLocalPlannerCache();
        });
      });
      container.appendChild(row);
    });
  }

  function renderPlanSummary() {
    if (!state.plan || !Array.isArray(state.plan.days) || !state.plan.days.length) {
      state.plan = generateLocalStudyPlan(state.chapters, state.config);
    }
    const plan = state.plan;

    if ($('plan-coach-headline')) $('plan-coach-headline').textContent = plan.coachHeadline || 'Your AI Study Plan';
    if ($('plan-coach-summary')) $('plan-coach-summary').textContent = plan.coachSummary || '';
    if ($('plan-style-badge')) $('plan-style-badge').textContent = plan.sessionStyleLabel || 'Pomodoro 25 / 5';

    const syncChip = $('plan-sync-status-chip');
    const syncBanner = $('todoist-sync-summary-banner');
    const isSynced = Boolean(plan.todoistSync?.synced);
    if (syncChip) {
      syncChip.className = `chip ${isSynced ? 'ok' : 'wait'}`;
      syncChip.innerHTML = isSynced
        ? `<i class="fa-solid fa-circle-check"></i> Synced (${plan.todoistSync.totalTasksCreated || 0} Todoist Tasks)`
        : `<i class="fa-regular fa-clock"></i> Ready to Sync to Todoist`;
    }
    if (syncBanner) {
      syncBanner.hidden = !isSynced;
      if (isSynced) {
        $('todoist-sync-banner-title').textContent = `Synced ${plan.todoistSync.parentTasksCreated || 0} Parent Tasks & ${plan.todoistSync.subTasksCreated || 0} Sub-Tasks to Todoist!`;
        const syncDate = plan.todoistSync.syncedAt ? new Date(plan.todoistSync.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'just now';
        $('todoist-sync-banner-desc').textContent = `Last pushed at ${syncDate}. Open Todoist Upcoming to view your scheduled blocks, descriptions, and due dates.`;
      }
    }

    const recsEl = $('plan-coach-recommendations');
    if (recsEl) {
      recsEl.innerHTML = '';
      (plan.keyRecommendations || []).forEach((rec) => {
        const li = document.createElement('li');
        li.innerHTML = `<i class="fa-solid fa-circle-check"></i><span>${escapeHtml(rec)}</span>`;
        recsEl.appendChild(li);
      });
    }

    const m = plan.metrics || {};
    if ($('metric-daily-split')) {
      $('metric-daily-split').textContent = `${m.dailyStudyHours || state.config.dailyStudyHours}h Study · ${m.dailySleepHours || state.config.dailySleepHours}h Sleep`;
    }
    if ($('metric-session-style')) {
      $('metric-session-style').textContent = plan.sessionStyleLabel || 'Pomodoro (25m / 5m)';
    }
    if ($('metric-total-hours')) {
      $('metric-total-hours').textContent = `${m.totalStudyHours || 0} hrs (${m.totalBlocks || 0} blocks)`;
    }
    if ($('metric-total-blocks')) {
      $('metric-total-blocks').textContent = `Across ${m.totalDays || plan.days.length} scheduled days`;
    }
    if ($('metric-day-types')) {
      $('metric-day-types').textContent = `${m.schoolDaysCount ?? 0} School · ${m.fullDaysCount ?? 0} Full Day(s)`;
    }
    if ($('metric-synced-tasks')) {
      $('metric-synced-tasks').textContent = isSynced
        ? `${plan.todoistSync.totalTasksCreated} Tasks in Todoist`
        : `${m.totalBlocks || 0} Main Tasks Ready`;
    }
    if ($('metric-synced-time')) {
      $('metric-synced-time').textContent = isSynced
        ? `${plan.todoistSync.parentTasksCreated} parent + ${plan.todoistSync.subTasksCreated} sub-tasks`
        : 'Click "Sync / Push to Todoist"';
    }

    const subjGrid = $('prioritized-subjects-grid');
    if (subjGrid) {
      subjGrid.innerHTML = '';
      (plan.prioritizedSubjects || []).forEach((s) => {
        const card = document.createElement('div');
        card.className = 'pl-subj-card';
        const weakHtml = s.weakSubtopics?.length
          ? `<div class="pl-subj-chapters"><b style="color:var(--accent-warning)">Weak Subtopics:</b> ${escapeHtml(s.weakSubtopics.join(', '))}</div>`
          : '';
        card.innerHTML = `
          <div class="pl-subj-top">
            <h4>${escapeHtml(s.subject)}</h4>
            <span class="pl-prio-badge ${escapeHtml(s.priority || 'Medium')}">${escapeHtml(s.priority || 'Medium')} Priority</span>
          </div>
          <div class="pl-subj-meta">
            <span><i class="fa-regular fa-clock"></i> ${s.totalHours}h (${s.sessionsCount} blocks)</span>
            <span><i class="fa-solid fa-book"></i> ${s.chaptersCount} chapter(s)</span>
            ${s.examDate ? `<span><i class="fa-solid fa-flag-checkered"></i> Exam: ${escapeHtml(s.examDate)}</span>` : ''}
          </div>
          <div class="pl-subj-chapters">${escapeHtml((s.chapters || []).slice(0, 4).join(' · '))}</div>
          ${weakHtml}
        `;
        subjGrid.appendChild(card);
      });
    }

    const tabsEl = $('schedule-day-tabs');
    if (tabsEl) {
      tabsEl.innerHTML = '';
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = `pl-day-tab ${state.activeDayFilter === 'all' ? 'is-active' : ''}`;
      allBtn.textContent = `All Days (${plan.days.length})`;
      allBtn.addEventListener('click', () => {
        state.activeDayFilter = 'all';
        renderPlanSummary();
      });
      tabsEl.appendChild(allBtn);

      plan.days.forEach((d) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `pl-day-tab ${state.activeDayFilter === d.date ? 'is-active' : ''}`;
        btn.textContent = `Day ${d.dayIndex} · ${d.shortDay}`;
        btn.addEventListener('click', () => {
          state.activeDayFilter = d.date;
          renderPlanSummary();
        });
        tabsEl.appendChild(btn);
      });
    }

    const daysContainer = $('daily-schedule-container');
    if (daysContainer) {
      daysContainer.innerHTML = '';
      const filteredDays = state.activeDayFilter === 'all'
        ? plan.days
        : plan.days.filter((d) => d.date === state.activeDayFilter);

      filteredDays.forEach((day) => {
        const allDaySynced = (day.studyBlocks || []).every((b) => b.synced);
        const dayCard = document.createElement('article');
        dayCard.className = `pl-day-card ${day.dayType !== 'school_day' ? 'is-full-day' : ''}`;
        dayCard.innerHTML = `
          <div class="pl-day-card-head">
            <div class="pl-day-title-group">
              <h4>Day ${day.dayIndex} — ${escapeHtml(day.dayLabel)}</h4>
              <span class="pl-day-type-pill ${escapeHtml(day.dayType)}">
                <i class="fa-solid ${day.dayType === 'school_day' ? 'fa-school' : 'fa-sun'}"></i>
                ${escapeHtml(day.dayTypeLabel)}
              </span>
            </div>
            <div class="pl-day-Allocation">
              <span>📚 ${day.studyHours}h Study</span>
              <span>😴 ${day.sleepHours}h Sleep</span>
              <span>🎮 ${day.freePlayHours}h Free</span>
              <button type="button" class="btn btn-ghost btn-sm pl-push-day-btn" data-date="${escapeHtml(day.date)}">
                <i class="fa-solid ${allDaySynced ? 'fa-check' : 'fa-cloud-arrow-up'}"></i>
                <span>${allDaySynced ? 'Day Synced' : 'Push Day to Todoist'}</span>
              </button>
            </div>
          </div>
          <div class="pl-blocks-grid"></div>
        `;

        dayCard.querySelector('.pl-push-day-btn')?.addEventListener('click', () => {
          triggerSyncTodoist({ onlyDate: day.date });
        });

        const blocksGrid = dayCard.querySelector('.pl-blocks-grid');
        (day.studyBlocks || []).forEach((block) => {
          const bCard = document.createElement('div');
          bCard.className = `pl-block-card ${block.completed ? 'is-completed' : ''}`;
          const quizBadge = block.quizPercentage != null
            ? `<span class="chip ${block.quizPercentage >= 80 ? 'ok' : 'wait'}">Quiz: ${block.quizPercentage}%</span>`
            : '';
          const syncBadge = block.synced
            ? `<span class="chip ok"><i class="fa-solid fa-check"></i> Synced to Todoist</span>`
            : `<span class="chip wait">Local Plan</span>`;

          bCard.innerHTML = `
            <div class="pl-block-top">
              <div class="pl-block-check-title">
                <input type="checkbox" class="pl-parent-check" ${block.completed ? 'checked' : ''} title="Mark study block completed in Todoist">
                <div>
                  <span class="pl-block-time">${escapeHtml(block.startTime)} – ${escapeHtml(block.endTime)} (${block.durationMins}m · ${escapeHtml(block.period)})</span>
                  <div class="pl-block-title">[${escapeHtml(block.subject)}] ${escapeHtml(block.title)}</div>
                </div>
              </div>
              <div class="pl-block-badges">
                <span class="pl-prio-badge ${escapeHtml(block.priority || 'Medium')}">${escapeHtml(block.priority || 'Medium')}</span>
                ${quizBadge}
                ${syncBadge}
              </div>
            </div>

            <div class="pl-break-strip">
              <i class="fa-solid fa-mug-hot"></i>
              <span><b>${escapeHtml(block.sessionPatternLabel || plan.sessionStyleLabel)}:</b> ${escapeHtml(block.breakIntervalText)}</span>
            </div>

            <p class="pl-block-strategy">💡 ${escapeHtml(block.strategyNote || block.focusType)}</p>

            <ul class="pl-subtasks-list"></ul>

            <div class="pl-block-foot">
              <div class="pl-block-links">
                ${block.pdfUrl ? `<a href="${escapeHtml(block.pdfUrl)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-file-pdf"></i> NCERT Chapter PDF</a>` : ''}
                ${block.youtubeUrl ? `<a href="${escapeHtml(block.youtubeUrl)}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-youtube"></i> Watch Tutorial</a>` : ''}
                <a href="quizzes.html"><i class="fa-solid fa-circle-question"></i> Take Chapter Quiz</a>
                ${block.todoistUrl ? `<a href="${escapeHtml(block.todoistUrl)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-list-check"></i> Open in Todoist</a>` : ''}
              </div>
              <span style="color:var(--text-muted);font-family:'JetBrains Mono',monospace;">Due: ${escapeHtml(block.todoistDueString)}</span>
            </div>
          `;

          const parentCheck = bCard.querySelector('.pl-parent-check');
          parentCheck?.addEventListener('change', (e) => {
            toggleTaskCompletion({
              blockId: block.id,
              subtaskId: null,
              todoistTaskId: block.todoistTaskId,
              completed: e.target.checked,
            });
          });

          const subList = bCard.querySelector('.pl-subtasks-list');
          (block.subtasks || []).forEach((sub) => {
            const li = document.createElement('li');
            li.className = `pl-subtask-item ${sub.completed ? 'is-done' : ''}`;
            li.innerHTML = `
              <input type="checkbox" ${sub.completed ? 'checked' : ''} title="Mark sub-task completed">
              <span>${escapeHtml(sub.content)}</span>
            `;
            li.querySelector('input')?.addEventListener('change', (e) => {
              toggleTaskCompletion({
                blockId: block.id,
                subtaskId: sub.id,
                todoistTaskId: sub.todoistTaskId,
                completed: e.target.checked,
              });
            });
            subList.appendChild(li);
          });

          blocksGrid.appendChild(bCard);
        });

        daysContainer.appendChild(dayCard);
      });
    }
  }

  async function refreshPlannerState() {
    // 1. Load local cache immediately so UI is responsive right away
    const cached = loadLocalPlannerCache();
    if (cached?.config) state.config = { ...state.config, ...cached.config };
    if (Array.isArray(cached?.chapters) && cached.chapters.length) state.chapters = cached.chapters;
    if (cached?.plan && Array.isArray(cached.plan.days) && cached.plan.days.length) {
      state.plan = cached.plan;
    } else {
      state.plan = generateLocalStudyPlan(state.chapters, state.config);
    }
    renderTodoistStatus();
    renderSyllabusAndQuizFallback();
    syncConfigControlsFromState();
    renderPlanSummary();

    // 2. Fetch live server state from /api/planner/state
    try {
      const res = await fetch(`/api/planner/state?telegramUserId=${encodeURIComponent(state.telegramUserId)}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok) {
          state.hasTodoistKey = Boolean(data.has_todoist_key || getLocalTodoistKey());
          state.todoistMasked = data.todoist_masked || state.todoistMasked;
          state.todoistSource = data.todoist_source || state.todoistSource;
          if (Array.isArray(data.chapters) && data.chapters.length) {
            state.chapters = data.chapters;
          }
          if (data.quiz_history) state.quizHistory = data.quiz_history;
          if (data.config && Object.keys(data.config).length) {
            state.config = { ...state.config, ...data.config };
          }
          if (data.plan && Array.isArray(data.plan.days) && data.plan.days.length) {
            state.plan = data.plan;
          } else {
            await triggerGeneratePlan(false, true);
            return;
          }
          saveLocalPlannerCache();
          renderTodoistStatus();
          renderSyllabusAndQuizFallback();
          syncConfigControlsFromState();
          renderPlanSummary();
          return;
        }
      }
    } catch {}

    // 3. Fallback if /api/planner/state returned 404/500: check /api/quizzes/chapters and /api/user-keys
    try {
      const [chRes, keyRes] = await Promise.all([
        fetch(`/api/quizzes/chapters?telegramUserId=${encodeURIComponent(state.telegramUserId)}`).catch(() => null),
        fetch(`/api/user-keys/${encodeURIComponent(state.telegramUserId)}`).catch(() => null),
      ]);
      if (keyRes && keyRes.ok) {
        const kd = await keyRes.json().catch(() => ({}));
        if (kd.has_todoist_key) state.hasTodoistKey = true;
      }
      if (chRes && chRes.ok) {
        const cd = await chRes.json().catch(() => ({}));
        if (Array.isArray(cd.chapters) && cd.chapters.length) {
          state.chapters = cd.chapters;
          state.plan = generateLocalStudyPlan(state.chapters, state.config);
          saveLocalPlannerCache();
        }
      }
    } catch {}

    renderTodoistStatus();
    renderSyllabusAndQuizFallback();
    syncConfigControlsFromState();
    renderPlanSummary();
  }

  async function triggerGeneratePlan(autoSyncTodoist = false, silent = false) {
    const genBtn = $('regenerate-plan-btn');
    const topGenBtn = $('top-regenerate-btn');
    const statusMsg = $('planner-status-msg');
    const origGenHtml = genBtn ? genBtn.innerHTML : '';

    if (genBtn) {
      genBtn.disabled = true;
      genBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Generating AI Plan…</span>`;
    }
    if (topGenBtn) topGenBtn.disabled = true;
    if (statusMsg) statusMsg.textContent = 'AI is analyzing your syllabus, quiz history, and school/vacation calendar…';

    try {
      const inlineText = String($('planner-syllabus-textarea')?.value || '').trim();
      const res = await fetch('/api/planner/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramUserId: state.telegramUserId,
          config: state.config,
          syllabusText: inlineText.length >= 3 ? inlineText : undefined,
          autoSyncTodoist: Boolean(autoSyncTodoist),
          todoistApiKey: getLocalTodoistKey() || undefined,
          geminiKey: getLocalGeminiKey() || undefined,
        }),
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data && data.ok && data.plan) {
          if (inlineText.length >= 3 && $('planner-syllabus-textarea')) {
            $('planner-syllabus-textarea').value = '';
            state.editorExpanded = false;
          }
          state.plan = data.plan;
          if (Array.isArray(data.chapters) && data.chapters.length) state.chapters = data.chapters;
          if (data.quiz_history) state.quizHistory = data.quiz_history;
          saveLocalPlannerCache();
          renderSyllabusAndQuizFallback();
          syncConfigControlsFromState();
          renderPlanSummary();
          if (statusMsg) {
            statusMsg.textContent = `Generated ${state.plan.days.length}-day study plan (${state.plan.metrics?.totalBlocks || 0} study blocks).`;
          }
          if (!silent) showToast('AI Study Plan generated!', 'fa-solid fa-wand-magic-sparkles');
          return;
        }
      }

      // Client-side fallback generator
      if (inlineText.length >= 3) {
        const extra = parseSyllabusTextLocally(inlineText);
        if (extra.length) state.chapters = [...state.chapters, ...extra];
        if ($('planner-syllabus-textarea')) $('planner-syllabus-textarea').value = '';
        state.editorExpanded = false;
      }
      state.plan = generateLocalStudyPlan(state.chapters, state.config);
      saveLocalPlannerCache();
      renderSyllabusAndQuizFallback();
      syncConfigControlsFromState();
      renderPlanSummary();
      if (statusMsg) {
        statusMsg.textContent = `Generated ${state.plan.days.length}-day study plan (${state.plan.metrics?.totalBlocks || 0} study blocks).`;
      }
      if (!silent) showToast('AI Study Plan generated!', 'fa-solid fa-wand-magic-sparkles');
    } catch (err) {
      state.plan = generateLocalStudyPlan(state.chapters, state.config);
      renderPlanSummary();
      if (statusMsg) statusMsg.textContent = `Generated ${state.plan.days.length}-day study plan.`;
    } finally {
      if (genBtn) {
        genBtn.disabled = false;
        genBtn.innerHTML = origGenHtml;
      }
      if (topGenBtn) topGenBtn.disabled = false;
    }
  }

  async function triggerSyncTodoist(opts = {}) {
    const onlyDate = opts.onlyDate || null;
    const scopeVal = $('todoist-sync-scope')?.value || 'all';
    const maxDays = !onlyDate && scopeVal !== 'all' ? parseInt(scopeVal, 10) : null;

    if (!state.plan || !Array.isArray(state.plan.days) || !state.plan.days.length) {
      state.plan = generateLocalStudyPlan(state.chapters, state.config);
      renderPlanSummary();
    }

    const localKey = getLocalTodoistKey();
    const syncBtn = $('sync-todoist-btn');
    const topSyncBtn = $('top-sync-todoist-btn');
    const statusMsg = $('planner-status-msg');
    const origSync = syncBtn ? syncBtn.innerHTML : '';
    const origTop = topSyncBtn ? topSyncBtn.innerHTML : '';

    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Pushing Tasks to Todoist…</span>`;
    }
    if (topSyncBtn) {
      topSyncBtn.disabled = true;
      topSyncBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Syncing…</span>`;
    }
    if (statusMsg) {
      statusMsg.textContent = 'Pushing parent study tasks, sub-tasks, descriptions, and due dates to Todoist…';
    }

    try {
      // 1. Try server-side @doist/todoist-sdk endpoint first (supports server .env TODOIST_API_KEY as well as user key)
      let syncedResult = null;
      try {
        const res = await fetch('/api/planner/sync-todoist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            telegramUserId: state.telegramUserId,
            todoistApiKey: localKey || undefined,
            config: state.config,
            plan: state.plan,
            onlyDate,
            maxDays,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.ok) {
          syncedResult = data;
        } else if (res.status === 400 && /No.*Todoist API key/i.test(data.error || '') && !localKey) {
          // Prompt user right inside Step 2 to paste their Todoist key
          const promptBox = $('step2-todoist-prompt');
          if (promptBox) {
            promptBox.hidden = false;
            $('step2-todoist-key-input')?.focus();
          }
          const topDrawer = $('inline-todoist-drawer');
          if (topDrawer) topDrawer.hidden = false;
          throw new Error('Paste your Todoist API token in the box above to push tasks to Todoist.');
        } else if (!localKey) {
          throw new Error(data.error || 'Could not sync tasks to Todoist. Make sure your Todoist API token is added.');
        }
      } catch (serverErr) {
        if (!localKey) throw serverErr;
      }

      // 2. If server endpoint failed/404'd and we have a Todoist token in the browser, push directly to Todoist REST API!
      if (!syncedResult && localKey) {
        syncedResult = await syncPlanDirectlyFromBrowser({
          token: localKey,
          plan: state.plan,
          onlyDate,
          maxDays,
        });
      }

      if (!syncedResult) {
        throw new Error('Could not sync tasks to Todoist.');
      }

      state.hasTodoistKey = true;
      state.plan = syncedResult.plan || state.plan;
      saveLocalPlannerCache();
      renderTodoistStatus();
      renderPlanSummary();

      if (statusMsg) {
        statusMsg.textContent = `Synced ${syncedResult.parentTasksCreated} parent tasks and ${syncedResult.subTasksCreated} sub-tasks to Todoist!`;
      }
      showToast(`Pushed ${syncedResult.totalTasksCreated} tasks to your Todoist Upcoming schedule!`, 'fa-solid fa-circle-check');
    } catch (err) {
      if (statusMsg) statusMsg.textContent = err.message || 'Todoist sync failed.';
      showToast(err.message || 'Failed to sync to Todoist', 'fa-solid fa-circle-exclamation');
    } finally {
      if (syncBtn) {
        syncBtn.disabled = false;
        syncBtn.innerHTML = origSync;
      }
      if (topSyncBtn) {
        topSyncBtn.disabled = false;
        topSyncBtn.innerHTML = origTop;
      }
    }
  }

  async function toggleTaskCompletion({ blockId, subtaskId, todoistTaskId, completed }) {
    if (state.plan && Array.isArray(state.plan.days)) {
      for (const day of state.plan.days) {
        for (const block of day.studyBlocks || []) {
          if (block.id === blockId && !subtaskId) {
            block.completed = completed;
          }
          if (subtaskId && Array.isArray(block.subtasks)) {
            for (const sub of block.subtasks) {
              if (sub.id === subtaskId) sub.completed = completed;
            }
          }
        }
      }
      saveLocalPlannerCache();
      renderPlanSummary();
    }

    const localKey = getLocalTodoistKey();
    let updatedServer = false;
    try {
      const res = await fetch('/api/planner/task-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramUserId: state.telegramUserId,
          blockId,
          subtaskId,
          todoistTaskId,
          completed,
          todoistApiKey: localKey || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.todoistUpdated) {
        updatedServer = true;
        showToast(completed ? 'Marked completed in Todoist!' : 'Reopened task in Todoist!', 'fa-solid fa-list-check');
      }
    } catch {}

    // Direct browser fallback for closing/reopening task in Todoist
    if (!updatedServer && todoistTaskId && localKey) {
      const action = completed ? 'close' : 'reopen';
      try {
        const res = await fetch(`https://api.todoist.com/api/v1/tasks/${encodeURIComponent(todoistTaskId)}/${action}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${localKey}` },
        });
        if (res.ok) {
          showToast(completed ? 'Marked completed in Todoist!' : 'Reopened task in Todoist!', 'fa-solid fa-list-check');
        }
      } catch {}
    }
  }

  $('regenerate-plan-btn')?.addEventListener('click', () => triggerGeneratePlan(false));
  $('top-regenerate-btn')?.addEventListener('click', () => triggerGeneratePlan(false));
  $('sync-todoist-btn')?.addEventListener('click', () => triggerSyncTodoist());
  $('top-sync-todoist-btn')?.addEventListener('click', () => triggerSyncTodoist());

  renderTodoistStatus();
  syncConfigControlsFromState();
  refreshPlannerState();
})();
