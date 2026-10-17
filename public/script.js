// Study Agent: Lenis smooth scroll, GSAP ScrollTrigger, cursor microinteractions
gsap.registerPlugin(ScrollTrigger);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// Smooth scroll, synced with ScrollTrigger
const lenis = new Lenis({ lerp: 0.1, smoothWheel: !reduce });
lenis.on('scroll', ScrollTrigger.update);
gsap.ticker.add((t) => lenis.raf(t * 1000));
gsap.ticker.lagSmoothing(0);

// In-page anchors only (nav links go to their own pages)
$$('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const href = a.getAttribute('href');
    const el = href.length > 1 && $(href);
    if (el) { e.preventDefault(); lenis.scrollTo(el, { offset: -20 }); }
  });
});
$('.to-top')?.addEventListener('click', () => lenis.scrollTo(0));

// Tools strip: clone the items so the marquee loops without a gap
const track = $('.strip-track');
if (track) track.innerHTML += track.innerHTML;

// Hero intro
const h1 = $('.hero h1');
if (h1) {
  h1.innerHTML = h1.textContent.trim().split(' ')
    .map((w) => `<span class="word"><span>${w}</span></span>`).join(' ');
  if (!reduce) {
    gsap.timeline({ defaults: { ease: 'power3.out' } })
      .from('.word > span', { yPercent: 110, duration: 0.9, stagger: 0.07 })
      .from('.hero-sub, .cta-row, .stats', { y: 20, opacity: 0, duration: 0.6, stagger: 0.1 }, '-=0.5')
      .from('.hero-chat', { y: 50, opacity: 0, duration: 0.8 }, '-=0.6')
      .from('.float-card', { scale: 0.8, opacity: 0, duration: 0.5, stagger: 0.15 }, '-=0.3')
      .from('.hero-chat .msg', { y: 12, opacity: 0, duration: 0.45, stagger: 0.5 }, '-=0.6');

    gsap.to('.hero-chat', {
      yPercent: -10, ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
    });
  }
}

// Pinned story
if ($('.story')) {
  const steps = $$('.step'), panels = $$('.panel'), bar = $('.story-bar span');
  let current = -1;
  const setActive = (i) => {
    if (i === current) return;
    current = i;
    steps.forEach((s, k) => s.classList.toggle('is-active', k === i));
    panels.forEach((p, k) => p.classList.toggle('is-active', k === i));
  };
  ScrollTrigger.create({
    trigger: '.story', start: 'top top', end: '+=300%', pin: '.story-pin', scrub: true,
    onUpdate: (self) => {
      setActive(Math.min(steps.length - 1, Math.floor(self.progress * steps.length)));
      gsap.set(bar, { scaleX: self.progress });
    },
  });
}

// Reveal on scroll
if (!reduce && $('.reveal')) {
  gsap.set('.reveal', { opacity: 0, y: 36 });
  ScrollTrigger.batch('.reveal', {
    start: 'top 88%', once: true,
    onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, duration: 0.7, stagger: 0.12, ease: 'power3.out' }),
  });
}
// Microinteractions: orbs, depth cards, card spotlight, magnetic buttons
if (!reduce && fine) {
  const orbs = [['.orb-1', -60], ['.orb-2', 80]].map(([sel, d]) => ({
    x: gsap.quickTo(sel, 'x', { duration: 1.2, ease: 'power3' }),
    y: gsap.quickTo(sel, 'y', { duration: 1.2, ease: 'power3' }), d,
  }));
  const depth = $$('[data-depth]').map((el) => ({
    x: gsap.quickTo(el, 'x', { duration: 0.8, ease: 'power3' }),
    y: gsap.quickTo(el, 'y', { duration: 0.8, ease: 'power3' }), d: Number(el.dataset.depth),
  }));

  window.addEventListener('pointermove', (e) => {
    const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5;
    orbs.forEach((o) => { o.x(nx * o.d); o.y(ny * o.d); });
    depth.forEach((f) => { f.x(nx * f.d); f.y(ny * f.d); });
  });

  // Spotlight that follows the cursor, only while it is over a card
  $$('.bento-card, .cta-card').forEach((card) => card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  }));

  // Buttons lean toward the cursor
  $$('.btn, .nav-btn-primary').forEach((btn) => {
    const qx = gsap.quickTo(btn, 'x', { duration: 0.4, ease: 'power3' });
    const qy = gsap.quickTo(btn, 'y', { duration: 0.4, ease: 'power3' });
    btn.addEventListener('pointermove', (e) => {
      const r = btn.getBoundingClientRect();
      qx((e.clientX - r.left - r.width / 2) * 0.25);
      qy((e.clientY - r.top - r.height / 2) * 0.25);
    });
    btn.addEventListener('pointerleave', () => { qx(0); qy(0); });
  });
}
// Navbar trace line: runs from the logo to the hovered link
const navEl = $('.nav');
const brandEl = $('.brand-logo');
if (navEl && brandEl) {
  const trace = document.createElement('span');
  trace.className = 'nav-trace';
  trace.setAttribute('aria-hidden', 'true');
  navEl.appendChild(trace);

  const showTrace = (link) => {
    const n = navEl.getBoundingClientRect();
    const b = brandEl.getBoundingClientRect();
    const l = link.getBoundingClientRect();
    const x = b.left - n.left;
    const end = l.left + l.width / 2 - n.left;
    trace.style.setProperty('--x', `${x}px`);
    trace.style.setProperty('--y', `${l.bottom - n.top}px`);
    trace.style.setProperty('--w', `${end - x}px`);
    trace.classList.add('on');
  };
  const hideTrace = () => trace.classList.remove('on');

  $$('.nav-links a').forEach((a) => {
    a.addEventListener('pointerenter', () => showTrace(a));
    a.addEventListener('focus', () => showTrace(a));
    a.addEventListener('blur', hideTrace);
  });
  $('.nav-links')?.addEventListener('pointerleave', hideTrace);
}


