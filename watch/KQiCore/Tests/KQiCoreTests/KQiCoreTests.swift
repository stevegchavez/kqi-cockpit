// KQiCoreTests.swift — run on a Mac with:  cd watch/KQiCore && swift test
//
// Byte-for-byte checks against the reference vectors the web app is tested with
// (test/fixtures/niu_vectors.json, generated from the niu-kqi Python reference with made-up
// test keys), plus the session against a simulated scooter.

import XCTest
import Foundation
@testable import KQiCore

// MARK: - vectors

private struct ReadVector: Decodable {
    let names: [String]
    let request: [String]
    let requestHex32Key: [String]
    let replyFrames: [String]
}

private struct Vectors: Decodable {
    let pwd: String
    let aes: String
    let aesHex32: String
    let rnd: String
    let hs1Frame: String
    let hs1Reply: String
    let hs1ReplyFrame: String
    let hs2Frame: String
    let hs2OkFrame: String
    let hs2BadFrame: String
    let hs1RejectFrame: String
    let reads: [String: ReadVector]
    let readErrorFrame: String
    let lossFrames: [String]
    let badChecksumFrame: String
}

private func loadVectors() throws -> (Vectors, [String: Any]) {
    // watch/KQiCore/Tests/KQiCoreTests/this file -> repository root
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    url.appendPathComponent("test/fixtures/niu_vectors.json")
    let data = try Data(contentsOf: url)
    let typed = try JSONDecoder().decode(Vectors.self, from: data)
    let loose = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    return (typed, loose)
}

private func h(_ s: String) -> [UInt8] { try! NiuProtocol.fromHex(s) }

/// The expected values of a read vector, as FieldValues.
private func expected(_ loose: [String: Any], _ group: String) -> [String: FieldValue] {
    let reads = loose["reads"] as! [String: Any]
    let g = reads[group] as! [String: Any]
    let exp = g["expected"] as! [String: Any]
    var out: [String: FieldValue] = [:]
    for (k, v) in exp {
        if let n = v as? NSNumber { out[k] = .int(n.intValue) } else { out[k] = .text(v as! String) }
    }
    return out
}

final class ProtocolTests: XCTestCase {
    func testHandshakeFramesMatchReference() throws {
        let (V, _) = try loadVectors()
        XCTAssertEqual(NiuProtocol.hex(try NiuProtocol.handshake1(password: V.pwd, random: h(V.rnd))), V.hs1Frame)
        XCTAssertEqual(NiuProtocol.hex(try NiuProtocol.parseHandshake1Reply(h(V.hs1ReplyFrame), password: V.pwd)), V.hs1Reply)
        XCTAssertEqual(NiuProtocol.hex(try NiuProtocol.handshake2(password: V.pwd, random: h(V.rnd), reply: h(V.hs1Reply))), V.hs2Frame)
        XCTAssertNoThrow(try NiuProtocol.parseHandshake2Reply(h(V.hs2OkFrame), password: V.pwd))
    }

    func testHandshakeRefusalsAreReported() throws {
        let (V, _) = try loadVectors()
        XCTAssertThrowsError(try NiuProtocol.parseHandshake2Reply(h(V.hs2BadFrame), password: V.pwd)) { e in
            XCTAssertTrue((e as! NiuError).message.contains("password verify failed (flag 07)"))
        }
        XCTAssertThrowsError(try NiuProtocol.parseHandshake1Reply(h(V.hs1RejectFrame), password: V.pwd)) { e in
            XCTAssertEqual((e as! NiuError).code, "2A")
        }
        var corrupted = h(V.hs1ReplyFrame)
        corrupted[19] ^= 1
        XCTAssertThrowsError(try NiuProtocol.parseHandshake1Reply(corrupted, password: V.pwd))
    }

    func testReadRequestsAndRepliesMatchReference() throws {
        let (V, loose) = try loadVectors()
        for (group, r) in V.reads {
            XCTAssertEqual(try NiuProtocol.buildRead(r.names, key: V.aes).map(NiuProtocol.hex), r.request, group)
            XCTAssertEqual(try NiuProtocol.buildRead(r.names, key: V.aesHex32).map(NiuProtocol.hex), r.requestHex32Key, group)
            let parsed = try NiuProtocol.parseReadFrames(r.replyFrames.map(h), names: r.names, key: V.aes)
            XCTAssertEqual(parsed, expected(loose, group), group)
        }
    }

    func testRefusalLossAndCorruptionAreDetected() throws {
        let (V, _) = try loadVectors()
        let fast = V.reads["fast"]!
        XCTAssertThrowsError(try NiuProtocol.parseReadFrames([h(V.readErrorFrame)], names: fast.names, key: V.aes)) { e in
            XCTAssertEqual((e as! NiuError).code, "40")
        }
        XCTAssertTrue(NiuProtocol.isLastReadFrame(h(V.readErrorFrame)))
        XCTAssertThrowsError(try NiuProtocol.parseReadFrames([h(V.badChecksumFrame)], names: fast.names, key: V.aes))
        XCTAssertThrowsError(try NiuProtocol.parseReadFrames(V.lossFrames.map(h), names: V.reads["long"]!.names, key: V.aes)) { e in
            XCTAssertTrue((e as! NiuError).message.contains("frame loss"))
        }
    }

