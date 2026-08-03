# XLN Modernization

Bringing the `xln` npm package (last touched November 2015) up to current standards.

## Goal

`xln` is a remote-control library for B&K Precision XLN-series programmable DC power
supplies, speaking SCPI over TCP. It is published on npm as `xln`, currently at
`0.6.4`, maintained by `cinderblock`.

The 2015 code is ES2015 modules compiled by gulp 3 + `babel-preset-es2015` — a
toolchain that does not run on any supported Node version. The library API is
callback-based and has a protocol-level defect that makes it unreliable for anything
beyond one-command-at-a-time use.

Target: a TypeScript, promise-based, tested, CI-built `1.0.0` with a correct
transport layer and a command set that matches the actual device manual.

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\XLN`, branch `master`, remote
  `github.com/cinderblock/XLN`
- Node v24.18.0, npm 11.16.0, bun 1.3.0 available locally
- Tooling versions current as of 2026-07-31: TypeScript 7.0.2, tsdown 0.22.14,
  vitest 4.1.10, eslint 10.8.0, prettier 3.9.6, `@types/node` 26.1.2
- npm published versions: 0.0.1 → 0.6.4 (17 releases), all from Nov 2015
- **Hardware is available** — Cameron can plug in a real XLN unit. This matters; see
  "Open questions" below, several of which are only answerable on the bench.

## Decisions already made (don't re-ask)

1. **Promise/async rewrite, breaking, → 1.0.0.** No callback shim. Method names stay
   recognizable so porting from 0.6.x is mechanical, and the README carries a
   migration table.
2. **Full modern tooling.** TypeScript, dual ESM+CJS output, vitest, eslint flat
   config + prettier, GitHub Actions for test matrix and for publishing with
   provenance.
3. **Mock device for CI, plus real-hardware scripts.** Tests must pass with no
   hardware attached; a probe script and a smoke script exist for the real unit.
4. **Publish `1.0.0-alpha.1` to the `next` dist-tag** once green. Explicitly _not_
   `latest` — 0.6.4 stays as `latest` so `npm i xln` does not break the handful of
   existing users until the alpha has been exercised on hardware.
5. **Releases go through GitHub Actions, exclusively. Never `npm publish` from a
   CLI.** CI publishing gives provenance attestation, a reproducible build from a
   clean checkout, and an auditable record tied to a commit; a local publish has
   none of those and can ship a dirty tree or a stale `dist/`. It also keeps npm
   credentials in repo secrets rather than on a workstation. Enforced by
   `scripts/guard-publish.ts`, wired to `prepublishOnly`, which hard-fails when
   `CI` is unset.

## Release process

1. Bump the version in `package.json` and commit.
2. `git tag v<version> && git push origin master --tags`.
3. `.github/workflows/release.yml` runs the full check suite, then
   `npm publish --provenance`. It picks the dist-tag automatically: any
   prerelease version (`1.0.0-alpha.1`) goes to `next`, a plain version goes to
   `latest`. `workflow_dispatch` allows overriding the tag by hand.

One-time setup still required — **no secrets involved**. Publishing uses npm
**trusted publishing** (OIDC), so there is no `NPM_TOKEN` anywhere:

- On npmjs.com, under the `xln` package's _Settings → Trusted publisher_: choose
  GitHub Actions, organization `cinderblock`, repository `XLN`, workflow
  filename `release.yml`. Leave the environment blank (the job declares none).
- The workflow already requests `id-token: write`, which is what npm exchanges
  for a short-lived credential. Provenance is then automatic, so `--provenance`
  is not passed explicitly.
- The trust is bound to the workflow **filename**. Renaming `release.yml` breaks
  publishing until the npm setting is changed to match.
- npm >= 11.5.1 is required; the job upgrades npm explicitly so a Node image
  update cannot silently regress it.

## Protocol research findings

Full sourced report was produced 2026-07-31 from three revisions of the official B&K
manual. Primary source: [XLN Series manual, © 2009-2018](https://bkpmedia.s3.us-west-1.amazonaws.com/downloads/manuals/en-us/XLN_Series_manual.pdf)
(203 pp; it is a combined document — PDF pp. 1-97 cover XLN3640/6024/8018/10014,
PDF pp. 98-203 cover XLN15010/30052/60026).

### Findings that change the design

- ~~**UDP / port 9221 does not exist on this device.**~~ **RETRACTED — WRONG.**
  See "UDP 9221 IS REAL" below, and "SOLVED: the protocol is a Java applet". UDP
  9221 exists, the vendor's own Java applet uses it, and the `udpXLN` class did
  work. What remains true from the original note: the manuals really do contain
  zero occurrences of "UDP"/"9221"/"broadcast"/"discovery" and document only web
  (80), Telnet (5024) and raw sockets (5025); and there is genuinely **no
  discovery mechanism**, because the applet learns the address from
  `getCodeBase()` and never needed one. The Aim-TTi 9221 convention is real but
  is TCP and appears to be an unrelated coincidence.

- **Set commands return nothing.** `*CLS`, `*RST`, `*SAV`, `*RCL`, `ABOR`,
  `OUTP:PROT:CLE` and every setter produce no response. The 0.6.x API accepts a
  callback on all of these, and that callback can never fire — worse, the pending
  `once('data')` listener steals the _next_ query's response. This is the root of the
  desync. The new API must model set-vs-query as distinct operations.

- **`:OUT?` is undocumented and revision-dependent.** The 2013 manual documents the
  Output subsystem short form as `OUT`; the 2018 manual changed it to `OUTP`. `OUT`
  separately exists as a _legacy, set-only, non-SCPI_ command (`OUT 1`) with no query
  form. Use the **long form** (`OUTPUT?`, `OUTPUT:LIMIT:VOLTAGE?`, …) which is
  documented identically in all three revisions.

- **`OUTPut?` and `OUTPut:STATe?` are different things.** `OUTPut?` returns output
  on/off. `OUTPut:STATe?` returns the _regulation mode_, CV or CC. The 0.6.x
  `getOutputState()` is misleadingly named for what it actually queries.

- **Slew rate is V/ms and A/ms**, not per second. Front panel confirms:
  `VOLT SLEW RATE = 3.0000 V/mS`. Per-model ranges are tabulated in
  `src/models.ts`.

- **Terminator is `\r\n`.** "All commands are terminated with `<CR>` and `<LF>`
  characters" — stated in every manual revision. 0.6.x sends `\n` only. It evidently
  worked (these parsers are usually tolerant) but `\r\n` is the documented contract.

- **No leading colon in any documented example.** Every example is `MEAS:VOLT?`,
  `SOUR:VOLT 30`, `SYS:ERR?` — never `:MEAS:VOLT?`. A leading colon is legal SCPI but
  this is a hand-rolled parser and B&K never documents it. Send without.

- **`SYS:BEEP`, not `SYSTEM:BEEPER`.** The node is `BEEP`.

- **`*OPC?`, `*ESR?`, `*STB?`, `*WAI`, `*TST?` and the entire `STATus:` subsystem do
  not exist here.** Only five common commands are documented: `*CLS`, `*IDN?`,
  `*RCL`, `*RST`, `*SAV`. So there is **no** standard way to synchronize after a
  write. Error detection has to go through `SYS:ERR?`.

- **One command per TCP write.** Commit `93f9bdc` (2015-11-07, "Make sure each
  `.write()` is sent on its own") added `setNoDelay()` — strong empirical hint the
  firmware parser mishandles coalesced segments. No manual example anywhere uses `;`
  compound commands. Keep `setNoDelay()`, never batch.

- **Assume a single TCP connection.** Undocumented, but a comparable design (TTi)
  documents exactly 2 sockets. Serialize all access inside the library.

- **Average command response time ≤ 50 ms** (datasheet). Read timeouts should be well
  above this; do not poll faster.

- **Ethernet only exists on `-GL` suffix models**, and the interface must be selected
  manually on the front panel (System Setting → Remote Control → Ethernet, IP =
  Static). DHCP is not offered. Worth a README note — it will be the first thing a
  user gets wrong.

- **`SYS:REM` selects the active physical interface** (USB/GPIB/ETHERNET), _not_
  IEEE-488 remote/local lockout. Sending `SYS:REM USB` over LAN cuts your own
  connection. **Do not expose this without a loud warning.**

### Things the old library missed that are worth adding

- `PROTection` subsystem: `PROT?`, `PROT:OVP`, `PROT:OCP`, **`PROT:OPP`
  (over-power — entirely absent from 0.6.x)**, `PROT:CVCC`, `PROT:CCCV`, each with
  `:LEVel`
- `OUTPUT:STATE?` for CV/CC regulation-mode detection
- Legacy `STATUS?` three-byte bitfield — the only way to read latched fault flags
  including over-temperature and AC-low, which have no SCPI query
- `SYSTem:KEY:LOCK` — front panel lock
- `SYSTem:POWer:TYPE` / `:VOLTage` / `:CURRent` / `:STATe` — power-on state
- `SYSTem:SERies?`, `SYSTem:LCD:BL`, `SYSTem:E5V` (aux 5 V, high-current models)
- `MEMory` subsystem (distinct from `*SAV`/`*RCL`)

Deferred to a later release (documented but response encodings unverified, and large
enough to be their own feature): `PROGram` list/sequence programming, `TIMER`,
`PS:MODE`/`PS:TYPE` parallel-series.

## Architecture

```
src/
  index.ts       public exports
  transport.ts   ScpiSocket — connection, framing, serialized queue, timeouts
  xln.ts         XLN class — typed SCPI command methods
  models.ts      per-model limit table + *IDN? parsing
  parse.ts       response value parsing (number, boolean, error code, STATUS?)
  errors.ts      XLNError hierarchy
