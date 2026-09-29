/**
 * Manual ToolChanger - Command Processor
 * Pure command processing logic for manual tool change workflow.
 * Runs on Node.js natively OR on .NET via Jint.
 * No import/require/fetch/ctx — pure input→output.
 *
 * Copyright (C) 2024 Francis Marasigan
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// === Constants ===

const PROBE_TOOL_NUMBER = 99;

// === M6 Pattern Matching (inlined from gcode-patterns.js) ===

const M6_PATTERN = /(?:^|[^A-Z])M0*6(?:\s*T0*(\d+)|(?=[^0-9T])|$)|(?:^|[^A-Z])T0*(\d+)\s*M0*6(?:[^0-9]|$)/i;

function isGcodeComment(command) {
  const trimmed = command.trim();
  const withoutLineNumber = trimmed.replace(/^N\d+\s*/i, '');
  if (withoutLineNumber.startsWith(';')) {
    return true;
  }
  if (withoutLineNumber.startsWith('(') && withoutLineNumber.endsWith(')')) {
    return true;
  }
  return false;
}

function parseM6Command(command) {
  if (!command || typeof command !== 'string') {
    return null;
  }
  if (isGcodeComment(command)) {
    return null;
  }
  const normalizedCommand = command.trim().toUpperCase();
  const match = normalizedCommand.match(M6_PATTERN);
  if (!match) {
    return null;
  }
  const toolNumberStr = match[1] || match[2];
  const toolNumber = toolNumberStr ? parseInt(toolNumberStr, 10) : null;
  return {
    toolNumber: Number.isFinite(toolNumber) ? toolNumber : null,
    matched: true
  };
}

// === Sanitization / Validation Helpers ===

const toFiniteNumber = (value, fallback = 0) => {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
};

// Re-indent a user-authored g-code block so it lines up with the macro
// it gets spliced into. Blank lines are dropped — an empty setting
// contributes nothing at all, not a stray newline.
function indentBlock(text) {
  if (!text) return '';
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  return lines.join('\n    ');
}

function auxOnOff(auxOutput) {
  if (auxOutput === 'M7' || auxOutput === 'M8') return { on: auxOutput, off: 'M9' };
  if (typeof auxOutput === 'number' && auxOutput >= 0) {
    return { on: `M64 P${auxOutput}`, off: `M65 P${auxOutput}` };
  }
  return { on: '', off: '' };
}

// The old "Aux Output during TLS" dropdown is gone — Pre/Post TLS events
// cover it and more. Configs saved with the dropdown are converted to
// the equivalent event g-code on first load, so an existing toolsetter
// that needed an aux pulse keeps working without the operator retyping it.
function migrateLegacyTlsAux(auxOutput, action) {
  if (auxOutput === undefined || auxOutput === null || auxOutput === -1) return '';
  const { on, off } = auxOnOff(auxOutput);
  const cmd = action === 'on' ? on : off;
  return cmd ? `G4 P0\n${cmd}\nG4 P0` : '';
}

const sanitizeCoords = (coords = {}) => ({
  x: toFiniteNumber(coords.x),
  y: toFiniteNumber(coords.y),
  z: toFiniteNumber(coords.z)
});

