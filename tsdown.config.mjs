// Plain JS on purpose. tsdown loads a .ts config via `unrun`, which declares
// `engines: node ^22.13.0 || >=24` — so a TypeScript config file could never
// build on the Node 20.19 floor this package supports. It worked locally only
// because Bun loads TS configs natively and never needed the loader at all.
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/testing/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20.19',
  platform: 'node',
  // publint/attw are deliberately NOT enabled here. They pack the package to
  // inspect it, and `build` runs from `prepublishOnly` — so enabling them makes
  // `npm pack` recurse into itself and fail. They live in the `check:package`
  // script instead, which CI runs.
});
