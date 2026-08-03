/**
 * Confirm what the state field reports while the output is ON.
 *
 * Everything else about the UDP frame was established with the output off, so
 * the state field had only ever been observed as `OFF`. B&K's manual shows a
 * screenshot of the same display panel reading `CV`, but that is documentary,
 * not measured. This measures it.
 *
 *   bun run probe:output 10.255.14.231
 *
 * SAFETY: enables the output. Only run with **nothing connected**. It saves the
 * existing setpoints and output state first and restores them in a `finally`,
 * including on failure. Voltage is kept low and the current limit modest.
 */

import { createSocket } from 'node:dgram';
import { connect } from '../src/index.js';

const host = process.argv[2];
if (!host) {
  console.error('Usage: bun run probe:output <host>');
  console.error('Only run this with NOTHING connected to the output.');
  process.exit(1);
}

/** Grab one raw UDP frame so the exact byte layout can be inspected. */
function rawFrame(target: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let frame: string | undefined;
    socket.on('message', (message) => {
      frame = message.toString('latin1');
    });
    socket.on('error', () => {
      resolve(frame);
    });
    socket.send(Buffer.alloc(96), 9221, target, () => undefined);
    setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(frame);
    }, 800);
  });
}

function showFrame(label: string, frame: string | undefined): void {
  console.log(`  ${label}`);
  if (!frame) {
    console.log('    (no reply)');
    return;
  }
  const ruler = Array.from({ length: Math.ceil(frame.length / 10) }, (_, i) =>
    String(i * 10).padEnd(10),
  ).join('');
  console.log(`    ${ruler}`);
  console.log(`    ${frame.replace(/ /g, '.').replace(/\0/g, '@')}`);
  const fields = [...frame.matchAll(/\S+/g)].map(
    (m) => `${String(m.index)}:${m[0]}`,
  );
  console.log(`    fields -> ${fields.join('  ')}`);
}

async function main(): Promise<void> {
  const psu = await connect({ host: host! });
  console.log(`${psu.identity.model}, firmware ${psu.identity.firmware}`);
  console.log(`usingUdp: ${String(psu.usingUdp)}\n`);

  const saved = {
    voltage: await psu.getVoltage(),
    current: await psu.getCurrent(),
    output: await psu.getOutput(),
  };
  console.log(
    `Saved state: ${saved.voltage} V, ${saved.current} A, output ` +
      `${saved.output ? 'ON' : 'off'}\n`,
  );

  if (saved.output) {
    console.log('Output is already ON — refusing to touch it. Turn it off.');
    await psu.close();
    return;
  }

  try {
    // Two widths on purpose: 5.000 is five characters and 24.000 is six, which
    // is what decides whether the value collides with its unit marker.
    for (const volts of [5, 24]) {
      await psu.setVoltage(volts);
      await psu.setCurrent(1);
      await psu.setOutput(true);
      // Let the output settle before sampling.
      await new Promise((r) => setTimeout(r, 600));

      console.log(`=== Output ON at ${volts} V, no load ===`);
      console.log(`  OUTPUT?        -> ${String(await psu.getOutput())}`);
      console.log(`  OUTPUT:STATE?  -> ${await psu.query('OUTPUT:STATE?')}`);
      console.log(`  STATUS?        -> ${await psu.query('STATUS?')}`);

      const reading = await psu.measure({ mode: true });
      console.log(`  measure()      -> ${JSON.stringify(reading)}`);

      showFrame('raw UDP frame:', await rawFrame(host!));
      console.log();

      await psu.setOutput(false);
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    console.log('Restoring...');
    await psu.setOutput(false);
    await psu.setVoltage(saved.voltage);
    await psu.setCurrent(saved.current);
    const check = {
      voltage: await psu.getVoltage(),
      current: await psu.getCurrent(),
      output: await psu.getOutput(),
    };
    console.log(
      `Restored: ${check.voltage} V, ${check.current} A, output ` +
        (check.output ? 'ON' : 'off'),
    );
    await psu.close();
  }
}

main().catch((error: unknown) => {
  console.error('Probe failed:', error);
  process.exit(1);
});
