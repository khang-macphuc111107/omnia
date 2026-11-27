// Knowledge view: memory vault, skill search and RAG planner (spec §6.4).
// Routes: #/knowledge/memory | skills | rag (default memory).

import { registerView, navigate, buildHash, currentRoute } from '../../core/router.js';
import { registerCommands } from '../../core/palette.js';
import { html, morph, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, fmtNumber } from '../../core/i18n.js';
import { rovingFocus } from '../../core/overlay.js';
import { connection } from '../../api.js';
import './strings.js';
import { DEFAULT_TAB, TABS, tabFromRoute } from './helpers.js';
import { mountMemory, memoryStore, memoryCount, loadMemory } from './memory.js';
import { mountSkills, skillsStore, skillsCount, SEARCH_ID } from './skills.js';
import { mountRag, runRag, QUERY_ID } from './rag.js';

const TAB_META = {
  memory: { icon: 'database', labelKey: 'knowledge.tabMemory' },
  skills: { icon: 'layers', labelKey: 'knowledge.tabSkills' },
  rag: { icon: 'search', labelKey: 'knowledge.tabRag' }
};

const PANELS = { memory: mountMemory, skills: mountSkills, rag: mountRag };

let pendingFocusSearch = false;

function onKnowledgeTab(tab) {
  const route = currentRoute();
  return route.view === 'knowledge' && (tab ? (tabFromRoute(route) || DEFAULT_TAB) === tab : true);
}

function focusSkillSearch() {
  pendingFocusSearch = true;
  if (onKnowledgeTab('skills')) {
    requestAnimationFrame(() => {
      document.getElementById(SEARCH_ID)?.focus();
      pendingFocusSearch = false;
    });
  } else navigate(buildHash('knowledge', 'skills'));
}

registerCommands(() => {
  const group = t('knowledge.cmdGroup');
  const commands = TABS.map((id) => ({
    id: `knowledge.open-${id}`,
    group,
    title: t('knowledge.cmdOpen', { name: t(TAB_META[id].labelKey) }),
    keywords: `knowledge tri thuc ${id} ${t(TAB_META[id].labelKey)}`,
    icon: TAB_META[id].icon,
    run: () => navigate(buildHash('knowledge', id))
  }));
  commands.push(
    {
      id: 'knowledge.skill-search',
      group,
      title: t('knowledge.cmdSkillSearch'),
      keywords: 'skill search ky nang tim kiem',
      icon: 'search',
      run: focusSkillSearch
    },
    {
      id: 'knowledge.rag-run',
      group,
      title: t('knowledge.cmdRagRun'),
      keywords: 'rag plan phan tich ke hoach truy xuat',
      icon: 'play',
      shortcut: 'Ctrl Enter',
      when: () => onKnowledgeTab('rag'),
      run: () => {
        runRag();
        requestAnimationFrame(() => document.getElementById(QUERY_ID)?.focus());
      }
    },
    {
      id: 'knowledge.memory-refresh',
      group,
      title: t('knowledge.cmdMemoryRefresh'),
      keywords: 'memory refresh bo nho lam moi',
      icon: 'refresh',
      when: () => onKnowledgeTab('memory'),
      run: loadMemory
    }
  );
  return commands;
});

function topbar(tab) {
  const counts = {
    memory: memoryCount(),
    skills: skillsCount() ?? (connection.get().health ? connection.get().health.skillCount : null),
    rag: null
  };
  return html`<h1 class="topbar__title">${t('nav.knowledge')}</h1>
    <div class="tabs knowledge-tabs" role="tablist" aria-label="${t('knowledge.tablist')}">
      ${TABS.map((id) => {
        const selected = id === tab;
        const count = counts[id];
        return html`<a class="tab" role="tab" id="knowledge-tab-${id}" href="${buildHash('knowledge', id)}" aria-selected="${selected}" aria-controls="knowledge-panel" tabindex="${selected ? 0 : -1}" data-key="tab:${id}">${icon(TAB_META[id].icon, { size: 'sm' })}${t(TAB_META[id].labelKey)}${Number.isFinite(count) ? html` <span class="count">${fmtNumber(count)}</span>` : null}</a>`;
      })}
    </div>`;
}

registerView({
  id: 'knowledge',
  order: 4,
  shortcut: '4',
  icon: 'book',
  placement: 'main',
  label: () => t('nav.knowledge'),
  title: () => t('nav.knowledge'),
  mount(host, route) {
    render(host, html`<header class="topbar"></header><div class="view__body knowledge-body" role="tabpanel" id="knowledge-panel"></div>`);
    const topbarEl = host.querySelector('.topbar');
    const bodyEl = host.querySelector('.knowledge-body');

    let tab = null;
    let panel = null;

    const paintTopbar = () => {
      morph(topbarEl, topbar(tab));
      bodyEl.setAttribute('aria-labelledby', `knowledge-tab-${tab}`);
    };

    function show(next, { focusSearch = false } = {}) {
      if (next === tab && panel) return;
      if (panel) panel.unmount();
      bodyEl.replaceChildren();
      tab = next;
      panel = PANELS[tab](bodyEl, { focusSearch });
      paintTopbar();
    }

    function resolve(current, { replace }) {
      let next = tabFromRoute(current);
      if (!next) {
        next = DEFAULT_TAB;
        // Mounting happens inside the router's own handler: rewrite the URL without re-entering it.
        if (replace === 'history') window.history.replaceState(null, '', buildHash('knowledge', next));
        else navigate(buildHash('knowledge', next), { replace: true });
      }
      return next;
    }

    const takeFocusFlag = () => {
      const flag = pendingFocusSearch;
      pendingFocusSearch = false;
      return flag;
    };

    show(resolve(route, { replace: 'history' }), { focusSearch: takeFocusFlag() });

    const stops = [
      memoryStore.subscribe(paintTopbar),
      skillsStore.subscribe((state, prev) => {
        if (state.catalogTotal !== prev.catalogTotal) paintTopbar();
      }),
      connection.subscribe((state, prev) => {
        if (state.health !== prev.health) paintTopbar();
      }),
      rovingFocus(topbarEl, '.tab', { onActivate: (el) => navigate(el.getAttribute('href')) })
    ];

    return {
      update(next) {
        const wanted = resolve(next, { replace: 'navigate' });
        if (wanted !== tab) show(wanted, { focusSearch: takeFocusFlag() });
        else {
          // Language change or same-route refresh: repaint texts.
          paintTopbar();
          if (panel && panel.refresh) panel.refresh();
          if (takeFocusFlag() && tab === 'skills') document.getElementById(SEARCH_ID)?.focus();
        }
      },
      unmount() {
        stops.forEach((stop) => stop());
        if (panel) panel.unmount();
        panel = null;
      }
    };
  }
});
