package com.callstackincubator.cordierite

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Config-plugin-written manifest meta-data: explicit,
 * non-default opt-in to registering Cordierite in a release build. The plugin requires non-empty
 * `cliPins` before it will set this to `true`. */
private const val ENABLE_IN_RELEASE_KEY = "com.callstackincubator.cordierite.ENABLE_IN_RELEASE"

/**
 * Default-inert release builds: registers the module only
 * when the app is debuggable, or when it has explicitly opted in via `ENABLE_IN_RELEASE`
 * meta-data. A production app that never touched the config plugin's `enableInReleaseBuilds`
 * option gets no Cordierite module at all — `getModule` returns `null`, matching
 * `BaseReactPackage`'s documented contract for "this package does not provide this module". The
 * JS side degrades to exact `/noop` behavior when the native module is absent
 * — this gate is its native counterpart.
 *
 * Pure decision logic is factored into `isCordieriteRegistrationEnabled` / `parseEnableInRelease`
 * (mirrors `resolveTrustedPins` / `parseAllowPrivateLanOnly`'s testability pattern) so it does not
 * require a `Context`/manifest fixture.
 *
 * `getReactModuleInfoProvider` below is deliberately NOT re-gated on the same check: unlike
 * `getModule`, `BaseReactPackage.getReactModuleInfoProvider()` takes no `Context` argument, so it
 * has no way to read `ApplicationInfo` at all. That's not an inconsistency —
 * `ReactPackageTurboModuleManagerDelegate.getModule` calls each package's `getModule(name, ctx)`
 * through the info map and simply leaves the module unresolved when it returns `null`; no warning
 * is logged for a `null` turbo module. Declaring `ReactModuleInfo` unconditionally while gating the
 * actual instance in `getModule` is exactly that documented contract.
 */
class CordieritePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    if (name != NativeCordieriteSpec.NAME) {
      return null
    }

    val applicationInfo = readApplicationInfo(reactContext)
    val isDebuggable = (applicationInfo?.flags?.and(ApplicationInfo.FLAG_DEBUGGABLE) ?: 0) != 0
    val metaData = applicationInfo?.metaData
    @Suppress("DEPRECATION") // Bundle.get(String) is deprecated but is the only way to read the raw value's type.
    val enableInRelease = parseEnableInRelease(
      hasKey = metaData?.containsKey(ENABLE_IN_RELEASE_KEY) == true,
      rawValue = metaData?.get(ENABLE_IN_RELEASE_KEY),
    )

    return if (isCordieriteRegistrationEnabled(isDebuggable, enableInRelease)) {
      NativeCordieriteModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        NativeCordieriteSpec.NAME to ReactModuleInfo(
          NativeCordieriteSpec.NAME,
          NativeCordieriteModule::class.java.name,
          false,
          false,
          false,
          true,
        ),
      )
    }
  }
}

private fun readApplicationInfo(context: Context): ApplicationInfo? =
  try {
    context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
  } catch (_: PackageManager.NameNotFoundException) {
    null
  }

/**
 * Tolerant parsing of the config-plugin-written `ENABLE_IN_RELEASE` manifest meta-data.
 * Mirrors `parseAllowPrivateLanOnly`'s tolerant Boolean-or-String
 * handling in `CordieriteConnectionManager.kt` (manifest meta-data can surface as either type
 * depending on how it was declared), but fails closed the other way: a missing key, an
 * unparseable String, or any other value type all resolve to `false` ("not opted in"), since the
 * safe default here is staying inert, not the reverse.
 */
internal fun parseEnableInRelease(hasKey: Boolean, rawValue: Any?): Boolean {
  if (!hasKey) {
    return false
  }

  return when (rawValue) {
    is Boolean -> rawValue
    is String -> rawValue.toBooleanStrictOrNull() ?: false
    else -> false
  }
}

/**
 * Pure decision logic for whether `CordieritePackage` registers the native module at all.
 * `isDebuggable` is `ApplicationInfo.FLAG_DEBUGGABLE`;
 * `enableInReleaseMetaData` is `parseEnableInRelease`'s result for the config-plugin-written
 * `ENABLE_IN_RELEASE` manifest flag. Unlike `resolveTrustedPins` (which pin trust a debug build
 * falls back to), this gate has no "weaker but usable" middle case — it's a plain OR, since
 * debug-vs-release here is about whether the module exists at all, not which pins it trusts once
 * it does.
 */
internal fun isCordieriteRegistrationEnabled(
  isDebuggable: Boolean,
  enableInReleaseMetaData: Boolean,
): Boolean = isDebuggable || enableInReleaseMetaData
