import CryptoKit
import Foundation
import Security
#if canImport(UIKit)
  import UIKit
#endif

private let cliPinsPlistKey = "CordieriteCliPins"
private let allowPrivateLanOnlyPlistKey = "CordieriteAllowPrivateLanOnly"
private let protocolVersion = 2

enum CordieriteConnectionState: String {
  case idle
  case connecting
  case active
  case closed
  case error
}

private struct CordieriteModuleError: Error {
  let message: String
}

struct CordieriteErrorDetails: Sendable {
  let code: String
  let message: String
  let phase: String
  let nativeCode: String?
  let closeReason: String?
  let isRetryable: Bool?
  let hint: String?
}

/// RCT/JSI often passes numeric fields as `NSNumber`; accept both `Int` and `NSNumber`.
private func cordieriteIntFromBridge(_ value: Any?) -> Int? {
  switch value {
  case let int as Int:
    return int
  case let number as NSNumber:
    return number.intValue
  default:
    return nil
  }
}

/// Sendable by construction (every field is a value type): parsed synchronously in
/// `CordieriteTurboBridge` from the loosely-typed JS options bag before it ever crosses onto the
/// actor, so `connect(options:)` never has to send a non-`Sendable` `[String: Any]`/`NSDictionary`
/// across an isolation boundary.
struct CordieriteConnectOptions: Sendable {
  let ip: String
  let port: Int
  let sessionId: String
  /// Claim token. Required unless `resumeToken` is present (protocol v2 `session_resume`).
  let token: String?
  /// When present, `connect` sends `session_resume` as the first frame instead of `session_claim`.
  let resumeToken: String?
  let expiresAt: Int
  let deviceManufacturer: String?
  let deviceModel: String?
  let deviceOs: String?
  /// Opt-in hardening dev-mode: the bootstrap deep link's separate `pin` query param, forwarded
  /// unchanged from JS (`CordieriteConnectOptions.linkPin` in `Cordierite.types.ts`). Only ever
  /// consulted by `resolveTrustedPins` when no build-time `cliPins` are configured, and even then
  /// only in a debug build — see `configureFromBundle`.
  let linkPin: String?

  init(_ value: [String: Any]) throws {
    // NOTE: intentionally not actor-isolated — called synchronously from the TurboModule bridge
    // before any actor hop, so parsing failures reject the JS promise immediately.
    guard
      let ip = value["ip"] as? String,
      let port = cordieriteIntFromBridge(value["port"]),
      let sessionId = value["sessionId"] as? String,
      let expiresAt = cordieriteIntFromBridge(value["expiresAt"])
    else {
      throw CordieriteModuleError(message: "Invalid Cordierite connect options.")
    }

    self.ip = ip
    self.port = port
    self.sessionId = sessionId
    self.expiresAt = expiresAt

    func optionalString(_ key: String) -> String? {
      guard let s = value[key] as? String else {
        return nil
      }
      let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }

    self.token = optionalString("token")
    self.resumeToken = optionalString("resumeToken")

    guard self.token != nil || self.resumeToken != nil else {
      throw CordieriteModuleError(message: "Cordierite connect requires either token or resumeToken.")
    }

    self.deviceManufacturer = optionalString("deviceManufacturer")
    self.deviceModel = optionalString("deviceModel")
    self.deviceOs = optionalString("deviceOs")
    self.linkPin = optionalString("linkPin")
  }
}

/// Outcome of `resolveTrustedPins` (opt-in hardening dev-mode pin trust).
enum CordieriteTrustedPinsResolution: Equatable {
  /// Build-time `cliPins` are configured; `linkPin` is irrelevant and never even inspected once
  /// this case applies — embedded pins always win, they never merge with a `linkPin`.
  case configured(Set<String>)
  /// No build-time `cliPins`, but a debug build with a usable `linkPin`: trust that single pin
  /// for this connection only. Callers must log the loud dev-mode warning when they see this case.
  case devModeLinkPin(String)
  /// No build-time `cliPins`, and either not a debug build or no usable `linkPin`: the existing
  /// hard-error behavior from before opt-in hardening.
  case missing
}

