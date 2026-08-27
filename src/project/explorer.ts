import type { AssetKind, ExplorerNode, Project } from './types';

/**
 * The Roblox-style Explorer, as an overlay on the flat asset lists.
 *
 * Nothing about how a project is stored changes between the two paradigms:
 * sprites, objects, rooms and scripts stay in their flat arrays and the engine
 * never sees the tree. `config.explorer` is a flat list of nodes with parent
 * pointers that *references* those assets and lets the user group them under
 * folders inside four services. Flat, so the JSON-snapshot undo stays cheap
 * and a cycle is impossible to express by accident; reconciled rather than
 * migrated, so switching paradigms in either direction never loses anything.
 *
 * Every asset kind lives under exactly one service ("its domain"): objects in
 * Workspace, rooms in StarterRooms, shared scripts in ReplicatedStorage,
 * sprites and tilesets in Assets. An object's script and sprite are shown as
 * derived rows beneath it by the view; they are not nodes.
 */

/**
 * The project as an exported game needs it: the paradigm, the Explorer tree
 * and the scripting mode are editor layout, and an object's blocks are editor
 * state (its generated script is what runs), so none of them reach the
 * player.
 */
export function forPlayer(project: Project): Project {
  const { paradigm: _paradigm, explorer: _explorer, scripting: _scripting, ...config } = project.config;
  const objects = project.objects.map(({ def, source }) => {
    const { blocks: _blocks, ...rest } = def;
    return { def: rest, source };
  });
  return { ...project, config, objects };
}

export const SERVICE_IDS = {
  workspace: 'svc_workspace',
  rooms: 'svc_rooms',
  replicated: 'svc_replicated',
  assets: 'svc_assets',
} as const;

export const SERVICE_NODES: readonly ExplorerNode[] = [
  { id: SERVICE_IDS.workspace, kind: 'service', name: 'Workspace', parentId: null },
  { id: SERVICE_IDS.rooms, kind: 'service', name: 'StarterRooms', parentId: null },
  { id: SERVICE_IDS.replicated, kind: 'service', name: 'ReplicatedStorage', parentId: null },
  { id: SERVICE_IDS.assets, kind: 'service', name: 'Assets', parentId: null },
];

/** Which service an asset kind belongs under. */
export function serviceFor(kind: AssetKind): string {
  switch (kind) {
    case 'object':
      return SERVICE_IDS.workspace;
    case 'room':
      return SERVICE_IDS.rooms;
    case 'script':
      return SERVICE_IDS.replicated;
    default:
      return SERVICE_IDS.assets;
  }
}

/** The kinds a service (and any folder inside it) may hold. */
export function kindsUnder(serviceId: string): AssetKind[] {
  switch (serviceId) {
    case SERVICE_IDS.workspace:
      return ['object'];
    case SERVICE_IDS.rooms:
      return ['room'];
    case SERVICE_IDS.replicated:
      return ['script'];
    default:
      return ['sprite', 'tileset'];
  }
}

export function assetNodeId(kind: AssetKind, name: string): string {
  return `${kind}:${name}`;
}

export function newFolderId(): string {
  return `fld_${Math.random().toString(36).slice(2, 8)}`;
}

function assetRefs(project: Project): { kind: AssetKind; name: string }[] {
  return [
    ...project.sprites.map((s) => ({ kind: 'sprite' as const, name: s.name })),
    ...project.tilesets.map((t) => ({ kind: 'tileset' as const, name: t.name })),
    ...project.objects.map((o) => ({ kind: 'object' as const, name: o.def.name })),
    ...project.rooms.map((r) => ({ kind: 'room' as const, name: r.name })),
    ...project.scripts.map((s) => ({ kind: 'script' as const, name: s.name })),
  ];
}

/** The four services with every asset at the root of its service. */
export function defaultExplorer(project: Project): ExplorerNode[] {
  const nodes: ExplorerNode[] = SERVICE_NODES.map((node) => ({ ...node }));
  for (const asset of assetRefs(project)) {
    nodes.push({
      id: assetNodeId(asset.kind, asset.name),
      kind: 'asset',
      name: asset.name,
      parentId: serviceFor(asset.kind),
      asset,
    });
  }
  return nodes;
}

export function childrenOf(nodes: readonly ExplorerNode[], parentId: string | null): ExplorerNode[] {
  return nodes.filter((node) => node.parentId === parentId);
}

/** The service a node ultimately sits under, or null if it is detached. */
export function serviceOf(nodes: readonly ExplorerNode[], id: string): string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let node = byId.get(id);
  for (let guard = 0; node && guard < 256; guard++) {
    if (node.kind === 'service') return node.id;
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return null;
}

function isDescendant(nodes: readonly ExplorerNode[], id: string, ancestorId: string): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let node = byId.get(id);
  for (let guard = 0; node && guard < 256; guard++) {
    if (node.id === ancestorId) return true;
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return false;
}

/**
 * Whether `nodeId` may be dropped into `targetId`.
 *
 * Targets are services and folders only. An asset stays inside the service
 * that owns its kind; a folder stays inside the service it is in, since it
 * may hold assets of that domain. Nothing may be dropped into itself or into
 * one of its own descendants.
 */
