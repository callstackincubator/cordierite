import XCTest
@testable import Cordierite

final class CordieriteConnectionManagerTests: XCTestCase {
  override func setUp() {
    super.setUp()
    CordieriteProcessResumeLeaseStore.shared.resetForTests()
  }

  // MARK: - Process resume lease

  func testValidClaimAckStoresExactSchemaRecordBeforeRawCallback() throws {
    let options = try connectOptions(token: "claim-token")
    let rawAck = """
    {"type":"session_ack","session_id":"session-1","status":"ok","alias":"iphone-1","resume_token":"resume-token-1","keepalive_interval_s":15,"grace_s":600}
    """
    let message = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(rawAck.utf8)) as? [String: Any]
    )
    let ownerGeneration = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    var recordObservedByRawCallback: [String: Any]?
    var transitioned = false

    let result = commitSessionAck(
      message: message,
      rawText: rawAck,
      options: options,
      ownerGeneration: ownerGeneration,
      onAccepted: { _ in transitioned = true },
      emitMessageRaw: { _ in
        XCTAssertTrue(transitioned)
        recordObservedByRawCallback = CordieriteProcessResumeLeaseStore.shared.getRecord()
      }
    )

    XCTAssertEqual(result, .accepted)
    let record = try XCTUnwrap(recordObservedByRawCallback)
    XCTAssertEqual(record["schemaVersion"] as? Int, 1)
    XCTAssertEqual(record["sessionId"] as? String, "session-1")
    XCTAssertEqual(record["resumeToken"] as? String, "resume-token-1")
    XCTAssertEqual(record["alias"] as? String, "iphone-1")
    let endpoint = try XCTUnwrap(record["endpoint"] as? [String: Any])
    XCTAssertEqual(endpoint["ip"] as? String, "127.0.0.1")
    XCTAssertEqual(endpoint["port"] as? Int, 8443)
    XCTAssertEqual(record["keepaliveIntervalS"] as? Double, 15)
    XCTAssertEqual(record["graceS"] as? Double, 600)
    XCTAssertTrue(record.keys.contains("disconnectedAtMs"))
    XCTAssertTrue(record["disconnectedAtMs"] is NSNull)
  }

  func testResumeAckRotatesTokenAndResetsDisconnectTimestamp() throws {
    let ownerGeneration = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let options = try connectOptions(resumeToken: "resume-token-1")
    let firstAck = validAck(resumeToken: "resume-token-1")

    XCTAssertEqual(
      commitSessionAck(
        message: firstAck,
        rawText: "first",
        options: options,
        ownerGeneration: ownerGeneration,
        onAccepted: { _ in },
        emitMessageRaw: { _ in }
      ),
      .accepted
    )
    XCTAssertTrue(
      CordieriteProcessResumeLeaseStore.shared.markDisconnected(
        ownerGeneration: ownerGeneration,
        sessionId: "session-1",
        disconnectedAtMs: 1_234
      )
    )

    var rotatedAck = firstAck
    rotatedAck["resume_token"] = "resume-token-2"
    var callbackToken: String?
    XCTAssertEqual(
      commitSessionAck(
        message: rotatedAck,
        rawText: "rotated",
        options: options,
        ownerGeneration: ownerGeneration,
        onAccepted: { _ in },
        emitMessageRaw: { _ in
          callbackToken = CordieriteProcessResumeLeaseStore.shared.get()?.resumeToken
        }
      ),
      .accepted
    )

    XCTAssertEqual(callbackToken, "resume-token-2")
    XCTAssertNil(CordieriteProcessResumeLeaseStore.shared.get()?.disconnectedAtMs)
  }

  func testMalformedAckMatrixNeverStoresTransitionsOrEmits() throws {
    let validOptions = try connectOptions(resumeToken: "resume-token-old")
    let valid = validAck(resumeToken: "resume-token-old")
    var malformedCases: [(String, [String: Any], CordieriteConnectOptions)] = []

    func replacing(_ key: String, with value: Any) -> [String: Any] {
      var result = valid
      result[key] = value
      return result
    }

    func removing(_ key: String) -> [String: Any] {
      var result = valid
      result.removeValue(forKey: key)
      return result
    }

    malformedCases.append(contentsOf: [
      ("missing type", removing("type"), validOptions),
      ("wrong type", replacing("type", with: "tool_call"), validOptions),
      ("non-string type", replacing("type", with: 1), validOptions),
      ("missing status", removing("status"), validOptions),
      ("rejected status", replacing("status", with: "rejected"), validOptions),
      ("wrong session", replacing("session_id", with: "session-2"), validOptions),
      ("empty session", replacing("session_id", with: ""), validOptions),
      ("long session", replacing("session_id", with: String(repeating: "s", count: 129)), validOptions),
      ("missing token", removing("resume_token"), validOptions),
      ("empty token", replacing("resume_token", with: ""), validOptions),
      ("long token", replacing("resume_token", with: String(repeating: "t", count: 129)), validOptions),
      ("missing alias", removing("alias"), validOptions),
      ("empty alias", replacing("alias", with: ""), validOptions),
      ("long alias", replacing("alias", with: String(repeating: "a", count: 129)), validOptions),
      ("string keepalive", replacing("keepalive_interval_s", with: "15"), validOptions),
      ("boolean keepalive", replacing("keepalive_interval_s", with: true), validOptions),
      ("zero keepalive", replacing("keepalive_interval_s", with: 0), validOptions),
      ("infinite keepalive", replacing("keepalive_interval_s", with: Double.infinity), validOptions),
      ("negative grace", replacing("grace_s", with: -1), validOptions),
      ("nan grace", replacing("grace_s", with: Double.nan), validOptions),
      ("empty endpoint", valid, try connectOptions(ip: "", resumeToken: "resume-token-old")),
      ("long endpoint", valid, try connectOptions(ip: String(repeating: "i", count: 4_097), resumeToken: "resume-token-old")),
      ("zero port", valid, try connectOptions(port: 0, resumeToken: "resume-token-old")),
      ("large port", valid, try connectOptions(port: 65_536, resumeToken: "resume-token-old")),
    ])

    for (name, malformedAck, malformedOptions) in malformedCases {
      CordieriteProcessResumeLeaseStore.shared.resetForTests()
      let ownerGeneration = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
      XCTAssertEqual(
        commitSessionAck(
          message: valid,
          rawText: "valid",
          options: validOptions,
          ownerGeneration: ownerGeneration,
          onAccepted: { _ in },
          emitMessageRaw: { _ in }
        ),
        .accepted,
        name
      )
      var transitioned = false
      var emitted = false

      XCTAssertEqual(
        commitSessionAck(
          message: malformedAck,
          rawText: name,
          options: malformedOptions,
          ownerGeneration: ownerGeneration,
          onAccepted: { _ in transitioned = true },
          emitMessageRaw: { _ in emitted = true }
        ),
        .invalid,
        name
      )
      XCTAssertFalse(transitioned, name)
      XCTAssertFalse(emitted, name)
      XCTAssertEqual(CordieriteProcessResumeLeaseStore.shared.get()?.resumeToken, "resume-token-old", name)
    }
  }

  func testStaleGenerationCannotReplaceTimestampOrClearNewerLease() {
    let olderOwner = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let newerOwner = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()

    XCTAssertTrue(
      CordieriteProcessResumeLeaseStore.shared.replace(
        ownerGeneration: olderOwner,
        lease: lease(resumeToken: "resume-token-old")
      )
    )
    XCTAssertTrue(
      CordieriteProcessResumeLeaseStore.shared.replace(
        ownerGeneration: newerOwner,
        lease: lease(resumeToken: "resume-token-new")
      )
    )
    XCTAssertFalse(
      CordieriteProcessResumeLeaseStore.shared.replace(
        ownerGeneration: olderOwner,
        lease: lease(resumeToken: "resume-token-stale")
      )
    )
    XCTAssertFalse(
      CordieriteProcessResumeLeaseStore.shared.markDisconnected(
        ownerGeneration: olderOwner,
        sessionId: "session-1",
        disconnectedAtMs: 1_000
      )
    )
    XCTAssertFalse(CordieriteProcessResumeLeaseStore.shared.clear(ownerGeneration: olderOwner))
    XCTAssertEqual(CordieriteProcessResumeLeaseStore.shared.get()?.resumeToken, "resume-token-new")
    XCTAssertNil(CordieriteProcessResumeLeaseStore.shared.get()?.disconnectedAtMs)
  }

  func testManagerResumeLeaseGetterReturnsNilThenExactSchemaRecord() throws {
    let ownerGeneration = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let manager = CordieriteConnectionManager(ownerGeneration: ownerGeneration)

    XCTAssertNil(manager.currentResumeLeaseRecord())
    XCTAssertTrue(
      CordieriteProcessResumeLeaseStore.shared.replace(
        ownerGeneration: ownerGeneration,
        lease: CordieriteResumeLeaseV1(
          sessionId: "session-1",
          resumeToken: "resume-token-1",
          alias: "iphone-1",
          endpoint: CordieriteResumeEndpoint(ip: "127.0.0.1", port: 8443),
          keepaliveIntervalS: 15,
          graceS: 600,
          disconnectedAtMs: 1_234
        )
      )
    )

    let record = try XCTUnwrap(manager.currentResumeLeaseRecord())
    XCTAssertEqual(record["schemaVersion"] as? Int, 1)
    XCTAssertEqual(record["sessionId"] as? String, "session-1")
    XCTAssertEqual(record["resumeToken"] as? String, "resume-token-1")
    XCTAssertEqual(record["alias"] as? String, "iphone-1")
    let endpoint = try XCTUnwrap(record["endpoint"] as? [String: Any])
    XCTAssertEqual(endpoint["ip"] as? String, "127.0.0.1")
    XCTAssertEqual(endpoint["port"] as? Int, 8443)
    XCTAssertEqual(record["keepaliveIntervalS"] as? Double, 15)
    XCTAssertEqual(record["graceS"] as? Double, 600)
    XCTAssertEqual(record["disconnectedAtMs"] as? Int64, 1_234)
  }

  func testManagerResumeLeaseClearIsGuardedByItsOwnerGeneration() {
    let olderOwner = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let newerOwner = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let oldManager = CordieriteConnectionManager(ownerGeneration: olderOwner)
    let newManager = CordieriteConnectionManager(ownerGeneration: newerOwner)
    XCTAssertTrue(
      CordieriteProcessResumeLeaseStore.shared.replace(
        ownerGeneration: newerOwner,
        lease: lease(resumeToken: "resume-token-new")
      )
    )

    XCTAssertFalse(oldManager.clearResumeLease())
    XCTAssertEqual(CordieriteProcessResumeLeaseStore.shared.get()?.resumeToken, "resume-token-new")
    XCTAssertTrue(newManager.clearResumeLease())
    XCTAssertNil(CordieriteProcessResumeLeaseStore.shared.get())
  }

  func testTransportLossTimestampsLeaseWhileNormalTerminalCloseClearsIt() {
    let ownerGeneration = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    CordieriteProcessResumeLeaseStore.shared.replace(
      ownerGeneration: ownerGeneration,
      lease: lease(resumeToken: "resume-token-1")
    )

    updateResumeLeaseForTransportTeardown(
      ownerGeneration: ownerGeneration,
      sessionId: "session-1",
      closeCode: nil,
      disconnectedAtMs: 1_234
    )
    XCTAssertEqual(CordieriteProcessResumeLeaseStore.shared.get()?.disconnectedAtMs, 1_234)
    XCTAssertEqual(CordieriteProcessResumeLeaseStore.shared.getRecord()?["disconnectedAtMs"] as? Int64, 1_234)

    updateResumeLeaseForTransportTeardown(
      ownerGeneration: ownerGeneration,
      sessionId: "session-1",
      closeCode: 1_000,
      disconnectedAtMs: 2_345
    )
    XCTAssertNil(CordieriteProcessResumeLeaseStore.shared.get())
  }

  func testConcurrentGenerationAssignmentIsUniqueAndMonotonic() {
    let generations = ThreadSafeInt64Array()

    DispatchQueue.concurrentPerform(iterations: 200) { _ in
      generations.append(CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration())
    }

    XCTAssertEqual(generations.values.sorted(), Array(1...200).map(Int64.init))
  }

  func testInvalidationPreservesAndTimestampsLeaseIdempotentlyWithoutEmitting() async throws {
    let ownerGeneration = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    XCTAssertTrue(
      CordieriteProcessResumeLeaseStore.shared.replace(
        ownerGeneration: ownerGeneration,
        lease: lease(resumeToken: "resume-token-1")
      )
    )
    let manager = CordieriteConnectionManager(ownerGeneration: ownerGeneration, activeSessionId: "session-1")
    let events = ThreadSafeStringArray()
    manager.emitStateChange = { events.append($0) }

    await manager.invalidate()

    XCTAssertEqual(CordieriteProcessResumeLeaseStore.shared.get()?.resumeToken, "resume-token-1")
    let disconnectedAtMs = try XCTUnwrap(CordieriteProcessResumeLeaseStore.shared.get()?.disconnectedAtMs)
    XCTAssertGreaterThan(disconnectedAtMs, 0)
    XCTAssertEqual(events.values, [])

    await manager.invalidate()
    XCTAssertEqual(CordieriteProcessResumeLeaseStore.shared.get()?.disconnectedAtMs, disconnectedAtMs)
    XCTAssertEqual(events.values, [])
  }

  func testExplicitCloseClearsOwnedLeaseButOldManagerCannotClearNewerLease() async {
    let olderOwner = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let newerOwner = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let oldManager = CordieriteConnectionManager(ownerGeneration: olderOwner, activeSessionId: "session-1")
    let newManager = CordieriteConnectionManager(ownerGeneration: newerOwner)

    CordieriteProcessResumeLeaseStore.shared.replace(
      ownerGeneration: newerOwner,
      lease: lease(resumeToken: "resume-token-new")
    )
    await oldManager.close()
    XCTAssertEqual(CordieriteProcessResumeLeaseStore.shared.get()?.resumeToken, "resume-token-new")

    await newManager.close()
    XCTAssertNil(CordieriteProcessResumeLeaseStore.shared.get())
  }

  func testOldManagerInvalidationCannotTimestampNewerLease() async {
    let olderOwner = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let newerOwner = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let oldManager = CordieriteConnectionManager(ownerGeneration: olderOwner, activeSessionId: "session-1")

    CordieriteProcessResumeLeaseStore.shared.replace(
      ownerGeneration: newerOwner,
      lease: lease(resumeToken: "resume-token-new")
    )
    await oldManager.invalidate()

    XCTAssertEqual(CordieriteProcessResumeLeaseStore.shared.get()?.resumeToken, "resume-token-new")
    XCTAssertNil(CordieriteProcessResumeLeaseStore.shared.get()?.disconnectedAtMs)
  }

  func testStaleDelegateCloseCallbackCannotClearNewerLease() async throws {
    let olderOwner = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let newerOwner = CordieriteProcessResumeLeaseStore.shared.newOwnerGeneration()
    let oldManager = CordieriteConnectionManager(ownerGeneration: olderOwner)
    CordieriteProcessResumeLeaseStore.shared.replace(
      ownerGeneration: newerOwner,
      lease: lease(resumeToken: "resume-token-new")
    )
    let task = URLSession.shared.webSocketTask(with: try XCTUnwrap(URL(string: "wss://127.0.0.1:8443")))

    oldManager.urlSession(
      URLSession.shared,
      webSocketTask: task,
      didCloseWith: .normalClosure,
      reason: nil
    )
    try? await Task.sleep(nanoseconds: 10_000_000)

    XCTAssertEqual(CordieriteProcessResumeLeaseStore.shared.get()?.resumeToken, "resume-token-new")
    XCTAssertNil(CordieriteProcessResumeLeaseStore.shared.get()?.disconnectedAtMs)
  }

  private func connectOptions(
    ip: String = "127.0.0.1",
    port: Int = 8443,
    token: String? = nil,
    resumeToken: String? = nil
  ) throws -> CordieriteConnectOptions {
    var value: [String: Any] = [
      "ip": ip,
      "port": port,
      "sessionId": "session-1",
      "expiresAt": Int.max,
    ]
    value["token"] = token
    value["resumeToken"] = resumeToken
    return try CordieriteConnectOptions(value)
  }

  private func validAck(resumeToken: String) -> [String: Any] {
    [
      "type": "session_ack",
      "session_id": "session-1",
      "status": "ok",
      "alias": "iphone-1",
      "resume_token": resumeToken,
      "keepalive_interval_s": 15,
      "grace_s": 600,
    ]
  }

  private func lease(resumeToken: String) -> CordieriteResumeLeaseV1 {
    CordieriteResumeLeaseV1(
      sessionId: "session-1",
      resumeToken: resumeToken,
      alias: "iphone-1",
      endpoint: CordieriteResumeEndpoint(ip: "127.0.0.1", port: 8443),
      keepaliveIntervalS: 15,
      graceS: 600,
      disconnectedAtMs: nil
    )
  }

  // MARK: - State transitions

  func testInitialStateIsIdle() {
    let manager = CordieriteConnectionManager()
    XCTAssertEqual(manager.currentStateSnapshot(), "idle")
  }

  func testInvalidateFromIdleTransitionsToClosedAndIsIdempotent() async {
    let manager = CordieriteConnectionManager()

    await manager.invalidate()
    XCTAssertEqual(manager.currentStateSnapshot(), "closed")

    // Calling invalidate again (e.g. a second Metro reload racing a slow first one) must not
    // crash or resurrect state; `getState()` must keep reporting "closed", never "active".
    await manager.invalidate()
    XCTAssertEqual(manager.currentStateSnapshot(), "closed")
  }

  func testCloseFromIdleEmitsExactlyOneCloseEventAndReportsClosed() async {
    let manager = CordieriteConnectionManager()
    let closeEvents = ClosedEventCounter()
    manager.emitClose = { _ in
      Task { await closeEvents.increment() }
    }

    await manager.close()

    // Give the fire-and-forget increment a turn to run.
    await Task.yield()
    let count = await closeEvents.count
    XCTAssertEqual(count, 1)
    XCTAssertEqual(manager.currentStateSnapshot(), "closed")
  }

  func testConnectRejectsWhenNeitherTokenNorResumeTokenGiven() {
    XCTAssertThrowsError(
      try CordieriteConnectOptions([
        "ip": "127.0.0.1",
        "port": 8443,
        "sessionId": "session-1",
        "expiresAt": Int(Date().timeIntervalSince1970) + 60,
      ])
    )
  }

  func testConnectOptionsAcceptsResumeTokenWithoutClaimToken() throws {
    let options = try CordieriteConnectOptions([
      "ip": "127.0.0.1",
      "port": 8443,
      "sessionId": "session-1",
      "resumeToken": "resume-token-value",
      "expiresAt": Int(Date().timeIntervalSince1970) + 60,
    ])

    XCTAssertNil(options.token)
    XCTAssertEqual(options.resumeToken, "resume-token-value")
  }

  // MARK: - Explicit trust mode (resolveTrustedPins) — docs/tasks/05-explicit-trust-mode.md

  private let embeddedPins = ["sha256/embedded-pin"]
  private let linkPinValue = "sha256/link-pin"

  // Table row: trust="pin", non-empty embedded pins -> embedded pins only, linkPin ignored.
  func testTrustPinWithEmbeddedPinsUsesEmbeddedPinsAndIgnoresLinkPin() {
    for linkPin in [nil, "", linkPinValue] {
      XCTAssertEqual(
        resolveTrustedPins(trust: "pin", embeddedPins: embeddedPins, linkPin: linkPin),
        .configured(Set(embeddedPins)),
        "linkPin=\(linkPin ?? "nil")"
      )
    }
  }

  // Table row: trust="pin", empty embedded pins -> hard error.
  func testTrustPinWithNoEmbeddedPinsHardErrorsRegardlessOfLinkPin() {
    for linkPin in [nil, "", linkPinValue] {
      XCTAssertEqual(
        resolveTrustedPins(trust: "pin", embeddedPins: [], linkPin: linkPin),
        .pinTrustRequiresEmbeddedPins,
        "linkPin=\(linkPin ?? "nil")"
      )
    }
  }

  // Table row: trust="link", empty embedded pins -> trust linkPin.
  func testTrustLinkWithNoEmbeddedPinsTrustsTheLinkPin() {
    XCTAssertEqual(
      resolveTrustedPins(trust: "link", embeddedPins: [], linkPin: linkPinValue),
      .linkPin(linkPinValue)
    )
  }

  // Table row: trust="link", empty embedded pins, no usable linkPin -> error.
  func testTrustLinkWithNoEmbeddedPinsAndNoUsableLinkPinErrors() {
    for linkPin in [nil, ""] {
      XCTAssertEqual(
        resolveTrustedPins(trust: "link", embeddedPins: [], linkPin: linkPin),
        .linkTrustRequiresLinkPin,
        "linkPin=\(linkPin ?? "nil")"
      )
    }
  }

  // Table row: trust="link", non-empty embedded pins -> embedded pins win, linkPin ignored.
  func testTrustLinkWithEmbeddedPinsUsesEmbeddedPinsAndIgnoresLinkPin() {
    for linkPin in [nil, "", linkPinValue] {
      XCTAssertEqual(
        resolveTrustedPins(trust: "link", embeddedPins: embeddedPins, linkPin: linkPin),
        .configured(Set(embeddedPins)),
        "linkPin=\(linkPin ?? "nil")"
      )
    }
  }

  // Missing-key default: no trust value, embedded pins present -> behaves like trust="pin".
  func testMissingTrustWithEmbeddedPinsDefaultsToPinBehavior() {
    XCTAssertEqual(
      resolveTrustedPins(trust: nil, embeddedPins: embeddedPins, linkPin: linkPinValue),
      .configured(Set(embeddedPins))
    )
  }

  // Missing-key default: no trust value, no embedded pins -> behaves like trust="link".
  func testMissingTrustWithNoEmbeddedPinsDefaultsToLinkBehavior() {
    XCTAssertEqual(
      resolveTrustedPins(trust: nil, embeddedPins: [], linkPin: linkPinValue),
      .linkPin(linkPinValue)
    )
    XCTAssertEqual(
      resolveTrustedPins(trust: nil, embeddedPins: [], linkPin: nil),
      .linkTrustRequiresLinkPin
    )
  }

  // An unrecognized trust string must fail safe (same missing-key default), never widen trust.
  func testUnrecognizedTrustValueFallsBackToTheMissingKeyDefault() {
    XCTAssertEqual(
      resolveTrustedPins(trust: "everything", embeddedPins: embeddedPins, linkPin: nil),
      .configured(Set(embeddedPins))
    )
    XCTAssertEqual(
      resolveTrustedPins(trust: "everything", embeddedPins: [], linkPin: linkPinValue),
      .linkPin(linkPinValue)
    )
  }

  func testConfigureFromBundleThrowsWhenNoPinsAndNoLinkPin() async {
    // The test host's Info.plist never sets CordieriteCliPins, so this exercises the real
    // Bundle.main-reading path (not just the pure resolveTrustedPins matrix above) for the
    // pre-existing "nothing configured" case, which must still hard-fail.
    let manager = CordieriteConnectionManager()
    do {
      try await manager.configureFromBundle(linkPin: nil)
      XCTFail("expected configureFromBundle to throw")
    } catch {
      // expected
    }
  }

  // MARK: - SPKI pin parity with packages/cordierite/src/spki-pin.ts

  /// DER bytes (base64) of a fixed, throwaway self-signed EC (P-256) test certificate, generated
  /// once with:
  ///
  ///   openssl ecparam -name prime256v1 -genkey -noout -out key.pem
  ///   openssl req -new -x509 -key key.pem -days 3650 -out cert.pem -subj "/CN=cordierite-test-fixture"
  ///
  /// Inlined (rather than committed as a `.pem` fixture file) per this repo's rule that no key
  /// material — including throwaway test fixtures — is ever committed as a `.pem` file
  /// (`git ls-files "*.pem"` must stay empty). Only the public certificate is needed here; the
  /// private key was discarded after generating the expected pin below and is not reproduced.
  private static let fixtureCertificateDerBase64 = """
  MIIBmTCCAT+gAwIBAgIULhk1FL4F1t1m4VB8ZocEJJk6FSAwCgYIKoZIzj0EAwIw
  IjEgMB4GA1UEAwwXY29yZGllcml0ZS10ZXN0LWZpeHR1cmUwHhcNMjYwNzE1MTI1
  NTM1WhcNMzYwNzEyMTI1NTM1WjAiMSAwHgYDVQQDDBdjb3JkaWVyaXRlLXRlc3Qt
  Zml4dHVyZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABCdrnHdxoZyNKqLxncue
  /z1uh6STs1TnZI643d5kaELACPbJYhQtsDvMauVa5G6LOcAyfvfoboLEUbRhR2wM
  e26jUzBRMB0GA1UdDgQWBBTDnPXrKTIWOcLw3w3PWtpV2fHnFjAfBgNVHSMEGDAW
  gBTDnPXrKTIWOcLw3w3PWtpV2fHnFjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
  BAMCA0gAMEUCIEHI+FcyHWubSC/hTHLSgyioRwNdiaQXOJyElnVT6fjnAiEAsNWW
  oTlKSgWIcpT15v8orzlc8BOam0+LL6JUP15ESos=
  """

  /// Independently derived (Node.js) from the same certificate's key material using
  /// `packages/cordierite/src/spki-pin.ts`'s `createSpkiPin`/SPKI-DER export — the two
  /// implementations must agree on this exact string for the same leaf certificate.
  private static let expectedPin = "sha256/nq5dKPoAJatciRzJQExHFls6q7YpSN2YP49Jmd+++Io="

  func testSpkiPinMatchesTypeScriptImplementationForTheSameCertificate() throws {
    let der = Data(base64Encoded: Self.fixtureCertificateDerBase64.replacingOccurrences(of: "\n", with: ""))
    guard let der, let certificate = SecCertificateCreateWithData(nil, der as CFData) else {
      XCTFail("Failed to decode the fixture certificate")
      return
    }

    let manager = CordieriteConnectionManager()
    let pin = try manager.spkiPin(for: certificate)

    XCTAssertEqual(pin, Self.expectedPin)
  }
}

/// Plain actor used only to serialize the close-event counter from a fire-and-forget `Task`.
private actor ClosedEventCounter {
  private(set) var count = 0

  func increment() {
    count += 1
  }
}

private final class ThreadSafeStringArray: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [String] = []

  var values: [String] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func append(_ value: String) {
    lock.lock()
    defer { lock.unlock() }
    storage.append(value)
  }
}

private final class ThreadSafeInt64Array: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [Int64] = []

  var values: [Int64] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func append(_ value: Int64) {
    lock.lock()
    defer { lock.unlock() }
    storage.append(value)
  }
}
