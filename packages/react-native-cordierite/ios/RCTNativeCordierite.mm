#import <CordieriteSpec/CordieriteSpec.h>
#import <React/RCTBridgeModule.h>

#import "Cordierite-Swift.h"

using namespace facebook::react;

@interface RCTNativeCordierite : NativeCordieriteSpecBase <NativeCordieriteSpec> {
  CordieriteTurboBridge *_swift;
}
@end

@implementation RCTNativeCordierite

RCT_EXPORT_MODULE(Cordierite)

- (instancetype)init
{
  if (self = [super init]) {
    _swift = [[CordieriteTurboBridge alloc] init];
    __weak __typeof__(self) weakSelf = self;
    [_swift
        wireEventHandlersWithStateChange:^(NSString *state) {
          [weakSelf emitOnStateChange:@{@"state" : state}];
        }
        messageRaw:^(NSString *raw) {
          [weakSelf emitOnMessage:@{@"rawMessage" : raw}];
        }
        error:^(NSString *code, NSString *message) {
          [weakSelf emitOnError:@{@"code" : code, @"message" : message}];
        }
        close:^(NSDictionary *payload) {
          NSMutableDictionary *out = [NSMutableDictionary dictionary];
          id codeVal = payload[@"code"];
          id reasonVal = payload[@"reason"];
          out[@"code"] = codeVal != nil ? codeVal : [NSNull null];
          out[@"reason"] = reasonVal != nil ? reasonVal : [NSNull null];
          [weakSelf emitOnClose:out];
        }];
  }
  return self;
}

- (std::shared_ptr<TurboModule>)getTurboModule:(const ObjCTurboModule::InitParams &)params
{
  return std::make_shared<NativeCordieriteSpecJSI>(params);
}

#pragma mark - NativeCordieriteSpec

- (void)connect:(JS::NativeCordierite::CordieriteConnectOptionsNative &)options
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
  NSMutableDictionary *opts = [@{
    @"ip" : options.ip(),
    @"port" : @(options.port()),
    @"sessionId" : options.sessionId(),
    @"token" : options.token(),
    @"expiresAt" : @(options.expiresAt()),
  } mutableCopy];

  NSString *deviceManufacturer = options.deviceManufacturer();
  if (deviceManufacturer != nil) {
    opts[@"deviceManufacturer"] = deviceManufacturer;
  }
  NSString *deviceModel = options.deviceModel();
  if (deviceModel != nil) {
    opts[@"deviceModel"] = deviceModel;
  }
  NSString *deviceOs = options.deviceOs();
  if (deviceOs != nil) {
    opts[@"deviceOs"] = deviceOs;
  }

  [_swift connectWithOptions:opts resolve:resolve reject:reject];
}

- (void)send:(NSString *)message resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_swift sendWithMessage:message resolve:resolve reject:reject];
}

- (void)close:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_swift closeWithResolve:resolve reject:reject];
}

- (NSString *)getState
{
  return (NSString *)[_swift getState];
}

@end
