require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'Cordierite'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/callstackincubator/cordierite' }
  s.static_framework = true

  s.source_files = 'ios/**/*.{m,mm,swift}'
  s.exclude_files = 'ios/CordieriteTests/**/*'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # All connection state lives behind a single actor (see CordieriteConnectionManager); keep
    # it that way by failing the build on any new concurrency violation.
    'OTHER_SWIFT_FLAGS' => '-strict-concurrency=complete',
  }

  # Default-inert release builds (opt-in hardening design doc part B): `CordieriteTurboBridge.swift`
  # and `RCTNativeCordierite.mm` compile out their module implementation unless `DEBUG` is set
  # (reliable for this pod's own Debug configs per docs/tasks/01-ios-debug-flag-spike.md) or the
  # app has opted in via `CORDIERITE_ENABLE_RELEASE`. That flag is NOT set here on the pod's own
  # xcconfig — opting in is an *app*-level decision, deliberately outside this podspec's control,
  # made by the config plugin's `enableInReleaseBuilds` option (bare RN: via the app's Podfile
  # `post_install` / `pod_target_xcconfig`). To opt in, the flag must be defined for BOTH
  # languages on the Cordierite pod target:
  #   SWIFT_ACTIVE_COMPILATION_CONDITIONS => '$(inherited) CORDIERITE_ENABLE_RELEASE'
  #   GCC_PREPROCESSOR_DEFINITIONS        => '$(inherited) CORDIERITE_ENABLE_RELEASE=1'

  if defined?(install_modules_dependencies)
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
  end

  s.test_spec 'Tests' do |test_spec|
    # Pure-logic tests (actor state transitions, SPKI pin parity with
    # packages/cordierite/src/spki-pin.ts) that need only Foundation/Security, not React Native.
    test_spec.source_files = 'ios/CordieriteTests/**/*.swift'
    test_spec.requires_app_host = true
  end
end
