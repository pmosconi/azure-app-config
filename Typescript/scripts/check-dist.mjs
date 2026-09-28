// Post-build check: the real ESM and CJS builds, loaded into one process, share one state.
//
// The unit suite simulates the second build with vi.resetModules() on src/, so nothing there
// looks at dist/. This loads dist/index.mjs and dist/index.js side by side, as a consumer graph
// reaching both would, and asserts what the dual-build fix promises: the registry symbol for this
// package.json version is the one both builds use (a floor armed through one holds the other
// back), resetHydration() from one clears both, errors match across builds, ConfigFloorError is
// still not a ConfigLoadError, and the published types never import @azure/functions.
//
// Plain Node, no dependencies, no Azure. The one attempt it makes goes to an RFC 2606 `.invalid`
// endpoint, which can never resolve, with a stub credential; the provider pads the failure to
// five seconds. Run by prepublishOnly after the build, and as `npm run check:dist`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const esm = await import(pathToFileURL(join(root, 'dist/index.mjs')).href);
const cjs = createRequire(join(root, 'package.json'))(join(root, 'dist/index.js'));

const key = Symbol.for(`@actvalue/azure-app-config/state@${version}`);
const registry = globalThis;
const lines = [];
const logger = { log: m => lines.push(m), error: m => lines.push(m) };
const stubCredential = {
  getToken: async () => ({ token: 'not-a-real-token', expiresOnTimestamp: Date.now() + 3_600_000 }),
};
const options = {
  keys: { 'shared:mongoUrl': 'CHECK_DIST_UNUSED' },
  label: 'prod',
  endpoint: 'https://nope.example.invalid',
  credential: stubCredential,
  timeoutMs: 1_000,
  retryFloorMs: 60_000,
  logger,
};

function check(description, fn) {
  try {
    fn();
    console.log(`ok - ${description}`);
  } catch (error) {
    console.error(`not ok - ${description}`);
    throw error;
  }
}

check('the two builds are separate module instances', () => {
  assert.notEqual(esm.hydrate, cjs.hydrate);
  assert.notEqual(esm.ConfigLoadError, cjs.ConfigLoadError);
  for (const name of ['gated', 'retryAfterMs', 'hydrate', 'hydrateWithBackoff', 'hydrationStatus', 'resetHydration']) {
    assert.equal(typeof esm[name], 'function', `esm exports ${name}`);
    assert.equal(typeof cjs[name], 'function', `cjs exports ${name}`);
  }
});

cjs.resetHydration();
const shared = registry[key];
check(`both builds keep their state under the registry symbol for ${version}`, () => {
  assert.ok(shared && shared.calls instanceof Map, 'the CJS reset created the state under the version key');
  esm.hydrationStatus(options.keys, options.label);
  assert.equal(registry[key], shared, 'the ESM build reads the same object');
});

// Keep the provider's own retry warnings out of the report.
const warn = console.warn;
console.warn = () => {};
const fresh = await esm.hydrate(options).catch(error => error);
console.warn = warn;
const floor = await cjs.hydrate(options).catch(error => error);

check('a floor armed through the ESM build holds the CJS build back', () => {
  assert.ok(fresh instanceof esm.ConfigLoadError, `the attempt failed as a load error: ${fresh}`);
  assert.equal(typeof registry[key].failedAt, 'number', 'the floor was armed in the shared state');
  assert.ok(floor instanceof cjs.ConfigFloorError, `the CJS call was floored: ${floor}`);
  assert.equal(floor.cause, fresh);
  const wait = cjs.retryAfterMs(fresh);
  assert.ok(wait > 0 && wait <= 60_050, `the CJS build measures the ESM build's floor: ${wait}`);
});

check('errors match across builds, and a floor error is still not a load error', () => {
  assert.ok(fresh instanceof cjs.ConfigLoadError);
  assert.ok(floor instanceof esm.ConfigFloorError);
  assert.ok(fresh instanceof Error && floor instanceof Error);
  for (const build of [esm, cjs]) {
    assert.ok(!(floor instanceof build.ConfigLoadError), 'ConfigFloorError is not a ConfigLoadError');
    assert.ok(!(floor instanceof build.ConfigInputError), 'ConfigFloorError is not a ConfigInputError');
    assert.ok(!(fresh instanceof build.ConfigFloorError), 'ConfigLoadError is not a ConfigFloorError');
  }
  const input = new cjs.ConfigInputError('check');
  assert.ok(input instanceof esm.ConfigInputError);
  assert.ok(!(input instanceof esm.ConfigLoadError));
});

check('resetHydration from the CJS build clears the ESM build too', () => {
  assert.equal(esm.hydrationStatus(options.keys, options.label).state, 'failing');
  cjs.resetHydration();
  assert.notEqual(registry[key], shared);
  assert.deepEqual(esm.hydrationStatus(options.keys, options.label), { state: 'none' });
  assert.equal(esm.retryAfterMs(fresh), undefined, 'no floor is left armed');
});

check('the failed attempt was logged once', () => {
  const failures = lines.filter(line => line.startsWith('Configuration load failed: '));
  assert.equal(failures.length, 1, JSON.stringify(lines));
});

check('the published types do not import @azure/functions', () => {
  for (const file of ['dist/index.d.ts', 'dist/index.d.mts']) {
    const types = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(types, /from\s+['"]@azure\/functions['"]|import\(\s*['"]@azure\/functions['"]|require\(\s*['"]@azure\/functions['"]/, file);
  }
  for (const file of ['dist/index.mjs', 'dist/index.js']) {
    const code = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(code, /['"]@azure\/functions['"]/, file);
  }
});

console.log(`dist check passed for ${version}`);
// The provider may leave an unref'd timer or a socket behind; the verdict is in.
process.exit(0);
