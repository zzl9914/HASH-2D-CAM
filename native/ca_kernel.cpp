// 元胞自动机步进内核。邻域只有 ±1，内部格子直接取邻居，边上才做镜面 / 开放 / 循环。
#include <stdint.h>
#include <stddef.h>

enum {
  MODE_CYCLE = 0,
  MODE_MIRROR = 1,
  MODE_OPEN = 2
};

static const int DX[8] = {-1, 0, 1, -1, 1, -1, 0, 1};
static const int DY[8] = {-1, -1, -1, 0, 0, 1, 1, 1};

struct Sim {
  int32_t cols;
  int32_t rows;
  int32_t gen;
  int32_t pop;
  uint8_t* curr;
  uint8_t* prev;
  uint8_t* spare;
};

enum { SLOT_CAP = 512 };

static Sim g_slots[SLOT_CAP];
static int g_used = 1;

extern "C" {
extern unsigned char __heap_base;
}

static uint8_t* g_top = 0;

struct FreeBlock {
  uint8_t* ptr;
  uint32_t size;
  FreeBlock* next;
};

static FreeBlock* g_free = 0;

extern "C" void* memset(void* dst, int value, size_t n) {
  uint8_t* p = (uint8_t*)dst;
  for (size_t i = 0; i < n; i++) p[i] = (uint8_t)value;
  return dst;
}

extern "C" void* memcpy(void* dst, const void* src, size_t n) {
  uint8_t* d = (uint8_t*)dst;
  const uint8_t* s = (const uint8_t*)src;
  for (size_t i = 0; i < n; i++) d[i] = s[i];
  return dst;
}

static void heap_init() {
  if (g_top) return;
  g_top = &__heap_base;
}

static uint8_t* heap_alloc(uint32_t n) {
  heap_init();
  n = (n + 15u) & ~15u;
  FreeBlock** link = &g_free;
  while (*link) {
    if ((*link)->size == n) {
      FreeBlock* block = *link;
      *link = block->next;
      return block->ptr;
    }
    link = &(*link)->next;
  }
  uint32_t addr = (uint32_t)(uintptr_t)g_top;
  uint32_t mem_bytes = (uint32_t)__builtin_wasm_memory_size(0) << 16;
  if (addr + n > mem_bytes) {
    uint32_t need = addr + n - mem_bytes;
    uint32_t pages = (need + 65535u) >> 16;
    if (__builtin_wasm_memory_grow(0, pages) < 0) return 0;
  }
  uint8_t* ptr = g_top;
  g_top += n;
  return ptr;
}

static void heap_release(uint8_t* ptr, uint32_t n) {
  if (!ptr) return;
  n = (n + 15u) & ~15u;
  FreeBlock* block = (FreeBlock*)heap_alloc(sizeof(FreeBlock));
  if (!block) return;
  block->ptr = ptr;
  block->size = n;
  block->next = g_free;
  g_free = block;
}

static Sim* sim_at(int id) {
  if (id <= 0 || id >= g_used) return 0;
  return &g_slots[id];
}

static int floor_div2(int v) {
  if (v >= 0) return v / 2;
  return -((-v + 1) / 2);
}

static int reflect_coord(int v, int n) {
  if (v < 0) return -v - 1;
  if (v >= n) return 2 * n - 1 - v;
  return v;
}

static int locate_neighbor(int xx, int yy, int w, int h, int flip_x, int flip_y, int x_mode, int y_mode) {
  if (xx >= 0 && yy >= 0 && xx < w && yy < h) return yy * w + xx;
  for (int pass = 0; pass < 2; pass++) {
    if (yy < 0 || yy >= h) {
      if (y_mode == MODE_OPEN) return -1;
      if (y_mode == MODE_MIRROR) yy = reflect_coord(yy, h);
      else if (yy < 0) yy += h;
      else yy -= h;
      if (flip_y) xx = w - 1 - xx;
    }
    if (xx < 0 || xx >= w) {
      if (x_mode == MODE_OPEN) return -1;
      if (x_mode == MODE_MIRROR) xx = reflect_coord(xx, w);
      else if (xx < 0) xx += w;
      else xx -= w;
      if (flip_x) yy = h - 1 - yy;
    }
  }
  if (xx < 0 || yy < 0 || xx >= w || yy >= h) return -1;
  return yy * w + xx;
}

