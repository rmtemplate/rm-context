import { legacy } from './_legacy.mjs';
const L = ['php'];
export default legacy([
  ['laravel', 'Laravel', 'php', L, 'partial', /Route::(get|post|put|patch|delete|options|any|match|resource|apiResource|group|prefix|middleware)\b/, ['Route::get("/literal", [Controller::class, "action"])', 'Route::resource / apiResource (one RESOURCE entry)']],
  ['symfony', 'Symfony', 'php', L, 'detected', /#\[Route\(|use\s+Symfony\\Component\\Routing\\/],
  ['slim', 'Slim', 'php', L, 'detected', /use\s+Slim\\/],
  ['codeigniter', 'CodeIgniter', 'php', L, 'detected', /\$routes->(get|post|put|patch|delete|add|group)\s*\(/],
]);