const buildInitialConfig = (raw = {}) => {
  
  return {
    // Position Settings
    pocket1: sanitizeCoords(raw.pocket1),
    toolSetter: sanitizeCoords(raw.toolSetter),
    parking: sanitizeCoords(raw.parking),

    // Tool Settings
    numberOfTools: toFiniteNumber(raw.numberOfTools, 1),

    // UI Toggle Settings
    autoSwap: raw.autoSwap === true,
    pauseBeforeUnload: raw.pauseBeforeUnload !== false,
    showMacroCommand: raw.showMacroCommand ?? false,
    waitForSpindle: raw.waitForSpindle !== false,

    // Advanced Settings (no UI, JSON only)
    // Z-axis Settings
    zEngagement: toFiniteNumber(raw.zEngagement, -50),
    zSafe: toFiniteNumber(raw.zSafe, 0),
    zSpinOff: toFiniteNumber(raw.zSpinOff, 23),
    zRetreat: toFiniteNumber(raw.zRetreat, 12),

    // Tool Change Settings
    unloadRpm: toFiniteNumber(raw.unloadRpm, 1500),
    loadRpm: toFiniteNumber(raw.loadRpm, 1200),
    engageFeedrate: toFiniteNumber(raw.engageFeedrate, 3500),

    // Tool Length Setter Settings
    zProbeStart: toFiniteNumber(raw.zProbeStart, -10),
    seekDistance: toFiniteNumber(raw.seekDistance, 50),
    seekFeedrate: toFiniteNumber(raw.seekFeedrate, 100),

    // Probe Tool Settings
    addProbe: raw.addProbe ?? false,
    probeLoadGcode: raw.probeLoadGcode ?? '',
    probeUnloadGcode: raw.probeUnloadGcode ?? '',
    legacyProbe: raw.legacyProbe ?? false,
    secondSeekDistance: toFiniteNumber(raw.secondSeekDistance, 1),
    secondSeekFeedrate: toFiniteNumber(raw.secondSeekFeedrate, 25),

    // Tool Change Events (Pre/Post TLS defaults migrate the legacy
    // tlsAuxOutput dropdown into equivalent M64/M65 or M7/M8 blocks
    // on first read — see migrateLegacyTlsAux).
    preToolChangeGcode: raw.preToolChangeGcode ?? '',
    postToolChangeGcode: raw.postToolChangeGcode ?? '',
    preTlsGcode: raw.preTlsGcode ?? migrateLegacyTlsAux(raw.tlsAuxOutput, 'on'),
    postTlsGcode: raw.postTlsGcode ?? migrateLegacyTlsAux(raw.tlsAuxOutput, 'off'),
    abortEventGcode: raw.abortEventGcode ?? ''
  };
};

// === Tool Offset Lookup (pure, from pre-fetched array) ===

// A T number names a slot first, then a Tool ID — the order the app itself
// uses — so a tool that isn't in any slot still gets its own offsets rather
// than silently getting none. Offsets belong to the tool, never the slot.
function findTool(toolNumber, tools) {
  return tools.find((t) => t.toolNumber === toolNumber)
    || tools.find((t) => t.toolId === toolNumber);
}

function getToolOffsets(toolNumber, tools) {
  if (!toolNumber || toolNumber <= 0 || !Array.isArray(tools)) {
    return { x: 0, y: 0, z: 0 };
  }
  const tool = findTool(toolNumber, tools);
  if (tool && tool.offsets) {
    return { x: tool.offsets.x || 0, y: tool.offsets.y || 0, z: tool.offsets.tlsZ || 0 };
  }
  return { x: 0, y: 0, z: 0 };
}

// === G-code Generation Helpers ===

const formatGCode = (gcode) => {
  return gcode
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
};

// === Routine Generators ===

// === Keeping a Z0 that was set before any Tool Length Reference ===
//
// The offset this plugin applies is absolute: G43.1 Z<machine Z where the
// tool touched the setter>. Work Z = machine Z - G5x Z - TLO. A Z0 set
// AFTER a reference exists is therefore right for every tool. A Z0 set
// BEFORE one (TLO still 0) goes wrong the moment the first TLS applies an
// offset: every tool is then shifted by the whole touch height and the
// next cut plunges. That is the "zero first, TLS later" habit gSender
// users bring with them.
//
// The host reports it (machineState.zeroSetWithoutTlr / zeroTool). While
// the tool that set that Z0 is still the one in the spindle we can keep it:
// the first offset we apply is paid back in the work offset, so
// G5x Z + TLO does not change.
//   'keepSelf'  measure this tool, apply its offset, shift G5x Z by it.
//   'reference' measure the tool that set Z0 and only remember its touch
//               height (#<_nc_ref_tlo>); nothing is applied yet.
//   'keepRef'   measure the new tool, apply its offset, shift G5x Z by the
//               remembered height. Net result: the new tool's tip is right
//               relative to the Z0 the operator set with the old one.
// The work offset is written only after the new offset is active and the
// host has been told, so it never looks like a fresh unreferenced Z0.
function zeroKeepPlan(context, currentTool) {
  const ms = (context && context.machineState) || {};
  const pending = ms.zeroSetWithoutTlr === true && ms.toolLengthSet !== true;
  const zeroTool = typeof ms.zeroTool === 'number' ? ms.zeroTool : 0;
  return { keep: pending && zeroTool === currentTool, swapped: pending && zeroTool !== currentTool };
}

