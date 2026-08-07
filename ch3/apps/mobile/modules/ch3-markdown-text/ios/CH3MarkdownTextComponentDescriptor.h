#pragma once

#include "CH3MarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using CH3MarkdownTextComponentDescriptor = ConcreteComponentDescriptor<CH3MarkdownTextShadowNode>;

void CH3MarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
