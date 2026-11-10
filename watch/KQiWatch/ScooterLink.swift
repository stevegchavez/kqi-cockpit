// ScooterLink.swift — Core Bluetooth on the watch: find the scooter, connect, authenticate with
// the saved keys, then read its status once a second. Same service and characteristics as the
// web app (confirmed on a real KQi 200F). READ-ONLY: it only sends handshake and read frames.
//
// The scooter accepts one Bluetooth connection at a time: while the watch is connected, the
// phone app (or the NIU app) can't be, and the other way round.

import Foundation
import CoreBluetooth
import KQiCore

enum LinkState: Equatable {
    case idle
    case bluetoothOff
    case scanning
    case connecting
    case connected
    case failed(String)

    var label: String {
        switch self {
        case .idle: return "Not connected"
        case .bluetoothOff: return "Bluetooth is off"
        case .scanning: return "Looking for the scooter…"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .failed(let why): return why
        }
    }
}

@MainActor
final class ScooterLink: NSObject, ObservableObject, NiuTransport {
    static let service = CBUUID(string: "8ec94e30-f315-4f60-9fb8-838830daea50")      // BLE version 10 (KQi 200F)
    static let notifyChar = CBUUID(string: "8ec94e31-f315-4f60-9fb8-838830daea50")
    static let writeChar = CBUUID(string: "8ec94e32-f315-4f60-9fb8-838830daea50")
    static let newerServices = [CBUUID(string: "8ec94e30-f315-4f60-9fb8-838830daea51"),
                                CBUUID(string: "8ec94e30-f315-4f60-9fb8-838830daea52")]

