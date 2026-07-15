package com.callstackincubator.cordierite

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

private const val ANDROID_PINS_KEY = "com.callstackincubator.cordierite.CLI_PINS"
private const val ANDROID_PRIVATE_LAN_KEY = "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY"
private const val PROTOCOL_VERSION = 2

/** Matches `config.json`'s `keepaliveIntervalSeconds` default (ARCHITECTURE §3). */
private const val DEFAULT_PING_INTERVAL_SECONDS = 15L

private enum class CordieriteConnectionState {
    idle,
    connecting,
    active,
    closed,
    error,
}

internal data class CordieriteConnectOptions(
    val ip: String,
    val port: Int,
    val sessionId: String,
    /** Claim token. Required unless `resumeToken` is present (protocol v2 `session_resume`). */
    val token: String?,
    /** When present, native sends `session_resume` as the first frame instead of `session_claim`. */
    val resumeToken: String?,
    val expiresAt: Int,
    val deviceManufacturer: String?,
    val deviceModel: String?,
    val deviceOs: String?,
) {
    companion object {
        fun fromReadableMap(value: com.facebook.react.bridge.ReadableMap): CordieriteConnectOptions {
            val ip = value.getString("ip") ?: throw IllegalArgumentException("Invalid Cordierite IP.")
            val port = value.getInt("port")
            val sessionId = value.getString("sessionId") ?: throw IllegalArgumentException("Invalid Cordierite session ID.")
            val expiresAt = value.getInt("expiresAt")

            fun optionalDeviceString(key: String): String? {
                if (!value.hasKey(key)) {
                    return null
                }
                val s = value.getString(key)?.trim() ?: return null
                return s.takeIf { it.isNotEmpty() }
            }

            val token = optionalDeviceString("token")
            val resumeToken = optionalDeviceString("resumeToken")

            if (token == null && resumeToken == null) {
                throw IllegalArgumentException("Cordierite connect requires either token or resumeToken.")
            }

            return CordieriteConnectOptions(
                ip,
                port,
                sessionId,
                token,
                resumeToken,
                expiresAt,
                optionalDeviceString("deviceManufacturer"),
                optionalDeviceString("deviceModel"),
                optionalDeviceString("deviceOs"),
            )
        }
    }
}

internal data class CordieriteErrorDetails(
    val code: String,
    val message: String,
    val phase: String,
    val nativeCode: String? = null,
    val closeReason: String? = null,
    val isRetryable: Boolean? = null,
    val hint: String? = null,
)

/** Always non-empty strings so `session_claim` matches iOS (three keys always present on the wire). */
internal data class DefaultSessionClaimDeviceFields(
    val manufacturer: String,
    val model: String,
    val os: String,
)

private fun defaultAndroidSessionClaimDeviceFields(): DefaultSessionClaimDeviceFields {
    val manufacturer = Build.MANUFACTURER?.trim()?.takeIf { it.isNotEmpty() } ?: "Unknown"
    val model = Build.MODEL?.trim()?.takeIf { it.isNotEmpty() } ?: "Unknown"
    val release =
        Build.VERSION.RELEASE
            ?.trim()
            ?.takeIf { it.isNotEmpty() } ?: ""
    val os = if (release.isNotEmpty()) "Android $release" else "Android"
    return DefaultSessionClaimDeviceFields(manufacturer, model, os)
}

private fun mergeSessionClaimDeviceFields(
    options: CordieriteConnectOptions,
    defaults: DefaultSessionClaimDeviceFields,
): DefaultSessionClaimDeviceFields =
    DefaultSessionClaimDeviceFields(
        options.deviceManufacturer ?: defaults.manufacturer,
        options.deviceModel ?: defaults.model,
        options.deviceOs ?: defaults.os,
    )

