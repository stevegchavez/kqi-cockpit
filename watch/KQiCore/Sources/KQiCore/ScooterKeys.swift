// ScooterKeys.swift — the two per-scooter secrets (Bluetooth password + AES key) and how to read
// them from what the rider pastes. Port of parseKeys in js/keystore.js. Storage is the app's job
// (the watch keeps them in its Keychain).

import Foundation

public struct ScooterKeys: Equatable, Codable {
    public let password: String
    public let aes: String

    public init(password: String, aes: String) throws {
        let p = password.trimmingCharacters(in: .whitespacesAndNewlines)
        let a = aes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard p.utf8.count == 16, p.count == 16, p.utf8.allSatisfy({ $0 < 0x80 }) else {
            throw NiuError("The Bluetooth password must be exactly 16 characters.")
        }
        guard (try? NiuProtocol.keyBytes(a)) != nil else {
            throw NiuError("The AES key must be 16 characters or 32 hex digits.")
        }
        self.password = p
        self.aes = a
    }

    /// Accepts the contents of niu-kqi's secrets/scooter.json, or the password and AES key
    /// separated by a new line or spaces.
    public static func parse(_ text: String) throws -> ScooterKeys {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { throw NiuError("Paste your scooter keys first.") }
        if raw.hasPrefix("{") {
            guard let data = raw.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw NiuError("That looks like JSON but could not be read.")
            }
            let src = (obj["ble"] as? [String: Any]) ?? obj
            let p = (src["password"] as? String) ?? (src["blePassword"] as? String) ?? ""
            let a = (src["aes"] as? String) ?? (src["bleAes"] as? String) ?? ""
            return try ScooterKeys(password: p, aes: a)
        }
        let parts = raw.split(whereSeparator: { $0 == "\n" || $0 == "\r" || $0 == " " || $0 == "\t" }).map(String.init)
        guard parts.count == 2 else {
            throw NiuError("Paste the scooter.json contents, or the Bluetooth password and the AES key.")
        }
        return try ScooterKeys(password: parts[0], aes: parts[1])
    }
}