test/
  mock-device.ts fake XLN speaking SCPI over TCP
  *.test.ts
scripts/
  probe.ts       resolves the UNVERIFIED protocol questions against real hardware
  smoke.ts       end-to-end check against real hardware
```

**Transport design.** A promise chain serializes every command so two callers can
never interleave. Received bytes accumulate in a buffer; NULs are stripped, the
buffer is split on `\n`, and each line is `\r`-trimmed. `write()` sends and resolves
without expecting a reply. `query()` sends and resolves on the next complete line.
A line arriving while no query is pending is a protocol anomaly — emit it as an
`unsolicited` event and discard, rather than letting it desync the stream.

**Error checking.** Because writes are silent and there is no `*OPC?`, a failed
`setCurrent()` is invisible by default. This is a 1440 W power supply, so the default
is **`autoCheckErrors: true`** — each write is followed by `SYS:ERR?` and a non-zero
code throws. Costs a round trip; users who need throughput set it false.

## Progress log

- [x] Read the 2015 source, git history, npm registry state
- [x] Commission and receive protocol research report
- [x] Decisions confirmed with Cameron (async rewrite / hardware available / full
      tooling / alpha to `next` tag)
- [x] Write this plan
- [x] Scaffold toolchain — package.json, tsconfig, tsdown, eslint, prettier; deleted
      gulpfile.js and .npmignore
- [x] Implement `transport.ts` — queue, framing, timeouts, transactions,
      AbortSignal, opt-in auto-reconnect
- [x] Implement `models.ts`, `parse.ts`, `errors.ts`, `xln.ts`
- [x] Mock device + vitest suite — 93 tests, including ones that drive the built
      `dist/` through both ESM and CommonJS
- [x] `scripts/probe.ts` + `scripts/smoke.ts`, both exercised against the mock
- [x] README rewrite + migration table, CHANGELOG
- [x] GitHub Actions: test matrix + release with provenance
- [x] Read and answer `consumer-requests-xln-control.md` (see
      `plans/reply-to-xln-control.md`)
- [x] Packaging validated — publint + attw green across node10, node16 CJS,
      node16 ESM and bundler resolution; `npm publish --dry-run --tag next` clean
- [ ] **Run probe against real hardware** and fold answers into tests
- [x] **Released `1.0.0-alpha.1` to `next`** (2026-08-03). Published by GitHub
      Actions via npm trusted publishing — no token involved. Verified on the
      registry: `dist-tags` are `latest: 0.6.4`, `next: 1.0.0-alpha.1`, so a
      bare `npm install xln` still gets 0.6.4. SLSA provenance attestation
      present. Installed `xln@next` into a scratch project and drove it end to
      end, including the `xln/testing` subpath export.

## Round 2: consumer feedback and follow-up decisions

The XLN-Control agent reviewed `1.0.0-alpha.1` (see
`plans/consumer-requests-xln-control-round-2.md`) and found a real bug.

- **`measurePower()` was incoherent.** Two separate `await`s meant
  `V(t) x I(t + one round trip)`, and since serialization is per-request another
  caller's query could land between them and widen the gap arbitrarily. Fixed by
  adding `measure()`, which takes V, I and an optional CV/CC mode inside one
  `transaction()`. `measurePower()` now delegates to it.
- **Coalesced replies to _different_ requests cannot happen against this
  client.** Trying to test it via the mock deadlocks: strict one-in-flight means
  request 2 is not sent until reply 1 arrives, so a well-behaved device has
  nothing to batch. The framing is still tested for it, using a raw server that
  volunteers both replies in one segment. This retroactively validates choosing
  strict serialization over a pipelined FIFO.
- **`xln/testing`** now exports the mock so the consumer can delete their own
  simulator. Needs a `testing/package.json` redirect stub shipped in `files` —
  legacy node10 resolution cannot see subpath exports, and attw flags it
  otherwise.
- **Hardware availability was contradictory.** The consumer agent was told no
  supply was reachable; Cameron confirmed to me directly (twice) that one **can
  be plugged in**. The probe remains a real near-term step.
- **Switched to Bun** (`bun.lock`) to match `react-smoothie`, `CloudWarden`,
  `battery-controller`, `Gate Manager` and XLN-Control. CI installs with Bun but
  runs the suite on Node across the 20.19/22/24 matrix, and the release job
  still publishes with npm because provenance is an npm feature.

## HARDWARE PROBE RESULTS (2026-07-31, XLN6024 at 10.255.14.231)

Real unit: `BK PRECISION,XLN6024,276G11128,1.20,0` — firmware 1.20.

**Every one of the previously-UNVERIFIED questions is now answered.**

| Question                | Answer                                                                                              | Impact                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Response terminator     | **bare `LF`**, never CRLF                                                                           | We send CRLF (per manual) and parse tolerantly — fine         |
| NUL padding             | **Real.** One `�` _after_ the LF, on some replies but not all (`*IDN?` none, `SOURCE:VOLTAGE?` one) | Not fixed-width padding. Framing already strips it            |
| `SYSTEM:ERROR?` format  | **bare `0`** — not `0,"No error"`                                                                   | `parseDeviceError` already accepts it                         |
| Boolean encoding        | **`OFF`/`ON`** — not `0`/`1`                                                                        | `parseBoolean` already accepts it. **Mock default was wrong** |
| `OUTPUT:STATE?`         | Returns **`OFF`** when output is off — _not_ CV/CC                                                  | See below. Would have thrown before the open-union change     |
| `STATUS?`               | **6-char contiguous hex** (`000000`)                                                                | `parseStatus` already handles hex                             |
| Leading colon           | **Accepted** (`:SOURCE:VOLTAGE?` works)                                                             | We don't send one; harmless either way                        |
| `SOUR:VOLT?` short form | **Accepted**                                                                                        | —                                                             |
| `OUTP?` short form      | **REJECTED (silence)**                                                                              | Confirms the long form `OUTPUT?` was the right call           |
| `;` compound commands   | **REJECTED (silence)**                                                                              | Confirms never batching                                       |
| `*OPC?`                 | **Does not exist (silence)**                                                                        | Confirms `SYSTEM:ERROR?` is the only write sync               |
| `SOURCE:VOLTAGE? MAX`   | **Not supported (silence)**                                                                         | Confirms the per-model limit table is necessary               |
| Second TCP session      | **Reset, then the device WEDGED**                                                                   | See the warning below                                         |
| Slew rate               | `OUTPUT:SR:VOLTAGE?` = `3.0000` = the XLN6024 max in **V/ms**                                       | Confirms V/ms, not V/s                                        |

### The open union on `RegulationMode` was load-bearing

`OUTPUT:STATE?` returns **`OFF`** while the output is disabled — not `CV`, not `CC`.
My original implementation threw `XLNProtocolError` on anything but CV/CC. The
XLN-Control agent argued it should degrade instead; I changed it on their
reasoning alone. **That change is the only reason `getRegulationMode()` does not
throw against real hardware in its most common state** (output off). Add `'OFF'`
to the documented union members.

### UDP 9221 IS REAL — my earlier conclusion was WRONG and is retracted

**Retracted:** "There is no UDP protocol on these supplies." I told Cameron that,
and I told the XLN-Control agent that, and both need correcting. The claim was
built on three manual revisions containing zero mentions of UDP — which is true,
but absence from the documentation is not absence from the firmware.

Hardware, 2026-08-03, XLN6024 firmware 1.20 at 10.255.14.231:

**UDP port 9221 answers.** It did not answer a plain `*IDN?

