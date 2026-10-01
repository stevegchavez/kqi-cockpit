/**
 * ble.js — NIU Companion Web Dashboard
 *
 * Web Bluetooth transport: pick the scooter, find the NIU service, subscribe
 * to its notify characteristic, then hand everything to a Session (handshake +
 * polling). READ-ONLY: nothing here sends anything except the password
 * handshake and field reads.
 *
 * Web Bluetooth has no way to silently reconnect to a remembered device after
 * a page reload — requestDevice() always needs a fresh user gesture (a tap).
 * Within one page session, reconnect() reuses the same device without the
 * picker.
 *
 * Events: statechange (detail: state), connected ({name}), telemetry (detail:
 * dashboard telemetry object), error (detail: Error), disconnected.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants.js'), require('./protocol.js'), require('./session.js'));
  } else {
    root.NIU = root.NIU || {};
    root.NIU.BLEManager = factory(root.NIU.BLE_CONSTANTS, root.NIU.Protocol, root.NIU.Session);
  }
})(typeof self !== 'undefined' ? self : this, function (C, P, S) {
  const { Session, TimeoutError } = S;

  /** Turns low-level failures into something a rider can act on. */
  function friendlyError(err) {
    if (err && err.name === 'NotFoundError' && /cancel/i.test(err.message || '')) {
      return new Error('No scooter selected.');
    }
    if (err instanceof P.NiuError && /rejected|verify failed/.test(err.message)) {
      return new Error('The scooter rejected the saved keys. Re-enter them in Setup.');
    }
    if (err instanceof TimeoutError) {
      return new Error('The scooter did not answer. Make sure it is on and not connected to another app.');
    }
    return err;
  }

  class BLEManager extends EventTarget {
    /**
     * @param {{bluetooth?: object, pollIntervalMs?: number, timeoutMs?: number}} [opts]
     *   `bluetooth` defaults to navigator.bluetooth; injectable for tests.
     */
    constructor(opts = {}) {
      super();
      this._bluetooth = opts.bluetooth || (typeof navigator !== 'undefined' ? navigator.bluetooth : undefined);
      this._pollIntervalMs = opts.pollIntervalMs || 1000;
      this._timeoutMs = opts.timeoutMs;
      this.device = null;
      this.session = null;
      this._notifyChar = null;
      this._onValue = null;
      this.state = 'disconnected'; // disconnected | connecting | connected | unsupported
      this._onDisconnected = this._onDisconnected.bind(this);
    }

    get isSupported() {
      return !!this._bluetooth;
    }

    _setState(state) {
      this.state = state;
      this.dispatchEvent(new CustomEvent('statechange', { detail: state }));
    }

    /**
     * Must be called from a direct user gesture (a button tap).
     * @param {{password: string, aes: string}} keys the scooter's blePassword and bleAes
     */
    async connect(keys) {
      if (!this.isSupported) {
        this._setState('unsupported');
        throw new Error('Web Bluetooth is not available in this browser. Use Bluefy on iOS or Chrome on desktop/Android.');
      }
      this._requireKeys(keys);
      this._setState('connecting');
      try {
        const device = await this._bluetooth.requestDevice({
          // Match by name OR by service so the picker works whether or not the
          // scooter puts its service UUID in its advertisement.
          filters: [{ namePrefix: 'NIU' }, { services: [C.PRIMARY_SERVICE_UUID] }],
          optionalServices: C.ALL_SERVICE_UUIDS,
        });
        await this._open(device, keys);
      } catch (err) {
        await this._teardown();
        this._setState('disconnected');
        throw friendlyError(err);
      }
    }

    /** Reconnects to the same device without showing the picker (same page session only). */
    async reconnect(keys) {
      if (!this.device) return this.connect(keys);
      this._requireKeys(keys);
      this._setState('connecting');
      try {
        await this._open(this.device, keys);
      } catch (err) {
        await this._teardown();
        this._setState('disconnected');
        throw friendlyError(err);
      }
    }

    _requireKeys(keys) {
      if (!keys || !keys.password || !keys.aes) {
        throw new Error('No scooter keys saved yet. Add them in Setup first.');
      }
    }

    async _findService(server) {
      for (const uuid of C.ALL_SERVICE_UUIDS) {
        try {
          const service = await server.getPrimaryService(uuid);
          return { uuid, service, version: C.SERVICES[uuid] };
        } catch (err) {
          if (!err || err.name !== 'NotFoundError') throw err;
        }
      }
      throw new Error('This device does not offer the NIU scooter service.');
    }

    async _open(device, keys) {
      this.device = device;
      device.removeEventListener('gattserverdisconnected', this._onDisconnected);
      device.addEventListener('gattserverdisconnected', this._onDisconnected);

      const server = await device.gatt.connect();
      const { uuid, service, version } = await this._findService(server);
      if (version !== C.SUPPORTED_BLE_VERSION) {
        throw new Error(`This scooter uses BLE version ${version}, which this app does not support yet (only version ${C.SUPPORTED_BLE_VERSION}, as on the KQi 200F).`);
      }

      const chars = C.characteristicsFor(uuid);
      const notifyChar = await service.getCharacteristic(chars.notify);
      const writeChar = await service.getCharacteristic(chars.write);

      const transport = {
        write: (bytes) => (writeChar.writeValueWithResponse
          ? writeChar.writeValueWithResponse(bytes)
          : writeChar.writeValue(bytes)),
      };
      this.session = new Session(transport, { password: keys.password, aes: keys.aes, timeoutMs: this._timeoutMs });

      this._notifyChar = notifyChar;
      this._onValue = (event) => {
        const v = event.target.value;   // DataView; copy out, the buffer may be reused
        const bytes = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
        if (this.session) this.session.onNotification(bytes);
      };
      notifyChar.addEventListener('characteristicvaluechanged', this._onValue);
      await notifyChar.startNotifications();

      await this.session.handshake();

      this._setState('connected');
      this.dispatchEvent(new CustomEvent('connected', { detail: { name: device.name } }));
      this.session.startPolling({
        intervalMs: this._pollIntervalMs,
        onTelemetry: (t) => this.dispatchEvent(new CustomEvent('telemetry', { detail: t })),
        onError: (err) => {
          this.dispatchEvent(new CustomEvent('error', { detail: friendlyError(err) }));
          this.disconnect();
        },
      });
    }

    disconnect() {
      if (this.session) this.session.stopPolling();
      if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
    }

    async _teardown() {
      if (this.session) this.session.stopPolling();
      if (this._notifyChar && this._onValue) {
        this._notifyChar.removeEventListener('characteristicvaluechanged', this._onValue);
      }
      this._notifyChar = null;
      this._onValue = null;
      this.session = null;
      if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
    }

    _onDisconnected() {
      if (this.session) this.session.stopPolling();
      this._setState('disconnected');
      this.dispatchEvent(new CustomEvent('disconnected'));
    }
  }

  return BLEManager;
});
