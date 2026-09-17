// Minimal, dependency-free Markdown -> HTML renderer for the file viewer's preview. Intentionally
// small (headings, emphasis, code, lists, quotes, rules, links, images, paragraphs) — not a full
// CommonMark implementation. Safety first: everything is HTML-escaped, only a controlled set of tags
// is emitted, and link/image URLs are scheme-checked so `javascript:`/`data:` can't inject script.
// IIFE so nothing leaks to the renderer globals (see i18n.js); dual-exported for require() in tests.
(function () {
  // Private-use sentinels bracket extracted code-span indices. escapeHtml leaves them intact and real
  // content never contains them, so restoring later can't collide with ordinary text (e.g. " 5 ").
  const CS_OPEN = String.fromCharCode(0xE000);
  const CS_CLOSE = String.fromCharCode(0xE001);
  const PLACEHOLDER = new RegExp(CS_OPEN + '(\\d+)' + CS_CLOSE, 'g');
  const HAS_SENTINEL = /[\uE000\uE001]/;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Only http(s) links become real anchors. Anything else (relative, mailto, javascript:, data:, …)
  // renders as plain text — so there's no <a> a middle-click/window-open could follow to bypass the
  // renderer's click handler, which only routes http(s) to the OS browser. URLs here are HTML-escaped.
  // A URL that carries a placeholder (an image/code span matched inside it) is refused outright:
  // placeholders restore to markup, and markup must never land inside an attribute.
  function safeLinkUrl(url) {
    const u = url.trim();
    return /^https?:\/\//i.test(u) && !HAS_SENTINEL.test(u) ? u : null;
  }

  function linkTag(text, url) {
    const safe = safeLinkUrl(url);
    return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
  }

  function imgTag(alt, url) {
    const u = url.trim();
    if (HAS_SENTINEL.test(u)) return alt; // see safeLinkUrl
    // Remote and data:image sources render directly. A local reference (./x.png, ../img/x.png,
    // /abs/x.png — issue #85) can't be an <img> src (the preview has no file origin), so it is
    // emitted WITHOUT a src and the renderer resolves it against the document's directory via
    // resolveLocalImagePath and loads the bytes over IPC. Any other scheme falls back to alt text.
    if (/^(https?:|data:image\/)/i.test(u)) return `<img src="${u}" alt="${alt}">`;
    return isLocalRef(u) ? `<img data-md-src="${u}" alt="${alt}">` : alt;
  }

  // A reference with no scheme and no host: relative or absolute path within the same filesystem.
  // Anything with a scheme (http:, data:, file:, javascript:, …) or protocol-relative (//host/…)
  // is not local. Windows drive letters never occur in WSL-side Markdown references.
  function isLocalRef(ref) {
    const u = String(ref || '').trim();
    return !!u && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//');
  }

  // Resolve a local image reference against the Markdown file's own directory to an absolute WSL
  // path (POSIX; `docPath` is an absolute /… path). Query strings / fragments are dropped and
  // percent-encoding decoded ("my%20img.png"). `..` never climbs above the root. Returns null for
  // non-local references.
  function resolveLocalImagePath(docPath, ref) {
    if (!isLocalRef(ref)) return null;
    let u = String(ref).trim().replace(/[?#].*$/, '');
    try { u = decodeURIComponent(u); } catch { /* keep the raw text */ }
    if (!u) return null;
    const dir = String(docPath || '').replace(/[^/]*$/, ''); // "/a/b/c.md" -> "/a/b/"
    const joined = u.startsWith('/') ? u : dir + u;
    const out = [];
    for (const part of joined.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return '/' + out.join('/');
  }

  function emphasis(s) {
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/_([^_]+)_/g, '<em>$1</em>');
    return s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  }

  // Inline spans within a single block of text. Code spans are pulled out before escaping so their
  // contents are shown verbatim and never re-interpreted as markup. Finished image / link tags are
  // parked the same way so the emphasis pass can't rewrite a URL (`./my_plot_final.png` would
  // otherwise become `./my<em>plot</em>final.png`); link text still gets emphasis. All parked
  // fragments are restored last.
  function inline(text) {
    const held = [];
    const hold = (html) => { held.push(html); return CS_OPEN + (held.length - 1) + CS_CLOSE; };
    // Held fragments nest (a code span inside link text, an image inside a link), so each restored
    // fragment is itself restored; a fragment can only reference earlier ones, so this terminates.
    const restore = (html) => html.replace(PLACEHOLDER, (_m, i) => restore(held[+i]));
    // Attribute values (alt) must never receive restored markup: restore, then strip our own tags,
    // which leaves only already-escaped text (e.g. the code span's contents).
    const attrText = (v) => restore(v).replace(/<[^>]*>/g, '');
    // The sentinels are private-use codepoints a file could technically contain; drop them from
    // the source so a document can never forge (or loop) a placeholder reference.
    let s = String(text).replace(/[\uE000\uE001]/g, '');
    s = s.replace(/`([^`]+)`/g, (_m, c) => hold(`<code>${escapeHtml(c)}</code>`));
    s = escapeHtml(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => hold(imgTag(attrText(alt), url)));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => hold(linkTag(emphasis(txt), url)));
    s = emphasis(s);
    return restore(s);
  }

  const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;

  // Indentation width of a list line (tab = 4). Depth is relative: any strictly deeper indent than
  // the current level opens a nested list, any shallower one unwinds back to the matching level.
  function listIndent(line) {
    const ws = line.match(/^[ \t]*/)[0];
    let n = 0;
    for (const c of ws) n += c === '\t' ? 4 : 1;
    return n;
  }

  // Consecutive list lines -> (possibly nested) <ul>/<ol>. A marker-type switch at the same level
  // (e.g. "- a" then "1. b") closes the list and starts a new one, per CommonMark.
  function renderListBlock(items) {
    const out = [];
    const stack = []; // open lists, outermost first: { indent, tag }
    for (const it of items) {
      const tag = it.ordered ? 'ol' : 'ul';
      // Shallower than the current level: unwind. A dedent that lands between two open levels
      // ("- a" / "    - b" / "  - c") stops at the nearest shallower one and re-nests below.
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
        out.push(`</li></${stack.pop().tag}>`);
      }
      if (!stack.length || it.indent > stack[stack.length - 1].indent) {
        // First item, or deeper than the current level: nest inside the still-open <li>.
        out.push(`<${tag}>`);
        stack.push({ indent: it.indent, tag });
      } else {
        out.push('</li>');
        if (stack[stack.length - 1].tag !== tag) {
          out.push(`</${stack.pop().tag}>`, `<${tag}>`);
          stack.push({ indent: it.indent, tag });
        }
      }
      out.push(`<li>${inline(it.text)}`);
    }
    while (stack.length) out.push(`</li></${stack.pop().tag}>`);
    return out.join('');
  }

  // --- GFM pipe tables ---
  // Cells of one row: outer pipes stripped, escaped \| kept as a literal pipe (protected with a
  // NUL placeholder through the split — NUL can't survive in real text files).
  function splitTableRow(line) {
    // Escaped backslashes are protected FIRST so \\| reads as a literal backslash followed by
    // a real cell delimiter (GFM), not an escaped pipe. Then \| pipes are protected, then the
    // outer pipes stripped - a row ending in \| with no closing outer pipe keeps its pipe.
    let s = line.trim().replace(/\\\\/g, '\u0001').replace(/\\\|/g, '\u0000');
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.replace(/\u0000/g, '|').replace(/\u0001/g, '\\\\').trim());
  }

  // A pipe that actually delimits cells — an escaped \| in prose must not smell like a table.
  // An even number of backslashes before the pipe (\\| etc.) means the pipe itself is NOT escaped.
  const UNESCAPED_PIPE = /(?<!\\)(?:\\\\)*\|/;

  // The delimiter row under the header (e.g. |---|:--:|). Cell count must match the header's —
  // that's what keeps a lone --- (rule) or a stray pipe in prose from being misread as a table.
  function tableAligns(delimLine, headerCount) {
    if (!delimLine || !UNESCAPED_PIPE.test(delimLine)) return null;
    const cells = splitTableRow(delimLine);
    if (cells.length !== headerCount || !cells.every((c) => /^:?-+:?$/.test(c))) return null;
    return cells.map((c) => {
      const l = c.startsWith(':'); const r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
  }

  // Start of a non-paragraph block (blank, fence, heading, rule, quote, list): ends a table body
  // per GFM ("broken at the first empty line or beginning of another block-level structure") and
  // ends paragraph continuation.
  function isBlockBoundary(l) {
    return /^\s*$/.test(l) || /^(```|~~~)/.test(l) || /^#{1,6}\s+/.test(l) ||
           /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) || /^\s*>/.test(l) || LIST_ITEM.test(l);
  }

  function render(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^(```|~~~)(.*)$/);
      if (fence) {
        const marker = fence[1];
        const lang = fence[2].trim().split(/\s+/)[0];
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith(marker)) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++; // consume the closing fence
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        out.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
        continue;
      }

      if (/^\s*$/.test(line)) { i++; continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push(`<h${h[1].length}>${inline(h[2].replace(/\s+#+\s*$/, '').trim())}</h${h[1].length}>`); i++; continue; }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }

      if (LIST_ITEM.test(line)) {
        const items = [];
        while (i < lines.length && LIST_ITEM.test(lines[i])) {
          items.push({
            indent: listIndent(lines[i]),
            ordered: /^\s*\d+[.)]\s+/.test(lines[i]),
            text: lines[i].replace(LIST_ITEM, '')
          });
          i++;
        }
        out.push(renderListBlock(items));
        continue;
      }

      // GFM table: a header row containing |, then a matching delimiter row, then body rows until
      // a block boundary (a pipe-less prose line is still a single-cell row, per GFM). Body cells
      // are padded/truncated to the header's column count.
      if (UNESCAPED_PIPE.test(line)) {
        const headerCells = splitTableRow(line);
        const aligns = tableAligns(lines[i + 1], headerCells.length);
        if (aligns) {
          i += 2;
          const rows = [];
          while (i < lines.length && !isBlockBoundary(lines[i])) {
            rows.push(splitTableRow(lines[i]));
            i++;
          }
          const attr = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
          const head = headerCells.map((c, k) => `<th${attr(k)}>${inline(c)}</th>`).join('');
          const body = rows.map((r) =>
            `<tr>${headerCells.map((_c, k) => `<td${attr(k)}>${inline(r[k] ?? '')}</td>`).join('')}</tr>`
          ).join('');
          out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
          continue;
        }
      }

      const buf = [line];
      i++;
      while (i < lines.length && !isBlockBoundary(lines[i]) &&
             !(UNESCAPED_PIPE.test(lines[i]) && tableAligns(lines[i + 1], splitTableRow(lines[i]).length))) {
        buf.push(lines[i]); i++;
      }
      out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('\n');
  }

  const markdown = { render, resolveLocalImagePath };
  if (typeof module !== 'undefined' && module.exports) module.exports = markdown;
  if (typeof window !== 'undefined') window.markdown = markdown;
})();
