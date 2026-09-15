// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DroidexCore",
    platforms: [.iOS("27.0"), .macOS(.v14)],
    products: [.library(name: "DroidexCore", targets: ["DroidexCore"])],
    targets: [
        .target(name: "DroidexCore"),
        .testTarget(name: "DroidexCoreTests", dependencies: ["DroidexCore"], resources: [.copy("Fixtures")])
    ]
)
