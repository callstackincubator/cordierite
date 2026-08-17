package com.callstackincubator.cordierite

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Compiled only for the `release` build type when `CORDIERITE_ENABLED` is unset/false (see
 * `android/build.gradle`'s `sourceSets.release` wiring) -- the real implementation under
 * `src/debug/` is not on this variant's classpath at all, not even gated behind a runtime check.
 * `PackageList.java` (generated once, shared by every variant -- see `docs/tasks/00-overview.md`'s
 * "Revisited post-implementation" note) still references `CordieritePackage` by name regardless of
 * variant, so this stub exists purely to keep that reference resolvable; it registers nothing.
 */
class CordieritePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider { emptyMap() }
  }
}
