// The touch bar: buttons for what a keyboard and a right mouse button do, on phones and tablets.
// Back (Backspace), the inventory key E (between the questbook and NEI's item list) and a right
// click for the next tap (an item's usages, the quest menu). It shows once the screen is touched,
// in a strip of its own beside the GUI (at the right in landscape, at the bottom in portrait), so
// it never covers anything.

import { touchInput, type Host, type Screen } from './gui/screen.ts';
import { openNeiInventory } from './nei/inventoryScreen.ts';

const svg = (body: string) =>
  `<svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true" shape-rendering="crispEdges" fill="currentColor">${body}</svg>`;

const ICONS = {
  back: svg('<rect x="6" y="3" width="2" height="2"/><rect x="4" y="5" width="2" height="2"/><rect x="2" y="7" width="12" height="2"/><rect x="4" y="9" width="2" height="2"/><rect x="6" y="11" width="2" height="2"/>'),
  // A crafting grid: NEI's item list.
  items: svg('<path d="M2 2h12v12H2zM3 3v4h4V3zm6 0v4h4V3zM3 9v4h4V9zm6 0v4h4V9z"/>'),
  // A book: the questbook.
  book: svg('<path d="M3 2h9v1h1v11H4v-1H3zm1 1v10h8V4H5V3zm2 3h5v1H6zm0 2h5v1H6z"/>'),
  // A mouse with its right button filled.
  right: svg('<path d="M4 4h1V3h1V2h5v1h1v1h1v8h-1v1h-1v1H6v-1H5v-1H4zm1 4v4h1v1h5v-1h1V8zm4-5v4h3V4h-1V3z"/><rect x="8" y="2" width="1" height="6"/>'),
};

export function installTouchBar(host: Host) {
  const bar = document.createElement('div');
  bar.id = 'touchbar';
  bar.hidden = true;
  const button = (cls: string, label: string, icon: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.tabIndex = -1;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon;
    // Keep the focus (and the on-screen keyboard) where it is.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    bar.appendChild(b);
    return b;
  };
  const back = button('act', 'Back', ICONS.back);
  const nei = button('act', 'Items (E)', ICONS.items);
  const right = button('act', 'Right click: the next tap is a right click (an item\'s uses)', ICONS.right);
  document.body.appendChild(bar);

  const screen = () => host.screen;
  const isNei = (s: Screen | null) => !!(s as { neiScreen?: boolean } | null)?.neiScreen;
  /** Done typing: the field's hidden input lets go, so keys reach the screen again. */
  const leaveField = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a?.closest?.('input,textarea')) a.blur();
  };
  const press = (s: Screen, key: string) => s.key(new KeyboardEvent('keydown', { key }));

  back.addEventListener('click', () => {
    const s = screen();
    if (!s) return;
    leaveField();
    if (s.popup) s.closePopup();
    else if (!press(s, 'Backspace')) host.back();
    host.invalidate();
  });
  nei.addEventListener('click', () => {
    const s = screen();
    if (!s) return;
    leaveField();
    if (s.popup) s.closePopup();
    if (!press(s, 'e') && !isNei(s)) openNeiInventory(s);
    host.invalidate();
  });
  right.addEventListener('click', () => {
    touchInput.rightClick = !touchInput.rightClick;
    touchInput.changed();
  });

  const update = () => {
    const s = screen();
    const inNei = isNei(s);
    nei.innerHTML = inNei ? ICONS.book : ICONS.items;
    const label = inNei ? 'Questbook (E)' : 'Items (E)';
    nei.title = label;
    nei.setAttribute('aria-label', label);
    back.disabled = !s?.parent && !s?.popup;
    right.classList.toggle('on', touchInput.rightClick);
    right.setAttribute('aria-pressed', String(touchInput.rightClick));
  };
  touchInput.changed = () => {
    update();
    host.invalidate();
  };

  const show = () => {
    if (!bar.hidden) return;
    bar.hidden = false;
    document.body.classList.add('touch');
    update();
  };
  // Phones and tablets show it at once; elsewhere the first touch does.
  if (window.matchMedia?.('(pointer: coarse)').matches) show();
  window.addEventListener('touchstart', show, { passive: true, capture: true });

  return { update };
}
