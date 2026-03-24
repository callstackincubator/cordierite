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
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

private const val ANDROID_PINS_KEY = "com.callstackincubator.cordierite.CLI_PINS"
private const val ANDROID_PRIVATE_LAN_KEY = "com.callstackincubator.cordierite.ALLOW_PRIVATE_LAN_ONLY"

private enum class CordieriteConnectionState {
  idle,
  connecting,
  active,
  closed,
  error,
}

private data class CordieriteConnectOptions(
  val ip: String,
  val port: Int,
  val sessionId: String,
  val token: String,
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
      val token = value.getString("token") ?: throw IllegalArgumentException("Invalid Cordierite token.")
      val expiresAt = value.getInt("expiresAt")

      fun optionalDeviceString(key: String): String? {
        if (!value.hasKey(key)) {
          return null
        }
        val s = value.getString(key)?.trim() ?: return null
        return s.takeIf { it.isNotEmpty() }
      }

      return CordieriteConnectOptions(
        ip,
        port,
        sessionId,
        token,
        expiresAt,
        optionalDeviceString("deviceManufacturer"),
        optionalDeviceString("deviceModel"),
        optionalDeviceString("deviceOs"),
      )
    }
  }
}

/** Always non-empty strings so `session_claim` matches iOS (three keys always present on the wire). */
private data class DefaultSessionClaimDeviceFields(
  val manufacturer: String,
  val model: String,
  val os: String,
)

private fun defaultAndroidSessionClaimDeviceFields(): DefaultSessionClaimDeviceFields {
  val manufacturer = Build.MANUFACTURER?.trim()?.takeIf { it.isNotEmpty() } ?: "Unknown"
  val model = Build.MODEL?.trim()?.takeIf { it.isNotEmpty() } ?: "Unknown"
  val release = Build.VERSION.RELEASE?.trim()?.takeIf { it.isNotEmpty() } ?: ""
  val os = if (release.isNotEmpty()) "Android $release" else "Android"
  return DefaultSessionClaimDeviceFields(manufacturer, model, os)
}

private fun mergeSessionClaimDeviceFields(
  options: CordieriteConnectOptions,
  defaults: DefaultSessionClaimDeviceFields,
): DefaultSessionClaimDeviceFields {
  return DefaultSessionClaimDeviceFields(
    options.deviceManufacturer ?: defaults.manufacturer,
    options.deviceModel ?: defaults.model,
    options.deviceOs ?: defaults.os,
  )
}

/**
 * Pins the leaf cert by SHA-256 over SubjectPublicKeyInfo DER (`publicKey.encoded`), same format as
 * `sha256/...` in docs — must match iOS SPKI hashing for the same CLI certificate.
 */
private class PinningTrustManager(private val acceptedPins: Set<String>) : X509TrustManager {
  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
    throw CertificateException("Client certificates are not supported.")
  }

  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
    val leaf = chain.firstOrNull() ?: throw CertificateException("Missing server certificate.")
    val pin = spkiPin(leaf)

    if (!acceptedPins.contains(pin)) {
      throw CertificateException("Server certificate pin mismatch.")
    }
  }

  private fun spkiPin(certificate: X509Certificate): String {
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded)
    val base64 = android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP)
    return "sha256/$base64"
  }
}

