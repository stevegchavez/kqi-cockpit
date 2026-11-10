// RideRecorder.swift — a ride is recorded as an outdoor cycling workout. That keeps the app
// running with the wrist down (so the scooter link stays up), records the GPS route and heart
// rate, and saves the ride to Apple Health on the watch.

import Foundation
import HealthKit
import CoreLocation

struct RideSummary: Equatable {
    let start: Date
    let duration: TimeInterval
    let distanceMeters: Double
    let topSpeedKPH: Double
    let startSOC: Int?
    let endSOC: Int?
}

@MainActor
final class RideRecorder: NSObject, ObservableObject {
    @Published private(set) var isRiding = false
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var distanceMeters: Double = 0
    @Published private(set) var heartRate: Double?
    @Published private(set) var topSpeedKPH: Double = 0
    @Published private(set) var lastRide: RideSummary?
    @Published var lastError: String?

    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var routeBuilder: HKWorkoutRouteBuilder?
    private let location = CLLocationManager()
    private var startDate: Date?
    private var startSOC: Int?
    private var timer: Timer?
    private var healthMeters: Double = 0          // from HealthKit's own cycling distance
    private var gpsMeters: Double = 0             // fallback: summed from GPS fixes
    private var lastFix: CLLocation?

    override init() {
        super.init()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        location.activityType = .otherNavigation
    }

    func start(batterySOC: Int?) async {
        guard !isRiding else { return }
        lastError = nil
        guard HKHealthStore.isHealthDataAvailable() else { lastError = "Health isn't available on this watch."; return }
        let share: Set<HKSampleType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute(),
                                        HKQuantityType(.distanceCycling), HKQuantityType(.activeEnergyBurned)]
        let read: Set<HKObjectType> = [HKQuantityType(.heartRate), HKQuantityType(.distanceCycling), HKQuantityType(.activeEnergyBurned)]
        do {
            try await store.requestAuthorization(toShare: share, read: read)
        } catch {
            lastError = "Health access is needed to record rides."
            return
        }
        let config = HKWorkoutConfiguration()
        config.activityType = .cycling
        config.locationType = .outdoor
        do {
            let s = try HKWorkoutSession(healthStore: store, configuration: config)
            let b = s.associatedWorkoutBuilder()
            b.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
            s.delegate = self
            b.delegate = self
            session = s
            builder = b
            routeBuilder = HKWorkoutRouteBuilder(healthStore: store, device: nil)
            let now = Date()
            startDate = now
            startSOC = batterySOC
            elapsed = 0; distanceMeters = 0; healthMeters = 0; gpsMeters = 0; topSpeedKPH = 0; heartRate = nil; lastFix = nil
            s.startActivity(with: now)
            try await b.beginCollection(at: now)
            location.requestWhenInUseAuthorization()
            location.startUpdatingLocation()
            isRiding = true
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        } catch {
            lastError = "Couldn't start the ride: \(error.localizedDescription)"
            session = nil
            builder = nil
            routeBuilder = nil
        }
    }

    func stop(batterySOC: Int?) async {
        guard isRiding, let s = session, let b = builder else { return }
        timer?.invalidate()
        timer = nil
        location.stopUpdatingLocation()
        isRiding = false
        s.end()
        let end = Date()
        do {
            try await b.endCollection(at: end)
            if let workout = try await b.finishWorkout(), let rb = routeBuilder {
                _ = try? await rb.finishRoute(with: workout, metadata: nil)
            }
        } catch {
            lastError = "The ride ended but couldn't be saved to Health: \(error.localizedDescription)"
        }
        if let start = startDate {
            lastRide = RideSummary(start: start, duration: end.timeIntervalSince(start), distanceMeters: distanceMeters,
                                   topSpeedKPH: topSpeedKPH, startSOC: startSOC, endSOC: batterySOC)
        }
        session = nil
        builder = nil
        routeBuilder = nil
    }

    /// The scooter's own speed reading, used for the ride's top speed.
    func noteSpeed(kph: Double) {
        if isRiding && kph > topSpeedKPH { topSpeedKPH = kph }
    }

    private func tick() {
        if let start = startDate, isRiding { elapsed = Date().timeIntervalSince(start) }
    }

    fileprivate func updateDistance(health: Double?, heartRate hr: Double?) {
        if let health { healthMeters = health }
        if let hr { heartRate = hr }
        distanceMeters = max(healthMeters, gpsMeters)
    }

    fileprivate func add(_ fixes: [CLLocation]) {
        guard isRiding else { return }
        let good = fixes.filter { $0.horizontalAccuracy >= 0 && $0.horizontalAccuracy <= 30 }
        guard !good.isEmpty else { return }
        for f in good {
            if let last = lastFix { gpsMeters += f.distance(from: last) }
            lastFix = f
        }
        distanceMeters = max(healthMeters, gpsMeters)
        if let rb = routeBuilder {
            Task { try? await rb.insertRouteData(good) }
        }
    }
}

extension RideRecorder: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
                                    from fromState: HKWorkoutSessionState, date: Date) {}

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        let message = error.localizedDescription
        Task { @MainActor in self.lastError = "Workout error: \(message)" }
    }
}

extension RideRecorder: HKLiveWorkoutBuilderDelegate {
    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    nonisolated func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        let meters = workoutBuilder.statistics(for: HKQuantityType(.distanceCycling))?.sumQuantity()?.doubleValue(for: .meter())
        let bpm = workoutBuilder.statistics(for: HKQuantityType(.heartRate))?.mostRecentQuantity()?
            .doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
        Task { @MainActor in self.updateDistance(health: meters, heartRate: bpm) }
    }
}

extension RideRecorder: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in self.add(locations) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
