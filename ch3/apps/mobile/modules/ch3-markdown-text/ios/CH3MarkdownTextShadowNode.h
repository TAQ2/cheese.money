#pragma once

#include <react/renderer/components/CH3MarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/CH3MarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char CH3MarkdownTextComponentName[];

struct CH3MarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct CH3MarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float CH3MarkdownTextAttachmentSize(const CH3MarkdownTextAttachmentRange &) {
  return 14;
}

inline Float CH3MarkdownTextAttachmentBaselineOffset(
    const CH3MarkdownTextAttachmentRange &) {
  return -2;
}

class CH3MarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<CH3MarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<CH3MarkdownTextAttachmentRange> attachmentRanges;
};

class CH3MarkdownTextShadowNode final : public ConcreteViewShadowNode<
CH3MarkdownTextComponentName,
CH3MarkdownTextProps,
CH3MarkdownTextEventEmitter,
CH3MarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  CH3MarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<CH3MarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<CH3MarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
