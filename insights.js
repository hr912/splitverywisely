// Calculations behind the Summary page, the Activity log, combined settle-up
// across trips, the WhatsApp message and the duplicate warning. No screen, no database.
import { toPence, toPounds, simplifyDebts, allocate } from './trip-math.js';
import { computeAll, expenseSharesPence, pairwiseTransfers, effPence, effectiveItems } from './logic.js';

const fmt = (n) => (Number(n) || 0).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });

const isoAdd = (iso, days) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

// Summary page numbers. `today` is an ISO date (pinned in tests). `who` = null for the whole group, or
// a person's name to see just THEIR share of everything (what they actually spent).
export function summarize(trip, expenses, all, today, who = null) {
  const start = trip.start_date || null;
  const end = trip.end_date || start;
  const amtOf = (e) => (who ? ((all.shareByExpense[e.uid] || {})[who] || 0) : effPence(e));
  const days = [];
  let before = 0; let after = 0; let inTrip = 0;
  const perDay = {}; const cats = {};
  expenses.forEach((e) => {
    const amt = amtOf(e);
    if (!(amt > 0)) return;
    const c = e.category || 'Uncategorised';
    cats[c] = (cats[c] || 0) + amt;
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
  const withIdx = expenses.map((e) => ({ uid: e.uid, description: e.description, amount: toPounds(amtOf(e)), category: e.category, subtype: e.subtype, date: e.expense_date })).filter((x) => x.amount > 0);
  return {
    byCategory: Object.entries(cats).map(([name, p]) => ({ name, total: toPounds(p) })).sort((x, y) => y.total - x.total),
    days, before: toPounds(before), after: toPounds(after),
    inTrip: toPounds(inTrip),
    avgPerDay: toPounds(Math.round(inTrip / dayCount)),
    biggest: withIdx.sort((x, y) => y.amount - x.amount).slice(0, 3),
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

// Who had what on an itemised receipt: every person's items, their share of the extras (service, VAT, tip)
// and their total - in the receipt's own currency, plus the pounds when they are known.
// How much the discounts on a receipt saved: each item's "was" (original) price less what was charged.
export function savedOf(e) {
  const items = Array.isArray(e.items) ? e.items : [];
  const saved = items.reduce((t, i) => (Number(i.was) > Number(i.amount) ? t + (Number(i.was) - Number(i.amount)) : t), 0);
  return { saved: Math.round(saved * 100) / 100, local: items.some((i) => i.in_local) };
}

export function itemisedBreakdown(e, members = []) {
  const items = effectiveItems(e).filter((i) => Number(i.amount) > 0);
  if (!items.length) return { empty: true };
  const local = items.some((i) => i.in_local) && Number(e.orig_amount) > 0;
  const cur = local ? (String(e.orig_currency || '').toUpperCase() || 'EUR') : 'GBP';
  const totalPence = toPence(Number(local ? e.orig_amount : e.amount_gbp) || 0);
  const payer = e.paid_by;
  const unassigned = items.filter((i) => !i.names || !i.names.length);
  const itemsPence = items.reduce((s, i) => s + toPence(i.amount), 0);
  const over = itemsPence > totalPence;
  const people = {};
  items.forEach((i) => {
    const names = i.names || [];
    if (!names.length) return;
    const part = allocate(toPence(i.amount), names.map((id) => ({ id, weight: 1 })), payer);
    Object.entries(part).forEach(([n, p]) => {
      (people[n] ||= { name: n, pieces: [], subtotal: 0 });
      people[n].pieces.push({ description: i.description, amount: toPounds(p), count: names.length, sharedWith: names.filter((x) => x !== n), was: Number(i.was) > Number(i.amount) ? Number(i.was) : null });
      people[n].subtotal += p;
    });
  });
  const extrasPence = over ? 0 : totalPence - itemsPence;
  const who = Object.keys(people);
  const extraParts = extrasPence > 0 && who.length ? allocate(extrasPence, who.map((n) => ({ id: n, weight: people[n].subtotal })), payer) : {};
  const order = (n) => { const k = members.indexOf(n); return k < 0 ? 999 : k; };
  const list = who.sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((n) => ({
    name: n, pieces: people[n].pieces, subtotal: toPounds(people[n].subtotal),
    extra: toPounds(extraParts[n] || 0), total: toPounds(people[n].subtotal + (extraParts[n] || 0)),
  }));
  const assignedTotal = list.reduce((s, p) => s + toPence(p.total), 0);
  const extrasPounds = toPounds(extrasPence);
  const named = Array.isArray(e.extras) ? e.extras.filter((x) => Number(x.amount) > 0) : [];
  const extraLabels = named.length && Math.abs(named.reduce((s, x) => s + Number(x.amount), 0) - extrasPounds) < 0.015
    ? named
    : (extrasPence > 0 ? [{ label: 'Service, VAT and other', amount: extrasPounds }] : []);
  let gbpByName = null;
  if (!over && !unassigned.length && list.length) {
    try {
      const s = expenseSharesPence({ ...e, split_type: 'items', items });
      gbpByName = Object.fromEntries(Object.entries(s).map(([n, p]) => [n, toPounds(p)]));
    } catch { gbpByName = null; }
  }
  return {
    cur, local, total: toPounds(totalPence), itemsSum: toPounds(itemsPence), extras: extrasPounds,
    extrasPct: itemsPence ? Math.round((extrasPence / itemsPence) * 1000) / 10 : 0,
    extraLabels, people: list, unassigned, over, saved: savedOf({ items }).saved,
    balanced: !over && !unassigned.length && assignedTotal === totalPence, gbpByName,
  };
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

// "Just me" extras: what you covered for others, what others covered for you, and how much of your share is still estimated.
export function coverage(me, expenses, all) {
  let forOthers = 0; let byOthers = 0; let estimated = 0;
  expenses.forEach((e) => {
    const mine = (all.shareByExpense[e.uid] || {})[me] || 0;
    const amt = effPence(e);
    if (e.paid_by === me) forOthers += Math.max(0, amt - mine); else byOthers += mine;
    if (e.gbp_estimated) estimated += mine;
  });
  return { forOthers: toPounds(forOthers), byOthers: toPounds(byOthers), estimated: toPounds(estimated) };
}

// Pace and forecast while the trip is running (null before it starts or once it has ended).
export function paceInfo(sm, trip, today, budget) {
  const start = trip.start_date; const end = trip.end_date || start;
  if (!start || !end || !today) return null;
  const tripDays = daysBetween(start, end) + 1;
  const elapsed = daysBetween(start, today) + 1;
  if (elapsed < 1 || elapsed > tripDays) return null;
  const daily = sm.inTrip / elapsed;
  const projected = sm.before + daily * tripDays;
  const b = Number(budget) > 0 ? Number(budget) : null;
  const r2 = (n) => Math.round(n * 100) / 100;
  return { daily: r2(daily), projected: r2(projected), tripDays, elapsed, budget: b, over: b ? projected > b : false };
}

export function todayLine(expenses, all, me, today) {
  const todays = expenses.filter((e) => e.expense_date === today);
  if (!todays.length) return null;
  let total = 0; let mine = 0;
  todays.forEach((e) => { total += effPence(e); mine += (all.shareByExpense[e.uid] || {})[me] || 0; });
  return { total: toPounds(total), mine: toPounds(mine) };
}

// Search + filters on the Expenses list. rows: [{kind:'expense'|'payment'|'carry', e|s|a}]
export function filterRows(rows, flt, me, all) {
  const q = String(flt.q || '').trim().toLowerCase();
  if (!(q || flt.who || flt.cat || flt.mine)) return rows;
  return rows.filter((r) => {
    if (r.kind === 'carry') return false;
    if (r.kind === 'payment') {
      if (q || flt.cat) return false;
      if (flt.who && r.s.from !== flt.who && r.s.to !== flt.who) return false;
      if (flt.mine && r.s.from !== me && r.s.to !== me) return false;
      return true;
    }
    const e = r.e;
    if (flt.who && e.paid_by !== flt.who) return false;
    if (flt.cat && (e.category || '') !== flt.cat) return false;
    if (flt.mine && !(((all.shareByExpense[e.uid] || {})[me] || 0) > 0) && e.paid_by !== me) return false;
    if (q) {
      const hay = [e.description, e.category, e.subtype, e.paid_by, e.notes].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Facts for the one-page trip summary.
export function buildRecap(trip, expenses, all, who, today) {
  const sm = summarize(trip, expenses, all, today, who);
  const meRow = who ? all.people.find((p) => p.name === who) : null;
  const total = who ? (meRow ? meRow.share : 0) : all.total;
  const dayRows = sm.days.filter((d) => d.total > 0).sort((x, y) => y.total - x.total);
  const people = all.people.filter((p) => p.paid > 0 || p.share > 0);
  const tripDays = Math.max(1, sm.days.length);
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    sm, total, count: expenses.length, people,
    topCategory: sm.byCategory[0] || null,
    priciestDay: dayRows[0] || null,
    priciest: sm.biggest[0] || null,
    perPersonPerDay: people.length ? r2(all.total / people.length / tripDays) : 0,
    settled: all.transfers.length === 0,
    transfers: all.transfers,
  };
}

// ---------------------------------------------------------------- running tabs (months, statements, payments to confirm)
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (ym) => (ym === 'all' ? 'All time' : `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`);
export const monthShort = (ym) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1].slice(0, 3)} ${ym.slice(2, 4)}`;
export const monthEnd = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
export const inMonth = (iso, ym) => ym === 'all' || (iso || '').slice(0, 7) === ym;
export const prevMonth = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);

// Every month that has an expense or a payment, newest first, always including this month.
export function monthsWithData(expenses, settlements, thisMonth) {
  const set = new Set([thisMonth]);
  expenses.forEach((e) => { if (e.expense_date) set.add(e.expense_date.slice(0, 7)); });
  settlements.forEach((s) => { if (s.settle_date) set.add(s.settle_date.slice(0, 7)); });
  return [...set].sort().reverse();
}

// Month by month totals for the Summary page (newest first, at most `limit` months).
export function monthTotals(expenses, months, limit = 12) {
  return months.slice(0, limit).map((m) => ({
    month: m,
    total: toPounds(expenses.filter((e) => inMonth(e.expense_date, m)).reduce((s, e) => s + effPence(e), 0)),
  }));
}

// Payments someone says they made that are still waiting for the receiver: those I must confirm, and those I'm waiting on.
export function pendingPayments(settlements, me) {
  const claimed = settlements.filter((s) => s.status === 'claimed');
  const disputed = settlements.filter((s) => s.status === 'disputed');
  return {
    toConfirm: claimed.filter((s) => s.to === me),
    waiting: claimed.filter((s) => s.from === me),
    others: claimed.filter((s) => s.from !== me && s.to !== me),
    disputedMine: disputed.filter((s) => s.from === me),
    disputedToMe: disputed.filter((s) => s.to === me),
  };
}

// Who owes whom as of the end of a month (expenses and confirmed payments dated up to then), plus that month's spending.
export function tabStatement(trip, expenses, settlements, ym, mode = 'simple') {
  const end = monthEnd(ym);
  const exUpTo = expenses.filter((e) => !e.expense_date || e.expense_date <= end);
  const stUpTo = settlements.filter((s) => !s.settle_date || s.settle_date <= end);
  const upTo = computeAll(trip, exUpTo, stUpTo, []);
  const inM = expenses.filter((e) => inMonth(e.expense_date, ym));
  const month = computeAll(trip, inM, [], []);
  const waiting = settlements.filter((s) => s.status === 'claimed' && (!s.settle_date || s.settle_date <= end));
  return {
    month: ym, label: monthLabel(ym), end, monthTotal: month.total, monthCount: inM.length,
    people: upTo.people, transfers: mode === 'direct' ? pairwiseTransfers(trip, exUpTo, stUpTo) : upTo.transfers, waiting,
  };
}

export function statementMessage(tabName, st, link) {
  const lines = [`${tabName} - statement for ${st.label}`, `Spent this month: ${fmt(st.monthTotal)} (${st.monthCount} expense${st.monthCount === 1 ? '' : 's'})`, ''];
  if (!st.transfers.length) {
    lines.push('Everyone is all square.');
  } else {
    lines.push(`Who pays whom (up to ${st.end.split('-').reverse().join('/')}):`);
    st.transfers.forEach((t) => lines.push(`${t.from} pays ${t.to} ${fmt(t.amount_gbp)}`));
  }
  if (st.waiting.length) {
    lines.push('', 'Already paid and counted above, waiting for the other person to confirm:');
    st.waiting.forEach((s) => lines.push(`${s.from} -> ${s.to} ${fmt(s.amount_gbp)}`));
  }
  lines.push('', 'Once you have paid, tap "I\'ve paid" in the app. The person you paid taps "Got it" when it arrives.');
  if (link) lines.push(link);
  return lines.join('\n');
}
