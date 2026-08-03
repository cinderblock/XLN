/**
 * A fake XLN power supply, speaking SCPI over TCP.
 *
 * Emulates the behaviours that actually matter for testing this library:
 *
 * - Set commands return **nothing**; only queries produce a reply. This is the
 *   single most important property — the 0.6.x library assumed otherwise.
 * - Unrecognized commands push `-1` (command error) onto a FIFO error queue
 *   that drains on read, exactly like the real device. So if the library sends
 *   a command form the real firmware would reject, a test sees it.
 * - Framing quirks are configurable, so the transport can be tested against
 *   NUL padding, bare-CR terminators, and responses fragmented across packets.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { once } from 'node:events';

export interface MockDeviceOptions {
  /** Response to `*IDN?`. Defaults to an XLN6024-GL identity. */
  identity?: string;
  /** Line terminator the mock appends to replies. Defaults to `'\r\n'`. */
  terminator?: string;
  /** Pad every reply out to this many bytes with NULs. Off by default. */
  padTo?: number;
  /** Send replies one byte per TCP segment, to exercise reassembly. */
  fragmentResponses?: boolean;
  /** Delay before replying, in milliseconds. Used to test timeouts. */
  responseDelay?: number;
  /** Encode booleans as `ON`/`OFF` instead of `1`/`0`. */
  verboseBooleans?: boolean;
  /**
   * Hold this many replies and flush them together in a **single** TCP write.
   *
   * This is the case that breaks naive response correlation: two replies to
   * two *different* requests arriving in one segment. A handler that resolves
   * on the `data` event gets both concatenated, and every later request is
   * off by one from then on.
   */
  coalesceReplies?: number;
  /**
   * Per-reply delay in milliseconds, keyed by 1-based reply index.
   *
   * Use to make a specific reply arrive *after* its request has already timed
   * out, which is how a late reply reaches the `'unsolicited'` path.
   * Overrides {@link responseDelay} for that index.
   */
  replyDelay?: (index: number) => number | undefined;
  /**
   * Also serve the undocumented UDP status channel on port 9221.
   *
   * Off by default so tests that only care about SCPI are not slowed by the
   * availability probe, but **real hardware does have it** (verified on an
   * XLN6024, firmware 1.20), so turn it on for anything measurement-related.
   */
  udp?: boolean;
  /**
   * Minimum datagram size the UDP channel will answer.
   *
   * Real hardware ignores the payload content but is length-sensitive. Set
   * absurdly high to simulate a unit that does not speak UDP at all.
   */
  udpMinSize?: number;
}

interface MemorySlot {
  voltage: number;
  current: number;
}

export class MockDevice {
  private readonly server: Server;
  private udpSocket: UdpSocket | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly options: MockDeviceOptions;

  /** Every command line received, in order. Useful for asserting wire format. */
  readonly received: string[] = [];

  /** Replies emitted so far, for {@link MockDeviceOptions.replyDelay}. */
  private replyCount = 0;
  /** Replies held back by {@link MockDeviceOptions.coalesceReplies}. */
  private pendingBatch: string[] = [];

  // Device state.
  voltage = 0;
  current = 0;
  output = false;
  voltageLimit = 60.5;
  currentLimit = 24.5;
  voltageSlewRate = 1;
  currentSlewRate = 0.5;
  regulationMode: 'CV' | 'CC' = 'CV';
  overVoltageProtection = false;
  overVoltageLevel = 64;
  overCurrentProtection = false;
  overCurrentLevel = 24;
  overPowerProtection = false;
  overPowerLevel = 1440;
  cvToCcProtection = false;
  ccToCvProtection = false;
  protectionTripped = false;
  beep = true;
  keyLock = false;
  backlight = true;
  aux5V = false;
  powerOnMode = 0;
  powerOnVoltage = 0;
  powerOnCurrent = 0;
  powerOnState = false;
  memorySlot = 0;
  memory: MemorySlot[] = Array.from({ length: 10 }, () => ({
    voltage: 0,
    current: 0,
  }));
  statusBytes: [number, number, number] = [0, 0, 0];
  errors: number[] = [];

  private constructor(server: Server, options: MockDeviceOptions) {
    this.server = server;
    this.options = options;
  }

  static async start(options: MockDeviceOptions = {}): Promise<MockDevice> {
    return MockDevice.listen(0, options);
  }

