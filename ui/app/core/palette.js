// Omnia Studio UI — command palette (Ctrl+K).
//
// Any module can contribute commands:
//   registerCommands(() => [
//     { id: 'chat.insert-maxwell', group: t('chat.cmdGroup'), title: t('chat.cmdInsert', {name}),
//       keywords: 'latex maxwell', shortcut: 'Alt 1', icon: 'sigma', run: () => … },
//   ]);
// Providers are called each time the palette opens, so they can read live state.
// Matching is accent-insensitive: "dinh tuyen" finds "Định tuyến".

import { html, morph, uid } from './dom.js';
import { icon } from './icons.js';
import { t, fold } from './i18n.js';
import { openOverlay } from './overlay.js';

const providers = new Set();
let active = null; // { close }

export function registerCommands(provider) {
  providers.add(provider);
  return () => providers.delete(provider);
}

function collect() {
  const out = [];
  for (const provider of providers) {
    try {
      const list = provider() || [];
      for (const command of list) {
        if (command && typeof command.run === 'function' && (!command.when || command.when())) out.push(command);
      }
    } catch (error) {
      console.error('[omnia] command provider failed', error);
    }
  }
  return out;
}

export function scoreCommand(command, query) {
  const needle = fold(query).trim();
  if (!needle) return 1;
  const haystack = fold(`${command.title} ${command.keywords || ''} ${command.group || ''}`);
  const at = haystack.indexOf(needle);
  if (at >= 0) return 200 - Math.min(at, 150);
  const words = needle.split(/\s+/).filter(Boolean);
  if (words.every((word) => haystack.includes(word))) return 60;
  let index = 0;
  for (const ch of needle.replace(/\s+/g, '')) {
    index = haystack.indexOf(ch, index);
    if (index < 0) return 0;
    index += 1;
  }
  return 10;
}

export function isPaletteOpen() {
  return active !== null;
}

export function closePalette() {
  if (active) active.close(null);
}

export function openPalette(initialQuery = '') {
  if (active) return;
  const listId = uid('pal-list');
  const optionId = (i) => `${listId}-opt-${i}`;
  const state = { query: initialQuery, index: 0, results: [] };
  const commands = collect();

  const overlay = openOverlay({
    className: 'palette',
    label: t('palette.label'),
    initialFocus: '.palette__input',
    content: html`
      <div class="palette__search">
        ${icon('search')}
        <input class="palette__input" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list"
          aria-controls="${listId}" aria-label="${t('palette.label')}" placeholder="${t('palette.placeholder')}"
          autocomplete="off" spellcheck="false" value="${initialQuery}">
        <span class="kbd">Esc</span>
      </div>
      <div class="palette__list" id="${listId}" role="listbox" aria-label="${t('palette.label')}"></div>
      <div class="palette__footer">
        <span><span class="kbd">↑</span> <span class="kbd">↓</span> ${t('palette.move')}</span>
        <span><span class="kbd">Enter</span> ${t('palette.run')}</span>
        <span><span class="kbd">Esc</span> ${t('palette.close')}</span>
      </div>`,
    onKeydown: (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!state.results.length) return;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        state.index = (state.index + delta + state.results.length) % state.results.length;
        paint();
      } else if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        runAt(state.index);
      }
    }
  });
  active = overlay;
  overlay.closed.then(() => {
    active = null;
  });

  const input = overlay.el.querySelector('.palette__input');
  const list = overlay.el.querySelector('.palette__list');

  function filter() {
    state.results = commands
      .map((command) => ({ command, score: scoreCommand(command, state.query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command);
    // Keep group order stable: group by first appearance in the ranked list.
    const groups = new Map();
    for (const command of state.results) {
      const group = command.group || t('palette.groupApp');
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(command);
    }
    state.results = Array.from(groups.values()).flat();
    state.index = Math.min(state.index, Math.max(0, state.results.length - 1));
  }

  function paint() {
    if (!state.results.length) {
      morph(list, html`<p class="palette__group" role="presentation">${t('palette.empty')}</p>`);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let lastGroup = null;
    const rows = [];
    state.results.forEach((command, i) => {
      const group = command.group || t('palette.groupApp');
      if (group !== lastGroup) {
        rows.push(html`<div class="palette__group" role="presentation" data-key="g-${group}">${group}</div>`);
        lastGroup = group;
      }
      rows.push(html`<div class="palette__item" role="option" id="${optionId(i)}" data-key="c-${command.id}" data-index="${i}" aria-selected="${i === state.index}">
          ${icon(command.icon || 'arrow-right')}<span class="truncate">${command.title}</span>${command.shortcut ? html`<span class="kbd">${command.shortcut}</span>` : null}
        </div>`);
    });
    morph(list, html`${rows}`);
    input.setAttribute('aria-activedescendant', optionId(state.index));
    const selected = list.querySelector('[aria-selected="true"]');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  function runAt(index) {
    const command = state.results[index];
    if (!command) return;
    overlay.close(command.id);
    // Run after focus has been restored to the opener.
    setTimeout(() => {
      try {
        command.run();
      } catch (error) {
        console.error('[omnia] command failed', error);
      }
    }, 0);
  }

  input.addEventListener('input', () => {
    state.query = input.value;
    state.index = 0;
    filter();
    paint();
  });
  list.addEventListener('mousemove', (event) => {
    const row = event.target instanceof Element ? event.target.closest('[data-index]') : null;
    if (!row) return;
    const index = Number(row.getAttribute('data-index'));
    if (index !== state.index) {
      state.index = index;
      paint();
    }
  });
  list.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest('[data-index]') : null;
    if (row) runAt(Number(row.getAttribute('data-index')));
  });

  filter();
  paint();
}
