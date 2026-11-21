// COPY of electron/tripMath.js (same rules as the desktop app) - keep them identical.
// Pure maths for Group Trips - no database, no Electron - so the same rules
// can later be reused by the phone web app and checked on their own.
//
// Everything here works in whole pence (integers) so shares always add up to
// the bill exactly; callers convert from/to pounds with toPence/toPounds.

const toPence = (pounds) => Math.round(Number(pounds) * 100);
const toPounds = (pence) => pence / 100;

// Spread `total` pence over `weights` (any non-negative numbers) in proportion.
// Uses the largest-remainder method so the pieces add up to exactly `total`.
// Any left-over pennies go first to `preferId` (the payer) when they're one of
// the people being charged - Splitwise-style "extra penny to whoever paid" -
// and otherwise to whoever has the biggest remainder.
function allocate(total, entries, preferId) {
  // entries: [{ id, weight }]
  const out = {};
  entries.forEach((e) => { out[e.id] = 0; });
  const sumW = entries.reduce((s, e) => s + e.weight, 0);
  if (entries.length === 0) return out;
  if (sumW <= 0) {
    // Nobody has any weight - fall back to an even spread.
    entries = entries.map((e) => ({ id: e.id, weight: 1 }));
    return allocate(total, entries, preferId);
  }
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  let given = 0;
  const rems = entries.map((e) => {
    const exact = (abs * e.weight) / sumW;
    const base = Math.floor(exact + 1e-9);
    out[e.id] = base;
    given += base;
    return { id: e.id, rem: exact - base };
  });
  let left = abs - given;
  if (left > 0 && preferId != null && Object.prototype.hasOwnProperty.call(out, preferId)) {
    out[preferId] += left;
    left = 0;
  }
  rems.sort((a, b) => b.rem - a.rem);
  for (let i = 0; left > 0; i = (i + 1) % rems.length, left -= 1) out[rems[i].id] += 1;
  Object.keys(out).forEach((k) => { out[k] *= sign; });
  return out;
}

// splitType: 'equal' | 'exact' | 'percent' | 'shares'
// participants: [{ memberId, value }] - value is pounds for exact, percent for
// percent, weight for shares; ignored for equal.
// Returns { shares: { memberId: pence } } or throws a plain-English Error.
function splitAmount({ amountPence, splitType, participants, payerId }) {
  if (!participants || participants.length === 0) {
    throw new Error('Pick at least one person to split this between.');
  }
  const ids = participants.map((p) => p.memberId);
  if (new Set(ids).size !== ids.length) throw new Error('The same person is in the split twice.');

  if (splitType === 'exact') {
    const shares = {};
    let sum = 0;
    participants.forEach((p) => {
      const pence = toPence(p.value || 0);
      shares[p.memberId] = pence;
      sum += pence;
    });
    if (sum !== amountPence) {
      throw new Error(
        `The exact amounts add up to ${toPounds(sum).toFixed(2)} but the expense is ${toPounds(amountPence).toFixed(2)}.`
      );
    }
    return shares;
  }
  if (splitType === 'percent') {
    const total = participants.reduce((s, p) => s + (Number(p.value) || 0), 0);
    if (Math.abs(total - 100) > 0.01) {
      throw new Error(`The percentages add up to ${Math.round(total * 100) / 100}%, not 100%.`);
    }
    return allocate(amountPence, participants.map((p) => ({ id: p.memberId, weight: Number(p.value) || 0 })), payerId);
  }
  if (splitType === 'shares') {
    const entries = participants.map((p) => ({ id: p.memberId, weight: Number(p.value) || 0 }));
    if (entries.every((e) => e.weight <= 0)) throw new Error('Give at least one person a share above 0.');
    return allocate(amountPence, entries, payerId);
  }
  // equal
  return allocate(amountPence, participants.map((p) => ({ id: p.memberId, weight: 1 })), payerId);
}

// Itemised receipt. items: [{ description, amountPence, memberIds: [..] }]
// totalPence is the whole bill (what was actually paid). Whatever the items
// don't cover (service charge, VAT, tip) is shared out in proportion to what
// each person's own items came to. If the bill equals the items exactly (e.g.
// service skipped) the extras are simply zero. Throws if the items add up to
// more than the bill.
function splitItemised({ totalPence, items, payerId }) {
  if (!items || items.length === 0) throw new Error('Add at least one item.');
  const subtotal = {};
  let itemsSum = 0;
  items.forEach((it) => {
    if (!it.memberIds || it.memberIds.length === 0) {
      throw new Error(`Pick who had "${it.description || 'an item'}".`);
    }
    const part = allocate(it.amountPence, it.memberIds.map((id) => ({ id, weight: 1 })), payerId);
    Object.entries(part).forEach(([id, p]) => { subtotal[id] = (subtotal[id] || 0) + p; });
    itemsSum += it.amountPence;
  });
  const extras = totalPence - itemsSum;
  if (extras < 0) {
    throw new Error(
      `The items add up to ${toPounds(itemsSum).toFixed(2)}, which is more than the bill of ${toPounds(totalPence).toFixed(2)}.`
    );
  }
  const members = Object.keys(subtotal);
  const extraParts = extras > 0
    ? allocate(extras, members.map((id) => ({ id, weight: subtotal[id] })), payerId)
    : {};
  const shares = {};
  members.forEach((id) => { shares[id] = subtotal[id] + (extraParts[id] || 0); });
  return { shares, itemsSumPence: itemsSum, extrasPence: extras };
}

// A receipt itemised in the LOCAL currency (euros) for a bill that is also
// known in pounds: split it in euros first (so the receipt adds up exactly as
// printed), then share the pounds total in the same proportions.
function splitItemisedLocal({ totalGbpPence, totalLocalPence, items, payerId }) {
  const local = splitItemised({ totalPence: totalLocalPence, items, payerId }).shares;
  const ids = Object.keys(local);
  return allocate(totalGbpPence, ids.map((id) => ({ id, weight: local[id] })), payerId);
}

// nets: { memberId: pence } where positive = is owed money, negative = owes.
// Returns the fewest-ish payments that settle everyone: repeatedly match the
// biggest debtor with the biggest creditor (the usual Splitwise approach).
function simplifyDebts(nets) {
  const creditors = [];
  const debtors = [];
  Object.entries(nets).forEach(([id, n]) => {
    if (n > 0) creditors.push({ id, amt: n });
    else if (n < 0) debtors.push({ id, amt: -n });
  });
  const transfers = [];
  while (creditors.length && debtors.length) {
    creditors.sort((a, b) => b.amt - a.amt);
    debtors.sort((a, b) => b.amt - a.amt);
    const c = creditors[0];
    const d = debtors[0];
    const pay = Math.min(c.amt, d.amt);
    transfers.push({ from: d.id, to: c.id, pence: pay });
    c.amt -= pay;
    d.amt -= pay;
    if (c.amt === 0) creditors.shift();
    if (d.amt === 0) debtors.shift();
  }
  return transfers;
}

export { toPence, toPounds, allocate, splitAmount, splitItemised, splitItemisedLocal, simplifyDebts };
