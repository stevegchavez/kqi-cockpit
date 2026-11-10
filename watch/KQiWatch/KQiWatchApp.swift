// KQiWatchApp.swift — entry point. Three pages, swiped vertically with the Digital Crown:
// the speed dial, the ride page, and settings.

import SwiftUI
import KQiCore

@main
struct KQiWatchApp: App {
    @StateObject private var link = ScooterLink()
    @StateObject private var ride = RideRecorder()

    var body: some Scene {
        WindowGroup {
            TabView {
                DashboardView()
                RideView()
                SettingsView()
            }
            .tabViewStyle(.verticalPage)
            .environmentObject(link)
            .environmentObject(ride)
            .onAppear {
                if let keys = KeyVault.load(), link.state == .idle { link.connect(keys: keys) }
            }
        }
    }
}
