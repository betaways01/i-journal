import { InlineKeyboardButton } from 'telegraf/types';

export const QUICK_ACTIONS: InlineKeyboardButton[][] = [
  [
    { text: '📖 Journal', callback_data: 'journal_now' },
    { text: '📝 Drop', callback_data: 'drop_now' },
  ],
  [
    { text: '💭 Vent', callback_data: 'vent_now' },
    { text: '📄 Last', callback_data: 'last_entry' },
  ],
  [
    { text: '📊 Today', callback_data: 'status_now' },
    { text: '⚙️ Settings', callback_data: 'open_settings' },
  ],
];

export const POST_SAVE_ACTIONS: InlineKeyboardButton[][] = [
  [
    { text: '📄 View entry', callback_data: 'last_entry' },
    { text: '📝 Drop more', callback_data: 'drop_now' },
  ],
];

export const STATUS_ACTIONS = (opts: {
  morningDone: boolean;
  eveningDone: boolean;
}): InlineKeyboardButton[][] => {
  const row: InlineKeyboardButton[] = [];
  if (!opts.morningDone) row.push({ text: '☀️ Morning now', callback_data: 'start_morning' });
  if (!opts.eveningDone) row.push({ text: '🌙 Journal now', callback_data: 'start_evening' });
  const rows: InlineKeyboardButton[][] = [];
  if (row.length > 0) rows.push(row);
  rows.push([
    { text: '📝 Drop', callback_data: 'drop_now' },
    { text: '📄 Last', callback_data: 'last_entry' },
  ]);
  return rows;
};
