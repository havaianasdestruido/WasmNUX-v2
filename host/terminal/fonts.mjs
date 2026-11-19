// Serve only the subset files used by the deterministic fixture. Production
// would load requested subsets lazily and use a complete font fallback chain.
export const fontAssets = [
  ['Probe Mono', 'fira-code', 'latin', 'U+0000-024F'],
  ['Probe CJK', 'noto-sans-jp', '111', 'U+754C'],
  ['Probe CJK', 'noto-sans-jp', '118', 'U+65E5'],
  ['Probe CJK', 'noto-sans-jp', '117', 'U+672C'],
  ['Probe CJK', 'noto-sans-jp', '113', 'U+8A9E']
].map(([family, name, subset, unicodeRange]) => {
  const file = `${name}-${subset}-400-normal.woff2`;
  return {family, file, unicodeRange, source:`node_modules/@fontsource/${name}/files/${file}`};
});
export const probeFont = '20px "Probe Mono", "Probe CJK", monospace';

export async function loadProbeFonts() {
  await Promise.all(fontAssets.map(async ({family,file,unicodeRange}) => {
    self.fonts.add(await new FontFace(family, `url(/assets/${file})`, {unicodeRange}).load());
  }));
}
export function rasterControls() {
  const c = new OffscreenCanvas(26, 24).getContext('2d', {willReadFrequently:true});
  c.font = probeFont;
  function bitmap(text, split = false) {
    c.clearRect(0,0,26,24);
    if (split) for (let i = 0; i < text.length; i++) c.fillText(text[i], i*13, 19);
    else c.fillText(text,0,19,26);
    return c.getImageData(0,0,26,24).data.filter((_, i) => i % 4 === 3);
  }
  const distinct = (a,b) => a.some((value,i) => value !== b[i]);
  const wide = [bitmap('界'), bitmap('日')];
  return {shapedRunDiffers:distinct(bitmap('->'), bitmap('->',true)),
    distinctWideGlyphs:wide.every(a => a.some(n => n > 0)) && distinct(...wide)};
}
