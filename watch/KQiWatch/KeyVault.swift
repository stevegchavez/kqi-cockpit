// KeyVault.swift — keeps the scooter keys in the watch's Keychain (this device only, never
// synced or backed up to other devices).

import Foundation
import Security
import KQiCore

enum KeyVault {
    private static let service = "kqi-cockpit.scooter-keys"
    private static let account = "scooter"

    private static var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func load() -> ScooterKeys? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(ScooterKeys.self, from: data)
    }

    @discardableResult
    static func save(_ keys: ScooterKeys) -> Bool {
        guard let data = try? JSONEncoder().encode(keys) else { return false }
        delete()
        var query = baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}
