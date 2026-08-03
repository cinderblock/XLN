/**
 * Follow-up to `probe-contention.ts`: can concurrent sessions cross replies,
 * and how many will the device accept?
 *
 * The first probe established that a second TCP session is accepted and that
 * both sessions keep answering. But its crossed-reply check was worthless: it
 * asked A for `MEAS:VOLT?` and B for `MEAS:CURR?` with the output off, so both
 * correct answers were `"0"`. Two identical replies cannot demonstrate they
 * went to the right place.
 *
 * This fixes that by giving every session a command whose reply is *unique to
 * that session*, baselined first on a lone connection. Then all sessions query
 * at once, repeatedly. Any reply that does not match that session's baseline is
 * a crossed reply.
 *
 * **Safety.** Read-only, and restricted to commands the library already issues
 * on its core paths. Avoids the forms known to wedge this firmware (`OUTP?`,
 * `OUT?`, compound `;`, `*OPC?`, `MIN`/`MAX`). Nothing changes device state.
 *
 *   bun run probe:contention:deep 10.255.14.231
 */

import { Socket } from 'node:net';

const host = process.argv[2] ?? '10.255.14.231';
const PORT = 5025;
const TIMEOUT_MS = 3000;

/** Read-only commands whose replies are likely to differ from one another. */
const CANDIDATES = [
  '*IDN?',
  'SOURCE:VOLTAGE?',
  'SOURCE:CURRENT?',
  'OUTPUT:STATE?',
  'SOURCE:VOLTAGE:PROTECTION:LEVEL?',
  'SOURCE:CURRENT:PROTECTION:LEVEL?',
];

/** How many rounds of all-sessions-query-at-once. */
const ROUNDS = 25;
/** Upper bound on the session-count search, so a permissive device terminates. */
const MAX_SESSIONS = 12;

class Session {
  readonly name: string;
  private socket: Socket | undefined;
  private rx = '';
  private waiting: ((line: string) => void) | undefined;
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
      }
    });
    socket.on('close', () => (this.died ??= 'close'));
    socket.on('end', () => (this.died ??= 'FIN'));
    socket.on(
      'error',
      (e: NodeJS.ErrnoException) => (this.died ??= e.code ?? e.message),
    );

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

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}

