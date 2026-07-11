/**
 * electron-builder hook: all runtime JavaScript (including electron-updater)
 * is bundled into dist-electron by esbuild, and the only native module is
 * built explicitly by `electron:native:release`. Returning false tells the
 * builder not to rebuild or duplicate the root package's browser dependencies.
 */
export function beforeBuild() {
  return false;
}

export default beforeBuild;