static int count_at(const uint8_t* src, int x, int y, int w, int h, const int* offs, int n_off, int flip_x, int flip_y, int x_mode, int y_mode) {
  int n = 0;
  int inside = x > 0 && y > 0 && x + 1 < w && y + 1 < h;
  if (inside) {
    int base = y * w + x;
    for (int k = 0; k < n_off; k++) {
      if (src[base + offs[k]] == 1) n += 1;
    }
    return n;
  }
  for (int b = 0; b < 8; b++) {
    int bit = 1 << b;
    int used = 0;
    for (int k = 0; k < n_off; k++) {
      if (offs[k] == DY[b] * w + DX[b]) used = 1;
    }
    if (!used) continue;
    int seen = locate_neighbor(x + DX[b], y + DY[b], w, h, flip_x, flip_y, x_mode, y_mode);
    if (seen >= 0 && src[seen] == 1) n += 1;
  }
  return n;
}

extern "C" {

int cam_locate(int xx, int yy, int w, int h, int flip_x, int flip_y, int x_mode, int y_mode) {
  return locate_neighbor(xx, yy, w, h, flip_x, flip_y, x_mode, y_mode);
}

int cam_create(int cols, int rows) {
  if (cols < 1 || rows < 1) return 0;
  if (g_used >= SLOT_CAP) return 0;
  uint32_t n = (uint32_t)cols * (uint32_t)rows;
  uint8_t* curr = heap_alloc(n);
  uint8_t* prev = heap_alloc(n);
  uint8_t* spare = heap_alloc(n);
  if (!curr || !prev || !spare) return 0;
  for (uint32_t i = 0; i < n; i++) {
    curr[i] = 0;
    prev[i] = 0;
    spare[i] = 0;
  }
  int id = g_used++;
  Sim* sim = &g_slots[id];
  sim->cols = cols;
  sim->rows = rows;
  sim->gen = 0;
  sim->pop = 0;
  sim->curr = curr;
  sim->prev = prev;
  sim->spare = spare;
  return id;
}

int cam_cols(int id) {
  Sim* sim = sim_at(id);
  return sim ? sim->cols : 0;
}

int cam_rows(int id) {
  Sim* sim = sim_at(id);
  return sim ? sim->rows : 0;
}

int cam_gen(int id) {
  Sim* sim = sim_at(id);
  return sim ? sim->gen : 0;
}

void cam_set_gen(int id, int gen) {
  Sim* sim = sim_at(id);
  if (sim) sim->gen = gen;
}

int cam_pop(int id) {
  Sim* sim = sim_at(id);
  return sim ? sim->pop : 0;
}

int cam_curr(int id) {
  Sim* sim = sim_at(id);
  return sim ? (int)(uintptr_t)sim->curr : 0;
}

int cam_prev(int id) {
  Sim* sim = sim_at(id);
  return sim ? (int)(uintptr_t)sim->prev : 0;
}

int cam_spare(int id) {
  Sim* sim = sim_at(id);
  return sim ? (int)(uintptr_t)sim->spare : 0;
}

int cam_recount(int id) {
  Sim* sim = sim_at(id);
  if (!sim) return 0;
  int n = sim->cols * sim->rows;
  int pop = 0;
  for (int i = 0; i < n; i++) if (sim->curr[i] == 1) pop += 1;
  sim->pop = pop;
  return pop;
}

void cam_clear(int id) {
  Sim* sim = sim_at(id);
  if (!sim) return;
  int n = sim->cols * sim->rows;
  for (int i = 0; i < n; i++) {
    sim->curr[i] = 0;
    sim->prev[i] = 0;
    sim->spare[i] = 0;
  }
  sim->gen = 0;
  sim->pop = 0;
}

int cam_get(int id, int x, int y) {
  Sim* sim = sim_at(id);
  if (!sim || x < 0 || y < 0 || x >= sim->cols || y >= sim->rows) return 0;
  return sim->curr[y * sim->cols + x];
}

int cam_set(int id, int x, int y, int value) {
  Sim* sim = sim_at(id);
  if (!sim || x < 0 || y < 0 || x >= sim->cols || y >= sim->rows) return 0;
  int i = y * sim->cols + x;
  int v = value ? 1 : 0;
  int old = sim->curr[i];
  if (old == v) return 0;
  if (old == 1) sim->pop -= 1;
  if (v == 1) sim->pop += 1;
  sim->curr[i] = (uint8_t)v;
  return 1;
}

void cam_randomize(int id, int ppm, unsigned seed) {
  Sim* sim = sim_at(id);
  if (!sim) return;
  if (ppm < 0) ppm = 0;
  if (ppm > 1000000) ppm = 1000000;
  unsigned state = seed ? seed : 1u;
  int n = sim->cols * sim->rows;
  int pop = 0;
  for (int i = 0; i < n; i++) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    int v = (int)(state % 1000000u) < ppm ? 1 : 0;
    sim->curr[i] = (uint8_t)v;
    pop += v;
  }
  for (int i = 0; i < n; i++) sim->prev[i] = 0;
  sim->pop = pop;
  sim->gen = 0;
}

