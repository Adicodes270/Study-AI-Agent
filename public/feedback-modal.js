// Feedback taker: a standalone rating popup that any page can open.
//
//   const review = await FeedbackModal.open({ submit: (payload) => store.create(payload) });
//
// `submit` receives { name, rating, body }, must save it and resolve (or throw an Error whose
// message is shown in the popup). open() resolves with whatever submit returned once the popup
// closes, or null if the visitor skipped it. Needs feedback-modal.css; GSAP is optional.
window.FeedbackModal = (() => {
  const STAR_PATH = 'M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.41l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z';
  const WORDS = ['', 'Poor', 'Fair', 'Good', 'Great', 'Excellent'];
  const LIMITS = { name: 60, body: 1000 };
  const gsap = window.gsap;
  const reduce = document.documentElement.dataset.respectMotion !== undefined
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = Boolean(gsap) && !reduce;

  const star = (cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`;

  let dialog, ui, resolveOpen, result = null, floatTweens = [];

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'fm';
    dialog.setAttribute('aria-labelledby', 'fm-title');
    dialog.setAttribute('data-lenis-prevent', '');
    dialog.innerHTML = `
      <svg class="fm-defs" aria-hidden="true" focusable="false"><defs>
        <linearGradient id="fm-grad" x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stop-color="hsl(50, 100%, 72%)"/>
          <stop offset="0.5" stop-color="hsl(44, 100%, 56%)"/>
          <stop offset="1" stop-color="hsl(34, 100%, 48%)"/>
        </linearGradient>
      </defs></svg>
      <span class="fm-blob fm-blob-1" aria-hidden="true"></span>
      <span class="fm-blob fm-blob-2" aria-hidden="true"></span>
      <span class="fm-blob fm-blob-3" aria-hidden="true"></span>
      <span class="fm-deco fm-deco-1">${star()}</span>
      <span class="fm-deco fm-deco-2">${star()}</span>
      <span class="fm-deco fm-deco-3">${star()}</span>
      <span class="fm-deco fm-deco-4">${star()}</span>

      <div class="fm-card">
        <span class="fm-sheen" aria-hidden="true"></span>
        <form class="fm-form" novalidate>
          <h2 class="fm-title" id="fm-title">How was your experience?</h2>
          <p class="fm-sub">Your feedback helps us improve and serve you better.</p>

          <fieldset class="fm-rate" aria-describedby="fm-err-rating">
            <legend class="fm-sr">Your rating</legend>
            ${[1, 2, 3, 4, 5].map((n) => `
              <input type="radio" name="rating" id="fm-r${n}" value="${n}">
              <label for="fm-r${n}" title="${WORDS[n]}"><span class="fm-sr">${n} star${n > 1 ? 's' : ''}, ${WORDS[n]}</span>${star()}</label>`).join('')}
          </fieldset>
          <p class="fm-rate-word" aria-hidden="true"></p>
          <p class="fm-err" id="fm-err-rating" role="alert"></p>

          <label class="fm-sr" for="fm-name">Your name</label>
          <input class="fm-input" id="fm-name" name="name" type="text" maxlength="${LIMITS.name}"
            autocomplete="name" placeholder="Your name" aria-describedby="fm-err-name">
          <p class="fm-err" id="fm-err-name" role="alert"></p>

          <div class="fm-textwrap">
            <label class="fm-sr" for="fm-body">Your review</label>
            <textarea class="fm-input" id="fm-body" name="body" maxlength="${LIMITS.body}"
              placeholder="Your message ..." aria-describedby="fm-err-body fm-count"></textarea>
            <span class="fm-count" id="fm-count">0 / ${LIMITS.body}</span>
          </div>
          <p class="fm-err" id="fm-err-body" role="alert"></p>

          <button type="submit" class="fm-submit">Submit</button>
          <p class="fm-status" role="status" aria-live="polite"></p>
          <button type="button" class="fm-skip">Skip for now</button>
        </form>

        <div class="fm-done" hidden>
          ${star('fm-done-star')}
          <h2 class="fm-title" tabindex="-1">Thank you!</h2>
          <p>Your review is live. It helps other students and tells us what to build next.</p>
          <button type="button" class="fm-submit fm-done-close">Back to reviews</button>
        </div>
      </div>`;
    document.body.append(dialog);

    const q = (s) => dialog.querySelector(s);
    ui = {
      card: q('.fm-card'),
      form: q('.fm-form'),
      done: q('.fm-done'),
      rate: q('.fm-rate'),
      labels: [...dialog.querySelectorAll('.fm-rate label')],
      radios: [...dialog.querySelectorAll('.fm-rate input')],
      word: q('.fm-rate-word'),
      name: q('#fm-name'),
      body: q('#fm-body'),
      count: q('#fm-count'),
      submit: q('.fm-form .fm-submit'),
      status: q('.fm-status'),
      decos: [...dialog.querySelectorAll('.fm-deco')],
      blobs: [...dialog.querySelectorAll('.fm-blob')],
      sheen: q('.fm-sheen'),
      errs: { rating: q('#fm-err-rating'), name: q('#fm-err-name'), body: q('#fm-err-body') },
    };
    wire();
  }

  // ---------- Stars ----------

  const rating = () => Number(ui.radios.find((r) => r.checked)?.value || 0);

  function paint(n, preview = false) {
    ui.labels.forEach((l, i) => l.classList.toggle('is-on', i < n));
    ui.word.textContent = n ? WORDS[n] : 'Tap a star to rate';
    ui.word.classList.toggle('is-set', Boolean(n) && !preview);
  }

  // ---------- Errors ----------

  const fieldFor = { rating: () => ui.rate, name: () => ui.name, body: () => ui.body };

  function setError(key, msg) {
    ui.errs[key].textContent = msg;
    fieldFor[key]().classList.add('has-error');
    if (key !== 'rating') fieldFor[key]().setAttribute('aria-invalid', 'true');
  }

  function clearError(key) {
    ui.errs[key].textContent = '';
    fieldFor[key]().classList.remove('has-error');
    fieldFor[key]().removeAttribute('aria-invalid');
  }

  function validate() {
    const name = ui.name.value.trim().replace(/\s+/g, ' ');
    const body = ui.body.value.trim();
    const r = rating();
    const bad = [];
    if (!r) { setError('rating', 'Pick a rating from 1 to 5 stars.'); bad.push(ui.radios[0]); }
    if (!name) { setError('name', 'Please add your name.'); bad.push(ui.name); }
    else if (name.length > LIMITS.name) { setError('name', `Keep it under ${LIMITS.name} characters.`); bad.push(ui.name); }
    if (!body) { setError('body', 'Tell us a little about your experience.'); bad.push(ui.body); }
    else if (body.length > LIMITS.body) { setError('body', `Keep it under ${LIMITS.body} characters.`); bad.push(ui.body); }
    if (bad.length) {
      bad[0].focus();
      if (animate) gsap.fromTo(ui.card, { x: -6 }, { x: 0, duration: 0.4, ease: 'elastic.out(1, 0.3)' });
      return null;
    }
    return { name, rating: r, body };
  }

  // ---------- Events ----------

  function wire() {
    ui.labels.forEach((l, i) => l.addEventListener('pointerenter', () => paint(i + 1, true)));
    ui.rate.addEventListener('pointerleave', () => paint(rating()));
    ui.radios.forEach((r) => r.addEventListener('change', () => {
      const n = rating();
      paint(n);
      clearError('rating');
      if (animate) {
        gsap.fromTo(ui.labels.slice(0, n).map((l) => l.querySelector('svg')),
          { scale: 0.55 }, { scale: 1, duration: 0.5, stagger: 0.04, ease: 'back.out(3)', clearProps: 'transform' });
      }
    }));

    ui.name.addEventListener('input', () => { if (ui.name.value.trim()) clearError('name'); });
    ui.body.addEventListener('input', () => {
      ui.count.textContent = `${ui.body.value.length} / ${LIMITS.body}`;
      if (ui.body.value.trim()) clearError('body');
    });

    ui.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      ui.status.textContent = '';
      const payload = validate();
      if (!payload) return;
      ui.submit.disabled = true;
      ui.submit.textContent = 'Submitting…';
      try {
        result = await (submitFn ? submitFn(payload) : payload);
        showDone();
      } catch (err) {
        ui.status.textContent = err instanceof TypeError
          ? 'Could not reach the server. Please try again.'
          : (err.message || 'Something went wrong. Please try again.');
      } finally {
        ui.submit.disabled = false;
        ui.submit.textContent = 'Submit';
      }
    });

    dialog.querySelector('.fm-skip').addEventListener('click', close);
    dialog.querySelector('.fm-done-close').addEventListener('click', close);
    // Esc: run the animated close instead of the instant native one
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    // Clicks on the dimmed backdrop land on the <dialog> itself
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
    dialog.addEventListener('close', finish);
  }

  // ---------- Open / close ----------

  let submitFn = null;

  function reset() {
    result = null;
    ui.form.reset();
    ui.form.hidden = false;
    ui.done.hidden = true;
    ui.status.textContent = '';
    ui.count.textContent = `0 / ${LIMITS.body}`;
    Object.keys(ui.errs).forEach(clearError);
    paint(0);
  }

  function showDone() {
    ui.form.hidden = true;
    ui.done.hidden = false;
    ui.done.querySelector('.fm-title').focus();
    if (animate) {
      gsap.timeline({ defaults: { ease: 'power3.out' } })
        .from('.fm-done-star', { scale: 0, rotation: -120, duration: 0.7, ease: 'back.out(2)' })
        .from('.fm-done > :not(.fm-done-star)', { y: 12, opacity: 0, duration: 0.45, stagger: 0.07 }, '-=0.35');
    }
  }

  function lockScroll(on) {
    try { on ? lenis.stop() : lenis.start(); } catch { /* page has no Lenis */ }
    document.documentElement.style.overflow = on ? 'hidden' : '';
  }

  function open({ submit } = {}) {
    if (!dialog) build();
    if (dialog.open) return Promise.resolve(null);
    submitFn = submit || null;
    reset();
    lockScroll(true);
    dialog.showModal();

    if (animate) {
      gsap.fromTo(ui.card, { y: 28, scale: 0.96, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.55, ease: 'power3.out' });
      gsap.fromTo(ui.decos, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, stagger: 0.08, delay: 0.15, ease: 'back.out(2.2)' });
      gsap.fromTo(ui.labels.map((l) => l.querySelector('svg')), { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, stagger: 0.05, delay: 0.25, ease: 'power2.out', clearProps: 'transform,opacity' });
      gsap.fromTo(ui.blobs, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.9, stagger: 0.1, ease: 'power2.out' });
      // Gentle bob on the decoration stars while the popup is open
      floatTweens = ui.decos.map((d, i) => gsap.to(d.firstElementChild, {
        y: i % 2 ? 6 : -7, rotation: i % 2 ? -6 : 6, duration: 2.2 + i * 0.4, ease: 'sine.inOut', yoyo: true, repeat: -1,
      }));
      // Liquid: the colour blobs drift and squash behind the glass, so the frost keeps shifting
      const drift = [[60, 40], [-50, -36], [-40, 30]];
      ui.blobs.forEach((b, i) => floatTweens.push(gsap.to(b, {
        x: drift[i][0], y: drift[i][1], scaleX: i % 2 ? 0.8 : 1.2, scaleY: i % 2 ? 1.2 : 0.85,
        duration: 4 + i * 1.3, ease: 'sine.inOut', yoyo: true, repeat: -1,
      })));
      // A light sheen sweeps across the glass every few seconds
      floatTweens.push(gsap.fromTo(ui.sheen, { xPercent: -160 }, {
        xPercent: 420, duration: 1.6, ease: 'power2.inOut', repeat: -1, repeatDelay: 3.5, delay: 0.6,
      }));
    }
    return new Promise((res) => { resolveOpen = res; });
  }

  function close() {
    if (!dialog?.open) return;
    if (!animate) { dialog.close(); return; }
    gsap.to(ui.card, { y: 16, scale: 0.97, opacity: 0, duration: 0.25, ease: 'power2.in' });
    gsap.to(ui.blobs, { opacity: 0, duration: 0.25, ease: 'power2.in' });
    gsap.to(ui.decos, { scale: 0, opacity: 0, duration: 0.2, ease: 'power2.in', onComplete: () => dialog.open && dialog.close() });
    // GSAP's ticker pauses in background tabs; never leave the popup stuck open
    setTimeout(() => { if (dialog.open) dialog.close(); }, 450);
  }

  function finish() {
    floatTweens.forEach((t) => t.kill());
    floatTweens = [];
    lockScroll(false);
    resolveOpen?.(result);
    resolveOpen = null;
  }

  return { open, close };
})();
