// Reviewing a modpack pull request: pick one, then go through its changes with a checkbox each.
// Not part of BetterQuesting; styled like its option screens.

import { Screen } from '../gui/screen.ts';
import { CanvasEmpty, Transform, Align, Rect, type Gfx, type Panel } from '../gui/core.ts';
import { tex, col, icon } from '../gui/theme.ts';
import { staticColor } from '../gui/color.ts';
import {
  PanelButton, PanelTextBox, CanvasTextured, CanvasScrolling, PanelVScrollBar, PanelGeneric, itemTexture,
} from '../gui/widgets.ts';
import { PanelTextField } from '../gui/textfield.ts';
import { tr } from '../gui/lang.ts';
import { book, line as getLine, quest as getQuest, linesContaining } from '../store.ts';
import {
  openPullRequests, questFileCount, knownQuestFileCount, getToken, setToken, rate, REPO, type PullRequest, type FileCount,
} from '../review/github.ts';
import {
  reviewing, startReview, stopReview, setShowBefore, isTicked, setTicked, tickedCount,
} from '../review/session.ts';
import type { ReviewItem } from '../review/diff.ts';
import { itemTitle, itemDetails, lineName } from '../review/format.ts';
import { QuestScreen } from './quest.ts';

const GREEN = staticColor(0xff55ff55);
const MAX_DETAILS = 6;

function openLink(url: string) {
  window.open(url, '_blank', 'noopener');
}

const rateLine = () =>
  rate.remaining >= 0
    ? `§7GitHub requests left this hour: ${rate.remaining} / ${rate.limit}${getToken() ? ' (with your token)' : ''}`
    : '';

// ---------------------------------------------------------------- picking a pull request

const picker = {
  list: null as PullRequest[] | null,
  loading: false,
  error: '',
  counts: new Map<number, FileCount>(),
  loadedAt: 0,
};

async function loadOpenList(refresh: () => void, force = false) {
  if (picker.loading || (!force && picker.list && Date.now() - picker.loadedAt < 5 * 60_000)) return;
  picker.loading = true;
  picker.error = '';
  refresh();
  try {
    const list = await openPullRequests();
    picker.list = list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    picker.loadedAt = Date.now();
    for (const p of list) {
      const n = knownQuestFileCount(p);
      if (n !== undefined) picker.counts.set(p.number, n);
    }
    refresh();
    // Find out which pull requests change quests, a few at a time.
    const todo = list.filter((p) => !picker.counts.has(p.number));
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(
        todo.slice(i, i + 4).map(async (p) => {
          try {
            picker.counts.set(p.number, await questFileCount(p));
          } catch {
            // leave unknown
          }
        }),
      );
      refresh();
    }
  } catch (e) {
    picker.error = (e as Error).message;
  } finally {
    picker.loading = false;
    refresh();
  }
}

export class ReviewPickerScreen extends Screen {
  private field: PanelTextField | null = null;
  private tokenField: PanelTextField | null = null;
  private number = '';
  private token = getToken();
  private showToken = false;

  title() {
    return 'Review a pull request';
  }
  route() {
    return '#/review';
  }

  private open() {
    const n = Number(this.number.replace(/^#/, '').trim());
    if (!Number.isInteger(n) || n <= 0) return;
    this.host.show(new ReviewScreen(this.parent, n));
    void startReview(n);
  }

  build() {
    void loadOpenList(() => this.host.screen === this && this.host.refresh());
    const bg = this.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_main')));
    const inner = bg.add(new CanvasEmpty(new Transform(Align.FULL_BOX, [16, 16, 16, 16])));
    inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), '§lReview a pull request').setAlignment(1).setColor(col('text_header')));
    inner.add(
      new PanelTextBox(
        new Transform(Align.TOP_EDGE, [0, 16, 0, -40]),
        `Shows the questbook as a pull request to ${REPO} would leave it, with every change listed and marked.`,
        true,
      ).setAlignment(1).setColor(col('text_main')),
    );

