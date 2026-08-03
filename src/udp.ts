/**
 * The undocumented UDP status channel on port 9221.
 *
 * No B&K manual revision mentions this — it was found by probing an XLN6024 on
 * firmware 1.20. What it does:
 *
 * - The content is ignored entirely. `*IDN?`, an empty buffer and pure garbage
 *   all produce the same reply, and garbage never reaches the SCPI parser —
 *   verified by sending junk over UDP and finding `SYSTEM:ERROR?` still clean.
 * - **Only the datagram length matters: it must be even and at most 96 bytes.**
 *   0, 2, 4, 12, 64, 94 and 96 are accepted; 1, 3, 5, 11, 63, 95, 97, 98 and
 *   128 are silent. That is an alignment check, not a grammar check — it looks
 *   like a receiver copying into a 96-byte buffer in 16-bit words.
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
 *
 * **Why this exists at all:** the XLN is a rebadged Motech DS-6024, and its web
 * UI serves a Java applet, `Display.class`, which is Sun's 1995
 * `QuoteClientApplet` tutorial sample with five edits — a 96-byte buffer,
 * a `MEAS:CURR?` request prefilled into it, port 9221 hardcoded, a 500 ms poll
 * timer, and a custom `paint()`. That applet is the only UDP client the vendor ships,
 * it has no input path, and the web page's own Set/Output controls are plain
 * HTML form fields over HTTP. So this port exists to feed a status readout, and
 * the 96-byte size and ignored payload are both inherited from a tutorial echo
 * server rather than designed.
 */

import { createSocket, type Socket } from 'node:dgram';
import { XLNProtocolError, XLNTimeoutError } from './errors.js';
import type { RegulationMode } from './parse.js';

/** Default UDP port for the status channel. */
export const XLN_UDP_PORT = 9221;

/**
 * Size of the poll datagram.
 *
 * Any even length up to 96 works, including zero — the content is discarded
 * either way. 96 is used because that is what the vendor's own applet sends,
 * which is the size most likely to be accepted by firmware revisions nobody
 * has tested.
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
   * Observed as `OFF` with the output disabled. With the output **enabled** it
   * carries the regulation mode: B&K's own manual screenshots the Web Control
   * page with this exact display panel reading `CV` above `35.996 V  0.000 A`
   * — the same three fields in the same order. Not yet confirmed on this unit,
   * so the type stays open.
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
 * Anchors on the `V` and `A` unit markers rather than on byte offsets. The
 * vendor applet slices the frame at fixed columns, but the values inside are
 * right-aligned, so a wider reading shifts where the digits start — and column
 * positions are exactly the kind of thing that differs between models and
 * firmware revisions anyway.
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
