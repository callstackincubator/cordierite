package com.callstackincubator.cordierite

import android.content.ContextWrapper
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Pure-logic JVM tests for the Android connection layer. Runs on the plain JVM (no
 * Robolectric, no emulator) via `./gradlew :cordierite_react-native:testDebugUnitTest` from
 * `playground/android` (the autolinked consumer app).
 *
 * Not covered here (documented gap, same category as the iOS side): the actual socket
 * callback state machine driven through real
 * `okhttp3.WebSocketListener` callbacks, and `PinningTrustManager`/`computeSpkiPin` end-to-end
 * (both ultimately call `android.util.Base64`, which throws "not mocked" on a plain JVM unit-test
 * runtime without Robolectric or a device/emulator). The SPKI test below independently verifies
 * the same SHA-256-over-SPKI-DER math with a standard-library `Base64` encoder instead.
 */
class CordieriteConnectionManagerTest {
    @Before
    fun resetProcessResumeLeaseStore() {
        CordieriteProcessResumeLeaseStore.resetForTests()
    }

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

    // MARK: - Opt-in hardening: dev-mode pin trust (resolveTrustedPins)

    @Test
    fun `configured manifest pins always win regardless of linkPin or debuggability`() {
        for (isDebuggable in listOf(true, false)) {
            for (linkPin in listOf(null, "sha256/link-pin-should-be-ignored")) {
                assertEquals(
                    TrustedPinsResolution.Configured(setOf("sha256/embedded-pin")),
                    resolveTrustedPins(setOf("sha256/embedded-pin"), linkPin, isDebuggable),
                )
            }
        }
    }

    @Test
    fun `no manifest pins, debuggable, with linkPin trusts the linkPin only`() {
        assertEquals(
            TrustedPinsResolution.DevModeLinkPin("sha256/dev-mode-pin"),
            resolveTrustedPins(emptySet(), "sha256/dev-mode-pin", isDebuggable = true),
        )
    }

    @Test
    fun `no manifest pins, not debuggable, with linkPin still fails closed`() {
        assertEquals(
            TrustedPinsResolution.Missing,
            resolveTrustedPins(emptySet(), "sha256/dev-mode-pin", isDebuggable = false),
        )
    }

    @Test
    fun `no manifest pins, debuggable, without linkPin still fails closed`() {
        assertEquals(
            TrustedPinsResolution.Missing,
            resolveTrustedPins(emptySet(), null, isDebuggable = true),
        )
    }

    @Test
    fun `no manifest pins, debuggable, with empty linkPin still fails closed`() {
        assertEquals(
            TrustedPinsResolution.Missing,
            resolveTrustedPins(emptySet(), "", isDebuggable = true),
        )
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
        linkPin = null,
    )

    private val defaultDeviceFields =
        DefaultSessionClaimDeviceFields(manufacturer = "TestCo", model = "TestModel", os = "Android 99")

    @Test
    fun `valid claim ack stores schema v1 lease before the raw message callback`() {
        val options = connectOptions(token = "claim-token")
        val rawAck =
            JSONObject()
                .put("type", "session_ack")
                .put("session_id", "session-1")
                .put("status", "ok")
                .put("alias", "pixel-1")
                .put("resume_token", "resume-token-1")
                .put("keepalive_interval_s", 15)
                .put("grace_s", 600)
                .toString()
        val ownerGeneration = CordieriteProcessResumeLeaseStore.newOwnerGeneration()
        var leaseObservedByMessageCallback: Map<String, Any?>? = null

        val result =
            commitSessionAck(
                jsonObject = JSONObject(rawAck),
                rawText = rawAck,
                options = options,
                ownerGeneration = ownerGeneration,
                onAccepted = {},
                emitMessageRaw = {
                    leaseObservedByMessageCallback = CordieriteProcessResumeLeaseStore.getRecord()
                },
            )

        assertEquals(SessionAckCommitResult.accepted, result)
        assertNotNull(leaseObservedByMessageCallback)
        val record = leaseObservedByMessageCallback!!
        assertEquals(1, record["schemaVersion"])
        assertEquals("session-1", record["sessionId"])
        assertEquals("resume-token-1", record["resumeToken"])
        assertEquals("pixel-1", record["alias"])
        assertEquals(mapOf("ip" to "127.0.0.1", "port" to 8443), record["endpoint"])
        assertEquals(15.0, record["keepaliveIntervalS"])
        assertEquals(600.0, record["graceS"])
        assertEquals(null, record["disconnectedAtMs"])
    }

