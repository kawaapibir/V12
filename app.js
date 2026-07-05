/* ==========================================================================
   HYBRID ATHLETE OS — V2.0 application logic
   Vanilla ES6. Dexie (IndexedDB) is the single source of truth; every
   mutation writes to Dexie first, then re-renders straight from it.
   ========================================================================== */

/* ---- Database -------------------------------------------------------------- */
const db = new Dexie('HybridAthleteOS');
db.version(1).stores({
  sessions: '++id, pillar, date, timestamp, [pillar+date]',
  deenDaily: 'date',
  settings: 'key'
});

const PRAYERS = ['subuh', 'dzuhur', 'ashar', 'maghrib', 'isya'];
let GOALS = { strength: 30, agility: 30 };
let userName = '';
let pendingDelete = null;
let deferredInstallPrompt = null;

/* ---- DOM helpers ------------------------------------------------------------ */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

/* ---- Date helpers ------------------------------------------------------------
   Always derive date keys from LOCAL time components, never toISOString()
   (that reads in UTC and would push a 5am Subuh entry onto the wrong day
   for anyone east of Greenwich). */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function timeAgo(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'Baru saja';
  if (min < 60) return `${min} menit lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} jam lalu`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'Kemarin';
  if (day < 7) return `${day} hari lalu`;
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

function formatHistoryDate(ts) {
  const ds = todayStr(new Date(ts));
  if (ds === todayStr()) return 'Hari ini';
  if (ds === todayStr(addDays(new Date(), -1))) return 'Kemarin';
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

/* ---- Settings / goals -------------------------------------------------------- */
async function getSetting(key, fallback) {
  const rec = await db.settings.get(key);
  return rec ? rec.value : fallback;
}
async function setSetting(key, value) {
  await db.settings.put({ key, value });
}
async function loadSettings() {
  userName = await getSetting('name', '');
  GOALS.strength = await getSetting('goalStrength', 30);
  GOALS.agility = await getSetting('goalAgility', 30);
}

/* ---- Deen day record ---------------------------------------------------------- */
async function getDeenDay(date) {
  const rec = await db.deenDaily.get(date);
  return rec || { date, subuh: false, dzuhur: false, ashar: false, maghrib: false, isya: false, quran: 0, dhikr: 0 };
}

/* ---- Aggregates --------------------------------------------------------------- */
async function sumDuration(pillar, date) {
  const rows = await db.sessions.where({ pillar, date }).toArray();
  return rows.reduce((s, r) => s + (Number(r.duration) || 0), 0);
}
async function dayHasActivity(dateStr) {
  if (await db.sessions.where({ pillar: 'strength', date: dateStr }).count()) return true;
  if (await db.sessions.where({ pillar: 'agility', date: dateStr }).count()) return true;
  const rec = await db.deenDaily.get(dateStr);
  return !!(rec && PRAYERS.some(p => rec[p]));
}
async function dayHasPrayer(dateStr) {
  const rec = await db.deenDaily.get(dateStr);
  return !!(rec && PRAYERS.some(p => rec[p]));
}
async function computeStreak(checkFn) {
  let streak = 0;
  let cursor = new Date();
  if (!(await checkFn(todayStr()))) cursor = addDays(cursor, -1);
  while (await checkFn(todayStr(cursor))) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/* ---- Ring rendering ------------------------------------------------------------ */
function setRing(id, pct) {
  const circle = document.getElementById(id);
  if (!circle) return;
  const r = circle.r.baseVal.value;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(pct, 1));
  circle.style.strokeDasharray = `${c} ${c}`;
  circle.style.strokeDashoffset = `${c * (1 - clamped)}`;
}

/* ---- Toast (status / undo / update) -------------------------------------------- */
let toastTimer = null;
function showToast(msg, opts = {}) {
  const { type = '', actionLabel = '', onAction = null, duration = 3000 } = opts;
  const toast = $('#toast');
  clearTimeout(toastTimer);
  toast.className = 'toast show' + (type ? ' ' + type : '');
  $('#toastMsg').textContent = msg;
  const actionEl = $('#toastAction');
  actionEl.classList.toggle('hidden', !actionLabel);
  actionEl.textContent = actionLabel;
  actionEl.onclick = () => { hideToast(); if (onAction) onAction(); };
  if (duration > 0) toastTimer = setTimeout(hideToast, duration);
}
function hideToast() { $('#toast').classList.remove('show'); }

/* ---- Empty state / row templates ----------------------------------------------- */
function emptyStateHTML(msg) {
  return `<div class="empty-state"><svg><use href="#icon-tray"></use></svg><p>${escapeHTML(msg)}</p></div>`;
}

function activityRowHTML(r) {
  const isStrength = r.pillar === 'strength';
  const icon = isStrength ? 'icon-dumbbell' : 'icon-basketball';
  const cls = isStrength ? 'strength' : 'agility';
  const title = r.name || (isStrength ? 'Latihan' : 'Sesi Basket');
  return `
    <div class="activity-row">
      <span class="activity-icon ${cls}"><svg><use href="#${icon}"></use></svg></span>
      <span class="activity-info">
        <div class="activity-title">${escapeHTML(title)}</div>
        <div class="activity-meta">${timeAgo(r.timestamp)}</div>
      </span>
      <span class="activity-value">${r.duration} menit</span>
      <button class="delete-x" data-id="${r.id}" aria-label="Hapus"><svg><use href="#icon-x"></use></svg></button>
    </div>`;
}

function historyRowHTML(r, pillar) {
  const title = r.name || (pillar === 'strength' ? 'Latihan' : 'Sesi Basket');
  let meta;
  if (pillar === 'strength') {
    meta = [r.sets ? `${r.sets} set` : null, r.reps ? `${r.reps} reps` : null, `${r.duration} menit`]
      .filter(Boolean).join(' • ');
  } else {
    meta = [`${r.duration} menit`, (r.made != null && r.attempted) ? `${r.made}/${r.attempted} shot` : null]
      .filter(Boolean).join(' • ');
  }
  return `
    <div class="history-row glass">
      <span class="history-dot"></span>
      <span class="history-info">
        <div class="history-title">${escapeHTML(title)}</div>
        <div class="history-meta">${formatHistoryDate(r.timestamp)} · ${meta}</div>
      </span>
      <button class="delete-x" data-id="${r.id}" aria-label="Hapus"><svg><use href="#icon-x"></use></svg></button>
    </div>`;
}

function attachDeleteHandlers(container) {
  $$('.delete-x', container).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSessionWithUndo(Number(btn.dataset.id));
    });
  });
}

