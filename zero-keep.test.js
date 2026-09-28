// Z0 set before a Tool Length Reference (the gSender habit) must survive every
// tool setter path. Run: node zero-keep.test.js
const fs = require('fs'); const vm = require('vm'); const path = require('path');
function run(_plugin, command, ms, settingsRaw = {}, tools = []) {
  const code = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8').replace(/^export \{[^}]*\};?\s*$/m, '');
  const ctx = { console, pluginContext: { armTlsWriteback() {}, getFirmwareSetting() { return null; } } };
  vm.createContext(ctx);
  vm.runInContext(code + '\n;this.__api = { onBeforeCommand, buildInitialConfig };', ctx);
  const settings = ctx.__api.buildInitialConfig(settingsRaw);
  const cmds = [{ command, isOriginal: true, displayCommand: null }];
  return { lines: ctx.__api.onBeforeCommand(cmds, { machineState: ms, tools, safeZHeight: -5 }, settings).map(c => c.command) };
}
const assert = require('assert');
const cfg = { toolSetter: { x: 10, y: 20, z: -80 }, parking: { x: 100, y: 50, z: 0 }, numberOfTools: 6 };
const base = { tool: 1, toolLengthSet: false, zeroSetWithoutTlr: false, zeroTool: 0, mpos: { x: 250, y: 300, z: -20 } };
const idx = (lines, re) => lines.findIndex(l => re.test(l));
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('M6 with a pending Z0 measures the old tool first, then keeps Z0 via the reference', () => {
  const { lines } = run('manualtoolchange', 'M6 T2', { ...base, zeroSetWithoutTlr: true, zeroTool: 1 }, cfg);
  const ref = idx(lines, /#<_nc_ref_tlo> = #<_rc_trigger_mach_z>/);
  const unload = idx(lines, /Unload current tool T1/);
  const g10 = idx(lines, /G10 L2 P\[#5220\] Z\[#<_cur_wcs_z_ofs> - #<_nc_ref_tlo>\]/);
  const notify = lines.lastIndexOf('$#=_tool_offset');
  assert(ref >= 0 && unload > ref, 'reference measure before unload');
  assert(g10 > unload && g10 > notify, 'G10 after the new tool offset is applied and announced');
  assert.equal(lines.filter(l => /G10 L2/.test(l)).length, 1, 'exactly one work-offset write');
  assert.equal(lines.filter(l => /^\$#=_tool_offset$/.test(l)).length, 1, 'reference measure does not announce a TLR');
});
t('M6 without a pending Z0 is unchanged: no reference measure, no G10', () => {
  const { lines } = run('manualtoolchange', 'M6 T2', base, cfg);
  assert.equal(idx(lines, /_nc_ref_tlo/), -1); assert.equal(idx(lines, /G10 L2/), -1);
});
t('M6 when a different tool is in the spindle than the one that zeroed: no keeping', () => {
  const { lines } = run('manualtoolchange', 'M6 T2', { ...base, zeroSetWithoutTlr: true, zeroTool: 3 }, cfg);
  assert.equal(idx(lines, /G10 L2/), -1);
});
t('M6 T0 with a pending Z0 establishes the reference with the current tool before unloading', () => {
  const { lines } = run('manualtoolchange', 'M6 T0', { ...base, zeroSetWithoutTlr: true, zeroTool: 1 }, cfg);
  const g10 = idx(lines, /G10 L2 P\[#5220\] Z\[#<_cur_wcs_z_ofs> - #<_rc_trigger_mach_z>\]/);
  assert(g10 >= 0 && g10 < idx(lines, /Unload current tool T1/));
});
t('$TLS with a pending Z0 keeps it (keepSelf)', () => {
  const { lines } = run('manualtoolchange', '$TLS', { ...base, zeroSetWithoutTlr: true, zeroTool: 1 }, cfg);
  const g10 = idx(lines, /G10 L2 P\[#5220\] Z\[#<_cur_wcs_z_ofs> - #<_rc_trigger_mach_z>\]/);
  assert(g10 > lines.indexOf('$#=_tool_offset'));
});
t('$TLS once a reference exists never writes the work offset', () => {
  const { lines } = run('manualtoolchange', '$TLS', { ...base, toolLengthSet: true, zeroSetWithoutTlr: true, zeroTool: 1 }, cfg);
  assert.equal(idx(lines, /G10 L2/), -1);
});
t('M6 returns to the pre-change XY at safe Z before handing back to the job', () => {
  const { lines } = run('manualtoolchange', 'M6 T2', base, cfg);
  const back = idx(lines, /^G53 G0 X250 Y300$/);
  assert(back > idx(lines, /Load new tool T2/), 'return after the load/TLS');
  assert(/G53 G0 Z-5/.test(lines[back - 1]), 'at safe Z');
});
t('the extra measure is wrapped in ZERO_KEEP markers for the UI banner', () => {
  const { lines } = run('manualtoolchange', 'M6 T2', { ...base, zeroSetWithoutTlr: true, zeroTool: 1 }, cfg);
  const a = lines.indexOf('(MSG, ZERO_KEEP_START T1)'), b = lines.indexOf('(MSG, ZERO_KEEP_END)');
  assert(a >= 0 && b > a, 'markers present and ordered');
  assert(lines.slice(a, b).some(l => /G38\.2/.test(l)), 'the touch-off is inside the markers');
  assert.equal(run('manualtoolchange', 'M6 T2', base, cfg).lines.indexOf('(MSG, ZERO_KEEP_START T1)'), -1, 'no markers without a pending Z0');
});
t('$H passes through untouched: no tool setter run after homing', () => {
  assert.deepEqual(run('manualtoolchange', '$H', { ...base, zeroSetWithoutTlr: true, zeroTool: 1 }, { ...cfg, performTlsAfterHome: true }).lines, ['$H']);
});
console.log(n, 'passed');
