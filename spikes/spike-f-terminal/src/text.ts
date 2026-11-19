/**
 * Unicode text handling for the terminal (Spike F): grapheme segmentation
 * (Intl.Segmenter), cell-width calculation (wcwidth-style), and ligature
 * tokenisation for coding ligatures.
 */

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export interface Grapheme { text: string; width: number }

export function segmentGraphemes(input: string): Grapheme[] {
  const out: Grapheme[] = [];
  for (const { segment } of segmenter.segment(input)) {
    out.push({ text: segment, width: graphemeWidth(segment) });
  }
  return out;
}

export function countCells(input: string): number {
  let cells = 0;
  for (const { segment } of segmenter.segment(input)) cells += graphemeWidth(segment);
  return cells;
}

const RI_START = 0x1f1e6, RI_END = 0x1f1ff;      // regional indicator letters
const VS16 = '\uFE0F';                          // variation selector 16 (emoji presentation)
const KEYCAP_MARK = '\u20E3';                   // combining enclosing keycap
const ZWJ = '\u200D';                           // zero width joiner

function isRegionalIndicatorFlag(cluster: string): boolean {
  const cps = [...cluster];
  if (cps.length !== 2) return false;
  return cps.every(ch => {
    const cp = ch.codePointAt(0)!;
    return cp >= RI_START && cp <= RI_END;
  });
}

/** Does this whole grapheme cluster have emoji presentation (renders wide)? */
function isEmojiPresentation(cluster: string): boolean {
  if (isRegionalIndicatorFlag(cluster)) return true;         // 🇺🇸 → wide
  if (cluster.includes(KEYCAP_MARK)) return true;            // 1️⃣ → wide
  if (cluster.includes(ZWJ)) return true;                    // 👨‍👩‍👧 → wide
  if (cluster.includes(VS16)) {
    const base = cluster.codePointAt(0)!;
    if (isWide(base) || isEmojiCapable(base)) return true;   // ©️️ ☀️ ☁️ etc.
  }
  return false;
}

// Narrow codepoints that become wide emoji with VS16 (subset of emoji-capable chars).
function isEmojiCapable(cp: number): boolean {
  return (
    (cp >= 0x00A9 && cp <= 0x00AE) || // © ®
    (cp >= 0x203C && cp <= 0x2049) || // !!
    (cp >= 0x2122 && cp <= 0x231A && cp !== 0x2124) || // ™ ↔ ⌚ (rough range)
    (cp >= 0x2460 && cp <= 0x24FF) || // enclosed alphanumerics
    (cp >= 0x2600 && cp <= 0x27BF) || // misc symbols + dingbats
    (cp >= 0x2B00 && cp <= 0x2BFF) || // arrows etc.
    (cp >= 0x1F000 && cp <= 0x1FAFF)  // modern emoji planes
  );
}

/** Cell width of a single grapheme cluster. */
export function graphemeWidth(cluster: string): number {
  if (cluster.length === 0) return 0;
  const cp = cluster.codePointAt(0)!;
  if (isZeroWidth(cluster)) return 0;
  if (isEmojiPresentation(cluster)) return 2;
  if (isWide(cp)) return 2;
  return 1;
}

function isZeroWidth(cluster: string): boolean {
  // Combining marks, ZWJ, variation selectors, ZWSP, tags.
  for (const ch of cluster) {
    const cp = ch.codePointAt(0)!;
    if (isZeroWidthCodepoint(cp)) continue;
    // If the cluster starts with a printable base, it is not zero-width.
    return false;
  }
  return true;
}

function isZeroWidthCodepoint(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x0670 && cp <= 0x0670) ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x0e31 && cp <= 0x0e3a) ||
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0e) ||   // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) ||   // combining half marks
    (cp >= 0xe0100 && cp <= 0xe01ef) || // variation selectors supplement
    cp === 0x200b || // ZERO WIDTH SPACE
    cp === 0x200d || // ZERO WIDTH JOINER
    cp === 0xfeff || // BOM/ZWNBSP
    (cp >= 0x1160 && cp <= 0x11ff) // Hangul Jungseong fillers render zero in modern terminals (treated as combining jamo blocks below)
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||  // emoji (misc symbols & pictographs, emoticons)
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

// ---------------- ligatures ----------------

export interface Token { text: string; ligature: string | null }

/** Longest-match-first ligature table (Fira Code / JetBrains Mono style). */
const LIGATURES = [
  '<!--', '-->', '...', '===', '!==', '<=<', '<!--', '==', '!=', '>=', '<=', '=>', '->', '<-',
  '&&', '||', '::', '..', '//', '/*', '*/', '/=', '*=', '+=', '-=', '>>', '<<',
  '|>', '<|', ';;', '??', '?.', '<>', '<$>',
].sort((a, b) => b.length - a.length);

const LIGATURE_RE = new RegExp(LIGATURES.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m)).join('|'), 'g');

/** Tokenise a line into graphemes-with-widths, collapsing coding ligatures. O(n). */
export function tokenizeLine(line: string): Token[] {
  const out: Token[] = [];
  let cursor = 0;
  for (const m of line.matchAll(LIGATURE_RE)) {
    const start = m.index;
    if (start > cursor) pushGraphemes(line.slice(cursor, start), out);
    out.push({ text: m[0], ligature: m[0] });
    cursor = start + m[0].length;
  }
  if (cursor < line.length) pushGraphemes(line.slice(cursor), out);
  return out;
}

function pushGraphemes(segment: string, out: Token[]): void {
  for (const { segment: g } of segmenter.segment(segment)) {
    out.push({ text: g, ligature: null });
  }
}

/** Cell width of one token (2 for wide graphemes, ligature length for ligatures). */
export function tokenWidth(tok: Token): number {
  if (tok.ligature) return tok.ligature.length; // coding ligatures render in one 2..6-cell glyph; reserving text length
  return graphemeWidth(tok.text);
}
