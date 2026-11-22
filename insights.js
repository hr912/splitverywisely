// Calculations behind the Summary page, the Activity log, combined settle-up
// across trips, the WhatsApp message and the duplicate warning. No screen, no database.
import { toPence, toPounds, simplifyDebts } from './trip-math.js';
import { computeAll } from './logic.js';

const fmt = (n) => (Number(n) || 0).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });

const isoAdd = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

// Summary page numbers. `today` is an ISO date (pinned in tests).
export function summarize(trip, expenses, all, today) {
  const start = trip.start_date || null;
  const end = trip.end_date || start;
  const days = [];
  let before = 0; let after = 0; let inTrip = 0;
  const perDay = {};
  expenses.forEach((e) => {
    const amt = toPence(e.amount_gbp);
    const d = e.expense_date || null;
    if (start && (!d || d < start)) { before += amt; return; }
    if (start && end && d > end) { after += amt; return; }
    inTrip += amt;
    const key = d || 'undated';
    perDay[key] = (perDay[key] || 0) + amt;
  });
  if (start && end) {
    const n = Math.max(1, daysBetween(start, end) + 1);
    for (let i = 0; i < Math.min(n, 60); i += 1) {
      const d = isoAdd(start, i);
      days.push({ date: d, total: toPounds(perDay[d] || 0) });
    }
  } else {
    Object.keys(perDay).sort().forEach((d) => days.push({ date: d, total: toPounds(perDay[d]) }));
  }
  let dayCount = days.length || 1;
  if (start && end && today) {
    const elapsed = daysBetween(start, today) + 1;
    if (elapsed >= 1 && elapsed < dayCount) dayCount = elapsed; // trip still running
  }
  const withIdx = expenses.map((e) => ({ uid: e.uid, description: e.description, amount: e.amount_gbp, category: e.category, subtype: e.subtype, date: e.expense_date }));
  return {
    byCategory: all.byCategory,
    days, before: toPounds(before), after: toPounds(after),
    inTrip: toPounds(inTrip),
    avgPerDay: toPounds(Math.round(inTrip / dayCount)),
    biggest: withIdx.sort((a, b) => b.amount - a.amount).slice(0, 3),
    paidVsShare: all.people.map((p) => ({ name: p.name, paid: p.paid, share: p.share })),
  };
}

