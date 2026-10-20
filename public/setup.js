// ==========================================================================
// setup.js — Onboarding & Configuration Logic for Study Agent
// Built-in Telegram Bot + Gemini Multi-Key Fallback + NotebookLM Popup/Bridge Auth
// ==========================================================================

(() => {
  const STORAGE_KEY = 'study_agent_config';

  // The bot token lives on the server only; this page talks to /api/telegram/* instead.
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
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
    updateReadinessUI();
    updatePayloadInspector();
    if (!silent) {
      showToast('Configuration saved to browser storage', 'fa-solid fa-circle-check');
    }
  }

  // NotebookLM session waiting to be saved (kept in memory only, never in localStorage)
  let pendingLoginId = null;

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
      notebooklm_login_id: pendingLoginId || undefined
    };
    if (!keys.length && !pendingLoginId && !body.google_email) {
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
      if (data.session_saved) pendingLoginId = null;
      showToast(`Saved to database for Telegram ID ${userId}: ${parts.join(' + ')}`, 'fa-solid fa-database');
      return true;
    } catch (e) {
      showToast('Could not save to the database: ' + e.message, 'fa-solid fa-circle-exclamation');
      return false;
    }
  }

  let state = loadState();
  let telegramPollTimer = null;
  let nlmPollTimer = null;
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
          openBotBtn.href = `https://t.me/${state.telegram.botUsername}?start=${encodeURIComponent(state.telegram.pairingCode)}`;
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

  async function pollTelegramUpdatesOnce() {
    try {
      // The bot records the chat that sent our pairing code; we just ask the server for it
      const res = await fetch(`/api/telegram/pairing/${encodeURIComponent(state.telegram.pairingCode)}`);
      const data = await res.json();
      if (data && data.found && data.chat_id) {
        const newChatId = String(data.chat_id);
        const firstName = data.first_name || 'Student';

        state.telegram.chatId = newChatId;
        state.telegram.userId = String(data.user_id || newChatId);
        state.telegram.chatFirstName = firstName;
        state.telegram.chatUsername = data.username || '';
        state.telegram.verified = true;
        state.telegram.updatedAt = new Date().toISOString();

        stopTelegramPolling();
        saveState(true);
        syncTelegramInputsFromState();
        showToast(`Detected ${firstName} (Chat ID: ${newChatId})!`, 'fa-brands fa-telegram');

        // Automatically send a confirmation welcome message to their Telegram
        sendWelcomeTelegramPing(newChatId, firstName, true);
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

  async function sendWelcomeTelegramPing(chatId, firstName = 'there', silentError = false) {
    try {
      const res = await fetch('/api/telegram/welcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: state.telegram.pairingCode })
      });
      const data = await res.json();
      if (res.ok && data && data.ok) {
        if (!silentError) showToast('Sent test message to your Telegram!', 'fa-regular fa-paper-plane');
        return true;
      } else if (!silentError) {
        showToast(data?.error || 'Press Start inside the Study Agent bot first!', 'fa-solid fa-circle-exclamation');
      }
    } catch (e) {
      if (!silentError) showToast('Could not reach Telegram API—check your internet connection', 'fa-solid fa-circle-exclamation');
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
    await sendWelcomeTelegramPing(chatId, state.telegram.chatFirstName || 'there', false);
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
    showToast('Google NotebookLM account linked!', 'fa-solid fa-circle-check');
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
    } catch (e) {
      showToast(e.message.startsWith('Failed') ? 'Could not reach the Study Agent server' : e.message, 'fa-solid fa-circle-exclamation');
      return;
    }
    state.notebooklm.status = 'pending';
    syncNotebookLMUI();
    showToast('A Google login window opened. Sign in there and it will close by itself', 'fa-brands fa-google');
    if (confirmPopupBtn) {
      confirmPopupBtn.hidden = false;
      confirmPopupBtn.onclick = () => {
        fetch(`/api/notebooklm/login/${loginId}/confirm`, { method: 'POST' }).catch(() => {});
        showToast('Checking your Google sign-in...', 'fa-brands fa-google');
      };
    }

    let attempts = 0;
    nlmPollTimer = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch(`/api/notebooklm/login/${loginId}`).then((x) => x.json());
        if (r.status === 'done') {
          pendingLoginId = loginId;
          // Use the email of the Google account that just signed in; ask for it only if it couldn't be read
          state.notebooklm.emailManual = !r.email;
          if (r.email) state.notebooklm.accountEmail = r.email;
          markNotebookLMConnected('notebooklm_login', r.email || state.notebooklm.accountEmail);
          showToast('Google account linked. Press Save Configuration to store it', 'fa-solid fa-circle-check');
          return;
        }
        if (r.status === 'error' || r.status === 'none') {
          stopNlmTimers();
          state.notebooklm.status = 'disconnected';
          syncNotebookLMUI();
          showToast(r.error || 'Login did not finish', 'fa-solid fa-circle-exclamation');
          return;
        }
      } catch (e) {}
      if (attempts > 620) {
        stopNlmTimers();
        state.notebooklm.status = 'disconnected';
        syncNotebookLMUI();
      }
    }, 1000);
  });

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

  $id('toggle-json-preview-btn')?.addEventListener('click', () => {
    const inspector = $id('payload-inspector');
    if (!inspector) return;
    inspector.hidden = !inspector.hidden;
    updatePayloadInspector();
  });

  document.querySelectorAll('.tab-pill[data-format]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-pill[data-format]').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      currentInspectorFormat = btn.dataset.format;
      updatePayloadInspector();
    });
  });

  $id('copy-payload-btn')?.addEventListener('click', () => {
    const text = currentInspectorFormat === 'env'
      ? buildEnvString()
      : JSON.stringify(buildCleanPayload(), null, 2);
    copyText(text, `Copied ${currentInspectorFormat.toUpperCase()} configuration!`);
  });

  $id('download-config-btn')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(buildCleanPayload(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'study-agent-config.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Downloaded study-agent-config.json', 'fa-solid fa-download');
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
    updatePayloadInspector();
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