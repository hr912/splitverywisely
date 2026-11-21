import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, deleteDoc, collection, onSnapshot, writeBatch, arrayUnion,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import {
  SPLIT_LABELS, clean, newCode, newUid, resolveAmounts, computeAll, buildTripFile, parseReceiptBlock, expenseSharesPence,
} from './logic.js';

// ---------------------------------------------------------------- setup
const app = initializeApp(firebaseConfig);
// Entries made with no signal wait on the phone and upload by themselves later.
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const STORE = 'svw-v1';
const readStore = () => { try { return JSON.parse(localStorage.getItem(STORE)) || { trips: {} }; } catch { return { trips: {} }; } };
const writeStore = (s) => { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* private mode etc. */ } };

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (Number(n) || 0).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const fmtNum = (n, cur) => `${Number(n).toFixed(2)} ${cur || ''}`.trim();

// ---------------------------------------------------------------- state
const S = {
  view: 'home', // home | new | who | trip | form
  tab: 'expenses', // expenses | balances | settle | share
  code: null, me: null,
  trip: null, expenses: [], settlements: [], deleted: [],
  pending: 0, loaded: false, missing: false,
  form: null, error: '', notice: '',
  newTrip: { mode: 'file', error: '' },
};
let unsubs = [];

// ---------------------------------------------------------------- opening a trip
function leaveTrip() {
  unsubs.forEach((u) => u());
  unsubs = [];
  Object.assign(S, { code: null, trip: null, expenses: [], settlements: [], deleted: [], loaded: false, missing: false, pending: 0 });
}

function openTrip(code) {
  leaveTrip();
  S.code = code;
  const store = readStore();
  S.me = store.trips[code]?.me || null;
  S.view = S.me ? 'trip' : 'who';
  const base = ['trips', code];
  unsubs.push(onSnapshot(doc(db, ...base), (snap) => {
    S.loaded = true;
    S.missing = !snap.exists();
    S.trip = snap.exists() ? snap.data() : null;
    if (S.trip) {
      const st = readStore();
      st.trips[code] = { ...(st.trips[code] || {}), name: S.trip.name };
      writeStore(st);
    }
    softRender();
  }, () => { S.loaded = true; softRender(); }));
  unsubs.push(onSnapshot(collection(db, ...base, 'expenses'), (snap) => {
    S.expenses = snap.docs.map((d) => ({ ...d.data(), uid: d.id }));
    S.pending = snap.docs.filter((d) => d.metadata.hasPendingWrites).length;
    softRender();
  }));
  unsubs.push(onSnapshot(collection(db, ...base, 'settlements'), (snap) => {
    S.settlements = snap.docs.map((d) => ({ ...d.data(), uid: d.id }));
    softRender();
  }));
  unsubs.push(onSnapshot(collection(db, ...base, 'deleted'), (snap) => {
    S.deleted = snap.docs.map((d) => d.id);
  }));
  render();
}

