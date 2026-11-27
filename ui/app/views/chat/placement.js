// Omnia Studio UI — "where should the file go?" dialog (artboard 6), built on openDialog.

import { html, raw } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, fmtBytes } from '../../core/i18n.js';
import { openDialog } from '../../core/overlay.js';

function choice(id, iconName, title, hint, isDefault) {
  const style = `padding: 12px; gap: 12px; text-align: left; color: var(--text-1);${isDefault ? ' border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent);' : ''}`;
  return html`<button class="card card--interactive row" type="button" data-dialog-action="${id}"${isDefault ? raw(' autofocus data-choice-default') : null} style="${style}">
      <span class="empty__icon" style="width: 32px; height: 32px;">${icon(iconName)}</span>
      <span class="col" style="gap: 2px;"><span class="strong text-sm">${title}</span><span class="text-xs muted">${hint}</span></span>
    </button>`;
}

/**
 * Resolves 'inline' | 'tray', or null when the user cancels (Esc, Huỷ, scrim). The caller must
 * not change anything on null. `items` = [{ name, size, mime }].
 */
export async function askPlacement({ items, defaultPlacement = 'inline' }) {
  const many = items.length > 1;
  const total = items.reduce((sum, item) => sum + item.size, 0);
  const description = many
    ? t('chat.placeMany', { n: items.length, size: fmtBytes(total) })
    : `${items[0].name} · ${fmtBytes(items[0].size)} · ${items[0].mime}`;
  const body = html`<div class="col" style="gap: 8px;">
      ${many ? html`<ul class="text-xs muted mono" style="margin: 0; padding-left: 18px;">${items.slice(0, 5).map((item) => html`<li class="truncate">${item.name}</li>`)}${items.length > 5 ? html`<li>… +${items.length - 5}</li>` : null}</ul>` : null}
      ${choice('inline', 'insert-inline', t('chat.placeInline'), t('chat.placeInlineHint'), defaultPlacement === 'inline')}
      ${choice('tray', 'tray', t('chat.placeTray'), t('chat.placeTrayHint'), defaultPlacement === 'tray')}
      <p class="text-xs muted" style="margin-top: 4px;">${t('chat.placeDedupe')}</p>
    </div>`;
  const result = await openDialog({
    title: many ? t('chat.placeTitleMany', { n: items.length }) : t('chat.placeTitle'),
    description,
    body,
    size: 'sm',
    initialFocus: '[data-choice-default]',
    actions: [
      { id: 'cancel', label: html`${t('common.cancel')}<span class="kbd">Esc</span>` },
      { id: defaultPlacement, label: t(defaultPlacement === 'inline' ? 'chat.placeInline' : 'chat.placeTray'), variant: 'primary' }
    ]
  });
  return result === 'inline' || result === 'tray' ? result : null;
}