    let y = 44;
    this.field = inner.add(new PanelTextField(Transform.at(Align.TOP_CENTER, -100, y, 136, 16), this.number));
    this.field.watermark = 'Pull request number';
    this.field.onChange = (s) => (this.number = s);
    this.field.onEnter = () => this.open();
    inner.add(new PanelButton(Transform.at(Align.TOP_CENTER, 40, y, 60, 16), { text: 'Open', onClick: () => this.open() }));
    y += 24;

    if (reviewing.number) {
      inner.add(
        new PanelButton(Transform.at(Align.TOP_CENTER, -100, y, 200, 16), {
          text: `Back to #${reviewing.number}`,
          onClick: () => this.host.show(new ReviewScreen(this.parent, reviewing.number)),
        }),
      );
      y += 20;
    }

    const counted = (picker.list ?? []).filter((p) => (picker.counts.get(p.number)?.n ?? 0) > 0 || p.labels.includes('Type: Quest'));
    const unknown = (picker.list ?? []).filter((p) => !picker.counts.has(p.number)).length;
    const head = picker.error
      ? `§4${picker.error}`
      : !picker.list
        ? 'Loading open pull requests...'
        : `Open pull requests that change quests (${counted.length})${unknown ? `, checking ${unknown} more...` : ':'}`;
    inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, y, 0, -y - 12]), head).setColor(col('text_header')));
    inner.add(
      new PanelButton(Transform.at(Align.TOP_RIGHT, -16, y - 3, 16, 16), {
        icon: icon('refresh'),
        tooltip: ['Check again'],
        onClick: () => void loadOpenList(() => this.host.screen === this && this.host.refresh(), true),
        active: !picker.loading,
      }),
    );
    y += 14;

    const listBottom = 72;
    const list = inner.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, y, 16, listBottom])));
    const sb = inner.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, y, 0, listBottom])));
    list.scrollY = sb;
    const w = list.transform.w();
    const panels: Panel[] = [];
    counted.forEach((p, i) => {
      const n = picker.counts.get(p.number);
      const flags = [p.draft ? '§7draft§r' : '', p.labels.some((l) => /freeze/i.test(l)) ? '§6freeze§r' : ''].filter(Boolean).join(', ');
      panels.push(
        new PanelButton(new Rect(0, i * 18, w, 16), {
          text: `#${p.number} ${p.title}`.slice(0, Math.max(20, Math.floor(w / 6))),
          align: 0,
          tooltip: [
            `#${p.number} ${p.title}`,
            `§7by ${p.author}, updated ${p.updatedAt.slice(0, 10)}`,
            `§7${n === undefined ? '?' : `${n.n}${n.more ? '+' : ''}`} quest file${n?.n === 1 && !n.more ? '' : 's'} changed${flags ? `, ${flags}` : ''}`,
            ...(p.labels.length ? [`§8${p.labels.join(', ')}`] : []),
          ],
          onClick: () => {
            this.host.show(new ReviewScreen(this.parent, p.number));
            void startReview(p.number);
          },
        }),
      );
    });
    list.addAll(panels);
    sb.enabled = list.scrollBounds.rh > 0;

    // GitHub token, for more than 60 requests an hour.
    const ty = -50;
    this.tokenField = inner.add(new PanelTextField(Transform.at(Align.BOTTOM_CENTER, -150, ty, 196, 16), this.token));
    this.tokenField.watermark = 'GitHub token (optional)';
    this.tokenField.mask = !this.showToken;
    this.tokenField.onChange = (s) => (this.token = s.trim());
    this.tokenField.onEnter = () => {
      setToken(this.token);
      this.host.refresh();
    };
    inner.add(
      new PanelButton(Transform.at(Align.BOTTOM_CENTER, 50, ty, 50, 16), {
        text: 'Save',
        tooltip: [
          'A GitHub token raises GitHub\'s limit from 60 to 5000',
          'requests an hour. It needs no scopes (public data only)',
          'and is kept in this browser only.',
        ],
        onClick: () => {
          setToken(this.token);
          this.host.refresh();
        },
      }),
    );
    inner.add(
      new PanelButton(Transform.at(Align.BOTTOM_CENTER, 104, ty, 46, 16), {
        text: this.showToken ? 'Hide' : 'Show',
        onClick: () => {
          this.showToken = !this.showToken;
          this.host.refresh();
        },
      }),
    );
    inner.add(new PanelTextBox(new Transform(Align.BOTTOM_EDGE, [0, -30, 0, 18]), rateLine()).setAlignment(1).setColor(col('text_main')));
    inner.add(new PanelButton(Transform.at(Align.BOTTOM_CENTER, -100, -16, 200, 16), { text: tr('gui.done'), onClick: () => this.host.back() }));
  }
}

