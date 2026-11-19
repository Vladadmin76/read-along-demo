Pod::Spec.new do |s|
  s.name           = 'LiveTranscriber'
  s.version        = '1.0.0'
  s.summary        = 'Continuous on-device speech transcription with Apple SpeechAnalyzer'
  s.description    = 'Continuous on-device speech transcription with Apple SpeechAnalyzer (iOS 26+)'
  s.author         = ''
  s.homepage       = 'https://github.com/Vladadmin76/read-along-demo'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,swift}"
end
