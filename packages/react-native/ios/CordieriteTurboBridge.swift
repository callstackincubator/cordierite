import Foundation

// Default-inert release builds: compiled out entirely unless
// this is a debug build, or the app has explicitly opted in via `CORDIERITE_ENABLE_RELEASE` (a
// Swift compilation condition the config plugin's `enableInReleaseBuilds` option adds to
// `SWIFT_ACTIVE_COMPILATION_CONDITIONS` on the *app* target — mirroring the `CORDIERITE_ENABLE_RELEASE`
// preprocessor flag `RCTNativeCordierite.mm` gates on). `RCTNativeCordierite.mm`'s `@interface`
// declares an ivar of this class's type, so that file is gated identically — the two must always
// agree on whether this class exists in a given build. Plain `#if DEBUG` is a reliable gate for
// this pod's own generated Debug configuration; custom configs other
// than Debug/Release don't get `DEBUG` and stay inert unless `CORDIERITE_ENABLE_RELEASE` is set.
#if DEBUG || CORDIERITE_ENABLE_RELEASE

/// Bridges Swift connection logic to Objective-C++ (`RCTNativeCordierite`).
///
/// `@unchecked Sendable`: the only stored state is `manager`, an actor reference (itself
/// `Sendable`); this class has no other mutable state, so capturing `self` in the `Task {}`
/// blocks below is sound.
@objc(CordieriteTurboBridge)
public final class CordieriteTurboBridge: NSObject, @unchecked Sendable {
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
    resolve: @escaping @Sendable (Any?) -> Void,
    reject: @escaping @Sendable (String, String, Error?) -> Void
  ) {
    // Parsed synchronously, before any actor hop: `CordieriteConnectOptions` is `Sendable`, so
    // this is the only value that needs to cross into the connection manager's actor.
    guard let dict = options as? [String: Any] else {
      reject("E_CORDIERITE", "Invalid connect options.", nil)
      return
    }

    let parsedOptions: CordieriteConnectOptions
    do {
      parsedOptions = try CordieriteConnectOptions(dict)
    } catch {
      reject("E_CORDIERITE", error.localizedDescription, error)
      return
    }

    Task {
      do {
        try await self.manager.connect(options: parsedOptions)
        resolve(nil)
      } catch {
        reject("E_CORDIERITE", error.localizedDescription, error)
      }
    }
  }

  @objc public func send(
    message: NSString,
    resolve: @escaping @Sendable (Any?) -> Void,
    reject: @escaping @Sendable (String, String, Error?) -> Void
  ) {
    let message = message as String
    Task {
      do {
        try await self.manager.send(message: message)
        resolve(nil)
      } catch {
        reject("E_CORDIERITE", error.localizedDescription, error)
      }
    }
  }

  @objc public func close(
    resolve: @escaping @Sendable (Any?) -> Void,
    reject: @escaping @Sendable (String, String, Error?) -> Void
  ) {
    Task {
      await self.manager.close()
      resolve(nil)
    }
  }

  @objc public func getState() -> NSString {
    (manager.currentStateSnapshot() as NSString)
  }

  @objc public func getResumeLease() -> NSDictionary? {
    manager.currentResumeLeaseRecord()
  }

  @objc public func clearResumeLease() {
    manager.clearResumeLease()
  }

  /// TurboModule invalidation entry point (see `RCTNativeCordierite.invalidate`). Cancels the
  /// socket, invalidates the URLSession, and drops event callbacks so a Metro reload fully
  /// releases the transport instead of leaving a wedged "connecting or active" state.
  @objc public func invalidate() {
    Task {
      await self.manager.invalidate()
    }
  }
}

#endif // DEBUG || CORDIERITE_ENABLE_RELEASE
