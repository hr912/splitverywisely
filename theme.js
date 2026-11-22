// Trip themes: colours, a flag-style stripe, faint doodles and local greetings.
// A trip stores either a preset id ("italy") or {id:'custom', colors:[..], doodles:[..]}
// in its `theme` field, so everyone on the trip sees the same look.

const GENERIC_GREETINGS = ['Welcome back', 'Fun trip', 'Good to see you', 'Let\'s split it', 'Holiday mode on', 'Ready when you are'];

export const THEMES = {
  classic: {
    id: 'classic', name: 'Classic', blurb: 'The plain teal look',
    accent: ['#0e7c86', '#3cc0cc'], accent2: ['#0e7c86', '#3cc0cc'], stripe: [], doodles: [],
    greetings: GENERIC_GREETINGS,
  },
  italy: {
    id: 'italy', name: 'Italy', blurb: 'Flag stripe · pizza, gelato, Vespa',
    accent: ['#0a8a4a', '#4cc98a'], accent2: ['#ce2b37', '#ff7a86'], stripe: ['#009246', '#f4f5f0', '#ce2b37'],
    doodles: ['pizza', 'ice-cream-2', 'coffee', 'scooter', 'building-arch', 'lemon', 'bottle', 'glass', 'chef-hat'],
    greetings: ['Buon viaggio', 'Ciao', 'Che bello', 'Andiamo', 'Dolce vita', 'Forza'],
  },
  china: {
    id: 'china', name: 'China', blurb: 'Red and gold · tea, noodles, mountains',
    accent: ['#c8201a', '#ff6b5e'], accent2: ['#b8860b', '#ffd24a'], stripe: ['#de2910', '#ffde00'],
    doodles: ['teapot', 'bowl', 'mountain', 'fish', 'chef-hat', 'flag', 'cup'],
    greetings: ['Ni hao', 'Huanying', 'Jiayou', 'Hao ya', 'Zai jian'],
  },
  spain: {
    id: 'spain', name: 'Spain', blurb: 'Red and yellow · sun, wine, music',
    accent: ['#c4161c', '#ff6b6f'], accent2: ['#b88a00', '#ffd34d'], stripe: ['#aa151b', '#f1bf00', '#aa151b'],
    doodles: ['sun', 'music', 'glass', 'pepper', 'flag', 'cactus', 'masks-theater'],
    greetings: ['¡Vamos!', 'Hola', '¡Olé!', 'Buen viaje', 'Qué bueno'],
  },
  japan: {
    id: 'japan', name: 'Japan', blurb: 'White and red · torii, ramen, sakura',
    accent: ['#bc002d', '#ff5c7c'], accent2: ['#555555', '#e0e0e0'], stripe: ['#f2f2f2', '#bc002d'],
    doodles: ['torii', 'flower', 'bowl', 'teapot', 'mountain', 'fish', 'cup'],
    greetings: ['Konnichiwa', 'Yokoso', 'Ganbatte', 'Itadakimasu', 'Sayonara'],
  },
  beach: {
    id: 'beach', name: 'Beach', blurb: 'Sea and sand · sun, waves, ships',
    accent: ['#0b7fa6', '#4ec3e8'], accent2: ['#b8731d', '#f2b25c'], stripe: ['#2aa7c9', '#f2d6a0'],
    doodles: ['beach', 'umbrella', 'sun', 'ship', 'anchor', 'fish', 'sailboat', 'sunglasses'],
    greetings: ['Sun\'s out', 'Beach mode on', 'Sea you soon', 'Salty hair, happy us'],
  },
};
export const PRESET_ORDER = ['italy', 'classic', 'china', 'spain', 'japan', 'beach'];

