// Mobile Architecture Intelligence (Android Kotlin/Java, Flutter, React Native). Static fixtures only: nothing runs, no device or
// emulator is used, no user data exists. Verifies detection from files/dependencies, evidence, status/confidence, the separation of
// local persistence from remote APIs, dependency edges from declared types only, and that nothing is forced into MVVM.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, rmc, repoTelemetry } from './helpers.mjs';
import { project } from './db-helpers.mjs';
import { detectMobile, saveMobile, mobileContext, loadMobile } from '../scripts/lib/mobile.mjs';
import { findObjects, showObject } from '../scripts/lib/database/store.mjs';

let telemetryBefore;
before(() => { telemetryBefore = repoTelemetry(); });
after(() => assert.equal(repoTelemetry(), telemetryBefore, "tests must not write to this repository's .rmcontext telemetry"));

const names = (r, k = 'architecture') => r[k].map((a) => a.name);
const find = (r, n, k = 'architecture') => r[k].find((a) => a.name === n);

const ANDROID_BASE = {
  'settings.gradle.kts': 'include(":app")',
  'app/build.gradle.kts': 'plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("com.google.devtools.ksp") }\ndependencies { implementation("androidx.room:room-runtime:2.6.1"); implementation("com.squareup.retrofit2:retrofit:2.9.0") }',
  'app/src/main/AndroidManifest.xml': '<manifest package="com.example.app"><application/></manifest>',
};
const KT_MVVM_ROOM = {
  ...ANDROID_BASE,
  'app/src/main/java/com/example/app/data/UserEntity.kt': '@Entity(tableName = "users", foreignKeys = [ForeignKey(entity = TeamEntity::class, parentColumns = ["id"], childColumns = ["team_id"])])\ndata class UserEntity(\n  @PrimaryKey(autoGenerate = true) val id: Long,\n  @ColumnInfo(name = "email") val email: String,\n  @ColumnInfo(name = "team_id") val teamId: Long?,\n  val nickname: String?\n)',
  'app/src/main/java/com/example/app/data/TeamEntity.kt': '@Entity(tableName = "teams")\ndata class TeamEntity(@PrimaryKey val id: Long, val name: String)',
  'app/src/main/java/com/example/app/data/UserDao.kt': '@Dao\ninterface UserDao {\n  @Query("SELECT * FROM users WHERE email = :email")\n  suspend fun byEmail(email: String): UserEntity?\n  @Insert\n  suspend fun insert(u: UserEntity)\n}',
  'app/src/main/java/com/example/app/data/AppDatabase.kt': '@Database(entities = [UserEntity::class, TeamEntity::class], version = 2)\nabstract class AppDatabase : RoomDatabase() { abstract fun userDao(): UserDao }',
  'app/src/main/java/com/example/app/data/Migrations.kt': 'val MIGRATION_1_2 = object : Migration(1, 2) { override fun migrate(db: SupportSQLiteDatabase) {} }',
  'app/src/main/java/com/example/app/data/UserApi.kt': 'interface UserApi {\n  @GET("users/{id}") suspend fun get(@Path("id") id: Long): UserDto\n}',
  'app/src/main/java/com/example/app/data/UserRepository.kt': 'class UserRepository(private val dao: UserDao, private val api: UserApi) {\n  suspend fun load(email: String) = dao.byEmail(email)\n}',
  'app/src/main/java/com/example/app/ui/UserViewModel.kt': 'class UserViewModel(private val repo: UserRepository) : ViewModel() {\n  private val _state = MutableStateFlow(0)\n  val state: StateFlow<Int> = _state\n}',
  'app/src/main/java/com/example/app/ui/UserActivity.kt': 'class UserActivity : AppCompatActivity() {\n  private val vm: UserViewModel by viewModels()\n}',
  'app/src/main/res/layout/activity_user.xml': '<LinearLayout/>',
};

