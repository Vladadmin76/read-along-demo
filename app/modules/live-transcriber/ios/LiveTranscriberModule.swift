import AVFoundation
import ExpoModulesCore
import Speech

// Continuous on-device transcription with Apple's SpeechAnalyzer + SpeechTranscriber (iOS 26+).
// One AVAudioEngine tap feeds the analyzer for the whole reading session, so there are no
// restarts between phrases (the old SFSpeechRecognizer stops after every pause).
public class LiveTranscriberModule: Module {
  private var session: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("LiveTranscriber")

    Events("onResult", "onState", "onError")

    Function("isAvailable") { () -> Bool in
      if #available(iOS 26.0, *) {
        return SpeechTranscriber.isAvailable
      }
      return false
    }

    AsyncFunction("start") { (localeId: String) async throws in
      guard #available(iOS 26.0, *) else {
        throw Exception(name: "Unavailable", description: "SpeechAnalyzer needs iOS 26 or newer")
      }
      if let old = self.session as? LiveSession { await old.stop() }
      let s = LiveSession(module: self)
      self.session = s
      try await s.start(localeId: localeId)
    }

    AsyncFunction("stop") { () async in
      if #available(iOS 26.0, *), let s = self.session as? LiveSession {
        await s.stop()
      }
      self.session = nil
    }

    OnDestroy {
      if #available(iOS 26.0, *), let s = self.session as? LiveSession {
        Task { await s.stop() }
      }
    }
  }
}

@available(iOS 26.0, *)
final class LiveSession {
  private weak var module: LiveTranscriberModule?
  private let engine = AVAudioEngine()
  private var analyzer: SpeechAnalyzer?
  private var transcriber: SpeechTranscriber?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var resultsTask: Task<Void, Never>?
  private var converter: AVAudioConverter?
  private var analyzerFormat: AVAudioFormat?
  private var finalized = ""
  private let lock = NSLock()

  init(module: LiveTranscriberModule) {
    self.module = module
  }

  private func emit(_ name: String, _ body: [String: Any]) {
    module?.sendEvent(name, body)
  }

  func start(localeId: String) async throws {
    let locale = Locale(identifier: localeId)
    let supported = await SpeechTranscriber.supportedLocales
    guard supported.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else {
      throw Exception(name: "Locale", description: "English speech model is not supported on this device")
    }

    let t = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [.volatileResults],
      attributeOptions: []
    )
    transcriber = t

    // The on-device model is downloaded once by the system.
    let installed = await SpeechTranscriber.installedLocales
    if !installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
      emit("onState", ["state": "downloading-model"])
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
        try await request.downloadAndInstall()
      }
    }

    let a = SpeechAnalyzer(modules: [t])
    analyzer = a
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [t]) else {
      throw Exception(name: "Format", description: "No audio format for the speech model")
    }
    analyzerFormat = format

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    input = continuation

    resultsTask = Task { [weak self] in
      do {
        for try await r in t.results {
          guard let self = self else { return }
          let text = String(r.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
          if r.isFinal {
            if !text.isEmpty {
              self.finalized = self.finalized.isEmpty ? text : self.finalized + " " + text
            }
            self.emit("onResult", ["text": self.finalized, "finalizedText": self.finalized, "isFinal": true])
          } else {
            let all = text.isEmpty ? self.finalized : (self.finalized.isEmpty ? text : self.finalized + " " + text)
            self.emit("onResult", ["text": all, "finalizedText": self.finalized, "isFinal": false])
          }
        }
      } catch {
        self?.emit("onError", ["message": error.localizedDescription])
      }
    }

    try await a.start(inputSequence: stream)

    // Play-and-record session so the cartoon and the "bam" sound never take the microphone away.
    let audio = AVAudioSession.sharedInstance()
    try audio.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .mixWithOthers])
    try audio.setActive(true)

    let node = engine.inputNode
    let micFormat = node.outputFormat(forBus: 0)
    converter = AVAudioConverter(from: micFormat, to: format)
    node.removeTap(onBus: 0)
    node.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { [weak self] buffer, _ in
      self?.feed(buffer)
    }
    engine.prepare()
    try engine.start()
    emit("onState", ["state": "listening"])
  }

  private func feed(_ buffer: AVAudioPCMBuffer) {
    guard let converter = converter, let format = analyzerFormat else { return }
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
    var given = false
    var error: NSError?
    lock.lock()
    converter.convert(to: out, error: &error) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return buffer
    }
    lock.unlock()
    if error == nil && out.frameLength > 0 {
      input?.yield(AnalyzerInput(buffer: out))
    }
  }

  func stop() async {
    engine.inputNode.removeTap(onBus: 0)
    if engine.isRunning { engine.stop() }
    input?.finish()
    input = nil
    try? await analyzer?.finalizeAndFinishThroughEndOfInput()
    resultsTask?.cancel()
    resultsTask = nil
    analyzer = nil
    emit("onState", ["state": "stopped"])
  }
}
