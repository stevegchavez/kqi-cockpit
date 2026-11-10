// swift-tools-version:5.9
// KQiCore: the NIU KQi Bluetooth protocol for the watch app, kept free of UI and Bluetooth code
// so it can be tested on a Mac with `swift test` against the same vectors as the web app.
import PackageDescription

let package = Package(
    name: "KQiCore",
    platforms: [.watchOS(.v10), .iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "KQiCore", targets: ["KQiCore"]),
    ],
    targets: [
        .target(name: "KQiCore"),
        .testTarget(name: "KQiCoreTests", dependencies: ["KQiCore"]),
    ]
)