// ---------------------------------------------------------------- the changes

const ui = { hideTicked: false, scroll: 0 };

/** Checkbox drawn from the item's tick state, so ticking needs no rebuild. */
class PanelTick extends PanelButton {
  constructor(r: Rect, private items: () => ReviewItem[], onToggle: () => void) {
    super(r, {});
    this.onClick = () => {
      const list = this.items();
      setTicked(list, !list.every(isTicked));
      onToggle();
    };
  }
  draw(gfx: Gfx, mx: number, my: number) {
    const list = this.items();
    const all = list.length > 0 && list.every(isTicked);
    const some = !all && list.some(isTicked);
    this.setIcon(all || some ? icon('tick') : null, all ? GREEN : staticColor(0xff888888), 2);
    this.tooltipLines = [all ? 'Reviewed: click to untick' : 'Click when reviewed'];
    super.draw(gfx, mx, my);
  }
}

export class ReviewScreen extends Screen {
  private list: CanvasScrolling | null = null;

  constructor(parent: Screen | null, public n: number) {
    super(parent);
  }

  title() {
    return `Review #${this.n}`;
  }
  route() {
    return `#/review/${this.n}`;
  }

  private keepScroll() {
    if (this.list) ui.scroll = this.list.getScrollY();
  }

  /** Open what a change is about: the quest, or the quest line with the quest marked. */
  private goTo(it: ReviewItem) {
    this.keepScroll();
    const removed = it.status === 'removed';
    if (removed !== reviewing.showBefore) setShowBefore(removed);
    if (it.kind === 'q' && it.questId && getQuest(it.questId)) {
      this.host.show(new QuestScreen(this, it.questId));
      return;
    }
    if (it.questId) {
      this.host.navigateToQuestOnMap(this, it.questId, it.lineId);
      return;
    }
    if (it.lineId && getLine(it.lineId)) this.host.navigateToLine(this, it.lineId);
  }

