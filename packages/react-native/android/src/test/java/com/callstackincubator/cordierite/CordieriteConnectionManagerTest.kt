package com.callstackincubator.cordierite

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.util.Base64

/**
 * Pure-logic JVM tests for the Android connection layer (task 10). Runs on the plain JVM (no
 * Robolectric, no emulator) via `./gradlew :cordierite_react-native:testDebugUnitTest` from
 * `playground/android` (the autolinked consumer app).
 *
 * Not covered here (documented gap, same category as task 09's iOS commit): the actual
 * `connect()`/`send()`/`close()`/`getState()` state machine driven through real
 * `okhttp3.WebSocketListener` callbacks, and `PinningTrustManager`/`computeSpkiPin` end-to-end
 * (both ultimately call `android.util.Base64`, which throws "not mocked" on a plain JVM unit-test
 * runtime without Robolectric or a device/emulator). The SPKI test below independently verifies
 * the same SHA-256-over-SPKI-DER math with a standard-library `Base64` encoder instead.
 */
class CordieriteConnectionManagerTest {
    // MARK: - ALLOW_PRIVATE_LAN_ONLY metadata parsing (item 2)

    @Test
    fun `absent metadata key defaults to fail-closed true`() {
        assertTrue(parseAllowPrivateLanOnly(hasKey = false, rawValue = null))
    }

    @Test
    fun `Boolean metadata value is honored`() {
        assertTrue(parseAllowPrivateLanOnly(hasKey = true, rawValue = true))
        assertFalse(parseAllowPrivateLanOnly(hasKey = true, rawValue = false))
    }

    @Test
    fun `String metadata value is honored for robustness`() {
        assertTrue(parseAllowPrivateLanOnly(hasKey = true, rawValue = "true"))
        assertFalse(parseAllowPrivateLanOnly(hasKey = true, rawValue = "false"))
    }

    @Test
    fun `unparseable String metadata value defaults to fail-closed true`() {
        assertTrue(parseAllowPrivateLanOnly(hasKey = true, rawValue = "not-a-boolean"))
    }

    @Test
    fun `unexpected metadata value type defaults to fail-closed true`() {
        assertTrue(parseAllowPrivateLanOnly(hasKey = true, rawValue = 42))
    }

    // MARK: - isLocalIpv4Address (backs the ALLOW_PRIVATE_LAN_ONLY gate)

    @Test
    fun `loopback and RFC1918 ranges are local`() {
        assertTrue(isLocalIpv4Address("127.0.0.1"))
        assertTrue(isLocalIpv4Address("10.0.0.5"))
        assertTrue(isLocalIpv4Address("172.16.0.1"))
        assertTrue(isLocalIpv4Address("172.31.255.255"))
        assertTrue(isLocalIpv4Address("192.168.1.1"))
    }

    @Test
    fun `public and malformed addresses are not local`() {
        assertFalse(isLocalIpv4Address("8.8.8.8"))
        assertFalse(isLocalIpv4Address("172.32.0.1"))
        assertFalse(isLocalIpv4Address("172.15.0.1"))
        assertFalse(isLocalIpv4Address("not-an-ip"))
        assertFalse(isLocalIpv4Address("1.2.3"))
        assertFalse(isLocalIpv4Address("1.2.3.4.5"))
    }

    // MARK: - Protocol v2 first-frame shape (item 5)

    private fun connectOptions(
        token: String? = null,
        resumeToken: String? = null,
    ) = CordieriteConnectOptions(
        ip = "127.0.0.1",
        port = 8443,
        sessionId = "session-1",
        token = token,
        resumeToken = resumeToken,
        expiresAt = Int.MAX_VALUE,
        deviceManufacturer = null,
        deviceModel = null,
        deviceOs = null,
    )

    private val defaultDeviceFields =
        DefaultSessionClaimDeviceFields(manufacturer = "TestCo", model = "TestModel", os = "Android 99")

    @Test
    fun `claim frame carries protocol_version 2 and the token`() {
        val frame = buildFirstFrame(connectOptions(token = "claim-token"), defaultDeviceFields)

        assertEquals("session_claim", frame.getString("type"))
        assertEquals(2, frame.getInt("protocol_version"))
        assertEquals("session-1", frame.getString("session_id"))
        assertEquals("claim-token", frame.getString("token"))
        assertEquals("TestCo", frame.getString("device_manufacturer"))
        assertEquals("TestModel", frame.getString("device_model"))
        assertEquals("Android 99", frame.getString("device_os"))
        assertFalse(frame.has("resume_token"))
    }

