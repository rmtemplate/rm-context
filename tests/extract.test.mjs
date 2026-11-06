import test from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../scripts/lib/extract.mjs';
import { buildScanGraph } from '../scripts/lib/scan.mjs';
import { validateGraph } from '../scripts/lib/graph.mjs';

test('Laravel: routes with handlers, models, migrations, PSR-4 resolution', () => {
  const files = {
    'composer.json': JSON.stringify({ name: 'acme/shop', require: { 'laravel/framework': '^11.0' }, autoload: { 'psr-4': { 'App\\': 'app/' } } }),
    'routes/web.php': "<?php\nuse App\\Http\\Controllers\\OrderController;\nRoute::get('/orders', [OrderController::class, 'index']);\nRoute::post('orders', [OrderController::class, 'store']);\n",
    'app/Http/Controllers/OrderController.php': "<?php\nnamespace App\\Http\\Controllers;\nuse App\\Models\\Order;\nclass OrderController extends Controller\n{\n    public function index()\n    {\n        return Order::all();\n    }\n    public function store() { DB::table('orders')->insert([]); }\n}\n",
    'app/Models/Order.php': "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Order extends Model\n{\n    protected $table = 'orders';\n}\n",
    'database/migrations/2024_01_01_create_orders.php': "<?php\nSchema::create('orders', function (Blueprint $table) {\n    $table->id('id');\n    $table->foreignId('user_id')->constrained('users');\n    $table->string('status');\n});\nSchema::create('users', function (Blueprint $table) {\n    $table->string('email');\n});\n",
  };
  const cache = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { x: extract(k, v) }]));
  const g = buildScanGraph(cache, { id: 'shop', name: 'shop' });
  const e = new Set(g.edges.map((x) => x.id));
  assert.ok(e.has('file:routes/web.php|implements|api:GET /orders'));
  assert.ok(e.has('api:GET /orders|calls|function:app/Http/Controllers/OrderController.php#index'));
  assert.ok(e.has('api:POST /orders|calls|function:app/Http/Controllers/OrderController.php#store'));
  assert.ok(e.has('file:routes/web.php|depends_on|file:app/Http/Controllers/OrderController.php'));
  assert.ok(e.has('entity:Order|depends_on|table:orders'));
  assert.ok(e.has('table:orders|depends_on|table:users'));
  assert.ok(g.nodes.find((n) => n.id === 'dependency:composer/laravel/framework'));
  assert.deepEqual(validateGraph(g).errors, []);
  const fn = g.nodes.find((n) => n.id === 'function:app/Http/Controllers/OrderController.php#index');
  assert.deepEqual(fn.evidence[0].lines, [6, 9]);
});

test('Python, Go, Java, Prisma and infrastructure extractors', () => {
  const py = extract('app/api.py', "from fastapi import APIRouter\nfrom .models import User\nrouter = APIRouter()\n\n@router.get('/users/{id}')\nasync def get_user(id: int):\n    return User\n\nclass User(Base):\n    __tablename__ = 'users'\n");
  assert.deepEqual(py.routes.map((r) => `${r.method} ${r.path}`), ['GET /users/{id}']);
  assert.deepEqual(py.decls.find((d) => d.name === 'get_user').end, 7);
  assert.ok(py.decls.some((d) => d.type === 'entity' && d.name === 'User'));
  const go = extract('main.go', 'package main\nimport (\n  "github.com/gin-gonic/gin"\n)\nfunc main() {\n  r := gin.Default()\n  r.GET("/ping", ping)\n}\n');
  assert.deepEqual(go.routes.map((r) => r.path), ['/ping']);
  assert.equal(go.imports[0].spec, 'github.com/gin-gonic/gin');
  const java = extract('src/OrderApi.java', 'package com.acme;\n@RestController\n@RequestMapping("/api")\npublic class OrderApi {\n  @GetMapping("/orders")\n  List<Order> all() { return null; }\n}\n');
  assert.deepEqual(java.routes.map((r) => `${r.method} ${r.path}`), ['GET /api/orders']);
  const prisma = extract('prisma/schema.prisma', 'model User {\n  id Int @id\n  posts Post[]\n}\nmodel Post {\n  id Int @id\n  author User @relation(fields: [authorId], references: [id])\n  authorId Int\n}\n');
  assert.deepEqual(prisma.tables.map((t) => t.name), ['User', 'Post']);
  assert.deepEqual(prisma.tables[1].refs.map((r) => r.table), ['User']);
  const k8s = extract('deploy/app.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web-svc\n');
  assert.deepEqual(k8s.infra.map((i) => i.id), ['deployment:k8s/Deployment/web', 'service:k8s/Service/web-svc']);
  const tf = extract('infra/main.tf', 'resource "aws_instance" "app" {\n}\nresource "aws_db_instance" "db" {\n}\n');
  assert.deepEqual(tf.infra.map((i) => i.type), ['server', 'server']);
  const env = extract('.env.example', 'export API_URL=https://x\nSECRET_KEY=\n# comment\n');
  assert.deepEqual(env.env, ['API_URL', 'SECRET_KEY']);
});

test('JS: SQL keywords in lowercase imports are not mistaken for table reads', () => {
  const x = extract('src/a.js', "import { from } from './from';\nconst q = 'select * from users';\nconst r = 'SELECT * FROM orders JOIN items ON 1=1';\n");
  assert.deepEqual(x.dbUses.map((u) => u.table), ['orders', 'items']);
});
