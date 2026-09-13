import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { ServerProviderSkill } from "@ch3tools/contracts";

import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import { detectProseFilePaths } from "./proseFilePaths";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "../composerInlineChip";
import { cn } from "~/lib/utils";

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

/**
 * Turns one absolute path found in prose into a chip, or returns null to
 * leave it as text.
 *
 * A callback rather than something this module resolves itself: deciding that
 * a path names a real file needs the thread's cwd and environment, which live
 * in `ChatMarkdown`, and the chip it builds is the same one a backticked path
 * gets. Absent — a caller with no cwd — paths stay as they are today.
 */
export type InlineFilePathRenderer = (path: string, key: string) => ReactNode | null;

export interface InlineTextOptions {
  readonly skills: ReadonlyArray<InlineSkill>;
  readonly renderFilePath?: InlineFilePathRenderer | undefined;
}

/** One token found in prose, at the position it was found. */
interface InlineToken {
  readonly start: number;
  readonly end: number;
  readonly node: ReactNode;
}

/**
 * Prose with its inline tokens replaced by chips: `$skill` names, and now
 * absolute file paths.
 *
 * Both kinds are collected into ONE ordered pass rather than each getting its
 * own walk. Two passes over the same string would have to re-scan the nodes
 * the first one had already replaced, and the second scanner would see chips
 * where it expected text.
 */
export function SkillInlineText(
  props: { text: string; skills: ReadonlyArray<InlineSkill> } & Pick<
    InlineTextOptions,
    "renderFilePath"
  >,
) {
  const tokens: InlineToken[] = [];

  for (const match of props.text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const rawText = `$${name}`;
    const skill = props.skills.find((candidate) => candidate.name === name);
    if (!skill) {
      continue;
    }
    tokens.push({
      start,
      end: start + rawText.length,
      node: <SkillChip key={`skill:${start}:${name}`} skill={skill} rawText={rawText} />,
    });
  }

  if (props.renderFilePath) {
    for (const match of detectProseFilePaths(props.text)) {
      const node = props.renderFilePath(match.path, `path:${match.start}`);
      if (node === null) continue;
      tokens.push({ start: match.start, end: match.end, node });
    }
  }

  if (tokens.length === 0) {
    return <>{props.text}</>;
  }

  tokens.sort((left, right) => left.start - right.start);

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    // A skill name inside a path, or any other overlap, keeps whichever token
    // started first; the loser is dropped rather than allowed to slice the
    // text twice.
    if (token.start < cursor) continue;
    if (token.start > cursor) {
      nodes.push(props.text.slice(cursor, token.start));
    }
    nodes.push(token.node);
    cursor = token.end;
  }

  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<InlineSkill>,
  renderFilePath?: InlineFilePathRenderer,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} renderFilePath={renderFilePath} />;
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    // Custom react-markdown components replace the intrinsic type, so also
    // check the hast node they carry.
    const markdownTagName = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (markdownTagName === "code" || markdownTagName === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(child.props.children, skills, renderFilePath),
    );
  });
}

function SkillChip(props: { skill: InlineSkill; rawText: string }) {
  return (
    <span className="inline-flex align-middle leading-none" data-markdown-copy={props.rawText}>
      <span
        className={cn(
          CHAT_INLINE_CHIP_CLASS_NAME,
          "border-fuchsia-500/25 bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300",
        )}
      >
        <span
          aria-hidden="true"
          className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
          dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
        />
        <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>
          {formatProviderSkillDisplayName(props.skill)}
        </span>
      </span>
    </span>
  );
}
