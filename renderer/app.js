(function () {
  const noopApi = {
    getInitialFile: async () => ({ canceled: true }),
    openFile: async () => ({ canceled: true }),
    reloadIfChanged: async () => ({ changed: false }),
    saveFile: async () => ({ canceled: true }),
    saveFileAs: async () => ({ canceled: true }),
    exportHtml: async () => ({ canceled: true }),
    exportFile: async () => ({ canceled: true }),
    exportPdf: async () => ({ canceled: true }),
    openTarget: async () => ({ ok: false }),
    writeClipboard: async () => ({ ok: true }),
    getSpellcheckEnabled: async () => true,
    getTheme: async () => 'light',
    setTheme: async (theme) => theme,
    newWindow: async () => ({ ok: true }),
    confirmCloseDocument: async () => 'discard',
    zoomIn: async () => 0,
    zoomOut: async () => 0,
    zoomReset: async () => 0,
    onThemeChanged: () => () => {},
    onSpellcheckEnabledChanged: () => () => {},
    sendCloseState: () => {},
    onCloseStateRequest: () => () => {},
    onCloseApproved: () => () => {},
    onEditorCommand: () => () => {},
    onCommand: () => () => {}
  };

  const api = window.tachylite || noopApi;
  const ZOOM_WHEEL_THRESHOLD = 90;
  const markdownit = window.markdownit;
  const DOMPurify = window.DOMPurify;
  const TurndownService = window.TurndownService;

  const md = markdownit({
    html: false,
    linkify: true,
    typographer: true
  });

  md.block.ruler.before('hr', 'front_matter', (state, startLine, endLine, silent) => {
    if (startLine !== 0) return false;

    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];

    if (state.src.slice(start, max).trim() !== '---') return false;

    let closeLine = -1;

    for (let line = startLine + 1; line < endLine; line += 1) {
      const lineStart = state.bMarks[line] + state.tShift[line];
      const lineMax = state.eMarks[line];

      if (state.src.slice(lineStart, lineMax).trim() === '---') {
        closeLine = line;
        break;
      }
    }

    if (closeLine === -1) return false;
    if (silent) return true;

    const token = state.push('front_matter', 'pre', 0);
    token.content = state.getLines(startLine, closeLine + 1, 0, false);
    token.map = [startLine, closeLine + 1];
    state.line = closeLine + 1;

    return true;
  });

  md.renderer.rules.front_matter = (tokens, index) => {
    return `<pre data-frontmatter="true"><code class="language-yaml">${escapeHtml(tokens[index].content)}</code></pre>\n`;
  };

  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*'
  });

  turndown.keep(['kbd']);
  turndown.addRule('frontMatter', {
    filter: (node) => {
      return node.nodeType === Node.ELEMENT_NODE && node.matches('pre[data-frontmatter="true"]');
    },
    replacement: (_content, node) => {
      return `${normalizeLineEndings(node.textContent || '').trimEnd()}\n\n`;
    }
  });

  turndown.addRule('headings', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => {
      const level = Number(node.nodeName.charAt(1));
      return `\n\n${'#'.repeat(level)} ${content.trim()}\n\n`;
    }
  });

  turndown.addRule('strikethrough', {
    filter: ['del', 's', 'strike'],
    replacement: (content) => `~~${content}~~`
  });

  turndown.addRule('listItems', {
    filter: 'li',
    replacement: (content, node, options) => {
      const parent = node.parentNode;
      const isOrdered = parent && parent.nodeName === 'OL';
      const start = isOrdered ? Number(parent.getAttribute('start')) || 1 : 1;
      const index = isOrdered ? Array.prototype.indexOf.call(parent.children, node) : 0;
      const prefix = isOrdered ? `${start + index}. ` : `${options.bulletListMarker} `;
      const normalized = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/g, '\n    ');

      return `${prefix}${normalized}${node.nextSibling && !/\n$/.test(normalized) ? '\n' : ''}`;
    }
  });

  turndown.addRule('typedWrapTokens', {
    filter: (node) => {
      return node.nodeName === 'SPAN' && node.hasAttribute('data-typed-wrap-token');
    },
    replacement: (content, node) => {
      const token = node.getAttribute('data-typed-wrap-token') || '';

      return node.textContent === token ? token : content;
    }
  });

  function escapeMarkdownLinkText(text) {
    return text.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
  }

  function escapeMarkdownLinkTarget(href) {
    return href.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
  }

  function editableInlineText(element) {
    return (element.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r?\n/g, ' ')
      .trim();
  }

  function linkEditorParts(editor) {
    const textPart = editor.querySelector('[data-link-part="text"]');
    const hrefPart = editor.querySelector('[data-link-part="href"]');
    const href = editableInlineText(hrefPart);
    const text = editableInlineText(textPart) || href;
    const title = editor.dataset.originalTitle || '';

    return { text, href, title };
  }

  function markdownLink(text, href, title = '') {
    if (!href) return text;
    const escapedText = escapeMarkdownLinkText(text || href);
    const escapedTarget = escapeMarkdownLinkTarget(href);

    if (title) {
      return `[${escapedText}](${escapedTarget} "${title.replace(/"/g, '\\"')}")`;
    }

    return `[${escapedText}](${escapedTarget})`;
  }

  function languageFromInfoString(info) {
    return (info || '').trim().split(/\s+/)[0].replace(/[^A-Za-z0-9_-]/g, '');
  }

  function codeBlockLanguage(code) {
    const className = code.getAttribute('class') || '';
    const languageClass = className.split(/\s+/).find((name) => name.startsWith('language-'));

    return languageClass ? languageClass.replace(/^language-/, '') : '';
  }

  function fencedCodeMarkdown(codeText, language = '') {
    const body = normalizeLineEndings(codeText || '').replace(/\n$/, '');
    const info = languageFromInfoString(language);

    return `\`\`\`${info}\n${body}\n\`\`\``;
  }

  function codeEditorMarkdown(editor) {
    const attributeMarkdown = editor.getAttribute('data-code-markdown');

    if (attributeMarkdown !== null) {
      return normalizeLineEndings(attributeMarkdown).replace(/\u200b/g, '').trimEnd();
    }

    const textarea = editor.querySelector('textarea');

    return normalizeLineEndings(textarea ? textarea.value : '').replace(/\u200b/g, '').trimEnd();
  }

  function mirrorCodeEditorTextareaValue(editor = state.activeCodeEditor) {
    const textarea = editor ? editor.querySelector('textarea') : null;

    if (!textarea) {
      return;
    }

    editor.dataset.codeMarkdown = textarea.value;
    textarea.defaultValue = textarea.value;
    textarea.textContent = textarea.value;
  }

  function parseFencedCode(markdown) {
    const normalized = normalizeLineEndings(markdown || '').replace(/\u200b/g, '');
    const lines = normalized.trimEnd().split('\n');
    const opening = lines[0] ? lines[0].match(/^\s{0,3}(`{3,}|~{3,})\s*([^\n]*)$/) : null;

    if (opening && lines.length >= 2) {
      const marker = opening[1];
      const markerChar = marker[0];

      for (let index = lines.length - 1; index > 0; index -= 1) {
        const closing = lines[index].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);

        if (closing && closing[1][0] === markerChar && closing[1].length >= marker.length) {
          return {
            code: lines.slice(1, index).join('\n'),
            language: languageFromInfoString(opening[2])
          };
        }
      }
    }

    return {
      code: normalized.trimEnd(),
      language: ''
    };
  }

  function codeBlockFromMarkdown(markdown) {
    const parsed = parseFencedCode(markdown);
    const pre = document.createElement('pre');
    const code = document.createElement('code');

    if (parsed.language) {
      code.className = `language-${parsed.language}`;
    }

    code.textContent = parsed.code;
    pre.appendChild(code);

    return pre;
  }

  function frontMatterBlockFromMarkdown(markdown) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');

    pre.dataset.frontmatter = 'true';
    code.className = 'language-yaml';
    code.textContent = normalizeLineEndings(markdown || '').trimEnd();
    pre.appendChild(code);

    return pre;
  }

  function completedFencedCodeBlock(markdown) {
    const normalized = normalizeLineEndings(markdown || '').replace(/\u200b/g, '').trim();
    const lines = normalized.split('\n');
    const opening = lines[0] ? lines[0].match(/^\s{0,3}(`{3,}|~{3,})[^\n]*$/) : null;
    const closing = lines.length > 1 ? lines[lines.length - 1].match(/^\s{0,3}(`{3,}|~{3,})\s*$/) : null;

    if (!opening || !closing) {
      return null;
    }

    if (closing[1][0] !== opening[1][0] || closing[1].length < opening[1].length) {
      return null;
    }

    return normalized;
  }

  function hasCompletedFencedCodeBlock(markdown) {
    const lines = normalizeLineEndings(markdown || '').replace(/\u200b/g, '').split('\n');
    let opening = null;

    for (const line of lines) {
      if (!opening) {
        const match = line.match(/^\s{0,3}(`{3,}|~{3,})[^\n]*$/);

        if (match) {
          opening = match[1];
        }

        continue;
      }

      const closing = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);

      if (closing && closing[1][0] === opening[0] && closing[1].length >= opening.length) {
        return true;
      }
    }

    return false;
  }

  turndown.addRule('links', {
    filter: 'a',
    replacement: (content, node) => {
      const href = node.getAttribute('data-md-href') || node.getAttribute('href') || '';
      const label = content.trim() || href;
      const title = node.getAttribute('title');

      if (!href) return label;

      if (title) {
        return `[${label}](${escapeMarkdownLinkTarget(href)} "${title.replace(/"/g, '\\"')}")`;
      }

      return `[${label}](${escapeMarkdownLinkTarget(href)})`;
    }
  });

  turndown.addRule('linkEditors', {
    filter: (node) => {
      return node.nodeType === Node.ELEMENT_NODE && node.matches('[data-link-editor="true"]');
    },
    replacement: (_content, node) => {
      const { text, href, title } = linkEditorParts(node);
      return markdownLink(text, href, title);
    }
  });

  turndown.addRule('codeBlockEditors', {
    filter: (node) => {
      return node.nodeType === Node.ELEMENT_NODE && node.matches('[data-code-editor="true"]');
    },
    replacement: (_content, node) => {
      const markdown = codeEditorMarkdown(node);

      return markdown ? `\n\n${markdown}\n\n` : '';
    }
  });

  turndown.addRule('inlineCodeEditors', {
    filter: (node) => {
      return node.nodeType === Node.ELEMENT_NODE && node.matches('[data-inline-code-editor="true"]');
    },
    replacement: (_content, node) => {
      return node.textContent || '';
    }
  });

  turndown.addRule('generatedUi', {
    filter: (node) => {
      return node.nodeType === Node.ELEMENT_NODE && node.matches('[data-generated-ui="true"]');
    },
    replacement: () => ''
  });

  const state = {
    content: '',
    filePath: null,
    fileName: 'Untitled.md',
    baseDirUrl: null,
    diskMtimeMs: null,
    dirty: false,
    tabs: [],
    activeTabId: null,
    nextTabId: 1,
    mode: 'preview',
    syncing: false,
    previewInputPending: false,
    closeApproved: false,
    spellcheckEnabled: true,
    theme: 'light',
    activeLinkEditor: null,
    activeInlineCodeEditor: null,
    activeCodeEditor: null,
    checkingExternalChanges: false,
    zoomWheelDelta: 0,
    outlineVisible: false,
    outline: [],
    find: {
      open: false,
      query: '',
      scope: 'preview',
      matches: [],
      activeIndex: -1
    }
  };

  const elements = {
    workspace: document.getElementById('workspace'),
    rawHighlight: document.getElementById('rawHighlight'),
    rawHighlightContent: document.getElementById('rawHighlightContent'),
    rawEditor: document.getElementById('rawEditor'),
    previewEditor: document.getElementById('previewEditor'),
    documentName: document.getElementById('documentName'),
    statusFile: document.getElementById('statusFile'),
    statusMode: document.getElementById('statusMode'),
    statusCounts: document.getElementById('statusCounts'),
    tabList: document.getElementById('tabList'),
    newTabButton: document.getElementById('newTabButton'),
    newButton: document.getElementById('newButton'),
    newWindowButton: document.getElementById('newWindowButton'),
    openButton: document.getElementById('openButton'),
    saveButton: document.getElementById('saveButton'),
    saveAsButton: document.getElementById('saveAsButton'),
    exportMenu: document.getElementById('exportMenu'),
    exportButton: document.getElementById('exportButton'),
    exportDropdown: document.getElementById('exportDropdown'),
    exportItems: Array.from(document.querySelectorAll('[data-export]')),
    themeSelect: document.getElementById('themeSelect'),
    findButton: document.getElementById('findButton'),
    outlineButton: document.getElementById('outlineButton'),
    outlinePane: document.getElementById('outlinePane'),
    outlineList: document.getElementById('outlineList'),
    outlineCount: document.getElementById('outlineCount'),
    findBar: document.getElementById('findBar'),
    findInput: document.getElementById('findInput'),
    findStatus: document.getElementById('findStatus'),
    findPrevButton: document.getElementById('findPrevButton'),
    findNextButton: document.getElementById('findNextButton'),
    findCloseButton: document.getElementById('findCloseButton'),
    modeButtons: Array.from(document.querySelectorAll('.mode-button'))
  };

  function debounce(callback, wait) {
    let timer = null;

    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => callback(...args), wait);
    };
  }

  function wordCount(content) {
    return (content.match(/\b[\w'-]+\b/g) || []).length;
  }

  function lineCount(content) {
    return content ? content.split('\n').length : 0;
  }

  function characterCount(content) {
    return content.length;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function rawMarkdownToken(value) {
    return `<span class="raw-md-token">${escapeHtml(value)}</span>`;
  }

  function renderRawMarkdownLine(line) {
    let match = line.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
    if (match) {
      return `${escapeHtml(match[1])}${rawMarkdownToken(match[2])}${escapeHtml(match[3])}`;
    }

    match = line.match(/^(\s{0,3})((?:>\s*)+)(.*)$/);
    if (match) {
      return `${escapeHtml(match[1])}${rawMarkdownToken(match[2])}${renderRawMarkdownLine(match[3])}`;
    }

    match = line.match(/^(\s{0,3})(#{1,6})(?=\s|$)(.*)$/);
    if (match) {
      return `${escapeHtml(match[1])}${rawMarkdownToken(match[2])}${escapeHtml(match[3])}`;
    }

    match = line.match(/^(\s{0,3})([-*+])(\s+)(\[[ xX]\])(?=\s|$)(.*)$/);
    if (match) {
      return `${escapeHtml(match[1])}${rawMarkdownToken(match[2])}${escapeHtml(match[3])}${rawMarkdownToken(match[4])}${escapeHtml(match[5])}`;
    }

    match = line.match(/^(\s{0,3})(\d+[.)])(\s+)(\[[ xX]\])(?=\s|$)(.*)$/);
    if (match) {
      return `${escapeHtml(match[1])}${rawMarkdownToken(match[2])}${escapeHtml(match[3])}${rawMarkdownToken(match[4])}${escapeHtml(match[5])}`;
    }

    match = line.match(/^(\s{0,3})([-*+])(\s+.*)$/);
    if (match) {
      return `${escapeHtml(match[1])}${rawMarkdownToken(match[2])}${escapeHtml(match[3])}`;
    }

    match = line.match(/^(\s{0,3})(\d+[.)])(\s+.*)$/);
    if (match) {
      return `${escapeHtml(match[1])}${rawMarkdownToken(match[2])}${escapeHtml(match[3])}`;
    }

    match = line.match(/^(\s{0,3})([-*_](?:\s*[-*_]){2,})(\s*)$/);
    if (match) {
      return `${escapeHtml(match[1])}${rawMarkdownToken(match[2])}${escapeHtml(match[3])}`;
    }

    return escapeHtml(line);
  }

  function renderRawMarkdownSyntax(value) {
    return normalizeLineEndings(value).split('\n').map(renderRawMarkdownLine).join('\n');
  }

  function syncRawHighlightScroll() {
    elements.rawHighlight.scrollTop = elements.rawEditor.scrollTop;
    elements.rawHighlight.scrollLeft = elements.rawEditor.scrollLeft;
  }

  function updateRawHighlight() {
    elements.rawHighlightContent.innerHTML = renderRawMarkdownSyntax(elements.rawEditor.value || '');
    syncRawHighlightScroll();
  }

  function modeLabel(mode) {
    return {
      preview: 'Preview',
      split: 'Split',
      raw: 'Raw'
    }[mode];
  }

  function runZoomCommand(command) {
    const action = {
      in: api.zoomIn,
      out: api.zoomOut,
      reset: api.zoomReset
    }[command];

    if (!action) return;

    Promise.resolve(action()).catch(() => {});
  }

  function handleZoomKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return false;
    }

    if (event.key === '=') {
      event.preventDefault();
      runZoomCommand('in');
      return true;
    }

    return false;
  }

  function handleZoomWheel(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }

    event.preventDefault();
    state.zoomWheelDelta += event.deltaY;

    if (Math.abs(state.zoomWheelDelta) < ZOOM_WHEEL_THRESHOLD) {
      return;
    }

    const command = state.zoomWheelDelta < 0 ? 'in' : 'out';
    state.zoomWheelDelta = 0;
    runZoomCommand(command);
  }

  function normalizeLineEndings(content) {
    return content.replace(/\r\n?/g, '\n');
  }

  function stripHeadingMarkdown(text) {
    return text
      .replace(/\s+#+\s*$/, '')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .trim();
  }

  function headingSlug(text, index) {
    const slug = stripHeadingMarkdown(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');

    return slug || `heading-${index + 1}`;
  }

  function extractOutline(content) {
    const headings = [];
    const lines = normalizeLineEndings(content).split('\n');
    let fenced = false;
    let fenceMarker = null;
    const frontMatterCloseLine = lines[0] && lines[0].trim() === '---'
      ? lines.findIndex((line, index) => index > 0 && line.trim() === '---')
      : -1;

    lines.forEach((line, lineIndex) => {
      if (frontMatterCloseLine !== -1 && lineIndex <= frontMatterCloseLine) {
        return;
      }

      const fenceMatch = line.match(/^\s{0,3}(```+|~~~+)/);

      if (fenceMatch) {
        const marker = fenceMatch[1][0];

        if (!fenced) {
          fenced = true;
          fenceMarker = marker;
        } else if (marker === fenceMarker) {
          fenced = false;
          fenceMarker = null;
        }

        return;
      }

      if (fenced) return;

      const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
      if (!headingMatch) return;

      const text = stripHeadingMarkdown(headingMatch[2]);
      if (!text) return;

      headings.push({
        level: headingMatch[1].length,
        text,
        line: lineIndex,
        id: headingSlug(text, headings.length)
      });
    });

    return headings;
  }

  function resolveAgainstDocument(rawTarget) {
    if (!rawTarget) return rawTarget;

    try {
      return new URL(rawTarget).href;
    } catch (_error) {
      if (!state.baseDirUrl) return rawTarget;
      return new URL(rawTarget, state.baseDirUrl).href;
    }
  }

  function prepareRenderedLinks() {
    elements.previewEditor.querySelectorAll('a[href]').forEach((anchor) => {
      const rawHref = anchor.getAttribute('data-md-href') || anchor.getAttribute('href');
      const resolved = resolveAgainstDocument(rawHref);

      anchor.setAttribute('data-md-href', rawHref);
      anchor.setAttribute('href', resolved);
      anchor.setAttribute('rel', 'noreferrer');
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('contenteditable', 'false');
    });

    elements.previewEditor.querySelectorAll('img[src]').forEach((image) => {
      const resolved = resolveAgainstDocument(image.getAttribute('src'));
      image.setAttribute('src', resolved);
      image.setAttribute('loading', 'lazy');
      image.setAttribute('decoding', 'async');
    });
  }

  function withoutGeneratedUi(root) {
    const clone = root.cloneNode(true);

    clone.querySelectorAll('[data-generated-ui="true"]').forEach((element) => element.remove());
    return clone;
  }

  function codeCopyButtonIcon(copied = false) {
    // Icons from lucide-static v1.23.0, ISC license.
    return copied
      ? '<svg class="lucide lucide-check" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>'
      : '<svg class="lucide lucide-copy" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>';
  }

  function setCodeCopyButtonState(button, copied = false) {
    button.innerHTML = codeCopyButtonIcon(copied);
    button.title = copied ? 'Copied' : 'Copy code';
    button.setAttribute('aria-label', copied ? 'Copied' : 'Copy code');
  }

  function prepareCodeBlockCopyButtons() {
    elements.previewEditor.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('[data-code-copy-button="true"]')) return;

      const button = document.createElement('button');

      button.type = 'button';
      button.className = 'code-copy-button';
      button.dataset.generatedUi = 'true';
      button.dataset.codeCopyButton = 'true';
      button.contentEditable = 'false';
      setCodeCopyButtonState(button);
      pre.appendChild(button);
    });
  }

  function prepareHeadingAnchors(outline) {
    const headings = Array.from(elements.previewEditor.querySelectorAll('h1,h2,h3,h4,h5,h6'));

    headings.forEach((heading, index) => {
      const item = outline[index];

      heading.id = item ? item.id : headingSlug(heading.textContent || '', index);
      heading.dataset.outlineIndex = String(index);
    });
  }

  function renderPreview(content) {
    const outline = extractOutline(content);
    const rendered = md.render(content);

    elements.previewEditor.innerHTML = DOMPurify.sanitize(rendered, {
      ADD_ATTR: ['target', 'rel', 'loading', 'decoding', 'contenteditable', 'data-frontmatter']
    });
    prepareRenderedLinks();
    prepareCodeBlockCopyButtons();
    prepareHeadingAnchors(outline);
  }

  function placeCaretAtEnd(element) {
    const range = document.createRange();
    const selection = window.getSelection();

    if (!element.firstChild) {
      element.appendChild(document.createElement('br'));
    }

    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function placeCaretAfterNode(node) {
    const range = document.createRange();
    const selection = window.getSelection();

    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function placeCaretAtDocumentEnd() {
    const range = document.createRange();
    const selection = window.getSelection();
    const lastChild = elements.previewEditor.lastChild;

    elements.previewEditor.focus();

    if (lastChild) {
      range.setStartAfter(lastChild);
    } else {
      range.selectNodeContents(elements.previewEditor);
      range.collapse(false);
    }

    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function selectionInsideElement(element) {
    const selection = window.getSelection();

    if (!element || !selection || selection.rangeCount === 0) {
      return false;
    }

    return element.contains(selection.anchorNode) || element.contains(selection.focusNode);
  }

  function makeLinkEditorPart(part, text, spellcheck) {
    const element = document.createElement('span');

    element.className = `link-editor-${part}`;
    element.dataset.linkPart = part;
    element.contentEditable = 'true';
    element.spellcheck = spellcheck;
    element.textContent = text;

    return element;
  }

  function makeLinkEditorToken(text) {
    const element = document.createElement('span');

    element.className = 'link-editor-token';
    element.contentEditable = 'false';
    element.textContent = text;

    return element;
  }

  function activateLinkEditor(anchor) {
    if (state.activeLinkEditor && state.activeLinkEditor.contains(anchor)) {
      return;
    }

    closeActiveLinkEditor();
    closeActiveInlineCodeEditor();
    closeActiveCodeEditor();

    const rawHref = anchor.getAttribute('data-md-href') || anchor.getAttribute('href') || '';
    const text = anchor.textContent || rawHref;
    const title = anchor.getAttribute('title') || '';
    const editor = document.createElement('span');
    const textPart = makeLinkEditorPart('text', text, state.spellcheckEnabled);
    const hrefPart = makeLinkEditorPart('href', rawHref, false);

    editor.className = 'link-editor';
    editor.dataset.linkEditor = 'true';
    editor.dataset.originalText = text;
    editor.dataset.originalHref = rawHref;
    editor.dataset.originalTitle = title;
    editor.contentEditable = 'false';
    editor.append(
      makeLinkEditorToken('['),
      textPart,
      makeLinkEditorToken(']('),
      hrefPart,
      makeLinkEditorToken(')')
    );

    anchor.replaceWith(editor);
    state.activeLinkEditor = editor;
    placeCaretAtEnd(textPart);
  }

  function closeActiveLinkEditor({ forceSync = false } = {}) {
    const editor = state.activeLinkEditor;

    if (!editor) {
      return null;
    }

    state.activeLinkEditor = null;

    if (!editor.isConnected) {
      return null;
    }

    const { text, href, title } = linkEditorParts(editor);
    const changed = text !== editor.dataset.originalText || href !== editor.dataset.originalHref;
    const replacement = href ? document.createElement('a') : document.createTextNode(text);

    if (href) {
      replacement.setAttribute('href', href);
      if (title) {
        replacement.setAttribute('title', title);
      }
      replacement.textContent = text || href;
    }

    editor.replaceWith(replacement);

    if (href) {
      prepareRenderedLinks();
    }

    if (forceSync || changed) {
      syncFromPreview();
    }

    return replacement;
  }

  function closeLinkEditorWhenSelectionLeaves() {
    const editor = state.activeLinkEditor;

    if (!editor || selectionInsideElement(editor)) {
      return;
    }

    closeActiveLinkEditor();
  }

  function inlineCodeMarkdown(text) {
    return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
  }

  function inlineCodeFromMarkdown(markdown) {
    const match = String(markdown || '').match(/^(`+)([\s\S]*)\1$/);

    if (!match) return document.createTextNode(markdown || '');

    const code = document.createElement('code');
    let text = match[2];

    if (match[1].length > 1) {
      text = text.replace(/^ /, '').replace(/ $/, '');
    }

    code.textContent = text;
    return code;
  }

  function activateInlineCodeEditor(code) {
    if (state.activeInlineCodeEditor && state.activeInlineCodeEditor.contains(code)) {
      return;
    }

    closeActiveLinkEditor();
    closeActiveInlineCodeEditor();
    closeActiveCodeEditor();

    const markdown = inlineCodeMarkdown(code.textContent || '');
    const editor = document.createElement('span');

    editor.className = 'inline-code-editor';
    editor.dataset.inlineCodeEditor = 'true';
    editor.dataset.originalMarkdown = markdown;
    editor.contentEditable = 'true';
    editor.spellcheck = false;
    editor.textContent = markdown;
    editor.addEventListener('keydown', handleInlineCodeEditorKeydown);

    code.replaceWith(editor);
    state.activeInlineCodeEditor = editor;
    selectElementContents(editor);
  }

  function closeActiveInlineCodeEditor({ forceSync = false } = {}) {
    const editor = state.activeInlineCodeEditor;

    if (!editor) {
      return null;
    }

    state.activeInlineCodeEditor = null;

    if (!editor.isConnected) {
      return null;
    }

    const markdown = editor.textContent || '';
    const changed = markdown !== editor.dataset.originalMarkdown;
    const replacement = inlineCodeFromMarkdown(markdown);

    editor.replaceWith(replacement);
    prepareCodeBlockCopyButtons();

    if (forceSync || changed) {
      syncFromPreview();
    }

    return replacement;
  }

  function handleInlineCodeEditorKeydown(event) {
    if (event.key !== 'Enter' && event.key !== 'Escape') {
      return;
    }

    event.preventDefault();
    const replacement = closeActiveInlineCodeEditor({ forceSync: true });

    if (replacement && replacement.parentNode) {
      placeCaretAfterNode(replacement);
    }
  }

  function closeInlineCodeEditorWhenSelectionLeaves() {
    const editor = state.activeInlineCodeEditor;

    if (!editor || selectionInsideElement(editor)) {
      return;
    }

    closeActiveInlineCodeEditor();
  }

  function syncCodeEditorInput(event) {
    if (event) {
      event.stopPropagation();
    }

    mirrorCodeEditorTextareaValue();
    state.previewInputPending = true;
    syncFromPreviewSoon();
  }

  function handleCodeEditorKeydown(event) {
    const pair = typedWrapPair(event);

    if (pair && wrapTextareaSelectionWithPair(event.target, pair)) {
      event.preventDefault();
      syncCodeEditorInput();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      event.target.setRangeText('  ', event.target.selectionStart, event.target.selectionEnd, 'end');
      syncCodeEditorInput();
      return;
    }

    if (event.key !== 'Escape') {
      return;
    }

    event.preventDefault();
    const replacement = closeActiveCodeEditor({ forceSync: true });

    if (replacement && replacement.parentNode) {
      placeCaretAfterNode(replacement);
    }
  }

  function activateCodeBlockEditor(pre) {
    if (!pre || (state.activeCodeEditor && state.activeCodeEditor.contains(pre))) {
      return;
    }

    closeActiveLinkEditor();
    closeActiveInlineCodeEditor();
    closeActiveCodeEditor();

    const code = pre.querySelector('code') || pre;
    const isFrontMatter = pre.matches('[data-frontmatter="true"]');
    const markdown = isFrontMatter
      ? normalizeLineEndings(code.textContent || '').trimEnd()
      : fencedCodeMarkdown(code.textContent || '', codeBlockLanguage(code));
    const editor = document.createElement('div');
    const textarea = document.createElement('textarea');
    const firstBodyOffset = Math.min(markdown.length, markdown.indexOf('\n') + 1);

    editor.className = 'code-block-editor';
    editor.dataset.codeEditor = 'true';
    editor.dataset.codeMarkdown = markdown;
    editor.dataset.originalMarkdown = markdown;
    if (isFrontMatter) editor.dataset.frontmatter = 'true';
    editor.contentEditable = 'false';

    textarea.className = 'code-block-textarea';
    textarea.spellcheck = false;
    textarea.value = markdown;
    textarea.rows = Math.max(4, markdown.split('\n').length);
    textarea.setAttribute('aria-label', 'Code block markdown');
    textarea.addEventListener('input', syncCodeEditorInput);
    textarea.addEventListener('keydown', handleCodeEditorKeydown);
    textarea.addEventListener('focusout', closeCodeEditorWhenFocusLeaves);

    editor.appendChild(textarea);
    pre.replaceWith(editor);
    state.activeCodeEditor = editor;
    textarea.focus();
    textarea.setSelectionRange(firstBodyOffset, firstBodyOffset);
  }

  function closeActiveCodeEditor({ forceSync = false } = {}) {
    const editor = state.activeCodeEditor;

    if (!editor) {
      return null;
    }

    state.activeCodeEditor = null;

    if (!editor.isConnected) {
      return null;
    }

    const markdown = codeEditorMarkdown(editor);
    const changed = markdown !== editor.dataset.originalMarkdown;
    const replacement = editor.dataset.frontmatter === 'true'
      ? frontMatterBlockFromMarkdown(markdown)
      : codeBlockFromMarkdown(markdown);

    editor.replaceWith(replacement);

    if (forceSync || changed) {
      syncFromPreview();
    }

    return replacement;
  }

  function closeCodeEditorWhenFocusLeaves() {
    setTimeout(() => {
      const editor = state.activeCodeEditor;

      if (editor && !editor.contains(document.activeElement)) {
        closeActiveCodeEditor();
      }
    }, 0);
  }

  function closeCodeEditorWhenSelectionLeaves() {
    const editor = state.activeCodeEditor;

    if (!editor || editor.contains(document.activeElement) || selectionInsideElement(editor)) {
      return;
    }

    closeActiveCodeEditor();
  }

  function currentEditableBlock(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;

    if (!element || !elements.previewEditor.contains(element)) {
      return null;
    }

    if (element === elements.previewEditor) {
      return elements.previewEditor;
    }

    return element.closest('h1,h2,h3,h4,h5,h6,p,div,li,blockquote') || elements.previewEditor;
  }

  function textAroundSelection(block, range) {
    const beforeRange = document.createRange();
    const afterRange = document.createRange();

    beforeRange.selectNodeContents(block);
    beforeRange.setEnd(range.startContainer, range.startOffset);

    afterRange.selectNodeContents(block);
    afterRange.setStart(range.startContainer, range.startOffset);

    return {
      before: beforeRange.toString().replace(/\u00a0/g, ' '),
      after: afterRange.toString().replace(/\u00a0/g, ' ')
    };
  }

  function inputMayCompleteInlineMarkdown(event) {
    if (event.inputType === 'insertFromPaste') {
      return true;
    }

    if (event.inputType !== 'insertText') {
      return false;
    }

    return ['*', '_', '~', '`', ')', '>', ' '].includes(event.data);
  }

  function hasCompletedInlineMarkdown(text) {
    return /!\[[^\]\n]*\]\([^) \n][^)\n]*\)/.test(text) ||
      /\[[^\]\n]+\]\([^) \n][^)\n]*\)/.test(text) ||
      /`[^`\n]+`/.test(text) ||
      /\*\*[^*\n]+?\*\*/.test(text) ||
      /__[^_\n]+?__/.test(text) ||
      /(^|[\s([{])\*[^*\s][^*\n]*?\*/.test(text) ||
      /(^|[\s([{])_[^_\s][^_\n]*?_/.test(text) ||
      /~~[^~\n]+~~/.test(text) ||
      /(^|[\s([{])https?:\/\/[^\s<]+$/i.test(text) ||
      /(^|[\s([{])mailto:[^\s<]+$/i.test(text);
  }

  function inlineMarkdownText(block) {
    return (block === elements.previewEditor ? elements.previewEditor.innerText : block.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r?\n/g, ' ')
      .trim();
  }

  function inlineMarkdownChanged(text, html) {
    return html !== escapeHtml(text);
  }

  function replaceBlockWithInlineMarkdown(block, html) {
    if (block === elements.previewEditor) {
      const paragraph = document.createElement('p');

      paragraph.innerHTML = html || '<br>';
      elements.previewEditor.replaceChildren(paragraph);
      prepareRenderedLinks();
      placeCaretAtEnd(paragraph);
      return;
    }

    block.innerHTML = html || '<br>';
    prepareRenderedLinks();
    placeCaretAtEnd(block);
  }

  function applyInlineMarkdownShortcut(event) {
    if (!inputMayCompleteInlineMarkdown(event) || state.activeLinkEditor) {
      return false;
    }

    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const block = currentEditableBlock(range.startContainer);

    if (!block || block.closest('pre,code')) {
      return false;
    }

    const activeText = textNodeAtSelection(range);
    if (!activeText) {
      return false;
    }

    const { after } = textAroundSelection(block, range);
    if (after.trim() !== '') {
      return false;
    }

    const before = activeText.node.nodeValue.slice(0, activeText.offset);
    const match = inlineMarkdownMatchAtEnd(before);
    if (!match) {
      return false;
    }

    const html = DOMPurify.sanitize(md.renderInline(match.source), {
      ADD_ATTR: ['target', 'rel', 'loading', 'decoding', 'contenteditable', 'data-frontmatter']
    });

    if (!inlineMarkdownChanged(match.source, html)) {
      return false;
    }

    clearFindHighlights();
    replaceTextNodeMarkdown(activeText.node, activeText.offset, match, html);
    prepareRenderedLinks();
    syncFromPreview();
    return true;
  }

  function textNodeAtSelection(range) {
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      return {
        node: range.startContainer,
        offset: range.startOffset
      };
    }

    if (range.startOffset === 0) {
      return null;
    }

    const previous = range.startContainer.childNodes[range.startOffset - 1];

    if (previous && previous.nodeType === Node.TEXT_NODE) {
      return {
        node: previous,
        offset: previous.nodeValue.length
      };
    }

    return null;
  }

  function inlineMarkdownMatchAtEnd(text) {
    const candidate = text.replace(/\s+$/, '');
    const patterns = [
      /(!\[[^\]\n]*\]\([^) \n][^)\n]*\))$/,
      /(\[[^\]\n]+\]\([^) \n][^)\n]*\))$/,
      /(`[^`\n]+`)$/,
      /(\*\*[^*\n]+?\*\*)$/,
      /(__[^_\n]+?__)$/,
      /(^|[\s([{])(\*[^*\s][^*\n]*?\*)$/,
      /(^|[\s([{])(_[^_\s][^_\n]*?_)$/,
      /(~~[^~\n]+~~)$/,
      /((?:https?:\/\/|mailto:)[^\s<]+)$/i
    ];

    for (const pattern of patterns) {
      const match = candidate.match(pattern);
      if (!match) continue;

      const source = match[2] || match[1];

      return {
        source,
        start: candidate.length - source.length,
        end: candidate.length
      };
    }

    return null;
  }

  function htmlNodes(html) {
    const template = document.createElement('template');

    template.innerHTML = html;
    return Array.from(template.content.childNodes);
  }

  function replaceTextNodeMarkdown(node, offset, match, html) {
    const original = node.nodeValue;
    const prefixText = original.slice(0, match.start);
    const trailingText = original.slice(match.end, offset);
    const suffixText = original.slice(offset);
    const replacements = [];
    const renderedNodes = htmlNodes(html);

    if (prefixText) {
      replacements.push(document.createTextNode(prefixText));
    }

    replacements.push(...renderedNodes);

    const trailingNode = trailingText ? document.createTextNode(trailingText) : null;
    const caretNode = trailingNode ? null : document.createTextNode('\u200b');
    if (trailingNode) {
      replacements.push(trailingNode);
    } else {
      replacements.push(caretNode);
    }

    if (suffixText) {
      replacements.push(document.createTextNode(suffixText));
    }

    const lastRenderedNode = renderedNodes[renderedNodes.length - 1] || null;
    node.replaceWith(...replacements);

    const range = document.createRange();
    const selection = window.getSelection();

    if (trailingNode) {
      range.setStart(trailingNode, trailingNode.nodeValue.length);
    } else if (caretNode) {
      range.setStart(caretNode, caretNode.nodeValue.length);
    } else if (lastRenderedNode) {
      range.setStartAfter(lastRenderedNode);
    } else if (replacements.length > 0) {
      range.setStartAfter(replacements[replacements.length - 1]);
    } else {
      range.selectNodeContents(elements.previewEditor);
      range.collapse(false);
    }

    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function blockShortcutAtSelection() {
    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const block = currentEditableBlock(range.startContainer);

    if (!block) {
      return null;
    }

    const { before, after } = textAroundSelection(block, range);
    const marker = before.trim();

    if (after.trim() !== '') {
      return null;
    }

    const headingMatch = marker.match(/^(#{1,6})$/);
    if (headingMatch) {
      return {
        block,
        type: 'heading',
        level: headingMatch[1].length
      };
    }

    if (/^[-*+]$/.test(marker)) {
      return {
        block,
        type: 'bullet-list'
      };
    }

    const orderedMatch = marker.match(/^(\d+)[.)]$/);
    if (orderedMatch) {
      return {
        block,
        type: 'numbered-list',
        start: Number(orderedMatch[1])
      };
    }

    if (marker === '>') {
      return {
        block,
        type: 'quote'
      };
    }

    if (marker === '```' || marker === '~~~') {
      return {
        block,
        type: 'code-block'
      };
    }

    return null;
  }

  function replaceShortcutBlock(block, replacement, caretTarget = replacement) {
    if (!caretTarget.firstChild) {
      caretTarget.appendChild(document.createElement('br'));
    }

    if (block === elements.previewEditor) {
      elements.previewEditor.replaceChildren(replacement);
    } else {
      block.replaceWith(replacement);
    }

    placeCaretAtEnd(caretTarget);
    syncFromPreview();
  }

  function applyBlockShortcut(shortcut) {
    if (shortcut.type === 'heading') {
      replaceShortcutBlock(shortcut.block, document.createElement(`h${shortcut.level}`));
      return;
    }

    if (shortcut.type === 'bullet-list') {
      const list = document.createElement('ul');
      const item = document.createElement('li');
      list.appendChild(item);
      replaceShortcutBlock(shortcut.block, list, item);
      return;
    }

    if (shortcut.type === 'numbered-list') {
      const list = document.createElement('ol');
      const item = document.createElement('li');

      if (shortcut.start > 1) {
        list.start = shortcut.start;
      }

      list.appendChild(item);
      replaceShortcutBlock(shortcut.block, list, item);
      return;
    }

    if (shortcut.type === 'quote') {
      replaceShortcutBlock(shortcut.block, document.createElement('blockquote'));
      return;
    }

    if (shortcut.type === 'code-block') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.appendChild(code);
      replaceShortcutBlock(shortcut.block, pre, code);
      prepareCodeBlockCopyButtons();
    }
  }

  function inputMayCompleteFencedCode(event) {
    if (event.inputType === 'insertFromPaste') {
      return true;
    }

    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      return true;
    }

    if (event.inputType !== 'insertText') {
      return false;
    }

    return ['`', '~', '\n'].includes(event.data) ||
      String(event.data || '').includes('```') ||
      String(event.data || '').includes('~~~');
  }

  function elementMarkdownText(element) {
    const text = element === elements.previewEditor
      ? elements.previewEditor.innerText || ''
      : element.innerText || element.textContent || '';

    return normalizeLineEndings(text)
      .replace(/\u00a0/g, ' ')
      .replace(/\u200b/g, '')
      .trimEnd();
  }

  function renderPreviewMarkdownFromInput(markdown) {
    const nextContent = normalizeLineEndings(markdown || '').replace(/\u200b/g, '').trimEnd();

    setContent(nextContent, 'preview-render', true);
    state.previewInputPending = false;
    placeCaretAtDocumentEnd();
  }

  function applyCompletedFencedCodeShortcut(event) {
    if (!inputMayCompleteFencedCode(event) || state.activeLinkEditor || state.activeCodeEditor) {
      return false;
    }

    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const block = range ? currentEditableBlock(range.startContainer) : null;
    const blockMarkdown = block ? elementMarkdownText(block) : '';
    const fencedBlock = completedFencedCodeBlock(blockMarkdown);

    if (fencedBlock) {
      const pre = codeBlockFromMarkdown(fencedBlock);

      clearFindHighlights();

      if (block === elements.previewEditor) {
        elements.previewEditor.replaceChildren(pre);
      } else {
        block.replaceWith(pre);
      }

      prepareCodeBlockCopyButtons();
      syncFromPreview();
      placeCaretAfterNode(pre);
      return true;
    }

    if (isPlainPreviewInput()) {
      const markdown = plainPreviewMarkdown();

      if (hasCompletedFencedCodeBlock(markdown)) {
        renderPreviewMarkdownFromInput(markdown);
        return true;
      }
    }

    return false;
  }

  function handlePreviewKeydown(event) {
    if (state.activeCodeEditor && state.activeCodeEditor.contains(event.target)) {
      return;
    }

    if (state.activeInlineCodeEditor && selectionInsideElement(state.activeInlineCodeEditor)) {
      return;
    }

    if (state.activeLinkEditor && selectionInsideElement(state.activeLinkEditor)) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        const part = event.target.closest('[data-link-part]');

        if (part) {
          event.preventDefault();
          selectElementContents(part);
        }

        return;
      }

      if (wrapLinkEditorSelectionWithTypedPair(event)) {
        return;
      }

      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        const replacement = closeActiveLinkEditor({ forceSync: true });

        if (replacement && replacement.parentNode) {
          placeCaretAfterNode(replacement);
        }
      }

      return;
    }

    if (wrapPreviewSelectionWithTypedPair(event)) {
      return;
    }

    if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    const shortcut = blockShortcutAtSelection();

    if (!shortcut) {
      return;
    }

    event.preventDefault();
    applyBlockShortcut(shortcut);
  }

  function isPlainPreviewInput() {
    if (elements.previewEditor.querySelector('[data-link-editor="true"], [data-inline-code-editor="true"], [data-code-editor="true"]')) {
      return false;
    }

    const semanticTags = new Set([
      'A',
      'BLOCKQUOTE',
      'CODE',
      'DEL',
      'EM',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'HR',
      'IMG',
      'LI',
      'OL',
      'P',
      'PRE',
      'S',
      'STRIKE',
      'STRONG',
      'TABLE',
      'TBODY',
      'TD',
      'TH',
      'THEAD',
      'TR',
      'UL'
    ]);

    return !Array.from(elements.previewEditor.querySelectorAll('*')).some((node) => {
      return semanticTags.has(node.tagName);
    });
  }

  function plainPreviewMarkdown() {
    return elements.previewEditor.innerText
      .replace(/\u00a0/g, ' ')
      .replace(/\u200b/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
  }

  function updateWorkspaceClass() {
    elements.workspace.className = [
      'workspace',
      `mode-${state.mode}`,
      state.outlineVisible && state.mode !== 'raw' ? 'show-outline' : ''
    ].filter(Boolean).join(' ');

    elements.outlineButton.setAttribute('aria-pressed', String(state.outlineVisible));
  }

  function updateOutline() {
    state.outline = extractOutline(state.content);
    elements.outlineCount.textContent = `${state.outline.length} ${state.outline.length === 1 ? 'heading' : 'headings'}`;
    elements.outlineList.replaceChildren();

    if (state.outline.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'outline-empty';
      empty.textContent = 'No headings';
      elements.outlineList.appendChild(empty);
      return;
    }

    state.outline.forEach((item, index) => {
      const button = document.createElement('button');

      button.type = 'button';
      button.className = `outline-item level-${item.level}`;
      button.textContent = item.text;
      button.title = item.text;
      button.addEventListener('click', () => goToOutlineItem(index));
      elements.outlineList.appendChild(button);
    });
  }

  function rawLineOffset(lineNumber) {
    let offset = 0;
    const lines = elements.rawEditor.value.split('\n');

    for (let index = 0; index < lineNumber; index += 1) {
      offset += lines[index].length + 1;
    }

    return offset;
  }

  function goToOutlineItem(index) {
    const item = state.outline[index];

    if (!item) return;

    if (state.mode === 'raw') {
      const start = rawLineOffset(item.line);
      const line = elements.rawEditor.value.split('\n')[item.line] || '';

      elements.rawEditor.focus();
      elements.rawEditor.setSelectionRange(start, start + line.length);
      return;
    }

    const heading = elements.previewEditor.querySelector(`[data-outline-index="${index}"]`);

    if (heading) {
      heading.scrollIntoView({ block: 'center', behavior: 'smooth' });
      heading.focus({ preventScroll: true });
    }
  }

  function toggleOutline() {
    state.outlineVisible = !state.outlineVisible;
    updateWorkspaceClass();
    updateOutline();
  }

  function clearFindHighlights() {
    const marks = Array.from(elements.previewEditor.querySelectorAll('mark.find-match'));

    marks.forEach((mark) => {
      const parent = mark.parentNode;
      const children = Array.from(mark.childNodes);

      if (children.length > 0) {
        mark.replaceWith(...children);
      } else {
        mark.replaceWith(document.createTextNode(mark.textContent || ''));
      }

      if (parent) {
        parent.normalize();
      }
    });
  }

  function currentFindScope() {
    if (document.activeElement === elements.findInput) {
      return state.find.scope || (state.mode === 'raw' ? 'raw' : 'preview');
    }

    if (state.mode === 'raw' || document.activeElement === elements.rawEditor) {
      return 'raw';
    }

    return 'preview';
  }

  function findMatches(query, text) {
    if (!query) return [];

    const matches = [];
    const needle = query.toLowerCase();
    const haystack = text.toLowerCase();
    let index = haystack.indexOf(needle);

    while (index !== -1) {
      matches.push({
        start: index,
        end: index + query.length
      });
      index = haystack.indexOf(needle, index + Math.max(1, query.length));
    }

    return matches;
  }

  function previewTextNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(
      elements.previewEditor,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;

          if (!node.nodeValue || !parent) {
            return NodeFilter.FILTER_REJECT;
          }

          if (parent.closest('.link-editor, .code-block-editor, mark.find-match')) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    return nodes;
  }

  function highlightPreviewMatches(query, activeIndex) {
    let matchIndex = 0;

    previewTextNodes().forEach((node) => {
      const text = node.nodeValue;
      const lowerText = text.toLowerCase();
      const lowerQuery = query.toLowerCase();
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      let index = lowerText.indexOf(lowerQuery);

      if (index === -1) return;

      while (index !== -1) {
        if (index > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
        }

        const mark = document.createElement('mark');
        mark.className = `find-match${matchIndex === activeIndex ? ' active' : ''}`;
        mark.dataset.findIndex = String(matchIndex);
        mark.textContent = text.slice(index, index + query.length);
        fragment.appendChild(mark);

        cursor = index + query.length;
        matchIndex += 1;
        index = lowerText.indexOf(lowerQuery, cursor);
      }

      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }

      node.replaceWith(fragment);
    });

    const active = elements.previewEditor.querySelector('mark.find-match.active');
    if (active) {
      active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function selectRawFindMatch(match) {
    if (!match) return;

    elements.rawEditor.focus();
    elements.rawEditor.setSelectionRange(match.start, match.end);
  }

  function updateFindStatus() {
    const total = state.find.matches.length;

    if (!state.find.query) {
      elements.findStatus.textContent = '0 / 0';
      return;
    }

    elements.findStatus.textContent = total === 0
      ? 'No matches'
      : `${state.find.activeIndex + 1} / ${total}`;
  }

  function refreshFind(requestedIndex = state.find.activeIndex) {
    clearFindHighlights();

    const query = elements.findInput.value;
    const scope = currentFindScope();
    const source = scope === 'raw'
      ? elements.rawEditor.value
      : elements.previewEditor.innerText || '';
    const matches = findMatches(query, source);
    const activeIndex = matches.length === 0
      ? -1
      : Math.max(0, Math.min(requestedIndex < 0 ? 0 : requestedIndex, matches.length - 1));

    state.find = {
      open: state.find.open,
      query,
      scope,
      matches,
      activeIndex
    };

    if (scope === 'raw') {
      selectRawFindMatch(matches[activeIndex]);
    } else if (query) {
      highlightPreviewMatches(query, activeIndex);
    }

    updateFindStatus();
  }

  function moveFind(delta) {
    if (!state.find.query) return;

    if (state.find.matches.length === 0) {
      refreshFind();
      return;
    }

    const total = state.find.matches.length;
    const nextIndex = (state.find.activeIndex + delta + total) % total;

    refreshFind(nextIndex);
  }

  function openFind() {
    closeActiveLinkEditor();
    const scope = currentFindScope();

    state.find.open = true;
    state.find.scope = scope;
    elements.findBar.hidden = false;
    elements.findInput.focus();
    elements.findInput.select();
    refreshFind(0);
  }

  function closeFind() {
    const editor = state.find.scope === 'raw' ? elements.rawEditor : elements.previewEditor;
    const scrollTop = editor.scrollTop;
    const scrollLeft = editor.scrollLeft;

    state.find.open = false;
    elements.findBar.hidden = true;
    clearFindHighlights();

    try {
      editor.focus({ preventScroll: true });
    } catch (_error) {
      editor.focus();
    }

    editor.scrollTop = scrollTop;
    editor.scrollLeft = scrollLeft;
    if (editor === elements.rawEditor) syncRawHighlightScroll();

    requestAnimationFrame(() => {
      editor.scrollTop = scrollTop;
      editor.scrollLeft = scrollLeft;
      if (editor === elements.rawEditor) syncRawHighlightScroll();
    });
  }

  function fileNameFromPath(filePath) {
    if (!filePath) return 'Untitled.md';
    return String(filePath).split(/[\\/]/).pop() || 'Untitled.md';
  }

  function createDocumentTab(file = {}) {
    const filePath = file.filePath || null;

    return {
      id: `tab-${state.nextTabId++}`,
      content: normalizeLineEndings(file.content || ''),
      filePath,
      fileName: file.fileName || fileNameFromPath(filePath),
      baseDirUrl: file.baseDirUrl || null,
      diskMtimeMs: file.diskMtimeMs || null,
      externalPromptMtimeMs: null,
      dirty: Boolean(file.dirty)
    };
  }

  function activeTab() {
    return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
  }

  function tabById(tabId) {
    return state.tabs.find((tab) => tab.id === tabId) || null;
  }

  function focusActiveEditor() {
    if (state.mode === 'raw') {
      elements.rawEditor.focus();
    } else {
      elements.previewEditor.focus();
    }
  }

  function syncActiveTabFromState() {
    const tab = activeTab();

    if (!tab) return;

    tab.content = state.content;
    tab.filePath = state.filePath;
    tab.fileName = state.fileName;
    tab.baseDirUrl = state.baseDirUrl;
    tab.diskMtimeMs = state.diskMtimeMs;
    tab.dirty = state.dirty;
  }

  function flushActiveDocument() {
    if (!activeTab()) return;

    closeActiveLinkEditor();
    closeActiveCodeEditor();

    if (state.previewInputPending) {
      syncFromPreview();
    }

    syncActiveTabFromState();
  }

  function updateTabs() {
    elements.tabList.replaceChildren();

    state.tabs.forEach((tab) => {
      const item = document.createElement('div');
      const tabButton = document.createElement('button');
      const closeButton = document.createElement('button');
      const active = tab.id === state.activeTabId;
      const dirtyMarker = tab.dirty ? ' *' : '';
      const label = `${tab.fileName || 'Untitled.md'}${dirtyMarker}`;

      item.className = `tab-item${active ? ' active' : ''}`;
      item.setAttribute('role', 'presentation');

      tabButton.type = 'button';
      tabButton.className = 'tab-button';
      tabButton.textContent = label;
      tabButton.title = tab.filePath || label;
      tabButton.setAttribute('role', 'tab');
      tabButton.setAttribute('aria-selected', String(active));
      tabButton.addEventListener('click', () => activateTab(tab.id));

      closeButton.type = 'button';
      closeButton.className = 'tab-close';
      closeButton.textContent = 'x';
      closeButton.title = `Close ${tab.fileName || 'tab'}`;
      closeButton.setAttribute('aria-label', `Close ${tab.fileName || 'tab'}`);
      closeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(tab.id);
      });

      item.append(tabButton, closeButton);
      elements.tabList.appendChild(item);
    });
  }

  function applyTabToState(tab, { focus = true } = {}) {
    if (!tab) return;

    state.activeTabId = tab.id;
    state.filePath = tab.filePath || null;
    state.fileName = tab.fileName || 'Untitled.md';
    state.baseDirUrl = tab.baseDirUrl || null;
    state.diskMtimeMs = tab.diskMtimeMs || null;
    state.dirty = Boolean(tab.dirty);
    setContent(tab.content || '', 'load', false);
    setDirty(Boolean(tab.dirty));
    updateTabs();

    if (focus) {
      focusActiveEditor();
    }
  }

  function activateTab(tabId, options = {}) {
    const tab = tabById(tabId);

    if (!tab) return;
    if (tab.id === state.activeTabId) {
      updateTabs();
      return;
    }

    flushActiveDocument();
    applyTabToState(tab, options);
  }

  function openDocumentTab(file = {}, options = {}) {
    flushActiveDocument();
    const tab = createDocumentTab(file);

    state.tabs.push(tab);
    applyTabToState(tab, options);
    return tab;
  }

  function hasDirtyTabs() {
    flushActiveDocument();
    return state.tabs.some((tab) => tab.dirty);
  }

  async function confirmCloseTab(tab) {
    if (!tab || !tab.dirty) return true;

    const fileName = tab.fileName || 'Untitled.md';
    let decision = 'cancel';

    try {
      decision = await api.confirmCloseDocument(fileName);
    } catch (_error) {
      decision = window.confirm(`Close ${fileName} without saving changes?`) ? 'discard' : 'cancel';
    }

    if (decision === 'discard') return true;
    if (decision !== 'save') return false;

    if (tab.id !== state.activeTabId) {
      activateTab(tab.id, { focus: false });
    }

    const saved = await saveFile();
    return Boolean(saved) && !activeTab().dirty;
  }

  async function closeTab(tabId = state.activeTabId) {
    const tab = tabById(tabId);

    if (!tab) return false;

    if (tab.id === state.activeTabId) {
      flushActiveDocument();
    }

    if (!(await confirmCloseTab(tab))) {
      return false;
    }

    const tabIndex = state.tabs.findIndex((item) => item.id === tab.id);
    const wasActive = tab.id === state.activeTabId;

    state.tabs.splice(tabIndex, 1);

    if (state.tabs.length === 0) {
      const nextTab = createDocumentTab();
      state.tabs.push(nextTab);
      applyTabToState(nextTab);
      return true;
    }

    if (wasActive) {
      const nextTab = state.tabs[Math.min(tabIndex, state.tabs.length - 1)];
      applyTabToState(nextTab);
    } else {
      updateTabs();
    }

    return true;
  }

  function updateTitle() {
    const dirtyMarker = state.dirty ? ' *' : '';
    const windowDirtyMarker = state.tabs.some((tab) => tab.dirty) ? ' *' : '';
    elements.documentName.textContent = `${state.fileName}${dirtyMarker}`;
    document.title = `${state.fileName}${windowDirtyMarker} - Tachylite`;
  }

  function updateStatus() {
    elements.statusFile.textContent = state.filePath || 'No file loaded';
    elements.statusMode.textContent = modeLabel(state.mode);
    elements.statusCounts.textContent = `${wordCount(state.content)} words · ${lineCount(state.content)} lines · ${characterCount(state.content)} chars`;
  }

  function applySpellcheckEnabled(enabled) {
    state.spellcheckEnabled = Boolean(enabled);
    elements.previewEditor.spellcheck = state.spellcheckEnabled;
    elements.rawEditor.spellcheck = state.spellcheckEnabled;
  }

  function normalizeTheme(theme) {
    return ['light', 'paper', 'dusk', 'contrast'].includes(theme) ? theme : 'light';
  }

  function applyTheme(theme) {
    const nextTheme = normalizeTheme(theme);

    state.theme = nextTheme;
    document.documentElement.dataset.theme = nextTheme;

    if (elements.themeSelect.value !== nextTheme) {
      elements.themeSelect.value = nextTheme;
    }
  }

  async function setTheme(theme) {
    const nextTheme = normalizeTheme(theme);

    applyTheme(nextTheme);

    try {
      const savedTheme = await api.setTheme(nextTheme);
      applyTheme(savedTheme || nextTheme);
    } catch (_error) {
      applyTheme(nextTheme);
    }
  }

  function setDirty(value) {
    state.dirty = Boolean(value);
    syncActiveTabFromState();
    updateTitle();
    updateStatus();
    updateTabs();
  }

  function setContent(content, source, dirty) {
    if (source !== 'preview') {
      closeActiveLinkEditor();
      closeActiveInlineCodeEditor();
      closeActiveCodeEditor();
    }

    state.content = normalizeLineEndings(content);

    if (source !== 'preview') {
      state.previewInputPending = false;
    }

    if (source !== 'raw') {
      elements.rawEditor.value = state.content;
    }

    updateRawHighlight();

    if (source !== 'preview') {
      renderPreview(state.content);
    }

    updateOutline();

    if (dirty) {
      setDirty(true);
    } else {
      syncActiveTabFromState();
      updateTitle();
      updateStatus();
      updateTabs();
    }

    if (state.find.open) {
      refreshFind();
    }
  }

  function loadDocument(file) {
    if (!activeTab()) {
      state.tabs.push(createDocumentTab(file));
      state.activeTabId = state.tabs[0].id;
    }

    state.filePath = file.filePath || null;
    state.fileName = file.fileName || 'Untitled.md';
    state.baseDirUrl = file.baseDirUrl || null;
    state.diskMtimeMs = file.diskMtimeMs || null;

    setContent(file.content || '', 'load', false);
    if (activeTab()) activeTab().externalPromptMtimeMs = null;
    setDirty(false);
  }

  function updateTabFromDisk(tab, file) {
    tab.content = normalizeLineEndings(file.content || '');
    tab.filePath = file.filePath || tab.filePath;
    tab.fileName = file.fileName || fileNameFromPath(tab.filePath);
    tab.baseDirUrl = file.baseDirUrl || null;
    tab.diskMtimeMs = file.diskMtimeMs || null;
    tab.externalPromptMtimeMs = null;
    tab.dirty = false;

    if (tab.id === state.activeTabId) {
      applyTabToState(tab, { focus: false });
    } else {
      updateTabs();
    }
  }

  async function checkExternalChanges() {
    if (state.checkingExternalChanges) return;

    state.checkingExternalChanges = true;

    try {
      for (const tab of state.tabs) {
        if (!tab.filePath || !tab.diskMtimeMs) continue;

        const result = await api.reloadIfChanged({
          filePath: tab.filePath,
          diskMtimeMs: tab.diskMtimeMs
        });

        if (!result || !result.changed || !result.file) continue;
        if (tab.externalPromptMtimeMs === result.file.diskMtimeMs) continue;

        const message = tab.dirty
          ? `${tab.fileName} changed on disk. Reload and discard Tachylite changes?`
          : `${tab.fileName} changed on disk. Reload from disk?`;

        if (window.confirm(message)) {
          updateTabFromDisk(tab, result.file);
        } else {
          tab.externalPromptMtimeMs = result.file.diskMtimeMs;
        }
      }
    } finally {
      state.checkingExternalChanges = false;
    }
  }

  function newDocument() {
    openDocumentTab({
      filePath: null,
      fileName: 'Untitled.md',
      baseDirUrl: null,
      content: ''
    });
  }

  function syncFromPreview() {
    if (state.syncing) return;

    state.syncing = true;
    clearFindHighlights();
    mirrorCodeEditorTextareaValue();
    const html = withoutGeneratedUi(elements.previewEditor).innerHTML.trim();
    let nextContent = html
      ? isPlainPreviewInput()
        ? plainPreviewMarkdown()
        : turndown.turndown(html)
      : '';
    nextContent = nextContent.replace(/\u200b/g, '');
    setContent(nextContent, 'preview', true);
    state.previewInputPending = false;
    state.syncing = false;
  }

  function currentDocumentSnapshot() {
    flushActiveDocument();

    const tabs = state.tabs.map((tab) => ({
      dirty: tab.dirty,
      filePath: tab.filePath,
      fileName: tab.fileName,
      content: tab.content
    }));

    return {
      dirty: tabs.some((tab) => tab.dirty),
      filePath: state.filePath,
      fileName: state.fileName,
      content: state.content,
      tabs
    };
  }

  function dispatchRawInput() {
    elements.rawEditor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function rawSelection() {
    return {
      start: elements.rawEditor.selectionStart,
      end: elements.rawEditor.selectionEnd,
      value: elements.rawEditor.value
    };
  }

  function rawSelectedText() {
    const { start, end, value } = rawSelection();
    return value.slice(start, end);
  }

  function typedWrapPair(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) {
      return null;
    }

    const pairs = {
      '"': ['"', '"'],
      "'": ["'", "'"],
      '`': ['`', '`'],
      '(': ['(', ')'],
      ')': ['(', ')'],
      '[': ['[', ']'],
      ']': ['[', ']'],
      '{': ['{', '}'],
      '}': ['{', '}']
    };

    return pairs[event.key] || null;
  }

  function wrapTextareaSelectionWithPair(textarea, pair) {
    if (!textarea || typeof textarea.selectionStart !== 'number' || typeof textarea.selectionEnd !== 'number') {
      return false;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    if (start === end) {
      return false;
    }

    const selected = textarea.value.slice(start, end);
    const replacement = `${pair[0]}${selected}${pair[1]}`;
    const selectionStart = start + pair[0].length;
    const selectionEnd = selectionStart + selected.length;

    textarea.setRangeText(replacement, start, end, 'select');
    textarea.selectionStart = selectionStart;
    textarea.selectionEnd = selectionEnd;
    textarea.focus();
    return true;
  }

  function wrapRawSelectionWithTypedPair(event) {
    const pair = typedWrapPair(event);

    if (!pair || !wrapTextareaSelectionWithPair(elements.rawEditor, pair)) {
      return false;
    }

    event.preventDefault();
    dispatchRawInput();
    return true;
  }

  function typedWrapToken(text) {
    const token = document.createElement('span');

    token.dataset.typedWrapToken = text;
    token.textContent = text;
    return token;
  }

  function wrapPreviewSelectionWithTypedPair(event) {
    const pair = typedWrapPair(event);
    const selection = window.getSelection();

    if (!pair || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);

    if (!elements.previewEditor.contains(range.commonAncestorContainer)) {
      return false;
    }

    event.preventDefault();

    if (pair[0] === '`' && pair[1] === '`') {
      const code = document.createElement('code');

      code.appendChild(range.extractContents());
      range.insertNode(code);
      selectElementContents(code);
      state.previewInputPending = true;
      syncFromPreview();
      return true;
    }

    const openToken = typedWrapToken(pair[0]);
    const closeToken = typedWrapToken(pair[1]);
    const endRange = range.cloneRange();
    const startRange = range.cloneRange();

    endRange.collapse(false);
    endRange.insertNode(closeToken);
    startRange.collapse(true);
    startRange.insertNode(openToken);

    const nextRange = document.createRange();
    nextRange.setStartAfter(openToken);
    nextRange.setEndBefore(closeToken);
    selection.removeAllRanges();
    selection.addRange(nextRange);

    state.previewInputPending = true;
    syncFromPreview();
    return true;
  }

  function wrapEditableSelectionWithPair(root, pair) {
    const selection = window.getSelection();

    if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);

    if (!root.contains(range.commonAncestorContainer)) {
      return false;
    }

    const openToken = document.createTextNode(pair[0]);
    const closeToken = document.createTextNode(pair[1]);
    const endRange = range.cloneRange();
    const startRange = range.cloneRange();

    endRange.collapse(false);
    endRange.insertNode(closeToken);
    startRange.collapse(true);
    startRange.insertNode(openToken);

    const nextRange = document.createRange();
    nextRange.setStartAfter(openToken);
    nextRange.setEndBefore(closeToken);
    selection.removeAllRanges();
    selection.addRange(nextRange);
    return true;
  }

  function wrapLinkEditorSelectionWithTypedPair(event) {
    const pair = typedWrapPair(event);

    if (!pair || !wrapEditableSelectionWithPair(state.activeLinkEditor, pair)) {
      return false;
    }

    event.preventDefault();
    state.previewInputPending = true;
    syncFromPreview();
    return true;
  }

  function activeEditorKind() {
    if (document.activeElement === elements.rawEditor || state.mode === 'raw') {
      return 'raw';
    }

    return 'preview';
  }

  function rawWrapSelection(prefix, suffix = prefix, placeholder = '') {
    const { start, end, value } = rawSelection();
    const selected = value.slice(start, end);
    const fallback = placeholder || selected;
    const replacement = `${prefix}${selected || fallback}${suffix}`;

    elements.rawEditor.setRangeText(replacement, start, end, 'end');
    elements.rawEditor.focus();

    if (!selected && fallback) {
      elements.rawEditor.selectionStart = start + prefix.length;
      elements.rawEditor.selectionEnd = start + prefix.length + fallback.length;
    }

    dispatchRawInput();
  }

  function currentRawLineRange() {
    const { start, end, value } = rawSelection();
    const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const nextLineBreak = value.indexOf('\n', end);
    const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;

    return {
      lineStart,
      lineEnd,
      text: value.slice(lineStart, lineEnd)
    };
  }

  function rawTransformSelectedLines(transform) {
    const { lineStart, lineEnd, text } = currentRawLineRange();
    const lines = text.split('\n');
    const replacement = lines.map(transform).join('\n');

    elements.rawEditor.setRangeText(replacement, lineStart, lineEnd, 'select');
    elements.rawEditor.focus();
    dispatchRawInput();
  }

  function stripLineMarker(line) {
    return line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+\.\s+/, '')
      .replace(/^\s{0,3}>\s?/, '');
  }

  function rawApplyHeading(level) {
    const marker = `${'#'.repeat(level)} `;
    rawTransformSelectedLines((line) => `${marker}${stripLineMarker(line) || 'Heading'}`);
  }

  function rawApplyBulletList() {
    rawTransformSelectedLines((line) => `- ${stripLineMarker(line) || 'List item'}`);
  }

  function rawApplyNumberedList() {
    let index = 1;
    rawTransformSelectedLines((line) => `${index++}. ${stripLineMarker(line) || 'List item'}`);
  }

  function rawApplyQuote() {
    rawTransformSelectedLines((line) => `> ${stripLineMarker(line) || 'Quote'}`);
  }

  function rawApplyCodeBlock() {
    const { start, end, value } = rawSelection();
    const selected = value.slice(start, end) || 'code';
    const replacement = `\`\`\`\n${selected}\n\`\`\``;

    elements.rawEditor.setRangeText(replacement, start, end, 'select');
    elements.rawEditor.focus();
    dispatchRawInput();
  }

  function rawApplyLink() {
    const selected = rawSelectedText() || 'link';
    const url = window.prompt('Link URL', 'https://');

    if (!url) return;

    rawWrapSelection('[', `](${url})`, selected);
  }

  function selectionInsidePreview() {
    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    return elements.previewEditor.contains(range.commonAncestorContainer);
  }

  function selectedPreviewHtml() {
    if (!selectionInsidePreview()) return '';

    const range = window.getSelection().getRangeAt(0);
    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    return withoutGeneratedUi(container).innerHTML;
  }

  function selectedPreviewMarkdown() {
    const html = selectedPreviewHtml();
    return html ? turndown.turndown(html) : '';
  }

  function focusPreview() {
    elements.previewEditor.focus();
  }

  function previewSelectionRange() {
    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0) {
      focusPreview();
      return null;
    }

    const range = selection.getRangeAt(0);

    if (!elements.previewEditor.contains(range.commonAncestorContainer)) {
      focusPreview();
      return null;
    }

    return range;
  }

  function selectElementContents(element) {
    const range = document.createRange();
    const selection = window.getSelection();

    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function previewWrapSelection(tagName, placeholder) {
    const range = previewSelectionRange();
    if (!range) return;

    const element = document.createElement(tagName);

    if (range.collapsed) {
      element.textContent = placeholder;
    } else {
      element.appendChild(range.extractContents());
    }

    range.insertNode(element);
    selectElementContents(element);
    syncFromPreview();
  }

  function previewInsertCodeBlock() {
    const range = previewSelectionRange();
    if (!range) return;

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    const selectedText = range.collapsed ? 'code' : range.toString();

    code.textContent = selectedText;
    pre.appendChild(code);
    range.deleteContents();
    range.insertNode(pre);
    prepareCodeBlockCopyButtons();
    selectElementContents(code);
    syncFromPreview();
  }

  function execPreviewCommand(command, value = null) {
    focusPreview();
    document.execCommand(command, false, value);
    syncFromPreview();
  }

  function previewApplyLink() {
    const range = previewSelectionRange();
    if (!range) return;

    const selectedText = range.toString() || 'link';
    const url = window.prompt('Link URL', 'https://');

    if (!url) return;

    if (range.collapsed) {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.textContent = selectedText;
      range.insertNode(anchor);
      selectElementContents(anchor);
    } else {
      document.execCommand('createLink', false, url);
    }

    prepareRenderedLinks();
    syncFromPreview();
  }

  function formatRaw(command, payload) {
    if (command === 'format:bold') rawWrapSelection('**', '**', 'bold text');
    if (command === 'format:italic') rawWrapSelection('*', '*', 'italic text');
    if (command === 'format:strike') rawWrapSelection('~~', '~~', 'struck text');
    if (command === 'format:inline-code') rawWrapSelection('`', '`', 'code');
    if (command === 'format:heading') rawApplyHeading(payload.level || 1);
    if (command === 'format:bullet-list') rawApplyBulletList();
    if (command === 'format:numbered-list') rawApplyNumberedList();
    if (command === 'format:quote') rawApplyQuote();
    if (command === 'format:code-block') rawApplyCodeBlock();
    if (command === 'format:link') rawApplyLink();
  }

  function formatPreview(command, payload) {
    if (command === 'format:bold') execPreviewCommand('bold');
    if (command === 'format:italic') execPreviewCommand('italic');
    if (command === 'format:strike') execPreviewCommand('strikeThrough');
    if (command === 'format:inline-code') previewWrapSelection('code', 'code');
    if (command === 'format:heading') execPreviewCommand('formatBlock', `H${payload.level || 1}`);
    if (command === 'format:bullet-list') execPreviewCommand('insertUnorderedList');
    if (command === 'format:numbered-list') execPreviewCommand('insertOrderedList');
    if (command === 'format:quote') execPreviewCommand('formatBlock', 'BLOCKQUOTE');
    if (command === 'format:code-block') previewInsertCodeBlock();
    if (command === 'format:link') previewApplyLink();
  }

  function markdownForClipboard() {
    if (document.activeElement === elements.rawEditor && rawSelectedText()) {
      return rawSelectedText();
    }

    const selectedMarkdown = selectedPreviewMarkdown();
    if (selectedMarkdown) return selectedMarkdown;

    return state.content;
  }

  function htmlForClipboard(markdown) {
    const selectedHtml = selectedPreviewHtml();
    if (selectedHtml) return DOMPurify.sanitize(selectedHtml);

    return DOMPurify.sanitize(md.render(markdown));
  }

  function copyMarkdown() {
    api.writeClipboard({
      text: markdownForClipboard()
    });
  }

  function copyHtml() {
    const markdown = markdownForClipboard();
    api.writeClipboard({
      text: markdown,
      html: htmlForClipboard(markdown)
    });
  }

  function exportedHtmlStyles() {
    return `
      :root { color-scheme: light; }
      body {
        margin: 0;
        background: #f7f8f6;
        color: #1f2421;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.72;
      }
      main {
        max-width: 860px;
        margin: 0 auto;
        padding: 48px min(56px, 7vw);
        background: #ffffff;
        min-height: 100vh;
      }
      h1, h2, h3 { color: #17211d; line-height: 1.18; }
      h1 { margin: 0 0 20px; padding-bottom: 12px; border-bottom: 1px solid #d7ddd5; font-size: 36px; }
      h2 { margin: 34px 0 14px; font-size: 25px; }
      h3 { margin: 28px 0 10px; font-size: 19px; }
      p, ul, ol, blockquote, pre, table { margin: 0 0 16px; }
      a { color: #0b5f59; text-decoration-thickness: 2px; text-underline-offset: 3px; }
      blockquote { padding: 2px 0 2px 18px; border-left: 4px solid #cc8a1d; color: #4e584f; }
      code { border-radius: 5px; background: #eef1ef; padding: 0.16em 0.34em; font-family: Consolas, "Liberation Mono", Menlo, monospace; font-size: 0.92em; }
      pre { overflow: auto; border: 1px solid #d7ddd5; border-radius: 8px; background: #1f2421; padding: 16px; color: #f6f7f4; }
      pre code { background: transparent; padding: 0; color: inherit; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th, td { padding: 9px 11px; border: 1px solid #d7ddd5; vertical-align: top; }
      th { background: #f0f2ef; text-align: left; }
      img { max-width: 100%; height: auto; border-radius: 7px; }
      hr { height: 1px; border: 0; background: #d7ddd5; margin: 28px 0; }
    `;
  }

  function exportHtmlDocument(snapshot) {
    const title = escapeHtml((snapshot.fileName || 'Untitled.md').replace(/\.[^.]+$/, ''));
    const base = state.baseDirUrl ? `\n    <base href="${escapeHtml(state.baseDirUrl)}">` : '';
    const body = DOMPurify.sanitize(md.render(snapshot.content || ''), {
      ADD_ATTR: ['target', 'rel', 'loading', 'decoding', 'data-frontmatter']
    });

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">${base}
    <title>${title}</title>
    <style>${exportedHtmlStyles()}</style>
  </head>
  <body>
    <main>
${body}
    </main>
  </body>
</html>
`;
  }

  function exportPlainTextDocument(snapshot) {
    const container = document.createElement('div');

    container.style.position = 'fixed';
    container.style.inset = '-10000px auto auto -10000px';
    container.style.width = '760px';
    container.innerHTML = DOMPurify.sanitize(md.render(snapshot.content || ''));
    document.body.appendChild(container);

    try {
      return (container.innerText || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
    } finally {
      container.remove();
    }
  }

  function exportLabel(type) {
    return {
      html: 'HTML',
      pdf: 'PDF',
      markdown: 'Markdown',
      text: 'plain text'
    }[type] || 'file';
  }

  async function exportDocument(type) {
    closeExportMenu();
    const snapshot = currentDocumentSnapshot();
    const html = type === 'html' || type === 'pdf' ? exportHtmlDocument(snapshot) : '';
    let result = { canceled: true };

    try {
      if (type === 'html') {
        result = await api.exportFile({
          type: 'html',
          filePath: snapshot.filePath,
          fileName: snapshot.fileName,
          content: html
        });
      } else if (type === 'pdf') {
        result = await api.exportPdf({
          filePath: snapshot.filePath,
          fileName: snapshot.fileName,
          html
        });
      } else if (type === 'markdown') {
        result = await api.exportFile({
          type: 'markdown',
          filePath: snapshot.filePath,
          fileName: snapshot.fileName,
          content: snapshot.content
        });
      } else if (type === 'text') {
        result = await api.exportFile({
          type: 'text',
          filePath: snapshot.filePath,
          fileName: snapshot.fileName,
          content: exportPlainTextDocument(snapshot)
        });
      }
    } catch (error) {
      elements.statusFile.textContent = `Export failed: ${error.message}`;
      return;
    }

    if (!result.canceled && result.filePath) {
      elements.statusFile.textContent = `Exported ${exportLabel(type)} to ${result.filePath}`;
    } else if (result.error) {
      elements.statusFile.textContent = `Export failed: ${result.error}`;
    }
  }

  function exportHtml() {
    exportDocument('html');
  }

  function handleEditorCommand(command, payload = {}) {
    if (command === 'copy:markdown') {
      copyMarkdown();
      return;
    }

    if (command === 'copy:html') {
      copyHtml();
      return;
    }

    if (activeEditorKind() === 'raw') {
      formatRaw(command, payload);
      return;
    }

    formatPreview(command, payload);
  }

  const renderFromRawSoon = debounce(() => {
    if (document.activeElement === elements.previewEditor) return;
    renderPreview(state.content);
  }, 140);

  const syncFromPreviewSoon = debounce(syncFromPreview, 180);

  function setMode(mode) {
    if (!['preview', 'split', 'raw'].includes(mode)) return;

    closeActiveLinkEditor();
    closeActiveInlineCodeEditor();
    closeActiveCodeEditor();
    state.mode = mode;
    updateWorkspaceClass();
    elements.modeButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    });

    if (mode !== 'raw') {
      renderPreview(state.content);
    }

    if (mode === 'raw') {
      elements.rawEditor.focus();
    } else {
      elements.previewEditor.focus();
    }

    updateStatus();

    if (state.find.open) {
      refreshFind();
    }
  }

  function confirmDiscardUnsaved() {
    if (!state.dirty) return true;
    return window.confirm('You have unsaved changes. Continue without saving them?');
  }

  async function openFile() {
    const result = await api.openFile();
    if (result.canceled) return;

    const files = result.files || (result.file ? [result.file] : []);
    files.forEach((file) => openDocumentTab(file));
  }

  async function saveFile() {
    const snapshot = currentDocumentSnapshot();
    const result = await api.saveFile({
      filePath: snapshot.filePath,
      fileName: snapshot.fileName,
      content: snapshot.content
    });

    if (result.canceled) return false;
    loadDocument(result.file);
    return true;
  }

  async function saveFileAs() {
    const snapshot = currentDocumentSnapshot();
    const result = await api.saveFileAs({
      filePath: snapshot.filePath,
      fileName: snapshot.fileName,
      content: snapshot.content
    });

    if (result.canceled) return false;
    loadDocument(result.file);
    return true;
  }

  function isExportMenuOpen() {
    return !elements.exportDropdown.hidden;
  }

  function openExportMenu() {
    elements.exportDropdown.hidden = false;
    elements.exportButton.setAttribute('aria-expanded', 'true');
  }

  function closeExportMenu() {
    elements.exportDropdown.hidden = true;
    elements.exportButton.setAttribute('aria-expanded', 'false');
  }

  function toggleExportMenu() {
    if (isExportMenuOpen()) {
      closeExportMenu();
      return;
    }

    openExportMenu();
  }

  function handleCommand(command, payload) {
    switch (command) {
      case 'new':
      case 'new-tab':
        newDocument();
        break;
      case 'new-window':
        api.newWindow();
        break;
      case 'close-tab':
        closeTab();
        break;
      case 'open':
        openFile();
        break;
      case 'save':
        saveFile();
        break;
      case 'save-as':
        saveFileAs();
        break;
      case 'check-external-changes':
        checkExternalChanges();
        break;
      case 'export-html':
        exportDocument('html');
        break;
      case 'export-pdf':
        exportDocument('pdf');
        break;
      case 'export-markdown':
        exportDocument('markdown');
        break;
      case 'export-text':
        exportDocument('text');
        break;
      case 'find':
        openFind();
        break;
      case 'toggle-outline':
        toggleOutline();
        break;
      case 'mode:preview':
        setMode('preview');
        break;
      case 'mode:split':
        setMode('split');
        break;
      case 'mode:raw':
        setMode('raw');
        break;
      case 'open-file':
        if (payload) openDocumentTab(payload);
        break;
      default:
        break;
    }
  }

  elements.rawEditor.addEventListener('input', () => {
    setContent(elements.rawEditor.value, 'raw', true);
    if (state.mode === 'split') renderFromRawSoon();
  });

  elements.rawEditor.addEventListener('keydown', (event) => {
    if (wrapRawSelectionWithTypedPair(event)) {
      return;
    }

    if (event.key !== 'Tab') return;

    event.preventDefault();
    const { selectionStart, selectionEnd, value } = elements.rawEditor;
    elements.rawEditor.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    elements.rawEditor.selectionStart = selectionStart + 2;
    elements.rawEditor.selectionEnd = selectionStart + 2;
    elements.rawEditor.dispatchEvent(new Event('input', { bubbles: true }));
  });

  elements.rawEditor.addEventListener('scroll', syncRawHighlightScroll);

  elements.previewEditor.addEventListener('keydown', handlePreviewKeydown);
  elements.previewEditor.addEventListener('input', (event) => {
    state.previewInputPending = true;

    if (state.activeInlineCodeEditor && state.activeInlineCodeEditor.contains(event.target)) {
      syncFromPreviewSoon();
      return;
    }

    if (applyCompletedFencedCodeShortcut(event)) {
      return;
    }

    if (applyInlineMarkdownShortcut(event)) {
      return;
    }

    syncFromPreviewSoon();
  });

  elements.previewEditor.addEventListener('paste', (event) => {
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;

    event.preventDefault();
    document.execCommand('insertText', false, text);
  });

  elements.previewEditor.addEventListener('click', (event) => {
    const copyButton = event.target.closest('[data-code-copy-button="true"]');
    const anchor = event.target.closest('a[href]');
    const codeBlock = event.target.closest('pre');
    const inlineCode = event.target.closest('code');

    if (copyButton) {
      event.preventDefault();
      event.stopPropagation();

      const pre = copyButton.closest('pre');
      const code = pre ? pre.querySelector('code') : null;
      api.writeClipboard({ text: code ? code.textContent || '' : '' });
      setCodeCopyButtonState(copyButton, true);
      setTimeout(() => {
        if (copyButton.isConnected) setCodeCopyButtonState(copyButton);
      }, 1200);
      return;
    }

    if (!anchor && !codeBlock && !inlineCode) return;

    if (codeBlock) {
      event.preventDefault();
      activateCodeBlockEditor(codeBlock);
      return;
    }

    if (inlineCode) {
      event.preventDefault();
      activateInlineCodeEditor(inlineCode);
      return;
    }

    event.preventDefault();

    if (event.ctrlKey || event.metaKey) {
      api.openTarget(anchor.href);
      return;
    }

    activateLinkEditor(anchor);
  });

  elements.previewEditor.addEventListener('focusout', () => {
    setTimeout(() => {
      const linkEditor = state.activeLinkEditor;
      const inlineCodeEditor = state.activeInlineCodeEditor;
      const codeEditor = state.activeCodeEditor;
      const active = document.activeElement;
      const focusWithinPreview = active === elements.previewEditor || elements.previewEditor.contains(active);

      if (linkEditor && (!focusWithinPreview || !selectionInsideElement(linkEditor))) {
        closeActiveLinkEditor();
      }

      if (inlineCodeEditor && (!focusWithinPreview || !selectionInsideElement(inlineCodeEditor))) {
        closeActiveInlineCodeEditor();
      }

      if (codeEditor && (!focusWithinPreview || !codeEditor.contains(active))) {
        closeActiveCodeEditor();
      }
    }, 0);
  });

  document.addEventListener('selectionchange', closeLinkEditorWhenSelectionLeaves);
  document.addEventListener('selectionchange', closeInlineCodeEditorWhenSelectionLeaves);
  document.addEventListener('selectionchange', closeCodeEditorWhenSelectionLeaves);
  document.addEventListener('click', (event) => {
    if (isExportMenuOpen() && !elements.exportMenu.contains(event.target)) {
      closeExportMenu();
    }
  });

  elements.modeButtons.forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  elements.themeSelect.addEventListener('change', () => {
    setTheme(elements.themeSelect.value);
  });

  elements.newButton.addEventListener('click', newDocument);
  elements.newTabButton.addEventListener('click', newDocument);
  elements.newWindowButton.addEventListener('click', () => api.newWindow());
  elements.openButton.addEventListener('click', openFile);
  elements.saveButton.addEventListener('click', saveFile);
  elements.saveAsButton.addEventListener('click', saveFileAs);
  elements.exportButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleExportMenu();
  });
  elements.exportItems.forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      exportDocument(button.dataset.export);
    });
  });
  elements.findButton.addEventListener('click', openFind);
  elements.outlineButton.addEventListener('click', toggleOutline);

  elements.findBar.addEventListener('submit', (event) => {
    event.preventDefault();
    moveFind(1);
  });

  elements.findInput.addEventListener('input', () => refreshFind(0));
  elements.findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      moveFind(event.shiftKey ? -1 : 1);
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });
  elements.findPrevButton.addEventListener('click', () => moveFind(-1));
  elements.findNextButton.addEventListener('click', () => moveFind(1));
  elements.findCloseButton.addEventListener('click', closeFind);

  elements.rawEditor.addEventListener('focus', () => {
    if (state.find.open) refreshFind(0);
  });

  elements.previewEditor.addEventListener('focus', () => {
    if (state.find.open) refreshFind(0);
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.closeApproved || !hasDirtyTabs()) return;

    event.preventDefault();
    event.returnValue = '';
  });

  window.addEventListener('keydown', (event) => {
    if (handleZoomKeydown(event)) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openFind();
      return;
    }

    if (state.find.open && event.key === 'Escape') {
      event.preventDefault();
      closeFind();
      return;
    }

    if (isExportMenuOpen() && event.key === 'Escape') {
      event.preventDefault();
      closeExportMenu();
      elements.exportButton.focus();
    }
  });

  window.addEventListener('wheel', handleZoomWheel, { passive: false });

  window.addEventListener('dragover', (event) => {
    event.preventDefault();
  });

  window.addEventListener('drop', async (event) => {
    event.preventDefault();

    const files = Array.from(event.dataTransfer.files);

    for (const file of files) {
      const content = await file.text();
      openDocumentTab({
        filePath: file.path || null,
        fileName: file.name,
        baseDirUrl: null,
        content
      });
    }
  });

  api.onCommand(handleCommand);
  api.onEditorCommand(handleEditorCommand);
  api.onCloseStateRequest((requestId) => {
    api.sendCloseState(requestId, currentDocumentSnapshot());
  });
  api.onCloseApproved(() => {
    state.closeApproved = true;
  });
  api.onThemeChanged(applyTheme);
  api.onSpellcheckEnabledChanged(applySpellcheckEnabled);
  api.getTheme().then(applyTheme);
  api.getSpellcheckEnabled().then(applySpellcheckEnabled);
  updateWorkspaceClass();
  updateOutline();

  api.getInitialFile().then((result) => {
    if (result && !result.canceled && result.file) {
      openDocumentTab(result.file);
      return;
    }

    newDocument();
  });
})();
