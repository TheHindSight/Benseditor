/**
 * Blocks to source.
 *
 * A block workspace is compiled to the project's language and the text is
 * what the engine runs, so everything downstream of the editor (running,
 * exporting, error lines) is identical for block and code projects.
 *
 * Generation is deterministic: hats come out in the engine's event order and
 * then by position, procedures first, so re-saving a project never rewrites
 * the script for no reason. Runs headless -- no DOM, no renderer.
 */
import * as Blockly from 'blockly';
import { luaGenerator } from 'blockly/lua';
import { pythonGenerator } from 'blockly/python';
import type { BlockWorkspace, ScriptLanguage } from '../project/types';
import { EVENT_NAMES } from '../ui/apiSurface';
import { eventBlockType, eventOfBlockType, installBlocks } from './blockDefs';

const LUAU_HEADER = '--!strict\n-- generated from blocks; edit the blocks, not this file\n\nlocal obj = {}\n\n';
const PYTHON_HEADER = '# generated from blocks; edit the blocks, not this file\n\n';

/** A top-level block as the serializer writes it; only these keys are read here. */
interface TopBlockState {
  type: string;
  id?: string;
  x?: number;
  y?: number;
}

function topBlocks(state: BlockWorkspace): TopBlockState[] {
  const blocks = state.blocks?.blocks ?? [];
  return blocks.filter((b): b is TopBlockState => typeof b === 'object' && b !== null && typeof (b as TopBlockState).type === 'string');
}

/** The serializer's shape, with the defaults a hand-built state may omit. */
function toSerialized(state: BlockWorkspace): Record<string, unknown> {
  return {
    blocks: { languageVersion: state.blocks?.languageVersion ?? 0, blocks: state.blocks?.blocks ?? [] },
    variables: state.variables ?? [],
  };
}

function isProcedureDef(block: Blockly.Block): boolean {
  return block.type === 'procedures_defnoreturn' || block.type === 'procedures_defreturn';
}

function byPosition(a: Blockly.Block, b: Blockly.Block): number {
  const pa = a.getRelativeToSurfaceXY();
  const pb = b.getRelativeToSurfaceXY();
  return pa.y - pb.y || pa.x - pb.x || a.id.localeCompare(b.id);
}

function byEvent(a: Blockly.Block, b: Blockly.Block): number {
  const ea = EVENT_NAMES.indexOf(eventOfBlockType(a.type) ?? '');
  const eb = EVENT_NAMES.indexOf(eventOfBlockType(b.type) ?? '');
  return ea - eb || byPosition(a, b);
}

function codeOf(generator: Blockly.CodeGenerator, block: Blockly.Block): string {
  const code = generator.blockToCode(block);
  return typeof code === 'string' ? code : Array.isArray(code) ? code[0] : '';
}

/** Tidy the generator's blank-line habits: at most one blank line, one trailing newline. */
function tidy(text: string): string {
  const trimmed = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
  return trimmed ? trimmed + '\n' : '';
}

/**
 * Compile a workspace to a complete object script in `language`.
 *
 * Only event hats and procedure definitions produce code; any other block
 * left loose on the canvas is ignored, as Scratch does.
 */
export function generateSource(state: BlockWorkspace, language: ScriptLanguage): string {
  installBlocks();
  // Both subclasses narrow `forBlock`'s generator parameter; the base type is all that is used here.
  const generator = (language === 'python' ? pythonGenerator : luaGenerator) as unknown as Blockly.CodeGenerator;
  const workspace = new Blockly.Workspace();
  try {
    Blockly.Events.disable();
    try {
      Blockly.serialization.workspaces.load(toSerialized(state), workspace);
    } finally {
      Blockly.Events.enable();
    }

    generator.init(workspace);
    const tops = workspace.getTopBlocks(false);
    const procedures = tops.filter(isProcedureDef).sort(byPosition);
    const hats = tops.filter((block) => eventOfBlockType(block.type) !== undefined).sort(byEvent);

    // Procedure definitions register themselves with the generator and are
    // emitted by `finish()` ahead of the hats.
    for (const block of procedures) codeOf(generator, block);
    let body = '';
    for (const block of hats) body += codeOf(generator, block);

    // The Python generator declares every used variable as a module global;
    // ours are instance fields, so that preamble is dropped.
    const definitions = (generator as unknown as { definitions_: Record<string, string> }).definitions_;
    delete definitions.variables;

    const text = tidy(generator.finish(body));
    if (language === 'python') return PYTHON_HEADER + text;
    return LUAU_HEADER + (text ? text + '\n' : '') + 'return obj\n';
  } finally {
    workspace.dispose();
  }
}

/** A workspace with nothing on it. */
export function emptyWorkspace(): BlockWorkspace {
  return { blocks: { languageVersion: 0, blocks: [] }, variables: [] };
}

/** The events with a hat on the canvas, in engine order. Reads the JSON only. */
export function definedEventsOf(state: BlockWorkspace): string[] {
  const found = new Set<string>();
  for (const block of topBlocks(state)) {
    const event = eventOfBlockType(block.type);
    if (event) found.add(event);
  }
  return EVENT_NAMES.filter((name) => found.has(name));
}

const HAT_GAP = 140;

/**
 * A copy of `state` with a hat for `eventName` appended, placed below
 * everything already on the canvas. The original is not touched.
 */
export function addEventHat(state: BlockWorkspace, eventName: string): BlockWorkspace {
  if (!EVENT_NAMES.includes(eventName)) throw new Error(`unknown event "${eventName}"`);
  const existing = topBlocks(state);
  const bottom = existing.reduce((max, block) => Math.max(max, block.y ?? 0), -HAT_GAP + 20);
  const hat: TopBlockState = {
    type: eventBlockType(eventName),
    id: Blockly.utils.idGenerator.genUid(),
    x: 20,
    y: bottom + HAT_GAP,
  };
  return {
    blocks: { languageVersion: state.blocks?.languageVersion ?? 0, blocks: [...(state.blocks?.blocks ?? []), hat] },
    variables: [...(state.variables ?? [])],
  };
}
