import { defineConfig } from 'tsup';

// Workspace packages from openhermit/ that are not (yet) published to
// npm. We bundle their types into the published d.ts via `dts.resolve`
// so consumers don't need them installed.
const internalPackages = [
  '@openhermit/protocol',
  '@openhermit/shared',
];

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  tsconfig: 'tsconfig.build.json',
  dts: { resolve: true },
  sourcemap: true,
  noExternal: internalPackages,
  esbuildOptions(options) {
    options.conditions = ['development'];
  },
});
