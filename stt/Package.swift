// swift-tools-version:6.0
import PackageDescription

// heckle-stt: a tiny CLI that transcribes an audio file with FluidAudio's on-device
// Parakeet model. It reuses the model already on this machine
// (~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3), so nothing
// is re-downloaded. The Heckle daemon shells out to this for local voice.
let package = Package(
    name: "heckle-stt",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Pinned exact for supply-chain cooldown (v0.15.4 was <15 days old at build time).
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.15.3")
    ],
    targets: [
        .executableTarget(
            name: "heckle-stt",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
