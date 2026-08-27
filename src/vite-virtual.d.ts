/**
 * The standalone player's source, embedded at build time.
 *
 * Empty in the normal web build — there `exportGame` fetches `player.js`
 * instead, which keeps ~2 MB out of the app bundle. The single-file build
 * resolves this to the real source, because a file:// page has nothing to
 * fetch from.
 */
declare module 'virtual:player-bundle' {
  /** Source of each language's player; empty when not embedded. */
  const bundles: { luau: string; python: string };
  export default bundles;
}