async function deleteSessionWithUndo(id) {
  const item = await db.sessions.get(id);
  if (!item) return;
  await db.sessions.delete(id);
  pendingDelete = item;
  await refreshActiveView();
  showToast('Dihapus', {
    actionLabel: 'Urungkan',
    duration: 4000,
    onAction: async () => {
      if (!pendingDelete) return;
      const { id: oldId, ...rest } = pendingDelete;
      await db.sessions.add(rest);
      pendingDelete = null;
      await refreshActiveView();
    }
  });
}

async function refreshActiveView() {
  const active = $('.view.active');
  const view = active ? active.id.replace('view-', '') : 'dashboard';
  await renderDashboard();
  if (view === 'strength') await renderStrength();
  if (view === 'agility') await renderAgility();
  if (view === 'deen') await renderDeen();
}

/* ==========================================================================
   DASHBOARD
   ========================================================================== */
async function renderDashboard() {
  const today = todayStr();
  const [sMin, aMin, deenDay, streak] = await Promise.all([
    sumDuration('strength', today),
    sumDuration('agility', today),
    getDeenDay(today),
    computeStreak(dayHasActivity)
  ]);
  const prayerCount = PRAYERS.filter(p => deenDay[p]).length;
  const sPct = sMin / GOALS.strength;
  const aPct = aMin / GOALS.agility;
  const dPct = prayerCount / 5;

  setRing('ringStrength', sPct);
  setRing('ringAgility', aPct);
  setRing('ringDeen', dPct);

  const overall = Math.round(((Math.min(sPct, 1) + Math.min(aPct, 1) + Math.min(dPct, 1)) / 3) * 100);
  $('#ringsCenterValue').textContent = `${overall}%`;

  $('#valStrength').textContent = `${sMin}/${GOALS.strength} menit`;
  $('#valAgility').textContent = `${aMin}/${GOALS.agility} menit`;
  $('#valDeen').textContent = `${prayerCount}/5 sholat`;

  $('#streakValue').textContent = streak > 0 ? `${streak} hari beruntun` : 'Mulai hari ini';

  const rows = await db.sessions.orderBy('timestamp').reverse().limit(6).toArray();
  const list = $('#activityList');
  list.innerHTML = rows.length ? rows.map(activityRowHTML).join('') : emptyStateHTML('Belum ada aktivitas hari ini. Ayo mulai!');
  attachDeleteHandlers(list);
}

