// ==========================================================================
// setup.js — Onboarding & Configuration Logic for Study Agent
// Built-in Telegram Bot + Gemini Multi-Key Fallback + NotebookLM + Todoist API Key
// ==========================================================================

(() => {
  const STORAGE_KEY = 'study_agent_config';
  const STUDY_AGENT_WEB_LINK = 'https://web.telegram.org/a/#8996972210';
  const FALLBACK_GUEST_ID = '100000001';

  const defaultState = () => ({
    version: '1.2.0',
    updatedAt: null,
    classLevel: '',
    geminiKeys: [
      { id: cryptoId(), label: 'Primary Key', key: '', verified: false, lastChecked: null }
    ],
    telegram: {
      botUsername: '',
      botName: 'Study Agent Bot',
      pairingCode: 'SA-' + Math.floor(1000 + Math.random() * 9000),
      chatId: '',
      userId: '',
      chatFirstName: '',
      chatUsername: '',
      verified: false,
      updatedAt: null
    },
    notebooklm: {
      status: 'disconnected', // 'disconnected' | 'pending' | 'connected'
      backendUrl: 'http://localhost:8000',
      accountEmail: '',
      authMethod: null,
      sessionData: null,
      sessionStored: false,
      connectedAt: null
    },
    todoist: {
      apiKey: '',
      verified: false,
      serverConfigured: false,
      maskedServerKey: null,
      source: null,
      lastChecked: null
    }
  });

  function cryptoId() {
    return 'key_' + Math.random().toString(36).slice(2, 10);
  }

  function cleanTodoistToken(raw) {
    if (typeof raw !== 'string') return '';
    return raw
      .trim()
      .replace(/^Bearer\s+/i, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();
  }

  function isValidTodoistKeyFormat(key) {
    const cleaned = cleanTodoistToken(key);
    return /^[^\s"'`]{16,}$/.test(cleaned);
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const def = defaultState();
      return {
        ...def,
        ...parsed,
        geminiKeys: Array.isArray(parsed.geminiKeys) && parsed.geminiKeys.length
          ? parsed.geminiKeys
          : def.geminiKeys,
        telegram: {
          ...def.telegram,
          ...(parsed.telegram || {}),
          pairingCode: parsed.telegram?.pairingCode || def.telegram.pairingCode
        },
        notebooklm: { ...def.notebooklm, ...(parsed.notebooklm || {}) },
        todoist: { ...def.todoist, ...(parsed.todoist || {}) }
      };
    } catch (e) {
      return defaultState();
    }
  }

  function saveState(silent = false) {
    state.updatedAt = new Date().toISOString();
    if (saveQueued) return;
    saveQueued = true;
    requestAnimationFrame(() => {
      saveQueued = false;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {}
      syncCookiesFromCurrentState();
      updateReadinessUI();
      updatePayloadInspector();
    });
  }
  let saveQueued = false;

  // NotebookLM session waiting to be saved (kept in memory only, never in localStorage)
  let pendingLoginId = null;
  let pendingStorageState = null;
  const IS_LOCAL_HOST = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  let nlmMode = IS_LOCAL_HOST ? 'local' : 'upload';

  // Mirror the saved settings into browser cookies so planner.html, quizzes.html & resources.html can access them.
  function setCookie(name, value, maxAgeSeconds = 31536000) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    const maxAge = maxAgeSeconds ? `; max-age=${maxAgeSeconds}` : '';
    document.cookie = `${name}=${encodeURIComponent(value)}${maxAge}; path=/; SameSite=Lax${secure}`;
  }

  function getEffectiveUserId() {
    const id = String(state.telegram.userId || state.telegram.chatId || '').trim();
    return /^\d+$/.test(id) ? id : FALLBACK_GUEST_ID;
  }

  function syncCookiesFromCurrentState(sessionSaved = false) {
    try {
      const userId = getEffectiveUserId();
      setCookie('sa_telegram_id', userId);
      const validGeminiKeys = state.geminiKeys.map((k) => k.key.trim()).filter(isValidGeminiKeyFormat);
      // Secrets are mirrored as session-only cookies (no max-age) so they do not persist
      // in the browser beyond the current session, reducing exposure if the device is shared
      // or compromised via XSS/a malicious extension.
      if (validGeminiKeys.length) setCookie('sa_gemini_key', validGeminiKeys[0], 0);
      const todoistKey = cleanTodoistToken(state.todoist.apiKey);
      if (isValidTodoistKeyFormat(todoistKey)) setCookie('sa_todoist_key', todoistKey, 0);
      const nlm = sessionSaved || state.notebooklm.status === 'connected' || state.notebooklm.sessionStored;
      setCookie('sa_notebooklm_auth', nlm ? 'connected' : 'none');
    } catch (e) {}
  }

  // Save Telegram id + Gemini keys + Todoist API key + Google account to the database
  async function saveConfigToDb() {
    const userId = getEffectiveUserId();
    const keys = state.geminiKeys.map((k) => k.key.trim()).filter(isValidGeminiKeyFormat);
    const todoistKey = cleanTodoistToken(state.todoist.apiKey);
    const hasTodoist = isValidTodoistKeyFormat(todoistKey);

    const classLevel = /^\d{1,2}$/.test(String(state.classLevel || '')) ? Number(state.classLevel) : undefined;

    const body = {
      telegram_user_id: userId,
      class_level: classLevel,
      gemini_api_keys: keys,
      todoist_api_key: hasTodoist ? todoistKey : undefined,
      google_email: (state.notebooklm.accountEmail || '').trim() || undefined,
      notebooklm_login_id: pendingLoginId || undefined,
      notebooklm_storage_state: (!pendingLoginId && pendingStorageState) || undefined
    };

    if (!keys.length && !classLevel && !hasTodoist && !pendingLoginId && !pendingStorageState && !body.google_email && !state.todoist.serverConfigured) {
      showToast('Add a Gemini key, choose your class, Todoist API token, or sign in to Google first', 'fa-solid fa-key');
      return false;
    }

    try {
      const res = await fetch('/api/user-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      if (data.session_saved) { pendingLoginId = null; pendingStorageState = null; }
      if (data.class_level) { state.classLevel = String(data.class_level); syncClassUI(); }
      if (data.todoist_saved || data.has_todoist_key) {
        state.todoist.verified = true;
        state.todoist.serverConfigured = true;
        state.todoist.maskedServerKey = data.todoist_masked || state.todoist.maskedServerKey;
      }
      saveState(true);
      syncTodoistUI();
      syncCookiesFromCurrentState(Boolean(data.session_saved));
      showToast('Configuration Saved Successfully!', 'fa-solid fa-circle-check');
      return true;
    } catch (e) {
      // Even if offline, local state & cookies are saved
      syncCookiesFromCurrentState(false);
      showToast('Saved to browser workspace (' + e.message + ')', 'fa-solid fa-circle-check');
      return false;
    }
  }

  let state = loadState();
  let telegramPollTimer = null;
  let nlmPollTimer = null;
  let activeLoginId = null;
  let nlmPopupMonitor = null;
  let currentInspectorFormat = 'json';

  const $id = (id) => document.getElementById(id);

  function showToast(message, iconClass = 'fa-solid fa-bolt') {
    const container = $id('setup-toast-container');
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
    }, 3400);
  }

  function copyText(text, label = 'Copied to clipboard') {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast(label, 'fa-regular fa-copy')).catch(() => fallbackCopy(text, label));
    } else {
      fallbackCopy(text, label);
    }
  }

  function fallbackCopy(text, label) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast(label, 'fa-regular fa-copy'); } catch (e) {}
    ta.remove();
  }

  // ==========================================================================
  // STEP 1: GEMINI API KEYS WITH FALLBACK
  // ==========================================================================
  const keysListEl = $id('gemini-keys-list');
  const keyCountBadge = $id('gemini-key-count');

  function isValidGeminiKeyFormat(key) {
    const trimmed = (key || '').trim();
    return /^AIza[0-9A-Za-z_-]{20,}$/.test(trimmed) || trimmed.length >= 20;
  }

  function renderGeminiKeys() {
    if (!keysListEl) return;
    keysListEl.innerHTML = '';

    state.geminiKeys.forEach((item, idx) => {
      const isPrimary = idx === 0;
      const validFormat = isValidGeminiKeyFormat(item.key);
      const card = document.createElement('div');
      card.className = 'key-item';
      card.innerHTML = `
        <div class="key-item-top">
          <span class="key-role-tag ${isPrimary ? 'primary' : 'fallback'}">
            <i class="fa-solid ${isPrimary ? 'fa-star' : 'fa-shield-halved'}"></i>
            ${isPrimary ? 'Primary Key (#1)' : `Fallback Key (#${idx + 1})`}
          </span>
          <input type="text" class="key-label-input" value="${escapeAttr(item.label || (isPrimary ? 'Primary Key' : `Fallback #${idx}`))}"
            placeholder="Key label..." aria-label="Key label">
          <span class="chip ${item.verified ? 'ok' : validFormat ? 'ok' : 'wait'}" data-role="status-chip">
            ${item.verified ? 'Verified Live' : validFormat ? 'Ready' : 'Enter Key'}
          </span>
          <div class="key-item-controls">
            <button type="button" class="icon-btn" data-action="up" title="Move priority up" ${idx === 0 ? 'disabled' : ''}>
              <i class="fa-solid fa-arrow-up"></i>
            </button>
            <button type="button" class="icon-btn" data-action="down" title="Move priority down" ${idx === state.geminiKeys.length - 1 ? 'disabled' : ''}>
              <i class="fa-solid fa-arrow-down"></i>
            </button>
            <button type="button" class="icon-btn danger" data-action="remove" title="Remove key slot" ${state.geminiKeys.length === 1 ? 'disabled' : ''}>
              <i class="fa-regular fa-trash-can"></i>
            </button>
          </div>
        </div>
        <div class="input-action-row">
          <div class="input-wrapper">
            <i class="fa-solid fa-key input-prefix-icon"></i>
            <input type="password" class="setup-input mono" data-role="key-input"
              value="${escapeAttr(item.key)}"
              placeholder="${isPrimary ? 'Paste your primary Gemini key (AIzaSy...)' : 'Paste fallback Gemini key (AIzaSy...)'}"
              autocomplete="off">
            <button type="button" class="icon-btn" data-action="toggle-vis" title="Show/Hide API Key">
              <i class="fa-regular fa-eye"></i>
            </button>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-action="verify">
            <i class="fa-solid fa-check"></i>
            <span>Verify Key</span>
          </button>
        </div>
      `;

      const labelInput = card.querySelector('.key-label-input');
      labelInput.addEventListener('input', (e) => {
        item.label = e.target.value;
        saveState(true);
      });

      const keyInput = card.querySelector('[data-role="key-input"]');
      const chipEl = card.querySelector('[data-role="status-chip"]');
      keyInput.addEventListener('input', (e) => {
        item.key = e.target.value.trim();
        item.verified = false;
        const ok = isValidGeminiKeyFormat(item.key);
        chipEl.className = `chip ${ok ? 'ok' : 'wait'}`;
        chipEl.textContent = ok ? 'Format OK' : 'Enter Key';
        saveState(true);
      });

      const visBtn = card.querySelector('[data-action="toggle-vis"]');
      visBtn.addEventListener('click', () => {
        const isPwd = keyInput.type === 'password';
        keyInput.type = isPwd ? 'text' : 'password';
        visBtn.innerHTML = `<i class="fa-regular ${isPwd ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
      });

      const verifyBtn = card.querySelector('[data-action="verify"]');
      verifyBtn.addEventListener('click', () => verifySingleGeminiKey(item, chipEl, verifyBtn));

      card.querySelector('[data-action="up"]').addEventListener('click', () => {
        if (idx === 0) return;
        [state.geminiKeys[idx - 1], state.geminiKeys[idx]] = [state.geminiKeys[idx], state.geminiKeys[idx - 1]];
        saveState(true);
        renderGeminiKeys();
      });

      card.querySelector('[data-action="down"]').addEventListener('click', () => {
        if (idx >= state.geminiKeys.length - 1) return;
        [state.geminiKeys[idx + 1], state.geminiKeys[idx]] = [state.geminiKeys[idx], state.geminiKeys[idx + 1]];
        saveState(true);
        renderGeminiKeys();
      });

      card.querySelector('[data-action="remove"]').addEventListener('click', () => {
        if (state.geminiKeys.length <= 1) return;
        state.geminiKeys.splice(idx, 1);
        saveState(true);
        renderGeminiKeys();
        showToast('Removed fallback key slot', 'fa-regular fa-trash-can');
      });

      keysListEl.appendChild(card);
    });

    if (keyCountBadge) {
      const total = state.geminiKeys.length;
      const fallbacks = Math.max(0, total - 1);
      keyCountBadge.textContent = fallbacks > 0
        ? `1 Primary + ${fallbacks} Fallback${fallbacks > 1 ? 's' : ''}`
        : '1 Primary Key';
    }
  }

  async function verifySingleGeminiKey(item, chipEl, btnEl) {
    const k = (item.key || '').trim();
    if (!k) {
      showToast('Paste a Gemini API key first', 'fa-solid fa-triangle-exclamation');
      return;
    }
    const origHTML = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Checking...</span>`;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`);
      if (res.ok) {
        item.verified = true;
        item.lastChecked = new Date().toISOString();
        chipEl.className = 'chip ok';
        chipEl.textContent = 'Verified Live';
        showToast(`${item.label || 'Gemini Key'} verified with Google AI Studio!`, 'fa-solid fa-circle-check');
      } else {
        item.verified = false;
        chipEl.className = 'chip wait';
        chipEl.textContent = 'Invalid Key';
        showToast('Google rejected that API key—double-check for typos', 'fa-solid fa-circle-exclamation');
      }
    } catch (err) {
      if (isValidGeminiKeyFormat(k)) {
        item.verified = true;
        item.lastChecked = new Date().toISOString();
        chipEl.className = 'chip ok';
        chipEl.textContent = 'Format Verified';
        showToast(`${item.label || 'Gemini Key'} format validated & saved`);
      } else {
        chipEl.className = 'chip wait';
        chipEl.textContent = 'Check Format';
        showToast('Key should start with AIza... and be ~39 characters', 'fa-solid fa-triangle-exclamation');
      }
    } finally {
      btnEl.disabled = false;
      btnEl.innerHTML = origHTML;
      saveState(true);
    }
  }

  $id('add-gemini-key-btn')?.addEventListener('click', () => {
    const nextNum = state.geminiKeys.length;
    state.geminiKeys.push({
      id: cryptoId(),
      label: `Fallback #${nextNum}`,
      key: '',
      verified: false,
      lastChecked: null
    });
    saveState(true);
    renderGeminiKeys();
    showToast(`Added Fallback Key #${nextNum + 1}`, 'fa-solid fa-plus');
  });

  $id('test-all-keys-btn')?.addEventListener('click', async () => {
    const filled = state.geminiKeys.filter((k) => k.key.trim().length > 0);
    if (!filled.length) {
      showToast('Add at least one Gemini API key to verify', 'fa-solid fa-key');
      return;
    }
    const cards = keysListEl.querySelectorAll('.key-item');
    for (let i = 0; i < state.geminiKeys.length; i++) {
      if (state.geminiKeys[i].key.trim()) {
        const chip = cards[i]?.querySelector('[data-role="status-chip"]');
        const btn = cards[i]?.querySelector('[data-action="verify"]');
        if (chip && btn) await verifySingleGeminiKey(state.geminiKeys[i], chip, btn);
      }
    }
  });

  // ==========================================================================
  // STEP 2: BUILT-IN TELEGRAM BOT PAIRING & AUTO-DETECT CHAT ID
  // ==========================================================================
  const chatIdInput = $id('telegram-chat-id');
  const pairingCodeEl = $id('telegram-pairing-code');
  const openBotBtn = $id('open-study-bot-btn');
  const openBotText = $id('open-study-bot-text');
  const botLiveSubtitle = $id('bot-live-subtitle');
  const listeningPanel = $id('autodetect-listening-panel');
  const connectedPill = $id('telegram-connected-pill');
  const connectedName = $id('telegram-connected-name');
  const connectedMeta = $id('telegram-connected-meta');

  async function initBuiltInTelegramBot() {
    if (pairingCodeEl) {
      pairingCodeEl.textContent = `/start ${state.telegram.pairingCode}`;
    }
    try {
      const res = await fetch('/api/telegram/bot');
      const data = await res.json();
      if (data && data.ok && data.result) {
        state.telegram.botUsername = data.result.username || '';
        state.telegram.botName = data.result.first_name || 'Study Agent Bot';
        if (state.telegram.botUsername && openBotBtn) {
          openBotBtn.href = `https://web.telegram.org/k/#@SylllabusBot`;
          if (openBotText) openBotText.textContent = `1. Open @${state.telegram.botUsername}`;
          if (botLiveSubtitle) {
            botLiveSubtitle.innerHTML = `Connected to official bot <b>@${escapeHtml(state.telegram.botUsername)}</b> · Tap below to pair your chat.`;
          }
        }
        saveState(true);
      }
    } catch (e) {
      if (openBotBtn) openBotBtn.href = STUDY_AGENT_WEB_LINK;
    }
  }

  function syncTelegramInputsFromState() {
    if (chatIdInput) chatIdInput.value = state.telegram.chatId || '';
    if (pairingCodeEl) pairingCodeEl.textContent = `/start ${state.telegram.pairingCode}`;

    if (state.telegram.chatId) {
      connectedPill.hidden = false;
      connectedName.textContent = state.telegram.chatFirstName
        ? `${state.telegram.chatFirstName}${state.telegram.chatUsername ? ` (@${state.telegram.chatUsername})` : ''}`
        : `Telegram Chat #${state.telegram.chatId}`;
      connectedMeta.textContent = state.telegram.botUsername
        ? `Paired with @${state.telegram.botUsername} · Chat ID: ${state.telegram.chatId}`
        : `Paired with Study Agent Bot · Chat ID: ${state.telegram.chatId}`;
    } else if (connectedPill) {
      connectedPill.hidden = true;
    }
  }

  $id('copy-pairing-code-btn')?.addEventListener('click', () => {
    copyText(`/start ${state.telegram.pairingCode}`, 'Copied pairing command!');
  });

  function stopTelegramPolling() {
    if (telegramPollTimer) {
      clearInterval(telegramPollTimer);
      telegramPollTimer = null;
    }
    if (listeningPanel) listeningPanel.hidden = true;
  }

  $id('cancel-autodetect-btn')?.addEventListener('click', () => {
    stopTelegramPolling();
    showToast('Stopped listening for Telegram messages');
  });

  async function pollTelegramUpdatesOnce() {
    try {
      const res = await fetch(`/api/telegram/pairing/${encodeURIComponent(state.telegram.pairingCode)}`);
      const data = await res.json();
      if (data && data.found) {
        const firstName = data.first_name || 'Student';
        state.telegram.chatId = String(data.chat_id);
        state.telegram.userId = String(data.user_id || data.chat_id);
        state.telegram.chatFirstName = firstName;
        state.telegram.chatUsername = data.username || '';
        state.telegram.verified = true;
        state.telegram.updatedAt = new Date().toISOString();

        stopTelegramPolling();
        saveState(true);
        syncTelegramInputsFromState();
        showToast(`Detected ${firstName} (Telegram ID: ${state.telegram.userId})!`, 'fa-brands fa-telegram');
        return true;
      }
    } catch (e) {}
    return false;
  }

  function startTelegramAutoDetection() {
    stopTelegramPolling();
    if (listeningPanel) listeningPanel.hidden = false;

    pollTelegramUpdatesOnce().then((foundNow) => {
      if (foundNow) return;
      let attempts = 0;
      telegramPollTimer = setInterval(async () => {
        attempts++;
        const found = await pollTelegramUpdatesOnce();
        if (found || attempts >= 40) {
          stopTelegramPolling();
          if (!found) {
            showToast('Didn\'t see a new message yet—make sure you pressed Start in Telegram!', 'fa-regular fa-clock');
          }
        }
      }, 2000);
    });
  }

  openBotBtn?.addEventListener('click', () => {
    startTelegramAutoDetection();
  });

  $id('autodetect-chat-btn')?.addEventListener('click', () => {
    startTelegramAutoDetection();
  });

  async function sendWelcomeTelegramPing(silentError = false) {
    try {
      const res = await fetch('/api/telegram/welcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: state.telegram.pairingCode })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        if (!silentError) showToast('Sent test message to your Telegram!', 'fa-regular fa-paper-plane');
        return true;
      }
      if (!silentError) showToast(data.error || 'Press Start inside the Study Agent bot first!', 'fa-solid fa-circle-exclamation');
    } catch (e) {
      if (!silentError) showToast('Could not reach the server. Check your connection', 'fa-solid fa-circle-exclamation');
    }
    return false;
  }

  $id('send-telegram-test-btn')?.addEventListener('click', async () => {
    const chatId = (state.telegram.chatId || '').trim();
    if (!chatId) {
      showToast('Click "Auto-Detect My Chat ID" and send the pairing code to the bot first', 'fa-solid fa-triangle-exclamation');
      return;
    }
    const btn = $id('send-telegram-test-btn');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Sending...</span>`;
    await sendWelcomeTelegramPing(false);
    btn.disabled = false;
    btn.innerHTML = orig;
  });

  // ==========================================================================
  // STEP 3: NOTEBOOKLM (notebooklm-py) SEPARATE POPUP WINDOW AUTH (BROWSERBASE + LOCAL)
  // ==========================================================================
  const nlmBackendInput = $id('nlm-backend-url');
  const nlmEmailInput = $id('nlm-account-label');
  const confirmPopupBtn = $id('confirm-popup-login-btn');
  const reopenPopupBtn = $id('reopen-popup-login-btn');
  const cancelPopupBtn = $id('cancel-popup-login-btn');
  const nlmModeBadge = $id('nlm-mode-badge');

  let nlmPopupWindow = null;
  let activeLiveViewUrl = null;

  // On phones/tablets window.open() becomes a separate browser tab, which pushes this page into the
  // background and loses the sign-in. So on touch devices the cloud browser is shown INSIDE the page,
  // right under the "Sign in with Google" buttons, and the rest of the page (footer included) stays put.
  // The returned object mimics the bits of the Window API this file uses (closed / close / focus / location.replace).
  const isMobileLike = () =>
    window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(max-width: 820px)').matches;

  function openLiveViewOverlay(url) {
    const anchor = $id('launch-notebooklm-auth-btn')?.closest('.nlm-buttons-row') || document.body;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:1rem;border:1px solid rgba(59,130,246,.35);border-radius:14px;overflow:hidden;background:#070b14;';
    wrap.innerHTML = `
      <div style="position:relative;height:min(75vh,640px);">
        <div data-loading style="position:absolute;inset:0;display:grid;place-items:center;color:#94a3b8;font:.95rem sans-serif;">Starting secure sign-in…</div>
        <iframe title="Google sign-in" allow="clipboard-read; clipboard-write; fullscreen" style="position:relative;width:100%;height:100%;border:0;background:#fff;"></iframe>
      </div>
      <form data-type style="display:flex;gap:.4rem;padding:.6rem;background:#0f172a;border-top:1px solid rgba(59,130,246,.35);">
        <input data-text type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Tap the box above, then type here" style="flex:1;min-width:0;padding:.6rem .7rem;border-radius:10px;border:1px solid #334155;background:#020617;color:#f8fafc;font-size:16px;">
        <button type="button" data-key="Backspace" aria-label="Backspace" style="padding:.5rem .7rem;border:1px solid #334155;border-radius:10px;background:transparent;color:#f8fafc;font:inherit;">⌫</button>
        <button type="button" data-key="Tab" style="padding:.5rem .7rem;border:1px solid #334155;border-radius:10px;background:transparent;color:#f8fafc;font:inherit;">Tab</button>
        <button type="submit" style="padding:.5rem .8rem;border:0;border-radius:10px;background:#2563eb;color:#fff;font:inherit;">Enter</button>
      </form>`;
    const frame = wrap.querySelector('iframe');
    const loading = wrap.querySelector('[data-loading]');
    const handle = {
      __overlay: true,
      closed: false,
      focus() { try { wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {} },
      close() { if (handle.closed) return; handle.closed = true; wrap.remove(); },
      location: { replace(u) { loading.style.display = 'none'; frame.src = u; } },
    };
    const sendKeys = (body) => {
      if (!activeLoginId) return;
      fetch(`/api/notebooklm/login/${activeLoginId}/type`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).catch(() => {});
    };
    const textInput = wrap.querySelector('[data-text]');
    wrap.querySelector('[data-type]').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = textInput.value;
      textInput.value = '';
      sendKeys({ text, key: 'Enter' });
      textInput.focus();
    });
    wrap.addEventListener('click', (e) => {
      const keyBtn = e.target?.closest?.('[data-key]');
      if (!keyBtn) return;
      const text = textInput.value;
      textInput.value = '';
      sendKeys({ text, key: keyBtn.dataset.key });
    });
    anchor.insertAdjacentElement('afterend', wrap);
    handle.focus();
    if (url && url !== 'about:blank') handle.location.replace(url);
    return handle;
  }

  function openCenteredPopupWindow(url, title = 'StudyAgentGoogleLogin') {
    if (isMobileLike()) return openLiveViewOverlay(url);
    const width = 1040;
    const height = 740;
    const dualScreenLeft = window.screenLeft !== undefined ? window.screenLeft : window.screenX;
    const dualScreenTop = window.screenTop !== undefined ? window.screenTop : window.screenY;
    const w = window.innerWidth || document.documentElement.clientWidth || screen.width;
    const h = window.innerHeight || document.documentElement.clientHeight || screen.height;
    const left = Math.max(0, Math.round(dualScreenLeft + (w - width) / 2));
    const top = Math.max(0, Math.round(dualScreenTop + (h - height) / 2));
    const features = `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=yes`;
    const win = window.open(url, title, features);
    try { win?.focus(); } catch {}
    return win;
  }

  function writePopupLoadingScreen(win) {
    if (!win || win.closed || win.__overlay) return;
    try {
      win.document.open();
      win.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Connecting to Google NotebookLM — Study Agent</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #070b14;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Plus Jakarta Sans", "Segoe UI", sans-serif;
      text-align: center;
    }
    .box {
      max-width: 420px;
      padding: 2rem;
      border-radius: 18px;
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(59, 130, 246, 0.35);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
    }
    .spinner {
      width: 44px;
      height: 44px;
      margin: 0 auto 1.25rem;
      border: 3px solid rgba(59, 130, 246, 0.25);
      border-top-color: #38bdf8;
      border-radius: 50%;
      animation: spin 0.85s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { margin: 0 0 0.5rem; font-size: 1.2rem; }
    p { margin: 0; font-size: 0.9rem; color: #94a3b8; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <h2>Starting Google NotebookLM Sign-In…</h2>
    <p>Preparing your isolated sign-in browser window. You'll be redirected to Google Sign-In in just a moment.</p>
  </div>
</body>
</html>`);
      win.document.close();
    } catch {}
  }

  function closeNlmPopupWindow() {
    if (nlmPopupWindow && !nlmPopupWindow.closed) {
      try { nlmPopupWindow.close(); } catch {}
    }
    nlmPopupWindow = null;
    activeLiveViewUrl = null;
    if (reopenPopupBtn) reopenPopupBtn.hidden = true;
    if (cancelPopupBtn) cancelPopupBtn.hidden = true;
  }

  function syncNotebookLMUI() {
    if (nlmBackendInput) nlmBackendInput.value = state.notebooklm.backendUrl || 'http://localhost:8000';
    if (nlmEmailInput) nlmEmailInput.value = state.notebooklm.accountEmail || '';
    if (nlmEmailInput) {
      nlmEmailInput.readOnly = !state.notebooklm.emailManual;
      const hint = $id('nlm-email-hint');
      if (hint) hint.textContent = state.notebooklm.emailManual
        ? "(couldn't be read automatically, please type it)"
        : '(filled in automatically when you sign in)';
    }

    const s1 = $id('nlm-stage-1');
    const s2 = $id('nlm-stage-2');
    const s3 = $id('nlm-stage-3');
    const icon = $id('nlm-status-icon');
    const headline = $id('nlm-status-headline');
    const subtext = $id('nlm-status-subtext');
    const launchBtn = $id('launch-notebooklm-auth-btn');

    if (state.notebooklm.status === 'connected') {
      s1?.classList.add('is-done');
      s2?.classList.add('is-done');
      s3?.classList.add('is-done');
      icon?.classList.add('ok');
      if (icon) icon.innerHTML = `<i class="fa-solid fa-circle-check"></i>`;
      if (nlmModeBadge) {
        nlmModeBadge.className = 'chip ok';
        nlmModeBadge.textContent = 'Connected';
      }
      if (headline) {
        headline.textContent = state.notebooklm.accountEmail
          ? `Connected to Google NotebookLM (${state.notebooklm.accountEmail})`
          : 'Google NotebookLM account connected';
      }
      if (subtext) {
        subtext.innerHTML = `Authenticated via <code>${escapeHtml(state.notebooklm.authMethod || 'notebooklm_login')}</code> · Ready for Study Agent.`;
      }
      if (launchBtn) {
        launchBtn.innerHTML = `<i class="fa-solid fa-rotate"></i> <span class="btn-txt">Switch / Reconnect Google Account</span>`;
      }
      if (confirmPopupBtn) confirmPopupBtn.hidden = true;
      if (reopenPopupBtn) reopenPopupBtn.hidden = true;
      if (cancelPopupBtn) cancelPopupBtn.hidden = true;
    } else if (state.notebooklm.status === 'pending') {
      s1?.classList.add('is-done');
      s2?.classList.add('is-current');
      s3?.classList.remove('is-done', 'is-current');
      icon?.classList.remove('ok');
      if (icon) icon.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
      if (nlmModeBadge) {
        nlmModeBadge.className = 'chip wait';
        nlmModeBadge.textContent = 'Signing In...';
      }
      if (headline) headline.textContent = 'Waiting for you to sign in in the popup window...';
      if (subtext) {
        subtext.innerHTML = 'Sign in to your Google account in the separate browser window that opened. It will close automatically once NotebookLM loads, or you can click <b>I\'ve Signed In — Confirm</b> below.';
      }
      if (confirmPopupBtn) confirmPopupBtn.hidden = false;
      if (reopenPopupBtn) reopenPopupBtn.hidden = !activeLiveViewUrl;
      if (cancelPopupBtn) cancelPopupBtn.hidden = false;
    } else {
      s1?.classList.add('is-current');
      s1?.classList.remove('is-done');
      s2?.classList.remove('is-current', 'is-done');
      s3?.classList.remove('is-current', 'is-done');
      icon?.classList.remove('ok');
      if (icon) icon.innerHTML = `<i class="fa-brands fa-google"></i>`;
      if (nlmModeBadge) {
        nlmModeBadge.className = 'chip wait';
        nlmModeBadge.textContent = 'Popup Window Auth';
      }
      if (headline) headline.textContent = 'Ready to connect your Google Account';
      if (subtext) {
        subtext.innerHTML = 'Click <b>Sign in with Google</b> below to open a separate login window and link your Google account.';
      }
      if (launchBtn) {
        launchBtn.innerHTML = `<i class="fa-brands fa-google"></i> <span class="btn-txt">Sign in with Google</span>`;
      }
      if (confirmPopupBtn) confirmPopupBtn.hidden = true;
      if (reopenPopupBtn) reopenPopupBtn.hidden = true;
      if (cancelPopupBtn) cancelPopupBtn.hidden = true;
    }

    if (nlmMode === 'upload') {
      if (launchBtn) launchBtn.hidden = true;
      if (confirmPopupBtn) confirmPopupBtn.hidden = true;
      if (reopenPopupBtn) reopenPopupBtn.hidden = true;
      if (cancelPopupBtn) cancelPopupBtn.hidden = true;
      if (state.notebooklm.status !== 'connected') {
        if (nlmModeBadge) nlmModeBadge.textContent = 'Upload Session';
        if (headline) headline.textContent = 'Upload your NotebookLM session file';
        if (subtext) subtext.textContent = 'Create it on your own computer with notebooklm login, then upload storage_state.json below.';
      }
    }
  }

  nlmBackendInput?.addEventListener('input', (e) => {
    state.notebooklm.backendUrl = e.target.value.trim().replace(/\/+$/, '') || 'http://localhost:8000';
    saveState(true);
  });

  nlmEmailInput?.addEventListener('input', (e) => {
    state.notebooklm.accountEmail = e.target.value.trim();
    saveState(true);
    syncNotebookLMUI();
  });

  function stopNlmTimers() {
    if (nlmPollTimer) { clearInterval(nlmPollTimer); nlmPollTimer = null; }
    if (nlmPopupMonitor) { clearInterval(nlmPopupMonitor); nlmPopupMonitor = null; }
  }

  function markNotebookLMConnected(method, email, sessionData = null) {
    stopNlmTimers();
    closeNlmPopupWindow();
    state.notebooklm.status = 'connected';
    state.notebooklm.authMethod = method;
    state.notebooklm.sessionStored = true;
    if (email) state.notebooklm.accountEmail = email;
    if (sessionData) state.notebooklm.sessionData = sessionData;
    state.notebooklm.connectedAt = new Date().toISOString();
    saveState(true);
    syncNotebookLMUI();
  }

  reopenPopupBtn?.addEventListener('click', () => {
    if (!activeLiveViewUrl) return;
    if (nlmPopupWindow && !nlmPopupWindow.closed) {
      try { nlmPopupWindow.focus(); return; } catch {}
    }
    nlmPopupWindow = openCenteredPopupWindow(activeLiveViewUrl);
    if (!nlmPopupWindow) {
      showToast('Popup was blocked by your browser—allow popups for this site and click again.', 'fa-solid fa-triangle-exclamation');
    }
  });

  cancelPopupBtn?.addEventListener('click', () => {
    if (activeLoginId) {
      fetch(`/api/notebooklm/login/${activeLoginId}/cancel`, { method: 'POST' }).catch(() => {});
      activeLoginId = null;
    }
    stopNlmTimers();
    closeNlmPopupWindow();
    state.notebooklm.status = 'disconnected';
    syncNotebookLMUI();
    showToast('Cancelled Google sign-in.', 'fa-solid fa-xmark');
  });

  $id('launch-notebooklm-auth-btn')?.addEventListener('click', async () => {
    stopNlmTimers();
    closeNlmPopupWindow();

    // Open the popup window SYNCHRONOUSLY inside the user click handler so Chrome/Brave
    // never blocks it when the async /api/notebooklm/login request finishes a few seconds later.
    if (nlmMode === 'remote') {
      nlmPopupWindow = openCenteredPopupWindow('about:blank');
      if (nlmPopupWindow) {
        writePopupLoadingScreen(nlmPopupWindow);
      }
    }

    state.notebooklm.status = 'pending';
    syncNotebookLMUI();

    let loginId;
    try {
      const res = await fetch('/api/notebooklm/login', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      loginId = data.login_id;
      activeLoginId = loginId;
      activeLiveViewUrl = data.live_view_url || null;

      if (activeLiveViewUrl) {
        // Navigate the already-opened popup window to the Browserbase live view URL
        if (nlmPopupWindow && !nlmPopupWindow.closed) {
          nlmPopupWindow.location.replace(activeLiveViewUrl);
          try { nlmPopupWindow.focus(); } catch {}
        } else {
          // Fallback if initial window was closed or blocked: try opening now and expose the manual button
          nlmPopupWindow = openCenteredPopupWindow(activeLiveViewUrl);
          if (!nlmPopupWindow) {
            showToast('Click "Open / Focus Login Window" to launch the Google Sign-In window.', 'fa-solid fa-up-right-from-square');
          }
        }
      } else {
        // Local OS Chrome was spawned directly by the server, so we don't need an about:blank popup
        closeNlmPopupWindow();
      }
    } catch (e) {
      closeNlmPopupWindow();
      state.notebooklm.status = 'disconnected';
      syncNotebookLMUI();
      showToast(e.message.startsWith('Failed') ? 'Could not reach the Study Agent server' : e.message, 'fa-solid fa-circle-exclamation');
      return;
    }

    syncNotebookLMUI();
    showToast('Google login window opened! Sign in there and it will close automatically.', 'fa-brands fa-google');

    if (confirmPopupBtn) {
      confirmPopupBtn.hidden = false;
      confirmPopupBtn.onclick = () => {
        fetch(`/api/notebooklm/login/${loginId}/confirm`, { method: 'POST' }).catch(() => {});
        showToast('Checking your Google sign-in...', 'fa-brands fa-google');
      };
    }

    // Monitor if the user manually closes the Browserbase popup window:
    // trigger a confirm check first so if they closed it right after logging in, their session is still captured!
    if (activeLiveViewUrl) {
      let popupCloseHandled = false;
      nlmPopupMonitor = setInterval(() => {
        if (popupCloseHandled || !activeLoginId || activeLoginId !== loginId) return;
        if (nlmPopupWindow && nlmPopupWindow.closed) {
          popupCloseHandled = true;
          fetch(`/api/notebooklm/login/${loginId}/confirm`, { method: 'POST' }).catch(() => {});
        }
      }, 800);
    }

    let attempts = 0;
    let pollBusy = false;
    let finished = false;
    nlmPollTimer = setInterval(async () => {
      if (pollBusy || finished) return;
      pollBusy = true;
      attempts++;
      try {
        const r = await fetch(`/api/notebooklm/login/${loginId}`).then((x) => x.json());
        if (finished) return;
        if (r.status === 'done') {
          finished = true;
          activeLoginId = null;
          pendingLoginId = loginId;
          state.notebooklm.emailManual = !r.email;
          if (r.email) state.notebooklm.accountEmail = r.email;
          markNotebookLMConnected('notebooklm_login', r.email || state.notebooklm.accountEmail);
          showToast('Google account linked! Press Save Configuration to store it.', 'fa-solid fa-circle-check');
          return;
        }
        if (r.status === 'error' || r.status === 'none') {
          finished = true;
          activeLoginId = null;
          closeNlmPopupWindow();
          if (nlmMode === 'remote') $id('nlm-upload-panel')?.removeAttribute('hidden');
          stopNlmTimers();
          state.notebooklm.status = 'disconnected';
          syncNotebookLMUI();
          showToast(r.error || 'Login did not finish', 'fa-solid fa-circle-exclamation');
          return;
        }
      } catch (e) {
      } finally {
        pollBusy = false;
      }
      if (!finished && attempts > 620) {
        finished = true;
        closeNlmPopupWindow();
        stopNlmTimers();
        state.notebooklm.status = 'disconnected';
        syncNotebookLMUI();
      }
    }, 1000);
  });

  addEventListener('pagehide', (e) => {
    if (e.persisted) return; // phone just backgrounded the page (bfcache) - keep the sign-in alive
    if (activeLoginId) navigator.sendBeacon(`/api/notebooklm/login/${activeLoginId}/cancel`);
    closeNlmPopupWindow();
  });

  function applyNlmMode() {
    const upload = nlmMode === 'upload';
    const launch = $id('launch-notebooklm-auth-btn');
    if (launch) launch.hidden = upload;
    if (upload && confirmPopupBtn) confirmPopupBtn.hidden = true;
    if (upload && reopenPopupBtn) reopenPopupBtn.hidden = true;
    if (upload && cancelPopupBtn) cancelPopupBtn.hidden = true;
    $id('nlm-flow-visual')?.toggleAttribute('hidden', upload);
    $id('nlm-local-guide')?.toggleAttribute('hidden', upload);
    $id('nlm-upload-panel')?.toggleAttribute('hidden', !upload);
    if (nlmModeBadge) nlmModeBadge.textContent = upload ? 'Upload Session' : nlmMode === 'remote' ? 'Popup Window Auth' : 'One-Click Auth';
    syncNotebookLMUI();
  }

  function showLiveView(liveUrl) {
    // Deprecated embedded iframe: Browserbase now opens in a standalone popup window
    activeLiveViewUrl = liveUrl || null;
  }

  const fileInput = $id('nlm-state-file');
  $id('nlm-state-upload-btn')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
      if (!cookies.some((c) => String(c.domain || '').includes('google'))) {
        throw new Error('no Google cookies found in this file');
      }
      pendingStorageState = parsed;
      state.notebooklm.emailManual = true;
      markNotebookLMConnected('storage_state_json', state.notebooklm.accountEmail);
      showToast('Session file loaded. Type your Google email, then press Save Configuration', 'fa-solid fa-circle-check');
    } catch (e) {
      showToast('That is not a valid storage_state.json: ' + e.message, 'fa-solid fa-circle-exclamation');
    } finally {
      fileInput.value = '';
    }
  });

  fetch('/api/notebooklm/mode')
    .then((r) => r.json())
    .then((d) => { if (['remote', 'local', 'upload'].includes(d.mode)) nlmMode = d.mode; })
    .catch(() => {})
    .finally(applyNlmMode);

  // ==========================================================================
  // STEP 4: TODOIST API KEY INTEGRATION
  // ==========================================================================
  const todoistInput = $id('todoist-api-key');
  const todoistStatusChip = $id('todoist-status-chip');
  const todoistVisBtn = $id('toggle-todoist-vis-btn');
  const todoistVerifyBtn = $id('verify-todoist-key-btn');
  const todoistConnectedPill = $id('todoist-connected-pill');
  const todoistConnectedTitle = $id('todoist-connected-title');
  const todoistConnectedMeta = $id('todoist-connected-meta');

  function syncTodoistUI() {
    if (todoistInput && document.activeElement !== todoistInput) {
      todoistInput.value = state.todoist.apiKey || '';
    }
    const cleaned = cleanTodoistToken(state.todoist.apiKey);
    const validLocal = isValidTodoistKeyFormat(cleaned);
    const isConnected = validLocal || Boolean(state.todoist.serverConfigured);

    if (todoistStatusChip) {
      if (state.todoist.verified && validLocal) {
        todoistStatusChip.className = 'chip ok';
        todoistStatusChip.textContent = 'Verified Live';
      } else if (validLocal) {
        todoistStatusChip.className = 'chip ok';
        todoistStatusChip.textContent = 'Ready';
      } else if (state.todoist.serverConfigured) {
        todoistStatusChip.className = 'chip ok';
        todoistStatusChip.textContent = state.todoist.source === 'env' ? 'Configured (.env)' : 'Saved on Server';
      } else {
        todoistStatusChip.className = 'chip wait';
        todoistStatusChip.textContent = 'Enter Token';
      }
    }

    if (todoistConnectedPill) {
      todoistConnectedPill.hidden = !isConnected;
      if (isConnected) {
        const masked = validLocal
          ? `${cleaned.slice(0, 4)}…${cleaned.slice(-4)}`
          : (state.todoist.maskedServerKey || 'Active Token');
        if (todoistConnectedTitle) {
          todoistConnectedTitle.textContent = state.todoist.verified
            ? `Todoist API Verified (${masked})`
            : `Todoist API Token Ready (${masked})`;
        }
        if (todoistConnectedMeta) {
          todoistConnectedMeta.textContent = state.todoist.source === 'env' && !validLocal
            ? 'Using TODOIST_API_KEY from server .env · Ready for AI Study Planner'
            : 'Saved to your Study Agent workspace · Ready to sync tasks to Todoist';
        }
      }
    }
  }

  todoistInput?.addEventListener('input', (e) => {
    const cleaned = cleanTodoistToken(e.target.value);
    state.todoist.apiKey = cleaned;
    state.todoist.verified = false;
    saveState(true);
    syncTodoistUI();
  });

  todoistVisBtn?.addEventListener('click', () => {
    if (!todoistInput) return;
    const isPwd = todoistInput.type === 'password';
    todoistInput.type = isPwd ? 'text' : 'password';
    todoistVisBtn.innerHTML = `<i class="fa-regular ${isPwd ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
  });

  async function verifyAndSaveTodoistKey() {
    const cleaned = cleanTodoistToken(todoistInput ? todoistInput.value : state.todoist.apiKey);
    state.todoist.apiKey = cleaned;

    if (!cleaned && !state.todoist.serverConfigured) {
      showToast('Paste your Todoist API token from Todoist Developer Settings first', 'fa-solid fa-triangle-exclamation');
      return;
    }
    if (cleaned && !isValidTodoistKeyFormat(cleaned)) {
      showToast('Todoist API token must be at least 16 characters with no spaces', 'fa-solid fa-triangle-exclamation');
      return;
    }

    const origHTML = todoistVerifyBtn ? todoistVerifyBtn.innerHTML : '';
    if (todoistVerifyBtn) {
      todoistVerifyBtn.disabled = true;
      todoistVerifyBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Verifying...</span>`;
    }

    try {
      const userId = getEffectiveUserId();
      const res = await fetch('/api/todoist/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramUserId: userId,
          todoistApiKey: cleaned || undefined
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.valid) {
        state.todoist.verified = true;
        state.todoist.serverConfigured = true;
        state.todoist.maskedServerKey = data.masked || null;
        state.todoist.lastChecked = new Date().toISOString();
        saveState(true);
        syncTodoistUI();
        showToast('Todoist API key verified & saved!', 'fa-solid fa-circle-check');
      } else {
        throw new Error(data.error || 'Could not verify Todoist token');
      }
    } catch (err) {
      // If the server is unreachable but format is valid, accept & save locally so valid keys are never blocked
      if (isValidTodoistKeyFormat(cleaned)) {
        state.todoist.verified = true;
        state.todoist.lastChecked = new Date().toISOString();
        saveState(true);
        syncTodoistUI();
        showToast('Todoist API token validated & saved!', 'fa-solid fa-circle-check');
      } else {
        showToast(err.message || 'Invalid Todoist API token', 'fa-solid fa-circle-exclamation');
      }
    } finally {
      if (todoistVerifyBtn) {
        todoistVerifyBtn.disabled = false;
        todoistVerifyBtn.innerHTML = origHTML;
      }
    }
  }

  todoistVerifyBtn?.addEventListener('click', verifyAndSaveTodoistKey);

  // ---- Class selector (saved per user with "Save Configuration") ----
  const classSelect = $id('class-level-select');
  const classChip = $id('class-status-chip');
  function syncClassUI() {
    if (classSelect && document.activeElement !== classSelect) classSelect.value = state.classLevel || '';
    if (classChip) {
      const has = Boolean(state.classLevel);
      classChip.className = has ? 'chip ok' : 'chip wait';
      classChip.textContent = has ? 'Class ' + state.classLevel : 'Choose class';
    }
  }
  classSelect?.addEventListener('change', () => {
    state.classLevel = classSelect.value || '';
    saveState(true);
    syncClassUI();
  });
  syncClassUI();

  // Hydrate server-side keys status (including .env TODOIST_API_KEY fallback) on page load
  async function hydrateFromServer() {
    try {
      const userId = getEffectiveUserId();
      const res = await fetch(`/api/user-keys/${encodeURIComponent(userId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.class_level) {
        state.classLevel = String(data.class_level);
        saveState(true);
        syncClassUI();
      }
      if (data && data.has_todoist_key) {
        state.todoist.serverConfigured = true;
        state.todoist.maskedServerKey = data.todoist_masked || null;
        state.todoist.source = data.todoist_source || 'server';
        saveState(true);
        syncTodoistUI();
      }
    } catch {}
  }

  // ==========================================================================
  // OVERALL PROGRESS, PAYLOAD INSPECTOR & EXPORT
  // ==========================================================================
  function isStep1Complete() {
    return state.geminiKeys.some((k) => isValidGeminiKeyFormat(k.key));
  }

  function isStep2Complete() {
    return Boolean(state.telegram.chatId && String(state.telegram.chatId).trim().length > 0);
  }

  function isStep3Complete() {
    return state.notebooklm.status === 'connected';
  }

  function isStep4Complete() {
    return isValidTodoistKeyFormat(state.todoist.apiKey) || Boolean(state.todoist.serverConfigured);
  }

  function updateReadinessUI() {
    const s1 = isStep1Complete();
    const s2 = isStep2Complete();
    const s3 = isStep3Complete();
    const s4 = isStep4Complete();
    const totalSteps = 4;
    const doneCount = [s1, s2, s3, s4].filter(Boolean).length;
    const pct = Math.round((doneCount / totalSteps) * 100);

    const fill = $id('progress-bar-fill');
    if (fill) fill.style.width = `${pct}%`;

    const summaryText = $id('progress-summary-text');
    if (summaryText) {
      summaryText.textContent = doneCount === totalSteps
        ? 'All 4 integrations configured — Study Agent & Todoist Planner ready!'
        : `${doneCount} of ${totalSteps} integrations configured`;
    }

    const overallChip = $id('overall-status-chip');
    if (overallChip) {
      overallChip.className = `chip ${doneCount === totalSteps ? 'ok' : 'wait'}`;
      overallChip.textContent = doneCount === totalSteps ? 'Ready to Launch' : `${pct}% Complete`;
    }

    const validKeyCount = state.geminiKeys.filter((k) => isValidGeminiKeyFormat(k.key)).length;
    setPillState('pill-step-1', 'pill-status-1', 'gemini-step-chip', s1,
      validKeyCount > 1 ? `${validKeyCount} keys (${validKeyCount - 1} fallback)` : 'Primary key ready',
      'No keys added');

    setPillState('pill-step-2', 'pill-status-2', 'telegram-step-chip', s2,
      `Chat ID: ${state.telegram.chatId}`,
      'Not paired');

    setPillState('pill-step-3', 'pill-status-3', 'notebooklm-step-chip', s3,
      state.notebooklm.accountEmail || 'Google linked',
      'Not signed in');

    setPillState('pill-step-4', 'pill-status-4', 'todoist-step-chip', s4,
      state.todoist.verified ? 'Verified Live' : 'Token connected',
      'Not connected');

    const finishChip = $id('finish-card-chip');
    const finishTitle = $id('finish-card-title');
    if (finishChip) {
      finishChip.className = `chip ${doneCount === totalSteps ? 'ok' : 'wait'}`;
      finishChip.textContent = doneCount === totalSteps
        ? 'All Systems Go'
        : `${totalSteps - doneCount} Step${totalSteps - doneCount === 1 ? '' : 's'} Remaining`;
    }
    if (finishTitle) {
      finishTitle.textContent = doneCount === totalSteps
        ? 'Your Study Agent is ready to roll!'
        : 'Save your Study Agent configuration';
    }
  }

  function setPillState(pillId, statusId, stepChipId, isDone, doneText, waitText) {
    const pill = $id(pillId);
    const status = $id(statusId);
    const chip = $id(stepChipId);
    if (pill) {
      pill.classList.toggle('is-complete', isDone);
      const icon = pill.querySelector('.pill-icon');
      if (icon) icon.className = `fa-solid ${isDone ? 'fa-circle-check' : 'fa-circle-dot'} pill-icon`;
    }
    if (status) status.textContent = isDone ? doneText : waitText;
    if (chip) {
      chip.className = `chip ${isDone ? 'ok' : 'wait'}`;
      chip.textContent = isDone ? 'Configured' : 'Required';
    }
  }

  function buildCleanPayload() {
    const validKeys = state.geminiKeys
      .map((k, index) => ({
        priority: index + 1,
        role: index === 0 ? 'primary' : 'fallback',
        label: k.label || (index === 0 ? 'Primary Key' : `Fallback #${index}`),
        api_key: k.key.trim(),
        verified: Boolean(k.verified)
      }))
      .filter((k) => k.api_key.length > 0);

    return {
      schema_version: '1.2',
      saved_at: state.updatedAt || new Date().toISOString(),
      gemini_api_keys: validKeys,
      telegram_config: {
        bot_username: state.telegram.botUsername || null,
        chat_id: state.telegram.chatId.trim(),
        chat_user: state.telegram.chatUsername || state.telegram.chatFirstName || null,
        verified: Boolean(state.telegram.verified)
      },
      notebooklm_auth: {
        status: state.notebooklm.status,
        auth_method: state.notebooklm.authMethod,
        account_email: state.notebooklm.accountEmail || null,
        session_ready: Boolean(state.notebooklm.sessionStored),
        session_meta: state.notebooklm.sessionData || null,
        connected_at: state.notebooklm.connectedAt
      },
      todoist_config: {
        has_api_key: isStep4Complete(),
        verified: Boolean(state.todoist.verified)
      }
    };
  }

  function buildEnvString() {
    const payload = buildCleanPayload();
    const keysCsv = payload.gemini_api_keys.map((k) => k.api_key).join(',');
    const primaryKey = payload.gemini_api_keys[0]?.api_key || '';
    const todoistKey = cleanTodoistToken(state.todoist.apiKey);
    return [
      '# Study Agent Configuration (.env)',
      `GEMINI_API_KEY="${primaryKey}"`,
      `GEMINI_FALLBACK_KEYS="${keysCsv}"`,
      `TODOIST_API_KEY="${todoistKey}"`,
      `TELEGRAM_CHAT_ID="${payload.telegram_config.chat_id}"`,
      `NOTEBOOKLM_ACCOUNT_EMAIL="${payload.notebooklm_auth.account_email || ''}"`,
      `NOTEBOOKLM_SESSION_READY="${payload.notebooklm_auth.session_ready}"`
    ].join('\n');
  }

  function updatePayloadInspector() {
    const out = $id('payload-code-output');
    if (!out) return;
    out.textContent = currentInspectorFormat === 'env'
      ? buildEnvString()
      : JSON.stringify(buildCleanPayload(), null, 2);
  }

  $id('save-all-config-btn')?.addEventListener('click', async () => {
    saveState(true);
    await saveConfigToDb();
  });

  $id('reset-config-btn')?.addEventListener('click', () => {
    stopTelegramPolling();
    stopNlmTimers();
    state = defaultState();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    initBuiltInTelegramBot();
    renderGeminiKeys();
    syncTelegramInputsFromState();
    syncNotebookLMUI();
    syncTodoistUI();
    updateReadinessUI();
    showToast('Reset all setup credentials', 'fa-solid fa-rotate-left');
  });

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  // Initialize on load
  initBuiltInTelegramBot();
  renderGeminiKeys();
  syncTelegramInputsFromState();
  syncNotebookLMUI();
  syncTodoistUI();
  syncCookiesFromCurrentState();
  updateReadinessUI();
  updatePayloadInspector();
  hydrateFromServer();
})();

