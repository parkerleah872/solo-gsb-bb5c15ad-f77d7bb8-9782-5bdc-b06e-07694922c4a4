'use strict';

/**
 * 带载安全选配算法
 *
 * 在单台选配（目标速比 + 容差 + 1~3 级传动 + 每枚齿轮至多使用一次）的基础上，
 * 额外引入无损传动的扭矩校核：
 *   - 输入扭矩 T0（正整数，N·m）作用于第一级主动轮；
 *   - 每级主动轮承受该级输入扭矩 T_in；
 *   - 每级从动轮承受 T_in × 从动齿数 / 主动齿数（无损传动、功率守恒），
 *     该值同时作为下一级的输入扭矩；
 *   - 每级两轮的承受值均不得超过各自额定扭矩（正整数，N·m）。
 *
 * 同一组配对（相同齿轮、相同朝向）的不同级次顺序会产生不同的扭矩传递链，
 * 必须分别校核：先在完整枚举（不截断）的速比达标配对上展开全部级次排列，
 * 再逐一做载荷校核——不能使用单台搜索的级序去重结果或前 300 条截断结果
 * 代替完整候选。
 *
 * 结果排序与单台一致：级数最少 → 相对误差最小 → 级次（主动,从动）编号自然序；
 * 级次顺序不同的方案视为不同方案，分别计数、分别参与排序与展示。
 */

const {
  MAX_GEARS,
  MIN_TEETH,
  MAX_TEETH,
  RESULT_LIMIT,
  makeFrac,
  naturalCmp,
  cmpSolutions,
  enumerateMatches,
} = require('./search');

/** 输入扭矩 / 额定扭矩上限（正整数，取安全整数范围内的实用上限） */
const MAX_TORQUE = 1_000_000_000_000;

/**
 * 枚举数组的全部排列（级数 k ≤ 3，至多 6 种），每次 yield 一个新数组，
 * 不改动原数组。
 */
function* permutations(arr) {
  const n = arr.length;
  const used = new Array(n).fill(false);
  const out = new Array(n);
  function* rec(depth) {
    if (depth === n) {
      yield out.slice();
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      out[depth] = arr[i];
      yield* rec(depth + 1);
      used[i] = false;
    }
  }
  yield* rec(0);
}

/**
 * 对一个级次顺序已定的方案做无损传动扭矩校核。
 * 承受扭矩为精确分数 tn/td，判定全程整数交叉相乘，无需约分。
 *
 * @param {Array<{driveIndex:number,drivenIndex:number}>} idxs 按传动顺序排列的各级
 * @param {Array<{teeth:number,ratedTorque:number}>} gears 规范化齿轮
 * @param {bigint} t0 输入扭矩（正整数）
 * @returns {boolean} 每级两轮承受值均不超过各自额定值时返回 true
 */
function loadOk(idxs, gears, t0) {
  let tn = t0;
  let td = 1n;
  for (const p of idxs) {
    const drive = gears[p.driveIndex];
    const driven = gears[p.drivenIndex];
    // 主动轮承受该级输入扭矩 tn/td：要求 tn/td ≤ rated ⇔ tn ≤ rated·td
    if (tn > BigInt(drive.ratedTorque) * td) return false;
    // 从动轮承受 tn/td × 从动齿数/主动齿数，并作为下一级输入
    tn *= BigInt(driven.teeth);
    td *= BigInt(drive.teeth);
    if (tn > BigInt(driven.ratedTorque) * td) return false;
  }
  return true;
}

/**
 * 将轻量方案（级次顺序已定的齿轮下标序列）展开为带编号/齿数/额定扭矩/
 * 各级两轮承受扭矩的富对象，供接口与前端展示。
 * 承受扭矩按输入扭矩沿级次顺序重新传播，约分后输出。
 */
function enrichLoadMatch(m, gears, t0) {
  let tn = t0;
  let td = 1n;
  const pairs = m.idxs.map((p) => {
    const d = gears[p.driveIndex];
    const w = gears[p.drivenIndex];
    const driveTorque = makeFrac(tn, td);
    tn *= BigInt(w.teeth);
    td *= BigInt(d.teeth);
    return {
      drive: { id: d.id, teeth: d.teeth, ratedTorque: d.ratedTorque },
      driven: { id: w.id, teeth: w.teeth, ratedTorque: w.ratedTorque },
      stageRatio: makeFrac(BigInt(d.teeth), BigInt(w.teeth)),
      driveTorque,
      drivenTorque: makeFrac(tn, td),
    };
  });
  return { stages: m.stages, ratio: m.ratio, error: m.error, pairs };
}

