/**
 * Line-level markdown scanning shared by the markdown post-processors
 * (owner-markdown cleanup, large-page splitting): where fenced code blocks
 * start and end, so nothing ever edits or splits inside one.
 *
 * Fences are recognised at any indentation: in list items and inside MDX/JSX
 * components they are routinely indented by 4+ spaces, and treating such a
 * block as prose is the dangerous mistake (a `# comment` inside it would look
 * like a heading). Inside a blockquote (`> ```) a fence is left to the caller.
 */

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

/**
 * @param {string} line
 * @returns {null | {indent: string, marker: string, info: string}}
 */
export function fenceOpen(line) {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  // A backtick fence's info string may not contain a backtick (CommonMark);
  // that shape is inline code (```foo``` on one line).
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return { indent: m[1], marker: m[2], info: m[3] };
}

/** Does `line` close the fence opened by `open`? Same character, at least as long. */
export function isFenceClose(line, open) {
  const t = line.trim();
  if (t.length < open.marker.length) return false;
  const ch = open.marker[0];
  for (let i = 0; i < t.length; i++) if (t[i] !== ch) return false;
  return true;
}

/**
 * Mark every line that belongs to a fenced block (opening and closing lines
 * included). An unterminated fence runs to the end of the text, as in CommonMark.
 *
 * @param {string[]} lines
 * @returns {{inFence: Uint8Array, fences: Array<{start: number, end: number, open: object, closed: boolean}>}}
 */
export function scanFences(lines) {
  const inFence = new Uint8Array(lines.length);
  const fences = [];
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen(lines[i]);
    if (!open) continue;
    let j = i + 1;
    while (j < lines.length && !isFenceClose(lines[j], open)) j++;
    const closed = j < lines.length;
    const end = closed ? j : lines.length - 1;
    for (let k = i; k <= end; k++) inFence[k] = 1;
    fences.push({ start: i, end, open, closed });
    i = end;
  }
  return { inFence, fences };
}

/**
 * Split a prose line into text and `code span` segments (CommonMark: a run of
 * n backticks closes only on a run of exactly n; an unmatched run is text).
 * @returns {Array<{code: boolean, text: string}>}
 */
export function codeSegments(line) {
  const segs = [];
  let i = 0;
  let textStart = 0;
  while (i < line.length) {
    if (line[i] !== '`') { i++; continue; }
    let n = 0;
    while (line[i + n] === '`') n++;
    const ticks = '`'.repeat(n);
    let j = i + n;
    let close = -1;
    while (j < line.length) {
      const k = line.indexOf(ticks, j);
      if (k === -1) break;
      let m = 0;
      while (line[k + m] === '`') m++;
      if (m === n) { close = k; break; }
      j = k + m;
    }
    if (close === -1) { i += n; continue; }
    if (i > textStart) segs.push({ code: false, text: line.slice(textStart, i) });
    segs.push({ code: true, text: line.slice(i, close + n) });
    i = close + n;
    textStart = i;
  }
  if (textStart < line.length || segs.length === 0) segs.push({ code: false, text: line.slice(textStart) });
  return segs;
}

/**
 * Apply `fn` to the text of each inline-code-free run of a prose line, leaving
 * `code spans` byte-identical.
 */
export function mapOutsideInlineCode(line, fn) {
  if (!line.includes('`')) return fn(line);
  return codeSegments(line).map(s => (s.code ? s.text : fn(s.text))).join('');
}

/**
 * Replace each `code span` of a line with a placeholder (\u0000n\u0000) so a
 * pattern can match across spans without editing them; `restore` puts them back.
 * The line must not contain \u0000.
 */
export function protectCodeSpans(line) {
  if (!line.includes('`')) return { text: line, restore: s => s };
  const spans = [];
  const text = codeSegments(line).map(s => {
    if (!s.code) return s.text;
    spans.push(s.text);
    return `\u0000${spans.length - 1}\u0000`;
  }).join('');
  return { text, restore: (s) => s.replace(/\u0000(\d+)\u0000/g, (m, k) => spans[Number(k)] ?? '') };
}
