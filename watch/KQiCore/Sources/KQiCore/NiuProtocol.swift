// NiuProtocol.swift — frame building and parsing for NIU "BLE version 10" scooters (KQi 200F).
//
// A Swift port of js/protocol.js from the web app, checked against the same reference vectors
// (test/fixtures/niu_vectors.json, made-up test keys). The protocol knowledge comes from
// https://github.com/BaesTheorem/niu-kqi (MIT) — see NOTICE.md at the repository root.
//
// Every frame is 20 bytes: header(2) | index(1) | AES-128-ECB block(16) | checksum(1),
// the checksum being the sum of the first 19 bytes mod 256.
// READ-ONLY: this file builds handshake and read requests only.

import Foundation

public struct NiuError: Error, Equatable, CustomStringConvertible, LocalizedError {
    public let message: String
    /// Two-digit hex error code reported by the scooter, or "" when the error is ours.
    public let code: String
    public init(_ message: String, code: String = "") { self.message = message; self.code = code }
    public var description: String { message }
    public var errorDescription: String? { message }
}

public enum FieldType: String {
    case u8 = "U8", u16 = "U16", u32 = "U32", s8 = "S8", s16 = "S16", s32 = "S32", utf8 = "UTF-8", hex = "HEX"
}

public struct FieldSpec: Equatable {
    public let code: String
    public let len: Int
    public let type: FieldType
}

public enum FieldValue: Equatable, CustomStringConvertible {
    case int(Int)
    case text(String)

    public var int: Int? { if case .int(let v) = self { return v } else { return nil } }
    public var text: String? { if case .text(let v) = self { return v } else { return nil } }
    public var description: String {
        switch self { case .int(let v): return String(v); case .text(let s): return s }
    }
}

public enum NiuProtocol {
    public static let frameLength = 20

    // 2-byte frame headers.
    static let readFirst: [UInt8] = [0x01, 0x21]
    static let readNext: [UInt8] = [0x01, 0x01]
    static let readAck: [UInt8] = [0x01, 0xa1]
    static let readAckNext: [UInt8] = [0x01, 0x81]
    static let readErr: [UInt8] = [0x01, 0xe1]
    static let readErrNext: [UInt8] = [0x01, 0xc1]
    static let hs1: [UInt8] = [0x01, 0x23]
    static let hs1Ack: [UInt8] = [0x01, 0xa3]
    static let hs2: [UInt8] = [0x01, 0x03]
    static let hs2Ack: [UInt8] = [0x01, 0x83]
    static let hsErr: [UInt8] = [0x01, 0xc3]

    /// The fields the watch reads. Only fields confirmed readable on a real KQi 200F.
    /// Multi-byte integers are big-endian.
    public static let fields: [String: FieldSpec] = [
        "foc_k_rt_speed": FieldSpec(code: "21000B", len: 2, type: .u16),       // km/h x 10
        "foc_k_max_speed": FieldSpec(code: "21003B", len: 2, type: .u16),      // km/h x 10
        "foc_k_s_ver": FieldSpec(code: "210002", len: 8, type: .utf8),
        "bms_soc_rt": FieldSpec(code: "31001C", len: 1, type: .u8),            // battery %
        "bms_soh_rt": FieldSpec(code: "31004C", len: 1, type: .u8),            // battery health %
        "bms_rated_vlt": FieldSpec(code: "310016", len: 1, type: .u8),
        "bms_c_cont": FieldSpec(code: "310018", len: 2, type: .u16),           // charge cycles
        "bms_s_ver_n": FieldSpec(code: "31003C", len: 8, type: .utf8),
        "bms_c_cur_rt": FieldSpec(code: "31001A", len: 2, type: .u16),         // battery current, units unconfirmed
        "db_k_realtime_status": FieldSpec(code: "110004", len: 4, type: .u32), // bit 1 = powered on
        "db_k_f_code": FieldSpec(code: "110006", len: 1, type: .u8),
        "db_k_sw_ver": FieldSpec(code: "110002", len: 8, type: .utf8),
    ]

    // MARK: bytes

    public static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    public static func fromHex(_ s: String) throws -> [UInt8] {
        let chars = Array(s.utf8)
        guard chars.count % 2 == 0 else { throw NiuError("invalid hex string") }
        var out = [UInt8]()
        out.reserveCapacity(chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { throw NiuError("invalid hex string") }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30          // 0-9
        case 0x61...0x66: return c - 0x61 + 10     // a-f
        case 0x41...0x46: return c - 0x41 + 10     // A-F
        default: return nil
        }
    }

    public static func checksum<C: Collection>(_ bytes: C) -> UInt8 where C.Element == UInt8 {
        bytes.reduce(UInt8(0)) { $0 &+ $1 }
    }

    /// True when the last byte equals the sum of all the bytes before it.
    public static func checksumOK(_ frame: [UInt8]) -> Bool {
        frame.count >= 2 && frame[frame.count - 1] == checksum(frame.dropLast())
    }

    static func header(_ frame: [UInt8], is h: [UInt8]) -> Bool {
        frame.count >= 2 && frame[0] == h[0] && frame[1] == h[1]
    }

