/**
 * Are two concurrent TCP sessions to the supply safe?
 *
 * This is the one load-bearing unknown behind the monitor-first API redesign
 * (`plans/monitor-first-api.md`). The record on it is a mess worth summarizing:
 *
 * - Round 3 of the XLN-Control exchange stated as fact that the supply
 *   "forcibly disconnects the existing client when a second client connects."
 * - Round 4 **retracted** that: it was second-hand, and the probe run it came
 *   from had skipped the second-connection test entirely while the unit wedged
 *   anyway. See `plans/consumer-requests-xln-control-round-4.md:22`.
 * - A stale `workspace-contention` marker still repeats the retracted claim as
 *   a hard warning, which is how a withdrawn finding keeps steering decisions.
 *
 * So nobody has actually watched what happens. This does, on the wire.
 *
 * **Safety.** Read-only: every command here is from the set already known to
 * answer correctly on this firmware. It deliberately avoids the forms that take
 * the unit off the network until power-cycled (`OUTP?`, `OUT?`, compound `;`,
 * `*OPC?`, `MIN`/`MAX` parameters) — see `plans/xln-modernization.md:512`.
 * Nothing here changes output state, setpoints or protection config.
 *
 *   bun run probe:contention 10.255.14.231
 */

import { Socket } from 'node:net';

const host = process.argv[2] ?? '10.255.14.231';
const PORT = 5025;
const TIMEOUT_MS = 3000;

/** Commands known to answer correctly on fw 1.20. Read-only, all of them. */
const IDN = '*IDN?';
const VOLT = 'MEAS:VOLT?';
const CURR = 'MEAS:CURR?';

interface Event {
  at: number;
  who: string;
  what: string;
}

const started = Date.now();
const timeline: Event[] = [];

function note(who: string, what: string): void {
  const at = Date.now() - started;
  timeline.push({ at, who, what });
  console.log(`[${String(at).padStart(5)}ms] ${who.padEnd(3)} ${what}`);
}

/**
 * A raw SCPI session that records every transport event it sees.
 *
 * Deliberately not `ScpiSocket` — the point is to observe close, reset and
 * error exactly as the kernel reports them, with no reconnect logic or error
 * translation in the way.
 */
class Session {
  readonly name: string;
  private socket: Socket | undefined;
  private rx = '';
  private waiting: ((line: string) => void) | undefined;

  /** Set as soon as the peer closes, resets or errors on us. */
  died: string | undefined;

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
        if (resolve) resolve(line);
        else note(this.name, `!! unsolicited data: ${JSON.stringify(line)}`);
      }
    });

    // The three ways the device can end this session under us. Which one fires
    // — and whether it fires the instant another client connects — is the
    // entire question.
    socket.on('close', (hadError) => {
      this.died ??= hadError ? 'close(hadError)' : 'close';
      note(this.name, `<- socket close${hadError ? ' (with error)' : ''}`);
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      this.died ??= error.code ?? error.message;
      note(this.name, `<- socket error ${error.code ?? error.message}`);
    });
    socket.on('end', () => {
      this.died ??= 'FIN';
      note(this.name, '<- FIN from device (graceful close)');
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`connect timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.connect(PORT, host, () => {
        clearTimeout(timer);
        note(this.name, `-> TCP connected (local port ${socket.localPort})`);
        resolve();
      });
    });
  }

  /** Send one query; resolve with the reply, or an explicit failure string. */
  async ask(command: string): Promise<string> {
    if (!this.socket || this.socket.destroyed) return '<socket already dead>';
    note(this.name, `-> ${command}`);

    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        note(this.name, `<- TIMEOUT after ${TIMEOUT_MS}ms`);
        resolve('<timeout>');
      }, TIMEOUT_MS);

      this.waiting = (line) => {
        clearTimeout(timer);
        note(this.name, `<- ${JSON.stringify(line)}`);
        resolve(line);
      };

      this.socket?.write(`${command}\r\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.waiting = undefined;
          note(this.name, `<- write failed: ${error.message}`);
          resolve('<write failed>');
        }
      });
    });
  }

  close(): void {
    if (!this.socket) return;
    note(this.name, '-> closing');
    this.socket.destroy();
    this.socket = undefined;
  }
}