// Navbar: shrinks into a floating pill after a little scroll (styles in style.css, 1024px and up)
const headerEl = $('.header');
if (headerEl) {
  gsap.set(headerEl, { '--p': 0 });
  let compact = false;
  const setCompact = (on) => {
    if (on === compact) return;
    compact = on;
    headerEl.classList.toggle('is-compact', on);
    gsap.to(headerEl, { '--p': on ? 1 : 0, duration: reduce ? 0 : 0.8, ease: 'power3.out', overwrite: 'auto' });
  };
  // a little hysteresis so it doesn't flicker around the threshold
  const check = (y) => setCompact(compact ? y > 40 : y > 80);
  lenis.on('scroll', ({ scroll }) => check(scroll));
  check(window.scrollY);
}

// Mobile menu (hamburger)
const toggle = $('.nav-toggle');
if (navEl && toggle) {
  const icon = toggle.querySelector('i');
  const setMenu = (open) => {
    navEl.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    icon.className = open ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
  };
  toggle.addEventListener('click', () => setMenu(!navEl.classList.contains('is-open')));
  $$('.nav-links a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  document.addEventListener('click', (e) => { if (!navEl.contains(e.target)) setMenu(false); });
  matchMedia('(min-width: 769px)').addEventListener('change', (e) => { if (e.matches) setMenu(false); });
}

// Background: flush grey strips (hero only), brightest in the middle, near-black at the sides
const stripWrap = $('.bg-strips');
if (stripWrap) {
  // [width %, brightness]. Each set adds up to 100, so there are no gaps.
  const SETS = {
    wide: [[10,.10],[12,.35],[9,.18],[14,.75],[12,1],[10,.45],[13,.2],[9,.55],[11,.08]],
    phone: [[16,.08],[22,.5],[24,1],[22,.45],[16,.08]],
  };
  // The inner layer holds the strips and overscans/drifts; the outer box clips it.
  const inner = document.createElement('div');
  inner.className = 'bg-strips-inner';
  stripWrap.appendChild(inner);

  const phone = matchMedia('(max-width: 700px)');
  const build = () => {
    inner.innerHTML = '';
    let x = 0;
    SETS[phone.matches ? 'phone' : 'wide'].forEach(([w, o]) => {
      const s = document.createElement('span');
      s.style.cssText = `left:${x}%;width:calc(${w}% + 1px);--o:${o}`;
      inner.appendChild(s);
      x += w;
    });
  };
  build();
  phone.addEventListener('change', build);

  // Strips drop down from the top on load
  if (!reduce) {
    gsap.from(inner.children, { scaleY: 0, opacity: 0, duration: 1.4, ease: 'power3.out', stagger: { each: 0.07, from: 'center' } });
  }

  // The strip block drifts slightly with the cursor (clipped, so it never widens the page)
  if (!reduce && fine) {
    const mx = gsap.quickTo(inner, 'x', { duration: 1, ease: 'power3' });
    window.addEventListener('pointermove', (e) => mx((e.clientX / innerWidth - 0.5) * -40));
  }

  // Strips fade out as the hero scrolls away
  gsap.to(stripWrap, {
    opacity: 0, yPercent: -12, ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom 25%', scrub: true },
  });
}