/**
 * Fail-closed default (matches iOS `allowPrivateLanOnly` and ARCHITECTURE §11): absent the
 * manifest key, only local/LAN addresses are allowed. The config plugin writes a real Boolean via
 * `<meta-data ... android:value="true"/>` (`Bundle` stores it as `Boolean`), but some historical
 * writers emitted a String `"true"/"false"` — accept both. Pure function (no `Bundle`/`Context`
 * dependency) so it is unit-testable on the plain JVM.
 */
internal fun parseAllowPrivateLanOnly(
    hasKey: Boolean,
    rawValue: Any?,
): Boolean {
    if (!hasKey) {
        return true
    }

    return when (rawValue) {
        is Boolean -> rawValue
        is String -> rawValue.toBooleanStrictOrNull() ?: true
        else -> true
    }
}

/**
 * Builds the first protocol v2 frame sent on a fresh socket: `session_claim` (using `token`) or,
 * when `resumeToken` is given instead, `session_resume`. Pure function so the frame shape is
 * unit-testable without a live socket.
 */
internal fun buildFirstFrame(
    options: CordieriteConnectOptions,
    defaults: DefaultSessionClaimDeviceFields,
): JSONObject {
    val resumeToken = options.resumeToken
    if (resumeToken != null) {
        return JSONObject()
            .put("type", "session_resume")
            .put("protocol_version", PROTOCOL_VERSION)
            .put("session_id", options.sessionId)
            .put("resume_token", resumeToken)
    }

    // Unreachable in practice: `CordieriteConnectOptions.fromReadableMap` already requires one of
    // `token`/`resumeToken` to be present.
    val token = options.token ?: throw IllegalStateException("Cordierite connect requires a claim token.")
    val device = mergeSessionClaimDeviceFields(options, defaults)

    return JSONObject()
        .put("type", "session_claim")
        .put("protocol_version", PROTOCOL_VERSION)
        .put("session_id", options.sessionId)
        .put("token", token)
        .put("device_manufacturer", device.manufacturer)
        .put("device_model", device.model)
        .put("device_os", device.os)
}

/**
 * Pins the leaf cert by SHA-256 over SubjectPublicKeyInfo DER (`publicKey.encoded`), same format as
 * `sha256/...` in docs — must match iOS SPKI hashing for the same CLI certificate. Extracted as a
 * top-level pure function (rather than a private method on `PinningTrustManager`) so it is
 * unit-testable against the same fixture certificate as
 * `packages/cordierite/src/spki-pin.ts` and iOS's `spkiPin(for:)`. Untouched from the pre-task-10
 * implementation — verified correct, out of scope for this hardening pass.
 */
internal fun computeSpkiPin(certificate: X509Certificate): String {
    val digest =
        java.security.MessageDigest
            .getInstance("SHA-256")
            .digest(certificate.publicKey.encoded)
    val base64 = android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP)
    return "sha256/$base64"
}

internal class PinningTrustManager(
    private val acceptedPins: Set<String>,
) : X509TrustManager {
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

    override fun checkClientTrusted(
        chain: Array<X509Certificate>,
        authType: String,
    ): Unit = throw CertificateException("Client certificates are not supported.")

    override fun checkServerTrusted(
        chain: Array<X509Certificate>,
        authType: String,
    ) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("Missing server certificate.")
        val pin = computeSpkiPin(leaf)

        if (!acceptedPins.contains(pin)) {
            throw CertificateException("Server certificate pin mismatch.")
        }
    }
}

