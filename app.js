import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocs, setDoc, deleteDoc, collection, onSnapshot, writeBatch, arrayUnion,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import {
  SPLIT_LABELS, clean, newCode, newUid, resolveAmounts, computeAll, buildTripFile, parseReceiptBlock, expenseSharesPence,
} from './logic.js';
import {
  summarize, budgetState, describeChange, activityLine, canonicalName, combineTrips, unmatchedNames, settleMessage, findDuplicate, sha256Hex,
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
  trip: null, expenses: [], settlements: [], deleted: [], activity: [],
  pend: { e: 0, s: 0, a: 0 }, loaded: false, missing: false,
  form: null, pay: null, edit: null, nt: null, combo: null,
  error: '', notice: '',
  newMode: 'file',
};
let unsubs = [];

// ---------------------------------------------------------------- opening a trip
function leaveTrip() {
  unsubs.forEach((u) => u());
  unsubs = [];
  Object.assign(S, { code: null, trip: null, expenses: [], settlements: [], deleted: [], activity: [], loaded: false, missing: false, pend: { e: 0, s: 0, a: 0 }, isOwner: false, themeKey: '' });
  applyTheme(THEMES.classic);
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
  const base = ['trips', code];
  // includeMetadataChanges makes these fire again the moment the server confirms a write,
  // so "waiting to upload" clears by itself.
  unsubs.push(onSnapshot(doc(db, ...base), live, (snap) => {
    S.loaded = true;
    S.missing = !snap.exists();
    S.trip = snap.exists() ? snap.data() : null;
    if (S.trip) {
      patchStore((s) => { s.trips[code] = { ...(s.trips[code] || {}), name: S.trip.name }; });
      refreshTheme();
      computeOwner();
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
  unsubs.push(onSnapshot(collection(db, ...base, 'activity'), live, (snap) => {
    S.activity = snap.docs.map((d) => ({ ...d.data(), uid: d.id })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    S.pend.a = snap.docs.filter((d) => d.metadata.hasPendingWrites).length;
    softRender();
  }));
  unsubs.push(onSnapshot(collection(db, ...base, 'deleted'), (snap) => { S.deleted = snap.docs.map((d) => d.id); }));
  render();
}

function routeFromHash() {
  const m = /[#&]t=([a-z0-9]+)/i.exec(location.hash);
  if (m) {
    openTrip(m[1].toLowerCase());
  } else if (!['new', 'combo'].includes(S.view)) {
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

function logActivity(text, kind, code = S.code, by = S.me) {
  fireAndForget(setDoc(refFor(code, 'activity', newUid()), clean({ at: new Date().toISOString(), by, kind, text })));
}

// ---------------------------------------------------------------- rendering
function softRender() { if (!FORM_VIEWS.includes(S.view)) render(); }
function render() {
  const views = { home: homeView, new: newView, who: whoView, form: formView, pay: payView, edit: editView, activity: activityView, combo: comboView };
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

function homeView() {
  const trips = Object.entries(readStore().trips);
  return `
    <h1>SplitVeryWisely</h1>
    <p class="sub">Share the cost of a trip with friends. Everyone sees every expense straight away.</p>
    ${trips.length ? `<h2>Your trips</h2>${trips.map(([code, t]) => `
      <div class="ex" style="padding:6px 10px 6px 14px"><button class="plain grow" data-act="open" data-code="${esc(code)}"><span class="title">${esc(t.name || 'Trip')}</span>
      <div class="muted">${t.me ? `You are ${esc(t.me)}` : 'Tap to choose who you are'}</div></button>
      <button class="danger" data-act="forget" data-code="${esc(code)}" aria-label="Remove from this phone">Remove</button></div>`).join('')}
      ${trips.length > 1 ? '<button class="secondary full" data-act="openCombo">Settle several trips together</button>' : ''}` : ''}
    <h2>Join a trip</h2>
    <p class="sub">Open the link your friend sent you, or paste it here.</p>
    <input id="joinInput" placeholder="Paste the trip link" autocapitalize="off" autocorrect="off">
    <div style="height:10px"></div>
    <button class="full" data-act="join">Join</button>
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
    <h2>Start a new trip</h2>
    <button class="secondary full" data-act="startNew">Start a new trip</button>`;
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
  if (!S.loaded) return '<p class="loading">Opening trip…</p>';
  if (S.missing || !S.trip) return missingView();
  const t = S.trip;
  const th = resolveTheme(t.theme);
  const all = computeAll(t, S.expenses, S.settlements);
  const meRow = all.people.find((p) => p.name === S.me);
  const body = S.tab === 'summary' ? summaryTab(all) : S.tab === 'balances' ? balancesTab(all) : S.tab === 'more' ? moreTab() : expensesTab(all);
  const meta = [t.destination, fmtRange(t.start_date, t.end_date)].filter(Boolean).map(esc).join(' · ');
  const un = unseenCount();
  return `
    <header class="top">
      ${th.stripe.length ? `<div class="stripe">${th.stripe.map((c) => `<span style="background:${c}"></span>`).join('')}</div>` : ''}
      <div class="row between"><button class="ghost" data-act="home">← Trips</button>
        <span class="row">${syncBadge()}<button class="bell" data-act="openActivity" aria-label="Activity"><i class="ti ti-bell" aria-hidden="true"></i>${un ? `<span class="dotn">${un > 9 ? '9+' : un}</span>` : ''}</button></span></div>
      <div class="ttl">${esc(t.name)}</div>
      <div class="meta">${meta}${meta ? ' · ' : ''}<em>${esc(S.greeting)}, ${esc(S.me)}</em></div>
      <div class="cards2">
        <div class="mini a1"><div class="k">Trip total</div><div class="v num">${money(all.total)}</div></div>
        <div class="mini a2"><div class="k">Your share</div><div class="v num">${money(meRow?.share || 0)}</div></div>
      </div>
    </header>
    ${S.notice ? `<div class="alert">${esc(S.notice)}</div>` : ''}
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
    ${body}
    ${S.tab === 'expenses' ? '<div class="fabs"><button class="secondary" data-act="addReceipt">From a receipt</button><button data-act="addExpense">+ Add expense</button></div>' : ''}
    <nav class="tabs">
      ${[['expenses', 'Expenses', 'receipt-2'], ['summary', 'Summary', 'chart-pie'], ['balances', 'Balances', 'scale'], ['more', 'More', 'dots']]
    .map(([k, l, ic]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}"><i class="ti ti-${ic}" aria-hidden="true"></i><span>${l}</span></button>`).join('')}
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

function expensesTab(all) {
  const sortMode = readStore().prefs.sortMode;
  const added = (x) => String(x.created_at || x.updated_at || x.settle_date || '');
  const rows = [
    ...S.expenses.map((e) => ({ kind: 'expense', e, date: e.expense_date || '', added: added(e) })),
    ...S.settlements.map((s) => ({ kind: 'payment', s, date: s.settle_date || '', added: added(s) })),
  ].sort((x, y) => (sortMode === 'added'
    ? String(y.added).localeCompare(String(x.added))
    : String(y.date).localeCompare(String(x.date)) || String(y.added).localeCompare(String(x.added))));
  return `
    ${estimateAlert(all)}
    <div class="seg small" style="margin:6px 0"><button class="${sortMode === 'date' ? 'on' : ''}" data-act="sort" data-mode="date">By date</button><button class="${sortMode === 'added' ? 'on' : ''}" data-act="sort" data-mode="added">By when added</button></div>
    ${rows.length === 0 ? '<p class="sub">Nothing yet - tap "Add expense".</p>' : rows.map((r) => {
    if (r.kind === 'payment') {
      const s = r.s;
      return `<button class="ex pay" data-act="editPayment" data-uid="${esc(s.uid)}"><div class="tile tg"><i class="ti ti-cash" aria-hidden="true"></i></div><div class="mid"><p class="t" style="font-weight:400">${esc(s.from === S.me ? 'You' : s.from)} paid ${esc(s.to === S.me ? 'you' : s.to)} <b>${money(s.amount_gbp)}</b></p><p class="s">${esc(fmtShort(s.settle_date))}${s.settle_date ? ' · ' : ''}Payment${s.notes ? ` · ${esc(s.notes)}` : ''}</p></div></button>`;
    }
    const e = r.e;
    const mineP = (all.shareByExpense[e.uid] || {})[S.me];
    const mine = mineP != null ? mineP / 100 : 0;
    const iPaid = e.paid_by === S.me;
    let tone = 'n'; let label = '';
    if (iPaid) {
      const lent = e.amount_gbp - mine;
      if (lent > 0.004) { tone = 'g'; label = `you lent ${money(lent)}`; }
    } else if (mine > 0.004) { tone = 'r'; label = `you borrowed ${money(mine)}`; }
    const what = e.subtype || e.category || '';
    return `<button class="ex" data-act="editExpense" data-uid="${esc(e.uid)}">
        <div class="tile t${tone}"><i class="ti ti-${iconFor(e.category, e.subtype)}" aria-hidden="true"></i></div>
        <div class="mid"><p class="t">${esc(e.description)}</p>
          <p class="s">${esc(fmtShort(e.expense_date))}${e.expense_date ? ' · ' : ''}${esc(iPaid ? 'You paid' : `${e.paid_by} paid`)}${what ? ` · ${esc(what)}` : ''}${e.gbp_estimated ? '<span class="est">est. £</span>' : ''}</p>
          <p class="s">${mineP != null ? `Your share ${money(mine)}` : "You're not involved"}${all.problems[e.uid] ? ' · <span class="neg">check the split</span>' : ''}</p></div>
        <div class="amt"><b class="num">${money(e.amount_gbp)}</b>${label ? `<span class="${tone}t">${label}</span>` : ''}${e.orig_amount ? `<span class="m">${esc(fmtNum(e.orig_amount, e.orig_currency))}</span>` : ''}</div>
      </button>`;
  }).join('')}`;
}

// ---- Summary
function donut(byCategory, total) {
  const R = 40; const C = 2 * Math.PI * R;
  let off = 0;
  const segs = byCategory.map((c, i) => {
    const len = total > 0 ? (c.total / total) * C : 0;
    const s = `<circle cx="58" cy="58" r="${R}" stroke="${PALETTE[i % PALETTE.length]}" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`;
    off += len;
    return s;
  }).join('');
  return `<svg width="124" height="124" viewBox="0 0 116 116" role="img" aria-label="Spending by category"><g transform="rotate(-90 58 58)" fill="none" stroke-width="18"><circle cx="58" cy="58" r="${R}" stroke="currentColor" opacity="0.12"/>${segs}</g>
    <text x="58" y="55" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">Total</text><text x="58" y="70" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">${esc(money(total).replace(/\.00$/, ''))}</text></svg>`;
}

function budgetBar(label, st, hint) {
  if (!st) return '';
  return `<div class="bud"><div class="bl"><b>${label}</b><span>${money(st.spent)} of ${money(st.budget)}</span></div>
    <div class="track"><div class="fill ${st.tone}" style="width:${Math.min(100, st.pct)}%"></div></div>
    <div class="sub2"><span>${st.left >= 0 ? `${money(st.left)} left` : `${money(-st.left)} over`}</span><span>${hint}</span></div></div>`;
}

function summaryTab(all) {
  const t = S.trip;
  const sm = summarize(t, S.expenses, all, todayIso());
  const meRow = all.people.find((p) => p.name === S.me);
  const group = budgetState(t.budget_gbp, all.total);
  const personalBudget = readStore().budgets[S.code];
  const personal = budgetState(personalBudget, meRow?.share || 0);
  const maxDay = Math.max(1, sm.before, sm.after, ...sm.days.map((d) => d.total));
  const bar = (v) => `${Math.max(3, Math.round((v / maxDay) * 90))}px`;
  const maxPP = Math.max(1, ...sm.paidVsShare.map((p) => Math.max(p.paid, p.share)));
  if (!S.expenses.length) return '<p class="sub">Add a few expenses and this page fills in.</p>';
  return `
    <h2>Budget</h2>
    <div class="card">
      ${budgetBar('Group budget', group, group ? `${sm.days.length ? '' : ''}${group.pct}% used` : '') || '<p class="muted" style="margin:0">No group budget set. Add one under More, then Edit trip.</p>'}
      ${personal ? budgetBar('Your budget <i class="ti ti-lock" aria-hidden="true"></i>', personal, 'only you can see this') : ''}
      <button class="ghost" data-act="personalBudget">${personal ? 'Change' : 'Set'} your private budget</button>
    </div>
    <h2>Where the money went</h2>
    <div class="card donutrow">
      ${donut(sm.byCategory, all.total)}
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
    <h2>Who paid and who owes</h2>
    <div class="card">${sm.paidVsShare.map((p) => `<div class="pp"><div class="row between"><span>${esc(p.name === S.me ? `${p.name} (you)` : p.name)}</span><span class="muted num">paid ${money(p.paid)} · share ${money(p.share)}</span></div>
      <div class="two"><div class="paid" style="width:${(p.paid / maxPP) * 100}%"></div></div><div class="two"><div class="shr" style="width:${(p.share / maxPP) * 100}%"></div></div></div>`).join('')}
      <p class="muted" style="margin:6px 0 0"><span class="dot" style="background:var(--accent)"></span>paid &nbsp; <span class="dot" style="background:var(--muted)"></span>their share</p></div>
    <h2>Biggest expenses</h2>
    <div class="card">${sm.biggest.map((b) => `<div class="row" style="padding:6px 0"><div class="tile tn" style="width:34px;height:34px;font-size:18px"><i class="ti ti-${iconFor(b.category, b.subtype)}" aria-hidden="true"></i></div><div class="grow"><b>${esc(b.description)}</b><div class="muted">${esc(b.subtype || b.category || '')}${b.date ? ` · ${esc(fmtShort(b.date))}` : ''}</div></div><b class="num">${money(b.amount)}</b></div>`).join('')}</div>`;
}

// ---- Balances (who owes what + settle up)
function balancesTab(all) {
  return `
    ${estimateAlert(all)}
    <h2>Who owes what</h2>
    ${all.people.map((p) => `<div class="card"><div class="row between"><b>${esc(p.name === S.me ? `${p.name} (you)` : p.name)}</b>
      <span class="${p.net > 0.004 ? 'pos' : p.net < -0.004 ? 'neg' : 'muted'} num">${Math.abs(p.net) < 0.005 ? 'All square' : p.net > 0 ? `Is owed ${money(p.net)}` : `Owes ${money(-p.net)}`}</span></div>
      <div class="muted num">Paid ${money(p.paid)} · Their share ${money(p.share)}${p.settled ? ` · Payments ${money(p.settled)}` : ''}</div></div>`).join('')}
    <h2>Settle up</h2>
    <p class="sub">The fewest payments that clear everything, always in pounds. Someone paid a different amount? Use "Record a payment".</p>
    ${all.transfers.length === 0 ? `<p class="sub">${S.expenses.length ? 'Everyone is all square.' : 'Nothing to settle yet.'}</p>` : all.transfers.map((t) => `
      <div class="card"><div class="row between"><span><b>${esc(t.from === S.me ? 'You' : t.from)}</b> pay${t.from === S.me ? '' : 's'} <b>${esc(t.to === S.me ? 'you' : t.to)}</b></span><b class="num">${money(t.amount_gbp)}</b></div>
      <div style="height:8px"></div><button class="secondary" data-act="payFor" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amt="${t.amount_gbp.toFixed(2)}">Record this payment</button></div>`).join('')}
    <div class="row" style="margin-top:8px;flex-wrap:wrap"><button class="secondary" data-act="payFor">Record a payment</button>
      <button class="secondary" data-act="whatsapp">Share who pays whom</button></div>
    ${S.settlements.length ? `<h2>Payments recorded</h2>${S.settlements.slice().sort((a, b) => String(b.settle_date).localeCompare(String(a.settle_date))).map((s) => `
      <div class="row between" style="padding:6px 0"><span>${esc(s.settle_date ? `${fmtShort(s.settle_date)} · ` : '')}${esc(s.from)} paid ${esc(s.to)} <b class="num">${money(s.amount_gbp)}</b>${s.notes ? `<span class="muted"> · ${esc(s.notes)}</span>` : ''}</span>
      <button class="danger" data-act="undoPay" data-uid="${esc(s.uid)}">Undo</button></div>`).join('')}` : ''}`;
}

// ---- More
function moreTab() {
  const t = S.trip;
  const store = readStore();
  const hasOwner = !!t.owner_hash;
  return `
    <h2>Invite friends</h2>
    <p class="sub">Anyone with this link sees and edits the trip. They tap their name the first time they open it.</p>
    <div class="card"><div class="muted" style="word-break:break-all">${esc(tripLink())}</div></div>
    <div class="row"><button class="grow" data-act="shareLink">Share the link</button><button class="secondary" data-act="copyLink">Copy</button></div>
    <h2>People on this trip</h2>
    <div class="chips">${(t.members || []).map((m) => `<button type="button" class="chip ${m === S.me ? 'on' : ''}" data-act="rename" data-name="${esc(m)}">${esc(m)} ✎</button>`).join('')}</div>
    <p class="muted">Tap a name to rename it everywhere - handy for a typo, or to change "Me" to your real name.</p>
    <div class="row"><input id="addPerson" placeholder="Add someone"><button data-act="addPerson">Add</button></div>
    <h2>Trip</h2>
    <div class="menu">
      <button data-act="openActivity"><i class="ti ti-bell" aria-hidden="true"></i><span>Activity<small>Everything that changed, and who changed it</small></span></button>
      <button data-act="editTrip"><i class="ti ti-pencil" aria-hidden="true"></i><span>Edit trip<small>Name, dates, currency, rate, budget and theme</small></span></button>
      <button data-act="openCombo"><i class="ti ti-arrows-exchange" aria-hidden="true"></i><span>Settle several trips together<small>Add up balances across trips, e.g. Naples and Oxford</small></span></button>
      <button data-act="exportFile"><i class="ti ti-download" aria-hidden="true"></i><span>Save trip file<small>For the desktop app - also a handy backup</small></span></button>
    </div>
    <h2>Your phone</h2>
    <button class="ghost" data-act="changeMe">I'm not ${esc(S.me)} - change who I am</button>
    <button class="danger" data-act="forget" data-code="${esc(S.code)}">Remove this trip from my phone</button>
    <h2>Danger zone</h2>
    ${S.isOwner ? '<p class="sub">You created this trip. Deleting it removes it for everyone, for good.</p><button class="dangerbtn full" data-act="deleteTrip">Delete this trip for everyone</button>'
    : hasOwner ? '<p class="sub">Only the person who created this trip can delete it for everyone.</p>'
      : `<p class="sub">This trip has no creator yet. If you created it, tap below. Only the first person to tap becomes the creator, so do it now.</p><button class="secondary full" data-act="claimOwner">I'm the creator of this trip</button>`}`;
}

// ---- Activity
function activityView() {
  patchStore((s) => { s.seen[S.code] = new Date().toISOString(); });
  return `
    <div class="topbar"><button class="ghost" data-act="back">← Back</button></div>
    <h1>Activity</h1>
    <p class="sub">Everything that changed on this trip, newest first.</p>
    ${S.activity.length === 0 ? '<p class="sub">Nothing yet.</p>' : S.activity.map((a) => `
      <div class="card" style="padding:10px 12px"><div>${esc(a.text)}</div><div class="muted">${esc(fmtWhen(a.at))}</div></div>`).join('')}`;
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
    items: [{ description: '', amount: '', names: members.slice() }],
    notes: '', paste: '', pasteMsg: '',
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
    items: e.items && e.items.length ? e.items.map((i) => ({ description: i.description, amount: i.amount, names: i.names || [] })) : [{ description: '', amount: '', names: members.slice() }],
    notes: e.notes || '', paste: '', pasteMsg: '', wasEstimated: !!e.gbp_estimated, original: e,
  };
}

function formView() {
  const f = S.form; const t = S.trip; const members = t.members || [];
  const items = f.split_type === 'items';
  const unit = f.split_type === 'exact' ? '£' : f.split_type === 'percent' ? '%' : f.split_type === 'shares' ? 'shares' : '';
  const itemCur = Number(f.orig_amount) > 0 ? f.orig_currency : 'GBP';
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
    <label>Amount in pounds (£) - leave empty if you only know the ${esc(t.currency)} amount</label>
    <input id="f_amount_gbp" inputmode="decimal" value="${esc(f.amount_gbp)}" placeholder="0.00">
    <label>Amount in ${esc(f.orig_currency)} (optional)</label>
    <input id="f_orig_amount" inputmode="decimal" value="${esc(f.orig_amount)}" placeholder="0.00">
    <div id="estHint"></div>
    <label>Who paid?</label>
    <select id="f_paid_by">${members.map((m) => `<option ${m === f.paid_by ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <label>How is it split?</label>
    <div class="seg">${Object.entries(SPLIT_LABELS).map(([k, v]) => `<button type="button" class="${f.split_type === k ? 'on' : ''}" data-act="splitType" data-type="${k}">${v}</button>`).join('')}</div>
    ${items ? `
      <div class="card"><label style="margin-top:0">Got a receipt block from Claude? Paste it here</label>
      <textarea id="f_paste" placeholder="Paste what Claude gave you">${esc(f.paste)}</textarea>
      <div style="height:8px"></div><button type="button" class="secondary" data-act="usePaste">Fill in the items</button>
      ${f.pasteMsg ? `<p class="sub">${esc(f.pasteMsg)}</p>` : ''}</div>
      <p class="sub" style="margin-top:10px">Add each item and tap who had it. Service charge, VAT or tip that the items don't cover is shared in proportion to what each person had. Skipped the service? Make the bill match the items. Item amounts are in <b>${esc(itemCur === 'GBP' ? '£' : itemCur)}</b>.</p>
      ${f.items.map((it, i) => `<div class="item">
        <div class="row"><input data-item="${i}" data-field="description" value="${esc(it.description)}" placeholder="Item"><input data-item="${i}" data-field="amount" inputmode="decimal" value="${esc(it.amount)}" placeholder="0.00" style="max-width:110px">
        <button type="button" class="danger" data-act="removeItem" data-i="${i}">✕</button></div>
        <div class="chips" style="margin-top:8px">${members.map((m) => `<button type="button" class="chip ${(it.names || []).includes(m) ? 'on' : ''}" data-act="itemWho" data-i="${i}" data-name="${esc(m)}">${esc(m)}</button>`).join('')}</div></div>`).join('')}
      <button type="button" class="secondary" data-act="addItem">+ Add item</button>
      <div id="itemsHint" class="sub" style="margin-top:8px"></div>`
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
  const t = S.trip;
  const gbp = f.amount_gbp === '' ? null : Number(f.amount_gbp);
  const orig = f.orig_amount === '' ? null : Number(f.orig_amount);
  const rate = Number(f.rate) > 0 ? Number(f.rate) : Number(t.default_rate);
  const est = document.getElementById('estHint');
  if (est) est.innerHTML = gbp == null && orig && rate ? `<div class="alert">About ${money(orig * rate)} (estimate). It will be marked "estimated" until the person who paid gives you the real pounds.</div>` : '';
  const ih = document.getElementById('itemsHint');
  if (ih) {
    const sum = f.items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    const total = Number(orig) > 0 ? orig : (gbp || 0);
    const cur = Number(orig) > 0 ? f.orig_currency : '£';
    const extra = Math.max(0, total - sum);
    ih.textContent = `Items ${sum.toFixed(2)} · Bill ${total.toFixed(2)} ${cur === '£' ? '' : cur} · Extras shared in proportion ${extra.toFixed(2)}${sum > total + 0.005 ? ' - items add up to more than the bill!' : ''}`;
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
  if (f.split_type === 'items') {
    const local = amounts.orig_amount > 0;
    e.items = f.items.filter((i) => i.description.trim() || i.amount !== '').map((i) => ({
      description: i.description.trim(), amount: Number(i.amount), names: i.names || [], ...(local ? { in_local: true } : {}),
    }));
    if (e.items.some((i) => !(i.amount >= 0))) throw new Error('Every item needs an amount.');
    e.participants = [];
  } else {
    e.participants = Object.entries(f.participants).filter(([, p]) => p.on).map(([name, p]) => ({
      name, value: f.split_type === 'equal' || p.value === '' ? null : Number(p.value),
    }));
    e.items = null;
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
  fireAndForget(setDoc(refFor(p.code, 'settlements', uid), clean({
    from: p.from, to: p.to, amount_gbp: amount, settle_date: p.date || null, notes: p.note.trim() || null,
    created_at: existing.created_at || new Date().toISOString(), by,
  })));
  logActivity(activityLine('payment', by, `${p.from} paid ${p.to} ${money(amount)}${p.id ? ' (edited)' : ''}`), 'payment', p.code, by);
  const back = p.back; S.pay = null;
  if (back === 'combo') { S.view = 'combo'; loadCombo(); } else S.view = 'trip';
  render();
}

// ---------------------------------------------------------------- edit trip
function editFromTrip() {
  const t = S.trip;
  return {
    name: t.name || '', destination: t.destination || '', start_date: t.start_date || '', end_date: t.end_date || '',
    currency: t.currency || 'EUR', default_rate: t.default_rate ?? '', budget_gbp: t.budget_gbp ?? '', theme: themeState(t.theme),
  };
}
function editView() {
  return `
    <div class="topbar"><button class="ghost" data-act="back">← Cancel</button></div>
    <h1>Edit trip</h1>
    ${tripFields('edit')}
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
    <div style="height:14px"></div>
    <button class="full" data-act="saveEdit">Save</button>`;
}
function saveEdit() {
  const x = S.edit; S.error = '';
  if (!x.name.trim()) { S.error = 'Give the trip a name.'; render(); return; }
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
      my_name: t.my_name || null, members, owner_hash: owner.hash, created_at: new Date().toISOString(),
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
    theme: themeValue(x.theme), notes: null, my_name: me, members, owner_hash: owner.hash, created_at: new Date().toISOString(),
  })));
  chooseMeAndOpen(code, me, owner.token);
}

function chooseMeAndOpen(code, me, token) {
  patchStore((s) => { s.trips[code] = { ...(s.trips[code] || {}), me: me || null, owner_token: token || undefined }; });
  location.hash = `t=${code}`;
}

function setMe(name) {
  patchStore((s) => { s.trips[S.code] = { ...(s.trips[S.code] || {}), me: name }; });
  S.me = name; S.view = 'trip'; S.tab = 'expenses'; S.error = '';
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
  S.expenses.forEach((e) => {
    const touches = e.paid_by === oldName || (e.participants || []).some((p) => p.name === oldName) || (e.items || []).some((i) => (i.names || []).includes(oldName));
    if (!touches) return;
    const { uid, ...rest } = e;
    batch.set(tripRef('expenses', uid), clean({
      ...rest, paid_by: sw(e.paid_by), updated_at: now,
      participants: (e.participants || []).map((p) => ({ ...p, name: sw(p.name) })),
      items: e.items ? e.items.map((i) => ({ ...i, names: (i.names || []).map(sw) })) : null,
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
  for (const sub of ['expenses', 'settlements', 'deleted', 'activity']) {
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

// ---------------------------------------------------------------- combined settle-up
function comboView() {
  const c = S.combo;
  const store = readStore();
  const known = Object.entries(store.trips);
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
      const [t, e, s] = await Promise.all([getDoc(doc(db, 'trips', code)), getDocs(collection(db, 'trips', code, 'expenses')), getDocs(collection(db, 'trips', code, 'settlements'))]);
      if (!t.exists || (typeof t.exists === 'function' && !t.exists())) continue;
      c.data[code] = { trip: t.data(), expenses: e.docs.map((d) => ({ ...d.data(), uid: d.id })), settlements: s.docs.map((d) => ({ ...d.data(), uid: d.id })) };
    }
  } catch (err) { c.error = `Couldn't load: ${err.message}`; }
  c.loaded = true; c.step = 'result';
  render();
}

// ---------------------------------------------------------------- events
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const d = el.dataset; const act = d.act;
  S.error = ''; S.notice = '';
  const f = S.form;
  switch (act) {
    case 'home': location.hash = ''; S.view = 'home'; leaveTrip(); render(); break;
    case 'back': S.view = 'trip'; S.edit = null; render(); break;
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
    case 'newMode': S.newMode = d.mode; S.error = ''; render(); break;
    case 'createBlank': await createBlank(); break;
    case 'iAm': setMe(d.name); break;
    case 'addMe': {
      const name = document.getElementById('newMe').value.trim();
      if (!name) { S.error = 'Type your name first.'; render(); break; }
      fireAndForget(setDoc(tripRef(), { members: arrayUnion(name) }, { merge: true }));
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
    case 'addItem': f.items.push({ description: '', amount: '', names: (S.trip.members || []).slice() }); render(); updateHints(); break;
    case 'removeItem': f.items.splice(Number(d.i), 1); if (!f.items.length) f.items.push({ description: '', amount: '', names: (S.trip.members || []).slice() }); render(); updateHints(); break;
    case 'itemWho': {
      const it = f.items[Number(d.i)];
      it.names = it.names.includes(d.name) ? it.names.filter((n) => n !== d.name) : [...it.names, d.name];
      render(); updateHints(); break;
    }
    case 'usePaste': {
      try {
        const r = parseReceiptBlock(f.paste || document.getElementById('f_paste').value, S.trip.members || []);
        f.items = r.items.map((i) => ({ description: i.description, amount: i.amount, names: i.names }));
        const isLocal = r.currency && r.currency !== 'GBP';
        if (r.total != null && f.orig_amount === '' && f.amount_gbp === '') {
          if (isLocal) { f.orig_amount = r.total; f.orig_currency = r.currency; } else f.amount_gbp = r.total;
        }
        f.pasteMsg = `Filled in ${r.items.length} items.${r.unknown.length ? ` I didn't recognise: ${r.unknown.join(', ')} - tap their items below to fix.` : ''}`;
      } catch (err) { f.pasteMsg = err.message; }
      render(); updateHints(); break;
    }
    case 'saveExpense': await saveExpense(); break;
    case 'deleteExpense':
      if (confirm(`Delete "${f.description}"?`)) {
        fireAndForget(deleteDoc(tripRef('expenses', f.uid)));
        fireAndForget(setDoc(tripRef('deleted', f.uid), { deleted_at: new Date().toISOString(), by: S.me }));
        logActivity(activityLine('deleted', S.me, `"${f.original?.description || f.description}"`, f.original ? money(f.original.amount_gbp) : ''), 'deleted');
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
      const all = computeAll(S.trip, S.expenses, S.settlements);
      const text = settleMessage(S.trip.name, all.transfers, all.total);
      if (navigator.share) { try { await navigator.share({ text }); } catch { /* cancelled */ } } else { try { await navigator.clipboard.writeText(text); S.notice = 'Copied - paste it into your group chat.'; } catch { S.notice = text; } render(); }
      break;
    }
    case 'addPerson': {
      const name = document.getElementById('addPerson').value.trim();
      if (name && !(S.trip.members || []).includes(name)) { fireAndForget(setDoc(tripRef(), { members: arrayUnion(name) }, { merge: true })); logActivity(activityLine('added', S.me, `${name} to the trip`), 'joined'); }
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

// Typing updates state without redrawing (a redraw would drop the keyboard).
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset.ci !== undefined) { S[t.dataset.f].theme.colors[Number(t.dataset.ci)] = t.value; return; }
  if (t.dataset.f && t.dataset.k) { S[t.dataset.f][t.dataset.k] = t.value; if (t.dataset.k === 'currency') S[t.dataset.f].currency = t.value.toUpperCase(); return; }
  const f = S.form;
  if (S.view !== 'form' || !f) return;
  if (t.id === 'f_paste') { f.paste = t.value; return; }
  if (t.id && t.id.startsWith('f_')) f[t.id.slice(2)] = t.value;
  else if (t.dataset.item !== undefined) f.items[Number(t.dataset.item)][t.dataset.field] = t.value;
  else if (t.dataset.val !== undefined) f.participants[t.dataset.val].value = t.value;
  updateHints();
});
document.addEventListener('change', (ev) => {
  const t = ev.target; const f = S.form;
  if (t.id === 'tripFile' && t.files[0]) { createFromFile(t.files[0]); return; }
  if (t.dataset.combo !== undefined) {
    const c = S.combo; c.selected = t.checked ? [...new Set([...c.selected, t.dataset.combo])] : c.selected.filter((x) => x !== t.dataset.combo); render(); return;
  }
  if (t.dataset.map !== undefined) { patchStore((s) => { if (t.value) s.nameMap[t.dataset.map] = t.value; else delete s.nameMap[t.dataset.map]; }); render(); return; }
  if (t.dataset.f && t.dataset.k) { S[t.dataset.f][t.dataset.k] = t.value; return; }
  if (S.view !== 'form' || !f) return;
  if (t.dataset.who !== undefined) { f.participants[t.dataset.who].on = t.checked; render(); updateHints(); }
  else if (t.id === 'f_paid_by') { f.paid_by = t.value; render(); updateHints(); }
});

routeFromHash();
render();
