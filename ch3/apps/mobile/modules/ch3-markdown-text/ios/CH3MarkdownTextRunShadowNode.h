#pragma once

#include <react/renderer/components/CH3MarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/CH3MarkdownTextSpec/Props.h>
#include <react/renderer/components/CH3MarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char CH3MarkdownTextRunComponentName[];

using CH3MarkdownTextRunShadowNode = ConcreteViewShadowNode<
    CH3MarkdownTextRunComponentName,
    CH3MarkdownTextRunProps,
    CH3MarkdownTextRunEventEmitter,
    CH3MarkdownTextRunState>;
}
