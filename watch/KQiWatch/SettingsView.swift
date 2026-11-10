// SettingsView.swift — scooter keys (pasted from the iPhone), units, and what the scooter reports.
//
// Tip: when a text field is open on the watch, the iPhone shows an "Apple Watch Keyboard"
// notification; tap it to type or paste on the phone instead.

import SwiftUI
import KQiCore

struct SettingsView: View {
    @EnvironmentObject var link: ScooterLink
    @AppStorage("useMiles") private var useMiles = true
    @State private var password = ""
    @State private var aes = ""
    @State private var message = ""
    @State private var hasKeys = KeyVault.load() != nil

    var body: some View {
        Form {
            Section {
                if hasKeys {
                    Label("Keys saved on this watch", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                    Button("Remove keys", role: .destructive) {
                        link.disconnect()
                        KeyVault.delete()
                        hasKeys = false
                        message = ""
                    }
                } else {
                    TextField("Bluetooth password", text: $password)
                    TextField("AES key", text: $aes)
                    Button("Save keys") { save() }
                        .tint(.orange)
                }
                if !message.isEmpty {
                    Text(message).font(.footnote).foregroundStyle(hasKeys ? .green : .red)
                }
            } header: {
                Text("Scooter keys")
            } footer: {
                Text("The same two keys as the web app's Setup tab. Paste the whole scooter.json into the first field, or one key per field.")
            }

            Section("Units") {
                Toggle("Miles", isOn: $useMiles)
            }

            if link.state == .connected {
                Section("Scooter") {
                    row("Health", link.telemetry.batteryHealth.map { "\($0)%" })
                    row("Charge cycles", link.telemetry.chargeCycles.map(String.init))
                    row("Power", link.telemetry.poweredOn.map { $0 ? "On" : "Off" })
                    row("Firmware", link.telemetry.firmware)
                    if let f = link.telemetry.faultCode, f != 0 { row("Fault code", String(f)) }
                    Button("Disconnect") { link.disconnect() }
                }
            }
        }
    }

    private func row(_ label: String, _ value: String?) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value ?? "–").foregroundStyle(.secondary)
        }
    }

    private func save() {
        do {
            // Whole scooter.json (or both keys) pasted into the first field, or one key per field.
            let keys = aes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? try ScooterKeys.parse(password)
                : try ScooterKeys(password: password, aes: aes)
            guard KeyVault.save(keys) else { message = "Couldn't save to the Keychain."; return }
            password = ""
            aes = ""
            hasKeys = true
            message = "Saved. Connecting…"
            link.connect(keys: keys)
        } catch {
            message = (error as? NiuError)?.message ?? error.localizedDescription
        }
    }
}
