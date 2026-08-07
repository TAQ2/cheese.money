#pragma once

#include "CH3MarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using CH3MarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<CH3MarkdownTextRunShadowNode>;

void CH3MarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
