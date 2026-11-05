// rmc viewer rebuilds viewer.css automatically when these sources change (hash check in scripts/lib/viewer.mjs).
// The compiled viewer.css is committed and inlined into the single-file viewer; nothing is fetched at runtime.
const tok = (v) => `rgb(var(--${v}) / <alpha-value>)`;
module.exports = {
  content: [__dirname + '/template.html', __dirname + '/app.js'],
  safelist: ['b-extracted', 'b-inferred', 'b-manual', 'b-stale'], // built dynamically from provenance
  theme: {
    extend: {
      colors: Object.fromEntries(['bg', 'panel', 'raised', 'fg', 'muted', 'faint', 'line', 'hover', 'accent', 'accent-fg', 'accent-soft', 'danger', 'warn', 'ok',
        'l-business', 'l-system', 'l-engineering', 'l-infrastructure', 'l-project'].map((k) => [k, tok(k)])),
      fontFamily: { sans: ['Inter', '"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif'], mono: ['ui-monospace', '"SF Mono"', 'Consolas', 'monospace'] },
      fontSize: { '2xs': ['11px', '16px'] },
    },
  },
  plugins: [],
};
