// The start page's states (src/page.ts renders them all): ready, starting, full, error, films.
// Starting: a challenge from the launcher, the proof of work in a worker (pow-worker.js), the
// start; once the sandbox is healthy the launcher has set its cookie and `/` is the editor.
const root = document.documentElement;
const config = JSON.parse(document.getElementById('demo-config').textContent);
const texts = config.texts;
const t = (key, values = {}) =>
  (texts[key] ?? key).replace(/\{(\w+)\}/g, (_, name) =>
    String(values[name] ?? ''),
  );
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const RETRY_SECONDS = 120;

/* States. The heading of the new state takes the focus, so a screen reader reads where it is. */
function setState(state) {
  if (root.dataset.state === state) return;
  root.dataset.state = state;
  const heading = $(`.s-${state} h1, [data-state='${state}'] .films-block h2`);
  if (heading && state !== 'ready') {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: false });
  }
  if (state === 'full') scheduleRetry();
  else clearRetry();
}

/* The live line: how many sandboxes are free. */
function showStatus({ capacity, free }) {
  const dot = $('[data-live] .dot');
  dot.classList.toggle('warn', free === 0);
  $('[data-live-text]').textContent =
    free === 0 ? t('live.full') : t('live.free', { free, capacity });
}

async function readStatus() {
  const response = await fetch('/_demo/api/status', {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

/* A second tab, or a visitor coming back from another site (the cookie is SameSite=Strict, so the
 * first request from elsewhere comes without it): the sandbox is still theirs, so go to it. */
async function refresh() {
  try {
    const status = await readStatus();
    if (status.session?.active) {
      openSandbox();
      return status;
    }
    forget();
    showStatus(status);
    if (status.free === 0 && root.dataset.state === 'ready') setState('full');
    return status;
  } catch {
    return undefined;
  }
}

const OPENING = 'openfolia-demo-opening';
function forget() {
  try {
    sessionStorage.removeItem(OPENING);
  } catch {
    // No storage: nothing kept.
  }
}
function openSandbox() {
  // Once per tab while the sandbox lives: never a loop between this page and `/` when the cookie
  // is not sent with the navigation.
  try {
    if (sessionStorage.getItem(OPENING)) return;
    sessionStorage.setItem(OPENING, '1');
  } catch {
    return;
  }
  location.replace('/');
}

/* Starting. */
const steps = Object.fromEntries(
  $$('[data-step]').map((li) => [li.dataset.step, li]),
);
let stepTimer;
function step(name, progress) {
  const order = ['check', 'start', 'open'];
  const at = order.indexOf(name);
  clearInterval(stepTimer);
  for (const [index, key] of order.entries()) {
    const li = steps[key];
    li.classList.toggle('done', index < at);
    li.classList.toggle('now', index === at);
  }
  $('[data-progress]').style.width = `${progress}%`;
  const began = performance.now();
  const time = steps[name].querySelector('[data-time]');
  const tick = () => {
    time.textContent = t('starting.seconds', {
      seconds: ((performance.now() - began) / 1000).toFixed(1),
    });
  };
  tick();
  stepTimer = setInterval(tick, 100);
}

function solve(challenge, bits) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/_demo/pow-worker.js');
    worker.onmessage = (event) => {
      if (event.data.nonce === undefined) return;
      worker.terminate();
      resolve(event.data.nonce);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage({ challenge, bits });
  });
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

let wantStart = false;
let starting = false;

async function start() {
  if (starting) return;
  starting = true;
  wantStart = true;
  const lang = $('input[name="content-lang"]:checked')?.value ?? config.lang;
  setState('starting');
  try {
    step('check', 12);
    const challenge = await post('/_demo/api/challenge');
    if (challenge.status !== 200) return refused(challenge);
    const nonce = await solve(challenge.data.challenge, challenge.data.bits);
    step('start', 85);
    const started = await post('/_demo/api/start', {
      challenge: challenge.data.challenge,
      nonce,
      lang,
    });
    if (started.status !== 200 && started.status !== 201)
      return refused(started);
    step('open', 100);
    wantStart = false;
    location.replace('/');
  } catch {
    showError('error.title', t('error.network.lede'));
  } finally {
    starting = false;
  }
}

function refused({ status, data }) {
  clearInterval(stepTimer);
  const code = data?.code;
  if (code === 'full') {
    setState('full');
    return refresh();
  }
  wantStart = false;
  if (code === 'daily-limit') {
    const time = new Intl.DateTimeFormat(config.lang, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(data.retryAt));
    return showError(
      'limit.daily.title',
      t('limit.daily.lede', { daily: config.daily, time }),
    );
  }
  if (code === 'one-at-a-time')
    return showError('limit.once.title', t('limit.once.lede'));
  if (status === 429)
    return showError('limit.rate.title', t('limit.rate.lede'));
  return showError(
    'error.title',
    t('error.lede', { daily: config.daily }),
    data?.reference,
  );
}

function showError(titleKey, lede, reference) {
  wantStart = false;
  $('[data-error-title]').textContent = t(titleKey);
  $('[data-error-lede]').textContent = lede;
  const ref = $('[data-reference]');
  ref.hidden = !reference;
  ref.textContent = reference ? t('error.reference', { reference }) : '';
  setState('error');
}

/* Full: try again by itself after two minutes, the time counted down. */
let retryTimer;
function clearRetry() {
  clearInterval(retryTimer);
  retryTimer = undefined;
}
function scheduleRetry() {
  clearRetry();
  let left = RETRY_SECONDS;
  const line = $('[data-retry-text]');
  const show = () => {
    const minutes = Math.floor(left / 60);
    const seconds = String(left % 60).padStart(2, '0');
    line.textContent = t('full.retryIn', { time: `${minutes}:${seconds}` });
  };
  show();
  retryTimer = setInterval(() => {
    left -= 1;
    if (left > 0) return show();
    retryNow();
  }, 1000);
}
async function retryNow() {
  clearRetry();
  $('[data-retry-text]').textContent = t('full.retrying');
  const status = await refresh();
  if (status && status.free > 0) {
    if (wantStart) return start();
    return setState('ready');
  }
  scheduleRetry();
}

/* Films: a poster becomes its film, with controls, when chosen. */
for (const poster of $$('.poster[data-sources]')) {
  poster.addEventListener('click', () => {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-label', poster.getAttribute('aria-label') ?? '');
    for (const { src, type } of JSON.parse(poster.dataset.sources)) {
      const source = document.createElement('source');
      source.src = src;
      source.type = type;
      video.append(source);
    }
    video.poster = poster.querySelector('img')?.src ?? '';
    poster.replaceWith(video);
    video.focus();
  });
}

$('[data-start-form]').addEventListener('submit', (event) => {
  event.preventDefault();
  void start();
});
$('[data-retry]').addEventListener('click', () => void retryNow());
$('[data-again]').addEventListener('click', () => void start());
$('[data-show-films]')?.addEventListener('click', () => setState('films'));
$('[data-start]').disabled = false;

if (root.dataset.state === 'full') scheduleRetry();
void refresh();
