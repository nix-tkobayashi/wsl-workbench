// Pure helpers for "find" inside the rendered Markdown preview (issue #82). The preview is a DOM
// tree, not a string, so matches are found on the concatenated text of its text nodes and then
// mapped back to (node, offset) pairs for Range/Highlight objects. Kept DOM-free so it can be
// unit-tested; the renderer supplies the text nodes and does the Range construction.
// IIFE so nothing leaks into the renderer globals (see i18n.js); dual-exported for require().
(function () {
  // Build the searchable text for a list of text-node descriptors ({ data, block }). Nodes in
  // different blocks (paragraph, list item, table cell, …) are separated by a newline so a query
  // can never match across a block boundary ("a</p><p>b" is not "ab"); nodes sharing a block are
  // joined seamlessly so a match may span inline markup ("foo <strong>bar</strong>").
  // Returns { text, segments: [{ index, start, end }] } with offsets into `text`.
  function buildTextIndex(nodes) {
    let text = '';
    const segments = [];
    let prevBlock;
    (nodes || []).forEach((n, index) => {
      const data = String(n.data || '');
      if (segments.length && n.block !== prevBlock) text += '\n';
      prevBlock = n.block;
      segments.push({ index, start: text.length, end: text.length + data.length });
      text += data;
    });
    return { text, segments };
  }

  // Map an offset into the concatenated text to { index, offset } within one node. A match START
  // resolves to the node that holds the character at `offset` (first segment ending after it);
  // a match END (`end` true) resolves to the node holding the character before it (first segment
  // ending at or after it), so a match closing exactly on a node boundary stays in that node.
  // Separator newlines belong to no node: an offset inside one clamps to the nearest node edge.
  function locate(segments, offset, end) {
    let lo = 0; let hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const hit = end ? segments[mid].end >= offset : segments[mid].end > offset;
      if (hit) hi = mid; else lo = mid + 1;
    }
    const s = segments[lo];
    if (!s) return null;
    return { index: s.index, offset: Math.max(0, Math.min(s.end, offset) - s.start) };
  }

  // Every [start, end) match of `query` (a literal string) in `text`.
  function findAll(text, query, caseSensitive) {
    const out = [];
    if (!query) return out;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
    let m;
    while ((m = re.exec(text))) {
      out.push({ start: m.index, end: m.index + m[0].length });
      if (!m[0].length) re.lastIndex++;
    }
    return out;
  }

  // Matches of `query` over the node list, each as { start: {index, offset}, end: {index, offset} }.
  function findInNodes(nodes, query, caseSensitive) {
    const { text, segments } = buildTextIndex(nodes);
    return findAll(text, query, caseSensitive)
      .map((m) => ({ start: locate(segments, m.start, false), end: locate(segments, m.end, true) }))
      .filter((m) => m.start && m.end);
  }

  const previewFind = { buildTextIndex, locate, findAll, findInNodes };
  if (typeof module !== 'undefined' && module.exports) module.exports = previewFind;
  if (typeof window !== 'undefined') window.previewFind = previewFind;
})();
