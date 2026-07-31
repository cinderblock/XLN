/**
 * Test helpers for code that talks to an XLN supply.
 *
 * ```ts
 * import { MockDevice } from 'xln/testing';
 * import { connect } from 'xln';
 *
 * const device = await MockDevice.start();
 * const psu = await connect({ host: '127.0.0.1', port: device.port });
 * ```
 *
 * This is the same mock the library's own test suite runs against, so it is
 * the authoritative model of the device's behaviour rather than a second,
 * drifting approximation of it. It emulates the properties that actually
 * matter — set commands reply with nothing, unrecognized commands queue a
 * command error — and can reproduce the framing pathologies the transport has
 * to survive: fragmented replies, NUL padding, alternate terminators,
 * coalesced replies to different requests, and late replies that arrive after
 * their request has timed out.
 */

export { MockDevice, type MockDeviceOptions } from './mock-device.js';
