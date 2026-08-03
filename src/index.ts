/**
 * Remote control for B&K Precision XLN series programmable DC power supplies,
 * over SCPI on TCP port 5025.
 *
 * @example
 * ```ts
 * import { connect } from 'xln';
 *
 * await using psu = await connect({ host: '192.168.1.50' });
 *
 * await psu.setVoltage(12);
 * await psu.setCurrent(1);
 * await psu.setOutput(true);
 *
 * console.log(await psu.measureCurrent(), 'A');
 * ```
 */

export {
  XLN,
  connect,
  type XLNOptions,
  type PowerOnMode,
  type MeasureOptions,
  type Measurement,
} from './xln.js';

export {
  ScpiSocket,
  XLN_TCP_PORT,
  type CommandOptions,
  type ReconnectOptions,
  type ScpiChannel,
  type ScpiSocketOptions,
} from './transport.js';

export {
  UdpStatusChannel,
  XLN_UDP_PORT,
  parseUdpStatus,
  type UdpStatus,
  type UdpStatusOptions,
} from './udp.js';

export {
  XLNError,
  XLNConnectionError,
  XLNTimeoutError,
  XLNProtocolError,
  XLNDeviceError,
  XLNRangeError,
} from './errors.js';

export {
  XLN_MODELS,
  allModels,
  lookupModel,
  type Range,
  type XLNModelName,
  type XLNModelSpec,
} from './models.js';

export {
  describeErrorCode,
  type DeviceErrorInfo,
  type Identity,
  type RegulationMode,
  type XLNStatus,
} from './parse.js';
