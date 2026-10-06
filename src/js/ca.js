// 二维生命类元胞自动机（外总和规则）。浏览器页面和 Node 测试共用。
(function (factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CA = api;
})(function () {
  'use strict';

  function kernelBytes() {
    var b64 = typeof CA_KERNEL_B64 === 'string' ? CA_KERNEL_B64 : '';
    if (!b64 && typeof require === 'function') b64 = require('./kernel_wasm.js');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var kernelModule = new WebAssembly.Module(kernelBytes());
  var K = new WebAssembly.Instance(kernelModule).exports;
  var MODE = { cycle: 0, mirror: 1, open: 2 };

  function plane(id, which) {
    var n = (K.cam_cols(id) | 0) * (K.cam_rows(id) | 0);
    var ptr = (which === 'prev' ? K.cam_prev(id) : which === 'spare' ? K.cam_spare(id) : K.cam_curr(id)) | 0;
    return new Uint8Array(K.memory.buffer, ptr, n);
  }

  function readLocalJson(fileName) {
    var text;
    if (typeof require === 'function') {
      text = require('fs').readFileSync(require('path').join(__dirname, '..', 'data', fileName), 'utf8');
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'data/' + fileName + '?t=' + Date.now(), false);
      xhr.send(null);
      if (xhr.status && xhr.status !== 200) throw new Error('读取 data/' + fileName + ' 失败：' + xhr.status);
      text = xhr.responseText;
    }
    if (!text) throw new Error('data/' + fileName + ' 是空的');
    return JSON.parse(text);
  }

  var PRESETS = readLocalJson('presets.json');
  var PATTERNS = readLocalJson('patterns.json');

  function maskFromDigits(text) {
    var mask = 0;
    var src = String(text || '');
    for (var i = 0; i < src.length; i++) {
      var d = src.charCodeAt(i) - 48;
      if (d >= 0 && d <= 8) mask |= 1 << d;
    }
    return mask;
  }

  function formatMask(mask) {
    var out = '';
    for (var d = 0; d <= 8; d++) {
      if ((mask >>> d) & 1) out += String(d);
    }
    return out;
  }

  function clampStates(states) {
    var c = states | 0;
    if (c < 2) return 2;
    if (c > 256) return 256;
    return c;
  }

  // 邻域数字从 1 数到 8，对应 3×3 去掉中心后从左到右、从上到下：
  // 1 2 3
  // 4 · 5
  // 6 7 8
  function formatNeighborhood(mask) {
    var bits = mask == null ? 0xff : (mask & 0xff);
    var out = '';
    for (var i = 0; i < 8; i++) if ((bits >>> i) & 1) out += String(i + 1);
    return out;
  }

  function maskFromNeighborhoodText(text) {
    if (text == null) return 0xff;
    var mask = 0;
    for (var i = 0; i < text.length; i++) {
      var d = text.charCodeAt(i) - 48;
      if (d < 1 || d > 8) return null;
      mask |= 1 << (d - 1);
    }
    return mask;
  }

  // 顺时针转 90°：1→3，2→5，3→8，4→2，5→7，6→1，7→4，8→6。
  // 左右翻转：1↔3，4↔5，6↔8。
  var ROTATE_DIGIT_90 = [0, 3, 5, 8, 2, 7, 1, 4, 6];
  var MIRROR_DIGIT_H = [0, 3, 2, 1, 5, 4, 8, 7, 6];

  function permuteNeighborhood(mask, map) {
    var next = 0;
    var bits = mask & 0xff;
    for (var i = 0; i < 8; i++) {
      if ((bits >>> i) & 1) {
        var dest = map[i + 1];
        next |= 1 << (dest - 1);
      }
    }
    return next;
  }

  function rotateNeighborhood90(mask) {
    return permuteNeighborhood(mask, ROTATE_DIGIT_90);
  }

  function mirrorNeighborhood(mask) {
    return permuteNeighborhood(mask, MIRROR_DIGIT_H);
  }

  function canonicalNeighborhood(mask) {
    var seeds = [mask & 0xff, mirrorNeighborhood(mask)];
    var best = seeds[0];
    var bestText = formatNeighborhood(best);
    for (var s = 0; s < seeds.length; s++) {
      var cur = seeds[s];
      for (var turn = 0; turn < 4; turn++) {
        var text = formatNeighborhood(cur);
        if (text < bestText) {
          best = cur;
          bestText = text;
        }
        cur = rotateNeighborhood90(cur);
      }
    }
    return best;
  }

  function formatRule(birthMask, survivalMask, states, neighborhoodMask) {
    var nmask = neighborhoodMask == null ? 0xff : (neighborhoodMask & 0xff);
    return 'B' + formatMask(birthMask) + '/S' + formatMask(survivalMask) + '/C' + clampStates(states) + '/N' + formatNeighborhood(nmask);
  }

  function statesFromText(text) {
    if (text == null) return 2;
    var n = parseInt(text, 10);
    if (!(n >= 2 && n <= 256)) return null;
    return n;
  }

  function packParsed(birthText, survivalText, statesText, neighText) {
    var states = statesFromText(statesText);
    if (states == null) return null;
    var neighborhoodMask = maskFromNeighborhoodText(neighText);
    if (neighborhoodMask == null) return null;
    return {
      birthMask: maskFromDigits(birthText),
      survivalMask: maskFromDigits(survivalText),
      states: states,
      neighborhoodMask: neighborhoodMask,
    };
  }

  function parseRule(text) {
    var t = String(text || '').replace(/\s+/g, '').toUpperCase();
    var birthFirst = /^B([0-8]*)\/S([0-8]*)(?:\/C([0-9]+))?(?:\/N([1-8]*))?$/.exec(t);
    if (birthFirst) return packParsed(birthFirst[1], birthFirst[2], birthFirst[3], birthFirst[4]);
    var survivalFirst = /^S([0-8]*)\/B([0-8]*)(?:\/C([0-9]+))?(?:\/N([1-8]*))?$/.exec(t);
    if (survivalFirst) return packParsed(survivalFirst[2], survivalFirst[1], survivalFirst[3], survivalFirst[4]);
    return null;
  }

  // 3×3 邻域，中心不算。内部位序从 0 起，写进规则时改成 1–8：
  // 1 2 3
  // 4 · 5
  // 6 7 8
  var NEIGHBOR_OFFSETS = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];

  var NEIGHBOR_NAMES = ['左上', '上', '右上', '左', '右', '左下', '下', '右下'];

  function bitsOf() {
    var mask = 0;
    for (var i = 0; i < arguments.length; i++) mask |= 1 << arguments[i];
    return mask;
  }

  var VON_NEUMANN_MASK = bitsOf(1, 3, 4, 6);
  var NEIGHBORHOODS = [
    {
      id: 'moore',
      name: '摩尔（8）',
      mask: 0xff,
      summary: '周围 8 个格子',
      note: '周围 8 个格子都算邻居。',
    },
    {
      id: 'vonneumann',
      name: '冯·诺依曼（4）',
      mask: VON_NEUMANN_MASK,
      summary: '上下左右 4 个格子',
      note: '只算上下左右。',
    },
    {
      id: 'hex',
      name: '六角（6）',
      mask: VON_NEUMANN_MASK | bitsOf(0, 7),
      summary: '六角的 6 个格子',
      note: '上下左右，再加左上和右下，外轮廓是六边形。',
    },
  ];

  function neighborhoodById(id) {
    for (var i = 0; i < NEIGHBORHOODS.length; i++) {
      if (NEIGHBORHOODS[i].id === id) return NEIGHBORHOODS[i];
    }
    return null;
  }

  function neighborhoodCount(mask) {
    var n = 0;
    for (var i = 0; i < 8; i++) n += (mask >>> i) & 1;
    return n;
  }

  function matchNeighborhood(mask) {
    var bits = mask & 0xff;
    for (var i = 0; i < NEIGHBORHOODS.length; i++) {
      if (NEIGHBORHOODS[i].mask === bits) return NEIGHBORHOODS[i];
    }
    return null;
  }

  function maskFromRule(rule) {
    if (rule && typeof rule.neighborhoodMask === 'number') return rule.neighborhoodMask & 0xff;
    var found = neighborhoodById(rule && rule.neighborhood);
    if (found) return found.mask;
    return 0xff;
  }

  function cellsOf(pattern) {
    var rows = pattern.rows;
    var cells = [];
    for (var y = 0; y < rows.length; y++) {
      var line = rows[y];
      for (var x = 0; x < line.length; x++) {
        var ch = line.charAt(x);
        var state = 0;
        if (ch === 'O' || ch === 'o' || ch === '#' || ch === '*' || ch === 'A' || ch === 'a') state = 1;
        else if (ch >= 'B' && ch <= 'Z') state = ch.charCodeAt(0) - 64;
        else if (ch >= '1' && ch <= '9') state = ch.charCodeAt(0) - 48;
        if (state) cells.push([x, y, state]);
      }
    }
    return cells;
  }

  function bounds(cells) {
    if (!cells.length) return { minX: 0, minY: 0, maxX: -1, maxY: -1, w: 0, h: 0 };
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < cells.length; i++) {
      var x = cells[i][0];
      var y = cells[i][1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return null;
  }

  function patternById(id) {
    for (var i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i].id === id) return PATTERNS[i];
    }
    return null;
  }

  function presetNeighborhood(preset) {
    if (!preset) return 0xff;
    if (typeof preset.neighborhoodMask === 'number') return preset.neighborhoodMask & 0xff;
    var found = neighborhoodById(preset.neighborhood);
    if (found) return found.mask;
    return 0xff;
  }

  function matchPreset(birthMask, survivalMask, states, neighborhoodMask) {
    var c = states == null ? 2 : clampStates(states);
    var nmask = neighborhoodMask == null ? 0xff : (neighborhoodMask & 0xff);
    for (var i = 0; i < PRESETS.length; i++) {
      var preset = PRESETS[i];
      var presetStates = preset.states || 2;
      if (presetStates !== c) continue;
      if (presetNeighborhood(preset) !== nmask) continue;
      if (maskFromDigits(preset.birth) !== birthMask) continue;
      if (maskFromDigits(preset.survival) !== survivalMask) continue;
      return preset;
    }
    return null;
  }

  function Simulator(cols, rows) {
    if ((cols | 0) < 1 || (rows | 0) < 1) throw new Error('网格太小');
    this._id = K.cam_create(cols | 0, rows | 0) | 0;
    if (!this._id) throw new Error('内核无法分配网格');
  }

  function bindPlane(name, which) {
    Object.defineProperty(Simulator.prototype, name, {
      get: function () { return plane(this._id, which); },
    });
  }
  bindPlane('curr', 'curr');
  bindPlane('prev', 'prev');
  bindPlane('spare', 'spare');

  Object.defineProperty(Simulator.prototype, 'cols', {
    get: function () { return K.cam_cols(this._id) | 0; },
  });
  Object.defineProperty(Simulator.prototype, 'rows', {
    get: function () { return K.cam_rows(this._id) | 0; },
  });
  Object.defineProperty(Simulator.prototype, 'pop', {
    get: function () { return K.cam_pop(this._id) | 0; },
  });
  Object.defineProperty(Simulator.prototype, 'gen', {
    get: function () { return K.cam_gen(this._id) | 0; },
    set: function (value) { K.cam_set_gen(this._id, value | 0); },
  });

  Simulator.prototype.recount = function () {
    return K.cam_recount(this._id) | 0;
  };

  Simulator.prototype.clear = function () {
    K.cam_clear(this._id);
  };

  Simulator.prototype.getCell = function (x, y) {
    return K.cam_get(this._id, x | 0, y | 0) | 0;
  };

  Simulator.prototype.setCell = function (x, y, value) {
    return !!K.cam_set(this._id, x | 0, y | 0, value ? 1 : 0);
  };

  Simulator.prototype.stamp = function (cells, ox, oy) {
    var curr = this.curr;
    var w = this.cols;
    var h = this.rows;
    for (var i = 0; i < cells.length; i++) {
      var x = cells[i][0] + ox;
      var y = cells[i][1] + oy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      var v = cells[i].length > 2 ? (cells[i][2] | 0) : 1;
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      curr[y * w + x] = v;
    }
    this.recount();
  };

  Simulator.prototype.randomize = function (probability, rng) {
    if (rng) {
      var curr = this.curr;
      var p = probability;
      for (var i = 0; i < curr.length; i++) curr[i] = rng() < p ? 1 : 0;
      this.prev.fill(0);
      this.gen = 0;
      this.recount();
      return;
    }
    var ppm = Math.round(Number(probability) * 1000000);
    if (ppm < 0) ppm = 0;
    if (ppm > 1000000) ppm = 1000000;
    var seed = (Math.random() * 0x100000000) >>> 0;
    if (!seed) seed = 1;
    K.cam_randomize(this._id, ppm, seed);
  };

  Simulator.prototype.invert = function () {
    K.cam_invert(this._id);
  };

  Simulator.prototype.resize = function (cols, rows) {
    if (!K.cam_resize(this._id, cols | 0, rows | 0)) throw new Error('内核无法调整网格');
  };

  function normalizeBoundary(boundary) {
    if (typeof boundary === 'string') {
      if (boundary === 'dead') return { flipX: false, flipY: false, xMode: 'open', yMode: 'open' };
      if (boundary === 'klein') return { flipX: false, flipY: true, xMode: 'cycle', yMode: 'cycle' };
      if (boundary === 'projective') return { flipX: true, flipY: true, xMode: 'cycle', yMode: 'cycle' };
      return { flipX: false, flipY: false, xMode: 'cycle', yMode: 'cycle' };
    }
    var src = boundary || {};
    return {
      flipX: !!src.flipX,
      flipY: !!src.flipY,
      xMode: axisModeOf(src, 'x'),
      yMode: axisModeOf(src, 'y'),
    };
  }

  function axisModeOf(src, axis) {
    var mode = axis === 'x' ? src.xMode : src.yMode;
    if (mode === 'mirror' || mode === 'open' || mode === 'cycle') return mode;
    if (src.dead) return 'open';
    if (axis === 'x' ? src.mirrorX : src.mirrorY) return 'mirror';
    return 'cycle';
  }

  function boundaryOf(rule) {
    if (!rule) return normalizeBoundary('wrap');
    if (rule.boundary && typeof rule.boundary === 'object') return normalizeBoundary(rule.boundary);
    if (rule.xMode || rule.yMode || typeof rule.flipX === 'boolean' || typeof rule.flipY === 'boolean' || typeof rule.mirrorX === 'boolean' || typeof rule.mirrorY === 'boolean') {
      return normalizeBoundary(rule);
    }
    if (rule.boundary === 'wrap' || rule.boundary === 'dead' || rule.boundary === 'klein' || rule.boundary === 'projective') {
      return normalizeBoundary(rule.boundary);
    }
    return normalizeBoundary(rule.wrap === false ? 'dead' : 'wrap');
  }

  function locateNeighbor(xx, yy, w, h, boundary) {
    var spec = normalizeBoundary(boundary);
    return K.cam_locate(
      xx | 0,
      yy | 0,
      w | 0,
      h | 0,
      spec.flipX ? 1 : 0,
      spec.flipY ? 1 : 0,
      MODE[spec.xMode],
      MODE[spec.yMode]
    ) | 0;
  }

  // rule: { birthMask, survivalMask, neighborhoodMask, boundary, wrap }
  // neighborhood 字符串仍可用，方便旧调用。步进在 C++ 内核里完成。
  Simulator.prototype.step = function (rule) {
    var boundary = boundaryOf(rule);
    K.cam_step(
      this._id,
      rule.birthMask | 0,
      rule.survivalMask | 0,
      maskFromRule(rule),
      clampStates(rule && rule.states),
      boundary.flipX ? 1 : 0,
      boundary.flipY ? 1 : 0,
      MODE[boundary.xMode],
      MODE[boundary.yMode]
    );
  };

  Simulator.prototype.advance = function (steps, rule) {
    var n = steps | 0;
    if (n <= 1) {
      this.step(rule);
      return 1;
    }
    var boundary = boundaryOf(rule);
    var done = K.cam_run(
      this._id,
      n,
      rule.birthMask | 0,
      rule.survivalMask | 0,
      maskFromRule(rule),
      clampStates(rule && rule.states),
      boundary.flipX ? 1 : 0,
      boundary.flipY ? 1 : 0,
      MODE[boundary.xMode],
      MODE[boundary.yMode]
    ) | 0;
    if (done < 1) {
      this.step(rule);
      return 1;
    }
    return done;
  };

  return {
    PRESETS: PRESETS,
    PATTERNS: PATTERNS,
    Simulator: Simulator,
    maskFromDigits: maskFromDigits,
    formatMask: formatMask,
    formatRule: formatRule,
    formatNeighborhood: formatNeighborhood,
    rotateNeighborhood90: rotateNeighborhood90,
    canonicalNeighborhood: canonicalNeighborhood,
    mirrorNeighborhood: mirrorNeighborhood,
    boundaryOf: boundaryOf,
    locateNeighbor: locateNeighbor,
    maskFromNeighborhoodText: maskFromNeighborhoodText,
    presetNeighborhood: presetNeighborhood,
    parseRule: parseRule,
    cellsOf: cellsOf,
    bounds: bounds,
    presetById: presetById,
    patternById: patternById,
    matchPreset: matchPreset,
    NEIGHBOR_OFFSETS: NEIGHBOR_OFFSETS,
    NEIGHBOR_NAMES: NEIGHBOR_NAMES,
    NEIGHBORHOODS: NEIGHBORHOODS,
    neighborhoodById: neighborhoodById,
    neighborhoodCount: neighborhoodCount,
    matchNeighborhood: matchNeighborhood,
    maskFromRule: maskFromRule,
    clampStates: clampStates,
  };
});