    static func hex2(_ b: UInt8) -> String { String(format: "%02X", b) }

    // MARK: keys

    /// A 16-character ASCII key (used as-is) or 32 hex digits.
    public static func keyBytes(_ key: String) throws -> [UInt8] {
        let ascii = Array(key.utf8)
        if key.count == 16 && ascii.count == 16 && ascii.allSatisfy({ $0 < 0x80 }) { return ascii }
        if ascii.count == 32, let bytes = try? fromHex(key) { return bytes }
        throw NiuError("AES key must be 16 characters or 32 hex digits")
    }

    // MARK: frames

    /// Splits `data` into 16-byte AES blocks, one 20-byte frame each.
    static func buildChunked(first: [UInt8], next: [UInt8], data: [UInt8], key: [UInt8]) throws -> [[UInt8]] {
        let n = max(1, (data.count + 15) / 16)
        var frames: [[UInt8]] = []
        for i in 0..<n {
            var chunk = [UInt8](repeating: 0, count: 16)          // zero-padded on the right
            let start = i * 16
            let end = min(start + 16, data.count)
            if start < end { chunk.replaceSubrange(0..<(end - start), with: data[start..<end]) }
            var body = (i == 0 ? first : next) + [UInt8(n - i - 1)]
            body += try NiuCrypto.encrypt(key: key, block: chunk)
            frames.append(body + [checksum(body)])
        }
        return frames
    }

    static func spec(_ name: String) throws -> FieldSpec {
        guard let s = fields[name] else { throw NiuError("unknown or unsupported field \(name)") }
        return s
    }

    /// Request frames asking the scooter for the named fields.
    public static func buildRead(_ names: [String], key: String) throws -> [[UInt8]] {
        var data: [UInt8] = []
        for n in names { data += try fromHex(try spec(n).code) }
        return try buildChunked(first: readFirst, next: readNext, data: data, key: try keyBytes(key))
    }

    /// A frame that belongs to a read reply (data or refusal).
    public static func isReadReply(_ f: [UInt8]) -> Bool {
        header(f, is: readAck) || header(f, is: readAckNext) || header(f, is: readErr) || header(f, is: readErrNext)
    }

    static func isReadError(_ f: [UInt8]) -> Bool { header(f, is: readErr) || header(f, is: readErrNext) }

    /// True when a read reply frame is the final one (index 0) or an error.
    public static func isLastReadFrame(_ f: [UInt8]) -> Bool {
        (f.count > 2 && f[2] == 0x00) || isReadError(f)
    }

    static func errorCode(_ frame: [UInt8], key: [UInt8]) -> String {
        guard frame.count >= 19, let plain = try? NiuCrypto.decrypt(key: key, block: Array(frame[3..<19])) else { return "??" }
        return hex2(plain[0])
    }

    /// Decodes one field's bytes. Integers are big-endian; text is NUL-trimmed; HEX is lower-case hex.
    public static func decode(_ spec: FieldSpec, _ bytes: [UInt8]) -> FieldValue {
        switch spec.type {
        case .u8, .u16, .u32:
            return .int(bytes.reduce(0) { $0 * 256 + Int($1) })
        case .s8, .s16, .s32:
            let v = bytes.reduce(0) { $0 * 256 + Int($1) }
            let bits = bytes.count * 8
            return .int(v >= (1 << (bits - 1)) ? v - (1 << bits) : v)
        case .utf8:
            var end = bytes.count
            while end > 0 && bytes[end - 1] == 0 { end -= 1 }
            return .text(String(decoding: bytes[0..<end], as: UTF8.self))
        case .hex:
            return .text(hex(bytes))
        }
    }

    /// Reassembles a read reply and splits it into named values.
    public static func parseReadFrames(_ frames: [[UInt8]], names: [String], key: String) throws -> [String: FieldValue] {
        let k = try keyBytes(key)
        var receivable = 0
        var actual = 0
        var data: [UInt8] = []
        for f in frames {
            guard f.count == frameLength, checksumOK(f) else { throw NiuError("bad checksum in reply frame") }
            if f[2] == 0xff { continue }
            if header(f, is: readAck) {
                receivable = Int(f[2]) + 1
                data += try NiuCrypto.decrypt(key: k, block: Array(f[3..<19]))
                actual += 1
            } else if header(f, is: readAckNext) {
                data += try NiuCrypto.decrypt(key: k, block: Array(f[3..<19]))
                actual += 1
            } else if isReadError(f) {
                let code = errorCode(f, key: k)
                throw NiuError("scooter refused the read (error \(code))", code: code)
            } else {
                throw NiuError("unexpected reply header \(hex(Array(f.prefix(2))))")
            }
        }
        guard receivable == actual else {
            throw NiuError("frame loss: expected \(receivable) data frames, got \(actual)")
        }
        var out: [String: FieldValue] = [:]
        var pos = 0
        for name in names {
            let s = try spec(name)
            guard pos + s.len <= data.count else { throw NiuError("reply too short for \(name) (got \(data.count) bytes)") }
            out[name] = decode(s, Array(data[pos..<(pos + s.len)]))
            pos += s.len
        }
        return out
    }