// Budget bar state: group budget against the whole trip total.
export function budgetState(budget, spent) {
  const b = Number(budget);
  if (!(b > 0)) return null;
  const ratio = Math.max(0, spent / b);
  return { budget: b, spent, left: Math.round((b - spent) * 100) / 100, pct: Math.round(ratio * 100), tone: ratio > 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok' };
}

// What changed between two versions of an expense, as short plain phrases.
export function describeChange(a, b) {
  const out = [];
  if (a.description !== b.description) out.push(`name "${a.description}" → "${b.description}"`);
  if (Math.abs(a.amount_gbp - b.amount_gbp) > 0.004) out.push(`amount ${fmt(a.amount_gbp)} → ${fmt(b.amount_gbp)}${b.gbp_estimated ? ' (estimate)' : ''}`);
  else if (!!a.gbp_estimated !== !!b.gbp_estimated) out.push(b.gbp_estimated ? 'amount marked as an estimate' : 'pounds confirmed');
  if (a.paid_by !== b.paid_by) out.push(`paid by ${a.paid_by} → ${b.paid_by}`);
  if ((a.category || '') !== (b.category || '') || (a.subtype || '') !== (b.subtype || '')) {
    const label = (x) => [x.category, x.subtype].filter(Boolean).join(' / ') || 'none';
    out.push(`category ${label(a)} → ${label(b)}`);
  }
  if ((a.expense_date || '') !== (b.expense_date || '')) out.push(`date ${a.expense_date || 'none'} → ${b.expense_date || 'none'}`);
  const people = (x) => (x.split_type === 'items' ? (x.items || []).flatMap((i) => i.names || []) : (x.participants || []).map((p) => p.name));
  const pa = [...new Set(people(a))].sort().join(','); const pb = [...new Set(people(b))].sort().join(',');
  if (a.split_type !== b.split_type) out.push('split changed');
  else if (pa !== pb) out.push('who it\'s split between changed');
  if ((a.notes || '') !== (b.notes || '')) out.push('notes changed');
  return out;
}

export function activityLine(kind, by, subject, detail) {
  const who = by || 'Someone';
  if (kind === 'added') return `${who} added ${subject}${detail ? ` (${detail})` : ''}`;
  if (kind === 'edited') return `${who} changed ${subject}: ${detail}`;
  if (kind === 'deleted') return `${who} deleted ${subject}${detail ? ` (${detail})` : ''}`;
  if (kind === 'payment') return `${who} recorded ${subject}`;
  if (kind === 'payment-undone') return `${who} removed ${subject}`;
  return `${who} ${subject}`;
}

// Names that mean the same person across trips. Auto-matches identical names (ignoring case and
// spaces); `map` holds the user's own choices ("arnav l." -> "Arnav"). Returns canonical names.
export function canonicalName(name, map) {
  const key = String(name).trim().toLowerCase();
  return (map && map[key]) || String(name).trim();
}

// Combine several trips: add up each person's net balance across all of them.
// list: [{ code, trip, expenses, settlements }]
export function combineTrips(list, map) {
  const nets = {}; const perTrip = [];
  list.forEach((t) => {
    const all = computeAll(t.trip, t.expenses, t.settlements, t.adjustments || []);
    const row = { code: t.code, name: t.trip.name, people: [] };
    all.people.forEach((p) => {
      const c = canonicalName(p.name, map);
      const key = c.toLowerCase();
      nets[key] = nets[key] || { name: c, pence: 0 };
      nets[key].pence += toPence(p.net);
      row.people.push({ name: c, net: p.net });
    });
    perTrip.push(row);
  });
  const byKey = Object.fromEntries(Object.entries(nets).map(([k, v]) => [k, v.pence]));
  const transfers = simplifyDebts(byKey).map((t) => ({ from: nets[t.from].name, to: nets[t.to].name, amount_gbp: toPounds(t.pence) }));
  return {
    people: Object.values(nets).map((v) => ({ name: v.name, net: toPounds(v.pence) })),
    transfers, perTrip,
  };
}

// Names that appear in only one trip - the ones worth asking "same person?" about.
export function unmatchedNames(list, map) {
  const seen = {};
  list.forEach((t) => {
    const names = new Set();
    (t.trip.members || []).forEach((m) => names.add(canonicalName(m, map)));
    names.forEach((n) => { (seen[n.toLowerCase()] ||= { name: n, trips: 0 }).trips += 1; });
  });
  return Object.values(seen).filter((x) => x.trips < list.length).map((x) => x.name);
}

// Closing a trip into another: the source trip's balances (who owes / is owed) move to the target.
// Returns the carry-over entries for each side plus a before/after preview of the target.
export function buildCarryOver(source, target, map) {
  const src = computeAll(source.trip, source.expenses, source.settlements, source.adjustments || []);
  const targetMembers = target.trip.members || [];
  const targetName = (n) => {
    const c = canonicalName(n, map).toLowerCase();
    return targetMembers.find((m) => m.toLowerCase() === c) || canonicalName(n, map);
  };
  const moving = src.people.filter((p) => Math.abs(p.net) >= 0.005);
  const outItems = moving.map((p) => ({ name: p.name, amount: toPounds(-toPence(p.net)) }));
  const inItems = moving.map((p) => ({ name: targetName(p.name), amount: p.net }));
  // two source people can map onto one target person - merge them
  const merged = {};
  inItems.forEach((i) => { merged[i.name] = (merged[i.name] || 0) + toPence(i.amount); });
  const inMerged = Object.entries(merged).map(([name, pence]) => ({ name, amount: toPounds(pence) }));
  const before = computeAll(target.trip, target.expenses, target.settlements, target.adjustments || []);
  const entry = { items: inMerged };
  const after = computeAll(target.trip, target.expenses, target.settlements, [...(target.adjustments || []), entry]);
  const names = new Set([...before.people.map((p) => p.name), ...after.people.map((p) => p.name)]);
  const preview = [...names].map((n) => ({
    name: n,
    before: (before.people.find((p) => p.name === n) || { net: 0 }).net,
    after: (after.people.find((p) => p.name === n) || { net: 0 }).net,
  })).filter((r) => Math.abs(r.before - r.after) >= 0.005);
  const newMembers = inMerged.map((i) => i.name).filter((n) => !targetMembers.some((m) => m.toLowerCase() === n.toLowerCase()));
  return { outItems, inItems: inMerged, preview, newMembers, empty: moving.length === 0 };
}

export function settleMessage(tripName, transfers, total) {
  const lines = [`${tripName} - settling up`];
  if (!transfers.length) lines.push('Everyone is all square.');
  transfers.forEach((t) => lines.push(`${t.from} pays ${t.to} ${fmt(t.amount_gbp)}`));
  if (total != null) lines.push(`(Trip total ${fmt(total)})`);
  return lines.join('\n');
}

// Same day and same amount (in pounds, or in the local currency) as an existing expense.
export function findDuplicate(expenses, cand) {
  return expenses.find((e) => e.uid !== cand.uid
    && (e.expense_date || '') === (cand.expense_date || '')
    && ((Math.abs(e.amount_gbp - cand.amount_gbp) < 0.005)
      || (e.orig_amount && cand.orig_amount && Math.abs(e.orig_amount - cand.orig_amount) < 0.005 && e.orig_currency === cand.orig_currency))) || null;
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
