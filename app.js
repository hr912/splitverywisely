import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch, arrayUnion,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import {
  SPLIT_LABELS, clean, newCode, newUid, resolveAmounts, computeAll, buildTripFile, parseReceiptBlock, expenseSharesPence, pairwiseTransfers, effectiveItems, unclaimedItems,
} from './logic.js';
import {
  itemisedBreakdown, summarize, budgetState, describeChange, activityLine, canonicalName, combineTrips, unmatchedNames, settleMessage, findDuplicate, sha256Hex, buildCarryOver,
  coverage, paceInfo, todayLine, filterRows, buildRecap, savedOf,
  monthLabel, monthShort, monthEnd, inMonth, prevMonth, monthsWithData, monthTotals, pendingPayments, tabStatement, statementMessage,
} from './insights.js';
import { CATEGORIES, iconFor } from './categories.js';
import { THEMES, PRESET_ORDER, ICON_LIBRARY, resolveTheme, pickGreeting, applyTheme } from './theme.js';

// ---------------------------------------------------------------- setup
const app = initializeApp(firebaseConfig);
// Entries made with no signal wait on the phone and upload by themselves later.
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const STORE = 'svw-v1';
const blankStore = () => ({ trips: {}, prefs: { sortMode: 'date' }, budgets: {}, defaults: {}, seen: {}, nameMap: {} });
const readStore = () => {
  try { return { ...blankStore(), ...(JSON.parse(localStorage.getItem(STORE)) || {}) }; } catch { return blankStore(); }
};
const writeStore = (s) => { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* private mode etc. */ } };
const patchStore = (fn) => { const s = readStore(); fn(s); writeStore(s); return s; };

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (Number(n) || 0).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtShort = (iso) => { if (!iso) return ''; const [, m, d] = iso.split('-'); return `${Number(d)} ${SHORT_MONTHS[Number(m) - 1]}`; };
const fmtRange = (s, e) => { if (!s) return ''; if (!e || e === s) return fmtShort(s); const [, m1, d1] = s.split('-'); const [, m2] = e.split('-'); return m1 === m2 ? `${Number(d1)}–${fmtShort(e)}` : `${fmtShort(s)} – ${fmtShort(e)}`; };
const fmtNum = (n, cur) => `${Number(n).toFixed(2)} ${cur || ''}`.trim();
const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CNY', 'JPY', 'INR', 'AED', 'THB', 'CHF', 'TRY', 'CZK', 'PLN', 'HUF', 'MAD', 'EGP', 'MXN', 'CAD', 'AUD', 'ZAR', 'NOK', 'SEK', 'DKK', 'HRK'];
const PALETTE = ['#3cc0cc', '#5fd593', '#f2b25c', '#ff8a7a', '#a99cf0', '#6fa8ff', '#e58fc1', '#c9d36b', '#7fd0c0', '#d9a066', '#93a8ad'];
const FORM_VIEWS = ['form', 'pay', 'edit', 'new'];

// ---------------------------------------------------------------- state
const S = {
  view: 'home', // home | new | who | trip | form | pay | edit | activity | combo
  tab: 'expenses', // expenses | summary | balances | more
  code: null, me: null, greeting: '', themeKey: '', isOwner: false,
  trip: null, expenses: [], settlements: [], deleted: [], activity: [], adjustments: [],
  pend: { e: 0, s: 0, a: 0 }, loaded: false, missing: false,
  form: null, pay: null, edit: null, nt: null, combo: null, carry: null, adjView: null, person: null, noteForm: null, notes: [], deletedMap: {},
  flt: { q: '', who: '', cat: '', mine: false, open: false },
  error: '', notice: '',
  newMode: 'file',
  month: null, stmtMonth: null, homeBadges: {}, claimUid: null, claimTouched: false, draft: null,
};
// A running tab is a trip document with kind: 'tab' - same engine, but no dates, pounds only, month views and statements.
const isTab = () => S.trip?.kind === 'tab';
const noun = () => (isTab() ? 'tab' : 'trip');
const thisMonth = () => todayIso().slice(0, 7);
const curMonth = () => S.month || thisMonth();
// Balances can be shown as the fewest payments overall ("simple") or only what is between each pair of people ("direct").
const balanceMode = () => (readStore().prefs.balanceMode === 'direct' && !S.adjustments.length ? 'direct' : 'simple');
const transfersFor = (all) => (balanceMode() === 'direct' ? pairwiseTransfers(S.trip, S.expenses, S.settlements) : all.transfers);
// Under each person: who they pay / who pays them, following the chosen view (fewest payments, or directly between people).
function owesLines(name, transfers) {
  const out = transfers.filter((t) => t.from === name).map((t) => `Owes ${t.to === S.me ? 'you' : t.to} ${money(t.amount_gbp)}`);
  const inn = transfers.filter((t) => t.to === name).map((t) => `Is owed ${money(t.amount_gbp)} by ${t.from === S.me ? 'you' : t.from}`);
  const all = [...out, ...inn];
  return all.length ? `<div class="owes">${all.map(esc).join(' · ')}</div>` : '';
}
// Payments someone has said they made that the other person hasn't confirmed yet.
const pendingSum = (from, to) => S.settlements.filter((x) => x.status === 'claimed' && x.from === from && x.to === to).reduce((t, x) => t + Number(x.amount_gbp), 0);
function pendingLines(name) {
  const lines = S.settlements.filter((x) => x.status === 'claimed' && (x.from === name)).map((x) => `${name === S.me ? 'You' : name} paid ${x.to === S.me ? 'you' : x.to} ${money(x.amount_gbp)} - counted, waiting for ${x.to === S.me ? 'you' : x.to} to confirm`);
  return lines.length ? `<div class="owes neg">${lines.map(esc).join('<br>')}</div>` : '';
}
function balanceToggle() {
  if (S.adjustments.length) return '<p class="muted">Carried-over balances are in this trip, so payments are shown in the simplified way only.</p>';
  const m = balanceMode();
  return `<div class="seg" style="margin:8px 0"><button class="${m === 'simple' ? 'on' : ''}" data-act="balanceMode" data-mode="simple">Fewest payments</button><button class="${m === 'direct' ? 'on' : ''}" data-act="balanceMode" data-mode="direct">Directly between people</button></div>
    <p class="muted" style="margin-top:0">${m === 'simple' ? 'Fewest payments clears everyone, but may route money through a third person.' : 'Each pair only settles what is between the two of them - nobody is paid on behalf of someone else.'}</p>`;
}
let unsubs = [];
let idsWriting = false;

// ---------------------------------------------------------------- opening a trip
function leaveTrip() {
  unsubs.forEach((u) => u());
  unsubs = [];
  idsWriting = false;
  Object.assign(S, { code: null, trip: null, expenses: [], settlements: [], deleted: [], activity: [], adjustments: [], notes: [], deletedMap: {}, loaded: false, missing: false, pend: { e: 0, s: 0, a: 0 }, isOwner: false, themeKey: '' });
  applyTheme(THEMES.classic);
}

// Every person on a trip keeps one hidden id for life, even if their name is changed - the desktop app uses it
// to know "Jay" and the old "Jay Patel" are the same person.
function ensureMemberIds() {
  const t = S.trip;
  if (!t || !navigator.onLine) return;
  const ids = t.member_ids || {};
  const missing = (t.members || []).filter((m) => !ids[m]);
  if (!missing.length) { idsWriting = false; return; }
  if (idsWriting) return;
  idsWriting = true;
  const map = { ...ids };
  missing.forEach((m) => { map[m] = newUid(); });
  fireAndForget(updateDoc(tripRef(), { member_ids: map }));
}

async function computeOwner() {
  const token = readStore().trips[S.code]?.owner_token;
  let owner = false;
  try { owner = !!(token && S.trip?.owner_hash && (await sha256Hex(token)) === S.trip.owner_hash); } catch { owner = false; }
  if (owner !== S.isOwner) { S.isOwner = owner; softRender(); }
}

function refreshTheme() {
  const th = resolveTheme(S.trip?.theme);
  const key = JSON.stringify(S.trip?.theme || 'classic');
  if (key !== S.themeKey) { S.themeKey = key; S.greeting = pickGreeting(th); applyTheme(th); }
}

