import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTicketReference,
  htmlToText,
  makeSnippet,
  sanitizeEmailHtml,
  sanitizeNoteHtml,
} from '../src/services/mail/sanitize.ts';
import { extractMentionIds } from '../src/services/notifications/mentions.ts';

describe('sanitizeEmailHtml — hostile input', () => {
  const cases: [string, string, RegExp][] = [
    ['script tags and their contents', '<p>Hi</p><script>alert(1)</script>', /script|alert/i],
    ['event handler attributes', '<img src="https://x.test/a.png" onerror="alert(1)">', /onerror|alert/i],
    ['javascript: links', '<a href="javascript:alert(1)">click</a>', /javascript:/i],
    ['data: links (only images may use data:)', '<a href="data:text/html,<script>alert(1)</script>">x</a>', /data:/i],
    ['iframes', '<iframe src="https://evil.test"></iframe>', /iframe|evil/i],
    ['forms and inputs', '<form action="https://evil.test"><input name="pw"></form>', /form|input|evil/i],
    ['style blocks', '<style>body{background:url(https://evil.test/t.png)}</style><p>x</p>', /style|evil/i],
    [
      'link/meta tags',
      '<link rel="stylesheet" href="https://evil.test/a.css"><meta http-equiv="refresh" content="0;url=https://evil.test">',
      /link|meta|evil/i,
    ],
    [
      'css url() in inline style',
      '<p style="background-color: red; background-image: url(https://evil.test/t.png)">x</p>',
      /url\(|evil/i,
    ],
    ['css expression()', '<p style="width: expression(alert(1))">x</p>', /expression|alert/i],
    [
      'svg with script',
      '<svg><script>alert(1)</script><a xlink:href="javascript:alert(1)"></a></svg>',
      /svg|script|alert|javascript/i,
    ],
    ['protocol-relative image', '<img src="//evil.test/t.png">', /evil/i],
    ['obfuscated javascript scheme', '<a href="jav&#x09;ascript:alert(1)">x</a>', /alert/i],
    // Phase 8 additions: other well-known bypass families.
    ['entity-encoded javascript scheme', '<a href="&#106;avascript:alert(1)">x</a>', /alert/i],
    ['javascript: image source', '<img src="javascript:alert(1)">', /javascript|alert/i],
    [
      'object and embed',
      '<object data="https://evil.test/x.swf"></object><embed src="https://evil.test/x">',
      /object|embed|evil/i,
    ],
    ['base href (would redirect relative links)', '<base href="https://evil.test/"><a href="/x">x</a>', /base|evil/i],
    ['remote srcset', '<img src="https://ok.test/a.png" srcset="https://evil.test/t.png 2x">', /srcset|evil/i],
    [
      'noscript mutation XSS',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
      /onerror|alert/i,
    ],
    [
      'math/style mutation XSS',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
      /onerror|alert/i,
    ],
    ['template contents', '<template><img src=x onerror=alert(1)></template>', /onerror|alert/i],
    ['vbscript scheme', '<a href="vbscript:msgbox(1)">x</a>', /vbscript/i],
    [
      'css behaviour / -moz-binding',
      '<p style="behavior:url(x.htc);-moz-binding:url(https://evil.test/x)">x</p>',
      /behavior|binding|evil/i,
    ],
  ];

  for (const [name, input, forbidden] of cases) {
    it(`removes ${name}`, () => {
      assert.doesNotMatch(sanitizeEmailHtml(input), forbidden);
    });
  }
});

describe('sanitizeEmailHtml — ordinary formatting survives', () => {
  it('keeps paragraphs, emphasis, lists and tables', () => {
    const html =
      '<p>Hello <b>there</b></p><ul><li>One</li></ul><table border="1"><tr><td colspan="2">Cell</td></tr></table>';
    assert.equal(
      sanitizeEmailHtml(html),
      '<p>Hello <b>there</b></p><ul><li>One</li></ul><table border="1"><tr><td colspan="2">Cell</td></tr></table>',
    );
  });

  it('keeps safe inline styles and colours', () => {
    const out = sanitizeEmailHtml('<p style="color: rgb(0, 0, 255); font-size: 14px; text-align: center">x</p>');
    assert.match(out, /color:rgb\(0, 0, 255\)/);
    assert.match(out, /font-size:14px/);
  });

  it('forces links to open in a new tab without referrer', () => {
    assert.equal(
      sanitizeEmailHtml('<a href="https://example.com">site</a>'),
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a>',
    );
  });

  it('keeps data: and https images', () => {
    assert.match(sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">'), /data:image\/png/);
    assert.match(sanitizeEmailHtml('<img src="https://cdn.example.com/a.png">'), /https:\/\/cdn\.example\.com/);
  });
});

describe('htmlToText', () => {
  it('turns markup into readable text', () => {
    assert.equal(
      htmlToText('<p>Dear Sir,</p><p>My account&nbsp;no. is <b>ZH-1</b> &amp; more.</p><script>x()</script>'),
      'Dear Sir,\nMy account no. is ZH-1 & more.',
    );
  });
});

describe('findTicketReference', () => {
  it('finds a reference anywhere in the subject', () => {
    assert.equal(findTicketReference('RE: Your enquiry [REG-2026-001042] dividend'), 'REG-2026-001042');
  });
  it('returns null when there is none', () => {
    assert.equal(findTicketReference('Dividend REG-26-1'), null);
    assert.equal(findTicketReference(undefined), null);
  });
});

describe('makeSnippet', () => {
  it('drops the external-sender caution banner', () => {
    const body =
      'CAUTION: This email originated from outside of the organisation. Do not open attachment(s) or click on link(s) unless you recognize the sender and know the content is safe..\nGood morning,\nMy dividend was not paid.';
    assert.equal(makeSnippet(body), 'Good morning, My dividend was not paid.');
  });

  it('drops the first-contact safety tip', () => {
    assert.equal(
      makeSnippet(
        "You don't often get email from someone@example.com. Learn why this is important\nPlease update my address.",
      ),
      'Please update my address.',
    );
    assert.equal(
      makeSnippet(
        "Some people who received this message don't often get email from a@b.co. Learn why this is important\nHello",
      ),
      'Hello',
    );
  });

  it('drops the safety-tip link when it arrives as plain text', () => {
    assert.equal(
      makeSnippet('[ at https://aka.ms/LearnAboutSenderIdentification ] Dear Sir/Madam, I am writing'),
      'Dear Sir/Madam, I am writing',
    );
    assert.equal(makeSnippet('Learn why<https://aka.ms/LearnAboutSenderIdentification> Hello'), 'Learn why Hello');
  });

  it('leaves ordinary text alone and truncates', () => {
    assert.equal(makeSnippet('Hello\n\nthere', 8), 'Hello th');
  });
});

describe('sanitizeEmailHtml — quoted history markers', () => {
  it('turns Outlook reply-header ids into the quote class and drops other ids/classes', () => {
    const out = sanitizeEmailHtml(
      '<div id="divRplyFwdMsg" class="x"><b>From:</b> A</div><div class="evil" id="y">B</div>',
    );
    assert.equal(out, '<div class="rd-quote-start"><b>From:</b> A</div><div>B</div>');
  });
  it('keeps the Gmail quote class', () => {
    assert.match(sanitizeEmailHtml('<div class="gmail_quote">On Mon wrote:</div>'), /class="gmail_quote"/);
  });
});

describe('@mentions in internal notes', () => {
  const id = '6ad73cea0620e8502532056a';
  const mention = `<span data-type="mention" class="mention" data-id="${id}" data-label="Ada">@Ada</span>`;

  it('notes keep mention spans; emails drop them', () => {
    assert.match(sanitizeNoteHtml(`<p>Hi ${mention}</p>`), new RegExp(`data-id="${id}"`));
    assert.match(sanitizeNoteHtml(`<p>${mention}</p>`), /class="mention"/);
    assert.doesNotMatch(sanitizeEmailHtml(`<p>${mention}</p>`), /data-id|data-type/);
  });

  it('notes still strip anything that can run', () => {
    const out = sanitizeNoteHtml(
      `<span data-type="mention" data-id="${id}" onclick="alert(1)" data-x="1" class="mention evil">@A</span><script>x</script>`,
    );
    assert.doesNotMatch(out, /onclick|data-x|evil|script/);
  });

  it('finds each mentioned officer once', () => {
    const other = '6ad73cea0620e8502532056b';
    const html = sanitizeNoteHtml(
      `<p>${mention} and <span data-type="mention" data-id="${other}">@B</span> and ${mention}</p>`,
    );
    assert.deepEqual(extractMentionIds(html), [id, other]);
  });

  it('ignores spans that are not mentions or carry a bad id', () => {
    assert.deepEqual(extractMentionIds(`<span data-id="${id}">x</span>`), []);
    assert.deepEqual(extractMentionIds('<span data-type="mention" data-id="nope">x</span>'), []);
  });
});
