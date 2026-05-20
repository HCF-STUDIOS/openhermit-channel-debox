/**
 * Markdown → Debox-friendly text helpers.
 *
 * Debox accepts several `parse_mode` values (text / rich_text / markdown
 * / markdown_v2 / html / image / video / file). The simplest, safest
 * choice for arbitrary agent output is `markdown`. Long messages are
 * chunked on paragraph/sentence boundaries to stay under the documented
 * 5000-character text limit.
 */

import { marked } from 'marked';
import remend from 'remend';

const DEBOX_MAX_LENGTH = 5000;

export interface FormattedChunk {
  text: string;
  parseMode: 'markdown';
}

const splitMessage = (text: string): string[] => {
  if (text.length <= DEBOX_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DEBOX_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf('\n\n', DEBOX_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf('\n', DEBOX_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(' ', DEBOX_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = DEBOX_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  return chunks;
};

/**
 * Render arbitrary agent markdown into a single string we can hand to
 * Debox's `markdown` parse mode. We currently rely on Debox's own
 * markdown renderer for the heavy lifting, and only normalise whitespace
 * to keep messages compact.
 */
export const normalizeMarkdown = (md: string): string => {
  return md.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * Best-effort streaming markdown: closes any unbalanced markers via
 * `remend` so partial output renders cleanly during a streaming edit.
 */
export const normalizeStreamingMarkdown = (partial: string): string => {
  return normalizeMarkdown(remend(partial, { linkMode: 'text-only' }));
};

export const formatAgentResponse = (text: string): FormattedChunk[] => {
  const normalized = normalizeMarkdown(text);
  return splitMessage(normalized).map((chunk) => ({
    text: chunk,
    parseMode: 'markdown' as const,
  }));
};

/**
 * Strip markdown formatting to plain text. Used as a last-resort
 * fallback when Debox rejects markdown content.
 */
export const toPlainText = (md: string): string => {
  const html = marked.parse(normalizeMarkdown(md), { async: false }) as string;
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
