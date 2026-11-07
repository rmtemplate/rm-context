// Mobile Architecture Intelligence: Android (Kotlin/Java), Flutter, React Native.
// Static analysis only (files, dependencies, build config, declarations). Every finding carries status (verified|inferred),
// evidence, confidence and a timestamp. Nothing is forced into MVVM; "unstructured" is a valid result. Local databases are
// described from schema definitions (entities, DAO queries, migrations, CREATE TABLE) and never from device data.
import fs from 'node:fs';
import path from 'node:path';
import { ctx, readJson, writeJson, now, fail } from './util.mjs';
import { walkFiles } from './database/config.mjs';
import { parseSql, objKey } from './database/sql.mjs';
import { applyModel } from './database/store.mjs';

const read = (root, f, max = 400_000) => { try { const p = path.join(root, f); if (fs.statSync(p).size > max) return ''; return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const mk = (name, status, confidence, evidence, extra = {}) => ({ name, status, confidence, evidence: evidence.slice(0, 4), detectedAt: now(), ...extra });
const ev = (file, line, note) => ({ file, ...(line ? { line } : {}), ...(note ? { note } : {}) });

export function detectPlatforms(root, files) {
  const out = [];
  const gradle = files.filter((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f));
  const gtexts = gradle.map((f) => [f, read(root, f)]);
  const manifest = files.filter((f) => /(^|\/)AndroidManifest\.xml$/.test(f));
  const androidGradle = gtexts.filter(([, t]) => /com\.android\.(application|library)|id\(["']com\.android|android\s*\{/.test(t));
  const pubspec = files.find((f) => /(^|\/)pubspec\.yaml$/.test(f));
  const pub = pubspec ? read(root, pubspec) : '';
  const pkgs = files.filter((f) => /(^|\/)package\.json$/.test(f) && !/node_modules/.test(f));
  const rn = pkgs.find((f) => { try { const j = JSON.parse(read(root, f)); return { ...j.dependencies, ...j.devDependencies }['react-native']; } catch { return false; } });
  if (pubspec && /^\s*flutter:\s*$/m.test(pub) && /sdk:\s*flutter/.test(pub)) out.push({ platform: 'flutter', status: 'verified', evidence: [ev(pubspec, 1, 'pubspec declares the Flutter SDK')], root: path.posix.dirname(pubspec) });
  if (rn) out.push({ platform: 'react-native', status: 'verified', evidence: [ev(rn, 1, 'package.json depends on react-native')], root: path.posix.dirname(rn) });
  if (androidGradle.length || manifest.length) {
    const isFlutterShell = out.some((p) => p.platform === 'flutter') && !files.some((f) => /\.(kt|java)$/.test(f) && /(^|\/)src\/main\/(java|kotlin)\//.test(f) && !/MainActivity/.test(f));
    const isRnShell = out.some((p) => p.platform === 'react-native') && !files.some((f) => /\.(kt|java)$/.test(f) && /(^|\/)src\/main\/(java|kotlin)\//.test(f) && !/MainApplication|MainActivity|ReactNative/.test(f));
    if (!isFlutterShell && !isRnShell) {
      const langs = [files.some((f) => /\.kt$/.test(f)) && 'kotlin', files.some((f) => /\.java$/.test(f)) && 'java'].filter(Boolean);
      out.push({ platform: 'android', status: 'verified', languages: langs, evidence: [ev((androidGradle[0] || [manifest[0]])[0] || manifest[0], 1, androidGradle.length ? 'Android Gradle plugin' : 'AndroidManifest.xml')], root: path.posix.dirname((androidGradle[0] || [manifest[0]])[0] || manifest[0]) });
    }
  }
  return out;
}

function classes(root, files, exts) {
  const out = [];
  for (const f of files.filter((x) => exts.test(x) && !/\/(build|\.dart_tool|node_modules|generated)\//.test(x) && !/\.(g|freezed)\.dart$/.test(x))) {
    const t = read(root, f); if (!t) continue;
    out.push({ file: f, text: t });
  }
  return out;
}

const KOTLIN_CLASS = /(?:^|\n)\s*((?:@\w+(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?\s*)*)(?:(?:data|sealed|abstract|open|internal|private|public|enum)\s+)*(class|interface|object)\s+(\w+)\s*(?:<[^>]*>)?\s*(\((?:[^()]|\([^()]*\))*\))?\s*(?::\s*([^{\n]+))?/g;
const JAVA_CLASS = /(?:^|\n)\s*((?:@\w+(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?\s*)*)(?:(?:public|private|protected|abstract|final|static)\s+)*(class|interface|enum)\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+([\w.<>, ]+))?(?:\s+implements\s+([\w.<>, ]+))?/g;
const DART_CLASS = /(?:^|\n)\s*(?:abstract\s+|final\s+|base\s+|sealed\s+)*(class|mixin)\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+([\w<>?]+))?(?:\s+(?:with|implements)\s+([\w, <>]+))?/g;
const TS_CLASS = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(class|function|const)\s+([A-Z]\w+)/g;

function parseClasses(file, text) {
  const out = [];
  const add = (name, kind, line, header, supers, annotations, body) => out.push({ name, kind, file, line, supers: supers.filter(Boolean), annotations, header, body });
  if (/\.kt$/.test(file)) for (const m of text.matchAll(KOTLIN_CLASS)) { const supers = (m[5] || '').split(',').map((s) => s.trim().replace(/\(.*$/, '').replace(/<.*$/, '')).filter(Boolean); add(m[3], m[2], lineOf(text, m.index + 1), m[4] || '', supers, (m[1].match(/@\w+/g) || []), text.slice(m.index, m.index + 6000)); }
  else if (/\.java$/.test(file)) for (const m of text.matchAll(JAVA_CLASS)) add(m[3], m[2], lineOf(text, m.index + 1), '', [m[4], ...(m[5] || '').split(',')].map((s) => s?.trim().replace(/<.*$/, '')), (m[1].match(/@\w+/g) || []), text.slice(m.index, m.index + 6000));
  else if (/\.dart$/.test(file)) for (const m of text.matchAll(DART_CLASS)) add(m[2], m[1], lineOf(text, m.index + 1), '', [m[3], ...(m[4] || '').split(',')].map((s) => s?.trim().replace(/<.*$/, '').replace(/\?$/, '')), [], text.slice(m.index, m.index + 6000));
  else if (/\.(tsx?|jsx?)$/.test(file)) for (const m of text.matchAll(TS_CLASS)) add(m[2], m[1], lineOf(text, m.index + 1), '', [], [], text.slice(m.index, m.index + 4000));
  return out;
}

const roleOf = (c, ctxText) => {
  const s = c.supers.join(' '); const a = c.annotations.join(' ');
  if (/\b(ViewModel|AndroidViewModel)\b/.test(s) || /@HiltViewModel/.test(a)) return 'viewmodel';
  if (/\b(Bloc|Cubit)\b/.test(s)) return 'bloc';
  if (/\bGetxController\b/.test(s)) return 'controller';
  if (/\b(ChangeNotifier|StateNotifier|Notifier|AsyncNotifier)\b/.test(s)) return 'notifier';
  if (/\b(Activity|AppCompatActivity|ComponentActivity|FragmentActivity|Fragment|DialogFragment)\b/.test(s)) return 'screen';
  if (/\b(StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget)\b/.test(s)) return /screen|page|view/i.test(c.name) ? 'screen' : 'widget';
  if (/@Dao\b/.test(a)) return 'dao';
  if (/@Entity\b/.test(a)) return 'entity';
  if (/@Database\b/.test(a)) return 'database';
  if (c.kind === 'interface' && /@(GET|POST|PUT|DELETE|PATCH)\b/.test(c.body)) return 'api';
  if (/Repository(Impl)?$/.test(c.name) || /abstract class \w*Repository/.test(c.body.slice(0, 80))) return 'repository';
  if (/UseCase$|Interactor$/.test(c.name) || /operator fun invoke|Future<[^>]*> call\(/.test(c.body) && /UseCase/.test(c.name)) return 'usecase';
  if (/(DataSource|Api|Service|Client)$/.test(c.name)) return /Remote|Api|Client/.test(c.name) ? 'remote' : 'datasource';
  if (/Screen$|Page$/.test(c.name) && /\.(kt|dart|tsx?|jsx?)$/.test(c.file)) return 'screen';
  return null;
};

function declaredTypes(c) {
  const t = new Set();
  const body = c.body;
  for (const m of (c.header || '').matchAll(/(?:val|var)\s+\w+\s*:\s*([A-Z]\w*)/g)) t.add(m[1]);
  for (const m of body.matchAll(/(?:private\s+|protected\s+|public\s+)?(?:final\s+)?(?:lateinit\s+var|val|var)\s+\w+\s*:\s*([A-Z]\w*)/g)) t.add(m[1]);
  for (const m of body.matchAll(/(?:private|protected|public)\s+(?:final\s+)?([A-Z]\w*)\s+\w+\s*[;=]/g)) t.add(m[1]);
  for (const m of body.matchAll(/\bfinal\s+([A-Z]\w*)\??\s+_?\w+\s*;/g)) t.add(m[1]);
  for (const m of body.matchAll(/\bconstructor\s*\(([^)]*)\)|\b\w+\s*\(([^)]*)\)\s*(?:\{|;|:)/g)) for (const p of String(m[1] || m[2] || '').matchAll(/(?:final\s+|val\s+|var\s+)?(?:[\w]+\s*:\s*|\b)([A-Z]\w*)\??\s+\w+|:\s*([A-Z]\w*)/g)) t.add(p[1] || p[2]);
  for (const m of body.matchAll(/by\s+(?:viewModels|activityViewModels|hiltViewModel|viewModel)<?([A-Z]\w*)?/g)) if (m[1]) t.add(m[1]);
  for (const m of body.matchAll(/(?:hiltViewModel|viewModel|viewModels)<([A-Z]\w*)>/g)) t.add(m[1]);
  for (const m of body.matchAll(/\b(?:BlocProvider|BlocBuilder|BlocConsumer|BlocSelector|context\.read|context\.watch|Provider\.of)<([A-Z]\w*)/g)) t.add(m[1]);
  return [...t].filter((x) => x !== c.name);
}

function mobileRoots(platforms) { return platforms.map((p) => p.root).filter((r) => r && r !== '.'); }

export function detectMobile(root) {
  const files = walkFiles(root, { max: 8000, depth: 10 });
  const platforms = detectPlatforms(root, files);
  const stamp = now();
  const result = { generatedAt: stamp, platforms, architecture: [], stateManagement: [], dataLayer: { local: [], remote: [], cache: [] }, navigation: [], features: [], dependencies: { nodes: [], edges: [], chains: [] }, limitations: [] };
  if (!platforms.length) { result.limitations.push('No mobile platform was detected from build files, manifests or dependencies.'); return result; }
  const gradleAll = files.filter((f) => /build\.gradle(\.kts)?$|libs\.versions\.toml$/.test(f)).map((f) => [f, read(root, f)]);
  const pubText = files.filter((f) => /pubspec\.yaml$/.test(f)).map((f) => [f, read(root, f)]);
  const pkgText = files.filter((f) => /(^|\/)package\.json$/.test(f) && !/node_modules/.test(f)).map((f) => [f, read(root, f)]);
  const depIn = (list, rx) => { for (const [f, t] of list) { const m = rx.exec(t); if (m) return ev(f, lineOf(t, m.index), `dependency ${m[0].slice(0, 60)}`); } return null; };
  const srcClasses = [];
  const srcFiles = classes(root, files, /\.(kt|java|dart|tsx?|jsx?)$/);
  for (const sf of srcFiles) for (const c of parseClasses(sf.file, sf.text)) srcClasses.push({ ...c, role: null });
  for (const c of srcClasses) c.role = roleOf(c);
  const byRole = (r) => srcClasses.filter((c) => c.role === r);
  const add = (list, x) => { if (x) list.push(x); };
  const has = platforms.map((p) => p.platform);
  const textHas = (rx) => { for (const sf of srcFiles) { const m = rx.exec(sf.text); if (m) return ev(sf.file, lineOf(sf.text, m.index), m[0].slice(0, 50)); } return null; };

  // ---- Android
  if (has.includes('android')) {
    const ui = [];
    const compose = depIn(gradleAll, /androidx\.compose|compose\s*=\s*true|buildFeatures\s*\{[^}]*compose/) || textHas(/@Composable\b/);
    if (compose) add(result.architecture, mk('Jetpack Compose', 'verified', 'high', [compose], { layer: 'ui' }));
    const xml = files.filter((f) => /\/res\/layout\/[^/]+\.xml$/.test(f));
    if (xml.length) add(result.architecture, mk('XML layouts', 'verified', 'high', [ev(xml[0], 1, `${xml.length} layout file(s)`)], { layer: 'ui' }));
    void ui;
    const vms = byRole('viewmodel'); const repos = byRole('repository'); const ucs = byRole('usecase');
    const viewUse = textHas(/\b(hiltViewModel|viewModels|viewModel)\s*[<(]|by\s+viewModels/);
    if (vms.length) add(result.architecture, mk('ViewModel', 'verified', 'high', vms.slice(0, 3).map((c) => ev(c.file, c.line, `class ${c.name}`)), { count: vms.length }));
    if (vms.length && viewUse) add(result.architecture, mk('MVVM', 'verified', 'high', [ev(vms[0].file, vms[0].line, 'ViewModel class'), viewUse], { note: 'ViewModels exist and views obtain them' }));
    else if (vms.length) add(result.architecture, mk('MVVM', 'inferred', 'medium', [ev(vms[0].file, vms[0].line, 'ViewModel class')], { note: 'ViewModels exist but no view usage was found' }));
    if (repos.length) add(result.architecture, mk('Repository pattern', vms.some((v) => declaredTypes(v).some((t) => repos.some((r) => r.name === t || r.name === `${t}Impl`))) ? 'verified' : 'inferred', 'high', repos.slice(0, 3).map((c) => ev(c.file, c.line, `class ${c.name}`)), { count: repos.length }));
    if (ucs.length) add(result.architecture, mk('UseCase layer', 'verified', 'high', ucs.slice(0, 3).map((c) => ev(c.file, c.line, `class ${c.name}`)), { count: ucs.length }));
    const layers = ['data', 'domain', 'presentation', 'ui'].filter((l) => files.some((f) => new RegExp(`/${l}/`).test(f) && /\.(kt|java)$/.test(f)));
    if (ucs.length && repos.length && layers.includes('domain') && layers.includes('data')) add(result.architecture, mk('Clean Architecture', 'inferred', 'medium', [ev(ucs[0].file, ucs[0].line, 'UseCase'), ev(repos[0].file, repos[0].line, 'Repository')], { note: 'domain/data layers plus use cases; layer boundaries not enforced-checked', layers }));
    const sf = textHas(/\bStateFlow<|MutableStateFlow\(/); if (sf) add(result.stateManagement, mk('StateFlow', 'verified', 'high', [sf]));
    const ld = textHas(/\bLiveData<|MutableLiveData\b/); if (ld) add(result.stateManagement, mk('LiveData', 'verified', 'high', [ld]));
    const rs = textHas(/\bmutableStateOf\(|\bremember\s*\{/); if (rs) add(result.stateManagement, mk('Compose state', 'verified', 'high', [rs]));
    const hilt = depIn(gradleAll, /hilt|dagger\.hilt/i) || textHas(/@HiltAndroidApp|@AndroidEntryPoint/); if (hilt) add(result.architecture, mk('Hilt', 'verified', 'high', [hilt], { layer: 'di' }));
    const dagger = !hilt && (depIn(gradleAll, /com\.google\.dagger:dagger/) || textHas(/@Component\b|@Module\b/)); if (dagger) add(result.architecture, mk('Dagger', 'verified', 'high', [dagger], { layer: 'di' }));
    const koin = depIn(gradleAll, /koin/i) || textHas(/\bstartKoin\b|module\s*\{/); if (koin) add(result.architecture, mk('Koin', 'verified', 'high', [koin], { layer: 'di' }));
    // data layer
    const room = depIn(gradleAll, /androidx\.room|room-runtime|room\s*=/i) || textHas(/@Database\s*\(/);
    const sqldelight = files.filter((f) => /\.sq$/.test(f));
    const helper = srcClasses.filter((c) => c.supers.some((s) => /SQLiteOpenHelper/.test(s)));
    const realm = depIn(gradleAll, /realm/i); const datastore = depIn(gradleAll, /datastore/i);
    if (room) result.dataLayer.local.push(mk('Room', 'verified', 'high', [room], { engine: 'sqlite' }));
    if (sqldelight.length) result.dataLayer.local.push(mk('SQLDelight', 'verified', 'high', [ev(sqldelight[0], 1, `${sqldelight.length} .sq file(s)`)], { engine: 'sqlite' }));
    if (helper.length) result.dataLayer.local.push(mk('SQLite (SQLiteOpenHelper)', 'verified', 'high', helper.slice(0, 2).map((c) => ev(c.file, c.line, `class ${c.name}`)), { engine: 'sqlite' }));
    if (realm) result.dataLayer.local.push(mk('Realm', 'verified', 'medium', [realm]));
    if (datastore) result.dataLayer.cache.push(mk('DataStore', 'verified', 'high', [datastore], { note: 'key-value preferences, not a relational schema' }));
    const retro = depIn(gradleAll, /retrofit/i) || textHas(/@(GET|POST|PUT|DELETE|PATCH)\s*\(/); if (retro) result.dataLayer.remote.push(mk('Retrofit', 'verified', 'high', [retro], { note: 'remote API client: not the local database' }));
    const ktor = depIn(gradleAll, /io\.ktor:ktor-client/); if (ktor) result.dataLayer.remote.push(mk('Ktor client', 'verified', 'high', [ktor]));
  }

  // ---- Flutter
  if (has.includes('flutter')) {
    const pubdep = (name) => depIn(pubText, new RegExp(`^\\s+${name}\\s*:`, 'm'));
    const bloc = pubdep('flutter_bloc') || pubdep('bloc'); const blocCls = byRole('bloc');
    if (bloc || blocCls.length) { const isCubit = blocCls.some((c) => c.supers.includes('Cubit')); add(result.stateManagement, mk(isCubit && !blocCls.some((c) => c.supers.includes('Bloc')) ? 'Cubit' : 'BLoC', 'verified', 'high', [bloc, ...blocCls.slice(0, 2).map((c) => ev(c.file, c.line, `class ${c.name}`))].filter(Boolean), { count: blocCls.length })); }
    const rp = pubdep('flutter_riverpod') || pubdep('riverpod') || pubdep('hooks_riverpod'); if (rp) add(result.stateManagement, mk('Riverpod', 'verified', 'high', [rp, textHas(/ConsumerWidget|ref\.(watch|read)\(/)].filter(Boolean)));
    const pv = pubdep('provider'); if (pv) add(result.stateManagement, mk('Provider', 'verified', 'high', [pv, textHas(/ChangeNotifierProvider|Provider\.of|context\.(read|watch)</)].filter(Boolean)));
    const gx = pubdep('get'); if (gx && textHas(/GetxController|GetMaterialApp|Get\.(to|put|find)/)) add(result.stateManagement, mk('GetX', 'verified', 'high', [gx, textHas(/GetxController|Get\.(to|put|find)/)].filter(Boolean)));
    const repos = byRole('repository'); if (repos.length) add(result.architecture, mk('Repository pattern', 'inferred', 'medium', repos.slice(0, 3).map((c) => ev(c.file, c.line, `class ${c.name}`)), { note: 'classes named *Repository; usage by state holders is in the dependency edges' }));
    const di = pubdep('get_it') || pubdep('injectable'); if (di) add(result.architecture, mk('Dependency injection (get_it/injectable)', 'verified', 'high', [di], { layer: 'di' }));
    const drift = pubdep('drift'); const sqflite = pubdep('sqflite'); const hive = pubdep('hive'); const isar = pubdep('isar'); const sp = pubdep('shared_preferences');
    if (drift) result.dataLayer.local.push(mk('Drift', 'verified', 'high', [drift], { engine: 'sqlite' }));
    if (sqflite) result.dataLayer.local.push(mk('sqflite', 'verified', 'high', [sqflite], { engine: 'sqlite' }));
    if (hive) result.dataLayer.local.push(mk('Hive', 'verified', 'medium', [hive], { note: 'NoSQL box store' }));
    if (isar) result.dataLayer.local.push(mk('Isar', 'verified', 'medium', [isar]));
    if (sp) result.dataLayer.cache.push(mk('SharedPreferences', 'verified', 'high', [sp], { note: 'key-value, not a relational schema' }));
    for (const n of ['dio', 'http', 'retrofit', 'chopper']) { const d = pubdep(n); if (d) result.dataLayer.remote.push(mk(n, 'verified', 'high', [d], { note: 'remote API client: not the local database' })); }
    if (!result.stateManagement.length) result.architecture.push(mk('Unstructured / setState', 'inferred', 'low', [textHas(/setState\(/)].filter(Boolean), { note: 'no state-management package detected; no pattern is assumed' }));
  }

  // ---- React Native
  if (has.includes('react-native')) {
    const pdep = (name) => { for (const [f, t] of pkgText) { try { const j = JSON.parse(t); const d = { ...j.dependencies, ...j.devDependencies }; if (d[name]) return ev(f, 1, `${name}@${d[name]}`); } catch { /* ignore */ } } return null; };
    const hooks = textHas(/\buse(State|Effect|Reducer|Memo|Callback)\(/); if (hooks) add(result.stateManagement, mk('React hooks', 'verified', 'high', [hooks]));
    const ctxo = textHas(/createContext\(/); if (ctxo) add(result.stateManagement, mk('React Context', 'verified', 'high', [ctxo]));
    const redux = pdep('@reduxjs/toolkit') || pdep('redux'); if (redux) add(result.stateManagement, mk('Redux', 'verified', 'high', [redux]));
    const zus = pdep('zustand'); if (zus) add(result.stateManagement, mk('Zustand', 'verified', 'high', [zus, textHas(/\bcreate\(\s*(?:\(|<)|create<[^>]*>\(\)/)].filter(Boolean)));
    const tq = pdep('@tanstack/react-query') || pdep('react-query'); if (tq) add(result.stateManagement, mk('TanStack Query', 'verified', 'high', [tq], { note: 'server-state cache' }));
    const sql = pdep('expo-sqlite') || pdep('react-native-sqlite-storage') || pdep('react-native-quick-sqlite') || pdep('@op-engineering/op-sqlite'); if (sql) result.dataLayer.local.push(mk('SQLite', 'verified', 'high', [sql], { engine: 'sqlite' }));
    const realm = pdep('realm'); if (realm) result.dataLayer.local.push(mk('Realm', 'verified', 'medium', [realm]));
    const mmkv = pdep('react-native-mmkv'); if (mmkv) result.dataLayer.cache.push(mk('MMKV', 'verified', 'high', [mmkv], { note: 'key-value, not a relational schema' }));
    const as = pdep('@react-native-async-storage/async-storage'); if (as) result.dataLayer.cache.push(mk('AsyncStorage', 'verified', 'high', [as], { note: 'key-value, not a relational schema' }));
    const ax = pdep('axios'); if (ax) result.dataLayer.remote.push(mk('axios', 'verified', 'high', [ax], { note: 'remote API client: not the local database' }));
    else { const f = textHas(/\bfetch\(\s*[`'"]https?:/); if (f) result.dataLayer.remote.push(mk('fetch', 'inferred', 'medium', [f])); }
  }

  // ---- local database schema (definitions only)
  const localModel = localSchema(root, files, srcFiles, srcClasses, result);
  result.localSchema = { tables: localModel.tables.length, daos: localModel.daos.length, migrations: localModel.migrations };
  result.dataLayer.daos = localModel.daos; result.dataLayer.migrations = localModel.migrations;

  // ---- dependency graph from declared types only
  buildDependencies(result, srcClasses);
  result.navigation = detectNavigation(root, files, srcFiles);
  result.features = detectFeatures(files, srcClasses);
  result._localModel = localModel;
  if (!result.architecture.length && !result.stateManagement.length) result.architecture.push(mk('Unstructured', 'inferred', 'low', [], { note: 'no recognised architecture or state-management pattern; nothing is assumed' }));
  return result;
}

function localSchema(root, files, srcFiles, classesAll, result) {
  const tables = []; const daos = []; const migrations = []; const stamp = now(); void stamp;
  // Room
  for (const c of classesAll.filter((x) => x.role === 'entity')) {
    const tn = /@Entity\s*\(([^)]*)\)/.exec(c.body)?.[1]; const name = /tableName\s*=\s*"([^"]+)"/.exec(tn || '')?.[1] || c.name;
    const cols = []; const pk = []; const fks = [];
    for (const m of c.body.matchAll(/((?:@\w+(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?\s*)*)(?:val|var)\s+(\w+)\s*:\s*([\w<>?]+)/g)) {
      if (/@Ignore/.test(m[1])) continue;
      const cn = /@ColumnInfo\s*\(\s*name\s*=\s*"([^"]+)"/.exec(m[1])?.[1] || m[2];
      cols.push({ name: cn, type: m[3].replace('?', ''), nullable: /\?$/.test(m[3]), pk: /@PrimaryKey/.test(m[1]), identity: /autoGenerate\s*=\s*true/.test(m[1]) });
      if (/@PrimaryKey/.test(m[1])) pk.push(cn);
    }
    for (const m of (tn || '').matchAll(/ForeignKey\s*\(\s*entity\s*=\s*(\w+)::class\s*,\s*parentColumns\s*=\s*\[?"([^"\]]+)"\]?\s*,\s*childColumns\s*=\s*\[?"([^"\]]+)"/g)) fks.push({ columns: [m[3]], ref: { schema: '', name: m[1] }, refColumns: [m[2]] });
    if (cols.length) tables.push({ schema: '', name, columns: cols, primaryKey: pk, foreignKeys: fks, uniques: [], checks: [], indexes: [], _file: c.file, _line: c.line });
  }
  for (const c of classesAll.filter((x) => x.role === 'dao')) {
    const qs = [];
    for (const m of c.body.matchAll(/@(Query|Insert|Update|Delete|Upsert)\s*(?:\(\s*"((?:[^"\\]|\\.)*)"\s*\))?[\s\S]{0,60}?fun\s+(\w+)\s*\(([^)]*)\)/g)) {
      const sql = m[2] || ''; const used = sql ? parseSql(`${sql};`).routines : []; void used;
      const tn = [...(sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/gi))].map((x) => x[1]);
      qs.push({ method: m[3], op: m[1], sql: sql.slice(0, 300), tables: [...new Set(tn)] });
    }
    daos.push({ name: c.name, file: c.file, line: c.line, queries: qs });
  }
  for (const sf of srcFiles) for (const m of sf.text.matchAll(/\bMigration\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g)) migrations.push({ name: `Migration ${m[1]}→${m[2]}`, file: sf.file, line: lineOf(sf.text, m.index), from: m[1], to: m[2] });
  for (const f of files.filter((x) => /schemas\/.*\/\d+\.json$/.test(x))) migrations.push({ name: path.basename(f), file: f, kind: 'room-schema-export' });
  // SQL strings in SQLiteOpenHelper / sqflite / expo-sqlite / SQLDelight
  const sqlTexts = [];
  for (const f of files.filter((x) => /\.sq$/.test(x))) sqlTexts.push([f, read(root, f)]);
  for (const sf of srcFiles) { if (!/CREATE\s+TABLE/i.test(sf.text)) continue; for (const m of sf.text.matchAll(/("""|'''|["'`])((?:(?!\1)[\s\S]){0,4000}?CREATE\s+TABLE(?:(?!\1)[\s\S])*)\1/gi)) sqlTexts.push([sf.file, m[2]]); }
  for (const [f, t] of sqlTexts) for (const tb of parseSql(t.replace(/\\n|\\t/g, ' ')).tables) if (!tables.some((x) => x.name === tb.name)) tables.push({ ...tb, schema: '', _file: f });
  // Drift
  for (const c of classesAll.filter((x) => x.supers.includes('Table'))) {
    const cols = [...c.body.matchAll(/(Int|Text|Bool|DateTime|Real|Blob|Int64)Column\s+get\s+(\w+)\s*=>\s*([^;]+);/g)].map((m) => ({ name: m[2], type: m[1].toLowerCase(), nullable: /nullable\(\)/.test(m[3]), pk: /autoIncrement\(\)/.test(m[3]), identity: /autoIncrement\(\)/.test(m[3]) }));
    if (cols.length) tables.push({ schema: '', name: c.name, columns: cols, primaryKey: cols.filter((x) => x.pk).map((x) => x.name), foreignKeys: [], uniques: [], checks: [], indexes: [], _file: c.file, _line: c.line });
  }
  if (tables.length) result.limitations.push('Local database tables come from schema definitions in source (entities, CREATE TABLE, Drift tables); no device data was read, and the local database is not the backend database.');
  return { tables, daos, migrations };
}

function buildDependencies(result, classesAll) {
  const byName = new Map(); for (const c of classesAll) { if (!byName.has(c.name)) byName.set(c.name, []); byName.get(c.name).push(c); }
  const roles = new Set(['screen', 'viewmodel', 'bloc', 'controller', 'notifier', 'usecase', 'repository', 'dao', 'api', 'remote', 'datasource', 'database']);
  const nodes = classesAll.filter((c) => c.role && roles.has(c.role)).map((c) => ({ id: `${c.role}:${c.name}`, name: c.name, role: c.role, file: c.file, line: c.line }));
  const nodeOf = new Map(nodes.map((n) => [n.name, n]));
  const edges = [];
  for (const c of classesAll) {
    if (!c.role || !roles.has(c.role)) continue;
    for (const tn of declaredTypes(c)) {
      const cands = byName.get(tn) || []; const tgt = nodeOf.get(tn) || nodeOf.get(tn.replace(/Impl$/, '')) || (nodeOf.get(`${tn}Impl`));
      if (!tgt || tgt.name === c.name) continue;
      if (cands.length > 1 && !nodeOf.get(tn)) continue; // ambiguous name: not linked
      edges.push({ from: `${c.role}:${c.name}`, to: tgt.id, kind: 'declared-type', file: c.file, line: c.line, status: 'verified', confidence: 'high' });
    }
  }
  const uniq = new Map(edges.map((e) => [`${e.from}>${e.to}`, e]));
  const list = [...uniq.values()];
  // chains: Screen → … → DAO/API
  const adj = new Map(); for (const e of list) { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from).push(e.to); }
  const chains = []; const ends = new Set(['dao', 'api', 'remote', 'datasource']);
  const dfs = (path_, seen) => { const cur = path_[path_.length - 1]; if (ends.has(cur.split(':')[0]) && path_.length > 1) { chains.push([...path_]); return; } for (const nx of adj.get(cur) || []) if (!seen.has(nx) && path_.length < 7) { seen.add(nx); dfs([...path_, nx], seen); seen.delete(nx); } };
  for (const n of nodes.filter((x) => ['screen', 'viewmodel', 'bloc', 'controller', 'notifier'].includes(x.role))) dfs([n.id], new Set([n.id]));
  result.dependencies = { nodes, edges: list, chains: chains.slice(0, 60).map((c) => c.map((x) => x.split(':')[1]).join(' → ')) };
}

function detectNavigation(root, files, srcFiles) {
  const nav = [];
  for (const f of files.filter((x) => /res\/navigation\/[^/]+\.xml$/.test(x))) { const t = read(root, f); for (const m of t.matchAll(/<(fragment|activity)[^>]*android:name="([^"]+)"/g)) nav.push({ kind: 'nav-graph', destination: m[2].split('.').pop(), file: f, line: lineOf(t, m.index), status: 'verified' }); }
  for (const sf of srcFiles) {
    for (const m of sf.text.matchAll(/composable\(\s*(?:route\s*=\s*)?"([^"]+)"/g)) nav.push({ kind: 'compose-route', destination: m[1], file: sf.file, line: lineOf(sf.text, m.index), status: 'verified' });
    for (const m of sf.text.matchAll(/GoRoute\(\s*path:\s*'([^']+)'/g)) nav.push({ kind: 'go_router', destination: m[1], file: sf.file, line: lineOf(sf.text, m.index), status: 'verified' });
    for (const m of sf.text.matchAll(/'(\/[\w/:-]*)'\s*:\s*\(\w*\)\s*=>/g)) nav.push({ kind: 'flutter-routes', destination: m[1], file: sf.file, line: lineOf(sf.text, m.index), status: 'verified' });
    for (const m of sf.text.matchAll(/<(?:\w+\.)?Screen\s+name=["{']+([\w-]+)/g)) nav.push({ kind: 'react-navigation', destination: m[1], file: sf.file, line: lineOf(sf.text, m.index), status: 'verified' });
  }
  return nav.slice(0, 200);
}

function detectFeatures(files, classesAll) {
  const feats = new Map();
  for (const c of classesAll) {
    if (!c.role) continue;
    const m = /(?:^|\/)(?:features?|modules?|screens?)\/([^/]+)\//.exec(c.file) || /\/(?:ui|presentation)\/([a-z][\w]*)\//.exec(c.file); if (!m) continue;
    const f = feats.get(m[1]) || { name: m[1], classes: [] }; f.classes.push({ name: c.name, role: c.role, file: c.file }); feats.set(m[1], f);
  }
  return [...feats.values()].slice(0, 60);
}

// ---------- persistence ----------
export const mobileDir = (root) => ctx(root).p('mobile');
export function saveMobile(root, r) {
  const d = mobileDir(root); const local = r._localModel; delete r._localModel;
  writeJson(path.join(d, 'architecture.json'), { generatedAt: r.generatedAt, platforms: r.platforms, architecture: r.architecture, limitations: r.limitations });
  writeJson(path.join(d, 'state-management.json'), { generatedAt: r.generatedAt, items: r.stateManagement });
  writeJson(path.join(d, 'data-layer.json'), { generatedAt: r.generatedAt, ...r.dataLayer, note: 'Local persistence, remote API clients and caches are separate. A local database is never the backend database.' });
  writeJson(path.join(d, 'navigation.json'), { generatedAt: r.generatedAt, items: r.navigation });
  writeJson(path.join(d, 'features.json'), { generatedAt: r.generatedAt, items: r.features });
  writeJson(path.join(d, 'dependencies.json'), { generatedAt: r.generatedAt, ...r.dependencies, rule: 'Edges come from declared constructor/field types only, never from similar names.' });
  writeJson(path.join(d, 'manifest.json'), { schema: 1, generatedAt: r.generatedAt, platforms: r.platforms.map((p) => p.platform), counts: { architecture: r.architecture.length, stateManagement: r.stateManagement.length, localTables: r.localSchema?.tables || 0, daos: r.dataLayer.daos?.length || 0, edges: r.dependencies.edges.length, chains: r.dependencies.chains.length, screens: r.dependencies.nodes.filter((n) => n.role === 'screen').length }, files: ['architecture.json', 'state-management.json', 'data-layer.json', 'navigation.json', 'features.json', 'dependencies.json'], limitations: r.limitations });
  if (local?.tables.length) {
    const model = { engine: 'sqlite', database: 'local-db', version: '', tables: local.tables.map(({ _file, _line, ...t }) => t), routines: [], sequences: [], dependencies: [], limitations: ['Local mobile database: schema from source definitions only; no device data was read.'] };
    applyModel(root, { scope: 'local', target: { engine: 'sqlite', database: 'local-db', profile: 'mobile' }, model, source: 'orm-definition', sourceFile: local.tables[0]._file });
  }
  return r;
}

export function loadMobile(root) { const d = mobileDir(root); if (!fs.existsSync(path.join(d, 'manifest.json'))) return null; return { manifest: readJson(path.join(d, 'manifest.json')), architecture: readJson(path.join(d, 'architecture.json'), {}), state: readJson(path.join(d, 'state-management.json'), {}), data: readJson(path.join(d, 'data-layer.json'), {}), nav: readJson(path.join(d, 'navigation.json'), {}), features: readJson(path.join(d, 'features.json'), {}), deps: readJson(path.join(d, 'dependencies.json'), {}) }; }

// compact, bounded knowledge for a task (never the whole knowledge)
export function mobileContext(root, query, { maxChars = 1100 } = {}) {
  const m = loadMobile(root); if (!m) return '';
  const q = String(query || '').toLowerCase(); const terms = q.split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
  const hit = (s) => terms.some((t) => String(s).toLowerCase().includes(t));
  const lines = [`Mobile (${m.manifest.platforms.join(', ')}):`];
  lines.push(`- architecture: ${m.architecture.architecture.map((a) => `${a.name} [${a.status}]`).join(', ') || 'none detected'}`);
  if (m.state.items.length) lines.push(`- state management: ${m.state.items.map((a) => a.name).join(', ')} — follow it; do not swap it without approval`);
  if (m.data.local?.length) lines.push(`- local data: ${m.data.local.map((a) => a.name).join(', ')} · remote: ${m.data.remote.map((a) => a.name).join(', ') || '-'} (separate from the backend database)`);
  const chains = (m.deps.chains || []).filter(hit).slice(0, 4);
  for (const c of chains) lines.push(`- chain: ${c}`);
  const nodes = (m.deps.nodes || []).filter((n) => hit(n.name)).slice(0, 6);
  for (const n of nodes) lines.push(`- ${n.role} ${n.name} — ${n.file}:${n.line}`);
  const daos = (m.data.daos || []).filter((d) => hit(d.name) || d.queries.some((x) => hit(x.method) || x.tables.some(hit))).slice(0, 3);
  for (const d of daos) lines.push(`- dao ${d.name} — ${d.file}:${d.line}: ${d.queries.slice(0, 4).map((x) => x.method).join(', ')}`);
  return lines.join('\n').slice(0, maxChars);
}

export function cli(root, args) {
  const [sub, a1] = args._;
  switch (sub) {
    case 'detect': case 'discover': { const r = saveMobile(root, detectMobile(root)); if (args.json) return JSON.stringify({ platforms: r.platforms, architecture: r.architecture, stateManagement: r.stateManagement, dataLayer: r.dataLayer, chains: r.dependencies.chains }, null, 2); return r.platforms.length ? `Mobile: ${r.platforms.map((p) => p.platform).join(', ')} · architecture ${r.architecture.map((a) => `${a.name} [${a.status}]`).join(', ') || 'none'} · state ${r.stateManagement.map((a) => a.name).join(', ') || 'none'} · local ${r.dataLayer.local.map((a) => a.name).join(', ') || 'none'} · ${r.dependencies.edges.length} dependency edge(s), ${r.dependencies.chains.length} chain(s)` : 'No mobile platform detected.'; }
    case 'status': { const m = loadMobile(root); return m ? JSON.stringify(m.manifest, null, 2) : 'Mobile knowledge not generated: run `rmc mobile detect`.'; }
    case 'show': { const m = loadMobile(root); if (!m) fail('Run `rmc mobile detect` first.'); const k = { architecture: m.architecture, 'state-management': m.state, 'data-layer': m.data, navigation: m.nav, features: m.features, dependencies: m.deps }[a1]; if (!k) fail('Usage: rmc mobile show architecture|state-management|data-layer|navigation|features|dependencies'); return JSON.stringify(k, null, 2); }
    case 'find': { const q = args._.slice(1).join(' '); return mobileContext(root, q) || 'No mobile knowledge: run `rmc mobile detect`.'; }
    default: return 'rmc mobile detect|status|show <section>|find <terms>';
  }
}
export { objKey };