const live = { includeMetadataChanges: true };
function openTrip(code) {
  leaveTrip();
  S.code = code;
  S.me = readStore().trips[code]?.me || null;
  S.view = S.me ? 'trip' : 'who';
  S.tab = 'expenses';
  S.month = null; S.stmtMonth = null;
  const base = ['trips', code];
  // includeMetadataChanges makes these fire again the moment the server confirms a write,
  // so "waiting to upload" clears by itself.
  unsubs.push(onSnapshot(doc(db, ...base), live, (snap) => {
    S.loaded = true;
    S.missing = !snap.exists();
    S.trip = snap.exists() ? snap.data() : null;
    if (S.trip) {
      patchStore((s) => { s.trips[code] = { ...(s.trips[code] || {}), name: S.trip.name, kind: S.trip.kind || 'trip' }; });
      refreshTheme();
      computeOwner();
      ensureMemberIds();
      if (S.draft && S.me) { applyDraft(); return; }
    }
    softRender();
  }, () => { S.loaded = true; softRender(); }));
  unsubs.push(onSnapshot(collection(db, ...base, 'expenses'), live, (snap) => {
    S.expenses = snap.docs.map((d) => ({ ...d.data(), uid: d.id }));
    S.pend.e = snap.docs.filter((d) => d.metadata.hasPendingWrites).length;
    softRender();
  }));
  unsubs.push(onSnapshot(collection(db, ...base, 'settlements'), live, (snap) => {
    S.settlements = snap.docs.map((d) => ({ ...d.data(), uid: d.id }));
    S.pend.s = snap.docs.filter((d) => d.metadata.hasPendingWrites).length;
    softRender();
  }));
  unsubs.push(onSnapshot(collection(db, ...base, 'adjustments'), live, (snap) => {
    S.adjustments = snap.docs.map((d) => ({ ...d.data(), uid: d.id }));
    softRender();
  }));
  unsubs.push(onSnapshot(collection(db, ...base, 'activity'), live, (snap) => {
    S.activity = snap.docs.map((d) => ({ ...d.data(), uid: d.id })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    S.pend.a = snap.docs.filter((d) => d.metadata.hasPendingWrites).length;
    softRender();
  }));
  unsubs.push(onSnapshot(collection(db, ...base, 'deleted'), (snap) => {
    S.deleted = snap.docs.map((d) => d.id);
    S.deletedMap = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    softRender();
  }));
  unsubs.push(onSnapshot(collection(db, ...base, 'notes'), (snap) => {
    S.notes = snap.docs.map((d) => ({ ...d.data(), uid: d.id }));
    softRender();
  }));
  render();
}

// A tap-to-add link looks like  #t=CODE&r=<receipt block>  - the block is read straight into the "add expense" form.
function safeDecode(raw) {
  const plus = raw.replace(/\+/g, ' ');
  try { return decodeURIComponent(plus); } catch { /* a stray % - tidy it and try again */ }
  try { return decodeURIComponent(plus.replace(/%(?![0-9a-f]{2})/gi, '%25')); } catch { return plus; }
}
function routeFromHash() {
  const h = location.hash.replace(/^#/, '');
  const m = /(?:^|&)t=([a-z0-9]+)/i.exec(h);
  const ri = h.search(/(?:^|&)r=/);
  if (m) {
    S.draft = ri >= 0 ? safeDecode(h.slice(h.indexOf('r=', ri) + 2)) : null;
    if (S.draft) { try { history.replaceState(null, '', `#t=${m[1].toLowerCase()}`); } catch { /* ignore */ } }
    openTrip(m[1].toLowerCase());
  } else if (!['new', 'newtab', 'combo'].includes(S.view)) {
    leaveTrip();
    S.view = 'home';
    render();
  }
}
window.addEventListener('hashchange', routeFromHash);
window.addEventListener('online', () => render());
window.addEventListener('offline', () => render());

const tripLink = () => `${location.origin}${location.pathname}#t=${S.code}`;
const tripRef = (...p) => doc(db, 'trips', S.code, ...p);
const refFor = (code, ...p) => doc(db, 'trips', code, ...p);
const fireAndForget = (p) => p.catch((err) => { S.error = `Couldn't save: ${err.message}`; render(); });

function logActivity(text, kind, code = S.code, by = S.me, extra = {}) {
  fireAndForget(setDoc(refFor(code, 'activity', newUid()), clean({ at: new Date().toISOString(), by, kind, text, ...extra })));
}

// ---------------------------------------------------------------- rendering
function softRender() { if (!FORM_VIEWS.includes(S.view) && !(S.view === 'info' && S.noteForm)) render(); }
function render() {
  const views = { home: homeView, new: newView, newtab: newTabView, who: whoView, form: formView, pay: payView, edit: editView, activity: activityView, combo: comboView, carry: carryView, adj: adjView, info: infoView, person: personView, recap: recapView, claim: claimView };
  $app.innerHTML = (views[S.view] || tripView)();
}

const themePicker = (f) => {
  const t = S[f].theme;
  return `<label>Trip theme</label>
    <div class="themes">${PRESET_ORDER.map((id) => { const th = THEMES[id]; return `<button type="button" class="theme ${t.id === id ? 'on' : ''}" data-act="pickTheme" data-f="${f}" data-id="${id}">
      <span class="sw">${(th.stripe.length ? th.stripe : [th.accent[1]]).map((c) => `<span style="background:${c}"></span>`).join('')}</span><span><b>${esc(th.name)}</b><small>${esc(th.blurb)}</small></span></button>`; }).join('')}
      <button type="button" class="theme ${t.id === 'custom' ? 'on' : ''}" data-act="pickTheme" data-f="${f}" data-id="custom"><span class="sw">${t.colors.filter(Boolean).map((c) => `<span style="background:${c}"></span>`).join('')}</span><span><b>Make your own</b><small>Pick colours and doodles</small></span></button></div>
    ${t.id === 'custom' ? `<div class="card"><p class="muted" style="margin-top:0">Pick two or three colours (leave the third as it is to use just two)</p>
      <div class="row">${[0, 1, 2].map((i) => `<input type="color" data-ci="${i}" data-f="${f}" value="${esc(t.colors[i] || t.colors[0] || '#0e7c86')}" style="min-height:46px;padding:2px">`).join('')}</div>
      <p class="muted">Pick up to 8 doodles for the background</p>
      <div class="chips">${ICON_LIBRARY.map(([n, l]) => `<button type="button" class="chip ${t.doodles.includes(n) ? 'on' : ''}" data-act="pickDoodle" data-f="${f}" data-name="${n}"><i class="ti ti-${n}" aria-hidden="true"></i>${esc(l)}</button>`).join('')}</div></div>` : ''}`;
};
const themeValue = (t) => (t.id === 'custom' ? { id: 'custom', colors: t.colors.filter(Boolean).slice(0, 3), doodles: t.doodles } : t.id);
const themeState = (value) => {
  if (value && typeof value === 'object' && value.id === 'custom') return { id: 'custom', colors: [...(value.colors || []), '', '', ''].slice(0, 3), doodles: [...(value.doodles || [])] };
  return { id: typeof value === 'string' && THEMES[value] ? value : 'classic', colors: ['#0e7c86', '#f2b25c', ''], doodles: ['pizza', 'sun', 'camera'] };
};
const currencyList = `<datalist id="cur-list">${CURRENCIES.map((c) => `<option value="${c}">`).join('')}</datalist>`;

function tripFields(f) {
  const x = S[f];
  return `
    <label>Trip name</label><input data-f="${f}" data-k="name" value="${esc(x.name)}" placeholder="e.g. Naples weekend">
    <label>Destination (optional)</label><input data-f="${f}" data-k="destination" value="${esc(x.destination)}" placeholder="e.g. Naples, Italy">
    <div class="row"><div class="grow"><label>First day</label><input type="date" data-f="${f}" data-k="start_date" value="${esc(x.start_date)}"></div>
      <div class="grow"><label>Last day</label><input type="date" data-f="${f}" data-k="end_date" value="${esc(x.end_date)}"></div></div>
    <div class="row"><div class="grow"><label>Local currency</label><input list="cur-list" data-f="${f}" data-k="currency" value="${esc(x.currency)}" maxlength="5" autocapitalize="characters"></div>
      <div class="grow"><label>£ for 1 ${esc(x.currency || 'unit')}</label><input data-f="${f}" data-k="default_rate" inputmode="decimal" value="${esc(x.default_rate)}" placeholder="e.g. 0.85"></div></div>
    ${currencyList}
    <label>Group budget in £ (optional)</label><input data-f="${f}" data-k="budget_gbp" inputmode="decimal" value="${esc(x.budget_gbp)}" placeholder="e.g. 1200">
    ${themePicker(f)}`;
}

function homeRow([code, t]) {
  const n = S.homeBadges[code] || 0;
  return `
      <div class="ex" style="padding:6px 10px 6px 14px"><button class="plain grow" data-act="open" data-code="${esc(code)}"><span class="title">${esc(t.name || (t.kind === 'tab' ? 'Tab' : 'Trip'))}</span>
      <div class="muted">${t.me ? `You are ${esc(t.me)}` : 'Tap to choose who you are'}${n ? ` · <b class="neg">${n} payment${n === 1 ? '' : 's'} to confirm</b>` : ''}</div></button>
      <button class="danger" data-act="forget" data-code="${esc(code)}" aria-label="Remove from this phone">Remove</button></div>`;
}

function homeView() {
  const all = Object.entries(readStore().trips);
  const tabs = all.filter(([, t]) => t.kind === 'tab');
  const trips = all.filter(([, t]) => t.kind !== 'tab');
  return `
    <h1>SplitVeryWisely</h1>
    <p class="sub">Share the cost of a trip or a night out with friends. Everyone sees every expense straight away.</p>
    ${tabs.length ? `<h2>Running tabs</h2>${tabs.map(homeRow).join('')}` : ''}
    ${trips.length ? `<h2>Your trips</h2>${trips.map(homeRow).join('')}
      ${trips.length > 1 ? '<button class="secondary full" data-act="openCombo">Settle several trips together</button>' : ''}` : ''}
    <h2>Join a trip or a tab</h2>
    <p class="sub">Open the link your friend sent you, or paste it here.</p>
    <input id="joinInput" placeholder="Paste the link" autocapitalize="off" autocorrect="off">
    <div style="height:10px"></div>
    <button class="full" data-act="join">Join</button>
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
    <h2>Start something new</h2>
    <p class="sub">A <b>trip</b> is for a holiday or a day out. A <b>running tab</b> keeps going all year - like nights out with the same friends - with a statement each month.</p>
    <button class="secondary full" data-act="startNew">Start a new trip</button>
    <div style="height:8px"></div>
    <button class="secondary full" data-act="startTab">Start a running tab</button>`;
}

// One quick look at each running tab for payments waiting for me to confirm (shown on the home screen).
async function loadHomeBadges() {
  const store = readStore();
  const tabs = Object.entries(store.trips).filter(([, t]) => t.kind === 'tab' && t.me);
  if (!tabs.length || !navigator.onLine) return;
  const out = {};
  for (const [code, t] of tabs) {
    try {
      const snap = await getDocs(collection(db, 'trips', code, 'settlements'));
      const n = snap.docs.filter((d) => d.data().status === 'claimed' && d.data().to === t.me).length;
      if (n) out[code] = n;
    } catch { /* offline or no access - no badge */ }
  }
  S.homeBadges = out;
  if (S.view === 'home') render();
}

function newTabView() {
  return `
    <div class="topbar"><button class="ghost" data-act="home">← Back</button></div>
    <h1>Start a running tab</h1>
    <p class="sub">One shared balance that keeps going - add everything you pay for as you go, and send a statement at the end of each month. Always in pounds.</p>
    <label>Name of the tab</label><input data-f="nt" data-k="name" value="${esc(S.nt.name)}" placeholder="e.g. Leicester nights">
    <label>Your name</label><input data-f="nt" data-k="me" value="${esc(S.nt.me)}" placeholder="How your friends know you">
    <label>Friends (separate names with commas)</label><input data-f="nt" data-k="friends" value="${esc(S.nt.friends)}" placeholder="Jay, Ayush">
    ${themePicker('nt')}
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
    <div style="height:14px"></div>
    <button class="full" data-act="createTab">Create tab</button>`;
}

function newView() {
  return `
    <div class="topbar"><button class="ghost" data-act="home">← Back</button></div>
    <h1>Start a new trip</h1>
    <div class="seg">
      <button class="${S.newMode === 'file' ? 'on' : ''}" data-act="newMode" data-mode="file">From a desktop trip file</button>
      <button class="${S.newMode === 'blank' ? 'on' : ''}" data-act="newMode" data-mode="blank">From scratch</button>
    </div>
    ${S.newMode === 'file' ? `
      <p class="sub" style="margin-top:12px">On the desktop app, open the trip and press <b>Save trip file</b>, send yourself the file, then choose it here. The trip, the people, the theme and any expenses you've already entered come across.</p>
      <input type="file" id="tripFile" accept=".json,application/json">`
    : `
      <label>Your name</label><input data-f="nt" data-k="me" value="${esc(S.nt.me)}" placeholder="How your friends know you">
      <label>Friends (separate names with commas)</label><input data-f="nt" data-k="friends" value="${esc(S.nt.friends)}" placeholder="Jay, Ayush">
      ${tripFields('nt')}
      <div style="height:14px"></div>
      <button class="full" data-act="createBlank">Create trip</button>`}
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}`;
}

function missingView() {
  return `<div class="topbar"><button class="ghost" data-act="home">← Back</button></div>
    <h1>Can't find that trip</h1>
    <p class="sub">${navigator.onLine ? 'The link may be wrong, or the creator deleted this trip.' : 'You\'re offline - connect once to open a trip for the first time.'}</p>
    ${readStore().trips[S.code] ? '<button class="secondary full" data-act="forget" data-code="' + esc(S.code) + '">Remove it from this phone</button>' : ''}`;
}

function whoView() {
  if (!S.loaded) return '<p class="loading">Opening trip…</p>';
  if (S.missing || !S.trip) return missingView();
  return `
    <h1>${esc(S.trip.name)}</h1>
    <p class="sub">Who are you? Tap your name.</p>
    <div class="chips">${(S.trip.members || []).map((m) => `<button class="chip" data-act="iAm" data-name="${esc(m)}">${esc(m)}</button>`).join('')}</div>
    <h2>Not on the list?</h2>
    <input id="newMe" placeholder="Type your name">
    <div style="height:10px"></div>
    <button class="secondary full" data-act="addMe">Add me</button>
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}`;
}

function pendingCount() { return S.pend.e + S.pend.s + S.pend.a; }
function syncBadge() {
  if (!navigator.onLine) return '<span class="badge">Offline - saved on this phone</span>';
  if (pendingCount() > 0) return `<span class="badge">${pendingCount()} waiting to upload</span>`;
  return '<span class="badge sync">Live</span>';
}
const unseenCount = () => {
  const seen = readStore().seen[S.code] || '';
  return S.activity.filter((a) => a.by !== S.me && String(a.at) > seen).length;
};

function tripView() {
  if (!S.loaded) return `<p class="loading">Opening ${S.code && readStore().trips[S.code]?.kind === 'tab' ? 'tab' : 'trip'}…</p>`;
  if (S.missing || !S.trip) return missingView();
  const t = S.trip; const tab = isTab();
  const th = resolveTheme(t.theme);
  const all = computeAll(t, S.expenses, S.settlements, S.adjustments);
  const meRow = all.people.find((p) => p.name === S.me);
  const pend = tab ? pendingPayments(S.settlements, S.me) : null;
  const body = S.tab === 'summary' ? summaryTab(all) : S.tab === 'balances' ? balancesTab(all) : S.tab === 'more' ? moreTab() : expensesTab(all);
  const meta = tab ? 'Running tab' : [t.destination, fmtRange(t.start_date, t.end_date)].filter(Boolean).map(esc).join(' · ');
  const un = unseenCount();
  const nowMonthTotal = tab ? computeAll(t, S.expenses.filter((e) => inMonth(e.expense_date, thisMonth())), [], []).total : 0;
  const myNet = meRow ? meRow.net : 0;
  const cards = tab
    ? `<div class="mini a1"><div class="k">${esc(monthLabel(thisMonth()))}</div><div class="v num">${money(nowMonthTotal)}</div></div>
        <div class="mini a2"><div class="k">Your balance</div><div class="v num">${Math.abs(myNet) < 0.005 ? 'All square' : myNet > 0 ? `+${money(myNet)}` : `-${money(-myNet)}`}</div></div>`
    : `<div class="mini a1"><div class="k">Trip total</div><div class="v num">${money(all.total)}</div></div>
        <div class="mini a2"><div class="k">Your share</div><div class="v num">${money(meRow?.share || 0)}</div></div>`;
  return `
    <header class="top">
      ${th.stripe.length ? `<div class="stripe">${th.stripe.map((c) => `<span style="background:${c}"></span>`).join('')}</div>` : ''}
      <div class="row between"><button class="ghost" data-act="home">${tab ? '← Home' : '← Trips'}</button>
        <span class="row">${syncBadge()}<button class="bell" data-act="openInfo" aria-label="Info"><i class="ti ti-info-circle" aria-hidden="true"></i></button><button class="bell" data-act="openActivity" aria-label="Activity"><i class="ti ti-bell" aria-hidden="true"></i>${un ? `<span class="dotn">${un > 9 ? '9+' : un}</span>` : ''}</button></span></div>
      <div class="ttl">${esc(t.name)}</div>
      <div class="meta">${meta}${meta ? ' · ' : ''}<em>${esc(S.greeting)}, ${esc(S.me)}</em></div>
      <div class="cards2">${cards}</div>
    </header>
    ${S.notice ? `<div class="alert">${esc(S.notice)}</div>` : ''}
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
    ${pend && pend.toConfirm.length && S.tab !== 'balances' ? `<button class="alert tapalert" data-act="tab" data-tab="balances"><b>${pend.toConfirm.length} payment${pend.toConfirm.length === 1 ? '' : 's'} waiting for you to confirm</b> - tap to see</button>` : ''}
    ${pend && pend.disputedMine.length && S.tab !== 'balances' ? `<button class="alert tapalert" data-act="tab" data-tab="balances"><b>${pend.disputedMine.length} payment${pend.disputedMine.length === 1 ? '' : 's'} you sent ${pend.disputedMine.length === 1 ? 'was' : 'were'} marked as not received</b> - tap to see</button>` : ''}
    ${tab ? '' : carryBanner(all)}
    ${body}
    ${S.tab === 'expenses' ? '<div class="fabs"><button class="secondary" data-act="addReceipt">From a receipt</button><button data-act="addExpense">+ Add expense</button></div>' : ''}
    <nav class="tabs">
      ${[['expenses', 'Expenses', 'receipt-2'], ['summary', 'Summary', 'chart-pie'], ['balances', 'Balances', 'scale'], ['more', 'More', 'dots']]
    .map(([k, l, ic]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}"><i class="ti ti-${ic}" aria-hidden="true"></i><span>${l}</span>${k === 'balances' && pend && (pend.toConfirm.length + pend.disputedMine.length) ? `<span class="dotn">${pend.toConfirm.length + pend.disputedMine.length}</span>` : ''}</button>`).join('')}
    </nav>`;
}

function estimateAlert(all) {
  if (!all.estimatedCount) return '';
  const est = S.expenses.filter((e) => e.gbp_estimated);
  const mine = est.filter((e) => e.paid_by === S.me);
  const byPayer = {};
  est.filter((e) => e.paid_by !== S.me).forEach((e) => { (byPayer[e.paid_by] ||= []).push(e); });
  return `<div class="alert"><b>${all.estimatedCount} amount${all.estimatedCount === 1 ? ' is' : 's are'} only estimated</b> (${money(all.estimatedGbp)}). Only the person who paid knows the real pounds.
    ${mine.length ? `<div style="margin-top:8px"><b>You need to confirm:</b><div class="chips" style="margin-top:6px">${mine.map((e) => `<button type="button" class="chip" data-act="editExpense" data-uid="${esc(e.uid)}">${esc(e.description)} · ${esc(e.orig_amount ? fmtNum(e.orig_amount, e.orig_currency) : money(e.amount_gbp))}</button>`).join('')}</div></div>` : ''}
    ${Object.keys(byPayer).length ? `<div style="margin-top:8px">Waiting for: ${Object.entries(byPayer).map(([n, l]) => `${esc(n)} (${l.map((e) => esc(e.description)).join(', ')})`).join('; ')}</div>` : ''}</div>`;
}

function rowsFor(all) {
  const sortMode = readStore().prefs.sortMode;
  const added = (x) => String(x.created_at || x.updated_at || x.settle_date || '');
  const rows = [
    ...S.expenses.map((e) => ({ kind: 'expense', e, date: e.expense_date || '', added: added(e) })),
    ...S.settlements.map((s) => ({ kind: 'payment', s, date: s.settle_date || '', added: added(s) })),
    ...S.adjustments.map((x) => ({ kind: 'carry', a: x, date: x.date || '', added: added(x) })),
  ].sort((x, y) => (sortMode === 'added'
    ? String(y.added).localeCompare(String(x.added))
    : String(y.date).localeCompare(String(x.date)) || String(y.added).localeCompare(String(x.added))));
  const month = curMonth();
  const shown = isTab() && month !== 'all' ? rows.filter((r) => r.kind === 'carry' || inMonth(r.date, month)) : rows;
  return filterRows(shown, S.flt, S.me, all);
}

function rowHtml(r, all) {
  if (r.kind === 'carry') {
    const x = r.a;
    return `<button class="ex pay" data-act="openAdj" data-uid="${esc(x.uid)}"><div class="tile tn"><i class="ti ti-arrows-exchange" aria-hidden="true"></i></div><div class="mid"><p class="t">${esc(x.label)}</p><p class="s">${esc(fmtShort(x.date))}${x.date ? ' · ' : ''}Balances only - no cost${x.kind === 'in' ? ' · tap to see' : ''}</p></div></button>`;
  }
  if (r.kind === 'payment') {
    const s = r.s;
    return `<button class="ex pay" data-act="editPayment" data-uid="${esc(s.uid)}"><div class="tile tg"><i class="ti ti-cash" aria-hidden="true"></i></div><div class="mid"><p class="t" style="font-weight:400">${esc(s.from === S.me ? 'You' : s.from)} paid ${esc(s.to === S.me ? 'you' : s.to)} <b>${money(s.amount_gbp)}</b></p><p class="s">${esc(fmtShort(s.settle_date))}${s.settle_date ? ' · ' : ''}Payment${s.status === 'claimed' ? ' · <b class="neg">waiting for confirmation</b>' : s.status === 'disputed' ? ' · <b class="neg">not received - not counted</b>' : ''}${s.notes ? ` · ${esc(s.notes)}` : ''}</p></div></button>`;
  }
  const e = r.e;
  const mineP = (all.shareByExpense[e.uid] || {})[S.me];
  const mine = mineP != null ? mineP / 100 : 0;
  const iPaid = e.paid_by === S.me;
  let tone = 'n'; let label = '';
  if (iPaid) {
    const lent = (e.amount_gbp - (e.cashback_gbp || 0)) - mine;
    if (lent > 0.004) { tone = 'g'; label = `you lent ${money(lent)}`; }
  } else if (mine > 0.004) { tone = 'r'; label = `you borrowed ${money(mine)}`; }
  const what = e.subtype || e.category || '';
  return `<button class="ex" data-act="editExpense" data-uid="${esc(e.uid)}">
      <div class="tile t${tone}"><i class="ti ti-${iconFor(e.category, e.subtype)}" aria-hidden="true"></i></div>
      <div class="mid"><p class="t">${esc(e.description)}</p>
        <p class="s">${esc(fmtShort(e.expense_date))}${e.expense_date ? ' · ' : ''}${esc(iPaid ? 'You paid' : `${e.paid_by} paid`)}${what ? ` · ${esc(what)}` : ''}${e.gbp_estimated ? '<span class="est">est. £</span>' : ''}</p>
        <p class="s">${mineP != null ? `Your share ${money(mine)}` : "You're not involved"}${all.problems[e.uid] ? ' · <span class="neg">check the split</span>' : ''}${unclaimedItems(e).length ? ` · <span class="neg">${unclaimedItems(e).length} item${unclaimedItems(e).length === 1 ? '' : 's'} to pick</span>` : ''}${savedOf(e).saved > 0 ? ` · saved ${esc(savedOf(e).local && e.orig_currency ? curFmt(savedOf(e).saved, e.orig_currency) : money(savedOf(e).saved))}` : ''}</p></div>
      <div class="amt"><b class="num">${money(e.amount_gbp)}</b>${label ? `<span class="${tone}t">${label}</span>` : ''}${e.orig_amount ? `<span class="m">${esc(fmtNum(e.orig_amount, e.orig_currency))}</span>` : ''}${e.cashback_gbp > 0 ? `<span class="m">cashback -${money(e.cashback_gbp)}</span>` : ''}</div>
    </button>`;
}

const filterActive = () => !!(S.flt.q || S.flt.who || S.flt.cat || S.flt.mine);
function listHtml(all) {
  const rows = rowsFor(all);
  if (rows.length === 0) return filterActive() ? '<p class="sub">Nothing matches. Try clearing the search or filters.</p>' : '<p class="sub">Nothing yet - tap "Add expense".</p>';
  return rows.map((r) => rowHtml(r, all)).join('');
}
function countText(all) {
  if (!filterActive()) return '';
  const n = rowsFor(all).length;
  return `Showing ${n} of ${S.expenses.length + S.settlements.length}`;
}
function refreshList() {
  const el = document.getElementById('explist');
  if (!el || !S.trip) return;
  const all = computeAll(S.trip, S.expenses, S.settlements, S.adjustments);
  el.innerHTML = listHtml(all);
  const c = document.getElementById('fltcount');
  if (c) c.textContent = countText(all);
}

// Month chips for a running tab (newest first, plus "All").
function monthBar() {
  const months = monthsWithData(S.expenses, S.settlements, thisMonth());
  const cur = curMonth();
  return `<div class="chips mbar">${months.slice(0, 14).map((m) => `<button type="button" class="chip ${cur === m ? 'on' : ''}" data-act="pickMonth" data-month="${m}">${esc(monthShort(m))}</button>`).join('')}<button type="button" class="chip ${cur === 'all' ? 'on' : ''}" data-act="pickMonth" data-month="all">All</button></div>`;
}
function monthLine() {
  const cur = curMonth();
  const inM = S.expenses.filter((e) => inMonth(e.expense_date, cur));
  const mm = computeAll(S.trip, inM, [], []);
  const mine = (mm.people.find((p) => p.name === S.me) || {}).share || 0;
  return `<p class="today">${esc(monthLabel(cur))}: <b>${money(mm.total)}</b> across ${inM.length} expense${inM.length === 1 ? '' : 's'} · your share <b>${money(mine)}</b></p>`;
}

function expensesTab(all) {
  const sortMode = readStore().prefs.sortMode;
  const today = todayLine(S.expenses, all, S.me, todayIso());
  const f = S.flt;
  const cats = [...new Set([...CATEGORIES.map((c) => c.name), ...S.expenses.map((e) => e.category).filter(Boolean)])];
  const people = [...new Set([...(S.trip.members || []), ...S.expenses.map((e) => e.paid_by)])];
  const openRec = S.expenses.filter((e) => unclaimedItems(e).length);
  const claimBanner = openRec.length ? `<div class="alert"><b>Items waiting to be picked</b> - tap one, then tick what you had.<div class="chips" style="margin-top:6px">${openRec.map((e) => `<button type="button" class="chip" data-act="openClaim" data-uid="${esc(e.uid)}">${esc(e.description)} · ${unclaimedItems(e).length} left</button>`).join('')}</div></div>` : '';
  return `
    ${isTab() ? monthBar() + monthLine() : ''}
    ${claimBanner}
    ${estimateAlert(all)}
    ${today ? `<p class="today">Today so far <b>${money(today.total)}</b> · your share <b>${money(today.mine)}</b></p>` : ''}
    <div class="row"><input data-flt="q" placeholder="Search expenses" value="${esc(f.q)}" autocomplete="off"><button class="secondary" data-act="toggleFilters">Filters${(f.who || f.cat || f.mine) ? ' ●' : ''}</button></div>
    ${f.open ? `<div class="card">
      <label style="margin-top:0">Paid by</label><select data-flt="who"><option value="">Anyone</option>${people.map((n) => `<option ${f.who === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <label>Category</label><select data-flt="cat"><option value="">All categories</option>${cats.map((n) => `<option ${f.cat === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" data-flt="mine" ${f.mine ? 'checked' : ''}> Only ones I'm part of</label>
      <button class="ghost" data-act="clearFilters">Clear search and filters</button></div>` : ''}
    <div class="row between" style="margin:6px 0"><div class="seg small"><button class="${sortMode === 'date' ? 'on' : ''}" data-act="sort" data-mode="date">By date</button><button class="${sortMode === 'added' ? 'on' : ''}" data-act="sort" data-mode="added">By when added</button></div><span class="muted" id="fltcount">${esc(countText(all))}</span></div>
    <div id="explist">${listHtml(all)}</div>`;
}

// ---- Summary
function donut(byCategory, total, ink = 'currentColor') {
  const R = 40; const C = 2 * Math.PI * R;
  let off = 0;
  const segs = byCategory.map((c, i) => {
    const len = total > 0 ? (c.total / total) * C : 0;
    const s = `<circle cx="58" cy="58" r="${R}" stroke="${PALETTE[i % PALETTE.length]}" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`;
    off += len;
    return s;
  }).join('');
  return `<svg width="124" height="124" viewBox="0 0 116 116" role="img" aria-label="Spending by category"><g transform="rotate(-90 58 58)" fill="none" stroke-width="18"><circle cx="58" cy="58" r="${R}" stroke="${ink}" opacity="0.12"/>${segs}</g>
    <text x="58" y="55" text-anchor="middle" font-size="10" fill="${ink}" opacity="0.6">Total</text><text x="58" y="70" text-anchor="middle" font-size="13" font-weight="700" fill="${ink}">${esc(money(total).replace(/\.00$/, ''))}</text></svg>`;
}

function budgetBar(label, st, hint) {
  if (!st) return '';
  return `<div class="bud"><div class="bl"><b>${label}</b><span>${money(st.spent)} of ${money(st.budget)}</span></div>
    <div class="track"><div class="fill ${st.tone}" style="width:${Math.min(100, st.pct)}%"></div></div>
    <div class="sub2"><span>${st.left >= 0 ? `${money(st.left)} left` : `${money(-st.left)} over`}</span><span>${hint}</span></div></div>`;
}

const summaryMode = () => (readStore().prefs.summaryMode === 'me' ? 'me' : 'all');
function modeToggle() {
  const mode = summaryMode();
  return `<div class="seg" style="margin:8px 0"><button class="${mode === 'all' ? 'on' : ''}" data-act="summaryMode" data-mode="all">Everyone</button><button class="${mode === 'me' ? 'on' : ''}" data-act="summaryMode" data-mode="me">Just me</button></div>`;
}

function chartBlocks(sm, total, ink) {
  const maxDay = Math.max(1, sm.before, sm.after, ...sm.days.map((d) => d.total));
  const bar = (v) => `${Math.max(3, Math.round((v / maxDay) * 90))}px`;
  return `
    <h2>Where the money went</h2>
    <div class="card donutrow">
      ${donut(sm.byCategory, total, ink)}
      <div class="legend">${sm.byCategory.map((c, i) => {
    const cat = CATEGORIES.find((x) => x.name === c.name);
    return `<div><span><span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span><i class="ti ti-${cat ? cat.icon : 'dots'}" aria-hidden="true"></i> ${esc(c.name)}</span><span class="num">${money(c.total)}</span></div>`;
  }).join('')}</div>
    </div>
    <h2>Spending per day <span class="muted">average ${money(sm.avgPerDay)} a day</span></h2>
    <div class="card"><div class="days">
      ${sm.before > 0 ? `<div class="day"><b>${money(sm.before).replace(/\.00$/, '')}</b><div class="dbar before" style="height:${bar(sm.before)}"></div>Booked before</div>` : ''}
      ${sm.days.map((d) => `<div class="day"><b>${money(d.total).replace(/\.00$/, '')}</b><div class="dbar" style="height:${bar(d.total)}"></div>${esc(d.date === 'undated' ? 'No date' : fmtShort(d.date))}</div>`).join('')}
      ${sm.after > 0 ? `<div class="day"><b>${money(sm.after).replace(/\.00$/, '')}</b><div class="dbar before" style="height:${bar(sm.after)}"></div>After</div>` : ''}
    </div><p class="muted" style="margin:8px 0 0">Flights and stays booked before the trip are shown apart so they don't flatten the holiday days.</p></div>
    <h2>Biggest expenses</h2>
    <div class="card">${sm.biggest.map((b) => `<div class="row" style="padding:6px 0"><div class="tile tn" style="width:34px;height:34px;font-size:18px"><i class="ti ti-${iconFor(b.category, b.subtype)}" aria-hidden="true"></i></div><div class="grow"><b>${esc(b.description)}</b><div class="muted">${esc(b.subtype || b.category || '')}${b.date ? ` · ${esc(fmtShort(b.date))}` : ''}</div></div><b class="num">${money(b.amount)}</b></div>`).join('')}</div>`;
}

function paidVsShareBlock(sm) {
  const maxPP = Math.max(1, ...sm.paidVsShare.map((p) => Math.max(p.paid, p.share)));
  return `<h2>Who paid and who owes</h2>
    <div class="card">${sm.paidVsShare.map((p) => `<div class="pp"><div class="row between"><span>${esc(p.name === S.me ? `${p.name} (you)` : p.name)}</span><span class="muted num">paid ${money(p.paid)} · share ${money(p.share)}</span></div>
      <div class="two"><div class="paid" style="width:${(p.paid / maxPP) * 100}%"></div></div><div class="two"><div class="shr" style="width:${(p.share / maxPP) * 100}%"></div></div></div>`).join('')}
      <p class="muted" style="margin:6px 0 0"><span class="dot" style="background:var(--accent)"></span>paid &nbsp; <span class="dot" style="background:var(--muted)"></span>their share</p></div>`;
}

function coverageBlock(cov) {
  return `<h2>You and the others</h2>
    <div class="card">
      <div class="row between"><span>You paid for other people's shares</span><b class="num">${money(cov.forOthers)}</b></div>
      <div class="row between" style="margin-top:6px"><span>Other people paid for your share</span><b class="num">${money(cov.byOthers)}</b></div>
      ${cov.estimated > 0.004 ? `<div class="row between" style="margin-top:6px"><span>Still only estimated in your share</span><b class="num">${money(cov.estimated)}</b></div><p class="muted" style="margin:6px 0 0">The real pounds will firm this up once whoever paid confirms them.</p>` : ''}
    </div>`;
}

function paceBlock(pace, mode) {
  if (!pace) return '';
  const who = mode === 'me' ? "You're" : "You're all";
  return `<h2>Pace</h2><div class="card">${who} spending about <b>${money(pace.daily)}</b> a day (day ${pace.elapsed} of ${pace.tripDays}). At this pace the trip ends at about <b>${money(pace.projected)}</b>${pace.budget ? (pace.over ? ` - <span class="neg">over the budget of ${money(pace.budget)}</span>` : ` - within the budget of ${money(pace.budget)}`) : ''}.</div>`;
}

function summaryTab(all) {
  if (isTab()) return tabSummaryTab();
  const t = S.trip; const mode = summaryMode(); const who = mode === 'me' ? S.me : null;
  if (!S.expenses.length) return '<p class="sub">Add a few expenses and this page fills in.</p>';
  const today = todayIso();
  const sm = summarize(t, S.expenses, all, today, who);
  const meRow = all.people.find((p) => p.name === S.me);
  const total = who ? (meRow?.share || 0) : all.total;
  const personalBudget = readStore().budgets[S.code];
  const budget = mode === 'all'
    ? (budgetBar('Group budget', budgetState(t.budget_gbp, all.total), `${budgetState(t.budget_gbp, all.total)?.pct}% used`) || '<p class="muted" style="margin:0">No group budget set. Add one under More, then Edit trip.</p>')
    : `${budgetBar('Your budget <i class="ti ti-lock" aria-hidden="true"></i>', budgetState(personalBudget, total), 'only you can see this') || '<p class="muted" style="margin:0">You haven\'t set a private budget for this trip.</p>'}
      <button class="ghost" data-act="personalBudget">${personalBudget ? 'Change' : 'Set'} your private budget</button>`;
  return `
    ${modeToggle()}
    <h2>Budget</h2>
    <div class="card">${budget}</div>
    ${paceBlock(paceInfo(sm, t, today, mode === 'all' ? t.budget_gbp : personalBudget), mode)}
    ${chartBlocks(sm, total, 'currentColor')}
    ${mode === 'all' ? paidVsShareBlock(sm) : coverageBlock(coverage(S.me, S.expenses, all))}
    <div style="height:10px"></div>
    <button class="secondary full" data-act="openRecap">Open the trip summary page</button>`;
}

// ---- Trip summary (one shareable page)
function recapView() {
  const t = S.trip; const mode = summaryMode(); const who = mode === 'me' ? S.me : null;
  const all = computeAll(t, S.expenses, S.settlements, S.adjustments);
  const r = buildRecap(t, S.expenses, all, who, todayIso());
  const th = resolveTheme(t.theme);
  const ink = typeof getComputedStyle === 'function' && document.body ? getComputedStyle(document.body).color : '#888888';
  const meta = [t.destination, fmtRange(t.start_date, t.end_date)].filter(Boolean).map(esc).join(' · ');
  const cat = r.topCategory;
  const facts = [
    ['Expenses', String(r.count)],
    r.priciestDay ? ['Priciest day', `${fmtShort(r.priciestDay.date)} · ${money(r.priciestDay.total)}`] : null,
    r.priciest ? ['Biggest expense', `${r.priciest.description} · ${money(r.priciest.amount)}`] : null,
    cat ? ['Top category', `${cat.name} · ${r.total > 0 ? Math.round((cat.total / r.total) * 100) : 0}%`] : null,
    !who && r.people.length ? ['Per person, per day', money(r.perPersonPerDay)] : null,
  ].filter(Boolean);
  const meRow = all.people.find((p) => p.name === S.me);
  return `
    <div class="topbar"><button class="ghost" data-act="back">← Back</button></div>
    ${modeToggle()}
    <div id="recap" class="recap">
      ${th.stripe.length ? `<div class="stripe" style="margin:0 0 10px">${th.stripe.map((c) => `<span style="background:${c}"></span>`).join('')}</div>` : ''}
      <p class="rlabel">Trip summary${who ? ` · just ${esc(who)}` : ''}</p>
      <h1 style="margin:2px 0 2px">${esc(t.name)}</h1>
      <p class="sub">${meta}</p>
      <div class="rtotal"><span>${who ? 'Your share of the trip' : 'Total cost'}</span><b class="num">${money(r.total)}</b></div>
      <div class="facts">${facts.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
      ${chartBlocks(r.sm, r.total, ink)}
      ${who ? coverageBlock(coverage(S.me, S.expenses, all)) : `<h2>Everyone's part</h2><div class="card">${r.people.map((p) => `<div class="row between" style="padding:3px 0"><span>${esc(p.name)}</span><span class="muted num">paid ${money(p.paid)} · share ${money(p.share)}</span></div>`).join('')}</div>`}
      <h2>Settling up</h2>
      <div class="card">${r.settled ? '<b>Everyone is all square.</b>' : r.transfers.map((x) => `<div class="row between" style="padding:3px 0"><span><b>${esc(x.from)}</b> pays <b>${esc(x.to)}</b></span><b class="num">${money(x.amount_gbp)}</b></div>`).join('')}</div>
      <p class="rfoot">SplitVeryWisely</p>
    </div>
    ${S.notice ? `<div class="alert">${esc(S.notice)}</div>` : ''}
    <button class="full" data-act="sharePicture">Share as picture</button>
    <p class="muted">If the picture doesn't come out, take a screenshot of this page instead.</p>`;
}

async function sharePicture() {
  const el = document.getElementById('recap');
  try {
    if (!window.html2canvas) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
      });
    }
    const canvas = await window.html2canvas(el, { backgroundColor: getComputedStyle(document.body).backgroundColor, scale: 2, useCORS: true });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const name = `${(S.trip.name || 'trip').replace(/[^\w\- ]+/g, '').trim() || 'trip'}-summary.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: S.trip.name }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = name; document.body.appendChild(link); link.click(); link.remove();
    S.notice = `Saved ${name}`; render();
  } catch {
    S.notice = 'Couldn\'t make the picture on this phone - take a screenshot of this page instead.'; render();
  }
}

// ---- Trip info (shared notes)
function infoView() {
  const notes = S.notes.slice().sort((x, y) => String(x.created_at || '').localeCompare(String(y.created_at || '')));
  const f = S.noteForm;
  return `
    <div class="topbar"><button class="ghost" data-act="back">← Back</button></div>
    <h1>${isTab() ? 'Notes' : 'Trip info'}</h1>
    <p class="sub">Addresses, flight times, booking references, door codes - everyone on the trip can see and edit these.</p>
    ${f ? `<div class="card">
      <label style="margin-top:0">Title</label><input data-f="noteForm" data-k="title" value="${esc(f.title)}" placeholder="e.g. Airbnb address">
      <label>Details</label><textarea data-f="noteForm" data-k="body" placeholder="Anything worth keeping handy">${esc(f.body)}</textarea>
      <label class="check"><input type="checkbox" data-f="noteForm" data-k="address" ${f.address ? 'checked' : ''}> This is an address (adds an "Open in maps" button)</label>
      ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
      <div class="row" style="margin-top:8px"><button class="grow" data-act="saveNote">${f.id ? 'Save changes' : 'Add note'}</button><button class="secondary" data-act="cancelNote">Cancel</button></div>
      ${f.id ? '<button class="danger" data-act="deleteNote">Delete this note</button>' : ''}</div>`
    : '<button class="full" data-act="addNote">+ Add a note</button>'}
    ${notes.length === 0 && !f ? '<p class="sub">Nothing here yet.</p>' : ''}
    ${notes.map((n) => `<div class="card"><b>${esc(n.title)}</b>${n.body ? `<div style="white-space:pre-wrap;margin-top:4px">${esc(n.body)}</div>` : ''}
      <div class="row" style="margin-top:8px;flex-wrap:wrap"><button class="secondary" data-act="copyNote" data-uid="${esc(n.uid)}">Copy</button>
      ${n.address ? `<a class="btn secondary" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([n.title, n.body].filter(Boolean).join(' ').slice(0, 200))}" target="_blank" rel="noopener">Open in maps</a>` : ''}
      <button class="ghost" data-act="editNote" data-uid="${esc(n.uid)}">Edit</button></div></div>`).join('')}`;
}

// ---- Tap a person
function personView() {
  const name = S.person;
  const all = computeAll(S.trip, S.expenses, S.settlements, S.adjustments);
  const row = all.people.find((p) => p.name === name) || { paid: 0, share: 0, net: 0, settled: 0, carried: 0 };
  const paidFor = S.expenses.filter((e) => e.paid_by === name).sort((x, y) => String(y.expense_date || '').localeCompare(String(x.expense_date || '')));
  const shares = S.expenses.map((e) => ({ e, p: ((all.shareByExpense[e.uid] || {})[name] || 0) / 100 })).filter((x) => x.p > 0).sort((x, y) => y.p - x.p);
  const estPaid = paidFor.filter((e) => e.gbp_estimated);
  const pays = S.settlements.filter((s) => s.from === name || s.to === name);
  const line = (e, amt) => `<div class="row between" style="padding:4px 0"><span class="grow">${esc(e.description)}<span class="muted"> · ${esc(fmtShort(e.expense_date))}</span>${e.gbp_estimated ? '<span class="est"> est. £</span>' : ''}</span><b class="num">${money(amt)}</b></div>`;
  return `
    <div class="topbar"><button class="ghost" data-act="back">← Back</button></div>
    <h1>${esc(name === S.me ? `${name} (you)` : name)}</h1>
    <p class="sub ${row.net > 0.004 ? 'pos' : row.net < -0.004 ? 'neg' : ''}">${esc(bal(row.net))}</p>
    ${owesLines(name, transfersFor(all))}
    <div class="stat-row"><div class="card"><div class="label">Paid out</div><div class="big num">${money(row.paid)}</div></div><div class="card"><div class="label">Their share</div><div class="big num">${money(row.share)}</div></div></div>
    ${estPaid.length ? `<div class="alert"><b>${esc(name)} still needs to confirm the real pounds for:</b> ${estPaid.map((e) => esc(e.description)).join(', ')}.</div>` : ''}
    <h2>What they paid for</h2>
    <div class="card">${paidFor.length ? paidFor.map((e) => line(e, e.amount_gbp)).join('') : '<p class="muted" style="margin:0">Nothing.</p>'}</div>
    <h2>Their share of</h2>
    <div class="card">${shares.length ? shares.map((x) => line(x.e, x.p)).join('') : '<p class="muted" style="margin:0">Nothing.</p>'}</div>
    ${pays.length ? `<h2>Payments</h2><div class="card">${pays.map((s) => `<div class="row between" style="padding:4px 0"><span>${esc(fmtShort(s.settle_date))} · ${esc(s.from)} paid ${esc(s.to)}</span><b class="num">${money(s.amount_gbp)}</b></div>`).join('')}</div>` : ''}`;
}

// ---- Balances (who owes what + settle up)
function balancesTab(all) {
  if (isTab()) return tabBalancesTab(all);
  return `
    ${estimateAlert(all)}
    ${balanceToggle()}
    <h2>Who owes what</h2>
    ${all.people.map((p) => `<div class="card tap" data-act="openPerson" data-name="${esc(p.name)}"><div class="row between"><b>${esc(p.name === S.me ? `${p.name} (you)` : p.name)} ›</b>
      <span class="${p.net > 0.004 ? 'pos' : p.net < -0.004 ? 'neg' : 'muted'} num">${Math.abs(p.net) < 0.005 ? 'All square' : p.net > 0 ? `Is owed ${money(p.net)}` : `Owes ${money(-p.net)}`}</span></div>
      ${owesLines(p.name, transfersFor(all))}
      <div class="muted num">Paid ${money(p.paid)} · Their share ${money(p.share)}${p.settled ? ` · Payments ${money(p.settled)}` : ''}${Math.abs(p.carried) > 0.004 ? ` · Carried over ${p.carried > 0 ? '+' : '-'}${money(Math.abs(p.carried))}` : ''}</div></div>`).join('')}
    <h2>Settle up</h2>
    <p class="sub">Always in pounds. Someone paid a different amount? Use "Record a payment".</p>
    ${transfersFor(all).length === 0 ? `<p class="sub">${S.expenses.length ? 'Everyone is all square.' : 'Nothing to settle yet.'}</p>` : transfersFor(all).map((t) => `
      <div class="card"><div class="row between"><span><b>${esc(t.from === S.me ? 'You' : t.from)}</b> pay${t.from === S.me ? '' : 's'} <b>${esc(t.to === S.me ? 'you' : t.to)}</b></span><b class="num">${money(t.amount_gbp)}</b></div>
      <div style="height:8px"></div><button class="secondary" data-act="payFor" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amt="${t.amount_gbp.toFixed(2)}">Record this payment</button></div>`).join('')}
    <div class="row" style="margin-top:8px;flex-wrap:wrap"><button class="secondary" data-act="payFor">Record a payment</button>
      <button class="secondary" data-act="whatsapp">Share who pays whom</button></div>
    ${S.settlements.length ? `<h2>Payments recorded</h2>${S.settlements.slice().sort((a, b) => String(b.settle_date).localeCompare(String(a.settle_date))).map((s) => `
      <div class="row between" style="padding:6px 0"><span>${esc(s.settle_date ? `${fmtShort(s.settle_date)} · ` : '')}${esc(s.from)} paid ${esc(s.to)} <b class="num">${money(s.amount_gbp)}</b>${s.notes ? `<span class="muted"> · ${esc(s.notes)}</span>` : ''}</span>
      <button class="danger" data-act="undoPay" data-uid="${esc(s.uid)}">Undo</button></div>`).join('')}` : ''}`;
}

// ---- Running tab: Summary (a month at a time, plus month by month)
function categoryBlock(sm, total, ink) {
  return `
    <h2>Where the money went</h2>
    <div class="card donutrow">
      ${donut(sm.byCategory, total, ink)}
      <div class="legend">${sm.byCategory.map((c, i) => {
    const cat = CATEGORIES.find((x) => x.name === c.name);
    return `<div><span><span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span><i class="ti ti-${cat ? cat.icon : 'dots'}" aria-hidden="true"></i> ${esc(c.name)}</span><span class="num">${money(c.total)}</span></div>`;
  }).join('')}</div>
    </div>`;
}
function biggestBlock(sm) {
  if (!sm.biggest.length) return '';
  return `<h2>Biggest expenses</h2>
    <div class="card">${sm.biggest.map((b) => `<div class="row" style="padding:6px 0"><div class="tile tn" style="width:34px;height:34px;font-size:18px"><i class="ti ti-${iconFor(b.category, b.subtype)}" aria-hidden="true"></i></div><div class="grow"><b>${esc(b.description)}</b><div class="muted">${esc(b.subtype || b.category || '')}${b.date ? ` · ${esc(fmtShort(b.date))}` : ''}</div></div><b class="num">${money(b.amount)}</b></div>`).join('')}</div>`;
}

function tabSummaryTab() {
  const t = S.trip; const mode = summaryMode(); const who = mode === 'me' ? S.me : null;
  if (!S.expenses.length) return '<p class="sub">Add a few expenses and this page fills in.</p>';
  const month = curMonth();
  const exps = S.expenses.filter((e) => inMonth(e.expense_date, month));
  const allM = computeAll(t, exps, [], []);
  const sm = summarize({}, exps, allM, todayIso(), who);
  const meRow = allM.people.find((p) => p.name === S.me);
  const total = who ? (meRow?.share || 0) : allM.total;
  const months = monthsWithData(S.expenses, S.settlements, thisMonth());
  const valueOf = (m) => {
    const inM = S.expenses.filter((e) => inMonth(e.expense_date, m));
    const a = computeAll(t, inM, [], []);
    return who ? ((a.people.find((p) => p.name === S.me) || {}).share || 0) : a.total;
  };
  const rows = months.slice(0, 12).map((m) => ({ month: m, value: valueOf(m) }));
  const maxV = Math.max(1, ...rows.map((r) => r.value));
  return `
    ${monthBar()}
    ${modeToggle()}
    <div class="card"><div class="muted">${esc(monthLabel(month))}${who ? ' · just your share' : ''}</div>
      <div class="big num" style="font-size:1.7rem;font-weight:700">${money(total)}</div>
      <div class="muted">${exps.length} expense${exps.length === 1 ? '' : 's'}${exps.length ? ` · average ${money((allM.total) / exps.length)} each` : ''}</div></div>
    ${exps.length === 0 ? '<p class="sub">Nothing in this month.</p>' : `
      ${categoryBlock(sm, total, 'currentColor')}
      ${biggestBlock(sm)}
      ${mode === 'all' ? paidVsShareBlock(sm) : coverageBlock(coverage(S.me, exps, allM))}`}
    <h2>Month by month</h2>
    <div class="card">${rows.map((r) => `<button type="button" class="mrow ${r.month === month ? 'on' : ''}" data-act="pickMonth" data-month="${r.month}"><span class="ml">${esc(monthShort(r.month))}</span><span class="mb"><span style="width:${Math.max(2, Math.round((r.value / maxV) * 100))}%"></span></span><b class="num">${money(r.value)}</b></button>`).join('')}</div>
    <p class="muted">Tap a month to look at it.</p>`;
}

// ---- Running tab: Balances (running balance, payments to confirm, month-end statement)
function statementMonth() { return S.stmtMonth || prevMonth(thisMonth()); }

function tabBalancesTab(all) {
  const pend = pendingPayments(S.settlements, S.me);
  const sm = statementMonth();
  const st = tabStatement(S.trip, S.expenses, S.settlements, sm, balanceMode());
  const months = monthsWithData(S.expenses, S.settlements, thisMonth());
  const stmtMonths = [...new Set([prevMonth(thisMonth()), ...months])].sort().reverse().slice(0, 12);
  const payRow = (s, buttons) => `<div class="card"><div class="row between"><span>${esc(s.from === S.me ? 'You' : s.from)} said ${s.from === S.me ? 'you' : 'they'} paid ${esc(s.to === S.me ? 'you' : s.to)}</span><b class="num">${money(s.amount_gbp)}</b></div>
      <div class="muted">${esc(fmtShort(s.settle_date))}${s.notes ? ` · ${esc(s.notes)}` : ''}</div><div class="row" style="margin-top:8px;flex-wrap:wrap">${buttons}</div></div>`;
  return `
    ${pend.toConfirm.length ? `<h2>Waiting for you</h2>${pend.toConfirm.map((s) => payRow(s, `<button class="grow" data-act="confirmPay" data-uid="${esc(s.uid)}">Got it</button><button class="secondary" data-act="declinePay" data-uid="${esc(s.uid)}">Haven't received it</button>`)).join('')}` : ''}
    ${pend.waiting.length ? `<h2>You've paid - waiting for them</h2>${pend.waiting.map((s) => payRow(s, `<span class="muted grow">Waiting for ${esc(s.to)} to tap "Got it"</span><button class="danger" data-act="cancelClaim" data-uid="${esc(s.uid)}">Cancel</button>`)).join('')}` : ''}
    ${pend.disputedMine.length ? `<h2>Marked as not received</h2>${pend.disputedMine.map((s) => payRow(s, `<span class="muted grow">${esc(s.to)} says this hasn't arrived - check with them. It is not counted.</span><button class="danger" data-act="cancelClaim" data-uid="${esc(s.uid)}">Delete it</button>`)).join('')}` : ''}
    ${pend.disputedToMe.length ? `<h2>You said you haven't received</h2>${pend.disputedToMe.map((s) => payRow(s, `<button class="grow" data-act="confirmPay" data-uid="${esc(s.uid)}">It arrived - Got it</button><button class="danger" data-act="cancelClaim" data-uid="${esc(s.uid)}">Delete it</button>`)).join('')}` : ''}
    ${balanceToggle()}
    <h2>Who owes what</h2>
    <p class="sub">Everything on the tab so far. A payment someone says they've made is counted straight away and marked until the other person taps "Got it" - if they say they haven't received it, it comes off again.</p>
    ${all.people.map((p) => `<div class="card tap" data-act="openPerson" data-name="${esc(p.name)}"><div class="row between"><b>${esc(p.name === S.me ? `${p.name} (you)` : p.name)} ›</b>
      <span class="${p.net > 0.004 ? 'pos' : p.net < -0.004 ? 'neg' : 'muted'} num">${Math.abs(p.net) < 0.005 ? 'All square' : p.net > 0 ? `Is owed ${money(p.net)}` : `Owes ${money(-p.net)}`}</span></div>
      ${owesLines(p.name, transfersFor(all))}${pendingLines(p.name)}
      <div class="muted num">Paid ${money(p.paid)} · Their share ${money(p.share)}${p.settled ? ` · Payments ${money(p.settled)}` : ''}</div></div>`).join('')}
    <h2>Settle up</h2>
    <p class="sub">Paid someone? Tap "I've paid" and they'll be asked to confirm.</p>
    ${transfersFor(all).length === 0 ? `<p class="sub">${S.expenses.length ? 'Everyone is all square.' : 'Nothing to settle yet.'}</p>` : transfersFor(all).map((t) => {
    const mine = t.from === S.me; const toMe = t.to === S.me;
    const pend = pendingSum(t.from, t.to);
    let action = '';
    if (mine) {
      if (pend > 0.004) action += `<p class="muted" style="margin:8px 0 0">You've already sent ${money(pend)} (counted, waiting for ${esc(t.to)} to confirm).</p>`;
      action += `<div style="height:8px"></div><button class="secondary" data-act="claimPaid" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amt="${t.amount_gbp.toFixed(2)}">${pend > 0.004 ? "I've paid this too" : "I've paid this"}</button>`;
    } else if (toMe) {
      const claim = S.settlements.find((x) => x.status === 'claimed' && x.from === t.from && x.to === S.me);
      action = claim
        ? `<p class="muted" style="margin:8px 0 0">${esc(t.from)} says they've already paid you <b>${money(pend)}</b> (counted - tap Got it when it arrives).</p><div style="height:8px"></div><button data-act="confirmPay" data-uid="${esc(claim.uid)}">Got it</button>`
        : `<div style="height:8px"></div><button class="secondary" data-act="receivedPaid" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amt="${t.amount_gbp.toFixed(2)}">${esc(t.from)} has paid me</button>`;
    }
    return `<div class="card"><div class="row between"><span><b>${esc(mine ? 'You' : t.from)}</b> pay${mine ? '' : 's'} <b>${esc(toMe ? 'you' : t.to)}</b></span><b class="num">${money(t.amount_gbp)}</b></div>${action}</div>`;
  }).join('')}
    <div class="row" style="margin-top:8px;flex-wrap:wrap"><button class="secondary" data-act="payFor">Record a different amount</button></div>
    <h2>Month-end statement</h2>
    <p class="sub">Who owes whom at the end of a month, ready to send to the group chat.</p>
    <div class="chips mbar">${stmtMonths.map((m) => `<button type="button" class="chip ${sm === m ? 'on' : ''}" data-act="pickStmt" data-month="${m}">${esc(monthShort(m))}</button>`).join('')}</div>
    <div class="card"><b>${esc(st.label)}</b>
      <div class="muted">Spent ${money(st.monthTotal)} across ${st.monthCount} expense${st.monthCount === 1 ? '' : 's'}</div>
      ${st.transfers.length === 0 ? '<p style="margin:8px 0 0">Everyone was all square.</p>' : st.transfers.map((x) => `<div class="row between" style="padding:4px 0"><span><b>${esc(x.from)}</b> pays <b>${esc(x.to)}</b></span><b class="num">${money(x.amount_gbp)}</b></div>`).join('')}
      ${st.waiting.length ? `<p class="muted" style="margin:6px 0 0">Already paid, waiting to be confirmed: ${st.waiting.map((x) => `${esc(x.from)} → ${esc(x.to)} ${money(x.amount_gbp)}`).join(', ')}</p>` : ''}</div>
    <button class="full" data-act="sendStatement">Send this statement on WhatsApp</button>
    ${S.settlements.length ? `<h2>Payments recorded</h2>${S.settlements.slice().sort((a, b) => String(b.settle_date).localeCompare(String(a.settle_date))).map((s) => `
      <div class="row between" style="padding:6px 0"><span>${esc(s.settle_date ? `${fmtShort(s.settle_date)} · ` : '')}${esc(s.from)} paid ${esc(s.to)} <b class="num">${money(s.amount_gbp)}</b>${s.status === 'claimed' ? ' <b class="neg">· not confirmed yet</b>' : s.status === 'disputed' ? ' <b class="neg">· marked as not received</b>' : ''}${s.notes ? `<span class="muted"> · ${esc(s.notes)}</span>` : ''}</span>
      <button class="danger" data-act="undoPay" data-uid="${esc(s.uid)}">Undo</button></div>`).join('')}` : ''}`;
}

// ---- More
function moreTab() {
  const t = S.trip;
  const store = readStore();
  const hasOwner = !!t.owner_hash;
  return `
    <h2>Invite friends</h2>
    <p class="sub">Anyone with this link sees and edits the ${noun()}. They tap their name the first time they open it.</p>
    <div class="card"><div class="muted" style="word-break:break-all">${esc(tripLink())}</div></div>
    <div class="row"><button class="grow" data-act="shareLink">Share the link</button><button class="secondary" data-act="copyLink">Copy</button></div>
    <h2>People on this ${noun()}</h2>
    <div class="chips">${(t.members || []).map((m) => `<button type="button" class="chip ${m === S.me ? 'on' : ''}" data-act="rename" data-name="${esc(m)}">${esc(m)} ✎</button>`).join('')}</div>
    <p class="muted">Tap a name to rename it everywhere - handy for a typo, or to change "Me" to your real name.</p>
    <div class="row"><input id="addPerson" placeholder="Add someone"><button data-act="addPerson">Add</button></div>
    <h2>${isTab() ? 'Tab' : 'Trip'}</h2>
    <div class="menu">
      <button data-act="openInfo"><i class="ti ti-info-circle" aria-hidden="true"></i><span>${isTab() ? 'Notes' : 'Trip info'}<small>${isTab() ? 'Anything worth keeping handy for the group' : 'Addresses, flight times, booking references'}</small></span></button>
      ${isTab() ? '' : `<button data-act="openRecap"><i class="ti ti-photo" aria-hidden="true"></i><span>Trip summary<small>One page to look back on, with Share as picture</small></span></button>`}
      <button data-act="openActivity"><i class="ti ti-bell" aria-hidden="true"></i><span>Activity<small>Everything that changed, and who changed it</small></span></button>
      <button data-act="editTrip"><i class="ti ti-pencil" aria-hidden="true"></i><span>${isTab() ? 'Edit tab' : 'Edit trip'}<small>${isTab() ? 'Name and theme' : 'Name, dates, currency, rate, budget and theme'}</small></span></button>
      ${isTab() ? '' : `<button data-act="openCarry"><i class="ti ti-arrow-big-right-lines" aria-hidden="true"></i><span>Settle this trip into another trip<small>Close it and move who-owes-what to another trip</small></span></button>
      <button data-act="openCombo"><i class="ti ti-arrows-exchange" aria-hidden="true"></i><span>Settle several trips together<small>Add up balances across trips, e.g. Naples and Oxford</small></span></button>`}
      <button data-act="exportFile"><i class="ti ti-download" aria-hidden="true"></i><span>${isTab() ? 'Save tab file' : 'Save trip file'}<small>For the desktop app - also a handy backup</small></span></button>
    </div>
    <h2>Your phone</h2>
    <button class="ghost" data-act="changeMe">I'm not ${esc(S.me)} - change who I am</button>
    <button class="danger" data-act="forget" data-code="${esc(S.code)}">Remove this ${noun()} from my phone</button>
    <h2>Danger zone</h2>
    ${S.isOwner ? `<p class="sub">You created this ${noun()}. Deleting it removes it for everyone, for good.</p><button class="dangerbtn full" data-act="deleteTrip">Delete this ${noun()} for everyone</button>`
    : hasOwner ? `<p class="sub">Only the person who created this ${noun()} can delete it for everyone.</p>`
      : `<p class="sub">This ${noun()} has no creator yet. If you created it, tap below. Only the first person to tap becomes the creator, so do it now.</p><button class="secondary full" data-act="claimOwner">I'm the creator of this ${noun()}</button>`}`;
}

// ---- Activity
function activityView() {
  patchStore((s) => { s.seen[S.code] = new Date().toISOString(); });
  return `
    <div class="topbar"><button class="ghost" data-act="back">← Back</button></div>
    <h1>Activity</h1>
    <p class="sub">Everything that changed on this trip, newest first.</p>
    ${S.activity.length === 0 ? '<p class="sub">Nothing yet.</p>' : S.activity.map((a) => `
      <div class="card" style="padding:10px 12px"><div>${esc(a.text)}</div><div class="muted">${esc(fmtWhen(a.at))}</div>${a.kind === 'deleted' && a.ref && S.deletedMap[a.ref]?.expense ? `<button class="secondary" style="margin-top:8px" data-act="restore" data-uid="${esc(a.ref)}">Restore this expense</button>` : ''}</div>`).join('')}`;
}

// ---------------------------------------------------------------- pick your own items
function claimView() {
  const e = S.expenses.find((x) => x.uid === S.claimUid);
  const back = '<div class="topbar"><button class="ghost" data-act="claimDone">← Back</button></div>';
  if (!e || !e.items) return `${back}<p class="sub">That receipt isn't here any more.</p>`;
  const items = effectiveItems(e);
  const mineIdx = (e.claims || {})[S.me] || [];
  const all = computeAll(S.trip, S.expenses, S.settlements, S.adjustments);
  const my = ((all.shareByExpense[e.uid] || {})[S.me] || 0) / 100;
  const left = unclaimedItems(e);
  const cur = items.some((i) => i.in_local) && e.orig_currency ? e.orig_currency : 'GBP';
  const leftSum = left.reduce((t, it) => t + Number(it.amount), 0);
  return `${back}
    <h1>${esc(e.description)}</h1>
    <p class="sub">${esc(fmtShort(e.expense_date))}${e.expense_date ? ' · ' : ''}${esc(e.paid_by)} paid ${money(e.amount_gbp)}${e.cashback_gbp > 0 ? ` (cashback ${money(e.cashback_gbp)} shared out)` : ''}. Tap everything you had.</p>
    ${items.map((it, i) => {
    const named = ((e.items[i] || {}).names || []).includes(S.me);
    const mine = named || mineIdx.includes(i);
    const others = it.names.filter((n) => n !== S.me);
    return `<button class="ex claimrow ${mine ? 'on' : ''}" data-act="claimItem" data-i="${i}" ${named ? 'disabled' : ''}><span class="cbox">${mine ? '✓' : ''}</span><div class="mid"><p class="t">${esc(it.description)}</p><p class="s">${others.length ? `Also: ${esc(others.join(', '))}` : (it.names.length ? '' : 'Nobody yet')}${named ? ' · set by the person who added it' : ''}</p></div><span class="amtcol"><b class="num">${curFmt(it.amount, cur)}</b>${Number(it.was) > Number(it.amount) ? `<s class="was">${curFmt(it.was, cur)}</s>` : ''}</span></button>`;
  }).join('')}
    ${savedOf(e).saved > 0 ? `<p class="muted">Discounts saved ${curFmt(savedOf(e).saved, cur)} on this receipt - the prices above are what was actually charged.</p>` : ''}
    <div class="card">Your share so far: <b class="num">${money(my)}</b><div class="muted">Your items plus your part of any service charge or VAT${e.cashback_gbp > 0 ? ', after cashback' : ''}.</div></div>
    ${left.length ? `<div class="alert">${left.length} item${left.length === 1 ? '' : 's'} (${curFmt(leftSum, cur)}) nobody has picked yet - counted against ${esc(e.paid_by)} until someone does.</div>` : '<p class="sub">Everything is picked.</p>'}
    <button class="full" data-act="claimDone">Done</button>`;
}

// ---------------------------------------------------------------- expense form
function savedDefaults() {
  const d = readStore().defaults[S.code];
  const members = S.trip.members || [];
  if (!d) return null;
  return { split_type: d.split_type, who: (d.who || []).filter((n) => members.includes(n)) };
}
function blankForm() {
  const t = S.trip;
  const members = t.members || [];
  const d = savedDefaults();
  const on = d && d.who.length ? new Set(d.who) : new Set(members);
  return {
    uid: null, description: '', expense_date: todayIso(), category: '', subtype: '', amount_gbp: '', orig_amount: '',
    orig_currency: t.currency, rate: '', paid_by: S.me, split_type: d && d.split_type && d.split_type !== 'items' ? d.split_type : 'equal',
    participants: Object.fromEntries(members.map((m) => [m, { on: on.has(m), value: '' }])),
    items: [{ description: '', amount: '', names: members.slice() }], extras: [], editItems: false, collapsed: [],
    notes: '', paste: '', pasteMsg: '', claim_open: false, cashback_on: false, gift_card: '', cashback_pct: '',
  };
}
function formFromExpense(e) {
  const members = S.trip.members || [];
  const participants = Object.fromEntries(members.map((m) => [m, { on: false, value: '' }]));
  (e.participants || []).forEach((p) => { participants[p.name] = { on: true, value: p.value ?? '' }; });
  return {
    uid: e.uid, description: e.description, expense_date: e.expense_date || '', category: e.category || '', subtype: e.subtype || '',
    // An estimated pound figure isn't real - leave the box empty so it stays an estimate until typed in.
    amount_gbp: e.gbp_estimated ? '' : e.amount_gbp,
    orig_amount: e.orig_amount ?? '', orig_currency: e.orig_currency || S.trip.currency,
    rate: e.gbp_estimated && e.rate ? e.rate : '',
    paid_by: e.paid_by, split_type: e.split_type, participants,
    items: e.items && e.items.length ? effectiveItems(e).map((i) => ({ description: i.description, amount: i.amount, names: i.names || [], was: i.was ?? '' })) : [{ description: '', amount: '', names: members.slice() }],
    claim_open: !!e.claim_open, cashback_on: Number(e.cashback_gbp) > 0, gift_card: e.gift_card_gbp ?? '', cashback_pct: e.cashback_pct ?? '',
    extras: e.extras || [], editItems: false, collapsed: [],
    notes: e.notes || '', paste: '', pasteMsg: '', wasEstimated: !!e.gbp_estimated, original: e,
  };
}

// ---- itemised receipt: who had what (per person), with their share of service / VAT
const CUR_SYMBOL = { GBP: '£', EUR: '€', USD: '$' };
const curFmt = (n, cur) => (CUR_SYMBOL[cur] ? `${CUR_SYMBOL[cur]}${Number(n).toFixed(2)}` : `${Number(n).toFixed(2)} ${cur}`);
const joinNames = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const shareWord = (n) => (n === 2 ? 'half each' : n === 3 ? 'a third each' : n === 4 ? 'a quarter each' : `1/${n} each`);
function shareNote(piece, members) {
  if (piece.count <= 1) return '';
  const everyone = members.length > 1 && piece.count === members.length;
  return everyone ? `shared with everyone, ${shareWord(piece.count)}` : `shared with ${joinNames(piece.sharedWith)}, ${shareWord(piece.count)}`;
}

function formBreakdown(f) {
  const gbp = f.amount_gbp === '' ? null : Number(f.amount_gbp);
  const orig = f.orig_amount === '' ? null : Number(f.orig_amount);
  const rate = Number(f.rate) > 0 ? Number(f.rate) : Number(S.trip.default_rate);
  const est = gbp == null && orig && rate ? orig * rate : null;
  return itemisedBreakdown({
    items: f.items.filter((i) => i.description.trim() || i.amount !== '').map((i) => ({ description: i.description.trim() || 'Item', amount: Number(i.amount) || 0, names: i.names || [], in_local: orig > 0 })),
    amount_gbp: gbp ?? est ?? 0, orig_amount: orig > 0 ? orig : null, orig_currency: f.orig_currency, paid_by: f.paid_by, extras: f.extras,
  }, S.trip.members || []);
}

function itemSummaryHtml(f) {
  const bd = formBreakdown(f);
  if (bd.empty) return '';
  const members = S.trip.members || [];
  const cur = bd.cur;
  const poundsConfirmed = f.amount_gbp !== '';
  const extraName = bd.extraLabels.length ? bd.extraLabels.map((x) => x.label).join(' + ') : '';
  const warnings = [];
  if (bd.unassigned.length) warnings.push(f.claim_open ? `<b>${bd.unassigned.length} item${bd.unassigned.length === 1 ? ' is' : 's are'} left for friends to pick</b> (${esc(bd.unassigned.map((i) => i.description || 'Item').join(', '))}).` : `<b>${bd.unassigned.length} item${bd.unassigned.length === 1 ? ' has' : 's have'} nobody</b> (${esc(bd.unassigned.map((i) => i.description || 'Item').join(', '))}) - tap an item's names below to fix.`);
  const cbFactor = (() => { if (!f.cashback_on) return 0; const bill = Number(f.amount_gbp) || 0; const pct = Number(f.cashback_pct) || 0; if (!(bill > 0 && pct > 0)) return 0; const card = Number(f.gift_card) > 0 ? Number(f.gift_card) : bill; return (Math.round(card * pct) / 100) / bill; })();
  if (bd.over) warnings.push(`The items add up to <b>${curFmt(bd.itemsSum, cur)}</b>, which is more than the bill of <b>${curFmt(bd.total, cur)}</b>.`);
  const cards = bd.people.map((p) => {
    const open = !(f.collapsed || []).includes(p.name);
    const gbp = bd.gbpByName && bd.local ? bd.gbpByName[p.name] : null;
    const gbpText = gbp != null ? ` · ${poundsConfirmed ? '' : '≈ '}£${gbp.toFixed(2)}` : '';
    return `<div class="pcard">
      <button type="button" class="phead" data-act="togglePerson" data-name="${esc(p.name)}"><b>${esc(p.name === S.me ? `${p.name} (you)` : p.name)}</b><span class="num">${curFmt(p.total, cur)}${gbpText} <i class="ti ti-chevron-${open ? 'up' : 'down'}" aria-hidden="true"></i></span></button>
      ${open ? `<div class="plines">
        ${p.pieces.map((pc) => `<div class="row between"><span class="grow">${esc(pc.description)}${pc.was ? `<small>original price ${curFmt(pc.was, cur)}${pc.count > 1 ? ' (whole item)' : ''}</small>` : ''}${pc.count > 1 ? `<small>${esc(shareNote(pc, members))}</small>` : ''}</span><span class="num">${curFmt(pc.amount, cur)}</span></div>`).join('')}
        <div class="row between sum"><span>Items</span><span class="num">${curFmt(p.subtotal, cur)}</span></div>
        ${p.extra > 0 ? `<div class="row between"><span>${esc(extraName || 'Service, VAT and other')} (your share)</span><span class="num">+ ${curFmt(p.extra, cur)}</span></div>` : ''}
        <div class="row between sum"><b>Total</b><b class="num">${curFmt(p.total, cur)}${gbpText}</b></div>
        ${cbFactor && cur === 'GBP' ? `<div class="row between"><span>Cashback (your share)</span><span class="num">- ${curFmt(p.total * cbFactor, cur)}</span></div><div class="row between sum"><b>To pay after cashback</b><b class="num">${curFmt(p.total * (1 - cbFactor), cur)}</b></div>` : ''}
      </div>` : ''}</div>`;
  }).join('');
  const check = bd.over || bd.unassigned.length ? '' : `<p class="muted" style="margin:6px 0 0">Bill ${curFmt(bd.total, cur)} = items ${curFmt(bd.itemsSum, cur)}${bd.extras > 0 ? ` + ${bd.extraLabels.map((x) => `${esc(x.label.toLowerCase())} ${curFmt(x.amount, cur)}`).join(' + ')} (about ${bd.extrasPct}% on top, shared in proportion)` : ''}. ${bd.balanced ? 'Everything is shared out.' : ''}</p>`;
  return `<h2 style="margin-top:14px">Who had what</h2>
    ${warnings.length ? `<div class="alert">${warnings.join('<br>')}</div>` : ''}
    ${bd.saved > 0 ? `<p class="muted" style="margin:6px 0 0">Original prices add up to ${curFmt(bd.itemsSum + bd.saved, cur)}; discounts saved ${curFmt(bd.saved, cur)}.</p>` : ''}
    ${cards}${check}`;
}

function formView() {
  const f = S.form; const t = S.trip; const members = t.members || [];
  const items = f.split_type === 'items';
  const unit = f.split_type === 'exact' ? '£' : f.split_type === 'percent' ? '%' : f.split_type === 'shares' ? 'shares' : '';
  const itemCur = Number(f.orig_amount) > 0 ? f.orig_currency : 'GBP';
  const bd = items ? formBreakdown(f) : null;
  const hasItems = f.items.some((i) => i.description.trim() || i.amount !== '');
  const editorOpen = items && (f.editItems || !hasItems || !!(bd && ((bd.unassigned?.length && !f.claim_open) || bd.over)));
  return `
    <div class="topbar"><button class="ghost" data-act="cancelForm">← Cancel</button></div>
    <h1>${f.uid ? 'Edit expense' : 'Add expense'}</h1>
    <label>What was it?</label>
    <input id="f_description" value="${esc(f.description)}" placeholder="e.g. Pizza dinner" autocomplete="off">
    <label>Date</label>
    <input id="f_expense_date" type="date" value="${esc(f.expense_date)}">
    <label>Category</label>
    <div class="cats">${CATEGORIES.map((c) => `<button type="button" class="catbtn ${f.category === c.name ? 'on' : ''}" data-act="pickCat" data-name="${esc(c.name)}"><span class="ctile"><i class="ti ti-${c.icon}" aria-hidden="true"></i></span>${esc(c.name)}</button>`).join('')}</div>
    ${f.category && !CATEGORIES.some((c) => c.name === f.category) ? `<p class="muted">Old category: ${esc(f.category)} - pick one above to change it.</p>` : ''}
    ${(CATEGORIES.find((c) => c.name === f.category)?.subs || []).length ? `<p class="muted" style="margin:10px 0 6px">${esc(f.category)} - what was it?</p><div class="chips">${CATEGORIES.find((c) => c.name === f.category).subs.map(([n, ic]) => `<button type="button" class="chip ${f.subtype === n ? 'on' : ''}" data-act="pickSub" data-name="${esc(n)}"><i class="ti ti-${ic}" aria-hidden="true"></i>${esc(n)}</button>`).join('')}</div>` : ''}
    ${isTab() ? `<label>Amount (£)</label>
    <input id="f_amount_gbp" inputmode="decimal" value="${esc(f.amount_gbp)}" placeholder="0.00">` : `<label>Amount in pounds (£) - leave empty if you only know the ${esc(t.currency)} amount</label>
    <input id="f_amount_gbp" inputmode="decimal" value="${esc(f.amount_gbp)}" placeholder="0.00">
    <label>Amount in ${esc(f.orig_currency)} (optional)</label>
    <input id="f_orig_amount" inputmode="decimal" value="${esc(f.orig_amount)}" placeholder="0.00">
    <div id="estHint"></div>`}
    <div class="card" style="margin-top:12px"><button type="button" class="chip ${f.cashback_on ? 'on' : ''}" data-act="toggleCashback"><i class="ti ti-gift" aria-hidden="true"></i> Paid with a gift card that gives cashback</button>
      ${f.cashback_on ? `<div class="row"><div class="grow"><label>Gift card amount (£)</label><input id="f_gift_card" inputmode="decimal" value="${esc(f.gift_card)}" placeholder="same as the bill"></div>
        <div class="grow"><label>Cashback %</label><input id="f_cashback_pct" inputmode="decimal" value="${esc(f.cashback_pct)}" placeholder="e.g. 5"></div></div>
        <p class="muted" style="margin:6px 0 0">Cashback only counts on the gift card part. Everyone's share goes down by the same proportion.</p>` : ''}
      <div id="cbHint" class="sub" style="margin:6px 0 0"></div></div>
    <label>Who paid?</label>
    <select id="f_paid_by">${members.map((m) => `<option ${m === f.paid_by ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <label>How is it split?</label>
    <div class="seg">${Object.entries(SPLIT_LABELS).map(([k, v]) => `<button type="button" class="${f.split_type === k ? 'on' : ''}" data-act="splitType" data-type="${k}">${v}</button>`).join('')}</div>
    ${items ? `
      <div class="card"><label style="margin-top:0">Got a receipt block from Claude? Paste it here</label>
      <textarea id="f_paste" placeholder="Paste what Claude gave you">${esc(f.paste)}</textarea>
      <div style="height:8px"></div><button type="button" class="secondary" data-act="usePaste">Fill in the items</button>
      ${f.pasteMsg ? `<p class="sub">${esc(f.pasteMsg)}</p>` : ''}</div>
      <button type="button" class="chip ${f.claim_open ? 'on' : ''}" data-act="toggleClaim" style="margin:10px 0 2px"><i class="ti ti-users" aria-hidden="true"></i> Let friends pick their own items</button>
      <p class="muted" style="margin:4px 0 0">${f.claim_open ? 'On: items nobody is named on wait for friends to tick them in the app (counted against whoever paid until then).' : 'Off: every item needs someone on it.'}</p>
      ${f.uid ? '<button type="button" class="secondary" style="margin-top:8px" data-act="claimFromForm">Pick what I had</button>' : ''}
      <div id="itemsum">${itemSummaryHtml(f)}</div>
      ${editorOpen ? `<p class="sub" style="margin-top:10px">Add each item and tap who had it. Service charge, VAT or tip that the items don't cover is shared in proportion to what each person had. Skipped the service? Make the bill match the items. Item amounts are in <b>${esc(itemCur === 'GBP' ? '£' : itemCur)}</b>.</p>
      ${f.items.map((it, i) => `<div class="item">
        <div class="row"><input data-item="${i}" data-field="description" value="${esc(it.description)}" placeholder="Item"><button type="button" class="danger" data-act="removeItem" data-i="${i}">✕</button></div>
        <div class="row" style="margin-top:6px"><div class="grow"><span class="lbl">Price paid (£)</span><input data-item="${i}" data-field="amount" inputmode="decimal" value="${esc(it.amount)}" placeholder="0.00"></div>
          <div class="grow"><span class="lbl">Original price (£)</span><input data-item="${i}" data-field="was" inputmode="decimal" value="${esc(it.was ?? '')}" placeholder="if discounted"></div></div>
        <div class="chips" style="margin-top:8px">${members.map((m) => `<button type="button" class="chip ${(it.names || []).includes(m) ? 'on' : ''}" data-act="itemWho" data-i="${i}" data-name="${esc(m)}">${esc(m)}</button>`).join('')}</div></div>`).join('')}
      <button type="button" class="secondary" data-act="addItem">+ Add item</button>
      <div id="itemsHint" class="sub" style="margin-top:8px"></div>
      ${f.editItems && hasItems && !(bd && ((bd.unassigned?.length && !f.claim_open) || bd.over)) ? '<button type="button" class="secondary full" data-act="toggleEditor">Done editing</button>' : ''}`
      : `<button type="button" class="secondary full" data-act="toggleEditor">Edit individual items (${f.items.filter((i) => i.description.trim() || i.amount !== '').length})</button>`}`
    : `
      <div class="row between" style="margin-top:10px"><p class="muted" style="margin:0">Who is it split between?</p>
        <span class="row"><button type="button" class="chip" data-act="preset" data-p="all">Everyone</button><button type="button" class="chip" data-act="preset" data-p="me">Only me</button></span></div>
      ${members.map((m) => `<div class="row"><label class="check grow"><input type="checkbox" data-who="${esc(m)}" ${f.participants[m]?.on ? 'checked' : ''}> ${esc(m)}</label>
        ${f.split_type !== 'equal' && f.participants[m]?.on ? `<input data-val="${esc(m)}" inputmode="decimal" value="${esc(f.participants[m].value)}" style="max-width:110px" placeholder="${unit}"><span class="muted">${unit}</span>` : ''}</div>`).join('')}
      ${f.split_type === 'equal' ? '<p class="muted">Any spare penny goes to whoever paid.</p>' : ''}`}
    <label>Notes (optional)</label>
    <input id="f_notes" value="${esc(f.notes)}">
    ${f.uid && f.wasEstimated && f.paid_by !== S.me ? `<div class="alert">This amount is an estimate. Only ${esc(f.paid_by)} knows the real pounds - ask them, then type it in above.</div>` : ''}
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
    <div style="height:14px"></div>
    <button class="full" data-act="saveExpense">${f.uid ? 'Save changes' : 'Add expense'}</button>
    ${f.uid ? '<div style="height:8px"></div><button class="danger full" data-act="deleteExpense">Delete this expense</button>' : ''}`;
}

function updateHints() {
  const f = S.form; if (!f) return;
  if (f.split_type === 'items') { const box = document.getElementById('itemsum'); if (box) box.innerHTML = itemSummaryHtml(f); }
  const t = S.trip;
  const gbp = f.amount_gbp === '' ? null : Number(f.amount_gbp);
  const orig = f.orig_amount === '' ? null : Number(f.orig_amount);
  const rate = Number(f.rate) > 0 ? Number(f.rate) : Number(t.default_rate);
  const est = document.getElementById('estHint');
  if (est) est.innerHTML = gbp == null && orig && rate ? `<div class="alert">About ${money(orig * rate)} (estimate). It will be marked "estimated" until the person who paid gives you the real pounds.</div>` : '';
  const cbBox = document.getElementById('cbHint');
  if (cbBox) {
    const bill = gbp || 0; const pct = Number(f.cashback_pct) || 0;
    const card = Number(f.gift_card) > 0 ? Number(f.gift_card) : bill;
    const c = Math.round(card * pct) / 100;
    cbBox.textContent = f.cashback_on ? (bill > 0 && pct > 0 ? `Bill £${bill.toFixed(2)} · cashback £${c.toFixed(2)} (${pct}% of £${card.toFixed(2)}) · shared between everyone £${(bill - c).toFixed(2)}` : 'Enter the bill in pounds and the cashback % to see the shared amount.') : '';
  }
  const ih = document.getElementById('itemsHint');
  if (ih) {
    const sum = f.items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    const total = Number(orig) > 0 ? orig : (gbp || 0);
    const cur = Number(orig) > 0 ? f.orig_currency : '£';
    const extra = Math.max(0, total - sum);
    const unreadable = f.items.filter((it) => it.amount !== '' && !Number.isFinite(Number(it.amount))).length;
    ih.textContent = `${unreadable ? `${unreadable} amount${unreadable === 1 ? '' : 's'} can't be read - use digits only, like 6.50. ` : ''}Items ${sum.toFixed(2)} · Bill ${total.toFixed(2)} ${cur === '£' ? '' : cur} · Extras shared in proportion ${extra.toFixed(2)}${sum > total + 0.005 ? ' - items add up to more than the bill!' : ''}`;
  }
}

function payloadFromForm() {
  const f = S.form; const t = S.trip;
  if (!f.description.trim()) throw new Error('Say what it was.');
  const amounts = resolveAmounts(t, f);
  const e = {
    uid: f.uid || newUid(),
    description: f.description.trim(),
    expense_date: f.expense_date || null,
    category: f.category || null,
    subtype: f.category && f.subtype ? f.subtype : null,
    paid_by: f.paid_by,
    ...amounts,
    split_type: f.split_type,
    notes: f.notes.trim() || null,
    updated_at: new Date().toISOString(),
    updated_by: S.me,
  };
  if (f.cashback_on && Number(f.cashback_pct) > 0) {
    const card = Number(f.gift_card) > 0 ? Number(f.gift_card) : amounts.amount_gbp;
    if (card > amounts.amount_gbp + 0.005) throw new Error("The gift card amount can't be more than the bill.");
    e.gift_card_gbp = Math.round(card * 100) / 100;
    e.cashback_pct = Number(f.cashback_pct);
    e.cashback_gbp = Math.round(card * Number(f.cashback_pct)) / 100;
  } else { e.gift_card_gbp = null; e.cashback_pct = null; e.cashback_gbp = null; }
  e.claims = null; // everyone's picks are folded into the items when you save
  e.claim_open = f.split_type === 'items' && !!f.claim_open;
  if (f.split_type === 'items') {
    const local = amounts.orig_amount > 0;
    e.items = f.items.filter((i) => i.description.trim() || i.amount !== '').map((i) => ({
      description: i.description.trim(), amount: Number(i.amount), names: i.names || [], ...(Number(i.was) > Number(i.amount) ? { was: Number(i.was) } : {}), ...(local ? { in_local: true } : {}),
    }));
    if (e.items.some((i) => !(i.amount >= 0))) throw new Error('Every item needs an amount.');
    e.extras = f.extras && f.extras.length ? f.extras.map((x) => ({ label: x.label, amount: Number(x.amount) })) : null;
    e.participants = [];
  } else {
    e.participants = Object.entries(f.participants).filter(([, p]) => p.on).map(([name, p]) => ({
      name, value: f.split_type === 'equal' || p.value === '' ? null : Number(p.value),
    }));
    e.items = null;
    e.extras = null;
  }
  return e;
}

async function saveExpense() {
  S.error = '';
  try {
    const e = payloadFromForm();
    expenseSharesPence({ ...e }); // throws a plain message if the split doesn't add up
    const isNew = !S.form.uid;
    if (isNew) {
      e.created_at = e.updated_at;
      const dup = findDuplicate(S.expenses, e);
      if (dup && !confirm(`"${dup.description}" on the same day for the same amount is already here. Add this one anyway?`)) { render(); return; }
    } else if (S.form.original?.created_at) e.created_at = S.form.original.created_at;
    fireAndForget(setDoc(tripRef('expenses', e.uid), clean(e)));
    if (isNew) logActivity(activityLine('added', S.me, `"${e.description}"`, money(e.amount_gbp)), 'added');
    else {
      const changes = describeChange(S.form.original, e);
      if (changes.length) logActivity(activityLine('edited', S.me, `"${S.form.original.description}"`, changes.join(', ')), 'edited');
    }
    patchStore((s) => { s.defaults[S.code] = { split_type: e.split_type, who: e.participants.map((p) => p.name) }; });
    // on a running tab, jump to the month the expense belongs to so it is visible straight away
    if (isTab() && e.expense_date) S.month = e.expense_date.slice(0, 7);
    S.form = null; S.view = 'trip';
  } catch (err) {
    S.error = err.message;
  }
  render();
}

// ---------------------------------------------------------------- payments
function blankPay(from, to, amt, code, back) {
  return { id: null, from: from || '', to: to || '', amount: amt || '', date: todayIso(), note: '', code: code || S.code, back: back || 'trip' };
}
function payView() {
  const p = S.pay;
  const members = p.code === S.code ? (S.trip.members || []) : (S.combo?.data[p.code]?.trip.members || []);
  return `
    <div class="topbar"><button class="ghost" data-act="cancelPay">← Cancel</button></div>
    <h1>${p.id ? 'Edit payment' : 'Record a payment'}</h1>
    <p class="sub">Money that really moved between two people - any amount, on the day it happened. Always in pounds.</p>
    <label>Who paid?</label>
    <select data-f="pay" data-k="from"><option value="">Choose…</option>${members.map((m) => `<option ${m === p.from ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <label>Who received it?</label>
    <select data-f="pay" data-k="to"><option value="">Choose…</option>${members.map((m) => `<option ${m === p.to ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <label>Amount (£)</label><input data-f="pay" data-k="amount" inputmode="decimal" value="${esc(p.amount)}" placeholder="0.00">
    <label>Date</label><input type="date" data-f="pay" data-k="date" value="${esc(p.date)}">
    <label>Note (optional)</label><input data-f="pay" data-k="note" value="${esc(p.note)}" placeholder="e.g. bank transfer">
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
    <div style="height:14px"></div>
    <button class="full" data-act="savePay">${p.id ? 'Save changes' : 'Save payment'}</button>
    ${p.id ? '<div style="height:8px"></div><button class="danger full" data-act="deletePay">Delete this payment</button>' : ''}`;
}
function savePay() {
  const p = S.pay; S.error = '';
  const amount = Math.round(Number(p.amount) * 100) / 100;
  if (!p.from || !p.to) { S.error = 'Choose who paid and who received it.'; render(); return; }
  if (p.from === p.to) { S.error = 'Choose two different people.'; render(); return; }
  if (!(amount > 0)) { S.error = 'Enter the amount in pounds.'; render(); return; }
  const by = readStore().trips[p.code]?.me || S.me;
  const existing = p.id ? (S.settlements.find((s) => s.uid === p.id) || {}) : {};
  const uid = p.id || newUid();
  // On a running tab a payment only counts once the person it went to has said they got it (if that's me, it counts straight away).
  const status = isTab() && p.code === S.code ? (p.to === by ? 'confirmed' : 'claimed') : undefined;
  fireAndForget(setDoc(refFor(p.code, 'settlements', uid), clean({
    from: p.from, to: p.to, amount_gbp: amount, settle_date: p.date || null, notes: p.note.trim() || null,
    created_at: existing.created_at || new Date().toISOString(), by, ...(status ? { status } : {}),
  })));
  logActivity(activityLine('payment', by, `${p.from} paid ${p.to} ${money(amount)}${p.id ? ' (edited)' : ''}`), 'payment', p.code, by);
  const back = p.back; S.pay = null;
  if (back === 'combo') { S.view = 'combo'; loadCombo(); } else S.view = 'trip';
  render();
}

// ---------------------------------------------------------------- edit trip
function editFromTrip() {
  const t = S.trip;
  if (isTab()) return { name: t.name || '', theme: themeState(t.theme) };
  return {
    name: t.name || '', destination: t.destination || '', start_date: t.start_date || '', end_date: t.end_date || '',
    currency: t.currency || 'EUR', default_rate: t.default_rate ?? '', budget_gbp: t.budget_gbp ?? '', theme: themeState(t.theme),
  };
}
function editView() {
  return `
    <div class="topbar"><button class="ghost" data-act="back">← Cancel</button></div>
    <h1>${isTab() ? 'Edit tab' : 'Edit trip'}</h1>
    ${isTab() ? `<label>Name of the tab</label><input data-f="edit" data-k="name" value="${esc(S.edit.name)}">${themePicker('edit')}` : tripFields('edit')}
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
    <div style="height:14px"></div>
    <button class="full" data-act="saveEdit">Save</button>`;
}
function saveEdit() {
  const x = S.edit; S.error = '';
  if (!x.name.trim()) { S.error = `Give the ${noun()} a name.`; render(); return; }
  if (isTab()) {
    fireAndForget(setDoc(tripRef(), clean({ name: x.name.trim(), theme: themeValue(x.theme) }), { merge: true }));
    logActivity(activityLine('trip', S.me, 'changed the tab details'), 'trip');
    S.edit = null; S.view = 'trip'; S.tab = 'more'; render(); return;
  }
  const rate = Number(x.default_rate) > 0 ? Number(x.default_rate) : null;
  const upd = {
    name: x.name.trim(), destination: x.destination.trim() || null, start_date: x.start_date || null, end_date: x.end_date || null,
    currency: (x.currency || 'EUR').trim().toUpperCase().slice(0, 5), default_rate: rate,
    budget_gbp: Number(x.budget_gbp) > 0 ? Number(x.budget_gbp) : null, theme: themeValue(x.theme),
  };
  const rateChanged = rate !== (S.trip.default_rate ?? null);
  const estimated = S.expenses.filter((e) => e.gbp_estimated && e.orig_amount > 0);
  const batch = writeBatch(db);
  batch.set(tripRef(), clean(upd), { merge: true });
  if (rateChanged && rate && estimated.length && confirm(`Re-estimate the ${estimated.length} expense${estimated.length === 1 ? '' : 's'} still marked as estimated with the new rate? Confirmed pounds never change.`)) {
    const now = new Date().toISOString();
    estimated.forEach((e) => {
      const { uid, ...rest } = e;
      batch.set(tripRef('expenses', uid), clean({ ...rest, rate, amount_gbp: Math.round(e.orig_amount * rate * 100) / 100, updated_at: now }));
    });
  }
  fireAndForget(batch.commit());
  logActivity(activityLine('trip', S.me, 'changed the trip details'), 'trip');
  S.edit = null; S.view = 'trip'; S.tab = 'more';
  render();
}

// ---------------------------------------------------------------- new trip
const blankNew = () => ({ me: '', friends: '', name: '', destination: '', start_date: '', end_date: '', currency: 'EUR', default_rate: '', budget_gbp: '', theme: themeState('classic') });

async function ownerFields() {
  const token = `${newUid()}${newCode()}`;
  return { token, hash: await sha256Hex(token) };
}

async function createFromFile(file) {
  S.error = '';
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'finance-tracker-trip' || !data.trip) throw new Error('That isn\'t a trip file from the desktop app.');
    const code = newCode();
    const t = data.trip;
    const owner = await ownerFields();
    const members = Array.from(new Set([...(data.members || []), t.my_name].filter(Boolean)));
    const batch = writeBatch(db);
    batch.set(doc(db, 'trips', code), clean({
      uid: t.uid, name: t.name, destination: t.destination || null, start_date: t.start_date || null, end_date: t.end_date || null,
      status: t.status || 'Planning', currency: t.currency || 'EUR', default_rate: t.default_rate || null, notes: t.notes || null,
      budget_gbp: t.budget_gbp || null, theme: t.theme || null,
      my_name: t.my_name || null, members, member_ids: data.member_ids || {}, owner_hash: owner.hash, created_at: new Date().toISOString(),
    }));
    (data.expenses || []).forEach((e) => batch.set(doc(db, 'trips', code, 'expenses', e.uid || newUid()), clean(e)));
    (data.settlements || []).forEach((s) => batch.set(doc(db, 'trips', code, 'settlements', s.uid || newUid()), clean(s)));
    fireAndForget(batch.commit());
    chooseMeAndOpen(code, t.my_name, owner.token);
  } catch (err) {
    S.error = err.message || String(err);
    render();
  }
}

async function createBlank() {
  const x = S.nt; S.error = '';
  if (!x.name.trim() || !x.me.trim()) { S.error = 'Give the trip a name and say who you are.'; render(); return; }
  const me = x.me.trim();
  const friends = x.friends.split(',').map((n) => n.trim()).filter(Boolean);
  const members = Array.from(new Set([me, ...friends]));
  const code = newCode();
  const owner = await ownerFields();
  fireAndForget(setDoc(doc(db, 'trips', code), clean({
    uid: newUid(), name: x.name.trim(), destination: x.destination.trim() || null, start_date: x.start_date || null, end_date: x.end_date || null,
    status: 'Planning', currency: (x.currency || 'EUR').trim().toUpperCase().slice(0, 5),
    default_rate: Number(x.default_rate) > 0 ? Number(x.default_rate) : null, budget_gbp: Number(x.budget_gbp) > 0 ? Number(x.budget_gbp) : null,
    theme: themeValue(x.theme), notes: null, my_name: me, members, member_ids: Object.fromEntries(members.map((n) => [n, newUid()])), owner_hash: owner.hash, created_at: new Date().toISOString(),
  })));
  chooseMeAndOpen(code, me, owner.token);
}

async function createTab() {
  const x = S.nt; S.error = '';
  if (!x.name.trim() || !x.me.trim()) { S.error = 'Give the tab a name and say who you are.'; render(); return; }
  const me = x.me.trim();
  const friends = x.friends.split(',').map((n) => n.trim()).filter(Boolean);
  const members = Array.from(new Set([me, ...friends]));
  const code = newCode();
  const owner = await ownerFields();
  fireAndForget(setDoc(doc(db, 'trips', code), clean({
    uid: newUid(), kind: 'tab', name: x.name.trim(), destination: null, start_date: null, end_date: null, status: 'Open', currency: 'GBP',
    default_rate: null, budget_gbp: null, theme: themeValue(x.theme), notes: null, my_name: me, members,
    member_ids: Object.fromEntries(members.map((n) => [n, newUid()])), owner_hash: owner.hash, created_at: new Date().toISOString(),
  })));
  patchStore((st) => { st.trips[code] = { ...(st.trips[code] || {}), name: x.name.trim(), kind: 'tab' }; });
  chooseMeAndOpen(code, me, owner.token);
}

function chooseMeAndOpen(code, me, token) {
  patchStore((s) => { s.trips[code] = { ...(s.trips[code] || {}), me: me || null, owner_token: token || undefined }; });
  location.hash = `t=${code}`;
}

function setMe(name) {
  patchStore((s) => { s.trips[S.code] = { ...(s.trips[S.code] || {}), me: name }; });
  S.me = name; S.view = 'trip'; S.tab = 'expenses'; S.error = '';
  if (S.draft && S.trip) { applyDraft(); return; }
  render();
}

// ---------------------------------------------------------------- rename / delete / export
async function renamePerson(oldName, newName) {
  if ((S.trip.members || []).some((m) => m.toLowerCase() === newName.toLowerCase() && m !== oldName)) {
    S.notice = `${newName} is already on this trip.`; render(); return;
  }
  const sw = (n) => (n === oldName ? newName : n);
  const now = new Date().toISOString();
  const batch = writeBatch(db);
  batch.set(tripRef(), { members: (S.trip.members || []).map(sw), ...(S.trip.my_name === oldName ? { my_name: newName } : {}) }, { merge: true });
  // the person keeps their hidden id under the new name
  const ids = { ...(S.trip.member_ids || {}) };
  if (ids[oldName]) { ids[newName] = ids[oldName]; delete ids[oldName]; }
  batch.update(tripRef(), { member_ids: ids });
  S.expenses.forEach((e) => {
    const touches = e.paid_by === oldName || (e.participants || []).some((p) => p.name === oldName) || (e.items || []).some((i) => (i.names || []).includes(oldName)) || Object.prototype.hasOwnProperty.call(e.claims || {}, oldName);
    if (!touches) return;
    const { uid, ...rest } = e;
    batch.set(tripRef('expenses', uid), clean({
      ...rest, paid_by: sw(e.paid_by), updated_at: now,
      participants: (e.participants || []).map((p) => ({ ...p, name: sw(p.name) })),
      items: e.items ? e.items.map((i) => ({ ...i, names: (i.names || []).map(sw) })) : null,
      claims: e.claims ? Object.fromEntries(Object.entries(e.claims).map(([n, v]) => [sw(n), v])) : null,
    }));
  });
  S.settlements.forEach((s) => {
    if (s.from !== oldName && s.to !== oldName) return;
    const { uid, ...rest } = s;
    batch.set(tripRef('settlements', uid), clean({ ...rest, from: sw(s.from), to: sw(s.to) }));
  });
  fireAndForget(batch.commit());
  logActivity(activityLine('renamed', S.me, `renamed ${oldName} to ${newName}`), 'renamed');
  if (S.me === oldName) { patchStore((s) => { s.trips[S.code] = { ...(s.trips[S.code] || {}), me: newName }; }); S.me = newName; }
  S.notice = `Renamed ${oldName} to ${newName}.`;
  render();
}

async function exportFile() {
  const file = buildTripFile({ ...S.trip }, S.expenses, S.settlements, S.deleted);
  const name = `${(S.trip.name || 'trip').replace(/[^\w\- ]+/g, '').trim() || 'trip'}.trip.json`;
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const f = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: name }); return true; } catch (err) { if (err.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  S.notice = `Saved ${name}`; render();
  return true;
}

async function deleteEverything(code) {
  const batches = [];
  for (const sub of ['expenses', 'settlements', 'deleted', 'activity', 'adjustments', 'notes']) {
    const snap = await getDocs(collection(db, 'trips', code, sub));
    let b = writeBatch(db); let n = 0;
    snap.docs.forEach((d) => { b.delete(d.ref); n += 1; if (n === 400) { batches.push(b); b = writeBatch(db); n = 0; } });
    if (n) batches.push(b);
  }
  for (const b of batches) await b.commit();
  await deleteDoc(doc(db, 'trips', code));
}

async function deleteTrip() {
  if (!navigator.onLine) { S.notice = 'You need to be online to delete a trip.'; render(); return; }
  if (confirm('Save a backup trip file first? (Recommended)')) { const ok = await exportFile(); if (ok === false) return; }
  const typed = (prompt(`This deletes "${S.trip.name}" for everyone, for good.\n\nType the trip name to confirm:`) || '').trim();
  if (typed.toLowerCase() !== String(S.trip.name).trim().toLowerCase()) { S.notice = 'Name didn\'t match - nothing was deleted.'; render(); return; }
  const code = S.code;
  try {
    await deleteEverything(code);
    patchStore((s) => { delete s.trips[code]; });
    location.hash = ''; S.view = 'home'; leaveTrip();
    S.notice = '';
  } catch (err) {
    S.notice = `Couldn't delete: ${err.message}`;
  }
  render();
}

async function claimOwner() {
  if (S.trip.owner_hash) { S.notice = 'This trip already has a creator.'; render(); return; }
  const owner = await ownerFields();
  patchStore((s) => { s.trips[S.code] = { ...(s.trips[S.code] || {}), owner_token: owner.token }; });
  fireAndForget(setDoc(tripRef(), { owner_hash: owner.hash }, { merge: true }));
  S.notice = 'You are now the creator of this trip.';
  render();
}

// ---------------------------------------------------------------- settle one trip into another
function carryBanner(all) {
  const out = S.adjustments.find((a) => a.kind === 'out');
  if (!out) return '';
  const stillOwed = all.people.some((p) => Math.abs(p.net) > 0.005);
  return `<div class="alert" style="background:var(--accent-soft);color:var(--ink)"><b>Settled into ${esc(out.other_name)}</b> on ${esc(fmtShort(out.date))}. Who owes what now lives there.${stillOwed ? ' <b>Something changed here since then</b> - undo the carry-over (tap it in the log) and do it again.' : ''}</div>`;
}

function carryView() {
  const c = S.carry;
  const others = Object.entries(readStore().trips).filter(([code, t]) => code !== S.code && t.kind !== 'tab');
  if (c.step === 'pick') {
    return `
      <div class="topbar"><button class="ghost" data-act="carryBack">← Back</button></div>
      <h1>Settle this trip into another</h1>
      <p class="sub">"${esc(S.trip.name)}" becomes settled - everyone shows as all square. Who owes whom moves to the trip you pick, so that trip shows the real, current situation. Neither trip's costs change.</p>
      ${others.length === 0 ? '<p class="sub">You need another trip on this phone first.</p>' : others.map(([code, t]) => `<button class="ex" data-act="carryPick" data-code="${esc(code)}"><div class="mid"><p class="t">${esc(t.name || code)}</p><p class="s">Move the balances here</p></div></button>`).join('')}
      ${c.error ? `<p class="error">${esc(c.error)}</p>` : ''}`;
  }
  if (!c.loaded) return '<p class="loading">Loading…</p>';
  const r = c.result;
  return `
    <div class="topbar"><button class="ghost" data-act="carryBack">← Choose another trip</button></div>
    <h1>Check before you confirm</h1>
    <p class="sub"><b>${esc(S.trip.name)}</b> → <b>${esc(c.target.trip.name)}</b></p>
    ${r.empty ? '<p class="sub">Nobody owes anything on this trip, so there is nothing to move.</p>' : `
    <h2>${esc(S.trip.name)} afterwards</h2>
    <p class="sub">Everyone all square. These amounts move out:</p>
    ${r.outItems.map((i) => `<div class="row between muted"><span>${esc(i.name)}</span><span class="num">${esc(bal(-i.amount))}</span></div>`).join('')}
    <h2>${esc(c.target.trip.name)} afterwards</h2>
    ${r.preview.map((p) => `<div class="card"><b>${esc(p.name)}</b><div class="row between"><span class="muted num">${esc(bal(p.before))}</span><span>→</span><b class="num">${esc(bal(p.after))}</b></div></div>`).join('')}
    ${r.newMembers.length ? `<p class="muted">New to ${esc(c.target.trip.name)}, and added: ${esc(r.newMembers.join(', '))}</p>` : ''}
    <p class="sub">You can undo this later by tapping the "balance carried over" line in the log.</p>
    <button class="full" data-act="carryGo">Settle ${esc(S.trip.name)} into ${esc(c.target.trip.name)}</button>`}
    ${c.error ? `<p class="error">${esc(c.error)}</p>` : ''}`;
}
const bal = (n) => (Math.abs(n) < 0.005 ? 'All square' : n > 0 ? `is owed ${money(n)}` : `owes ${money(-n)}`);

async function loadCarryTarget(code) {
  const c = S.carry; c.loaded = false; c.error = ''; c.targetCode = code; render();
  try {
    const [t, e, s, j] = await Promise.all([getDoc(doc(db, 'trips', code)), getDocs(collection(db, 'trips', code, 'expenses')), getDocs(collection(db, 'trips', code, 'settlements')), getDocs(collection(db, 'trips', code, 'adjustments'))]);
    if (!t.exists || (typeof t.exists === 'function' && !t.exists())) throw new Error('That trip can\'t be found.');
    c.target = { trip: t.data(), expenses: e.docs.map((d) => ({ ...d.data(), uid: d.id })), settlements: s.docs.map((d) => ({ ...d.data(), uid: d.id })), adjustments: j.docs.map((d) => ({ ...d.data(), uid: d.id })) };
    c.result = buildCarryOver({ trip: S.trip, expenses: S.expenses, settlements: S.settlements, adjustments: S.adjustments }, c.target, readStore().nameMap);
    c.step = 'preview';
  } catch (err) { c.error = `Couldn't load: ${err.message}`; c.step = 'pick'; }
  c.loaded = true; render();
}

function doCarry() {
  const c = S.carry; const r = c.result;
  if (r.empty) return;
  const id = newUid(); const now = new Date().toISOString(); const date = todayIso();
  const batch = writeBatch(db);
  batch.set(refFor(S.code, 'adjustments', id), clean({ label: `Settled into ${c.target.trip.name}`, kind: 'out', other_code: c.targetCode, other_name: c.target.trip.name, date, created_at: now, by: S.me, items: r.outItems }));
  batch.set(refFor(c.targetCode, 'adjustments', id), clean({ label: `Balance carried over from ${S.trip.name}`, kind: 'in', other_code: S.code, other_name: S.trip.name, date, created_at: now, by: S.me, items: r.inItems }));
  if (r.newMembers.length) batch.set(refFor(c.targetCode), { members: arrayUnion(...r.newMembers) }, { merge: true });
  fireAndForget(batch.commit());
  logActivity(activityLine('carry', S.me, `settled this trip into ${c.target.trip.name}`), 'carry');
  logActivity(activityLine('carry', S.me, `carried over the balances from ${S.trip.name}`), 'carry', c.targetCode);
  S.carry = null; S.view = 'trip'; S.tab = 'balances';
  S.notice = `${S.trip.name} is settled. Its balances now live in ${c.target.trip.name}.`;
  render();
}

function adjView() {
  const a = S.adjView;
  return `
    <div class="topbar"><button class="ghost" data-act="back">← Back</button></div>
    <h1>${esc(a.label)}</h1>
    <p class="sub">${esc(fmtShort(a.date))} · Only changes who owes whom - it is not a cost, so no trip total changes.</p>
    ${(a.items || []).map((i) => `<div class="card row between"><b>${esc(i.name)}</b><span class="num ${i.amount >= 0 ? 'pos' : 'neg'}">${i.amount >= 0 ? 'is owed ' : 'owes '}${money(Math.abs(i.amount))}</span></div>`).join('')}
    <button class="danger full" data-act="undoAdj">Undo this (in both trips)</button>`;
}

function undoAdj() {
  const a = S.adjView;
  if (!confirm('Undo this? The balances go back to how they were in both trips.')) return;
  const batch = writeBatch(db);
  batch.delete(refFor(S.code, 'adjustments', a.uid));
  if (a.other_code) batch.delete(refFor(a.other_code, 'adjustments', a.uid));
  fireAndForget(batch.commit());
  logActivity(activityLine('carry', S.me, 'undid a balance carry-over'), 'carry');
  S.adjView = null; S.view = 'trip'; render();
}

// ---------------------------------------------------------------- combined settle-up
function comboView() {
  const c = S.combo;
  const store = readStore();
  const known = Object.entries(store.trips).filter(([, t]) => t.kind !== 'tab');
  if (c.step === 'pick') {
    return `
      <div class="topbar"><button class="ghost" data-act="comboBack">← Back</button></div>
      <h1>Settle several trips together</h1>
      <p class="sub">Tick the trips to combine. Each trip keeps its own costs - only the balances between people are added up.</p>
      ${known.map(([code, t]) => `<label class="check card"><input type="checkbox" data-combo="${esc(code)}" ${c.selected.includes(code) ? 'checked' : ''}> ${esc(t.name || code)}</label>`).join('')}
      ${c.error ? `<p class="error">${esc(c.error)}</p>` : ''}
      <button class="full" data-act="comboGo" ${c.selected.length < 2 ? 'disabled' : ''}>Combine ${c.selected.length} trips</button>`;
  }
  const list = c.selected.map((code) => ({ code, ...c.data[code] })).filter((x) => x.trip);
  if (!c.loaded) return '<p class="loading">Loading trips…</p>';
  const map = store.nameMap;
  const res = combineTrips(list, map);
  const allNames = [...new Set(list.flatMap((x) => (x.trip.members || []).map((m) => canonicalName(m, map))))];
  const unmatched = unmatchedNames(list, map);
  const primary = c.selected[0];
  return `
    <div class="topbar"><button class="ghost" data-act="comboPick">← Choose trips</button></div>
    <h1>Combined balances</h1>
    <p class="sub">${list.map((x) => esc(x.trip.name)).join(' + ')}</p>
    ${unmatched.length ? `<div class="alert"><b>Are these the same person?</b> These names are only in some of the trips. If one is a different spelling of another name, choose who it is.
      ${unmatched.map((n) => `<div class="row" style="margin-top:6px"><span class="grow">${esc(n)}</span><select data-map="${esc(n.toLowerCase())}"><option value="">a different person</option>${allNames.filter((x) => x !== n).map((o) => `<option value="${esc(o)}" ${map[n.toLowerCase()] === o ? 'selected' : ''}>same as ${esc(o)}</option>`).join('')}</select></div>`).join('')}</div>` : ''}
    <h2>Who owes what, overall</h2>
    ${res.people.map((p) => `<div class="card row between"><b>${esc(p.name)}</b><span class="${p.net > 0.004 ? 'pos' : p.net < -0.004 ? 'neg' : 'muted'} num">${Math.abs(p.net) < 0.005 ? 'All square' : p.net > 0 ? `Is owed ${money(p.net)}` : `Owes ${money(-p.net)}`}</span></div>`).join('')}
    <details class="card"><summary>Balance in each trip</summary>${res.perTrip.map((t) => `<p><b>${esc(t.name)}</b></p>${t.people.map((p) => `<div class="row between muted"><span>${esc(p.name)}</span><span class="num">${p.net >= 0 ? '+' : '-'}${money(Math.abs(p.net))}</span></div>`).join('')}`).join('')}</details>
    <h2>Who pays whom</h2>
    <p class="sub">A payment you record here is saved in "${esc(list[0]?.trip.name || '')}" with its own date and note, and counts towards the combined balances. It doesn't change any trip's costs.</p>
    ${res.transfers.length === 0 ? '<p class="sub">Everyone is all square.</p>' : res.transfers.map((t) => `<div class="card"><div class="row between"><span><b>${esc(t.from)}</b> pays <b>${esc(t.to)}</b></span><b class="num">${money(t.amount_gbp)}</b></div>
      <div style="height:8px"></div><button class="secondary" data-act="comboPay" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amt="${t.amount_gbp.toFixed(2)}" data-primary="${esc(primary)}">Record this payment</button></div>`).join('')}
    <button class="secondary" data-act="comboShare">Share who pays whom</button>`;
}

async function loadCombo() {
  const c = S.combo; c.loaded = false; c.error = '';
  render();
  try {
    for (const code of c.selected) {
      const [t, e, s, j] = await Promise.all([getDoc(doc(db, 'trips', code)), getDocs(collection(db, 'trips', code, 'expenses')), getDocs(collection(db, 'trips', code, 'settlements')), getDocs(collection(db, 'trips', code, 'adjustments'))]);
      if (!t.exists || (typeof t.exists === 'function' && !t.exists())) continue;
      c.data[code] = { trip: t.data(), expenses: e.docs.map((d) => ({ ...d.data(), uid: d.id })), settlements: s.docs.map((d) => ({ ...d.data(), uid: d.id })), adjustments: j.docs.map((d) => ({ ...d.data(), uid: d.id })) };
    }
  } catch (err) { c.error = `Couldn't load: ${err.message}`; }
  c.loaded = true; c.step = 'result';
  render();
}

// Fills the add-expense form from a receipt block (pasted, or carried by a tap-to-add link).
function fillFromBlock(f, text) {
  f.split_type = 'items';
  try {
    const r = parseReceiptBlock(text, S.trip.members || []);
    const filled = [];
    f.items = r.items.map((i) => ({ description: i.description, amount: i.amount, names: i.names, was: i.was ?? '' }));
    f.extras = r.extras || []; f.editItems = false; f.collapsed = [];
    filled.push(`${r.items.length} items`);
    if (r.extras.length) filled.push(r.extras.map((x) => x.label.toLowerCase()).join(' and '));
    const isLocal = r.currency && r.currency !== 'GBP';
    if (r.total != null) {
      if (isLocal) {
        if (f.orig_amount === '') { f.orig_amount = r.total; f.orig_currency = r.currency; filled.push(`the ${r.currency} amount`); }
      } else if (f.amount_gbp === '') { f.amount_gbp = r.paid_gbp ?? r.total; filled.push('the pounds'); }
    }
    if (isLocal && r.paid_gbp && f.amount_gbp === '') { f.amount_gbp = r.paid_gbp; filled.push('the pounds paid'); }
    if (r.place && !f.description.trim()) { f.description = r.place; filled.push('the place'); }
    if (r.date) { f.expense_date = r.date; filled.push('the date'); }
    if (r.category && !f.category) { f.category = r.category; f.subtype = r.subtype || ''; filled.push('the category'); }
    if (r.paid_by) { f.paid_by = r.paid_by; filled.push('who paid'); }
    if (r.notes && !f.notes.trim()) { f.notes = r.notes; filled.push('notes'); }
    if (r.claim) { f.claim_open = true; filled.push('items left for friends to pick'); }
    if (r.gift_card && r.cashback_pct) { f.cashback_on = true; f.gift_card = r.gift_card; f.cashback_pct = r.cashback_pct; filled.push('the cashback'); }
    const issues = [];
    if (r.fuzzy.length) issues.push(`I read ${r.fuzzy.map((x) => `"${x.given}" as ${x.matched}`).join(', ')} - check that's right.`);
    if (r.ambiguous.length) issues.push(`${r.ambiguous.map((x) => `"${x.given}" could be ${x.options.join(' or ')}`).join('; ')} - tap the right person on those items.`);
    if (r.unknown.length) issues.push(`I didn't recognise: ${r.unknown.join(', ')} - tap their items below to fix.`);
    if (!r.paid_by && !f.uid) issues.push('Check who paid - the block didn\'t say.');
    f.pasteMsg = `Filled in ${filled.join(', ')}.${issues.length ? ` ${issues.join(' ')}` : ''}`;
  } catch (err) { f.pasteMsg = err.message; }
}
function applyDraft() {
  const text = S.draft; S.draft = null;
  const f = { ...blankForm(), split_type: 'items', paste: text };
  fillFromBlock(f, text);
  S.form = f; S.view = 'form'; S.tab = 'expenses'; S.error = '';
  render(); window.scrollTo(0, 0); updateHints();
}

// ---------------------------------------------------------------- events
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const d = el.dataset; const act = d.act;
  S.error = ''; S.notice = '';
  const f = S.form;
  switch (act) {
    case 'home': location.hash = ''; S.view = 'home'; leaveTrip(); render(); loadHomeBadges(); break;
    case 'back': S.view = 'trip'; S.edit = null; S.person = null; S.noteForm = null; render(); break;
    case 'open': location.hash = `t=${d.code}`; break;
    case 'forget':
      if (confirm('Remove this trip from your phone? It stays available to everyone else, and you can rejoin with the link.')) {
        patchStore((s) => { delete s.trips[d.code]; });
        if (S.code === d.code) { location.hash = ''; leaveTrip(); }
        S.view = 'home';
      }
      render(); break;
    case 'join': {
      const raw = document.getElementById('joinInput').value.trim();
      const m = /t=([a-z0-9]+)/i.exec(raw) || /^([a-z0-9]{8,})$/i.exec(raw);
      if (!m) { S.error = 'That doesn\'t look like a trip link.'; render(); break; }
      location.hash = `t=${m[1].toLowerCase()}`;
      break;
    }
    case 'startNew': S.view = 'new'; S.newMode = 'file'; S.nt = blankNew(); render(); break;
    case 'startTab': S.view = 'newtab'; S.nt = blankNew(); render(); break;
    case 'createTab': await createTab(); break;
    case 'toggleClaim': f.claim_open = !f.claim_open; render(); updateHints(); break;
    case 'toggleCashback': f.cashback_on = !f.cashback_on; render(); updateHints(); break;
    case 'openClaim': S.claimUid = d.uid; S.claimTouched = false; S.view = 'claim'; render(); window.scrollTo(0, 0); break;
    case 'claimFromForm': S.claimUid = f.uid; S.claimTouched = false; S.form = null; S.view = 'claim'; render(); window.scrollTo(0, 0); break;
    case 'claimItem': {
      const e = S.expenses.find((x) => x.uid === S.claimUid); if (!e) break;
      const i = Number(d.i);
      const mine = new Set((e.claims || {})[S.me] || []);
      if (mine.has(i)) mine.delete(i); else mine.add(i);
      const list = [...mine].sort((x, y) => x - y);
      S.claimTouched = true;
      e.claims = { ...(e.claims || {}), [S.me]: list };
      fireAndForget(setDoc(tripRef('expenses', e.uid), { claims: { [S.me]: list } }, { merge: true }));
      render(); break;
    }
    case 'claimDone': {
      const e = S.expenses.find((x) => x.uid === S.claimUid);
      if (e && S.claimTouched) logActivity(`${S.me} picked their items on "${e.description}"`, 'claimed');
      S.claimUid = null; S.claimTouched = false; S.view = 'trip'; render(); break;
    }
    case 'balanceMode': patchStore((st) => { st.prefs.balanceMode = d.mode; }); render(); break;
    case 'pickMonth': S.month = d.month; render(); break;
    case 'pickStmt': S.stmtMonth = d.month; render(); break;
    case 'sendStatement': {
      const st = tabStatement(S.trip, S.expenses, S.settlements, S.stmtMonth || prevMonth(thisMonth()), balanceMode());
      const text = statementMessage(S.trip.name, st, tripLink());
      if (navigator.share) { try { await navigator.share({ text }); } catch { /* cancelled */ } }
      else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      break;
    }
    case 'claimPaid': case 'receivedPaid': {
      const mine = act === 'claimPaid';
      const amount = Math.round(Number(d.amt) * 100) / 100;
      const uid = newUid(); const now = new Date().toISOString();
      // show it at once, so a second tap can't send it again
      S.settlements = [...S.settlements, { uid, from: d.from, to: d.to, amount_gbp: amount, settle_date: todayIso(), status: mine ? 'claimed' : 'confirmed', by: S.me }];
      fireAndForget(setDoc(tripRef('settlements', uid), clean({ from: d.from, to: d.to, amount_gbp: amount, settle_date: todayIso(), notes: null, created_at: now, by: S.me, status: mine ? 'claimed' : 'confirmed', ...(mine ? {} : { confirmed_by: S.me, confirmed_at: now }) })));
      logActivity(mine ? `${S.me} says they paid ${d.to} ${money(amount)} - waiting for ${d.to} to confirm` : `${S.me} confirmed that ${d.from} paid ${money(amount)}`, 'payment');
      S.notice = mine ? `Sent. ${d.to} will be asked to confirm it.` : 'Recorded.'; render(); break;
    }
    case 'confirmPay': {
      const s = S.settlements.find((x) => x.uid === d.uid); if (!s) break;
      fireAndForget(updateDoc(tripRef('settlements', d.uid), { status: 'confirmed', confirmed_by: S.me, confirmed_at: new Date().toISOString() }));
      logActivity(`${S.me} confirmed ${s.from}'s payment of ${money(s.amount_gbp)}`, 'payment');
      S.notice = 'Confirmed - the balance is updated.'; render(); break;
    }
    case 'declinePay': {
      const s = S.settlements.find((x) => x.uid === d.uid); if (!s) break;
      if (!confirm(`Tell ${s.from} you haven't received ${money(s.amount_gbp)}? It stops counting, and they'll see it marked as not received. If it turns up later you can still tap Got it.`)) break;
      fireAndForget(updateDoc(tripRef('settlements', d.uid), { status: 'disputed', disputed_by: S.me, disputed_at: new Date().toISOString() }));
      logActivity(`${S.me} hasn't received the ${money(s.amount_gbp)} that ${s.from} said they paid`, 'payment-undone');
      render(); break;
    }
    case 'cancelClaim': {
      const s = S.settlements.find((x) => x.uid === d.uid); if (!s) break;
      fireAndForget(deleteDoc(tripRef('settlements', d.uid)));
      logActivity(`${S.me} cancelled their ${money(s.amount_gbp)} payment to ${s.to}`, 'payment-undone');
      render(); break;
    }
    case 'newMode': S.newMode = d.mode; S.error = ''; render(); break;
    case 'createBlank': await createBlank(); break;
    case 'iAm': setMe(d.name); break;
    case 'addMe': {
      const name = document.getElementById('newMe').value.trim();
      if (!name) { S.error = 'Type your name first.'; render(); break; }
      fireAndForget(setDoc(tripRef(), { members: arrayUnion(name) }, { merge: true }));
      fireAndForget(updateDoc(tripRef(), { member_ids: { ...(S.trip.member_ids || {}), [name]: newUid() } }));
      setMe(name);
      logActivity(activityLine('joined', name, 'joined the trip'), 'joined', S.code, name);
      break;
    }
    case 'tab': S.tab = d.tab; render(); window.scrollTo(0, 0); break;
    case 'sort': patchStore((s) => { s.prefs.sortMode = d.mode; }); render(); break;
    case 'addExpense': S.form = blankForm(); S.view = 'form'; render(); window.scrollTo(0, 0); updateHints(); break;
    case 'addReceipt': S.form = { ...blankForm(), split_type: 'items' }; S.view = 'form'; render(); window.scrollTo(0, 0); updateHints(); break;
    case 'editExpense': S.form = formFromExpense(S.expenses.find((e) => e.uid === d.uid)); S.view = 'form'; render(); window.scrollTo(0, 0); updateHints(); break;
    case 'cancelForm': S.form = null; S.view = 'trip'; render(); break;
    case 'pickCat': f.category = f.category === d.name ? '' : d.name; f.subtype = ''; render(); updateHints(); break;
    case 'pickSub': f.subtype = f.subtype === d.name ? '' : d.name; render(); updateHints(); break;
    case 'preset':
      (S.trip.members || []).forEach((m) => { f.participants[m] = { ...f.participants[m], on: d.p === 'all' || m === S.me }; });
      render(); updateHints(); break;
    case 'splitType': f.split_type = d.type; render(); updateHints(); break;
    case 'toggleEditor': f.editItems = !f.editItems; render(); updateHints(); break;
    case 'togglePerson': f.collapsed = (f.collapsed || []).includes(d.name) ? f.collapsed.filter((n) => n !== d.name) : [...(f.collapsed || []), d.name]; render(); updateHints(); break;
    case 'addItem': f.items.push({ description: '', amount: '', names: (S.trip.members || []).slice() }); render(); updateHints(); break;
    case 'removeItem': f.items.splice(Number(d.i), 1); if (!f.items.length) f.items.push({ description: '', amount: '', names: (S.trip.members || []).slice() }); render(); updateHints(); break;
    case 'itemWho': {
      const it = f.items[Number(d.i)];
      it.names = it.names.includes(d.name) ? it.names.filter((n) => n !== d.name) : [...it.names, d.name];
      render(); updateHints(); break;
    }
    case 'usePaste': fillFromBlock(f, f.paste || document.getElementById('f_paste').value); render(); updateHints(); break;
    case 'saveExpense': await saveExpense(); break;
    case 'deleteExpense':
      if (confirm(`Delete "${f.description}"?`)) {
        fireAndForget(deleteDoc(tripRef('expenses', f.uid)));
        // The tombstone keeps a copy of the expense so it can be restored from Activity.
        fireAndForget(setDoc(tripRef('deleted', f.uid), clean({ deleted_at: new Date().toISOString(), by: S.me, expense: f.original || null })));
        logActivity(activityLine('deleted', S.me, `"${f.original?.description || f.description}"`, f.original ? money(f.original.amount_gbp) : ''), 'deleted', S.code, S.me, { ref: f.uid });
        S.form = null; S.view = 'trip';
      }
      render(); break;
    case 'payFor': S.pay = blankPay(d.from, d.to, d.amt); S.view = 'pay'; render(); window.scrollTo(0, 0); break;
    case 'editPayment': {
      const s = S.settlements.find((x) => x.uid === d.uid);
      S.pay = { id: s.uid, from: s.from, to: s.to, amount: s.amount_gbp, date: s.settle_date || '', note: s.notes || '', code: S.code, back: 'trip' };
      S.view = 'pay'; render(); break;
    }
    case 'cancelPay': { const back = S.pay.back; S.pay = null; S.view = back === 'combo' ? 'combo' : 'trip'; render(); break; }
    case 'savePay': savePay(); break;
    case 'deletePay': case 'undoPay': {
      const uid = act === 'deletePay' ? S.pay.id : d.uid;
      const s = S.settlements.find((x) => x.uid === uid);
      if (!confirm('Delete this payment?')) break;
      fireAndForget(deleteDoc(tripRef('settlements', uid)));
      if (s) logActivity(activityLine('payment-undone', S.me, `the payment of ${s.from} → ${s.to} ${money(s.amount_gbp)}`), 'payment-undone');
      S.pay = null; S.view = 'trip'; render(); break;
    }
    case 'whatsapp': {
      const all = computeAll(S.trip, S.expenses, S.settlements, S.adjustments);
      const text = settleMessage(S.trip.name, transfersFor(all), all.total);
      if (navigator.share) { try { await navigator.share({ text }); } catch { /* cancelled */ } } else { try { await navigator.clipboard.writeText(text); S.notice = 'Copied - paste it into your group chat.'; } catch { S.notice = text; } render(); }
      break;
    }
    case 'addPerson': {
      const name = document.getElementById('addPerson').value.trim();
      if (name && !(S.trip.members || []).includes(name)) { fireAndForget(setDoc(tripRef(), { members: arrayUnion(name) }, { merge: true })); fireAndForget(updateDoc(tripRef(), { member_ids: { ...(S.trip.member_ids || {}), [name]: newUid() } })); logActivity(activityLine('added', S.me, `${name} to the trip`), 'joined'); }
      break;
    }
    case 'rename': {
      const nn = (prompt(`Rename ${d.name} to:`, d.name) || '').trim();
      if (nn && nn !== d.name) await renamePerson(d.name, nn);
      break;
    }
    case 'shareLink':
      if (navigator.share) { try { await navigator.share({ title: S.trip.name, text: `Join our trip on SplitVeryWisely: ${S.trip.name}`, url: tripLink() }); } catch { /* cancelled */ } }
      else { await navigator.clipboard?.writeText(tripLink()); S.notice = 'Link copied.'; render(); }
      break;
    case 'copyLink':
      try { await navigator.clipboard.writeText(tripLink()); S.notice = 'Link copied.'; } catch { S.notice = 'Couldn\'t copy - press and hold the link to copy it.'; }
      render(); break;
    case 'exportFile': await exportFile(); break;
    case 'changeMe': S.view = 'who'; render(); break;
    case 'openActivity': S.view = 'activity'; render(); window.scrollTo(0, 0); break;
    case 'editTrip': S.edit = editFromTrip(); S.view = 'edit'; render(); window.scrollTo(0, 0); break;
    case 'saveEdit': saveEdit(); break;
    case 'pickTheme': { const t = S[d.f].theme; t.id = d.id; render(); break; }
    case 'pickDoodle': {
      const t = S[d.f].theme;
      t.doodles = t.doodles.includes(d.name) ? t.doodles.filter((n) => n !== d.name) : (t.doodles.length < 8 ? [...t.doodles, d.name] : t.doodles);
      render(); break;
    }
    case 'personalBudget': {
      const cur = readStore().budgets[S.code] || '';
      const v = prompt('Your private budget for this trip, in £ (only you can see it). Leave empty to remove it:', cur);
      if (v !== null) patchStore((s) => { if (Number(v) > 0) s.budgets[S.code] = Number(v); else delete s.budgets[S.code]; });
      render(); break;
    }
    case 'openCarry': S.carry = { step: 'pick', loaded: true, error: '' }; S.view = 'carry'; render(); window.scrollTo(0, 0); break;
    case 'carryBack': if (S.carry.step === 'preview') { S.carry.step = 'pick'; render(); } else { S.carry = null; S.view = 'trip'; render(); } break;
    case 'carryPick': await loadCarryTarget(d.code); break;
    case 'carryGo': doCarry(); break;
    case 'openAdj': S.adjView = S.adjustments.find((x) => x.uid === d.uid); S.view = 'adj'; render(); break;
    case 'undoAdj': undoAdj(); break;
    case 'summaryMode': patchStore((s) => { s.prefs.summaryMode = d.mode; }); render(); break;
    case 'toggleFilters': S.flt.open = !S.flt.open; render(); break;
    case 'clearFilters': S.flt = { q: '', who: '', cat: '', mine: false, open: S.flt.open }; render(); break;
    case 'openPerson': S.person = d.name; S.view = 'person'; render(); window.scrollTo(0, 0); break;
    case 'openRecap': S.view = 'recap'; S.notice = ''; render(); window.scrollTo(0, 0); break;
    case 'sharePicture': await sharePicture(); break;
    case 'openInfo': S.view = 'info'; S.noteForm = null; render(); window.scrollTo(0, 0); break;
    case 'addNote': S.noteForm = { id: null, title: '', body: '', address: false }; render(); break;
    case 'editNote': { const n = S.notes.find((x) => x.uid === d.uid); S.noteForm = { id: n.uid, title: n.title || '', body: n.body || '', address: !!n.address }; render(); break; }
    case 'cancelNote': S.noteForm = null; S.error = ''; render(); break;
    case 'saveNote': {
      const nf = S.noteForm;
      if (!nf.title.trim()) { S.error = 'Give the note a title.'; render(); break; }
      const existing = nf.id ? (S.notes.find((x) => x.uid === nf.id) || {}) : {};
      const uid = nf.id || newUid(); const now = new Date().toISOString();
      fireAndForget(setDoc(tripRef('notes', uid), clean({ title: nf.title.trim(), body: nf.body.trim() || null, address: !!nf.address, created_at: existing.created_at || now, updated_at: now, by: S.me })));
      logActivity(activityLine(nf.id ? 'edited' : 'added', S.me, `the note "${nf.title.trim()}"`, nf.id ? 'edited' : ''), 'note');
      S.noteForm = null; S.error = ''; render(); break;
    }
    case 'deleteNote': {
      const nf = S.noteForm;
      if (confirm('Delete this note?')) { fireAndForget(deleteDoc(tripRef('notes', nf.id))); logActivity(activityLine('deleted', S.me, `the note "${nf.title}"`), 'note'); S.noteForm = null; }
      render(); break;
    }
    case 'copyNote': {
      const n = S.notes.find((x) => x.uid === d.uid);
      try { await navigator.clipboard.writeText([n.title, n.body].filter(Boolean).join('\n')); S.notice = 'Copied.'; } catch { S.notice = 'Couldn\'t copy - press and hold the text to copy it.'; }
      render(); break;
    }
    case 'restore': {
      const tomb = S.deletedMap[d.uid];
      if (!tomb || !tomb.expense) break;
      fireAndForget(setDoc(tripRef('expenses', d.uid), clean({ ...tomb.expense, updated_at: new Date().toISOString() })));
      fireAndForget(deleteDoc(tripRef('deleted', d.uid)));
      logActivity(activityLine('restored', S.me, `restored "${tomb.expense.description}"`), 'restored');
      S.notice = 'Restored - it is back in the Expenses list.'; render(); break;
    }
    case 'claimOwner': await claimOwner(); break;
    case 'deleteTrip': await deleteTrip(); break;
    case 'openCombo': S.combo = { step: 'pick', selected: S.code ? [S.code] : [], data: {}, loaded: false, error: '' }; S.view = 'combo'; render(); break;
    case 'comboBack': S.combo = null; S.view = S.code ? 'trip' : 'home'; render(); break;
    case 'comboPick': S.combo.step = 'pick'; render(); break;
    case 'comboGo': await loadCombo(); break;
    case 'comboPay':
      S.pay = blankPay(d.from, d.to, d.amt, d.primary, 'combo');
      // the primary trip may not have both people yet - add them so the payment can be saved
      [d.from, d.to].forEach((n) => { if (!(S.combo.data[d.primary]?.trip.members || []).includes(n)) { fireAndForget(setDoc(refFor(d.primary), { members: arrayUnion(n) }, { merge: true })); S.combo.data[d.primary].trip.members = [...(S.combo.data[d.primary].trip.members || []), n]; } });
      S.view = 'pay'; render(); break;
    case 'comboShare': {
      const c = S.combo; const list = c.selected.map((code) => ({ code, ...c.data[code] })).filter((x) => x.trip);
      const res = combineTrips(list, readStore().nameMap);
      const text = settleMessage(list.map((x) => x.trip.name).join(' + '), res.transfers, null);
      if (navigator.share) { try { await navigator.share({ text }); } catch { /* cancelled */ } } else { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } }
      break;
    }
    default: break;
  }
});

// Amounts are tidied as they are typed: a stray space ("6. 50"), a pound sign or a decimal comma ("6,50") would otherwise be
// read as "not a number" and quietly counted as nothing.
const cleanNum = (v) => {
  let x = String(v ?? '').replace(/[£€$\s]/g, '');
  x = /^\d+,\d{1,2}$/.test(x) ? x.replace(',', '.') : x.replace(/,/g, '');
  return x;
};
const NUMERIC_FIELDS = new Set(['amount_gbp', 'orig_amount', 'rate', 'gift_card', 'cashback_pct']);

// Typing updates state without redrawing (a redraw would drop the keyboard).
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset.flt) { if (t.type !== 'checkbox') { S.flt[t.dataset.flt] = t.value; refreshList(); } return; }
  if (t.dataset.ci !== undefined) { S[t.dataset.f].theme.colors[Number(t.dataset.ci)] = t.value; return; }
  if (t.dataset.f && t.dataset.k) { S[t.dataset.f][t.dataset.k] = t.type === 'checkbox' ? t.checked : t.value; if (t.dataset.k === 'currency') S[t.dataset.f].currency = t.value.toUpperCase(); return; }
  const f = S.form;
  if (S.view !== 'form' || !f) return;
  if (t.id === 'f_paste') { f.paste = t.value; return; }
  if (t.id && t.id.startsWith('f_')) f[t.id.slice(2)] = NUMERIC_FIELDS.has(t.id.slice(2)) ? cleanNum(t.value) : t.value;
  else if (t.dataset.item !== undefined) f.items[Number(t.dataset.item)][t.dataset.field] = (t.dataset.field === 'amount' || t.dataset.field === 'was') ? cleanNum(t.value) : t.value;
  else if (t.dataset.val !== undefined) f.participants[t.dataset.val].value = cleanNum(t.value);
  updateHints();
});
document.addEventListener('change', (ev) => {
  const t = ev.target; const f = S.form;
  if (t.dataset.flt) { S.flt[t.dataset.flt] = t.type === 'checkbox' ? t.checked : t.value; refreshList(); const c = document.getElementById('fltcount'); if (c) c.textContent = countText(computeAll(S.trip, S.expenses, S.settlements, S.adjustments)); return; }
  if (t.id === 'tripFile' && t.files[0]) { createFromFile(t.files[0]); return; }
  if (t.dataset.combo !== undefined) {
    const c = S.combo; c.selected = t.checked ? [...new Set([...c.selected, t.dataset.combo])] : c.selected.filter((x) => x !== t.dataset.combo); render(); return;
  }
  if (t.dataset.map !== undefined) { patchStore((s) => { if (t.value) s.nameMap[t.dataset.map] = t.value; else delete s.nameMap[t.dataset.map]; }); render(); return; }
  if (t.dataset.f && t.dataset.k) { S[t.dataset.f][t.dataset.k] = t.type === 'checkbox' ? t.checked : t.value; return; }
  if (S.view !== 'form' || !f) return;
  if ((t.id && NUMERIC_FIELDS.has(t.id.slice(2))) || t.dataset.field === 'amount' || t.dataset.field === 'was' || t.dataset.val !== undefined) { const c = cleanNum(t.value); if (c !== t.value) t.value = c; }
  if (t.dataset.who !== undefined) { f.participants[t.dataset.who].on = t.checked; render(); updateHints(); }
  else if (t.id === 'f_paid_by') { f.paid_by = t.value; render(); updateHints(); }
});

routeFromHash();
render();
loadHomeBadges();
