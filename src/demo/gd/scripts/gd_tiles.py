# gd_tiles -- keep a tile layer in sync with a level's blocks.
#
# Tile edits persist across room_restart/room_goto and layers cannot be
# rebuilt, so the play and editor rooms write their blocks into a pre-authored
# layer at runtime. `sync_layer` diffs the wanted cells against the cells it
# wrote last time (remembered in ReplicatedStorage, which lives exactly as long
# as the tiles do), so a restart costs nothing and stale blocks from the
# previous level are cleared. The floor rows are authored in the room and are
# never touched. Depends on gd_const.

_RS = game.GetService("ReplicatedStorage")


def _record_key(layer_id):
    return "gd.tiles." + layer_id


def layer_cells(layer_id):
    """{(tx, ty): index} written by the last sync of this layer."""
    cells = _RS.Get(_record_key(layer_id))
    return cells if isinstance(cells, dict) else {}


def sync_layer(layer_id, wanted):
    """Make the layer hold exactly `wanted` ({(tx, ty): index}, or a set of
    (tx, ty) meaning TILE_BLOCK) on top of what the room authored. Returns
    (added, removed) -- both 0 when nothing changed, so it is idempotent."""
    if not isinstance(wanted, dict):
        wanted = {cell: TILE_BLOCK for cell in wanted}
    if layer_id not in tilemap_layers():
        return (0, 0)
    last = layer_cells(layer_id)
    added = 0
    removed = 0
    written = {}
    for cell in last:
        if cell not in wanted:
            if tilemap_set(layer_id, cell[0], cell[1], -1):
                removed += 1
    for cell in wanted:
        index = wanted[cell]
        if last.get(cell) == index:
            # Already there -- unless someone else overwrote the tile.
            if tilemap_get(layer_id, cell[0], cell[1]) == index:
                written[cell] = index
                continue
        if tilemap_set(layer_id, cell[0], cell[1], index):
            written[cell] = index
            added += 1
    _RS.Set(_record_key(layer_id), written)
    return (added, removed)


def clear_layer(layer_id):
    """Remove every cell the last sync wrote."""
    return sync_layer(layer_id, {})


def layer_matches(layer_id, wanted):
    """True when every wanted cell holds its index (a check for tests and saves)."""
    if not isinstance(wanted, dict):
        wanted = {cell: TILE_BLOCK for cell in wanted}
    for cell in wanted:
        if tilemap_get(layer_id, cell[0], cell[1]) != wanted[cell]:
            return False
    return True
