/**
 * Verifies the *published* artifact, not the source.
 *
 * Everything else in this suite imports from `src/`, which would happily pass
 * even if the exports map, the build config, or the CJS interop were broken.
 * These tests load `dist/` the way a consumer would — through the package
 * exports, in both module systems — and drive a real socket through it.
 *
 * Skipped automatically when `dist/` has not been built.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type * as XlnSource from '../src/index.js';
import { MockDevice } from './mock-device.js';

/** The bundle is expected to expose exactly the source's public surface. */
type XlnModule = typeof XlnSource;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = existsSync(resolve(root, 'dist/index.mjs'));

let device: MockDevice | undefined;
afterEach(async () => {
  await device?.stop();
  device = undefined;
});

describe.skipIf(!built)('published artifact', () => {
  it('drives a device through the ESM entry point', async () => {
    const url = pathToFileURL(resolve(root, 'dist/index.mjs')).href;
    const { connect, XLNRangeError } = (await import(url)) as XlnModule;

    device = await MockDevice.start();
    const psu = await connect({ host: '127.0.0.1', port: device.port });

    expect(psu.identity.model).toBe('XLN6024-GL');
    await psu.setVoltage(12);
    expect(await psu.getVoltage()).toBe(12);
    // Errors thrown by the bundle must be catchable with the bundle's classes.
    await expect(psu.setVoltage(1000)).rejects.toBeInstanceOf(XLNRangeError);
    await psu.close();
  });

  it('drives a device through the CommonJS entry point', async () => {
    const require = createRequire(import.meta.url);
    const bundle = require(resolve(root, 'dist/index.cjs')) as XlnModule;

    device = await MockDevice.start();
    const psu = await bundle.connect({
      host: '127.0.0.1',
      port: device.port,
    });

    expect(psu.identity.model).toBe('XLN6024-GL');
    await psu.setOutput(true);
    expect(await psu.getOutput()).toBe(true);
    await psu.close();
  });

  it('exports the documented public surface from both formats', async () => {
    const require = createRequire(import.meta.url);
    const esm = (await import(
      pathToFileURL(resolve(root, 'dist/index.mjs')).href
    )) as Record<string, unknown>;
    const cjs = require(resolve(root, 'dist/index.cjs')) as Record<
      string,
      unknown
    >;

    for (const name of [
      'XLN',
      'connect',
      'ScpiSocket',
      'XLN_TCP_PORT',
      'XLNError',
      'XLNConnectionError',
      'XLNTimeoutError',
      'XLNProtocolError',
      'XLNDeviceError',
      'XLNRangeError',
      'XLN_MODELS',
      'allModels',
      'lookupModel',
      'describeErrorCode',
    ]) {
      expect(esm[name], `ESM export ${name}`).toBeDefined();
      expect(cjs[name], `CJS export ${name}`).toBeDefined();
    }

    // The UDP class from 0.6.x is deliberately gone; port 9221 is not a real
    // XLN protocol. See plans/xln-modernization.md.
    expect(esm.udpXLN).toBeUndefined();
    expect(esm.tcpXLN).toBeUndefined();
  });
});
