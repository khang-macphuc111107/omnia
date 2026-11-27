// Omnia Studio UI — shared session list (sidebar + chat view).
//
//   sessions.get() → { items, status: 'idle'|'loading'|'ready'|'error', error, activeId, lease }
//   await loadSessions();                 // first page, newest first
//   await loadMoreSessions();             // append the next bounded page
//   await ensureSession(id);              // resolve a deep link outside loaded pages
//   const s = await createSession({ title, modelId, effort });
//   setActiveSession(id);                 // remembered across reloads
//
// The server stores session metadata only (no messages, no update/delete routes).

import { createStore, storage } from './store.js';
import { api, ApiError } from '../api.js';

const ACTIVE_KEY = 'omnia.ui.activeSession';

export const sessions = createStore({
  items: [],
  status: 'idle',
  error: null,
  activeId: storage.get(ACTIVE_KEY, null),
  lease: null,
  nextCursor: null,
  totalCount: 0,
  loadingMore: false,
  pageError: null,
  details: {}
});

let listVersion = 0;
let listController = null;
let selectionVersion = 0;
const detailRequests = new Map();

function invalidateList() {
  listVersion += 1;
  listController?.abort();
  listController = null;
  return listVersion;
}

function mergeItems(...groups) {
  const records = new Map();
  for (const group of groups) {
    for (const item of group) {
      const previous = records.get(item.id);
      if (!previous || (item.revision ?? 0) >= (previous.revision ?? 0)) records.set(item.id, item);
    }
  }
  return [...records.values()].sort((a, b) =>
    b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

function pageItems(payload) {
  if (!Array.isArray(payload?.sessions)) throw new ApiError({ code: 'invalid_response' });
  return payload.sessions;
}

function setDetail(id, detail) {
  sessions.set({ details: { ...sessions.get().details, [id]: detail } });
}

export async function loadSessions() {
  const version = invalidateList();
  const controller = new AbortController();
  listController = controller;
  sessions.set({ status: 'loading', error: null, loadingMore: false, pageError: null });
  try {
    const payload = await api.sessions.list({ limit: 50, signal: controller.signal });
    if (version !== listVersion) return;
    const selected = findSession(sessions.get().activeId);
    const items = mergeItems(pageItems(payload), selected ? [selected] : []);
    const activeId = sessions.get().activeId || items[0]?.id || null;
    sessions.set({ items, activeId, lease: payload.activeLease ?? null, status: 'ready', error: null,
      nextCursor: payload.nextCursor ?? null, totalCount: payload.totalCount ?? items.length });
    if (activeId) {
      storage.set(ACTIVE_KEY, activeId);
      if (!findSession(activeId)) await ensureSession(activeId, { retry: true });
    }
  } catch (error) {
    if (version === listVersion) sessions.set({ status: 'error', error });
  } finally {
    if (version === listVersion) listController = null;
  }
}

export async function loadMoreSessions() {
  const state = sessions.get();
  if (state.status !== 'ready' || state.loadingMore || !state.nextCursor) return;
  const version = invalidateList();
  const controller = new AbortController();
  listController = controller;
  sessions.set({ loadingMore: true, pageError: null });
  try {
    const payload = await api.sessions.list({ limit: 50, cursor: state.nextCursor, signal: controller.signal });
    if (version !== listVersion) return;
    if (payload.nextCursor === state.nextCursor) throw new ApiError({ code: 'invalid_response' });
    sessions.set({ items: mergeItems(sessions.get().items, pageItems(payload)),
      nextCursor: payload.nextCursor ?? null, totalCount: payload.totalCount ?? state.totalCount });
  } catch (error) {
    if (version === listVersion) sessions.set({ pageError: error });
  } finally {
    if (version === listVersion) {
      listController = null;
      sessions.set({ loadingMore: false });
    }
  }
}

/** Detail lookups never change selection; a late reply may only populate its own ID. */
export async function ensureSession(id, { retry = false } = {}) {
  if (!id) return null;
  if (findSession(id)) return findSession(id);
  if (detailRequests.has(id)) return detailRequests.get(id);
  if (!retry && Object.hasOwn(sessions.get().details, id)) return null;
  const pending = Promise.resolve().then(async () => {
    try {
      const payload = await api.sessions.get(id);
      if (payload.session?.id !== id) throw new ApiError({ code: 'invalid_response' });
      sessions.set({ items: mergeItems(sessions.get().items, [payload.session]) });
      setDetail(id, { status: 'ready', error: null });
      return payload.session;
    } catch (error) {
      setDetail(id, { status: error.status === 404 ? 'missing' : 'error', error });
      return null;
    } finally {
      detailRequests.delete(id);
    }
  });
  detailRequests.set(id, pending);
  setDetail(id, { status: 'loading', error: null });
  return pending;
}

/** Creates a session on the server and makes it active. Throws ApiError on failure. */
export async function createSession({ title, modelId, effort }) {
  const selection = ++selectionVersion;
  invalidateList();
  sessions.set({ status: sessions.get().items.length ? 'ready' : 'idle', loadingMore: false });
  let payload;
  try {
    payload = await api.sessions.create({ title, modelId, effort });
  } catch (error) {
    if (selection === selectionVersion && sessions.get().status === 'idle') await loadSessions();
    throw error;
  }
  const created = payload.session || null;
  const rows = pageItems(payload);
  // A refresh started during creation can still contain the pre-create snapshot.
  invalidateList();
  const state = sessions.get();
  const items = mergeItems(rows, state.items, created ? [created] : []);
  const activeId = selection === selectionVersion && created ? created.id : state.activeId;
  sessions.set({ items, activeId, status: 'ready', error: null, loadingMore: false,
    pageError: null, lease: payload.activeLease ?? state.lease,
    totalCount: Math.max(state.totalCount, payload.totalCount ?? 0, items.length),
    nextCursor: state.nextCursor ?? payload.nextCursor ?? null });
  if (activeId) storage.set(ACTIVE_KEY, activeId);
  return created;
}

export function setActiveSession(id) {
  if (!id || sessions.get().activeId === id) return;
  selectionVersion += 1;
  sessions.set({ activeId: id });
  storage.set(ACTIVE_KEY, id);
}

export function findSession(id) {
  return sessions.get().items.find((s) => s.id === id) || null;
}

export function activeSession() {
  const { activeId } = sessions.get();
  return activeId ? findSession(activeId) : null;
}
