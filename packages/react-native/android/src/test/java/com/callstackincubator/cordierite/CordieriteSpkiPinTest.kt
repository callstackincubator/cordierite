package com.callstackincubator.cordierite

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64

/**
 * Robolectric-backed tests for the TLS pinning decision path.
 *
 * Everything here calls the *shipped* functions — `computeSpkiPin` and
 * `PinningTrustManager.checkServerTrusted` — which both reach `android.util.Base64`. That class is
 * a stub in the plain-JVM android.jar and throws "not mocked", which is why these tests live apart
 * from [CordieriteConnectionManagerTest] (still a plain-JVM class, still the fast path) and pull in
 * Robolectric to provide a real android.jar runtime. No emulator is involved: this runs inside the
 * same `:cordierite_react-native:testDebugUnitTest` task.
 *
 * The SDK level is pinned rather than inherited from the consuming app's `compileSdk` so the pin
 * math is exercised at a level Robolectric ships an android-all jar for, no matter which
 * `compileSdkVersion` the autolinked host project sets.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CordieriteSpkiPinTest {
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

    private val fixtureCertificate: X509Certificate
        get() =
            CertificateFactory
                .getInstance("X.509")
                .generateCertificate(Base64.getDecoder().decode(fixtureCertificateDerBase64).inputStream())
                as X509Certificate

    // MARK: - SPKI pin parity with packages/cordierite/src/spki-pin.ts and iOS's spkiPin(for:)

    @Test
    fun `computeSpkiPin matches the TypeScript and iOS implementations for the same certificate`() {
        assertEquals(expectedPin, computeSpkiPin(fixtureCertificate))
    }

    @Test
    fun `computeSpkiPin emits an unwrapped single-line pin`() {
        // NO_WRAP matters: a pin carrying a newline would never string-compare equal to the pin the
        // CLI puts in the bootstrap link or the manifest, so every connection would fail closed.
        val pin = computeSpkiPin(fixtureCertificate)

        assertEquals(pin.trim(), pin)
        assertEquals(1, pin.lines().size)
        assertEquals("sha256/", pin.take("sha256/".length))
    }

    // MARK: - PinningTrustManager decision path

    @Test
    fun `server certificate whose pin is accepted passes verification`() {
        PinningTrustManager(setOf(expectedPin))
            .checkServerTrusted(arrayOf(fixtureCertificate), "ECDHE_ECDSA")
    }

    @Test
    fun `server certificate is still accepted when the pin set holds other pins too`() {
        PinningTrustManager(setOf("sha256/some-other-pin", expectedPin))
            .checkServerTrusted(arrayOf(fixtureCertificate), "ECDHE_ECDSA")
    }

    @Test
    fun `server certificate whose pin is not accepted is rejected`() {
        assertThrows(CertificateException::class.java) {
            PinningTrustManager(setOf("sha256/some-other-pin"))
                .checkServerTrusted(arrayOf(fixtureCertificate), "ECDHE_ECDSA")
        }
    }

    @Test
    fun `an empty pin set rejects every server certificate`() {
        assertThrows(CertificateException::class.java) {
            PinningTrustManager(emptySet())
                .checkServerTrusted(arrayOf(fixtureCertificate), "ECDHE_ECDSA")
        }
    }

    @Test
    fun `an empty certificate chain is rejected rather than treated as trusted`() {
        assertThrows(CertificateException::class.java) {
            PinningTrustManager(setOf(expectedPin))
                .checkServerTrusted(emptyArray(), "ECDHE_ECDSA")
        }
    }

    @Test
    fun `client certificates are never trusted`() {
        assertThrows(CertificateException::class.java) {
            PinningTrustManager(setOf(expectedPin))
                .checkClientTrusted(arrayOf(fixtureCertificate), "ECDHE_ECDSA")
        }
    }

    @Test
    fun `no issuers are advertised as accepted`() {
        assertEquals(0, PinningTrustManager(setOf(expectedPin)).acceptedIssuers.size)
    }
}
