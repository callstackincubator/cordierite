package com.callstackincubator.cordierite

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = NativeCordieriteSpec.NAME)
class NativeCordieriteModule(
    reactContext: ReactApplicationContext,
) : NativeCordieriteSpec(reactContext) {
    private val manager =
        CordieriteConnectionManager(
            context = reactContext,
            emitStateChange = { state ->
                emitOnStateChange(
                    Arguments.createMap().apply { putString("state", state) },
                )
            },
            emitMessageRaw = { raw ->
                emitOnMessage(
                    Arguments.createMap().apply { putString("rawMessage", raw) },
                )
            },
            emitError = { details ->
                emitOnError(
                    Arguments.createMap().apply {
                        putString("code", details.code)
                        putString("message", details.message)
                        if (details.phase != null) {
                            putString("phase", details.phase)
                        }
                        if (details.nativeCode != null) {
                            putString("nativeCode", details.nativeCode)
                        }
                        if (details.closeReason != null) {
                            putString("closeReason", details.closeReason)
                        }
                        if (details.isRetryable != null) {
                            putBoolean("isRetryable", details.isRetryable)
                        }
                        if (details.hint != null) {
                            putString("hint", details.hint)
                        }
                    },
                )
            },
            emitClose = { payload ->
                val m = Arguments.createMap()
                when (val c = payload["code"]) {
                    is Int -> m.putInt("code", c)
                    else -> m.putNull("code")
                }
                when (val r = payload["reason"]) {
                    is String -> m.putString("reason", r)
                    else -> m.putNull("reason")
                }
                emitOnClose(m)
            },
        )

    override fun connect(
        options: ReadableMap,
        promise: Promise,
    ) {
        manager.connect(options) { error ->
            if (error != null) {
                promise.reject("E_CORDIERITE", error.message, error)
            } else {
                promise.resolve(null)
            }
        }
    }

    override fun send(
        message: String,
        promise: Promise,
    ) {
        manager.send(message) { error ->
            if (error != null) {
                promise.reject("E_CORDIERITE", error.message, error)
            } else {
                promise.resolve(null)
            }
        }
    }

    override fun close(promise: Promise) {
        manager.close {
            promise.resolve(null)
        }
    }

    override fun getState(): String = manager.getState()

    override fun getResumeLease(): WritableMap? {
        val record = manager.getResumeLeaseRecord() ?: return null
        val endpoint = record["endpoint"] as Map<*, *>
        return Arguments.createMap().apply {
            putInt("schemaVersion", record["schemaVersion"] as Int)
            putString("sessionId", record["sessionId"] as String)
            putString("resumeToken", record["resumeToken"] as String)
            putString("alias", record["alias"] as String)
            putMap(
                "endpoint",
                Arguments.createMap().apply {
                    putString("ip", endpoint["ip"] as String)
                    putInt("port", endpoint["port"] as Int)
                },
            )
            putDouble("keepaliveIntervalS", record["keepaliveIntervalS"] as Double)
            putDouble("graceS", record["graceS"] as Double)
            when (val disconnectedAtMs = record["disconnectedAtMs"]) {
                is Long -> putDouble("disconnectedAtMs", disconnectedAtMs.toDouble())
                else -> putNull("disconnectedAtMs")
            }
        }
    }

    override fun clearResumeLease() {
        manager.clearResumeLease()
    }

    override fun invalidate() {
        manager.invalidate()
        super.invalidate()
    }
}