void cam_invert(int id) {
  Sim* sim = sim_at(id);
  if (!sim) return;
  int n = sim->cols * sim->rows;
  for (int i = 0; i < n; i++) sim->curr[i] = sim->curr[i] == 0 ? 1 : 0;
  for (int i = 0; i < n; i++) sim->prev[i] = 0;
  cam_recount(id);
}

int cam_resize(int id, int cols, int rows) {
  Sim* sim = sim_at(id);
  if (!sim || cols < 1 || rows < 1) return 0;
  uint32_t n = (uint32_t)cols * (uint32_t)rows;
  uint32_t old_n = (uint32_t)sim->cols * (uint32_t)sim->rows;
  uint8_t* curr = heap_alloc(n);
  uint8_t* prev = heap_alloc(n);
  uint8_t* spare = heap_alloc(n);
  if (!curr || !prev || !spare) return 0;
  for (uint32_t i = 0; i < n; i++) {
    curr[i] = 0;
    prev[i] = 0;
    spare[i] = 0;
  }
  int ox = floor_div2(cols - sim->cols);
  int oy = floor_div2(rows - sim->rows);
  for (int y = 0; y < sim->rows; y++) {
    for (int x = 0; x < sim->cols; x++) {
      int nx = x + ox;
      int ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      int oi = y * sim->cols + x;
      int ni = ny * cols + nx;
      curr[ni] = sim->curr[oi];
      prev[ni] = sim->prev[oi];
    }
  }
  heap_release(sim->curr, old_n);
  heap_release(sim->prev, old_n);
  heap_release(sim->spare, old_n);
  sim->curr = curr;
  sim->prev = prev;
  sim->spare = spare;
  sim->cols = cols;
  sim->rows = rows;
  cam_recount(id);
  return 1;
}

enum { HASH_BITS = 18, HASH_SIZE = 1 << HASH_BITS, NODE_CHUNK = 4096, MAX_CHUNKS = 128, MAX_HYPER = 20 };

struct HNode {
  uint8_t level;
  uint8_t empty;
  uint8_t s0, s1, s2, s3;
  uint32_t memo_mask;
  HNode* nw;
  HNode* ne;
  HNode* sw;
  HNode* se;
  HNode* memo[MAX_HYPER];
  HNode* chain;
};

struct NodeChunk {
  HNode nodes[NODE_CHUNK];
};

static HNode* g_buckets[HASH_SIZE];
static NodeChunk* g_chunks[MAX_CHUNKS];
static int g_nchunks = 0;
static int g_chunk_i = 0;
static int g_node_i = 0;
static HNode* g_empty[24];
static int g_birth = 0;
static int g_survival = 0;
static int g_neigh = 0xff;
static int g_states = 2;
static int g_off_n = 0;
static int g_ox[8];
static int g_oy[8];
static int g_rule_ready = 0;
static int bb_x0, bb_y0, bb_x1, bb_y1;

