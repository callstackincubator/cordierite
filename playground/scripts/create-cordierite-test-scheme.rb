#!/usr/bin/env ruby
# frozen_string_literal: true

require 'fileutils'
require 'xcodeproj'

pods_project_path = ARGV.fetch(0, 'ios/Pods/Pods.xcodeproj')
project = Xcodeproj::Project.open(pods_project_path)

tests = project.targets.find { |target| target.name == 'Cordierite-Unit-Tests' }
host = project.targets.find { |target| target.name == 'AppHost-Cordierite-Unit-Tests' }

abort("Missing Cordierite-Unit-Tests target in #{pods_project_path}") unless tests
abort("Missing AppHost-Cordierite-Unit-Tests target in #{pods_project_path}") unless host

def buildable_reference(target)
  reference = target.product_reference
  <<~XML
    <BuildableReference
       BuildableIdentifier = "primary"
       BlueprintIdentifier = "#{target.uuid}"
       BuildableName = "#{reference.path}"
       BlueprintName = "#{target.name}"
       ReferencedContainer = "container:Pods.xcodeproj">
    </BuildableReference>
  XML
end

scheme = <<~XML
  <?xml version="1.0" encoding="UTF-8"?>
  <Scheme
     LastUpgradeVersion = "1640"
     version = "1.7">
     <BuildAction
        parallelizeBuildables = "YES"
        buildImplicitDependencies = "YES">
        <BuildActionEntries>
           <BuildActionEntry
              buildForTesting = "YES"
              buildForRunning = "NO"
              buildForProfiling = "NO"
              buildForArchiving = "NO"
              buildForAnalyzing = "YES">
  #{buildable_reference(tests).lines.map { |line| "           #{line}" }.join}           </BuildActionEntry>
           <BuildActionEntry
              buildForTesting = "YES"
              buildForRunning = "YES"
              buildForProfiling = "NO"
              buildForArchiving = "NO"
              buildForAnalyzing = "YES">
  #{buildable_reference(host).lines.map { |line| "           #{line}" }.join}           </BuildActionEntry>
        </BuildActionEntries>
     </BuildAction>
     <TestAction
        buildConfiguration = "Debug"
        selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
        selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
        shouldUseLaunchSchemeArgsEnv = "YES">
        <Testables>
           <TestableReference skipped = "NO">
  #{buildable_reference(tests).lines.map { |line| "              #{line}" }.join}           </TestableReference>
        </Testables>
     </TestAction>
  </Scheme>
XML

scheme_path = File.join(pods_project_path, 'xcshareddata', 'xcschemes', 'Cordierite-Native-Tests.xcscheme')
FileUtils.mkdir_p(File.dirname(scheme_path))
File.write(scheme_path, scheme)
puts "Generated #{scheme_path}"