export function canDrop(nodes: readonly ExplorerNode[], nodeId: string, targetId: string): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const node = byId.get(nodeId);
  const target = byId.get(targetId);
  if (!node || !target) return false;
  if (node.kind === 'service') return false;
  if (target.kind === 'asset') return false;
  if (node.id === target.id || isDescendant(nodes, target.id, node.id)) return false;
  const domain = node.asset ? serviceFor(node.asset.kind) : serviceOf(nodes, node.id);
  return serviceOf(nodes, target.id) === domain;
}

/**
 * Make `nodes` agree with the project's assets. Idempotent, and safe to run
 * on a tree written by an older or newer editor:
 *
 * - the four services exist, in order, at the root;
 * - every asset has exactly one node, inside its service's domain;
 * - nodes for assets that no longer exist are dropped;
 * - a node whose parent is missing, or which is caught in a cycle, moves to
 *   the root of its domain.
 */
export function reconcileExplorer(project: Project): ExplorerNode[] {
  const input = project.config.explorer ?? [];
  const nodes: ExplorerNode[] = [];

  for (const service of SERVICE_NODES) nodes.push({ ...service });

  const assets = assetRefs(project);
  const wanted = new Map(assets.map((asset) => [assetNodeId(asset.kind, asset.name), asset]));
  const seenAssets = new Set<string>();

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.kind === 'service') continue; // always rebuilt above
    if (raw.kind === 'folder') {
      if (typeof raw.id !== 'string' || !raw.id || nodes.some((n) => n.id === raw.id)) continue;
      nodes.push({
        id: raw.id,
        kind: 'folder',
        name: typeof raw.name === 'string' && raw.name ? raw.name : 'Folder',
        parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
      });
      continue;
    }
    if (raw.kind === 'asset' && raw.asset) {
      const id = assetNodeId(raw.asset.kind, raw.asset.name);
      const asset = wanted.get(id);
      if (!asset || seenAssets.has(id)) continue; // gone, or a duplicate
      seenAssets.add(id);
      nodes.push({
        id,
        kind: 'asset',
        name: asset.name,
        parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
        asset,
      });
    }
  }

  // Adopt assets the tree has never seen, at the root of their service.
  for (const [id, asset] of wanted) {
    if (seenAssets.has(id)) continue;
    nodes.push({ id, kind: 'asset', name: asset.name, parentId: serviceFor(asset.kind), asset });
  }

  // Repair parents: missing, cyclic, or in the wrong domain.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.kind === 'service') continue;
    const domain = node.asset ? serviceFor(node.asset.kind) : null;
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (!parent || parent.kind === 'asset') parent = undefined;
    if (parent) {
      // A cycle has no service above it.
      const service = serviceOf(nodes, parent.id);
      if (!service || (domain && service !== domain)) parent = undefined;
    }
    if (!parent) node.parentId = domain ?? serviceOf(nodes, node.id) ?? SERVICE_IDS.assets;
  }
  // Folders in a cycle still have no service; break the cycle at each one.
  for (const node of nodes) {
    if (node.kind === 'folder' && !serviceOf(nodes, node.id)) node.parentId = SERVICE_IDS.assets;
  }

  project.config.explorer = nodes;
  return nodes;
}

/** Drop a folder, lifting its contents to where the folder was. */
export function removeFolder(nodes: ExplorerNode[], folderId: string): void {
  const folder = nodes.find((node) => node.id === folderId && node.kind === 'folder');
  if (!folder) return;
  for (const node of nodes) {
    if (node.parentId === folderId) node.parentId = folder.parentId;
  }
  nodes.splice(nodes.indexOf(folder), 1);
}

/** Keep the tree in step with a rename made on the flat lists. */
export function renameAssetNode(nodes: ExplorerNode[], kind: AssetKind, from: string, to: string): void {
  const node = nodes.find((n) => n.kind === 'asset' && n.asset?.kind === kind && n.asset.name === from);
  if (!node) return;
  node.id = assetNodeId(kind, to);
  node.name = to;
  node.asset = { kind, name: to };
}

export function removeAssetNode(nodes: ExplorerNode[], kind: AssetKind, name: string): void {
  const index = nodes.findIndex((n) => n.kind === 'asset' && n.asset?.kind === kind && n.asset.name === name);
  if (index >= 0) nodes.splice(index, 1);
}

/** Register a freshly created asset, in `parentId` when that is a valid home. */
export function addAssetNode(
  nodes: ExplorerNode[],
  kind: AssetKind,
  name: string,
  parentId?: string | null,
): void {
  const id = assetNodeId(kind, name);
  if (nodes.some((node) => node.id === id)) return;
  const domain = serviceFor(kind);
  const home =
    parentId && nodes.some((n) => n.id === parentId && n.kind !== 'asset') && serviceOf(nodes, parentId) === domain
      ? parentId
      : domain;
  nodes.push({ id, kind: 'asset', name, parentId: home, asset: { kind, name } });
}
