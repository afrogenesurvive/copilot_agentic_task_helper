/**
 * renderer/markdown.js — tiny, dependency-free Markdown → HTML renderer for the
 * About → Guide docs viewer.
 *
 * Security model: input is HTML-escaped FIRST, then we re-apply only a small set
 * of Markdown constructs (headings, paragraphs, lists, fenced code, inline code,
 * bold/italic, blockquotes, tables, horizontal rules, external links). Because we
 * escape before injecting our own tags, user/doc content can never introduce raw
 * HTML or event handlers. External http(s)/mailto links get `data-ext="1"` so the
 * renderer can route them through api.openExternal (the page CSP forbids nav).
 *
 * Loaded via <script src="markdown.js"></script> (satisfies script-src 'self').
 * Exposes window.renderMarkdown(md).
 */
(function () {
  "use strict";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Inline formatting. `s` has ALREADY been HTML-escaped.
  function inline(s) {
    s = String(s);
    // Images: keep only the alt text (no local assets in this viewer).
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt) => alt || "");
    // Inline code first (its contents stay escaped and unformatted).
    s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    // Bold, then italic (bold must win over single-asterisk emphasis).
    s = s.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
    s = s.replace(/__([^_]+)__/g, (_m, c) => `<strong>${c}</strong>`);
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, pre, c) => `${pre}<em>${c}</em>`);
    s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, (_m, pre, c) => `${pre}<em>${c}</em>`);
    // External links → routed through the host's openExternal.
    s = s.replace(
      /\[([^\]]+)\]\(((?:https?|mailto):[^)\s]+)\)/g,
      (_m, label, url) => `<a href="${url}" data-ext="1">${label}</a>`,
    );
    // Any remaining markdown links (relative/internal) → render as plain label.
    s = s.replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_m, label) => label);
    return s;
  }

  function renderMarkdown(md) {
    const src = String(md == null ? "" : md).replace(/\r\n?/g, "\n");
    const lines = src.split("\n");
    const out = [];
    let para = [];

    const flushPara = () => {
      if (!para.length) return;
      out.push(`<p>${inline(escapeHtml(para.join(" ").trim()))}</p>`);
      para = [];
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();

      // Fenced code block.
      const fence = t.match(/^```(.*)$/);
      if (fence) {
        flushPara();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        out.push(`<pre class="code-block"><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
        continue;
      }

      if (t === "") {
        flushPara();
        i++;
        continue;
      }

      // ATX heading.
      const h = t.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        flushPara();
        const lvl = h[1].length;
        const text = inline(escapeHtml(h[2].replace(/\s+#+\s*$/, "").trim()));
        out.push(`<h${lvl}>${text}</h${lvl}>`);
        i++;
        continue;
      }

      // Horizontal rule (---, ***, ___).
      if (/^[-*_]{3,}\s*$/.test(t.replace(/\s/g, ""))) {
        flushPara();
        out.push("<hr/>");
        i++;
        continue;
      }

      // Blockquote.
      if (/^>/.test(line)) {
        flushPara();
        const q = [];
        while (i < lines.length && /^>/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*>\s?/, "").trim());
          i++;
        }
        const paras = q.filter(Boolean).map((x) => `<p>${inline(escapeHtml(x))}</p>`).join("");
        out.push(`<blockquote>${paras}</blockquote>`);
        continue;
      }

      // List (unordered or ordered).
      const listM = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      if (listM) {
        flushPara();
        const ordered = /^\d/.test(listM[2]);
        const tag = ordered ? "ol" : "ul";
        const items = [];
        while (i < lines.length) {
          const m2 = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
          if (!m2) break;
          items.push(`<li>${inline(escapeHtml(m2[3].trim()))}</li>`);
          i++;
        }
        out.push(`<${tag}>${items.join("")}</${tag}>`);
        continue;
      }

      // GFM table (header row + |---| delimiter).
      if (
        t.includes("|") &&
        i + 1 < lines.length &&
        lines[i + 1].includes("-") &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1].trim())
      ) {
        flushPara();
        const splitRow = (r) =>
          r
            .replace(/^\s*\|/, "")
            .replace(/\|\s*$/, "")
            .split("|")
            .map((c) => c.trim());
        const header = splitRow(lines[i]).map((c) => `<th>${inline(escapeHtml(c))}</th>`).join("");
        i += 2; // skip header + delimiter rows
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          const cells = splitRow(lines[i]).map((c) => `<td>${inline(escapeHtml(c))}</td>`).join("");
          rows.push(`<tr>${cells}</tr>`);
          i++;
        }
        out.push(`<table><thead><tr>${header}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
        continue;
      }

      // Plain paragraph line (soft-wrapped later at flush).
      para.push(t);
      i++;
    }
    flushPara();
    return out.join("\n");
  }

  window.renderMarkdown = renderMarkdown;
})();
