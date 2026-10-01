/**
 * constants.js — NIU Companion Web Dashboard
 *
 * GATT identifiers and frame headers for the NIU KQi Bluetooth protocol.
 * These were first guessed, then CONFIRMED against a real KQi 200F (service
 * UUID, both characteristics, the "01 23 01" / "01 03 00" handshake frames),
 * and the frame layout/crypto follow the reverse-engineering in
 * https://github.com/BaesTheorem/niu-kqi (MIT) — see NOTICE.md.
 *
 * UMD-style export: works as a plain <script> global in the browser
 * (window.NIU.BLE_CONSTANTS) and as a CommonJS module under Node for the
 * test suite in /test.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NIU = root.NIU || {};
    root.NIU.BLE_CONSTANTS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // One GATT service per vehicle; the last hex digit tells the "BLE version".
  //   ...daea50 -> BLE 10 (confirmed on a KQi 200F; supported here)
  //   ...daea51 -> BLE 20 (newer handshake; NOT supported yet)
  //   ...daea52 -> BLE 21 (different frame format; NOT supported yet)
  const SERVICES = {
    '8ec94e30-f315-4f60-9fb8-838830daea50': 10,
    '8ec94e30-f315-4f60-9fb8-838830daea51': 20,
    '8ec94e30-f315-4f60-9fb8-838830daea52': 21,
  };

  return {
    SERVICES,
    SUPPORTED_BLE_VERSION: 10,
    // Web Bluetooth needs every service we might touch declared up front.
    ALL_SERVICE_UUIDS: Object.keys(SERVICES),
    PRIMARY_SERVICE_UUID: '8ec94e30-f315-4f60-9fb8-838830daea50',

    /** Notify characteristic and write characteristic for a service UUID. */
    characteristicsFor(serviceUuid) {
      const suffix = serviceUuid.slice(-1);
      return {
        notify: `8ec94e31-f315-4f60-9fb8-838830daea5${suffix}`,
        write: `8ec94e32-f315-4f60-9fb8-838830daea5${suffix}`,
      };
    },

    FRAME_LENGTH: 20,         // every data/handshake frame is exactly 20 bytes
    RESPONSE_TIMEOUT_MS: 4000,

    // 2-byte frame headers, [first frame, continuation frame].
    HEADERS: {
      READ: [[0x01, 0x21], [0x01, 0x01]],
      READ_ACK: [[0x01, 0xa1], [0x01, 0x81]],
      READ_ERR: [[0x01, 0xe1], [0x01, 0xc1]],
      HS1: [0x01, 0x23],         // handshake request 1 is 01 23 01 + AES(random)
      HS1_ACK: [0x01, 0xa3],
      HS2: [0x01, 0x03],         // handshake request 2 is 01 03 00 + AES(md5(...))
      HS2_ACK: [0x01, 0x83],
      HS_ERR: [0x01, 0xc3],
    },
  };
});
