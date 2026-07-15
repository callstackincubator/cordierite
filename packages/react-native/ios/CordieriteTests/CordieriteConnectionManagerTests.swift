import XCTest
@testable import Cordierite

final class CordieriteConnectionManagerTests: XCTestCase {
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
