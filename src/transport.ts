/**
 * SCPI-over-TCP transport for XLN supplies.
 *
 * Design notes, all driven by the device's actual behaviour:
 *
 * - **Every command is serialized.** The firmware has no request/response
 *   correlation — replies are bare values with no echo of the command. The
 *   only way to know which reply belongs to which query is to have at most one
 *   query outstanding. A promise chain enforces that regardless of how many
 *   callers hit the socket concurrently.
 *
 * - **Writes and queries are different operations.** Set commands (`*RST`,
 *   `OUTPUT 1`, ...) produce no reply at all. The 0.6.x library waited for one
 *   anyway, which left a dangling listener that consumed the *next* query's
 *   response and desynchronized the stream for the rest of the session.
 *
 * - **One command per write, Nagle disabled.** `setNoDelay()` was added in 2015
 *   with the commit message "Make sure each `.write()` is sent on its own",
 *   which reads as hard-won evidence that the firmware parser mishandles
 *   coalesced TCP segments. No manual example uses `;` compound commands
 *   either. So: never batch.
 *
 * - **Framing is tolerant.** The manual specifies CRLF on commands but never
 *   says what the device sends back, and 2015 testing found NUL padding in
 *   responses. CR, LF, and NUL are all treated as terminators and empty
 *   segments are discarded.
 */

import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { XLNConnectionError, XLNTimeoutError } from './errors.js';

/** Default raw-socket SCPI port for the XLN series. */
export const XLN_TCP_PORT = 5025;

/** Guards against unbounded memory growth if the device never terminates. */
const MAX_BUFFER_BYTES = 64 * 1024;

export interface ScpiSocketOptions {
  /** Hostname or IP address of the supply. */
  host: string;
  /** TCP port. Defaults to {@link XLN_TCP_PORT}. */
  port?: number;
  /**
   * How long to wait for a response to a query, in milliseconds.
   *
   * The datasheet quotes an average command response time of 50 ms, so the
   * 2000 ms default is generous. Defaults to 2000.
   */
  timeout?: number;
  /** How long to wait for the TCP connection itself. Defaults to 5000 ms. */
  connectTimeout?: number;
}

interface Pending {
  readonly command: string;
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Exclusive access to the socket, handed to {@link ScpiSocket.transaction}.
 *
 * Calls made through this interface bypass the queue — the transaction
 * already holds it — so they run back to back with nothing interleaved.
 */
export interface ScpiChannel {
  /** Send a command that produces no response. */
  write(command: string): Promise<void>;
  /** Send a query and resolve with the device's reply. */
  query(command: string): Promise<string>;
}

interface ScpiSocketEvents {
  /**
   * A complete line arrived while no query was outstanding.
   *
   * This should not happen against a healthy device; it usually means a
   * previous command timed out and its late reply has now shown up. The line
   * is discarded rather than being allowed to desynchronize the next query.
   */
  unsolicited: [line: string];
  /** The socket failed outside the scope of any individual command. */
  error: [error: Error];
  /** The connection closed, for any reason. */
  close: [];
}

/**
 * A serialized, line-framed SCPI connection.
 *
 * Most users want {@link XLN} instead; this is exported for anyone who needs
 * to send raw commands the typed API does not cover.
 */
export class ScpiSocket extends EventEmitter<ScpiSocketEvents> {
  readonly host: string;
  readonly port: number;
  readonly timeout: number;
  readonly connectTimeout: number;

  private socket: Socket | undefined;
  private rx = '';
  private pending: Pending | undefined;
  private pendingTimer: NodeJS.Timeout | undefined;
  /** Tail of the command queue; every command chains onto this. */
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: ScpiSocketOptions) {
    super();
    this.host = options.host;
    this.port = options.port ?? XLN_TCP_PORT;
    this.timeout = options.timeout ?? 2000;
    this.connectTimeout = options.connectTimeout ?? 5000;
  }

  /** True while the socket is open and usable. */
  get connected(): boolean {
    return this.socket !== undefined && !this.closed;
  }