/**
 * 带载安全搜索：在全部速比达标配对（完整枚举，不截断）上展开全部级次顺序，
 * 逐一校核载荷；按 级数 → 误差 → 级次编号自然序 排序，最多返回前 RESULT_LIMIT 条。
 *
 * @param {Array<{id:string,teeth:number,ratedTorque:number}>} gears 规范化齿轮（2~12 枚，按编号自然序）
 * @param {{num:bigint,den:bigint}} target 目标输出转速比（正分数）
 * @param {{num:bigint,den:bigint}} tolerance 允许相对误差（非负分数）
 * @param {number} inputTorque 输入扭矩（正整数，N·m）
 * @returns {{ratioTotal:number,total:number,truncated:boolean,results:Array}}
 *   ratioTotal 为仅速比达标的方案数（级次顺序分别计数，与 total 口径一致），
 *   total 为速比与载荷均达标的方案总数
 */
function searchLoad(gears, target, tolerance, inputTorque) {
  const t0 = BigInt(inputTorque);
  const matches = [];
  let ratioTotal = 0;

  // 速比达标判定与级次顺序无关：先在完整枚举的达标配对上展开全部级次排列
  for (const m of enumerateMatches(gears, target, tolerance)) {
    for (const ordered of permutations(m.idxs)) {
      ratioTotal++;
      if (!loadOk(ordered, gears, t0)) continue;
      matches.push({ stages: m.stages, ratio: m.ratio, error: m.error, idxs: ordered });
    }
  }

  // 排序：级数最少 → 误差最小 → 级次（主动,从动）编号序列自然序
  matches.sort(cmpSolutions);

  const total = matches.length;
  return {
    ratioTotal,
    total,
    truncated: total > RESULT_LIMIT,
    // 仅展开实际返回的前若干条为富对象
    results: matches.slice(0, RESULT_LIMIT).map((m) => enrichLoadMatch(m, gears, t0)),
  };
}

/**
 * 校验并规范化带载选配的齿轮列表：编号唯一、齿数为正整数、
 * 额定扭矩为正整数（单位 N·m）。
 * @param {*} input
 * @returns {{ok:true, gears:Array}|{ok:false,error:string}}
 */
function validateLoadGears(input) {
  if (!Array.isArray(input)) return { ok: false, error: '齿轮列表格式不正确' };
  if (input.length < 2 || input.length > MAX_GEARS) {
    return { ok: false, error: `齿轮数量需在 2~${MAX_GEARS} 枚之间（当前 ${input.length} 枚）` };
  }
  const gears = [];
  const ids = new Set();
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    if (!row || typeof row !== 'object') return { ok: false, error: `第 ${i + 1} 行齿轮数据格式不正确` };
    const id = String(row.id ?? '').trim();
    if (!id) return { ok: false, error: `第 ${i + 1} 行缺少齿轮编号` };
    if (ids.has(id)) return { ok: false, error: `齿轮编号重复：${id}` };
    ids.add(id);
    const teeth = Number(row.teeth);
    if (!Number.isInteger(teeth) || teeth < MIN_TEETH || teeth > MAX_TEETH) {
      return { ok: false, error: `齿轮 ${id} 的齿数需为 ${MIN_TEETH}~${MAX_TEETH} 的整数` };
    }
    const ratedTorque = Number(row.ratedTorque);
    if (!Number.isInteger(ratedTorque) || ratedTorque < 1 || ratedTorque > MAX_TORQUE) {
      return { ok: false, error: `齿轮 ${id} 的额定扭矩需为 1~${MAX_TORQUE} 的正整数（单位 N·m）` };
    }
    gears.push({ id, teeth, ratedTorque });
  }
  // 按编号自然序排列，保证枚举与结果稳定
  gears.sort((a, b) => naturalCmp(a.id, b.id));
  return { ok: true, gears };
}

module.exports = {
  MAX_TORQUE,
  searchLoad,
  enrichLoadMatch,
  validateLoadGears,
};