  /**
   * Start on a specific port, to simulate a device coming back after a drop.
   */
  static async startOn(
    port: number,
    options: MockDeviceOptions = {},
  ): Promise<MockDevice> {
    return MockDevice.listen(port, options);
  }

  private static async listen(
    port: number,
    options: MockDeviceOptions,
  ): Promise<MockDevice> {
    const server = createServer();
    const device = new MockDevice(server, options);

    server.on('connection', (socket) => {
      device.sockets.add(socket);
      socket.setEncoding('latin1');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          device.handle(line, socket);
          index = buffer.indexOf('\n');
        }
      });
      socket.on('error', () => undefined);
      socket.on('close', () => device.sockets.delete(socket));
    });

    server.listen(port, '127.0.0.1');
    await once(server, 'listening');

    if (options.udp) {
      const udp = createSocket({ type: 'udp4', reuseAddr: true });
      udp.on('message', (message, remote) => {
        // Real hardware ignores the payload content entirely and only answers
        // datagrams of an accepted size.
        if (message.length < (options.udpMinSize ?? 1)) return;
        const frame = Buffer.from(device.statusFrame(), 'latin1');
        udp.send(frame, remote.port, remote.address, () => undefined);
      });
      udp.on('error', () => undefined);
      udp.bind(0, '127.0.0.1');
      await once(udp, 'listening');
      udp.unref();
      device.udpSocket = udp;
    }

    return device;
  }

  /** Stop only the UDP responder, leaving SCPI up. */
  async stopUdp(): Promise<void> {
    if (!this.udpSocket) return;
    const socket = this.udpSocket;
    this.udpSocket = undefined;
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => {
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  /** UDP status port, or undefined when the UDP channel is disabled. */
  get udpPort(): number | undefined {
    const address = this.udpSocket?.address();
    return typeof address === 'object' ? address.port : undefined;
  }

  /**
   * Build the 96-byte fixed-width status frame the real device sends.
   *
   * Layout observed on an XLN6024 (fw 1.20): state at offset 16, measured
   * volts at 35 followed by `V`, measured amps at 45 followed by `A`.
   */
  statusFrame(): string {
    const state = this.output ? this.regulationMode : 'OFF';
    const volts = (this.output ? this.voltage : 0).toFixed(3);
    const amps = (this.output ? this.current : 0).toFixed(3);
    const frame = Array.from({ length: 96 }, () => ' ');
    const put = (text: string, at: number): void => {
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char !== undefined) frame[at + i] = char;
      }
    };
    put(state, 16);
    put(volts, 35);
    put('V', 41);
    put(amps, 45);
    put('A', 51);
    return frame.join('');
  }

  /** The ephemeral port the mock is listening on. */
  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Mock device is not listening on a TCP port');
    }
    return address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {
        // Already closed.
      }
      this.udpSocket = undefined;
    }
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  /** Push an unsolicited line, to test that stray data cannot desynchronize. */
  emitUnsolicited(text: string): void {
    for (const socket of this.sockets) {
      socket.write(text + (this.options.terminator ?? '\r\n'));
    }
  }

  private bool(value: boolean): string {
    if (this.options.verboseBooleans) return value ? 'ON' : 'OFF';
    return value ? '1' : '0';
  }

  private reply(socket: Socket, text: string): void {
    const terminator = this.options.terminator ?? '\r\n';
    let payload = text + terminator;
    if (
      this.options.padTo !== undefined &&
      payload.length < this.options.padTo
    ) {
      payload = payload.padEnd(this.options.padTo, '\0');
    }

    this.replyCount += 1;
    const index = this.replyCount;

    const write = (data: string): void => {
      if (socket.destroyed) return;
      if (this.options.fragmentResponses) {
        for (const char of data) socket.write(char);
      } else {
        socket.write(data);
      }
    };

    // Coalescing: buffer until we have `coalesceReplies` of them, then emit
    // the whole batch as one write so they land in a single segment.
    const batchSize = this.options.coalesceReplies ?? 1;
    const send = (): void => {
      if (batchSize <= 1) {
        write(payload);
        return;
      }
      this.pendingBatch.push(payload);
      if (this.pendingBatch.length >= batchSize) {
        const batch = this.pendingBatch.join('');
        this.pendingBatch = [];
        write(batch);
      }
    };

    const delay =
      this.options.replyDelay?.(index) ?? this.options.responseDelay;
    if (delay) {
      setTimeout(send, delay);
    } else {
      send();
    }
  }

  /**
   * Flush any replies held back by {@link MockDeviceOptions.coalesceReplies}.
   *
   * Needed when the batch never fills — e.g. coalescing 2 but only 1 more
   * request is made.
   */
  flush(): void {
    if (this.pendingBatch.length === 0) return;
    const batch = this.pendingBatch.join('');
    this.pendingBatch = [];
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.write(batch);
    }
  }

  private handle(line: string, socket: Socket): void {
    const command = line.trim();
    if (command.length === 0) return;
    this.received.push(command);

    const spaceIndex = command.indexOf(' ');
    const head = (
      spaceIndex < 0 ? command : command.slice(0, spaceIndex)
    ).toUpperCase();
    const argument = spaceIndex < 0 ? '' : command.slice(spaceIndex + 1).trim();

    const response = this.queryResponse(head);
    if (response !== undefined) {
      this.reply(socket, response);
      return;
    }
    this.applyCommand(head, argument);
  }

  /** The reply for a query, or `undefined` if `head` is not a query. */
  private queryResponse(head: string): string | undefined {
    switch (head) {
      case '*IDN?':
        return (
          this.options.identity ??
          'B&K Precision, XLN6024-GL, 123A45678, 1.00-1.02'
        );
      case 'SYSTEM:ERROR?': {
        const code = this.errors.shift() ?? 0;
        return String(code);
      }
      case 'SYSTEM:SERIES?':
        return '123A45678';
      case 'MEASURE:VOLTAGE?':
      case 'FETCH:VOLTAGE?':
        return (this.output ? this.voltage : 0).toFixed(3);
      case 'MEASURE:CURRENT?':
      case 'FETCH:CURRENT?':
        return (this.output ? this.current : 0).toFixed(3);
      case 'SOURCE:VOLTAGE?':
        return this.voltage.toFixed(3);
      case 'SOURCE:CURRENT?':
        return this.current.toFixed(3);
      case 'OUTPUT?':
        return this.bool(this.output);
      case 'OUTPUT:STATE?':
        return this.regulationMode;
      case 'OUTPUT:LIMIT:VOLTAGE?':
        return this.voltageLimit.toFixed(3);
      case 'OUTPUT:LIMIT:CURRENT?':
        return this.currentLimit.toFixed(3);
      case 'OUTPUT:SR:VOLTAGE?':
        return this.voltageSlewRate.toFixed(4);
      case 'OUTPUT:SR:CURRENT?':
        return this.currentSlewRate.toFixed(4);
      case 'PROTECTION?':
        return this.bool(this.protectionTripped);
      case 'SOURCE:VOLTAGE:PROTECTION?':
        return this.bool(this.overVoltageProtection);
      case 'SOURCE:VOLTAGE:PROTECTION:LEVEL?':
        return this.overVoltageLevel.toFixed(3);
      case 'SOURCE:CURRENT:PROTECTION?':
        return this.bool(this.overCurrentProtection);
      case 'SOURCE:CURRENT:PROTECTION:LEVEL?':
        return this.overCurrentLevel.toFixed(3);
      case 'PROTECTION:OPP?':
        return this.bool(this.overPowerProtection);
      case 'PROTECTION:OPP:LEVEL?':
        return this.overPowerLevel.toFixed(1);
      case 'PROTECTION:CVCC?':
        return this.bool(this.cvToCcProtection);
      case 'PROTECTION:CCCV?':
        return this.bool(this.ccToCvProtection);
      case 'SYSTEM:BEEP?':
        return this.bool(this.beep);
      case 'SYSTEM:KEY:LOCK?':
        return this.bool(this.keyLock);
      case 'SYSTEM:LCD:BL?':
        return this.bool(this.backlight);
      case 'SYSTEM:E5V?':
        return this.bool(this.aux5V);
      case 'SYSTEM:POWER:TYPE?':
        return String(this.powerOnMode);
      case 'SYSTEM:POWER:VOLTAGE?':
        return this.powerOnVoltage.toFixed(3);
      case 'SYSTEM:POWER:CURRENT?':
        return this.powerOnCurrent.toFixed(3);
      case 'SYSTEM:POWER:STATE?':
        return this.bool(this.powerOnState);
      case 'MEMORY?':
        return String(this.memorySlot);
      case 'MEMORY:VSET?':
        return this.slot().voltage.toFixed(3);
      case 'MEMORY:ISET?':
        return this.slot().current.toFixed(3);
      case 'STATUS?':
        return this.statusBytes.join(',');
      default:
        return undefined;
    }
  }

  /** Apply a set command. Set commands produce no reply, ever. */
  private applyCommand(head: string, argument: string): void {
    const num = (): number => Number(argument);
    const flag = (): boolean => argument === '1' || /^on$/i.test(argument);

    switch (head) {
      case '*CLS':
        this.errors = [];
        return;
      case '*RST':
        this.output = false;
        this.voltage = 0;
        this.current = 0;
        return;
      case '*SAV':
        this.memory[num()] = {
          voltage: this.voltage,
          current: this.current,
        };
        return;
      case '*RCL': {
        const slot = this.memory[num()];
        if (slot) {
          this.voltage = slot.voltage;
          this.current = slot.current;
        }
        return;
      }
      case 'ABORT':
        return;
      case 'SOURCE:VOLTAGE':
        this.voltage = num();
        return;
      case 'SOURCE:CURRENT':
        this.current = num();
        return;
      case 'OUTPUT':
        this.output = flag();
        return;
      case 'OUTPUT:LIMIT:VOLTAGE':
        this.voltageLimit = num();
        return;
      case 'OUTPUT:LIMIT:CURRENT':
        this.currentLimit = num();
        return;
      case 'OUTPUT:SR:VOLTAGE':
        this.voltageSlewRate = num();
        return;
      case 'OUTPUT:SR:CURRENT':
        this.currentSlewRate = num();
        return;
      case 'OUTPUT:PROTECTION:CLEAR':
      case 'PROTECTION:CLEAR':
        this.protectionTripped = false;
        return;
      case 'SOURCE:VOLTAGE:PROTECTION':
        this.overVoltageProtection = flag();
        return;
      case 'SOURCE:VOLTAGE:PROTECTION:LEVEL':
        this.overVoltageLevel = num();
        return;
      case 'SOURCE:CURRENT:PROTECTION':
        this.overCurrentProtection = flag();
        return;
      case 'SOURCE:CURRENT:PROTECTION:LEVEL':
        this.overCurrentLevel = num();
        return;
      case 'PROTECTION:OPP':
        this.overPowerProtection = flag();
        return;
      case 'PROTECTION:OPP:LEVEL':
        this.overPowerLevel = num();
        return;
      case 'PROTECTION:CVCC':
        this.cvToCcProtection = flag();
        return;
      case 'PROTECTION:CCCV':
        this.ccToCvProtection = flag();
        return;
      case 'SYSTEM:BEEP':
        this.beep = flag();
        return;
      case 'SYSTEM:KEY:LOCK':
        this.keyLock = flag();
        return;
      case 'SYSTEM:LCD:BL':
        this.backlight = flag();
        return;
      case 'SYSTEM:E5V':
        this.aux5V = flag();
        return;
      case 'SYSTEM:POWER:TYPE':
        this.powerOnMode = num();
        return;
      case 'SYSTEM:POWER:VOLTAGE':
        this.powerOnVoltage = num();
        return;
      case 'SYSTEM:POWER:CURRENT':
        this.powerOnCurrent = num();
        return;
      case 'SYSTEM:POWER:STATE':
        this.powerOnState = flag();
        return;
      case 'SYSTEM:RECALL:DEFAULT':
        return;
      case 'MEMORY':
        this.memorySlot = num();
        return;
      case 'MEMORY:VSET':
        this.slot().voltage = num();
        return;
      case 'MEMORY:ISET':
        this.slot().current = num();
        return;
      case 'MEMORY:SAVE':
        return;
      default:
        // Unrecognized: the real device queues a command error silently.
        this.pushError(-1);
    }
  }

  /** Queue a device error, respecting the documented 10-entry depth. */
  pushError(code: number): void {
    if (this.errors.length < 10) this.errors.push(code);
  }

  private slot(): MemorySlot {
    const slot = this.memory[this.memorySlot];
    if (!slot) throw new Error(`Invalid memory slot ${this.memorySlot}`);
    return slot;
  }
}
