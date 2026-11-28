// Everything the phone app calculates, with no screen or database in it, so it
// can be tested on its own. Mirrors the desktop app's rules (see
// electron/main.js: resolveTripAmounts, computeTripDetail).
import {
  toPence, toPounds, allocate, splitAmount, splitItemised, splitItemisedLocal, simplifyDebts,
} from './trip-math.js';
import { CATEGORIES } from './categories.js';

export const SPLIT_LABELS = {
  equal: 'Equally',
  exact: 'Exact amounts',
  percent: 'By percentage',
  shares: 'By shares',
  items: 'By item (receipt)',
};

const clean = (o) => JSON.parse(JSON.stringify(o));
export { clean };

export function newCode() {
  const bytes = new Uint8Array(12);
  (globalThis.crypto || {}).getRandomValues?.(bytes);
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
export const newUid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${newCode()}`);

// Pounds are the truth. Pounds given -> confirmed. Local amount only ->
// pounds ESTIMATED from the rate (and flagged until the payer gives the real figure).
export function resolveAmounts(trip, f) {
  const gbp = f.amount_gbp === '' || f.amount_gbp == null ? null : Number(f.amount_gbp);
  const orig = f.orig_amount === '' || f.orig_amount == null ? null : Number(f.orig_amount);
  const cur = String(f.orig_currency || trip.currency || '').trim().toUpperCase() || null;
  if (gbp != null && gbp > 0) {
    return {
      amount_gbp: Math.round(gbp * 100) / 100, gbp_estimated: false,
      orig_amount: orig > 0 ? orig : null, orig_currency: orig > 0 ? cur : null,
      rate: orig > 0 ? gbp / orig : null,
    };
  }
  if (orig != null && orig > 0) {
    const rate = Number(f.rate) > 0 ? Number(f.rate) : Number(trip.default_rate);
    if (!(rate > 0)) throw new Error('Enter the amount in pounds, or set an approximate rate for the trip.');
    return {
      amount_gbp: Math.round(orig * rate * 100) / 100, gbp_estimated: true,
      orig_amount: orig, orig_currency: cur, rate,
    };
  }
  throw new Error('Enter the amount - in pounds, or in the local currency.');
}

// What the group really pays for an expense once any cashback is taken off (in pence).
export const effPence = (e) => toPence(e.amount_gbp) - toPence(e.cashback_gbp || 0);

// Items with everyone's picks folded in: friends tick what they had ("claims": { name: [item numbers] }), and that is added
// to whoever the creator named on the item.
export function effectiveItems(e) {
  const claims = e.claims || {};
  return (e.items || []).map((it, i) => {
    const names = new Set(it.names || []);
    Object.entries(claims).forEach(([n, idx]) => { if (Array.isArray(idx) && idx.includes(i)) names.add(n); });
    return { ...it, names: [...names] };
  });
}
// Items nobody has picked yet, on a receipt left open for friends to pick.
export const unclaimedItems = (e) => (e.split_type === 'items' && e.claim_open
  ? effectiveItems(e).map((it, i) => ({ ...it, i })).filter((it) => !it.names.length && Number(it.amount) > 0)
  : []);

// Pence each person owes for one expense, keyed by name. Throws a plain message if the split doesn't add up.
// Cashback is shared out in proportion to everyone's share. Items nobody has picked yet count against whoever paid until picked.
export function expenseSharesPence(e) {
  const amountPence = toPence(e.amount_gbp);
  let shares;
  if (e.split_type === 'items') {
    const open = !!e.claim_open;
    const items = effectiveItems(e).map((it) => ({
      description: it.description, amountPence: toPence(it.amount), memberIds: it.names.length || !open ? it.names : [e.paid_by],
    }));
    const local = (e.items || []).some((it) => it.in_local) && e.orig_amount > 0;
    shares = local
      ? splitItemisedLocal({ totalGbpPence: amountPence, totalLocalPence: toPence(e.orig_amount), items, payerId: e.paid_by })
      : splitItemised({ totalPence: amountPence, items, payerId: e.paid_by }).shares;
  } else {
    shares = splitAmount({
      amountPence, splitType: e.split_type, payerId: e.paid_by,
      participants: (e.participants || []).map((p) => ({ memberId: p.name, value: p.value })),
    });
  }
  const cb = toPence(e.cashback_gbp || 0);
  if (cb > 0 && cb < amountPence) {
    const names = Object.keys(shares);
    const parts = allocate(amountPence - cb, names.map((n) => ({ id: n, weight: shares[n] })), e.paid_by);
    return Object.fromEntries(names.map((n) => [n, parts[n]]));
  }
  return shares;
}

export function computeAll(trip, expenses, settlements, adjustments = []) {
  const names = new Set(trip.members || []);
  expenses.forEach((e) => { names.add(e.paid_by); (e.participants || []).forEach((p) => names.add(p.name)); });
  settlements.forEach((s) => { names.add(s.from); names.add(s.to); });
  const carried = {};
  (adjustments || []).forEach((a) => (a.items || []).forEach((i) => { names.add(i.name); carried[i.name] = (carried[i.name] || 0) + toPence(i.amount); }));
  const paid = {}; const share = {}; const net = {}; const settled = {};
  names.forEach((n) => { paid[n] = 0; share[n] = 0; settled[n] = 0; });
  const byCategory = {};
  const shareByExpense = {}; const problems = {};
  let total = 0; let estimatedCount = 0; let estimatedPence = 0;
  expenses.forEach((e) => {
    const amt = effPence(e);
    total += amt;
    if (e.gbp_estimated) { estimatedCount += 1; estimatedPence += amt; }
    paid[e.paid_by] = (paid[e.paid_by] || 0) + amt;
    try {
      const s = expenseSharesPence(e);
      shareByExpense[e.uid] = s;
      Object.entries(s).forEach(([n, p]) => { share[n] = (share[n] || 0) + p; });
    } catch (err) {
      problems[e.uid] = err.message;
    }
    const cat = e.category || 'Uncategorised';
    byCategory[cat] = (byCategory[cat] || 0) + amt;
  });
  // A payment someone says they made (running tabs) counts straight away (it is shown as not yet confirmed), and comes off again if the
  // person it went to says they haven't received it ("disputed").
  settlements.filter((s) => s.status !== 'disputed').forEach((s) => {
    const a = toPence(s.amount_gbp);
    settled[s.from] = (settled[s.from] || 0) + a;
    settled[s.to] = (settled[s.to] || 0) - a;
  });
  names.forEach((n) => { net[n] = paid[n] - share[n] + settled[n] + (carried[n] || 0); });
  return {
    people: [...names].map((n) => ({
      name: n, paid: toPounds(paid[n]), share: toPounds(share[n]), settled: toPounds(settled[n]), carried: toPounds(carried[n] || 0), net: toPounds(net[n]),
    })),
    transfers: simplifyDebts(net).map((t) => ({ from: t.from, to: t.to, amount_gbp: toPounds(t.pence) })),
    byCategory: Object.entries(byCategory).map(([name, p]) => ({ name, total: toPounds(p) })).sort((a, b) => b.total - a.total),
    total: toPounds(total),
    estimatedCount,
    estimatedGbp: toPounds(estimatedPence),
    shareByExpense,
    problems,
  };
}

// "Directly between people": for every pair, only what is between those two (what each owes the other from the expenses
// one paid for the other, less payments made between them) - no re-routing through a third person.
export function pairwiseTransfers(trip, expenses, settlements) {
  const all = computeAll(trip, expenses, settlements, []);
  const owe = {};
  const add = (a, b, p) => { owe[a] = owe[a] || {}; owe[a][b] = (owe[a][b] || 0) + p; };
  const names = new Set(all.people.map((p) => p.name));
  expenses.forEach((e) => {
    const s = all.shareByExpense[e.uid];
    if (!s) return;
    Object.entries(s).forEach(([n, p]) => { if (n !== e.paid_by && p > 0) add(n, e.paid_by, p); });
  });
  settlements.filter((x) => x.status !== 'disputed').forEach((x) => add(x.from, x.to, -toPence(x.amount_gbp)));
  const list = [...names].sort();
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]; const b = list[j];
      const net = ((owe[a] || {})[b] || 0) - ((owe[b] || {})[a] || 0);
      if (net >= 1) out.push({ from: a, to: b, amount_gbp: toPounds(net) });
      else if (net <= -1) out.push({ from: b, to: a, amount_gbp: toPounds(-net) });
    }
  }
  return out.sort((x, y) => y.amount_gbp - x.amount_gbp);
}

// The same file the desktop app saves/imports ("Save trip file" / "Import trip file").
export function buildTripFile(trip, expenses, settlements, deletedUids) {
  const strip = (e) => {
    const { _pending, claims, ...rest } = e;
    if (rest.items) rest.items = effectiveItems(e).map((it) => ({ ...it }));
    return rest;
  };
  return clean({
    format: 'finance-tracker-trip',
    version: 1,
    exported_at: new Date().toISOString(),
    trip: {
      uid: trip.uid, name: trip.name, destination: trip.destination || null, start_date: trip.start_date || null,
      end_date: trip.end_date || null, status: trip.status || 'Planning', currency: trip.currency,
      default_rate: trip.default_rate || null, notes: trip.notes || null, my_name: trip.my_name || null,
      theme: trip.theme || null, budget_gbp: trip.budget_gbp || null, kind: trip.kind || null,
    },
    members: trip.members || [],
    member_ids: trip.member_ids || {},
    categories: trip.categories || [],
    expenses: expenses.map(strip),
    settlements,
    deleted_uids: deletedUids || [],
  });
}

// Closest-name matching: exact (ignoring case) first, then a unique near match
// ("Arn" -> Arnav, "Aayush" -> Ayush, "Arnav L." -> Arnav). Several possible people = ambiguous, never a guess.
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const within1 = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1; if (edits > 1) return false;
    if (a.length > b.length) i += 1; else if (a.length < b.length) j += 1; else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};
export function matchName(given, members) {
  const g = String(given ?? '').trim();
  if (!g) return { kind: 'none' };
  const exact = members.find((m) => m.toLowerCase() === g.toLowerCase());
  if (exact) return { kind: 'exact', name: exact };
  const ng = norm(g);
  if (!ng) return { kind: 'none' };
  const hits = members.filter((m) => {
    const nm = norm(m); const first = norm(m.split(/\s+/)[0]);
    if (nm === ng || first === ng) return true;
    if (ng.length >= 3 && (nm.startsWith(ng) || first.startsWith(ng))) return true;
    if (first.length >= 3 && ng.startsWith(first)) return true;
    return ng.length >= 4 && (within1(nm, ng) || within1(first, ng));
  });
  if (hits.length === 1) return { kind: 'fuzzy', name: hits[0] };
  if (hits.length > 1) return { kind: 'ambiguous', options: hits };
  return { kind: 'unknown' };
}

const validIso = (s) => {
  if (!s) return null;
  let v = String(s).trim();
  const dmy = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(v);
  if (dmy) v = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
};

// Reads the block Claude gives back for a receipt photo. Tolerates ``` fences and chatter around the JSON.
// Besides the items and total it can carry the place, date, category, who paid, the pounds paid and notes.
// Names are matched closely, never guessed: anything unclear is reported so the person can tap the right one.
export function parseReceiptBlock(text, memberNames) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Couldn\'t find the receipt block - paste exactly what Claude gave you.');
  let data;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('That block isn\'t readable - ask Claude to give it again.'); }
  if (!Array.isArray(data.items) || data.items.length === 0) throw new Error('No items found in that block.');
  const unknown = []; const fuzzy = []; const ambiguous = [];
  const resolve = (n) => {
    const m = matchName(n, memberNames);
    if (m.kind === 'exact') return m.name;
    if (m.kind === 'fuzzy') { if (!fuzzy.some((x) => x.given === n)) fuzzy.push({ given: n, matched: m.name }); return m.name; }
    if (m.kind === 'ambiguous') { if (!ambiguous.some((x) => x.given === n)) ambiguous.push({ given: n, options: m.options }); return null; }
    if (m.kind === 'unknown' && !unknown.includes(n)) unknown.push(n);
    return null;
  };
  const items = data.items.map((it) => {
    const given = Array.isArray(it.names) ? it.names : (it.who ? [it.who] : []);
    const names = [...new Set(given.map(resolve).filter(Boolean))];
    const left = it.unclaimed === true || it.names === null; // "nobody yet" - friends pick it themselves (an empty list still means everyone)
    return {
      description: String(it.description || it.name || '').trim(),
      amount: Number(it.amount),
      was: Number(it.was ?? it.original_price ?? it.orig_price) > Number(it.amount) ? Number(it.was ?? it.original_price ?? it.orig_price) : null,
      names: names.length ? names : (given.length || left ? [] : memberNames.slice()),
      left,
    };
  });
  const cat = CATEGORIES.find((c) => c.name.toLowerCase() === String(data.category || '').trim().toLowerCase());
  const sub = cat && data.subtype ? cat.subs.find((s) => s[0].toLowerCase() === String(data.subtype).trim().toLowerCase()) : null;
  const payer = data.paid_by ? resolve(data.paid_by) : null;
  const gbp = Number(data.paid_gbp);
  const extras = Array.isArray(data.extras)
    ? data.extras.map((x) => ({ label: String(x.label || x.name || 'Extra').trim(), amount: Number(x.amount) })).filter((x) => x.amount > 0)
    : [];
  return {
    items, extras, unknown, fuzzy, ambiguous,
    total: data.total != null && data.total !== '' ? Number(data.total) : null,
    currency: data.currency ? String(data.currency).toUpperCase() : null,
    place: data.place ? String(data.place).trim() : null,
    date: validIso(data.date),
    category: cat ? cat.name : null,
    subtype: sub ? sub[0] : null,
    paid_by: payer,
    paid_gbp: gbp > 0 ? gbp : null,
    claim: data.claim === true || items.some((i) => i.left),
    gift_card: Number(data.gift_card_gbp ?? data.gift_card) > 0 ? Number(data.gift_card_gbp ?? data.gift_card) : null,
    cashback_pct: Number(data.cashback_pct) > 0 ? Number(data.cashback_pct) : null,
    notes: data.notes ? String(data.notes).trim() : null,
  };
}
