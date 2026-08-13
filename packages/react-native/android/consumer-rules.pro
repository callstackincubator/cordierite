# Consumed by every app that depends on @cordierite/react-native (R8/ProGuard reads
# `consumerProguardFiles` from this library's AAR metadata, not just the app's own rules file).
#
# Keeps CordieriteNativeMarker's fully-qualified name unminified and unremoved so
# `cordierite doctor` (packages/cordierite/src/artifact-inspect.ts, docs/tasks/10-android-detection-keep-rule.md)
# has a detection anchor that survives aggressive release minification even in a bare-RN app with
# no config plugin and no other Android keep rules. Deliberately scoped to this one marker class,
# not the whole `com.callstackincubator.cordierite` package: everything else in this library
# remains free to be renamed and shrunk by R8 as normal.
-keep class com.callstackincubator.cordierite.CordieriteNativeMarker { *; }
