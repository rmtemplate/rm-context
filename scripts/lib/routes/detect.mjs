// Framework detection helpers. Detection returns the 1-based line of the first marker, or null.
export function lineOf(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  let line = 1;
  for (let i = 0; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