static void hash_reset() {
  for (int i = 0; i < HASH_SIZE; i++) g_buckets[i] = 0;
  for (int i = 0; i < 24; i++) g_empty[i] = 0;
  g_chunk_i = 0;
  g_node_i = 0;
}

static HNode* alloc_node() {
  if (g_chunk_i >= g_nchunks) {
    if (g_nchunks >= MAX_CHUNKS) return 0;
    g_chunks[g_nchunks] = (NodeChunk*)heap_alloc(sizeof(NodeChunk));
    if (!g_chunks[g_nchunks]) return 0;
    g_nchunks += 1;
  }
  if (g_node_i >= NODE_CHUNK) {
    g_chunk_i += 1;
    g_node_i = 0;
    if (g_chunk_i >= g_nchunks) return alloc_node();
  }
  HNode* node = &g_chunks[g_chunk_i]->nodes[g_node_i++];
  memset(node, 0, sizeof(HNode));
  return node;
}

static uint32_t mix_hash(uint32_t h) {
  h ^= h >> 16;
  h *= 0x7feb352du;
  h ^= h >> 15;
  return h;
}

static HNode* intern_leaf(int a, int b, int c, int d) {
  uint32_t h = mix_hash((uint32_t)a * 131u ^ (uint32_t)b * 137u ^ (uint32_t)c * 139u ^ (uint32_t)d * 149u);
  uint32_t slot = h & (HASH_SIZE - 1);
  for (HNode* it = g_buckets[slot]; it; it = it->chain) {
    if (it->level == 1 && it->s0 == a && it->s1 == b && it->s2 == c && it->s3 == d) return it;
  }
  HNode* node = alloc_node();
  if (!node) return 0;
  node->level = 1;
  node->s0 = (uint8_t)a;
  node->s1 = (uint8_t)b;
  node->s2 = (uint8_t)c;
  node->s3 = (uint8_t)d;
  node->empty = (a | b | c | d) == 0;
  node->chain = g_buckets[slot];
  g_buckets[slot] = node;
  return node;
}

static HNode* intern_node(HNode* nw, HNode* ne, HNode* sw, HNode* se) {
  if (!nw || !ne || !sw || !se) return 0;
  uint32_t h = mix_hash((uint32_t)(uintptr_t)nw ^ ((uint32_t)(uintptr_t)ne << 1) ^ ((uint32_t)(uintptr_t)sw << 2) ^ ((uint32_t)(uintptr_t)se << 3));
  uint32_t slot = h & (HASH_SIZE - 1);
  for (HNode* it = g_buckets[slot]; it; it = it->chain) {
    if (it->level > 1 && it->nw == nw && it->ne == ne && it->sw == sw && it->se == se) return it;
  }
  HNode* node = alloc_node();
  if (!node) return 0;
  node->level = (uint8_t)(nw->level + 1);
  node->nw = nw;
  node->ne = ne;
  node->sw = sw;
  node->se = se;
  node->empty = nw->empty && ne->empty && sw->empty && se->empty;
  node->chain = g_buckets[slot];
  g_buckets[slot] = node;
  return node;
}

static HNode* empty_node(int level) {
  if (level < 1 || level >= 24) return 0;
  if (g_empty[level]) return g_empty[level];
  HNode* node;
  if (level == 1) node = intern_leaf(0, 0, 0, 0);
  else {
    HNode* e = empty_node(level - 1);
    node = intern_node(e, e, e, e);
  }
  g_empty[level] = node;
  return node;
}

static void bind_rule(int birth, int survival, int neigh, int states) {
  if (states < 2) states = 2;
  if (states > 256) states = 256;
  if (g_rule_ready && g_birth == birth && g_survival == survival && g_neigh == neigh && g_states == states) return;
  g_birth = birth;
  g_survival = survival;
  g_neigh = neigh;
  g_states = states;
  g_off_n = 0;
  for (int b = 0; b < 8; b++) {
    if ((neigh >> b) & 1) {
      g_ox[g_off_n] = DX[b];
      g_oy[g_off_n] = DY[b];
      g_off_n += 1;
    }
  }
  hash_reset();
  g_rule_ready = 1;
}

