'use strict';

// 在选定规则下搜索「规律模式」。
//
// 用 HASH 2D-CAM 的 C++/WASM 内核做步进，对每一次试验逐代观察，
// 判断最终落入哪种吸引子：静物、振荡子、平移结构、消亡、持续扩张、混沌。
//
//   node hunt.js -r "B3/S23/C2/N12345678" -s 64x64 -n 240 --md report.md
//   node hunt.js -r life -m droplet -d 0.08,0.15,0.3
//   node hunt.js -r 火雨 --top 20 --emit-pattern found.json
//
// 平台约定（已实测，别改）：
//   * 内核只能创建 511 个 Simulator 且没有销毁接口 —— 全部试验复用同一个实例。
//   * cam_run 会让 WASM 内存增长，缓存的字节视图会静默失效 —— 一律 step() + 当帧复制。
//   * advance() 一次至多扫描 24 代，返回值可能小于请求值 —— 本程序不用它。

var fs = require('fs');
var path = require('path');

var detect = require(path.join(__dirname, 'detect.js'));

// ---------- 载入平台 ----------

function resolveRoot(explicit) {
  var candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.CA_ROOT) candidates.push(process.env.CA_ROOT);
  candidates.push('G:/Hash 2D-CAM');
  candidates.push(process.cwd());
  for (var i = 0; i < candidates.length; i++) {
    var p = path.resolve(candidates[i]);
    if (fs.existsSync(path.join(p, 'src', 'js', 'ca.js'))) return p;
  }
  throw new Error('找不到 src/js/ca.js。用 --root 指定 HASH 2D-CAM 仓库根目录。');
}

function loadCA(root) {
  return require(path.join(root, 'src', 'js', 'ca.js'));
}

// ---------- 参数 ----------

function parseArgs(argv) {
  var o = {
    rule: null,
    root: null,
    size: '64x64',
    trials: 240,
    maxGen: 300,
    periodMax: 40,
    densities: '0.06,0.12,0.22,0.35,0.5',
    seedMode: 'both',
    droplet: 8,
    fromPattern: null,
    seed: 20261007,
    boundary: 'open',
    flip: '',
    top: 12,
    out: null,
    md: null,
    emitPattern: null,
    quiet: false,
  };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    var next = function () { return argv[++i]; };
    if (a === '-r' || a === '--rule') o.rule = next();
    else if (a === '--root') o.root = next();
    else if (a === '-s' || a === '--size') o.size = next();
    else if (a === '-n' || a === '--trials') o.trials = parseInt(next(), 10);
    else if (a === '-g' || a === '--max-gen') o.maxGen = parseInt(next(), 10);
    else if (a === '-p' || a === '--period') o.periodMax = parseInt(next(), 10);
    else if (a === '-d' || a === '--densities') o.densities = next();
    else if (a === '-m' || a === '--seed-mode') o.seedMode = next();
    else if (a === '--droplet') o.droplet = parseInt(next(), 10);
    else if (a === '--from-pattern') o.fromPattern = next();
    else if (a === '--seed') o.seed = parseInt(next(), 10);
    else if (a === '--boundary') o.boundary = next();
    else if (a === '--flip') o.flip = next();
    else if (a === '--top') o.top = parseInt(next(), 10);
    else if (a === '--out') o.out = next();
    else if (a === '--md') o.md = next();
    else if (a === '--emit-pattern') o.emitPattern = next();
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error('未知参数 ' + a);
  }
  return o;
}

function usage() {
  return [
    'node hunt.js -r <规则> [选项]',
    '',
    '  -r, --rule        规则字符串 B/S/C/N，或预设 id / 名称（life、火雨…）',
    '      --root        仓库根目录（默认 env CA_ROOT 或 G:/Hash 2D-CAM）',
    '  -s, --size        WxH，默认 64x64',
    '  -n, --trials      试验总数，默认 240',
    '  -g, --max-gen     观察上限，默认 300',
    '  -p, --period      周期上限，默认 40',
    '  -d, --densities   随机密度列表，默认 0.06,0.12,0.22,0.35,0.5',
    '  -m, --seed-mode   field | droplet | both，默认 both',
    '      --droplet     液滴边长，默认 8',
    '      --from-pattern 用 patterns.json 里的图案做种子（按 id 或名称），只跑一次',
    '      --seed        随机种子，默认 20261007',
    '      --boundary    open | cycle | mirror | klein | projective，默认 open',
    '      --flip        x,y 翻转（配合 klein / projective 用）',
    '      --top         报告保留条数，默认 12',
    '      --out         JSON 输出路径',
    '      --md          Markdown 报告路径（省略则打到 stdout）',
    '      --emit-pattern 把最佳结果写成 patterns.json 片段',
  ].join('\n');
}

