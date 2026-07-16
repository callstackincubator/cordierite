import CoreFoundation
import Foundation

private let resumeLeaseSchemaVersion = 1
private let maxWireIdLength = 128
private let maxWireStringLength = 4096

struct CordieriteResumeEndpoint: Equatable, Sendable {
  let ip: String
  let port: Int
}

/// Immutable process-memory representation of Task 1's `ResumeLeaseV1` contract.
struct CordieriteResumeLeaseV1: Equatable, Sendable {
  let sessionId: String
  let resumeToken: String
  let alias: String
  let endpoint: CordieriteResumeEndpoint
  let keepaliveIntervalS: Double
  let graceS: Double
  let disconnectedAtMs: Int64?

  let schemaVersion = resumeLeaseSchemaVersion

  /// Stable JSON-ready record for the future synchronous TurboModule exposure.
  func toRecord() -> [String: Any] {
    [
      "schemaVersion": schemaVersion,
      "sessionId": sessionId,
      "resumeToken": resumeToken,
      "alias": alias,
      "endpoint": ["ip": endpoint.ip, "port": endpoint.port],
      "keepaliveIntervalS": keepaliveIntervalS,
      "graceS": graceS,
      "disconnectedAtMs": disconnectedAtMs.map { $0 as Any } ?? NSNull(),
    ]
  }
}

///
/// Owns exactly one app/session resume lease for this process lifetime. The owner generation is
/// deliberately absent from the serialized record; it only prevents teardown from an older
/// TurboModule/manager from mutating a lease installed by its replacement.
///
/// `@unchecked Sendable` is justified by the single private lock: all mutable state and the
/// generation counter are synchronously accessed under that lock, while values copied across the
/// boundary are immutable `Sendable` structs.
final class CordieriteProcessResumeLeaseStore: @unchecked Sendable {
  static let shared = CordieriteProcessResumeLeaseStore()

  private struct Entry: Sendable {
    let ownerGeneration: Int64
    let lease: CordieriteResumeLeaseV1
  }

  private let lock = NSLock()
  private var generationCounter: Int64 = 0
  private var entry: Entry?

  private init() {}

  func newOwnerGeneration() -> Int64 {
    withLock {
      precondition(generationCounter < Int64.max, "Cordierite owner generation exhausted.")
      generationCounter += 1
      return generationCounter
    }
  }

  func get() -> CordieriteResumeLeaseV1? {
    withLock { entry?.lease }
  }

  /// Internal synchronous getter reserved for Task 4's TurboModule bridge.
  func getRecord() -> [String: Any]? {
    withLock { entry?.lease.toRecord() }
  }

  @discardableResult
  func replace(ownerGeneration: Int64, lease: CordieriteResumeLeaseV1) -> Bool {
    withLock {
      if let entry, entry.ownerGeneration > ownerGeneration {
        return false
      }
      entry = Entry(ownerGeneration: ownerGeneration, lease: lease)
      return true
    }
  }

  @discardableResult
  func markDisconnected(ownerGeneration: Int64, sessionId: String, disconnectedAtMs: Int64) -> Bool {
    withLock {
      guard
        disconnectedAtMs >= 0,
        let current = entry,
        current.ownerGeneration <= ownerGeneration,
        current.lease.sessionId == sessionId
      else {
        return false
      }

      entry = Entry(
        ownerGeneration: ownerGeneration,
        lease: CordieriteResumeLeaseV1(
          sessionId: current.lease.sessionId,
          resumeToken: current.lease.resumeToken,
          alias: current.lease.alias,
          endpoint: current.lease.endpoint,
          keepaliveIntervalS: current.lease.keepaliveIntervalS,
          graceS: current.lease.graceS,
          disconnectedAtMs: current.lease.disconnectedAtMs ?? disconnectedAtMs
        )
      )
      return true
    }
  }

  /// Guarded clear reserved for connection teardown and Task 4's native wrapper.
  @discardableResult
  func clear(ownerGeneration: Int64) -> Bool {
    withLock {
      guard let current = entry else {
        return true
      }
      guard current.ownerGeneration <= ownerGeneration else {
        return false
      }
      entry = nil
      return true
    }
  }

  func resetForTests() {
    withLock {
      entry = nil
      generationCounter = 0
    }
  }

  private func withLock<T>(_ operation: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try operation()
  }
}

/// Applies the shared terminal/nonterminal transport contract with the same generation guard as
/// every other lease mutation. A normal WebSocket close (1000) is daemon revocation/terminal;
/// every other completion preserves the credential and records the first disconnect time.
func updateResumeLeaseForTransportTeardown(
  ownerGeneration: Int64,
  sessionId: String?,
  closeCode: Int?,
  disconnectedAtMs: Int64
) {
  if closeCode == 1_000 {
    CordieriteProcessResumeLeaseStore.shared.clear(ownerGeneration: ownerGeneration)
  } else if let sessionId {
    CordieriteProcessResumeLeaseStore.shared.markDisconnected(
      ownerGeneration: ownerGeneration,
      sessionId: sessionId,
      disconnectedAtMs: disconnectedAtMs
    )
  }
}

enum SessionAckCommitResult: Equatable {
  case accepted
  case invalid
  case stale
}

/// Validates and commits the ack-owned lease before either actor state or the raw callback changes.
/// Keeping this ordering in one synchronous function closes the token-rotation reload window.
func commitSessionAck(
  message: [String: Any],
  rawText: String,
  options: CordieriteConnectOptions,
  ownerGeneration: Int64,
  onAccepted: (CordieriteResumeLeaseV1) -> Void,
  emitMessageRaw: (String) -> Void
) -> SessionAckCommitResult {
  guard let lease = parseSessionAckLease(message: message, options: options) else {
    return .invalid
  }
  guard CordieriteProcessResumeLeaseStore.shared.replace(ownerGeneration: ownerGeneration, lease: lease) else {
    return .stale
  }

  onAccepted(lease)
  emitMessageRaw(rawText)
  return .accepted
}

private func parseSessionAckLease(
  message: [String: Any],
  options: CordieriteConnectOptions
) -> CordieriteResumeLeaseV1? {
  guard
    let type = message["type"] as? String,
    type == "session_ack",
    let status = message["status"] as? String,
    status == "ok",
    let sessionId = boundedWireString(message["session_id"], maxLength: maxWireIdLength),
    sessionId == options.sessionId,
    let resumeToken = boundedWireString(message["resume_token"], maxLength: maxWireIdLength),
    let alias = boundedWireString(message["alias"], maxLength: maxWireIdLength),
    let keepaliveIntervalS = positiveFiniteNumber(message["keepalive_interval_s"]),
    let graceS = positiveFiniteNumber(message["grace_s"]),
    !options.ip.isEmpty,
    options.ip.utf16.count <= maxWireStringLength,
    (1...65_535).contains(options.port)
  else {
    return nil
  }

  return CordieriteResumeLeaseV1(
    sessionId: sessionId,
    resumeToken: resumeToken,
    alias: alias,
    endpoint: CordieriteResumeEndpoint(ip: options.ip, port: options.port),
    keepaliveIntervalS: keepaliveIntervalS,
    graceS: graceS,
    disconnectedAtMs: nil
  )
}

private func boundedWireString(_ value: Any?, maxLength: Int) -> String? {
  guard let value = value as? String, !value.isEmpty, value.utf16.count <= maxLength else {
    return nil
  }
  return value
}

private func positiveFiniteNumber(_ value: Any?) -> Double? {
  guard
    let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID()
  else {
    return nil
  }
  let value = number.doubleValue
  return value.isFinite && value > 0 ? value : nil
}
