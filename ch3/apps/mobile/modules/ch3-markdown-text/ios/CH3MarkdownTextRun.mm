#import "CH3MarkdownTextRun.h"
#import "CH3MarkdownText.h"
#import "CH3MarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/CH3MarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/CH3MarkdownTextSpec/Props.h>
#import <react/renderer/components/CH3MarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface CH3MarkdownTextRun () <RCTCH3MarkdownTextRunViewProtocol>

@end

@implementation CH3MarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<CH3MarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const CH3MarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<CH3MarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<CH3MarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::CH3MarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::CH3MarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::CH3MarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::CH3MarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> CH3MarkdownTextRunCls(void)
{
    return CH3MarkdownTextRun.class;
}

@end