function createToolLengthSetRoutine(settings, toolOffsets = { x: 0, y: 0, z: 0 }, toolNumber, options = {}) {
  const tlsX = settings.toolSetter.x + (toolOffsets.x || 0);
  const tlsY = settings.toolSetter.y + (toolOffsets.y || 0);
  const tlsZ = toolOffsets.z || 0;
  const fineProbeFeedrate = settings.seekFeedrate < 75 ? settings.seekFeedrate : 75;
  const legacyProbe = settings.legacyProbe;

  // Pre/Post TLS user events (replaces the old "Aux Output during TLS"
  // dropdown — configs saved with that dropdown are migrated into
  // these two blocks in buildInitialConfig, so nothing regresses).
  const preTls  = indentBlock(settings.preTlsGcode);
  const postTls = indentBlock(settings.postTlsGcode);

  // Safety descent from safe Z down to the toolsetter altitude
  // (toolSetter.z + the tool library's per-tool Z bias). Instead of
  // rapiding blind with G0, use G38.3 as a "probe toward" — same fast
  // motion (grblHAL clamps F99999 to the machine Z max rate $112) but
  // if the tool contacts the sensor early (misconfigured toolSetter.z,
  // tool longer than expected, etc.) the machine HALTS at contact
  // instead of crashing. The follow-up G38.2 seek will then error
  // with "probe already triggered", surfacing the problem to the
  // operator. When the target is above safe Z (positive tlsZ), just
  // do a normal G0 raise — nothing to crash into going up.
  const approachDelta = (settings.toolSetter.z + tlsZ) - settings.zSafe;
  const approach = approachDelta < 0
    ? `G38.3 G91 Z${approachDelta.toFixed(3)} F99999\n    G90`
    : approachDelta > 0
      ? `G91 G0 Z${approachDelta.toFixed(3)}\n    G90`
      : '';

  let probeCommand = '';
  if (legacyProbe && toolNumber === PROBE_TOOL_NUMBER) {
    const secondSeekDistance = settings.secondSeekDistance || 1;
    const secondSeekFeedrate = settings.secondSeekFeedrate || 25;
   
    probeCommand = `
    G38.2 G91 Z-${settings.seekDistance} F${settings.seekFeedrate}
    G4 P0.2
    G0 G91 Z${secondSeekDistance}
    G4 P0.2
    G38.2 G91 Z-${secondSeekDistance} F${secondSeekFeedrate}`
  } else {
    probeCommand = `
    G38.2 G91 Z-${settings.seekDistance} F${settings.seekFeedrate}
    G4 P0.2
    G38.4 G91 Z5 F${fineProbeFeedrate}`;
  }

  const mode = options.mode || 'normal';
  const applyOffset = mode === 'reference'
    ? `(Remember the touch height of the tool that set Z0)
    #<_nc_ref_tlo> = #<_rc_trigger_mach_z>`
    : `G43.1 Z[#<_rc_trigger_mach_z>]
    (Notify ncSender that toolLengthSet is now set)
    $#=_tool_offset${mode === 'keepSelf' ? `
    (Keep the Z0 that was set before this reference)
    G10 L2 P[#5220] Z[#<_cur_wcs_z_ofs> - #<_rc_trigger_mach_z>]` : ''}${mode === 'keepRef' ? `
    (Keep the Z0 that was set with the previous tool)
    G10 L2 P[#5220] Z[#<_cur_wcs_z_ofs> - #<_nc_ref_tlo>]` : ''}`;

  return `
    G53 G0 Z${settings.zSafe}
    G53 G0 X${tlsX} Y${tlsY}
    ${approach}
    ${preTls}
    G43.1 Z0
    ${probeCommand}
    G91 G0 Z5
    G90
    ${postTls}
    #<_ofs_idx> = [#5220 * 20 + 5203]
    #<_cur_wcs_z_ofs> = #[#<_ofs_idx>]
    #<_rc_trigger_mach_z> = [#5063 + #<_cur_wcs_z_ofs>]
    ${applyOffset}
    G53 G91 G0 Z${settings.zSafe}
  `.trim();
}

function isManualTool(toolNumber, settings) {
  return toolNumber > settings.numberOfTools;
}

function createToolUnload(settings, currentTool, targetTool) {
  const useRCS = settings.autoSwap && !isManualTool(currentTool, settings);
  const messageCode = useRCS ? `PLUGIN_MANUALTOOLCHANGE:UNLOAD_MESSAGE_${currentTool}` : `PLUGIN_MANUALTOOLCHANGE:UNLOAD_MESSAGE_MANUAL_${currentTool}`;
  const needsPause = settings.pauseBeforeUnload;
  const confirmationLines = needsPause ? `
    G4 P0
    (MSG, ${messageCode})
    M0` : '';

  if (useRCS) {
    const pauseSequence = needsPause ? `
      G53 G0 X${settings.parking.x} Y${settings.parking.y}
      ${confirmationLines}
      G53 G0 X${settings.pocket1.x} Y${settings.pocket1.y}` : `
      G53 G0 X${settings.pocket1.x} Y${settings.pocket1.y}`;

    const moveToManualAfterUnload = targetTool !== 0 ? `
      G53 G0 X${settings.parking.x} Y${settings.parking.y}` : '';

    const g65p6 = settings.waitForSpindle ? '' : 'G65P6';

    return `
      G53 G0 Z${settings.zSafe}
      ${pauseSequence}
      G53 G0 Z${settings.zEngagement + settings.zSpinOff}
      ${g65p6}
      M4 S${settings.unloadRpm}
      G53 G1 Z${settings.zEngagement} F${settings.engageFeedrate}
      G53 G1 Z${settings.zEngagement + settings.zRetreat} F${settings.engageFeedrate}
      ${g65p6}
      M5
      M61 Q0
      G53 G0 Z${settings.zSafe}
      ${moveToManualAfterUnload}
    `.trim();
  } else {
    const isUnloadOnly = targetTool === 0;
    const manualConfirmation = isUnloadOnly ? `
      G4 P0
      (MSG, ${messageCode})
      M0` : '';

    return `
      G53 G0 Z${settings.zSafe}
      G53 G0 X${settings.parking.x} Y${settings.parking.y}
      G53 G0 Z0
      ${manualConfirmation}
      M61 Q0
    `.trim();
  }
}

function createToolLoad(settings, toolNumber, hasUnload, currentTool) {
  const wasManualUnload = hasUnload && isManualTool(currentTool, settings);
  const useRCS = settings.autoSwap && !isManualTool(toolNumber, settings);
  const messageCode = useRCS
    ? (wasManualUnload ? `PLUGIN_MANUALTOOLCHANGE:LOAD_AFTER_MANUAL_MESSAGE_${toolNumber}` : `PLUGIN_MANUALTOOLCHANGE:LOAD_MESSAGE_${toolNumber}`)
    : (wasManualUnload ? `PLUGIN_MANUALTOOLCHANGE:SWAP_MESSAGE_MANUAL_${toolNumber}` : `PLUGIN_MANUALTOOLCHANGE:LOAD_MESSAGE_MANUAL_${toolNumber}`);

  const moveToManualLocation = hasUnload ? '' : `
      G53 G0 Z${settings.zSafe}
      G53 G0 X${settings.parking.x} Y${settings.parking.y}`;

  if (useRCS) {
    const g65p6 = settings.waitForSpindle ? '' : 'G65P6';

    return `
      ${moveToManualLocation}
      G4 P0
      (MSG, ${messageCode})
      M0
      G53 G0 Z${settings.zSafe}
      G53 G0 X${settings.pocket1.x} Y${settings.pocket1.y}
      G53 G0 Z${settings.zEngagement + settings.zSpinOff}
      ${g65p6}
      M3 S${settings.loadRpm}
      G53 G1 Z${settings.zEngagement} F${settings.engageFeedrate}
      G53 G1 Z${settings.zEngagement + settings.zRetreat} F${settings.engageFeedrate}
      G53 G1 Z${settings.zEngagement} F${settings.engageFeedrate}
      G53 G1 Z${settings.zEngagement + settings.zRetreat} F${settings.engageFeedrate}
      G53 G1 Z${settings.zEngagement} F${settings.engageFeedrate}
      G53 G1 Z${settings.zEngagement + settings.zRetreat} F${settings.engageFeedrate}
      ${g65p6}
      M5
      M61 Q${toolNumber}
      G53 G0 Z${settings.zSafe}
    `.trim();
  } else {
    return `
      ${moveToManualLocation}
      G53 G0 Z0
      G4 P0
      (MSG, ${messageCode})
      M0
      M61 Q${toolNumber}
      G53 G0 Z${settings.zSafe}
    `.trim();
  }
}

function buildUnloadTool(settings, currentTool, targetTool) {
  if (currentTool === 0) {
    return '';
  }

  if (currentTool === PROBE_TOOL_NUMBER) {
    const probeUnloadGcode = settings.probeUnloadGcode?.trim() || '';
    if (probeUnloadGcode) {
      return `
        (Unload Probe Tool T${PROBE_TOOL_NUMBER})
        G53 G0 Z${settings.zSafe}
        ${probeUnloadGcode}
        M61 Q0
      `.trim();
    } else {
      return `
        (Unload Probe Tool T${PROBE_TOOL_NUMBER})
        G53 G0 Z${settings.zSafe}
        G53 G0 X${settings.parking.x} Y${settings.parking.y}
        G53 G0 Z0
        G4 P0
        (MSG, PLUGIN_MANUALTOOLCHANGE:MANUAL_UNLOAD_PROBE_${PROBE_TOOL_NUMBER})
        M0
        M61 Q0
      `.trim();
    }
  }

  return `
    (Unload current tool T${currentTool})
    ${createToolUnload(settings, currentTool, targetTool)}
  `.trim();
}

function buildLoadTool(settings, toolNumber, tlsRoutine, hasUnload, currentTool) {
  if (toolNumber === 0) {
    return '';
  }

  if (toolNumber === PROBE_TOOL_NUMBER) {
    const probeLoadGcode = settings.probeLoadGcode?.trim() || '';
    if (probeLoadGcode) {
      return `
        (Load Probe Tool T${PROBE_TOOL_NUMBER})
        G53 G0 Z${settings.zSafe}
        M61 Q${PROBE_TOOL_NUMBER}
        ${probeLoadGcode}
        ${tlsRoutine}
      `.trim();
    } else {
      return `
        (Load Probe Tool T${PROBE_TOOL_NUMBER})
        G53 G0 Z${settings.zSafe}
        G53 G0 X${settings.parking.x} Y${settings.parking.y}
        G53 G0 Z0
        G4 P0
        (MSG, PLUGIN_MANUALTOOLCHANGE:MANUAL_LOAD_PROBE_${PROBE_TOOL_NUMBER})
        M0
        M61 Q${PROBE_TOOL_NUMBER}
        ${tlsRoutine}
      `.trim();
    }
  }

  return `
    (Load new tool T${toolNumber})
    ${createToolLoad(settings, toolNumber, hasUnload, currentTool)}
    ${tlsRoutine}
  `.trim();
}

// A user's Pre/Post Tool Change g-code deliberately runs in the PROGRAM's
// units, not the plugin's: it is spliced outside the G21 wrapper that makes
// the plugin's own (millimetre) config correct. That stays -- someone running
// an inch post is thinking in inches, and the snippet reads as part of their
// program.
//
// What must not survive is a modal word set inside the snippet. Write G21 in
// Post Tool Change "to be safe" on an inch program and every remaining line
// of the job silently becomes millimetres; write G91 and the rest goes
// incremental. Either corrupts the whole run with no error and no clue at the
// machine -- the same shape as the dropped-line bug that cost a customer a
// job, arriving by a different door.
//
// So the snippet is bracketed: capture units and distance mode before it, put
// them back after. grblHAL exposes both read-only (_metric, _absolute).
// Feed is deliberately NOT restored: #<_feed> is 0 until the program sets
// one, and emitting F0 is worse than the leak it would prevent. Most posts
// re-state F on the next cutting move.
function modalSafe(snippet, tag) {
  const body = String(snippet || '').trim();
  if (!body) return '';
  return `#<${tag}_units> = [20 + #<_metric>]
    #<${tag}_dist> = [91 - #<_absolute>]
    ${body}
    G[#<${tag}_units>]
    G[#<${tag}_dist>]`;
}

// The operator's spindle override (Ov: in the status report) must not scale
// the load/unload RPM: those speeds were tuned at 100% and a 50% override
// would leave the collet nut under-torqued. M51 P0 makes grblHAL apply
// programmed RPM regardless of the override, without touching the stored
// percentage -- so the job resumes at exactly the override the operator set.
// #<_speed_override> is the pre-existing enable state (a program may have
// disabled overrides itself), so restore what was there, not a hard-coded on.
// options.keepZero      — Z0 was set with the tool in the spindle before any
//                         reference existed; carry it over (see zeroKeepPlan).
// options.currentOffsets — tool library offsets of the tool in the spindle.
// options.returnTo       — machine XY to go back to at safe Z once the change
//                         is done, so the job's spindle start happens where
//                         the job left off rather than above the tool setter.
function buildToolChangeProgram(settings, currentTool, toolNumber, toolOffsets = { x: 0, y: 0 }, options = {}) {
  const keepZero = !!options.keepZero;
  // Measuring the tool that set Z0 first only matters when a new tool will
  // be measured after it; for an unload-only change, fix the reference now.
  const keepViaReference = keepZero && toolNumber !== 0;
  const tlsRoutine = createToolLengthSetRoutine(settings, toolOffsets, toolNumber,
    { mode: keepViaReference ? 'keepRef' : 'normal' });
  const zeroKeepSection = keepZero
    ? `(Measure T${currentTool} first: it set Z0 before a tool length reference existed)
    (MSG, ZERO_KEEP_START T${currentTool})
    ${createToolLengthSetRoutine(settings, options.currentOffsets || { x: 0, y: 0, z: 0 }, currentTool,
      { mode: keepViaReference ? 'reference' : 'keepSelf' })}
    G53 G0 Z${settings.zSafe}
    (MSG, ZERO_KEEP_END)`
    : '';
  const returnTo = options.returnTo;
  const returnSection = returnTo && isFinite(returnTo.x) && isFinite(returnTo.y)
    ? `G53 G0 X${returnTo.x} Y${returnTo.y}`
    : '';
  const hasUnload = currentTool !== 0;

  const unloadSection = buildUnloadTool(settings, currentTool, toolNumber);
  const loadSection = buildLoadTool(settings, toolNumber, tlsRoutine, hasUnload, currentTool);

  const preToolChangeCmd = settings.preToolChangeGcode?.trim() || '';
  const postToolChangeCmd = settings.postToolChangeGcode?.trim() || '';

  // Post Tool Change runs once the new tool is in, at safe Z, BEFORE the move
  // back to where the change started. It used to run after that move: a
  // routine that picks up a dust shoe drove back to the work first, went off
  // to the dust shoe, and the job then moved back again. The event runs in the
  // program's units (modalSafe), then millimetres and safe Z again for the
  // return. With no return move (older host) it stays at the very end.
  const postBeforeReturn = postToolChangeCmd && returnSection
    ? `G4 P0
    G[#<return_units>]
    ${modalSafe(postToolChangeCmd, 'post')}
    G21
    G53 G0 Z${settings.zSafe}`
    : '';

  const gcode = `
    (Start of Manual ToolChanger Sequence)
    ${modalSafe(preToolChangeCmd, 'pre')}
    #<return_units> = [20 + #<_metric>]
    #<return_spov> = #<_speed_override>
    G21
    M51 P0
    M5
    ${zeroKeepSection}
    ${unloadSection}
    ${loadSection}
    G53 G0 Z${settings.zSafe}
    ${postBeforeReturn}
    ${returnSection}
    M51 P[#<return_spov>]
    G[#<return_units>]
    G90
    ${postBeforeReturn ? '' : modalSafe(postToolChangeCmd, 'post')}
    (End of Manual ToolChanger Sequence)
  `.trim();

  return formatGCode(gcode);
}

// === Command Handlers (synchronous, no host dependency) ===

function handleTLSCommand(commands, context, settings) {
  const tlsIndex = commands.findIndex(cmd =>
    cmd.isOriginal && cmd.command.trim().toUpperCase() === '$TLS'
  );

  if (tlsIndex === -1) {
    return;
  }

  const currentTool = context.machineState?.tool ?? 0;
  const toolOffsets = getToolOffsets(currentTool, context.tools);

  const tlsCommand = commands[tlsIndex];
  const toolLengthSetRoutine = createToolLengthSetRoutine(settings, toolOffsets, currentTool,
    { mode: zeroKeepPlan(context, currentTool).keep ? 'keepSelf' : 'normal' });

  const preToolChangeCmd = settings.preToolChangeGcode?.trim() || '';
  const postToolChangeCmd = settings.postToolChangeGcode?.trim() || '';

  const gcode = `
    (Start of Tool Length Setter)
    ${modalSafe(preToolChangeCmd, 'pre')}
    #<return_units> = [20 + #<_metric>]
    G21
    ${toolLengthSetRoutine}
    G53 G0 Z${settings.zSafe}
    G[#<return_units>]
    G90
    ${modalSafe(postToolChangeCmd, 'post')}
    (End of Tool Length Setter)
  `.trim();
  const tlsProgram = formatGCode(gcode);
  const showMacroCommand = settings.showMacroCommand ?? false;

  const expandedCommands = tlsProgram.map((line, index) => {
    if (index === 0) {
      return {
        command: line,
        displayCommand: showMacroCommand ? null : tlsCommand.command.trim(),
        isOriginal: false
      };
    } else {
      return {
        command: line,
        displayCommand: null,
        isOriginal: false,
        meta: showMacroCommand ? {} : { silent: true }
      };
    }
  });

  commands.splice(tlsIndex, 1, ...expandedCommands);
}

function handlePocket1Command(commands, settings) {
  const pocket1Index = commands.findIndex(cmd =>
    cmd.isOriginal && cmd.command.trim().toUpperCase() === '$POCKET1'
  );

  if (pocket1Index === -1) {
    return;
  }

  const pocket1Command = commands[pocket1Index];
  const gcode = `
    G53 G21 G90 G0 Z${settings.zSafe}
    G53 G21 G90 G0 X${settings.pocket1.x} Y${settings.pocket1.y}
  `.trim();

  const pocket1Program = formatGCode(gcode);
  const showMacroCommand = settings.showMacroCommand ?? false;

  const expandedCommands = pocket1Program.map((line, index) => {
    if (index === 0) {
      return {
        command: line,
        displayCommand: showMacroCommand ? null : pocket1Command.command.trim(),
        isOriginal: false
      };
    } else {
      return {
        command: line,
        displayCommand: null,
        isOriginal: false,
        meta: showMacroCommand ? {} : { silent: true }
      };
    }
  });

  commands.splice(pocket1Index, 1, ...expandedCommands);
}


// Returns 'proceed' | 'stopped' | 'pause' — see RapidChangeATC's
// matching helper for the semantics. Only fires when RapidChangeSolo
// (autoSwap) is enabled; manual tool swaps don't spin the spindle.
function confirmSpindleRpmSafety(settings) {
  if (!settings.autoSwap) return 'proceed';
  if (typeof pluginContext === 'undefined'
      || !pluginContext
      || typeof pluginContext.getFirmwareSetting !== 'function') {
    return 'proceed';
  }
  const minRpm = pluginContext.getFirmwareSetting('31');
  if (minRpm === null || minRpm === undefined || !isFinite(minRpm)) return 'proceed';
  const soloRpmFloor = Math.min(settings.loadRpm, settings.unloadRpm);
  if (minRpm <= soloRpmFloor) return 'proceed';

  if (typeof pluginContext.askGate !== 'function') return 'proceed';
  const choice = pluginContext.askGate({
    title: 'Spindle RPM clamp above Solo RPM',
    message:
      'Firmware $31 (minimum spindle RPM) is ' + minRpm + '. ' +
      'RapidChangeSolo engages the collet at ' + settings.loadRpm +
      ' RPM (load) and ' + settings.unloadRpm + ' RPM (unload).\n\n' +
      'grblHAL will silently bump those macro RPMs up to ' + minRpm +
      ', which can destroy the Solo mechanism.\n\n' +
      'Lower $31 to at most ' + soloRpmFloor + ' before running a tool change.',
    variant: 'error',
    buttons: [
      { value: 'proceed', label: 'Proceed at My Risk',   style: 'danger' },
      { value: 'cancel',  label: 'Cancel Tool Change',   style: 'secondary', isDefault: true }
    ]
  });
  if (choice === 'proceed') return 'proceed';
  if (typeof pluginContext.stopJob === 'function') {
    try { pluginContext.stopJob(); return 'stopped'; } catch (_) { /* fall through */ }
  }
  return 'pause';
}

function handleM6Command(commands, context, settings) {
  const m6Index = commands.findIndex(cmd => {
    if (!cmd.isOriginal) return false;
    const parsed = parseM6Command(cmd.command);
    return parsed?.matched && parsed.toolNumber !== null;
  });

  if (m6Index === -1) {
    return;
  }

  const m6Command = commands[m6Index];
  const parsed = parseM6Command(m6Command.command);

  if (!parsed?.matched || parsed.toolNumber === null) {
    return;
  }

  const safety = confirmSpindleRpmSafety(settings);
  if (safety === 'stopped') {
    // Host dispatched feed hold + soft reset — silently drop the M6.
    commands.splice(m6Index, 1);
    return;
  }
  if (safety === 'pause') {
    const abortBlock = [
      { command: '(MSG, PLUGIN_MANUALTOOLCHANGE:ABORTED_$31_ABOVE_SOLO_RPM)', isOriginal: false, displayCommand: m6Command.command.trim() },
      { command: 'M0', isOriginal: false, displayCommand: null, meta: { silent: true } }
    ];
    commands.splice(m6Index, 1, ...abortBlock);
    return;
  }

  const toolNumber = parsed.toolNumber;
  const currentTool = context.machineState?.tool ?? 0;
  const toolOffsets = getToolOffsets(toolNumber, context.tools);
  const mpos = context.machineState?.mpos;

  const toolChangeProgram = buildToolChangeProgram(settings, currentTool, toolNumber, toolOffsets, {
    keepZero: zeroKeepPlan(context, currentTool).keep,
    currentOffsets: getToolOffsets(currentTool, context.tools),
    returnTo: mpos && typeof mpos.x === 'number' && typeof mpos.y === 'number' ? { x: mpos.x, y: mpos.y } : null,
  });
  const showMacroCommand = settings.showMacroCommand ?? false;

  const expandedCommands = toolChangeProgram.map((line, index) => {
    if (index === 0) {
      return {
        command: line,
        displayCommand: showMacroCommand ? null : m6Command.command.trim(),
        isOriginal: false
      };
    } else {
      return {
        command: line,
        displayCommand: null,
        isOriginal: false,
        meta: showMacroCommand ? {} : { silent: true }
      };
    }
  });

  commands.splice(m6Index, 1, ...expandedCommands);
}

// === Main Entry Point ===

function onBeforeCommand(commands, context, settings) {
  // Use core app's safe Z height setting, fallback to 0 (machine Z0)
  if (context && context.safeZHeight !== undefined) {
    settings.zSafe = context.safeZHeight;
  }

  handleTLSCommand(commands, context, settings);
  handlePocket1Command(commands, settings);
  handleM6Command(commands, context, settings);
  return commands;
}
