const WORDS_256: u32 = 8u;
const WORDS_512: u32 = 16u;
const TEMP_WORDS: u32 = 10u;
const WINDOW_SEGMENTS: u32 = 4u;
const WINDOW_SIZE: u32 = 256u;
const CANDIDATE_CAPACITY: u32 = 1024u;
const WINDOW_HI_MASK: u32 = 0x0fffffffu;

struct MinerConfig {
  batch_size: u32,
  prefix_enabled: u32,
  prefix_pattern: u32,
  prefix_mask: u32,
  suffix_enabled: u32,
  suffix_pattern_hi: u32,
  suffix_pattern_lo: u32,
  suffix_mask_hi: u32,
  suffix_mask_lo: u32,
}

struct PointAffine {
  x: array<u32, 8>,
  y: array<u32, 8>,
}

struct CandidateOutput {
  count: atomic<u32>,
  indices: array<u32, CANDIDATE_CAPACITY>,
}

struct DebugOutput {
  x_msw: u32,
  prefix_enabled: u32,
  prefix_pattern: u32,
  prefix_mask: u32,
  prefix_match: u32,
  suffix_match: u32,
  combined_match: u32,
  stage: u32,
}

struct Sub256Result {
  words: array<u32, 8>,
  borrow: u32,
}

struct JacobianPoint {
  x: array<u32, 8>,
  y: array<u32, 8>,
  z: array<u32, 8>,
  z_sq: array<u32, 8>,
}

@group(0) @binding(0)
var<storage, read> config: MinerConfig;

@group(0) @binding(1)
var<storage, read> base_point: PointAffine;

@group(0) @binding(2)
var<storage, read> window_table: array<PointAffine, 1024>;

@group(0) @binding(3)
var<storage, read_write> candidates: CandidateOutput;

@group(0) @binding(4)
var<storage, read_write> debug_output: DebugOutput;

const P: array<u32, 8> = array<u32, 8>(
  0xfffffc2fu,
  0xfffffffeu,
  0xffffffffu,
  0xffffffffu,
  0xffffffffu,
  0xffffffffu,
  0xffffffffu,
  0xffffffffu,
);

const BECH32_NPUB_POLYMOD_INIT: u32 = 0x1773adfbu;

fn mul_u32(a: u32, b: u32) -> vec2<u32> {
  let a_lo = a & 0xffffu;
  let a_hi = a >> 16u;
  let b_lo = b & 0xffffu;
  let b_hi = b >> 16u;
  let p0 = a_lo * b_lo;
  let p1 = a_lo * b_hi;
  let p2 = a_hi * b_lo;
  let p3 = a_hi * b_hi;
  let middle = (p0 >> 16u) + (p1 & 0xffffu) + (p2 & 0xffffu);
  let low = (p0 & 0xffffu) | ((middle & 0xffffu) << 16u);
  let high = p3 + (p1 >> 16u) + (p2 >> 16u) + (middle >> 16u);
  return vec2<u32>(low, high);
}

fn add_u32(a: u32, b: u32) -> vec2<u32> {
  let sum = a + b;
  let carry = select(0u, 1u, sum < a);
  return vec2<u32>(sum, carry);
}

fn add_u32_with_carry(a: u32, b: u32, carry_in: u32) -> vec2<u32> {
  let sum_ab = add_u32(a, b);
  let sum_all = add_u32(sum_ab.x, carry_in);
  return vec2<u32>(sum_all.x, sum_ab.y + sum_all.y);
}

fn sub_u32(a: u32, b: u32) -> vec2<u32> {
  let diff = a - b;
  let borrow = select(0u, 1u, a < b);
  return vec2<u32>(diff, borrow);
}

fn sub_u32_with_borrow(a: u32, b: u32, borrow_in: u32) -> vec2<u32> {
  let diff_ab = sub_u32(a, b);
  let diff_all = sub_u32(diff_ab.x, borrow_in);
  return vec2<u32>(diff_all.x, diff_ab.y + diff_all.y);
}

