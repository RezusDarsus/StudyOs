window.StudyOSVisuals = (() => {
  let mermaidStarted = false;
  let diagramNumber = 0;

  function initializeMermaid() {
    if (mermaidStarted || !window.mermaid) return;
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        primaryColor: '#dcefe8', primaryTextColor: '#203438', primaryBorderColor: '#177d72',
        lineColor: '#42636a', secondaryColor: '#f4ede7', tertiaryColor: '#f8f8f5', fontFamily: 'Inter, system-ui, sans-serif'
      },
      flowchart: { useMaxWidth: true, htmlLabels: false, curve: 'basis' }
    });
    mermaidStarted = true;
  }

  async function renderMermaid(target, definition) {
    const fallback = () => { const pre = document.createElement('pre'); pre.className = 'diagram-fallback'; pre.textContent = definition; target.replaceChildren(pre); };
    if (!window.mermaid) { fallback(); return; }
    try {
      initializeMermaid();
      const id = `studyos-mermaid-${Date.now()}-${diagramNumber++}`;
      const rendered = await window.mermaid.render(id, definition.trim());
      target.innerHTML = rendered.svg;
      rendered.bindFunctions?.(target);
      target.classList.remove('diagram-loading');
    } catch (error) { console.warn('Could not render Mermaid diagram', error); fallback(); }
  }

  function renderFunctionPlot(target, definition) {
    try {
      const settings = parsePlot(definition);
      const fn = compileExpression(settings.function);
      const svg = createPlot(settings, fn);
      target.replaceChildren(svg);
      target.classList.remove('diagram-loading');
    } catch (error) {
      const fallback = document.createElement('pre'); fallback.className = 'diagram-fallback'; fallback.textContent = definition;
      target.replaceChildren(fallback);
      console.warn('Could not render function plot', error);
    }
  }

  function parsePlot(definition) {
    const values = { title: 'Function plot', function: 'x', xMin: -5, xMax: 5 };
    for (const line of definition.split(/\r?\n/)) {
      const match = line.match(/^\s*([a-zA-Z]+)\s*:\s*(.+?)\s*$/);
      if (!match) continue;
      const key = match[1].toLowerCase(); const value = match[2];
      if (key === 'title' || key === 'function') values[key] = value;
      if (key === 'xmin' || key === 'xmax') values[key === 'xmin' ? 'xMin' : 'xMax'] = Number(value);
    }
    if (!Number.isFinite(values.xMin) || !Number.isFinite(values.xMax) || values.xMin >= values.xMax) throw new Error('Invalid plot range');
    return values;
  }

  function compileExpression(expression) {
    let source = String(expression || '').trim().replace(/^y\s*=\s*/i, '').replace(/\^/g, '**');
    const names = source.match(/[A-Za-z_]+/g) || [];
    const allowed = new Set(['x', 'sin', 'cos', 'tan', 'sqrt', 'abs', 'exp', 'log', 'pi']);
    if (names.some(name => !allowed.has(name.toLowerCase())) || /[^0-9A-Za-z_+\-*/().,\s]/.test(source)) throw new Error('Unsupported plot expression');
    source = source.replace(/\bpi\b/gi, 'Math.PI').replace(/\bsin\b/gi, 'Math.sin').replace(/\bcos\b/gi, 'Math.cos').replace(/\btan\b/gi, 'Math.tan').replace(/\bsqrt\b/gi, 'Math.sqrt').replace(/\babs\b/gi, 'Math.abs').replace(/\bexp\b/gi, 'Math.exp').replace(/\blog\b/gi, 'Math.log');
    return new Function('x', `"use strict"; return (${source});`);
  }

  function createPlot(settings, fn) {
    const ns = 'http://www.w3.org/2000/svg'; const width = 640; const height = 340; const margin = { left: 52, right: 20, top: 42, bottom: 42 };
    const samples = []; const count = 220;
    for (let index = 0; index <= count; index++) { const x = settings.xMin + (settings.xMax - settings.xMin) * index / count; let y = Number.NaN; try { y = fn(x); } catch {} if (Number.isFinite(y) && Math.abs(y) < 1e6) samples.push({ x, y }); }
    if (samples.length < 2) throw new Error('Function cannot be plotted in this range');
    let yMin = Math.min(...samples.map(point => point.y)); let yMax = Math.max(...samples.map(point => point.y));
    const padding = Math.max((yMax - yMin) * .12, 1); yMin = Math.min(0, yMin - padding); yMax = Math.max(0, yMax + padding);
    const xScale = x => margin.left + (x - settings.xMin) / (settings.xMax - settings.xMin) * (width - margin.left - margin.right);
    const yScale = y => height - margin.bottom - (y - yMin) / (yMax - yMin) * (height - margin.top - margin.bottom);
    const el = (name, attributes = {}) => { const node = document.createElementNS(ns, name); Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value))); return node; };
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': settings.title, class: 'function-plot-svg' });
    svg.append(el('rect', { x: 0, y: 0, width, height, rx: 12, fill: '#f7fbf9' }));
    for (let step = 0; step <= 8; step++) { const x = margin.left + step / 8 * (width - margin.left - margin.right); const y = margin.top + step / 8 * (height - margin.top - margin.bottom); svg.append(el('line', { x1: x, y1: margin.top, x2: x, y2: height - margin.bottom, stroke: '#dce7e2', 'stroke-width': 1 })); svg.append(el('line', { x1: margin.left, y1: y, x2: width - margin.right, y2: y, stroke: '#dce7e2', 'stroke-width': 1 })); }
    if (settings.xMin <= 0 && settings.xMax >= 0) svg.append(el('line', { x1: xScale(0), y1: margin.top, x2: xScale(0), y2: height - margin.bottom, stroke: '#627b78', 'stroke-width': 1.5 }));
    if (yMin <= 0 && yMax >= 0) svg.append(el('line', { x1: margin.left, y1: yScale(0), x2: width - margin.right, y2: yScale(0), stroke: '#627b78', 'stroke-width': 1.5 }));
    let path = ''; let previous = null;
    for (const point of samples) { const x = xScale(point.x); const y = yScale(point.y); if (previous && Math.abs(y - previous) > height * 1.5) { path += ` M ${x} ${y}`; } else { path += path ? ` L ${x} ${y}` : `M ${x} ${y}`; } previous = y; }
    svg.append(el('path', { d: path, fill: 'none', stroke: '#177d72', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    const title = el('text', { x: margin.left, y: 25, fill: '#203438', 'font-size': 16, 'font-weight': 700 }); title.textContent = humanFormula(settings.title); svg.append(title);
    const xLabel = el('text', { x: width - margin.right, y: height - 15, fill: '#627b78', 'font-size': 12, 'text-anchor': 'end' }); xLabel.textContent = `x: ${settings.xMin} to ${settings.xMax}`; svg.append(xLabel);
    const yLabel = el('text', { x: 12, y: margin.top + 8, fill: '#627b78', 'font-size': 12 }); yLabel.textContent = 'y'; svg.append(yLabel);
    return svg;
  }

  function humanFormula(value) {
    const superscripts = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
    return String(value).replace(/\^(-?\d+)/g, (_, exponent) => [...exponent].map(char => superscripts[char] || char).join(''));
  }

  return { renderMermaid, renderFunctionPlot };
})();
