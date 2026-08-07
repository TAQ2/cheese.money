Pod::Spec.new do |s|
  s.name           = 'CH3NativeControls'
  s.version        = '1.0.0'
  s.summary        = 'Native UIKit controls for CH3 mobile.'
  s.description    = 'UIKit-backed controls that match native iOS navigation chrome.'
  s.author         = 'CH3 Tools'
  s.homepage       = 'https://ch3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
