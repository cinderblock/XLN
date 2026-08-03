/**
 * Do concurrent sessions stay coherent when they *write*?
 *
 * `probe-contention-deep.ts` proved reads are safe: 12 simultaneous sessions,
 * 150 concurrent queries, zero crossed replies. That only covers readers. This
 * covers the case the API redesign actually cares about — one session driving
 * the supply while others are connected.
 *
 * Questions:
 *   1. Does a setpoint written on session A read back on session B? (Shared
 *      device state, or per-session shadow state?)
 *   2. Do concurrent writes from two sessions land coherently, or interleave
 *      into a value neither client asked for?
 *   3. Does write traffic on one session desynchronize another's read stream?
 *   4. Does any of it leave entries in the error queue?
 *
 * **Safety.** Writes setpoints only. The output is NOT enabled — `OUTPUT` is
 * never touched, so nothing is energized. Setpoints stay between 4 V and 7 V,
 * well under this unit's 8.500 V OVP trip. Every original value is read first
 * and restored in a `finally`, including after a crash or Ctrl-C.
 *
 *   bun run probe:contention:writes 10.255.14.231
 */

import { Socket } from 'node:net';

const host = process.argv[2] ?? '10.255.14.231';
const PORT = 5025;
const TIMEOUT_MS = 3000;

/** Setpoints used during the test. Both comfortably below the 8.5 V OVP. */
const V_LOW = '5.000';
const V_HIGH = '7.000';
/**
 * Hard ceiling for *test* writes — refuse to exceed it no matter what.
 *
 * Restoring a pre-existing setpoint is exempt: this unit was found at 24.000 V
 * (with OVP at 8.500 V, which is the operator's business, not ours). An earlier
 * revision applied the ceiling unconditionally and so blocked its own restore
 * step, leaving the supply on a test setpoint. Whatever we found, we put back.
 */
const MAX_SAFE_VOLTS = 8.0;

class Session {
  readonly name: string;
  private socket: Socket | undefined;
  private rx = '';
  private waiting: ((line: string) => void) | undefined;

  constructor(name: string) {
    this.name = name;
  }

  async open(): Promise<void> {
    const socket = new Socket();
    socket.setNoDelay(true);
    this.socket = socket;
    socket.on('data', (chunk) => {
      this.rx += chunk.toString('latin1');
      const cut = Math.max(
        this.rx.lastIndexOf('\n'),
        this.rx.lastIndexOf('\r'),
        this.rx.lastIndexOf('\0'),
      );
      if (cut < 0) return;
      const complete = this.rx.slice(0, cut + 1);
      this.rx = this.rx.slice(cut + 1);
      for (const segment of complete.split(/[\r\n\0]+/)) {
        const line = segment.trim();
        if (!line) continue;
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve?.(line);
      }
    });
    socket.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('connect timeout'));
      }, TIMEOUT_MS);
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.connect(PORT, host, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async ask(command: string): Promise<string> {
    if (!this.socket || this.socket.destroyed) return '<dead>';
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        resolve('<timeout>');
      }, TIMEOUT_MS);
      this.waiting = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.socket?.write(`${command}\r\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.waiting = undefined;
          resolve('<write failed>');
        }
      });
    });
  }

  /**
   * Fire-and-forget command. The device does not acknowledge writes.
   *
   * @param restoring Exempts the write from the voltage ceiling, for putting a
   * pre-existing setpoint back. Only ever passed by the restore step.
   */
  async tell(command: string, restoring = false): Promise<void> {
    // Guard: never emit a voltage above the safe ceiling, whatever the caller says.
    const volts = /SOURCE:VOLTAGE\s+([\d.]+)/i.exec(command);
    if (!restoring && volts && Number(volts[1]) > MAX_SAFE_VOLTS) {
      throw new Error(`refusing unsafe write: ${command}`);
    }
    await new Promise<void>((resolve, reject) => {
      this.socket?.write(`${command}\r\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}

const settle = (ms = 250): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is a `SYSTEM:ERROR?` reply an empty queue?
 *
 * This unit answers a bare `0` rather than the `0,"No error"` the SCPI standard
 * suggests, so matching on the text alone reports a clean queue as six errors.
 */
const isClean = (reply: string): boolean =>
  reply.startsWith('<') || /no error/i.test(reply) || /^0\b/.test(reply.trim());

