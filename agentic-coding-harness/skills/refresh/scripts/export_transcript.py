#!/usr/bin/env python3
"""Export a Claude Code session transcript (.jsonl) to readable markdown.

Usage: python3 export_transcript.py <session.jsonl> <output.md>

Keeps: user messages, assistant text, tool calls (name + truncated input),
tool results (truncated). Drops: thinking blocks, non-message records.
"""
import json
import sys


def content_to_md(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if not isinstance(block, dict):
            continue
        t = block.get("type")
        if t == "text":
            parts.append(block.get("text", ""))
        elif t == "tool_use":
            inp = json.dumps(block.get("input", {}), ensure_ascii=False)
            if len(inp) > 2000:
                inp = inp[:2000] + " …[truncated]"
            parts.append(f"**[tool_use: {block.get('name')}]**\n`{inp}`")
        elif t == "tool_result":
            c = block.get("content")
            if isinstance(c, list):
                c = "\n".join(
                    b.get("text", "")
                    for b in c
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            c = str(c or "")
            if len(c) > 3000:
                c = c[:3000] + " …[truncated]"
            parts.append(f"**[tool_result]**\n```\n{c}\n```")
        # thinking blocks intentionally skipped
    return "\n\n".join(p for p in parts if p and p.strip())


def main(path, out):
    n = 0
    with open(path, encoding="utf-8") as f, open(out, "w", encoding="utf-8") as o:
        o.write(f"# Conversation log export\n\nSource: `{path}`\n\n---\n\n")
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("type") not in ("user", "assistant"):
                continue
            msg = rec.get("message", {})
            if not isinstance(msg, dict):
                continue
            md = content_to_md(msg.get("content"))
            if not md.strip():
                continue
            role = msg.get("role", rec.get("type", "?")).upper()
            ts = rec.get("timestamp", "")
            o.write(f"## {role}  ({ts})\n\n{md}\n\n---\n\n")
            n += 1
    print(f"Exported {n} messages -> {out}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: export_transcript.py <session.jsonl> <output.md>")
    main(sys.argv[1], sys.argv[2])