    func testDecodeAndHelpers() throws {
        let u16 = FieldSpec(code: "21003B", len: 2, type: .u16)
        XCTAssertEqual(NiuProtocol.decode(u16, [0x01, 0x2c]), .int(300))
        XCTAssertEqual(NiuProtocol.decode(FieldSpec(code: "x", len: 8, type: .utf8), h("4b32430000000000")), .text("K2C"))
        XCTAssertEqual(NiuProtocol.decode(FieldSpec(code: "x", len: 1, type: .s8), [0xff]), .int(-1))
        XCTAssertEqual(NiuProtocol.splitNotification([UInt8](repeating: 1, count: 40)).count, 2)
        XCTAssertEqual(NiuProtocol.splitNotification([1, 2, 3]).count, 1)
        XCTAssertThrowsError(try NiuProtocol.keyBytes("short"))
        XCTAssertEqual(try NiuProtocol.keyBytes("00112233445566778899aabbccddeeff").count, 16)
        XCTAssertThrowsError(try NiuProtocol.fromHex("zz"))
    }

    func testTelemetryFromFields() {
        let t = Telemetry(fields: ["foc_k_rt_speed": .int(123), "bms_soc_rt": .int(59), "db_k_realtime_status": .int(4325377),
                                   "foc_k_max_speed": .int(300), "bms_c_cont": .int(151), "db_k_sw_ver": .text("K2C2FV32")])
        XCTAssertEqual(t.speedKPH, 12.3)
        XCTAssertEqual(t.batterySOC, 59)
        XCTAssertEqual(t.poweredOn, true)
        XCTAssertEqual(t.maxSpeedKPH, 30)
        XCTAssertEqual(t.chargeCycles, 151)
        XCTAssertEqual(t.firmware, "K2C2FV32")
        var merged = t
        merged.merge(Telemetry(fields: ["bms_soc_rt": .int(58)]))
        XCTAssertEqual(merged.batterySOC, 58)
        XCTAssertEqual(merged.speedKPH, 12.3, "fields not in the new read are kept")
    }
}

final class KeysAndDialTests: XCTestCase {
    func testKeyParsing() throws {
        let json = #"{"ble": {"blePassword": "0123456789abcdef", "bleAes": "fedcba9876543210"}}"#
        XCTAssertEqual(try ScooterKeys.parse(json), try ScooterKeys(password: "0123456789abcdef", aes: "fedcba9876543210"))
        XCTAssertEqual(try ScooterKeys.parse("0123456789abcdef\nfedcba9876543210").aes, "fedcba9876543210")
        XCTAssertEqual(try ScooterKeys.parse(" 0123456789abcdef  00112233445566778899aabbccddeeff ").aes.count, 32)
        XCTAssertThrowsError(try ScooterKeys.parse(""))
        XCTAssertThrowsError(try ScooterKeys.parse("short fedcba9876543210"))
        XCTAssertThrowsError(try ScooterKeys.parse("{oops"))
    }

    func testDialZones() {
        XCTAssertEqual(Dial.maxKPH(scooterLimitKPH: 30), 33)
        XCTAssertEqual(Dial.maxKPH(scooterLimitKPH: nil), 32)
        XCTAssertEqual(Dial.zone(fraction: 0), .idle)
        XCTAssertEqual(Dial.zone(fraction: 0.3), .good)
        XCTAssertEqual(Dial.zone(fraction: 0.6), .fair)
        XCTAssertEqual(Dial.zone(fraction: 0.9), .poor)
        XCTAssertEqual(Dial.fraction(speedKPH: 50, maxKPH: 33), 1)
    }
}

// MARK: - session against a simulated scooter

/// A simulated KQi (BLE 10): handshake and reads, with the made-up test keys.
private final class FakeScooter: NiuTransport {
    let password: [UInt8]
    let aes: [UInt8]
    var fields: [String: (len: Int, value: Int)]
    var refuse: Set<String> = []
    var silent = false
    weak var session: NiuSession?
    private var rnd: [UInt8] = []
    private var reply: [UInt8] = []
    var verified = false
    var requested: [String] = []

    init(password: String, aes: String, fields: [String: (len: Int, value: Int)]) {
        self.password = Array(password.utf8)
        self.aes = Array(aes.utf8)
        self.fields = fields
    }

    private func frame(_ header: [UInt8], _ index: UInt8, _ plain: [UInt8], key: [UInt8]) -> [UInt8] {
        let encrypted = try! NiuCrypto.encrypt(key: key, block: plain)
        let body = header + [index] + encrypted
        return body + [NiuProtocol.checksum(body)]
    }

