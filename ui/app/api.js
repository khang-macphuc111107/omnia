"use strict";

(function initOmniaApi(global) {
  const Studio = (global.OmniaStudio = global.OmniaStudio || {});

  /* ========================================================================
     1. Pure-JS RFC-6234 SHA-256 (Works on Loopback Host AND Standalone File)
     ======================================================================== */
  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(String(str));
    }
    const out = [];
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }

  function sha256Hex(input) {
    const msg = utf8Bytes(input);
    const bitLenHi = Math.floor((msg.length * 8) / 0x100000000);
    const bitLenLo = (msg.length * 8) >>> 0;
    const padLen = ((msg.length + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(padLen);
    buf.set(msg);
    buf[msg.length] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 8, bitLenHi, false);
    dv.setUint32(padLen - 4, bitLenLo, false);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let off = 0; off < padLen; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map((n) => n.toString(16).padStart(8, "0"))
      .join("");
  }

  function fnv1aHex(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  /* ========================================================================
     2. Zero-CDN Rust & Systems Deterministic Syntax Highlighter
     ======================================================================== */
  const RUST_KEYWORDS = new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn",
    "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
    "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
    "self", "Self", "static", "struct", "super", "trait", "true", "type",
    "unsafe", "use", "where", "while", "macro_rules"
  ]);

  const RUST_TYPES = new Set([
    "String", "str", "Vec", "Option", "Result", "Some", "None", "Ok", "Err",
    "Box", "Arc", "Mutex", "RwLock", "PathBuf", "Path", "HashMap", "BTreeMap",
    "HashSet", "BTreeSet", "Duration", "Instant", "u8", "u16", "u32", "u64",
    "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "f32", "f64",
    "bool", "char", "HWND", "WPARAM", "LPARAM", "LRESULT", "sqlite3",
    "SessionStore", "DynamicProviderRouter", "PeerMeshGraph", "GraphifyIndex",
    "RouteDecisionReceipt", "ErasureReceipt", "ConnectorRegistry",
    "WorkspaceOps", "CapabilityReport", "RemoteLeaseManager"
  ]);

  function highlightCode(source) {
    const text = String(source || "");
    const tokenRe = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|#!?\[[^\n\]]*\]|\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.[\d_]+)?\b|\b[a-zA-Z_]\w*\b)/g;
    let out = "";
    let last = 0;
    let match;
    while ((match = tokenRe.exec(text)) !== null) {
      out += escapeHtml(text.slice(last, match.index));
      const tok = match[0];
      if (tok.startsWith("//") || tok.startsWith("/*")) {
        out += '<span class="syn-cmt">' + escapeHtml(tok) + "</span>";
      } else if (tok.startsWith('"')) {
        out += '<span class="syn-str">' + escapeHtml(tok) + "</span>";
      } else if (tok.startsWith("#")) {
        out += '<span class="syn-kw">' + escapeHtml(tok) + "</span>";
      } else if (/^\d|^0x/.test(tok)) {
        out += '<span class="syn-num">' + escapeHtml(tok) + "</span>";
      } else if (RUST_KEYWORDS.has(tok)) {
        out += '<span class="syn-kw">' + escapeHtml(tok) + "</span>";
      } else if (RUST_TYPES.has(tok)) {
        out += '<span class="syn-type">' + escapeHtml(tok) + "</span>";
      } else {
        out += escapeHtml(tok);
      }
      last = tokenRe.lastIndex;
    }
    out += escapeHtml(text.slice(last));
    return out;
  }

  /* ========================================================================
     3. Zero-CDN Typographic LaTeX Math / Physics / Chemistry Renderer
     ======================================================================== */
  const LATEX_SYMBOLS = {
    "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\delta": "δ", "\\epsilon": "ϵ",
    "\\varepsilon": "ε", "\\zeta": "ζ", "\\eta": "η", "\\theta": "θ", "\\kappa": "κ",
    "\\lambda": "λ", "\\mu": "μ", "\\nu": "ν", "\\xi": "ξ", "\\pi": "π", "\\rho": "ρ",
    "\\sigma": "σ", "\\tau": "τ", "\\phi": "ϕ", "\\varphi": "φ", "\\chi": "χ",
    "\\psi": "ψ", "\\omega": "ω", "\\Gamma": "Γ", "\\Delta": "Δ", "\\Theta": "Θ",
    "\\Lambda": "Λ", "\\Xi": "Ξ", "\\Pi": "Π", "\\Sigma": "Σ", "\\Phi": "Φ",
    "\\Psi": "Ψ", "\\Omega": "Ω", "\\hbar": "ℏ", "\\nabla": "∇", "\\partial": "∂",
    "\\infty": "∞", "\\rightleftharpoons": "⇌", "\\leftrightarrow": "↔",
    "\\rightarrow": "→", "\\to": "→", "\\leftarrow": "←", "\\Rightarrow": "⇒",
    "\\Leftrightarrow": "⇔", "\\uparrow": "↑", "\\downarrow": "↓",
    "\\times": "×", "\\cdot": "·", "\\pm": "±", "\\mp": "∓", "\\neq": "≠",
    "\\leq": "≤", "\\le": "≤", "\\geq": "≥", "\\ge": "≥", "\\approx": "≈",
    "\\equiv": "≡", "\\propto": "∝", "\\in": "∈", "\\notin": "∉", "\\subset": "⊂",
    "\\forall": "∀", "\\exists": "∃", "\\circ": "°", "\\dagger": "†", "\\ell": "ℓ",
    "\\quad": " ", "\\,": " ", "\\;": " ", "\\!": ""
  };

  const BIG_OPS = {
    "\\sum": "∑",
    "\\prod": "∏",
    "\\int": "∫",
    "\\oint": "∮",
    "\\iint": "∬",
    "\\lim": "lim"
  };

  function readBracedGroup(src, idx) {
    while (idx < src.length && src[idx] === " ") idx++;
    if (src[idx] !== "{") {
      if (src[idx] === "\\") {
        let end = idx + 1;
        while (end < src.length && /[a-zA-Z]/.test(src[end])) end++;
        return { content: src.slice(idx, end), next: end };
      }
      return { content: src[idx] || "", next: Math.min(src.length, idx + 1) };
    }
    let depth = 0;
    let start = idx + 1;
    for (let i = idx; i < src.length; i++) {
      if (src[i] === "{" && src[i - 1] !== "\\") depth++;
      else if (src[i] === "}" && src[i - 1] !== "\\") {
        depth--;
        if (depth === 0) {
          return { content: src.slice(start, i), next: i + 1 };
        }
      }
    }
    return { content: src.slice(start), next: src.length };
  }

  function renderLatexInner(tex) {
    const s = String(tex || "").trim();
    let out = "";
    let i = 0;
    while (i < s.length) {
      if (s.startsWith("\\begin{pmatrix}", i) || s.startsWith("\\begin{bmatrix}", i)) {
        const endTag = s.startsWith("\\begin{pmatrix}", i) ? "\\end{pmatrix}" : "\\end{bmatrix}";
        const bodyStart = i + 15;
        const endIdx = s.indexOf(endTag, bodyStart);
        const body = endIdx >= 0 ? s.slice(bodyStart, endIdx) : s.slice(bodyStart);
        const rows = body.split("\\\\").map((r) => r.trim()).filter(Boolean);
        out += '<table class="math-matrix" role="presentation"><tbody>';
        for (const row of rows) {
          out += "<tr>";
          for (const cell of row.split("&")) {
            out += "<td>" + renderLatexInner(cell.trim()) + "</td>";
          }
          out += "</tr>";
        }
        out += "</tbody></table>";
        i = endIdx >= 0 ? endIdx + endTag.length : s.length;
        continue;
      }

      if (s.startsWith("\\frac", i)) {
        const num = readBracedGroup(s, i + 5);
        const den = readBracedGroup(s, num.next);
        out += '<span class="math-frac"><span class="math-frac-num">' +
          renderLatexInner(num.content) +
          '</span><span class="math-frac-den">' +
          renderLatexInner(den.content) +
          "</span></span>";
        i = den.next;
        continue;
      }

      if (s.startsWith("\\sqrt", i)) {
        const rad = readBracedGroup(s, i + 5);
        out += '<span class="math-sqrt">√<span class="math-sqrt-radicand">' +
          renderLatexInner(rad.content) + "</span></span>";
        i = rad.next;
        continue;
      }

      if (s.startsWith("\\mathbf", i) || s.startsWith("\\vec", i) || s.startsWith("\\hat", i) || s.startsWith("\\text", i) || s.startsWith("\\mathrm", i)) {
        let cmdEnd = i + 1;
        while (cmdEnd < s.length && /[a-zA-Z]/.test(s[cmdEnd])) cmdEnd++;
        const cmd = s.slice(i, cmdEnd);
        const grp = readBracedGroup(s, cmdEnd);
        if (cmd === "\\mathbf" || cmd === "\\vec") {
          const arrow = cmd === "\\vec" ? "\u20d7" : "";
          out += '<span class="math-vec">' + renderLatexInner(grp.content) + arrow + "</span>";
        } else if (cmd === "\\hat") {
          out += '<span class="math-vec">' + renderLatexInner(grp.content) + "\u0302</span>";
        } else {
          out += '<span>' + escapeHtml(grp.content) + "</span>";
        }
        i = grp.next;
        continue;
      }

      if (s.startsWith("\\left", i)) {
        i += 5;
        continue;
      }
      if (s.startsWith("\\right", i) && !s.startsWith("\\rightarrow", i) && !s.startsWith("\\rightleftharpoons", i)) {
        i += 6;
        continue;
      }

      if (s[i] === "\\") {
        let end = i + 1;
        if (end < s.length && !/[a-zA-Z]/.test(s[end])) {
          end++;
        } else {
          while (end < s.length && /[a-zA-Z]/.test(s[end])) end++;
        }
        const cmd = s.slice(i, end);
        if (Object.prototype.hasOwnProperty.call(BIG_OPS, cmd)) {
          let sub = "";
          let sup = "";
          let cur = end;
          for (let k = 0; k < 2; k++) {
            while (cur < s.length && s[cur] === " ") cur++;
            if (s[cur] === "_") {
              const g = readBracedGroup(s, cur + 1);
              sub = renderLatexInner(g.content);
              cur = g.next;
            } else if (s[cur] === "^") {
              const g = readBracedGroup(s, cur + 1);
              sup = renderLatexInner(g.content);
              cur = g.next;
            }
          }
          out += '<span class="math-op-stack">' +
            (sup ? '<span class="math-op-sup">' + sup + "</span>" : "") +
            '<span class="math-op-sym">' + escapeHtml(BIG_OPS[cmd]) + "</span>" +
            (sub ? '<span class="math-op-sub">' + sub + "</span>" : "") +
            "</span>";
          i = cur;
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(LATEX_SYMBOLS, cmd)) {
          out += escapeHtml(LATEX_SYMBOLS[cmd]);
        } else {
          out += escapeHtml(cmd.slice(1));
        }
        i = end;
        continue;
      }

      if (s[i] === "^" || s[i] === "_") {
        const tag = s[i] === "^" ? "sup" : "sub";
        const grp = readBracedGroup(s, i + 1);
        out += "<" + tag + ">" + renderLatexInner(grp.content) + "</" + tag + ">";
        i = grp.next;
        continue;
      }

      if (s[i] === "{" || s[i] === "}") {
        i++;
        continue;
      }

      if (s[i] === "-") {
        out += "−";
        i++;
        continue;
      }

      out += escapeHtml(s[i]);
      i++;
    }
    return out;
  }

  function renderLatexToHtml(latex, displayMode) {
    const inner = '<span class="math-expr">' + renderLatexInner(latex) + "</span>";
    return displayMode ? '<div class="math-display-block">' + inner + "</div>" : inner;
  }

  function renderRichMarkdown(markdown, attachmentLookup) {
    const src = String(markdown || "");
    const lines = src.split("\n");
    const htmlParts = [];
    let inCode = false;
    let codeBuf = [];

    function renderInline(lineText) {
      let chunk = "";
      let idx = 0;
      while (idx < lineText.length) {
        if (lineText.startsWith("$$", idx)) {
          const close = lineText.indexOf("$$", idx + 2);
          if (close > idx + 2) {
            chunk += renderLatexToHtml(lineText.slice(idx + 2, close), true);
            idx = close + 2;
            continue;
          }
        }
        if (lineText[idx] === "$") {
          const close = lineText.indexOf("$", idx + 1);
          if (close > idx + 1) {
            chunk += renderLatexToHtml(lineText.slice(idx + 1, close), false);
            idx = close + 1;
            continue;
          }
        }
        if (lineText.startsWith("[[att:", idx)) {
          const close = lineText.indexOf("]]", idx + 6);
          if (close > idx + 6) {
            const attId = lineText.slice(idx + 6, close);
            const meta = attachmentLookup && attachmentLookup[attId];
            const label = meta ? meta.name + " · " + meta.sha256.slice(0, 8) : "att:" + attId;
            chunk += '<span class="inline-att-chip">📎 ' + escapeHtml(label) + "</span>";
            idx = close + 2;
            continue;
          }
        }
        chunk += escapeHtml(lineText[idx]);
        idx++;
      }
      return chunk
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/__([^_]+)__/g, "<u>$1</u>")
        .replace(/`([^`]+)`/g, '<code class="mono">$1</code>');
    }

    for (const rawLine of lines) {
      if (rawLine.trim().startsWith("```")) {
        if (!inCode) {
          inCode = true;
          codeBuf = [];
        } else {
          inCode = false;
          htmlParts.push('<pre class="code-pre">' + highlightCode(codeBuf.join("\n")) + "</pre>");
        }
        continue;
      }
      if (inCode) {
        codeBuf.push(rawLine);
        continue;
      }
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length > 4) {
        htmlParts.push(renderLatexToHtml(trimmed.slice(2, -2), true));
      } else if (trimmed.startsWith("# ")) {
        htmlParts.push('<div style="font-size:1.1rem;font-weight:700;margin:4px 0;">' + renderInline(trimmed.slice(2)) + "</div>");
      } else if (trimmed.startsWith("## ")) {
        htmlParts.push('<div style="font-size:0.98rem;font-weight:700;color:var(--accent-amber);margin:4px 0;">' + renderInline(trimmed.slice(3)) + "</div>");
      } else if (trimmed.startsWith("- [x] ") || trimmed.startsWith("- [ ] ")) {
        const checked = trimmed.startsWith("- [x] ");
        htmlParts.push('<div class="row-wrap" style="margin:2px 0;"><span>' + (checked ? "☑" : "☐") + "</span><span>" + renderInline(trimmed.slice(6)) + "</span></div>");
      } else if (trimmed.startsWith("- ")) {
        htmlParts.push('<div style="padding-left:12px;margin:2px 0;">• ' + renderInline(trimmed.slice(2)) + "</div>");
      } else {
        htmlParts.push("<p>" + renderInline(rawLine) + "</p>");
      }
    }
    if (inCode && codeBuf.length) {
      htmlParts.push('<pre class="code-pre">' + highlightCode(codeBuf.join("\n")) + "</pre>");
    }
    return htmlParts.join("") || '<span class="muted">Live preview renders Markdown, Rust code, and LaTeX equations automatically.</span>';
  }

  /* ========================================================================
     4. Live HTTP Client + Contract Normalization
     ======================================================================== */
  let connectionMode = "PROBING";

  function canAttemptHttp() {
    return typeof global.location !== "undefined" &&
      (global.location.protocol === "http:" || global.location.protocol === "https:");
  }

  function resolveTimeoutMs(options, fallbackMs) {
    return options && options.timeoutMs != null && Number.isFinite(Number(options.timeoutMs))
      ? Math.max(100, Math.min(120000, Math.trunc(Number(options.timeoutMs))))
      : fallbackMs;
  }

  async function requestJsonDetailed(method, path, body, options) {
    const timeoutMs = resolveTimeoutMs(options, 2800);
    if (!canAttemptHttp()) {
      connectionMode = "STANDALONE_ATELIER";
      return {
        ok: false,
        httpStatus: 0,
        data: null,
        error: "standalone_origin",
        message: "Opened outside HTTP listener; live Studio endpoints are unreachable."
      };
    }
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const opts = {
        method,
        headers: { Accept: "application/json" },
        signal: ctrl ? ctrl.signal : undefined
      };
      if (body !== undefined) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(path, opts);
      if (timer) clearTimeout(timer);
      connectionMode = "LIVE_RUST";
      const data = await res.json().catch(() => null);
      if (res.ok && data && typeof data === "object") {
        return {
          ok: data.ok !== false,
          httpStatus: res.status,
          data,
          error: data.ok === false ? (data.error || data.code || "endpoint_error") : null,
          message: data.message || data.reason || null
        };
      }
      return {
        ok: false,
        httpStatus: res.status,
        data: data && typeof data === "object" ? data : null,
        error: (data && (data.error || data.code)) || ("http_" + res.status),
        message: (data && (data.message || data.reason)) || ("HTTP " + res.status + " from " + path)
      };
    } catch (err) {
      if (timer) clearTimeout(timer);
      connectionMode = "STANDALONE_ATELIER";
      return {
        ok: false,
        httpStatus: 0,
        data: null,
        error: err && err.name === "AbortError" ? "request_timeout" : "network_unreachable",
        message: err && err.message ? err.message : "Failed to reach " + path
      };
    }
  }

  async function requestJson(method, path, body, options) {
    const preserveErrorPayload = Boolean(options && options.preserveErrorPayload === true);
    const timeoutMs = resolveTimeoutMs(options, 2400);
    if (!canAttemptHttp()) {
      connectionMode = "STANDALONE_ATELIER";
      return null;
    }
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const opts = {
        method,
        headers: { Accept: "application/json" },
        signal: ctrl ? ctrl.signal : undefined
      };
      if (body !== undefined) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(path, opts);
      if (timer) clearTimeout(timer);
      connectionMode = "LIVE_RUST";
      const data = await res.json().catch(() => null);
      if (!res.ok && !preserveErrorPayload) return null;
      return data && typeof data === "object" ? data : null;
    } catch (_err) {
      if (timer) clearTimeout(timer);
      connectionMode = "STANDALONE_ATELIER";
      return null;
    }
  }

  function unavailableResult(error, extra) {
    return Object.assign({
      ok: false,
      state: "unavailable",
      error: String(error || "endpoint_unavailable")
    }, extra || {});
  }

  function unavailableArray(error) {
    const result = [];
    result.ok = false;
    result.state = "unavailable";
    result.error = String(error || "endpoint_unavailable");
    return result;
  }

  const api = {
    getConnectionMode() {
      return connectionMode;
    },

    async getCapabilities() {
      const live = await requestJson("GET", "/api/capabilities");
      if (live && live.ok !== false) {
        if (live.schema === "omnia.capabilities.v1" && Array.isArray(live.capabilities)) {
          return live;
        }
        if (Array.isArray(live.capabilities)) {
          return {
            ok: true,
            schema: live.schema || "omnia.capabilities.v1",
            listener: live.listener ?? null,
            capabilities: live.capabilities
          };
        }
        if (live.capabilities && typeof live.capabilities === "object") {
          return {
            ok: true,
            schema: live.schema || "omnia.capabilities.v1",
            listener: live.listener ?? null,
            capabilities: Object.entries(live.capabilities).map(([id, enabled]) => ({
              id,
              enabled: Boolean(enabled)
            }))
          };
        }
      }
      return unavailableResult("capabilities_endpoint_unavailable", {
        schema: "omnia.capabilities.v1",
        listener: null,
        capabilities: []
      });
    },

    async getHealth() {
      const live = await requestJson("GET", "/api/health");
      if (live && live.ok !== false) {
        return {
          ok: live.ok !== false,
          state: live.state || "ok",
          engine: live.engine ?? null,
          compiler: live.compiler ?? live.rustcVersion ?? live.rustc ?? null,
          crateCount: live.crateCount ?? live.crate_count ?? null,
          httpStack: live.httpStack ?? live.http_stack ?? null,
          sqliteBackend: live.sqliteBackend ?? live.sqlite_backend ?? null,
          rustRuntime: live.rustRuntime ?? live.rust_runtime ?? null,
          rustFiles: live.rustFiles ?? live.rust_files ?? null,
          pid: live.pid ?? null,
          workingSetBytes: live.workingSetBytes ?? live.working_set_bytes ?? null,
          binaryBytes: live.binaryBytes ?? live.binary_bytes ?? null,
          skillCount: live.skillCount ?? live.skill_count ?? null,
          peerCount: live.peerCount ?? live.peer_count ?? null
        };
      }
      return unavailableResult("health_endpoint_unavailable", {
        engine: null,
        compiler: null,
        crateCount: null,
        httpStack: null,
        sqliteBackend: null,
        rustRuntime: null,
        rustFiles: null,
        pid: null,
        workingSetBytes: null,
        binaryBytes: null,
        skillCount: null,
        peerCount: null
      });
    },


    async getRuntimeStatus() {
      const live = await requestJson("GET", "/api/runtime/status", undefined, {
        preserveErrorPayload: true,
        timeoutMs: 5000
      });
      if (live && live.ok !== false && live.state !== "unavailable") {
        return live;
      }
      if (live && (live.error || live.code || live.message)) {
        return {
          ok: false,
          state: "unavailable",
          code: live.code || live.error || "runtime_status_unavailable",
          error: live.error || live.code || "runtime_status_unavailable",
          message: live.message || "Omnia runtime status unavailable."
        };
      }
      return unavailableResult("runtime_status_unavailable", {
        code: "runtime_status_unavailable",
        message: "Omnia runtime status endpoint unavailable."
      });
    },
    async getNvidiaHardware() {
      const live = await requestJson("GET", "/api/hardware/nvidia", undefined, {
        preserveErrorPayload: true,
        timeoutMs: 3200
      });
      if (live && live.schema === "omnia.hardware.nvidia.v1" &&
          ["ready", "unavailable", "error"].includes(String(live.state || ""))) {
        return live;
      }
      return unavailableResult("nvidia_runtime_unavailable", {
        schema: "omnia.hardware.nvidia.v1",
        backend: "nvidia-smi",
        evidenceScope: "device_query_only",
        workloads: { cuda: "unverified", tensorrt: "unverified", nvenc: "unverified" },
        gpus: []
      });
    },

    async getSessions() {
      const live = await requestJson("GET", "/api/sessions");
      if (live && Array.isArray(live.sessions)) return live;
      return unavailableResult("sessions_endpoint_unavailable", {
        sessions: [],
        activeLease: null
      });
    },

    async getHistory(query, limit, offset) {
      const params = new URLSearchParams();
      const cleanQuery = String(query || "").trim();
      if (cleanQuery) params.set("query", cleanQuery);
      if (Number.isFinite(Number(limit))) params.set("limit", String(Math.max(1, Math.min(200, Math.trunc(Number(limit))))));
      if (Number.isFinite(Number(offset))) params.set("offset", String(Math.max(0, Math.min(1000000, Math.trunc(Number(offset))))));
      const suffix = params.toString() ? "?" + params.toString() : "";
      const live = await requestJson("GET", "/api/history" + suffix);
      if (live && live.schema === "omnia.history-manifest.v2") return live;
      return {
        ok: false,
        schema: "omnia.history-manifest.v2",
        state: "unavailable",
        acquisitionState: "unavailable",
        error: "history_endpoint_unavailable",
        manifestPath: "",
        records: [],
        counts: {
          records: 0,
          verified: 0,
          partial: 0,
          blocked: 0,
          transcriptAvailable: 0
        },
        completion: {
          verified: [],
          partial: [],
          blocked: [],
          next: []
        }
      };
    },

    async getHistoryMessages(recordId, limit, offset) {
      const params = new URLSearchParams();
      const cleanId = String(recordId || "").trim();
      if (cleanId) params.set("record_id", cleanId);
      if (Number.isFinite(Number(limit))) {
        params.set("limit", String(Math.max(1, Math.min(200, Math.trunc(Number(limit))))));
      }
      if (Number.isFinite(Number(offset))) {
        params.set("offset", String(Math.max(0, Math.min(1000000, Math.trunc(Number(offset))))));
      }
      const suffix = params.toString() ? "?" + params.toString() : "";
      const live = await requestJson("GET", "/api/history/messages" + suffix);
      if (live && live.schema === "omnia.history-messages.v1") return live;
      return {
        ok: false,
        schema: "omnia.history-messages.v1",
        recordId: cleanId,
        state: "unavailable",
        error: "history_messages_endpoint_unavailable",
        messages: [],
        totalMatched: 0,
        limit: Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Math.trunc(Number(limit)))) : 20,
        offset: Number.isFinite(Number(offset)) ? Math.max(0, Math.min(1000000, Math.trunc(Number(offset)))) : 0
      };
    },

    async createSession(payload) {
      const live = await requestJson("POST", "/api/sessions/create", payload);
      if (live && (live.sessions || live.session)) {
        return Object.assign({ sessions: [] }, live);
      }
      return unavailableResult("sessions_create_endpoint_unavailable", {
        session: null,
        sessions: []
      });
    },

    async getSteer() {
      const live = await requestJson("GET", "/api/steer");
      if (live && Array.isArray(live.items)) {
        return Object.assign({}, live, {
          tokenBudget: live.tokenBudget ?? live.token_budget ?? null
        });
      }
      return unavailableResult("steer_endpoint_unavailable", {
        tokenBudget: null,
        invariant: null,
        items: []
      });
    },

    async enqueueSteer(text) {
      const clean = String(text || "").trim();
      if (!clean) return this.getSteer();
      const live = await requestJson("POST", "/api/steer/enqueue", { text: clean });
      if (live && (live.item || Array.isArray(live.items))) {
        return Object.assign({}, live, {
          tokenBudget: live.tokenBudget ?? live.token_budget ?? null
        });
      }
      return unavailableResult("steer_enqueue_endpoint_unavailable", {
        tokenBudget: null,
        item: null,
        items: []
      });
    },

    async getTemplates() {
      const live = await requestJson("GET", "/api/composer/templates");
      if (live && Array.isArray(live.templates)) return live.templates;
      return unavailableArray("composer_templates_endpoint_unavailable");
    },

    async getGraph() {
      const live = await requestJson("GET", "/api/graph");
      if (live && Array.isArray(live.nodes)) {
        return {
          ok: live.ok !== false,
          state: live.state || "ok",
          nodes: live.nodes,
          links: Array.isArray(live.links) ? live.links : [],
          messages: Array.isArray(live.messages) ? live.messages : [],
          graphifyNodes: Array.isArray(live.graphifyNodes)
            ? live.graphifyNodes
            : (Array.isArray(live.graphify_nodes) ? live.graphify_nodes : []),
          graphifyEdges: Array.isArray(live.graphifyEdges)
            ? live.graphifyEdges
            : (Array.isArray(live.graphify_edges) ? live.graphify_edges : [])
        };
      }
      return unavailableResult("graph_endpoint_unavailable", {
        nodes: [],
        links: [],
        messages: [],
        graphifyNodes: [],
        graphifyEdges: []
      });
    },

    async sendGraphMessage(payload) {
      const live = await requestJson("POST", "/api/graph/send", payload);
      if (live && live.ok !== false) return live;
      return unavailableResult("graph_send_endpoint_unavailable", {
        message: null,
        messages: []
      });
    },

    async traverseGraph(entity, direction, maxDepth) {
      const qs = "?entity=" + encodeURIComponent(entity) +
        "&direction=" + encodeURIComponent(direction) +
        "&maxDepth=" + encodeURIComponent(maxDepth);
      const live = await requestJson("GET", "/api/graph/traverse" + qs);
      if (live && (Array.isArray(live.edges) || Array.isArray(live.visited))) return live;
      return unavailableResult("graph_traverse_endpoint_unavailable", {
        entity: entity || null,
        direction: direction || null,
        maxDepth: Number.isFinite(Number(maxDepth)) ? Number(maxDepth) : null,
        visited: [],
        edges: [],
        quarantinedAmbiguous: []
      });
    },

    async getRouterState() {
      const live = await requestJson("GET", "/api/router/state");
      if (live && Array.isArray(live.candidates)) return live;
      return unavailableResult("router_state_endpoint_unavailable", {
        candidates: [],
        recentReceipts: []
      });
    },


    async sendChatCompletion(payload, options) {
      const timeout = options && options.timeoutMs != null && Number.isFinite(Number(options.timeoutMs))
        ? Math.max(100, Math.min(120000, Math.trunc(Number(options.timeoutMs))))
        : 65000;
      const live = await requestJson("POST", "/api/chat", payload, {
        preserveErrorPayload: true,
        timeoutMs: timeout
      });
      if (live && live.ok !== false && live.state !== "unavailable") {
        return live;
      }
      if (live && typeof live === "object") {
        return {
          ok: false,
          state: "unavailable",
          status: live.status || "UNAVAILABLE",
          code: live.code || live.error || "chat_completion_failed",
          error: live.error || live.code || "chat_completion_failed",
          message: live.message || "Chat completion endpoint returned an error response.",
          details: live
        };
      }
      return unavailableResult("chat_completion_unavailable", {
        status: "UNAVAILABLE",
        code: "chat_completion_unavailable",
        message: "Chat completion endpoint (/api/chat) is currently offline or unreachable.",
        details: null
      });
    },
    async decideRoute(payload) {
      const live = await requestJson("POST", "/api/router/decide", payload);
      if (live) return live;
      return unavailableResult("router_decide_endpoint_unavailable", {
        selectedCandidateId: null,
        status: "UNAVAILABLE",
        receipt: null,
        candidates: []
      });
    },

    async queryRag(query) {
      const res = await requestJsonDetailed("POST", "/api/rag/query", { query });
      const live = res.data;
      if (res.ok && live) {
        return {
          ok: live.ok !== false,
          state: live.state || "ok",
          query: live.query || query,
          language: live.language ?? null,
          uncertaintyScore: live.uncertaintyScore ?? live.uncertainty_score ?? null,
          shouldRetrieve: live.shouldRetrieve ?? live.should_retrieve ?? null,
          triggers: live.triggers || [],
          subQueries: live.subQueries || live.sub_queries || [],
          citedSources: live.citedSources || live.cited_sources || live.citations || [],
          unusedSources: live.unusedSources || live.unused_sources || [],
          hits: Array.isArray(live.hits) ? live.hits : (Array.isArray(live.results) ? live.results : []),
          answer: live.answer ?? live.summary ?? null
        };
      }
      return unavailableResult(res.error || "rag_query_endpoint_unavailable", {
        httpStatus: res.httpStatus,
        message: res.message,
        query: String(query || ""),
        language: null,
        uncertaintyScore: null,
        shouldRetrieve: null,
        triggers: [],
        subQueries: [],
        citedSources: [],
        unusedSources: [],
        hits: [],
        answer: null
      });
    },

    async planRag(query) {
      let res = await requestJsonDetailed("POST", "/api/rag/plan", { query });
      if (!res.ok && res.httpStatus === 404) {
        res = await requestJsonDetailed("POST", "/api/rag/query", { query });
      }
      const live = res.data;
      if (res.ok && live && (live.subQueries || live.sub_queries || live.uncertaintyScore !== undefined || live.hits || live.results)) {
        return {
          ok: live.ok !== false,
          state: live.state || "ok",
          query: live.query || query,
          language: live.language ?? null,
          uncertaintyScore: live.uncertaintyScore ?? live.uncertainty_score ?? null,
          shouldRetrieve: live.shouldRetrieve ?? live.should_retrieve ?? null,
          triggers: live.triggers || [],
          subQueries: live.subQueries || live.sub_queries || [],
          citedSources: live.citedSources || live.cited_sources || live.citations || [],
          unusedSources: live.unusedSources || live.unused_sources || [],
          hits: Array.isArray(live.hits) ? live.hits : (Array.isArray(live.results) ? live.results : []),
          answer: live.answer ?? live.summary ?? null
        };
      }
      return unavailableResult(res.error || "rag_plan_endpoint_unavailable", {
        httpStatus: res.httpStatus,
        message: res.message,
        query: String(query || ""),
        language: null,
        uncertaintyScore: null,
        shouldRetrieve: null,
        triggers: [],
        subQueries: [],
        citedSources: [],
        unusedSources: [],
        hits: [],
        answer: null
      });
    },

    async getWorkspaceTree(relPath, maxDepth) {
      const cleanPath = String(relPath == null ? "." : relPath).trim() || ".";
      const depthNum = maxDepth != null && Number.isFinite(Number(maxDepth))
        ? Math.max(1, Math.min(8, Math.trunc(Number(maxDepth))))
        : 3;
      const url = "/api/workspace/tree?path=" + encodeURIComponent(cleanPath) +
        "&max_depth=" + encodeURIComponent(String(depthNum));
      const res = await requestJsonDetailed("GET", url);
      const live = res.data;
      if (res.ok && live && Array.isArray(live.entries)) {
        return {
          ok: true,
          state: "ok",
          root: live.root ?? cleanPath,
          path: cleanPath,
          entries: live.entries.map((entry) => ({
            path: String(entry.path || entry.relativePath || entry.name || ""),
            kind: entry.kind === "dir" || entry.type === "dir" ? "dir" : "file",
            bytes: Number(entry.bytes ?? entry.sizeBytes ?? entry.size ?? 0)
          }))
        };
      }
      return unavailableResult(res.error || "workspace_tree_unavailable", {
        httpStatus: res.httpStatus,
        message: res.message,
        root: null,
        path: cleanPath,
        entries: []
      });
    },

    async getWorkspaceFile(relPath, startLine, endLine) {
      const cleanPath = String(relPath || "").trim();
      if (!cleanPath) {
        return unavailableResult("workspace_path_required", {
          httpStatus: 0,
          message: "Specify a relative file path (for example Cargo.toml).",
          relativePath: "",
          content: null,
          sha256: null,
          lineCount: 0,
          lines: []
        });
      }
      const params = ["path=" + encodeURIComponent(cleanPath)];
      if (startLine != null && Number.isFinite(Number(startLine)) && Number(startLine) > 0) {
        params.push("start_line=" + encodeURIComponent(String(Math.trunc(Number(startLine)))));
      }
      if (endLine != null && Number.isFinite(Number(endLine)) && Number(endLine) > 0) {
        params.push("end_line=" + encodeURIComponent(String(Math.trunc(Number(endLine)))));
      }
      const res = await requestJsonDetailed("GET", "/api/workspace/file?" + params.join("&"));
      const live = res.data;
      if (res.ok && live && (typeof live.content === "string" || Array.isArray(live.lines))) {
        const baseStart = startLine != null && Number(startLine) > 0 ? Math.trunc(Number(startLine)) : 1;
        const rawLines = Array.isArray(live.lines)
          ? live.lines.map((row, i) => ({
            lineNumber: Number(row.lineNumber ?? row.line_number ?? (baseStart + i)),
            text: String(row.text ?? row.content ?? "")
          }))
          : String(live.content || "").split(/\r?\n/).map((text, i) => ({
            lineNumber: baseStart + i,
            text
          }));
        const content = typeof live.content === "string"
          ? live.content
          : rawLines.map((row) => row.text).join("\n");
        return {
          ok: true,
          state: "ok",
          relativePath: live.relativePath || live.relative_path || live.path || cleanPath,
          content,
          sha256: live.sha256 ?? null,
          lineCount: Number(live.lineCount ?? live.line_count ?? rawLines.length),
          lines: rawLines
        };
      }
      return unavailableResult(res.error || "workspace_file_unavailable", {
        httpStatus: res.httpStatus,
        message: res.message,
        relativePath: cleanPath,
        content: null,
        sha256: null,
        lineCount: 0,
        lines: []
      });
    },

    async diffWorkspace(beforeText, afterText, contextLines) {
      const ctx = contextLines != null && Number.isFinite(Number(contextLines))
        ? Math.max(0, Math.min(20, Math.trunc(Number(contextLines))))
        : 3;
      const res = await requestJsonDetailed("POST", "/api/workspace/diff", {
        beforeText: String(beforeText == null ? "" : beforeText),
        afterText: String(afterText == null ? "" : afterText),
        contextLines: ctx
      });
      const live = res.data;
      if (res.ok && live && typeof live.unifiedDiff === "string") {
        return {
          ok: true,
          state: "ok",
          additions: Number(live.additions ?? 0),
          deletions: Number(live.deletions ?? 0),
          hunks: Number(live.hunks ?? 0),
          unifiedDiff: live.unifiedDiff
        };
      }
      return unavailableResult(res.error || "workspace_diff_unavailable", {
        httpStatus: res.httpStatus,
        message: res.message,
        additions: 0,
        deletions: 0,
        hunks: 0,
        unifiedDiff: null
      });
    },

    async getGraphCode(entity, direction, maxDepth) {
      const params = [];
      if (entity && String(entity).trim()) {
        params.push("entity=" + encodeURIComponent(String(entity).trim()));
      }
      if (direction && String(direction).trim()) {
        params.push("direction=" + encodeURIComponent(String(direction).trim()));
      }
      if (maxDepth != null && Number.isFinite(Number(maxDepth))) {
        params.push("max_depth=" + encodeURIComponent(String(Math.max(1, Math.min(6, Math.trunc(Number(maxDepth)))))));
      }
      const query = params.length ? "?" + params.join("&") : "";
      const res = await requestJsonDetailed("GET", "/api/graph/code" + query);
      const live = res.data;
      if (res.ok && live) {
        return {
          ok: true,
          state: "ok",
          entity: live.entity ?? (entity || null),
          nodes: Array.isArray(live.nodes) ? live.nodes : [],
          edges: Array.isArray(live.edges) ? live.edges : [],
          matches: Array.isArray(live.matches) ? live.matches : [],
          summary: live.summary ?? null
        };
      }
      return unavailableResult(res.error || "graph_code_unavailable", {
        httpStatus: res.httpStatus,
        message: res.message,
        entity: entity || null,
        nodes: [],
        edges: [],
        matches: [],
        summary: null
      });
    },

    async getConnectorsStatus() {
      const res = await requestJsonDetailed("GET", "/api/connectors/status");
      const live = res.data;
      if (res.ok && live) {
        const rawList = Array.isArray(live.connectors)
          ? live.connectors
          : (Array.isArray(live) ? live : []);
        return {
          ok: true,
          state: "ok",
          checkedAt: live.checkedAt ?? live.checked_at ?? null,
          connectors: rawList.map((item) => ({
            id: String(item.id || item.name || "unknown"),
            name: String(item.name || item.id || "Unknown Connector"),
            status: String(item.status || "unavailable"),
            reason: item.reason ?? item.reasonCode ?? item.reason_code ?? item.detail ?? null,
            detail: item.detail ?? item.message ?? null,
            endpoint: item.endpoint ?? item.binaryPath ?? item.binary_path ?? null
          }))
        };
      }
      return unavailableResult(res.error || "connectors_status_unavailable", {
        httpStatus: res.httpStatus,
        message: res.message,
        checkedAt: null,
        connectors: []
      });
    },

    async validateConnectors(payload) {
      const res = await requestJsonDetailed("POST", "/api/connectors/validate", payload || {}, { timeoutMs: 8000 });
      const live = res.data;
      if (res.ok && live) {
        const rawList = Array.isArray(live.connectors)
          ? live.connectors
          : (Array.isArray(live.results) ? live.results : []);
        return {
          ok: true,
          state: "ok",
          checkedAt: live.checkedAt ?? live.checked_at ?? null,
          connectors: rawList.map((item) => ({
            id: String(item.id || item.name || "unknown"),
            name: String(item.name || item.id || "Unknown Connector"),
            status: String(item.status || "unavailable"),
            reason: item.reason ?? item.reasonCode ?? item.reason_code ?? item.detail ?? null,
            detail: item.detail ?? item.message ?? null,
            endpoint: item.endpoint ?? item.binaryPath ?? item.binary_path ?? null
          }))
        };
      }
      return unavailableResult(res.error || "connectors_validate_unavailable", {
        httpStatus: res.httpStatus,
        message: res.message,
        checkedAt: null,
        connectors: []
      });
    },

    async getMediaCapabilities() {
      const res = await requestJsonDetailed("GET", "/api/media/capabilities");
      const live = res.data;
      if (res.ok && live) {
        let rawList = [];
        if (Array.isArray(live.capabilities)) rawList = live.capabilities;
        else if (Array.isArray(live.adapters)) rawList = live.adapters;
        else if (live.capabilities && typeof live.capabilities === "object") {
          rawList = Object.entries(live.capabilities).map(([key, val]) =>
            Object.assign({ adapter: key }, val && typeof val === "object" ? val : { status: String(val) })
          );
        }
        return {
          ok: true,
          state: "ok",
          capabilities: rawList.map((item) => ({
            adapter: String(item.adapter || item.id || item.name || "unknown"),
            name: String(item.name || item.adapter || item.id || "Unknown Adapter"),
            status: String(item.status || "unavailable"),
            reasonCode: item.reasonCode ?? item.reason_code ?? item.reason ?? null,
            detail: item.detail ?? item.message ?? item.reason ?? null,
            sourceVerified: item.sourceVerified ?? item.source_verified ?? null,
            endpointOrigin: item.endpointOrigin ?? item.endpoint_origin ?? null,
            latencyMs: item.latencyMs ?? item.latency_ms ?? null
          }))
        };
      }
      return unavailableResult(res.error || "media_capabilities_unavailable", {
        httpStatus: res.httpStatus,
        message: res.message,
        capabilities: []
      });
    },

    async getRemoteStatus() {
      const res = await requestJsonDetailed("GET", "/api/remote/status");
      const live = res.data;
      if (res.ok && live) {
        return {
          ok: true,
          state: "ok",
          status: String(live.status || "unavailable"),
          reason: live.reason ?? live.reasonCode ?? live.reason_code ?? live.detail ?? null,
          protocol: live.protocol ?? live.schema ?? null,
          pairing: live.pairing ?? null,
          activeLeases: Number(live.activeLeases ?? live.active_leases ?? (Array.isArray(live.leases) ? live.leases.length : 0)),
          leases: Array.isArray(live.leases) ? live.leases : [],
          replayWindow: live.replayWindow ?? live.replay_window ?? null
        };
      }
      return unavailableResult(res.error || "remote_status_unavailable", {
        httpStatus: res.httpStatus,
        message: res.message,
        status: "unavailable",
        reason: res.message || res.error || "remote_status_unavailable",
        protocol: null,
        pairing: null,
        activeLeases: 0,
        leases: [],
        replayWindow: null
      });
    },

    async getMemory() {
      const live = await requestJson("GET", "/api/memory");
      if (live && Array.isArray(live.entries)) return live;
      return unavailableResult("memory_endpoint_unavailable", {
        entries: [],
        erasures: []
      });
    },

    async upsertMemory(payload) {
      const ns = String(payload.namespace || "").trim();
      if (!ns || ns.includes("..") || ns.includes("\\")) {
        return { ok: false, error: "Rejected invalid namespace: '..' and '\\' path segments are forbidden." };
      }
      const live = await requestJson("POST", "/api/memory/upsert", payload);
      if (live && live.ok !== false && live.entry) return live;
      return unavailableResult("memory_upsert_endpoint_unavailable", {
        entry: null
      });
    },

    async eraseMemory(target) {
      const live = await requestJson("POST", "/api/memory/erase", target);
      if (live && live.receipt) return live;
      return unavailableResult("memory_erase_endpoint_unavailable", {
        receipt: null
      });
    },

    async searchSkills(query) {
      const q = String(query || "").trim();
      const live = await requestJson("GET", "/api/skills?q=" + encodeURIComponent(q));
      if (live && Array.isArray(live.skills)) return live;
      return unavailableResult("skills_endpoint_unavailable", {
        query: q,
        total: 0,
        skills: []
      });
    }
  };

  Studio.utils = {
    sha256Hex,
    fnv1aHex,
    escapeHtml,
    formatBytes,
    highlightCode,
    renderLatexToHtml,
    renderRichMarkdown
  };
  Studio.api = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
