import sanitizeHtml from 'sanitize-html';

// Every inbound email is treated as hostile (BUILD_SPEC §10). This allowlist keeps ordinary email
// formatting (tables, fonts, colours, images) and drops everything that can execute or exfiltrate:
// scripts, event handlers, <style>/<link>/<iframe>/<form>, javascript: and other unsafe URL schemes,
// and CSS functions such as url() or expression(). The browser also renders the result in a
// script-less sandboxed iframe with a strict CSP, so this is one of two independent walls.

// A CSS value with no functions, quotes or escapes: lengths, keywords, plain font names.
const PLAIN_VALUE = /^[a-z0-9\s.,#%+-]+$/i;
// Colours additionally allow rgb()/rgba()/hsl() with numbers only.
const COLOR_VALUE = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|rgba|hsl|hsla)\(\s*[\d.\s,%]+\))$/i;
const FONT_FAMILY = /^[a-z0-9\s,"'-]+$/i;

const PLAIN_PROPS = [
  'font-size',
  'font-weight',
  'font-style',
  'text-align',
  'text-decoration',
  'text-indent',
  'text-transform',
  'line-height',
  'letter-spacing',
  'vertical-align',
  'white-space',
  'width',
  'height',
  'max-width',
  'min-width',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-width',
  'border-style',
  'border-collapse',
  'border-spacing',
  'border-radius',
  'list-style-type',
  'display',
];

const allowedStyles: Record<string, RegExp[]> = {
  ...Object.fromEntries(PLAIN_PROPS.map((p) => [p, [PLAIN_VALUE]])),
  color: [COLOR_VALUE],
  'background-color': [COLOR_VALUE],
  'border-color': [COLOR_VALUE],
  'font-family': [FONT_FAMILY],
};

/** Class marking where quoted history begins (shared with the web app's quote folding). */
export const QUOTE_CLASS = 'rd-quote-start';
const OUTLOOK_QUOTE_IDS = new Set(['divRplyFwdMsg', 'appendonsend', 'mail-editor-reference-message-container']);

const TABLE_ATTRS = [
  'width',
  'height',
  'align',
  'valign',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'colspan',
  'rowspan',
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'font', 'center'],
  allowedAttributes: {
    '*': ['style', 'align', 'dir', 'lang', 'title'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    font: ['color', 'size', 'face'],
    table: TABLE_ATTRS,
    td: TABLE_ATTRS,
    th: TABLE_ATTRS,
    tr: TABLE_ATTRS,
    col: ['width', 'span'],
    colgroup: ['width', 'span'],
    ol: ['start', 'type'],
  },
  allowedStyles: { '*': allowedStyles },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  // Drop the contents of these, not just the tags (default also covers script/style/textarea).
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head'],
  // The only classes kept: markers for where quoted reply history starts, so the reading pane can
  // fold it away like Outlook does. Gmail marks it with "gmail_quote"; Outlook uses element ids
  // (ids are dropped), which transformTags converts into our own "rd-quote-start" class.
  allowedClasses: { div: [QUOTE_CLASS, 'gmail_quote'], blockquote: ['gmail_quote'] },
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
    }),
    div: (tagName, attribs) =>
      attribs.id && OUTLOOK_QUOTE_IDS.has(attribs.id)
        ? { tagName, attribs: { ...attribs, class: `${attribs.class ?? ''} ${QUOTE_CLASS}`.trim() } }
        : { tagName, attribs },
  },
};

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}

// Internal notes may also carry @mentions of colleagues (the editor's mention spans). Only notes
// get this, so an email can never pass itself off as mentioning someone.
const NOTE_OPTIONS: sanitizeHtml.IOptions = {
  ...OPTIONS,
  allowedAttributes: {
    ...(OPTIONS.allowedAttributes as Record<string, sanitizeHtml.AllowedAttribute[]>),
    span: ['data-type', 'data-id', 'data-label'],
  },
  allowedClasses: { ...OPTIONS.allowedClasses, span: ['mention'] },
};

export function sanitizeNoteHtml(html: string): string {
  return sanitizeHtml(html, NOTE_OPTIONS).trim();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/** Plain-text version of an email body, for search and previews. */
export function htmlToText(html: string): string {
  const withBreaks = html.replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/blockquote)\b[^>]*>/gi, '\n$&');
  const stripped = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: OPTIONS.nonTextTags,
  });
  return stripped
    .replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Ticket reference in a subject line, e.g. "Re: Your enquiry [REG-2026-001042]". */
export function findTicketReference(subject: string | null | undefined): string | null {
  return subject?.match(/\bREG-\d{4}-\d{6}\b/)?.[0] ?? null;
}

/**
 * Notices that Exchange adds to the top of external mail. They stay in the email body (as in
 * Outlook) but are dropped from the list-pane preview so officers see what the shareholder wrote.
 * Admins can add more under Admin → Settings ("external-sender tag text"); see `phrasePatterns`.
 */
export const EXTERNAL_BANNER_PATTERNS: RegExp[] = [
  /CAUTION: This email originated from outside[^\n]*?(?:is safe\.*|\n|$)/gi,
  /(?:Some people who received this message don't|You don't) often get email from \S+\.?(?:\s*Learn why this is important)?/gi,
  // The same tip's link when it comes through as plain text: "[ at https://aka.ms/… ]" or "<https://aka.ms/…>".
  /[[<(]?\s*(?:at\s+)?https:\/\/aka\.ms\/LearnAboutSenderIdentification\s*[\]>)]?/gi,
];

/**
 * Turns admin-entered banner phrases (Admin → Settings) into patterns: each phrase removes itself
 * and the rest of its line, matched case-insensitively as plain text.
 */
export function phrasePatterns(phrases: string[]): RegExp[] {
  return phrases
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp(`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\n]*`, 'gi'));
}

/**
 * Preview text for the message list: the body without external-sender banners (the built-in ones
 * plus any phrases from settings), on one line.
 */
export function makeSnippet(bodyText: string, maxLength = 200, extraPhrases: string[] = []): string {
  let text = bodyText;
  for (const pattern of [...EXTERNAL_BANNER_PATTERNS, ...phrasePatterns(extraPhrases)])
    text = text.replace(pattern, ' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
