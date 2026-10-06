'use strict';

// 规则无关的规律模式检测库。
// 只吃「字节平面 + pop」，不 require ca.js，方便单独测试。
//
// 判定用的是「平移不变的规范化裁剪块」：把非空格子的包围盒切出来，
// 以包围盒左上角为原点重排。这样同一个结构平移之后签名不变，
// 签名相同但原点不同，就是平移结构；签名相同且原点相同，就是原地周期。

var zlib = require('zlib');

function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(bytes) {
  var h = 0x811c9dc5;
  for (var i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// 包围盒 + 以包围盒为原点的稠密副本。空盘返回 null。
function normalize(snap, cols, rows) {
  var x0 = cols;
  var y0 = rows;
  var x1 = -1;
  var y1 = -1;
  for (var y = 0; y < rows; y++) {
    var row = y * cols;
    for (var x = 0; x < cols; x++) {
      if (!snap[row + x]) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  var w = x1 - x0 + 1;
  var h = y1 - y0 + 1;
  var data = new Uint8Array(w * h);
  for (var yy = 0; yy < h; yy++) {
    var src = (y0 + yy) * cols + x0;
    data.set(snap.subarray(src, src + w), yy * w);
  }
  return { ox: x0, oy: y0, w: w, h: h, data: data };
}

function sameCrop(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function signature(crop) {
  var h = fnv1a(crop.data);
  h = Math.imul(h ^ crop.w, 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ crop.h, 0x85ebca6b) >>> 0;
  return h >>> 0;
}

// 秩序指标。三个都是启发式代理量，不是熵率。
//   compressibility  1 - |deflate(快照)| / |快照|     描述长度代理
//   blockOrder       1 - H(4x4 块的模式分布) / 16      块熵的补
//   lag1Order        相邻格状态相同的比例              空间相关
function orderMetrics(snap, cols, rows) {
  var raw = Buffer.from(snap.buffer, snap.byteOffset, snap.byteLength);
  var packed = zlib.deflateRawSync(raw, { level: 9 });
  var compressibility = snap.length ? 1 - packed.length / snap.length : 0;

  var counts = new Map();
  var total = 0;
  for (var by = 0; by + 4 <= rows; by += 4) {
    for (var bx = 0; bx + 4 <= cols; bx += 4) {
      var key = '';
      for (var k = 0; k < 4; k++) {
        var off = (by + k) * cols + bx;
        key += snap[off] + ',' + snap[off + 1] + ',' + snap[off + 2] + ',' + snap[off + 3] + ';';
      }
      counts.set(key, (counts.get(key) || 0) + 1);
      total += 1;
    }
  }
  var blockOrder = 1;
  if (total > 0) {
    var hsum = 0;
    counts.forEach(function (c) {
      var p = c / total;
      hsum -= p * (Math.log(p) / Math.LN2);
    });
    blockOrder = Math.max(0, 1 - hsum / 16);
  }

  var same = 0;
  var pairs = 0;
  for (var y = 0; y < rows; y++) {
    var row = y * cols;
    for (var x = 0; x + 1 < cols; x++) {
      pairs += 1;
      if (snap[row + x] === snap[row + x + 1]) same += 1;
    }
  }
  var lag1Order = pairs ? same / pairs : 0;

  return {
    compressibility: compressibility,
    blockOrder: blockOrder,
    lag1Order: lag1Order,
    order: (compressibility + blockOrder + lag1Order) / 3,
  };
}

// 判断一个「平移结构」是不是自平凡：把位移在包围盒内取模，
// 若取模后不是全零，且裁剪块在该位移下保持不变，说明这块图样本身就是周期性的，
// 位移是它的对称性而不是「飞走了」。这类命中记作退化，排名里降权。
//
// 取模后为 (0,0) 时无法判定：位移恰好是包围盒尺寸的整数倍，可能是真的飞过去一格
// （有限支撑的图样下一拍在原位置旁边重生），所以此时不判退化。
function degenerateShift(crop, dx, dy) {
  var w = crop.w;
  var h = crop.h;
  var mx = ((dx % w) + w) % w;
  var my = ((dy % h) + h) % h;
  if (mx === 0 && my === 0) return false;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (crop.data[y * w + x] !== crop.data[((y + my) % h) * w + ((x + mx) % w)]) return false;
    }
  }
  return true;
}

function Detector(opts) {
  this.cols = opts.cols;
  this.rows = opts.rows;
  this.periodMax = opts.periodMax;
  this.recent = new Map();
  this.result = null;
  this.boxSeries = [];
  this.popSeries = [];
}

Detector.prototype.observe = function (t, snap, pop) {
  if (this.result) return;
  this.popSeries.push(pop);
  if (pop === 0) {
    this.result = { kind: 'died', t: t, period: 0, dx: 0, dy: 0, touched: false };
    return;
  }
  var crop = normalize(snap, this.cols, this.rows);
  if (!crop) return;
  this.boxSeries.push(Math.max(crop.w, crop.h));

  var sig = signature(crop);
  var hit = this.recent.get(sig);
  if (hit && sameCrop(hit.data, crop.data)) {
    var dt = t - hit.t;
    if (dt >= 1 && dt <= this.periodMax) {
      var dx = crop.ox - hit.ox;
      var dy = crop.oy - hit.oy;
      // 绕过半个棋盘以上的位移只可能来自环绕，不是真的在滑行。
      var wrapped = Math.abs(dx) > this.cols / 2 || Math.abs(dy) > this.rows / 2;
      if (!wrapped) {
        var kind = 'oscillator';
        if (dx === 0 && dy === 0) kind = dt === 1 ? 'still' : 'oscillator';
        else kind = 'translator';
        this.result = {
          kind: kind,
          t: t,
          period: dt,
          dx: dx,
          dy: dy,
          touched: crop.ox === 0 || crop.oy === 0 || crop.ox + crop.w >= this.cols || crop.oy + crop.h >= this.rows,
          crop: crop,
        };
        return;
      }
    }
  }
  this.recent.set(sig, { t: t, ox: crop.ox, oy: crop.oy, data: crop.data });
  // 只留最近 periodMax 帧，避免长跑吃内存。
  var cutoff = t - this.periodMax;
  if (this.recent.size > this.periodMax * 2) {
    var self = this;
    this.recent.forEach(function (v, k) {
      if (v.t < cutoff) self.recent.delete(k);
    });
  }
};

// 没在 periodMax 内命中时，再分辨是「持续扩张」还是「混沌」。
// 判据：最近 24 帧的包围盒尺寸单调不减，且相对窗口最小值长了至少 3。
// 混沌盘的边缘会死掉，包围盒会有起伏，因此不会误判成扩张。
Detector.prototype.result_or_tail = function () {
  if (this.result) return this.result;
  var tail = this.boxSeries.slice(-24);
  var expanding = false;
  if (tail.length >= 8) {
    var monotone = true;
    var min = tail[0];
    for (var i = 1; i < tail.length; i++) {
      if (tail[i] < tail[i - 1]) monotone = false;
      if (tail[i] < min) min = tail[i];
    }
    expanding = monotone && tail[tail.length - 1] - min >= 3;
  }
  var pops = this.popSeries.slice(-24);
  var popStable = pops.length >= 8 && pops.every(function (v) { return v === pops[0]; });
  return {
    kind: expanding ? 'expanding' : 'chaotic',
    t: this.boxSeries.length,
    period: 0,
    dx: 0,
    dy: 0,
    touched: false,
    popStable: popStable,
  };
};

Detector.prototype.popStable = function () {
  var pops = this.popSeries.slice(-24);
  return pops.length >= 8 && pops.every(function (v) { return v === pops[0]; });
};

// 把裁剪块画成 ASCII。0 是 '.'，1 是 'O'，2..27 用 B..Z（与 ca.js 的 cellsOf 一致）。
// 超过 maxW x maxH 时按格子取「最大值」降采样，只用于肉眼预览，不用于回填图案。
function ascii(crop, maxW, maxH) {
  maxW = maxW || 48;
  maxH = maxH || 24;
  var w = crop.w;
  var h = crop.h;
  var sx = Math.max(1, Math.ceil(w / maxW));
  var sy = Math.max(1, Math.ceil(h / maxH));
  var out = [];
  for (var y = 0; y < h; y += sy) {
    var line = '';
    for (var x = 0; x < w; x += sx) {
      var best = 0;
      for (var dy = 0; dy < sy && y + dy < h; dy++) {
        for (var dx = 0; dx < sx && x + dx < w; dx++) {
          var v = crop.data[(y + dy) * w + x + dx];
          if (v > best) best = v;
        }
      }
      line += best === 0 ? '.' : (best === 1 ? 'O' : String.fromCharCode(64 + Math.min(best, 26)));
    }
    out.push(line);
  }
  return out;
}

// 把裁剪块写成 patterns.json 里 rows 能读的字符画（不回填给预览用）。
function rowsOf(crop) {
  var out = [];
  for (var y = 0; y < crop.h; y++) {
    var line = '';
    for (var x = 0; x < crop.w; x++) {
      var v = crop.data[y * crop.w + x];
      line += v === 0 ? '.' : (v === 1 ? 'O' : String.fromCharCode(64 + Math.min(v, 26)));
    }
    out.push(line);
  }
  return out;
}

module.exports = {
  mulberry32: mulberry32,
  normalize: normalize,
  signature: signature,
  orderMetrics: orderMetrics,
  degenerateShift: degenerateShift,
  Detector: Detector,
  ascii: ascii,
  rowsOf: rowsOf,
};
