// Omnia Studio UI — inspector panel templates (pure: state in, SafeHtml out).

import { html, raw } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, fmtNumber, fmtTime, fmtBytes } from '../../core/i18n.js';
import { ApiError, describeError } from '../../api.js';
import { privacyChip, reasonText } from './thread.js';
import { receiptMessage, selectedScore, rejectedScores, scoreShares } from './local-store.js';
import { effectivePlacement } from './attachments.js';

export const STEER_FORM_MODES = [
  { id: 'additive', key: 'modeAdditive' },
  { id: 'boundary_correction', key: 'modeBoundary' },
  { id: 'explicit_stop_or_replace', key: 'modeStop' }
];

function section({ id, open, title, count, body }) {
  return html`<details class="disclosure" data-section="${id}"${open ? raw(' open') : null}>
      <summary>${icon('chevron-right', { size: 'sm', className: 'chev' })}${title}${count !== undefined && count !== null ? html`<span class="count${typeof count === 'string' ? ' mono' : ''}">${count}</span>` : null}</summary>
      <div class="disclosure__body">${body}</div>
    </details>`;
}

const STATE_STATUS = {
  pending: { cls: 'info', icon: 'clock', key: 'statePending' },
  routed: { cls: 'ok', icon: 'check-circle', key: 'stateRouted' },
  fenced: { cls: 'warn', icon: 'alert', key: 'stateFenced' },
  error: { cls: 'danger', icon: 'stop', key: 'stateError' }
};

const LEGEND = [
  ['s1', 'legendCapability'],
  ['s2', 'legendPrivacy'],
  ['s3', 'legendQuota'],
  ['s4', 'legendLatency'],
  ['s5', 'legendReliability']
];

function receiptBody(view) {
  const message = receiptMessage(view.chat.messages, view.receiptFocus);
  if (!message) {
    return html`<p class="text-sm subtle">${t('chat.receiptNone')}</p><p class="text-xs muted">${t('chat.receiptNoneHint')}</p>`;
  }
  const route = message.route;
  const receipt = route.receipt;
  const status = STATE_STATUS[route.state] || STATE_STATUS.error;
  const policy = route.policy || {};
  const score = selectedScore(route);
  const rejected = rejectedScores(route);
  const isLatest = receiptMessage(view.chat.messages, null) === message;

  return html`
    <div class="row between">
      <span class="status status--${status.cls}">${icon(status.icon)}${t(`chat.${status.key}`)}</span>
      <span class="text-xs muted num">${fmtTime(message.createdAt, true)}</span>
    </div>
    ${isLatest ? null : html`<button class="btn btn--ghost btn--sm" type="button" data-action="receipt-latest" style="align-self: flex-start;">${t('chat.receiptLatest')}</button>`}
    ${route.state === 'error'
      ? html`<p class="text-sm">${route.errorCode === 'interrupted' ? t('chat.routeInterrupted') : describeError(new ApiError({ code: route.errorCode }))}</p><p class="text-xs muted mono">${route.errorCode}</p>`
      : null}
    <dl class="kv">
      ${receipt ? html`<dt>${t('chat.kvReceipt')}</dt><dd class="mono">${receipt.receiptId}</dd>` : null}
      ${route.selectedCandidateId ? html`<dt>${t('chat.kvRoute')}</dt><dd class="mono">${route.selectedCandidateId}</dd>` : null}
      ${receipt ? html`<dt>${t('chat.kvPolicy')}</dt><dd class="mono">${receipt.policyClass}</dd><dt>${t('chat.kvHash')}</dt><dd class="mono text-xs">${receipt.policyHash}</dd>` : null}
      ${policy.privacyTier ? html`<dt>${t('chat.kvPrivacy')}</dt><dd>${privacyChip(policy.privacyTier)}</dd>` : null}
      ${receipt ? html`<dt>${t('chat.kvReserved')}</dt><dd class="num">${t('chat.tokens', { n: fmtNumber(receipt.reservedTokens) })}</dd>` : null}
      ${policy.estimatedTokens ? html`<dt>${t('chat.kvEstimated')}</dt><dd class="num">${t('chat.tokens', { n: fmtNumber(policy.estimatedTokens) })} · <span class="mono">${policy.taskClass}</span></dd>` : null}
      ${receipt ? html`<dt>${t('chat.kvPrompt')}</dt><dd>${receipt.promptRedacted ? t('chat.redacted') : t('chat.notRedacted')}</dd><dt>${t('chat.kvSecrets')}</dt><dd class="num">${fmtNumber(receipt.secretsExposed)}</dd>` : null}
      ${receipt && receipt.estimatedCostMicrounits !== null && receipt.estimatedCostMicrounits !== undefined ? html`<dt>${t('chat.kvCost')}</dt><dd class="num">${fmtNumber(receipt.estimatedCostMicrounits)}</dd>` : null}
      ${receipt ? html`<dt>${t('chat.kvSequence')}</dt><dd class="num">${fmtNumber(receipt.sequenceId)}</dd>` : null}
    </dl>
    ${score
      ? (() => {
          const { parts, shares } = scoreShares(score);
          return html`<div class="col" style="gap: 6px;">
              <div class="row between text-xs"><span class="subtle">${t('chat.score')}</span><span class="strong num">${fmtNumber(score.totalScore)} / 100</span></div>
              <div class="stackbar" role="img" aria-label="${t('chat.scoreAria', { a: parts[0], b: parts[1], c: parts[2], d: parts[3], e: parts[4] })}">
                ${shares.map((share, i) => html`<span class="s${i + 1}" style="width: ${share.toFixed(2)}%;"></span>`)}
              </div>
              <div class="legend">${LEGEND.map(([cls, key]) => html`<span class="legend__item"><span class="swatch ${cls}"></span>${t(`chat.${key}`)}</span>`)}</div>
            </div>`;
        })()
      : null}
    ${rejected.length
      ? html`<div class="col" style="gap: 6px;">
          <span class="section-title">${t('chat.rejected')}</span>
          <ul class="col" style="list-style: none; padding: 0; margin: 0; gap: 4px;">
            ${rejected.map((entry) => html`<li class="row between text-xs" data-key="rej-${entry.candidateId}"><span class="mono truncate">${entry.candidateId}</span><span class="chip" title="${reasonText(entry.rejectedReason)}">${entry.rejectedReason || '—'}</span></li>`)}
          </ul>
        </div>`
      : null}
    <a class="btn btn--sm" href="#/routing" style="align-self: flex-start;">${t('chat.openRouting')}${icon('arrow-right', { size: 'sm' })}</a>`;
}

