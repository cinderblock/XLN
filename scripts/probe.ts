/**
 * Protocol probe — run this against a real XLN supply.
 *
 * The B&K manual leaves several response encodings undocumented. This script
 * resolves them empirically and prints a report you can paste into an issue.
 * Every answer it produces should become a test fixture.
 *
 *   bun run probe 192.168.1.50
 *
 * SAFETY: this is strictly read-only. It never enables the output, never
 * changes a setpoint, and never writes to non-volatile memory. The only
 * commands it sends are queries plus `*CLS`, which just empties the error
 * queue. It is safe to run on a supply with a load attached.
 *
 * It deliberately does NOT use src/transport.ts — the whole point is to test
 * the assumptions that transport is built on, so it speaks raw sockets and
 * hex-dumps what comes back.
 */

import { Socket } from 'node:net';
import { XLN_TCP_PORT } from '../src/transport.js';

const host = process.argv[2];
const port = Number(process.argv[3] ?? XLN_TCP_PORT);

if (!host) {
  console.error('Usage: bun run probe <host> [port]');
  console.error('Example: bun run probe 192.168.1.50');
  process.exit(1);
}

/** How long to keep listening after a command before calling it silent. */
const LISTEN_MS = 700;

interface Probe {
  command: string;
  /** Why we're asking, shown in the report. */
  question: string;
  raw: string;
  bytes: number[];
}

function hex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function printable(raw: string): string {
  return JSON.stringify(raw);
}

function describeTerminator(bytes: number[]): string {
  const tail: number[] = [];
  for (let i = bytes.length - 1; i >= 0; i--) {
    const b = bytes[i];
    if (b === 0x0a || b === 0x0d || b === 0x00) tail.unshift(b);
    else break;
  }
  if (tail.length === 0) return 'none (!)';
  return tail
    .map((b) => (b === 0x0a ? 'LF' : b === 0x0d ? 'CR' : 'NUL'))
    .join(' ');
}

async function openSocket(): Promise<Socket> {
  const socket = new Socket();
  socket.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.connect({ host, port }, () => {
      socket.removeAllListeners('error');
      resolve();
    });
  });
  return socket;
}

/** Send one command and collect every byte that arrives within LISTEN_MS. */
function ask(socket: Socket, command: string): Promise<Probe> {
  return new Promise<Probe>((resolve) => {
    const bytes: number[] = [];
    const onData = (chunk: Buffer): void => {
      bytes.push(...chunk);
    };
    socket.on('data', onData);
    socket.write(`${command}\r\n`);
    setTimeout(() => {
      socket.off('data', onData);
      resolve({
        command,
        question: '',
        raw: Buffer.from(bytes).toString('latin1'),
        bytes,
      });
    }, LISTEN_MS);
  });
}

async function main(): Promise<void> {
  console.log(`# XLN protocol probe — ${host}:${port}`);
  console.log(`# ${new Date().toISOString()}\n`);

  const socket = await openSocket();
  console.log('Connected.\n');

  // Start from a clean error queue so later readings mean something.
  socket.write('*CLS\r\n');
  await new Promise((r) => setTimeout(r, 200));

  const questions: { command: string; question: string }[] = [
    { command: '*IDN?', question: 'Identity — also tells us the model' },
    {
      command: 'SYSTEM:ERROR?',
      question: 'Error format: bare code, -000, or SCPI `0,"No error"`?',
    },
    {
      command: 'OUTPUT?',
      question: 'Boolean encoding: 0/1 or OFF/ON?',
    },
    {
      command: 'OUTPUT:STATE?',
      question: 'Regulation mode: literal CV/CC, or an integer?',
    },
    {
      command: 'STATUS?',
      question: 'Legacy 3-byte status: hex string, decimals, or raw bytes?',
    },
    {
      command: 'SOURCE:VOLTAGE?',
      question: 'Numeric format, and does it echo units?',
    },
    {
      command: 'OUTPUT:SR:VOLTAGE?',
      question: 'Slew rate — confirm the value is plausible as V/ms',
    },
    {
      command: 'SYSTEM:SERIES?',
      question: 'Serial number query — does it exist?',
    },
    // --- command-form acceptance -----------------------------------------
    {
      command: ':SOURCE:VOLTAGE?',
      question: 'Does the firmware accept a LEADING COLON? (we send none)',
    },
    {
      command: 'SOUR:VOLT?',
      question: 'Short form accepted?',
    },
    {
      command: 'OUTP?',
      question: 'Output subsystem short form per the 2018 manual',
    },
    {
      command: 'OUT?',
      question: 'Output short form per the 2013 manual — expected to FAIL',
    },
    {
      command: 'SOURCE:VOLTAGE?;SOURCE:CURRENT?',
      question: 'Are `;` COMPOUND commands accepted? (we never send them)',
    },
    {
      command: '*OPC?',
      question: 'Undocumented, but does it exist? Would give us write sync',
    },
    {
      command: 'SOURCE:VOLTAGE? MAX',
      question: 'MIN/MAX query params — would let us drop the model table',
    },
  ];

  const results: Probe[] = [];
  for (const { command, question } of questions) {
    const probe = await ask(socket, command);
    probe.question = question;
    results.push(probe);

    const answered = probe.bytes.length > 0;
    console.log(`## ${command}`);
    console.log(`   ${question}`);
    if (answered) {
      console.log(`   reply : ${printable(probe.raw)}`);
      console.log(`   hex   : ${hex(probe.bytes)}`);
      console.log(`   ends  : ${describeTerminator(probe.bytes)}`);
      const nuls = probe.bytes.filter((b) => b === 0).length;
      if (nuls > 0) console.log(`   NULs  : ${nuls} (padding is real)`);
    } else {
      console.log('   reply : (silence)');
    }
    console.log();

    // Drain any error the probe itself provoked, so the next reading is clean.
    await ask(socket, 'SYSTEM:ERROR?');
  }

  // --- concurrent sessions -----------------------------------------------
  console.log('## Second simultaneous connection');
  console.log('   Does the device accept two sessions on 5025 at once?');
  try {
    const second = await openSocket();
    const probe = await ask(second, '*IDN?');
    if (probe.bytes.length > 0) {
      console.log(
        `   ACCEPTED — second session answered ${printable(probe.raw)}`,
      );
      console.log('   (does not prove it is SAFE; replies may interleave)');
    } else {
      console.log('   Connected but did not answer — likely single-session.');
    }
    second.destroy();
  } catch (error) {
    console.log(`   REFUSED — ${(error as Error).message}`);
    console.log('   Single-session confirmed.');
  }
  console.log();

  socket.end();

  console.log('---');
  console.log('Paste this whole output into');
  console.log('https://github.com/cinderblock/XLN/issues so the answers can');
  console.log('become test fixtures in test/parse.test.ts.');
}

main().catch((error: unknown) => {
  console.error('Probe failed:', error);
  process.exit(1);
});
