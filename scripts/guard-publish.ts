/**
 * Refuse to publish from anywhere but CI.
 *
 * Wired into `prepublishOnly`, so it runs before `npm publish` does anything.
 *
 * Releases go through `.github/workflows/release.yml` exclusively. That gives
 * provenance attestation, a reproducible build from a clean checkout, and an
 * auditable record tied to a commit — none of which a local publish has. It
 * also means the npm token lives only in repo secrets, never on a workstation.
 *
 * To release: push a `v*` tag, or run the Release workflow manually.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.CI) {
  const packagePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../package.json',
  );
  const { version } = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    version: string;
  };

  console.error(`
  Refusing to publish from a local machine.

  This package is published by GitHub Actions only. To release:

    git tag v${version}
    git push origin master --tags

  or trigger the "Release" workflow manually from the Actions tab, which lets
  you pick the dist-tag.

  See .github/workflows/release.yml.
  `);
  process.exit(1);
}

console.log('CI detected — proceeding with publish.');