/// Pure decision logic for opt-in hardening dev-mode (design doc part A): given the build-time
/// `cliPins` read from Info.plist and the connect options' `linkPin` (from the bootstrap deep
/// link's separate `pin` query param, if any), decides which SPKI pin(s) this connection trusts.
/// Factored out of `configureFromBundle` (which reads `Bundle.main`) so the decision matrix is
/// unit-testable without an Info.plist fixture.
///
/// `bundlePins` always wins when non-empty — `linkPin` never widens the trust set, it only ever
/// fills in for a *missing* embedded pin, and only in a debug build. A release build with no
/// `cliPins` configured returns `.missing` regardless of `linkPin`, preserving the pre-existing
/// hard-fail (release builds without pins keep today's hard error).
func resolveTrustedPins(
  bundlePins: [String],
  linkPin: String?,
  isDebugBuild: Bool
) -> CordieriteTrustedPinsResolution {
  if !bundlePins.isEmpty {
    return .configured(Set(bundlePins))
  }

  if isDebugBuild, let linkPin, !linkPin.isEmpty {
    return .devModeLinkPin(linkPin)
  }

  return .missing
}

private struct DefaultSessionClaimDeviceFields {
  let manufacturer: String
  let model: String
  let os: String
}

/// `UIDevice` properties are `@MainActor`-isolated; this is only ever called from `connect()`,
/// which can freely `await` onto the main actor for this one-shot, non-blocking read.
@MainActor
private func defaultAppleSessionClaimDeviceFields() -> DefaultSessionClaimDeviceFields {
  #if canImport(UIKit)
  let device = UIDevice.current
  let os = "\(device.systemName) \(device.systemVersion)"
  return DefaultSessionClaimDeviceFields(
    manufacturer: "Apple",
    model: defaultAppleDeviceModelLabel(device: device),
    os: os,
  )
  #else
  return DefaultSessionClaimDeviceFields(
    manufacturer: "Apple",
    model: "Unknown Apple device",
    os: ProcessInfo.processInfo.operatingSystemVersionString,
  )
  #endif
}

#if canImport(UIKit)
@MainActor
private func defaultAppleDeviceModelLabel(device: UIDevice) -> String {
  #if os(visionOS)
    return "Apple Vision"
  #else
    switch device.userInterfaceIdiom {
    case .phone:
      return "iPhone"
    case .pad:
      return "iPad"
    case .tv:
      return "Apple TV"
    case .mac:
      return "Mac"
    case .carPlay, .vision, .unspecified:
      return device.model
    @unknown default:
      return device.model
    }
  #endif
}
#endif

private func mergeSessionClaimDeviceFields(
  options: CordieriteConnectOptions,
  defaults: DefaultSessionClaimDeviceFields,
) -> DefaultSessionClaimDeviceFields {
  DefaultSessionClaimDeviceFields(
    manufacturer: options.deviceManufacturer ?? defaults.manufacturer,
    model: options.deviceModel ?? defaults.model,
    os: options.deviceOs ?? defaults.os,
  )
}

