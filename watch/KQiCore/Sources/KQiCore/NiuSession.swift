// NiuSession.swift — the conversation with the scooter over any transport that can write a
// 20-byte frame and hand back notification bytes. Port of js/session.js.
//
// Bluetooth stays out of here so the handshake, reads, refusals and timeouts can be tested
// on a Mac against a simulated scooter (Tests/KQiCoreTests).
// READ-ONLY: authenticates and reads fields, nothing else.

import Foundation

public protocol NiuTransport: AnyObject {
    /// Sends one 20-byte frame to the scooter's write characteristic.
    func write(_ frame: [UInt8]) async throws
}

public struct NiuTimeout: Error, LocalizedError {
    public var errorDescription: String? { "No reply from the scooter." }
}

public actor NiuSession {
    /// What the dashboard polls every second (one request block holds at most 5 field codes).
    public static let fastGroup = ["foc_k_rt_speed", "bms_soc_rt", "db_k_realtime_status", "db_k_f_code", "bms_c_cur_rt"]
    /// Read once per connection.
    public static let staticGroup = ["foc_k_max_speed", "bms_rated_vlt", "db_k_sw_ver", "bms_c_cont", "bms_soh_rt"]

    private weak var transport: NiuTransport?
    private let password: String
    private let aes: String
    private let timeout: TimeInterval
    public private(set) var verified = false
    private var unsupported = Set<String>()

    private var queue: [[UInt8]] = []
    private var waiter: (id: UInt64, cont: CheckedContinuation<Void, Never>)?
    private var waiterSeq: UInt64 = 0
    private var busy = false                      // one exchange at a time
    private var busyWaiters: [CheckedContinuation<Void, Never>] = []

    // Notifications arrive on the Bluetooth thread; this stream hands them to the actor in order.
    private let inbox: AsyncStream<[UInt8]>.Continuation
    private var pump: Task<Void, Never>?

    public init(transport: NiuTransport, password: String, aes: String, timeout: TimeInterval = 4) throws {
        _ = try NiuProtocol.keyBytes(password)       // fail fast on malformed keys
        _ = try NiuProtocol.keyBytes(aes)
        self.transport = transport
        self.password = password
        self.aes = aes
        self.timeout = timeout
        let (stream, continuation) = AsyncStream.makeStream(of: [UInt8].self)
        self.inbox = continuation
        Task { await self.startPump(stream) }
    }

    private func startPump(_ stream: AsyncStream<[UInt8]>) {
        pump = Task { [weak self] in
            for await bytes in stream { await self?.receive(bytes) }
        }
    }

    deinit {
        inbox.finish()
        pump?.cancel()
    }

    /// Call with every notification's bytes, from any thread. Order is preserved.
    public nonisolated func deliver(_ bytes: [UInt8]) {
        inbox.yield(bytes)
    }

    private func receive(_ bytes: [UInt8]) {
        queue += NiuProtocol.splitNotification(bytes)
        wake(nil)
    }

    private func wake(_ id: UInt64?) {
        guard let w = waiter, id == nil || w.id == id else { return }
        waiter = nil
        w.cont.resume()
    }

    /// Next frame accepted by `want`; other frames (late replies, pushes) are dropped.
    private func next(_ want: ([UInt8]) -> Bool) async throws -> [UInt8] {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            while !queue.isEmpty {
                let f = queue.removeFirst()
                if want(f) { return f }
            }
            let left = deadline.timeIntervalSinceNow
            if left <= 0 { throw NiuTimeout() }
            waiterSeq += 1
            let id = waiterSeq
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                waiter = (id, c)
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(left * 1_000_000_000))
                    await self?.wake(id)
                }
            }
        }
    }

    private func send(_ frames: [[UInt8]]) async throws {
        queue.removeAll()                         // anything waiting is not an answer to this request
        guard let t = transport else { throw NiuError("not connected") }
        for f in frames { try await t.write(f) }
    }

    /// Serializes exchanges so two callers can never interleave frames.
    private func exclusive<T>(_ body: () async throws -> T) async throws -> T {
        while busy { await withCheckedContinuation { busyWaiters.append($0) } }
        busy = true
        defer {
            busy = false
            if !busyWaiters.isEmpty { busyWaiters.removeFirst().resume() }
        }
        return try await body()
    }

    // MARK: handshake

    public func handshake(random: [UInt8]? = nil) async throws {
        try await exclusive {
            verified = false
            let rnd = random ?? NiuSession.secureRandom(16)
            try await send([try NiuProtocol.handshake1(password: password, random: rnd)])
            let r1 = try await next { $0.count >= 2 && $0[0] == 0x01 && ($0[1] == 0xa3 || $0[1] == 0xc3) }
            let reply = try NiuProtocol.parseHandshake1Reply(r1, password: password)
            try await send([try NiuProtocol.handshake2(password: password, random: rnd, reply: reply)])
            let r2 = try await next { $0.count >= 2 && $0[0] == 0x01 && ($0[1] == 0x83 || $0[1] == 0xc3) }
            try NiuProtocol.parseHandshake2Reply(r2, password: password)
            verified = true
        }
    }

    static func secureRandom(_ n: Int) -> [UInt8] {
        var g = SystemRandomNumberGenerator()     // cryptographically secure on Apple platforms
        return (0..<n).map { _ in UInt8.random(in: 0...255, using: &g) }
    }

    // MARK: reads

    private func readOnce(_ names: [String]) async throws -> [String: FieldValue] {
        try await exclusive {
            guard verified else { throw NiuError("not authenticated with the scooter yet") }
            try await send(try NiuProtocol.buildRead(names, key: aes))
            var frames: [[UInt8]] = []
            while true {
                let f = try await next(NiuProtocol.isReadReply)
                frames.append(f)
                if NiuProtocol.isLastReadFrame(f) { break }
            }
            return try NiuProtocol.parseReadFrames(frames, names: names, key: aes)
        }
    }

    /// Reads a group of fields. If the scooter refuses the group (it does when any one field is
    /// unsupported), asks for each field alone and remembers which were refused. Timeouts are not retried.
    public func read(_ names: [String]) async throws -> [String: FieldValue] {
        let isRefusal: (Error) -> Bool = { ($0 as? NiuError).map { !$0.code.isEmpty } ?? false }
        let wanted = names.filter { !unsupported.contains($0) }
        if wanted.isEmpty { return [:] }
        do {
            return try await readOnce(wanted)
        } catch {
            guard isRefusal(error) else { throw error }
            if wanted.count == 1 { unsupported.insert(wanted[0]); return [:] }
        }
        var out: [String: FieldValue] = [:]
        for name in wanted {
            do {
                out.merge(try await readOnce([name])) { _, new in new }
            } catch {
                guard isRefusal(error) else { throw error }
                unsupported.insert(name)
            }
        }
        return out
    }

    public func readStatus() async throws -> Telemetry { Telemetry(fields: try await read(NiuSession.fastGroup)) }
    public func readStatic() async throws -> Telemetry { Telemetry(fields: try await read(NiuSession.staticGroup)) }
}
