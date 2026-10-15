// Study Agent landing page: Lenis smooth scroll + GSAP ScrollTrigger
gsap.registerPlugin(ScrollTrigger);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Smooth scroll, kept in sync with ScrollTrigger
const lenis = new Lenis({ lerp: 0.1, smoothWheel: !reduce });
lenis.on('scroll', ScrollTrigger.update);
gsap.ticker.add((t) => lenis.raf(t * 1000));
gsap.ticker.lagSmoothing(0);

// Anchor links use Lenis so the page glides instead of jumping
document.querySelectorAll('a[href^="#"], a[href="/"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const href = a.getAttribute('href');
    const target = href === '/' ? 0 : href.length > 1 && document.querySelector(href);
    if (target === 0 || target) {
      e.preventDefault();
      lenis.scrollTo(target, { offset: target === 0 ? 0 : -20 });
    }
  });
});

// Hero intro: split the headline into words and slide them up
const h1 = document.querySelector('.hero h1');
h1.innerHTML = h1.textContent.trim().split(' ')
  .map((w) => `<span class="word"><span>${w}</span></span>`).join(' ');

if (!reduce) {
  gsap.timeline({ defaults: { ease: 'power3.out' } })
    .from('.word > span', { yPercent: 110, duration: 0.9, stagger: 0.07 })
    .from('.hero-sub, .cta-row', { y: 20, opacity: 0, duration: 0.6, stagger: 0.1 }, '-=0.5')
    .from('.hero-chat', { y: 50, opacity: 0, duration: 0.8 }, '-=0.4')
    .from('.hero-chat .msg', { y: 12, opacity: 0, duration: 0.45, stagger: 0.5 }, '-=0.2');

  gsap.to('.hero-chat', {
    yPercent: -12, ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
  });
}

// Pinned story: scrolling steps through the four panels
const steps = [...document.querySelectorAll('.step')];
const panels = [...document.querySelectorAll('.panel')];
const bar = document.querySelector('.story-bar span');
let current = -1;

function setActive(i) {
  if (i === current) return;
  current = i;
  steps.forEach((s, k) => s.classList.toggle('is-active', k === i));
  panels.forEach((p, k) => p.classList.toggle('is-active', k === i));
}

ScrollTrigger.create({
  trigger: '.story',
  start: 'top top',
  end: '+=300%',
  pin: '.story-pin',
  scrub: true,
  onUpdate: (self) => {
    setActive(Math.min(steps.length - 1, Math.floor(self.progress * steps.length)));
    gsap.set(bar, { scaleX: self.progress });
  },
});

// Reveal content as it enters the viewport
if (!reduce) {
  gsap.set('.reveal', { opacity: 0, y: 36 });
  ScrollTrigger.batch('.reveal', {
    start: 'top 88%',
    once: true,
    onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, duration: 0.7, stagger: 0.12, ease: 'power3.out' }),
  });
}

// Interactive quiz-score demo
const range = document.getElementById('score');
const tiers = [
  [80, 'good', 'Mastered', 'The task is closed and a light revision is added 7 days before the exam.'],
  [50, 'mid', 'Needs revision', 'A revision task lands in Todoist for tomorrow.'],
  [0, 'low', 'Redo the chapter', 'The chapter is scheduled again in 2 days.'],
];

function updateTier() {
  const v = Number(range.value);
  const [, key, name, text] = tiers.find(([min]) => v >= min);
  document.getElementById('scoreVal').textContent = v;
  document.getElementById('tier').dataset.tier = key;
  document.getElementById('tierName').textContent = name;
  document.getElementById('tierText').textContent = text;
}
range.addEventListener('input', updateTier);
updateTier();