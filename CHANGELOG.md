# Changelog

## 1.0.0-alpha.2

### Fixed

- **`getStatus()` decoded the wrong byte and reported every flag as `false`.**
  The manual calls the enable-flags byte "byte 0", but it arrives **last** on
  the wire. Measured on an XLN6024 (fw 1.20): enabling the output gives
  `000004`, OVP gives `000080`, OCP gives `000040` — all in the final byte, all
  matching the manual's byte-0 bit assignments. The response is now decoded as a
  24-bit big-endian value with byte 0 as the low byte.

### Confirmed against hardware

- `OUTPUT:STATE?` returns **`CV`** with the output enabled, matching the UDP
  frame's state field. Both are now verified rather than inferred.
- UDP frame values are **right-aligned**, so a wider reading shifts where its
  digits start (`4.998` at column 35, `23.995` at 34) but always ends two
  columns before its unit. The parser anchors on the unit markers and is
  unaffected either way.

## 1.0.0-alpha.1

Complete rewrite in TypeScript. The API is promise-based and breaking; see
[Migrating from 0.6.x](README.md#migrating-from-06x).

### Fixed

- **Responses could be silently mismatched to the wrong request.** `send()`
  armed a `once('data')` listener for every command, including set commands the
  device never answers. The orphaned listener consumed the next query's reply,
  shifting every subsequent reading by one for the rest of the session.
  Replaced with a serialized command queue and a receive buffer that frames on
  the terminator instead of trusting TCP `data` boundaries. Split and coalesced
  replies are both handled.
- **Setters resolved with `socket.write()`'s return value** — TCP backpressure
  state, not device acknowledgement. They now resolve only after the device has
  accepted the command (see `autoCheckErrors` below).
- **A lost reply hung the caller forever.** All commands now have a timeout.
- **`getOutputState()` did not report the output state.** It queried
  `OUTPUT:STATE?`, which returns the CV/CC regulation mode. Split into
  `getOutput()` (on/off) and `getRegulationMode()`.
- **Slew rates were undocumented as V/s.** They are V/ms and A/ms.
- **Commands were sent with a leading colon and 2013-era short forms.** The
  Output subsystem short form changed from `OUT` to `OUTP` between manual
  revisions, and `:OUT?` is documented in neither. All commands now use the
  long form with no leading colon, which every revision documents identically.
- **Commands were terminated with bare LF.** The manual specifies CRLF.
- `new Buffer(96)`, removed in modern Node, is gone with the UDP class.

### Removed

- **`udpXLN`.** Replaced by `UdpStatusChannel` (see Added). The port is real —
  my initial removal note claimed it was not, which was wrong and is retracted.
  It is a monitor-only status channel, not a control or discovery protocol, so
  a class shaped like a command interface was still the wrong abstraction.
- `tcpXLN` — replaced by `XLN` / `connect()`.
- The gulp + babel build.

### Added

- `measure()` — voltage, current, derived power and an optional CV/CC mode from
  a **single transaction**, so the readings describe the same moment. Two
  separate `await`s are a round trip apart and another caller's query can land
  between them, which on a transient load yields a V×I product that was never
  simultaneously true. `measurePower()` now uses it. Reported by the XLN-Control
  agent against `1.0.0-alpha.1`.
- **UDP status channel**, used by `measure()` by default. The supply has an
  undocumented UDP service on port 9221 that returns output state, voltage and
  current in one datagram sampled at a single instant, versus two or three SCPI
  round trips that each sample a different moment. Regulation mode comes free.
  Probed once at connect; falls back to SCPI silently if unavailable, and
  `udp: false` opts out. Monitor-only — all control stays on SCPI.
  Exposed directly as `UdpStatusChannel` / `parseUdpStatus`.
- `xln/testing` — the mock device the library's own suite runs against, so
  consumers can test without hardware. Reproduces fragmented replies, NUL
  padding, alternate terminators, coalesced replies, and late replies that
  arrive after their request has timed out.
- Full TypeScript types, dual ESM/CommonJS output, validated by `publint` and
  `attw` on every build.
- `autoCheckErrors` (default **on**): each write is followed by
  `SYSTEM:ERROR?`, throwing `XLNDeviceError` on a non-zero code. This firmware
  has no `*OPC?`, so it is the only way to know a setpoint was accepted.
- Client-side range validation from a per-model limit table, keyed off `*IDN?`.
  Covers all seven models including the non-zero minimums on the high-voltage
  units.
- Opt-in auto-reconnect with exponential backoff, plus `connected` /
  `disconnected` events.
- `AbortSignal` support on connect and on raw commands; per-command timeout
  overrides.
- `transaction()` for sequences that must not be interleaved.
- Typed error hierarchy under `XLNError`.
- `PROTECTION` subsystem including **over-power**, which 0.6.x omitted entirely.
- `getStatus()`, decoding the legacy `STATUS?` bitfield — the only way to read
  latched over-temperature and AC-low faults.
- Front-panel key lock, LCD backlight, aux 5 V output, power-on state
  configuration, and the `MEMORY` preset subsystem.
- `[Symbol.asyncDispose]` for `await using`.
- `bun run probe` and `bun run smoke` for testing against real hardware.

### Notes

- Requires Node 20.19 or newer.
- Dependencies are managed with Bun (`bun.lock`); the library targets Node and
  CI runs the suite on Node 20.19, 22 and 24.
- Releases go through GitHub Actions only. `prepublishOnly` refuses to run
  outside CI.
- Published under the `next` dist-tag. `0.6.4` remains `latest` until this has
  been exercised on real hardware.
- Several response encodings are undocumented in the B&K manuals and are parsed
  defensively. `bun run probe` resolves them against a real unit; please open an
  issue with its output.

## 0.6.4 and earlier

See the git history. Released November 2015.