`, which is why
the first probe run reported silence and why I felt confirmed. It answers a
**fixed-size datagram** — exactly what the 2015 `udpXLN` sent.

#### What it is

A **status poll**, not a command channel:

- **The payload content is entirely ignored.** `*IDN?`, `MEAS:VOLT?`, `STATUS?`,
  an empty buffer and pure garbage all return the identical frame. You cannot
  ask it anything; you poke it and it reports.
- **Length matters, and the rule is now exact.** Full sweep 2026-08-02 of
  0,1,2,4,6,8,10,11,12,16,20,24,32,40,48,56,64,72,80,88,92,94,95,96,97,100,112,128:

  > **The device replies iff the payload length is even and ≤ 96.**

  Accepted: 0,2,4,6,8,10,12,16,20,24,32,40,48,56,64,72,80,88,92,94,96. Silent:
  1, 11, 95, 97 (odd) and 100, 112, 128 (even but > 96). Every reply is 96 bytes.
  **A zero-length datagram works** and is the cheapest possible poke.

  The earlier note ("6/16/32/48/64/96 get a reply") was consistent with this but
  over-generalised into "fixed sizes" — the sizes originally tried simply happened
  to be even. Even-or-odd, not multiples of anything.

  This looks like an embedded receiver copying the datagram into a 96-byte buffer
  in **16-bit words**: it rejects odd lengths because it cannot copy a half-word,
  and rejects > 96 because that overruns the buffer. Note this is an alignment
  check, not a grammar check — a command parser would not care whether the
  request had an even number of bytes. Further evidence the payload is never
  parsed.

- **Unicast only.** Broadcast to `255.255.255.255` and to every directed
  broadcast address — including the device's own `10.255.15.255` — is silent.
  **So this is not a discovery mechanism.** That part of my advice stands.
- **It does not disturb TCP.** Verified healthy on port 5025 before and after.

#### Reply frame: 96 bytes, fixed-width, space-padded

```
0         10        20        30        40        50        60 ...
................OFF................0.000.V...0.000.A............
                ^^^                ^^^^^ ^   ^^^^^ ^
                offset 16          35    41  45    51