/// All connection state is actor-isolated: every mutation and read goes through this actor's
/// serial executor, so two rapid `connect()` calls, delegate callbacks arriving on URLSession's
/// delegate queue, and JS-thread calls can never race. Actors may inherit from `NSObject`
/// (and only from `NSObject`) specifically so they can satisfy `@objc` delegate protocols like
/// `URLSessionWebSocketDelegate`; the delegate methods below are `nonisolated` (URLSession calls
/// them synchronously from its own queue) and hop back onto the actor via `Task` before touching
/// any state.
actor CordieriteConnectionManager: NSObject, URLSessionDelegate, URLSessionWebSocketDelegate {
  /// Event callbacks are wired once, synchronously, immediately after construction (see
  /// `CordieriteTurboBridge.wireEventHandlers`) and before any JS call can reach `connect`.
  /// `nonisolated(unsafe)` lets the bridge assign them from outside the actor without an `await`,
  /// matching the existing synchronous wiring contract; `invalidate()` clears them so a
  /// straggling delegate callback can never call back into a torn-down bridge.
  nonisolated(unsafe) var emitStateChange: ((String) -> Void)?
  /// Turbo path: only the raw JSON string; JS parses `message`.
  nonisolated(unsafe) var emitMessageRaw: ((String) -> Void)?
  nonisolated(unsafe) var emitError: ((CordieriteErrorDetails) -> Void)?
  nonisolated(unsafe) var emitClose: ((NSDictionary) -> Void)?

  private(set) var state: CordieriteConnectionState = .idle {
    didSet {
      stateSnapshot = state.rawValue
      if !isInvalidated {
        emitStateChange?(state.rawValue)
      }
    }
  }

  /// Mirrors `state.rawValue` so `getState()` (a synchronous TurboModule method) can be answered
  /// without hopping onto the actor. Written only from within actor-isolated code, immediately
  /// after `state` changes, so it is never stale by more than the time it takes to observe it —
  /// in particular it is never `"active"` once a teardown path has run.
  nonisolated(unsafe) private(set) var stateSnapshot = CordieriteConnectionState.idle.rawValue

  private var session: URLSession?
  private var socketTask: URLSessionWebSocketTask?
  private var activeSessionId: String?
  private var pendingOptions: CordieriteConnectOptions?
  nonisolated private let ownerGeneration: Int64
  private var isInvalidated = false
  /// Written once per `connect()` (inside `configureFromBundle`, before the socket exists) and
  /// read from the `nonisolated` TLS challenge delegate callback, which must respond
  /// synchronously and therefore cannot hop onto the actor. Never mutated concurrently with a
  /// read: no challenge can arrive before `configureFromBundle` has run.
  nonisolated(unsafe) private var configuredPins: Set<String> = []
  private var allowPrivateLanOnly = true
  private var closeEventPending = false
  private var lastErrorDetails: CordieriteErrorDetails?
  private var keepaliveTask: Task<Void, Never>?
  private var pingFailureCount = 0

  override init() {
    ownerGeneration = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    super.init()
  }

  init(ownerGeneration: Int64, activeSessionId: String? = nil) {
    self.ownerGeneration = ownerGeneration
    self.activeSessionId = activeSessionId
    super.init()
  }

  /// `linkPin` comes from the connect options (the bootstrap deep link's `pin` param, if any) —
  /// see `resolveTrustedPins` for the trust decision itself. `#if DEBUG` reflects the *Cordierite
  /// pod's own* compilation condition, which the app's Debug configuration propagates down to it
  /// (verified against the playground's checked-in `Pods.xcodeproj`: CocoaPods' project-level
  /// default Debug config sets `SWIFT_ACTIVE_COMPILATION_CONDITIONS = $(inherited) DEBUG`, which
  /// the pod's own target-level config inherits since it only ever adds `$(inherited)` itself).
  func configureFromBundle(linkPin: String?) throws {
    let info = Bundle.main.infoDictionary ?? [:]
    let pins = info[cliPinsPlistKey] as? [String] ?? []

    #if DEBUG
    let isDebugBuild = true
    #else
    let isDebugBuild = false
    #endif

    switch resolveTrustedPins(bundlePins: pins, linkPin: linkPin, isDebugBuild: isDebugBuild) {
    case .configured(let trustedPins):
      configuredPins = trustedPins
    case .devModeLinkPin(let pin):
      // Loud and unconditional (not gated behind any log level): a developer relying on this path
      // must not be able to miss it, since it is strictly weaker than a real embedded pin.
      NSLog("Cordierite: trusting pin from bootstrap link (dev mode). Release builds require embedded cliPins.")
      configuredPins = [pin]
    case .missing:
      throw CordieriteModuleError(message: "Cordierite CLI pins are not configured in Info.plist.")
    }

    // Fail closed: absent the plist key, only local/LAN addresses are allowed.
    allowPrivateLanOnly = info[allowPrivateLanOnlyPlistKey] as? Bool ?? true
  }

  func connect(options: CordieriteConnectOptions) async throws {
    guard !isInvalidated else {
      throw CordieriteModuleError(message: "Cordierite native module has been invalidated.")
    }

    if state == .connecting || state == .active {
      throw CordieriteModuleError(message: "A Cordierite session is already connecting or active.")
    }

    try configureFromBundle(linkPin: options.linkPin)

    let now = Int(Date().timeIntervalSince1970)

    if options.expiresAt <= now {
      throw CordieriteModuleError(message: "Cordierite bootstrap payload has expired.")
    }

    if allowPrivateLanOnly && !isLocalIpv4Address(options.ip) {
      throw CordieriteModuleError(message: "Cordierite only allows local IPv4 addresses.")
    }

    guard let url = URL(string: "wss://\(options.ip):\(options.port)") else {
      throw CordieriteModuleError(message: "Failed to create a Cordierite WebSocket URL.")
    }

    // Resume needs no claim token, so validate up front (still before any `await`) rather than
    // discovering a missing token only after the socket already exists.
    if options.resumeToken == nil && options.token == nil {
      throw CordieriteModuleError(message: "Cordierite connect requires a claim token.")
    }

    // Everything above this point, and everything through `state = .connecting` below, is
    // synchronous: two rapid `connect()` calls can only interleave at an `await`, and the first
    // `await` is `sendRawObject` at the very end — by which point `state` is already
    // `.connecting`, so a second call's guard at the top of this function deterministically
    // throws `already_connecting` instead of racing to create a second socket.
    cleanup()

    pendingOptions = options
    closeEventPending = true
    state = .connecting

    let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    let task = session.webSocketTask(with: url)

    self.session = session
    socketTask = task

    task.resume()
    receiveNextMessage()

    let firstFrame: [String: Any]

    if let resumeToken = options.resumeToken {
      firstFrame = [
        "type": "session_resume",
        "protocol_version": protocolVersion,
        "session_id": options.sessionId,
        "resume_token": resumeToken,
      ]
    } else {
      guard let token = options.token else {
        // Unreachable: validated above, before any `await`.
        throw CordieriteModuleError(message: "Cordierite connect requires a claim token.")
      }

      let device = mergeSessionClaimDeviceFields(options: options, defaults: await defaultAppleSessionClaimDeviceFields())
      firstFrame = [
        "type": "session_claim",
        "protocol_version": protocolVersion,
        "session_id": options.sessionId,
        "token": token,
        "device_manufacturer": device.manufacturer,
        "device_model": device.model,
        "device_os": device.os,
      ]
    }

    try await sendRawObject(firstFrame, requireActiveSession: false)
  }

  func send(message: String) async throws {
    guard state == .active, let activeSessionId else {
      throw CordieriteModuleError(message: "Cordierite session is not active.")
    }

    guard
      let data = message.data(using: .utf8),
      let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      throw CordieriteModuleError(message: "Outgoing Cordierite messages must be JSON objects.")
    }

    guard let sessionId = parsed["session_id"] as? String, sessionId == activeSessionId else {
      throw CordieriteModuleError(message: "Outgoing Cordierite message session_id does not match the active session.")
    }

    try await sendText(message)
  }

  func close() async {
    CordieriteProcessResumeLeaseStore.shared.clear(ownerGeneration: ownerGeneration)

    guard let socketTask else {
      cleanup()
      state = .closed
      emitClose?(NSDictionary())
      return
    }

    closeEventPending = true
    socketTask.cancel(with: .normalClosure, reason: nil)
  }

  /// TurboModule invalidation: called by React Native when the bridge is torn down (e.g. a Metro
  /// reload). Cancels the socket with close code 1001, invalidates the URLSession, clears all
  /// state, and drops the event callbacks so no straggling delegate callback can reach into a
  /// dead bridge. Deliberately synchronous within the actor turn (no awaited network round trip)
  /// so the socket is released promptly and the daemon observes the disconnect and suspends the
  /// session.
  func invalidate() {
    guard !isInvalidated else {
      return
    }

    isInvalidated = true
    markCurrentLeaseDisconnected(at: epochMilliseconds())
    closeEventPending = false
    socketTask?.cancel(with: .goingAway, reason: nil)
    cleanup()
    emitStateChange = nil
    emitMessageRaw = nil
    emitError = nil
    emitClose = nil
    state = .closed
  }

  /// Synchronous, non-isolated read of the current state for the TurboModule's `getState()`,
  /// which is a synchronous ObjC method and cannot `await` onto the actor.
  nonisolated func currentStateSnapshot() -> String {
    stateSnapshot
  }

  /// Synchronous TurboModule bridge wrappers; clear retains this manager's generation guard.
  nonisolated func currentResumeLeaseRecord() -> NSDictionary? {
    CordieriteProcessResumeLeaseStore.shared.getRecord().map { $0 as NSDictionary }
  }

  @discardableResult
  nonisolated func clearResumeLease() -> Bool {
    CordieriteProcessResumeLeaseStore.shared.clear(ownerGeneration: ownerGeneration)
  }

  private func cleanup() {
    keepaliveTask?.cancel()
    keepaliveTask = nil
    pingFailureCount = 0
    socketTask = nil
    session?.invalidateAndCancel()
    session = nil
    activeSessionId = nil
    pendingOptions = nil
    lastErrorDetails = nil
  }

  private func markCurrentLeaseDisconnected(at disconnectedAtMs: Int64) {
    let sessionId = activeSessionId ?? pendingOptions?.sessionId
    guard let sessionId else {
      return
    }
    CordieriteProcessResumeLeaseStore.shared.markDisconnected(
      ownerGeneration: ownerGeneration,
      sessionId: sessionId,
      disconnectedAtMs: disconnectedAtMs
    )
  }

  private func epochMilliseconds() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1_000)
  }

  private func cancelTransport(
    with closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    updateResumeLeaseForTransportTeardown(
      ownerGeneration: ownerGeneration,
      sessionId: activeSessionId ?? pendingOptions?.sessionId,
      closeCode: Int(closeCode.rawValue),
      disconnectedAtMs: epochMilliseconds()
    )
    socketTask?.cancel(with: closeCode, reason: reason)
  }

  private func publishError(_ details: CordieriteErrorDetails) {
    guard !isInvalidated else {
      return
    }
    lastErrorDetails = details
    emitError?(details)
  }

  private func sendRawObject(_ value: [String: Any], requireActiveSession: Bool) async throws {
    if requireActiveSession {
      guard state == .active else {
        throw CordieriteModuleError(message: "Cordierite session is not active.")
      }
    }

    let data = try JSONSerialization.data(withJSONObject: value)
    guard let text = String(data: data, encoding: .utf8) else {
      throw CordieriteModuleError(message: "Failed to serialize a Cordierite message.")
    }

    try await sendText(text)
  }

  private func sendText(_ text: String) async throws {
    guard let socketTask else {
      throw CordieriteModuleError(message: "Cordierite socket is not connected.")
    }

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      socketTask.send(.string(text)) { error in
        if let error {
          continuation.resume(throwing: error)
          return
        }

        continuation.resume()
      }
    }
  }

  private func receiveNextMessage() {
    guard let socketTask else {
      return
    }

    let expectedTask = socketTask

    Task { [weak self] in
      guard let self else {
        return
      }

      do {
        let message = try await expectedTask.receive()
        await self.handleReceivedMessage(message, from: expectedTask)
      } catch {
        await self.handleReceiveFailure(error, from: expectedTask)
      }
    }
  }

  private func handleReceivedMessage(_ message: URLSessionWebSocketTask.Message, from task: URLSessionWebSocketTask) async {
    guard !isInvalidated, task === socketTask else {
      // Stale read loop from a socket that has since been replaced or torn down.
      return
    }

    switch message {
    case .string(let text):
      await handleIncomingText(text)
      receiveNextMessage()
    case .data:
      state = .error
      publishError(
        CordieriteErrorDetails(
          code: "invalid_message",
          message: "Binary Cordierite messages are not supported.",
          phase: "transport",
          nativeCode: "binary_not_supported",
          closeReason: nil,
          isRetryable: false,
          hint: nil
        )
      )
      cancelTransport(with: .unsupportedData, reason: Data("binary_not_supported".utf8))
    @unknown default:
      state = .error
      publishError(
        CordieriteErrorDetails(
          code: "invalid_message",
          message: "Unsupported Cordierite WebSocket message received.",
          phase: "transport",
          nativeCode: "invalid_message",
          closeReason: nil,
          isRetryable: false,
          hint: nil
        )
      )
      cancelTransport(with: .policyViolation, reason: Data("invalid_message".utf8))
    }
  }

  private func handleReceiveFailure(_ error: Error, from task: URLSessionWebSocketTask) async {
    guard !isInvalidated, task === socketTask else {
      return
    }

    state = .error
    if lastErrorDetails == nil {
      publishError(
        classifyTransportFailure(
          code: "receive_failed",
          message: error.localizedDescription,
          closeReason: nil
        )
      )
    }
    cancelTransport(with: .abnormalClosure, reason: nil)
  }

  private func handleIncomingText(_ text: String) async {
    guard !isInvalidated else {
      return
    }

    guard
      let data = text.data(using: .utf8),
      let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      state = .error
      publishError(
        CordieriteErrorDetails(
          code: "invalid_message",
          message: "Incoming Cordierite message must be a JSON object.",
          phase: "transport",
          nativeCode: "invalid_message",
          closeReason: nil,
          isRetryable: false,
          hint: nil
        )
      )
      cancelTransport(with: .policyViolation, reason: Data("invalid_message".utf8))
      return
    }

    if state == .connecting {
      await handleSessionAck(parsed, rawText: text)
      return
    }

    guard
      let activeSessionId,
      let sessionId = parsed["session_id"] as? String,
      sessionId == activeSessionId
    else {
      state = .error
      publishError(
        CordieriteErrorDetails(
          code: "session_mismatch",
          message: "Incoming Cordierite message does not match the active session.",
          phase: "session",
          nativeCode: "session_mismatch",
          closeReason: nil,
          isRetryable: false,
          hint: nil
        )
      )
      cancelTransport(with: .policyViolation, reason: Data("session_mismatch".utf8))
      return
    }

    emitMessageRaw?(text)
  }

  private func handleSessionAck(_ message: [String: Any], rawText: String) async {
    guard let pendingOptions else {
      state = .error
      publishError(classifyHandshakeCloseReason(nil))
      cancelTransport(with: .policyViolation, reason: Data("invalid_ack".utf8))
      return
    }

    let result = commitSessionAck(
      message: message,
      rawText: rawText,
      options: pendingOptions,
      ownerGeneration: ownerGeneration,
      onAccepted: { lease in
        activeSessionId = lease.sessionId
        self.pendingOptions = nil
        state = .active
        scheduleKeepalive(intervalSeconds: lease.keepaliveIntervalS)
      },
      emitMessageRaw: { text in
        emitMessageRaw?(text)
      }
    )

    switch result {
    case .accepted:
      return
    case .stale:
      cancelTransport(with: .normalClosure, reason: Data("module_replaced".utf8))
    case .invalid:
      state = .error
      let closeReason = (message["reason"] as? String)?.isEmpty == false ? message["reason"] as? String : nil
      publishError(classifyHandshakeCloseReason(closeReason))
      cancelTransport(with: .policyViolation, reason: Data((closeReason ?? "invalid_ack").utf8))
    }
  }

  private func scheduleKeepalive(intervalSeconds: Double) {
    keepaliveTask?.cancel()
    pingFailureCount = 0

    let requestedNanoseconds = intervalSeconds * 1_000_000_000
    let nanoseconds = requestedNanoseconds >= Double(UInt64.max)
      ? UInt64.max
      : UInt64(max(1, requestedNanoseconds))

    keepaliveTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: nanoseconds)
        if Task.isCancelled {
          return
        }
        await self?.sendPing()
      }
    }
  }

  /// Sends a protocol-level WebSocket ping. Two consecutive failures are treated as transport
  /// death: the socket is cancelled, which drives the same `didCompleteWithError`/`didCloseWith`
  /// teardown path (and its single-close-event dedupe) as any other abrupt disconnect.
  private func sendPing() async {
    guard let socketTask, state == .active else {
      return
    }

    do {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        socketTask.sendPing { error in
          if let error {
            continuation.resume(throwing: error)
            return
          }

          continuation.resume()
        }
      }
      pingFailureCount = 0
    } catch {
      pingFailureCount += 1

      if pingFailureCount >= 2 {
        publishError(
          classifyTransportFailure(
            code: "keepalive_ping_failed",
            message: error.localizedDescription,
            closeReason: nil
          )
        )
        cancelTransport(with: .abnormalClosure, reason: nil)
      }
    }
  }

  private func isLocalIpv4Address(_ value: String) -> Bool {
    let parts = value.split(separator: ".")

    guard parts.count == 4 else {
      return false
    }

    let octets = parts.compactMap { Int($0) }

    guard octets.count == 4 else {
      return false
    }

    guard octets.allSatisfy({ (0...255).contains($0) }) else {
      return false
    }

    let first = octets[0]
    let second = octets[1]

    return first == 127 ||
      first == 10 ||
      (first == 172 && (16...31).contains(second)) ||
      (first == 192 && second == 168)
  }

  /// Deliberately `nonisolated` and fully synchronous (no `Task`/actor hop): `completionHandler`
  /// is not `@Sendable`-typed by the SDK, so it cannot cross into the actor, and the TLS
  /// handshake should not wait on an extra hop anyway. All the state this needs
  /// (`configuredPins`) is a `nonisolated(unsafe)` snapshot written before any socket exists;
  /// error reporting is dispatched separately via a fire-and-forget `Task` that only carries the
  /// `Sendable` `CordieriteErrorDetails`.
  nonisolated func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
      // Non-TLS-server-trust challenges (e.g. client certificate, HTTP auth) are not something
      // Cordierite pins against; defer to the platform's normal handling instead of failing the
      // connection with a bogus TLS error.
      completionHandler(.performDefaultHandling, nil)
      return
    }

    guard
      let trust = challenge.protectionSpace.serverTrust,
      let certificate = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = certificate.first
    else {
      reportError(
        CordieriteErrorDetails(
          code: "tls_handshake_failed",
          message: "Cordierite could not evaluate the host TLS certificate.",
          phase: "tls",
          nativeCode: "server_trust_unavailable",
          closeReason: nil,
          isRetryable: false,
          hint: "Check the host certificate and trusted pins."
        )
      )
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }

    do {
      let pin = try spkiPin(for: leaf)

      guard configuredPins.contains(pin) else {
        reportError(
          CordieriteErrorDetails(
            code: "pin_mismatch",
            message: "Cordierite host certificate pin mismatch.",
            phase: "tls",
            nativeCode: "pin_mismatch",
            closeReason: nil,
            isRetryable: false,
            hint: "Verify cliPins matches the fingerprint from cordierite keygen and rebuild the native app."
          )
        )
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }

      completionHandler(.useCredential, URLCredential(trust: trust))
    } catch {
      reportError(
        CordieriteErrorDetails(
          code: "tls_handshake_failed",
          message: error.localizedDescription,
          phase: "tls",
          nativeCode: "spki_pin_failed",
          closeReason: nil,
          isRetryable: false,
          hint: "Check the host certificate and trusted pins."
        )
      )
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  /// Fire-and-forget error report from a `nonisolated` context: hops onto the actor to update
  /// `lastErrorDetails` and invoke `emitError`, without making the (synchronous) caller wait.
  nonisolated private func reportError(_ details: CordieriteErrorDetails) {
    Task {
      await self.publishError(details)
    }
  }

  nonisolated func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    Task {
      await self.handleSocketClosed(task: webSocketTask, closeCode: closeCode, reason: reason)
    }
  }

  /// `didCompleteWithError` fires for every task completion, including a normal close (with
  /// `error == nil`, shortly after `didCloseWith`) and abrupt transport death (network drop,
  /// process kill on the other end) where `didCloseWith` never fires at all. Both paths funnel
  /// into `finishTransportTeardown`, which is guarded by `closeEventPending` so exactly one
  /// `close` event is ever emitted no matter which delegate callback (or both) fire.
  nonisolated func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    Task {
      await self.handleTaskCompleted(task: task, error: error)
    }
  }

  private func handleSocketClosed(
    task: URLSessionWebSocketTask,
    closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) async {
    guard !isInvalidated, task === socketTask else {
      return
    }

    let decodedReason = reason.flatMap { String(data: $0, encoding: .utf8) }

    if state == .connecting, let decodedReason {
      state = .error
      publishError(classifyHandshakeCloseReason(decodedReason))
    }

    finishTransportTeardown(emitCode: Int(closeCode.rawValue), emitReason: decodedReason)
  }

  private func handleTaskCompleted(task: URLSessionTask, error: Error?) async {
    guard !isInvalidated, task === socketTask else {
      return
    }

    if let error, lastErrorDetails == nil, state != .error {
      publishError(
        classifyTransportFailure(
          code: "transport_task_completed",
          message: error.localizedDescription,
          closeReason: nil
        )
      )
    }

    finishTransportTeardown(emitCode: nil, emitReason: nil)
  }

  private func finishTransportTeardown(emitCode: Int?, emitReason: String?) {
    guard closeEventPending else {
      // Already handled by the other delegate path (or by an explicit close()/invalidate()).
      return
    }

    let leaseSessionId = activeSessionId ?? pendingOptions?.sessionId
    updateResumeLeaseForTransportTeardown(
      ownerGeneration: ownerGeneration,
      sessionId: leaseSessionId,
      closeCode: emitCode,
      disconnectedAtMs: epochMilliseconds()
    )

    cleanup()

    if state != .error {
      state = .closed
    }

    let payload = NSMutableDictionary()
    if let emitCode {
      payload["code"] = emitCode
    }
    if let emitReason {
      payload["reason"] = emitReason
    }
    emitClose?(payload)
    closeEventPending = false
  }

  /// SPKI DER hash; pin strings must match Android `PinningTrustManager` for the same leaf certificate.
  nonisolated func spkiPin(for certificate: SecCertificate) throws -> String {
    guard let publicKey = SecCertificateCopyKey(certificate),
          let rawPublicKey = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?
    else {
      throw CordieriteModuleError(message: "Unable to read the Cordierite server public key.")
    }

    guard let attributes = SecKeyCopyAttributes(publicKey) as NSDictionary? else {
      throw CordieriteModuleError(message: "Unable to read Cordierite server public key attributes.")
    }
    guard let keyType = attributes[kSecAttrKeyType] as? String else {
      throw CordieriteModuleError(message: "Unsupported Cordierite server public key type.")
    }

    let keySizeBits = attributes[kSecAttrKeySizeInBits] as? Int ?? 0
    let algorithmIdentifier: Data

    if keyType == (kSecAttrKeyTypeRSA as String) {
      algorithmIdentifier = Data([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00])
    } else if keyType == (kSecAttrKeyTypeECSECPrimeRandom as String) {
      switch keySizeBits {
      case 256:
        algorithmIdentifier = Data([0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07])
      case 384:
        algorithmIdentifier = Data([0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22])
      case 521:
        algorithmIdentifier = Data([0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23])
      default:
        throw CordieriteModuleError(message: "Unsupported Cordierite EC key size.")
      }
    } else {
      throw CordieriteModuleError(message: "Unsupported Cordierite server public key algorithm.")
    }

    let bitString = asn1(tag: 0x03, value: Data([0x00]) + rawPublicKey)
    let spki = asn1(tag: 0x30, value: algorithmIdentifier + bitString)
    let digest = SHA256.hash(data: spki)

    return "sha256/\(Data(digest).base64EncodedString())"
  }

  nonisolated private func asn1(tag: UInt8, value: Data) -> Data {
    Data([tag]) + derLength(value.count) + value
  }

  nonisolated private func derLength(_ length: Int) -> Data {
    if length < 128 {
      return Data([UInt8(length)])
    }

    var remaining = length
    var octets: [UInt8] = []

    while remaining > 0 {
      octets.insert(UInt8(remaining & 0xff), at: 0)
      remaining >>= 8
    }

    return Data([0x80 | UInt8(octets.count)] + octets)
  }

  private func classifyTransportFailure(
    code: String,
    message: String,
    closeReason: String?
  ) -> CordieriteErrorDetails {
    let normalized = message.lowercased()

    if normalized.contains("timed out") || normalized.contains("network connection was lost") {
      return CordieriteErrorDetails(
        code: "host_unreachable",
        message: message,
        phase: "connect",
        nativeCode: code,
        closeReason: closeReason,
        isRetryable: true,
        hint: "Check that the host is running and reachable from the app."
      )
    }

    if normalized.contains("ssl") || normalized.contains("certificate") || normalized.contains("tls") {
      return CordieriteErrorDetails(
        code: "tls_handshake_failed",
        message: message,
        phase: "tls",
        nativeCode: code,
        closeReason: closeReason,
        isRetryable: false,
        hint: "Check the host certificate, trusted pins, and device clock."
      )
    }

    return CordieriteErrorDetails(
      code: code,
      message: message,
      phase: "transport",
      nativeCode: code,
      closeReason: closeReason,
      isRetryable: true,
      hint: nil
    )
  }

  private func classifyHandshakeCloseReason(_ closeReason: String?) -> CordieriteErrorDetails {
    switch closeReason {
    case "expired_session_claim":
      return CordieriteErrorDetails(
        code: "session_claim_expired",
        message: "Cordierite session claim expired before the app connected.",
        phase: "handshake",
        nativeCode: nil,
        closeReason: closeReason,
        isRetryable: true,
        hint: "Restart the host and open the deep link again. Larger apps may need the longer default 60s TTL."
      )
    case "wrong_session_id":
      return CordieriteErrorDetails(
        code: "session_claim_rejected",
        message: "Cordierite app claimed a different session id than the host expected.",
        phase: "handshake",
        nativeCode: nil,
        closeReason: closeReason,
        isRetryable: false,
        hint: nil
      )
    case "wrong_token":
      return CordieriteErrorDetails(
        code: "session_claim_rejected",
        message: "Cordierite app used the wrong session token for this host.",
        phase: "handshake",
        nativeCode: nil,
        closeReason: closeReason,
        isRetryable: false,
        hint: nil
      )
    case "already_claimed", "single_session_only":
      return CordieriteErrorDetails(
        code: "session_claim_rejected",
        message: "Cordierite host already has an active device connection for this session.",
        phase: "handshake",
        nativeCode: nil,
        closeReason: closeReason,
        isRetryable: true,
        hint: nil
      )
    case "session_not_claimable":
      return CordieriteErrorDetails(
        code: "session_claim_rejected",
        message: "Cordierite session is no longer claimable.",
        phase: "handshake",
        nativeCode: nil,
        closeReason: closeReason,
        isRetryable: true,
        hint: nil
      )
    case "expected_session_claim":
      return CordieriteErrorDetails(
        code: "invalid_ack",
        message: "Cordierite host expected a session claim before any other message.",
        phase: "handshake",
        nativeCode: nil,
        closeReason: closeReason,
        isRetryable: false,
        hint: nil
      )
    default:
      return CordieriteErrorDetails(
        code: "invalid_ack",
        message: "Cordierite session acknowledgement was invalid.",
        phase: "handshake",
        nativeCode: nil,
        closeReason: closeReason,
        isRetryable: false,
        hint: nil
      )
    }
  }
}
