// Settings view — pure Capability Matrix markup helper (AUD-25).

import { html } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t, fmtNumber, fmtTime } from '../../core/i18n.js';
import { describeError } from '../../api.js';
import { summarizeCapabilities } from './helpers.js';

/**
 * Renders the live GET /api/capabilities matrix alongside /api/health diagnostics.
 * `state` = { status:'loading'|'ready'|'error', schema, rows, error, fetchedAt }.
 */
export function capabilityMatrixHtml(state) {
  const cap = state || { status: 'loading', schema: '', rows: [], error: null, fetchedAt: 0 };
  const rows = Array.isArray(cap.rows) ? cap.rows : [];
  const counts = summarizeCapabilities(rows);
  const notReady = counts.degraded + counts.unavailable;

  return html`<div class="col settings-cap-matrix" data-role="capability-matrix" aria-busy="${cap.status === 'loading'}">
    <div class="row between wrap">
      <div class="row wrap">
        <h3 class="section-title">${t('settings.capTitle')}</h3>
        ${rows.length
          ? html`<span class="chip num">${t('settings.capSummary', { ready: fmtNumber(counts.ready), total: fmtNumber(counts.total) })}</span>`
          : null}
        ${notReady > 0
          ? html`<span class="status status--warn">${icon('alert')}${t('settings.capUnavailableCount', { n: fmtNumber(notReady) })}</span>`
          : null}
      </div>
      <span class="text-xs muted">GET /api/capabilities${cap.schema ? html` · ${t('settings.capSource', { source: cap.schema })}` : null}${cap.fetchedAt ? html` · ${t('settings.lastOk')} ${fmtTime(cap.fetchedAt, true)}` : null}</span>
    </div>
    ${cap.status === 'error'
      ? html`<div class="banner banner--danger" role="alert">${icon('alert', { className: 'banner__icon' })}<div class="banner__body"><span class="banner__title">${t('settings.capErrorTitle')}</span><span>${describeError(cap.error)}</span></div></div>`
      : null}
    ${cap.status === 'loading' && !rows.length
      ? html`<p class="text-sm muted" role="status">${t('settings.capLoading')}</p>`
      : rows.length
        ? html`<div class="table-wrap"><table class="table settings-cap-table">
            <caption class="sr-only">${t('settings.capTitle')}</caption>
            <thead>
              <tr>
                <th scope="col">${t('settings.capColId')}</th>
                <th scope="col">${t('settings.capColStatus')}</th>
                <th scope="col">${t('settings.capColEndpoint')}</th>
                <th scope="col">${t('settings.capColDetail')}</th>
                <th scope="col">${t('settings.capColRemediation')}</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row) => {
                const remediationText = row.remediation || (row.remediationKey ? t(row.remediationKey) : '');
                return html`<tr data-key="cap:${row.id}" data-cap-status="${row.status}">
                  <th scope="row" class="mono settings-th">${row.id}</th>
                  <td><span class="status status--${row.meta.variant}">${icon(row.meta.icon)}${t(row.meta.labelKey)}</span></td>
                  <td class="mono text-xs">${row.endpoint || '—'}</td>
                  <td class="text-xs subtle">${row.detail || '—'}${row.checkedAt ? html` <span class="muted num">· ${fmtTime(row.checkedAt, true)}</span>` : null}</td>
                  <td class="text-xs settings-cap-remediation">${remediationText || html`<span class="muted">${t('settings.capNoneNeeded')}</span>`}</td>
                </tr>`;
              })}
            </tbody>
          </table></div>`
        : cap.status === 'ready'
          ? html`<p class="text-sm muted" role="status">${t('settings.capEmpty')}</p>`
          : null}
  </div>`;
}
