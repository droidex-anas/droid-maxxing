import DroidexCore
import Foundation
import Security

// Only the pairing credential lives here. API/provider credentials never leave the desktop.
enum CredentialVault {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "DROIDEX.remote",
         kSecAttrAccount as String: "paired-computer"]
    }

    static func load() throws -> DesktopCredential? {
        var lookup = Self.query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw RemoteFailure("The saved computer credential could not be opened. Unlock your phone and try again.")
        }
        return try JSONDecoder().decode(DesktopCredential.self, from: data)
    }

    static func save(_ credential: DesktopCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let attributes: [String: Any] = [kSecValueData as String: data,
                                       kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw RemoteFailure("The computer credential could not be saved securely.") }
        let status = SecItemAdd(query.merging(attributes) { _, value in value } as CFDictionary, nil)
        guard status == errSecSuccess else { throw RemoteFailure("The computer credential could not be saved securely.") }
    }

    static func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw RemoteFailure("The computer credential could not be removed from Keychain.")
        }
    }
}