// ---------- 规则解析 ----------

function loadRuleTable(root, CA) {
  var table = {};
  function put(key, rule) {
    if (!key) return;
    table[String(key).toLowerCase()] = rule;
  }
  CA.PRESETS.forEach(function (p) {
    var r = {
      id: p.id,
      name: p.name,
      source: 'preset',
      birthMask: CA.maskFromDigits(p.birth),
      survivalMask: CA.maskFromDigits(p.survival),
      states: p.states || 2,
      neighborhoodMask: CA.presetNeighborhood(p),
    };
    put(p.id, r);
    put(p.name, r);
  });
  var savedPath = path.join(root, 'src', 'data', 'saved-rules.json');
  if (fs.existsSync(savedPath)) {
    JSON.parse(fs.readFileSync(savedPath, 'utf8')).forEach(function (r) {
      var item = {
        id: r.id,
        name: r.name,
        source: 'saved',
        birthMask: r.birthMask | 0,
        survivalMask: r.survivalMask | 0,
        states: r.states || 2,
        neighborhoodMask: r.neighborhoodMask & 0xff,
      };
      put(r.id, item);
      put(r.name, item);
    });
  }
  return table;
}

function resolveRule(text, table, CA) {
  if (!text) throw new Error('必须用 -r 指定规则');
  var hit = table[String(text).toLowerCase()];
  if (hit) return Object.assign({}, hit);
  var parsed = CA.parseRule(text);
  if (!parsed) throw new Error('无法解析规则：' + text + '（要 B/S/C/N 形式，或预设 id）');
  return Object.assign({ id: 'custom', name: text, source: 'parsed' }, parsed);
}

// ---------- 报告用的量（与 ref/rules.md 同一套定义）----------