fn one_u256() -> array<u32, 8> {
  return array<u32, 8>(1u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
}

fn is_zero_u256(value: array<u32, 8>) -> bool {
  for (var index = 0u; index < WORDS_256; index = index + 1u) {
    if (value[index] != 0u) {
      return false;
    }
  }

  return true;
}

fn gte_u256(left: array<u32, 8>, right: array<u32, 8>) -> bool {
  for (var offset = 0u; offset < WORDS_256; offset = offset + 1u) {
    let index = WORDS_256 - 1u - offset;

    if (left[index] > right[index]) {
      return true;
    }

    if (left[index] < right[index]) {
      return false;
    }
  }

  return true;
}

fn add_u256(left: array<u32, 8>, right: array<u32, 8>) -> array<u32, 9> {
  var result: array<u32, 9>;
  var carry = 0u;

  for (var index = 0u; index < WORDS_256; index = index + 1u) {
    let next = add_u32_with_carry(left[index], right[index], carry);
    result[index] = next.x;
    carry = next.y;
  }

  result[8] = carry;
  return result;
}

fn sub_u256(left: array<u32, 8>, right: array<u32, 8>) -> Sub256Result {
  var result: array<u32, 8>;
  var borrow = 0u;

  for (var index = 0u; index < WORDS_256; index = index + 1u) {
    let next = sub_u32_with_borrow(left[index], right[index], borrow);
    result[index] = next.x;
    borrow = next.y;
  }

  return Sub256Result(result, borrow);
}

fn mod_add(left: array<u32, 8>, right: array<u32, 8>) -> array<u32, 8> {
  let sum = add_u256(left, right);
  var reduced = array<u32, 8>(
    sum[0],
    sum[1],
    sum[2],
    sum[3],
    sum[4],
    sum[5],
    sum[6],
    sum[7],
  );

  if (sum[8] != 0u || gte_u256(reduced, P)) {
    reduced = sub_u256(reduced, P).words;
  }

  return reduced;
}

fn mod_sub_fixed(left: array<u32, 8>, right: array<u32, 8>) -> array<u32, 8> {
  let diff = sub_u256(left, right);

  if (diff.borrow == 0u) {
    return diff.words;
  }

  let wrapped = add_u256(diff.words, P);
  return array<u32, 8>(
    wrapped[0],
    wrapped[1],
    wrapped[2],
    wrapped[3],
    wrapped[4],
    wrapped[5],
    wrapped[6],
    wrapped[7],
  );
}

fn add_at_16(output_words: ptr<function, array<u32, 16>>, index: u32, value: u32) {
  var slot = index;
  var carry = value;

  loop {
    if (carry == 0u || slot >= WORDS_512) {
      break;
    }

    let next = add_u32((*output_words)[slot], carry);
    (*output_words)[slot] = next.x;
    carry = next.y;
    slot = slot + 1u;
  }
}

fn add_at_10(output_words: ptr<function, array<u32, 10>>, index: u32, value: u32) {
  var slot = index;
  var carry = value;

  loop {
    if (carry == 0u || slot >= TEMP_WORDS) {
      break;
    }

    let next = add_u32((*output_words)[slot], carry);
    (*output_words)[slot] = next.x;
    carry = next.y;
    slot = slot + 1u;
  }
}

fn reduce_512(input: array<u32, 16>) -> array<u32, 8> {
  var temp: array<u32, 10>;

  for (var index = 0u; index < WORDS_256; index = index + 1u) {
    temp[index] = input[index];
  }

  for (var index = 0u; index < WORDS_256; index = index + 1u) {
    add_at_10(&temp, index + 1u, input[index + 8u]);
    let product = mul_u32(input[index + 8u], 977u);
    add_at_10(&temp, index, product.x);
    add_at_10(&temp, index + 1u, product.y);
  }

  loop {
    if (temp[8] == 0u && temp[9] == 0u) {
      break;
    }

    for (var high_index = 8u; high_index < TEMP_WORDS; high_index = high_index + 1u) {
      let factor = temp[high_index];

      if (factor == 0u) {
        continue;
      }

      temp[high_index] = 0u;
      let shift = high_index - 8u;
      let product = mul_u32(factor, 977u);
      add_at_10(&temp, shift, product.x);
      add_at_10(&temp, shift + 1u, product.y);
      add_at_10(&temp, shift + 1u, factor);
    }
  }

  var result = array<u32, 8>(
    temp[0],
    temp[1],
    temp[2],
    temp[3],
    temp[4],
    temp[5],
    temp[6],
    temp[7],
  );

  loop {
    if (!gte_u256(result, P)) {
      break;
    }

    result = sub_u256(result, P).words;
  }

  return result;
}

fn mod_mult(left: array<u32, 8>, right: array<u32, 8>) -> array<u32, 8> {
  var temp: array<u32, 16>;

  for (var i = 0u; i < WORDS_256; i = i + 1u) {
    for (var j = 0u; j < WORDS_256; j = j + 1u) {
      let product = mul_u32(left[i], right[j]);
      add_at_16(&temp, i + j, product.x);
      add_at_16(&temp, i + j + 1u, product.y);
    }
  }

  return reduce_512(temp);
}

fn mod_square(value: array<u32, 8>) -> array<u32, 8> {
  return mod_mult(value, value);
}

fn mod_double(value: array<u32, 8>) -> array<u32, 8> {
  return mod_add(value, value);
}

fn mod_triple(value: array<u32, 8>) -> array<u32, 8> {
  return mod_add(mod_double(value), value);
}

fn mod_inv(value: array<u32, 8>) -> array<u32, 8> {
  var x2: array<u32, 8>;
  var x3: array<u32, 8>;
  var x6: array<u32, 8>;
  var x9: array<u32, 8>;
  var x11: array<u32, 8>;
  var x22: array<u32, 8>;
  var x44: array<u32, 8>;
  var x88: array<u32, 8>;
  var x176: array<u32, 8>;
  var x220: array<u32, 8>;
  var x223: array<u32, 8>;
  var temp: array<u32, 8>;

  temp = mod_square(value);
  x2 = mod_mult(temp, value);

  temp = mod_square(x2);
  x3 = mod_mult(temp, value);

  temp = x3;
  for (var index = 0u; index < 3u; index = index + 1u) {
    temp = mod_square(temp);
  }
  x6 = mod_mult(temp, x3);

  temp = x6;
  for (var index = 0u; index < 3u; index = index + 1u) {
    temp = mod_square(temp);
  }
  x9 = mod_mult(temp, x3);

  temp = x9;
  for (var index = 0u; index < 2u; index = index + 1u) {
    temp = mod_square(temp);
  }
  x11 = mod_mult(temp, x2);

  temp = mod_square(x11);
  for (var index = 1u; index < 11u; index = index + 1u) {
    temp = mod_square(temp);
  }
  x22 = mod_mult(temp, x11);

  temp = mod_square(x22);
  for (var index = 1u; index < 22u; index = index + 1u) {
    temp = mod_square(temp);
  }
  x44 = mod_mult(temp, x22);

  temp = mod_square(x44);
  for (var index = 1u; index < 44u; index = index + 1u) {
    temp = mod_square(temp);
  }
  x88 = mod_mult(temp, x44);

  temp = mod_square(x88);
  for (var index = 1u; index < 88u; index = index + 1u) {
    temp = mod_square(temp);
  }
  x176 = mod_mult(temp, x88);

  temp = mod_square(x176);
  for (var index = 1u; index < 44u; index = index + 1u) {
    temp = mod_square(temp);
  }
  x220 = mod_mult(temp, x44);

  temp = x220;
  for (var index = 0u; index < 3u; index = index + 1u) {
    temp = mod_square(temp);
  }
  x223 = mod_mult(temp, x3);

  temp = x223;
  for (var index = 0u; index < 23u; index = index + 1u) {
    temp = mod_square(temp);
  }
  temp = mod_mult(temp, x22);

  for (var index = 0u; index < 5u; index = index + 1u) {
    temp = mod_square(temp);
  }
  temp = mod_mult(temp, value);

  for (var index = 0u; index < 3u; index = index + 1u) {
    temp = mod_square(temp);
  }
  temp = mod_mult(temp, x2);

  temp = mod_square(temp);
  temp = mod_square(temp);
  return mod_mult(temp, value);
}

fn point_from_affine(point: PointAffine) -> JacobianPoint {
  return JacobianPoint(point.x, point.y, one_u256(), one_u256());
}

fn point_double(point: JacobianPoint) -> JacobianPoint {
  let y_sq = mod_square(point.y);
  let y_fourth = mod_square(y_sq);
  let x_sq = mod_square(point.x);
  let x_y_sq = mod_mult(point.x, y_sq);
  let s = mod_double(mod_double(x_y_sq));
  let m = mod_triple(x_sq);
  let x_next = mod_sub_fixed(mod_square(m), mod_double(s));
  let y_next = mod_sub_fixed(
    mod_mult(m, mod_sub_fixed(s, x_next)),
    mod_double(mod_double(mod_double(y_fourth))),
  );
  let z_next = mod_double(mod_mult(point.y, point.z));
  let z_sq_next = mod_square(z_next);

  return JacobianPoint(x_next, y_next, z_next, z_sq_next);
}

fn point_add_mixed(point: JacobianPoint, affine: PointAffine) -> JacobianPoint {
  let z_cubed = mod_mult(point.z_sq, point.z);
  let u2 = mod_mult(affine.x, point.z_sq);
  let s2 = mod_mult(affine.y, z_cubed);
  let h = mod_sub_fixed(u2, point.x);
  let r = mod_sub_fixed(s2, point.y);

  if (is_zero_u256(h)) {
    if (is_zero_u256(r)) {
      return point_double(point);
    }

    return point;
  }

  let h_sq = mod_square(h);
  let h_cubed = mod_mult(h_sq, h);
  let r_sq = mod_square(r);
  let x_h_sq = mod_mult(point.x, h_sq);
  let x_next = mod_sub_fixed(
    mod_sub_fixed(r_sq, h_cubed),
    mod_double(x_h_sq),
  );
  let y_next = mod_sub_fixed(
    mod_mult(r, mod_sub_fixed(x_h_sq, x_next)),
    mod_mult(point.y, h_cubed),
  );
  let z_next = mod_mult(point.z, h);
  let z_sq_next = mod_square(z_next);

  return JacobianPoint(x_next, y_next, z_next, z_sq_next);
}

fn affine_x(point: JacobianPoint) -> array<u32, 8> {
  let z_inv_sq = mod_inv(point.z_sq);
  return mod_mult(point.x, z_inv_sq);
}

fn bech32_polymod_step(pre: u32, value: u32) -> u32 {
  let top = pre >> 25u;
  var chk = ((pre & 0x1ffffffu) << 5u) ^ value;

  if ((top & 1u) != 0u) {
    chk = chk ^ 0x3b6a57b2u;
  }

  if ((top & 2u) != 0u) {
    chk = chk ^ 0x26508e6du;
  }

  if ((top & 4u) != 0u) {
    chk = chk ^ 0x1ea119fau;
  }

  if ((top & 8u) != 0u) {
    chk = chk ^ 0x3d4233ddu;
  }

  if ((top & 16u) != 0u) {
    chk = chk ^ 0x2a1462b3u;
  }

  return chk;
}

fn suffix_window_matches(x_words: array<u32, 8>) -> bool {
  var polymod = BECH32_NPUB_POLYMOD_INIT;
  var acc = 0u;
  var bits = 0u;
  var window_hi = 0u;
  var window_lo = 0u;

  for (var reverse = 0u; reverse < WORDS_256; reverse = reverse + 1u) {
    let limb = WORDS_256 - 1u - reverse;
    let word = x_words[limb];

    for (var byte_index = 0u; byte_index < 4u; byte_index = byte_index + 1u) {
      let shift = 24u - byte_index * 8u;
      let byte = (word >> shift) & 0xffu;
      acc = ((acc << 8u) | byte) & 0x0fffu;
      bits = bits + 8u;

      loop {
        if (bits < 5u) {
          break;
        }

        bits = bits - 5u;
        let value = (acc >> bits) & 0x1fu;
        polymod = bech32_polymod_step(polymod, value);
        window_hi = ((window_hi << 5u) | (window_lo >> 27u)) & WINDOW_HI_MASK;
        window_lo = (window_lo << 5u) | value;
      }
    }
  }

  if (bits > 0u) {
    let value = (acc << (5u - bits)) & 0x1fu;
    polymod = bech32_polymod_step(polymod, value);
    window_hi = ((window_hi << 5u) | (window_lo >> 27u)) & WINDOW_HI_MASK;
    window_lo = (window_lo << 5u) | value;
  }

  for (var index = 0u; index < 6u; index = index + 1u) {
    polymod = bech32_polymod_step(polymod, 0u);
  }

  let checksum = polymod ^ 1u;

  for (var index = 0u; index < 6u; index = index + 1u) {
    let shift = 5u * (5u - index);
    let value = (checksum >> shift) & 0x1fu;
    window_hi = ((window_hi << 5u) | (window_lo >> 27u)) & WINDOW_HI_MASK;
    window_lo = (window_lo << 5u) | value;
  }

  return (
    ((window_hi & config.suffix_mask_hi) == (config.suffix_pattern_hi & config.suffix_mask_hi))
    && ((window_lo & config.suffix_mask_lo) == (config.suffix_pattern_lo & config.suffix_mask_lo))
  );
}

@compute @workgroup_size(64)
fn mine_batch(@builtin(global_invocation_id) invocation_id: vec3<u32>) {
  let index = invocation_id.x;

  if (index >= config.batch_size) {
    return;
  }

  if (index == 0u) {
    debug_output.stage = 1u;
    debug_output.prefix_enabled = config.prefix_enabled;
    debug_output.prefix_pattern = config.prefix_pattern;
    debug_output.prefix_mask = config.prefix_mask;
  }

  if (config.prefix_enabled == 0u && config.suffix_enabled == 0u) {
    if (index == 0u) {
      debug_output.x_msw = 0xffffffffu;
      debug_output.prefix_match = 1u;
      debug_output.suffix_match = 1u;
      debug_output.combined_match = 1u;
      debug_output.stage = 2u;
    }

    let no_filter_slot = atomicAdd(&candidates.count, 1u);

    if (no_filter_slot < CANDIDATE_CAPACITY) {
      candidates.indices[no_filter_slot] = index;
    }

    return;
  }

  var point = point_from_affine(base_point);

  for (var segment = 0u; segment < WINDOW_SEGMENTS; segment = segment + 1u) {
    let shift = segment * 8u;
    let chunk = (index >> shift) & 0xffu;

    if (chunk == 0u) {
      continue;
    }

    let table_index = segment * WINDOW_SIZE + chunk;
    point = point_add_mixed(point, window_table[table_index]);
  }

  let x_words = affine_x(point);
  if (index == 0u) {
    debug_output.stage = 3u;
  }
  var prefix_ok = config.prefix_enabled == 0u;
  let suffix_ok = config.suffix_enabled == 0u || suffix_window_matches(x_words);

  if (config.prefix_enabled != 0u) {
    prefix_ok = (x_words[7] & config.prefix_mask) == (config.prefix_pattern & config.prefix_mask);
  }

  if (index == 0u) {
    debug_output.x_msw = x_words[7];
    debug_output.prefix_enabled = config.prefix_enabled;
    debug_output.prefix_pattern = config.prefix_pattern;
    debug_output.prefix_mask = config.prefix_mask;
    debug_output.prefix_match = select(0u, 1u, prefix_ok);
    debug_output.suffix_match = select(0u, 1u, suffix_ok);
    debug_output.combined_match = select(0u, 1u, prefix_ok && suffix_ok);
    debug_output.stage = 4u;
  }

  if (!(prefix_ok && suffix_ok)) {
    return;
  }

  let candidate_slot = atomicAdd(&candidates.count, 1u);

  if (candidate_slot < CANDIDATE_CAPACITY) {
    candidates.indices[candidate_slot] = index;
  }
}
