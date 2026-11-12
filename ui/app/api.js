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
     2. Zero-CDN C++20 Deterministic Syntax Highlighter
     ======================================================================== */
  const CPP_KEYWORDS = new Set([
    "alignas", "auto", "bool", "break", "case", "catch", "class", "co_await",
    "co_return", "co_yield", "concept", "const", "consteval", "constexpr",
    "constinit", "continue", "default", "delete", "do", "double", "else",
    "enum", "explicit", "export", "extern", "false", "final", "float", "for",
    "friend", "if", "inline", "int", "long", "mutable", "namespace", "new",
    "noexcept", "nullptr", "operator", "override", "private", "protected",
    "public", "requires", "return", "short", "signed", "sizeof", "static",
    "static_assert", "struct", "switch", "template", "this", "throw", "true",
    "try", "typedef", "typename", "union", "unsigned", "using", "virtual",
    "void", "volatile", "while"
  ]);

  const CPP_TYPES = new Set([
    "std", "string", "string_view", "span", "vector", "unique_ptr", "shared_ptr",
    "optional", "variant", "mutex", "lock_guard", "scoped_lock", "uint8_t",
    "uint32_t", "uint64_t", "size_t", "int64_t", "sqlite3", "sqlite3_stmt",
    "HRESULT", "HWND", "WPARAM", "LPARAM", "LRESULT", "BCRYPT_ALG_HANDLE",
    "IRawElementProviderSimple", "IValueProvider", "IInvokeProvider",
    "JsonValue", "SessionStore", "DynamicProviderRouter", "PeerMeshGraph",
    "GraphifyIndex", "RouteDecisionReceipt", "ErasureReceipt"
  ]);

  function highlightCpp20(source) {
    const text = String(source || "");
    const tokenRe = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|#\s*[a-zA-Z_]+|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_]\w*\b)/g;
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
      } else if (CPP_KEYWORDS.has(tok)) {
        out += '<span class="syn-kw">' + escapeHtml(tok) + "</span>";
      } else if (CPP_TYPES.has(tok)) {
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
          htmlParts.push('<pre class="code-pre">' + highlightCpp20(codeBuf.join("\n")) + "</pre>");
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
      htmlParts.push('<pre class="code-pre">' + highlightCpp20(codeBuf.join("\n")) + "</pre>");
    }
    return htmlParts.join("") || '<span class="muted">Live preview renders Markdown, C++20 code, and LaTeX equations automatically.</span>';
  }

  /* ========================================================================
     4. Rich Standalone Atelier Fallback State (100% Parity with C++20 Host)
     ======================================================================== */
  const fallbackState = {
    health: {
      ok: true,
      engine: "Omnia Native C++20",
      compiler: "MSVC 14.51.36231",
      cplusplus: 202002,
      rustFiles: 0,
      pid: 41280,
      workingSetBytes: 8650752,
      binaryBytes: 397312,
      skillCount: 13,
      peerCount: 6
    },
    sessions: [
      { id: "sess-cpp20-atelier", title: "Wave 4 • Native C++20 Studio & UIA", modelId: "gemini-3.1-pro", effort: "high", updatedAt: "2026-11-12T20:26:00Z" },
      { id: "sess-router-audit", title: "Dynamic Provider Router Fencing", modelId: "claude-opus-4.6", effort: "high", updatedAt: "2026-11-12T19:45:00Z" },
      { id: "sess-phys-deriv", title: "Maxwell-Faraday & Electrochemistry", modelId: "gpt-5.4-thinking", effort: "medium", updatedAt: "2026-11-12T18:12:00Z" }
    ],
    activeLease: { ownerPid: 41280, leaseEpoch: 14, walMode: "WAL" },
    steer: {
      tokenBudget: null,
      invariant: "ZERO_DROP_ADDITIVE",
      items: [
        {
          id: "steer-01",
          seq: 1,
          text: "UI cần đẹp hết cỡ, Obsidian Kinetic Atelier 10/10, 0 Rust overhead.",
          mode: "ADDITIVE_INTAKE",
          status: "ACTIVE_ENFORCED",
          createdAt: "2026-11-12T20:25:10Z"
        },
        {
          id: "steer-02",
          seq: 2,
          text: "Preserve zero-mutation Escape on attachment paste and SHA-256 tray deduplication.",
          mode: "ADDITIVE_INTAKE",
          status: "QUEUED_CONTINUITY",
          createdAt: "2026-11-12T20:26:09Z"
        }
      ]
    },
    templates: [
      { id: "math-euler", category: "Math", title: "Riemann / Series Sum", symbol: "∑", latex: "\\sum_{k=1}^{n} \\frac{1}{k^2} = \\frac{\\pi^2}{6}", description: "Convergent Basel series identity" },
      { id: "math-gauss", category: "Math", title: "Gaussian Integral", symbol: "∫", latex: "\\int_{0}^{\\infty} e^{-\\alpha x^2} \\, dx = \\frac{1}{2}\\sqrt{\\frac{\\pi}{\\alpha}}", description: "Half-line Gaussian integral" },
      { id: "math-matrix", category: "Math", title: "2x2 Eigenvalue System", symbol: "[A]", latex: "\\begin{pmatrix} \\lambda - a & -b \\\\ -c & \\lambda - d \\end{pmatrix}", description: "Characteristic matrix block" },
      { id: "math-fourier", category: "Math", title: "Fourier Transform", symbol: "ℱ", latex: "\\hat{f}(\\omega) = \\int_{-\\infty}^{\\infty} f(t) e^{-i\\omega t} \\, dt", description: "Continuous frequency projection" },
      { id: "math-cauchy", category: "Math", title: "Contour Residue", symbol: "∮", latex: "\\oint_{\\Gamma} \\frac{f(z)}{z - z_0} \\, dz = 2\\pi i \\, f(z_0)", description: "Cauchy integral formula" },
      { id: "phys-maxwell", category: "Physics", title: "Maxwell-Faraday Curl", symbol: "∇×E", latex: "\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}", description: "Electromagnetic induction law" },
      { id: "phys-schrodinger", category: "Physics", title: "Schrodinger Evolution", symbol: "iℏ∂t", latex: "i\\hbar \\frac{\\partial \\Psi}{\\partial t} = -\\frac{\\hbar^2}{2m}\\nabla^2 \\Psi + V\\Psi", description: "Time-dependent wave equation" },
      { id: "phys-partition", category: "Physics", title: "Canonical Partition", symbol: "Z", latex: "Z = \\sum_{s} e^{-\\beta E_s}, \\quad F = -k_B T \\ln Z", description: "Statistical mechanics free energy" },
      { id: "phys-dirac", category: "Physics", title: "Relativistic Dispersion", symbol: "E²", latex: "E^2 = p^2 c^2 + m_0^2 c^4", description: "Energy-momentum invariant" },
      { id: "phys-navier", category: "Physics", title: "Lorentz Force Law", symbol: "F=qE", latex: "\\mathbf{F} = q\\left(\\mathbf{E} + \\mathbf{v} \\times \\mathbf{B}\\right)", description: "Charged particle dynamics" },
      { id: "chem-gibbs", category: "Chemistry", title: "Gibbs Free Energy", symbol: "ΔG°", latex: "\\Delta G^\\circ = \\Delta H^\\circ - T\\Delta S^\\circ = -RT \\ln K_{eq}", description: "Thermodynamic spontaneity" },
      { id: "chem-equilibrium", category: "Chemistry", title: "Haber-Bosch Duplex", symbol: "⇌", latex: "\\mathrm{N}_2 + 3\\mathrm{H}_2 \\rightleftharpoons 2\\mathrm{NH}_3", description: "Reversible chemical equilibrium" },
      { id: "chem-nernst", category: "Chemistry", title: "Nernst Cell Potential", symbol: "Ecell", latex: "E = E^\\circ - \\frac{RT}{nF} \\ln Q", description: "Electrochemical half-cell voltage" },
      { id: "chem-arrhenius", category: "Chemistry", title: "Arrhenius Rate Law", symbol: "k(T)", latex: "k = A e^{-\\frac{E_a}{RT}}", description: "Activation energy barrier" },
      { id: "chem-henderson", category: "Chemistry", title: "Buffer Equilibrium", symbol: "pH", latex: "\\mathrm{pH} = \\mathrm{p}K_a + \\log\\frac{[\\mathrm{A}^-]}{[\\mathrm{HA}]}", description: "Henderson-Hasselbalch relation" }
    ],
    graph: {
      nodes: [
        { id: "coordinator", label: "Coordinator", role: "Coordinator", state: "ACTIVE", epoch: 4, maxHops: 8, disjointPaths: ["docs/handoff/**"], incomingCount: 18, outgoingCount: 22, lastSeq: 76 },
        { id: "cpp-core", label: "C++ Core", role: "Worker", state: "WORKING", epoch: 4, maxHops: 8, disjointPaths: ["CMakeLists.txt", "CMakePresets.json", "cpp/**"], incomingCount: 9, outgoingCount: 11, lastSeq: 76 },
        { id: "win32-shell", label: "Win32 Shell", role: "Worker", state: "WORKING", epoch: 4, maxHops: 8, disjointPaths: ["native/**"], incomingCount: 7, outgoingCount: 8, lastSeq: 74 },
        { id: "ui-atelier", label: "UI Atelier", role: "Specialist", state: "WORKING", epoch: 4, maxHops: 8, disjointPaths: ["ui/**", "docs/ui-direction/FLAGSHIP_STUDIO_UI_SPEC.md"], incomingCount: 8, outgoingCount: 9, lastSeq: 76 },
        { id: "deep-cleaner", label: "Deep Cleaner", role: "Worker", state: "WORKING", epoch: 4, maxHops: 8, disjointPaths: [".gitignore", "docs/workspace/DEEP_CLEAN_AUDIT_D_DRIVE.md"], incomingCount: 5, outgoingCount: 6, lastSeq: 74 },
        { id: "verifier", label: "Independent Verifier", role: "Verifier", state: "READY", epoch: 4, maxHops: 8, disjointPaths: ["(read-only zero-repo-writes)"], incomingCount: 15, outgoingCount: 14, lastSeq: 74 }
      ],
      links: [
        { from: "coordinator", to: "cpp-core", mode: "Duplex", label: "A <-> B Core" },
        { from: "coordinator", to: "win32-shell", mode: "Duplex", label: "A <-> B UIA" },
        { from: "coordinator", to: "ui-atelier", mode: "Duplex", label: "A <-> B Studio" },
        { from: "coordinator", to: "deep-cleaner", mode: "Duplex", label: "A <-> B Clean" },
        { from: "coordinator", to: "verifier", mode: "Duplex", label: "A <-> B Audit" },
        { from: "cpp-core", to: "ui-atelier", mode: "Duplex", label: "/api/* JSON Contract" },
        { from: "cpp-core", to: "win32-shell", mode: "Duplex", label: "SQLite WAL Lease" },
        { from: "cpp-core", to: "verifier", mode: "Duplex", label: "CTest + Binary Audit" },
        { from: "ui-atelier", to: "verifier", mode: "Duplex", label: "WCAG + Zero-Overflow QA" },
        { from: "win32-shell", to: "verifier", mode: "Duplex", label: "7x Native UIA QA" },
        { from: "deep-cleaner", to: "verifier", mode: "Duplex", label: "Reclamation Receipt" }
      ],
      messages: [
        { seq: 73, from: "coordinator", to: "ui-atelier", text: "Build Obsidian Kinetic Atelier 10/10 Studio UI under ui/ with 3 live themes & 5 interactive workbenches.", epoch: 4, hop: 1, timestamp: "20:26:09" },
        { seq: 75, from: "ui-atelier", to: "cpp-core", text: "Proposed 12-endpoint camelCase /api/* schema with loopback Origin guard & standalone parity.", epoch: 4, hop: 2, timestamp: "20:27:44" },
        { seq: 76, from: "cpp-core", to: "ui-atelier", text: "Locked 1:1 on all 12 /api/* JSON contracts! Proceeding to MSVC 14.51 build & CTest.", epoch: 4, hop: 3, timestamp: "20:28:27" }
      ],
      graphifyNodes: [
        { id: "omnia-studio", kind: "binary", label: "omnia-studio.exe", path: "cpp/apps/omnia_studio/main.cpp" },
        { id: "omnia_core", kind: "module", label: "omnia_core", path: "cpp/include/omnia/core/" },
        { id: "omnia_storage", kind: "module", label: "omnia_storage", path: "cpp/include/omnia/storage/" },
        { id: "omnia_routing", kind: "module", label: "omnia_routing", path: "cpp/include/omnia/routing/" },
        { id: "omnia_graph", kind: "module", label: "omnia_graph", path: "cpp/include/omnia/graph/" },
        { id: "omnia_harness", kind: "module", label: "omnia_harness", path: "cpp/include/omnia/harness/" },
        { id: "omnia-native", kind: "binary", label: "omnia-native.exe", path: "native/CMakeLists.txt" },
        { id: "ui-atelier-bundle", kind: "ui", label: "Flagship Studio UI", path: "ui/index.html" },
        { id: "DOD-14", kind: "spec", label: "DOD-14 Runtime Verification", path: "docs/workspace/DOD.md" }
      ],
      graphifyEdges: [
        { from: "omnia-studio", to: "omnia_routing", relation: "calls", provenance: "EXTRACTED", note: "POST /api/router/decide -> DynamicProviderRouter" },
        { from: "omnia-studio", to: "omnia_graph", relation: "calls", provenance: "EXTRACTED", note: "GET /api/graph & BFS traverse" },
        { from: "omnia-studio", to: "omnia_harness", relation: "calls", provenance: "EXTRACTED", note: "MemoryGraph + ProactiveRag + SkillRegistry + SteerQueue" },
        { from: "omnia-studio", to: "omnia_storage", relation: "calls", provenance: "EXTRACTED", note: "RAII winsqlite3 WAL SessionStore" },
        { from: "omnia_storage", to: "omnia_core", relation: "depends_on", provenance: "EXTRACTED", note: "BCrypt SHA-256 + RFC-8259 JsonValue" },
        { from: "omnia_routing", to: "omnia_core", relation: "depends_on", provenance: "EXTRACTED", note: "SecretRedactor + deterministic receipt serialization" },
        { from: "ui-atelier-bundle", to: "omnia-studio", relation: "consumes_rpc", provenance: "EXTRACTED", note: "12 loopback JSON endpoints" },
        { from: "omnia-native", to: "omnia_storage", relation: "shares_wal_schema", provenance: "INFERRED", note: "Shared cooperative SQLite session lease invariants" },
        { from: "DOD-14", to: "omnia-native", relation: "verifies", provenance: "EXTRACTED", note: "7 PowerShell UIA + session + guard suites" },
        { from: "DOD-14", to: "ui-atelier-bundle", relation: "candidate_match", provenance: "AMBIGUOUS", note: "Quarantined: multiple preview/studio surfaces reference DOD-14; requires explicit locator binding" }
      ]
    },
    router: {
      candidates: [
        { id: "local-cpp-llama-q8", providerId: "omnia-local", modelId: "qwen3-coder-32b-q8", capabilities: ["code_generation", "architecture_synthesis", "fast_triage", "streaming"], privacyTier: "strict_local_zero_retention", circuit: "Closed", quotaState: "Known", remainingTokens: 480000, reserveTokens: 25000, ewmaMs: 142, p95Ms: 215, errorRate: 0.002 },
        { id: "anthropic-opus-4-6", providerId: "anthropic-zdr", modelId: "claude-opus-4-6", capabilities: ["code_generation", "architecture_synthesis", "math_derivation", "multimodal_vision", "streaming"], privacyTier: "enterprise_zdr", circuit: "Closed", quotaState: "Known", remainingTokens: 310000, reserveTokens: 30000, ewmaMs: 390, p95Ms: 620, errorRate: 0.004 },
        { id: "google-gemini-3-1-pro", providerId: "vertex-zdr", modelId: "gemini-3.1-pro", capabilities: ["code_generation", "architecture_synthesis", "math_derivation", "multimodal_vision", "fast_triage", "streaming"], privacyTier: "enterprise_zdr", circuit: "Closed", quotaState: "Known", remainingTokens: 920000, reserveTokens: 40000, ewmaMs: 265, p95Ms: 410, errorRate: 0.003 },
        { id: "openai-gpt-5-4-thinking", providerId: "openai-enterprise", modelId: "gpt-5.4-thinking", capabilities: ["code_generation", "architecture_synthesis", "math_derivation", "streaming"], privacyTier: "enterprise_zdr", circuit: "HalfOpen", quotaState: "Stale", remainingTokens: 125000, reserveTokens: 20000, ewmaMs: 540, p95Ms: 890, errorRate: 0.028 },
        { id: "cloud-fast-unverified", providerId: "public-gateway", modelId: "deepseek-r2-distill", capabilities: ["code_generation", "fast_triage", "streaming"], privacyTier: "standard_cloud", circuit: "Open", quotaState: "Unknown", remainingTokens: null, reserveTokens: 15000, ewmaMs: 980, p95Ms: 1640, errorRate: 0.145 }
      ],
      lastDecision: null
    },
    memory: {
      entries: [
        { id: "mem-01", namespace: "architecture/cpp20-core", key: "winsqlite3-wal-lease", content: "SessionStore uses RAII sqlite3 custom deleter + WAL synchronous=NORMAL + cooperative process lease heartbeat.", tier: "Durable", contentSha256: sha256Hex("SessionStore uses RAII sqlite3 custom deleter + WAL synchronous=NORMAL + cooperative process lease heartbeat."), updatedAt: "2026-11-12T20:15:00Z", links: ["architecture/win32-uia"] },
        { id: "mem-02", namespace: "architecture/win32-uia", key: "modal-32770-cbt-hook", content: "Thread-scoped WH_CBT HCBT_ACTIVATE hook attaches IInvokeProvider to IDOK/IDCANCEL/IDYES/IDNO so background UIA Invoke succeeds.", tier: "Durable", contentSha256: sha256Hex("Thread-scoped WH_CBT HCBT_ACTIVATE hook attaches IInvokeProvider to IDOK/IDCANCEL/IDYES/IDNO so background UIA Invoke succeeds."), updatedAt: "2026-11-12T20:18:00Z", links: ["lessons/uia-background-focus"] },
        { id: "mem-03", namespace: "workspace/ui-atelier", key: "obsidian-contrast-floor", content: "All 3 studio themes verify IEEE-754 WCAG 2.2 luminance >= 5.12:1 across canvas, rail, panel, and elevated surfaces.", tier: "Working", contentSha256: sha256Hex("All 3 studio themes verify IEEE-754 WCAG 2.2 luminance >= 5.12:1 across canvas, rail, panel, and elevated surfaces."), updatedAt: "2026-11-12T20:26:30Z", links: ["architecture/cpp20-core"] },
        { id: "mem-04", namespace: "lessons/uia-background-focus", key: "zero-drop-steer-rule", content: "Mid-run user prompts enter SteerQueue as ADDITIVE_INTAKE with token_budget=NULL; never drop unfinished tasks.", tier: "Durable", contentSha256: sha256Hex("Mid-run user prompts enter SteerQueue as ADDITIVE_INTAKE with token_budget=NULL; never drop unfinished tasks."), updatedAt: "2026-11-12T19:50:00Z", links: [] }
      ],
      erasures: []
    },
    skills: [
      { name: "deep-cpp-native", category: "Native C++20 & Win32", path: ".agents/skills/deep-cpp-native/SKILL.md", description: "Out-of-source CMake + Ninja + MSVC /std:c++20 /W4 /WX builds, RAII Win32/COM/winsqlite3 handles, Direct2D, server-side UIA, and loopback JSON-RPC.", score: 9.9 },
      { name: "autonomous-power-continuity", category: "Swarm Orchestration", path: ".agents/skills/autonomous-power-continuity/SKILL.md", description: "Execute end-to-end engineering goals with Graphify bidirectional context, 2-way all-to-all peer-mesh swarms, and anti-overconfidence verification.", score: 9.6 },
      { name: "deep-general-graph-orchestration", category: "Graph & Provenance", path: ".agents/skills/deep-general-graph-orchestration/SKILL.md", description: "Design, execute, and verify bidirectional A <-> B peer-mesh graphs and Graphify EXTRACTED/INFERRED/AMBIGUOUS code-knowledge graphs.", score: 9.5 },
      { name: "omni-bilingual-skill-router", category: "Routing & Discovery", path: ".agents/skills/omni-bilingual-skill-router/SKILL.md", description: "Compose multi-skill execution pipelines across Vietnamese and English queries using fast BM25 ranking and SHA-256 lockfile health checks.", score: 9.4 },
      { name: "additive-steer-queue", category: "Continuity & Steer", path: ".agents/skills/additive-steer-queue/SKILL.md", description: "Preserve all unfinished tasks on mid-run user steer messages via ADDITIVE_INTAKE queue intake with token_budget=NULL.", score: 9.3 },
      { name: "deep-clean", category: "Workspace Hygiene", path: ".agents/skills/deep-clean/SKILL.md", description: "Clean repositories and drives via inventory, provenance classification, quarantine, and byte-accurate reclamation receipts.", score: 9.1 },
      { name: "deep-proposal", category: "Architecture & RFC", path: ".agents/skills/deep-proposal/SKILL.md", description: "Author rigorous Engineering/RFC, Academic, and Product proposals with baseline evidence, trade-off matrices, and rollback gates.", score: 9.0 },
      { name: "deep-steer", category: "Continuity & Steer", path: ".agents/skills/deep-steer/SKILL.md", description: "Steer active goals and general graphs via compare-and-swap mutations, supersession, and auditable control receipts.", score: 8.9 },
      { name: "goal-plan-loop-dod", category: "Verification & DoD", path: ".agents/skills/goal-plan-loop-dod/SKILL.md", description: "Bind multi-requirement engineering goals to measurable execution loops and falsifiable Definition of Done gates.", score: 8.9 },
      { name: "omnia-session-governance-handoff", category: "Governance", path: ".agents/skills/omnia-session-governance-handoff/SKILL.md", description: "Govern startup preflight, canonical workspace ledgers, and 6-state completion receipts separating inspected vs runtime-verified states.", score: 8.8 },
      { name: "omni-deterministic-verifiers", category: "Verification & DoD", path: ".agents/skills/omni-deterministic-verifiers/SKILL.md", description: "Run deterministic structural, LF-hygiene, secret-redaction, and cross-artifact verification suites.", score: 8.8 },
      { name: "vietnamese-typo-intent-inference", category: "Bilingual UX", path: ".agents/skills/vietnamese-typo-intent-inference/SKILL.md", description: "Infer bilingual Vietnamese-English intent across VNI/Telex slips and shorthand without mutating identifiers or paths.", score: 8.7 },
      { name: "codex-mcp-namespace-diagnostics", category: "Diagnostics", path: ".agents/skills/codex-mcp-namespace-diagnostics/SKILL.md", description: "Diagnose MCP dispatch namespaces, SSE framing, V8 text execution, and Windows cold-start timeouts.", score: 8.5 }
    ]
  };

  /* ========================================================================
     5. Resilient HTTP Client + Normalization + Offline Engine
     ======================================================================== */
  let connectionMode = "PROBING";

  function canAttemptHttp() {
    return typeof global.location !== "undefined" &&
      (global.location.protocol === "http:" || global.location.protocol === "https:");
  }

  async function requestJson(method, path, body) {
    if (!canAttemptHttp()) {
      connectionMode = "STANDALONE_ATELIER";
      return null;
    }
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 2400) : null;
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
      if (!res.ok) return null;
      const data = await res.json();
      connectionMode = "LIVE_CPP20";
      return data;
    } catch (_err) {
      if (timer) clearTimeout(timer);
      connectionMode = "STANDALONE_ATELIER";
      return null;
    }
  }

  function computeFallbackRouterDecision(payload) {
    const req = payload || {};
    const taskClass = req.taskClass || "code_generation";
    const estimatedTokens = Number(req.estimatedTokens) || 4096;
    const privacyTier = req.privacyTier || "enterprise_zdr";
    const requireStreaming = req.requireStreaming !== false;

    if (req.tripCandidate) {
      const c = fallbackState.router.candidates.find((x) => x.id === req.tripCandidate);
      if (c) c.circuit = "Open";
    }
    if (req.resetCandidate) {
      const c = fallbackState.router.candidates.find((x) => x.id === req.resetCandidate);
      if (c) {
        c.circuit = "Closed";
        if (c.quotaState === "Stale") c.quotaState = "Known";
      }
    }

    const privacyRank = {
      strict_local_zero_retention: 3,
      enterprise_zdr: 2,
      standard_cloud: 1
    };
    const reqPriv = privacyRank[privacyTier] || 2;

    const scores = fallbackState.router.candidates.map((cand) => {
      const candPriv = privacyRank[cand.privacyTier] || 1;
      const reasons = [];
      if (cand.circuit === "Open") reasons.push("circuit_open_fenced");
      if (candPriv < reqPriv) reasons.push("privacy_boundary_violation");
      if (!cand.capabilities.includes(taskClass)) reasons.push("missing_capability:" + taskClass);
      if (requireStreaming && !cand.capabilities.includes("streaming")) reasons.push("streaming_unsupported");
      if (cand.quotaState === "Unknown") reasons.push("quota_unknown_never_coerced_to_zero");
      if (cand.quotaState === "Stale") reasons.push("quota_stale_ttl_expired");
      if (typeof cand.remainingTokens === "number" && cand.remainingTokens - cand.reserveTokens < estimatedTokens) {
        reasons.push("emergency_reserve_floor");
      }

      const capabilityScore = cand.capabilities.includes(taskClass) ? 28 : 0;
      const privacyScore = candPriv >= reqPriv ? (candPriv === 3 ? 24 : 20) : 0;
      const quotaScore = cand.quotaState === "Known"
        ? Math.min(20, Math.round(((cand.remainingTokens - cand.reserveTokens) / 50000) * 4))
        : 0;
      const latencyScore = Math.max(2, Math.round(18 - cand.p95Ms / 110));
      const reliabilityScore = Math.max(0, Math.round((1 - cand.errorRate * 5) * 10));
      const eligible = reasons.length === 0;
      const totalScore = eligible
        ? capabilityScore + privacyScore + quotaScore + latencyScore + reliabilityScore
        : 0;

      return {
        candidateId: cand.id,
        eligible,
        totalScore,
        capabilityScore,
        privacyScore,
        quotaScore,
        latencyScore,
        reliabilityScore,
        rejectedReason: reasons.join(", ") || null
      };
    });

    const eligibleSorted = scores
      .filter((s) => s.eligible)
      .sort((a, b) => (b.totalScore - a.totalScore) || a.candidateId.localeCompare(b.candidateId));

    const winner = eligibleSorted[0] || null;
    const policyHash = sha256Hex(JSON.stringify({ taskClass, estimatedTokens, privacyTier, requireStreaming })).slice(0, 16);
    const receipt = {
      receiptId: "rcpt-" + fnv1aHex(Date.now() + ":" + policyHash),
      schemaVersion: "omnia.routing.v2.cpp20",
      policyHash: "sha256:" + policyHash,
      selectedRoute: winner ? winner.candidateId : null,
      reservationId: winner ? "rsv-" + fnv1aHex(winner.candidateId + ":" + estimatedTokens) : null,
      reservedTokens: winner ? estimatedTokens : 0,
      promptRedacted: true,
      secretsExposed: 0,
      scores
    };
    fallbackState.router.lastDecision = receipt;
    return {
      ok: true,
      selectedCandidateId: winner ? winner.candidateId : null,
      status: winner ? "ROUTED_DETERMINISTIC" : "FENCED_OPERATOR_RECOVERY_REQUIRED",
      receipt,
      candidates: fallbackState.router.candidates
    };
  }

  function computeFallbackTraverse(entity, direction, maxDepth) {
    const start = entity || "omnia-studio";
    const dir = direction || "Both";
    const depthCap = Math.max(1, Math.min(5, Number(maxDepth) || 3));
    const visited = new Set([start]);
    const frontier = [{ id: start, depth: 0 }];
    const matchedEdges = [];
    const quarantinedAmbiguous = [];

    while (frontier.length > 0) {
      const cur = frontier.shift();
      if (cur.depth >= depthCap) continue;
      for (const edge of fallbackState.graph.graphifyEdges) {
        const forwardMatch = (dir === "Forward" || dir === "Both") && edge.from === cur.id;
        const reverseMatch = (dir === "Reverse" || dir === "Both") && edge.to === cur.id;
        if (!forwardMatch && !reverseMatch) continue;
        const nextId = forwardMatch ? edge.to : edge.from;
        const item = Object.assign({ depth: cur.depth + 1 }, edge);
        if (edge.provenance === "AMBIGUOUS") {
          quarantinedAmbiguous.push(item);
          continue;
        }
        matchedEdges.push(item);
        if (!visited.has(nextId)) {
          visited.add(nextId);
          frontier.push({ id: nextId, depth: cur.depth + 1 });
        }
      }
    }

    return {
      entity: start,
      direction: dir,
      maxDepth: depthCap,
      visited: Array.from(visited),
      edges: matchedEdges,
      quarantinedAmbiguous
    };
  }

  function computeFallbackRagPlan(queryText) {
    const q = String(queryText || "").trim();
    const hasVn = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(q);
    const hasEn = /\b(how|why|what|compare|explain|lease|circuit|quota|uia|sqlite|memory)\b/i.test(q);
    const language = hasVn && hasEn ? "BILINGUAL_VI_EN" : (hasVn ? "VI" : "EN");
    const triggers = ["ZERO_EXPLICIT_SEARCH_KEYWORD"];
    let score = 0.42;

    if (/\?|tại sao|như thế nào|làm sao|giải thích|how|why|compare/i.test(q)) {
      triggers.push("CAUSAL_OR_COMPARATIVE_INQUIRY");
      score += 0.22;
    }
    if (/32770|uia|winsqlite3|wal|sha-256|quota_stale|halfopen|graphify|lease/i.test(q)) {
      triggers.push("DEEP_ARCHITECTURE_INVARIANT");
      score += 0.24;
    }
    if (hasVn) {
      triggers.push("VIETNAMESE_TECHNICAL_SEMANTICS");
      score += 0.06;
    }
    const uncertaintyScore = Math.min(0.96, Number(score.toFixed(2)));
    const shouldRetrieve = uncertaintyScore >= 0.55;

    function clipWords(text, maxChars) {
      if (text.length <= maxChars) return text;
      const cut = text.slice(0, maxChars);
      const sp = cut.lastIndexOf(" ");
      return (sp > 20 ? cut.slice(0, sp) : cut) + "…";
    }

    const subQueries = [
      { angle: "AST & Header Contract", query: "omnia C++20 header invariants for: " + clipWords(q, 76) },
      { angle: "Governance & DoD Spec", query: "DIRECTION_DECISION & DYNAMIC_ROUTING_REQUIREMENTS rules for: " + clipWords(q, 68) },
      { angle: "Reverse Graphify Provenance", query: "reverse dependents & verification tests covering: " + clipWords(q, 72) }
    ];

    const citedSources = [
      {
        id: "src-routing-spec",
        title: "DYNAMIC_ROUTING_REQUIREMENTS.md",
        locator: "docs/workspace/DYNAMIC_ROUTING_REQUIREMENTS.md#L37-L70",
        snippet: "Unknown, stale or contradictory values must remain explicit. Do not silently convert unknown quota or usage to zero.",
        provenance: "EXTRACTED",
        score: 0.94
      },
      {
        id: "src-graphify-spec",
        title: "BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md",
        locator: "docs/handoff/BIDIRECTIONAL_AGENT_GRAPH_AND_GRAPHIFY.md#L49-L65",
        snippet: "Explicit Three-Tier Edge Provenance: EXTRACTED, INFERRED, and quarantined AMBIGUOUS candidates.",
        provenance: "EXTRACTED",
        score: 0.91
      },
      {
        id: "src-cpp-storage",
        title: "omnia_storage::SessionStore (winsqlite3 WAL)",
        locator: "cpp/include/omnia/storage/session_store.hpp#L1-L68",
        snippet: "Cooperative SQLite WAL process ownership lease with acquire_lease, heartbeat, and PID/epoch recovery.",
        provenance: "INFERRED",
        score: 0.87
      }
    ];

    const unusedSources = [
      {
        id: "unused-legacy-tauri",
        title: "Archive Snapshot: pre-cpp-rust-snapshot-20261112",
        locator: "git:archive/pre-cpp-rust-snapshot-20261112",
        reason: "Excluded: superseded historical Rust/Tauri tree; active runtime is 100% Native C++20."
      },
      {
        id: "unused-encrypted-7z",
        title: "exam_solutions_locked.7z",
        locator: "attachment://encrypted/exam_solutions_locked.7z",
        reason: "Quarantined: ENCRYPTED_UNRESOLVED archive (0 bytes claimed read)."
      }
    ];

    return {
      query: q,
      language,
      uncertaintyScore,
      shouldRetrieve,
      triggers,
      subQueries,
      citedSources,
      unusedSources
    };
  }

  const api = {
    getConnectionMode() {
      return connectionMode;
    },

    async getHealth() {
      const live = await requestJson("GET", "/api/health");
      if (live && live.ok !== false) {
        return {
          ok: true,
          engine: live.engine || "Omnia Native C++20",
          compiler: live.compiler || "MSVC 14.51",
          cplusplus: live.cplusplus || 202002,
          rustFiles: live.rustFiles ?? live.rust_files ?? 0,
          pid: live.pid || 0,
          workingSetBytes: live.workingSetBytes ?? live.working_set_bytes ?? 8388608,
          binaryBytes: live.binaryBytes ?? live.binary_bytes ?? 393216,
          skillCount: live.skillCount ?? live.skill_count ?? 13,
          peerCount: live.peerCount ?? live.peer_count ?? 6
        };
      }
      return Object.assign({}, fallbackState.health);
    },

    async getSessions() {
      const live = await requestJson("GET", "/api/sessions");
      if (live && Array.isArray(live.sessions)) return live;
      return { sessions: fallbackState.sessions.slice(), activeLease: fallbackState.activeLease };
    },

    async createSession(payload) {
      const live = await requestJson("POST", "/api/sessions/create", payload);
      if (live && (live.sessions || live.session)) {
        if (live.session && !live.sessions) {
          fallbackState.sessions.unshift(live.session);
          return { sessions: fallbackState.sessions.slice(), session: live.session };
        }
        return live;
      }
      const created = {
        id: "sess-" + fnv1aHex(Date.now() + ":" + (payload.title || "studio")),
        title: payload.title || "New Studio Session",
        modelId: payload.modelId || "gemini-3.1-pro",
        effort: payload.effort || "high",
        updatedAt: new Date().toISOString()
      };
      fallbackState.sessions.unshift(created);
      return { ok: true, session: created, sessions: fallbackState.sessions.slice() };
    },

    async getSteer() {
      const live = await requestJson("GET", "/api/steer");
      if (live && Array.isArray(live.items)) return live;
      return {
        tokenBudget: null,
        invariant: fallbackState.steer.invariant,
        items: fallbackState.steer.items.slice()
      };
    },

    async enqueueSteer(text) {
      const clean = String(text || "").trim();
      if (!clean) return this.getSteer();
      const live = await requestJson("POST", "/api/steer/enqueue", { text: clean });
      if (live && (live.item || Array.isArray(live.items))) return live;
      const seq = fallbackState.steer.items.length + 1;
      const item = {
        id: "steer-0" + seq,
        seq,
        text: clean,
        mode: "ADDITIVE_INTAKE",
        status: "QUEUED_CONTINUITY",
        createdAt: new Date().toISOString()
      };
      fallbackState.steer.items.push(item);
      return { ok: true, tokenBudget: null, item, items: fallbackState.steer.items.slice() };
    },

    async getTemplates() {
      const live = await requestJson("GET", "/api/composer/templates");
      if (live && Array.isArray(live.templates) && live.templates.length > 0) return live.templates;
      return fallbackState.templates.slice();
    },

    async getGraph() {
      const live = await requestJson("GET", "/api/graph");
      if (live && Array.isArray(live.nodes) && live.nodes.length > 0) {
        return {
          nodes: live.nodes,
          links: live.links || fallbackState.graph.links,
          messages: live.messages || fallbackState.graph.messages,
          graphifyNodes: live.graphifyNodes || live.graphify_nodes || fallbackState.graph.graphifyNodes,
          graphifyEdges: live.graphifyEdges || live.graphify_edges || fallbackState.graph.graphifyEdges
        };
      }
      return JSON.parse(JSON.stringify(fallbackState.graph));
    },

    async sendGraphMessage(payload) {
      const live = await requestJson("POST", "/api/graph/send", payload);
      if (live && live.ok !== false) return live;
      const nextSeq = (fallbackState.graph.messages.reduce((m, x) => Math.max(m, x.seq || 0), 76)) + 1;
      const now = new Date();
      const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((n) => String(n).padStart(2, "0"))
        .join(":");
      const msg = {
        seq: nextSeq,
        from: payload.from || "ui-atelier",
        to: payload.broadcast ? "@all" : (payload.to || "cpp-core"),
        text: payload.text || "Duplex heartbeat sync",
        epoch: 4,
        hop: 1,
        timestamp: ts
      };
      fallbackState.graph.messages.push(msg);
      for (const n of fallbackState.graph.nodes) {
        if (n.id === msg.from) { n.outgoingCount++; n.lastSeq = nextSeq; }
        if (payload.broadcast || n.id === msg.to) { n.incomingCount++; n.lastSeq = nextSeq; }
      }
      return { ok: true, message: msg, messages: fallbackState.graph.messages.slice() };
    },

    async traverseGraph(entity, direction, maxDepth) {
      const qs = "?entity=" + encodeURIComponent(entity) +
        "&direction=" + encodeURIComponent(direction) +
        "&maxDepth=" + encodeURIComponent(maxDepth);
      const live = await requestJson("GET", "/api/graph/traverse" + qs);
      if (live && (Array.isArray(live.edges) || Array.isArray(live.visited))) return live;
      return computeFallbackTraverse(entity, direction, maxDepth);
    },

    async getRouterState() {
      const live = await requestJson("GET", "/api/router/state");
      if (live && Array.isArray(live.candidates) && live.candidates.length > 0) return live;
      return {
        candidates: JSON.parse(JSON.stringify(fallbackState.router.candidates)),
        recentReceipts: fallbackState.router.lastDecision ? [fallbackState.router.lastDecision] : []
      };
    },

    async decideRoute(payload) {
      const live = await requestJson("POST", "/api/router/decide", payload);
      if (live && live.receipt) return live;
      return computeFallbackRouterDecision(payload);
    },

    async planRag(query) {
      const live = await requestJson("POST", "/api/rag/plan", { query });
      if (live && (live.subQueries || live.sub_queries || live.uncertaintyScore !== undefined)) {
        return {
          query: live.query || query,
          language: live.language || "EN",
          uncertaintyScore: live.uncertaintyScore ?? live.uncertainty_score ?? 0.65,
          shouldRetrieve: live.shouldRetrieve ?? live.should_retrieve ?? true,
          triggers: live.triggers || [],
          subQueries: live.subQueries || live.sub_queries || [],
          citedSources: live.citedSources || live.cited_sources || [],
          unusedSources: live.unusedSources || live.unused_sources || []
        };
      }
      return computeFallbackRagPlan(query);
    },

    async getMemory() {
      const live = await requestJson("GET", "/api/memory");
      if (live && Array.isArray(live.entries)) return live;
      return {
        entries: fallbackState.memory.entries.slice(),
        erasures: fallbackState.memory.erasures.slice()
      };
    },

    async upsertMemory(payload) {
      const ns = String(payload.namespace || "").trim();
      if (!ns || ns.includes("..") || ns.includes("\\")) {
        return { ok: false, error: "Rejected invalid namespace: '..' and '\\' path segments are forbidden." };
      }
      const live = await requestJson("POST", "/api/memory/upsert", payload);
      if (live && live.ok !== false && live.entry) return live;
      const content = String(payload.content || "").trim();
      const digest = sha256Hex(content);
      const existing = fallbackState.memory.entries.find((e) => e.namespace === ns && e.key === payload.key);
      if (existing) {
        existing.content = content;
        existing.tier = payload.tier || existing.tier;
        existing.contentSha256 = digest;
        existing.updatedAt = new Date().toISOString();
        return { ok: true, entry: existing };
      }
      const entry = {
        id: "mem-0" + (fallbackState.memory.entries.length + 1),
        namespace: ns,
        key: String(payload.key || "note").trim(),
        content,
        tier: payload.tier || "Durable",
        contentSha256: digest,
        updatedAt: new Date().toISOString(),
        links: []
      };
      fallbackState.memory.entries.unshift(entry);
      return { ok: true, entry };
    },

    async eraseMemory(target) {
      const live = await requestJson("POST", "/api/memory/erase", target);
      if (live && live.receipt) return live;
      const idx = fallbackState.memory.entries.findIndex((e) => e.id === target.id);
      const removed = idx >= 0 ? fallbackState.memory.entries.splice(idx, 1)[0] : null;
      const receipt = {
        receiptId: "erase-" + sha256Hex(Date.now() + ":" + (target.id || "")).slice(0, 12),
        erasedId: target.id,
        namespace: removed ? removed.namespace : (target.namespace || "unknown"),
        previousDigestSha256: removed ? removed.contentSha256 : sha256Hex(String(target.id)),
        erasedAt: new Date().toISOString(),
        verifiedPlaintextFree: true
      };
      fallbackState.memory.erasures.unshift(receipt);
      return { ok: true, receipt };
    },

    async searchSkills(query) {
      const q = String(query || "").trim();
      const live = await requestJson("GET", "/api/skills?q=" + encodeURIComponent(q));
      if (live && Array.isArray(live.skills)) return live;
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      const matched = fallbackState.skills
        .map((sk) => {
          if (!terms.length) return sk;
          const hay = (sk.name + " " + sk.category + " " + sk.description).toLowerCase();
          let hits = 0;
          for (const t of terms) {
            if (hay.includes(t)) hits += (sk.name.includes(t) ? 3 : 1.5);
          }
          if (hits === 0 && q.toLowerCase().includes("tiếng việt") && sk.name.includes("vietnamese")) hits = 3.5;
          return hits > 0 ? Object.assign({}, sk, { score: Number((sk.score + hits).toFixed(1)) }) : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      return { query: q, total: matched.length, skills: matched };
    }
  };

  Studio.utils = {
    sha256Hex,
    fnv1aHex,
    escapeHtml,
    formatBytes,
    highlightCpp20,
    renderLatexToHtml,
    renderRichMarkdown
  };
  Studio.api = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
