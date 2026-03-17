package com.callstackincubator.cordierite

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class CordieritePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == NativeCordieriteSpec.NAME) {
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
