import { reconcileExplorer } from './explorer';
import { FORMAT_VERSION, type Project } from './types';

/**
 * Project validation and migration.
 *
 * Every path that brings a project into memory — the JSON importer, the
 * autosave, a folder opened through the File System Access API, the desktop
 * bridge and the standalone player — runs through `validate`, so fields added
 * since a project was written are filled in exactly once, here, rather than
 * being defaulted piecemeal wherever they happen to be read.
 */

/** Fill in fields added since a project was written, and repair broken ones. */
export function validate(value: unknown): Project {
  const project = value as Project;
  if (
    !project?.config ||
    !Array.isArray(project.sprites) ||
    !Array.isArray(project.objects) ||
    !Array.isArray(project.rooms)
  ) {
    throw new Error('That file is not a Benseditor project.');
  }
  project.scripts ??= [];
  project.tilesets ??= [];
  for (const room of project.rooms) room.layers ??= [];
  for (const entry of project.objects) entry.def.blockedBy ??= [];
  project.config.version ??= FORMAT_VERSION;
  // A project that has ever used the Explorer keeps its tree in step with the
  // assets; one that never has does not grow one until the paradigm is switched.
  if (project.config.paradigm === 'roblox' || project.config.explorer) reconcileExplorer(project);

  // Repair a start room that points at a room which no longer exists, rather
  // than letting it fail later on Play.
  if (!project.rooms.some((room) => room.name === project.config.startRoom)) {
    project.config.startRoom = project.rooms[0]?.name ?? '';
  }

  return project;
}

/** Alias kept for callers that read better with the past participle. */
export const validateLoaded = validate;
