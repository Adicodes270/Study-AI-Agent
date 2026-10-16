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

}

// 3D buttons: layered depth, tilt, magnetic pull, glossy shine, click shockwave, spring release
const btnSel = '.btn, .nav-btn-primary, .to-top';

// Wrap the label so it can float above the button face (icons already are elements)
$$(btnSel).forEach((btn) => {
  [...btn.childNodes].forEach((n) => {
    if (n.nodeType === 3 && n.textContent.trim()) {
      const s = document.createElement('span');
      s.className = 'btn-txt';
      s.textContent = n.textContent.replace(/\s+/g, ' ').trim();
      n.replaceWith(s);
    }
  });
});

if (!reduce) {
  $$(`${btnSel}, .socials a`).forEach((btn) => {
    const base = btn.classList.contains('to-top') ? 3 : 5;
    const lift = fine ? 20 : 0;
    const icon = btn.querySelector('i');
    gsap.set(btn, { transformPerspective: 500, '--depth': `${base}px` });
    const rx = gsap.quickTo(btn, 'rotationX', { duration: 0.35, ease: 'power3' });
    const ry = gsap.quickTo(btn, 'rotationY', { duration: 0.35, ease: 'power3' });
    const mx = gsap.quickTo(btn, 'x', { duration: 0.4, ease: 'power3' });
    const my = gsap.quickTo(btn, 'y', { duration: 0.4, ease: 'power3' });
    let pressed = false;

    btn.addEventListener('pointerenter', () => {
      gsap.to(btn, { z: lift, '--depth': `${base + 3}px`, duration: 0.3, ease: 'power3.out' });
      if (icon) gsap.fromTo(icon, { rotationY: 0 }, { rotationY: 360, duration: 0.8, ease: 'power3.inOut' });
    });

    btn.addEventListener('pointermove', (e) => {
      const r = btn.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      ry(px * 26);
      rx(-py * 26);
      if (fine && !pressed) { mx(px * 12); my(py * 9); }
      btn.style.setProperty('--sx', `${e.clientX - r.left}px`);
      btn.style.setProperty('--sy', `${e.clientY - r.top}px`);
    });

    btn.addEventListener('pointerdown', () => {
      pressed = true;
      gsap.to(btn, { z: 0, scale: 0.95, '--depth': '1px', duration: 0.1, ease: 'power2.out' });
      // Shockwave ring that expands out of the button
      const ring = document.createElement('span');
      ring.className = 'btn-ring';
      ring.setAttribute('aria-hidden', 'true');
      btn.appendChild(ring);
      gsap.fromTo(ring, { scale: 1, opacity: 0.9 },
        { scale: 1.45, opacity: 0, duration: 0.7, ease: 'power3.out', onComplete: () => ring.remove() });
    });

    const release = () => {
      pressed = false;
      gsap.to(btn, { z: lift, scale: 1, '--depth': `${base + 3}px`, duration: 0.9, ease: 'elastic.out(1, 0.45)' });
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);

    btn.addEventListener('pointerleave', () => {
      pressed = false;
      rx(0); ry(0); mx(0); my(0);
      gsap.to(btn, { z: 0, scale: 1, '--depth': `${base}px`, duration: 0.6, ease: 'elastic.out(1, 0.6)' });
    });
  });

  // Hero buttons flip in from the side in 3D
  gsap.from('.hero .cta-row .btn', {
    rotationY: -90, rotationX: 25, y: 30, opacity: 0, duration: 1, delay: 1,
    ease: 'back.out(1.7)', stagger: 0.15,
  });
}

// Mobile menu: the toggle is added here so every page with the same navbar gets it
const navRoot = $('.nav');
const navList = $('.nav-links');
if (navRoot && navList) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nav-toggle';
  toggle.setAttribute('aria-label', 'Open menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<span></span><span></span><span></span>';
  navRoot.appendChild(toggle);

  const setMenu = (open) => {
    navRoot.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    open ? lenis.stop() : lenis.start();
  };
  toggle.addEventListener('click', () => setMenu(!navRoot.classList.contains('menu-open')));
  navList.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  matchMedia('(min-width: 769px)').addEventListener('change', (m) => { if (m.matches) setMenu(false); });
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


// Background: flush grey strips (hero only), brightest in the middle, near-black at the sides
const stripWrap = $('.bg-strips');
if (stripWrap) {
  // [width %, brightness]. Widths add up to 100, so there are no gaps.
  let x = 0;
  [[10,.10],[12,.35],[9,.18],[14,.75],[12,1],[10,.45],[13,.2],[9,.55],[11,.08]]
    .forEach(([w, o]) => {
      const s = document.createElement('span');
      s.style.cssText = `left:${x}%;width:calc(${w}% + 1px);--o:${o}`;
      stripWrap.appendChild(s);
      x += w;
    });
  const strips = $$('.bg-strips span');

  // Strips drop down from the top on load
  if (!reduce) {
    gsap.from(strips, { scaleY: 0, opacity: 0, duration: 1.4, ease: 'power3.out', stagger: { each: 0.07, from: 'center' } });
  }

  // The whole strip block drifts slightly with the cursor (no gaps open up)
  if (!reduce && fine) {
    const mx = gsap.quickTo(stripWrap, 'x', { duration: 1, ease: 'power3' });
    window.addEventListener('pointermove', (e) => mx((e.clientX / innerWidth - 0.5) * -40));
  }

  // Strips fade out as the hero scrolls away
  gsap.to(stripWrap, {
    opacity: 0, yPercent: -12, ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom 25%', scrub: true },
  });
}