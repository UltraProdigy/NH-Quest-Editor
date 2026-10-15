// What the questbook screens ask review mode (filled in by review/install.ts). Kept free of
// imports, so screens can use it without depending on GitHub or the diff.

import type { QuestLine, Quest } from '../lib/model.ts';

/** Colours of added, removed, changed and moved things. */
export const STATUS_COLOR = {
  added: 0xff55ff55,
  removed: 0xffff5555,
  changed: 0xffffcc33,
  moved: 0xff55ccff,
} as const;

export interface Mark {
  color: number;
  /** Ticked as reviewed: drawn fainter. */
  dim: boolean;
}

/** Where a quest is in the other questbook (before or after the pull request). */
export interface Ghost {
  quest: Quest | null;
  rect: [x: number, y: number, w: number, h: number];
  color: number;
  /** Where it is now, when it moved. */
  to?: [x: number, y: number, w: number, h: number];
  tooltip: string[];
}

export type QuestArea = 'name' | 'desc' | 'icon' | 'pre' | 'task' | 'reward' | 'prop';

export const reviewHooks = {
  /** A pull request is being reviewed (its questbook is shown). */
  active: () => false,
  /** "PR #123" and whether before or after is shown, for headers. */
  label: () => '',
  showingBefore: () => false,
  toggleBefore: () => {},
  /** Open the review screen (or the picker). */
  open: (_from: unknown) => {},
  /** Number of changes in a quest line, for the line list. */
  lineCount: (_lineId: string) => 0,
  /** The mark of a quest on a quest line. */
  questMark: (_lineId: string, _questId: string): Mark | null => null,
  /** Tooltip lines about a quest's changes. */
  questTooltip: (_questId: string, _lineId?: string, _all?: boolean): string[] => [],
  /** Quests drawn where they are in the other questbook. */
  ghosts: (_line: QuestLine): Ghost[] => [],
  /** The colour to outline a part of the quest screen with, if it changed. */
  areaMark: (_questId: string, _area: QuestArea, _index?: number): number | null => null,
  /** The whole quest is new or removed (its colour). */
  questStatus: (_questId: string): number | null => null,
  /** The description with its changes marked, if it changed. */
  descDiff: (_questId: string): string | null => null,
  /** What a property was before, if the pull request changed it. */
  propBefore: (_questId: string, _key: string): string | null => null,
};
