// Webcam overlay shapes: Path2D in a w×h box, plus each shape's natural aspect ratio (null = camera's).
(function () {
  const poly = (pts, w, h) => {
    const p = new Path2D();
    pts.forEach(([x, y], i) => (i ? p.lineTo(x * w, y * h) : p.moveTo(x * w, y * h)));
    p.closePath();
    return p;
  };
  const star = (n, inner) => Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? inner : 0.5, a = -Math.PI / 2 + (i * Math.PI) / n;
    return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)];
  });
  const ngon = (n, rot) => Array.from({ length: n }, (_, i) => {
    const a = rot + (i * 2 * Math.PI) / n;
    return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
  });
  const rounded = (w, h, rf) => { const p = new Path2D(); p.roundRect(0, 0, w, h, Math.min(w, h) * rf); return p; };
  const ellipse = (w, h) => { const p = new Path2D(); p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); return p; };

  const SHAPES = {
    original: { aspect: null, path: (w, h) => { const p = new Path2D(); p.rect(0, 0, w, h); return p; } },
    rounded: { aspect: null, path: (w, h) => rounded(w, h, 0.12) },
    square: { aspect: 1, path: (w, h) => { const p = new Path2D(); p.rect(0, 0, w, h); return p; } },
    roundedSquare: { aspect: 1, path: (w, h) => rounded(w, h, 0.16) },
    rect43: { aspect: 4 / 3, path: (w, h) => { const p = new Path2D(); p.rect(0, 0, w, h); return p; } },
    roundedRect43: { aspect: 4 / 3, path: (w, h) => rounded(w, h, 0.12) },
    rect34: { aspect: 3 / 4, path: (w, h) => { const p = new Path2D(); p.rect(0, 0, w, h); return p; } },
    roundedRect34: { aspect: 3 / 4, path: (w, h) => rounded(w, h, 0.12) },
    circle: { aspect: 1, path: ellipse },
    ellipse43: { aspect: 4 / 3, path: ellipse },
    ellipse34: { aspect: 3 / 4, path: ellipse },
    star: { aspect: 1, path: (w, h) => poly(star(5, 0.2), w, h) },
    star10: { aspect: 1, path: (w, h) => poly(star(10, 0.38), w, h) },
    heart: {
      aspect: 1,
      path: (w, h) => {
        const p = new Path2D();
        p.moveTo(0.5 * w, 0.95 * h);
        p.bezierCurveTo(0.1 * w, 0.68 * h, -0.02 * w, 0.42 * h, 0.08 * w, 0.24 * h);
        p.bezierCurveTo(0.2 * w, 0.03 * h, 0.44 * w, 0.06 * h, 0.5 * w, 0.24 * h);
        p.bezierCurveTo(0.56 * w, 0.06 * h, 0.8 * w, 0.03 * h, 0.92 * w, 0.24 * h);
        p.bezierCurveTo(1.02 * w, 0.42 * h, 0.9 * w, 0.68 * h, 0.5 * w, 0.95 * h);
        p.closePath();
        return p;
      },
    },
    pentagon: { aspect: 1, path: (w, h) => poly(ngon(5, -Math.PI / 2), w, h) },
    hexagon: { aspect: 1, path: (w, h) => poly(ngon(6, -Math.PI / 2), w, h) },
    hexagonFlat: { aspect: 1, path: (w, h) => poly(ngon(6, 0), w, h) },
    archedTop: {
      aspect: 3 / 4,
      path: (w, h) => { const p = new Path2D(); p.moveTo(0, h); p.lineTo(0, w / 2); p.arc(w / 2, w / 2, w / 2, Math.PI, 0); p.lineTo(w, h); p.closePath(); return p; },
    },
    diamond: { aspect: 1, path: (w, h) => poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]], w, h) },
    clover: {
      aspect: 1,
      path: (w, h) => {
        const p = new Path2D();
        for (const [cx, cy] of [[0.5, 0.27], [0.73, 0.5], [0.5, 0.73], [0.27, 0.5]]) { p.moveTo((cx + 0.25) * w, cy * h); p.ellipse(cx * w, cy * h, 0.25 * w, 0.25 * h, 0, 0, Math.PI * 2); }
        p.rect(0.3 * w, 0.3 * h, 0.4 * w, 0.4 * h);
        return p;
      },
    },
    squircle: {
      aspect: 1,
      path: (w, h) => poly(Array.from({ length: 96 }, (_, i) => {
        const a = (i / 96) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        return [0.5 + 0.5 * Math.sign(c) * Math.abs(c) ** 0.5, 0.5 + 0.5 * Math.sign(s) * Math.abs(s) ** 0.5];
      }), w, h),
    },
  };

  const LABELS = {
    original: 'Original', rounded: 'Rounded', square: 'Square', roundedSquare: 'Rounded Square', rect43: 'Rectangle (4:3)',
    roundedRect43: 'Rounded Rectangle (4:3)', rect34: 'Rectangle (3:4)', roundedRect34: 'Rounded Rectangle (3:4)', circle: 'Circle',
    ellipse43: 'Ellipse (4:3)', ellipse34: 'Ellipse (3:4)', star: 'Star', star10: '10-Point Star', heart: 'Heart', pentagon: 'Pentagon',
    hexagon: 'Hexagon', hexagonFlat: 'Hexagon (Flat)', archedTop: 'Arched Top', diamond: 'Diamond', clover: 'Clover', squircle: 'Squircle',
  };

  const api = { SHAPES, LABELS };
  if (typeof module !== 'undefined') module.exports = api; else window.WebcamShapes = api;
})();
