// Everything the phone app calculates, with no screen or database in it, so it
// can be tested on its own. Mirrors the desktop app's rules (see
// electron/main.js: resolveTripAmounts, computeTripDetail).
import {
  toPence, toPounds, splitAmount, splitItemised, splitItemisedLocal, simplifyDebts,
} from './trip-math.js';

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

export function computeAll(trip, expenses, settlements) {
  const names = new Set(trip.members || []);
  expenses.forEach((e) => { names.add(e.paid_by); (e.participants || []).forEach((p) => names.add(p.name)); });
  settlements.forEach((s) => { names.add(s.from); names.add(s.to); });
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
  settlements.forEach((s) => {
    const a = toPence(s.amount_gbp);
    settled[s.from] = (settled[s.from] || 0) + a;
    settled[s.to] = (settled[s.to] || 0) - a;
  });
  names.forEach((n) => { net[n] = paid[n] - share[n] + settled[n]; });
  return {
    people: [...names].map((n) => ({
      name: n, paid: toPounds(paid[n]), share: toPounds(share[n]), settled: toPounds(settled[n]), net: toPounds(net[n]),
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
    },
    members: trip.members || [],
    categories: trip.categories || [],
    expenses: expenses.map(strip),
    settlements,
    deleted_uids: deletedUids || [],
  });
}

// Reads the block Claude gives back for a receipt photo. Tolerates ``` fences
// and chatter around the JSON. Names that aren't on the trip are reported, not guessed.
export function parseReceiptBlock(text, memberNames) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Couldn\'t find the receipt block - paste exactly what Claude gave you.');
  let data;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('That block isn\'t readable - ask Claude to give it again.'); }
  if (!Array.isArray(data.items) || data.items.length === 0) throw new Error('No items found in that block.');
  const byLower = Object.fromEntries(memberNames.map((n) => [n.toLowerCase(), n]));
  const unknown = [];
  const items = data.items.map((it) => {
    const given = Array.isArray(it.names) ? it.names : (it.who ? [it.who] : []);
    const names = [];
    given.forEach((n) => {
      const hit = byLower[String(n).trim().toLowerCase()];
      if (hit) names.push(hit); else if (!unknown.includes(n)) unknown.push(n);
    });
    return {
      description: String(it.description || it.name || '').trim(),
      amount: Number(it.amount),
      names: names.length ? names : (given.length ? [] : memberNames.slice()),
    };
  });
  return {
    items, unknown,
    total: data.total != null && data.total !== '' ? Number(data.total) : null,
    currency: data.currency ? String(data.currency).toUpperCase() : null,
  };
}
