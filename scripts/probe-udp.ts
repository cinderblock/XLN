/**
 * Does this device speak UDP at all?
 *
 * The 2015 library had a `udpXLN` class targeting UDP port 9221. Three
 * revisions of the B&K manual (2010, 2013, 2018) plus the datasheet contain
 * zero occurrences of "UDP", "9221", "broadcast" or "discovery" — they
 * document exactly three LAN paths: web (80), telnet (5024), raw socket
 * (5025). Port 9221 is an Aim-TTi convention, and TCP even there.
 *
 * That's an argument from absence, so with hardware on the bench this settles
 * it by experiment instead. It tries, in order:
 *
 *   1. Unicast `*IDN?` to UDP 9221, 5025 and 5024.
 *   2. The exact wire format the 2015 code used — a 96-byte NUL-padded buffer.
 *   3. Broadcast on 9221 and 5025, listening for any beacon (which is what a
 *      discovery protocol would look like if one existed).
 *
 *   bun run probe:udp 192.168.1.50
 *   bun run probe:udp                    # broadcast-only, no host needed
 *
 * Read-only: only queries are sent, and only ones that cannot change state.
 */

import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

const host = process.argv[2];
const LISTEN_MS = 1500;

/** Candidate ports, most-likely first. */
const PORTS = [9221, 5025, 5024];

interface Reply {
  from: string;
  port: number;
  text: string;
  hex: string;
}

/** Send one datagram and collect anything that comes back within LISTEN_MS. */
function ask(
  target: string,
  port: number,
  payload: Buffer,
  broadcast = false,
): Promise<Reply[]> {
  return new Promise((resolve) => {
    const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true });
    const replies: Reply[] = [];

    socket.on('message', (message, remote) => {
      replies.push({
        from: remote.address,
        port: remote.port,
        text: message.toString('latin1').replace(/\0+$/, ''),
        hex: [...message]
          .slice(0, 64)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' '),
      });
    });

    socket.on('error', () => {
      socket.close();
      resolve(replies);
    });

    socket.bind(() => {
      if (broadcast) socket.setBroadcast(true);
      socket.send(payload, port, target, () => undefined);
      setTimeout(() => {
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        resolve(replies);
      }, LISTEN_MS);
    });
  });
}

function report(label: string, replies: Reply[]): boolean {
  console.log(`## ${label}`);
  if (replies.length === 0) {
    console.log('   (silence)\n');
    return false;
  }
  for (const reply of replies) {
    console.log(`   ANSWERED from ${reply.from}:${reply.port}`);
    console.log(`   text : ${JSON.stringify(reply.text)}`);
    console.log(`   hex  : ${reply.hex}`);
  }
  console.log();
  return true;
}

/** Directed broadcast addresses for every local IPv4 interface. */
function broadcastAddresses(): string[] {
  const addresses = new Set<string>(['255.255.255.255']);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      const ip = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      addresses.add(
        ip.map((o, i) => (o & mask[i]!) | (~mask[i]! & 0xff)).join('.'),
      );
    }
  }
  return [...addresses];
}

async function main(): Promise<void> {
  console.log('# XLN UDP probe');
  console.log(`# ${new Date().toISOString()}\n`);

  let anyAnswer = false;

  if (host) {
    console.log(`--- Unicast to ${host} ---\n`);

    for (const port of PORTS) {
      const replies = await ask(host, port, Buffer.from('*IDN?\r\n', 'latin1'));
      anyAnswer = report(`*IDN? -> udp/${port}`, replies) || anyAnswer;
    }

    // The exact format the 2015 udpXLN used: 96-byte zero-padded buffer.
    const legacy = Buffer.alloc(96);
    legacy.write('*IDN?', 'latin1');
    anyAnswer =
      report(
        '2015 wire format (96-byte NUL-padded *IDN?) -> udp/9221',
        await ask(host, 9221, legacy),
      ) || anyAnswer;

    // What udpXLN.readStatus() actually sent — note it queried current, not
    // status, which is one of several signs that class was never finished.
    const legacyMeas = Buffer.alloc(96);
    legacyMeas.write('MEAS:CURR?', 'latin1');
    anyAnswer =
      report(
        '2015 readStatus() payload (MEAS:CURR?) -> udp/9221',
        await ask(host, 9221, legacyMeas),
      ) || anyAnswer;
  } else {
    console.log('No host given — running broadcast checks only.\n');
  }

  console.log('--- Broadcast (would reveal a discovery beacon) ---\n');
  for (const address of broadcastAddresses()) {
    for (const port of [9221, 5025]) {
      const replies = await ask(
        address,
        port,
        Buffer.from('*IDN?\r\n', 'latin1'),
        true,
      );
      anyAnswer = report(`*IDN? -> ${address}:${port}`, replies) || anyAnswer;
    }
  }

  console.log('---');
  if (anyAnswer) {
    console.log('Something answered over UDP. That contradicts the manuals —');
    console.log('please capture this output; it changes the design.');
  } else {
    console.log('Nothing answered on any UDP port, unicast or broadcast.');
    console.log('Consistent with the manuals: these supplies have no UDP');
    console.log('interface and no discovery protocol. TCP 5025 is the only');
    console.log('programmatic control path.');
  }
}

main().catch((error: unknown) => {
  console.error('UDP probe failed:', error);
  process.exit(1);
});
