import { getLuauHost } from '../engine/luauHost';
import { bootPlayer } from './boot';

/** The Luau player: `public/player.js`. */
void bootPlayer(() => getLuauHost());