```

| Offset | Field            | Sample  |
| ------ | ---------------- | ------- |
| 16     | output state     | `OFF`   |
| 35     | measured voltage | `0.000` |
| 41     | unit             | `V`     |
| 45     | measured current | `0.000` |
| 51     | unit             | `A`     |

Sampled with the output off; the numeric fields are measured values, not
setpoints (the setpoint was 24 V at the time and the frame read 0.000 V).

**UNVERIFIED:** what the frame looks like with the output ON, whether the `OFF`
field becomes `CV`/`CC`, and whether field offsets shift as values widen. That
needs the output enabled, which is a hardware state change I have not made
without asking.

#### SOLVED: the protocol is a Java applet served by the device's own web server

**2026-08-02. This is no longer inference — the client is on the device and has
been decompiled.**

The XLN is an OEM rebadge. `http://10.255.14.231/` returns
`<TITLE>Motech DC Power Supply</TITLE>`, the header reads **`D S 6 0 2 4`
Programmable DC Power Supply**, and the footer is
`Copyright © 2008 MOTECH INDUSTRIES INC.` B&K Precision Taiwan Inc. **is** the
former Motech Industries Instrument Division, so XLN6024 = **Motech DS-6024**
(DS-3640/6024/8018/10018 ↔ XLN3640/6024/8018/10014).