test('Kotlin MVVM + Room: platform, verified MVVM with evidence, Room entities/DAO/migration, remote API kept separate', () => {
  const r = detectMobile(project(KT_MVVM_ROOM, { init: false }));
  assert.deepEqual(r.platforms.map((p) => p.platform), ['android']);
  const mvvm = find(r, 'MVVM'); assert.equal(mvvm.status, 'verified'); assert.ok(mvvm.evidence.length >= 2 && mvvm.evidence[0].file && mvvm.detectedAt && mvvm.confidence);
  assert.ok(names(r).includes('ViewModel') && names(r).includes('Repository pattern') && names(r).includes('XML layouts'));
  assert.equal(find(r, 'Repository pattern').status, 'verified', 'the ViewModel declares the repository as a constructor type');
  assert.deepEqual(names(r, 'stateManagement'), ['StateFlow']);
  assert.deepEqual(r.dataLayer.local.map((x) => x.name), ['Room']);
  assert.deepEqual(r.dataLayer.remote.map((x) => x.name), ['Retrofit']);
  assert.match(r.dataLayer.remote[0].note, /not the local database/);
  assert.deepEqual(r.dataLayer.daos.map((d) => [d.name, d.queries.map((q) => q.method)]), [['UserDao', ['byEmail', 'insert']]]);
  assert.deepEqual(r.dataLayer.daos[0].queries[0].tables, ['users']);
  assert.equal(r.dataLayer.migrations[0].from, '1');
});
test('dependency chain comes from declared types only: Screen → ViewModel → Repository → DAO/API', () => {
  const r = detectMobile(project(KT_MVVM_ROOM, { init: false }));
  const edges = r.dependencies.edges.map((e) => `${e.from}>${e.to}`);
  assert.ok(edges.includes('screen:UserActivity>viewmodel:UserViewModel'));
  assert.ok(edges.includes('viewmodel:UserViewModel>repository:UserRepository'));
  assert.ok(edges.includes('repository:UserRepository>dao:UserDao') && edges.includes('repository:UserRepository>api:UserApi'));
  assert.ok(r.dependencies.chains.includes('UserActivity → UserViewModel → UserRepository → UserDao'));
  assert.ok(r.dependencies.edges.every((e) => e.file && e.line && e.kind === 'declared-type' && e.status === 'verified'));
});
test('similar names alone create no relationship', () => {
  const r = detectMobile(project({ ...ANDROID_BASE,
    'app/src/main/java/a/OrderRepository.kt': 'class OrderRepository(private val x: Int)',
    'app/src/main/java/a/OrderViewModel.kt': 'class OrderViewModel : ViewModel() { val s = 1 }' }, { init: false }));
  assert.deepEqual(r.dependencies.edges, [], 'OrderViewModel does not reference OrderRepository: no edge');
});
test('Kotlin Compose + Hilt: Compose and Hilt detected; entry point evidence', () => {
  const r = detectMobile(project({ 'app/build.gradle.kts': 'plugins { id("com.android.application") }\ndependencies { implementation("androidx.compose.ui:ui:1.6.0"); implementation("com.google.dagger:hilt-android:2.50") }', 'app/src/main/AndroidManifest.xml': '<manifest/>',
    'app/src/main/java/x/App.kt': '@HiltAndroidApp class App : Application()',
    'app/src/main/java/x/HomeVm.kt': '@HiltViewModel class HomeVm @Inject constructor(private val repo: HomeRepository) : ViewModel()',
    'app/src/main/java/x/HomeRepository.kt': 'class HomeRepository @Inject constructor()',
    'app/src/main/java/x/HomeScreen.kt': '@Composable fun HomeScreen(vm: HomeVm = hiltViewModel()) {}' }, { init: false }));
  assert.ok(names(r).includes('Jetpack Compose') && names(r).includes('Hilt'));
  assert.equal(find(r, 'Hilt').status, 'verified'); assert.ok(!names(r).includes('XML layouts'));
  assert.ok(r.dependencies.edges.some((e) => e.from === 'viewmodel:HomeVm' && e.to === 'repository:HomeRepository'));
});
test('Java Android + SQLiteOpenHelper: local SQLite schema from CREATE TABLE in source; no Room, no MVVM invented', () => {
  const dir = project({ 'app/build.gradle': "apply plugin: 'com.android.application'", 'app/src/main/AndroidManifest.xml': '<manifest/>',
    'app/src/main/java/a/DbHelper.java': 'public class DbHelper extends SQLiteOpenHelper {\n  public void onCreate(SQLiteDatabase db) {\n    db.execSQL("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");\n  }\n}',
    'app/src/main/java/a/MainActivity.java': 'public class MainActivity extends AppCompatActivity { private DbHelper helper; }' }, { init: false });
  const r = detectMobile(dir);
  assert.equal(r.platforms[0].languages.join(), 'java');
  assert.deepEqual(r.dataLayer.local.map((x) => x.name), ['SQLite (SQLiteOpenHelper)']);
  assert.ok(!names(r).includes('MVVM') && !names(r).includes('Room'));
  assert.equal(r.localSchema.tables, 1);
});
test('Flutter Riverpod + Drift', () => {
  const r = detectMobile(project({ 'pubspec.yaml': 'name: app\nenvironment:\n  sdk: ">=3.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_riverpod: ^2.5.0\n  drift: ^2.0.0\n  dio: ^5.0.0\n',
    'lib/db.dart': "class Users extends Table {\n  IntColumn get id => integer().autoIncrement()();\n  TextColumn get email => text()();\n}",
    'lib/repo.dart': 'class UserRepository { final AppDb db; UserRepository(this.db); }\nclass AppDb {}',
    'lib/ui.dart': 'class UserScreen extends ConsumerWidget { final UserRepository repo; UserScreen(this.repo); }' }, { init: false }));
  assert.deepEqual(r.platforms.map((p) => p.platform), ['flutter']);
  assert.deepEqual(names(r, 'stateManagement'), ['Riverpod']);
  assert.deepEqual(r.dataLayer.local.map((x) => x.name), ['Drift']); assert.deepEqual(r.dataLayer.remote.map((x) => x.name), ['dio']);
  assert.equal(r.localSchema.tables, 1);
  assert.ok(r.dependencies.edges.some((e) => e.from === 'screen:UserScreen' && e.to === 'repository:UserRepository'));
});
test('Flutter BLoC + sqflite', () => {
  const r = detectMobile(project({ 'pubspec.yaml': 'name: a\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_bloc: ^8.0.0\n  sqflite: ^2.0.0\n',
    'lib/bloc.dart': 'class CartBloc extends Bloc<CartEvent, CartState> { final CartRepository repo; CartBloc(this.repo) : super(CartState()); }\nclass CartRepository {}',
    'lib/store.dart': "Future<void> create(Database db) => db.execute('CREATE TABLE cart (id INTEGER PRIMARY KEY, sku TEXT NOT NULL)');" }, { init: false }));
  assert.deepEqual(names(r, 'stateManagement'), ['BLoC']); assert.deepEqual(r.dataLayer.local.map((x) => x.name), ['sqflite']);
  assert.equal(r.localSchema.tables, 1);
  assert.ok(r.dependencies.edges.some((e) => e.from === 'bloc:CartBloc' && e.to === 'repository:CartRepository'));
});
test('Flutter without any state-management package: reported as unstructured, no pattern assumed', () => {
  const r = detectMobile(project({ 'pubspec.yaml': 'name: a\ndependencies:\n  flutter:\n    sdk: flutter\n', 'lib/main.dart': 'class Home extends StatefulWidget { void f() { setState(() {}); } }' }, { init: false }));
  assert.deepEqual(r.stateManagement, []); assert.ok(names(r).some((n) => /Unstructured/.test(n)));
  assert.ok(!names(r).includes('MVVM') && !names(r).includes('Repository pattern'));
  assert.equal(find(r, 'Unstructured / setState').status, 'inferred');
});
test('React Native + Zustand: hooks, Zustand, MMKV cache and axios kept in separate data-layer groups', () => {
  const r = detectMobile(project({ 'package.json': JSON.stringify({ dependencies: { 'react-native': '0.74.0', zustand: '4.5.0', 'react-native-mmkv': '2.0.0', axios: '1.0.0', 'expo-sqlite': '14.0.0' } }),
    'src/store.ts': 'export const useCart = create<CartState>()((set) => ({ items: [] }));', 'src/Home.tsx': 'export function Home() { const [a, setA] = useState(0); return null }',
    'src/nav.tsx': '<Stack.Screen name="Home" component={Home} />' }, { init: false }));
  assert.deepEqual(r.platforms.map((p) => p.platform), ['react-native']);
  assert.deepEqual(names(r, 'stateManagement').sort(), ['React hooks', 'Zustand']);
  assert.deepEqual(r.dataLayer.local.map((x) => x.name), ['SQLite']); assert.deepEqual(r.dataLayer.cache.map((x) => x.name), ['MMKV']); assert.deepEqual(r.dataLayer.remote.map((x) => x.name), ['axios']);
  assert.ok(r.navigation.some((n) => n.destination === 'Home'));
});
test('no mobile project: nothing detected, nothing invented', () => {
  const r = detectMobile(project({ 'package.json': '{"dependencies":{"express":"4"}}', 'src/a.js': 'x' }, { init: false }));
  assert.deepEqual(r.platforms, []); assert.deepEqual(r.architecture, []);
});