internal class CordieriteConnectionManager(
  private val context: Context,
  private val emitStateChange: (String) -> Unit,
  private val emitMessageRaw: (String) -> Unit,
  private val emitError: (String, String) -> Unit,
  private val emitClose: (Map<String, Any?>) -> Unit,
) {
  private var state = CordieriteConnectionState.idle
    set(value) {
      field = value
      emitStateChange(value.name)
    }

  private var okHttpClient: OkHttpClient? = null
  private var webSocket: WebSocket? = null
  private var activeSessionId: String? = null
  private var pendingSessionId: String? = null
  private var configuredPins: Set<String> = emptySet()
  private var allowPrivateLanOnly = false
  private var closeEventPending = false

  fun connect(rawOptions: com.facebook.react.bridge.ReadableMap) {
    val options = CordieriteConnectOptions.fromReadableMap(rawOptions)

    if (state == CordieriteConnectionState.connecting || state == CordieriteConnectionState.active) {
      throw IllegalStateException("A Cordierite session is already connecting or active.")
    }

    loadConfiguration()

    val now = (System.currentTimeMillis() / 1000L).toInt()
    if (options.expiresAt <= now) {
      throw IllegalArgumentException("Cordierite bootstrap payload has expired.")
    }

    if (allowPrivateLanOnly && !isPrivateIpv4Address(options.ip)) {
      throw IllegalArgumentException("Cordierite only allows private LAN IP addresses.")
    }

    cleanup()

    pendingSessionId = options.sessionId
    closeEventPending = true
    state = CordieriteConnectionState.connecting

    val trustManager = PinningTrustManager(configuredPins)
    val sslSocketFactory = createSslSocketFactory(trustManager)

    // URL uses raw IP (`wss://ip:port`); hostname verification is not applicable. Pinning enforces identity.
    okHttpClient = OkHttpClient.Builder()
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .sslSocketFactory(sslSocketFactory, trustManager)
      .hostnameVerifier(HostnameVerifier { _, _ -> true })
      .build()

    val request = Request.Builder()
      .url("wss://${options.ip}:${options.port}")
      .build()

    webSocket = okHttpClient?.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        val device = mergeSessionClaimDeviceFields(options, defaultAndroidSessionClaimDeviceFields())
        val claim = JSONObject()
          .put("type", "session_claim")
          .put("session_id", options.sessionId)
          .put("token", options.token)
          .put("device_manufacturer", device.manufacturer)
          .put("device_model", device.model)
          .put("device_os", device.os)

        if (!webSocket.send(claim.toString())) {
          failSocketSend(
            webSocket,
            "Cordierite session claim could not be sent because the socket is closing.",
          )
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        handleIncomingMessage(webSocket, text)
      }

      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        state = CordieriteConnectionState.error
        emitError("invalid_message", "Binary Cordierite messages are not supported.")
        webSocket.close(1003, "binary_not_supported")
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
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

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        state = CordieriteConnectionState.error
        emitError("connection_failed", t.message ?: "Cordierite WebSocket connection failed.")
        cleanup()
        if (closeEventPending) {
          emitClose(emptyMap())
          closeEventPending = false
        }
      }
    })
  }

  fun send(message: String) {
    val currentSessionId = activeSessionId ?: throw IllegalStateException("Cordierite session is not active.")
    if (state != CordieriteConnectionState.active) {
      throw IllegalStateException("Cordierite session is not active.")
    }

    val parsed = try {
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

  fun close() {
    val socket = webSocket

    if (socket == null) {
      cleanup()
      state = CordieriteConnectionState.closed
      emitClose(emptyMap())
      return
    }

    closeEventPending = true
    socket.close(1000, "client_close")
  }

  fun getState(): String = state.name

  private fun handleIncomingMessage(webSocket: WebSocket, text: String) {
    val jsonObject = try {
      JSONObject(text)
    } catch (_: Throwable) {
      state = CordieriteConnectionState.error
      emitError("invalid_message", "Incoming Cordierite message must be a JSON object.")
      webSocket.close(1008, "invalid_message")
      return
    }

    if (state == CordieriteConnectionState.connecting) {
      val sessionId = jsonObject.optString("session_id")
      val isValidAck = jsonObject.optString("type") == "session_ack" &&
        jsonObject.optString("status") == "ok" &&
        sessionId == pendingSessionId

      if (!isValidAck) {
        state = CordieriteConnectionState.error
        emitError("invalid_ack", "Cordierite session acknowledgement was invalid.")
        webSocket.close(1008, "invalid_ack")
        return
      }

      activeSessionId = pendingSessionId
      pendingSessionId = null
      state = CordieriteConnectionState.active
      return
    }

    val currentSessionId = activeSessionId
    val sessionId = jsonObject.optString("session_id")

    if (currentSessionId == null || sessionId != currentSessionId) {
      state = CordieriteConnectionState.error
      emitError("session_mismatch", "Incoming Cordierite message does not match the active session.")
      webSocket.close(1008, "session_mismatch")
      return
    }

    emitMessageRaw(text)
  }

  private fun loadConfiguration() {
    val applicationInfo = context.packageManager.getApplicationInfo(
      context.packageName,
      PackageManager.GET_META_DATA,
    )
    val metaData = applicationInfo.metaData
    val pinsJson = metaData?.getString(ANDROID_PINS_KEY).orEmpty()

    if (pinsJson.isEmpty()) {
      throw IllegalStateException("Cordierite CLI pins are not configured in AndroidManifest.xml.")
    }

    val parsedPins = JSONArray(pinsJson)
    configuredPins = buildSet {
      for (index in 0 until parsedPins.length()) {
        add(parsedPins.getString(index))
      }
    }

    allowPrivateLanOnly = metaData?.getString(ANDROID_PRIVATE_LAN_KEY)?.toBooleanStrictOrNull() ?: false
  }

  private fun cleanup() {
    webSocket = null
    okHttpClient?.dispatcher?.executorService?.shutdown()
    okHttpClient = null
    activeSessionId = null
    pendingSessionId = null
  }

  private fun failSocketSend(webSocket: WebSocket, message: String) {
    state = CordieriteConnectionState.error
    emitError("send_failed", message)
    closeEventPending = true
    webSocket.close(1011, "send_failed")
  }

  private fun createSslSocketFactory(trustManager: X509TrustManager): SSLSocketFactory {
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
    return sslContext.socketFactory
  }

  private fun isPrivateIpv4Address(value: String): Boolean {
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

    return first == 10 || (first == 172 && second in 16..31) || (first == 192 && second == 168)
  }
}
