// Run: node --test legacy-probe.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8') +
  '\nthis.api = { buildInitialConfig, onBeforeCommand };', context);
const { buildInitialConfig, onBeforeCommand } = context.api;

function run(command, tool, raw = {}, machineState = {}) {
  const settings = buildInitialConfig({
    toolSetter: { x: 10, y: 20, z: -80 },
    numberOfTools: 6,
    legacyProbe: true,
    ...raw
  });
  return Array.from(onBeforeCommand([{ command, isOriginal: true }], {
    machineState: { tool, ...machineState }, tools: [], safeZHeight: -5
  }, settings), item => item.command);
}

function assertLegacyTouch(lines, delay) {
  const first = lines.indexOf('G38.2 G91 Z-50 F100');
  assert(first >= 0);
  assert.deepEqual(lines.slice(first, first + 5), [
    'G38.2 G91 Z-50 F100',
    `G4 P${delay}`,
    'G0 G91 Z1',
    `G4 P${delay}`,
    'G38.2 G91 Z-1 F25'
  ]);
  assert(!lines.some(line => line.startsWith('G38.4')));
}

for (const tool of [1, 99]) {
  test(`$TLS uses two legacy touches for T${tool}`, () => {
    assertLegacyTouch(run('$TLS', tool), 0.5);
  });
}

test('M6 uses legacy probing for an ordinary cutting tool', () => {
  assertLegacyTouch(run('M6 T2', 1, { secondProbeDelay: 0.7 }), 0.7);
});

test('a pending Z0 uses legacy probing for both reference and new tool', () => {
  const lines = run('M6 T2', 1, { secondProbeDelay: 0.7 }, {
    zeroSetWithoutTlr: true, zeroTool: 1, toolLengthSet: false
  });
  assert.equal(lines.filter(line => line === 'G38.2 G91 Z-50 F100').length, 2);
  assert.equal(lines.filter(line => line === 'G4 P0.7').length, 4);
  assert.equal(lines.filter(line => line === 'G38.2 G91 Z-1 F25').length, 2);
  assert(!lines.some(line => line.startsWith('G38.4')));
  assert(lines.includes('G10 L2 P[#5220] Z[#<_cur_wcs_z_ofs> - #<_nc_ref_tlo>]'));
});

test('legacy delay accepts zero and clamps invalid or out-of-range settings', () => {
  for (const [value, expected] of [[0, 0], [-1, 0], [8, 5], ['invalid', 0.5]]) {
    assertLegacyTouch(run('$TLS', 1, { secondProbeDelay: value }), expected);
  }
});

test('modern probing retains its release touch and fixed wait', () => {
  const lines = run('$TLS', 1, { legacyProbe: false, secondProbeDelay: 0.7 });
  const first = lines.indexOf('G38.2 G91 Z-50 F100');
  assert.deepEqual(lines.slice(first, first + 3), [
    'G38.2 G91 Z-50 F100', 'G4 P0.2', 'G38.4 G91 Z5 F75'
  ]);
  assert(!lines.includes('G4 P0.7'));
});