static int next_of(int self, int neighbors) {
  if (self <= 1) {
    int mask = self == 1 ? g_survival : g_birth;
    if ((mask >> neighbors) & 1) return 1;
    if (self == 1 && g_states > 2) return 2;
    return 0;
  }
  int next = self + 1;
  if (next >= g_states) return 0;
  return next;
}

static int cell4(HNode* n, int x, int y) {
  HNode* q;
  int lx = x;
  int ly = y;
  if (y < 2) q = x < 2 ? n->nw : n->ne;
  else {
    q = x < 2 ? n->sw : n->se;
    ly -= 2;
  }
  if (x >= 2) lx -= 2;
  int s = ly * 2 + lx;
  if (s == 0) return q->s0;
  if (s == 1) return q->s1;
  if (s == 2) return q->s2;
  return q->s3;
}

static int count4(HNode* n, int x, int y) {
  int c = 0;
  for (int k = 0; k < g_off_n; k++) {
    if (cell4(n, x + g_ox[k], y + g_oy[k]) == 1) c += 1;
  }
  return c;
}

static HNode* evolve4(HNode* n) {
  int a = next_of(cell4(n, 1, 1), count4(n, 1, 1));
  int b = next_of(cell4(n, 2, 1), count4(n, 2, 1));
  int c = next_of(cell4(n, 1, 2), count4(n, 1, 2));
  int d = next_of(cell4(n, 2, 2), count4(n, 2, 2));
  return intern_leaf(a, b, c, d);
}

static HNode* center_of(HNode* n) {
  if (!n || n->level < 2) return 0;
  if (n->level == 2) return intern_leaf(n->nw->s3, n->ne->s2, n->sw->s1, n->se->s0);
  return intern_node(n->nw->se, n->ne->sw, n->sw->ne, n->se->nw);
}

static HNode* evolve(HNode* node, int hyper) {
  if (!node) return 0;
  if (hyper < MAX_HYPER && (node->memo_mask & (1u << hyper))) return node->memo[hyper];
  HNode* res = 0;
  if (!(g_birth & 1) && node->empty) res = empty_node(node->level - 1);
  else if (node->level == 2) res = evolve4(node);
  else {
    int do_hyper = hyper >= node->level;
    HNode* nw = node->nw;
    HNode* ne = node->ne;
    HNode* sw = node->sw;
    HNode* se = node->se;
    HNode* n00 = evolve(nw, hyper);
    HNode* n01 = evolve(intern_node(nw->ne, ne->nw, nw->se, ne->sw), hyper);
    HNode* n02 = evolve(ne, hyper);
    HNode* n10 = evolve(intern_node(nw->sw, nw->se, sw->nw, sw->ne), hyper);
    HNode* n11 = evolve(intern_node(nw->se, ne->sw, sw->ne, se->nw), hyper);
    HNode* n12 = evolve(intern_node(ne->sw, ne->se, se->nw, se->ne), hyper);
    HNode* n20 = evolve(sw, hyper);
    HNode* n21 = evolve(intern_node(sw->ne, se->nw, sw->se, se->sw), hyper);
    HNode* n22 = evolve(se, hyper);
    if (do_hyper) {
      res = intern_node(
        evolve(intern_node(n00, n01, n10, n11), hyper),
        evolve(intern_node(n01, n02, n11, n12), hyper),
        evolve(intern_node(n10, n11, n20, n21), hyper),
        evolve(intern_node(n11, n12, n21, n22), hyper));
    } else {
      res = intern_node(
        center_of(intern_node(n00, n01, n10, n11)),
        center_of(intern_node(n01, n02, n11, n12)),
        center_of(intern_node(n10, n11, n20, n21)),
        center_of(intern_node(n11, n12, n21, n22)));
    }
  }
  if (node && hyper < MAX_HYPER && res) {
    node->memo[hyper] = res;
    node->memo_mask |= 1u << hyper;
  }
  return res;
}

