import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20.19',
  platform: 'node',
  // publint/attw are deliberately NOT enabled here. They pack the package to
  // inspect it, and `build` runs from `prepack` — so enabling them makes
  // `npm pack` recurse into itself and fail. They live in the `check:package`
  // script instead, which CI runs.
});