/** Give the device a moment to react to something we just did. */
const settle = (ms = 400): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  console.log(`\n=== TCP contention probe against ${host}:${PORT} ===`);
  console.log('Read-only. No output, setpoint or protection changes.\n');

  const findings: string[] = [];

  // --- 1. Baseline: one session, known good. ------------------------------
  console.log('--- 1. Baseline: session A alone ---');
  const a = new Session('A');
  await a.open();
  const baseline = await a.ask(IDN);
  if (baseline.startsWith('<')) {
    console.log('\nBaseline query failed. The unit may already be wedged.');
    console.log(
      'Stopping before the actual test — nothing below would mean anything.',
    );
    a.close();
    return;
  }
  findings.push(`Baseline: A answers ${IDN} -> ${baseline}`);

  // --- 2. The actual question: B connects while A is open. ----------------
  console.log('\n--- 2. Session B connects while A is still open ---');
  const b = new Session('B');
  let bConnected = true;
  try {
    await b.open();
  } catch (error) {
    bConnected = false;
    note('B', `!! connect refused: ${(error as Error).message}`);
    findings.push(`B could NOT connect: ${(error as Error).message}`);
  }

  // The eviction claim predicts A dies at this instant, before any traffic.
  await settle();
  findings.push(
    bConnected
      ? `Second TCP connection ACCEPTED. A ${a.died ? `DIED (${a.died})` : 'still open'} on B connect.`
      : 'Second TCP connection REFUSED at the TCP layer.',
  );

  if (bConnected) {
    // --- 3. Does the *older* session still work? -------------------------
    console.log('\n--- 3. Does A still answer after B connected? ---');
    const aAfter = await a.ask(IDN);
    findings.push(`A after B connected: ${aAfter}`);

    // --- 4. Does the *newer* session work? -------------------------------
    console.log('\n--- 4. Does B answer? ---');
    const bAfter = await b.ask(IDN);
    findings.push(`B answers: ${bAfter}`);

    // --- 5. Concurrent traffic: are replies delivered to the right peer? --
    // Distinct commands so a cross-delivered reply is obvious: an identity
    // string arriving where a number was expected, or vice versa.
    console.log(
      '\n--- 5. Concurrent interleaved queries (crossed replies?) ---',
    );
    const [aVolt, bCurr] = await Promise.all([a.ask(VOLT), b.ask(CURR)]);
    const numeric = (s: string): boolean => Number.isFinite(Number(s));
    findings.push(
      `Interleaved: A got ${JSON.stringify(aVolt)} (${numeric(aVolt) ? 'numeric, sane' : 'NOT NUMERIC'}), ` +
        `B got ${JSON.stringify(bCurr)} (${numeric(bCurr) ? 'numeric, sane' : 'NOT NUMERIC'})`,
    );

    // --- 6. Does closing B disturb A? ------------------------------------
    console.log('\n--- 6. Close B, check A survives ---');
    b.close();
    await settle();
    const aAfterBClosed = await a.ask(IDN);
    findings.push(`A after B closed: ${aAfterBClosed}`);
  }

  a.close();
  await settle();

  // --- 7. Connect/disconnect churn — the light-touch risk. ---------------
  // `withControl()` opens and closes a session per scope. Nobody has tested
  // whether this firmware tolerates that, and it wedges from other things.
  console.log('\n--- 7. Churn: 10x connect -> query -> close ---');
  let churnOk = 0;
  let churnFail: string | undefined;
  const churnStart = Date.now();
  for (let i = 0; i < 10; i++) {
    const s = new Session(`C${i}`);
    try {
      await s.open();
      const reply = await s.ask(IDN);
      if (reply.startsWith('<')) {
        churnFail ??= `cycle ${i}: ${reply}`;
      } else churnOk++;
    } catch (error) {
      churnFail ??= `cycle ${i}: ${(error as Error).message}`;
    }
    s.close();
    await settle(150);
  }
  const churnMs = Date.now() - churnStart;
  findings.push(
    `Churn: ${churnOk}/10 connect-query-close cycles succeeded ` +
      `(${Math.round(churnMs / 10)}ms per cycle incl. 150ms pause)` +
      (churnFail ? `; first failure: ${churnFail}` : ''),
  );

  // --- 8. Is the unit still healthy afterwards? --------------------------
  console.log('\n--- 8. Post-test health check ---');
  const final = new Session('Z');
  try {
    await final.open();
    const reply = await final.ask(IDN);
    findings.push(
      reply.startsWith('<')
        ? `UNIT UNHEALTHY after test: ${reply} -- may need a power cycle`
        : `Unit healthy after test: ${reply}`,
    );
  } catch (error) {
    findings.push(
      `UNIT UNHEALTHY after test: ${(error as Error).message} -- may need a power cycle`,
    );
  }
  final.close();

  console.log('\n\n=== FINDINGS ===');
  for (const [i, f] of findings.entries()) console.log(`${i + 1}. ${f}`);
  console.log();
}

main().catch((error: unknown) => {
  console.error('\nProbe aborted:', error);
  process.exitCode = 1;
});
