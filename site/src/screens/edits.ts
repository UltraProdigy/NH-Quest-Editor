// The edits made on the site: undo and redo, what changed, and the downloads for a pull request.
// Not part of BetterQuesting (it saves into the game); styled like its option screens.

import { Screen } from '../gui/screen.ts';
import { CanvasEmpty, Transform, Align, Rect } from '../gui/core.ts';
import { tex, col } from '../gui/theme.ts';
import { PanelButton, PanelTextBox, CanvasTextured, CanvasScrolling, PanelVScrollBar } from '../gui/widgets.ts';
import { tr } from '../gui/lang.ts';
import { editing, startEditing, stopEditing, discardEdits, saveNow } from '../edit/session.ts';
import { exportZip, exportPatch } from '../edit/export.ts';
import { book } from '../store.ts';
import { stripFormatting } from '../gui/font.ts';

function download(name: string, data: Uint8Array | string, type: string) {
  const blob = new Blob([data as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** A readable line for one changed object. */
function describe(key: string, text: string | null, base: string | null): string {
  const what = base === null ? '§2added§r' : text === null ? '§4removed§r' : 'changed';
  const [kind, a, b] = key.split(':');
  const qName = (id: string) => stripFormatting(book.quests[id]?.name ?? id);
  const lName = (id: string) => stripFormatting(book.lines.find((l) => l.id === id)?.name ?? id);
  switch (kind) {
    case 'q':
      return `Quest "${qName(a)}" ${what}`;
    case 'l':
      return `Quest line "${lName(a)}" ${what}`;
    case 'e':
      return base === null ? `"${qName(b)}" placed in "${lName(a)}"` : text === null ? `"${qName(b)}" taken out of "${lName(a)}"` : `"${qName(b)}" moved in "${lName(a)}"`;
    case 's':
      return 'Questbook settings changed';
    case 'o':
      return 'Quest line order changed';
  }
  return key;
}

export class EditsScreen extends Screen {
  private confirmDiscard = false;

  title() {
    return 'Edits';
  }
  route() {
    return '#/edits';
  }

  build() {
    const bg = this.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_main')));
    const inner = bg.add(new CanvasEmpty(new Transform(Align.FULL_BOX, [16, 16, 16, 16])));
    inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), '§lEdits').setAlignment(1).setColor(col('text_header')));
    const doc = editing.doc;

    let y = 24;
    const button = (x: number, w: number, text: string, onClick: () => void, active = true, tooltip?: string[]) => {
      inner.add(new PanelButton(Transform.at(Align.TOP_CENTER, x, y, w, 20), { text, onClick, active, tooltip }));
    };

    if (!editing.on || !doc) {
      const msg = editing.loading
        ? 'Loading the quest files...'
        : editing.error
          ? `§4${editing.error}`
          : 'Edit mode is off. Switch it on to change the questbook here and download the changes for a pull request.';
      inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, y, 0, -y - 40]), msg).setAlignment(1).setColor(col('text_main')));
      y += 40;
      button(-100, 200, 'Switch edit mode on', () => void startEditing().then(() => this.host.refresh()), !editing.loading);
      inner.add(new PanelButton(Transform.at(Align.BOTTOM_CENTER, -100, -16, 200, 16), { text: tr('gui.done'), onClick: () => this.host.back() }));
      return;
    }

    button(-152, 148, doc.canUndo ? `Undo: ${doc.undoLabel}` : 'Undo', () => doc.undo(), doc.canUndo, ['Ctrl + Z']);
    button(4, 148, doc.canRedo ? `Redo: ${doc.redoLabel}` : 'Redo', () => doc.redo(), doc.canRedo, ['Ctrl + Y']);
    y += 24;

    const ch = doc.fileChanges();
    const nFiles = ch.changed.length + ch.added.length + ch.deleted.length;
    const stamp = `${doc.source.commit.slice(0, 7) || 'local'}-${new Date().toISOString().slice(0, 10)}`;
    button(-152, 148, 'Download changed files', () => download(`quests-${stamp}.zip`, exportZip(doc), 'application/zip'), nFiles > 0, [
      'A zip of the new and changed files at their paths in the modpack,',
      'with DELETED.txt listing the files to remove.',
    ]);
    button(4, 148, 'Download patch', () => download(`quests-${stamp}.patch`, exportPatch(doc), 'text/x-diff'), nFiles > 0, [
      'A git patch of the changes.',
      'In the modpack repo: git apply --3way quests.patch',
    ]);
    y += 24;
    button(-152, 148, this.confirmDiscard ? '§4Click again to discard' : 'Discard all edits', () => {
      if (!this.confirmDiscard) {
        this.confirmDiscard = true;
        this.host.refresh();
        return;
      }
      this.confirmDiscard = false;
      void discardEdits().then(() => this.host.refresh());
    }, doc.edits().length > 0);
    button(4, 148, 'Switch edit mode off', () => {
      stopEditing();
      this.host.refresh();
    }, true, ['Shows the published questbook again. Your edits stay saved in this browser.']);
    y += 28;

    const edits = doc.edits();
    const src = doc.source;
    const head = [
      `Edits on ${src.repo} @ ${src.commit.slice(0, 7)}${src.date ? ` (${src.date.slice(0, 10)})` : ''}, saved in this browser${editing.saveFailed ? ' §4(saving failed!)§r' : ''}.`,
      `${edits.length} change${edits.length === 1 ? '' : 's'}: ${ch.changed.length} file${ch.changed.length === 1 ? '' : 's'} changed, ${ch.added.length} added, ${ch.deleted.length} deleted.`,
    ];
    if (editing.rebased) {
      head.push(`§6The site now has newer quest data (your edits were made on ${editing.rebased.slice(0, 7)}).§r`);
      if (editing.clashes.length) head.push(`§6${editing.clashes.length} of the things you changed were changed in the modpack too; your version was kept:§r`);
    }
    const lines = [...head, '', ...edits.map((e) => (editing.clashes.includes(e.key) ? '§6! §r' : '- ') + describe(e.key, e.text, e.base))];

    const list = inner.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, y, 16, 24])));
    const text = new PanelTextBox(new Rect(0, 0, list.transform.w(), 0), lines.join('\n'), true, true);
    text.setColor(col('text_main'));
    list.add(text);
    const sb = inner.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, y, 0, 24])));
    list.scrollY = sb;

    inner.add(new PanelButton(Transform.at(Align.BOTTOM_CENTER, -100, -16, 200, 16), {
      text: tr('gui.done'),
      onClick: () => {
        void saveNow();
        this.host.back();
      },
    }));
  }
}