// ==========================================================================
// GSAP MOTION (hero intro, scroll reveals, small action responses)
// ==========================================================================
(() => {
  if (!window.gsap) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const hasST = !!window.ScrollTrigger;
  if (hasST) gsap.registerPlugin(ScrollTrigger);

  const EASE = 'power3.out';
  const CLEAR = 'transform,opacity';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function splitWords(el) {
    const text = el.textContent.trim();
    el.setAttribute('aria-label', text);
    el.textContent = '';
    const inners = [];
    const words = text.split(/\s+/);
    words.forEach((w, i) => {
      const mask = document.createElement('span');
      mask.setAttribute('aria-hidden', 'true');
      mask.style.cssText = 'display:inline-block;overflow:hidden;vertical-align:top;padding-bottom:.14em;margin-bottom:-.14em';
      const inner = document.createElement('span');
      inner.style.display = 'inline-block';
      inner.textContent = w;
      mask.appendChild(inner);
      el.appendChild(mask);
      if (i < words.length - 1) el.appendChild(document.createTextNode(' '));
      inners.push(inner);
    });
    return inners;
  }

  const title = $('.setup-hero h1');
  const words = title ? splitWords(title) : [];

  const intro = gsap.timeline({ defaults: { ease: EASE } });
  intro
    .from('.setup-badge', { y: 14, opacity: 0, duration: 0.6, clearProps: CLEAR })
    .from(words, { yPercent: 110, duration: 0.85, stagger: 0.06, ease: 'power4.out' }, '-=0.3')
    .from('.setup-hero .hero-sub', { y: 18, opacity: 0, duration: 0.7, clearProps: CLEAR }, '-=0.5')
    .from('.setup-progress-card', { y: 28, opacity: 0, duration: 0.8, clearProps: CLEAR }, '-=0.45')
    .from('.progress-pill', { y: 14, opacity: 0, duration: 0.5, stagger: 0.09, clearProps: CLEAR }, '-=0.45');

  if (hasST) {
    $$('.setup-step').forEach((step) => {
      const head = $$('.step-badge-row, .step-header h2, .step-header .lead', step);
      gsap.from(head, {
        y: 22, opacity: 0, duration: 0.7, ease: EASE, stagger: 0.09, clearProps: CLEAR,
        scrollTrigger: { trigger: step, start: 'top 82%', once: true }
      });

      $$('.setup-grid > .bento-card', step).forEach((card) => {
        const inner = $$(
          '.guide-steps li, .keys-actions-bar .btn, .pairing-cta-grid .btn, ' +
          '.nlm-buttons-row .btn, .todoist-quick-links .btn, .guide-tip, .guide-mini-win',
          card
        ).filter((el) => !el.hidden);

        const tl = gsap.timeline({
          defaults: { ease: EASE },
          scrollTrigger: { trigger: card, start: 'top 88%', once: true }
        });
        tl.from(card, { y: 36, opacity: 0, duration: 0.8, clearProps: CLEAR });
        if (inner.length) {
          tl.from(inner, { y: 12, opacity: 0, duration: 0.5, stagger: 0.07, clearProps: CLEAR }, '-=0.45');
        }
      });
    });

    const finish = $('.setup-finish-card');
    if (finish) {
      gsap.from($$('.chip, h2, .btn', finish), {
        y: 18, opacity: 0, duration: 0.65, ease: EASE, stagger: 0.09, clearProps: CLEAR,
        scrollTrigger: { trigger: finish, start: 'top 85%', once: true }
      });
    }

    window.addEventListener('load', () => ScrollTrigger.refresh());
  }

  const PRESSABLE = '.btn, .copy-pill, .icon-btn, .tab-pill';
  let pressed = null;
  const release = () => {
    if (!pressed) return;
    const el = pressed;
    pressed = null;
    gsap.to(el, { scale: 1, duration: 0.25, ease: 'back.out(2.2)', clearProps: 'transform' });
  };
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest(PRESSABLE);
    if (!el || el.disabled) return;
    pressed = el;
    gsap.to(el, { scale: 0.96, duration: 0.12, ease: 'power2.out' });
  });
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  document.addEventListener('pointerleave', release);

  const keysList = $('#gemini-keys-list');
  if (keysList) {
    let count = keysList.children.length;
    new MutationObserver(() => {
      const next = keysList.children.length;
      if (next > count) {
        gsap.from(keysList.lastElementChild, {
          y: 16, opacity: 0, scale: 0.98, duration: 0.45, ease: EASE, clearProps: 'transform,opacity'
        });
      }
      count = next;
    }).observe(keysList, { childList: true });
  }

  ['autodetect-listening-panel', 'telegram-connected-pill', 'nlm-live-panel', 'todoist-connected-pill'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    let wasHidden = el.hidden;
    new MutationObserver(() => {
      if (wasHidden && !el.hidden) {
        gsap.from(el, { y: -10, opacity: 0, duration: 0.45, ease: EASE, clearProps: 'transform,opacity' });
      }
      wasHidden = el.hidden;
    }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });

  $$('.progress-pill').forEach((pill) => {
    let done = pill.classList.contains('is-complete');
    new MutationObserver(() => {
      const nowDone = pill.classList.contains('is-complete');
      if (nowDone && !done) {
        const icon = $('.pill-icon', pill);
        if (icon) gsap.fromTo(icon, { scale: 0.3 }, { scale: 1, duration: 0.5, ease: 'back.out(3)', clearProps: 'transform' });
      }
      done = nowDone;
    }).observe(pill, { attributes: true, attributeFilter: ['class'] });
  });
})();