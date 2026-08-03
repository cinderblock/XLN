/**
 * Does a UDP monitor track a live change driven by a separate TCP session?
 *
 * This is the end-to-end premise of the monitor-first API
 * (`plans/monitor-first-api.md`): a read-only client polls UDP while a
 * completely independent client drives the supply over SCPI, and the monitor
 * sees the result promptly and coherently. Contention was already ruled out —
 * 12 concurrent TCP sessions, zero crossed replies — but that was all
 * read-side. This is the actual feature, running against real hardware.
 *
 * It also tries to capture a **CC** state, which has never been observed. With
 * nothing connected there is no load to force current limiting, so instead it
 * sets the current limit to zero: the supply cannot reach its voltage setpoint
 * without delivering current, which is the definition of current-limited. If
 * the device disagrees, that is a finding too.
 *
 * SAFETY: enables the output. **Only run with nothing connected.** Voltage is
 * held at 5 V, below this unit's 8.500 V OVP trip, and the current limit at
 * 1 A. Every original value — setpoints and output state — is read first and
 * restored in a `finally`, including on failure.
 *
 *   bun run probe:monitor:live 10.255.14.231
 */

import { connect, UdpStatusChannel, type UdpStatus } from '../src/index.js';

const hostArg = process.argv[2];
if (!hostArg) {
  console.error('Usage: bun run probe:monitor:live <host>');
  console.error('Only run this with NOTHING connected to the output.');
  process.exit(1);
}
// Rebound so the narrowing survives into `main()`; a module-level narrowing of
// `process.argv[2]` does not reach inside a function body.
const host: string = hostArg;