    @Published private(set) var state: LinkState = .idle
    @Published private(set) var telemetry = Telemetry()
    @Published private(set) var scooterName: String?
    @Published private(set) var lastUpdate: Date?

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var session: NiuSession?
    private var keys: ScooterKeys?
    private var pollTask: Task<Void, Never>?
    private var scanTimeout: Task<Void, Never>?
    private var wantConnection = false
    private var writeWaiters: [CheckedContinuation<Void, Error>] = []

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)   // callbacks on the main queue
    }

    // MARK: public

    func connect(keys: ScooterKeys) {
        self.keys = keys
        wantConnection = true
        guard central.state == .poweredOn else {
            state = central.state == .poweredOff ? .bluetoothOff : .connecting   // continues in centralManagerDidUpdateState
            return
        }
        if let p = peripheral {
            state = .connecting
            central.connect(p)
            return
        }
        if let p = central.retrieveConnectedPeripherals(withServices: [Self.service]).first {
            attach(p)
            return
        }
        state = .scanning
        // The scooter may not advertise its service, so scan for everything and match by name too.
        central.scanForPeripherals(withServices: nil, options: nil)
        scanTimeout?.cancel()
        scanTimeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            guard let self, !Task.isCancelled, self.state == .scanning else { return }
            self.central.stopScan()
            self.state = .failed("Scooter not found. Turn it on, close the NIU app and the phone app, then try again.")
        }
    }

    func disconnect() {
        wantConnection = false
        stopPolling()
        central.stopScan()
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        state = .idle
    }

    // MARK: NiuTransport

    nonisolated func write(_ frame: [UInt8]) async throws {
        try await performWrite(frame)
    }

    private func performWrite(_ frame: [UInt8]) async throws {
        guard let p = peripheral, let c = writeCharacteristic, p.state == .connected else { throw NiuError("Not connected to the scooter.") }
        if c.properties.contains(.write) {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                writeWaiters.append(cont)
                p.writeValue(Data(frame), for: c, type: .withResponse)
            }
        } else {
            p.writeValue(Data(frame), for: c, type: .withoutResponse)
        }
    }

    // MARK: internals

    private func attach(_ p: CBPeripheral) {
        peripheral = p
        p.delegate = self
        state = .connecting
        central.connect(p)
    }

    private func startSession() async {
        guard let keys else { state = .failed("Add your scooter keys in Settings."); return }
        do {
            let s = try NiuSession(transport: self, password: keys.password, aes: keys.aes)
            session = s
            try await s.handshake()
            scooterName = peripheral?.name
            state = .connected
            startPolling(s)
        } catch {
            let message = (error as? NiuError).map { e -> String in
                e.message.contains("rejected") ? "The scooter rejected the keys. Check them in Settings." : e.message
            } ?? error.localizedDescription
            state = .failed(message)
            wantConnection = false
            if let p = peripheral { central.cancelPeripheralConnection(p) }
        }
    }

    private func startPolling(_ s: NiuSession) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            if let t = try? await s.readStatic() { self?.apply(t) }
            var failures = 0
            while !Task.isCancelled {
                do {
                    let t = try await s.readStatus()
                    failures = 0
                    self?.apply(t)
                } catch {
                    failures += 1
                    if failures >= 3 {
                        self?.linkLost()
                        return
                    }
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func apply(_ t: Telemetry) {
        telemetry.merge(t)
        lastUpdate = Date()
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        session = nil
    }

    private func linkLost() {
        stopPolling()
        if let p = peripheral { central.cancelPeripheralConnection(p) }   // didDisconnect reconnects if still wanted
    }

    private func failWrites(_ error: Error) {
        let waiters = writeWaiters
        writeWaiters.removeAll()
        for w in waiters { w.resume(throwing: error) }
    }
}

// MARK: - CBCentralManagerDelegate

extension ScooterLink: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated {
            switch central.state {
            case .poweredOn:
                if wantConnection, let keys, peripheral == nil || state != .connected { connect(keys: keys) }
            case .poweredOff:
                state = .bluetoothOff
            case .unauthorized:
                state = .failed("Allow Bluetooth for this app in the watch's Settings > Privacy.")
            case .unsupported:
                state = .failed("Bluetooth isn't available on this device.")
            default:
                break
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                                    advertisementData: [String: Any], rssi RSSI: NSNumber) {
        MainActor.assumeIsolated {
            let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
            let name = peripheral.name ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? ""
            guard services.contains(Self.service) || name.uppercased().hasPrefix("NIU") else { return }
            central.stopScan()
            scanTimeout?.cancel()
            attach(peripheral)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        MainActor.assumeIsolated {
            peripheral.discoverServices([Self.service] + Self.newerServices)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated {
            state = .failed(error?.localizedDescription ?? "Couldn't connect to the scooter.")
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated {
            failWrites(NiuError("The scooter disconnected."))
            stopPolling()
            writeCharacteristic = nil
            if wantConnection {
                state = .connecting
                central.connect(peripheral)        // no timeout: reconnects when the scooter is back in range
            } else if case .failed = state {
                // keep the error on screen
            } else {
                state = .idle
            }
        }
    }
}

// MARK: - CBPeripheralDelegate

extension ScooterLink: CBPeripheralDelegate {
    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        MainActor.assumeIsolated {
            let services = peripheral.services ?? []
            if let ours = services.first(where: { $0.uuid == Self.service }) {
                peripheral.discoverCharacteristics([Self.notifyChar, Self.writeChar], for: ours)
            } else if services.contains(where: { Self.newerServices.contains($0.uuid) }) {
                wantConnection = false
                state = .failed("This scooter uses a newer Bluetooth version this app doesn't support yet.")
                central.cancelPeripheralConnection(peripheral)
            } else {
                state = .failed("This doesn't look like a NIU KQi.")
                central.cancelPeripheralConnection(peripheral)
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        MainActor.assumeIsolated {
            let chars = service.characteristics ?? []
            writeCharacteristic = chars.first { $0.uuid == Self.writeChar }
            if let notify = chars.first(where: { $0.uuid == Self.notifyChar }), writeCharacteristic != nil {
                peripheral.setNotifyValue(true, for: notify)
            } else {
                state = .failed("The scooter's Bluetooth service is missing a characteristic.")
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated {
            guard characteristic.uuid == Self.notifyChar else { return }
            if let error {
                state = .failed(error.localizedDescription)
            } else if characteristic.isNotifying {
                Task { await self.startSession() }
            }
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated {
            guard characteristic.uuid == Self.notifyChar, let value = characteristic.value else { return }
            session?.deliver([UInt8](value))        // keeps notification order
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated {
            guard !writeWaiters.isEmpty else { return }
            let w = writeWaiters.removeFirst()
            if let error { w.resume(throwing: error) } else { w.resume() }
        }
    }
}