internal class CordieriteConnectionManager(
    private val context: Context,
    private val emitStateChange: (String) -> Unit,
    private val emitMessageRaw: (String) -> Unit,
    private val emitError: (CordieriteErrorDetails) -> Unit,
    private val emitClose: (Map<String, Any?>) -> Unit,
) {
    /**
     * Every mutation and read of connection state goes through this single-thread executor — the
     * TurboModule bridge calls `connect`/`send`/`close` from the JS thread, and OkHttp invokes
     * `WebSocketListener` callbacks from its own dispatcher threads; routing everything through one
     * serial queue (mirroring iOS's actor) makes two rapid `connect()` calls deterministically yield
     * one socket and one `already_connecting` rejection, and prevents `send()`'s
     * check-then-use from racing `cleanup()`.
     */
    private val executor =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "CordieriteConnection").apply { isDaemon = true }
        }

    private var state = CordieriteConnectionState.idle
        set(value) {
            field = value
            stateSnapshot = value.name
            emitStateChange(value.name)
        }

    /**
     * Mirrors `state.name` so the synchronous TurboModule `getState()` can be answered without
     * hopping onto [executor]. Written only from executor-isolated code, immediately after `state`
     * changes, so it is never stale by more than the time it takes to observe it.
     */
    @Volatile
    private var stateSnapshot = CordieriteConnectionState.idle.name

    /** Lazily created once; per-connect TLS/ping configuration is layered on via `newBuilder()`. */
    private var sharedOkHttpClient: OkHttpClient? = null
    private var webSocket: WebSocket? = null
    private var activeSessionId: String? = null
    private var pendingSessionId: String? = null
    private var configuredPins: Set<String> = emptySet()
    private var allowPrivateLanOnly = true
    private var closeEventPending = false

    /** Resolves/rejects the in-flight `connect()` promise; consumed exactly once per attempt. */
    private var pendingConnectCompletion: ((Throwable?) -> Unit)? = null

    /**
     * OkHttp's `pingInterval` is a client-level (not per-message) setting, so it must be baked into
     * the per-connect client *before* the socket exists — before any ack can tell us the
     * server-negotiated interval. We seed it with the daemon's documented default and update it
     * from each ack's `keepalive_interval_s` (native parses the ack it already forwards, mirroring
     * the iOS plumbing choice from task 09) so the *next* connect/resume uses the negotiated value.
     */
    private var negotiatedPingIntervalSeconds = DEFAULT_PING_INTERVAL_SECONDS

    fun connect(
        rawOptions: com.facebook.react.bridge.ReadableMap,
        completion: (Throwable?) -> Unit,
    ) {
        val options =
            try {
                CordieriteConnectOptions.fromReadableMap(rawOptions)
            } catch (e: Exception) {
                completion(e)
                return
            }

        executor.execute {
            try {
                performConnect(options, completion)
            } catch (e: Exception) {
                completion(e)
            }
        }
    }

    fun send(
        message: String,
        completion: (Throwable?) -> Unit,
    ) {
        executor.execute {
            try {
                performSend(message)
                completion(null)
            } catch (e: Exception) {
                completion(e)
            }
        }
    }

    fun close(completion: () -> Unit) {
        executor.execute {
            performClose()
            completion()
        }
    }

    fun getState(): String = stateSnapshot

    private fun performConnect(
        options: CordieriteConnectOptions,
        completion: (Throwable?) -> Unit,
    ) {
        if (state == CordieriteConnectionState.connecting || state == CordieriteConnectionState.active) {
            completion(IllegalStateException("A Cordierite session is already connecting or active."))
            return
        }

        try {
            loadConfiguration()
        } catch (e: Exception) {
            completion(e)
            return
        }

        val now = (System.currentTimeMillis() / 1000L).toInt()
        if (options.expiresAt <= now) {
            completion(IllegalArgumentException("Cordierite bootstrap payload has expired."))
            return
        }

        if (allowPrivateLanOnly && !isLocalIpv4Address(options.ip)) {
            completion(IllegalArgumentException("Cordierite only allows local IPv4 addresses."))
            return
        }

        cleanup()

        pendingSessionId = options.sessionId
        closeEventPending = true
        pendingConnectCompletion = completion
        state = CordieriteConnectionState.connecting

        // Guarded separately from the validation checks above: those `return` before any state
        // mutation, but everything from here on runs after `pendingConnectCompletion`/`state` are
        // already set, so a thrown exception must reset them via `completeConnect`/`cleanup()`
        // instead of only rejecting the promise — otherwise `state` would wedge at `connecting`
        // forever with no socket to ever transition it out, the exact defect this task fixes.
        try {
            val trustManager = PinningTrustManager(configuredPins)
            val sslSocketFactory = createSslSocketFactory(trustManager)

            // URL uses raw IP (`wss://ip:port`); hostname verification is not applicable. Pinning enforces identity.
            val connectClient =
                getOrCreateSharedClient()
                    .newBuilder()
                    .sslSocketFactory(sslSocketFactory, trustManager)
                    .hostnameVerifier(HostnameVerifier { _, _ -> true })
                    .pingInterval(negotiatedPingIntervalSeconds, TimeUnit.SECONDS)
                    .build()

            val request =
                Request
                    .Builder()
                    .url("wss://${options.ip}:${options.port}")
                    .build()

            webSocket = connectClient.newWebSocket(request, ConnectionListener(options))
        } catch (e: Exception) {
            state = CordieriteConnectionState.error
            closeEventPending = false
            cleanup()
            completeConnect(e)
        }
    }

    private fun performSend(message: String) {
        val currentSessionId = activeSessionId ?: throw IllegalStateException("Cordierite session is not active.")
        if (state != CordieriteConnectionState.active) {
            throw IllegalStateException("Cordierite session is not active.")
        }

        val parsed =
            try {
                JSONObject(message)
            } catch (_: Throwable) {
                throw IllegalArgumentException("Outgoing Cordierite messages must be JSON objects.")
            }

        val sessionId = parsed.optString("session_id")
        if (sessionId != currentSessionId) {
            throw IllegalArgumentException("Outgoing Cordierite message session_id does not match the active session.")
        }

        val socket = webSocket ?: throw IllegalStateException("Cordierite socket is not connected.")
        if (!socket.send(message)) {
            val failureMessage = "Cordierite message could not be sent because the socket is closing."
            failSocketSend(socket, failureMessage)
            throw IllegalStateException(failureMessage)
        }
    }

    private fun performClose() {
        val socket = webSocket

        if (socket == null) {
            cleanup()
            state = CordieriteConnectionState.closed
            emitClose(emptyMap())
            return
        }

        closeEventPending = true
        // If a connect() attempt is still in flight (state == connecting, no onOpen yet), closing
        // now means it will never reach onOpen/onFailure — reject its promise instead of leaving
        // it pending forever. No-op if connect() already resolved.
        completeConnect(IllegalStateException("Cordierite connection was closed before it finished connecting."))
        socket.close(1000, "client_close")
    }

    /** All `WebSocketListener` callbacks re-enter [executor] before touching any state. */
    private inner class ConnectionListener(
        private val options: CordieriteConnectOptions,
    ) : WebSocketListener() {
        override fun onOpen(
            webSocket: WebSocket,
            response: Response,
        ) {
            executor.execute { handleOpen(webSocket, options) }
        }

        override fun onMessage(
            webSocket: WebSocket,
            text: String,
        ) {
            executor.execute { handleIncomingMessage(webSocket, text) }
        }

        override fun onMessage(
            webSocket: WebSocket,
            bytes: ByteString,
        ) {
            executor.execute { handleBinaryMessage(webSocket) }
        }

        override fun onClosing(
            webSocket: WebSocket,
            code: Int,
            reason: String,
        ) {
            executor.execute {
                if (webSocket === this@CordieriteConnectionManager.webSocket) {
                    // Acknowledge the peer's close handshake; the terminal `close` event (and its
                    // dedupe against `onFailure`) is emitted from `onClosed` only.
                    webSocket.close(code, reason)
                }
            }
        }

        override fun onClosed(
            webSocket: WebSocket,
            code: Int,
            reason: String,
        ) {
            executor.execute { handleClosed(webSocket, code, reason) }
        }

        override fun onFailure(
            webSocket: WebSocket,
            t: Throwable,
            response: Response?,
        ) {
            executor.execute { handleFailure(webSocket, t, response) }
        }
    }

    private fun handleOpen(
        socket: WebSocket,
        options: CordieriteConnectOptions,
    ) {
        if (socket !== webSocket) {
            // Stale callback from a socket superseded by a later connect()/cleanup().
            return
        }

        val firstFrame = buildFirstFrame(options, defaultAndroidSessionClaimDeviceFields())

        if (socket.send(firstFrame.toString())) {
            completeConnect(null)
            return
        }

        val message = "Cordierite session claim could not be sent because the socket is closing."
        failSocketSend(socket, message)
        completeConnect(IllegalStateException(message))
    }

    private fun handleBinaryMessage(socket: WebSocket) {
        if (socket !== webSocket) {
            return
        }

        state = CordieriteConnectionState.error
        publishError(
            CordieriteErrorDetails(
                code = "invalid_message",
                message = "Binary Cordierite messages are not supported.",
                phase = "transport",
                nativeCode = "binary_not_supported",
            ),
        )
        socket.close(1003, "binary_not_supported")
    }

    private fun handleClosed(
        socket: WebSocket,
        code: Int,
        reason: String,
    ) {
        if (socket !== webSocket) {
            return
        }

        cleanup()
        if (state != CordieriteConnectionState.error) {
            state = CordieriteConnectionState.closed
        }
        if (closeEventPending) {
            emitClose(
                mapOf(
                    "code" to code,
                    "reason" to reason,
                ),
            )
            closeEventPending = false
        }
    }

    private fun handleFailure(
        socket: WebSocket,
        t: Throwable,
        response: Response?,
    ) {
        if (socket !== webSocket) {
            return
        }

        state = CordieriteConnectionState.error
        publishError(classifyConnectionFailure(t, response))
        // Reject the in-flight connect() promise (pin mismatch, TLS failure, timeout, abrupt
        // transport death before a claim/resume ack ever arrived). No-op if already resolved.
        completeConnect(t)
        cleanup()
        if (closeEventPending) {
            emitClose(emptyMap())
            closeEventPending = false
        }
    }

    private fun handleIncomingMessage(
        socket: WebSocket,
        text: String,
    ) {
        if (socket !== webSocket) {
            return
        }

        val jsonObject =
            try {
                JSONObject(text)
            } catch (_: Throwable) {
                state = CordieriteConnectionState.error
                publishError(
                    CordieriteErrorDetails(
                        code = "invalid_message",
                        message = "Incoming Cordierite message must be a JSON object.",
                        phase = "transport",
                        nativeCode = "invalid_message",
                    ),
                )
                socket.close(1008, "invalid_message")
                return
            }

        if (state == CordieriteConnectionState.connecting) {
            val sessionId = jsonObject.optString("session_id")
            val isValidAck =
                jsonObject.optString("type") == "session_ack" &&
                    jsonObject.optString("status") == "ok" &&
                    sessionId == pendingSessionId

            if (!isValidAck) {
                state = CordieriteConnectionState.error
                val closeReason = ackCloseReason(jsonObject)
                publishError(classifyHandshakeCloseReason(closeReason))
                socket.close(1008, closeReason ?: "invalid_ack")
                return
            }

            activeSessionId = pendingSessionId
            pendingSessionId = null
            state = CordieriteConnectionState.active

            val keepaliveIntervalSeconds = jsonObject.optLong("keepalive_interval_s", -1)
            if (keepaliveIntervalSeconds > 0) {
                negotiatedPingIntervalSeconds = keepaliveIntervalSeconds
            }
            return
        }

        val currentSessionId = activeSessionId
        val sessionId = jsonObject.optString("session_id")

        if (currentSessionId == null || sessionId != currentSessionId) {
            state = CordieriteConnectionState.error
            publishError(
                CordieriteErrorDetails(
                    code = "session_mismatch",
                    message = "Incoming Cordierite message does not match the active session.",
                    phase = "session",
                    nativeCode = "session_mismatch",
                ),
            )
            socket.close(1008, "session_mismatch")
            return
        }

        emitMessageRaw(text)
    }

    @Suppress("DEPRECATION") // Bundle.get(String) is deprecated but is the only way to read the raw value's type.
    private fun loadConfiguration() {
        val applicationInfo =
            context.packageManager.getApplicationInfo(
                context.packageName,
                PackageManager.GET_META_DATA,
            )
        val metaData = applicationInfo.metaData
        val pinsJson = metaData?.getString(ANDROID_PINS_KEY).orEmpty()

        if (pinsJson.isEmpty()) {
            throw IllegalStateException("Cordierite CLI pins are not configured in AndroidManifest.xml.")
        }

        val parsedPins = JSONArray(pinsJson)
        configuredPins =
            buildSet {
                for (index in 0 until parsedPins.length()) {
                    add(parsedPins.getString(index))
                }
            }

        allowPrivateLanOnly =
            parseAllowPrivateLanOnly(
                hasKey = metaData?.containsKey(ANDROID_PRIVATE_LAN_KEY) == true,
                rawValue = metaData?.get(ANDROID_PRIVATE_LAN_KEY),
            )
    }

    private fun getOrCreateSharedClient(): OkHttpClient {
        sharedOkHttpClient?.let { return it }

        val client =
            OkHttpClient
                .Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build()
        sharedOkHttpClient = client
        return client
    }

    /**
     * Consumed exactly once per connect attempt: resolves on a successful first-frame send
     * (`onOpen`), rejects on transport failure (`onFailure`) or a synchronous validation error.
     * Never waits for the server's ack — see `NativeCordierite.ts`'s `connect` doc comment.
     */
    private fun completeConnect(error: Throwable?) {
        val completion = pendingConnectCompletion ?: return
        pendingConnectCompletion = null
        completion(error)
    }

    /**
     * Cancels the current socket (if any) and returns idle connections in the shared client's pool,
     * without shutting down the shared dispatcher — the shared `OkHttpClient` (and its thread pool)
     * outlives any single connection attempt.
     */
    private fun cleanup() {
        webSocket?.cancel()
        webSocket = null
        sharedOkHttpClient?.connectionPool?.evictAll()
        activeSessionId = null
        pendingSessionId = null
    }

    private fun failSocketSend(
        webSocket: WebSocket,
        message: String,
    ) {
        state = CordieriteConnectionState.error
        publishError(
            CordieriteErrorDetails(
                code = "send_failed",
                message = message,
                phase = "transport",
                nativeCode = "send_failed",
                isRetryable = false,
            ),
        )
        closeEventPending = true
        webSocket.close(1011, "send_failed")
    }

    private fun publishError(details: CordieriteErrorDetails) {
        emitError(details)
    }

    private fun classifyConnectionFailure(
        throwable: Throwable,
        response: Response?,
    ): CordieriteErrorDetails {
        val message = throwable.message ?: "Cordierite WebSocket connection failed."
        val normalized = message.lowercase()

        if (throwable is CertificateException || normalized.contains("pin mismatch")) {
            return CordieriteErrorDetails(
                code = "pin_mismatch",
                message = "Cordierite host certificate pin mismatch.",
                phase = "tls",
                nativeCode = response?.code?.toString(),
                isRetryable = false,
                hint = "Verify cliPins matches the fingerprint from cordierite keygen and rebuild the native app.",
            )
        }

        if (normalized.contains("unable to resolve host") ||
            normalized.contains("failed to connect") ||
            normalized.contains("timed out") ||
            normalized.contains("timeout")
        ) {
            return CordieriteErrorDetails(
                code = "host_unreachable",
                message = message,
                phase = "connect",
                nativeCode = response?.code?.toString(),
                isRetryable = true,
                hint = "Check that the host is running, the advertised IP is reachable from the app, and local networking is allowed.",
            )
        }

        if (normalized.contains("ssl") || normalized.contains("tls") || normalized.contains("certificate")) {
            return CordieriteErrorDetails(
                code = "tls_handshake_failed",
                message = message,
                phase = "tls",
                nativeCode = response?.code?.toString(),
                isRetryable = false,
                hint = "Check the host certificate, trusted pins, and device clock.",
            )
        }

        return CordieriteErrorDetails(
            code = "connection_failed",
            message = message,
            phase = "connect",
            nativeCode = response?.code?.toString(),
            isRetryable = true,
        )
    }

    private fun ackCloseReason(jsonObject: JSONObject): String? {
        val reason = jsonObject.optString("reason")
        return reason.takeIf { it.isNotEmpty() }
    }

    private fun classifyHandshakeCloseReason(closeReason: String?): CordieriteErrorDetails =
        when (closeReason) {
            "expired_session_claim" -> {
                CordieriteErrorDetails(
                    code = "session_claim_expired",
                    message = "Cordierite session claim expired before the app connected.",
                    phase = "handshake",
                    closeReason = closeReason,
                    isRetryable = true,
                    hint = "Restart the host and open the deep link again. Larger apps may need the longer default 60s TTL.",
                )
            }

            "wrong_session_id" -> {
                CordieriteErrorDetails(
                    code = "session_claim_rejected",
                    message = "Cordierite app claimed a different session id than the host expected.",
                    phase = "handshake",
                    closeReason = closeReason,
                    isRetryable = false,
                )
            }

            "wrong_token" -> {
                CordieriteErrorDetails(
                    code = "session_claim_rejected",
                    message = "Cordierite app used the wrong session token for this host.",
                    phase = "handshake",
                    closeReason = closeReason,
                    isRetryable = false,
                )
            }

            "already_claimed", "single_session_only" -> {
                CordieriteErrorDetails(
                    code = "session_claim_rejected",
                    message = "Cordierite host already has an active device connection for this session.",
                    phase = "handshake",
                    closeReason = closeReason,
                    isRetryable = true,
                )
            }

            "session_not_claimable" -> {
                CordieriteErrorDetails(
                    code = "session_claim_rejected",
                    message = "Cordierite session is no longer claimable.",
                    phase = "handshake",
                    closeReason = closeReason,
                    isRetryable = true,
                )
            }

            "expected_session_claim" -> {
                CordieriteErrorDetails(
                    code = "invalid_ack",
                    message = "Cordierite host expected a session claim before any other message.",
                    phase = "handshake",
                    closeReason = closeReason,
                    isRetryable = false,
                )
            }

            else -> {
                CordieriteErrorDetails(
                    code = "invalid_ack",
                    message = "Cordierite session acknowledgement was invalid.",
                    phase = "handshake",
                    closeReason = closeReason,
                    isRetryable = false,
                )
            }
        }

    private fun createSslSocketFactory(trustManager: X509TrustManager): SSLSocketFactory {
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
        return sslContext.socketFactory
    }
}

/**
 * Loopback/RFC 1918 private-range check backing the `ALLOW_PRIVATE_LAN_ONLY` gate. Extracted as a
 * top-level pure function so it is unit-testable without a `Context`.
 */
internal fun isLocalIpv4Address(value: String): Boolean {
    val parts = value.split(".")
    if (parts.size != 4) {
        return false
    }

    val octets = parts.mapNotNull { part -> part.toIntOrNull() }
    if (octets.size != 4 || octets.any { it !in 0..255 }) {
        return false
    }

    val first = octets[0]
    val second = octets[1]

    return first == 127 || first == 10 || (first == 172 && second in 16..31) || (first == 192 && second == 168)
}
