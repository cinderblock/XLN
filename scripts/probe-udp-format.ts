/**
 * Map the undocumented UDP status protocol on port 9221.
 *
 * The XLN *does* answer UDP 9221 — but only to a fixed-size datagram, which is
 * why a plain `*IDN?\r\n` gets silence and the 2015 library's 96-byte
 * NUL-padded buffer gets a reply. This maps out:
 *
 *   - which payload lengths are accepted
 *   - whether the payload *content* matters at all
 *   - the layout of the fixed-width reply frame
 *   - whether broadcast works (i.e. whether this is a discovery mechanism)
 *
 *   bun run probe:udp:format 10.255.14.231
 *
 * Read-only: every payload is a query or empty. Nothing here can change the
 * output state or a setpoint.
 */

import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

const host = process.argv[2];
const PORT = 9221;
const LISTEN_MS = 900;

interface Reply {
  from: string;
  bytes: Buffer;
}

function send(
  target: string,
  payload: Buffer,
  broadcast = false,
): Promise<Reply[]> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const replies: Reply[] = [];
    socket.on('message', (message, remote) => {
      replies.push({ from: remote.address, bytes: Buffer.from(message) });
    });
    socket.on('error', () => {
      resolve(replies);
    });
    socket.bind(() => {
      if (broadcast) socket.setBroadcast(true);
      socket.send(payload, PORT, target, () => undefined);
      setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        resolve(replies);
      }, LISTEN_MS);
    });
  });
}

/** A fixed-length datagram containing `text`, NUL-padded, like the 2015 code. */
function padded(text: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  buffer.write(text, 'latin1');
  return buffer;
}

function show(reply: Reply): void {
  const text = reply.bytes.toString('latin1');
  console.log(`      from ${reply.from}, ${reply.bytes.length} bytes`);
  console.log(`      text: ${JSON.stringify(text)}`);
}

async function main(): Promise<void> {
  console.log('# XLN UDP 9221 format probe\n');

  if (host) {
    // --- 1. Which lengths are accepted? ---------------------------------
    console.log('## Payload length sensitivity (content = "*IDN?")\n');
    for (const length of [6, 16, 32, 48, 64, 95, 96, 97, 128, 256]) {
      const replies = await send(host, padded('*IDN?', length));
      console.log(
        `   ${String(length).padStart(3)} bytes -> ${
          replies.length > 0 ? 'REPLY' : 'silence'
        }`,
      );
      if (replies.length > 0 && length === 96) show(replies[0]!);
    }
    console.log();

    // --- 2. Does the content matter? ------------------------------------
    console.log('## Payload content sensitivity (all 96 bytes)\n');
    const payloads: [string, string][] = [
      ['*IDN?', '*IDN?'],
      ['MEAS:VOLT?', 'MEAS:VOLT?'],
      ['MEAS:CURR?', 'MEAS:CURR?'],
      ['VOUT?', 'VOUT?'],
      ['STATUS?', 'STATUS?'],
      ['(empty)', ''],
      ['(garbage)', 'ZZZQQQ!!!'],
    ];
    for (const [label, text] of payloads) {
      const replies = await send(host, padded(text, 96));
      console.log(
        `   ${label.padEnd(12)} -> ${replies.length > 0 ? 'REPLY' : 'silence'}`,
      );
      if (replies.length > 0) {
        console.log(
          `      ${JSON.stringify(replies[0]!.bytes.toString('latin1'))}`,
        );
      }
    }
    console.log();

    // --- 3. Field layout ------------------------------------------------
    console.log('## Reply frame layout\n');
    const sample = await send(host, padded('*IDN?', 96));
    if (sample.length > 0) {
      const text = sample[0]!.bytes.toString('latin1');
      console.log(`   length: ${sample[0]!.bytes.length} bytes`);
      console.log('   column ruler and content:');
      console.log(
        '   ' +
          Array.from({ length: Math.ceil(text.length / 10) }, (_, i) =>
            String(i * 10).padEnd(10),
          ).join(''),
      );
      console.log(`   ${text.replace(/ /g, '.')}`);
      // Non-space runs and where they start.
      const fields = [...text.matchAll(/\S+/g)].map((m) => ({
        at: m.index,
        value: m[0],
      }));
      console.log('   fields:');
      for (const field of fields) {
        console.log(
          `      offset ${String(field.at).padStart(3)}: ${field.value}`,
        );
      }
    }
    console.log();
  }

  // --- 4. Broadcast: is this a discovery mechanism? ----------------------
  console.log('## Broadcast with the 96-byte format (discovery?)\n');
  const targets = new Set<string>(['255.255.255.255']);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      const ip = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      targets.add(
        ip.map((o, i) => (o & mask[i]!) | (~mask[i]! & 0xff)).join('.'),
      );
    }
  }

  for (const target of targets) {
    const replies = await send(target, padded('*IDN?', 96), true);
    console.log(
      `   ${target.padEnd(18)} -> ${
        replies.length > 0 ? `${replies.length} REPLY` : 'silence'
      }`,
    );
    for (const reply of replies) show(reply);
  }
}

main().catch((error: unknown) => {
  console.error('Format probe failed:', error);
  process.exit(1);
});
