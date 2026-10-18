// Study Agent: Lenis smooth scroll, GSAP ScrollTrigger, cursor microinteractions (merged)
gsap.registerPlugin(ScrollTrigger);
// Set to true to honour the visitor's OS "reduce motion" setting (disables all animation for them).
// It is false so the animations always run, even on systems where that setting is on.
const RESPECT_REDUCED_MOTION = false;
if (RESPECT_REDUCED_MOTION) document.documentElement.dataset.respectMotion = '';
const reduce = RESPECT_REDUCED_MOTION && matchMedia('(prefers-reduced-motion: reduce)').matches;
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

// Microinteractions: orbs, depth cards, card spotlight
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

// ==========================================================================
// Navbar
// ==========================================================================
const navEl = $('.nav');
const headerEl = $('.header');
const brandEl = $('.brand-logo');

// Trace line: runs from the logo to the hovered link
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
    if (!trace.dataset.placed) {
      // first time: put it at the logo without animating from the page corner
      trace.style.transition = 'none';
      trace.style.setProperty('--x', `${x}px`);
      trace.style.setProperty('--y', `${l.bottom - n.top}px`);
      trace.getBoundingClientRect();
      trace.style.transition = '';
      trace.dataset.placed = '1';
    }
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

// Shrinks into a floating pill after a little scroll (styles in style.css, 1024px and up)
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

// Mobile menu (hamburger). The toggle is created here if the HTML doesn't have one,
// so every page with the same navbar gets it. On phones the links stay in ONE row and
// scroll sideways, with a thin accent line underneath showing the scroll position.
const navList = $('.nav-links');
if (navEl && navList) {
  let toggle = $('.nav-toggle');
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-toggle';
    toggle.innerHTML = '<i class="fa-solid fa-bars" aria-hidden="true"></i>';
    navEl.appendChild(toggle);
  }
  toggle.setAttribute('aria-label', 'Open menu');
  toggle.setAttribute('aria-expanded', 'false');
  const icon = toggle.querySelector('i');

  // Scroll line under the links
  const bar = document.createElement('span');
  bar.className = 'nav-progress';
  bar.setAttribute('aria-hidden', 'true');
  bar.innerHTML = '<span></span>';
  navEl.appendChild(bar);
  const thumb = bar.firstElementChild;

  const updateBar = () => {
    const w = navList.clientWidth;
    const max = navList.scrollWidth - w;
    const tw = max > 0 ? Math.max(28, (w * w) / navList.scrollWidth) : w;
    const x = max > 0 ? (navList.scrollLeft / max) * (w - tw) : 0;
    bar.classList.toggle('is-static', max <= 0);
    bar.style.setProperty('--pl', `${navList.offsetLeft}px`);
    bar.style.setProperty('--pw', `${w}px`);
    thumb.style.setProperty('--tw', `${tw}px`);
    thumb.style.setProperty('--tx', `${x}px`);
    navList.style.setProperty('--fade-l', navList.scrollLeft > 4 ? '18px' : '0px');
    navList.style.setProperty('--fade-r', navList.scrollLeft < max - 4 ? '18px' : '0px');
  };

  const setMenu = (open) => {
    navEl.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (icon) icon.className = open ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
    open ? lenis.stop() : lenis.start();
    if (open) {
      updateBar();
      // start with the current page's link in view
      const a = navList.querySelector('a.active');
      if (a) {
        navList.scrollLeft = a.getBoundingClientRect().left - navList.getBoundingClientRect().left
          + navList.scrollLeft - (navList.clientWidth - a.offsetWidth) / 2;
      }
      updateBar();
    }
  };
  toggle.addEventListener('click', () => setMenu(!navEl.classList.contains('is-open')));
  navList.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  document.addEventListener('click', (e) => { if (!navEl.contains(e.target)) setMenu(false); });
  matchMedia('(min-width: 769px)').addEventListener('change', (e) => { if (e.matches) setMenu(false); });

  navList.addEventListener('scroll', updateBar, { passive: true });
  addEventListener('resize', updateBar);
  // mouse wheel scrolls the links sideways (for tablets with a mouse)
  navList.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { navList.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
}

// ==========================================================================
// Background: flush grey strips (hero only), brightest in the middle, near-black at the sides
// ==========================================================================
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