The **Web Control** page (`/control.htm?passwd=GUEST`) contains:

```html
<applet code="Display.class" height="110" width="490"></applet>
```

`Display.class` is fetchable unauthenticated from `http://<device>/Display.class`
(3742 bytes, Java 1.6 / class version 50.0). It is the **only** class on the
server — every other name returns the 650-byte login page. Decompiled with
`javap -c -p`, it is a near-verbatim copy of Sun's `QuoteClient` datagram tutorial
(the leftover debug string `"Quote of the Moment: "` is still in the constant
pool).

What it does, exactly:

- `init()` — `InetAddress.getByName(getCodeBase().getHost())`. It only ever talks
  to **the host it was served from**. That is why the service is unicast-only and
  why there is no broadcast/discovery behaviour: the client never needed it.
- `run()` — `while (!stopFlag) { repaint(); Thread.sleep(500); doIt(9221); }`.
  **`sipush 9221`** is the literal in the bytecode. Polls at 2 Hz.
- `doIt(int port)` — allocates `new byte[96]`, writes bytes 0..10 as
  `77,69,65,83,58,67,85,82,82,63,13` = **`"MEAS:CURR?\r"`**, leaves bytes 11..95
  as the JVM's zero fill, and sends `new DatagramPacket(buf, 96, address, port)`.
  Then `socket.receive()` **into the same packet**, and
  `new String(packet.getData())`.
- `paint()` — `Monospaced` PLAIN 40 on black, and exactly two `drawString` calls:
  - `str.substring(0, 19)` at (10, 45)
  - `str.substring(33, 52)` at (10, 90)