const settle = (ms = 200): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  console.log(`\n=== Deep contention probe against ${host}:${PORT} ===`);
  console.log('Read-only. No state changes.\n');
  const findings: string[] = [];

  // --- 1. Baseline every candidate on ONE lone session. -------------------
  // Establishes the correct answer per command, with no concurrency in play.
  console.log('--- 1. Baseline each command alone ---');
  const solo = new Session('base');
  await solo.open();
  const baseline = new Map<string, string>();
  for (const command of CANDIDATES) {
    const reply = await solo.ask(command);
    console.log(`  ${command.padEnd(34)} -> ${JSON.stringify(reply)}`);
    if (!reply.startsWith('<')) baseline.set(command, reply);
    else console.log(`    (dropping ${command}: no usable reply)`);
  }
  solo.close();
  await settle();

  // Keep only commands with a reply unique across the set — that uniqueness is
  // the entire detection mechanism for a crossed reply.
  const byReply = new Map<string, string[]>();
  for (const [command, reply] of baseline) {
    byReply.set(reply, [...(byReply.get(reply) ?? []), command]);
  }
  const distinct = [...baseline.entries()].filter(
    ([, reply]) => byReply.get(reply)?.length === 1,
  );

  console.log(
    `\n  ${distinct.length} commands have mutually distinct replies:`,
  );
  for (const [command, reply] of distinct) {
    console.log(`    ${command.padEnd(34)} = ${JSON.stringify(reply)}`);
  }
  const ambiguous = [...byReply.entries()].filter(
    ([, cmds]) => cmds.length > 1,
  );
  for (const [reply, cmds] of ambiguous) {
    console.log(
      `    (ambiguous, excluded) ${cmds.join(', ')} all = ${JSON.stringify(reply)}`,
    );
  }

  if (distinct.length < 2) {
    console.log(
      '\nFewer than two distinguishable commands. Cannot test crossing.',
    );
    return;
  }

  // --- 2. Sustained concurrent traffic across N sessions. -----------------
  console.log(
    `\n--- 2. ${distinct.length} concurrent sessions, ${ROUNDS} rounds ---`,
  );
  const sessions: { session: Session; command: string; expect: string }[] = [];
  for (const [index, [command, expect]] of distinct.entries()) {
    const session = new Session(`S${index}`);
    await session.open();
    sessions.push({ session, command, expect });
  }
  console.log(`  ${sessions.length} sessions open simultaneously.`);

  let crossed = 0;
  let failed = 0;
  let checks = 0;
  const mismatches: string[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    const replies = await Promise.all(
      sessions.map(({ session, command }) => session.ask(command)),
    );
    for (const [i, reply] of replies.entries()) {
      const { command, expect, session } = sessions[i]!;
      checks++;
      if (reply === expect) continue;
      if (reply.startsWith('<')) {
        failed++;
        if (mismatches.length < 10) {
          mismatches.push(
            `round ${round} ${session.name} ${command}: ${reply}`,
          );
        }
        continue;
      }
      // A reply that is another session's expected answer is the smoking gun.
      const stolenFrom = sessions.find((s) => s.expect === reply);
      crossed++;
      if (mismatches.length < 10) {
        mismatches.push(
          `round ${round} ${session.name} asked ${command}, expected ${JSON.stringify(expect)}, ` +
            `got ${JSON.stringify(reply)}` +
            (stolenFrom
              ? ` <-- that is ${stolenFrom.session.name}'s answer (CROSSED)`
              : ''),
        );
      }
    }
  }

  for (const { session } of sessions) session.close();
  await settle();

  findings.push(
    `Concurrency: ${checks} queries across ${sessions.length} simultaneous sessions, ` +
      `${crossed} crossed replies, ${failed} timeouts/failures.`,
  );
  if (mismatches.length) {
    console.log('\n  Mismatches:');
    for (const m of mismatches) console.log(`    ${m}`);
  } else {
    console.log('\n  Every reply matched its own session. No crossing.');
  }

  // --- 3. How many sessions will it accept at once? -----------------------
  console.log(`\n--- 3. Session-count limit (up to ${MAX_SESSIONS}) ---`);
  const held: Session[] = [];
  let limit = 0;
  let limitReason = `at least ${MAX_SESSIONS} (search bound reached)`;
  for (let i = 0; i < MAX_SESSIONS; i++) {
    const session = new Session(`L${i}`);
    try {
      await session.open();
    } catch (error) {
      limitReason = `${i} — connect #${i + 1} refused: ${(error as Error).message}`;
      break;
    }
    // Accepting the TCP connection is not the same as servicing it: a backlog
    // can accept while the application never reads. Only a reply proves it.
    const reply = await session.ask('*IDN?');
    if (reply.startsWith('<')) {
      session.close();
      limitReason = `${i} — connect #${i + 1} accepted but did not answer (${reply})`;
      break;
    }
    held.push(session);
    limit = held.length;
    console.log(`  ${held.length} concurrent sessions, all answering`);
  }
  findings.push(
    `Max concurrent sessions that answer: ${limit} (limit: ${limitReason})`,
  );

  // Verify the *first* session still works with the maximum load on the device.
  if (held.length > 1) {
    const first = await held[0]!.ask('*IDN?');
    findings.push(
      `Oldest session with ${held.length} open: ${first.startsWith('<') ? `DEAD (${first})` : 'still answering'}`,
    );
  }
  for (const session of held) session.close();
  await settle(500);

  // --- 4. Health check. ---------------------------------------------------
  console.log('\n--- 4. Post-test health check ---');
  const final = new Session('Z');
  try {
    await final.open();
    const reply = await final.ask('*IDN?');
    findings.push(
      reply.startsWith('<')
        ? `UNIT UNHEALTHY: ${reply} — may need a power cycle`
        : `Unit healthy after test: ${reply}`,
    );
  } catch (error) {
    findings.push(
      `UNIT UNHEALTHY: ${(error as Error).message} — may need a power cycle`,
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