// ==========================================================================
// Lightweight 3D background (Three.js): floating low-poly wireframe shapes + particles that follow the cursor.
// ~230 points + 10 wireframes, no lights, 30fps, paused when the tab is hidden. Skipped for reduced motion / data-saver.
// ==========================================================================
(() => {
  // Only the home page gets the 3D background ('/', '/index.html', or a folder URL like '/repo/')
  const isHome = /(^|\/)(index\.html)?$/.test(location.pathname);
  if (!isHome) return;
  if (reduce) { console.info('[3D background] skipped: your system has "reduce motion" turned on'); return; }
  if (navigator.connection && navigator.connection.saveData) { console.info('[3D background] skipped: data saver is on'); return; }
  try {
    const c = document.createElement('canvas');
    if (!(c.getContext('webgl') || c.getContext('experimental-webgl'))) { console.info('[3D background] skipped: WebGL is not available'); return; }
  } catch (e) { return; }

  // Loads ./three.min.js (next to index.html) first, then falls back to the CDN
  const addScript = (src) => new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = fail;
    document.head.appendChild(s);
  });
  const loadThree = () => window.THREE ? Promise.resolve()
    : addScript('./three.min.js').catch(() => addScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'));

  const init = () => {
    const canvas = document.createElement('canvas');
    canvas.className = 'bg-3d';
    canvas.setAttribute('aria-hidden', 'true');
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
    } catch (e) { return; }
    document.body.insertBefore(canvas, $('.header'));   // above the orbs and strips, below the page content
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    camera.position.z = 14;
    const group = new THREE.Group();
    scene.add(group);

    const small = innerWidth < 700;
    const rnd = (a, b) => a + Math.random() * (b - a);

    // Particles: one Points object = one draw call
    const N = small ? 90 : 220;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pos[i * 3] = rnd(-18, 18); pos[i * 3 + 1] = rnd(-11, 11); pos[i * 3 + 2] = rnd(-8, 6); }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    group.add(new THREE.Points(pGeo, new THREE.PointsMaterial({
      color: 0xffffff, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0.6, depthWrite: false,
    })));

    // Floating wireframe shapes in the site's purple and green
    const geos = [new THREE.IcosahedronGeometry(1, 0), new THREE.OctahedronGeometry(1, 0),
      new THREE.TetrahedronGeometry(1, 0), new THREE.BoxGeometry(1.4, 1.4, 1.4)];
    const shapes = [];
    for (let i = 0; i < (small ? 6 : 10); i++) {
      const mesh = new THREE.Mesh(geos[i % 4], new THREE.MeshBasicMaterial({
        color: i % 2 ? 0x2de6b4 : 0x7a5cff, wireframe: true, transparent: true, opacity: 0.42,
      }));
      mesh.userData = { x: rnd(-13, 13), y: rnd(-7, 7), z: rnd(-6, 2), s: rnd(0.5, 1.25),
        spin: rnd(0.1, 0.5), depth: rnd(0.4, 1.3), phase: rnd(0, 6.28) };
      mesh.position.set(mesh.userData.x, mesh.userData.y, mesh.userData.z);
      mesh.scale.setScalar(mesh.userData.s);
      group.add(mesh);
      shapes.push(mesh);
    }

    const resize = () => {
      renderer.setSize(innerWidth, innerHeight, false);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    addEventListener('resize', resize);

    // Cursor / touch, plus a click or tap that makes the shapes spin up and pulse
    const ptr = { x: 0.5, y: 0.4, tx: 0.5, ty: 0.4 };
    let boost = 0;
    addEventListener('pointermove', (e) => { ptr.tx = e.clientX / innerWidth; ptr.ty = e.clientY / innerHeight; }, { passive: true });
    addEventListener('pointerdown', (e) => {
      ptr.tx = e.clientX / innerWidth; ptr.ty = e.clientY / innerHeight; boost = 1;
    }, { passive: true });

    let last = 0;
    gsap.ticker.add((t) => {
      if (document.hidden || t - last < 0.033) return;     // ~30fps
      last = t;
      ptr.x += (ptr.tx - ptr.x) * 0.06;
      ptr.y += (ptr.ty - ptr.y) * 0.06;
      boost *= 0.94;

      group.rotation.y = (ptr.x - 0.5) * 0.6 + t * 0.03;
      group.rotation.x = (ptr.y - 0.5) * 0.35 + scrollY * 0.0003;
      shapes.forEach((m) => {
        const d = m.userData;
        m.rotation.x += d.spin * 0.012 * (1 + boost * 8);
        m.rotation.y += d.spin * 0.016 * (1 + boost * 8);
        m.position.x = d.x - (ptr.x - 0.5) * d.depth * 4;
        m.position.y = d.y + (ptr.y - 0.5) * d.depth * 3 + Math.sin(t * 0.6 + d.phase) * 0.35;
        m.scale.setScalar(d.s * (1 + boost * 0.4));
      });
      renderer.render(scene, camera);
    });
  };

  // Start right after the page is ready (not waiting for fonts / icons to finish loading)
  loadThree().then(init).catch(() => console.info('[3D background] skipped: could not load three.min.js (put it next to index.html)'));
})();