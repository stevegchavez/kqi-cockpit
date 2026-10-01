/**
 * protocol.test.js — run with: node test/protocol.test.js
 *
 * Exercises the exact same protocol.js that ships to the browser dashboard.
 * No test framework dependency — plain assert, zero installs required.
 */
const assert = require('assert');
const Protocol = require('../js/protocol.js');
const C = require('../js/constants.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

function buildTelemetryFrame({ speedTenths, soc, odometer, faults, statusByte }) {
  const payload = [
    speedTenths & 0xff, (speedTenths >> 8) & 0xff,
    soc & 0xff,
    odometer & 0xff, (odometer >> 8) & 0xff, (odometer >> 16) & 0xff, (odometer >> 24) & 0xff,
    faults & 0xff, (faults >> 8) & 0xff,
    statusByte & 0xff,
  ];
  const body = [C.TELEMETRY_FRAME_TYPE, ...payload];
  const withLen = [body.length + 1, ...body];
  const checksum = Protocol.xorChecksum(withLen, 0, withLen.length);
  return new Uint8Array([C.SYNC0, C.SYNC1, ...withLen, checksum]);
}

console.log('protocol.js\n');

test('parses a well-formed telemetry frame with all fields', () => {
  const frame = buildTelemetryFrame({
    speedTenths: 155,       // 15.5 km/h
    soc: 72,
    odometer: 123456,
    faults: 0,
    statusByte: 0b01,       // headlight on, lock off
  });
  const parsed = Protocol.parseTelemetry(frame);
  assert.ok(parsed, 'expected a non-null parse result');
  assert.strictEqual(parsed.speedKPH, 15.5);
  assert.strictEqual(parsed.batterySOC, 72);
  assert.strictEqual(parsed.odometerMeters, 123456);
  assert.strictEqual(parsed.faultFlags, 0);
  assert.strictEqual(parsed.headlightOn, true);
  assert.strictEqual(parsed.motorLocked, false);
});

test('clamps battery SOC to 100 even if the byte is out of range', () => {
  const frame = buildTelemetryFrame({
    speedTenths: 0, soc: 250, odometer: 0, faults: 0, statusByte: 0,
  });
  const parsed = Protocol.parseTelemetry(frame);
  assert.strictEqual(parsed.batterySOC, 100);
});

test('rejects a frame with a corrupted checksum', () => {
  const frame = buildTelemetryFrame({
    speedTenths: 100, soc: 50, odometer: 1000, faults: 0, statusByte: 0,
  });
  frame[frame.length - 1] ^= 0xff; // flip every bit of the checksum byte
  const parsed = Protocol.parseTelemetry(frame);
  assert.strictEqual(parsed, null);
});

test('rejects a frame with the wrong sync bytes', () => {
  const frame = buildTelemetryFrame({
    speedTenths: 100, soc: 50, odometer: 1000, faults: 0, statusByte: 0,
  });
  frame[0] = 0x00;
  assert.strictEqual(Protocol.parseTelemetry(frame), null);
});

test('rejects a truncated frame instead of throwing', () => {
  const frame = buildTelemetryFrame({
    speedTenths: 100, soc: 50, odometer: 1000, faults: 0, statusByte: 0,
  });
  const truncated = frame.slice(0, 6);
  assert.doesNotThrow(() => Protocol.parseTelemetry(truncated));
  assert.strictEqual(Protocol.parseTelemetry(truncated), null);
});

test('does not misparse a control-channel command frame as telemetry', () => {
  // frameType byte for a command frame is the command id (e.g. 0x01), which
  // must never collide with TELEMETRY_FRAME_TYPE (0x21) or the parser could
  // misread an outbound command echo as a live telemetry update.
  const cmdFrame = Protocol.headlightCommand(true);
  assert.strictEqual(Protocol.parseTelemetry(cmdFrame), null);
});

test('encodeCommand produces the exact expected byte sequence', () => {
  // sync(2) + length(1) + cmd(1) + payload(1) + checksum(1) = 6 bytes
  const frame = Protocol.encodeCommand(C.CMD_HEADLIGHT, [0x01]);
  assert.strictEqual(frame.length, 6);
  assert.strictEqual(frame[0], 0x5a);
  assert.strictEqual(frame[1], 0xa5);
  assert.strictEqual(frame[2], 0x03); // length = cmd byte + 1 payload byte + 1
  assert.strictEqual(frame[3], C.CMD_HEADLIGHT);
  assert.strictEqual(frame[4], 0x01);
  const expectedChecksum = frame[2] ^ frame[3] ^ frame[4];
  assert.strictEqual(frame[5], expectedChecksum);
});

test('headlightCommand / motorLockCommand toggle the correct payload byte', () => {
  assert.strictEqual(Protocol.headlightCommand(true)[4], 0x01);
  assert.strictEqual(Protocol.headlightCommand(false)[4], 0x00);
  assert.strictEqual(Protocol.motorLockCommand(true)[4], 0x01);
  assert.strictEqual(Protocol.motorLockCommand(false)[4], 0x00);
});

test('requestStateCommand carries no payload bytes', () => {
  const frame = Protocol.requestStateCommand();
  assert.strictEqual(frame.length, 5); // sync(2)+length(1)+cmd(1)+checksum(1)
});

console.log(`\n${passed} passed`);
