import ExpoModulesCore
import Security

public final class CH3NativeControlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CH3NativeControls")

    Function("getShowcasePairingUrl") {
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcasePairingUrl"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    Function("getShowcaseScene") { () -> String? in
      let scenePath = NSHomeDirectory() + "/Library/Caches/CH3ShowcaseScene"
      if let storedScene = try? String(contentsOfFile: scenePath, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines), !storedScene.isEmpty {
        return storedScene
      }
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcaseScene"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    Function("prepareShowcaseCapture") {
      for itemClass in [kSecClassGenericPassword, kSecClassInternetPassword] {
        SecItemDelete([kSecClass as String: itemClass] as CFDictionary)
      }
    }

    Function("markShowcaseReady") { (scene: String) in
      let readyPath = NSHomeDirectory() + "/Library/Caches/CH3ShowcaseReadyScene"
      try? scene.write(toFile: readyPath, atomically: true, encoding: .utf8)
    }

    View(CH3HeaderButtonView.self) {
      Prop("label") { (view: CH3HeaderButtonView, label: String) in
        view.setLabel(label)
      }
      Prop("systemImage") { (view: CH3HeaderButtonView, systemImage: String) in
        view.setSystemImage(systemImage)
      }

      Events("onTriggered")
    }
  }
}