    /// The scooter may deliver several 20-byte frames in one notification.
    public static func splitNotification(_ bytes: [UInt8]) -> [[UInt8]] {
        guard !bytes.isEmpty, bytes.count % frameLength == 0 else { return [bytes] }
        return stride(from: 0, to: bytes.count, by: frameLength).map { Array(bytes[$0..<($0 + frameLength)]) }
    }

    // MARK: handshake (BLE 10)

    /// Step 1 request: 01 23 01 + AES_pwd(random16).
    public static func handshake1(password: String, random: [UInt8]) throws -> [UInt8] {
        guard random.count == 16 else { throw NiuError("random must be 16 bytes") }
        let encrypted = try NiuCrypto.encrypt(key: try keyBytes(password), block: random)
        let body = hs1 + [0x01] + encrypted
        return body + [checksum(body)]
    }

    /// Step 1 reply -> the scooter's 16 plaintext bytes.
    public static func parseHandshake1Reply(_ frame: [UInt8], password: String) throws -> [UInt8] {
        let k = try keyBytes(password)
        if header(frame, is: hsErr) {
            let code = errorCode(frame, key: k)
            throw NiuError("password rejected at step 1 (error \(code))", code: code)
        }
        guard header(frame, is: hs1Ack) else { throw NiuError("unexpected verify reply \(hex(Array(frame.prefix(2))))") }
        guard frame.count == frameLength, checksumOK(frame) else { throw NiuError("bad checksum in verify reply 1") }
        return try NiuCrypto.decrypt(key: k, block: Array(frame[3..<19]))
    }

    /// Step 2 request: 01 03 00 + AES_pwd(md5(random16 ‖ reply16 ‖ pwd)).
    public static func handshake2(password: String, random: [UInt8], reply: [UInt8]) throws -> [UInt8] {
        let k = try keyBytes(password)
        let digest = NiuCrypto.md5(random + reply + k)
        let encrypted = try NiuCrypto.encrypt(key: k, block: digest)
        let body = hs2 + [0x00] + encrypted
        return body + [checksum(body)]
    }

    /// Step 2 reply; throws unless the scooter accepted the password.
    public static func parseHandshake2Reply(_ frame: [UInt8], password: String) throws {
        let k = try keyBytes(password)
        if header(frame, is: hsErr) {
            let code = errorCode(frame, key: k)
            throw NiuError("password rejected at step 2 (error \(code))", code: code)
        }
        guard header(frame, is: hs2Ack) else { throw NiuError("unexpected verify reply \(hex(Array(frame.prefix(2))))") }
        guard frame.count == frameLength, checksumOK(frame) else { throw NiuError("bad checksum in verify reply 2") }
        let plain = try NiuCrypto.decrypt(key: k, block: Array(frame[3..<19]))
        guard plain[0] == 0x00 else { throw NiuError("password verify failed (flag \(hex2(plain[0])))") }
    }
}

/// What the dashboard shows. Every value is optional: a read fills in only what it asked for.
public struct Telemetry: Equatable {
    public var speedKPH: Double?
    public var batterySOC: Int?
    public var batteryHealth: Int?
    public var poweredOn: Bool?
    public var faultCode: Int?
    public var maxSpeedKPH: Double?
    public var chargeCycles: Int?
    public var batteryCurrentRaw: Int?
    public var firmware: String?

    public init() {}

    /// Maps raw field values to telemetry. Speeds are km/h x 10 (confirmed for the top-speed field).
    public init(fields v: [String: FieldValue]) {
        if let s = v["foc_k_rt_speed"]?.int { speedKPH = Double(s) / 10 }
        if let b = v["bms_soc_rt"]?.int { batterySOC = min(b, 100) }
        if let h = v["bms_soh_rt"]?.int { batteryHealth = min(h, 100) }
        if let st = v["db_k_realtime_status"]?.int { poweredOn = (st & 1) == 1 }
        if let f = v["db_k_f_code"]?.int { faultCode = f }
        if let m = v["foc_k_max_speed"]?.int { maxSpeedKPH = Double(m) / 10 }
        if let c = v["bms_c_cont"]?.int { chargeCycles = c }
        if let i = v["bms_c_cur_rt"]?.int { batteryCurrentRaw = i }
        if let fw = v["db_k_sw_ver"]?.text { firmware = fw }
    }

    /// Overlays the values present in `other`.
    public mutating func merge(_ other: Telemetry) {
        speedKPH = other.speedKPH ?? speedKPH
        batterySOC = other.batterySOC ?? batterySOC
        batteryHealth = other.batteryHealth ?? batteryHealth
        poweredOn = other.poweredOn ?? poweredOn
        faultCode = other.faultCode ?? faultCode
        maxSpeedKPH = other.maxSpeedKPH ?? maxSpeedKPH
        chargeCycles = other.chargeCycles ?? chargeCycles
        batteryCurrentRaw = other.batteryCurrentRaw ?? batteryCurrentRaw
        firmware = other.firmware ?? firmware
    }
}