  /** Open the connection. Rejects if it cannot be established. */
  async connect(): Promise<void> {
    if (this.socket) {
      throw new XLNConnectionError('Already connected');
    }

    const socket = new Socket();
    socket.setNoDelay(true);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new XLNConnectionError(
            `Timed out after ${this.connectTimeout} ms connecting to ` +
              `${this.host}:${this.port}`,
          ),
        );
      }, this.connectTimeout);

      socket.once('error', (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(
          new XLNConnectionError(
            `Failed to connect to ${this.host}:${this.port}: ${error.message}`,
            { cause: error },
          ),
        );
      });

      socket.connect({ host: this.host, port: this.port }, () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve();
      });
    });

    // Responses are ASCII, but the legacy `STATUS?` command is documented to
    // return "three bytes" of unknown encoding. latin1 maps every byte to a
    // distinct code point, so nothing is mangled on the way through.
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      this.onData(chunk);
    });
    socket.on('error', (error: Error) => {
      this.fail(new XLNConnectionError(error.message, { cause: error }));
    });
    socket.on('close', () => {
      this.fail(new XLNConnectionError('Connection closed by remote host'));
    });

    this.socket = socket;
    this.closed = false;
  }

  /**
   * Send a command that produces no response.
   *
   * Resolves once the bytes have been handed to the OS — the device sends
   * nothing back to confirm, and this firmware has no `*OPC?`. Use
   * `XLN`'s `autoCheckErrors` option, or query `SYS:ERR?` yourself, if you
   * need to know whether the command was accepted.
   */
  write(command: string): Promise<void> {
    return this.transaction((channel) => channel.write(command));
  }

  /** Send a query and resolve with the single line the device replies with. */
  query(command: string): Promise<string> {
    return this.transaction((channel) => channel.query(command));
  }

  /**
   * Run several commands with exclusive access to the connection.
   *
   * Nothing from another caller can interleave between them. Use this for any
   * sequence that must stay atomic — a read-modify-write, or a command
   * followed by an error check.
   *
   * ```ts
   * await socket.transaction(async (ch) => {
   *   await ch.write('SOURCE:VOLTAGE 12');
   *   return ch.query('SYSTEM:ERROR?');
   * });
   * ```
   */
  transaction<T>(fn: (channel: ScpiChannel) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.assertUsable();
      return fn(this.channel);
    });
  }

  /** Close the connection. Safe to call more than once. */
  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    this.socket = undefined;
    this.closed = true;

    await new Promise<void>((resolve) => {
      socket.removeAllListeners('close');
      socket.once('close', () => {
        resolve();
      });
      // Swallow errors raised by the shutdown itself.
      socket.on('error', () => undefined);
      socket.end();
      // Don't hang forever if the peer never completes the FIN exchange.
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 1000);
      timer.unref();
    });

    this.settleReject(new XLNConnectionError('Connection closed'));
    this.emit('close');
  }

  /** Supports `await using socket = new ScpiSocket(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // --- internals ---------------------------------------------------------

  /**
   * Chain `fn` onto the command queue.
   *
   * The `.then(fn, fn)` pair is deliberate: a rejected command must not stall
   * the queue behind it.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private assertUsable(): void {
    if (!this.socket || this.closed) {
      throw new XLNConnectionError('Not connected');
    }
  }

  /** Queue-bypassing channel; only valid while a transaction holds the queue. */
  private readonly channel: ScpiChannel = {
    write: async (command: string): Promise<void> => {
      this.assertUsable();
      await this.send(command);
    },
    query: async (command: string): Promise<string> => {
      this.assertUsable();
      // Arm the receiver before writing so a fast reply cannot be missed.
      const response = this.awaitLine(command);
      try {
        await this.send(command);
      } catch (error) {
        this.settleReject(
          error instanceof Error
            ? error
            : new XLNConnectionError(String(error)),
        );
        throw error;
      }
      return response;
    },
  };

  private send(command: string): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new XLNConnectionError('Not connected'));
    }
    return new Promise<void>((resolve, reject) => {
      // CRLF per the manual: "All commands are terminated with <CR> and <LF>".
      socket.write(`${command}\r\n`, (error) => {
        if (error) {
          reject(new XLNConnectionError(error.message, { cause: error }));
        } else {
          resolve();
        }
      });
    });
  }

  private awaitLine(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pending = { command, resolve, reject };
      this.pendingTimer = setTimeout(() => {
        this.settleReject(new XLNTimeoutError(command, this.timeout));
      }, this.timeout);
    });
  }

  private settleResolve(line: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPending();
    pending.resolve(line);
  }

  private settleReject(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPending();
    pending.reject(error);
  }

  private clearPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    this.pending = undefined;
  }

  private onData(chunk: string): void {
    this.rx += chunk;

    // CR, LF and NUL all terminate a response. CRLF is what the manual
    // specifies for commands; NUL padding was observed on real hardware.
    const lastDelimiter = Math.max(
      this.rx.lastIndexOf('\n'),
      this.rx.lastIndexOf('\r'),
      this.rx.lastIndexOf('\0'),
    );

    if (lastDelimiter < 0) {
      if (this.rx.length > MAX_BUFFER_BYTES) {
        this.rx = '';
        this.fail(
          new XLNConnectionError(
            `Received ${MAX_BUFFER_BYTES} bytes with no line terminator; ` +
              'discarding. Is something other than an XLN supply listening ' +
              'on this port?',
          ),
        );
      }
      return;
    }

    const complete = this.rx.slice(0, lastDelimiter + 1);
    this.rx = this.rx.slice(lastDelimiter + 1);

    for (const segment of complete.split(/[\r\n\0]+/)) {
      const line = segment.trim();
      if (line.length === 0) continue;
      if (this.pending) {
        this.settleResolve(line);
      } else {
        this.emit('unsolicited', line);
      }
    }
  }

  /** Handle a connection-level failure: fail the in-flight command, if any. */
  private fail(error: Error): void {
    const hadPending = this.pending !== undefined;
    this.settleReject(error);
    if (this.closed) return;
    this.closed = true;
    this.socket = undefined;
    // Only surface as an 'error' event if nobody was waiting on a command —
    // otherwise the rejection above already reported it, and an unhandled
    // 'error' event would take the whole process down.
    if (!hadPending && this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
    this.emit('close');
  }
}
