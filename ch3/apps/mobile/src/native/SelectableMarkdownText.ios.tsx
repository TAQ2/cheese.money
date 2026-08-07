import {
  SelectableMarkdownText as CH3SelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@ch3tools/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@ch3tools/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return <CH3SelectableMarkdownText {...props} highlightCode={highlightCodeSnippet} />;
}
