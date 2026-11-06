import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fixture, ok, ROOT } from './helpers.mjs';

test('viewer embeds data safely and its script parses', () => {
  const dir = fixture();
  ok(dir, 'init');
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ nodes: [{ id: 'BR-9', type: 'business_requirement', name: '</script><script>alert(1)</script>' }] }));
  ok(dir, 'graph', 'upsert', 'x.json');
  ok(dir, 'viewer');
  const html = fs.readFileSync(path.join(dir, '.rmcontext/viewer/index.html'), 'utf8');
  assert.equal(html.match(/<\/script>/g).length, 1, 'embedded data must not close the script element');
  const code = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new vm.Script(code));
  assert.match(code, /"api:POST \/users"/);
  assert.ok(fs.existsSync(path.join(dir, '.rmcontext/viewer/graph.html')));
});

const fm = (file) => {
  const m = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${file}: missing frontmatter`);
  return { meta: Object.fromEntries(m[1].split('\n').filter((l) => /^\w[\w-]*:/.test(l)).map((l) => [l.split(':')[0], l.slice(l.indexOf(':') + 1).trim()])), body: m[2] };
};

test('agents, skills, commands, routing and catalog are consistent', async () => {
  const agents = fs.readdirSync(path.join(ROOT, 'agents')).map((f) => f.replace(/\.md$/, ''));
  const skills = fs.readdirSync(path.join(ROOT, 'skills'));
  const { AGENTS } = await import('../scripts/lib/project.mjs');
  assert.deepEqual([...agents].sort(), [...AGENTS].sort());
  const routing = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/models.json'), 'utf8'));
  assert.deepEqual(Object.keys(routing.agents).sort(), [...agents].sort());
  for (const a of agents) {
    const { meta } = fm(path.join(ROOT, 'agents', a + '.md'));
    assert.equal(meta.name, a);
    assert.ok(meta.description.length > 40, `${a}: description too thin`);
    assert.ok(['opus', 'sonnet', 'haiku', 'inherit'].includes(meta.model), `${a}: model ${meta.model}`);
    assert.equal(meta.model, routing.agents[a].model, `${a}: frontmatter model differs from config/models.json`);
    for (const s of (meta.skills || '').split(',').map((x) => x.trim()).filter(Boolean)) assert.ok(skills.includes(s), `${a}: unknown skill ${s}`);
  }
  for (const s of skills) assert.equal(fm(path.join(ROOT, 'skills', s, 'SKILL.md')).meta.name, s);
  const cmds = fs.readdirSync(path.join(ROOT, 'commands'));
  const required = ['init', 'refresh', 'status', 'find', 'graph', 'viewer', 'ba', 'sa', 'pm', 'engineering', 'devops', 'document', 'fsd', 'sipoc', 'srs', 'erd', 'gantt', 'roadmap', 'rtm', 'adr', 'impact', 'review', 'architecture', 'project-health'];
  for (const r of required) assert.ok(cmds.includes(r + '.md'), `missing command ${r}`);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const c of cmds) {
    const { meta, body } = fm(path.join(ROOT, 'commands', c));
    assert.ok(meta.description, `${c}: description`);
    for (const m of body.matchAll(/`([a-z-]+)` agent/g)) assert.ok(agents.includes(m[1]), `${c}: unknown agent ${m[1]}`);
    for (const m of body.matchAll(/rmc doc new ([a-z-]+)/g)) if (m[1] !== 'type') assert.ok(JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/catalog.json'))).types[m[1]], `${c}: unknown doc type ${m[1]}`);
    if (/!`/.test(body)) assert.match(meta['allowed-tools'] || '', /Bash\(node:\*\)/, `${c}: injection needs allowed-tools`);
    const name = c.replace(/\.md$/, '');
    assert.ok(readme.includes(`/rmc:${name}`), `README does not document /rmc:${name}`);
  }
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json', 'config/models.json', 'templates/catalog.json', 'package.json'])
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')), f);
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(market.plugins[0].version, plugin.version);
  assert.equal(pkg.version, plugin.version);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/lib/util.mjs'), 'utf8'), new RegExp(`rm-context@${plugin.version.replace(/\./g, '\\.')}`));
});

test('brand assets are genuine vector SVG and the listing icon is a 512px PNG', () => {
  for (const f of ['logo.svg', 'logo-dark.svg', 'logo-light.svg', 'icon.svg', 'banner.svg']) {
    const s = fs.readFileSync(path.join(ROOT, 'assets', f), 'utf8');
    assert.match(s, /^<svg [^>]*viewBox=/);
    assert.doesNotMatch(s, /<image|data:image|base64/, `${f} embeds raster data`);
  }
  const png = fs.readFileSync(path.join(ROOT, '.claude-plugin/icon.png'));
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
});

test('claude plugin validate --strict passes', { skip: spawnSync('claude', ['--version']).status !== 0 && 'claude CLI not installed' }, () => {
  for (const target of ['.', 'agents', 'skills', 'commands']) {
    const r = spawnSync('claude', ['plugin', 'validate', target, '--strict'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, `${target}: ${r.stdout}${r.stderr}`);
  }
});