**Provenance is exact.** Sun's `QuoteClientApplet.java` (1995–96) declares
`boolean DEBUG; InetAddress address; TextField portField; Label display;
DatagramSocket socket;` — the identical field set, in the identical order, that
`Display.class` still carries, including the now-unused `portField` and `display`.
Every debug string matches verbatim ("Couldn't get Internet address: Unknown
host", "Couldn't create new DatagramSocket", "Applet about to send packet to
address ", " at port ", "Applet sent packet.", "Applet socket.send failed:",
"Applet about to call socket.receive().", "Applet returned from
socket.receive().", "Applet socket.receive failed:", "Quote of the Moment: "), and
so does the `void doIt(int port)` signature.

Motech's only functional edits to the tutorial were:

1. `byte[] sendBuf = new byte[256]` → **`new byte[96]`** — this, and nothing more
   principled, is where 96 comes from.
2. Prefilled the buffer with `MEAS:CURR?\r`; Sun sent an all-zero buffer.
3. Hardcoded the port to 9221 instead of reading `portField`.
4. Added the 500 ms polling `Thread` (Sun's fired on a "Send" button).
5. Replaced `display.setText(received)` with the two-substring `paint()`.

That matters for the read/write question, because the **server** side of the same
tutorial (`QuoteServerThread`) does not parse the request at all — it discards the
received datagram's contents and replies. The observed "content is ignored"
behaviour is exactly what that archetype produces. (The length-sensitivity is
Motech's own: Java would silently truncate an oversized datagram rather than drop
it, so the 95-silent/96-OK check is hand-written code on the instrument side.)

This closes every open question at once:

- **Why 96 bytes, NUL-padded** — the applet's `new byte[96]`.
- **Why the payload is ignored** — the applet sends one hardcoded string forever;
  the firmware never had a reason to parse it.
- **Why `MEAS:CURR?`** — it is the applet's hardcoded payload, byte for byte. The
  2015 `udpXLN` sending `MEAS:CURR?` in a 96-byte buffer was not a guess or a
  coincidence; it was copied from this applet.
- **Why it is display-oriented fixed-width** — it is literally rendered into a
  490×110 monospaced applet.

#### The frame layout is defined by the applet, not guessed

The applet consumes only **38 of the 96 bytes**, as two 19-character lines:

| Applet line | Slice              | Bytes  | Sample (output off)   |
| ----------- | ------------------ | ------ | --------------------- |
| 1 (y=45)    | `substring(0,19)`  | 0..18  | `                OFF` |
| 2 (y=90)    | `substring(33,52)` | 33..51 | `  0.000 V   0.000 A` |

Both match the measured frame exactly: `OFF` right-aligned ending at byte 18, and
bytes 33..51 = 2 spaces + `0.000` + space + `V` + 3 spaces + `0.000` + space + `A`
with `A` at byte 51. Bytes 19..32 and 52..95 are **not read by the vendor's own
client** and were blank in every sample — treat them as reserved/padding, not as
fields waiting to be decoded.

Line 1 is a 19-char right-aligned state field, so `CV`/`CC` (if the firmware emits
them) would land at bytes 17..18, not 16. **Still UNVERIFIED** — needs the output
on.

#### Can UDP SET anything? Best available answer: no, but not proven

Evidence it is **read-only**:

1. The vendor's own and only UDP client is called **`Display`**, has no input
   path, and never sends anything but `MEAS:CURR?`.
2. On the same Web Control page, **setpoints do not go over UDP**: `Vset`, `Iset`
   and the `CHAN1` ON/OFF radios are plain HTML `<form>` fields submitted over
   **HTTP**. Motech's design uses HTTP for control and UDP purely for the live
   readout.
3. The Motech DS3640 manual says Java is required "for **monitoring** real-time
   output values" — monitoring, explicitly.
4. Random garbage payloads return an identical valid frame with no error. If a
   parser existed, garbage should diverge from valid input somewhere.

Why it is **not proven**: point 4 rules out a parser that rejects; it does not
rule out a parser that recognises a few prefixes and silently ignores the rest.
Only query-shaped and garbage payloads have been sent.

**Cheap, zero-risk test that would settle it** (not yet run): send a garbage
datagram to UDP 9221, then read `SYST:ERR?` over TCP 5025. If UDP payloads ever
reach the SCPI parser, malformed input should enqueue -113 "Undefined header" or
similar. An empty error queue after UDP garbage is strong evidence the payload is
discarded before any parser sees it. This changes no hardware state.

#### The 2015 code was right and I was unfair to it

I described `udpXLN` as "an early guess that was abandoned" and criticised
`readStatus()` for "sending `MEAS:CURR?` — it reads current, not status". Both
wrong:

- The 96-byte NUL-padded buffer is **exactly** the format that works. That is not
  a guess; that is someone who had observed the real protocol.
- `readStatus()` is **correctly named**. The payload is ignored and the reply _is_
  a status frame, so sending `MEAS:CURR?` was just a poke.
- `parseUDPMessage` returning the string unchanged is defensible — the reply is a
  display-oriented fixed-width string.

What it lacked was field parsing and a `close()`. The protocol understanding was
sound.

#### What this means for the library

- **UDP cannot replace TCP.** It cannot set a voltage, enable an output,
  configure protection or read the error queue. It is monitor-only.
- **It is genuinely attractive for polling.** One datagram returns output state,
  voltage and current **atomically** — which is exactly the coherent-measurement
  primitive `measure()` needs three TCP round trips to approximate.
- **There is no correlation problem on UDP here**, because content is ignored and
  every reply is a complete snapshot. Any reply is a valid current reading, so an
  out-of-order or duplicated datagram is harmless. This is the one respect in
  which Cameron's instinct about UDP was right, and my "UDP makes correlation
  worse" argument does not apply to a stateless status poll.
- Worth adding as an opt-in monitoring path alongside TCP control. Tracked as
  follow-up work, not for 1.0.0-alpha.1.

### DANGER: probing this firmware with unsupported commands wedges it

**Corrected 2026-08-02. My first diagnosis was wrong and is retracted.**

Originally I blamed a second simultaneous TCP connection, because that is what
the first probe run did immediately before the unit died. On the second run the
second-connection test was **skipped entirely** and the unit wedged anyway. So a
second connection is not the cause, or at least not the only one.

What both runs have in common is the probe's **unsupported-command block**:

    OUTP?                          -> silence
    OUT?                           -> silence
    SOURCE:VOLTAGE?;SOURCE:CURRENT?-> silence   (compound, ';' unsupported)
    *OPC?                          -> silence
    SOURCE:VOLTAGE? MAX            -> silence   (MIN/MAX param unsupported)

Every one of those returns silence rather than a device error, which already
suggests the hand-rolled parser does not handle them gracefully. The working
hypothesis is that one of them corrupts parser or network state, and the unit
dies shortly after.

**I have not narrowed down which command**, and deliberately stopped trying:
isolating it costs one power cycle per candidate, and the answer would not change
what the library does. Recorded as an open question instead.

Observed failure signature, both times:

1. All commands answer normally; the probe completes and prints results.
2. `socket.end()` produces `ECONNRESET` — this device resets rather than closing
   gracefully. (`ScpiSocket.close()` already swallows this; the probe script did
   not, and crashed.)
3. Shortly after, **all TCP services die** — ports 80, 5024 and 5025 stop
   accepting. First occurrence: still answered ICMP. Second occurrence: fell off
   the network entirely, no ARP response.
4. Does not self-recover. Needs a power cycle.

**Implications for the library:**

- The library itself is not affected: it only ever sends the documented long-form
  commands, all of which are confirmed working on firmware 1.20.
- **The raw escape hatches (`command()` / `query()`) are genuinely dangerous on
  this hardware.** Sending an unsupported command does not merely return an error
  — it can take the instrument off the network until someone power-cycles it.
  This needs a prominent warning in the README and on those methods.
- Do not assume `autoCheckErrors` will catch a bad command. An unsupported form
  produces silence, so the follow-up `SYSTEM:ERROR?` times out rather than
  reporting `-1`.
- Still treat the device as single-session. That remains the manual's implication
  and the safe assumption, it just is not what caused these two failures.

### Corroboration from two further research sweeps

Two background agents finished after the `Display.class` decompile had already
settled things. Both converged independently — and both independently proposed
decompiling the applet as the decisive test, which is what the first agent did.

Genuinely new:

- **The manual pictures the applet running.** B&K's Web Control screenshot shows
  the display panel reading `CV` on the upper line and `35.996 V   0.000 A`
  below — the same three fields, same order, with the state showing a
  regulation mode instead of `OFF`. That is documentary evidence for what the
  state field does with the output on, short of confirming it on this unit.
- **B&K's own PC software contains no UDP at all.** `Program Software.exe`
  decompiles to a single Ethernet transport, `BKTWLab.BKEthernet`, doing
  `myTcpClient.Connect(myIP, 5025)`. The strings `Udp`, `Dgram` and `9221`
  appear zero times, in both the 2014 and 2023 builds. So the vendor's own
  full-control client never touches UDP 9221 — control does not need it.
- **Not a third-party module.** Every serial-to-Ethernet device server family
  was checked (Lantronix 30718, Moxa 4800, Hi-Flying 48899, USR 1901, WIZnet
  1460, Tibbo 65534, ZLAN 1092, Digi 2362, NetBurner 20034, Silex 60000, Sena
  2002): none uses 9221, and all of them are broadcast-driven and key on a
  magic byte string. Ours ignores payload content and ignores broadcast, which
  is the opposite of a discovery responder. 9221 is unassigned at IANA and
  absent from nmap-services and Rapid7 Recog.
- **The Aim-TTi 9221 similarity is a coincidence.** Seven Aim-TTi manuals
  confirm their 9221 is TCP-only; their sole UDP port is 111 for the RPC
  portmapper. No corporate or OEM link to B&K exists. Do not repeat the
  "Aim-TTi lineage" framing — the real explanation is Motech's applet.

**The one residual uncertainty about writes.** B&K shipped an iOS app, `pwrApp`
(Feb 2012), advertised as full monitoring **and control** of network XLN-GL
supplies, with a "Legacy Firmware" toggle proving the LAN firmware protocol
changed around that date. It is delisted and could not be examined, and it is a
control client — so it cannot be ruled out on evidence that it writes over 9221. Counterweight: our frame carries three fields, nowhere near enough for
pwrApp's feature set (setpoints, OVP/OCP, programs, graphing), so the natural
split is UDP for the live monitor and TCP for everything else — exactly what
the applet does.

Practical effect: none. Read-only is supported on four independent legs (the
manual scopes Java to "display"; the applet has no input path; the vendor's
control software needs no UDP; and junk payloads never reach the SCPI parser).
The library only ever reads from this channel anyway.

### Output-on probe (2026-08-03) — closed the last protocol question, found a bug

Cameron confirmed nothing was connected, so the output could be enabled safely.
`scripts/probe-output-on.ts` saves setpoints, drives 5 V and 24 V into no load,
and restores everything in a `finally`.

Confirmed:

- **`OUTPUT:STATE?` returns `CV`** with the output on, and the UDP frame's state
  field agrees. Previously only inferred from a manual screenshot.
- **UDP frame values are right-aligned.** `4.998` starts at column 35, `23.995`
  at 34, both ending at 39 with `V` at 41 — so a value never collides with its
  unit on this firmware. The parser anchors on unit markers, so it was already
  correct; the defensive "merged" test case is retained but no longer claims to
  represent real hardware. The state field is right-aligned too: `OFF` at 16-18,
  `CV` at 17-18.
- **`CC` is still unobserved** — it needs a current-limited load.

**Bug found: `getStatus()` decoded the wrong byte.** The manual numbers the
enable-flags byte as "byte 0", but it is transmitted **last**. Verified by
toggling known bits:

| Change    | `STATUS?` | Bit | Manual byte 0 |
| --------- | --------- | --- | ------------- |
| Output on | `000004`  | 2   | output        |
| OVP on    | `000080`  | 7   | OVP           |
| OCP on    | `000040`  | 6   | OCP           |

Reading the string left to right made every flag `false`. Now decoded as a
24-bit big-endian value with the manual's byte 0 as the low byte, and confirmed
on hardware: `enabled.output` tracks the real output state.

Note the other byte-0 bits stay **unverified** — the backlight bit reads 0 while
the backlight is visibly on, so either that assignment differs or the bit means
something other than the obvious. Only the output/OVP/OCP bits are proven.

### Trusted publishing does not cover `npm deprecate`

Tried to deprecate `1.0.0-alpha.1` from CI, reusing the trusted-publishing
setup. It fails:

```
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/xln
```

A 404 on PUT is npm's way of saying unauthenticated. **The OIDC exchange happens
inside `npm publish` itself** — no other npm command triggers it, so `npm
deprecate` ran with no credentials at all. The workflow was removed rather than
left in the repo permanently failing.

**Cameron's ruling: running `npm deprecate` locally is fine.** The no-CLI-publish
rule is about shipping code, not about touching the registry — a deprecation
publishes no artifact, is reversible, and has no build to make reproducible. I
over-applied the rule; that clarification now lives in the global CLAUDE.md so it
generalizes to `npm dist-tag`, `npm owner` and `npm access` too.

Practical snag when actually doing it: `npm whoami` and `npm profile get` succeed
(reads), but `npm deprecate` is a write and npm kicks off an **interactive browser
auth flow** — with `two-factor auth: auth-only` on the account, the stored token
does not carry write authority. Not something an agent can complete. Cameron runs
the command, or uses the web UI.

## Findings / gotchas discovered during implementation

- **TypeScript 7.0.2 is `latest` but unusable here.** `typescript-eslint` 8.65 caps
  its peer range at `<6.1.0`, so type-aware linting breaks on TS 7. Pinned to
  TypeScript 5.9.3. Revisit when typescript-eslint ships TS 7 support — the emitted
  output is identical either way.
- **`*CLS` ordering was a real race.** Sending it _after_ `*IDN?` in `connect()`
  meant the write could still be in flight when the caller issued their first
  command, and would then wipe the error that command produced. Writes resolve when
  bytes reach the OS, not when the device has acted. Fixed by ordering `*CLS` before
  the `*IDN?` query, so the query's round trip proves it landed. Regression test in
  `test/xln.test.ts`.
- **`await using` is only native from Node 24.** Not Node 20 or 22. The tests use it
  and CI runs down to 20.19, so `vitest.config.ts` sets `oxc: { target: 'node20' }`
  to downlevel. Note vitest 4 uses **oxc, not esbuild** — setting `esbuild.target`
  is silently ignored with a warning. The shipped `dist/` is unaffected (the only
  `await using` occurrences in it are inside JSDoc comments; verified).
- **Node's `--experimental-strip-types` does not remap `.js` → `.ts` in imports**, so
  it cannot run `scripts/*.ts` against `src/`. Using `tsx` instead.
- **tsdown emits `.mjs`/`.cjs`**, not `.js`. The exports map has to match; `publint`
  and `attw` now run on every build and catch this.
- Do not assert TCP segment boundaries in tests. Two `socket.write()` calls in the
  same tick can land in one segment regardless of `setNoDelay`; that is the OS's
  business. Assert the byte stream instead.

## Verification performed

- 93 tests green: framing (fragmented, NUL-padded, CR/LF/CRLF), queue serialization
  under concurrency, timeouts and late-reply resync, abort, reconnect with backoff,
  range validation, error checking, and both module formats of the built bundle.
- `bun run probe` and `bun run smoke` (including `--allow-output`) both exercised
  end to end against the mock device.
- `bun link` verified from a scratch project outside the repo, driving a real socket
  under both `node` and `bun`.
- `publint` and `attw` clean; `npm pack` ships exactly `dist/`, README, LICENSE,
  package.json.
- **Not verified locally: the Node 20.19 and 22 CI legs.** Only Node 24 is installed
  on this machine. CI is the proof; if the `await using` downlevel is wrong, those
  legs fail with a syntax error in the test files.

## Open questions for the user

These are the items the manuals do not answer. All are ~20 minutes on the bench with
`scripts/probe.ts`, and the answers should become test fixtures.

1. **What terminator does the device send on responses?** Manual never says. We parse
   tolerantly (`\n` split, `\r` trim) so this is low-risk either way.
2. **Are responses really NUL-padded?** Commit `041cd13` ("Trim extra unwanted
   characters from the responses") is first-hand evidence from a real device, but the
   cause is undocumented. Is it fixed-width padding?
3. **Exact `SYS:ERR?` wire format.** Standard SCPI is `0,"No error"`, but the web GUI
   docs describe the status field as just `0`, and the error table lists codes as
   `-000`, `-001`, … We parse all three shapes defensively. **This one gates the
   `autoCheckErrors: true` default** — worth confirming early.
4. **`OUTP:STAT?` encoding** — literal `CV`/`CC` strings, or an integer?
5. **Boolean query encoding** — `0`/`1` or `OFF`/`ON`?
6. **`STATUS?` encoding** — the manual says "three bytes"; hex string, decimal, or
   raw binary?
7. **ANSWERED by the probe.** Leading colon: accepted. `;` compound: rejected.
   Short forms: `SOUR:VOLT?` accepted but `OUTP?` rejected. Multiple sessions:
   still assumed unsafe (untested since the destructive test is now gated).

8. **Which unsupported command actually wedges the unit?** Not narrowed down —
   isolating it costs a power cycle per candidate and would not change the
   library's behaviour. Candidates are `OUTP?`, `OUT?`, the `;` compound form,
   `*OPC?`, and `SOURCE:VOLTAGE? MAX`.

**Which XLN model do you have?** It determines the limit table entry the smoke test
range-checks against. `*IDN?` will tell us during the probe run.

Also note the model must be a **`-GL`** variant to have Ethernet at all, and the
front panel must be set to System Setting → Remote Control → Ethernet with a static
IP before anything can connect.

## Things not to do

- ~~**Do not resurrect the UDP class.**~~ **RETRACTED — this instruction was
  wrong.** UDP 9221 is real and is the vendor's own monitoring transport. Do not
  re-derive it from scratch either: the authoritative client is
  `http://<device>/Display.class`, already decompiled, and the frame layout is
  recorded above. What _is_ still true: **do not treat UDP as a control channel**
  and do not expect it to do discovery.
- **Do not use `:OUT` short forms.** 2013-manual-only. Long form everywhere.
- **Do not expose `SYSTem:REMote` casually.** It switches the active physical
  interface and will disconnect a LAN caller.
- **Do not batch commands** with `;` or coalesce writes. `setNoDelay()` stays.
- **Do not assume `*OPC?` exists** for write synchronization. It does not.
- **Do not publish the alpha to `latest`.** `next` tag only.
- Do not treat slew rate as V/s.
