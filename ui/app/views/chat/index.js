// Omnia Studio UI — Workspace view: #/chat and #/chat/<sessionId>.
// Layout, behaviour and data contract: docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md §6.1.

import { registerView } from '../../core/router.js';
import { registerCommands } from '../../core/palette.js';
import { t, getLang } from '../../core/i18n.js';
import './strings.js';
import { createChat, activeChat } from './controller.js';
import { templateTitle } from './templates.js';

registerView({
  id: 'chat',
  order: 1,
  shortcut: '1',
  icon: 'chat',
  placement: 'main',
  label: () => t('nav.chat'),
  title: () => t('nav.chat'),
  mount(host, route) {
    return createChat(host, route);
  }
});

// Registered once for the lifetime of the page; every command is gated on the view being mounted
// with a usable session, so nothing shows up in the palette on other screens.
registerCommands(() => {
  const chat = activeChat();
  if (!chat || !chat.usable()) return [];
  const group = t('chat.cmdGroup');
  const lang = getLang();
  return [
    { id: 'chat.focus', group, title: t('chat.cmdFocus'), keywords: 'composer focus soan thao', icon: 'edit', run: () => chat.focusComposer() },
    { id: 'chat.preview', group, title: t('chat.cmdPreview'), keywords: 'preview xem truoc markdown', icon: 'eye', run: () => chat.togglePreview() },
    { id: 'chat.inspector', group, title: t('chat.cmdInspector'), keywords: 'inspector chi tiet receipt steer', icon: 'panel-right', shortcut: 'Ctrl .', run: () => chat.toggleInspector() },
    { id: 'chat.attach', group, title: t('chat.cmdAttach'), keywords: 'attach file dinh kem tep', icon: 'paperclip', run: () => chat.attach() },
    ...chat.templates().map((template) => ({
      id: `chat.insert.${template.id}`,
      group,
      title: t('chat.cmdInsert', { name: templateTitle(template, lang) }),
      keywords: `latex formula cong thuc ${template.title} ${template.category} ${template.symbol}`,
      icon: 'sigma',
      run: () => chat.insertTemplate(template)
    }))
  ];
});
