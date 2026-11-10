// DashboardView.swift — the speed dial (green = efficient, yellow, red = high drain, the same
// zones as the web app), battery, and the connection state.

import SwiftUI
import WatchKit
import KQiCore

struct DashboardView: View {
    @EnvironmentObject var link: ScooterLink
    @EnvironmentObject var ride: RideRecorder
    @AppStorage("useMiles") private var useMiles = true

    var body: some View {
        let t = link.telemetry
        VStack(spacing: 4) {
            SpeedDial(speedKPH: link.state == .connected ? (t.speedKPH ?? 0) : 0,
                      maxKPH: Dial.maxKPH(scooterLimitKPH: t.maxSpeedKPH),
                      useMiles: useMiles)
            if link.state == .connected {
                BatteryBar(soc: t.batterySOC)
            } else {
                ConnectRow()
            }
        }
        .padding(.horizontal, 4)
        .onChange(of: t.speedKPH) { _, kph in ride.noteSpeed(kph: kph ?? 0) }
        .onChange(of: link.state) { old, new in
            if new == .connected { WKInterfaceDevice.current().play(.success) }
            if old == .connected, new != .connected { WKInterfaceDevice.current().play(.failure) }
        }
    }
}

struct SpeedDial: View {
    let speedKPH: Double
    let maxKPH: Double
    let useMiles: Bool

    private let sweep = 0.75            // 270° of the circle, open at the bottom
    private static let ramp = Gradient(stops: [
        .init(color: Color(red: 0.24, green: 0.86, blue: 0.52), location: 0),
        .init(color: Color(red: 0.31, green: 0.88, blue: 0.48), location: Dial.goodUpTo),
        .init(color: Color(red: 1.0, green: 0.82, blue: 0.25), location: 0.65),
        .init(color: Color(red: 1.0, green: 0.48, blue: 0.16), location: 0.85),
        .init(color: Color(red: 1.0, green: 0.23, blue: 0.19), location: 1),
    ])

    var body: some View {
        let fraction = Dial.fraction(speedKPH: speedKPH, maxKPH: maxKPH)
        let zone = Dial.zone(fraction: fraction)
        ZStack {
            Circle()
                .trim(from: 0, to: sweep)
                .stroke(Color.white.opacity(0.12), style: StrokeStyle(lineWidth: 11, lineCap: .butt))
                .rotationEffect(.degrees(135))
            Circle()
                .trim(from: 0, to: sweep * fraction)
                .stroke(AngularGradient(gradient: Self.ramp, center: .center,
                                        startAngle: .degrees(0), endAngle: .degrees(360 * sweep)),
                        style: StrokeStyle(lineWidth: 11, lineCap: .butt))
                .rotationEffect(.degrees(135))
                .animation(.easeOut(duration: 0.35), value: fraction)
            // Segment cuts, like the web app's dial.
            Circle()
                .trim(from: 0, to: sweep)
                .stroke(Color.black, style: StrokeStyle(lineWidth: 13, lineCap: .butt, dash: [1.5, 6]))
                .rotationEffect(.degrees(135))
            VStack(spacing: -2) {
                Text("\(Int(Dial.display(kph: speedKPH, miles: useMiles).rounded()))")
                    .font(.system(size: 48, weight: .heavy, design: .rounded))
                    .italic()
                    .monospacedDigit()
                    .foregroundStyle(LinearGradient(colors: [.white, Color(red: 1, green: 0.8, blue: 0.43)],
                                                    startPoint: .top, endPoint: .bottom))
                Text(useMiles ? "MPH" : "KM/H")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.secondary)
                    .tracking(2)
                Text(zone.label.uppercased())
                    .font(.system(size: 10, weight: .heavy))
                    .italic()
                    .tracking(1.5)
                    .foregroundStyle(zoneColor(zone))
                    .frame(height: 12)
            }
        }
        .padding(8)
        .aspectRatio(1, contentMode: .fit)
    }

    private func zoneColor(_ z: EfficiencyZone) -> Color {
        switch z {
        case .idle: return .clear
        case .good: return Color(red: 0.31, green: 0.88, blue: 0.48)
        case .fair: return Color(red: 1.0, green: 0.82, blue: 0.25)
        case .poor: return Color(red: 1.0, green: 0.35, blue: 0.24)
        }
    }
}

struct BatteryBar: View {
    let soc: Int?

    var body: some View {
        HStack(spacing: 6) {
            HStack(spacing: 2) {
                ForEach(0..<10, id: \.self) { i in
                    let lit = (soc ?? 0) > i * 10
                    Rectangle()
                        .fill(lit ? (soc ?? 0) <= 20 ? Color.red : Color.orange : Color.white.opacity(0.15))
                        .frame(height: 8)
                }
            }
            Text(soc.map { "\($0)%" } ?? "–")
                .font(.system(size: 15, weight: .heavy, design: .rounded))
                .italic()
                .monospacedDigit()
                .foregroundStyle(.orange)
        }
    }
}

struct ConnectRow: View {
    @EnvironmentObject var link: ScooterLink

    var body: some View {
        if let keys = KeyVault.load() {
            VStack(spacing: 2) {
                if link.state == .scanning || link.state == .connecting {
                    ProgressView().frame(height: 18)
                } else {
                    Button("Connect") { link.connect(keys: keys) }
                        .tint(.orange)
                }
                Text(link.state.label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            }
        } else {
            Text("Add your scooter keys in Settings (swipe up twice).")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }
}