function binom(n, k) {
  if (k < 0 || k > n) return 0;
  var r = 1;
  for (var i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

function ruleMetrics(rule, CA) {
  var m = CA.neighborhoodCount(rule.neighborhoodMask);
  var den = Math.pow(2, m + 1);
  var num = 0;
  var birth = [];
  var survival = [];
  for (var n = 0; n <= m; n++) {
    if ((rule.birthMask >> n) & 1) { birth.push(n); num += binom(m, n); }
  }
  for (var s = 0; s <= m; s++) {
    if ((rule.survivalMask >> s) & 1) { survival.push(s); if (rule.states <= 2) num += binom(m, s); }
  }
  if (rule.states > 2) num += Math.pow(2, m);
  var lambda = num / den;
  var h = lambda <= 0 || lambda >= 1 ? 0 : -lambda * (Math.log(lambda) / Math.LN2) - (1 - lambda) * (Math.log(1 - lambda) / Math.LN2);

  var seen = {};
  var orbit = 0;
  [rule.neighborhoodMask & 0xff, CA.mirrorNeighborhood(rule.neighborhoodMask & 0xff)].forEach(function (seed) {
    var c = seed;
    for (var t = 0; t < 4; t++) {
      if (!seen[c]) { seen[c] = 1; orbit += 1; }
      c = CA.rotateNeighborhood90(c);
    }
  });
  return {
    m: m,
    lambda: lambda,
    h: h,
    effective: birth.length + survival.length,
    effectiveDen: 2 * (m + 1),
    stabilizer: 8 / orbit,
    code: CA.formatRule(rule.birthMask, rule.survivalMask, rule.states, rule.neighborhoodMask),
  };
}

// ---------- 边界 ----------

function boundaryOpts(name, flip) {
  var fx = flip.indexOf('x') >= 0;
  var fy = flip.indexOf('y') >= 0;
  if (name === 'klein') return { boundary: 'klein' };
  if (name === 'projective') return { boundary: 'projective' };
  var mode = name === 'mirror' ? 'mirror' : (name === 'cycle' ? 'cycle' : 'open');
  return { xMode: mode, yMode: mode, flipX: fx, flipY: fy };
}

// ---------- 试验 ----------

var KIND_WEIGHT = {
  translator: 1.0,
  oscillator: 0.9,
  still: 0.5,
  expanding: 0.45,
  chaotic: 0.2,
  died: 0.1,
};

var KIND_LABEL = {
  translator: '平移结构',
  oscillator: '振荡子',
  still: '静物',
  expanding: '持续扩张',
  chaotic: '混沌',
  died: '消亡',
};

function deriveSeed(base, a, b) {
  var h = base >>> 0;
  h = Math.imul(h ^ (a + 0x9e3779b9), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (b + 0x7f4a7c15), 0xc2b2ae35) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) || 1;
}

function seedTrial(ctx, cols, rows, mode, density, salt, droplet) {
  var rng = detect.mulberry32(salt);
  ctx.sim.clear();
  if (mode === 'pattern') {
    var cells = ctx.patternCells;
    var box = ctx.CA.bounds(cells);
    var ox = Math.floor((cols - box.w) / 2) - box.minX;
    var oy = Math.floor((rows - box.h) / 2) - box.minY;
    ctx.sim.stamp(cells, ox, oy);
  } else if (mode === 'droplet') {
    var k = Math.min(droplet, cols, rows);
    var x0 = Math.floor((cols - k) / 2);
    var y0 = Math.floor((rows - k) / 2);
    var curr = ctx.sim.curr;
    if (curr.length !== cols * rows) throw new Error('字节视图失效，长度 ' + curr.length);
    for (var j = 0; j < k; j++) {
      for (var i = 0; i < k; i++) {
        curr[(y0 + j) * cols + x0 + i] = rng() < density ? 1 : 0;
      }
    }
    ctx.sim.recount();
  } else {
    ctx.sim.randomize(density, rng);
  }
  return rng;
}

function runTrial(ctx, combo, salt) {
  var sim = ctx.sim;
  var cols = ctx.cols;
  var rows = ctx.rows;
  seedTrial(ctx, cols, rows, combo.mode, combo.density, salt, ctx.droplet);

  var initialSnap = sim.curr.slice();
  var initialCrop = detect.normalize(initialSnap, cols, rows);
  var initialPop = sim.pop;

  var det = new detect.Detector({ cols: cols, rows: rows, periodMax: ctx.periodMax });
  det.observe(0, initialSnap, initialPop);

  var g = 0;
  while (g < ctx.maxGen && !det.result) {
    sim.step(ctx.stepRule);
    g += 1;
    var snap = sim.curr.slice();
    if (snap.length !== cols * rows) throw new Error('第 ' + g + ' 代字节视图失效');
    det.observe(g, snap, sim.pop);
  }

  var res = det.result_or_tail();
  var finalSnap = sim.curr.slice();
  var finalCrop = detect.normalize(finalSnap, cols, rows);
  var order = detect.orderMetrics(finalSnap, cols, rows);

  var subject = res.crop || finalCrop;
  var liveCount = 0;
  if (subject) {
    for (var k = 0; k < subject.data.length; k++) if (subject.data[k] === 1) liveCount += 1;
  }

  // 得分 = 类型权重 × 秩序项 × 体量项 × 周期项。
  // 体量项是为了不让三格闪烁器这种「极度可压缩的玩具」霸榜：它秩序满分但没什么内容。
  var substance = Math.min(1, liveCount / 40);
  var periodFactor = res.kind === 'oscillator' ? Math.min(1.15, 0.8 + 0.06 * res.period) : 1;
  var degenerate = res.kind === 'translator' && res.crop
    ? detect.degenerateShift(res.crop, res.dx, res.dy)
    : false;
  // 吸引子几乎占满棋盘时，它不是「找到的局部结构」，而是整盘作为一块在振荡/平移。
  // 含 B0 的规则几乎必然如此（空地不是不动点）。降权并标记。
  var spanning = subject ? (subject.w * 2 >= cols && subject.h * 2 >= rows) : false;
  var score = KIND_WEIGHT[res.kind] * (0.30 + 0.30 * order.order + 0.40 * substance) * periodFactor;
  if (degenerate) score *= 0.55;
  if (spanning) score *= 0.70;

  return {
    kind: res.kind,
    degenerate: degenerate,
    spanning: spanning,
    period: res.period,
    dx: res.dx,
    dy: res.dy,
    detectedAt: res.t,
    touched: !!res.touched,
    popStable: det.popStable(),
    gens: g,
    initialPop: initialPop,
    finalPop: sim.pop,
    mode: combo.mode,
    density: combo.density,
    salt: salt,
    order: order,
    liveCount: liveCount,
    substance: substance,
    score: score,
    subject: subject,
    initialCrop: initialCrop,
  };
}

function dedupeKey(f) {
  var s = f.subject ? detect.signature(f.subject) : 0;
  return [f.kind, f.period, f.dx, f.dy, s].join('|');
}

// ---------- 输出 ----------

function fmt(v, n) {
  return Number(v).toFixed(n == null ? 4 : n);
}

function findingsTable(findings) {
  var lines = [];
  lines.push('| # | 类型 | 周期 | 位移 | 判定代 | 初始密度 | 体量 | 秩序 | 得分 | 接触边界 |');
  lines.push('| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |');
  findings.forEach(function (f, i) {
    var disp = f.kind === 'translator' ? '(' + f.dx + ',' + f.dy + ')' + (f.degenerate ? 'ᵂ' : '') : '—';
    lines.push([
      String(i + 1),
      KIND_LABEL[f.kind],
      f.period ? String(f.period) : '—',
      disp,
      String(f.detectedAt),
      fmt(f.density, 3),
      String(f.liveCount) + (f.spanning ? 'ᵇ' : ''),
      fmt(f.order.order, 3),
      fmt(f.score, 3),
      f.touched ? '是' : '否',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  });
  return lines.join('\n');
}

function reproCommand(ctx, f) {
  var base = 'node hunt.js -r "' + ctx.metrics.code + '" -s ' + ctx.cols + 'x' + ctx.rows;
  if (f.mode === 'pattern') return base + ' --from-pattern ' + ctx.opts.fromPattern;
  return base + ' -m ' + f.mode + ' -d ' + fmt(f.density, 3) + ' --seed ' + ctx.opts.seed +
    ' --boundary ' + ctx.opts.boundary + ' -n ' + ctx.trialCount;
}

function buildMarkdown(ctx, findings, summary, order) {
  var m = ctx.metrics;
  var out = [];
  out.push('# 规律模式搜索报告');
  out.push('');
  out.push('规则 `' + m.code + '`' + (ctx.rule.name && ctx.rule.name !== 'custom' ? '（' + ctx.rule.name + '）' : ''));
  out.push('');
  out.push('| 项 | 值 |');
  out.push('| --- | --- |');
  out.push('| 邻域格数 | ' + m.m + ' |');
  out.push('| λ | ' + fmt(m.lambda) + ' |');
  out.push('| h(λ) | ' + fmt(m.h, 3) + ' |');
  out.push('| 有效位 | ' + m.effective + '/' + m.effectiveDen + ' |');
  out.push('| 邻域对称群 | ' + m.stabilizer + '/8 |');
  out.push('| 网格 | ' + ctx.cols + '×' + ctx.rows + ' |');
  out.push('| 边界 | ' + ctx.opts.boundary + (ctx.opts.flip ? ' +' + ctx.opts.flip + '翻转' : '') + ' |');
  out.push('| 观察上限 | ' + ctx.maxGen + ' 代／试验 |');
  out.push('| 试验数 | ' + ctx.trialCount + ' |');
  out.push('| 随机种子 | ' + ctx.opts.seed + ' |');
  out.push('');
  out.push('## 命中的吸引子分布');
  out.push('');
  out.push('| 类型 | 条数 | 占比 |');
  out.push('| --- | ---: | ---: |');
  Object.keys(summary).sort(function (a, b) { return summary[b] - summary[a]; }).forEach(function (k) {
    out.push('| ' + KIND_LABEL[k] + ' | ' + summary[k] + ' | ' + fmt(100 * summary[k] / ctx.trialCount, 1) + '% |');
  });
  out.push('');
  out.push('## 排名');
  out.push('');
  out.push(findingsTable(findings));
  out.push('');
  out.push('## 逐条明细');
  out.push('');
  findings.forEach(function (f, i) {
    out.push('### ' + (i + 1) + '. ' + KIND_LABEL[f.kind] +
      (f.period ? '，周期 ' + f.period : '') +
      (f.kind === 'translator' ? '，每周期位移 (' + f.dx + ',' + f.dy + ')' + (f.degenerate ? '（自平移对称，疑为行波）' : '') : ''));
    out.push('');
    out.push('判定于第 ' + f.detectedAt + ' 代；试验模式 `' + f.mode + '`，初始密度 ' + fmt(f.density, 3) +
      '，初始存活 ' + f.initialPop + '，终止存活 ' + f.finalPop + '，吸引子存活 ' + f.liveCount +
      (f.spanning ? '（**占满棋盘**，不是局部结构）' : '') +
      (f.popStable ? '，末 24 代存活数不变' : '') +
      (f.touched ? '，**判定时已接触边界**' : '') + '。');
    out.push('');
    out.push('秩序 ' + fmt(f.order.order, 3) + '（压缩率 ' + fmt(f.order.compressibility, 3) +
      '，块序 ' + fmt(f.order.blockOrder, 3) + '，邻接一致 ' + fmt(f.order.lag1Order, 3) + '）。');
    if (f.subject) {
      out.push('');
      out.push('吸引子形态：');
      out.push('');
      out.push('```text');
      detect.ascii(f.subject).forEach(function (l) { out.push(l); });
      out.push('```');
    }
    if (f.initialCrop && f.initialCrop.w <= 40 && f.initialCrop.h <= 40) {
      out.push('');
      out.push('初始构型：');
      out.push('');
      out.push('```text');
      detect.ascii(f.initialCrop).forEach(function (l) { out.push(l); });
      out.push('```');
    }
    out.push('');
    out.push('复现：`' + reproCommand(ctx, f) + '`（本次试验 salt=' + f.salt + '）');
    out.push('');
  });
  out.push('## 评分口径');
  out.push('');
  out.push('`得分 = 类型权重 × (0.30 + 0.30 × 秩序 + 0.40 × 体量) × 周期项`');
  out.push('');
  out.push('| 项 | 取值 |');
  out.push('| --- | --- |');
  out.push('| 类型权重 | 平移结构 1.0，振荡子 0.9，静物 0.5，扩张 0.45，混沌 0.2，消亡 0.1 |');
  out.push('| 秩序 | 压缩率、4×4 块序、水平邻接一致三项的算术平均 |');
  out.push('| 体量 | `min(1, 吸引子存活数 / 40)` |');
  out.push('| 周期项 | 振荡子取 `min(1.15, 0.8 + 0.06 × 周期)`，其余为 1 |');
  out.push('');
  out.push('体量项是必要的：三格闪烁器的秩序接近满分（压缩率 0.99），不加体量会霸榜，把有内容的发现挤下去。');
  out.push('');
  out.push('## 判读须知');
  out.push('');
  out.push('- 类型是**有限预算内的观察结果**，不是证明。`--max-gen` 之内没命中周期就归为混沌或扩张，加长观察可能改判。');
  out.push('- 秩序三项都是启发式代理：压缩率对稀疏图样天然偏高，块序把 4×4 块当作独立样本，邻接一致只看水平相邻。它们合起来用于排序，不是熵率。');
  out.push('- 默认边界 `open`（界外读作 0），避免环绕造成的假周期。要复现界面默认的环面，传 `--boundary cycle`，此时位移超过半个棋盘的命中会被丢弃，以防把绕行误判成滑行。');
  out.push('- `field` 模式填满整个网格，适合看规则整体的收敛倾向；`droplet` 模式只在中心放一小块，适合找孤立的静物、振荡子和飞船。');
  out.push('- **平移结构只有在整盘一起平移时才会被识别**。如果盘面上同时有飞出去的飞船和不动的碎片，整盘签名不再重复，该次试验会落到混沌或静物。要找飞船，用小液滴、低密度、大网格，或者用 `--from-pattern` 把已知飞船丢进去。');
  out.push('- 位移列带 `ᵂ` 的命中，是包围盒在位移下的自洽性检验判定为「图样自身就有这个平移对称」的，多半是行波而不是飞船，得分已乘 0.55。');
  out.push('- 体量列带 `ᵇ` 的命中，吸引子至少占满半个棋盘。它通常不是「找到了一块结构」，而是**整盘作为一块在振荡或平移**。得分已乘 0.70。');
  if (ctx.hasB0) {
    out.push('- **本规则含 `B0`**：六个（或八个）邻居全死时该格下一拍必定为活，空地不是不动点。' +
      '整盘会迅速被填满并大面积同步，`混沌` 占比因此天然偏高，命中也容易是 `ᵇ` 的整盘波。' +
      '要在这个规则里找局部结构，应该用很小的 `--droplet`、很低的密度，或者在含 `B0` 的规则上接受「没有局部结构」这个结论。');
  }
  out.push('- 判定接触边界（`接触边界 = 是`）的命中，其形态受边界条件影响，不能直接当作规则的内禀性质。');
  return out.join('\n');
}

function emitPatterns(findings, code, ruleName) {
  var entries = [];
  findings.forEach(function (f, i) {
    var crop = f.subject;
    // 上限 48：再大的图案在界面上既盖不下也看不清，而且多半是「整盘沉降后的集合」，
    // 不是可复用的结构。
    if (!crop || crop.w > 48 || crop.h > 48) return;
    if (f.spanning) return;            // 整盘波不是可投放的图案
    if ((f.kind === 'chaotic' && crop.w > 24) || f.kind === 'died') return;
    var slug = 'hunt-' + String(code).replace(/[^A-Za-z0-9]/g, '').slice(0, 16).toLowerCase() +
      '-' + f.kind.slice(0, 4) + (f.period ? '-p' + f.period : '') + '-' + (i + 1);
    entries.push({
      id: slug,
      name: (ruleName || code) + ' · ' + KIND_LABEL[f.kind] + (f.period ? ' 周期' + f.period : '') + ' #' + (i + 1),
      align: 'center',
      rows: detect.rowsOf(crop),
      rule: code,
    });
  });
  return entries;
}

// ---------- 主流程 ----------

function main() {
  var opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.rule) {
    console.log(usage());
    return;
  }

  var root = resolveRoot(opts.root);
  var CA = loadCA(root);
  var rule = resolveRule(opts.rule, loadRuleTable(root, CA), CA);

  var patternCells = null;
  if (opts.fromPattern) {
    var want = String(opts.fromPattern).toLowerCase();
    var pat = null;
    for (var pi = 0; pi < CA.PATTERNS.length; pi++) {
      var cand = CA.PATTERNS[pi];
      if (String(cand.id).toLowerCase() === want || String(cand.name).toLowerCase() === want) { pat = cand; break; }
    }
    if (!pat) throw new Error('patterns.json 里找不到「' + opts.fromPattern + '」');
    patternCells = CA.cellsOf(pat).map(function (c) { return [c[0], c[1], c[2] || 1]; });
    opts.seedMode = 'pattern';
  }

  var sizeMatch = /^(\d+)x(\d+)$/.exec(opts.size);
  if (!sizeMatch) throw new Error('--size 要写成 WxH，例如 64x64');
  var cols = parseInt(sizeMatch[1], 10);
  var rows = parseInt(sizeMatch[2], 10);
  if (cols < 8 || rows < 8) throw new Error('网格至少 8x8');

  // 出生掩码含 B0 时，空格不是不动点，检测仍然成立，只是排版更满。提示一句。
  var hasB0 = (rule.birthMask & 1) === 1;

  var bopts = boundaryOpts(opts.boundary, opts.flip);
  var stepRule = Object.assign({
    birthMask: rule.birthMask,
    survivalMask: rule.survivalMask,
    states: rule.states,
    neighborhoodMask: rule.neighborhoodMask,
  }, bopts);

  var sim = new CA.Simulator(cols, rows);
  var ctx = {
    sim: sim,
    CA: CA,
    patternCells: patternCells,
    hasB0: hasB0,
    rule: rule,
    cols: cols,
    rows: rows,
    maxGen: opts.maxGen,
    periodMax: opts.periodMax,
    droplet: opts.droplet,
    stepRule: stepRule,
    opts: opts,
    metrics: ruleMetrics(rule, CA),
    trialCount: 0,
  };

  var modes = opts.seedMode === 'both' ? ['field', 'droplet'] : [opts.seedMode];
  var densities = String(opts.densities).split(',').map(parseFloat).filter(function (v) { return v > 0 && v < 1; });
  if (!densities.length) throw new Error('--densities 里没有合法的 (0,1) 数值');
  if (opts.seedMode === 'pattern') {
    densities = [densities[0]];
    opts.trials = 1;
  }

  var combos = [];
  modes.forEach(function (m) { densities.forEach(function (d) { combos.push({ mode: m, density: d }); }); });
  var perCombo = Math.max(1, Math.round(opts.trials / combos.length));

  var started = Date.now();
  var all = [];
  var summary = {};
  combos.forEach(function (combo, ci) {
    for (var i = 0; i < perCombo; i++) {
      var salt = deriveSeed(opts.seed, ci + 1, i + 1);
      var f = runTrial(ctx, combo, salt);
      all.push(f);
      summary[f.kind] = (summary[f.kind] || 0) + 1;
      ctx.trialCount += 1;
    }
    if (!opts.quiet) process.stderr.write('.');
  });
  if (!opts.quiet) process.stderr.write('\n');

  var seen = {};
  var ranked = all.filter(function (f) {
    var k = dedupeKey(f);
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  }).sort(function (a, b) { return b.score - a.score; });

  var top = ranked.slice(0, opts.top);

  console.log(buildMarkdown(ctx, top, summary, all.length));
  console.log('\n试验 ' + ctx.trialCount + ' 次，去重后不同吸引子 ' + ranked.length +
    ' 个，用时 ' + (Date.now() - started) + ' ms' + (hasB0 ? '（该规则含 B0，空地不是不动点）' : ''));

  if (opts.md) {
    fs.writeFileSync(opts.md, buildMarkdown(ctx, top, summary, all.length) + '\n', 'utf8');
    console.log('报告已写入 ' + opts.md);
  }
  if (opts.out) {
    var payload = {
      rule: ctx.metrics.code,
      ruleName: rule.name,
      grid: { cols: cols, rows: rows },
      boundary: opts.boundary,
      seed: opts.seed,
      trials: ctx.trialCount,
      summary: summary,
      findings: ranked.map(function (f) {
        return {
          kind: f.kind,
          degenerate: f.degenerate,
          spanning: f.spanning,
          period: f.period,
          dx: f.dx,
          dy: f.dy,
          detectedAt: f.detectedAt,
          touched: f.touched,
          popStable: f.popStable,
          mode: f.mode,
          density: f.density,
          salt: f.salt,
          initialPop: f.initialPop,
          finalPop: f.finalPop,
          order: f.order,
          score: f.score,
          liveCount: f.liveCount,
          substance: f.substance,
          rows: f.subject ? detect.rowsOf(f.subject) : null,
        };
      }),
    };
    fs.writeFileSync(opts.out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log('JSON 已写入 ' + opts.out);
  }
  if (opts.emitPattern) {
    var entries = emitPatterns(top, ctx.metrics.code, rule.name);
    fs.writeFileSync(opts.emitPattern, JSON.stringify(entries, null, 2) + '\n', 'utf8');
    console.log('图案片段已写入 ' + opts.emitPattern + '（' + entries.length + ' 条，可并入 src/data/patterns.json）');
  }
}

try {
  main();
} catch (err) {
  console.error('错误：' + err.message);
  process.exit(1);
}
