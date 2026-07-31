/**
 * End-to-end smoke test against a real XLN supply.
 *
 *   npm run smoke -- 192.168.1.50
 *
 * By default this is **read-only**: it identifies the device, reads every
 * getter, and reports anything the library failed to parse. It will not touch
 * the output or any setpoint.
 *
 *   npm run smoke -- 192.168.1.50 --allow-output
 *
 * adds an active test: it saves your current setpoints, drives a low, safe
 * setpoint, enables the output briefly, measures, then disables the output and
 * restores what it found. Only pass this with nothing dangerous connected.
 */

import { connect, XLN_TCP_PORT, XLNError, type XLN } from '../src/index.js';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const host = positional[0];
// Port is only useful for pointing at a mock; real hardware is always 5025.
const port = positional[1] === undefined ? undefined : Number(positional[1]);
const allowOutput = args.includes('--allow-output');

if (!host || (port !== undefined && !Number.isInteger(port))) {
  console.error('Usage: npm run smoke -- <host> [port] [--allow-output]');
  process.exit(1);
}

let failures = 0;

/** Run one read and report it, without letting one bad parse end the run. */
async function read<T>(label: string, fn: () => Promise<T>): Promise<void> {
  try {
    const value = await fn();
    console.log(`  ok    ${label.padEnd(28)} ${String(value)}`);
  } catch (error) {
    failures++;
    const message = error instanceof XLNError ? error.message : String(error);
    console.log(`  FAIL  ${label.padEnd(28)} ${message}`);
  }
}

async function readOnlyChecks(psu: XLN): Promise<void> {
  console.log('\nIdentity');
  console.log(`  manufacturer  ${psu.identity.manufacturer}`);
  console.log(`  model         ${psu.identity.model}`);
  console.log(`  serial        ${psu.identity.serial}`);
  console.log(`  firmware      ${psu.identity.firmware}`);
  if (psu.spec) {
    console.log(
      `  limits        ${psu.spec.voltage.min}-${psu.spec.voltage.max} V, ` +
        `${psu.spec.current.min}-${psu.spec.current.max} A, ` +
        `${psu.spec.power} W`,
    );
  } else {
    console.log('  limits        UNKNOWN MODEL — range checking is disabled');
    failures++;
  }

  console.log('\nSetpoints');
  await read('voltage setpoint (V)', () => psu.getVoltage());
  await read('current setpoint (A)', () => psu.getCurrent());
  await read('voltage limit (V)', () => psu.getVoltageLimit());
  await read('current limit (A)', () => psu.getCurrentLimit());
  await read('voltage slew (V/ms)', () => psu.getVoltageSlewRate());
  await read('current slew (A/ms)', () => psu.getCurrentSlewRate());

  console.log('\nOutput');
  await read('output enabled', () => psu.getOutput());
  await read('regulation mode', () => psu.getRegulationMode());
  await read('measured voltage (V)', () => psu.measureVoltage());
  await read('measured current (A)', () => psu.measureCurrent());

  console.log('\nProtection');
  await read('OVP enabled', () => psu.getOverVoltageProtection());
  await read('OVP level (V)', () => psu.getOverVoltageLevel());
  await read('OCP enabled', () => psu.getOverCurrentProtection());
  await read('OCP level (A)', () => psu.getOverCurrentLevel());
  await read('OPP enabled', () => psu.getOverPowerProtection());
  await read('OPP level (W)', () => psu.getOverPowerLevel());
  await read('protection tripped', () => psu.getProtectionTripped());

  console.log('\nSystem');
  await read('serial number', () => psu.getSerialNumber());
  await read('beeper', () => psu.getBeep());
  await read('key lock', () => psu.getKeyLock());
  await read('power-on mode', () => psu.getPowerOnMode());
  await read('status flags', async () => {
    const status = await psu.getStatus();
    return (
      `output=${status.enabled.output} ` +
      `OTP=${status.occurred.overTemperature} ` +
      `AClow=${status.occurred.acLow} ` +
      `raw=[${status.bytes.join(',')}]`
    );
  });

  console.log('\nError queue');
  await read('pending errors', async () => {
    const errors = await psu.getErrors();
    return errors.length === 0
      ? 'none'
      : errors.map((e) => `${e.code} (${e.description})`).join('; ');
  });
}

async function activeChecks(psu: XLN): Promise<void> {
  console.log('\n--- ACTIVE TEST (--allow-output) ---');

  const restore = {
    voltage: await psu.getVoltage(),
    current: await psu.getCurrent(),
    output: await psu.getOutput(),
  };
  console.log(
    `  saved: ${restore.voltage} V, ${restore.current} A, ` +
      `output ${restore.output ? 'on' : 'off'}`,
  );

  if (restore.output) {
    console.log('  Output is already ON — skipping. Turn it off and re-run.');
    return;
  }

  // Lowest setpoint this model actually supports, with a small current cap.
  const testVoltage = psu.spec ? Math.max(psu.spec.voltage.min, 1) : 1;
  const testCurrent = psu.spec ? Math.max(psu.spec.current.min, 0.1) : 0.1;

  try {
    console.log(`  setting ${testVoltage} V / ${testCurrent} A`);
    await psu.setVoltage(testVoltage);
    await psu.setCurrent(testCurrent);

    console.log('  enabling output for ~1 s');
    await psu.setOutput(true);
    await new Promise((r) => setTimeout(r, 1000));

    await read('measured voltage (V)', () => psu.measureVoltage());
    await read('measured current (A)', () => psu.measureCurrent());
    await read('regulation mode', () => psu.getRegulationMode());
  } finally {
    // Always put the supply back, even if a check above threw.
    console.log('  restoring');
    await psu.setOutput(false);
    await psu.setVoltage(restore.voltage);
    await psu.setCurrent(restore.current);
    console.log('  output off, setpoints restored');
  }
}

async function main(): Promise<void> {
  console.log(`Connecting to ${host}:${port ?? XLN_TCP_PORT} ...`);
  await using psu = await connect(
    port === undefined ? { host: host! } : { host: host!, port },
  );

  await readOnlyChecks(psu);
  if (allowOutput) await activeChecks(psu);

  console.log(
    failures === 0
      ? '\nAll checks passed.'
      : `\n${failures} check(s) failed — see FAIL lines above.`,
  );
  console.log(
    'If anything failed to parse, please open an issue with this output:',
  );
  console.log('https://github.com/cinderblock/XLN/issues');

  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('\nSmoke test failed to run:', error);
  process.exit(1);
});
