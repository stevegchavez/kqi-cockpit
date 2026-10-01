/**
 * fake-bluetooth.js — a fake navigator.bluetooth backed by the simulated scooter.
 *
 * Mimics the Web Bluetooth call sequence the app uses (requestDevice ->
 * gatt.connect -> getPrimaryService -> getCharacteristic -> startNotifications
 * -> writeValue*) so BLEManager and the whole app can be tested without a phone.
 */
const C = require('../../js/constants.js');

class FakeChar extends EventTarget {
  constructor() { super(); this.value = null; this.notifying = false; }
  async startNotifications() { this.notifying = true; return this; }
  emit(bytes) {
    // Hand out a DataView over a larger buffer with a non-zero offset, as real stacks may.
    const backing = new Uint8Array(bytes.length + 7);
    backing.set(bytes, 3);
    this.value = new DataView(backing.buffer, 3, bytes.length);
    const ev = new Event('characteristicvaluechanged');
    Object.defineProperty(ev, 'target', { value: this });
    this.dispatchEvent(ev);
  }
}

function fakeBluetooth(scooter, { serviceUuid = C.PRIMARY_SERVICE_UUID, cancel = false, noWithResponse = false } = {}) {
  const suffix = serviceUuid.slice(-1);
  const notifyChar = new FakeChar();
  const writeChar = new FakeChar();
  const written = [];
  const doWrite = async (bytes) => {
    written.push(Buffer.from(bytes).toString('hex'));
    const replies = scooter.receive(Buffer.from(bytes));
    setImmediate(() => { for (const r of replies) notifyChar.emit(new Uint8Array(r)); });
  };
  if (noWithResponse) writeChar.writeValue = doWrite; else writeChar.writeValueWithResponse = doWrite;

  const service = {
    async getCharacteristic(uuid) {
      if (uuid === `8ec94e31-f315-4f60-9fb8-838830daea5${suffix}`) return notifyChar;
      if (uuid === `8ec94e32-f315-4f60-9fb8-838830daea5${suffix}`) return writeChar;
      throw Object.assign(new Error('no such characteristic'), { name: 'NotFoundError' });
    },
  };
  const device = new EventTarget();
  device.name = 'NIU KQi';
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return {
      async getPrimaryService(uuid) {
        if (uuid === serviceUuid) return service;
        throw Object.assign(new Error('Service not found'), { name: 'NotFoundError' });
      } }; },
    disconnect() { if (this.connected) { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); } },
  };
  const calls = [];
  const bluetooth = {
    async requestDevice(opts) {
      calls.push(opts);
      if (cancel) throw Object.assign(new Error('User cancelled the requestDevice() chooser.'), { name: 'NotFoundError' });
      return device;
    },
  };
  return { bluetooth, device, calls, written, notifyChar };
}

module.exports = { FakeChar, fakeBluetooth };