    @Test
    fun `resume ack atomically rotates the token and resets the disconnect timestamp`() {
        val ownerGeneration = CordieriteProcessResumeLeaseStore.newOwnerGeneration()
        val options = connectOptions(resumeToken = "resume-token-1")
        val firstAck =
            JSONObject()
                .put("type", "session_ack")
                .put("session_id", "session-1")
                .put("status", "ok")
                .put("alias", "pixel-1")
                .put("resume_token", "resume-token-1")
                .put("keepalive_interval_s", 15)
                .put("grace_s", 600)

        assertEquals(
            SessionAckCommitResult.accepted,
            commitSessionAck(firstAck, firstAck.toString(), options, ownerGeneration, {}, {}),
        )
        assertTrue(CordieriteProcessResumeLeaseStore.markDisconnected(ownerGeneration, "session-1", 1234L))
        assertEquals(1234L, CordieriteProcessResumeLeaseStore.get()?.disconnectedAtMs)

        val resumedAck =
            JSONObject(firstAck.toString())
                .put("resume_token", "resume-token-2")
        var callbackToken: String? = null
        val result =
            commitSessionAck(
                resumedAck,
                resumedAck.toString(),
                options,
                ownerGeneration,
                {},
                { callbackToken = CordieriteProcessResumeLeaseStore.get()?.resumeToken },
            )

        assertEquals(SessionAckCommitResult.accepted, result)
        assertEquals("resume-token-2", callbackToken)
        assertEquals(null, CordieriteProcessResumeLeaseStore.get()?.disconnectedAtMs)
    }

    @Test
    fun `stale teardown cannot mark or clear a newer manager lease`() {
        val olderOwner = CordieriteProcessResumeLeaseStore.newOwnerGeneration()
        val newerOwner = CordieriteProcessResumeLeaseStore.newOwnerGeneration()
        val options = connectOptions(resumeToken = "resume-token")

        fun ack(token: String) =
            JSONObject()
                .put("type", "session_ack")
                .put("session_id", "session-1")
                .put("status", "ok")
                .put("alias", "pixel-1")
                .put("resume_token", token)
                .put("keepalive_interval_s", 15)
                .put("grace_s", 600)

        val oldAck = ack("resume-token-old")
        val newAck = ack("resume-token-new")
        assertEquals(
            SessionAckCommitResult.accepted,
            commitSessionAck(oldAck, oldAck.toString(), options, olderOwner, {}, {}),
        )
        assertEquals(
            SessionAckCommitResult.accepted,
            commitSessionAck(newAck, newAck.toString(), options, newerOwner, {}, {}),
        )
        val staleAck = ack("resume-token-stale")
        assertEquals(
            SessionAckCommitResult.stale,
            commitSessionAck(staleAck, staleAck.toString(), options, olderOwner, {}, {}),
        )

        assertFalse(CordieriteProcessResumeLeaseStore.markDisconnected(olderOwner, "session-1", 1000L))
        assertFalse(CordieriteProcessResumeLeaseStore.clear(olderOwner))
        assertEquals("resume-token-new", CordieriteProcessResumeLeaseStore.get()?.resumeToken)
        assertEquals(null, CordieriteProcessResumeLeaseStore.get()?.disconnectedAtMs)

        assertTrue(CordieriteProcessResumeLeaseStore.markDisconnected(newerOwner, "session-1", 2000L))
        assertEquals(2000L, CordieriteProcessResumeLeaseStore.get()?.disconnectedAtMs)
        assertTrue(CordieriteProcessResumeLeaseStore.clear(newerOwner))
        assertEquals(null, CordieriteProcessResumeLeaseStore.get())
    }

    @Test
    fun `manager resume lease getter returns null then the exact schema record`() {
        val ownerGeneration = CordieriteProcessResumeLeaseStore.newOwnerGeneration()
        val manager = managerForTest(ownerGeneration)

        assertNull(manager.getResumeLeaseRecord())
        assertTrue(
            CordieriteProcessResumeLeaseStore.replace(
                ownerGeneration,
                CordieriteResumeLeaseV1(
                    sessionId = "session-1",
                    resumeToken = "resume-token-1",
                    alias = "pixel-1",
                    endpoint = CordieriteResumeEndpoint("127.0.0.1", 8443),
                    keepaliveIntervalS = 15.0,
                    graceS = 600.0,
                    disconnectedAtMs = 1_234L,
                ),
            ),
        )

        assertEquals(
            linkedMapOf(
                "schemaVersion" to 1,
                "sessionId" to "session-1",
                "resumeToken" to "resume-token-1",
                "alias" to "pixel-1",
                "endpoint" to linkedMapOf("ip" to "127.0.0.1", "port" to 8443),
                "keepaliveIntervalS" to 15.0,
                "graceS" to 600.0,
                "disconnectedAtMs" to 1_234L,
            ),
            manager.getResumeLeaseRecord(),
        )
    }

    @Test
    fun `manager resume lease clear is guarded by its owner generation`() {
        val olderOwner = CordieriteProcessResumeLeaseStore.newOwnerGeneration()
        val newerOwner = CordieriteProcessResumeLeaseStore.newOwnerGeneration()
        val oldManager = managerForTest(olderOwner)
        val newManager = managerForTest(newerOwner)
        assertTrue(
            CordieriteProcessResumeLeaseStore.replace(
                newerOwner,
                CordieriteResumeLeaseV1(
                    sessionId = "session-1",
                    resumeToken = "resume-token-new",
                    alias = "pixel-1",
                    endpoint = CordieriteResumeEndpoint("127.0.0.1", 8443),
                    keepaliveIntervalS = 15.0,
                    graceS = 600.0,
                    disconnectedAtMs = null,
                ),
            ),
        )

        assertFalse(oldManager.clearResumeLease())
        assertEquals("resume-token-new", CordieriteProcessResumeLeaseStore.get()?.resumeToken)
        assertTrue(newManager.clearResumeLease())
        assertNull(CordieriteProcessResumeLeaseStore.get())
    }

