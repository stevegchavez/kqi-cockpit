// RideView.swift — start and finish a ride (recorded as a cycling workout in Apple Health).

import SwiftUI
import KQiCore

struct RideView: View {
    @EnvironmentObject var link: ScooterLink
    @EnvironmentObject var ride: RideRecorder
    @AppStorage("useMiles") private var useMiles = true
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if ride.isRiding {
                    Text(clock(ride.elapsed))
                        .font(.system(size: 34, weight: .heavy, design: .rounded))
                        .italic()
                        .monospacedDigit()
                    HStack {
                        stat(distance(ride.distanceMeters), useMiles ? "MI" : "KM")
                        stat("\(Int(Dial.display(kph: ride.topSpeedKPH, miles: useMiles).rounded()))", useMiles ? "TOP MPH" : "TOP KM/H")
                        stat(ride.heartRate.map { "\(Int($0))" } ?? "–", "BPM")
                    }
                } else if let last = ride.lastRide {
                    Text("Last ride").font(.footnote).foregroundStyle(.secondary)
                    HStack {
                        stat(distance(last.distanceMeters), useMiles ? "MI" : "KM")
                        stat(clock(last.duration), "TIME")
                        stat(used(last), "BATTERY")
                    }
                } else {
                    Text("Rides are saved to Apple Health as cycling workouts, with the route.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                Button {
                    busy = true
                    Task {
                        if ride.isRiding { await ride.stop(batterySOC: link.telemetry.batterySOC) }
                        else { await ride.start(batterySOC: link.telemetry.batterySOC) }
                        busy = false
                    }
                } label: {
                    Text(ride.isRiding ? "FINISH RIDE" : "START RIDE")
                        .font(.system(size: 16, weight: .heavy))
                        .italic()
                        .tracking(2)
                        .frame(maxWidth: .infinity)
                }
                .tint(ride.isRiding ? .red : .orange)
                .disabled(busy)

                if !ride.isRiding && link.state != .connected {
                    Text("Not connected: the ride will record GPS and heart rate, but no scooter speed or battery.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                if let err = ride.lastError {
                    Text(err).font(.caption2).foregroundStyle(.red).multilineTextAlignment(.center)
                }
            }
        }
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 0) {
            Text(value).font(.system(size: 18, weight: .bold, design: .rounded)).italic().monospacedDigit()
            Text(label).font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary).tracking(1)
        }
        .frame(maxWidth: .infinity)
    }

    private func distance(_ meters: Double) -> String {
        String(format: "%.2f", useMiles ? meters / 1609.344 : meters / 1000)
    }

    private func clock(_ seconds: TimeInterval) -> String {
        let s = Int(seconds)
        return s >= 3600 ? String(format: "%ld:%02ld:%02ld", s / 3600, s / 60 % 60, s % 60) : String(format: "%ld:%02ld", s / 60, s % 60)
    }

    private func used(_ r: RideSummary) -> String {
        guard let a = r.startSOC, let b = r.endSOC else { return "–" }
        return "\(max(0, a - b))%"
    }
}