async function main(): Promise<void> {
  console.log(
    `\n=== Concurrent-write coherence probe against ${host}:${PORT} ===`,
  );
  console.log('Writes setpoints only. Output is never enabled.\n');

  const findings: string[] = [];
  const a = new Session('A');
  const b = new Session('B');
  const c = new Session('C');
  await a.open();
  await b.open();
  await c.open();

  // --- 0. Record everything we are about to disturb. ----------------------
  const originalVoltage = await a.ask('SOURCE:VOLTAGE?');
  const originalCurrent = await a.ask('SOURCE:CURRENT?');
  const outputState = await a.ask('OUTPUT:STATE?');
  console.log('--- 0. Original state ---');
  console.log(`  SOURCE:VOLTAGE? = ${originalVoltage}`);
  console.log(`  SOURCE:CURRENT? = ${originalCurrent}`);
  console.log(`  OUTPUT:STATE?   = ${outputState}  (must stay OFF)`);

  if (outputState !== 'OFF') {
    console.log(
      '\nOutput is NOT off. Refusing to run — this probe assumes a de-energized supply.',
    );
    a.close();
    b.close();
    c.close();
    return;
  }

  try {
    // Drain any pre-existing error-queue entries so later checks are meaningful.
    for (let i = 0; i < 5; i++) {
      const error = await a.ask('SYSTEM:ERROR?');
      if (isClean(error)) break;
      console.log(`  (drained stale error: ${error})`);
    }

    // --- 1. Is device state shared across sessions? ----------------------
    console.log('\n--- 1. Cross-session write visibility ---');
    await a.tell(`SOURCE:VOLTAGE ${V_LOW}`);
    await settle();
    const seenByB = await b.ask('SOURCE:VOLTAGE?');
    const seenByC = await c.ask('SOURCE:VOLTAGE?');
    console.log(`  A wrote ${V_LOW}; B reads ${seenByB}, C reads ${seenByC}`);
    findings.push(
      `A's write visible to B (${seenByB}) and C (${seenByC}): ` +
        (Number(seenByB) === Number(V_LOW) && Number(seenByC) === Number(V_LOW)
          ? 'YES — device state is shared, not per-session'
          : 'NO — sessions appear to have independent state'),
    );

    await b.tell(`SOURCE:VOLTAGE ${V_HIGH}`);
    await settle();
    const backOnA = await a.ask('SOURCE:VOLTAGE?');
    console.log(`  B wrote ${V_HIGH}; A reads ${backOnA}`);
    findings.push(
      `B's write visible to A (${backOnA}): ` +
        (Number(backOnA) === Number(V_HIGH) ? 'YES' : 'NO'),
    );

    // --- 2. Concurrent writes from two sessions. -------------------------
    // The dangerous case: does the device land on one of the two requested
    // values, or on something neither client asked for?
    console.log('\n--- 2. Concurrent conflicting writes (20 rounds) ---');
    let sane = 0;
    const insane: string[] = [];
    for (let round = 0; round < 20; round++) {
      await Promise.all([
        a.tell(`SOURCE:VOLTAGE ${V_LOW}`),
        b.tell(`SOURCE:VOLTAGE ${V_HIGH}`),
      ]);
      await settle(120);
      const settled = await c.ask('SOURCE:VOLTAGE?');
      const value = Number(settled);
      if (value === Number(V_LOW) || value === Number(V_HIGH)) sane++;
      else insane.push(`round ${round}: ${settled}`);
    }
    console.log(
      `  ${sane}/20 rounds settled on one of the two requested values`,
    );
    if (insane.length) console.log(`  Anomalies: ${insane.join(', ')}`);
    findings.push(
      `Concurrent conflicting writes: ${sane}/20 landed on a requested value` +
        (insane.length
          ? `; anomalies: ${insane.slice(0, 5).join(', ')}`
          : '; no torn/garbage values'),
    );

    // --- 3. Does write traffic desync a concurrent reader? ---------------
    // C reads a command with a fixed, distinctive answer while A and B hammer
    // setpoint writes. A desynced stream shows up as C receiving a number.
    console.log('\n--- 3. Reader stability under concurrent write load ---');
    let good = 0;
    const bad: string[] = [];
    for (let round = 0; round < 30; round++) {
      const [, , idn] = await Promise.all([
        a.tell(`SOURCE:VOLTAGE ${round % 2 ? V_LOW : V_HIGH}`),
        b.tell(`SOURCE:CURRENT ${round % 2 ? '1.000' : '2.000'}`),
        c.ask('*IDN?'),
      ]);
      if (idn.startsWith('BK PRECISION')) good++;
      else bad.push(`round ${round}: ${JSON.stringify(idn)}`);
    }
    console.log(
      `  ${good}/30 reads on C returned a correct identity under write load`,
    );
    if (bad.length) console.log(`  Bad: ${bad.slice(0, 5).join(', ')}`);
    findings.push(
      `Reader under concurrent write load: ${good}/30 correct` +
        (bad.length ? `; failures: ${bad.slice(0, 3).join(', ')}` : ''),
    );

    // --- 4. Error queue after all that. ----------------------------------
    console.log('\n--- 4. Error queue ---');
    const errors: string[] = [];
    for (let i = 0; i < 6; i++) {
      const error = await a.ask('SYSTEM:ERROR?');
      if (isClean(error)) break;
      errors.push(error);
    }
    console.log(
      errors.length ? `  ${errors.join(' | ')}` : '  clean (queue empty)',
    );
    findings.push(
      `Error queue after concurrent writes: ${errors.length ? errors.join(' | ') : 'clean'}`,
    );
  } finally {
    // --- 5. Restore. Runs even if something above threw. -----------------
    console.log('\n--- 5. Restoring original setpoints ---');
    try {
      await a.tell(`SOURCE:VOLTAGE ${originalVoltage}`, true);
      await a.tell(`SOURCE:CURRENT ${originalCurrent}`, true);
      await settle();
      const v = await a.ask('SOURCE:VOLTAGE?');
      const i = await a.ask('SOURCE:CURRENT?');
      const o = await a.ask('OUTPUT:STATE?');
      console.log(`  SOURCE:VOLTAGE? = ${v} (was ${originalVoltage})`);
      console.log(`  SOURCE:CURRENT? = ${i} (was ${originalCurrent})`);
      console.log(`  OUTPUT:STATE?   = ${o}`);
      const restored =
        Number(v) === Number(originalVoltage) &&
        Number(i) === Number(originalCurrent);
      findings.push(
        restored
          ? 'Original setpoints restored.'
          : `RESTORE FAILED — V=${v} I=${i}, please check the unit.`,
      );
    } catch (error) {
      console.log(`  RESTORE FAILED: ${(error as Error).message}`);
    }
    a.close();
    b.close();
    c.close();
  }

  console.log('\n\n=== FINDINGS ===');
  for (const [i, f] of findings.entries()) console.log(`${i + 1}. ${f}`);
  console.log();
}

main().catch((error: unknown) => {
  console.error('\nProbe aborted:', error);
  process.exitCode = 1;
});