/* ==========================================================================
   STRENGTH / AGILITY (shared shape, different pillar)
   ========================================================================== */
async function renderStrength() {
  const today = todayStr();
  const min = await sumDuration('strength', today);
  $('#strengthTodayVal').textContent = `${min}/${GOALS.strength} menit`;
  setRing('ringStrengthMini', min / GOALS.strength);

  const rows = (await db.sessions.where('pillar').equals('strength').toArray())
    .sort((a, b) => b.timestamp - a.timestamp);
  const el = $('#strengthHistory');
  el.innerHTML = rows.length ? rows.map(r => historyRowHTML(r, 'strength')).join('') : emptyStateHTML('Belum ada latihan tercatat');
  attachDeleteHandlers(el);
}

async function renderAgility() {
  const today = todayStr();
  const min = await sumDuration('agility', today);
  $('#agilityTodayVal').textContent = `${min}/${GOALS.agility} menit`;
  setRing('ringAgilityMini', min / GOALS.agility);

  const rows = (await db.sessions.where('pillar').equals('agility').toArray())
    .sort((a, b) => b.timestamp - a.timestamp);
  const el = $('#agilityHistory');
  el.innerHTML = rows.length ? rows.map(r => historyRowHTML(r, 'agility')).join('') : emptyStateHTML('Belum ada sesi tercatat');
  attachDeleteHandlers(el);
}

/* ==========================================================================
   DEEN
   ========================================================================== */
async function renderDeen() {
  const deenDay = await getDeenDay(todayStr());

  PRAYERS.forEach(p => {
    const btn = $(`.prayer-btn[data-prayer="${p}"]`);
    if (btn) btn.classList.toggle('done', !!deenDay[p]);
  });

  $('#quranVal').textContent = deenDay.quran || 0;
  $('#dhikrVal').textContent = deenDay.dhikr || 0;

  await renderWeekGrid();
  const streak = await computeStreak(dayHasPrayer);
  $('#deenStreakVal').textContent = `${streak} hari`;
}

async function renderWeekGrid() {
  const today = todayStr();
  let html = '';
  for (let i = 6; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    const ds = todayStr(d);
    const rec = await db.deenDaily.get(ds);
    const count = rec ? PRAYERS.filter(p => rec[p]).length : 0;
    const label = d.toLocaleDateString('id-ID', { weekday: 'narrow' });
    html += `
      <div class="week-day">
        <div class="week-dot${ds === today ? ' today' : ''}"><div class="week-dot-fill" style="--fill:${count / 5}"></div></div>
        <span class="week-day-label">${label}</span>
      </div>`;
  }
  $('#weekGrid').innerHTML = html;
}

async function togglePrayer(prayer) {
  const rec = await getDeenDay(todayStr());
  rec[prayer] = !rec[prayer];
  await db.deenDaily.put(rec);
  await renderDeen();
  await renderDashboard();
}

async function bumpQuran(n) {
  const rec = await getDeenDay(todayStr());
  rec.quran = Math.max(0, (rec.quran || 0) + n);
  await db.deenDaily.put(rec);
  $('#quranVal').textContent = rec.quran;
  await renderDashboard();
}

async function bumpDhikr() {
  const rec = await getDeenDay(todayStr());
  rec.dhikr = (rec.dhikr || 0) + 1;
  await db.deenDaily.put(rec);
  $('#dhikrVal').textContent = rec.dhikr;
}

/* ==========================================================================
   NAVIGATION
   ========================================================================== */
async function switchView(view) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $(`#view-${view}`)?.classList.add('active');
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('.view-container').scrollTop = 0;
  if (view === 'dashboard') await renderDashboard();
  else if (view === 'strength') await renderStrength();
  else if (view === 'agility') await renderAgility();
  else if (view === 'deen') await renderDeen();
}

