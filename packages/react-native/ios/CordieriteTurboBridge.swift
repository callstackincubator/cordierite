import Foundation

/// Bridges Swift connection logic to Objective-C++ (`RCTNativeCordierite`).
@objc(CordieriteTurboBridge)
public final class CordieriteTurboBridge: NSObject {
  private let manager = CordieriteConnectionManager()

  @objc public override init() {
    super.init()
  }

  @objc public func wireEventHandlers(
    stateChange: @escaping (NSString) -> Void,
    messageRaw: @escaping (NSString) -> Void,
    error: @escaping (NSDictionary) -> Void,
    close: @escaping (NSDictionary) -> Void
  ) {
    manager.emitStateChange = { state in
      stateChange(state as NSString)
    }
    manager.emitMessageRaw = { text in
      messageRaw(text as NSString)
    }
    manager.emitError = { (details: CordieriteErrorDetails) in
      let payload = NSMutableDictionary()
      payload["code"] = details.code as NSString
      payload["message"] = details.message as NSString
      payload["phase"] = details.phase as NSString
      if let nativeCode = details.nativeCode {
        payload["nativeCode"] = nativeCode as NSString
      }
      if let closeReason = details.closeReason {
        payload["closeReason"] = closeReason as NSString
      }
      if let isRetryable = details.isRetryable {
        payload["isRetryable"] = NSNumber(value: isRetryable)
      }
      if let hint = details.hint {
        payload["hint"] = hint as NSString
      }
      error(payload)
    }
    manager.emitClose = close
  }

  @objc public func connect(
    options: NSDictionary,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    guard let dict = options as? [String: Any] else {
      reject("E_CORDIERITE", "Invalid connect options.", nil)
      return
    }

    Task {
      do {
        try await self.manager.connect(options: dict)
        resolve(nil)
      } catch {
        reject("E_CORDIERITE", error.localizedDescription, error)
      }
    }
  }

  @objc public func send(
    message: NSString,
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    Task {
      do {
        try await self.manager.send(message: message as String)
        resolve(nil)
      } catch {
        reject("E_CORDIERITE", error.localizedDescription, error)
      }
    }
  }

  @objc public func close(
    resolve: @escaping (Any?) -> Void,
    reject: @escaping (String, String, Error?) -> Void
  ) {
    manager.close()
    resolve(nil)
  }

  @objc public func getState() -> NSString {
    (manager.state.rawValue as NSString)
  }
}
