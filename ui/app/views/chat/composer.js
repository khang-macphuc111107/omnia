// Omnia Studio UI — composer templates and the textarea edit helper.

import { html, raw } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, getLang, fmtBytes } from '../../core/i18n.js';
import { describeError } from '../../api.js';
import { renderMath } from '../../lib/latex.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { markdownLabels } from './thread.js';
import { effectivePlacement } from './attachments.js';
import { CATEGORY_IDS, categoryCounts, filterTemplates, templateTitle } from './templates.js';
import { diffEdit } from './format.js';

export const INPUT_ID = 'chat-composer-input';

const TOOLBAR_GROUPS = [
  [
    ['heading', 'heading', 'fmtHeading'],
    ['bold', 'bold', 'fmtBold'],
    ['italic', 'italic', 'fmtItalic'],
    ['underline', 'underline', 'fmtUnderline'],
    ['code', 'code', 'fmtCode']
  ],
  [
    ['bullet', 'list', 'fmtBullet'],
    ['numbered', 'list-ordered', 'fmtNumbered'],
    ['task', 'checklist', 'fmtTask'],
    ['table', 'table', 'fmtTable'],
    ['quote', 'quote', 'fmtQuote']
  ]
];

function categoryLabel(id) {
  return t(`chat.cat${id === 'all' ? 'All' : id}`);
}

function popoverHtml(view) {
  const { popover, templates } = view;
  const items = templates.items;
  const counts = categoryCounts(items);
  const matches = filterTemplates(items, { category: popover.category, query: popover.query });
  let body;
  if (templates.status === 'loading' || templates.status === 'idle') {
    body = html`<div class="tpl-grid" aria-hidden="true">${[0, 1, 2, 3, 4, 5].map(() => html`<span class="skeleton" style="height: 84px;"></span>`)}</div><span class="sr-only" role="status">${t('chat.tplLoading')}</span>`;
  } else if (templates.status === 'error') {
    body = html`<div class="empty" style="padding: var(--sp-6);"><span class="empty__title">${t('chat.tplError')}</span><span class="empty__text">${describeError(templates.error)}</span>
        <button class="btn btn--sm" type="button" data-action="tpl-reload">${icon('refresh', { size: 'sm' })}${t('common.retry')}</button></div>`;
  } else if (!matches.length) {
    body = html`<div class="empty" style="padding: var(--sp-6);"><span class="empty__text">${t('chat.tplEmpty', { q: popover.query })}</span></div>`;
  } else {
    const lang = getLang();
    body = html`<div class="tpl-grid" role="group" aria-label="${t('chat.tplLabel')}">
        ${matches.map(
          (tpl, i) => html`<button class="tpl-card enter" type="button" data-key="tpl-${tpl.id}" data-action="tpl-insert" data-id="${tpl.id}" style="--i: ${Math.min(i, 12)}" title="${tpl.description}">
              <span class="tpl-card__title">${templateTitle(tpl, lang)}</span>
              <span class="tpl-card__math">${renderMath(tpl.latex)}</span>
            </button>`
        )}
      </div>`;
  }
  return html`<div class="popover chat-popover" role="dialog" aria-label="${t('chat.tplLabel')}" data-role="tpl-popover">
      <div class="popover__header">
        <div class="input-group grow">
          ${icon('search', { size: 'sm' })}
          <input class="input" type="search" data-role="tpl-search" placeholder="${t('chat.tplSearch')}" aria-label="${t('chat.tplSearchLabel')}" value="${popover.query}" autocomplete="off">
        </div>
        <div class="seg" role="tablist" aria-label="${t('chat.tplGroups')}">
          ${CATEGORY_IDS.map(
            (id) => html`<button class="seg__item" type="button" role="tab" data-key="cat-${id}" data-action="tpl-category" data-cat="${id}" aria-selected="${popover.category === id}" tabindex="${popover.category === id ? 0 : -1}">${categoryLabel(id)}<span class="count">${counts[id] ?? 0}</span></button>`
          )}
        </div>
        <button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="tpl-close" aria-label="${t('chat.tplClose')}">${icon('x', { size: 'sm' })}</button>
      </div>
      ${body}
    </div>`;
}

export function footerHtml(view) {
  const { saveState, draft } = view;
  const text = saveState === 'dirty' ? t('chat.saving') : saveState === 'failed' ? t('chat.saveFailed') : t('chat.saved', { rev: draft.rev });
  return html`<div class="row gap-3 text-xs muted wrap">
      <span>${t('chat.formats')}</span><span class="vr" style="height: 12px;"></span>
      <span class="num" data-role="draft-status" style="${saveState === 'failed' ? 'color: var(--danger);' : ''}">${text}</span>
    </div>
    <button class="btn btn--primary" type="button" data-action="send" title="${t('chat.sendTitle')}"${view.canSend ? null : raw(' disabled')}>${icon('send')}${t('chat.send')}<span class="kbd">Ctrl ↵</span></button>`;
}

export function previewInnerHtml(draft) {
  return renderMarkdown(draft.text, { attachments: draft.attachments, labels: markdownLabels() });
}

