// Framework capability registry. Every framework the scanner knows about is listed with an explicit status:
//   supported — extracted and covered by representative regression tests
//   partial   — extracted for the listed patterns only (see limitations)
//   detected  — recognised so the report can say so, but routes are not extracted
//   planned   — not recognised yet
// Adding a framework = adding an entry (usually to an adapter module); the graph schema does not change.
import csharp from './adapters/csharp.mjs';
import java from './adapters/java.mjs';
import js from './adapters/js.mjs';
import php from './adapters/php.mjs';
import python from './adapters/python.mjs';
import go from './adapters/go.mjs';
import ruby from './adapters/ruby.mjs';
import rust from './adapters/rust.mjs';

export const STATUSES = ['supported', 'partial', 'detected', 'planned'];
export const LANGUAGE_NAMES = { csharp: 'C#', java: 'Java', kotlin: 'Kotlin', javascript: 'JavaScript', typescript: 'TypeScript', php: 'PHP', python: 'Python', go: 'Go', ruby: 'Ruby', rust: 'Rust' };

export const REGISTRY = [...csharp, ...java, ...js, ...php, ...python, ...go, ...ruby, ...rust];

export const PARSERS = [
  { id: 'structural', name: 'Built-in tokenizer + structural parser (plain JavaScript)', available: true, languages: ['csharp', 'java', 'kotlin', 'javascript', 'typescript', 'php', 'python', 'go', 'ruby', 'rust'], note: 'Default. Zero dependencies; strings, comments, annotations, classes, members, call chains and lambda scopes.' },
  { id: 'tree-sitter', name: 'tree-sitter grammars', available: false, status: 'planned', note: 'Optional adapter; not bundled to keep the CLI dependency-free.' },
  { id: 'roslyn', name: 'Roslyn (C#)', available: false, status: 'planned', note: 'Would need the .NET SDK; not used.' },
  { id: 'javaparser', name: 'JavaParser', available: false, status: 'planned', note: 'Would need a JVM; not used.' },
];

export function capabilityMatrix() {
  return REGISTRY.map((a) => ({ id: a.id, name: a.name, language: a.language, status: a.status, parser: a.parser ?? (a.extract ? 'structural' : null), patterns: a.patterns || [], limitations: a.limitations || [] }));
}