// Icons you can pick from when making your own theme (Tabler icon names).
export const ICON_LIBRARY = [
  ['pizza', 'Pizza'], ['ice-cream-2', 'Gelato'], ['coffee', 'Coffee'], ['bottle', 'Bottle'], ['glass', 'Glass'], ['beer', 'Beer'],
  ['burger', 'Burger'], ['soup', 'Soup'], ['salad', 'Salad'], ['cake', 'Cake'], ['cookie', 'Cookie'], ['candy', 'Sweets'],
  ['chef-hat', 'Chef'], ['pepper', 'Pepper'], ['lemon', 'Lemon'], ['cherry', 'Cherry'], ['bread', 'Bread'], ['fish', 'Fish'],
  ['teapot', 'Teapot'], ['bowl', 'Bowl'], ['scooter', 'Scooter'], ['bike', 'Bike'], ['car', 'Car'], ['train', 'Train'],
  ['bus', 'Bus'], ['plane', 'Plane'], ['ship', 'Ship'], ['sailboat', 'Sailboat'], ['anchor', 'Anchor'], ['building-arch', 'Arch'],
  ['tower', 'Tower'], ['columns', 'Columns'], ['building-castle', 'Castle'], ['windmill', 'Windmill'], ['torii', 'Torii'],
  ['mountain', 'Mountain'], ['sun', 'Sun'], ['moon', 'Moon'], ['umbrella', 'Umbrella'], ['beach', 'Beach'], ['tent', 'Tent'],
  ['campfire', 'Campfire'], ['cactus', 'Cactus'], ['tree', 'Tree'], ['flower', 'Flower'], ['camera', 'Camera'], ['compass', 'Compass'],
  ['luggage', 'Luggage'], ['backpack', 'Backpack'], ['ticket', 'Ticket'], ['music', 'Music'], ['masks-theater', 'Theatre'],
  ['palette', 'Art'], ['flag', 'Flag'], ['swimming', 'Swimming'], ['kayak', 'Kayak'], ['sunglasses', 'Sunglasses'],
  ['heart', 'Heart'], ['star', 'Star'], ['confetti', 'Confetti'], ['balloon', 'Balloon'],
];

const hexToRgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (r) => `#${r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => { const x = hexToRgb(a); const y = hexToRgb(b); return rgbToHex(x.map((v, i) => v * (1 - t) + y[i] * t)); };
export const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const onColor = (hex) => (luminance(hex) > 0.4 ? '#06242a' : '#ffffff');
// Keep a custom colour readable on the page background in each mode.
const forLight = (hex) => { let c = hex; for (let i = 0; i < 6 && luminance(c) > 0.3; i += 1) c = mix(c, '#000000', 0.2); return c; };
const forDark = (hex) => { let c = hex; for (let i = 0; i < 6 && luminance(c) < 0.25; i += 1) c = mix(c, '#ffffff', 0.2); return c; };

export function resolveTheme(value) {
  if (!value) return THEMES.classic;
  if (typeof value === 'string') return THEMES[value] || THEMES.classic;
  if (value.id === 'custom') {
    const colors = (value.colors || []).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 3);
    if (!colors.length) return THEMES.classic;
    const c2 = colors[1] || colors[0];
    return {
      id: 'custom', name: 'Your own', blurb: 'Your colours and doodles',
      accent: [forLight(colors[0]), forDark(colors[0])], accent2: [forLight(c2), forDark(c2)],
      stripe: colors, doodles: (value.doodles || []).slice(0, 10), greetings: GENERIC_GREETINGS,
    };
  }
  return THEMES[value.id] || THEMES.classic;
}

export const pickGreeting = (theme) => theme.greetings[Math.floor(Math.random() * theme.greetings.length)];

// Writes the theme into the page: colour variables, and the faint doodle layer.
export function applyTheme(theme) {
  if (typeof document === 'undefined' || !document.head || !document.createElement) return;
  try {
    const css = (i) => `--accent:${theme.accent[i]};--accent2:${theme.accent2[i]};--accent-soft:color-mix(in srgb, ${theme.accent[i]} 16%, var(--surface));--on-accent:${onColor(theme.accent[i])};`;
    let style = document.getElementById('theme-style');
    if (!style) { style = document.createElement('style'); style.id = 'theme-style'; document.head.appendChild(style); }
    style.textContent = `:root{${css(0)}}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${css(1)}}}:root[data-theme="dark"]{${css(1)}}`;
    let layer = document.getElementById('doodles');
    if (!layer) { layer = document.createElement('div'); layer.id = 'doodles'; layer.setAttribute('aria-hidden', 'true'); document.body.appendChild(layer); }
    const names = theme.doodles || [];
    layer.innerHTML = '';
    if (!names.length) return;
    const cols = 5; const rows = 14; let html = '';
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const n = names[(r * 3 + c * 2) % names.length];
        const left = c * 22 + (r % 2 ? 11 : 2) + ((r * 7 + c * 3) % 5);
        const top = r * 9 + 2 + ((r * 5 + c * 11) % 4);
        const rot = ((r * 37 + c * 53) % 50) - 25;
        html += `<i class="ti ti-${n}" style="left:${left}%;top:${top}%;transform:rotate(${rot}deg)"></i>`;
      }
    }
    layer.innerHTML = html;
  } catch { /* theming is cosmetic - never break the app over it */ }
}
