import { getPythonHost } from '../engine/pythonHost';
import { bootPlayer } from './boot';

/** The Python player: `public/player.py.js`. */
void bootPlayer(() => getPythonHost());
