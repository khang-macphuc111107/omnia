/**
 * High-level Router tying together RouteTrie, URL parsing, and middleware pipeline.
 */

import { runPipeline } from './middleware.mjs';
import { parseQuery, parseRequestUrl } from './query.mjs';
import { RouteTrie } from './trie.mjs';

function createResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    sent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value);
      return this;
    },
    json(payload) {
      this.setHeader('content-type', 'application/json');
      this.body = payload;
      this.sent = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.sent = true;
      return this;
    },
  };
  return res;
}

export class Router {
  constructor() {
    this.trie = new RouteTrie();
    /** @type {Function[]} */
    this.middlewares = [];
  }

  /**
   * Register a global normal or error middleware.
   * @param {Function} fn
   */
  use(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('Middleware must be a function');
    }
    this.middlewares.push(fn);
    return this;
  }

  /**
   * Register a route for an HTTP method and path pattern.
   * @param {string} method
   * @param {string} pattern
   * @param {...Function} handlers
   */
  add(method, pattern, ...handlers) {
    if (handlers.length === 0) {
      throw new Error(`Route ${method} ${pattern} requires at least one handler`);
    }
    this.trie.insert(method, pattern, handlers);
    return this;
  }

  get(pattern, ...handlers) {
    return this.add('GET', pattern, ...handlers);
  }

  post(pattern, ...handlers) {
    return this.add('POST', pattern, ...handlers);
  }

  put(pattern, ...handlers) {
    return this.add('PUT', pattern, ...handlers);
  }

  delete(pattern, ...handlers) {
    return this.add('DELETE', pattern, ...handlers);
  }

  /**
   * Dispatch a request object `{ method, url, headers?, body? }` through global
   * middlewares, matched route handlers, and error handlers.
   *
   * @param {{ method: string, url: string, headers?: Record<string, string>, body?: any }} rawReq
   * @returns {Promise<{ status: number, headers: Record<string, string>, body: any, params: Record<string, string>, query: Record<string, string | string[]> }>}
   */
  async handle(rawReq) {
    const res = createResponse();
    let parsed;
    try {
      parsed = parseRequestUrl(rawReq.url || '/');
    } catch (err) {
      return {
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: { error: err.message || 'Bad Request' },
        params: {},
        query: {},
      };
    }

    const req = {
      method: (rawReq.method || 'GET').toUpperCase(),
      url: rawReq.url || '/',
      pathname: parsed.pathname,
      headers: { ...(rawReq.headers || {}) },
      body: rawReq.body,
      params: {},
      query: parsed.query,
    };

    const match = this.trie.match(req.method, parsed.segments);
    const normalGlobals = this.middlewares.filter((fn) => fn.length < 4);
    const errorGlobals = this.middlewares.filter((fn) => fn.length === 4);

    let stack;
    if (match) {
      req.params = match.params;
      stack = [...normalGlobals, ...match.handlers, ...errorGlobals];
    } else {
      const notFoundHandler = (_req, response) => {
        if (!response.sent) {
          response.status(404).json({ error: 'Not Found' });
        }
      };
      stack = [...normalGlobals, notFoundHandler, ...errorGlobals];
    }

    try {
      await runPipeline(stack, req, res);
    } catch (err) {
      if (!res.sent) {
        res.status(500).json({ error: err?.message || String(err) });
      }
    }

    return {
      status: res.statusCode,
      headers: res.headers,
      body: res.body,
      params: req.params,
      query: req.query,
    };
  }
}

export { RouteTrie, parseQuery, parseRequestUrl, runPipeline };
