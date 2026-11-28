// Omnia Studio UI — conversation thread templates (pure: state in, SafeHtml out).

import { html, raw, escapeHtml } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, getLang, fmtNumber, fmtTime, fmtBytes } from '../../core/i18n.js';
import { ApiError, describeError } from '../../api.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { rejectedScores } from './local-store.js';

const STAGGER_CAP = 12;

export function markdownLabels() {
  return {
    copy: t('common.copy'),
    copyCode: t('chat.copyCode'),
    plain: t('chat.plainCode'),
    taskDone: t('chat.attachTaskDone'),
    taskOpen: t('chat.attachTaskOpen')
  };
}

// Rendered markdown is cached per message; the key covers everything the output depends on.
const cache = new Map();

export function messageBody(message) {
  const key = `${message.id}|${getLang()}|${message.markdown.length}|${message.attachments.map((a) => a.sha256.slice(0, 8)).join(',')}`;
  let out = cache.get(key);
  if (!out) {
    if (cache.size > 500) cache.clear();
    out = renderMarkdown(message.markdown, { attachments: message.attachments, labels: markdownLabels() });
    cache.set(key, out);
  }
  return out;
}

const TIER = {
  strict_local_zero_retention: { key: 'tierStrict', status: 'ok' },
  enterprise_zdr: { key: 'tierZdr', status: 'ok' },
  private_vpc: { key: 'tierVpc', status: 'info' },
  standard_cloud: { key: 'tierCloud', status: 'warn' }
};

export function privacyChip(tier) {
  const meta = TIER[tier];
  if (!meta) return null;
  return html`<span class="status status--${meta.status}">${icon('shield')}${t(`chat.${meta.key}`)}</span>`;
}

const REASON = { privacy_boundary_violation: 'reasonPrivacy', quota_stale: 'reasonQuotaStale', context_limit_exceeded: 'reasonContext' };

export function reasonText(code) {
  return REASON[code] ? `${t(`chat.${REASON[code]}`)} (${code})` : String(code || '—');
}

function errorText(code) {
  if (code === 'interrupted') return t('chat.routeInterrupted');
  return describeError(new ApiError({ code }));
}

function attachmentChip(att) {
  return html`<span class="att">${icon('file', { size: 'sm' })}<span>${att.name}</span><span class="mono">${fmtBytes(att.size)} · ${att.id}</span></span>`;
}

function routeEvent(message, index, stagger) {
  const route = message.route;
  const policy = route.policy || {};
  const estimate = policy.estimatedTokens
    ? html`<span class="chip num" title="${t('chat.estimatedTitle')}">${t('chat.estimated', { n: fmtNumber(policy.estimatedTokens) })}</span>`
    : null;
  const note = html`<span class="event__note">${t('chat.noteLocal')}</span>`;
  const style = stagger ? `--i: ${Math.min(index, STAGGER_CAP)}` : '';
  const attrs = (state) => `data-key="e-${escapeHtml(message.id)}" data-state="${state}"`;
  const receipt = route.receipt;

  if (route.state === 'pending') {
    return html`<div class="event enter" role="note" aria-busy="true" style="${style}" ${raw(attrs('pending'))}>
        <span class="status status--info">${icon('clock')}${t('chat.statePending')}</span>
        <span>${t('chat.routePending')}</span>${estimate}
        <button class="btn btn--ghost btn--sm" type="button" data-action="cancel-route" data-id="${message.id}">${icon('stop', { size: 'sm' })}${t('common.cancel')}</button>${note}
      </div>`;
  }
  if (route.state === 'cancelled') {
    const ack = route.cancelAck || {};
    const reconciled = ack.routerCancelled === true || ack.chatStopped === true;
    return html`<div class="event enter" role="note" style="${style}" ${raw(attrs('cancelled'))}>
        <span class="status status--warn">${icon('stop')}${t('chat.stateCancelled')}</span>
        <span>${t('chat.routeCancelled')}</span>
        ${reconciled ? html`<span class="chip">${t('chat.cancelReconciled')}</span>` : null}${estimate}
        <button class="btn btn--sm" type="button" data-action="retry-route" data-id="${message.id}">${icon('refresh', { size: 'sm' })}${t('common.retry')}</button>
        <span class="event__note">${t('chat.routeCancelledHint')}</span>${note}
      </div>`;
  }
  if (route.state === 'routed') {
    return html`<div class="event enter" role="note" style="${style}" ${raw(attrs('routed'))}>
        ${icon('route')}<span>${t('chat.routeRouted')}</span>
        <span class="strong mono">${route.selectedCandidateId}</span>
        ${receipt ? html`<span class="chip chip--mono">${receipt.receiptId}</span>` : null}
        ${receipt ? html`<span class="chip num">${t('chat.reserved', { n: fmtNumber(receipt.reservedTokens) })}</span>` : null}
        ${privacyChip(policy.privacyTier)}
        <button class="btn btn--ghost btn--sm" type="button" data-action="view-receipt" data-id="${message.id}">${t('chat.viewReceipt')}</button>${note}
      </div>`;
  }
  if (route.state === 'fenced') {
    const rejected = rejectedScores(route);
    const shown = rejected.slice(0, 5);
    return html`<div class="event enter" role="note" style="${style}" ${raw(attrs('fenced'))}>
        <span class="status status--warn">${icon('alert')}${t('chat.stateFenced')}</span>
        <span>${t('chat.routeFenced')}</span>
        ${receipt ? html`<span class="chip chip--mono">${receipt.receiptId}</span>` : null}${estimate}
        <button class="btn btn--ghost btn--sm" type="button" data-action="view-receipt" data-id="${message.id}">${t('chat.viewReceipt')}</button>
        <span class="event__note">${t('chat.routeFencedHint')}</span>
        ${shown.length
          ? html`<span class="event__note row wrap">${shown.map((entry) => html`<span class="chip" title="${reasonText(entry.rejectedReason)}"><span class="mono">${entry.candidateId}</span> · ${entry.rejectedReason || '—'}</span>`)}${rejected.length > shown.length ? html`<span class="chip">${t('chat.more', { n: rejected.length - shown.length })}</span>` : null}</span>`
          : null}${note}
      </div>`;
  }
  return html`<div class="event enter" role="note" style="${style}" ${raw(attrs('error'))}>
      <span class="status status--danger">${icon('stop')}${t('chat.stateError')}</span>
      <span>${t('chat.routeError')}: ${errorText(route.errorCode)}</span>
      <span class="chip chip--mono">${route.errorCode || 'unknown'}</span>${estimate}
      ${!policy.idempotencyKey ? html`<span class="event__note">${t('chat.unkeyedRetry')}</span>` : null}
      <button class="btn btn--sm" type="button" data-action="retry-route" data-id="${message.id}">${icon('refresh', { size: 'sm' })}${t(policy.idempotencyKey ? 'common.retry' : 'chat.newDecision')}</button>${note}
    </div>`;
}