/** Test setpoints. Both well under the 8.500 V OVP this unit is configured for. */
const V_FIRST = 5;
const V_SECOND = 6.5;
const I_LIMIT = 1;

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const findings: string[] = [];

  // The monitor. Note this is a *separate transport* from the control session
  // below — no shared socket, no coordination between them.
  const monitor = new UdpStatusChannel({ host });
  if (!(await monitor.available())) {
    console.error(`No UDP status channel on ${host}:9221. Cannot run.`);
    monitor.close();
    process.exit(1);
  }
  console.log(`\n=== Live monitor probe against ${host} ===`);
  console.log('UDP monitor + independent TCP control session.\n');

  // A background poll loop, exactly as a read-only client would run one.
  const samples: UdpStatus[] = [];
  const stop = new AbortController();
  let pollErrors = 0;
  const loop = (async () => {
    while (!stop.signal.aborted) {
      try {
        samples.push(await monitor.poll());
      } catch {
        pollErrors++;
      }
      await settle(100);
    }
  })();

  /** Newest sample, for reporting what the monitor saw at a moment in time. */
  const latest = (): UdpStatus | undefined => samples.at(-1);
  const show = (label: string): void => {
    const s = latest();
    console.log(
      `  ${label.padEnd(28)} ${s ? `${s.state.padEnd(4)} ${s.voltage.toFixed(3)} V  ${s.current.toFixed(3)} A` : '(no sample)'}`,
    );
  };

  const psu = await connect({ host });
  console.log(
    `Control session: ${psu.identity.model}, usingUdp=${psu.usingUdp}`,
  );

  // --- 0. Save everything we are about to disturb. ------------------------
  const original = {
    voltage: await psu.getVoltage(),
    current: await psu.getCurrent(),
    output: await psu.getOutput(),
  };
  console.log(
    `\n--- 0. Original: ${original.voltage} V, ${original.current} A, output ${original.output ? 'ON' : 'OFF'} ---`,
  );
  if (original.output) {
    console.log(
      'Output already ON — refusing to run, this probe assumes a de-energized start.',
    );
    stop.abort();
    await loop;
    monitor.close();
    await psu.close();
    return;
  }

  try {
    await settle(300);
    show('output off:');
    findings.push(`Monitor with output off: state=${latest()?.state}`);

    // --- 1. Energize, and watch the monitor notice. ----------------------
    console.log(
      `\n--- 1. Set ${V_FIRST} V / ${I_LIMIT} A and enable output ---`,
    );
    await psu.setVoltage(V_FIRST);
    await psu.setCurrent(I_LIMIT);
    const before = samples.length;
    const enabledAt = Date.now();
    await psu.setOutput(true);

    // How long until a read-only client, with no knowledge of the control
    // session, observes the change? This is the number a UI cares about.
    let noticedAfter: number | undefined;
    for (let i = 0; i < 40; i++) {
      await settle(50);
      const s = latest();
      if (s && samples.length > before && s.output) {
        noticedAfter = Date.now() - enabledAt;
        break;
      }
    }
    await settle(400);
    show(`after enable:`);
    findings.push(
      noticedAfter === undefined
        ? 'Monitor did NOT observe the output turning on.'
        : `Monitor observed output ON ${noticedAfter}ms after an independent TCP session enabled it.`,
    );
    const onSample = latest();
    findings.push(
      `Monitor with output on: state=${onSample?.state}, ${onSample?.voltage.toFixed(3)} V ` +
        `(setpoint ${V_FIRST} V), ${onSample?.current.toFixed(3)} A`,
    );

    // --- 2. Change voltage under the monitor's nose. ---------------------
    console.log(`\n--- 2. Change setpoint to ${V_SECOND} V over TCP ---`);
    const changedAt = Date.now();
    await psu.setVoltage(V_SECOND);
    let trackedAfter: number | undefined;
    for (let i = 0; i < 40; i++) {
      await settle(50);
      const s = latest();
      if (s && Math.abs(s.voltage - V_SECOND) < 0.2) {
        trackedAfter = Date.now() - changedAt;
        break;
      }
    }
    await settle(400);
    show(`after change:`);
    findings.push(
      trackedAfter === undefined
        ? `Monitor did NOT track the change to ${V_SECOND} V (last saw ${latest()?.voltage} V).`
        : `Monitor tracked ${V_FIRST} V -> ${V_SECOND} V in ${trackedAfter}ms.`,
    );

    // --- 3. Cross-check the monitor against SCPI at the same moment. -----
    console.log('\n--- 3. Agreement between UDP frame and SCPI reads ---');
    const udpNow = await monitor.poll();
    const scpiVolts = await psu.measureVoltage();
    const scpiMode = await psu.getRegulationMode();
    console.log(`  UDP:  ${udpNow.state} ${udpNow.voltage.toFixed(3)} V`);
    console.log(`  SCPI: ${scpiMode} ${scpiVolts.toFixed(3)} V`);
    findings.push(
      `UDP vs SCPI: state ${udpNow.state}/${scpiMode} ` +
        `(${udpNow.state === scpiMode ? 'agree' : 'DISAGREE'}), ` +
        `voltage ${udpNow.voltage.toFixed(3)}/${scpiVolts.toFixed(3)} ` +
        `(delta ${Math.abs(udpNow.voltage - scpiVolts).toFixed(3)} V)`,
    );

    // --- 4. Try to force CC, never yet observed. -------------------------
    // No load is connected, so the only way to current-limit is to set the
    // limit to zero and let the supply fail to reach its voltage setpoint.
    console.log('\n--- 4. Attempt to observe CC (low current limit) ---');
    // A 0 A limit is rejected outright — this device answers `SYSTEM:ERROR?`
    // with **4**, a positive code absent from every published table (the
    // manual documents 0 and -1..-12 only). Recorded rather than worked
    // around; the attempt is guarded so it cannot abort the restore below.
    let ccNote = '';
    for (const limit of [0.1, 0.01]) {
      try {
        await psu.setCurrent(limit);
        await settle(800);
        const ccUdp = await monitor.poll();
        const ccScpi = await psu.getRegulationMode();
        console.log(
          `  limit ${limit} A -> UDP: ${ccUdp.state}  SCPI: ${ccScpi}  ` +
            `(${ccUdp.voltage.toFixed(3)} V, ${ccUdp.current.toFixed(3)} A)`,
        );
        ccNote =
          ccUdp.state === 'CC' || ccScpi === 'CC'
            ? `CC OBSERVED at ${limit} A limit — UDP=${ccUdp.state}, SCPI=${ccScpi}. First ever capture.`
            : `CC not reached at ${limit} A with no load — UDP=${ccUdp.state}, SCPI=${ccScpi}.`;
        if (ccUdp.state === 'CC') break;
      } catch (error) {
        console.log(`  limit ${limit} A rejected: ${(error as Error).message}`);
        ccNote = `Current limit ${limit} A rejected by device: ${(error as Error).message}`;
      }
    }
    findings.push(
      `${ccNote} CC needs a real load; the state type must stay open rather than ` +
        `being narrowed to what has been observed.`,
    );

    // --- 5. Poll rate under a live output. -------------------------------
    console.log('\n--- 5. Sustained poll rate ---');
    const rateStart = Date.now();
    let polls = 0;
    while (Date.now() - rateStart < 2000) {
      await monitor.poll();
      polls++;
    }
    const hz = polls / ((Date.now() - rateStart) / 1000);
    console.log(`  ${polls} polls in 2s = ${hz.toFixed(1)} Hz`);
    findings.push(
      `Sustained poll-on-reply with output live: ${hz.toFixed(1)} Hz.`,
    );
  } finally {
    // --- 6. Restore. Runs even on failure. -------------------------------
    console.log('\n--- 6. Restoring ---');
    try {
      await psu.setOutput(original.output);
      await psu.setVoltage(original.voltage);
      await psu.setCurrent(original.current);
      await settle(400);
      const v = await psu.getVoltage();
      const i = await psu.getCurrent();
      const o = await psu.getOutput();
      console.log(`  ${v} V, ${i} A, output ${o ? 'ON' : 'OFF'}`);
      findings.push(
        v === original.voltage &&
          i === original.current &&
          o === original.output
          ? 'Restored to original state exactly.'
          : `RESTORE MISMATCH — now ${v} V / ${i} A / output ${o}, was ` +
              `${original.voltage} V / ${original.current} A / output ${original.output}. CHECK THE UNIT.`,
      );
    } catch (error) {
      findings.push(
        `RESTORE FAILED: ${(error as Error).message} — CHECK THE UNIT.`,
      );
    }

    stop.abort();
    await loop;
    monitor.close();
    await psu.close();
  }

  console.log(
    `\n\n=== FINDINGS === (${samples.length} UDP samples, ${pollErrors} poll errors)`,
  );
  for (const [i, f] of findings.entries()) console.log(`${i + 1}. ${f}`);
  console.log();
}

main().catch((error: unknown) => {
  console.error('\nProbe aborted:', error);
  console.error('CHECK THE UNIT — the output may still be enabled.');
  process.exitCode = 1;
});
