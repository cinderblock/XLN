/**
 * Find XLN supplies on the local network.
 *
 * There is no vendor discovery protocol for these units — no UDP beacon, no
 * mDNS, no LXI. The only way to find one is to try connecting to the SCPI
 * port and ask `*IDN?`. That is a network scan, which is why this is a
 * development script and not part of the library.
 *
 *   bun run discover                      # sweep every local /24
 *   bun run discover 10.255.0.0/20        # sweep a specific range
 *
 * Read-only: it opens a TCP connection, sends `*IDN?`, and disconnects.
 */

import { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { XLN_TCP_PORT } from '../src/transport.js';

let port: number = XLN_TCP_PORT;

const CONCURRENCY = 400;
const CONNECT_TIMEOUT = 500;
const REPLY_TIMEOUT = 800;

interface Found {
  host: string;
  idn: string;
}

/** Expand a CIDR into host addresses, skipping network and broadcast. */
function expand(cidr: string): string[] {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText ?? 32);
  if (!base || !Number.isInteger(bits) || bits < 8 || bits > 32) {
    throw new Error(`Unusable CIDR: ${cidr}`);
  }
  const octets = base.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o))) {
    throw new Error(`Unusable address: ${base}`);
  }
  const start =
    ((octets[0]! << 24) |
      (octets[1]! << 16) |
      (octets[2]! << 8) |
      octets[3]!) >>>
    0;
  const size = 2 ** (32 - bits);
  const network = (start & (size === 2 ** 32 ? 0 : ~(size - 1))) >>> 0;

  const hosts: string[] = [];
  // Skip .0 and .255 for anything bigger than a /31.
  const first = size > 2 ? 1 : 0;
  const last = size > 2 ? size - 1 : size;
  for (let i = first; i < last; i++) {
    const address = (network + i) >>> 0;
    hosts.push(
      [
        (address >>> 24) & 0xff,
        (address >>> 16) & 0xff,
        (address >>> 8) & 0xff,
        address & 0xff,
      ].join('.'),
    );
  }
  return hosts;
}

/** Local /24s, derived from the machine's own interfaces. */
function localRanges(): string[] {
  const ranges = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      // Link-local is never where an instrument lives.
      if (address.address.startsWith('169.254.')) continue;
      const parts = address.address.split('.');
      ranges.add(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`);
    }
  }
  return [...ranges];
}

/** Connect, ask *IDN?, and return the reply if anything answers. */
function probe(host: string): Promise<Found | undefined> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    let buffer = '';

    const done = (result?: Found): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const connectTimer = setTimeout(() => {
      done();
    }, CONNECT_TIMEOUT);

    socket.setNoDelay(true);
    socket.setEncoding('latin1');
    socket.on('error', () => {
      done();
    });

    socket.connect({ host, port }, () => {
      clearTimeout(connectTimer);
      // Something is listening. Give it a chance to identify itself.
      setTimeout(() => {
        done();
      }, REPLY_TIMEOUT);
      socket.write('*IDN?\r\n');
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (/[\r\n\0]/.test(buffer)) {
        const idn = buffer.replace(/\0/g, '').trim();
        if (idn.length > 0) done({ host, idn });
      }
    });
  });
}

async function sweep(hosts: string[]): Promise<Found[]> {
  const found: Found[] = [];
  let index = 0;
  let scanned = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = index++;
      const host = hosts[i];
      if (host === undefined) return;
      const result = await probe(host);
      scanned++;
      if (scanned % 500 === 0) {
        process.stderr.write(`  ...${scanned}/${hosts.length}\n`);
      }
      if (result) {
        found.push(result);
        console.log(`  FOUND ${result.host} -> ${result.idn}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, hosts.length) }, worker),
  );
  return found;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const portFlag = argv.findIndex((a) => a === '--port');
  if (portFlag >= 0) {
    const value = Number(argv[portFlag + 1]);
    if (!Number.isInteger(value)) throw new Error('--port needs a number');
    port = value;
    argv.splice(portFlag, 2);
  }
  const targets = argv.length > 0 ? argv : localRanges();

  console.log(`Scanning port ${port} on:`);
  for (const range of targets) console.log(`  ${range}`);
  console.log();

  const hosts = targets.flatMap(expand);
  console.log(`${hosts.length} addresses...\n`);

  const found = await sweep(hosts);

  console.log();
  if (found.length === 0) {
    console.log(`Nothing answered on port ${port}.`);
    console.log('Check that the supply is a -GL model and that the front');
    console.log('panel has System Setting -> Remote Control -> Ethernet set,');
    console.log('with a static IP on a subnet this machine can reach.');
    process.exitCode = 1;
    return;
  }
  console.log(`Found ${found.length}:`);
  for (const { host, idn } of found) console.log(`  ${host}  ${idn}`);
}

main().catch((error: unknown) => {
  console.error('Discovery failed:', error);
  process.exit(1);
});
