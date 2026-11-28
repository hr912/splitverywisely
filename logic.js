// Everything the phone app calculates, with no screen or database in it, so it
// can be tested on its own. Mirrors the desktop app's rules (see
// electron/main.js: resolveTripAmounts, computeTripDetail).
import {
  toPence, toPounds, splitAmount, splitItemised, splitItemisedLocal, simplifyDebts,
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

// Pence each person owes for one expense, keyed by name. Throws a plain message if the split doesn't add up.
export function expenseSharesPence(e) {
  const amountPence = toPence(e.amount_gbp);
  if (e.split_type === 'items') {
    const items = (e.items || []).map((it) => ({
      description: it.description, amountPence: toPence(it.amount), memberIds: it.names || [],
    }));
    const local = (e.items || []).some((it) => it.in_local) && e.orig_amount > 0;
    return local
      ? splitItemisedLocal({ totalGbpPence: amountPence, totalLocalPence: toPence(e.orig_amount), items, payerId: e.paid_by })
      : splitItemised({ totalPence: amountPence, items, payerId: e.paid_by }).shares;
  }
  return splitAmount({
    amountPence, splitType: e.split_type, payerId: e.paid_by,
    participants: (e.participants || []).map((p) => ({ memberId: p.name, value: p.value })),
  });
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
    const amt = toPence(e.amount_gbp);
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
  // A payment someone says they made (running tabs) only counts once the person it went to has confirmed it.
  settlements.filter((s) => !s.status || s.status === 'confirmed').forEach((s) => {
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

// The same file the desktop app saves/imports ("Save trip file" / "Import trip file").
export function buildTripFile(trip, expenses, settlements, deletedUids) {
  const strip = (e) => {
    const { _pending, ...rest } = e;
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
    return {
      description: String(it.description || it.name || '').trim(),
      amount: Number(it.amount),
      names: names.length ? names : (given.length ? [] : memberNames.slice()),
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
    notes: data.notes ? String(data.notes).trim() : null,
  };
}
