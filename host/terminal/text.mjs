const segmenter = new Intl.Segmenter(undefined, {granularity:'grapheme'});
const wide = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]/u;
const combining = /^\p{Mark}+$/u;
const ligature = /^(?:===|!==|=>|->|<=|>=|==|!=|::|ffi|ffl|fi|fl)/;

// Approximate terminal width for the probe, not a Unicode wcwidth table.
export function layout(line, {ligatures = true} = {}) {
  let col = 0, i = 0;
  const entries = Array.from(segmenter.segment(line));
  const out = [];
  while (i < entries.length) {
    const {segment, index} = entries[i];
    const match = ligatures && line.slice(index).match(ligature)?.[0];
    if (match && entries.slice(i, i+match.length).map(e => e.segment).join('') === match) {
      out.push({text:match, col, cells:match.length});
      col += match.length; i += match.length; continue;
    }
    i++;
    if (combining.test(segment)) continue;
    const cells = wide.test(segment) ? 2 : 1;
    out.push({text:segment, col, cells}); col += cells;
  }
  return out;
}

// The editable element is the IME sink; pre-edit changes are not guest input.
export function captureInput(textarea, onCommit) {
  const input = event => {
    if (event.isComposing || !textarea.value) return;
    const value = textarea.value;
    textarea.value = '';
    onCommit(value);
  };
  const end = event => {
    textarea.value = '';
    if (event.data) onCommit(event.data);
  };
  textarea.addEventListener('input', input);
  textarea.addEventListener('compositionend', end);
  return () => {
    textarea.removeEventListener('input', input);
    textarea.removeEventListener('compositionend', end);
  };
}