function setupNav() {
  $$('.nav-item').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  $$('[data-goto-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.gotoView)));
}

/* ==========================================================================
   BOTTOM SHEET — strength / agility / settings forms
   ========================================================================== */
function strengthFormHTML() {
  return `
    <h2 class="sheet-title">Catat Latihan</h2>
    <form id="strengthForm">
      <div class="field">
        <label class="field-label" for="sf-name">Nama Gerakan</label>
        <input id="sf-name" type="text" placeholder="Push Up, Pull Up, Plank..." required list="exerciseList" autocomplete="off">
        <datalist id="exerciseList">
          <option value="Push Up"></option><option value="Pull Up"></option><option value="Dips"></option>
          <option value="Squat"></option><option value="Plank"></option><option value="Muscle Up"></option>
          <option value="Sit Up"></option><option value="Lunges"></option>
        </datalist>
      </div>
      <div class="field-row">
        <div class="field"><label class="field-label" for="sf-sets">Set</label><input id="sf-sets" type="number" min="0" inputmode="numeric" placeholder="3"></div>
        <div class="field"><label class="field-label" for="sf-reps">Reps</label><input id="sf-reps" type="number" min="0" inputmode="numeric" placeholder="12"></div>
      </div>
      <div class="field">
        <label class="field-label" for="sf-duration">Durasi (menit)</label>
        <input id="sf-duration" type="number" min="1" inputmode="numeric" placeholder="30" required>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn-ghost" data-close-sheet>Batal</button>
        <button type="submit" class="btn-primary strength">Simpan</button>
      </div>
    </form>`;
}

function agilityFormHTML() {
  return `
    <h2 class="sheet-title">Catat Sesi Basket</h2>
    <form id="agilityForm">
      <div class="field">
        <label class="field-label" for="af-type">Jenis Latihan</label>
        <select id="af-type">
          <option>Free Throw</option><option>Three Point</option><option>Layup</option>
          <option>Dribbling</option><option>Scrimmage / Main</option><option>Sprint / Kondisi</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="af-duration">Durasi (menit)</label>
        <input id="af-duration" type="number" min="1" inputmode="numeric" placeholder="45" required>
      </div>
      <div class="field-row">
        <div class="field"><label class="field-label" for="af-made">Bola Masuk</label><input id="af-made" type="number" min="0" inputmode="numeric" placeholder="8"></div>
        <div class="field"><label class="field-label" for="af-attempted">Total Percobaan</label><input id="af-attempted" type="number" min="0" inputmode="numeric" placeholder="15"></div>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn-ghost" data-close-sheet>Batal</button>
        <button type="submit" class="btn-primary agility">Simpan</button>
      </div>
    </form>`;
}

function settingsFormHTML() {
  return `
    <h2 class="sheet-title">Pengaturan</h2>
    <form id="settingsForm">
      <div class="field">
        <label class="field-label" for="st-name">Nama Kamu</label>
        <input id="st-name" type="text" placeholder="Nama panggilan" value="${escapeHTML(userName)}" autocomplete="off">
      </div>
      <div class="settings-row">
        <label for="st-goal-strength">Target Strength</label>
        <input id="st-goal-strength" type="number" min="5" step="5" value="${GOALS.strength}" inputmode="numeric">
      </div>
      <div class="settings-row">
        <label for="st-goal-agility">Target Agility</label>
        <input id="st-goal-agility" type="number" min="5" step="5" value="${GOALS.agility}" inputmode="numeric">
      </div>
      <p class="field-hint">Target dalam menit per hari. Deen tetap 5 sholat wajib.</p>
      <div class="sheet-actions">
        <button type="button" class="btn-ghost" data-close-sheet>Batal</button>
        <button type="submit" class="btn-primary neutral">Simpan</button>
      </div>
    </form>`;
}

function openSheet(type) {
  const content = $('#sheetContent');
  if (type === 'strength') content.innerHTML = strengthFormHTML();
  else if (type === 'agility') content.innerHTML = agilityFormHTML();
  else if (type === 'settings') content.innerHTML = settingsFormHTML();
  else return;

  $('#logSheet').classList.add('open');
  $('#sheetOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';

  if (type === 'strength') $('#strengthForm').addEventListener('submit', onStrengthSubmit);
  if (type === 'agility') $('#agilityForm').addEventListener('submit', onAgilitySubmit);
  if (type === 'settings') $('#settingsForm').addEventListener('submit', onSettingsSubmit);
  $$('[data-close-sheet]', content).forEach(btn => btn.addEventListener('click', closeSheet));
}

function closeSheet() {
  $('#logSheet').classList.remove('open');
  $('#sheetOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

function setupSheet() {
  $$('[data-open-sheet]').forEach(btn => btn.addEventListener('click', () => openSheet(btn.dataset.openSheet)));
  $('#sheetOverlay').addEventListener('click', closeSheet);
}

async function onStrengthSubmit(e) {
  e.preventDefault();
  const name = $('#sf-name').value.trim();
  const duration = parseInt($('#sf-duration').value, 10) || 0;
  if (!name || duration <= 0) return;
  await db.sessions.add({
    pillar: 'strength', date: todayStr(), timestamp: Date.now(),
    name,
    sets: parseInt($('#sf-sets').value, 10) || 0,
    reps: parseInt($('#sf-reps').value, 10) || 0,
    duration
  });
  closeSheet();
  await renderDashboard();
  await renderStrength();
  showToast('Latihan tersimpan');
}

async function onAgilitySubmit(e) {
  e.preventDefault();
  const duration = parseInt($('#af-duration').value, 10) || 0;
  if (duration <= 0) return;
  const madeRaw = $('#af-made').value, attRaw = $('#af-attempted').value;
  await db.sessions.add({
    pillar: 'agility', date: todayStr(), timestamp: Date.now(),
    name: $('#af-type').value,
    duration,
    made: madeRaw ? parseInt(madeRaw, 10) : null,
    attempted: attRaw ? parseInt(attRaw, 10) : null
  });
  closeSheet();
  await renderDashboard();
  await renderAgility();
  showToast('Sesi tersimpan');
}

async function onSettingsSubmit(e) {
  e.preventDefault();
  userName = $('#st-name').value.trim();
  GOALS.strength = parseInt($('#st-goal-strength').value, 10) || 30;
  GOALS.agility = parseInt($('#st-goal-agility').value, 10) || 30;
  await Promise.all([
    setSetting('name', userName),
    setSetting('goalStrength', GOALS.strength),
    setSetting('goalAgility', GOALS.agility)
  ]);
  closeSheet();
  updateHeader();
  await renderDashboard();
  showToast('Pengaturan tersimpan');
}

/* ==========================================================================
   HEADER
   ========================================================================== */
function updateHeader() {
  const now = new Date();
  const h = now.getHours();
  const greet = h >= 4 && h < 11 ? 'Selamat Pagi' : h >= 11 && h < 15 ? 'Selamat Siang' : h >= 15 && h < 18 ? 'Selamat Sore' : 'Selamat Malam';
  $('#greeting').textContent = userName ? `${greet}, ${userName}` : greet;
  $('#dateLabel').textContent = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ==========================================================================
   CONNECTIVITY — quiet, non-blocking status only on change
   ========================================================================== */
function setupConnectivity() {
  window.addEventListener('online', () => showToast('Kembali online', { type: 'online', duration: 2500 }));
  window.addEventListener('offline', () => showToast('Mode offline — tersimpan di perangkat', { type: 'offline', duration: 3500 }));
}

/* ==========================================================================
   INSTALL PROMPT
   ========================================================================== */
function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', async (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!(await getSetting('installDismissed', false))) $('#installPill').classList.add('show');
  });
  $('#installConfirm').addEventListener('click', async () => {
    $('#installPill').classList.remove('show');
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });
  $('#installDismiss').addEventListener('click', async () => {
    $('#installPill').classList.remove('show');
    await setSetting('installDismissed', true);
  });
  window.addEventListener('appinstalled', () => {
    $('#installPill').classList.remove('show');
    deferredInstallPrompt = null;
  });
}

/* ==========================================================================
   SERVICE WORKER — install silently, ask before activating a new version
   ========================================================================== */
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // clients.claim() fires "controllerchange" both on a genuine update AND
  // on the very first install (going from no controller to one). Only the
  // former should trigger an auto-reload, so capture this before registering.
  const hadController = !!navigator.serviceWorker.controller;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            showToast('Update baru tersedia', {
              type: 'update', duration: 10000, actionLabel: 'Muat Ulang',
              onAction: () => nw.postMessage('SKIP_WAITING')
            });
          }
        });
      });
    }).catch(err => console.warn('[App] SW registration failed:', err));

    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });
}

/* ==========================================================================
   INIT
   ========================================================================== */
async function init() {
  await loadSettings();
  updateHeader();
  setupNav();
  setupSheet();
  $$('.prayer-btn').forEach(btn => btn.addEventListener('click', () => togglePrayer(btn.dataset.prayer)));
  $('#quranPlus1').addEventListener('click', () => bumpQuran(1));
  $('#quranPlus5').addEventListener('click', () => bumpQuran(5));
  $('#dhikrPlus').addEventListener('click', bumpDhikr);
  setupConnectivity();
  setupInstallPrompt();
  setupServiceWorker();
  await renderDashboard();
  setInterval(updateHeader, 60000);
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => console.error('[App] Init failed:', err));
});
