package com.callstackincubator.cordierite

import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

private const val RESUME_LEASE_SCHEMA_VERSION = 1
private const val MAX_WIRE_ID_LENGTH = 128
private const val MAX_WIRE_STRING_LENGTH = 4096

internal data class CordieriteResumeEndpoint(
    val ip: String,
    val port: Int,
)

/** Immutable process-memory representation of the `ResumeLeaseV1` contract. */
internal data class CordieriteResumeLeaseV1(
    val sessionId: String,
    val resumeToken: String,
    val alias: String,
    val endpoint: CordieriteResumeEndpoint,
    val keepaliveIntervalS: Double,
    val graceS: Double,
    val disconnectedAtMs: Long?,
) {
    val schemaVersion: Int = RESUME_LEASE_SCHEMA_VERSION

    /** Stable JSON-ready record for the future synchronous TurboModule exposure. */
    fun toRecord(): Map<String, Any?> =
        linkedMapOf(
            "schemaVersion" to schemaVersion,
            "sessionId" to sessionId,
            "resumeToken" to resumeToken,
            "alias" to alias,
            "endpoint" to linkedMapOf("ip" to endpoint.ip, "port" to endpoint.port),
            "keepaliveIntervalS" to keepaliveIntervalS,
            "graceS" to graceS,
            "disconnectedAtMs" to disconnectedAtMs,
        )
}

/**
 * Owns exactly one app/session resume lease for the lifetime of this Android process. The entry's
 * owner generation is deliberately not serialized: it only prevents teardown from an older
 * TurboModule/manager instance from mutating a lease installed by its replacement.
 */
internal object CordieriteProcessResumeLeaseStore {
    private data class Entry(
        val ownerGeneration: Long,
        val lease: CordieriteResumeLeaseV1,
    )

    private val lock = Any()
    private val generationCounter = AtomicLong(0)
    private var entry: Entry? = null

    fun newOwnerGeneration(): Long = generationCounter.incrementAndGet()

    fun get(): CordieriteResumeLeaseV1? = synchronized(lock) { entry?.lease }

    fun getRecord(): Map<String, Any?>? = synchronized(lock) { entry?.lease?.toRecord() }

    fun replace(
        ownerGeneration: Long,
        lease: CordieriteResumeLeaseV1,
    ): Boolean =
        synchronized(lock) {
            val current = entry
            if (current != null && current.ownerGeneration > ownerGeneration) {
                return@synchronized false
            }
            entry = Entry(ownerGeneration, lease)
            true
        }

    fun markDisconnected(
        ownerGeneration: Long,
        sessionId: String,
        disconnectedAtMs: Long,
    ): Boolean =
        synchronized(lock) {
            val current = entry ?: return@synchronized false
            if (
                disconnectedAtMs < 0 ||
                current.ownerGeneration > ownerGeneration ||
                current.lease.sessionId != sessionId
            ) {
                return@synchronized false
            }

            entry =
                Entry(
                    ownerGeneration = ownerGeneration,
                    lease =
                        current.lease.copy(
                            disconnectedAtMs = current.lease.disconnectedAtMs ?: disconnectedAtMs,
                        ),
                )
            true
        }

    fun clear(ownerGeneration: Long): Boolean =
        synchronized(lock) {
            val current = entry ?: return@synchronized true
            if (current.ownerGeneration > ownerGeneration) {
                return@synchronized false
            }
            entry = null
            true
        }

    fun resetForTests() {
        synchronized(lock) {
            entry = null
            generationCounter.set(0)
        }
    }
}

internal enum class SessionAckCommitResult {
    accepted,
    invalid,
    stale,
}

/**
 * Validates and commits the ack-owned lease before either the manager transition or raw callback.
 * Keeping this ordering in one function closes the token-rotation crash/reload window.
 */
internal fun commitSessionAck(
    jsonObject: JSONObject,
    rawText: String,
    options: CordieriteConnectOptions,
    ownerGeneration: Long,
    onAccepted: (CordieriteResumeLeaseV1) -> Unit,
    emitMessageRaw: (String) -> Unit,
): SessionAckCommitResult {
    val lease = parseSessionAckLease(jsonObject, options) ?: return SessionAckCommitResult.invalid
    if (!CordieriteProcessResumeLeaseStore.replace(ownerGeneration, lease)) {
        return SessionAckCommitResult.stale
    }

    onAccepted(lease)
    emitMessageRaw(rawText)
    return SessionAckCommitResult.accepted
}

private fun parseSessionAckLease(
    jsonObject: JSONObject,
    options: CordieriteConnectOptions,
): CordieriteResumeLeaseV1? {
    val type = jsonObject.stringValue("type") ?: return null
    val status = jsonObject.stringValue("status") ?: return null
    val sessionId = jsonObject.boundedStringValue("session_id", MAX_WIRE_ID_LENGTH) ?: return null
    val resumeToken = jsonObject.boundedStringValue("resume_token", MAX_WIRE_ID_LENGTH) ?: return null
    val alias = jsonObject.boundedStringValue("alias", MAX_WIRE_ID_LENGTH) ?: return null
    val keepaliveIntervalS = jsonObject.positiveFiniteNumberValue("keepalive_interval_s") ?: return null
    val graceS = jsonObject.positiveFiniteNumberValue("grace_s") ?: return null

    if (
        type != "session_ack" ||
        status != "ok" ||
        sessionId != options.sessionId ||
        options.ip.isEmpty() ||
        options.ip.length > MAX_WIRE_STRING_LENGTH ||
        options.port !in 1..65535
    ) {
        return null
    }

    return CordieriteResumeLeaseV1(
        sessionId = sessionId,
        resumeToken = resumeToken,
        alias = alias,
        endpoint = CordieriteResumeEndpoint(options.ip, options.port),
        keepaliveIntervalS = keepaliveIntervalS,
        graceS = graceS,
        disconnectedAtMs = null,
    )
}

private fun JSONObject.stringValue(key: String): String? = opt(key) as? String

private fun JSONObject.boundedStringValue(
    key: String,
    maxLength: Int,
): String? = stringValue(key)?.takeIf { it.isNotEmpty() && it.length <= maxLength }

private fun JSONObject.positiveFiniteNumberValue(key: String): Double? {
    val value = (opt(key) as? Number)?.toDouble() ?: return null
    return value.takeIf { it.isFinite() && it > 0.0 }
}