const STEER_STATUS = {
  queued: { cls: '', icon: 'clock', key: 'statusQueued' },
  in_progress: { cls: 'status--info', icon: 'clock', key: 'statusInProgress' },
  completed: { cls: 'status--ok', icon: 'check', key: 'statusCompleted' }
};

function steerBody(view) {
  const { steer, steerForm } = view;
  const items = steer.items.slice().sort((a, b) => b.seq - a.seq);
  let list;
  if (steer.status === 'loading' || (steer.status === 'idle' && !items.length)) {
    list = html`<div class="col" style="gap: 8px;" aria-hidden="true"><span class="skeleton" style="height: 52px;"></span><span class="skeleton" style="height: 52px;"></span></div><span class="sr-only" role="status">${t('chat.steerLoading')}</span>`;
  } else if (steer.status === 'error' && !items.length) {
    list = html`<div class="banner banner--danger"><div class="banner__body"><span class="banner__title">${t('chat.steerError')}</span><span>${describeError(steer.error)}</span></div><button class="btn btn--sm" type="button" data-action="steer-reload">${t('common.retry')}</button></div>`;
  } else if (!items.length) {
    list = html`<p class="text-xs muted">${t('chat.steerEmpty')}</p>`;
  } else {
    list = html`<ol class="col" style="list-style: none; padding: 0; margin: 0;">
        ${items.map((item) => {
          const status = STEER_STATUS[item.status] || STEER_STATUS.queued;
          return html`<li class="card enter" data-key="steer-${item.id}" style="padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;">
              <div class="row between"><span class="mono text-xs muted">#${item.seq} · ${item.mode}</span><span class="status ${status.cls}">${icon(status.icon)}${t(`chat.${status.key}`)}</span></div>
              <p class="text-sm${item.status === 'completed' ? ' subtle' : ''}">${item.text}</p>
            </li>`;
        })}
      </ol>`;
  }
  const stale = steer.status === 'error' && items.length
    ? html`<p class="text-xs" style="color: var(--warn);">${t('chat.steerStale')} ${describeError(steer.error)} <button class="btn btn--ghost btn--sm" type="button" data-action="steer-reload">${t('common.retry')}</button></p>`
    : null;
  return html`
    <p class="text-xs muted">${t('chat.steerHint')} · <span class="mono">token_budget = ${steer.tokenBudget === null || steer.tokenBudget === undefined ? 'null' : steer.tokenBudget}</span></p>
    ${list}${stale}
    ${steer.updatedAt ? html`<p class="text-xs muted num">${t('chat.steerUpdated', { time: fmtTime(steer.updatedAt, true) })}</p>` : null}
    <div class="field">
      <label class="field__label" for="chat-steer-text">${t('chat.steerAdd')}</label>
      <textarea class="textarea" id="chat-steer-text" data-role="steer-text" rows="3" placeholder="${t('chat.steerPlaceholder')}"${steerForm.error ? raw(' aria-invalid="true" aria-describedby="chat-steer-error"') : null}></textarea>
      ${steerForm.error ? html`<p class="field__error" id="chat-steer-error" role="alert">${steerForm.error}</p>` : null}
    </div>
    <div class="row between">
      <select class="select" data-role="steer-mode" aria-label="${t('chat.steerMode')}" style="width: auto;">
        ${STEER_FORM_MODES.map((mode) => html`<option value="${mode.id}"${steerForm.mode === mode.id ? raw(' selected') : null}>${t(`chat.${mode.key}`)}</option>`)}
      </select>
      <button class="btn btn--primary btn--sm" type="button" data-action="steer-submit"${steerForm.busy ? raw(' aria-busy="true"') : null}>${icon('plus', { size: 'sm' })}${t('chat.steerSubmit')}</button>
    </div>`;
}

