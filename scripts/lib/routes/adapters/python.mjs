import { legacy } from './_legacy.mjs';
const L = ['py'];
export default legacy([
  ['fastapi', 'FastAPI', 'python', L, 'partial', /^\s*from\s+fastapi\b|^\s*import\s+fastapi\b/m, ['@app.METHOD(literal path) / @router.METHOD(literal path)']],
  ['flask', 'Flask', 'python', L, 'partial', /^\s*from\s+flask\b|^\s*import\s+flask\b/m, ['@app.route(literal path, methods=[...])', '@bp.METHOD(literal path)']],
  ['django', 'Django URLconf', 'python', L, 'partial', /^\s*from\s+django\.urls\b/m, ['path("literal/") / re_path(…) in urls.py (method ANY)']],
  ['drf', 'Django REST framework', 'python', L, 'detected', /^\s*from\s+rest_framework\b/m],
]);