function trayHtml(draft) {
  if (!draft.attachments.length) return null;
  return html`<div class="composer__tray tray" aria-label="${t('chat.trayLabel')}">
      ${draft.attachments.map((att) => {
        const placement = effectivePlacement(att, draft.text);
        const label = t(placement === 'both' ? 'chat.placementBoth' : placement === 'inline' ? 'chat.placementInline' : 'chat.placementTray');
        return html`<div class="tray-item enter" data-key="tray-${att.sha256}">
            ${icon('file')}<span class="truncate">${att.name}</span><span class="muted num">${fmtBytes(att.size)}</span><span class="chip">${label}</span>
            <button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="remove-attachment" data-id="${att.id}" aria-label="${t('chat.removeAttachment', { name: att.name })}">${icon('x', { size: 'sm' })}</button>
          </div>`;
      })}
    </div>`;
}

function dropHtml(drop) {
  if (!drop) return null;
  const inline = drop === 'input';
  return html`<div class="chat-drop" aria-hidden="true">
      ${icon('upload', { size: 'lg' })}
      <span class="strong text-sm">${t(inline ? 'chat.dropInline' : 'chat.dropTray')}</span>
      <span class="text-xs muted">${t(inline ? 'chat.dropInlineHint' : 'chat.dropTrayHint')}</span>
    </div>`;
}

/** The composer region. `view` = { draft, previewOn, popover, templates, drop, saveState, canSend }. */
export function composerHtml(view) {
  const { draft, previewOn, popover } = view;
  const showPreview = previewOn && draft.text.trim() !== '';
  return html`<div class="composer chat-composer" data-editor data-key="composer"${view.drop ? raw(' data-drop="true"') : null}>
      ${popover.open ? popoverHtml(view) : null}
      <div class="composer__toolbar" role="toolbar" aria-label="${t('chat.toolbar')}">
        ${TOOLBAR_GROUPS.map(
          (group, index) => html`${index ? html`<span class="vr" style="height: 16px; margin: 0 4px;"></span>` : null}${group.map(
            ([id, iconName, key]) => html`<button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="format" data-format="${id}" aria-label="${t(`chat.${key}`)}" title="${t(`chat.${key}`)}">${icon(iconName, { size: 'sm' })}</button>`
          )}`
        )}
        <span class="vr" style="height: 16px; margin: 0 4px;"></span>
        <button class="btn btn--ghost btn--sm" type="button" data-action="tpl-toggle" data-role="tpl-button" aria-expanded="${popover.open}" aria-haspopup="dialog">${icon('sigma', { size: 'sm' })}${t('chat.formulas')}</button>
        <button class="btn btn--ghost btn--sm" type="button" data-action="attach">${icon('paperclip', { size: 'sm' })}${t('chat.attach')}</button>
        <span class="grow"></span>
        <button class="btn btn--ghost btn--sm" type="button" data-action="toggle-preview" aria-pressed="${previewOn}">${icon('eye', { size: 'sm' })}${t('chat.preview')}</button>
      </div>
      <label class="sr-only" for="${INPUT_ID}">${t('chat.inputLabel')}</label>
      <textarea id="${INPUT_ID}" class="composer__input" rows="3" placeholder="${t('chat.placeholder')}" data-preserve="style"></textarea>
      ${showPreview ? html`<div class="composer__preview prose" data-role="preview" aria-label="${t('chat.previewLabel')}">${view.previewHtml}</div>` : null}
      ${trayHtml(draft)}
      <div class="composer__footer" data-role="footer">${footerHtml(view)}</div>
      <input type="file" multiple hidden data-role="file-input" tabindex="-1">
      ${dropHtml(view.drop)}
    </div>`;
}

/**
 * Replace [from, to) in a textarea the way typing would (keeps native undo where the browser
 * allows it), then set the selection. Always fires an `input` event.
 */
export function replaceRange(textarea, from, to, insert, selectionStart, selectionEnd) {
  const before = textarea.value;
  const expected = before.slice(0, from) + insert + before.slice(to);
  textarea.focus();
  textarea.setSelectionRange(from, to);
  let done = false;
  try {
    done = insert === '' ? document.execCommand('delete') : document.execCommand('insertText', false, insert);
  } catch {
    done = false;
  }
  if (!done || textarea.value !== expected) {
    textarea.value = expected;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  textarea.setSelectionRange(selectionStart, selectionEnd);
}

/** Apply a pure editor state (from format.js) to the textarea. */
export function applyEditorState(textarea, next) {
  const edit = diffEdit(textarea.value, next.value);
  if (edit) replaceRange(textarea, edit.from, edit.to, edit.insert, next.start, next.end);
  else {
    textarea.focus();
    textarea.setSelectionRange(next.start, next.end);
  }
}

export function autosize(textarea) {
  textarea.style.height = 'auto';
  const max = Math.round(window.innerHeight * 0.4);
  textarea.style.height = `${Math.min(textarea.scrollHeight + 2, max)}px`;
}
