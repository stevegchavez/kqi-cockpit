/**
 * ble.js — NIU Companion Web Dashboard
 *
 * Wraps navigator.bluetooth: device request, connect, subscribe to
 * telemetry notifications, write control commands, and reconnect handling.
 *
 * Web Bluetooth has no equivalent of CoreBluetooth's "retrieve known
 * peripheral by UUID" — every fresh connection after a full disconnect
 * requires a new user-gesture-triggered requestDevice() call. This class
 * keeps a reference to the last CBluetoothDevice object in memory so it can
 * attempt a silent reconnect via device.gatt.connect() while the page is
 * still alive, but cannot skip the picker after a page reload.
 */
(function (root) {
  const C = root.NIU.BLE_CONSTANTS;
  const Protocol = root.NIU.Protocol;

  class BLEManager extends EventTarget {
    constructor() {
      super();
      this.device = null;
      this.server = null;
      this.telemetryChar = null;
      this.controlChar = null;
      this.state = 'disconnected'; // disconnected | connecting | connected | unsupported
      this._onDisconnected = this._onDisconnected.bind(this);
    }

    get isSupported() {
      return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    _setState(state) {
      this.state = state;
      this.dispatchEvent(new CustomEvent('statechange', { detail: state }));
    }

    /** Must be called from a direct user gesture (e.g. a button tap). */
    async connect() {
      if (!this.isSupported) {
        this._setState('unsupported');
        throw new Error('Web Bluetooth is not available in this browser. Use Bluefy on iOS or Chrome on desktop/Android.');
      }
      this._setState('connecting');
      try {
        this.device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [C.SERVICE_UUID] }],
        });
        this.device.addEventListener('gattserverdisconnected', this._onDisconnected);

        this.server = await this.device.gatt.connect();
        const service = await this.server.getPrimaryService(C.SERVICE_UUID);

        this.telemetryChar = await service.getCharacteristic(C.TELEMETRY_UUID);
        this.controlChar = await service.getCharacteristic(C.CONTROL_UUID);

        await this.telemetryChar.startNotifications();
        this.telemetryChar.addEventListener('characteristicvaluechanged', (event) => {
          const bytes = new Uint8Array(event.target.value.buffer);
          const parsed = Protocol.parseTelemetry(bytes);
          if (parsed) {
            this.dispatchEvent(new CustomEvent('telemetry', { detail: parsed }));
          }
        });

        this._setState('connected');
        this.dispatchEvent(new CustomEvent('connected', { detail: { name: this.device.name } }));
      } catch (err) {
        this._setState('disconnected');
        throw err;
      }
    }

    /** Attempts to reconnect to the same device without showing the picker again. */
    async reconnect() {
      if (!this.device) return this.connect();
      this._setState('connecting');
      try {
        this.server = await this.device.gatt.connect();
        const service = await this.server.getPrimaryService(C.SERVICE_UUID);
        this.telemetryChar = await service.getCharacteristic(C.TELEMETRY_UUID);
        this.controlChar = await service.getCharacteristic(C.CONTROL_UUID);
        await this.telemetryChar.startNotifications();
        this._setState('connected');
      } catch (err) {
        this._setState('disconnected');
        throw err;
      }
    }

    disconnect() {
      if (this.device && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
    }

    _onDisconnected() {
      this._setState('disconnected');
      this.dispatchEvent(new CustomEvent('disconnected'));
    }

    async _write(bytes) {
      if (!this.controlChar) throw new Error('Not connected to a scooter');
      try {
        await this.controlChar.writeValueWithoutResponse(bytes);
      } catch (err) {
        // Falls back for peripherals/browsers that only support writeValue.
        await this.controlChar.writeValue(bytes);
      }
    }

    setHeadlight(on) {
      return this._write(Protocol.headlightCommand(on));
    }

    setMotorLock(locked) {
      return this._write(Protocol.motorLockCommand(locked));
    }

    requestFreshState() {
      return this._write(Protocol.requestStateCommand());
    }
  }

  root.NIU.BLEManager = BLEManager;
})(typeof globalThis !== 'undefined' ? globalThis : this);
