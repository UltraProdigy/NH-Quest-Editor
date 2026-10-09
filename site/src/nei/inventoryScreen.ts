// The player's inventory with NEI around it (GuiInventory with LayoutManager's overlay): where NEI's
// item panel and search live in game. Opened with E from the questbook, like the inventory key.
// The inventory itself is empty; the player model is not drawn.

import { Screen } from '../gui/screen.ts';
import type { Gfx, Tooltip, TipLine } from '../gui/core.ts';
import { texture } from '../gui/assets.ts';
import { drawString } from '../gui/font.ts';
import { ItemPanelOverlay } from './itemPanel.ts';
import { openLookup } from './recipeScreen.ts';
import { drawMultilineTip } from './draw.ts';
import { itemKeyAt } from './data.ts';

const X_SIZE = 176, Y_SIZE = 166;

export class NeiInventoryScreen extends Screen {
  useMargins = false;
  /** An NEI screen: the E key closes all of them at once. */
  readonly neiScreen = true;
  private gl = 0;
  private gt = 0;
  private lastMouse: [number, number] = [-1, -1];
  private overlay = new ItemPanelOverlay((key, mode) => void openLookup(this, key, mode));

  route() {
    return '#/nei';
  }
  title() {
    return 'Items';
  }

  build() {
    this.gl = Math.trunc((this.width - X_SIZE) / 2);
    this.gt = Math.trunc((this.height - Y_SIZE) / 2);
    this.overlay.layout(this.width, this.height, { x: this.gl, y: this.gt, w: X_SIZE, h: Y_SIZE });
  }

  draw(gfx: Gfx, mx: number, my: number) {
    const img = texture('minecraft:textures/gui/container/inventory.png');
    if (img) {
      const k = img.width / 256;
      gfx.image(img, 0, 0, X_SIZE * k, Y_SIZE * k, this.gl, this.gt, X_SIZE, Y_SIZE);
    }
    // GuiInventory.drawGuiContainerForegroundLayer.
    drawString(gfx, 'Crafting', this.gl + 86, this.gt + 16, 0xff404040, false);
    this.overlay.draw(gfx, mx, my);
  }

  mouseDown(mx: number, my: number, b: number) {
    if (this.overlay.mouseDown(mx, my, b)) return true;
    return true;
  }
  mouseUp(mx: number, my: number, b: number) {
    this.overlay.mouseUp(mx, my, b);
    return true;
  }
  scroll(mx: number, my: number, d: number) {
    return this.overlay.scroll(mx, my, d);
  }

  key(e: KeyboardEvent) {
    const [mx, my] = this.lastMouse;
    if (this.overlay.key(e, mx, my)) return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === 'r' || k === 'u') {
      const item = this.overlay.hoveredItem(mx, my);
      if (item !== null) {
        void openLookup(this, itemKeyAt(item), k === 'r' ? 'recipe' : 'usage');
        return true;
      }
    }
    // The inventory key and Escape close the inventory.
    if (k === 'e' || e.key === 'Escape') {
      if (this.parent) this.host.back();
      return true;
    }
    return false;
  }

  tooltip(mx: number, my: number): Tooltip {
    this.lastMouse = [mx, my];
    return this.overlay.tooltip(mx, my);
  }

  drawTooltip(gfx: Gfx, lines: (string | TipLine)[], mx: number, my: number) {
    drawMultilineTip(gfx, lines, mx + 12, my - 12, this.width, this.height);
  }
}


/** Open the inventory with NEI over `from` (the E key in the questbook). */
export function openNeiInventory(from: Screen) {
  from.host.show(new NeiInventoryScreen(from), true);
}