function messageNode(message, index, stagger) {
  const style = stagger ? `--i: ${Math.min(index, STAGGER_CAP)}` : '';
  const trayItems = message.attachments.filter((att) => att.placement !== 'inline');
  return html`<article class="msg enter" data-key="m-${message.id}" style="${style}">
      <div class="msg__head">
        <span class="avatar avatar--accent" aria-hidden="true">${t('chat.you').slice(0, 1).toUpperCase()}</span>
        <span class="msg__author">${t('chat.you')}</span>
        <time class="msg__time" datetime="${new Date(message.createdAt).toISOString()}">${fmtTime(message.createdAt)}</time>
      </div>
      <div class="msg__bubble prose">${messageBody(message)}${trayItems.length ? html`<div class="tray" aria-label="${t('chat.trayLabel')}">${trayItems.map(attachmentChip)}</div>` : null}</div>
    </article>
    ${routeEvent(message, index, stagger)}`;
}

function banner(hidden) {
  if (hidden) return null;
  return html`<div class="banner banner--info" data-key="local-banner">
      ${icon('info', { className: 'banner__icon' })}
      <div class="banner__body"><span class="banner__title">${t('chat.localTitle')}</span><span>${t('chat.localBody')}</span></div>
      <button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="hide-banner" aria-label="${t('chat.hideBanner')}">${icon('x', { size: 'sm' })}</button>
    </div>`;
}

function stateBlock({ iconName, title, text, action, tone }) {
  return html`<div class="empty enter" style="padding-top: 72px;">
      <span class="empty__icon"${tone ? raw(` style="color: var(--${tone});"`) : null}>${icon(iconName, { size: 'lg' })}</span>
      <h2 class="empty__title">${title}</h2>
      ${text ? html`<p class="empty__text">${text}</p>` : null}
      ${action || null}
    </div>`;
}

/** The whole scrollable region. `view` = { sessionState, sessionId, error, chat, bannerHidden, stagger }. */
export function threadHtml(view) {
  const { sessionState, sessionId, error, chat, bannerHidden, stagger } = view;
  if (sessionState === 'loading') {
    return html`<div class="thread" aria-busy="true">
        <div class="col" style="gap: 14px;" aria-hidden="true">${[70, 52, 84].map((w) => html`<div class="col" style="gap: 6px;"><span class="skeleton" style="height: 12px; width: ${w}%;"></span><span class="skeleton" style="height: 10px; width: 40%;"></span></div>`)}</div>
        <span class="sr-only" role="status">${t('chat.loadingSessions')}</span>
      </div>`;
  }
  if (sessionState === 'error') {
    return html`<div class="thread">${stateBlock({
      iconName: 'alert',
      tone: 'danger',
      title: t('chat.sessionsErrorTitle'),
      text: describeError(error),
      action: html`<button class="btn btn--sm" type="button" data-action="reload-sessions">${icon('refresh', { size: 'sm' })}${t('common.retry')}</button>`
    })}</div>`;
  }
  if (sessionState === 'empty') {
    return html`<div class="thread">${stateBlock({
      iconName: 'chat',
      title: t('chat.noSessionsTitle'),
      text: t('chat.noSessionsText'),
      action: html`<button class="btn btn--primary btn--sm" type="button" data-action="new-session">${icon('plus', { size: 'sm' })}${t('shell.newSession')}</button>`
    })}</div>`;
  }
  if (sessionState === 'unknown') {
    return html`<div class="thread">${stateBlock({
      iconName: 'search',
      title: t('chat.unknownTitle'),
      text: t('chat.unknownText', { id: sessionId }),
      action: html`<a class="btn btn--sm" href="#/chat">${t('chat.backToChat')}</a>`
    })}</div>`;
  }
  const messages = chat.messages;
  return html`<div class="thread">
      ${banner(bannerHidden)}
      ${messages.length
        ? messages.map((message, index) => messageNode(message, index, stagger))
        : stateBlock({
            iconName: 'chat',
            title: t('chat.emptyTitle'),
            text: t('chat.emptyText'),
            action: html`<div class="row wrap" style="justify-content: center;">
                <button class="btn" type="button" data-action="open-templates">${icon('sigma')}${t('chat.emptyInsert')}</button>
                <button class="btn" type="button" data-action="attach">${icon('paperclip')}${t('chat.emptyAttach')}</button>
              </div>`
          })}
    </div>`;
}
