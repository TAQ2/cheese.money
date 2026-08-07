#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface CH3MarkdownTextManager : RCTViewManager
@end

@implementation CH3MarkdownTextManager

RCT_EXPORT_MODULE(CH3MarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface CH3MarkdownTextRunManager : RCTViewManager
@end

@implementation CH3MarkdownTextRunManager

RCT_EXPORT_MODULE(CH3MarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