static int sample_cell(const uint8_t* grid, int w, int h, int x, int y) {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  return grid[y * w + x];
}

static HNode* build_node(const uint8_t* grid, int w, int h, int ox, int oy, int level) {
  int size = 1 << level;
  if (ox > bb_x1 || oy > bb_y1 || ox + size <= bb_x0 || oy + size <= bb_y0) return empty_node(level);
  if (level == 1) {
    return intern_leaf(
      sample_cell(grid, w, h, ox, oy),
      sample_cell(grid, w, h, ox + 1, oy),
      sample_cell(grid, w, h, ox, oy + 1),
      sample_cell(grid, w, h, ox + 1, oy + 1));
  }
  int half = 1 << (level - 1);
  return intern_node(
    build_node(grid, w, h, ox, oy, level - 1),
    build_node(grid, w, h, ox + half, oy, level - 1),
    build_node(grid, w, h, ox, oy + half, level - 1),
    build_node(grid, w, h, ox + half, oy + half, level - 1));
}

static void blit_node(HNode* n, uint8_t* dest, int w, int h, int ox, int oy) {
  if (!n || n->empty) return;
  if (n->level == 1) {
    if (oy >= 0 && oy < h && ox >= 0 && ox < w) dest[oy * w + ox] = n->s0;
    if (oy >= 0 && oy < h && ox + 1 >= 0 && ox + 1 < w) dest[oy * w + ox + 1] = n->s1;
    if (oy + 1 >= 0 && oy + 1 < h && ox >= 0 && ox < w) dest[(oy + 1) * w + ox] = n->s2;
    if (oy + 1 >= 0 && oy + 1 < h && ox + 1 >= 0 && ox + 1 < w) dest[(oy + 1) * w + ox + 1] = n->s3;
    return;
  }
  int half = 1 << (n->level - 1);
  blit_node(n->nw, dest, w, h, ox, oy);
  blit_node(n->ne, dest, w, h, ox + half, oy);
  blit_node(n->sw, dest, w, h, ox, oy + half);
  blit_node(n->se, dest, w, h, ox + half, oy + half);
}

static int next_pow2_at_least(int n) {
  int s = 1;
  while (s < n) {
    if (s > 65536) return s;
    s <<= 1;
  }
  return s;
}

static int border_busy(const uint8_t* grid, int w, int h) {
  for (int x = 0; x < w; x++) {
    if (grid[x] || grid[(h - 1) * w + x]) return 1;
  }
  for (int y = 0; y < h; y++) {
    if (grid[y * w] || grid[y * w + w - 1]) return 1;
  }
  return 0;
}

static int find_bbox(const uint8_t* grid, int w, int h) {
  bb_x0 = w;
  bb_y0 = h;
  bb_x1 = -1;
  bb_y1 = -1;
  for (int y = 0; y < h; y++) {
    int row = y * w;
    for (int x = 0; x < w; x++) {
      if (!grid[row + x]) continue;
      if (x < bb_x0) bb_x0 = x;
      if (y < bb_y0) bb_y0 = y;
      if (x > bb_x1) bb_x1 = x;
      if (y > bb_y1) bb_y1 = y;
    }
  }
  return bb_x1 >= 0;
}