    @Test
    fun `resume frame carries protocol_version 2 and the resume token instead of a claim`() {
        val frame = buildFirstFrame(connectOptions(resumeToken = "resume-token"), defaultDeviceFields)

        assertEquals("session_resume", frame.getString("type"))
        assertEquals(2, frame.getInt("protocol_version"))
        assertEquals("session-1", frame.getString("session_id"))
        assertEquals("resume-token", frame.getString("resume_token"))
        assertFalse(frame.has("token"))
        assertFalse(frame.has("device_manufacturer"))
    }

    @Test
    fun `resume token takes precedence when both are present`() {
        val frame = buildFirstFrame(connectOptions(token = "claim-token", resumeToken = "resume-token"), defaultDeviceFields)

        assertEquals("session_resume", frame.getString("type"))
        assertEquals("resume-token", frame.getString("resume_token"))
    }

    @Test
    fun `frame round-trips through JSON text as sent on the wire`() {
        val frame = buildFirstFrame(connectOptions(token = "claim-token"), defaultDeviceFields)
        val reparsed = JSONObject(frame.toString())

        assertEquals("session_claim", reparsed.getString("type"))
        assertEquals(2, reparsed.getInt("protocol_version"))
    }

    // MARK: - SPKI pin math parity with packages/cordierite/src/spki-pin.ts and iOS's spkiPin(for:)

    /**
     * Same fixture certificate (DER, base64) as
     * `packages/react-native/ios/CordieriteTests/CordieriteConnectionManagerTests.swift`, generated
     * once with:
     *
     *   openssl ecparam -name prime256v1 -genkey -noout -out key.pem
     *   openssl req -new -x509 -key key.pem -days 3650 -out cert.pem -subj "/CN=cordierite-test-fixture"
     *
     * Inlined rather than committed as a `.pem` fixture file per this repo's rule that no key
     * material — including throwaway test fixtures — is ever committed as a `.pem` file
     * (`git ls-files "*.pem"` must stay empty). Only the public certificate is needed; the private
     * key was discarded after generating the expected pin below.
     */
    private val fixtureCertificateDerBase64 =
        """
        MIIBmTCCAT+gAwIBAgIULhk1FL4F1t1m4VB8ZocEJJk6FSAwCgYIKoZIzj0EAwIw
        IjEgMB4GA1UEAwwXY29yZGllcml0ZS10ZXN0LWZpeHR1cmUwHhcNMjYwNzE1MTI1
        NTM1WhcNMzYwNzEyMTI1NTM1WjAiMSAwHgYDVQQDDBdjb3JkaWVyaXRlLXRlc3Qt
        Zml4dHVyZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABCdrnHdxoZyNKqLxncue
        /z1uh6STs1TnZI643d5kaELACPbJYhQtsDvMauVa5G6LOcAyfvfoboLEUbRhR2wM
        e26jUzBRMB0GA1UdDgQWBBTDnPXrKTIWOcLw3w3PWtpV2fHnFjAfBgNVHSMEGDAW
        gBTDnPXrKTIWOcLw3w3PWtpV2fHnFjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
        BAMCA0gAMEUCIEHI+FcyHWubSC/hTHLSgyioRwNdiaQXOJyElnVT6fjnAiEAsNWW
        oTlKSgWIcpT15v8orzlc8BOam0+LL6JUP15ESos=
        """.trimIndent().replace("\n", "")

    /**
     * Independently derived (Node.js) from the same certificate's key material using
     * `packages/cordierite/src/spki-pin.ts`'s `createSpkiPin` — must match for the same leaf
     * certificate (and does match the iOS fixture test's `expectedPin`).
     */
    private val expectedPin = "sha256/nq5dKPoAJatciRzJQExHFls6q7YpSN2YP49Jmd+++Io="

    @Test
    fun `SPKI digest over the fixture certificate matches the TypeScript and iOS implementations`() {
        val der = Base64.getDecoder().decode(fixtureCertificateDerBase64)
        val certificate =
            CertificateFactory
                .getInstance("X.509")
                .generateCertificate(der.inputStream()) as java.security.cert.X509Certificate

        // Same algorithm as `computeSpkiPin`/`PinningTrustManager` (SHA-256 over
        // `publicKey.encoded`, i.e. the SPKI DER), encoded with the JDK's standard Base64 instead
        // of `android.util.Base64` (unavailable on a plain JVM unit-test runtime) — the two
        // encoders produce identical output for this un-padded-newline, standard-alphabet case.
        val digest = MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded)
        val pin = "sha256/${Base64.getEncoder().encodeToString(digest)}"

        assertEquals(expectedPin, pin)
    }
}
