import CryptoKit
import Foundation
import Security
#if canImport(UIKit)
  import UIKit
#endif

private let cliPinsPlistKey = "CordieriteCliPins"
private let allowPrivateLanOnlyPlistKey = "CordieriteAllowPrivateLanOnly"

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

struct CordieriteErrorDetails {
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

private struct CordieriteConnectOptions {
  let ip: String
  let port: Int
  let sessionId: String
  let token: String
  let expiresAt: Int
  let deviceManufacturer: String?
  let deviceModel: String?
  let deviceOs: String?

  init(_ value: [String: Any]) throws {
    guard
      let ip = value["ip"] as? String,
      let port = cordieriteIntFromBridge(value["port"]),
      let sessionId = value["sessionId"] as? String,
      let token = value["token"] as? String,
      let expiresAt = cordieriteIntFromBridge(value["expiresAt"])
    else {
      throw CordieriteModuleError(message: "Invalid Cordierite connect options.")
    }

    self.ip = ip
    self.port = port
    self.sessionId = sessionId
    self.token = token
    self.expiresAt = expiresAt

    func optionalString(_ key: String) -> String? {
      guard let s = value[key] as? String else {
        return nil
      }
      let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }

    self.deviceManufacturer = optionalString("deviceManufacturer")
    self.deviceModel = optionalString("deviceModel")
    self.deviceOs = optionalString("deviceOs")
  }
}

private struct DefaultSessionClaimDeviceFields {
  let manufacturer: String
  let model: String
  let os: String
}

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
    case .unspecified:
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

final class CordieriteConnectionManager: NSObject, URLSessionDelegate, URLSessionWebSocketDelegate {
  var emitStateChange: ((String) -> Void)?
  /// Turbo path: only the raw JSON string; JS parses `message`.
  var emitMessageRaw: ((String) -> Void)?
  var emitError: ((CordieriteErrorDetails) -> Void)?
  var emitClose: ((NSDictionary) -> Void)?

  private(set) var state: CordieriteConnectionState = .idle {
    didSet {
      emitStateChange?(state.rawValue)
    }
  }

  private var session: URLSession?
  private var socketTask: URLSessionWebSocketTask?
  private var activeSessionId: String?
  private var pendingSessionId: String?
  private var configuredPins: Set<String> = []
  private var allowPrivateLanOnly = false
  private var closeEventPending = false
  private var lastErrorDetails: CordieriteErrorDetails?

  func configureFromBundle() throws {
    let info = Bundle.main.infoDictionary ?? [:]
    let pins = info[cliPinsPlistKey] as? [String] ?? []

    guard !pins.isEmpty else {
      throw CordieriteModuleError(message: "Cordierite CLI pins are not configured in Info.plist.")
    }

    configuredPins = Set(pins)
    allowPrivateLanOnly = info[allowPrivateLanOnlyPlistKey] as? Bool ?? false
  }

  func connect(options rawOptions: [String: Any]) async throws {
    let options = try CordieriteConnectOptions(rawOptions)

    if state == .connecting || state == .active {
      throw CordieriteModuleError(message: "A Cordierite session is already connecting or active.")
    }

    try configureFromBundle()

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

    cleanup()

    pendingSessionId = options.sessionId
    closeEventPending = true
    state = .connecting

    let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    let task = session.webSocketTask(with: url)

    self.session = session
    socketTask = task

    task.resume()
    receiveNextMessage()

    let device = mergeSessionClaimDeviceFields(options: options, defaults: defaultAppleSessionClaimDeviceFields())
    let claim: [String: Any] = [
      "type": "session_claim",
      "session_id": options.sessionId,
      "token": options.token,
      "device_manufacturer": device.manufacturer,
      "device_model": device.model,
      "device_os": device.os,
    ]

    try await sendRawObject(claim, requireActiveSession: false)
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

  func close() {
    guard let socketTask else {
      cleanup()
      state = .closed
      emitClose?(NSDictionary())
      return
    }

    closeEventPending = true
    socketTask.cancel(with: .normalClosure, reason: nil)
  }

  private func cleanup() {
    socketTask = nil
    session?.invalidateAndCancel()
    session = nil
    activeSessionId = nil
    pendingSessionId = nil
    lastErrorDetails = nil
  }

  private func publishError(_ details: CordieriteErrorDetails) {
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

    socketTask.receive { [weak self] result in
      guard let self else {
        return
      }

      switch result {
      case .failure(let error):
        self.state = .error
        if self.lastErrorDetails == nil {
          self.publishError(
            self.classifyTransportFailure(
              code: "receive_failed",
              message: error.localizedDescription,
              closeReason: nil
            )
          )
        }
        self.close()
      case .success(let message):
        switch message {
        case .string(let text):
          self.handleIncomingText(text)
          self.receiveNextMessage()
        case .data:
          self.state = .error
          self.publishError(
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
          self.close()
        @unknown default:
          self.state = .error
          self.publishError(
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
          self.close()
        }
      }
    }
  }

  private func handleIncomingText(_ text: String) {
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
      close()
      return
    }

    if state == .connecting {
      handleSessionAck(parsed)
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
      close()
      return
    }

    emitMessageRaw?(text)
  }

  private func handleSessionAck(_ message: [String: Any]) {
    guard
      let pendingSessionId,
      let type = message["type"] as? String,
      type == "session_ack",
      let sessionId = message["session_id"] as? String,
      sessionId == pendingSessionId,
      let status = message["status"] as? String,
      status == "ok"
    else {
      state = .error
      let closeReason = (message["reason"] as? String)?.isEmpty == false ? message["reason"] as? String : nil
      publishError(classifyHandshakeCloseReason(closeReason))
      close()
      return
    }

    activeSessionId = pendingSessionId
    self.pendingSessionId = nil
    state = .active
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

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust,
          let certificate = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let leaf = certificate.first
    else {
      publishError(
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
        publishError(
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
      publishError(
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

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    let decodedReason = reason.flatMap { String(data: $0, encoding: .utf8) }

    if state == .connecting, let decodedReason {
      state = .error
      publishError(classifyHandshakeCloseReason(decodedReason))
    }

    cleanup()

    if state != .error {
      state = .closed
    }

    if closeEventPending {
      let payload = NSMutableDictionary()
      payload["code"] = Int(closeCode.rawValue)
      if let decodedReason {
        payload["reason"] = decodedReason
      }
      emitClose?(payload)
      closeEventPending = false
    }
  }

  /// SPKI DER hash; pin strings must match Android `PinningTrustManager` for the same leaf certificate.
  private func spkiPin(for certificate: SecCertificate) throws -> String {
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

  private func asn1(tag: UInt8, value: Data) -> Data {
    Data([tag]) + derLength(value.count) + value
  }

  private func derLength(_ length: Int) -> Data {
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
