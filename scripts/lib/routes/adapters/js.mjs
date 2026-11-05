import { legacy } from './_legacy.mjs';
const L = ['js'];
export default legacy([
  ['express', 'Express', 'javascript', L, 'partial', /require\(\s*['"]express['"]\s*\)|from\s+['"]express['"]/, ['app.METHOD(literal path, handler)', 'router.METHOD(literal path, handler)']],
  ['koa', 'Koa (@koa/router)', 'javascript', L, 'partial', /from\s+['"](@koa\/router|koa-router)['"]|require\(\s*['"](@koa\/router|koa-router)['"]\s*\)/, ['router.METHOD(literal path)']],
  ['hono', 'Hono', 'javascript', L, 'partial', /from\s+['"]hono['"]/, ['app.METHOD(literal path)']],
  ['nextjs', 'Next.js (App Router / pages/api)', 'javascript', L, 'partial', /from\s+['"]next(\/server)?['"]|export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/, ['app/**/route.{js,ts} exported verbs', 'pages/api/** files']],
  ['nestjs', 'NestJS', 'typescript', L, 'detected', /from\s+['"]@nestjs\/common['"]/],
  ['fastify', 'Fastify', 'javascript', L, 'detected', /require\(\s*['"]fastify['"]\s*\)|from\s+['"]fastify['"]/],
  ['nuxt', 'Nuxt / Nitro server routes', 'javascript', L, 'detected', /defineEventHandler\s*\(/],
  ['adonis', 'AdonisJS', 'typescript', L, 'detected', /from\s+['"]@(adonisjs\/core\/services\/router|ioc:Adonis\/Core\/Route)['"]/],
]);
