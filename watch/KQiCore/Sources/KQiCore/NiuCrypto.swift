// NiuCrypto.swift — AES-128 (ECB, one block) and MD5, only because the scooter's protocol
// dictates them. Uses Apple's own implementations (CommonCrypto, CryptoKit).
// Don't reuse this for anything else: ECB and MD5 are not secure building blocks.

import Foundation
import CommonCrypto
import CryptoKit

enum NiuCrypto {
    /// Encrypts or decrypts exactly one 16-byte block with a 16-byte key.
    static func aesBlock(key: [UInt8], block: [UInt8], encrypt: Bool) throws -> [UInt8] {
        guard key.count == 16 else { throw NiuError("AES key must be 16 bytes") }
        guard block.count == 16 else { throw NiuError("AES block must be 16 bytes") }
        var out = [UInt8](repeating: 0, count: 32)
        var moved = 0
        let status = CCCrypt(
            CCOperation(encrypt ? kCCEncrypt : kCCDecrypt),
            CCAlgorithm(kCCAlgorithmAES),
            CCOptions(kCCOptionECBMode),          // no padding: the block is already 16 bytes
            key, key.count,
            nil,
            block, block.count,
            &out, out.count,
            &moved
        )
        guard status == CCCryptorStatus(kCCSuccess), moved == 16 else {
            throw NiuError("AES failed (status \(status))")
        }
        return Array(out.prefix(16))
    }

    static func encrypt(key: [UInt8], block: [UInt8]) throws -> [UInt8] {
        try aesBlock(key: key, block: block, encrypt: true)
    }

    static func decrypt(key: [UInt8], block: [UInt8]) throws -> [UInt8] {
        try aesBlock(key: key, block: block, encrypt: false)
    }

    static func md5(_ bytes: [UInt8]) -> [UInt8] {
        Array(Insecure.MD5.hash(data: Data(bytes)))
    }
}
