/**
 * charts.js — NIU Companion Web Dashboard
 *
 * Tiny dependency-free SVG line chart. Returns markup as a string so it is
 * easy to test; every value interpolated into it is a number or an escaped
 * label, never raw data.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Charts = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const f = (n) => (Math.round(n * 10) / 10).toString();

  /**
   * @param {{x:number,y:number}[]} points sorted by x
   * @param {{width?:number,height?:number,yMin?:number,yMax?:number,label?:string,unit?:string,xFormat?:(x:number)=>string}} [opts]
   * @returns {string} SVG markup, or '' when there is nothing to draw
   */
  function lineChart(points, opts) {
    const o = Object.assign({ width: 320, height: 130, unit: '', label: 'Chart', xFormat: null }, opts);
    const pts = (points || []).filter((p) => p && isNum(p.x) && isNum(p.y));
    if (!pts.length) return '';

    const padL = 30, padR = 8, padT = 10, padB = o.xFormat ? 20 : 8;
    const w = o.width - padL - padR;
    const h = o.height - padT - padB;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    let yMin = isNum(o.yMin) ? o.yMin : Math.min(...ys);
    let yMax = isNum(o.yMax) ? o.yMax : Math.max(...ys);
    if (yMax - yMin < 1) { yMax += 0.5; yMin -= 0.5; }          // flat data still draws a visible line
    const sx = (x) => padL + (xMax === xMin ? w / 2 : ((x - xMin) / (xMax - xMin)) * w);
    const sy = (y) => padT + h - ((y - yMin) / (yMax - yMin)) * h;

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${f(sx(p.x))} ${f(sy(p.y))}`).join(' ');
    const last = pts[pts.length - 1];
    const parts = [
      `<svg class="chart" viewBox="0 0 ${o.width} ${o.height}" role="img" aria-label="${esc(o.label)}" xmlns="http://www.w3.org/2000/svg">`,
      `<line class="chart-grid" x1="${padL}" y1="${f(sy(yMax))}" x2="${o.width - padR}" y2="${f(sy(yMax))}"/>`,
      `<line class="chart-grid" x1="${padL}" y1="${f(sy(yMin))}" x2="${o.width - padR}" y2="${f(sy(yMin))}"/>`,
      `<text class="chart-axis" x="${padL - 4}" y="${f(sy(yMax) + 4)}" text-anchor="end">${esc(f(yMax))}${esc(o.unit)}</text>`,
      `<text class="chart-axis" x="${padL - 4}" y="${f(sy(yMin) + 3)}" text-anchor="end">${esc(f(yMin))}${esc(o.unit)}</text>`,
    ];
    if (pts.length > 1) parts.push(`<path class="chart-line" d="${line}" fill="none"/>`);
    parts.push(`<circle class="chart-dot" cx="${f(sx(last.x))}" cy="${f(sy(last.y))}" r="3.5"/>`);
    if (o.xFormat) {
      parts.push(`<text class="chart-axis" x="${padL}" y="${o.height - 4}" text-anchor="start">${esc(o.xFormat(xMin))}</text>`);
      if (xMax !== xMin) parts.push(`<text class="chart-axis" x="${o.width - padR}" y="${o.height - 4}" text-anchor="end">${esc(o.xFormat(xMax))}</text>`);
    }
    parts.push('</svg>');
    return parts.join('');
  }

  return { lineChart };
});