    func write(_ f: [UInt8]) async throws {
        guard !silent, f.count == 20, NiuProtocol.checksumOK(f) else { return }
        let payload = Array(f[3..<19])
        var replies: [[UInt8]] = []
        if f[0] == 0x01 && f[1] == 0x23 {
            rnd = try NiuCrypto.decrypt(key: password, block: payload)
            reply = (0..<16).map { UInt8($0 * 7 & 0xff) }
            replies = [frame([0x01, 0xa3], 0x01, reply, key: password)]
        } else if f[0] == 0x01 && f[1] == 0x03 {
            let got = try NiuCrypto.decrypt(key: password, block: payload)
            if got == NiuCrypto.md5(rnd + reply + password) {
                verified = true
                replies = [frame([0x01, 0x83], 0x00, [0x00] + [UInt8](repeating: 0x11, count: 15), key: password)]
            } else {
                replies = [frame([0x01, 0xc3], 0x00, [0x2a] + [UInt8](repeating: 0, count: 15), key: password)]
            }
        } else if f[0] == 0x01 && f[1] == 0x21 && verified {
            let data = try NiuCrypto.decrypt(key: aes, block: payload)
            var codes: [String] = []
            var i = 0
            while i + 3 <= data.count {
                let c = NiuProtocol.hex(Array(data[i..<(i + 3)])).uppercased()
                if c == "000000" { break }
                codes.append(c)
                i += 3
            }
            requested += codes
            if codes.contains(where: { refuse.contains($0) || fields[$0] == nil }) {
                replies = [frame([0x01, 0xe1], 0x00, [0x40] + [UInt8](repeating: 0, count: 15), key: aes)]
            } else {
                var out: [UInt8] = []
                for c in codes {
                    let fld = fields[c]!
                    for k in stride(from: fld.len - 1, through: 0, by: -1) { out.append(UInt8((fld.value >> (8 * k)) & 0xff)) }
                }
                let n = max(1, (out.count + 15) / 16)
                for j in 0..<n {
                    var block = [UInt8](repeating: 0, count: 16)
                    let end = min(out.count, (j + 1) * 16)
                    if j * 16 < end { block.replaceSubrange(0..<(end - j * 16), with: out[(j * 16)..<end]) }
                    replies.append(frame(j == 0 ? [0x01, 0xa1] : [0x01, 0x81], UInt8(n - j - 1), block, key: aes))
                }
            }
        }
        let s = session
        for r in replies { s?.deliver(r) }
    }
}

private func defaultFields() -> [String: (len: Int, value: Int)] {
    [
        "21000B": (2, 123), "31001C": (1, 59), "110004": (4, 4325377), "110006": (1, 0), "31001A": (2, 0),
        "21003B": (2, 300), "310016": (1, 48), "310018": (2, 151), "31004C": (1, 93),
    ]
}

final class SessionTests: XCTestCase {
    private func link(password: String = "0123456789abcdef", refuse: Set<String> = []) throws -> (FakeScooter, NiuSession) {
        let scooter = FakeScooter(password: "0123456789abcdef", aes: "fedcba9876543210", fields: defaultFields())
        scooter.refuse = refuse
        let session = try NiuSession(transport: scooter, password: password, aes: "fedcba9876543210", timeout: 0.5)
        scooter.session = session
        return (scooter, session)
    }

    func testHandshakeAndStatusRead() async throws {
        let (scooter, session) = try link()
        try await session.handshake()
        XCTAssertTrue(scooter.verified)
        let t = try await session.readStatus()
        XCTAssertEqual(t.speedKPH, 12.3)
        XCTAssertEqual(t.batterySOC, 59)
        XCTAssertEqual(t.poweredOn, true)
        XCTAssertEqual(t.batteryCurrentRaw, 0)
    }

    func testWrongPasswordIsRejected() async throws {
        let (_, session) = try link(password: "AAAAAAAAAAAAAAAA")
        do {
            try await session.handshake()
            XCTFail("a wrong password must not be accepted")
        } catch let e as NiuError {
            XCTAssertTrue(e.message.contains("rejected at step 2"))
        }
        let verified = await session.verified
        XCTAssertFalse(verified)
    }

    func testARefusedFieldIsDroppedAndTheRestStillRead() async throws {
        let (scooter, session) = try link(refuse: ["31001A"])
        try await session.handshake()
        let t = try await session.readStatus()
        XCTAssertEqual(t.batterySOC, 59)
        XCTAssertNil(t.batteryCurrentRaw)
        scooter.requested.removeAll()
        _ = try await session.readStatus()
        XCTAssertFalse(scooter.requested.contains("31001A"), "a refused field is not asked for again")
    }

    func testSilenceTimesOut() async throws {
        let (scooter, session) = try link()
        try await session.handshake()
        scooter.silent = true
        do {
            _ = try await session.readStatus()
            XCTFail("expected a timeout")
        } catch is NiuTimeout {}
    }

    func testStaticRead() async throws {
        let (_, session) = try link()
        try await session.handshake()
        let t = try await session.readStatic()
        XCTAssertEqual(t.maxSpeedKPH, 30)
        XCTAssertEqual(t.chargeCycles, 151)
        XCTAssertEqual(t.batteryHealth, 93)
    }
}
