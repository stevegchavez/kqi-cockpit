/**
 * storage.js — NIU Companion Web Dashboard
 *
 * All ride history lives in IndexedDB, entirely on-device. Nothing here
 * ever makes a network request — no cloud sync, no analytics beacon.
 */
(function (root) {
  const DB_NAME = 'niu-companion';
  const DB_VERSION = 1;
  const STORE_NAME = 'rides';

  class RideStore {
    constructor() {
      this._dbPromise = this._open();
    }

    _open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('startDate', 'startDate');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async saveRide(ride) {
      const db = await this._dbPromise;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(ride);
        tx.oncomplete = () => resolve(ride);
        tx.onerror = () => reject(tx.error);
      });
    }

    async getAllRides() {
      const db = await this._dbPromise;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => {
          const rides = req.result || [];
          rides.sort((a, b) => b.startDate - a.startDate);
          resolve(rides);
        };
        req.onerror = () => reject(req.error);
      });
    }

    async deleteRide(id) {
      const db = await this._dbPromise;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  }

  root.NIU = root.NIU || {};
  root.NIU.RideStore = RideStore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
