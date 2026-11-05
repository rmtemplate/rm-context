import { legacy } from './_legacy.mjs';
const L = ['rs'];
export default legacy([
  ['axum', 'Axum', 'rust', L, 'detected', /\buse\s+axum\b/],
  ['actix', 'Actix Web', 'rust', L, 'detected', /\buse\s+actix_web\b/],
  ['rocket', 'Rocket', 'rust', L, 'detected', /#\[macro_use\]\s*extern\s+crate\s+rocket|\buse\s+rocket\b/],
]);
