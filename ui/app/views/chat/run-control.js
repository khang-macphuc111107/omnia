// Omnia Studio UI — chat routing run lifecycle and explicit cancellation (AUD-24).
// Pure transport + state coordinator (no DOM dependencies) shared by controller.js and unit tests.

import { api } from '../../api.js';
import { cancelledRoute, routeFromResponse, routeFromError } from './local-store.js';

const CANCEL_TIMEOUT_MS = 3000;

export function createRunTracker({ client = api } = {}) {
  const inflight = new Map(); // `${sessionId}:${messageId}` -> { controller, sessionId, messageId, policy, cancelled, cancelAck }

  const keyOf = (sessionId, messageId) => `${sessionId}:${messageId}`;

  function isInflight(sessionId, messageId) {
    return inflight.has(keyOf(sessionId, messageId));
  }

  /** Starts a live router decision with a per-message AbortController. */
  async function runDecide(sessionId, messageId, policy, { onUpdate, onSettled } = {}) {
    const key = keyOf(sessionId, messageId);
    if (inflight.has(key)) return null;
    const controller = new AbortController();
    const entry = { controller, sessionId, messageId, policy, cancelled: false, cancelAck: null };
    inflight.set(key, entry);
    let route;
    try {
      const response = await client.router.decide(policy, { signal: controller.signal });
      if (entry.cancelled || controller.signal.aborted) {
        route = cancelledRoute(policy, entry.cancelAck);
      } else {
        route = routeFromResponse(response, policy);
      }
    } catch (error) {
      if (entry.cancelled || controller.signal.aborted || (error && error.code === 'aborted')) {
        route = cancelledRoute(policy, entry.cancelAck);
      } else {
        route = routeFromError(error, policy);
      }
    } finally {
      if (inflight.get(key) === entry) inflight.delete(key);
    }
    if (entry.cancelled) {
      // cancelRoute() owns the cancelled transition and reconciliation update.
      return route;
    }
    if (onUpdate) onUpdate(sessionId, messageId, route);
    if (onSettled) onSettled(route);
    return route;
  }

  /**
   * Aborts an in-flight decision and sends best-effort stop + reservation cancel
   * signals to POST /api/chat/stop and POST /api/router/cancel.
   */
  async function cancelRoute(sessionId, messageId, { onUpdate, onCancelled } = {}) {
    const key = keyOf(sessionId, messageId);
    const entry = inflight.get(key);
    if (!entry || entry.cancelled) return null;
    entry.cancelled = true;
    entry.controller.abort();

    const optimistic = cancelledRoute(entry.policy, { pendingReconcile: true, chatStopped: false, routerCancelled: false });
    entry.cancelAck = optimistic.cancelAck;
    if (onUpdate) onUpdate(sessionId, messageId, optimistic);
    if (onCancelled) onCancelled(optimistic);

    const payload = {
      sessionId,
      sessionKey: sessionId,
      messageId,
      idempotencyKey: (entry.policy && entry.policy.idempotencyKey) || `chat:${sessionId}:${messageId}`
    };

    const [chatStopRes, routerCancelRes] = await Promise.allSettled([
      client.chat.stop(payload, { timeout: CANCEL_TIMEOUT_MS }),
      client.router.cancel(payload, { timeout: CANCEL_TIMEOUT_MS })
    ]);

    const ack = {
      pendingReconcile: false,
      chatStopped: chatStopRes.status === 'fulfilled' && Boolean(chatStopRes.value && chatStopRes.value.ok !== false),
      routerCancelled: routerCancelRes.status === 'fulfilled' && Boolean(routerCancelRes.value && routerCancelRes.value.ok !== false)
    };
    entry.cancelAck = ack;
    const finalRoute = cancelledRoute(entry.policy, ack);
    if (onUpdate) onUpdate(sessionId, messageId, finalRoute);
    return finalRoute;
  }

  return { isInflight, runDecide, cancelRoute };
}
