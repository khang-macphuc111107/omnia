/**
 * URL Segment Trie supporting static segments, :param captures, and *wildcard catch-alls.
 */

class TrieNode {
  constructor() {
    /** @type {Map<string, TrieNode>} */
    this.staticChildren = new Map();
    /** @type {{ name: string, node: TrieNode } | null} */
    this.paramChild = null;
    /** @type {{ name: string, node: TrieNode } | null} */
    this.wildcardChild = null;
    /** @type {Map<string, Function[]>} */
    this.handlers = new Map();
  }
}

export class RouteTrie {
  constructor() {
    this.root = new TrieNode();
  }

  /**
   * Register route handlers for an HTTP method and pattern path.
   *
   * @param {string} method
   * @param {string} pattern
   * @param {Function[]} handlers
   */
  insert(method, pattern, handlers) {
    const upperMethod = method.toUpperCase();
    const segments = pattern.split('/').filter((seg) => seg.length > 0);
    let node = this.root;

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (seg.startsWith('*')) {
        if (i !== segments.length - 1) {
          throw new Error(`Wildcard segment '${seg}' must be the final segment in '${pattern}'`);
        }
        const name = seg.slice(1) || 'wildcard';
        if (!node.wildcardChild) {
          node.wildcardChild = { name, node: new TrieNode() };
        } else if (node.wildcardChild.name !== name) {
          throw new Error(
            `Conflicting wildcard name '${name}' vs '${node.wildcardChild.name}' in '${pattern}'`
          );
        }
        node = node.wildcardChild.node;
      } else if (seg.startsWith(':')) {
        const name = seg.slice(1);
        if (!name) {
          throw new Error(`Empty parameter name in '${pattern}'`);
        }
        if (!node.paramChild) {
          node.paramChild = { name, node: new TrieNode() };
        } else if (node.paramChild.name !== name) {
          throw new Error(
            `Conflicting param name ':${name}' vs ':${node.paramChild.name}' in '${pattern}'`
          );
        }
        node = node.paramChild.node;
      } else {
        if (!node.staticChildren.has(seg)) {
          node.staticChildren.set(seg, new TrieNode());
        }
        node = node.staticChildren.get(seg);
      }
    }

    node.handlers.set(upperMethod, handlers);
  }

  /**
   * Match an HTTP method and decoded path segments against registered routes.
   *
   * @param {string} method
   * @param {string[]} segments
   * @returns {{ handlers: Function[], params: Record<string, string> } | null}
   */
  match(method, segments) {
    const upperMethod = method.toUpperCase();
    let node = this.root;
    const params = {};

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (node.staticChildren.has(seg)) {
        node = node.staticChildren.get(seg);
      } else if (node.wildcardChild) {
        params[node.wildcardChild.name] = segments.slice(i).join('/');
        node = node.wildcardChild.node;
        const wcHandlers = node.handlers.get(upperMethod);
        return wcHandlers ? { handlers: wcHandlers, params } : null;
      } else if (node.paramChild) {
        params[node.paramChild.name] = seg;
        node = node.paramChild.node;
      } else {
        return null;
      }
    }

    const handlers = node.handlers.get(upperMethod);
    if (!handlers) {
      return null;
    }
    return { handlers, params };
  }
}