static int hashlife_jump(Sim* sim, int max_steps) {
  if (max_steps < 2) return 0;
  if (g_birth & 1) return 0;
  int w = sim->cols;
  int h = sim->rows;
  if (w < 8 || h < 8) return 0;
  const uint8_t* grid = sim->curr;
  if (border_busy(grid, w, h)) return 0;
  if (!find_bbox(grid, w, h)) {
    sim->gen += max_steps;
    return max_steps;
  }
  int pw = bb_x1 - bb_x0 + 1;
  int ph = bb_y1 - bb_y0 + 1;
  int side = pw > ph ? pw : ph;
  for (int j = 12; j >= 1; --j) {
    int jump = 1 << j;
    if (jump > max_steps || side > jump * 2) continue;
    int span = jump << 2;
    int level = j + 2;
    if (span > w || span > h) continue;
    int lower_x = bb_x1 + jump - span + 1;
    int upper_x = bb_x0 - jump;
    int min_x = lower_x > 0 ? lower_x : 0;
    int max_x = upper_x < w - span ? upper_x : w - span;
    if (min_x > max_x) continue;
    int lower_y = bb_y1 + jump - span + 1;
    int upper_y = bb_y0 - jump;
    int min_y = lower_y > 0 ? lower_y : 0;
    int max_y = upper_y < h - span ? upper_y : h - span;
    if (min_y > max_y) continue;
    int origin_x = min_x;
    int origin_y = min_y;
    HNode* root = build_node(grid, w, h, origin_x, origin_y, level);
    if (!root) return 0;
    HNode* empty = empty_node(level - 1);
    HNode* big = intern_node(
      intern_node(empty, empty, empty, root->nw),
      intern_node(empty, empty, root->ne, empty),
      intern_node(empty, root->sw, empty, empty),
      intern_node(root->se, empty, empty, empty));
    if (!big) return 0;
    HNode* future = evolve(big, level);
    if (!future) return 0;
    uint8_t* dest = sim->spare;
    int n = w * h;
    for (int i = 0; i < n; i++) dest[i] = 0;
    blit_node(future, dest, w, h, origin_x, origin_y);
    uint8_t* old_prev = sim->prev;
    sim->prev = sim->curr;
    sim->curr = dest;
    sim->spare = old_prev;
    sim->gen += jump;
    cam_recount((int)(sim - g_slots));
    return jump;
  }
  return 0;
}

static void step_once(Sim* sim, int birth, int survival, int neigh, int states, int flip_x, int flip_y, int x_mode, int y_mode) {
  int w = sim->cols;
  int h = sim->rows;
  if (states < 2) states = 2;
  if (states > 256) states = 256;
  const uint8_t* src = sim->curr;
  uint8_t* dst = sim->spare;
  int offs[8];
  int n_off = 0;
  for (int b = 0; b < 8; b++) {
    if ((neigh >> b) & 1) offs[n_off++] = DY[b] * w + DX[b];
  }
  int pop = 0;
  for (int y = 0; y < h; y++) {
    int row = y * w;
    for (int x = 0; x < w; x++) {
      int cell = src[row + x];
      int next;
      if (cell <= 1) {
        int n = count_at(src, x, y, w, h, offs, n_off, flip_x, flip_y, x_mode, y_mode);
        int mask = cell == 1 ? survival : birth;
        if ((mask >> n) & 1) next = 1;
        else next = (cell == 1 && states > 2) ? 2 : 0;
      } else {
        next = cell + 1;
        if (next >= states) next = 0;
      }
      dst[row + x] = (uint8_t)next;
      if (next == 1) pop += 1;
    }
  }
  sim->spare = sim->prev;
  sim->prev = (uint8_t*)src;
  sim->curr = dst;
  sim->pop = pop;
  sim->gen += 1;
}

void cam_step(int id, int birth, int survival, int neigh, int states, int flip_x, int flip_y, int x_mode, int y_mode) {
  Sim* sim = sim_at(id);
  if (!sim) return;
  step_once(sim, birth, survival, neigh, states, flip_x, flip_y, x_mode, y_mode);
}

int cam_run(int id, int steps, int birth, int survival, int neigh, int states, int flip_x, int flip_y, int x_mode, int y_mode) {
  Sim* sim = sim_at(id);
  if (!sim || steps < 1) return 0;
  if (states < 2) states = 2;
  if (states > 256) states = 256;
  bind_rule(birth, survival, neigh, states);
  int done = 0;
  int scans = 0;
  while (done < steps) {
    int left = steps - done;
    int jumped = 0;
    if (left >= 2 && scans == 0) jumped = hashlife_jump(sim, left - 1);
    if (jumped > 0) {
      done += jumped;
      continue;
    }
    if (scans >= 24) break;
    step_once(sim, birth, survival, neigh, states, flip_x, flip_y, x_mode, y_mode);
    done += 1;
    scans += 1;
  }
  return done;
}

}
