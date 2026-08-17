package com.callstackincubator.cordierite

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Whether Cordierite is present in a build at all is now decided entirely by autolinking, at the
 * app level (see `docs/tasks/00-overview.md`'s "Inclusion" contract) -- not by any runtime check
 * here. This package registers the module unconditionally whenever it is linked.
 */
class CordieritePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    if (name != NativeCordieriteSpec.NAME) {
      return null
    }

    return NativeCordieriteModule(reactContext)
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
