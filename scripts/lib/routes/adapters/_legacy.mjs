// Frameworks recognised for the coverage report whose routes still come from the generic pattern extractor in
// extract.mjs (literal paths only, no prefix composition). They have no structural `extract` yet.
import { lineOf } from '../detect.mjs';

const LEGACY = 'Routes come from the generic pattern extractor: literal paths only; prefixes, groups, mounts and handlers are not composed (structural adapter planned).';
const NONE = 'Recognised only: routes are not extracted.';

// [id, name, language, langs, status, marker regex, patterns]
export function legacy(rows) {
  return rows.map(([id, name, language, langs, status, re, patterns = []]) => ({
    id, name, language, langs, status, detect: (F) => lineOf(F.text, re), patterns,
    limitations: [status === 'partial' ? LEGACY : NONE], parser: status === 'partial' ? 'regex (legacy)' : null,
  }));
}
