(window.__omnia || (function () {
  'use strict';
  const refs = new Map();
  const rev = new WeakMap();
  let counter = 0;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE', 'DATALIST']);
  const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
    'file-input', 'clickable', 'option']);
  const LEAF = new Set(['link', 'button', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'treeitem', 'option', 'clickable', 'img', 'slider', 'spinbutton', 'textbox', 'searchbox',
    'combobox', 'listbox', 'file-input', 'progressbar', 'separator']);
  const NAME_FROM_CONTENT = new Set(['link', 'button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'treeitem', 'option', 'clickable', 'switch', 'checkbox', 'radio', 'heading']);

  function isInViewport(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return true;
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return true;
      const vpHeight = window.innerHeight || (document.documentElement ? document.documentElement.clientHeight : 800);
      const vpWidth = window.innerWidth || (document.documentElement ? document.documentElement.clientWidth : 1280);
      return r.bottom >= 0 && r.top <= vpHeight && r.right >= 0 && r.left <= vpWidth;
    } catch (e) {
      return true;
    }
  }


  function refFor(el) {
    let r = rev.get(el);
    if (!r) {
      r = 'e' + (++counter);
      rev.set(el, r);
      refs.set(r, el);
    }
    return r;
  }

  function clean(s, max) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function textOf(el, max) {
    const t = el.innerText !== undefined ? el.innerText : el.textContent;
    return clean(t, max);
  }

  function style(el) {
    try { return el.ownerDocument.defaultView.getComputedStyle(el); } catch (e) { return null; }
  }

  function inputType(el) {
    return (el.getAttribute('type') || el.type || 'text').toLowerCase();
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) {
      const r = explicit.trim().split(/\s+/)[0].toLowerCase();
      if (r && r !== 'presentation' && r !== 'none' && r !== 'generic') return r;
    }
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : null;
      case 'area': return el.hasAttribute('href') ? 'link' : null;
      case 'button': return 'button';
      case 'summary': return 'button';
      case 'select': return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'input': {
        const t = inputType(el);
        if (t === 'hidden') return null;
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        if (t === 'file') return 'file-input';
        if (t === 'search') return 'searchbox';
        if (el.hasAttribute('list')) return 'combobox';
        return 'textbox';
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'ul': case 'ol': case 'menu': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
      case 'img': return 'img';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return 'banner';
      case 'footer': return 'contentinfo';
      case 'aside': return 'complementary';
      case 'form': return (el.getAttribute('aria-label') || el.getAttribute('name')) ? 'form' : null;
      case 'section': return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) ? 'region' : null;
      case 'article': return 'article';
      case 'dialog': return 'dialog';
      case 'p': return 'paragraph';
      case 'pre': return 'code';
      case 'blockquote': return 'blockquote';
      case 'iframe': case 'frame': return 'iframe';
      case 'progress': return 'progressbar';
      case 'hr': return 'separator';
      case 'fieldset': return 'group';
      case 'details': return 'group';
      case 'video': return 'video';
      case 'audio': return 'audio';
      case 'canvas': return 'canvas';
      default: break;
    }
    if (el.isContentEditable && el.parentElement && !el.parentElement.isContentEditable) return 'textbox';
    return null;
  }

  function isClickable(el, st) {
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && parseInt(ti, 10) >= 0) return true;
    if (st && st.cursor === 'pointer') {
      const parent = el.parentElement;
      const pst = parent ? style(parent) : null;
      return !pst || pst.cursor !== 'pointer';
    }
    return false;
  }

  function labelText(el) {
    let t = '';
    try {
      if (el.labels && el.labels.length) {
        t = Array.from(el.labels).map(function (l) { return textOf(l, 120); }).join(' ');
      }
    } catch (e) { /* ignore */ }
    return clean(t, 120);
  }

  function nameOf(el, role) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria, 120);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const root = el.getRootNode();
      const t = lb.split(/\s+/).map(function (id) {
        const n = root.getElementById ? root.getElementById(id) : null;
        return n ? textOf(n, 200) : '';
      }).join(' ');
      if (t.trim()) return clean(t, 120);
    }
    const tag = el.tagName;
    if (tag === 'IMG') return clean(el.getAttribute('alt') || el.title, 120);
    if (tag === 'INPUT') {
      const t = inputType(el);
      if (t === 'button' || t === 'submit' || t === 'reset') return clean(el.value || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : ''), 120);
      if (t === 'image') return clean(el.getAttribute('alt') || el.title, 120);
    }
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      const l = labelText(el);
      if (l) return l;
      return clean(el.getAttribute('placeholder') || el.title || el.getAttribute('name'), 120);
    }
    if (tag === 'FIELDSET') {
      const lg = el.querySelector('legend');
      return lg ? textOf(lg, 120) : '';
    }
    if (tag === 'IFRAME' || tag === 'FRAME') return clean(el.title || el.getAttribute('name') || '', 120);
    if (tag === 'VIDEO' || tag === 'AUDIO') return clean(el.title || '', 120);
    if (NAME_FROM_CONTENT.has(role)) {
      let t = textOf(el, 120);
      if (!t) {
        const img = el.querySelector('img[alt]');
        if (img && img.getAttribute('alt')) t = clean(img.getAttribute('alt'), 120);
      }
      if (!t) {
        const st = el.querySelector('svg title');
        if (st) t = clean(st.textContent, 120);
      }
      if (!t) t = clean(el.title, 120);
      if (!t && tag === 'A') t = clean(el.getAttribute('href'), 80);
      return t;
    }
    if (role === 'dialog' || role === 'region' || role === 'form' || role === 'navigation' || role === 'group' || role === 'list' || role === 'table') {
      return clean(el.title, 120);
    }
    return '';
  }

  function hrefOf(el) {
    try {
      const raw = el.getAttribute('href');
      if (!raw || /^javascript:/i.test(raw)) return null;
      const abs = el.href;
      if (typeof abs !== 'string') return raw;
      const u = new URL(abs);
      if (u.origin === el.ownerDocument.defaultView.location.origin) return u.pathname + u.search + u.hash;
      return abs;
    } catch (e) { return null; }
  }

  function checkedOf(el, role) {
    if (el.tagName === 'INPUT' && (role === 'checkbox' || role === 'radio')) {
      if (el.indeterminate) return 'mixed';
      return el.checked ? 'true' : null;
    }
    const a = el.getAttribute('aria-checked');
    if (a === 'true') return 'true';
    if (a === 'mixed') return 'mixed';
    return null;
  }

  function hasInteractiveDescendant(el) {
    return !!el.querySelector('a[href],button,input:not([type=hidden]),select,textarea,[tabindex],[role=button],[role=link],[onclick]');
  }

  function valueOf(el, role) {
    const tag = el.tagName;
    if (tag === 'SELECT') {
      return Array.from(el.selectedOptions || []).map(function (o) { return clean(o.text, 80); }).join(', ');
    }
    if (tag === 'INPUT') {
      const t = inputType(el);
      if (t === 'password') return el.value ? '(hidden)' : '';
      if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider' || role === 'combobox') return clean(el.value, 200);
      return '';
    }
    if (tag === 'TEXTAREA') return clean(el.value, 300);
    if (role === 'textbox' && el.isContentEditable) return textOf(el, 300);
    if (role === 'progressbar' && tag === 'PROGRESS') return String(el.value);
    return '';
  }

  function walkChildren(parent, ctx, out) {
    let list;
    if (parent.nodeType === 1 && parent.shadowRoot) list = parent.shadowRoot.childNodes;
    else list = parent.childNodes;
    for (let i = 0; i < list.length; i++) {
      if (ctx.count > ctx.max) { ctx.truncated = true; return; }
      walk(list[i], ctx, out);
    }
  }

  function pushText(out, text) {
    const last = out[out.length - 1];
    if (last && last.role === 'text') last.text = clean(last.text + ' ' + text, 300);
    else out.push({ role: 'text', text: text });
  }

  function walk(node, ctx, out) {
    if (node.nodeType === 3) {
      if (ctx.interactive) return;
      if (ctx.visibleOnly && node.parentElement && !isInViewport(node.parentElement)) return;
      const t = clean(node.nodeValue, 300);
      if (t) { pushText(out, t); ctx.count++; }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP.has(el.tagName)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (el.tagName === 'SLOT') {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) { for (const a of assigned) walk(a, ctx, out); }
      else walkChildren(el, ctx, out);
      return;
    }
    const st = style(el);
    if (!st || st.display === 'none') return;
    const visible = st.visibility === 'visible';
    if (ctx.visibleOnly && visible) {
      const r = el.getBoundingClientRect();
      const hasSize = r.width > 0 || r.height > 0;
      if (hasSize) {
        const vpHeight = window.innerHeight || 800;
        const vpWidth = window.innerWidth || 1280;
        const outOfVp = r.bottom < 0 || r.top > vpHeight || r.right < 0 || r.left > vpWidth;
        if (outOfVp) {
          const clips = st.overflow === 'hidden' || st.overflowX === 'hidden' || st.overflowY === 'hidden' || st.overflow === 'clip' || st.overflowX === 'clip' || st.overflowY === 'clip';
          if (clips || LEAF.has(roleOf(el) || '')) return;
        }
      }
    }
    let role = roleOf(el);
    if (!role && visible && isClickable(el, st)) {
      const hasKids = el.children.length > 0 && hasInteractiveDescendant(el);
      if (!hasKids && (textOf(el, 40) || el.getAttribute('aria-label'))) role = 'clickable';
    }
    if (!visible) {
      // Invisible element: children may still be visible.
      walkChildren(el, ctx, out);
      return;
    }
    if (!role) { walkChildren(el, ctx, out); return; }

    const interactive = INTERACTIVE.has(role);
    if (role === 'img' || role === 'separator') {
      if (ctx.interactive) return;
      const n = nameOf(el, role);
      if (role === 'img' && !n) return;
      if (role === 'separator') return;
      const r = el.getBoundingClientRect();
      if (r.width < 8 && r.height < 8) return;
      ctx.count++;
      out.push({ role: role, name: n });
      return;
    }
    if (interactive) {
      const rect = el.getBoundingClientRect();
      const zero = rect.width === 0 && rect.height === 0;
      const t = el.tagName === 'INPUT' ? inputType(el) : '';
      const allowZero = t === 'checkbox' || t === 'radio' || t === 'file';
      if (zero && !allowZero) { return; }
    }

    const node2 = { role: role };
    const name = nameOf(el, role);
    if (name) node2.name = name;
    if (role === 'heading') {
      const m = /^H([1-6])$/.exec(el.tagName);
      node2.level = m ? parseInt(m[1], 10) : parseInt(el.getAttribute('aria-level') || '2', 10);
    }
    if (interactive) {
      node2.ref = refFor(el);
      const doc = el.ownerDocument;
      if (doc.activeElement === el) node2.focused = true;
      const href = role === 'link' ? hrefOf(el) : null;
      if (href) node2.href = href;
      if (el.tagName === 'INPUT') {
        const t = inputType(el);
        if (t !== 'text' && role !== 'checkbox' && role !== 'radio' && role !== 'button') node2.type = t;
      }
      const checked = checkedOf(el, role);
      if (checked) node2.checked = checked;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') node2.disabled = true;
      if (el.required || el.getAttribute('aria-required') === 'true') node2.required = true;
      const exp = el.getAttribute('aria-expanded');
      if (exp === 'true') node2.expanded = true;
      else if (exp === 'false') node2.expanded = false;
      if (el.getAttribute('aria-pressed') === 'true') node2.pressed = true;
      if (el.getAttribute('aria-selected') === 'true' || (el.tagName === 'OPTION' && el.selected)) node2.selected = true;
      const v = valueOf(el, role);
      if (v) node2.value = v;
      if (el.tagName === 'SELECT') {
        node2.options = Array.from(el.options).slice(0, 60).map(function (o) {
          const x = { label: clean(o.text, 80) };
          if (o.value && o.value !== x.label) x.value = clean(o.value, 60);
          if (o.selected) x.selected = true;
          if (o.disabled) x.disabled = true;
          return x;
        });
      }
    } else {
      if (el.getAttribute('aria-expanded') === 'true') node2.expanded = true;
      if (role === 'progressbar') { const v = valueOf(el, role); if (v) node2.value = v; }
    }
    ctx.count++;

    if (role === 'iframe') {
      const src = el.getAttribute('src');
      if (src) node2.src = clean(src, 120);
      let doc = null;
      try { doc = el.contentDocument; } catch (e) { doc = null; }
      if (doc && doc.body) {
        const kids = [];
        ctx.depth++;
        if (ctx.depth < 6) walkChildren(doc.body, ctx, kids);
        ctx.depth--;
        if (kids.length) node2.children = kids;
      } else {
        node2.crossOrigin = true;
      }
    } else if (!LEAF.has(role) && !(role === 'heading' && !hasInteractiveDescendant(el))) {
      const kids = [];
      walkChildren(el, ctx, kids);
      if (role === 'heading' && kids.length) { delete node2.name; }
      if (kids.length) node2.children = kids;
    } else if (role === 'heading' && !node2.name) {
      return;
    }
    if (ctx.visibleOnly) {
      const r = el.getBoundingClientRect();
      const hasSize = r.width > 0 || r.height > 0;
      if (hasSize) {
        const vpHeight = window.innerHeight || 800;
        const vpWidth = window.innerWidth || 1280;
        const outOfVp = r.bottom < 0 || r.top > vpHeight || r.right < 0 || r.left > vpWidth;
        if (outOfVp && (!node2.children || node2.children.length === 0)) return;
      }
    }
    if (ctx.interactive && !node2.ref && role !== 'heading' && !node2.children) return;
    out.push(node2);
  }

  const api = {
    get: function (r) {
      const el = refs.get(r);
      return el || null;
    },
    snapshot: function (opts) {
      for (const [r, el] of refs) { if (!el.isConnected) { refs.delete(r); } }
      const ctx = {
        interactive: !!(opts && opts.interactive),
        visibleOnly: !!(opts && opts.visibleOnly),
        max: (opts && opts.maxNodes) || 6000,
        count: 0,
        truncated: false,
        depth: 0
      };
      const nodes = [];
      let root = null;
      if (opts && opts.selector && typeof opts.selector === 'string') {
        try { root = document.querySelector(opts.selector); } catch (e) { root = null; }
      }
      if (root) {
        walk(root, ctx, nodes);
      } else {
        const docRoot = document.body || document.documentElement;
        if (docRoot) walkChildren(docRoot, ctx, nodes);
      }
      const vv = window.visualViewport;
      return JSON.stringify({
        url: location.href,
        title: document.title,
        nodes: nodes,
        truncated: ctx.truncated,
        viewport: {
          width: window.innerWidth, height: window.innerHeight,
          scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY),
          scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
          scale: vv ? vv.scale : 1
        }
      });
    }
  };
  Object.defineProperty(window, '__omnia', { value: api, enumerable: false, configurable: true });
  return api;
})())
