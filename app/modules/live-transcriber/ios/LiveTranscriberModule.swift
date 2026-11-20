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

    AsyncFunction("start") { (localeId: String, engineName: String) async throws in
      guard #available(iOS 26.0, *) else {
        throw Exception(name: "Unavailable", description: "SpeechAnalyzer needs iOS 26 or newer")
      }
      if let old = self.session as? LiveSession { await old.stop() }
      let s = LiveSession(module: self)
      self.session = s
      try await s.start(localeId: localeId, dictation: engineName == "dictation")
    }

    // Hints with the words of the sentence being read (works with the Dictation engine only).
    AsyncFunction("setContext") { (words: [String]) async in
      if #available(iOS 26.0, *), let s = self.session as? LiveSession {
        await s.setContext(words)
      }
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
  private var isDictation = false
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var resultsTask: Task<Void, Never>?
  private var converter: AVAudioConverter?
  private var analyzerFormat: AVAudioFormat?
  private var finalized = ""
  private let lock = NSLock()
  private var t0 = Date()
  private var loggedBuffer = false

  init(module: LiveTranscriberModule) {
    self.module = module
  }

  private func emit(_ name: String, _ body: [String: Any]) {
    module?.sendEvent(name, body)
  }

  private func handle(text raw: String, isFinal: Bool) {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    NSLog("[LiveTranscriber] result t=%.2fs final=%@ len=%d", Date().timeIntervalSince(t0), isFinal ? "Y" : "N", text.count)
    if isFinal {
      if !text.isEmpty {
        finalized = finalized.isEmpty ? text : finalized + " " + text
      }
      emit("onResult", ["text": finalized, "finalizedText": finalized, "isFinal": true])
    } else {
      let all = text.isEmpty ? finalized : (finalized.isEmpty ? text : finalized + " " + text)
      emit("onResult", ["text": all, "finalizedText": finalized, "isFinal": false])
    }
  }

  // Word hints for the Dictation engine (SpeechTranscriber ignores them).
  func setContext(_ words: [String]) async {
    guard isDictation, let a = analyzer else { return }
    let ctx = AnalysisContext()
    ctx.contextualStrings[.general] = words
    do {
      try await a.setContext(ctx)
      NSLog("[LiveTranscriber] setContext %d words", words.count)
    } catch {
      NSLog("[LiveTranscriber] setContext failed: %@", error.localizedDescription)
    }
  }

  func start(localeId: String, dictation: Bool) async throws {
    isDictation = dictation
    let locale = Locale(identifier: localeId)
    let supported = dictation ? await DictationTranscriber.supportedLocales : await SpeechTranscriber.supportedLocales
    guard supported.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else {
      throw Exception(name: "Locale", description: "English speech model is not supported on this device")
    }
    NSLog("[LiveTranscriber] engine=%@", dictation ? "dictation" : "speechtranscriber")

    let speechModule: any SpeechModule
    let resultsLoop: () async throws -> Void
    if dictation {
      let d = DictationTranscriber(
        locale: locale,
        contentHints: [],
        transcriptionOptions: [],
        // frequentFinalization: the engine confirms text sooner, so crosses can come earlier
        reportingOptions: [.volatileResults, .frequentFinalization],
        attributeOptions: []
      )
      speechModule = d
      resultsLoop = { [weak self] in
        for try await r in d.results { self?.handle(text: String(r.text.characters), isFinal: r.isFinal) }
      }
    } else {
      let t = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],
        attributeOptions: []
      )
      speechModule = t
      resultsLoop = { [weak self] in
        for try await r in t.results { self?.handle(text: String(r.text.characters), isFinal: r.isFinal) }
      }
    }

    // The on-device model is downloaded once by the system.
    let installed = dictation ? await DictationTranscriber.installedLocales : await SpeechTranscriber.installedLocales
    if !installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
      emit("onState", ["state": "downloading-model"])
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [speechModule]) {
        try await request.downloadAndInstall()
      }
    }

    let a = SpeechAnalyzer(modules: [speechModule])
    analyzer = a
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [speechModule]) else {
      throw Exception(name: "Format", description: "No audio format for the speech model")
    }
    analyzerFormat = format

    // Warm up the model before the first audio arrives (cuts the delay before the first word).
    try await a.prepareToAnalyze(in: format)
    t0 = Date()

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    input = continuation

    resultsTask = Task { [weak self] in
      do {
        try await resultsLoop()
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
    // Small buffer (~20-40 ms): iOS may deliver larger ones, so the real size is logged below.
    node.installTap(onBus: 0, bufferSize: 1024, format: micFormat) { [weak self] buffer, _ in
      guard let self = self else { return }
      if !self.loggedBuffer {
        self.loggedBuffer = true
        NSLog("[LiveTranscriber] first tap buffer frames=%d rate=%.0f", buffer.frameLength, buffer.format.sampleRate)
      }
      self.feed(buffer)
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
