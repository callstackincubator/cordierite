require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Only evaluated when autolinking has already decided to link Cordierite, so the line appearing at
# all is the proof. Ungated: a release build carrying Cordierite by mistake is the failure worth
# catching, and this is grep-able in CI output. CocoaPods evaluates the podspec several times per
# install, hence the guard.
if defined?(Pod::UI) && !defined?($cordierite_banner_shown)
  $cordierite_banner_shown = true
  Pod::UI.puts "[cordierite] native module INCLUDED in this build (v#{package['version']})"
end

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
