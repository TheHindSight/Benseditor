/**
 * Starter art, authored as character grids so it stays readable in source.
 *
 * Rendered to a canvas and exported as base64 PNG, which is exactly the format
 * the sprite editor reads and writes.
 */

export function frameFromAscii(rows: string[], palette: Record<string, string>): string {
  const height = rows.length;
  const width = Math.max(...rows.map((row) => row.length));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = palette[rows[y][x] ?? ' '];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  return canvas.toDataURL('image/png').split(',')[1];
}

export const PLAYER_ART = [
  '................',
  '....kkkkkkkk....',
  '...kbbbbbbbbk...',
  '...kbwbbbbwbk...',
  '...kbbbbbbbbk...',
  '...kbbkkkkbbk...',
  '...kbbbbbbbbk...',
  '....kbbbbbbk....',
  '.....kkkkkk.....',
  '....kbbbbbbk....',
  '...kbbbbbbbbk...',
  '...kbbbbbbbbk...',
  '...kbb....bbk...',
  '....kk....kk....',
  '....kk....kk....',
  '...kkkk..kkkk...',
];

// The outline must differ from the room background, or the sprite reads as
// disconnected fragments.
export const PLAYER_PALETTE = { k: '#000000', b: '#29adff', w: '#fff1e8' };

export const WALL_ART = [
  'GGGGGGGGGGGGGGGG',
  'GddddddGdddddddG',
  'GddddddGdddddddG',
  'GddddddGdddddddG',
  'GGGGGGGGGGGGGGGG',
  'GdddGddddddddddG',
  'GdddGddddddddddG',
  'GdddGddddddddddG',
  'GGGGGGGGGGGGGGGG',
  'GddddddGdddddddG',
  'GddddddGdddddddG',
  'GddddddGdddddddG',
  'GGGGGGGGGGGGGGGG',
  'GdddGddddddddddG',
  'GdddGddddddddddG',
  'GGGGGGGGGGGGGGGG',
];

export const WALL_PALETTE = { G: '#5f574f', d: '#ab5236' };

export const COIN_PALETTE = { y: '#ffa300', Y: '#ffec27', w: '#fff1e8' };

/** Four 16x16 tiles laid out in one row: stone, stone top, rubble, empty grate. */
export const TILESET_ART = [
  'ssssssssssssssssSSSSSSSSSSSSSSSSrrrrrrrrrrrrrrrr.....gg..gg.....',
  'sSSsssSSssssSSssSSSSSSSSSSSSSSSSrRRrrrRRrrrrrrrr.gggggggggggggg.',
  'sSSsssSSssssSSsssSSssssSSssssSSsrRRrrrRRrrrrRRrr.gg..........gg.',
  'ssssssssssssssssssssssssssssssssrrrrrrrrrrrrrrrr.gg..gggggg..gg.',
  'ssssSSSsssSSSsssssssSSSsssSSSsssrrrrRRRrrrRRRrrr.gg..gg..gg..gg.',
  'ssssSSSsssSSSsssssssSSSsssSSSsssrrrrRRRrrrRRRrrr.gg..gg..gg..gg.',
  'ssssssssssssssssssssssssssssssssrrrrrrrrrrrrrrrr.gg..gggggg..gg.',
  'sssSSssssssssSSsssssSSssssssssSSrrrRRrrrrrrrrRRr.gg..........gg.',
  'sssSSssssssssSSsssssSSssssssssSSrrrRRrrrrrrrrRRr.gggggggggggggg.',
  'ssssssssssssssssssssssssssssssssrrrrrrrrrrrrrrrr.....gg..gg.....',
  'ssSSSssssSSSsssssssSSSssssSSSsssrrRRRrrrrRRRrrrr................',
  'ssSSSssssSSSsssssssSSSssssSSSsssrrRRRrrrrRRRrrrr................',
  'ssssssssssssssssssssssssssssssssrrrrrrrrrrrrrrrr................',
  'sssssSSsssssssSSssssssSSsssssssSrrrrrRRrrrrrrrSS................',
  'sssssSSsssssssSSssssssSSsssssssSrrrrrRRrrrrrrrSS................',
  'ssssssssssssssssssssssssssssssssrrrrrrrrrrrrrrrr................',
];

export const TILESET_PALETTE = {
  s: '#5f574f',
  S: '#7b7268',
  r: '#4a443e',
  R: '#6b635a',
  g: '#008751',
};

export const COIN_FRAMES = [
  ['..yyyy..', '.yYYYYy.', 'yYYwwYYy', 'yYwwwwYy', 'yYwwwwYy', 'yYYwwYYy', '.yYYYYy.', '..yyyy..'],
  ['...yy...', '..yYYy..', '..yYwy..', '..ywwy..', '..ywwy..', '..yYwy..', '..yYYy..', '...yy...'],
  ['...y....', '...yy...', '...yy...', '...yy...', '...yy...', '...yy...', '...yy...', '...y....'],
  ['...yy...', '..yYYy..', '..ywYy..', '..ywwy..', '..ywwy..', '..ywYy..', '..yYYy..', '...yy...'],
];