test('local database knowledge goes to database/local, separate from the backend database, with no device data', () => {
  const dir = project(KT_MVVM_ROOM);
  const r = saveMobile(dir, detectMobile(dir));
  assert.ok(fs.existsSync(path.join(dir, '.rmcontext/database/local')));
  assert.ok(!fs.existsSync(path.join(dir, '.rmcontext/database/backend')));
  for (const f of ['manifest', 'architecture', 'state-management', 'data-layer', 'navigation', 'features', 'dependencies']) assert.ok(fs.existsSync(path.join(dir, `.rmcontext/mobile/${f}.json`)), f);
  const users = showObject(dir, 'table', 'users');
  assert.equal(users.provenance.source, 'orm-definition'); assert.equal(users.scope, 'local'); assert.deepEqual(users.foreignKeys[0].ref.name, 'TeamEntity');
  assert.deepEqual(findObjects(dir, 'email').map((h) => h.scope), ['local']);
  assert.match(fs.readFileSync(path.join(dir, '.rmcontext/mobile/data-layer.json'), 'utf8'), /never the backend database/);
  void r;
});
test('selective context: only the relevant chain and DAO are sent, bounded in size', () => {
  const dir = project(KT_MVVM_ROOM); saveMobile(dir, detectMobile(dir));
  const t = mobileContext(dir, 'add a method to the user repository');
  assert.match(t, /Mobile \(android\)/); assert.match(t, /UserActivity → UserViewModel → UserRepository → UserDao/); assert.match(t, /follow it|state management/);
  assert.ok(t.length <= 1100);
  assert.ok(!/TeamEntity/.test(mobileContext(dir, 'payment gateway')), 'unrelated task: no chains or classes');
});
test('CLI: rmc mobile detect/status/show/find', () => {
  const dir = project(KT_MVVM_ROOM);
  const d = rmc(dir, 'mobile', 'detect'); assert.equal(d.code, 0, d.err); assert.match(d.out, /Mobile: android/); assert.match(d.out, /MVVM \[verified\]/);
  assert.match(rmc(dir, 'mobile', 'status').out, /"platforms"/);
  assert.match(rmc(dir, 'mobile', 'show', 'data-layer').out, /Room/);
  assert.match(rmc(dir, 'mobile', 'find', 'user', 'repository').out, /chain: /);
  assert.ok(loadMobile(dir));
  void ROOT; void spawnSync;
});
