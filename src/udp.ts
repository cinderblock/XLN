/**
 * The undocumented UDP status channel on port 9221.
 *
 * No B&K manual revision mentions this — it was found by probing an XLN6024 on
 * firmware 1.20. What it does:
 *
 * - You send a **fixed-size** datagram. The content is ignored entirely:
 *   `*IDN?`, an empty buffer and random bytes all produce the same reply. Only
 *   the length matters, and only some lengths work (6/16/32/48/64 and exactly
 *   96 are known good; 95, 97, 128 and 256 are silent).
 * - It replies with a 96-byte, space-padded, fixed-width ASCII frame carrying
 *   the output state and the measured voltage and current.
 * - It is unicast only; broadcast gets nothing, so it is not discovery.
 *
 * Why it is worth using: one datagram returns state, volts and amps **taken at
 * the same instant**, where the SCPI path needs two or three round trips that
 * each sample a different moment. And because the request carries no
 * information, there is no request/response correlation problem — every reply
 * is a complete, self-contained snapshot, so a reordered or duplicated
 * datagram is harmless.
 *
 * What it cannot do: change anything. It is a monitor, not a control channel.
 * All control still goes over SCPI on TCP 5025.
 */

import { createSocket, type Socket } from 'node:dgram';
import { XLNProtocolError, XLNTimeoutError } from './errors.js';
import type { RegulationMode } from './parse.js';

/** Default UDP port for the status channel. */
export const XLN_UDP_PORT = 9221;

/**
 * Size of the poll datagram.
 *
 * 96 matches both the reply size and what the 2015 library sent. Lengths in
 * the 65-95 range are not reliably accepted, so this is not made configurable
 * without good reason.
 */
const POLL_SIZE = 96;

export interface UdpStatusOptions {
  /** Hostname or IP of the supply. */
  host: string;
  /** UDP port. Defaults to {@link XLN_UDP_PORT}. */
  port?: number;
  /** How long to wait for a reply, in milliseconds. Defaults to 500. */
  timeout?: number;
}

/** A single status frame from the UDP channel. */
export interface UdpStatus {
  /**
   * Output state as reported by the frame.
   *
   * Observed as `OFF` with the output disabled. With the output enabled this
   * is expected to carry the regulation mode (`CV`/`CC`), but that is
   * **unverified** — hence the open type.
   */
  readonly state: RegulationMode | 'OFF';
  /** Whether the output is on, derived from {@link state}. */
  readonly output: boolean;
  /** Measured output voltage, in volts. */
  readonly voltage: number;
  /** Measured output current, in amps. */
  readonly current: number;
  /** `voltage * current`, in watts. */
  readonly power: number;
  /** `Date.now()` when the reply arrived. */
  readonly timestamp: number;
  /** The raw frame, for fields this parser does not model. */
  readonly raw: string;
}

/**
 * Parse a status frame.
 *
 * Tokenizes on whitespace rather than reading fixed byte offsets: the sample
 * frame has its fields at offsets 16/35/45, but those will shift as values
 * gain digits (`9.999` vs `24.000`), and column positions are exactly the kind
 * of thing that differs between models and firmware revisions.
 */
export function parseUdpStatus(frame: string, at = Date.now()): UdpStatus {
  const raw = frame.replace(/\0+$/, '');

  // Anchor on the unit markers rather than on whitespace or byte offsets.
  // Offsets shift as values gain digits, and the separating space disappears
  // entirely once a value is wide enough — the observed `0.000 V` becomes
  // `12.000V` — so neither column position nor token splitting is safe.
  const read = (unit: 'V' | 'A'): number | undefined => {
    const match = new RegExp(`([-+]?\\d*\\.?\\d+)\\s*${unit}(?![A-Za-z])`).exec(
      raw,
    );
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  };

  // The state is the leading word, before any reading.
  const stateMatch = /^\s*([A-Za-z]+)/.exec(raw);
  if (!stateMatch?.[1]) {
    throw new XLNProtocolError('Empty UDP status frame', raw);
  }

  const voltage = read('V');
  const current = read('A');
  if (voltage === undefined || current === undefined) {
    throw new XLNProtocolError(
      'Expected a voltage and a current in the UDP status frame',
      raw,
    );
  }

  const upper = stateMatch[1].toUpperCase();
  return {
    state: upper,
    output: upper !== 'OFF',
    voltage,
    current,
    power: voltage * current,
    timestamp: at,
    raw,
  };
}

/**
 * A polling client for the UDP status channel.
 *
 * Stateless by design: each {@link poll} sends one datagram and resolves with
 * the next reply. There is no connection to keep alive and nothing to
 * serialize, because every reply stands alone.
 */
export class UdpStatusChannel {
  readonly host: string;
  readonly port: number;
  readonly timeout: number;

  private socket: Socket | undefined;
  private closed = false;
  /** Resolvers for polls awaiting a reply, oldest first. */
  private waiting: ((frame: string) => void)[] = [];

  constructor(options: UdpStatusOptions) {
    this.host = options.host;
    this.port = options.port ?? XLN_UDP_PORT;
    this.timeout = options.timeout ?? 500;
  }

  /** Send one poll and resolve with the parsed reply. */
  async poll(): Promise<UdpStatus> {
    if (this.closed) {
      throw new XLNProtocolError('UDP status channel is closed', '');
    }
    const socket = this.ensureSocket();

    const frame = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== onFrame);
        reject(
          new XLNTimeoutError(
            `UDP poll ${this.host}:${this.port}`,
            this.timeout,
          ),
        );
      }, this.timeout);

      const onFrame = (text: string): void => {
        clearTimeout(timer);
        resolve(text);
      };

      this.waiting.push(onFrame);
      // Content is ignored by the device; only the length matters.
      socket.send(Buffer.alloc(POLL_SIZE), this.port, this.host, (error) => {
        if (error) {
          clearTimeout(timer);
          this.waiting = this.waiting.filter((w) => w !== onFrame);
          reject(error);
        }
      });
    });

    return parseUdpStatus(frame);
  }

  /**
   * Whether the device answers on this channel.
   *
   * Used to decide whether to prefer UDP for measurements. Never throws.
   */
  async available(): Promise<boolean> {
    try {
      await this.poll();
      return true;
    } catch {
      return false;
    }
  }

  /** Release the socket. Safe to call more than once. */
  close(): void {
    this.closed = true;
    this.waiting = [];
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closed.
      }
      this.socket = undefined;
    }
  }

  private ensureSocket(): Socket {
    if (this.socket) return this.socket;

    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (message) => {
      const next = this.waiting.shift();
      // A reply with nobody waiting is a late one from a timed-out poll.
      // Dropping it is safe here in a way it is not on TCP: every frame is a
      // complete snapshot, so nothing downstream is left misaligned.
      if (next) next(message.toString('latin1'));
    });
    socket.on('error', () => {
      // Errors surface as poll timeouts rather than killing the process.
    });
    socket.unref();
    this.socket = socket;
    return socket;
  }
}
