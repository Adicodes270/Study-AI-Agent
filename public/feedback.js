// Feedback & Reviews page: data layer, rendering, form, GSAP entrances.
// Wrapped in an IIFE because script.js already declares $, $$ and reduce at the top level.
(() => {
  // ==========================================================================
  // Data layer
  // --------------------------------------------------------------------------
  // The page only talks to `store` (list + create). Today it is the localStorage
  // mockup. To move to NeonDB, add GET/POST /api/reviews to src/webServer.js and
  // set SOURCE to 'api'; nothing else on this page has to change.
  //
  // Suggested table (NeonDB / PostgreSQL):
  //   CREATE TABLE reviews (
  //     id          BIGSERIAL PRIMARY KEY,
  //     name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  //     rating      SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  //     body        TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  //     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  //   );
  //   CREATE INDEX reviews_created_at_idx ON reviews (created_at DESC);
  //
  // Expected API shape:
  //   GET  /api/reviews  -> { reviews: [{ id, name, rating, body, createdAt }] }  (newest first)
  //   POST /api/reviews  { name, rating, body } -> { review: { id, name, rating, body, createdAt } }
  //   Errors: non-2xx with { error: "message" }
  // ==========================================================================
  const SOURCE = 'local'; // 'local' | 'api'
  const API_URL = '/api/reviews';
  const LOCAL_KEY = 'study_agent_reviews';

  /** Normalise a row from either source into the shape the UI renders. */
  function toReview(r) {
    return {
      id: String(r.id),
      name: String(r.name || '').trim(),
      rating: Math.min(5, Math.max(1, Math.round(Number(r.rating) || 0))),
      body: String(r.body || '').trim(),
      createdAt: r.createdAt || r.created_at || new Date().toISOString(),
    };
  }

  const localStore = {
    read() {
      try {
        const rows = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
        return Array.isArray(rows) ? rows.map(toReview) : [];
      } catch { return []; }
    },
    async list() {
      return this.read().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    async create({ name, rating, body }) {
      const review = toReview({
        id: (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name, rating, body, createdAt: new Date().toISOString(),
      });
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify([review, ...this.read()]));
      } catch {
        throw new Error('Your browser blocked saving the review. Check that site storage is allowed.');
      }
      return review;
    },
  };

  const apiStore = {
    async list() {
      const res = await fetch(API_URL, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Server responded with ${res.status}`);
      return (Array.isArray(data?.reviews) ? data.reviews : []).map(toReview);
    },
    async create(payload) {
      const res = await fetch(API_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Server responded with ${res.status}`);
      return toReview(data?.review || data);
    },
  };

  const store = SOURCE === 'api' ? apiStore : localStore;

  // ==========================================================================
  // Helpers
  // ==========================================================================
  const byId = (id) => document.getElementById(id);
  const gsap = window.gsap;
  const reduce = document.documentElement.dataset.respectMotion !== undefined
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = Boolean(gsap) && !reduce;

  const STAR_PATH = 'M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.41l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z';
  const PAGE_SIZE = 10;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function starSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', STAR_PATH);
    svg.append(p);
    return svg;
  }

  /** Five grey stars with a yellow layer clipped to `value / 5`. */
  function starRow(value, label) {
    const wrap = el('span', 'stars');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', label || `${value} out of 5 stars`);
    const base = el('span', 'stars-base');
    const fill = el('span', 'stars-fill');
    for (let i = 0; i < 5; i++) { base.append(starSvg()); fill.append(starSvg()); }
    base.style.display = 'inline-flex';
    fill.style.width = `${(value / 5) * 100}%`;
    wrap.append(base, fill);
    return wrap;
  }

  function initials(name) {
    const parts = name.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  // Same name, same avatar hue, so a person is recognisable across reviews
  function hueFor(name) {
    let h = 0;
    for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  function when(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const mins = Math.round((Date.now() - d) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 60 * 24) return `${Math.floor(mins / 60)} h ago`;
    return dateFmt.format(d);
  }

  // ==========================================================================
  // State + rendering
  // ==========================================================================
  const state = { reviews: [], shown: PAGE_SIZE, shownAvg: 0 };

  const avgNumEl = byId('fb-avg-num');
  const avgStarsEl = starRow(0, 'No ratings yet');
  byId('fb-avg-stars').replaceWith(avgStarsEl);
  const avgCountEl = byId('fb-avg-count');
  const distEl = byId('fb-dist');
  const listEl = byId('fb-list');
  const emptyEl = byId('fb-empty');
  const feedCountEl = byId('fb-feed-count');
  const moreBtn = byId('fb-more');

  function stats() {
    const counts = [0, 0, 0, 0, 0, 0];
    let sum = 0;
    state.reviews.forEach((r) => { counts[r.rating]++; sum += r.rating; });
    const total = state.reviews.length;
    return { total, counts, avg: total ? sum / total : 0 };
  }

  function renderSummary() {
    const { total, counts, avg } = stats();
    const rounded = Math.round(avg * 10) / 10;

    const paintAvg = (v) => {
      avgNumEl.textContent = total ? v.toFixed(1) : '–';
      avgStarsEl.querySelector('.stars-fill').style.width = `${(v / 5) * 100}%`;
    };
    if (animate && total) {
      const counter = { v: state.shownAvg };
      gsap.to(counter, { v: rounded, duration: 0.9, ease: 'power3.out', onUpdate: () => paintAvg(counter.v) });
    } else {
      paintAvg(rounded);
    }
    state.shownAvg = rounded;

    avgStarsEl.setAttribute('aria-label', total ? `Average rating ${rounded.toFixed(1)} out of 5` : 'No ratings yet');
    byId('fb-avg-sr').textContent = total ? `${rounded.toFixed(1)} out of 5` : 'No ratings yet';
    avgCountEl.textContent = total
      ? `Based on ${total.toLocaleString()} review${total === 1 ? '' : 's'}`
      : 'No reviews yet. Be the first.';

    distEl.querySelectorAll('li').forEach((li) => {
      const n = counts[Number(li.dataset.star)];
      li.querySelector('.fb-dist-bar span').style.width = total ? `${(n / total) * 100}%` : '0%';
      li.querySelector('.fb-dist-count').textContent = n;
      li.setAttribute('aria-label', `${li.dataset.star} star: ${n} review${n === 1 ? '' : 's'}`);
    });
  }

  function renderReview(r, isNew) {
    const li = el('li', 'fb-review' + (isNew ? ' is-new' : ''));
    li.dataset.id = r.id;

    const avatar = el('div', 'fb-avatar', initials(r.name));
    avatar.style.setProperty('--h', hueFor(r.name));
    avatar.setAttribute('aria-hidden', 'true');

    const content = el('div');
    const top = el('div', 'fb-review-top');
    top.append(el('h3', 'fb-review-name', r.name));
    const time = el('time', 'fb-review-date', when(r.createdAt));
    time.dateTime = r.createdAt;
    top.append(time);
    content.append(top, starRow(r.rating, `Rated ${r.rating} out of 5`), el('p', 'fb-review-body', r.body));

    li.append(avatar, content);
    return li;
  }

  function renderFeed() {
    const total = state.reviews.length;
    feedCountEl.textContent = total ? `${total} total` : '';
    emptyEl.hidden = total > 0;
    const visible = state.reviews.slice(0, state.shown);
    listEl.replaceChildren(...visible.map((r) => renderReview(r, false)));
    moreBtn.hidden = total <= state.shown;
    return listEl.children;
  }

  function revealOnScroll(items) {
    if (!animate || !items.length) return;
    gsap.set(items, { opacity: 0, y: 24 });
    if (window.ScrollTrigger) {
      ScrollTrigger.batch(items, {
        start: 'top 92%', once: true,
        onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power3.out' }),
      });
    } else {
      gsap.to(items, { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power3.out' });
    }
  }

  moreBtn.addEventListener('click', () => {
    const before = listEl.children.length;
    state.shown += PAGE_SIZE;
    const items = [...renderFeed()];
    if (animate) gsap.from(items.slice(before), { opacity: 0, y: 18, duration: 0.5, stagger: 0.06, ease: 'power3.out' });
    window.ScrollTrigger?.refresh();
  });

  // ==========================================================================
  // Feedback taker: the popup lives in feedback-modal.js; this page only saves
  // through `store` and drops the new review into the feed once it closes.
  // ==========================================================================
  function addReview(review) {
    state.reviews.unshift(review);
    state.shown += 1;

    // Insert at the top of the feed instead of re-rendering, so the list doesn't jump
    emptyEl.hidden = true;
    const li = renderReview(review, true);
    listEl.prepend(li);
    feedCountEl.textContent = `${state.reviews.length} total`;
    renderSummary();

    const target = byId('fb-feed-title');
    try { lenis.scrollTo(target, { offset: -110 }); } catch { target.scrollIntoView({ behavior: 'smooth' }); }
    if (animate) {
      gsap.from(li, { height: 0, paddingTop: 0, paddingBottom: 0, opacity: 0, duration: 0.55, delay: 0.3, ease: 'power3.out', clearProps: 'height,paddingTop,paddingBottom' });
      gsap.from(li.children, { y: 14, opacity: 0, duration: 0.5, delay: 0.45, stagger: 0.06, ease: 'power3.out' });
    }
    window.ScrollTrigger?.refresh();
  }

  async function openFeedback() {
    const review = await window.FeedbackModal.open({ submit: (payload) => store.create(payload) });
    if (review) addReview(review);
  }

  document.querySelectorAll('[data-open-feedback]').forEach((b) => b.addEventListener('click', openFeedback));

  // ==========================================================================
  // Boot
  // ==========================================================================
  function intro() {
    if (!animate) return;

    // Split the heading into masked words so each one slides up into place
    const h1 = document.querySelector('.fb-head h1');
    const words = h1.textContent.trim().split(/\s+/);
    h1.setAttribute('aria-label', words.join(' '));
    h1.replaceChildren(...words.flatMap((w, i) => {
      const outer = el('span', 'w');
      outer.setAttribute('aria-hidden', 'true');
      outer.append(el('span', null, w));
      return i ? [document.createTextNode(' '), outer] : [outer];
    }));

    gsap.timeline({ defaults: { ease: 'power3.out' } })
      .from('.fb-head .fb-eyebrow', { y: 12, opacity: 0, duration: 0.5 })
      .from('.fb-head h1 .w > span', { yPercent: 110, duration: 0.85, stagger: 0.06 }, '-=0.25')
      .from('.fb-head p', { y: 16, opacity: 0, duration: 0.6 }, '-=0.5')
      .from('.fb-summary', { y: 26, opacity: 0, duration: 0.7 }, '-=0.45')
      .from('.fb-dist li', { x: -10, opacity: 0, duration: 0.45, stagger: 0.05 }, '-=0.45')
      .from('.fb-cta', { y: 26, opacity: 0, duration: 0.7 }, '-=0.5')
      .from('.fb-feed-head', { y: 16, opacity: 0, duration: 0.5 }, '-=0.4');

    // Liquid background: blobs drift and squash slowly behind the glass
    const drift = [[120, 80], [-140, -60], [90, -110]];
    document.querySelectorAll('.fb-liquid span').forEach((b, i) => gsap.to(b, {
      x: drift[i][0], y: drift[i][1], scaleX: i % 2 ? 0.85 : 1.15, scaleY: i % 2 ? 1.15 : 0.9,
      duration: 9 + i * 3, ease: 'sine.inOut', yoyo: true, repeat: -1,
    }));

    // Spotlight that follows the cursor across each glass card
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
      document.querySelectorAll('.fb-card').forEach((card) => card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - r.left}px`);
        card.style.setProperty('--my', `${e.clientY - r.top}px`);
      }));
    }
  }

  async function load() {
    let failed = false;
    try {
      state.reviews = await store.list();
    } catch {
      state.reviews = [];
      failed = true;
    }
    renderSummary();
    if (failed) avgCountEl.textContent = 'Could not load reviews right now.';
    revealOnScroll([...renderFeed()]);
  }

  intro();
  load();
  // feedback.html#write opens the popup straight away (handy for links from the bot or footer)
  if (location.hash === '#write') openFeedback();
})();