function placementLabel(placement) {
  return t(placement === 'both' ? 'chat.placementBoth' : placement === 'inline' ? 'chat.placementInline' : 'chat.placementTray');
}

function attachmentsBody(view) {
  const list = view.chat.draft.attachments;
  if (!list.length) return html`<p class="text-xs muted">${t('chat.attNone')}</p>`;
  return html`${list.map(
    (att) => html`<div class="card enter" data-key="att-${att.sha256}" style="padding: 10px 12px;">
        <dl class="kv">
          <dt>${t('chat.kvName')}</dt><dd>${att.name}</dd>
          <dt>${t('chat.kvSize')}</dt><dd class="num">${t('chat.bytes', { n: fmtNumber(att.size) })} <span class="muted">(${fmtBytes(att.size)})</span></dd>
          <dt>${t('chat.kvMime')}</dt><dd class="mono">${att.mime}</dd>
          <dt>${t('chat.kvSha')}</dt>
          <dd><span class="mono text-xs" style="word-break: break-all;">${att.sha256}</span>
            <button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="copy-sha" data-sha="${att.sha256}" aria-label="${t('chat.copySha')}" title="${t('chat.copySha')}">${icon('copy', { size: 'sm' })}</button></dd>
          <dt>${t('chat.kvPlacement')}</dt><dd>${placementLabel(effectivePlacement(att, view.chat.draft.text))}</dd>
        </dl>
      </div>`
  )}`;
}

/** The aside, or null when closed. `view` = { chat, steer, steerForm, sections, receiptFocus }. */
export function inspectorHtml(view) {
  const latest = receiptMessage(view.chat.messages, view.receiptFocus);
  const receiptCount = latest && latest.route.receipt ? latest.route.receipt.receiptId : undefined;
  return html`<aside class="panel scroll panel--overlay" aria-label="${t('chat.inspectorLabel')}" data-role="inspector">
      <div class="panel__header">
        <h2 class="panel__title">${t('chat.inspectorTitle')}</h2>
        <button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="close-inspector" aria-label="${t('chat.inspectorClose')}">${icon('x', { size: 'sm' })}</button>
      </div>
      ${section({ id: 'receipt', open: view.sections.receipt, title: t('chat.receiptTitle'), count: receiptCount, body: receiptBody(view) })}
      ${section({ id: 'steer', open: view.sections.steer, title: t('chat.steerTitle'), count: view.steer.items.length, body: steerBody(view) })}
      ${section({ id: 'atts', open: view.sections.atts, title: t('chat.attTitle'), count: view.chat.draft.attachments.length, body: attachmentsBody(view) })}
    </aside>`;
}

