package com.callstackincubator.cordierite

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic JVM tests for `CordieritePackage`'s default-inert-release-builds gate.
 * `getModule` itself needs a `Context`/`ApplicationInfo` and isn't
 * exercised here — see `isCordieriteRegistrationEnabled` and `parseEnableInRelease`'s doc comments
 * for why the decision is factored out this way.
 */
class CordieritePackageTest {
    // -- isCordieriteRegistrationEnabled: plain OR of isDebuggable / already-parsed meta-data --

    @Test
    fun `debuggable app registers the module regardless of ENABLE_IN_RELEASE`() {
        assertTrue(isCordieriteRegistrationEnabled(isDebuggable = true, enableInReleaseMetaData = false))
        assertTrue(isCordieriteRegistrationEnabled(isDebuggable = true, enableInReleaseMetaData = true))
    }

    @Test
    fun `non-debuggable app registers the module only when ENABLE_IN_RELEASE is true`() {
        assertFalse(isCordieriteRegistrationEnabled(isDebuggable = false, enableInReleaseMetaData = false))
        assertTrue(isCordieriteRegistrationEnabled(isDebuggable = false, enableInReleaseMetaData = true))
    }

    // -- parseEnableInRelease: tolerant Boolean-or-String meta-data parsing, fails closed to false --

    @Test
    fun `parseEnableInRelease returns false when the meta-data key is absent`() {
        assertFalse(parseEnableInRelease(hasKey = false, rawValue = null))
    }

    @Test
    fun `parseEnableInRelease honors a real Boolean value`() {
        assertTrue(parseEnableInRelease(hasKey = true, rawValue = true))
        assertFalse(parseEnableInRelease(hasKey = true, rawValue = false))
    }

    @Test
    fun `parseEnableInRelease honors a tolerant String boolean value`() {
        assertTrue(parseEnableInRelease(hasKey = true, rawValue = "true"))
        assertFalse(parseEnableInRelease(hasKey = true, rawValue = "false"))
    }

    @Test
    fun `parseEnableInRelease fails closed to false on an unparseable String`() {
        assertFalse(parseEnableInRelease(hasKey = true, rawValue = "garbage"))
        assertFalse(parseEnableInRelease(hasKey = true, rawValue = ""))
    }

    @Test
    fun `parseEnableInRelease fails closed to false on an unexpected value type`() {
        assertFalse(parseEnableInRelease(hasKey = true, rawValue = 1))
        assertFalse(parseEnableInRelease(hasKey = true, rawValue = 1.0))
    }

    // -- Full matrix: debuggable x {no key, true, false, "true", "false", garbage} and the same
    // for non-debuggable, composing parseEnableInRelease with isCordieriteRegistrationEnabled the
    // way CordieritePackage.getModule does. --

    private fun registrationEnabled(isDebuggable: Boolean, hasKey: Boolean, rawValue: Any?): Boolean =
        isCordieriteRegistrationEnabled(
            isDebuggable = isDebuggable,
            enableInReleaseMetaData = parseEnableInRelease(hasKey, rawValue),
        )

    @Test
    fun `full matrix - debuggable app always registers regardless of meta-data value`() {
        assertTrue(registrationEnabled(isDebuggable = true, hasKey = false, rawValue = null))
        assertTrue(registrationEnabled(isDebuggable = true, hasKey = true, rawValue = true))
        assertTrue(registrationEnabled(isDebuggable = true, hasKey = true, rawValue = false))
        assertTrue(registrationEnabled(isDebuggable = true, hasKey = true, rawValue = "true"))
        assertTrue(registrationEnabled(isDebuggable = true, hasKey = true, rawValue = "false"))
        assertTrue(registrationEnabled(isDebuggable = true, hasKey = true, rawValue = "garbage"))
    }

    @Test
    fun `full matrix - non-debuggable app registers only when meta-data resolves truthy`() {
        assertFalse(registrationEnabled(isDebuggable = false, hasKey = false, rawValue = null))
        assertTrue(registrationEnabled(isDebuggable = false, hasKey = true, rawValue = true))
        assertFalse(registrationEnabled(isDebuggable = false, hasKey = true, rawValue = false))
        assertTrue(registrationEnabled(isDebuggable = false, hasKey = true, rawValue = "true"))
        assertFalse(registrationEnabled(isDebuggable = false, hasKey = true, rawValue = "false"))
        assertFalse(registrationEnabled(isDebuggable = false, hasKey = true, rawValue = "garbage"))
    }
}
