// doubt.js — "Ask a doubt": a floating AI chat popup. Loaded only on quizzes.html and resources.html.
// Everything stays on the page (no external site). Talks to POST /api/doubt/ask.
(function () {
  if (window.__doubtLoaded) return;
  window.__doubtLoaded = true;

  var STORE_KEY = 'sa_doubt_chat';
  var MAX_TURNS_SENT = 10;
  var history = []; // [{ role: 'user' | 'model', text }]
  var busy = false;
  var els = {};

  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function pageName() {
    return /resources/i.test(location.pathname) ? 'resources' : 'quizzes';
  }
  function loadHistory() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) history = arr.filter(function (m) { return m && m.text && (m.role === 'user' || m.role === 'model'); }).slice(-40);
    } catch (e) { history = []; }
  }
  function saveHistory() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(history.slice(-40))); } catch (e) {}
  }

  // What the student is looking at right now (chapter title during a quiz). Pages can also set window.__doubtContext.
  function getContext() {
    if (window.__doubtContext) return String(window.__doubtContext).slice(0, 200);
    var quiz = document.getElementById('view-quiz');
    var title = document.getElementById('quiz-title');
    if (quiz && !quiz.hidden && title && title.textContent.trim()) return title.textContent.trim().slice(0, 200);
    return '';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  }
  // Tiny, safe markdown: paragraphs, bullet / numbered lists, bold, italic, inline code. Input is escaped first.
  function renderMarkdown(text) {
    var lines = String(text).replace(/\r/g, '').split('\n');
    var out = [], list = null, para = [];
    function flushPara() { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } }
    function flushList() { if (list) { out.push('</' + list + '>'); list = null; } }
    lines.forEach(function (line) {
      var ul = line.match(/^\s*[-*•]\s+(.*)$/);
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        var kind = ul ? 'ul' : 'ol';
        if (list !== kind) { flushList(); out.push('<' + kind + '>'); list = kind; }
        out.push('<li>' + inline((ul || ol)[1]) + '</li>');
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(inline(line.replace(/^#{1,6}\s+/, '')));
      }
    });
    flushPara(); flushList();
    return out.join('');
  }

  function build() {
    var fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'dbt-fab';
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.setAttribute('aria-expanded', 'false');
    fab.innerHTML = '<i class="fa-solid fa-circle-question" aria-hidden="true"></i><span class="dbt-fab-label">Ask a doubt</span>';

    var panel = document.createElement('section');
    panel.className = 'dbt-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Ask a doubt');
    panel.innerHTML =
      '<header class="dbt-head">' +
        '<span class="dbt-head-icon"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></span>' +
        '<div class="dbt-head-text"><h2 class="dbt-title">Ask a doubt</h2><p class="dbt-sub" id="dbt-sub">Your AI study helper</p></div>' +
        '<button type="button" class="dbt-icon-btn" id="dbt-clear" title="Clear chat" aria-label="Clear chat"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>' +
        '<button type="button" class="dbt-icon-btn" id="dbt-close" title="Close" aria-label="Close"><span class="dbt-x" aria-hidden="true">\u2715</span></button>' +
      '</header>' +
      '<div class="dbt-body" id="dbt-body" role="log" aria-live="polite"></div>' +
      '<footer class="dbt-foot">' +
        '<form class="dbt-form" id="dbt-form">' +
          '<textarea class="dbt-input" id="dbt-input" rows="1" maxlength="2000" placeholder="Type your doubt…" aria-label="Your doubt"></textarea>' +
          '<button type="submit" class="dbt-send" id="dbt-send" aria-label="Send"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i></button>' +
        '</form>' +
        '<p class="dbt-note">AI can make mistakes. Check important answers with your textbook.</p>' +
      '</footer>';

    document.body.appendChild(fab);
    document.body.appendChild(panel);
    els = {
      fab: fab, panel: panel,
      body: panel.querySelector('#dbt-body'), input: panel.querySelector('#dbt-input'),
      send: panel.querySelector('#dbt-send'), form: panel.querySelector('#dbt-form'),
      sub: panel.querySelector('#dbt-sub'),
    };

    fab.addEventListener('click', openPanel);
    panel.querySelector('#dbt-close').addEventListener('click', function () { closePanel(); });
    panel.querySelector('#dbt-clear').addEventListener('click', function () {
      if (busy) return;
      history = []; saveHistory(); renderAll();
    });
    els.form.addEventListener('submit', function (e) { e.preventDefault(); ask(els.input.value); });
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(els.input.value); }
    });
    els.input.addEventListener('input', autoGrow);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !els.panel.hidden) closePanel();
    });
    // Click / tap outside the popup closes it
    document.addEventListener('pointerdown', function (e) {
      if (els.panel.hidden) return;
      if (els.panel.contains(e.target) || els.fab.contains(e.target)) return;
      closePanel(true);
    });
  }

  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 120) + 'px';
  }
  function scrollDown() { els.body.scrollTop = els.body.scrollHeight; }

  function addBubble(role, html) {
    var d = document.createElement('div');
    d.className = 'dbt-msg ' + (role === 'user' ? 'is-user' : role === 'error' ? 'is-error' : 'is-ai');
    d.innerHTML = html;
    els.body.appendChild(d);
    return d;
  }

  var SUGGESTIONS = ["Explain this chapter's main idea simply", 'Give me an easy way to remember this', 'Why is this important for exams?'];

  function renderAll() {
    els.body.innerHTML = '';
    if (!history.length) {
      var empty = document.createElement('div');
      empty.className = 'dbt-empty';
      empty.innerHTML = '<i class="fa-solid fa-lightbulb" aria-hidden="true"></i><p>Stuck on something? Ask me any study doubt.</p><div class="dbt-chips"></div>';
      var chips = empty.querySelector('.dbt-chips');
      SUGGESTIONS.forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'dbt-chip'; b.textContent = s;
        b.addEventListener('click', function () { ask(s); });
        chips.appendChild(b);
      });
      els.body.appendChild(empty);
      return;
    }
    history.forEach(function (m) {
      addBubble(m.role, m.role === 'user' ? '<p>' + esc(m.text).replace(/\n/g, '<br>') + '</p>' : renderMarkdown(m.text));
    });
    scrollDown();
  }

  function openPanel() {
    var ctx = getContext();
    els.sub.textContent = ctx ? 'About: ' + ctx : 'Your AI study helper';
    els.panel.hidden = false;
    els.fab.classList.add('is-hidden');
    els.fab.setAttribute('aria-expanded', 'true');
    renderAll();
    setTimeout(function () { els.input.focus(); }, 30);
  }
  function closePanel(fromOutside) {
    els.panel.hidden = true;
    els.fab.classList.remove('is-hidden');
    els.fab.setAttribute('aria-expanded', 'false');
    if (!fromOutside) els.fab.focus();
  }

  function setBusy(on) {
    busy = on;
    els.send.disabled = on;
    els.input.disabled = on;
  }

  function ask(raw) {
    var text = String(raw || '').trim();
    if (!text || busy) return;
    if (!history.length) els.body.innerHTML = '';
    var prior = history.slice(-MAX_TURNS_SENT);
    history.push({ role: 'user', text: text });
    addBubble('user', '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>');
    els.input.value = ''; autoGrow();
    setBusy(true);
    var typing = addBubble('ai', '<span class="dbt-typing" aria-label="Thinking"><span></span><span></span><span></span></span>');
    scrollDown();

    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 45000);
    var id = getCookie('sa_telegram_id');
    fetch('/api/doubt/ask', {
      method: 'POST',
      credentials: 'same-origin',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegramUserId: id || undefined,
        message: text,
        history: prior,
        page: pageName(),
        context: getContext(),
      }),
    })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        typing.remove();
        if (!r.ok || !r.data.answer) throw new Error((r.data && r.data.error) || 'Something went wrong. Please try again.');
        history.push({ role: 'model', text: r.data.answer });
        addBubble('ai', renderMarkdown(r.data.answer));
      })
      .catch(function (e) {
        typing.remove();
        history.pop(); // drop the unanswered question so the saved chat stays in turns
        var msg = e && e.name === 'AbortError' ? 'That took too long. Please try again.' : (e && e.message) || 'Something went wrong.';
        addBubble('error', '<p>' + esc(msg) + '</p>');
      })
      .then(function () {
        clearTimeout(timer);
        saveHistory();
        setBusy(false);
        scrollDown();
        els.input.focus();
      });
  }

  function init() {
    loadHistory();
    build();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