  build() {
    const bg = this.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_main')));
    const inner = bg.add(new CanvasEmpty(new Transform(Align.FULL_BOX, [16, 16, 16, 16])));
    const pr = reviewing.number === this.n ? reviewing.pr : null;
    const data = reviewing.number === this.n ? reviewing.data : null;
    const header = pr ? `§lPull request #${pr.number}: ${pr.title}` : `§lPull request #${this.n}`;
    inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 0, 0, -12]), header).setAlignment(1).setColor(col('text_header')));

    const done = () =>
      inner.add(new PanelButton(Transform.at(Align.BOTTOM_CENTER, -100, -16, 200, 16), {
        text: tr('gui.done'),
        onClick: () => {
          this.keepScroll();
          this.host.back();
        },
      }));

    if (reviewing.number !== this.n || (!data && !reviewing.loading)) {
      const msg = reviewing.error && reviewing.number === this.n ? `§4${reviewing.error}` : 'This pull request is not loaded.';
      inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 24, 0, -64]), msg, true).setAlignment(1).setColor(col('text_main')));
      inner.add(new PanelButton(Transform.at(Align.TOP_CENTER, -100, 72, 200, 20), {
        text: reviewing.error ? 'Try again' : `Load #${this.n}`,
        onClick: () => void startReview(this.n, true),
      }));
      inner.add(new PanelButton(Transform.at(Align.TOP_CENTER, -100, 96, 200, 20), {
        text: 'Pick another pull request',
        onClick: () => this.host.show(new ReviewPickerScreen(this.parent)),
      }));
      inner.add(new PanelTextBox(new Transform(Align.BOTTOM_EDGE, [0, -30, 0, 18]), rateLine()).setAlignment(1).setColor(col('text_main')));
      done();
      return;
    }
    if (!data) {
      inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 24, 0, -64]), reviewing.progress || 'Loading...', true).setAlignment(1).setColor(col('text_main')));
      done();
      return;
    }

    const { files, items } = data;
    const p = data.pr;
    const state = p.state === 'merged' ? '§5merged§r' : p.state === 'closed' ? '§4closed§r' : p.draft ? '§7draft§r' : '§2open§r';
    const sub = `by ${p.author}, ${state}, ${files.quests.length} quest file${files.quests.length === 1 ? '' : 's'} changed`;
    inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 12, 0, -24]), sub).setAlignment(1).setColor(col('text_main')));

    let y = 26;
    const btn = (x: number, w: number, text: string, onClick: () => void, tooltip?: string[], active = true) =>
      inner.add(new PanelButton(Transform.at(Align.TOP_CENTER, x, y, w, 16), { text, onClick, tooltip, active }));
    btn(-204, 100, 'Open on GitHub', () => openLink(`${p.url}/files`));
    btn(-102, 100, reviewing.showBefore ? 'Showing: before' : 'Showing: after', () => {
      setShowBefore(!reviewing.showBefore);
      this.keepScroll();
      this.host.refresh();
    }, ['Show the questbook without (before) or with (after)', 'the pull request\'s changes. B switches too.']);
    btn(0, 100, reviewing.loading ? 'Reloading...' : 'Reload', () => {
      this.keepScroll();
      void startReview(this.n, true);
    }, ['Load the pull request\'s latest commits.', 'Ticks stay on changes that are the same.'], !reviewing.loading);
    btn(102, 100, 'Stop reviewing', () => {
      stopReview();
      this.host.back();
    }, ['Show the published questbook again.']);
    y += 20;

    const ticked = tickedCount();
    inner.add(
      new PanelTextBox(
        new Transform(Align.TOP_EDGE, [0, y + 4, 0, -y - 16]),
        `Reviewed ${ticked} of ${items.length} change${items.length === 1 ? '' : 's'}${ticked === items.length && items.length ? ' §2- all done!' : ''}`,
      ).setColor(col('text_header')),
    );
    inner.add(
      new PanelButton(Transform.at(Align.TOP_RIGHT, -16 - 124, y, 124, 16), {
        text: `Hide reviewed: ${ui.hideTicked ? tr('gui.yes') : tr('gui.no')}`,
        onClick: () => {
          ui.hideTicked = !ui.hideTicked;
          this.keepScroll();
          this.host.refresh();
        },
      }),
    );
    y += 20;

    const list = (this.list = inner.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, y, 16, 46]))));
    const sb = inner.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, y, 0, 46])));
    list.scrollY = sb;
    const w = list.transform.w();
    const panels: Panel[] = [];
    const refresh = () => {
      if (ui.hideTicked) {
        this.keepScroll();
        this.host.refresh();
      }
      else this.host.refresh();
    };

    // Group by quest line, in the questbook's order; the rest at the end.
    const groups = new Map<string, ReviewItem[]>();
    const groupOf = (it: ReviewItem) => {
      if (it.lineId) return it.lineId;
      if (it.questId) {
        const l = linesContaining(it.questId)[0] ?? data.result.before.lines.find((x) => x.quests.some((q) => q[0] === it.questId));
        if (l) return l.id;
        return 'none';
      }
      return 'book';
    };
    for (const it of items) {
      const g = groupOf(it);
      const l = groups.get(g);
      if (l) l.push(it);
      else groups.set(g, [it]);
    }
    const order = [...new Set(['book', ...data.result.after.lines.map((l) => l.id), ...data.result.before.lines.map((l) => l.id), 'none'])];
    let cy = 0;
    for (const g of order) {
      const all = groups.get(g);
      if (!all) continue;
      const shown = ui.hideTicked ? all.filter((it) => !isTicked(it)) : all;
      if (!shown.length) continue;
      const lineRef = getLine(g) ?? data.result.before.lines.find((l) => l.id === g);
      const title = g === 'book' ? 'Questbook' : g === 'none' ? 'Not in a quest line' : lineName(g);
      panels.push(new PanelTick(new Rect(0, cy, 16, 16), () => all, refresh));
      if (lineRef?.icon) panels.push(new PanelGeneric(new Rect(18, cy, 16, 16), itemTexture(lineRef.icon)));
      const done = all.filter(isTicked).length;
      panels.push(new PanelTextBox(new Rect(36, cy + 4, w - 36, 12), `§l${title}§r §7(${done}/${all.length})`).setColor(col('text_header')));
      cy += 18;
      for (const it of shown) {
        panels.push(new PanelTick(new Rect(8, cy, 14, 14), () => [it], refresh));
        const title = new PanelButton(new Rect(24, cy, w - 24, 14), {
          text: itemTitle(it),
          align: 0,
          textures: [null, null, null],
          tooltip: [it.kind === 'q' ? 'Open the quest' : 'Show it on the quest line'],
          onClick: () => this.goTo(it),
        });
        title.colors = [col('text_main'), col('text_header'), col('text_highlight')];
        title.shadow = false;
        panels.push(title);
        cy += 14;
        let details = itemDetails(it);
        if (details.length > MAX_DETAILS) details = [...details.slice(0, MAX_DETAILS - 1), `§7... and ${details.length - MAX_DETAILS + 1} more (open the quest to see all)`];
        if (details.length) {
          const t = new PanelTextBox(new Rect(28, cy, w - 28, 0), details.join('\n'), true);
          t.setColor(col('text_main'));
          t.init();
          panels.push(t);
          cy += t.transform.h();
        }
        cy += 4;
      }
      cy += 6;
    }
    if (files.other.length) {
      const t = new PanelTextBox(
        new Rect(0, cy, w, 0),
        [`§lOther files in the pull request (not shown here):`, ...files.other.map((f) => `§7${f}`)].join('\n'),
        true,
      );
      t.setColor(col('text_main'));
      t.init();
      panels.push(t);
      cy += t.transform.h();
    }
    if (!items.length) {
      panels.push(new PanelTextBox(new Rect(0, 0, w, 0), files.quests.length ? 'The quest files changed, but not the quests in them.' : 'This pull request does not change any quests.', true).setColor(col('text_main')));
    }
    list.addAll(panels);
    sb.enabled = list.scrollBounds.rh > 0;
    list.setScrollY(ui.scroll);
    list.updatePanelScroll();

    const base = files.mergeBase.slice(0, 7), headSha = p.headSha.slice(0, 7);
    const foot = `§7Head ${headSha}, branched from ${base}, shown on the site's quests from ${book.source.commit.slice(0, 7) || 'master'}.\n${rateLine()}`;
    inner.add(new PanelTextBox(new Transform(Align.BOTTOM_EDGE, [0, -42, 0, 20]), foot).setAlignment(1).setColor(col('text_main')));
    done();
  }

  key(e: KeyboardEvent) {
    if (!this.popup && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'b' && reviewing.data) {
      setShowBefore(!reviewing.showBefore);
      this.host.refresh();
      return true;
    }
    return super.key(e);
  }
}
