/**
 * constants.js — NIU Companion Web Dashboard
 *
 * Mirrors BLEConstants.swift from the native project 1:1. If you calibrate
 * the protocol against a real capture, update both places.
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
  return {
    SERVICE_UUID: '8ec94e30-f315-4f60-9fb8-838830daea50',
    TELEMETRY_UUID: '8ec94e31-f315-4f60-9fb8-838830daea50',
    CONTROL_UUID: '8ec94e32-f315-4f60-9fb8-838830daea50',

    SYNC0: 0x5a,
    SYNC1: 0xa5,
    TELEMETRY_FRAME_TYPE: 0x21,

    CMD_HEADLIGHT: 0x01,
    CMD_LOCK: 0x02,
    CMD_REQUEST_STATE: 0x10,
  };
});