function routeFromHash() {
  const m = /[#&]t=([a-z0-9]+)/i.exec(location.hash);
  if (m) {
    openTrip(m[1].toLowerCase());
  } else if (S.view !== 'new') {
    leaveTrip();
    S.view = 'home';
    render();
  }
}
window.addEventListener('hashchange', routeFromHash);
window.addEventListener('online', render);
window.addEventListener('offline', render);

const tripLink = () => `${location.origin}${location.pathname}#t=${S.code}`;

// ---------------------------------------------------------------- rendering
function softRender() { if (S.view !== 'form') render(); }
function render() {
  if (S.view === 'home') $app.innerHTML = homeView();
  else if (S.view === 'new') $app.innerHTML = newView();
  else if (S.view === 'who') $app.innerHTML = whoView();
  else if (S.view === 'form') $app.innerHTML = formView();
  else $app.innerHTML = tripView();
}

function homeView() {
  const trips = Object.entries(readStore().trips);
  return `
    <h1>SplitVeryWisely</h1>
    <p class="sub">Share the cost of a trip with friends. Everyone sees every expense straight away.</p>
    ${trips.length ? `<h2>Your trips</h2>${trips.map(([code, t]) => `
      <button class="expense" data-act="open" data-code="${esc(code)}"><span class="title">${esc(t.name || 'Trip')}</span>
      <div class="muted">${t.me ? `You are ${esc(t.me)}` : 'Tap to choose who you are'}</div></button>`).join('')}` : ''}
    <h2>Join a trip</h2>
    <p class="sub">Open the link your friend sent you, or paste it (or just its code) here.</p>
    <input id="joinInput" placeholder="Paste the trip link or code" autocapitalize="off" autocorrect="off">
    <div style="height:10px"></div>
    <button class="full" data-act="join">Join</button>
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ''}
    <h2>Start a new trip</h2>
    <button class="secondary full" data-act="startNew">Start a new trip</button>`;
}

function newView() {
  const n = S.newTrip;
  return `
    <div class="topbar"><button class="ghost" data-act="home">← Back</button></div>
    <h1>Start a new trip</h1>
    <div class="seg">
      <button class="${n.mode === 'file' ? 'on' : ''}" data-act="newMode" data-mode="file">From a desktop trip file</button>
      <button class="${n.mode === 'blank' ? 'on' : ''}" data-act="newMode" data-mode="blank">From scratch</button>
    </div>
    ${n.mode === 'file' ? `
      <p class="sub" style="margin-top:12px">On the desktop app, open the trip and press <b>Save trip file</b>, send yourself the file, then choose it here. The trip, the people and any expenses you've already entered come across.</p>
      <input type="file" id="tripFile" accept=".json,application/json">`
    : `
      <label>Trip name</label><input id="nt_name" placeholder="e.g. Naples weekend">
      <label>Your name</label><input id="nt_me" placeholder="How your friends know you">
      <label>Friends (separate names with commas)</label><input id="nt_friends" placeholder="Jay, Ayush">
      <label>Local currency</label><input id="nt_cur" value="EUR" maxlength="5">
      <label>Approximate £ for 1 of that currency (optional)</label><input id="nt_rate" inputmode="decimal" placeholder="e.g. 0.85">
      <div style="height:14px"></div>
      <button class="full" data-act="createBlank">Create trip</button>`}
    ${n.error ? `<p class="error">${esc(n.error)}</p>` : ''}`;
}

function whoView() {
  if (!S.loaded) return '<p class="loading">Opening trip…</p>';
  if (S.missing || !S.trip) {
    return `<div class="topbar"><button class="ghost" data-act="home">← Back</button></div>
      <h1>Can't find that trip</h1>
      <p class="sub">${navigator.onLine ? 'Check the link, or ask your friend to send it again.' : 'You\'re offline - connect once to open a trip for the first time.'}</p>`;
  }
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

function syncBadge() {
  if (!navigator.onLine) return '<span class="badge">Offline - saved on this phone</span>';
  if (S.pending > 0) return `<span class="badge">${S.pending} waiting to upload</span>`;
  return '<span class="badge sync">Live</span>';
}

function tripView() {
  if (!S.loaded) return '<p class="loading">Opening trip…</p>';
  if (S.missing || !S.trip) return whoView();
  const t = S.trip;
  const all = computeAll(t, S.expenses, S.settlements);
  const meRow = all.people.find((p) => p.name === S.me);
  const body = S.tab === 'balances' ? balancesTab(all) : S.tab === 'settle' ? settleTab(all) : S.tab === 'share' ? shareTab() : expensesTab(all, meRow);
  return `
    <div class="topbar"><button class="ghost" data-act="home">← Trips</button><span class="grow"></span>${syncBadge()}</div>
    <h1>${esc(t.name)}</h1>
    <p class="sub">${[t.destination, t.start_date ? `${fmtDate(t.start_date)}${t.end_date ? ` – ${fmtDate(t.end_date)}` : ''}` : ''].filter(Boolean).map(esc).join(' · ')}${t.destination || t.start_date ? ' · ' : ''}You are <b>${esc(S.me)}</b></p>
    ${S.notice ? `<div class="alert">${esc(S.notice)}</div>` : ''}
    ${body}
    ${S.tab === 'expenses' ? '<button class="fab" data-act="addExpense">+ Add expense</button>' : ''}
    <nav class="tabs">
      ${[['expenses', 'Expenses'], ['balances', 'Balances'], ['settle', 'Settle up'], ['share', 'Share']]
    .map(([k, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}
    </nav>`;
}

function estimateAlert(all) {
  if (!all.estimatedCount) return '';
  const byPayer = {};
  S.expenses.filter((e) => e.gbp_estimated).forEach((e) => { (byPayer[e.paid_by] ||= []).push(e); });
  return `<div class="alert"><b>${all.estimatedCount} amount${all.estimatedCount === 1 ? ' is' : 's are'} only estimated</b> (${money(all.estimatedGbp)}).
    Only the person who paid knows the real pounds - ask them, then tap the expense and type them in.<br>
    ${Object.entries(byPayer).map(([n, l]) => `${esc(n === S.me ? 'You' : n)}: ${l.map((e) => esc(e.description)).join(', ')}`).join('<br>')}</div>`;
}

function expensesTab(all, meRow) {
  const list = S.expenses.slice().sort((a, b) => String(b.expense_date || '').localeCompare(String(a.expense_date || '')) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return `
    <div class="stat-row">
      <div class="card"><div class="label">Trip total</div><div class="big num">${money(all.total)}</div></div>
      <div class="card"><div class="label">Your share</div><div class="big num">${money(meRow?.share || 0)}</div></div>
    </div>
    ${estimateAlert(all)}
    ${list.length === 0 ? '<p class="sub">Nothing yet - tap "Add expense".</p>' : list.map((e) => {
    const mine = (all.shareByExpense[e.uid] || {})[S.me];
    return `<button class="expense" data-act="editExpense" data-uid="${esc(e.uid)}">
        <div class="row between"><span class="title grow">${esc(e.description)}</span><span class="num"><b>${money(e.amount_gbp)}</b></span></div>
        <div class="row between muted"><span>${esc(fmtDate(e.expense_date))}${e.expense_date ? ' · ' : ''}${esc(e.paid_by === S.me ? 'You paid' : `${e.paid_by} paid`)}${e.category ? ` · ${esc(e.category)}` : ''}</span>
          <span class="num">${e.orig_amount ? esc(fmtNum(e.orig_amount, e.orig_currency)) : ''}</span></div>
        <div class="row between muted"><span>${e.gbp_estimated ? '<span class="badge">estimated £</span> ' : ''}${esc(SPLIT_LABELS[e.split_type] || '')}${all.problems[e.uid] ? ' · <span class="neg">check the split</span>' : ''}</span>
          <span class="num">${mine != null ? `Your share ${money(mine / 100)}` : 'Not in your share'}</span></div>
      </button>`;
  }).join('')}`;
}

function balancesTab(all) {
  const max = Math.max(0, ...all.byCategory.map((c) => c.total));
  return `
    ${estimateAlert(all)}
    <h2>Who owes what</h2>
    ${all.people.map((p) => `<div class="card"><div class="row between"><b>${esc(p.name === S.me ? `${p.name} (you)` : p.name)}</b>
      <span class="${p.net > 0.004 ? 'pos' : p.net < -0.004 ? 'neg' : 'muted'} num">${Math.abs(p.net) < 0.005 ? 'All square' : p.net > 0 ? `Is owed ${money(p.net)}` : `Owes ${money(-p.net)}`}</span></div>
      <div class="muted num">Paid ${money(p.paid)} · Their share ${money(p.share)}${p.settled ? ` · Payments ${money(p.settled)}` : ''}</div></div>`).join('')}
    <h2>Where the money went</h2>
    ${all.byCategory.length === 0 ? '<p class="sub">Nothing yet.</p>' : all.byCategory.map((c) => `
      <div class="row between"><span>${esc(c.name)}</span><span class="num">${money(c.total)}${all.total ? ` · ${Math.round((c.total / all.total) * 100)}%` : ''}</span></div>
      <div class="bar"><div style="width:${max ? (c.total / max) * 100 : 0}%"></div></div>`).join('')}`;
}

function settleTab(all) {
  return `
    ${estimateAlert(all)}
    <h2>Who pays whom</h2>
    <p class="sub">The fewest payments that clear everything. People who owe pay people who are owed - nobody has to pay back exactly who paid for them. Always in pounds.</p>
    ${all.transfers.length === 0 ? `<p class="sub">${S.expenses.length ? 'Everyone is all square.' : 'Nothing to settle yet.'}</p>` : all.transfers.map((t) => `
      <div class="card"><div class="row between"><span><b>${esc(t.from === S.me ? 'You' : t.from)}</b> pay${t.from === S.me ? '' : 's'} <b>${esc(t.to === S.me ? 'you' : t.to)}</b></span><b class="num">${money(t.amount_gbp)}</b></div>
      <div style="height:8px"></div><button class="secondary" data-act="settle" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amt="${t.amount_gbp.toFixed(2)}">Mark as paid</button></div>`).join('')}
    ${S.settlements.length ? `<h2>Payments recorded</h2>${S.settlements.map((s) => `
      <div class="row between" style="padding:6px 0"><span>${esc(s.settle_date ? fmtDate(s.settle_date) + ' · ' : '')}${esc(s.from)} paid ${esc(s.to)} <b class="num">${money(s.amount_gbp)}</b></span>
      <button class="danger" data-act="undoSettle" data-uid="${esc(s.uid)}">Undo</button></div>`).join('')}` : ''}`;
}

function shareTab() {
  const t = S.trip;
  return `
    <h2>Invite friends</h2>
    <p class="sub">Anyone with this link sees and edits the trip. They tap their name the first time they open it.</p>
    <div class="card"><div class="muted" style="word-break:break-all">${esc(tripLink())}</div></div>
    <button class="full" data-act="shareLink">Share the link</button>
    <div style="height:8px"></div>
    <button class="secondary full" data-act="copyLink">Copy the link</button>
    <h2>People on this trip</h2>
    <div class="chips">${(t.members || []).map((m) => `<span class="chip ${m === S.me ? 'on' : ''}">${esc(m)}</span>`).join('')}</div>
    <div class="row" style="margin-top:10px"><input id="addPerson" placeholder="Add someone"><button data-act="addPerson">Add</button></div>
    <h2>For the desktop app</h2>
    <p class="sub">Save a file with everything in the trip, then use <b>Import trip file</b> on the desktop app. Importing it twice never duplicates anything.</p>
    <button class="secondary full" data-act="exportFile">Save trip file</button>
    <h2>This phone</h2>
    <button class="ghost" data-act="changeMe">I'm not ${esc(S.me)} - change who I am</button>`;
}

// ---------------------------------------------------------------- expense form
function blankForm() {
  const t = S.trip;
  const members = t.members || [];
  return {
    uid: null, description: '', expense_date: todayIso(), category: '', amount_gbp: '', orig_amount: '',
    orig_currency: t.currency, rate: '', paid_by: S.me, split_type: 'equal',
    participants: Object.fromEntries(members.map((m) => [m, { on: true, value: '' }])),
    items: [{ description: '', amount: '', names: members.slice() }],
    notes: '', paste: '', pasteMsg: '',
  };
}
function formFromExpense(e) {
  const members = S.trip.members || [];
  const participants = Object.fromEntries(members.map((m) => [m, { on: false, value: '' }]));
  (e.participants || []).forEach((p) => { participants[p.name] = { on: true, value: p.value ?? '' }; });
  return {
    uid: e.uid, description: e.description, expense_date: e.expense_date || '', category: e.category || '',
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
    <select id="f_category"><option value="">(none)</option>${(t.categories || []).map((c) => `<option ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
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
      <p class="sub" style="margin-top:10px">Add each item and tap who had it. Service charge, VAT or tip that the items don't cover is shared in proportion to what each person had. Skipped the service? Make the bill match the items. Item amounts are in <b>${esc(itemCur === 'GBP' ? '£' : itemCur)}</b>.</p>
      ${f.items.map((it, i) => `<div class="item">
        <div class="row"><input data-item="${i}" data-field="description" value="${esc(it.description)}" placeholder="Item"><input data-item="${i}" data-field="amount" inputmode="decimal" value="${esc(it.amount)}" placeholder="0.00" style="max-width:110px">
        <button type="button" class="danger" data-act="removeItem" data-i="${i}">✕</button></div>
        <div class="chips" style="margin-top:8px">${members.map((m) => `<button type="button" class="chip ${(it.names || []).includes(m) ? 'on' : ''}" data-act="itemWho" data-i="${i}" data-name="${esc(m)}">${esc(m)}</button>`).join('')}</div></div>`).join('')}
      <button type="button" class="secondary" data-act="addItem">+ Add item</button>
      <div id="itemsHint" class="sub" style="margin-top:8px"></div>
      <label>Paste from Claude (optional)</label>
      <textarea id="f_paste" placeholder="Paste the receipt block Claude gave you">${esc(f.paste)}</textarea>
      <div style="height:8px"></div><button type="button" class="secondary" data-act="usePaste">Fill in the items</button>
      ${f.pasteMsg ? `<p class="sub">${esc(f.pasteMsg)}</p>` : ''}`
    : `
      <p class="sub" style="margin-top:10px">Who is it split between?</p>
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

// ---------------------------------------------------------------- actions
const tripRef = (...p) => doc(db, 'trips', S.code, ...p);
const fireAndForget = (p) => p.catch((err) => { S.error = `Couldn't save: ${err.message}`; render(); });

async function saveExpense() {
  S.error = '';
  try {
    const e = payloadFromForm();
    expenseSharesPence({ ...e }); // throws a plain message if the split doesn't add up
    fireAndForget(setDoc(tripRef('expenses', e.uid), clean(e)));
    S.form = null; S.view = 'trip';
  } catch (err) {
    S.error = err.message;
  }
  render();
}

async function createFromFile(file) {
  const n = S.newTrip; n.error = '';
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'finance-tracker-trip' || !data.trip) throw new Error('That isn\'t a trip file from the desktop app.');
    const code = newCode();
    const t = data.trip;
    const members = Array.from(new Set([...(data.members || []), t.my_name].filter(Boolean)));
    const batch = writeBatch(db);
    batch.set(doc(db, 'trips', code), clean({
      uid: t.uid, name: t.name, destination: t.destination || null, start_date: t.start_date || null, end_date: t.end_date || null,
      status: t.status || 'Planning', currency: t.currency || 'EUR', default_rate: t.default_rate || null, notes: t.notes || null,
      my_name: t.my_name || null, members, categories: data.categories || [], created_at: new Date().toISOString(),
    }));
    (data.expenses || []).forEach((e) => batch.set(doc(db, 'trips', code, 'expenses', e.uid || newUid()), clean(e)));
    (data.settlements || []).forEach((s) => batch.set(doc(db, 'trips', code, 'settlements', s.uid || newUid()), clean(s)));
    fireAndForget(batch.commit());
    chooseMeAndOpen(code, t.my_name);
  } catch (err) {
    n.error = err.message || String(err);
    render();
  }
}

function createBlank() {
  const v = (id) => document.getElementById(id)?.value.trim() || '';
  const n = S.newTrip; n.error = '';
  const name = v('nt_name'); const me = v('nt_me');
  if (!name || !me) { n.error = 'Give the trip a name and say who you are.'; render(); return; }
  const friends = v('nt_friends').split(',').map((x) => x.trim()).filter(Boolean);
  const members = Array.from(new Set([me, ...friends]));
  const code = newCode();
  fireAndForget(setDoc(doc(db, 'trips', code), clean({
    uid: newUid(), name, destination: null, start_date: null, end_date: null, status: 'Planning',
    currency: (v('nt_cur') || 'EUR').toUpperCase(), default_rate: Number(v('nt_rate')) > 0 ? Number(v('nt_rate')) : null,
    notes: null, my_name: me, members, categories: DEFAULT_CATEGORIES, created_at: new Date().toISOString(),
  })));
  chooseMeAndOpen(code, me);
}
const DEFAULT_CATEGORIES = ['Food & Drink', 'Transport', 'Accommodation', 'Activities', 'Shopping', 'Other'];

function chooseMeAndOpen(code, me) {
  const st = readStore();
  st.trips[code] = { ...(st.trips[code] || {}), me: me || null };
  writeStore(st);
  location.hash = `t=${code}`;
}

function setMe(name) {
  const st = readStore();
  st.trips[S.code] = { ...(st.trips[S.code] || {}), me: name };
  writeStore(st);
  S.me = name; S.view = 'trip'; S.tab = 'expenses'; S.error = '';
  render();
}

async function exportFile() {
  const file = buildTripFile({ ...S.trip }, S.expenses, S.settlements, S.deleted);
  const name = `${(S.trip.name || 'trip').replace(/[^\w\- ]+/g, '').trim() || 'trip'}.trip.json`;
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const f = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: name }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  S.notice = `Saved ${name}`; render();
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
    case 'open': location.hash = `t=${d.code}`; break;
    case 'join': {
      const raw = document.getElementById('joinInput').value.trim();
      const m = /t=([a-z0-9]+)/i.exec(raw) || /^([a-z0-9]{8,})$/i.exec(raw);
      if (!m) { S.error = 'That doesn\'t look like a trip link or code.'; render(); break; }
      location.hash = `t=${m[1].toLowerCase()}`;
      break;
    }
    case 'startNew': S.view = 'new'; S.newTrip = { mode: 'file', error: '' }; render(); break;
    case 'newMode': S.newTrip.mode = d.mode; S.newTrip.error = ''; render(); break;
    case 'createBlank': createBlank(); break;
    case 'iAm': setMe(d.name); break;
    case 'addMe': {
      const name = document.getElementById('newMe').value.trim();
      if (!name) { S.error = 'Type your name first.'; render(); break; }
      fireAndForget(setDoc(tripRef(), { members: arrayUnion(name) }, { merge: true }));
      setMe(name);
      break;
    }
    case 'tab': S.tab = d.tab; render(); window.scrollTo(0, 0); break;
    case 'addExpense': S.form = blankForm(); S.view = 'form'; render(); window.scrollTo(0, 0); updateHints(); break;
    case 'editExpense': S.form = formFromExpense(S.expenses.find((e) => e.uid === d.uid)); S.view = 'form'; render(); window.scrollTo(0, 0); updateHints(); break;
    case 'cancelForm': S.form = null; S.view = 'trip'; render(); break;
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
        S.form = null; S.view = 'trip';
      }
      render(); break;
    case 'settle':
      fireAndForget(setDoc(tripRef('settlements', newUid()), clean({
        from: d.from, to: d.to, amount_gbp: Number(d.amt), settle_date: todayIso(), notes: null,
      })));
      break;
    case 'undoSettle': fireAndForget(deleteDoc(tripRef('settlements', d.uid))); break;
    case 'addPerson': {
      const input = document.getElementById('addPerson'); const name = input.value.trim();
      if (name) fireAndForget(setDoc(tripRef(), { members: arrayUnion(name) }, { merge: true }));
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
    default: break;
  }
});

// Typing updates the form's state without redrawing (a redraw would drop the keyboard).
document.addEventListener('input', (ev) => {
  const f = S.form; const t = ev.target;
  if (S.view !== 'form' || !f) return;
  if (t.id === 'f_paste') { f.paste = t.value; return; }
  if (t.id && t.id.startsWith('f_')) f[t.id.slice(2)] = t.value;
  else if (t.dataset.item !== undefined) f.items[Number(t.dataset.item)][t.dataset.field] = t.value;
  else if (t.dataset.val !== undefined) f.participants[t.dataset.val].value = t.value;
  updateHints();
});
document.addEventListener('change', (ev) => {
  const f = S.form; const t = ev.target;
  if (t.id === 'tripFile' && t.files[0]) { createFromFile(t.files[0]); return; }
  if (S.view !== 'form' || !f) return;
  if (t.dataset.who !== undefined) { f.participants[t.dataset.who].on = t.checked; render(); updateHints(); }
  else if (t.id === 'f_paid_by') { f.paid_by = t.value; render(); updateHints(); }
});

routeFromHash();
render();
