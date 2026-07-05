import Foundation
import FluidAudio

// heckle-stt: local speech-to-text using FluidAudio's on-device Parakeet model, reusing
// the model already on this machine (no re-download).
//
//   heckle-stt <audio.wav>      one-shot: print the transcript and exit
//   heckle-stt --serve          persistent worker: load the model once, print "READY",
//                               then read one audio-file path per line from stdin and
//                               print one transcript line per path to stdout. This keeps
//                               the model warm so each transcription is ~1s, not ~14s.

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

let out = FileHandle.standardOutput
func emit(_ s: String) {
    out.write((s + "\n").data(using: .utf8)!) // unbuffered, so the daemon reads it immediately
}

let args = CommandLine.arguments
let serve = args.contains("--serve")

do {
    // Loads from ~/Library/Application Support/FluidAudio/Models when already present.
    let models = try await AsrModels.downloadAndLoad(version: .v3)
    let asr = AsrManager(config: .default)
    try await asr.loadModels(models)

    func transcribe(_ path: String) async -> String {
        do {
            var state = try TdtDecoderState()
            let result = try await asr.transcribe(URL(fileURLWithPath: path), decoderState: &state)
            return result.text.replacingOccurrences(of: "\n", with: " ")
        } catch {
            FileHandle.standardError.write("stt error: \(error)\n".data(using: .utf8)!)
            return ""
        }
    }

    if serve {
        emit("READY")
        while let line = readLine(strippingNewline: true) {
            let path = line.trimmingCharacters(in: .whitespaces)
            if path.isEmpty { continue }
            let text = await transcribe(path)
            emit(text)
        }
    } else {
        guard args.count >= 2 else { fail("usage: heckle-stt <audio.wav> | heckle-stt --serve", 2) }
        emit(await transcribe(args[1]))
    }
} catch {
    fail("stt init error: \(error)", 1)
}
