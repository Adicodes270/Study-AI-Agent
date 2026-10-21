// ==========================================================================
// setup.js — Onboarding & Configuration Logic for Study Agent
// Built-in Telegram Bot + Gemini Multi-Key Fallback + NotebookLM Popup/Bridge Auth
// ==========================================================================

(() => {
  const STORAGE_KEY = 'study_agent_config';

  // The bot token lives only on the server (.env). This page talks to /api/telegram/* instead of Telegram.
  const STUDY_AGENT_WEB_LINK = 'https://web.telegram.org/a/#8996972210';

  const defaultState = () => ({
    version: '1.1.0',
    updatedAt: null,
    geminiKeys: [
      { id: cryptoId(), label: 'Primary Key', key: '', verified: false, lastChecked: null }
    ],
    telegram: {
      botUsername: '',
      botName: 'Study Agent Bot',
      pairingCode: 'SA-' + Math.floor(1000 + Math.random() * 9000),
      chatId: '',
      chatFirstName: '',
      chatUsername: '',
      verified: false,
      updatedAt: null
    },
    notebooklm: {
      status: 'disconnected', // 'disconnected' | 'pending' | 'connected'
      backendUrl: 'http://localhost:8000',
      accountEmail: '',
      authMethod: null,       // 'local_playwright_bridge' | 'notebooklm_login' | 'storage_state_json'
      sessionData: null,
      sessionStored: false,
      connectedAt: null
    }
  });

  function cryptoId() {
    return 'key_' + Math.random().toString(36).slice(2, 10);
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
        notebooklm: { ...def.notebooklm, ...(parsed.notebooklm || {}) }
      };
    } catch (e) {
      return defaultState();
    }
  }

  function saveState(silent = false) {
    state.updatedAt = new Date().toISOString();
    // Coalesce rapid calls (every keystroke) into one write + one UI refresh per frame
    if (saveQueued) return;
    saveQueued = true;
    requestAnimationFrame(() => {
      saveQueued = false;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {}
      updateReadinessUI();
      updatePayloadInspector();
    });
  }
  let saveQueued = false;

  // NotebookLM session waiting to be saved (kept in memory only, never in localStorage)
  let pendingLoginId = null;
  let pendingStorageState = null; // uploaded storage_state.json (public site), also memory only
  const IS_LOCAL_HOST = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  // How NotebookLM sign-in works here: 'remote' (cloud browser in the page), 'local' (Chrome on this
  // computer) or 'upload' (paste storage_state.json). The server tells us; see applyNlmMode().
  let nlmMode = IS_LOCAL_HOST ? 'local' : 'upload';

  // Mirror the saved settings into browser cookies so quizzes.html can tell who the student is.
  //   sa_telegram_id      numeric Telegram user id
  //   sa_gemini_key       primary Gemini API key (the server prefers the keys saved in the database)
  //   sa_notebooklm_auth  'connected' | 'none'
  function setCookie(name, value) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=31536000; path=/; SameSite=Lax${secure}`;
  }
  function syncCookies(userId, keys, sessionSaved) {
    try {
      setCookie('sa_telegram_id', userId);
      if (keys.length) setCookie('sa_gemini_key', keys[0]);
      const nlm = sessionSaved || state.notebooklm.status === 'connected' || state.notebooklm.sessionStored;
      setCookie('sa_notebooklm_auth', nlm ? 'connected' : 'none');
    } catch (e) { /* cookies blocked: quizzes.html falls back to the saved setup state */ }
  }

  // Save Telegram id + Gemini keys + Google account to the database (Save Configuration button)
  async function saveConfigToDb() {
    const userId = String(state.telegram.userId || state.telegram.chatId || '').trim();
    const keys = state.geminiKeys.map((k) => k.key.trim()).filter(isValidGeminiKeyFormat);
    if (!/^\d+$/.test(userId)) {
      showToast('Pair your Telegram account first (Step 2) so we know whose settings to save', 'fa-solid fa-triangle-exclamation');
      return false;
    }
    const body = {
      telegram_user_id: userId,
      gemini_api_keys: keys,
      google_email: (state.notebooklm.accountEmail || '').trim() || undefined,
      notebooklm_login_id: pendingLoginId || undefined,
      notebooklm_storage_state: (!pendingLoginId && pendingStorageState) || undefined
    };
    if (!keys.length && !pendingLoginId && !pendingStorageState && !body.google_email) {
      showToast('Add a Gemini key or sign in to your Google account first', 'fa-solid fa-key');
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
      const parts = [];
      if (data.keys_saved) parts.push(`${data.keys_saved} Gemini key${data.keys_saved > 1 ? 's' : ''}`);
      if (data.email_saved) parts.push('Google email');
      if (data.session_saved) parts.push('NotebookLM Google session');
      if (data.session_saved) { pendingLoginId = null; pendingStorageState = null; }
      syncCookies(userId, keys, Boolean(data.session_saved));
      showToast('Saved Successfully!', 'fa-solid fa-circle-check');
      return true;
    } catch (e) {
      showToast('Could not save: ' + e.message, 'fa-solid fa-circle-exclamation');
      return false;
    }
  }

  let state = loadState();
  let telegramPollTimer = null;
  let nlmPollTimer = null;
  let activeLoginId = null; // cloud sign-in in progress; cancelled if the page is closed so it stops billing
  let nlmPopupWin = null;
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
    return /^AIza[0-9A-Za-z_-]{20,}$/.test(trimmed) || trimmed.length >= 24;
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

  // Fetch our built-in bot's live @username on load so deep links work with 1 tap
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

  chatIdInput?.addEventListener('input', (e) => {
    state.telegram.chatId = e.target.value.trim();
    state.telegram.userId = state.telegram.chatId;
    state.telegram.verified = Boolean(state.telegram.chatId);
    state.telegram.updatedAt = new Date().toISOString();
    saveState(true);
    syncTelegramInputsFromState();
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

  // Ask our server whether the bot has received "/start <pairing code>" yet.
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
        // The bot itself already replied "Study Agent is linked!" in Telegram
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

  // Clicking "1. Open Study Agent Bot" ALSO starts auto-detecting automatically!
  openBotBtn?.addEventListener('click', () => {
    startTelegramAutoDetection();
  });

  $id('autodetect-chat-btn')?.addEventListener('click', () => {
    startTelegramAutoDetection();
  });

  // "Send test message": asks the server to message the chat that paired with our code
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
      showToast('Click "Auto-Detect My Chat ID" or enter your Chat ID first', 'fa-solid fa-triangle-exclamation');
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
  // STEP 3: NOTEBOOKLM (notebooklm-py) SEAMLESS POPUP + LOCAL BRIDGE AUTH
  // ==========================================================================
  const nlmBackendInput = $id('nlm-backend-url');
  const nlmEmailInput = $id('nlm-account-label');
  const confirmPopupBtn = $id('confirm-popup-login-btn');
  const nlmModeBadge = $id('nlm-mode-badge');

  function syncNotebookLMUI() {
    if (nlmBackendInput) nlmBackendInput.value = state.notebooklm.backendUrl || 'http://localhost:8000';
    if (nlmEmailInput) nlmEmailInput.value = state.notebooklm.accountEmail || '';
    if (nlmEmailInput) {
      // Locked while it comes from Google; opens for typing only if Google's email could not be read
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
      if (headline) headline.textContent = 'Waiting for you to sign in...';
      if (subtext) {
        subtext.innerHTML = 'Sign in to your Google account in the window that just opened on this computer. It closes by itself once you are signed in. If it stays open after you reach NotebookLM, press <b>I\'ve Signed In — Confirm</b>.';
      }
      if (confirmPopupBtn) confirmPopupBtn.hidden = false;
    } else {
      s1?.classList.add('is-current');
      s1?.classList.remove('is-done');
      s2?.classList.remove('is-current', 'is-done');
      s3?.classList.remove('is-current', 'is-done');
      icon?.classList.remove('ok');
      if (icon) icon.innerHTML = `<i class="fa-brands fa-google"></i>`;
      if (nlmModeBadge) {
        nlmModeBadge.className = 'chip wait';
        nlmModeBadge.textContent = 'One-Click Auth';
      }
      if (headline) headline.textContent = 'Ready to connect your Google Account';
      if (subtext) {
        subtext.innerHTML = 'Click <b>Sign in with Google</b> below to open the NotebookLM login window and link your Google account.';
      }
      if (launchBtn) {
        launchBtn.innerHTML = `<i class="fa-brands fa-google"></i> <span class="btn-txt">Sign in with Google</span>`;
      }
      if (confirmPopupBtn) confirmPopupBtn.hidden = true;
    }

    // Cloud browser: the sign-in happens inside the page, not in a window on this computer
    if (nlmMode === 'remote' && state.notebooklm.status === 'pending') {
      if (headline) headline.textContent = 'Sign in to Google in the box below';
      if (subtext) subtext.innerHTML = 'Sign in normally and approve 2-Step Verification if asked. It finishes by itself when NotebookLM loads. If it doesn\'t, press <b>I\'ve Signed In — Confirm</b>.';
    }
    // Public website without a cloud browser: the visitor uploads a session file instead
    if (nlmMode === 'upload') {
      if (launchBtn) launchBtn.hidden = true;
      if (confirmPopupBtn) confirmPopupBtn.hidden = true;
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
    state.notebooklm.status = 'connected';
    state.notebooklm.authMethod = method;
    state.notebooklm.sessionStored = true;
    if (email) state.notebooklm.accountEmail = email;
    if (sessionData) state.notebooklm.sessionData = sessionData;
    state.notebooklm.connectedAt = new Date().toISOString();
    saveState(true);
    syncNotebookLMUI();
  }

  // Sign in: the server opens a Google login window on this computer, captures the session
  // automatically, and closes the window. The session is saved with Save Configuration.
  $id('launch-notebooklm-auth-btn')?.addEventListener('click', async () => {
    stopNlmTimers();
    let loginId;
    try {
      const res = await fetch('/api/notebooklm/login', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      loginId = data.login_id;
      activeLoginId = loginId;
      showLiveView(data.live_view_url || null);
    } catch (e) {
      showToast(e.message.startsWith('Failed') ? 'Could not reach the Study Agent server' : e.message, 'fa-solid fa-circle-exclamation');
      return;
    }
    state.notebooklm.status = 'pending';
    syncNotebookLMUI();
    showToast(nlmMode === 'remote' ? 'Sign in to Google in the box below' : 'A Google login window opened. Sign in there and it will close by itself', 'fa-brands fa-google');
    if (confirmPopupBtn) {
      confirmPopupBtn.hidden = false;
      confirmPopupBtn.onclick = () => {
        fetch(`/api/notebooklm/login/${loginId}/confirm`, { method: 'POST' }).catch(() => {});
        showToast('Checking your Google sign-in...', 'fa-brands fa-google');
      };
    }

    let attempts = 0;
    let pollBusy = false;   // a status request is still in flight
    let finished = false;   // done/error already handled, never handle it twice
    nlmPollTimer = setInterval(async () => {
      if (pollBusy || finished) return; // don't stack requests when the server is slow
      pollBusy = true;
      attempts++;
      try {
        const r = await fetch(`/api/notebooklm/login/${loginId}`).then((x) => x.json());
        if (finished) return;
        if (r.status === 'done') {
          finished = true;
          activeLoginId = null;
          showLiveView(null);
          pendingLoginId = loginId;
          // Use the email of the Google account that just signed in; ask for it only if it couldn't be read
          state.notebooklm.emailManual = !r.email;
          if (r.email) state.notebooklm.accountEmail = r.email;
          markNotebookLMConnected('notebooklm_login', r.email || state.notebooklm.accountEmail);
          showToast('Google account linked. Press Save Configuration to store it', 'fa-solid fa-circle-check');
          return;
        }
        if (r.status === 'error' || r.status === 'none') {
          finished = true;
          activeLoginId = null;
          showLiveView(null);
          if (nlmMode === 'remote') $id('nlm-upload-panel')?.removeAttribute('hidden'); // offer the file upload as a way out
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
        showLiveView(null);
        stopNlmTimers();
        state.notebooklm.status = 'disconnected';
        syncNotebookLMUI();
      }
    }, 1000);
  });

  // Leaving the page mid sign-in: tell the server so the cloud browser is released right away
  addEventListener('pagehide', () => {
    if (activeLoginId) navigator.sendBeacon(`/api/notebooklm/login/${activeLoginId}/cancel`);
  });

  // Show the right sign-in UI for this server (cloud browser / local Chrome / file upload)
  function applyNlmMode() {
    const upload = nlmMode === 'upload';
    const launch = $id('launch-notebooklm-auth-btn');
    if (launch) launch.hidden = upload;
    if (upload && confirmPopupBtn) confirmPopupBtn.hidden = true;
    $id('nlm-flow-visual')?.toggleAttribute('hidden', upload);
    $id('nlm-local-guide')?.toggleAttribute('hidden', upload);
    $id('nlm-upload-panel')?.toggleAttribute('hidden', !upload);
    if (nlmModeBadge) nlmModeBadge.textContent = upload ? 'Upload Session' : nlmMode === 'remote' ? 'Cloud Sign-In' : 'One-Click Auth';
    syncNotebookLMUI();
  }

  function showLiveView(liveUrl) {
    const panel = $id('nlm-live-panel');
    const frame = $id('nlm-live-frame');
    if (!panel || !frame) return;
    if (liveUrl) { frame.src = liveUrl; panel.hidden = false; }
    else { frame.src = 'about:blank'; panel.hidden = true; }
  }

  // Upload fallback: always available if cloud sign-in fails (e.g. Google blocks it)
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
      state.notebooklm.emailManual = true; // the email can't be read from an uploaded file
      markNotebookLMConnected('storage_state_json', state.notebooklm.accountEmail);
      showToast('Session file loaded. Type your Google email, then press Save Configuration', 'fa-solid fa-circle-check');
    } catch (e) {
      showToast('That is not a valid storage_state.json: ' + e.message, 'fa-solid fa-circle-exclamation');
    } finally {
      fileInput.value = '';
    }
  });

  // Ask the server which sign-in it offers (a static host without the server falls back to upload)
  fetch('/api/notebooklm/mode')
    .then((r) => r.json())
    .then((d) => { if (['remote', 'local', 'upload'].includes(d.mode)) nlmMode = d.mode; })
    .catch(() => {})
    .finally(applyNlmMode);

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

  function updateReadinessUI() {
    const s1 = isStep1Complete();
    const s2 = isStep2Complete();
    const s3 = isStep3Complete();
    const doneCount = [s1, s2, s3].filter(Boolean).length;
    const pct = Math.round((doneCount / 3) * 100);

    const fill = $id('progress-bar-fill');
    if (fill) fill.style.width = `${pct}%`;

    const summaryText = $id('progress-summary-text');
    if (summaryText) {
      summaryText.textContent = doneCount === 3
        ? 'All 3 integrations configured — Study Agent is ready!'
        : `${doneCount} of 3 integrations configured`;
    }

    const overallChip = $id('overall-status-chip');
    if (overallChip) {
      overallChip.className = `chip ${doneCount === 3 ? 'ok' : 'wait'}`;
      overallChip.textContent = doneCount === 3 ? 'Ready to Launch' : `${pct}% Complete`;
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

    const finishChip = $id('finish-card-chip');
    const finishTitle = $id('finish-card-title');
    if (finishChip) {
      finishChip.className = `chip ${doneCount === 3 ? 'ok' : 'wait'}`;
      finishChip.textContent = doneCount === 3 ? 'All Systems Go' : `${3 - doneCount} Step${3 - doneCount === 1 ? '' : 's'} Remaining`;
    }
    if (finishTitle) {
      finishTitle.textContent = doneCount === 3
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
      schema_version: '1.1',
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
      }
    };
  }

  function buildEnvString() {
    const payload = buildCleanPayload();
    const keysCsv = payload.gemini_api_keys.map((k) => k.api_key).join(',');
    const primaryKey = payload.gemini_api_keys[0]?.api_key || '';
    return [
      '# Study Agent Configuration (.env)',
      `GEMINI_API_KEY="${primaryKey}"`,
      `GEMINI_FALLBACK_KEYS="${keysCsv}"`,
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
  updateReadinessUI();
  updatePayloadInspector();
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
  const CLEAR = 'transform,opacity'; // hand control back to the CSS hover states afterwards
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Split a plain-text heading into masked words so they can slide up one by one
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

  // ------------------------------------------------------------------------
  // 1. Hero intro (the one orchestrated moment)
  // ------------------------------------------------------------------------
  const title = $('.setup-hero h1');
  const words = title ? splitWords(title) : [];

  const intro = gsap.timeline({ defaults: { ease: EASE } });
  intro
    .from('.setup-badge', { y: 14, opacity: 0, duration: 0.6, clearProps: CLEAR })
    .from(words, { yPercent: 110, duration: 0.85, stagger: 0.06, ease: 'power4.out' }, '-=0.3')
    .from('.setup-hero .hero-sub', { y: 18, opacity: 0, duration: 0.7, clearProps: CLEAR }, '-=0.5')
    .from('.setup-progress-card', { y: 28, opacity: 0, duration: 0.8, clearProps: CLEAR }, '-=0.45')
    .from('.progress-pill', { y: 14, opacity: 0, duration: 0.5, stagger: 0.09, clearProps: CLEAR }, '-=0.45');

  // ------------------------------------------------------------------------
  // 2. Steps: heading first, then each card as it comes into view
  // ------------------------------------------------------------------------
  if (hasST) {
    $$('.setup-step').forEach((step) => {
      const head = $$('.step-badge-row, .step-header h2, .step-header .lead', step);
      gsap.from(head, {
        y: 22, opacity: 0, duration: 0.7, ease: EASE, stagger: 0.09, clearProps: CLEAR,
        scrollTrigger: { trigger: step, start: 'top 82%', once: true }
      });

      // per card, so a card further down the page animates when you reach it
      $$('.setup-grid > .bento-card', step).forEach((card) => {
        const inner = $$(
          '.guide-steps li, .keys-actions-bar .btn, .pairing-cta-grid .btn, ' +
          '.nlm-buttons-row .btn, .guide-tip, .guide-mini-win',
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

    // Final save card
    const finish = $('.setup-finish-card');
    if (finish) {
      gsap.from($$('.chip, h2, .btn', finish), {
        y: 18, opacity: 0, duration: 0.65, ease: EASE, stagger: 0.09, clearProps: CLEAR,
        scrollTrigger: { trigger: finish, start: 'top 85%', once: true }
      });
    }

    // Layout shifts (fonts, content-visibility) can move trigger points
    window.addEventListener('load', () => ScrollTrigger.refresh());
  }

  // ------------------------------------------------------------------------
  // 3. Responses to what the person does
  // ------------------------------------------------------------------------

  // Button press: a quick squeeze, then back to whatever the CSS says
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

  // A new fallback key slot slides in (only when one is added, not on reorder/remove)
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

  // Panels that appear when something starts (listening for Telegram, connected, cloud sign-in)
  ['autodetect-listening-panel', 'telegram-connected-pill', 'nlm-live-panel'].forEach((id) => {
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

  // A readiness pill pops its icon when its step becomes complete
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