    @Test
    fun `manager invalidation preserves and marks the lease while explicit close clears it`() {
        val invalidatedOwner = CordieriteProcessResumeLeaseStore.newOwnerGeneration()
        val options = connectOptions(token = "claim-token")
        val ack =
            JSONObject()
                .put("type", "session_ack")
                .put("session_id", "session-1")
                .put("status", "ok")
                .put("alias", "pixel-1")
                .put("resume_token", "resume-token-1")
                .put("keepalive_interval_s", 15)
                .put("grace_s", 600)
        assertEquals(
            SessionAckCommitResult.accepted,
            commitSessionAck(ack, ack.toString(), options, invalidatedOwner, {}, {}),
        )

        val invalidatedManager = managerForTest(invalidatedOwner)
        invalidatedManager.javaClass.getDeclaredField("activeSessionId").apply {
            isAccessible = true
            set(invalidatedManager, "session-1")
        }
        val invalidated = CountDownLatch(1)
        invalidatedManager.invalidate { invalidated.countDown() }
        assertTrue(invalidated.await(2, TimeUnit.SECONDS))
        assertEquals("resume-token-1", CordieriteProcessResumeLeaseStore.get()?.resumeToken)
        assertNotNull(CordieriteProcessResumeLeaseStore.get()?.disconnectedAtMs)
        val firstDisconnectedAtMs = CordieriteProcessResumeLeaseStore.get()?.disconnectedAtMs
        val invalidatedAgain = CountDownLatch(1)
        invalidatedManager.invalidate { invalidatedAgain.countDown() }
        assertTrue(invalidatedAgain.await(2, TimeUnit.SECONDS))
        assertEquals(firstDisconnectedAtMs, CordieriteProcessResumeLeaseStore.get()?.disconnectedAtMs)

        val explicitlyClosedOwner = CordieriteProcessResumeLeaseStore.newOwnerGeneration()
        val nextAck = JSONObject(ack.toString()).put("resume_token", "resume-token-2")
        assertEquals(
            SessionAckCommitResult.accepted,
            commitSessionAck(nextAck, nextAck.toString(), options, explicitlyClosedOwner, {}, {}),
        )
        val explicitlyClosedManager = managerForTest(explicitlyClosedOwner)
        val closed = CountDownLatch(1)
        explicitlyClosedManager.close { closed.countDown() }
        assertTrue(closed.await(2, TimeUnit.SECONDS))
        assertNull(CordieriteProcessResumeLeaseStore.get())
    }

    @Test
    fun `malformed or incomplete ack neither replaces the lease nor becomes accepted`() {
        val options = connectOptions(resumeToken = "resume-token-old")
        val validAck =
            JSONObject()
                .put("type", "session_ack")
                .put("session_id", "session-1")
                .put("status", "ok")
                .put("alias", "pixel-1")
                .put("resume_token", "resume-token-old")
                .put("keepalive_interval_s", 15)
                .put("grace_s", 600)
        val malformedAcks =
            listOf(
                JSONObject(validAck.toString()).apply { remove("alias") },
                JSONObject(validAck.toString()).put("resume_token", ""),
                JSONObject(validAck.toString()).put("alias", "x".repeat(129)),
                JSONObject(validAck.toString()).put("keepalive_interval_s", "15"),
                JSONObject(validAck.toString()).put("keepalive_interval_s", 0),
                JSONObject(validAck.toString()).put("grace_s", -1),
                JSONObject(validAck.toString()).put("session_id", "wrong-session"),
                JSONObject(validAck.toString()).put("status", "rejected"),
            )

        malformedAcks.forEach { malformedAck ->
            CordieriteProcessResumeLeaseStore.resetForTests()
            val ownerGeneration = CordieriteProcessResumeLeaseStore.newOwnerGeneration()
            assertEquals(
                SessionAckCommitResult.accepted,
                commitSessionAck(validAck, validAck.toString(), options, ownerGeneration, {}, {}),
            )
            var transitioned = false
            var emitted = false

            val result =
                commitSessionAck(
                    malformedAck,
                    malformedAck.toString(),
                    options,
                    ownerGeneration,
                    { transitioned = true },
                    { emitted = true },
                )

            assertEquals(SessionAckCommitResult.invalid, result)
            assertFalse(transitioned)
            assertFalse(emitted)
            assertEquals("resume-token-old", CordieriteProcessResumeLeaseStore.get()?.resumeToken)
        }
    }

    private fun managerForTest(ownerGeneration: Long) =
        CordieriteConnectionManager(
            context = ContextWrapper(null),
            emitStateChange = {},
            emitMessageRaw = {},
            emitError = {},
            emitClose = {},
            ownerGeneration = ownerGeneration,
        )

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
