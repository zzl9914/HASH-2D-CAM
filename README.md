# HASH 2D-CAM

二维元胞自动机实验台。仿真内核用 C++ 写成并编译为 WebAssembly，界面是一个纯静态页面——
没有构建步骤，没有依赖，起一个本地静态服务器就能跑。

支持任意半径 1 的外总和（outer-totalistic）规则、三种邻域、多状态「衰老」（Generations）、
可组合的边界拓扑，以及一个受限的 Hashlife 加速器。

## 特性

| 能力 | 说明 |
| --- | --- |
| 规则书写 | `B{诞生}/S{存活}/C{状态数}/N{邻域}`，`C` 与 `N` 可省略 |
| 邻域 | 摩尔 `N12345678`、冯·诺依曼 `N2457`、六角 `N124578`，或任意 8 位掩码 |
| 多状态 | `C` 取 2..256。`C>2` 时不能存活的活细胞进入衰老序列，逐代递增后归零 |
| 边界 | 每条轴可独立选 `cycle` / `mirror` / `open`，另有翻转开关，可组合出环面、克莱因瓶、实射影平面 |
| 加速 | 受限 Hashlife：图样在棋盘中部、四周留有空档时按 2 的幂跳代 |
| 规则同一性 | 保存时取 D4 八种对称里 `N` 字典序最小的一种作为规范形，避免同一条规则存成多份 |
| 图案库 | 预设与已保存规则放 JSON，每次打开页面重新读取，不依赖浏览器缓存 |
| 六角棋盘 | 设置里可把画布切成六角密排（尖顶朝向，底边与屏幕下边平行） |

## 快速开始

需要 **Node.js**（仅用于静态服务器与内核构建；页面本身不需要 Node）。

```bash
# Windows
start.bat

# 或手动起服务（默认端口 8732）
node src/tools/serve.js
```

浏览器会自动打开 `http://127.0.0.1:8732/`。可用环境变量覆盖：

- `PORT` —— 换端口。
- `CAM_OPEN=0` —— 只起服务，不自动开浏览器。

服务器同时接管 `PUT /data/saved-rules.json`，界面上保存的规则因此落盘到
`src/data/saved-rules.json`，而不是存在浏览器里。

## 目录结构

```text
.
├── start.bat                    # 一键启动（chcp 65001 + 起服务）
├── native/
│   └── ca_kernel.cpp            # 仿真内核（C++，编译为 wasm）
├── ref/
│   ├── rules.md                 # 全部预设的 λ / h(λ) / 有效位 / 邻域对称群
│   └── implementation.md        # 引擎算法：状态、邻域、边界、Hashlife
└── src/
    ├── index.html               # 界面
    ├── css/style.css
    ├── js/
    │   ├── kernel_wasm.js       # 由 build-kernel.js 生成，base64 内嵌 wasm，勿手改
    │   ├── ca.js                # 规则串解析、内存视图绑定
    │   └── main.js              # 画布、交互、设置面板
    ├── data/
    │   ├── presets.json         # 内置预设规则
    │   ├── patterns.json        # 内置图案库
    │   └── saved-rules.json     # 界面保存的规则
    └── tools/
        ├── serve.js             # 静态服务器 + saved-rules 写回
        └── build-kernel.js      # 编译 wasm 并内嵌为 base64
```

## 规则字符串

```text
B{诞生}/S{存活}/C{状态数}/N{邻域}
```

- `C` 省略按 `C2`；`N` 省略按摩尔邻域 `N12345678`。
- `S` 允许写在 `B` 前面。`N` 的数字须为 1..8，重复只保留一次。
- `C` 超出生效范围 2..256 时整串无效。

邻域编号从左到右、从上到下，中心不算：

```text
1 2 3
4 · 5
6 7 8
```

只有状态 `1` 算活邻居。`C>2` 时，活细胞不能存活会先变成状态 `2`，之后每代加一，
到 `C` 之前回到 `0`；这些衰老状态既不算邻居也不计入存活数。

## 边界与拓扑

宽、高各自有一个衔接方式和一个翻转开关，可同时打开：

| 衔接方式 | 语义 |
| --- | --- |
| `cycle` | 从这一对边走出去，从对面回来 |
| `mirror` | 坐标折返 |
| `open` | 界外读作 0，不计入活邻居 |

处理完本轴衔接后，翻转开关把另一轴变成 `n−1−坐标`。两个轴都循环：都不翻转是环面，
只翻转上下是克莱因瓶，都翻转是实射影平面。旧名字仍可读：`wrap` = 两轴循环、
`dead` = 两轴开放、`klein` = 两轴循环且只翻转上下、`projective` = 两轴循环且都翻转。

## Hashlife

内核里的 Hashlife 是 Gosper 算法在**有限网格、半径 1、外总和加 Generations** 上的受限版本，
不是 Golly 那种无限平面或环面上的完整跳代。满足以下条件才允许一次跳过 `T=2^j` 代：

1. 出生掩码不含 `B0`（否则空节点优化是错的）；
2. 网格至少 8×8，且四条边上没有非 0 格；
3. 非 0 格的包围盒边长 `P ≤ 2T`；
4. 取边长 `S=4T` 的方块能放进网格，并盖住包围盒四周各 `T` 格的空边。

不满足就退回逐步扫描，边界语义以逐步扫描为准。单步按钮始终走逐步扫描，不走跳代。
细节见 [`ref/implementation.md`](ref/implementation.md)。

## 重新编译内核

`src/js/kernel_wasm.js` 由 `native/ca_kernel.cpp` 生成，**改 C++ 不会自动生效**，需要重跑：

```bash
node src/tools/build-kernel.js
```

脚本调用 clang 以 `wasm32` 目标编译（`--target=wasm32 -O3 -nostdlib -ffreestanding`，
初始内存 2 MiB、上限 256 MiB），把产物 `src/js/ca_kernel.wasm` 读成 base64 内嵌进 JS。
需要带 wasm32 目标的 clang；路径可用环境变量 `CAM_CLANG` 覆盖。

## 文档

- [`ref/rules.md`](ref/rules.md) —— 全部预设规则，以及 λ、`h(λ)`、有效位、邻域对称群的定义与取值。
  表里每个数值都能按定义直接复算，不必另推公式。
- [`ref/implementation.md`](ref/implementation.md) —— 引擎算法：状态机、邻域与边界函数、
  逐步扫描、Hashlife 的节点与 `evolve`、规则规范形与保存格式。

## 说明

- `.workbuddy/` 下是本项目的工程技能 `skills/ca-pattern-hunter`（在选定规则下搜索
  静物 / 振荡子 / 平移结构 / 消亡 / 扩张 / 混沌）。本机 Agent 的会话日志不入库。
- 仓库暂未附带开源许可证。
