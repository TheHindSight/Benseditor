/** Art for the Snake template, as character grids. */

// Both fill the full 16x16 cell so consecutive segments touch rather than
// leaving a gap that makes the snake look like loose beads.
export const HEAD_ART = [
  '..gggggggggggg..',
  '.gGGGGGGGGGGGGg.',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGwwGGGGGg',
  'gGGGGGGGwkGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGwkGGGGGg',
  'gGGGGGGGwwGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  '.gGGGGGGGGGGGGg.',
  '..gggggggggggg..',
];

export const BODY_ART = [
  'gggggggggggggggg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGddddGGGGGGg',
  'gGGGGddddGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGddddGGGGg',
  'gGGGGGGddddGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gGGGGGGGGGGGGGGg',
  'gggggggggggggggg',
];

export const SNAKE_PALETTE = {
  g: '#008751',
  G: '#00e436',
  d: '#00b32b',
  w: '#fff1e8',
  k: '#000000',
};

export const FOOD_ART = [
  '................',
  '................',
  '.......kk.......',
  '......kGGk......',
  '....rrrrrrrr....',
  '...rrRRRRRRrr...',
  '..rrRRRRRRRRrr..',
  '..rRRRRwRRRRRr..',
  '..rRRRRRRRRRRr..',
  '..rrRRRRRRRRrr..',
  '...rrRRRRRRrr...',
  '....rrrrrrrr....',
  '................',
  '................',
  '................',
  '................',
];

export const FOOD_PALETTE = {
  r: '#7e2553',
  R: '#ff004d',
  w: '#fff1e8',
  k: '#5f574f',
  G: '#008751',
};

/**
 * Two 16x16 tiles side by side: the light and dark squares of the field.
 * A darker top row and left column give a subtle grid without a real border.
 */
export const FIELD_ART = [
  'A'.repeat(16) + 'B'.repeat(16),
  ...Array.from({ length: 15 }, () => 'A' + 'a'.repeat(15) + 'B' + 'b'.repeat(15)),
];

export const FIELD_PALETTE = {
  A: '#0d1018',
  a: '#141a26',
  B: '#11151f',
  b: '#1a2130',
};
