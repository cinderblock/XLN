import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20.19',
  platform: 'node',
  // Validate the published shape on every build: publint catches a broken
  // exports map, attw catches type resolution that works in ESM but not CJS.
  publint: true,
  attw: true,
});
