(function () {
  'use strict';

  var STORAGE_KEY = 'hash2dcam.v1';
  var RULES_KEY = 'hash2dcam.rules.v1';
  var PATTERNS_KEY = 'hash2dcam.patterns.v1';
  var savedRules = [];
  var savedPatterns = [];
  var saveKind = 'rule';
  var deleteKind = 'rule';
  var LIFE_KEY = CA.formatRule(CA.maskFromDigits('3'), CA.maskFromDigits('23'), 2, 0xff);

  var state = {
    birthMask: CA.maskFromDigits('3'),
    survivalMask: CA.maskFromDigits('23'),
    neighborhoodMask: CA.neighborhoodById('moore').mask,
    hexView: false,
    states: 2,
    flipX: false,
    flipY: false,
    xMode: 'cycle',
    yMode: 'cycle',
    speed: 12,
    density: 22,
    running: false,
  };

  var view = { x: 0, y: 0, cell: 8 };
  var userView = false;
  var sim = new CA.Simulator(140, 90);
  var dirty = true;
  var resetClock = false;
  var syncing = false;
  var saveTimer = 0;
  var pan = null;
  var paint = null;

  var canvas;
  var ctx;
  var stage;
  var genEl;
  var popEl;
  var hoverEl;
  var ruleNameEl;
  var presetSelect;
  var presetNote;
  var ruleInput;
  var ruleError;
  var describeEl;
  var playBtn;
  var birthChips;
  var survivalChips;
  var statesInput;
  var dyingLegend;
  var neighSeg;
  var neighGrid;
  var neighNote;
  var hexViewInput;
  var hexViewWrap;
  var xFlipInput;
  var yFlipInput;
  var xModeInput;
  var yModeInput;
  var speedInput;
  var speedOut;
  var patternSelect;
  var densityInput;
  var densityOut;
  var colsInput;
  var rowsInput;
  var copyBtn;
  var saveDialog;
  var saveForm;
  var saveNameInput;
  var saveError;
  var saveDialogRule;
  var saveDialogTitle;
  var saveDialogHint;
  var deleteRuleBtn;
  var deletePatternBtn;
  var deleteDialog;
  var deleteDialogTitle;
  var deleteDialogText;
  var patternNote;
  var patternError;
  var settingsEl;
  var settingsToggle;

  var SPEED_MIN = 12;
  var SPEED_MAX = 1200;
  var SPEED_STEPS = 1000;

  function sliderToSpeed(pos) {
    var t = Number(pos) / SPEED_STEPS;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return Math.round(SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, t));
  }

  function speedToSlider(speed) {
    var s = Number(speed);
    if (s < SPEED_MIN) s = SPEED_MIN;
    if (s > SPEED_MAX) s = SPEED_MAX;
    var t = Math.log(s / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
    return Math.round(t * SPEED_STEPS);
  }

  function clampInt(value, min, max) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) return min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function activeRule() {
    return {
      birthMask: state.birthMask,
      survivalMask: state.survivalMask,
      neighborhoodMask: state.neighborhoodMask,
      states: state.states,
      boundary: {
        flipX: state.flipX,
        flipY: state.flipY,
        xMode: state.xMode,
        yMode: state.yMode,
      },
    };
  }

  function maxNeighbors() {
    return CA.neighborhoodCount(state.neighborhoodMask);
  }

  function digitList(mask, maxN) {
    var out = [];
    for (var d = 0; d <= maxN; d++) {
      if ((mask >>> d) & 1) out.push(String(d));
    }
    return out;
  }

  function describeEdge() {
    var fx = state.flipX;
    var fy = state.flipY;
    var mx = state.xMode;
    var my = state.yMode;
    if (mx === 'cycle' && my === 'cycle' && !fx && !fy) return '左右、上下都直接连到对面，这是环面。';
    if (mx === 'cycle' && my === 'cycle' && fy && !fx) return '左右直接连到对面，上下连到对面时左右颠倒，这是克莱因瓶。';
    if (mx === 'cycle' && my === 'cycle' && fx && fy) return '从任一对边走出去，都会从对面回来，并且另一个方向颠倒，这是实射影平面。';
    if (mx === 'open' && my === 'open' && !fx && !fy) return '左右、上下的边界外都是 0。';
    function one(axis, flip, mode, other) {
      var text = mode === 'mirror'
        ? axis + '两边是镜面，走出去会折返'
        : mode === 'open'
          ? axis + '边界外是 0'
          : axis + '直接连到对面';
      if (flip) text += '，并且' + other + '颠倒';
      return text;
    }
    return one('左右', fx, mx, '上下') + '；' + one('上下', fy, my, '左右') + '。';
  }

  function describeRule() {
    var maxN = maxNeighbors();
    var birth = digitList(state.birthMask, maxN);
    var survival = digitList(state.survivalMask, maxN);
    var known = CA.matchNeighborhood(state.neighborhoodMask);
    var neigh = known ? known.summary : ('你勾选的 ' + maxN + ' 个格子');
    var edge = describeEdge();
    var birthText = birth.length
      ? '死细胞在活邻居为 ' + birth.join('、') + ' 个时变活'
      : '死细胞不会变活';
    var survivalText = survival.length
      ? '活细胞在活邻居为 ' + survival.join('、') + ' 个时继续活着'
      : '活细胞下一刻都会死去';
    var dormant = [];
    for (var d = maxN + 1; d <= 8; d++) {
      if (((state.birthMask | state.survivalMask) >>> d) & 1) dormant.push(String(d));
    }
    var extra = dormant.length ? ' 条件里的 ' + dormant.join('、') + ' 先留着，当前邻域最多 ' + maxN + ' 个邻居。' : '';
    var cycle = state.states <= 2
      ? '循环代数 C 是 2：只有死和活，活细胞不能存活就直接死去。'
      : '循环代数 C 是 ' + state.states + '：活细胞不能存活后进入衰老，衰老共 ' + (state.states - 2) + ' 代，然后回到死。只有活细胞计入邻居。';
    return '数邻居时看' + neigh + '。' + birthText + '；' + survivalText + '。' + edge + extra + cycle;
  }

  function fillChipRow(container, mask, maxN, onToggle) {
    container.innerHTML = '';
    for (var d = 0; d <= 8; d++) {
      var btn = document.createElement('button');
      btn.type = 'button';
      var on = ((mask >>> d) & 1) === 1;
      btn.className = 'chip' + (on ? ' on' : '');
      btn.textContent = String(d);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (d > maxN) {
        btn.disabled = true;
        btn.title = '当前邻域最多 ' + maxN + ' 个邻居';
      } else {
        btn.addEventListener('click', onToggle.bind(null, d));
      }
      container.appendChild(btn);
    }
  }

  function renderChips() {
    var maxN = maxNeighbors();
    fillChipRow(birthChips, state.birthMask, maxN, function (bit) {
      state.birthMask ^= 1 << bit;
      syncRuleUi();
      scheduleSave();
    });
    fillChipRow(survivalChips, state.survivalMask, maxN, function (bit) {
      state.survivalMask ^= 1 << bit;
      syncRuleUi();
      scheduleSave();
    });
  }

  function syncSeg(container, value) {
    var buttons = container.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-value') === value;
      buttons[i].classList.toggle('on', on);
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function edgeMode(mode) {
    if (mode === 'mirror' || mode === 'open' || mode === 'cycle') return mode;
    return 'cycle';
  }

  function syncEdgeUi() {
    if (!xFlipInput) return;
    xFlipInput.checked = !!state.flipX;
    yFlipInput.checked = !!state.flipY;
    xModeInput.value = edgeMode(state.xMode);
    yModeInput.value = edgeMode(state.yMode);
  }

  function setEdgeFlip(axis, on) {
    if (axis === 'x') state.flipX = !!on;
    else state.flipY = !!on;
    syncEdgeUi();
    describeEl.textContent = describeRule();
    scheduleSave();
  }

  function setEdgeMode(axis, mode) {
    mode = edgeMode(mode);
    if (axis === 'x') state.xMode = mode;
    else state.yMode = mode;
    syncEdgeUi();
    describeEl.textContent = describeRule();
    scheduleSave();
  }

  function setSettingsOpen(open) {
    var shown = !!open;
    document.body.classList.toggle('is-settings', shown);
    settingsEl.hidden = !shown;
    settingsToggle.setAttribute('aria-expanded', shown ? 'true' : 'false');
    settingsToggle.classList.toggle('on', shown);
  }

  function syncRuleUi() {
    renderChips();
    ruleInput.value = currentRuleText();
    if (statesInput.value !== String(state.states)) statesInput.value = String(state.states);
    dyingLegend.hidden = state.states <= 2;
    refreshDyingColors();
    ruleInput.classList.remove('invalid');
    ruleError.hidden = true;
    var saved = matchSavedRule();
    var preset = saved ? null : CA.matchPreset(state.birthMask, state.survivalMask, state.states, state.neighborhoodMask);
    var shown = saved || preset;
    syncing = true;
    presetSelect.value = saved ? ('saved:' + saved.id) : (preset ? preset.id : 'custom');
    syncing = false;
    presetNote.textContent = shown
      ? (shown.note || currentRuleText())
      : '这是自定义组合。点上面的数字改规则，或在输入框写 B3/S23/C2/N12345678 后应用。';
    describeEl.textContent = describeRule();
    ruleNameEl.textContent = shown ? shown.name : '自定义';
    document.title = 'HASH 2D-CAM · ' + ruleInput.value;
    if (deleteRuleBtn) deleteRuleBtn.hidden = !saved;
    renderNeighGrid();
    renderPatternOptions();
    // 规则/邻域/六角画法改完必须重画：六角棋盘只在 draw() 里判断画法有没有换过，
    // 不主动置脏的话，勾上复选框后要等下一次别的操作才会变成六角。
    dirty = true;
  }

  // ---- 六边形网格视图 -----------------------------------------------------
  // 把九宫格里的 6 个六角方向按「最近邻」落到六角形网格上：
  // 左上→西北、上→东北、左→正西、右→正东、下→西南、右下→东南。
  // 这样 6 个六角形正好围住中心，和九宫格那张图说的是同一套邻居。
  // （整张网旋转 30° 后邻居落在正东南西北 + 四个斜角上，主棋盘用的是同一套朝向。）
  var HEX_MASK = CA.neighborhoodById('hex').mask;
  var HEX_SIDE = 15;                            // 六角形外接圆半径（边长）
  var HEX_PITCH = Math.sqrt(3) * HEX_SIDE;      // 相邻两列的横向间距
  var HEX_ROWSTEP = 1.5 * HEX_SIDE;             // 相邻两行的纵向步进
  var SVG_NS = 'http://www.w3.org/2000/svg';
  // 每个邻居的落点，单位分别是 (横向列距, 纵向行步进)。数值就是掩码里的索引偏移：
  // bit0(−1,−1)→西北、bit1(0,−1)→东北、bit3(−1,0)→正西、
  // bit4(1,0)→正东、bit6(0,1)→西南、bit7(1,1)→东南。
  // 和主棋盘用的是同一套映射，所以两边画出来的邻接关系必然一致。
  var HEX_SLOTS = [
    { bit: 0, pc: -0.5, pr: -1 },
    { bit: 1, pc: 0.5, pr: -1 },
    { bit: 3, pc: -1, pr: 0 },
    { bit: 4, pc: 1, pr: 0 },
    { bit: 6, pc: -0.5, pr: 1 },
    { bit: 7, pc: 0.5, pr: 1 },
  ];

  function svgNode(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
      }
    }
    return node;
  }

  // 尖顶六角形（和主棋盘同一朝向，等价于平顶旋转 30°）：顶点落在上下，
  // 左右各是一条竖直边。i 取 0..5 给出六个顶点。
  function hexPoints(cx, cy) {
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var angle = Math.PI / 2 + (Math.PI / 3) * i;
      pts.push(
        (cx + HEX_SIDE * Math.cos(angle)).toFixed(2) + ',' +
        (cy + HEX_SIDE * Math.sin(angle)).toFixed(2)
      );
    }
    return pts.join(' ');
  }

  function renderNeighHexGrid(mask) {
    // 横向最远是正东/正西那两格（±1 个列距），纵向最远是东北/西南（±1 个行步进），
    // 两侧再各留半个身位（半宽 √3s/2、半高 s）。
    var width = 3 * HEX_PITCH;
    var height = 2 * HEX_ROWSTEP + 2 * HEX_SIDE;
    // 四周留白要盖住描边的一半（stroke-width 由 CSS 给，当前 2px），
    // 只留 2 会让顶点正好压在视口边上——描边一加粗就切掉角，所以给 3。
    var pad = 3;
    var cx = width / 2;
    var cy = height / 2;
    var svg = svgNode('svg', {
      'class': 'neigh-hex',
      width: width + pad * 2,
      height: height + pad * 2,
      viewBox: (-pad) + ' ' + (-pad) + ' ' + (width + pad * 2) + ' ' + (height + pad * 2),
      role: 'img',
      'aria-label': '六角邻域的六边形网格：中间一格是自己，周围六个六角形是邻居。'
    });

    var selfCell = svgNode('g', { 'class': 'hex-self' });
    selfCell.appendChild(svgNode('polygon', { points: hexPoints(cx, cy) }));
    var selfText = svgNode('text', { x: cx, y: cy });
    selfText.textContent = '自';
    selfCell.appendChild(selfText);
    svg.appendChild(selfCell);

    for (var i = 0; i < HEX_SLOTS.length; i++) {
      var slot = HEX_SLOTS[i];
      var on = ((mask >>> slot.bit) & 1) === 1;
      var name = CA.NEIGHBOR_NAMES[slot.bit];
      var cell = svgNode('g', { 'class': 'hex-cell' + (on ? ' on' : '') });
      var tip = svgNode('title');
      tip.textContent = name + (on ? '（算邻居）' : '（不算邻居）');
      cell.appendChild(tip);
      cell.appendChild(svgNode('polygon', {
        points: hexPoints(cx + slot.pc * HEX_PITCH, cy + slot.pr * HEX_ROWSTEP)
      }));
      svg.appendChild(cell);
    }
    return svg;
  }

  // ---- 棋盘也用六角画：整张网旋转 30°（平顶 → 尖顶）------------------------
  // 为什么角度只能是 30°、而且这一转不是美术选项：
  // 3×3 掩码里「同行」的 bit3/bit4 是 (±1,0)、「同列」的 bit1/bit6 是 (0,±1)，
  // 这 6 个索引方向必须两两共边。设格子按 (c,r) ↦ c·u + r·v 排布，6 个邻居的位移就是
  // ±u、±v、±(u+v)，要求三者等长且两两成 60°，解出来 u、v 只能等长且夹角 120°。
  // 这个解可以整体任意旋转——旋转不改变任何邻接关系，但会同时决定
  // 六角形的朝向和补丁包围盒的长宽比，而长宽比直接决定能放多大。
  //
  // 原来的排法是平顶：u = (1.5s, −√3s/2) 斜向、v = (0, √3s) 竖直，错位全堆在纵向上，
  // 补丁是个又高又窄的斜平行四边形（140×90 时 210s × 276s），塞进横屏画布只用到
  // 一半宽度，fit 出来的 cell 被高度死死卡在 5.13。把整张网绕原点转 +30° 之后：
  //   u → (√3s, 0)  正好水平，v → (−√3s/2, 1.5s)
  // 错位改在横向累积，补丁变成「上下边水平、左右边与竖直线成 60°」的横长平行四边形
  // （319s × 135s），fit 出的 cell 从 5.13 涨到 6.31，六角形边长 +23%——这就是
  // 「放得更大」的来源。而且最后一行（r = rows−1）所有格子的南顶点落在同一条水平线上，
  // 补丁的底边变成一条水平直线，与屏幕下边平行。
  //
  // 内核与 ca.js 仍然一个字没动，换的只是画法。
  //
  // 代价：补丁轮廓因此是个斜的平行四边形，且左右两条斜边在拓扑上是同一处接缝，
  // 从右绕回左会横向错开 0.5·(行数−1) 列——环形边界画在平面上，这是免不了的。

  // draw() 用它记住上一帧是不是六角棋盘，好判断「画法换了没有」。
  var layoutHex = null;

  function hexActive() {
    return !!state.hexView && (state.neighborhoodMask & 0xff) === HEX_MASK;
  }

  // 六角形边长（外接圆半径）。列距沿用方格时代的节奏：cell = 1.5·s。
  function hexSide(cell) { return cell / 1.5; }

  // 相邻两列的横向间距（旋转后的 u 向量） = √3·s
  function hexPitch(cell) { return Math.sqrt(3) * hexSide(cell); }

  // 相邻两行的纵向步进（旋转后的 v 向量在 y 上的分量） = 1.5·s = cell
  function hexRowStep(cell) { return 1.5 * hexSide(cell); }

  // 旋转 +30° 后的落点。u 落到正水平，v 落到 (−√3s/2, 1.5s)：
  //   X(c,r) = view.x + pitch·(c + (rows − r)/2)
  //   Y(c,r) = view.y + s + rowStep·r
  // 常数项是按「补丁外框正好落在 [view.x, +gridW] × [view.y, +gridH]」反推的。
  function hexCenterX(col, row) {
    return view.x + hexPitch(view.cell) * (col + 0.5 * (sim.rows - row));
  }

  function hexCenterY(col, row) {
    return view.y + hexSide(view.cell) + hexRowStep(view.cell) * row;
  }

  // 棋盘包围盒（与 view.cell 成正比，缩放时等比）。
  // 旋转后错位堆在横向，所以宽度里多出「半列 × 行数」这一项，纵向只剩行步进。
  function gridW(cell) {
    if (!hexActive()) return cell * sim.cols;
    var s = hexSide(cell);
    return Math.sqrt(3) * s * (sim.cols + 0.5 * (sim.rows - 1));
  }

  function gridH(cell) {
    if (!hexActive()) return cell * sim.rows;
    var s = hexSide(cell);
    return 1.5 * s * (sim.rows - 1) + 2 * s;
  }

  // 这块六角补丁的真实轮廓：顶边走 r=0 的锯齿、右边贴末列的竖直边、
  // 底边走末行的锯齿、左边沿首列收回来。相邻格子的顶点会自然重合，一条路径就够。
  // 旋转 30° 后「行」是水平的，所以顺序是从上到下、从右到左逐行拼。
  function hexPatchOutline() {
    var cell = view.cell;
    var s = hexSide(cell);
    var hw = hexPitch(cell) / 2;   // 六角形半宽 = √3·s/2
    var cols = sim.cols;
    var rows = sim.rows;
    var pts = [];
    var c, r, cx, cy;
    // 顶边（r = 0）：每格「北顶点 → 东北顶点」
    for (c = 0; c < cols; c++) {
      cx = hexCenterX(c, 0);
      cy = hexCenterY(c, 0);
      pts.push([cx, cy - s], [cx + hw, cy - s / 2]);
    }
    // 右边（末列）：每格一条竖直的东边
    for (r = 0; r < rows; r++) {
      cx = hexCenterX(cols - 1, r);
      cy = hexCenterY(cols - 1, r);
      pts.push([cx + hw, cy - s / 2], [cx + hw, cy + s / 2]);
    }
    // 底边（末行）：每格「东南顶点 → 南顶点 → 西南顶点」
    for (c = cols - 1; c >= 0; c--) {
      cx = hexCenterX(c, rows - 1);
      cy = hexCenterY(c, rows - 1);
      pts.push([cx + hw, cy + s / 2], [cx, cy + s], [cx - hw, cy + s / 2]);
    }
    // 左边（首列）：每格一条竖直的西边 + 斜的西北边，末点回到顶边起点
    for (r = rows - 1; r >= 0; r--) {
      cx = hexCenterX(0, r);
      cy = hexCenterY(0, r);
      pts.push([cx - hw, cy - s / 2], [cx, cy - s]);
    }
    return pts;
  }

  function tracePath(target, pts) {
    target.beginPath();
    target.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) target.lineTo(pts[i][0], pts[i][1]);
    target.closePath();
  }

  // 尖顶六角形的六个顶点（整张网旋转 30° 之后），直接写进给定路径
  function addHex(target, cx, cy, s) {
    var hw = Math.sqrt(3) * s / 2;
    target.moveTo(cx, cy - s);
    target.lineTo(cx + hw, cy - s / 2);
    target.lineTo(cx + hw, cy + s / 2);
    target.lineTo(cx, cy + s);
    target.lineTo(cx - hw, cy + s / 2);
    target.lineTo(cx - hw, cy - s / 2);
    target.closePath();
  }

  // 可见格子：旋转后错位落在「行」方向上——每往下一行，整行向左挪半列，
  // 首末行差 0.5·(行数−1) 列。所以可见的**列区间必须逐行算**，全图共用一个列窗口
  // 会把被剪切推出去的行整段漏掉（这张网刚改出来时就踩过：放大后棋盘只剩边框）。
  // 返回扁平数组 [行, 起始列, 结束列, ...]，比每帧造对象省事。
  function hexVisibleRows() {
    var cell = view.cell;
    var s = hexSide(cell);
    var pitch = hexPitch(cell);
    var step = hexRowStep(cell);
    var cw = canvas.clientWidth;
    var ch = canvas.clientHeight;
    var r0 = Math.max(0, Math.floor((-view.y - 2 * s) / step));
    var r1 = Math.min(sim.rows, Math.ceil((ch - view.y) / step) + 1);
    var out = [];
    for (var r = r0; r < r1; r++) {
      // 中心 cx = view.x + pitch·(c + off)，六角形左右各再伸 pitch/2
      var off = 0.5 * (sim.rows - r);
      var c0 = Math.max(0, Math.floor((-view.x) / pitch - off - 0.5));
      var c1 = Math.min(sim.cols, Math.ceil((cw - view.x) / pitch - off + 0.5) + 1);
      if (c1 > c0) out.push(r, c0, c1);
    }
    return out;
  }

  function eachHexCell(fn) {
    var vis = hexVisibleRows();
    var cols = sim.cols;
    for (var i = 0; i < vis.length; i += 3) {
      var r = vis[i];
      var cEnd = vis[i + 2];
      for (var c = vis[i + 1]; c < cEnd; c++) fn(c, r, r * cols + c);
    }
  }

  // 路径的落地代价几乎正比于「一条路径里塞了多少子路径」，所以批次必须开得很小。
  // 实测（140×90 全亮，含光栅化同步，单位 ms）：
  //   批次      8     16    32    64    128   256   700   不打批
  //   cell=5  7.1   6.4   8.1   10.0  22.3  32.7  55.8   1074
  //   cell=8  10.1  11.2  12.5  14.8  19.0  28.2  58.2   692
  //   描边(cell=5) 7.0 / 6.5 / 7.2 / 9.2 / 19.3 / 29.3 / — / —
  // 16 在各档都最优或只差 2%，而 cell=5 时同样数量的方格 fillRect 是 5.8ms——
  // 也就是说到 16 之后六角填充基本只剩方格的成本了。批次再大就白交钱。
  var HEX_PATH_CHUNK = 16;

  // 沿可见格子建六角路径，每 HEX_PATH_CHUNK 格就落地一次（mode 为 stroke 或 fill）。
  // pred 返回真才把这一格加进路径。返回是否真的画了东西。
  function hexBatch(target, s, pred, mode) {
    var n = 0;
    var drew = false;
    var commit = mode === 'stroke'
      ? function () { target.stroke(); }
      : function () { target.fill(); };
    target.beginPath();
    eachHexCell(function (c, r, i) {
      if (!pred(c, r, i)) return;
      addHex(target, hexCenterX(c, r), hexCenterY(c, r), s);
      if (++n >= HEX_PATH_CHUNK) { commit(); drew = true; n = 0; target.beginPath(); }
    });
    if (n) { commit(); drew = true; }
    return drew;
  }

  // ---- 静态层缓存 ---------------------------------------------------------
  // 底色、网格线、边框只跟「视图 + 格子尺寸」有关，跟细胞状态无关。六角网格一帧要描
  // 上万个 5~10px 的小六角形（cell=8 实测 388ms/帧），每帧重描必然卡死——这正是
  // 「放大会卡死」的原因。所以把它们烘到一张离屏画布，每帧只 drawImage 一次。
  //
  // 平移和缩放会改变几何，缓存随即作废。手势期间先只画底色和边框（几十微秒），
  // 等视图停稳 HEX_SETTLE_MS 之后再补上网格，免得边缩放边重烘。
  var hexScene = { canvas: null, ctx: null, key: '', ready: false, hasGrid: false, movedAt: 0 };
  var HEX_GRID_MIN_CELL = 8;
  var HEX_SETTLE_MS = 150;
  // 主循环只在本帧「脏」的时候才画。手势一停就没人再标脏，光靠 draw 里判断「静置够了没有」
  // 永远等不到补网格那一刻——棋盘会一直光着，直到用户碰一下别的东西。所以静置期间必须
  // 自己约一次重绘（黑盒测试就是在这儿抓到网格在高倍下整片消失的）。
  var hexGridTimer = 0;

  function hexSceneKey(cw, ch, dpr) {
    return view.cell + '|' + view.x + '|' + view.y + '|' + sim.cols + '|' + sim.rows + '|' + cw + '|' + ch + '|' + dpr;
  }

  // 把六角棋盘的静态部分画到 target（屏幕 ctx 或离屏 ctx，两者的变换必须一致）
  function paintHexStatic(target, withGrid) {
    var cell = view.cell;
    var s = hexSide(cell);
    target.fillStyle = '#101710';
    tracePath(target, hexPatchOutline());
    target.fill();
    if (withGrid) {
      target.strokeStyle = 'rgba(57, 255, 20, 0.14)';
      target.lineWidth = 1;
      hexBatch(target, s, function () { return true; }, 'stroke');
    }
    target.strokeStyle = 'rgba(57, 255, 20, 0.45)';
    target.lineWidth = 1;
    tracePath(target, hexPatchOutline());
    target.stroke();
  }

  function renderHexScene(cw, ch, dpr, withGrid) {
    var cv = hexScene.canvas;
    if (!cv) {
      cv = hexScene.canvas = document.createElement('canvas');
      hexScene.ctx = cv.getContext('2d');
    }
    var pw = Math.max(1, Math.round(cw * dpr));
    var ph = Math.max(1, Math.round(ch * dpr));
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
    }
    var g = hexScene.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, pw, ph);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    paintHexStatic(g, withGrid);
    hexScene.hasGrid = withGrid;
    hexScene.ready = true;
  }

  // cell < 1 时一格不到一个像素，矢量路径又慢又没意义，退回「一格一像素」的打包填充。
  // 关键是像素位置也必须走六角公式：错位一丢，图案就按方格的老样子排开，
  // 看上去正是「还是原先的格局，只有边框是斜的」。
  function drawCoarseHex(cw, ch) {
    var cell = view.cell;
    var s = hexSide(cell);
    var pitch = hexPitch(cell);
    var step = hexRowStep(cell);
    var px0 = Math.max(0, Math.floor(view.x));
    var py0 = Math.max(0, Math.floor(view.y));
    var px1 = Math.min(cw, Math.ceil(view.x + gridW(cell)));
    var py1 = Math.min(ch, Math.ceil(view.y + gridH(cell)));
    var pw = px1 - px0;
    var ph = py1 - py0;
    if (pw < 1 || ph < 1) return false;

    var pack = coarseBuffers(pw, ph);
    var rank = pack.rank;
    var age = pack.age;
    var curr = sim.curr;
    var prev = sim.prev;
    var cols = sim.cols;
    var vis = hexVisibleRows();
    var occupied = false;
    for (var k = 0; k < vis.length; k += 3) {
      var r = vis[k];
      var cys = view.y + s + step * r;
      var off = 0.5 * (sim.rows - r);
      var cEnd = vis[k + 2];
      for (var c = vis[k + 1]; c < cEnd; c++) {
        var src = r * cols + c;
        var v = curr[src];
        if (v === 0) continue;
        // 一格一像素，落点是六角形的外接框左上角
        var px = Math.floor(view.x + pitch * (c + off) - pitch / 2) - px0;
        var py = Math.floor(cys - s) - py0;
        if (px < 0 || px >= pw || py < 0 || py >= ph) continue;
        var pi = py * pw + px;
        var rnk = v === 1 ? (prev[src] === 1 ? 2 : 3) : 1;
        if (rnk > rank[pi] || (rnk === 1 && rank[pi] === 1 && v < age[pi])) {
          rank[pi] = rnk;
          age[pi] = v;
          occupied = true;
        }
      }
    }
    flushCoarse(pack, px0, py0, pw, ph);
    return occupied;
  }

  function renderNeighGrid() {
    var mask = state.neighborhoodMask & 0xff;
    var match = CA.matchNeighborhood(mask);
    var canHex = mask === HEX_MASK;
    var hexView = !!state.hexView && canHex;

    if (hexViewInput) {
      hexViewInput.disabled = !canHex;
      hexViewInput.checked = hexView;
    }
    if (hexViewWrap) {
      hexViewWrap.classList.toggle('is-disabled', !canHex);
      hexViewWrap.title = canHex
        ? '把 6 个邻居按六角形排开，和上面的九宫格是同一条规则的两种画法'
        : '只在六角（6）邻域下可用';
    }

    neighGrid.innerHTML = '';
    neighGrid.classList.toggle('hex-mode', hexView);

    if (hexView) {
      neighGrid.appendChild(renderNeighHexGrid(mask));
    } else {
      var slots = [0, 1, 2, 3, -1, 4, 5, 6, 7];
      for (var i = 0; i < slots.length; i++) {
        var bit = slots[i];
        if (bit < 0) {
          var selfCell = document.createElement('div');
          selfCell.className = 'neigh-self';
          selfCell.textContent = '自';
          selfCell.title = '这一格是细胞自己，不计入邻居';
          neighGrid.appendChild(selfCell);
          continue;
        }
        var on = ((mask >>> bit) & 1) === 1;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'neigh-cell' + (on ? ' on' : '');
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-label', CA.NEIGHBOR_NAMES[bit]);
        btn.title = CA.NEIGHBOR_NAMES[bit];
        btn.addEventListener('click', toggleNeighBit.bind(null, bit));
        neighGrid.appendChild(btn);
      }
    }

    syncSeg(neighSeg, match ? match.id : '');
    if (hexView) {
      neighNote.textContent = '六边形网格：中间一格是自己，周围 6 个六角形就是九宫格里点亮的 6 个方向，两种画法同一条规则。';
    } else {
      var count = CA.neighborhoodCount(mask);
      neighNote.textContent = match
        ? match.note
        : '自定义邻域，当前勾了 ' + count + ' 个格子。点亮的才算邻居。';
    }
  }

  function toggleNeighBit(bit) {
    state.neighborhoodMask = (state.neighborhoodMask ^ (1 << bit)) & 0xff;
    syncRuleUi();
    scheduleSave();
  }

  var dyingColors = [];
  var dyingRGB = [];
  var coarsePack = { canvas: null, ctx: null, image: null, rank: null, age: null };

  var FLUOR_GREEN = [57, 255, 20];
  var BORN_BLUE = [77, 184, 255];
  var BLOOD_RED = [46, 0, 8];

  function refreshDyingColors() {
    dyingColors = [];
    dyingRGB = [];
    var total = state.states;
    var steps = Math.max(0, total - 2);
    var denom = Math.max(1, steps - 1);
    for (var s = 2; s < total; s++) {
      var t = steps <= 1 ? 1 : (s - 2) / denom;
      var r = Math.round(FLUOR_GREEN[0] + (BLOOD_RED[0] - FLUOR_GREEN[0]) * t);
      var g = Math.round(FLUOR_GREEN[1] + (BLOOD_RED[1] - FLUOR_GREEN[1]) * t);
      var b = Math.round(FLUOR_GREEN[2] + (BLOOD_RED[2] - FLUOR_GREEN[2]) * t);
      dyingColors[s] = 'rgb(' + r + ',' + g + ',' + b + ')';
      dyingRGB[s] = [r, g, b];
    }
  }

  function setStates(value) {
    var next = clampInt(value, 2, 256);
    var prevC = state.states;
    state.states = next;
    if (next < prevC) {
      var curr = sim.curr;
      var older = sim.prev;
      for (var i = 0; i < curr.length; i++) {
        if (curr[i] >= next) curr[i] = 0;
        if (older[i] >= next) older[i] = 0;
      }
      sim.recount();
    }
    dirty = true;
    syncRuleUi();
    renderHud();
    scheduleSave();
  }

  function renderHud() {
    genEl.textContent = String(sim.gen);
    popEl.textContent = String(sim.pop);
    popEl.parentElement.title = state.states > 2 ? '只计算活细胞，衰老的不算' : '';
  }

  function setRunning(on) {
    state.running = !!on;
    document.body.classList.toggle('is-running', state.running);
    playBtn.textContent = state.running ? '暂停' : '运行';
    playBtn.classList.toggle('is-on', state.running);
    playBtn.setAttribute('aria-pressed', state.running ? 'true' : 'false');
    if (state.running) resetClock = true;
    else scheduleSave();
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 250);
  }

  function packCells(u8) {
    var parts = [];
    var step = 0x8000;
    for (var i = 0; i < u8.length; i += step) {
      parts.push(String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + step))));
    }
    return btoa(parts.join(''));
  }

  function unpackCells(encoded, target) {
    var bin = atob(encoded);
    if (bin.length !== target.length) return false;
    for (var i = 0; i < bin.length; i++) target[i] = bin.charCodeAt(i);
    return true;
  }

  function currentRuleText() {
    return CA.formatRule(state.birthMask, state.survivalMask, state.states, state.neighborhoodMask);
  }

  function sameRuleContent(a, b) {
    return (a.birthMask | 0) === (b.birthMask | 0)
      && (a.survivalMask | 0) === (b.survivalMask | 0)
      && CA.clampStates(a.states || 2) === CA.clampStates(b.states || 2)
      && CA.canonicalNeighborhood(a.neighborhoodMask) === CA.canonicalNeighborhood(b.neighborhoodMask);
  }

  function rulesFromList(parsed) {
    var list = [];
    if (!Array.isArray(parsed)) return list;
    for (var i = 0; i < parsed.length; i++) {
      if (parsed[i] && typeof parsed[i].name === 'string' && parsed[i].name && typeof parsed[i].birthMask === 'number') {
        parsed[i].neighborhoodMask = CA.canonicalNeighborhood(parsed[i].neighborhoodMask);
        parsed[i].states = CA.clampStates(parsed[i].states || 2);
        list.push(parsed[i]);
      }
    }
    return list;
  }

  function mergeSavedRules(primary, extra) {
    var list = primary.slice();
    for (var i = 0; i < extra.length; i++) {
      var rule = extra[i];
      var found = false;
      for (var j = 0; j < list.length; j++) {
        if (list[j].name === rule.name || sameRuleContent(list[j], rule)) {
          found = true;
          break;
        }
      }
      if (!found) list.push(rule);
    }
    return list;
  }

  function loadSavedRules() {
    var fromFile = [];
    var fileOk = false;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'data/saved-rules.json?t=' + Date.now(), false);
      xhr.send(null);
      if (!xhr.status || xhr.status === 200) {
        fromFile = rulesFromList(JSON.parse(xhr.responseText || '[]'));
        fileOk = true;
      }
    } catch (err) {
      fileOk = false;
    }
    var fromBrowser = [];
    try {
      var raw = localStorage.getItem(RULES_KEY);
      if (raw) fromBrowser = rulesFromList(JSON.parse(raw));
    } catch (err) {
      fromBrowser = [];
    }
    if (!fileOk) return fromBrowser;
    return mergeSavedRules(fromFile, fromBrowser);
  }

  function persistSavedRules() {
    var body = JSON.stringify(savedRules);
    try {
      localStorage.setItem(RULES_KEY, body);
    } catch (err) {
      // 浏览器存不下时，仍尝试写到本地文件。
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', 'data/saved-rules.json', false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(savedRules, null, 2) + '\n');
    } catch (err) {
      // 本地服务没开时，名单留在浏览器里。
    }
  }

  function matchSavedRule() {
    var nmask = state.neighborhoodMask & 0xff;
    var found = null;
    for (var i = 0; i < savedRules.length; i++) {
      var rule = savedRules[i];
      if ((rule.birthMask | 0) !== state.birthMask) continue;
      if ((rule.survivalMask | 0) !== state.survivalMask) continue;
      if (CA.clampStates(rule.states || 2) !== state.states) continue;
      if (CA.canonicalNeighborhood(rule.neighborhoodMask) !== CA.canonicalNeighborhood(nmask)) continue;
      found = rule;
    }
    return found;
  }

  function currentRuleKey() {
    return CA.formatRule(
      state.birthMask,
      state.survivalMask,
      state.states,
      CA.canonicalNeighborhood(state.neighborhoodMask)
    );
  }

  function patternCellsOf(pattern) {
    if (pattern.cells) return pattern.cells;
    var raw = CA.cellsOf(pattern);
    var cells = [];
    for (var i = 0; i < raw.length; i++) cells.push([raw[i][0], raw[i][1], raw[i][2] || 1]);
    return cells;
  }

  function patternSignature(cells) {
    var parts = [];
    for (var i = 0; i < cells.length; i++) {
      parts.push(cells[i][0] + ',' + cells[i][1] + ',' + (cells[i][2] || 1));
    }
    parts.sort();
    return parts.join(';');
  }

  function capturePatternCells() {
    var w = sim.cols;
    var h = sim.rows;
    var curr = sim.curr;
    var minX = w;
    var minY = h;
    var maxX = -1;
    var maxY = -1;
    var count = 0;
    var y;
    var x;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        if (!curr[y * w + x]) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        count += 1;
      }
    }
    if (!count) return { error: '棋盘上没有可保存的图案。' };
    if (count > 40000) return { error: '非空格子太多，先留一小块再保存。' };
    var cells = [];
    for (y = minY; y <= maxY; y++) {
      for (x = minX; x <= maxX; x++) {
        var v = curr[y * w + x];
        if (v) cells.push([x - minX, y - minY, v]);
      }
    }
    return { cells: cells };
  }

  function loadSavedPatterns() {
    try {
      var raw = localStorage.getItem(PATTERNS_KEY);
      if (raw == null) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      var list = [];
      for (var i = 0; i < parsed.length; i++) {
        var item = parsed[i];
        if (!item || typeof item.name !== 'string' || !item.name) continue;
        if (typeof item.ruleKey !== 'string' || !item.ruleKey) continue;
        if (!Array.isArray(item.cells) || !item.cells.length) continue;
        list.push(item);
      }
      return dedupeSavedPatterns(list);
    } catch (err) {
      return [];
    }
  }

  function persistSavedPatterns() {
    try {
      localStorage.setItem(PATTERNS_KEY, JSON.stringify(savedPatterns));
    } catch (err) {
      if (patternError) {
        patternError.hidden = false;
        patternError.textContent = '图案存不下，可能是太大了。';
      }
    }
  }

  function samePatternContent(a, b) {
    return a.ruleKey === b.ruleKey && patternSignature(a.cells) === patternSignature(b.cells);
  }

  function dedupeSavedPatterns(list) {
    var next = [];
    for (var i = 0; i < list.length; i++) {
      var pattern = list[i];
      var filtered = [];
      for (var j = 0; j < next.length; j++) {
        if (next[j].name === pattern.name || samePatternContent(next[j], pattern)) continue;
        filtered.push(next[j]);
      }
      filtered.push(pattern);
      next = filtered;
    }
    return next;
  }

  function savedPatternById(id) {
    for (var i = 0; i < savedPatterns.length; i++) {
      if (savedPatterns[i].id === id) return savedPatterns[i];
    }
    return null;
  }

  function renderPatternOptions() {
    if (!patternSelect) return;
    var key = currentRuleKey();
    var selected = patternSelect.value;
    patternSelect.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '放入图案…';
    patternSelect.appendChild(placeholder);
    var count = 0;
    var builtins = null;
    CA.PATTERNS.forEach(function (pattern) {
      if ((pattern.rule || LIFE_KEY) !== key) return;
      if (!builtins) {
        builtins = document.createElement('optgroup');
        builtins.label = '内置';
        patternSelect.appendChild(builtins);
      }
      var opt = document.createElement('option');
      opt.value = 'builtin:' + pattern.id;
      opt.textContent = pattern.name;
      builtins.appendChild(opt);
      count += 1;
    });
    var savedGroup = null;
    savedPatterns.forEach(function (pattern) {
      if (pattern.ruleKey !== key) return;
      if (!savedGroup) {
        savedGroup = document.createElement('optgroup');
        savedGroup.label = '已保存';
        patternSelect.appendChild(savedGroup);
      }
      var opt = document.createElement('option');
      opt.value = 'saved:' + pattern.id;
      opt.textContent = pattern.name;
      savedGroup.appendChild(opt);
      count += 1;
    });
    if (patternNote) {
      patternNote.textContent = count
        ? '只列出和当前规则一致的图案。'
        : '当前规则还没有图案。可以先在棋盘上画好，再保存。';
    }
    var still = false;
    for (var i = 0; i < patternSelect.options.length; i++) {
      if (patternSelect.options[i].value === selected) still = true;
    }
    patternSelect.value = still ? selected : '';
    var saved = null;
    if (patternSelect.value.indexOf('saved:') === 0) saved = savedPatternById(patternSelect.value.slice(6));
    if (deletePatternBtn) deletePatternBtn.hidden = !saved;
  }

  function savedRuleById(id) {
    for (var i = 0; i < savedRules.length; i++) {
      if (savedRules[i].id === id) return savedRules[i];
    }
    return null;
  }

  function renderPresetOptions() {
    presetSelect.innerHTML = '';
    var custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = '自定义';
    presetSelect.appendChild(custom);

    var builtinsLife = document.createElement('optgroup');
    builtinsLife.label = 'Life';
    var builtinsGen = document.createElement('optgroup');
    builtinsGen.label = 'Generations';
    CA.PRESETS.forEach(function (preset) {
      var opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.name;
      if (preset.group === 'gen') builtinsGen.appendChild(opt);
      else builtinsLife.appendChild(opt);
    });
    presetSelect.appendChild(builtinsLife);
    if (builtinsGen.childNodes.length) presetSelect.appendChild(builtinsGen);

    if (!savedRules.length) return;
    var savedGroup = document.createElement('optgroup');
    savedGroup.label = '已保存';
    savedRules.forEach(function (rule) {
      var opt = document.createElement('option');
      opt.value = 'saved:' + rule.id;
      opt.textContent = rule.name;
      savedGroup.appendChild(opt);
    });
    presetSelect.appendChild(savedGroup);
  }

  function openSaveDialog(kind) {
    saveKind = kind === 'pattern' ? 'pattern' : 'rule';
    saveNameInput.value = '';
    saveError.hidden = true;
    saveError.textContent = '';
    if (saveKind === 'pattern') {
      var captured = capturePatternCells();
      if (captured.error) {
        patternError.hidden = false;
        patternError.textContent = captured.error;
        return;
      }
      patternError.hidden = true;
      saveDialogTitle.textContent = '保存图案';
      saveDialogRule.textContent = currentRuleKey();
      saveDialogHint.textContent = '按当前规则保存棋盘上的非空区域。同一图案再保存不会多出一条，只会留下这次写的名字。';
      saveNameInput.placeholder = '给这个图案起个名字';
    } else {
      saveDialogTitle.textContent = '保存规则';
      saveDialogRule.textContent = currentRuleText();
      saveDialogHint.textContent = '同一套规则再保存不会多出一条，只会留下这次写的名字。';
      saveNameInput.placeholder = '给这条规则起个名字';
    }
    if (typeof saveDialog.showModal === 'function') saveDialog.showModal();
    else saveDialog.setAttribute('open', '');
    saveNameInput.focus();
  }

  function closeSaveDialog() {
    if (typeof saveDialog.close === 'function') saveDialog.close();
    else saveDialog.removeAttribute('open');
  }

  function confirmSaveRule() {
    var name = saveNameInput.value.replace(/^\s+|\s+$/g, '');
    if (!name) {
      saveError.hidden = false;
      saveError.textContent = '先写一个名字。';
      saveNameInput.focus();
      return;
    }
    if (saveKind === 'pattern') confirmSavePattern(name);
    else confirmSaveNamedRule(name);
  }

  function confirmSaveNamedRule(name) {
    var record = {
      id: 'u' + Date.now(),
      name: name,
      birthMask: state.birthMask,
      survivalMask: state.survivalMask,
      states: state.states,
      neighborhoodMask: CA.canonicalNeighborhood(state.neighborhoodMask),
      note: '已保存的规则 ' + currentRuleText() + '。',
    };
    var kept = null;
    var removed = 0;
    var next = [];
    for (var i = 0; i < savedRules.length; i++) {
      var rule = savedRules[i];
      if (rule.name === name || sameRuleContent(rule, record)) {
        if (sameRuleContent(rule, record)) kept = rule;
        removed += 1;
        continue;
      }
      next.push(rule);
    }
    if (kept && kept.name === name && removed === 1) {
      closeSaveDialog();
      return;
    }
    if (kept) record.id = kept.id;
    next.push(record);
    savedRules = next;
    persistSavedRules();
    renderPresetOptions();
    syncRuleUi();
    closeSaveDialog();
  }

  function confirmSavePattern(name) {
    var captured = capturePatternCells();
    if (captured.error) {
      saveError.hidden = false;
      saveError.textContent = captured.error;
      return;
    }
    var record = {
      id: 'p' + Date.now(),
      name: name,
      ruleKey: currentRuleKey(),
      cells: captured.cells,
    };
    var kept = null;
    var removed = 0;
    var next = [];
    for (var i = 0; i < savedPatterns.length; i++) {
      var pattern = savedPatterns[i];
      if (pattern.name === name || samePatternContent(pattern, record)) {
        if (samePatternContent(pattern, record)) kept = pattern;
        removed += 1;
        continue;
      }
      next.push(pattern);
    }
    if (kept && kept.name === name && removed === 1) {
      closeSaveDialog();
      return;
    }
    if (kept) record.id = kept.id;
    next.push(record);
    savedPatterns = next;
    persistSavedPatterns();
    renderPatternOptions();
    patternSelect.value = 'saved:' + record.id;
    if (deletePatternBtn) deletePatternBtn.hidden = false;
    closeSaveDialog();
  }

  function openDeleteDialog(kind) {
    deleteKind = kind === 'pattern' ? 'pattern' : 'rule';
    if (deleteKind === 'pattern') {
      var selected = patternSelect.value.indexOf('saved:') === 0 ? savedPatternById(patternSelect.value.slice(6)) : null;
      if (!selected) return;
      deleteDialogTitle.textContent = '删除图案';
      deleteDialogText.textContent = '从名单里去掉「' + selected.name + '」。棋盘上的图案还留着。';
    } else {
      var saved = matchSavedRule();
      if (!saved) return;
      deleteDialogTitle.textContent = '删除规则';
      deleteDialogText.textContent = '从名单里去掉「' + saved.name + '」。棋盘上的图案还留着。';
    }
    if (typeof deleteDialog.showModal === 'function') deleteDialog.showModal();
    else deleteDialog.setAttribute('open', '');
  }

  function closeDeleteDialog() {
    if (typeof deleteDialog.close === 'function') deleteDialog.close();
    else deleteDialog.removeAttribute('open');
  }

  function confirmDeleteRule() {
    if (deleteKind === 'pattern') {
      confirmDeletePattern();
      return;
    }
    var saved = matchSavedRule();
    closeDeleteDialog();
    if (!saved) return;
    var next = [];
    for (var i = 0; i < savedRules.length; i++) {
      if (savedRules[i].id !== saved.id) next.push(savedRules[i]);
    }
    if (next.length === savedRules.length) return;
    savedRules = next;
    persistSavedRules();
    renderPresetOptions();
    syncRuleUi();
  }

  function confirmDeletePattern() {
    var selected = patternSelect.value.indexOf('saved:') === 0 ? savedPatternById(patternSelect.value.slice(6)) : null;
    closeDeleteDialog();
    if (!selected) return;
    var next = [];
    for (var i = 0; i < savedPatterns.length; i++) {
      if (savedPatterns[i].id !== selected.id) next.push(savedPatterns[i]);
    }
    savedPatterns = next;
    persistSavedPatterns();
    renderPatternOptions();
  }

  function saveNow() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        cols: sim.cols,
        rows: sim.rows,
        gen: sim.gen,
        birthMask: state.birthMask,
        survivalMask: state.survivalMask,
        neighborhoodMask: state.neighborhoodMask & 0xff,
        hexView: state.hexView,
        states: state.states,
        cellsB64: packCells(sim.curr),
        flipX: state.flipX,
        flipY: state.flipY,
        xMode: state.xMode,
        yMode: state.yMode,
        speed: state.speed,
        density: state.density,
      }));
    } catch (err) {
      // 存储不可用时，这一局仍然留在内存里。
    }
  }

  function storedEdgeMode(data, axis) {
    var mode = axis === 'x' ? data.xMode : data.yMode;
    if (mode === 'mirror' || mode === 'open' || mode === 'cycle') return mode;
    if (axis === 'x' ? data.mirrorX : data.mirrorY) return 'mirror';
    if (data.boundary === 'dead' || data.wrap === false) return 'open';
    return 'cycle';
  }

  function tryLoad() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      var cols = clampInt(data.cols, 8, 4096);
      var rows = clampInt(data.rows, 8, 4096);
      var next = new CA.Simulator(cols, rows);
      state.birthMask = (data.birthMask | 0) & 0x1ff;
      state.survivalMask = (data.survivalMask | 0) & 0x1ff;
      if (typeof data.neighborhoodMask === 'number' && isFinite(data.neighborhoodMask)) {
        state.neighborhoodMask = data.neighborhoodMask & 0xff;
      } else {
        var savedNeigh = CA.neighborhoodById(data.neighborhood);
        state.neighborhoodMask = savedNeigh ? savedNeigh.mask : CA.neighborhoodById('moore').mask;
      }
      state.hexView = !!data.hexView;
      state.flipX = !!data.flipX;
      state.flipY = !!data.flipY;
      if (typeof data.flipX !== 'boolean' && typeof data.flipY !== 'boolean') {
        if (data.boundary === 'klein') state.flipY = true;
        else if (data.boundary === 'projective') {
          state.flipX = true;
          state.flipY = true;
        }
      }
      state.xMode = storedEdgeMode(data, 'x');
      state.yMode = storedEdgeMode(data, 'y');
      state.speed = clampInt(data.speed, 12, 1200);
      state.density = clampInt(data.density, 1, 100);
      state.states = clampInt(data.states || 2, 2, 256);
      var loaded = false;
      if (typeof data.cellsB64 === 'string' && unpackCells(data.cellsB64, next.curr)) loaded = true;
      else if (typeof data.cells === 'string' && data.cells.length === cols * rows) {
        for (var i = 0; i < data.cells.length; i++) {
          next.curr[i] = data.cells.charCodeAt(i) === 49 ? 1 : 0;
        }
        loaded = true;
      }
      if (loaded) {
        for (var j = 0; j < next.curr.length; j++) {
          if (next.curr[j] >= state.states) next.curr[j] = 0;
        }
        next.prev.set(next.curr);
        next.recount();
        var gen = data.gen | 0;
        next.gen = gen > 0 && gen < 1e9 ? gen : 0;
      }
      sim = next;
      return true;
    } catch (err) {
      return false;
    }
  }

  function placePattern(pattern, shouldFit) {
    var cells = patternCellsOf(pattern);
    var box = CA.bounds(cells);
    var margin = pattern.align === 'left' && sim.cols >= box.w + 4
      ? 2
      : Math.max(0, Math.floor((sim.cols - box.w) / 2));
    var ox = margin - box.minX;
    var oy = Math.floor((sim.rows - box.h) / 2) - box.minY;
    setRunning(false);
    sim.clear();
    sim.stamp(cells, ox, oy);
    if (shouldFit !== false) fitView();
    dirty = true;
    renderHud();
    scheduleSave();
  }

  function syncControlsFromState() {
    speedInput.value = String(speedToSlider(state.speed));
    speedOut.textContent = String(sliderToSpeed(speedInput.value));
    state.speed = sliderToSpeed(speedInput.value);
    densityInput.value = String(state.density);
    densityOut.textContent = String(state.density);
    colsInput.value = String(sim.cols);
    rowsInput.value = String(sim.rows);
    syncEdgeUi();
    syncRuleUi();
    renderHud();
  }

  function coarseBuffers(pw, ph) {
    var pack = coarsePack;
    if (!pack.canvas) {
      pack.canvas = document.createElement('canvas');
      pack.ctx = pack.canvas.getContext('2d', { willReadFrequently: true });
    }
    if (pack.canvas.width !== pw || pack.canvas.height !== ph) {
      pack.canvas.width = pw;
      pack.canvas.height = ph;
      pack.image = null;
    }
    if (!pack.image || pack.image.width !== pw || pack.image.height !== ph) {
      pack.image = pack.ctx.createImageData(pw, ph);
    } else {
      pack.image.data.fill(0);
    }
    var n = pw * ph;
    if (!pack.rank || pack.rank.length < n) {
      pack.rank = new Uint8Array(n);
      pack.age = new Uint8Array(n);
    }
    pack.rank.fill(0, 0, n);
    pack.age.fill(0, 0, n);
    return pack;
  }

  function drawCoarse(cw, ch) {
    var cell = view.cell;
    var x0 = Math.max(0, Math.floor(-view.x / cell));
    var y0 = Math.max(0, Math.floor(-view.y / cell));
    var x1 = Math.min(sim.cols, Math.ceil((cw - view.x) / cell));
    var y1 = Math.min(sim.rows, Math.ceil((ch - view.y) / cell));
    if (x1 <= x0 || y1 <= y0) return false;
    var px0 = Math.max(0, Math.floor(view.x + x0 * cell));
    var py0 = Math.max(0, Math.floor(view.y + y0 * cell));
    var px1 = Math.min(cw, Math.ceil(view.x + x1 * cell));
    var py1 = Math.min(ch, Math.ceil(view.y + y1 * cell));
    var pw = px1 - px0;
    var ph = py1 - py0;
    if (pw < 1 || ph < 1) return false;

    var pack = coarseBuffers(pw, ph);
    var rank = pack.rank;
    var age = pack.age;
    var curr = sim.curr;
    var prev = sim.prev;
    var cols = sim.cols;
    var occupied = false;
    for (var y = y0; y < y1; y++) {
      var py = Math.floor(view.y + y * cell) - py0;
      if (py < 0 || py >= ph) continue;
      var src = y * cols;
      var dst = py * pw;
      for (var x = x0; x < x1; x++) {
        var v = curr[src + x];
        if (v === 0) continue;
        var px = Math.floor(view.x + x * cell) - px0;
        if (px < 0 || px >= pw) continue;
        var pi = dst + px;
        var rnk = v === 1 ? (prev[src + x] === 1 ? 2 : 3) : 1;
        if (rnk > rank[pi] || (rnk === 1 && rank[pi] === 1 && v < age[pi])) {
          rank[pi] = rnk;
          age[pi] = v;
          occupied = true;
        }
      }
    }

    flushCoarse(pack, px0, py0, pw, ph);
    return occupied;
  }

  // 把打包好的单像素缓冲刷到画布上（方格与六角的粗粒度路径共用）
  function flushCoarse(pack, px0, py0, pw, ph) {
    var rank = pack.rank;
    var age = pack.age;
    var data = pack.image.data;
    var n = pw * ph;
    for (var i = 0; i < n; i++) {
      var rnk = rank[i];
      if (!rnk) continue;
      var rgb = rnk === 3 ? BORN_BLUE : rnk === 2 ? FLUOR_GREEN : dyingRGB[age[i]];
      if (!rgb) rgb = BLOOD_RED;
      var o = i * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
    pack.ctx.putImageData(pack.image, 0, 0);
    ctx.drawImage(pack.canvas, px0, py0, pw, ph);
  }

  function cellRect(x, y) {
    var x1 = Math.round(view.x + x * view.cell);
    var y1 = Math.round(view.y + y * view.cell);
    var x2 = Math.round(view.x + (x + 1) * view.cell);
    var y2 = Math.round(view.y + (y + 1) * view.cell);
    return [x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1)];
  }

  function draw() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cw = canvas.clientWidth;
    var ch = canvas.clientHeight;
    if (cw < 2 || ch < 2) return;
    var pw = Math.max(1, Math.round(cw * dpr));
    var ph = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    // 六角棋盘和方格棋盘连包围盒都不一样，画法一变就把视图重新摆一次。
    if (layoutHex === null) layoutHex = hexActive();
    else if (hexActive() !== layoutHex) {
      layoutHex = hexActive();
      fitView();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0c100c';
    ctx.fillRect(0, 0, cw, ch);

    var hex = hexActive();
    var gx = Math.round(view.x);
    var gy = Math.round(view.y);
    var gw = Math.round(view.x + gridW(view.cell)) - gx;
    var gh = Math.round(view.y + gridH(view.cell)) - gy;

    if (hex) {
      // 底色 / 网格 / 边框走静态层：视图没动就直接用缓存，只重画细胞。
      var sceneKey = hexSceneKey(cw, ch, dpr);
      var moved = sceneKey !== hexScene.key;
      var nowMs = performance.now();
      if (moved) {
        hexScene.key = sceneKey;
        hexScene.movedAt = nowMs;
      }
      var wantGrid = view.cell >= HEX_GRID_MIN_CELL && (nowMs - hexScene.movedAt) >= HEX_SETTLE_MS;
      if (!hexScene.ready || moved || wantGrid !== hexScene.hasGrid) {
        renderHexScene(cw, ch, dpr, wantGrid);
      }
      // 还差一点静置时间就够格补网格 → 约一次重绘把自己叫醒
      if (!hexScene.hasGrid && view.cell >= HEX_GRID_MIN_CELL && !wantGrid) {
        if (hexGridTimer) clearTimeout(hexGridTimer);
        hexGridTimer = setTimeout(function () {
          hexGridTimer = 0;
          dirty = true;
        }, Math.ceil(HEX_SETTLE_MS - (nowMs - hexScene.movedAt)) + 16);
      } else if (hexGridTimer && hexScene.hasGrid) {
        clearTimeout(hexGridTimer);
        hexGridTimer = 0;
      }
      ctx.drawImage(hexScene.canvas, 0, 0, cw, ch);
    } else {
      ctx.fillStyle = '#101710';
      ctx.fillRect(gx, gy, gw, gh);
    }

    var xStart, yStart, xEnd, yEnd;
    if (!hex) {
      xStart = Math.max(0, Math.floor(-view.x / view.cell));
      yStart = Math.max(0, Math.floor(-view.y / view.cell));
      xEnd = Math.min(sim.cols, Math.ceil((cw - view.x) / view.cell));
      yEnd = Math.min(sim.rows, Math.ceil((ch - view.y) / view.cell));
    }
    var curr = sim.curr;
    var prev = sim.prev;
    var w = sim.cols;

    var occupied = sim.pop > 0;
    if (hex && view.cell >= 1) {
      // 三遍：活了两代的、刚出生的、正在衰变的状态。每遍把同色格子分批攒进路径再填充，
      // 比一格一次 fill 快得多——六角形彼此不重叠，同一色分几批填也不会串色。
      // 底色、网格、边框已经在静态层里，这里只画细胞。
      var s = hexSide(view.cell);
      ctx.fillStyle = '#39ff14';
      hexBatch(ctx, s, function (c, r, i) {
        return curr[i] === 1 && prev[i] === 1;
      }, 'fill');

      ctx.fillStyle = '#4db8ff';
      hexBatch(ctx, s, function (c, r, i) {
        return curr[i] === 1 && prev[i] !== 1;
      }, 'fill');

      for (var hage = 2; hage < state.states; hage++) {
        ctx.fillStyle = dyingColors[hage];
        if (hexBatch(ctx, s, (function (age) {
          return function (c, r, i) { return curr[i] === age; };
        })(hage), 'fill')) occupied = true;
      }
    } else if (view.cell < 1) {
      var coarseDrew = hex ? drawCoarseHex(cw, ch) : drawCoarse(cw, ch);
      if (coarseDrew) occupied = true;
    } else {
    ctx.fillStyle = '#39ff14';
    for (var y = yStart; y < yEnd; y++) {
      var row = y * w;
      for (var x = xStart; x < xEnd; x++) {
        var i = row + x;
        if (curr[i] !== 1 || prev[i] !== 1) continue;
        var lived = cellRect(x, y);
        ctx.fillRect(lived[0], lived[1], lived[2], lived[3]);
      }
    }
    ctx.fillStyle = '#4db8ff';
    for (y = yStart; y < yEnd; y++) {
      row = y * w;
      for (x = xStart; x < xEnd; x++) {
        i = row + x;
        if (curr[i] !== 1 || prev[i] === 1) continue;
        var born = cellRect(x, y);
        ctx.fillRect(born[0], born[1], born[2], born[3]);
      }
    }
    for (var age = 2; age < state.states; age++) {
      ctx.fillStyle = dyingColors[age];
      var drew = false;
      for (y = yStart; y < yEnd; y++) {
        row = y * w;
        for (x = xStart; x < xEnd; x++) {
          if (curr[row + x] !== age) continue;
          var aged = cellRect(x, y);
          ctx.fillRect(aged[0], aged[1], aged[2], aged[3]);
          drew = true;
        }
      }
      if (drew) occupied = true;
    }

    if (view.cell >= 8) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(57, 255, 20, 0.14)';
      ctx.lineWidth = 1;
      for (x = xStart; x <= xEnd; x++) {
        var px = Math.round(view.x + x * view.cell) + 0.5;
        ctx.moveTo(px, Math.round(view.y + yStart * view.cell));
        ctx.lineTo(px, Math.round(view.y + yEnd * view.cell));
      }
      for (y = yStart; y <= yEnd; y++) {
        var py = Math.round(view.y + y * view.cell) + 0.5;
        ctx.moveTo(Math.round(view.x + xStart * view.cell), py);
        ctx.lineTo(Math.round(view.x + xEnd * view.cell), py);
      }
      ctx.stroke();
    }
    }

    if (!hex) {
      ctx.strokeStyle = 'rgba(57, 255, 20, 0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(gx + 0.5, gy + 0.5, Math.max(0, gw - 1), Math.max(0, gh - 1));
    }

    if (!occupied) {
      ctx.fillStyle = '#93a394';
      ctx.font = '14px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('棋盘是空的。可以绘制，或打开右上角的设置。', cw / 2, ch / 2);
    }
  }

  function clampView() {
    var cw = canvas.clientWidth;
    var ch = canvas.clientHeight;
    if (cw < 20 || ch < 20) return;
    var gw = gridW(view.cell);
    var gh = gridH(view.cell);
    var margin = 48;
    if (view.x > cw - margin) view.x = cw - margin;
    if (view.y > ch - margin) view.y = ch - margin;
    if (view.x + gw < margin) view.x = margin - gw;
    if (view.y + gh < margin) view.y = margin - gh;
  }

  function fitCellSize() {
    var cw = canvas.clientWidth;
    var ch = canvas.clientHeight;
    var pad = 28;
    var availW = Math.max(1, cw - pad * 2);
    var availH = Math.max(1, ch - pad * 2);
    // gridW / gridH 和 cell 成正比，取 cell = 1 量一遍就够了，方格和六角两种画法都能用。
    return Math.min(availW / gridW(1), availH / gridH(1));
  }

  function minCellSize() {
    var lo = fitCellSize() * 0.25;
    if (lo > 1) lo = 1;
    if (!(lo > 0) || lo < 1 / 8192) lo = 1 / 8192;
    return lo;
  }

  function fitView() {
    var cw = canvas.clientWidth;
    var ch = canvas.clientHeight;
    if (cw < 20 || ch < 20) return;
    var cell = fitCellSize();
    var lo = minCellSize();
    if (cell < lo) cell = lo;
    view.cell = cell;
    view.x = (cw - gridW(view.cell)) / 2;
    view.y = (ch - gridH(view.cell)) / 2;
    userView = false;
    dirty = true;
  }

  function zoomAt(px, py, factor) {
    var next = view.cell * factor;
    var lo = minCellSize();
    if (next < lo) next = lo;
    if (next > 40) next = 40;
    if (next === view.cell) return;
    var k = next / view.cell;
    view.x = px - (px - view.x) * k;
    view.y = py - (py - view.y) * k;
    view.cell = next;
    userView = true;
    clampView();
    dirty = true;
  }

  function cellFromPoint(px, py) {
    if (!hexActive()) {
      var x = Math.floor((px - view.x) / view.cell);
      var y = Math.floor((py - view.y) / view.cell);
      if (x < 0 || y < 0 || x >= sim.cols || y >= sim.rows) return null;
      return { x: x, y: y };
    }
    // 六角格天然就是「离哪个中心最近」——最近中心划分出来的正是六角形，
    // 所以不用按边分情况判断，只要在邻近 9 个候选里比距离就行。网格是斜的，
    // 先用连续坐标估个大概位置，误差不会超过一格。
    var s = hexSide(view.cell);
    var pitch = hexPitch(view.cell);
    var step = hexRowStep(view.cell);
    var rf = Math.round((py - view.y - s) / step);
    var best = null;
    var bestD = Infinity;
    for (var dr = -1; dr <= 1; dr++) {
      var r = rf + dr;
      if (r < 0 || r >= sim.rows) continue;
      var off = 0.5 * (sim.rows - r);
      var cf = Math.round((px - view.x) / pitch - off);
      for (var dc = -1; dc <= 1; dc++) {
        var c = cf + dc;
        if (c < 0 || c >= sim.cols) continue;
        var dx = px - hexCenterX(c, r);
        var dy = py - hexCenterY(c, r);
        var d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x: c, y: r };
        }
      }
    }
    // 「最近中心」只保证落在这张无限六角密排的某个格里，而棋盘只是其中一块斜的补丁。
    // 贴着斜边上下那几处锯齿缺口其实在补丁之外，最近中心却仍在界内，得再验一次
    // 「点是否真的在那个六角形里」，否则在棋盘外面点一下也会画到棋盘上去。
    if (!best) return null;
    var ax = Math.abs(px - hexCenterX(best.x, best.y));
    var ay = Math.abs(py - hexCenterY(best.x, best.y));
    // 尖顶六角形：|dy| ≤ s、|dx| ≤ √3s/2，两条斜边再切一刀
    if (ay > s + 0.01 || ax > pitch / 2 + 0.01) return null;
    if (ax * s + ay * pitch > s * pitch + 0.01) return null;
    return best;
  }

  function pointOf(event) {
    var rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function paintAt(event) {
    if (!paint) return;
    var p = pointOf(event);
    var cell = cellFromPoint(p.x, p.y);
    if (!cell) return;
    var key = cell.x + ',' + cell.y;
    if (paint.last === key) return;
    paint.last = key;
    if (sim.setCell(cell.x, cell.y, paint.value)) {
      dirty = true;
      popEl.textContent = String(sim.pop);
    }
  }

  function stepOnce() {
    setRunning(false);
    sim.step(activeRule());
    dirty = true;
    renderHud();
    scheduleSave();
  }

  function applyRuleFromInput() {
    var parsed = CA.parseRule(ruleInput.value);
    if (!parsed) {
      ruleInput.classList.add('invalid');
      ruleError.hidden = false;
      ruleError.textContent = '写成 B3/S23/C2/N12345678 这样。N 用 1 到 8 表示哪些格子算邻居，摩尔邻域是 N12345678。不写 N 时按摩尔邻域。';
      return;
    }
    state.birthMask = parsed.birthMask;
    state.survivalMask = parsed.survivalMask;
    state.neighborhoodMask = parsed.neighborhoodMask;
    setStates(parsed.states);
  }

  function applySize() {
    var cols = clampInt(colsInput.value, 8, 4096);
    var rows = clampInt(rowsInput.value, 8, 4096);
    colsInput.value = String(cols);
    rowsInput.value = String(rows);
    if (cols === sim.cols && rows === sim.rows) return;
    sim.resize(cols, rows);
    fitView();
    renderHud();
    scheduleSave();
  }

  function fillSelects() {
    renderPresetOptions();
    renderPatternOptions();
  }

  function bind() {
    playBtn.addEventListener('click', function () { setRunning(!state.running); });
    document.getElementById('step').addEventListener('click', stepOnce);
    document.getElementById('clear').addEventListener('click', function () {
      setRunning(false);
      sim.clear();
      dirty = true;
      renderHud();
      scheduleSave();
    });
    document.getElementById('random').addEventListener('click', function () {
      setRunning(false);
      sim.randomize(state.density / 100);
      dirty = true;
      renderHud();
      scheduleSave();
    });
    document.getElementById('invert').addEventListener('click', function () {
      sim.invert();
      dirty = true;
      renderHud();
      scheduleSave();
    });
    document.getElementById('fit').addEventListener('click', fitView);
    document.getElementById('applyRule').addEventListener('click', applyRuleFromInput);
    document.getElementById('applySize').addEventListener('click', applySize);
    document.getElementById('randomRule').addEventListener('click', function () {
      var maxN = maxNeighbors();
      var birth = 0;
      var survival = 0;
      for (var d = 0; d <= maxN; d++) {
        if (Math.random() < 0.28) birth |= 1 << d;
        if (Math.random() < 0.28) survival |= 1 << d;
      }
      if (birth === 0 && survival === 0) birth |= 1 << Math.min(3, maxN);
      state.birthMask = birth;
      state.survivalMask = survival;
      syncRuleUi();
      scheduleSave();
    });

    copyBtn.addEventListener('click', function () {
      var text = currentRuleText();
      var done = function () {
        copyBtn.textContent = '已复制';
        window.setTimeout(function () { copyBtn.textContent = '复制'; }, 1000);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {
          ruleInput.focus();
          ruleInput.select();
        });
      } else {
        ruleInput.focus();
        ruleInput.select();
      }
    });

    ruleInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyRuleFromInput();
      }
    });

    document.getElementById('saveRule').addEventListener('click', function () { openSaveDialog('rule'); });
    document.getElementById('savePattern').addEventListener('click', function () { openSaveDialog('pattern'); });
    document.getElementById('saveCancel').addEventListener('click', closeSaveDialog);
    document.getElementById('saveForm').addEventListener('submit', function (event) {
      event.preventDefault();
      confirmSaveRule();
    });
    deleteRuleBtn.addEventListener('click', function () { openDeleteDialog('rule'); });
    deletePatternBtn.addEventListener('click', function () { openDeleteDialog('pattern'); });
    document.getElementById('deleteCancel').addEventListener('click', closeDeleteDialog);
    document.getElementById('deleteForm').addEventListener('submit', function (event) {
      event.preventDefault();
      confirmDeleteRule();
    });

    presetSelect.addEventListener('change', function () {
      if (syncing) return;
      var value = presetSelect.value;
      if (value.indexOf('saved:') === 0) {
        var saved = savedRuleById(value.slice(6));
        if (!saved) return;
        state.birthMask = saved.birthMask & 0x1ff;
        state.survivalMask = saved.survivalMask & 0x1ff;
        state.neighborhoodMask = saved.neighborhoodMask & 0xff;
        setStates(saved.states || 2);
        return;
      }
      var preset = CA.presetById(value);
      if (!preset) return;
      state.birthMask = CA.maskFromDigits(preset.birth);
      state.survivalMask = CA.maskFromDigits(preset.survival);
      state.neighborhoodMask = CA.presetNeighborhood(preset);
      setStates(preset.states || 2);
    });

    patternSelect.addEventListener('change', function () {
      var value = patternSelect.value;
      renderPatternOptions();
      patternSelect.value = value;
      var pattern = null;
      if (value.indexOf('builtin:') === 0) pattern = CA.patternById(value.slice(8));
      else if (value.indexOf('saved:') === 0) pattern = savedPatternById(value.slice(6));
      if (pattern) placePattern(pattern);
      if (deletePatternBtn) deletePatternBtn.hidden = value.indexOf('saved:') !== 0;
    });

    neighSeg.addEventListener('click', function (event) {
      var btn = event.target.closest('button');
      if (!btn) return;
      var item = CA.neighborhoodById(btn.getAttribute('data-value'));
      if (!item) return;
      state.neighborhoodMask = item.mask;
      syncRuleUi();
      scheduleSave();
    });

    if (hexViewInput) {
      hexViewInput.addEventListener('change', function () {
        state.hexView = hexViewInput.checked;
        syncRuleUi();
        scheduleSave();
      });
    }

    xFlipInput.addEventListener('change', function () { setEdgeFlip('x', xFlipInput.checked); });
    yFlipInput.addEventListener('change', function () { setEdgeFlip('y', yFlipInput.checked); });
    xModeInput.addEventListener('change', function () { setEdgeMode('x', xModeInput.value); });
    yModeInput.addEventListener('change', function () { setEdgeMode('y', yModeInput.value); });

    settingsToggle.addEventListener('click', function () {
      setSettingsOpen(settingsEl.hidden);
    });
    settingsEl.addEventListener('click', function (event) {
      if (event.target === settingsEl || event.target.classList.contains('settings-grid')) setSettingsOpen(false);
    });

    speedInput.addEventListener('input', function () {
      state.speed = sliderToSpeed(speedInput.value);
      speedOut.textContent = String(state.speed);
      scheduleSave();
    });

    densityInput.addEventListener('input', function () {
      state.density = clampInt(densityInput.value, 1, 100);
      densityOut.textContent = String(state.density);
      scheduleSave();
    });

    colsInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') applySize();
    });
    rowsInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') applySize();
    });
    colsInput.addEventListener('wheel', function (event) { event.preventDefault(); }, { passive: false });
    rowsInput.addEventListener('wheel', function (event) { event.preventDefault(); }, { passive: false });
    statesInput.addEventListener('change', function () { setStates(statesInput.value); });
    statesInput.addEventListener('wheel', function (event) { event.preventDefault(); }, { passive: false });

    canvas.addEventListener('contextmenu', function (event) { event.preventDefault(); });
    canvas.addEventListener('mousedown', function (event) {
      if (event.button === 1) event.preventDefault();
    });
    canvas.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      if (event.button === 1 || event.altKey) {
        pan = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, id: event.pointerId };
        canvas.style.cursor = 'grabbing';
        return;
      }
      var p = pointOf(event);
      var cell = cellFromPoint(p.x, p.y);
      var value = 1;
      if (event.button === 2) value = 0;
      else if (cell && sim.getCell(cell.x, cell.y)) value = 0;
      paint = { value: value, last: '' };
      paintAt(event);
    });
    canvas.addEventListener('pointermove', function (event) {
      var p = pointOf(event);
      var cell = cellFromPoint(p.x, p.y);
      hoverEl.textContent = cell ? cell.x + ', ' + cell.y : '–';
      if (pan && event.pointerId === pan.id) {
        view.x = pan.vx + (event.clientX - pan.x);
        view.y = pan.vy + (event.clientY - pan.y);
        userView = true;
        clampView();
        dirty = true;
        return;
      }
      if (paint) paintAt(event);
      canvas.style.cursor = event.altKey ? 'grab' : 'crosshair';
    });
    canvas.addEventListener('pointerleave', function () {
      if (!paint && !pan) hoverEl.textContent = '–';
    });
    function endPointer(event) {
      if (pan && event.pointerId === pan.id) pan = null;
      if (paint) {
        paint = null;
        sim.recount();
        renderHud();
        scheduleSave();
      }
      canvas.style.cursor = 'crosshair';
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('wheel', function (event) {
      event.preventDefault();
      var p = pointOf(event);
      zoomAt(p.x, p.y, event.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    window.addEventListener('keydown', function (event) {
      if (saveDialog.open || deleteDialog.open) return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        if (event.repeat) return;
        setRunning(!state.running);
      } else if (event.key === 'n' || event.key === 'N' || event.key === '.') {
        event.preventDefault();
        stepOnce();
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        fitView();
      } else       if (event.key === 'Escape') {
        if (!settingsEl.hidden) {
          setSettingsOpen(false);
          return;
        }
        setRunning(false);
      }
    });

    window.addEventListener('beforeunload', saveNow);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') saveNow();
    });
    window.setInterval(function () {
      if (state.running) saveNow();
    }, 3000);

    var observer = new ResizeObserver(function () {
      if (!userView) fitView();
      else clampView();
      dirty = true;
    });
    observer.observe(stage);
  }

  function startLoop() {
    var last = performance.now();
    var acc = 0;
    function frame(now) {
      window.requestAnimationFrame(frame);
      if (resetClock) {
        acc = 0;
        resetClock = false;
        last = now;
      }
      var dt = Math.min(50, now - last);
      last = now;
      if (state.running) {
        acc += dt;
        var stepMs = 1000 / state.speed;
        var budget = Math.floor(acc / stepMs);
        if (budget > 262144) budget = 262144;
        if (budget > 0) {
          var done = sim.advance(budget, activeRule());
          acc -= done * stepMs;
          if (done < budget || acc < 0) acc = 0;
          dirty = true;
        }
      }
      if (dirty) {
        dirty = false;
        draw();
        renderHud();
      }
    }
    window.requestAnimationFrame(frame);
  }

  function init() {
    canvas = document.getElementById('board');
    ctx = canvas.getContext('2d');
    stage = document.getElementById('stage');
    genEl = document.getElementById('gen');
    popEl = document.getElementById('pop');
    hoverEl = document.getElementById('hover');
    ruleNameEl = document.getElementById('ruleName');
    presetSelect = document.getElementById('presetSelect');
    presetNote = document.getElementById('presetNote');
    ruleInput = document.getElementById('ruleInput');
    ruleError = document.getElementById('ruleError');
    describeEl = document.getElementById('describe');
    playBtn = document.getElementById('play');
    birthChips = document.getElementById('birthChips');
    survivalChips = document.getElementById('survivalChips');
    statesInput = document.getElementById('states');
    dyingLegend = document.getElementById('dyingLegend');
    neighSeg = document.getElementById('neighSeg');
    neighGrid = document.getElementById('neighGrid');
    neighNote = document.getElementById('neighNote');
    hexViewInput = document.getElementById('hexView');
    hexViewWrap = document.getElementById('hexViewWrap');
    xFlipInput = document.getElementById('xFlip');
    yFlipInput = document.getElementById('yFlip');
    xModeInput = document.getElementById('xMode');
    yModeInput = document.getElementById('yMode');
    speedInput = document.getElementById('speed');
    speedOut = document.getElementById('speedOut');
    patternSelect = document.getElementById('patternSelect');
    densityInput = document.getElementById('density');
    densityOut = document.getElementById('densityOut');
    colsInput = document.getElementById('cols');
    rowsInput = document.getElementById('rows');
    copyBtn = document.getElementById('copyRule');
    saveDialog = document.getElementById('saveDialog');
    saveForm = document.getElementById('saveForm');
    saveNameInput = document.getElementById('saveName');
    saveError = document.getElementById('saveError');
    saveDialogRule = document.getElementById('saveDialogRule');
    saveDialogTitle = document.getElementById('saveDialogTitle');
    saveDialogHint = document.getElementById('saveDialogHint');
    deleteRuleBtn = document.getElementById('deleteRule');
    deletePatternBtn = document.getElementById('deletePattern');
    deleteDialog = document.getElementById('deleteDialog');
    deleteDialogTitle = document.getElementById('deleteDialogTitle');
    deleteDialogText = document.getElementById('deleteDialogText');
    patternNote = document.getElementById('patternNote');
    patternError = document.getElementById('patternError');
    settingsEl = document.getElementById('settings');
    settingsToggle = document.getElementById('settingsToggle');

    savedRules = loadSavedRules();
    savedPatterns = loadSavedPatterns();
    fillSelects();
    bind();
    if (!tryLoad()) placePattern(CA.patternById('gun'), false);
    syncControlsFromState();
    setRunning(false);
    fitView();
    draw();
    renderHud();
    startLoop();
  }

  init();
})();
