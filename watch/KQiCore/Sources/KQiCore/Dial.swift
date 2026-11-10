// Dial.swift — the speed dial's scale and efficiency zones, the same rules as the web app.
// Energy per km rises steeply with speed, so the low end of the dial is the efficient end.
// This is an estimate from speed alone; the scooter's live current isn't decoded yet.

import Foundation

public enum EfficiencyZone: String {
    case idle, good, fair, poor

    public var label: String {
        switch self {
        case .idle: return ""
        case .good: return "Efficient"
        case .fair: return "Moderate"
        case .poor: return "High drain"
        }
    }
}

public enum Dial {
    public static let goodUpTo = 0.45
    public static let fairUpTo = 0.70

    /// Top of the dial in km/h: 10% above the scooter's own limit (30 km/h on a KQi 200F).
    public static func maxKPH(scooterLimitKPH: Double?) -> Double {
        guard let m = scooterLimitKPH, m > 0 else { return 32 }
        return max(10, (m * 1.1).rounded(.up))
    }

    /// 0...1 position on the dial.
    public static func fraction(speedKPH: Double, maxKPH: Double) -> Double {
        guard maxKPH > 0 else { return 0 }
        return min(1, max(0, speedKPH / maxKPH))
    }

    public static func zone(fraction: Double) -> EfficiencyZone {
        if fraction <= 0.02 { return .idle }
        if fraction <= goodUpTo { return .good }
        if fraction <= fairUpTo { return .fair }
        return .poor
    }

    public static func display(kph: Double, miles: Bool) -> Double { miles ? kph * 0.621371 : kph }
}
