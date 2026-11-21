// The trip categories (kept short on purpose) with an icon each, plus
// optional sub-types. Icon names are Tabler icons (ti ti-NAME).
// The desktop app has the same list in src/lib/tripCategories.js - keep them identical.
export const CATEGORIES = [
  { name: 'Eating out', icon: 'tools-kitchen-2', subs: [['Restaurant', 'tools-kitchen-2'], ['Café', 'coffee'], ['Takeaway', 'paper-bag']] },
  { name: 'Groceries', icon: 'shopping-cart', subs: [] },
  { name: 'Drinks and nightlife', icon: 'glass-cocktail', subs: [['Bar', 'beer'], ['Club', 'music'], ['Alcohol shop', 'bottle']] },
  { name: 'Getting there', icon: 'plane', subs: [['Flights', 'plane'], ['Train', 'train'], ['Coach', 'bus'], ['Ferry', 'ship'], ['Airport parking', 'parking'], ['Fuel', 'gas-station'], ['Toll', 'receipt']] },
  { name: 'Getting around', icon: 'car', subs: [['Car hire', 'car-garage'], ['Fuel', 'gas-station'], ['Toll', 'receipt'], ['Parking', 'parking'], ['Taxi', 'car'], ['Metro or bus', 'bus']] },
  { name: 'Stay', icon: 'bed', subs: [['Hotel', 'building'], ['Rental', 'home'], ['Tourist tax', 'receipt-tax']] },
  { name: 'Activities', icon: 'ticket', subs: [['Tickets', 'ticket'], ['Tour', 'map'], ['Sport', 'ball-football'], ['Show', 'masks-theater']] },
  { name: 'Shopping', icon: 'shopping-bag', subs: [['Clothes', 'shirt'], ['Gifts', 'gift'], ['Souvenirs', 'camera']] },
  { name: 'Health and essentials', icon: 'first-aid-kit', subs: [] },
  { name: 'Tips and fees', icon: 'coin', subs: [] },
  { name: 'Other', icon: 'dots', subs: [] },
];

// The icon for an expense: its sub-type icon if it has one, else the category's, else "other".
export function iconFor(category, subtype) {
  const c = CATEGORIES.find((x) => x.name === category);
  if (!c) return 'dots';
  const s = subtype ? c.subs.find((x) => x[0] === subtype) : null;
  return s ? s[1] : c.icon;
}

export const GREETINGS = ['Welcome back', 'Fun trip', 'Good to see you', 'Let\'s split it', 'Holiday mode on', 'Ready when you are'];
