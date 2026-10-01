/**
 * keystore.js — NIU Companion Web Dashboard
 *
 * Holds the scooter's two per-vehicle secrets (blePassword and bleAes) in
 * this browser's localStorage, on this device only. Nothing here talks to the
 * network.
 *
 * Error messages never include key material, so a failed paste can't leak a
 * key into a toast, a screenshot or a console log.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NIU = root.NIU || {};
    root.NIU.KeyStore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const STORAGE_KEY = 'niu.keys.v1';

  function isValidPassword(s) {
    return typeof s === 'string' && /^[\x20-\x7e]{16}$/.test(s);
  }
  function isValidAes(s) {
    return typeof s === 'string' && (/^[\x20-\x7e]{16}$/.test(s) || /^[0-9a-fA-F]{32}$/.test(s));
  }

  /**
   * Accepts any of:
   *   - the contents of niu-kqi's secrets/scooter.json (keys under "ble")
   *   - a flat JSON object with password/aes or blePassword/bleAes
   *   - two plain lines: password, then AES key
   * @returns {{password: string, aes: string}}
   * @throws {Error} with a message that never contains key material
   */
  function parseKeys(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) throw new Error('Paste your scooter keys first.');

    let password;
    let aes;
    if (raw[0] === '{') {
      let obj;
      try { obj = JSON.parse(raw); }
      catch { throw new Error('That looks like JSON but could not be read. Check for missing quotes or braces.'); }
      const src = obj && typeof obj.ble === 'object' && obj.ble ? obj.ble : obj;
      password = src.password !== undefined ? src.password : src.blePassword;
      aes = src.aes !== undefined ? src.aes : src.bleAes;
    } else {
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length !== 2) {
        throw new Error('Paste either the scooter.json contents, or two lines: the Bluetooth password, then the AES key.');
      }
      [password, aes] = lines;
    }

    if (!isValidPassword(password)) {
      throw new Error('The Bluetooth password must be exactly 16 characters.');
    }
    if (!isValidAes(aes)) {
      throw new Error('The AES key must be 16 characters or 32 hex digits.');
    }
    return { password, aes };
  }

  function storage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; }
    catch { return null; }          // storage can throw in private windows
  }

  /** @returns {{password: string, aes: string} | null} */
  function load() {
    const s = storage();
    if (!s) return null;
    try {
      const v = JSON.parse(s.getItem(STORAGE_KEY) || 'null');
      return v && isValidPassword(v.password) && isValidAes(v.aes) ? { password: v.password, aes: v.aes } : null;
    } catch { return null; }
  }

  /** @returns {boolean} whether the keys were stored */
  function save(keys) {
    const s = storage();
    if (!s || !isValidPassword(keys.password) || !isValidAes(keys.aes)) return false;
    try {
      s.setItem(STORAGE_KEY, JSON.stringify({ password: keys.password, aes: keys.aes }));
      return true;
    } catch { return false; }
  }

  function clear() {
    const s = storage();
    if (s) { try { s.removeItem(STORAGE_KEY); } catch { /* nothing to do */ } }
  }

  function has() { return load() !== null; }

  return { parseKeys, load, save, clear, has, STORAGE_KEY };
});
