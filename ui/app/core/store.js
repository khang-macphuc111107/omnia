// Omnia Studio UI — minimal observable store.
//
//   const store = createStore({ items: [], status: 'idle' });
//   const stop = store.subscribe((state, prev) => render(state));
//   store.set({ status: 'loading' });            // shallow merge
//   store.set((s) => ({ ...s, items: [...] }));  // updater function

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  return {
    get() {
      return state;
    },

    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
      if (next === state) return;
      const prev = state;
      state = next;
      for (const listener of Array.from(listeners)) listener(state, prev);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

/** Read/write JSON in localStorage without ever throwing (private mode, quota, sandbox). */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },

  remove(key) {
    try {
      window.localStorage.removeItem(key);
      return window.localStorage.getItem(key) === null;
    } catch {
      return false;
    }
  },

  /** Keys starting with prefix (used by Settings → local data). */
  keys(prefix = '') {
    return storage.scanKeys(prefix).keys;
  },

  /** Preserve failure information for operations that must verify an erasure. */
  scanKeys(prefix = '') {
    try {
      const out = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(prefix)) out.push(key);
      }
      return { keys: out, verified: true };
    } catch {
      return { keys: [], verified: false };
    }
  }
};
