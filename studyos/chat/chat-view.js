// Chat rendering: assistant content pipeline (markdown → safe DOM), message list, and the staged
// progress indicator. All remote/model content enters through text nodes or escaped HTML —
// never raw innerHTML.
window.StudyOSChat = window.StudyOSChat || {};

(function (Chat) {
  'use strict';

  const { escapeHtml } = window.StudyOSFormat;

  // ------------------------------------------------------------- citation chips (loaded first)
  // citations.js owns attachCitation; it is merged into this namespace by its own IIFE.

  // ------------------------------------------------------------- safe markdown rendering
  function splitTableRow(line) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()); }
  function isTableSeparator(line) { const cells = splitTableRow(line); return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell)); }

  function appendMarkdownText(target, text) {
    const pattern = /(\[\[source:\s*[^\]]+\]\]|\[source:\s*[^\]]+\]|\*\*[^*]+\*\*|`[^`]+`|<br\s*\/?>)/gi;
    let cursor = 0; let match;
    while ((match = pattern.exec(text))) {
      if (match.index > cursor) target.append(document.createTextNode(text.slice(cursor, match.index)));
      const token = match[0];
      if (/^<br/i.test(token)) target.append(document.createElement('br'));
      else if (/^\[\[?source:/i.test(token)) { window.StudyOSChat?.attachCitation?.(target, token); }
      else { const node = document.createElement(token.startsWith('**') ? 'strong' : 'code'); node.textContent = token.startsWith('**') ? token.slice(2, -2) : token.slice(1, -1); target.append(node); }
      cursor = pattern.lastIndex;
    }
    if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
  }

  function readableFormula(value) {
    return String(value).replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\sqrt\{([^}]+)\}/g, '√($1)').replace(/\^\{?([^}\s]+)\}?/g, '^$1').replace(/[{}]/g, '');
  }

  function appendRichInline(target, text) {
    const formulaPattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;
    let cursor = 0; let match;
    while ((match = formulaPattern.exec(text))) {
      appendMarkdownText(target, text.slice(cursor, match.index));
      const formula = match[1] ?? match[2] ?? match[3] ?? match[4];
      const display = Boolean(match[1] || match[2]);
      const math = document.createElement('span'); math.className = display ? 'math-display' : 'math-inline';
      if (window.katex) { try { window.katex.render(formula, math, { displayMode: display, throwOnError: false, trust: false }); } catch (_) { math.textContent = readableFormula(formula); } }
      else math.textContent = readableFormula(formula);
      target.append(math); cursor = formulaPattern.lastIndex;
    }
    appendMarkdownText(target, text.slice(cursor));
  }

  function appendMarkdownTable(body, lines, start) {
    const headers = splitTableRow(lines[start]); let index = start + 2; const rows = [];
    while (index < lines.length && lines[index].trim() && lines[index].includes('|')) { const cells = splitTableRow(lines[index]); if (cells.length >= 2) rows.push(cells); index++; }
    const wrapper = document.createElement('div'); wrapper.className = 'response-table-wrap';
    const table = document.createElement('table'); table.className = 'response-table';
    const head = document.createElement('thead'); const headerRow = document.createElement('tr');
    headers.forEach(header => { const th = document.createElement('th'); appendRichInline(th, header); headerRow.append(th); }); head.append(headerRow); table.append(head);
    const tbody = document.createElement('tbody');
    rows.forEach(cells => { const row = document.createElement('tr'); headers.forEach((header, cellIndex) => { const td = document.createElement('td'); td.dataset.label = header; appendRichInline(td, cells[cellIndex] || '—'); row.append(td); }); tbody.append(row); });
    table.append(tbody); wrapper.append(table); body.append(wrapper);
    return index;
  }

  function appendAssistantText(body, text) {
    const lines = String(text || '').trim().split(/\r?\n/); let index = 0;
    while (index < lines.length) {
      const line = lines[index].trim();
      if (!line) { index++; continue; }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) { const node = document.createElement(heading[1].length <= 2 ? 'h3' : 'h4'); appendRichInline(node, heading[2]); body.append(node); index++; continue; }
      if (index + 1 < lines.length && line.includes('|') && isTableSeparator(lines[index + 1])) { index = appendMarkdownTable(body, lines, index); continue; }
      const listMatch = line.match(/^([-*])\s+(.+)$/) || line.match(/^(\d+)[.)]\s+(.+)$/);
      if (listMatch) {
        const ordered = /^\d/.test(line); const list = document.createElement(ordered ? 'ol' : 'ul'); list.className = 'rich-list';
        while (index < lines.length) { const item = lines[index].trim().match(ordered ? /^\d+[.)]\s+(.+)$/ : /^[-*]\s+(.+)$/); if (!item) break; const li = document.createElement('li'); appendRichInline(li, item[1]); list.append(li); index++; }
        body.append(list); continue;
      }
      if (line.startsWith('> ')) { const note = document.createElement('aside'); note.className = 'evidence-note'; appendRichInline(note, line.slice(2)); body.append(note); index++; continue; }
      const paragraphLines = [line]; index++;
      while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s+/.test(lines[index].trim()) && !/^([-*])\s+/.test(lines[index].trim()) && !/^\d+[.)]\s+/.test(lines[index].trim()) && !(index + 1 < lines.length && lines[index].includes('|') && isTableSeparator(lines[index + 1]))) { paragraphLines.push(lines[index].trim()); index++; }
      const paragraph = document.createElement('p'); appendRichInline(paragraph, paragraphLines.join(' ')); body.append(paragraph);
    }
  }

  function renderAssistantContent(body, text) {
    const source = String(text ?? '');
    const pattern = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
    let cursor = 0; let match;
    while ((match = pattern.exec(source))) {
      appendAssistantText(body, source.slice(cursor, match.index));
      const language = match[1].toLowerCase(); const code = match[2].trim();
      if (language === 'mermaid') { const diagram = document.createElement('div'); diagram.className = 'mermaid-diagram diagram-loading'; diagram.setAttribute('role', 'img'); diagram.setAttribute('aria-label', 'Study diagram'); body.append(diagram); window.StudyOSVisuals?.renderMermaid(diagram, code); }
      else if (language === 'plot') { const plot = document.createElement('div'); plot.className = 'function-plot diagram-loading'; plot.setAttribute('role', 'img'); plot.setAttribute('aria-label', 'Function graph'); body.append(plot); window.StudyOSVisuals?.renderFunctionPlot(plot, code); }
      else { const block = document.createElement('pre'); block.className = 'code-block'; block.textContent = code; body.append(block); }
      cursor = pattern.lastIndex;
    }
    appendAssistantText(body, source.slice(cursor));
    if (body.querySelector('.mermaid-diagram, .function-plot')) body.classList.add('visual-message');
    if (body.querySelector('.response-table-wrap')) body.classList.add('rich-wide-message');
  }

  // ------------------------------------------------------------- message list
  let chatHistory = null;
  let activeChatTitleProvider = () => 'New chat';

  function bind(element) { chatHistory = element; }

  function onChatTitle(provider) { activeChatTitleProvider = provider; }

  function clear() {
    if (!chatHistory) return;
    chatHistory.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'chat-empty'; empty.id = 'chatEmpty';
    empty.textContent = 'Start a new workspace conversation. Replies will use your uploaded learning sources and persistent learner state.';
    chatHistory.append(empty);
  }

  function addMessage(text, type) {
    if (!chatHistory) return;
    chatHistory.querySelector('#chatEmpty')?.remove();
    const wrapper = document.createElement('div'); wrapper.className = `message ${type}`;
    const body = document.createElement('div');
    if (type === 'assistant') renderAssistantContent(body, text);
    else { const paragraph = document.createElement('p'); paragraph.textContent = text; body.append(paragraph); }
    const meta = document.createElement('small'); meta.textContent = type === 'assistant' ? 'Live project AI · just now' : `${activeChatTitleProvider()} · just now`; body.append(meta);
    if (type === 'assistant') { const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = 'S'; wrapper.append(avatar); }
    wrapper.append(body);
    chatHistory.append(wrapper);
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }

  function addProgress() {
    if (!chatHistory) return { remove() {} };
    chatHistory.querySelector('#chatEmpty')?.remove();
    const wrapper = document.createElement('div'); wrapper.className = 'message assistant ai-progress-message';
    const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = 'S';
    const body = document.createElement('div'); body.className = 'ai-progress';
    const status = document.createElement('div'); status.className = 'ai-progress-status';
    const dots = document.createElement('span'); dots.className = 'thinking-dots'; dots.setAttribute('aria-hidden', 'true'); dots.innerHTML = '<i></i><i></i><i></i>';
    const label = document.createElement('span');
    status.append(dots, label); body.append(status);
    const stages = ['Searching your project sources…', 'Thinking through the evidence…', 'Writing your answer…'];
    const setStage = index => { label.textContent = stages[index]; body.dataset.stage = String(index); chatHistory.scrollTop = chatHistory.scrollHeight; };
    setStage(0); wrapper.append(avatar, body); chatHistory.append(wrapper); chatHistory.scrollTop = chatHistory.scrollHeight;
    const timers = [setTimeout(() => setStage(1), 2500), setTimeout(() => setStage(2), 10000)];
    return { remove() { timers.forEach(clearTimeout); wrapper.remove(); } };
  }

  Chat.appendAssistantText = appendAssistantText;
  Chat.appendRichInline = appendRichInline;
  Chat.renderAssistantContent = renderAssistantContent;
  Chat.escapeHtml = escapeHtml;
  Chat.bind = bind;
  Chat.onChatTitle = onChatTitle;
  Chat.clear = clear;
  Chat.addMessage = addMessage;
  Chat.addProgress = addProgress;
})(window.StudyOSChat);
