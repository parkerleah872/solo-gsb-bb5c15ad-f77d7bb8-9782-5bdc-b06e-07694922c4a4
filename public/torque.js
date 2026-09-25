'use strict';

const rowsBox = document.getElementById('gear-rows');
const form = document.getElementById('torque-form');
const formError = document.getElementById('form-error');
const resultPanel = document.getElementById('result-panel');
const resultSummary = document.getElementById('result-summary');
const resultList = document.getElementById('result-list');
const noSolution = document.getElementById('no-solution');
const truncatedNote = document.getElementById('truncated-note');

const EXAMPLE_GEARS = [
  { id: 'G1', teeth: 10, ratedTorque: 120 },
  { id: 'G2', teeth: 12, ratedTorque: 150 },
  { id: 'G3', teeth: 15, ratedTorque: 200 },
  { id: 'G4', teeth: 20, ratedTorque: 260 },
  { id: 'G5', teeth: 30, ratedTorque: 400 },
  { id: 'G6', teeth: 40, ratedTorque: 520 },
  { id: 'G7', teeth: 50, ratedTorque: 650 },
  { id: 'G8', teeth: 60, ratedTorque: 800 },
];

function addGearRow(id = '', teeth = '', ratedTorque = '') {
  const row = document.createElement('div');
  row.className = 'torque-row';
  row.innerHTML = `
    <input class="gear-id-input" placeholder="如 G1" value="${id}" />
    <input class="gear-teeth-input" type="number" min="1" max="100000" step="1" placeholder="齿数" value="${teeth}" />
    <input class="gear-rated-input" type="number" min="1" step="1" placeholder="额定扭矩" value="${ratedTorque}" />
    <button type="button" class="btn danger-ghost" title="删除该齿轮">✕</button>
  `;
  row.querySelector('button').addEventListener('click', () => {
    if (rowsBox.children.length <= 2) {
      alert('至少保留 2 枚齿轮');
      return;
    }
    row.remove();
  });
  rowsBox.appendChild(row);
}

document.getElementById('btn-add').addEventListener('click', () => addGearRow());
document.getElementById('btn-example').addEventListener('click', () => {
  rowsBox.innerHTML = '';
  EXAMPLE_GEARS.forEach((g) => addGearRow(g.id, g.teeth, g.ratedTorque));
  document.getElementById('target').value = '1/12';
  document.getElementById('tolerance').value = '5%';
  document.getElementById('input-torque').value = '50';
});

/* 初始两行 */
addGearRow('G1', 10, 120);
addGearRow('G2', 60, 800);

function collectInputTorque() {
  const raw = document.getElementById('input-torque').value.trim();
  const t = Number(raw);
  if (!Number.isInteger(t) || t < 1) throw new Error('输入扭矩需为正整数（单位 N·m）');
  return t;
}

function collectGears() {
  const gears = [];
  const ids = new Set();
  for (const row of rowsBox.querySelectorAll('.torque-row')) {
    const id = row.querySelector('.gear-id-input').value.trim();
    const teethRaw = row.querySelector('.gear-teeth-input').value.trim();
    const ratedRaw = row.querySelector('.gear-rated-input').value.trim();
    if (!id && !teethRaw && !ratedRaw) continue; // 空行忽略
    if (!id) throw new Error('存在未填写编号的齿轮行');
    if (ids.has(id)) throw new Error(`齿轮编号重复：${id}`);
    ids.add(id);
    const teeth = Number(teethRaw);
    if (!Number.isInteger(teeth) || teeth < 1) throw new Error(`齿轮 ${id} 的齿数需为正整数`);
    const ratedTorque = Number(ratedRaw);
    if (!Number.isInteger(ratedTorque) || ratedTorque < 1) {
      throw new Error(`齿轮 ${id} 的额定扭矩需为正整数（单位 N·m）`);
    }
    gears.push({ id, teeth, ratedTorque });
  }
  if (gears.length < 2) throw new Error('请至少填写 2 枚齿轮（最多 12 枚）');
  if (gears.length > 12) throw new Error('齿轮数量不能超过 12 枚');
  return gears;
}

function el(tag, className, html) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** 承受扭矩展示：整数只显示数值，分数显示 分数 ≈ 小数 */
function fracHtml(f) {
  return f.den === '1'
    ? `<strong>${f.num}</strong>`
    : `<strong class="frac">${f.num}/${f.den}</strong> ≈ <strong>${f.decimal}</strong>`;
}

function renderSolution(r, index) {
  const card = el('div', `solution${index === 0 ? ' best' : ''}`);

  const head = el('div', 'solution-head');
  head.appendChild(el('span', 'solution-title',
    `${index === 0 ? '<span class="badge">最优</span>' : ''}方案 ${index + 1} · ${r.stages} 级传动`));
  head.appendChild(el('span', 'solution-meta',
    `实际转速比 <strong class="frac">${r.ratio.num}/${r.ratio.den}</strong>` +
    ` ≈ <strong>${r.ratio.decimal}</strong>` +
    ` &nbsp;|&nbsp; 相对误差 <strong>${r.errorPercent}%</strong>`));
  card.appendChild(head);

  const table = el('table', 'pairs');
  table.innerHTML = `
    <thead><tr>
      <th>级</th>
      <th>主动轮（编号 / 齿数）</th>
      <th>主动轮承受 / 额定（N·m）</th>
      <th>从动轮（编号 / 齿数）</th>
      <th>从动轮承受 / 额定（N·m）</th>
      <th>本级速比（主动/从动）</th>
    </tr></thead>`;
  const tbody = el('tbody');
  r.pairs.forEach((p, i) => {
    const tr = el('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><span class="gear-id">${p.drive.id}</span> · ${p.drive.teeth} 齿</td>
      <td>${fracHtml(p.driveTorque)}<br><small>额定 ${p.drive.ratedTorque}</small></td>
      <td><span class="gear-id">${p.driven.id}</span> · ${p.driven.teeth} 齿</td>
      <td>${fracHtml(p.drivenTorque)}<br><small>额定 ${p.driven.ratedTorque}</small></td>
      <td class="frac">${p.stageRatio.num}/${p.stageRatio.den} ≈ ${p.stageRatio.decimal}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  card.appendChild(table);
  return card;
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  formError.hidden = true;
  resultPanel.hidden = true;

  let payload;
  try {
    payload = {
      target: document.getElementById('target').value,
      tolerance: document.getElementById('tolerance').value,
      inputTorque: collectInputTorque(),
      gears: collectGears(),
    };
  } catch (e) {
    formError.textContent = e.message;
    formError.hidden = false;
    return;
  }

  try {
    const resp = await fetch('/api/torque', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '带载选配失败');

    resultPanel.hidden = false;
    resultList.innerHTML = '';
    noSolution.hidden = true;
    noSolution.className = 'alert warn';
    truncatedNote.hidden = true;

    resultSummary.textContent =
      `目标比 ${data.target.num}/${data.target.den} ≈ ${data.target.decimal}，` +
      `允许误差 ${data.tolerance.decimal}，输入扭矩 ${data.inputTorque} N·m，` +
      `速比达标 ${data.ratioTotal} 条，载荷亦达标 ${data.total} 条`;

    if (data.total === 0) {
      noSolution.textContent = data.ratioTotal === 0
        ? '速比无解：在 1～3 级传动、每枚齿轮至多使用一次的限制下，' +
          '所有组合的实际转速比相对误差均超出允许范围。可尝试放宽误差或增加齿轮。'
        : `全部超载：速比达标方案共 ${data.ratioTotal} 条（同一配对的不同级次顺序分别计数），` +
          '但按无损传动逐级校核后，每条都至少有一枚齿轮的承受扭矩超过其额定值。' +
          '可尝试降低输入扭矩、提高齿轮额定扭矩、放宽误差或增加齿轮。';
      noSolution.hidden = false;
      return;
    }

    if (data.truncated) {
      truncatedNote.textContent = `达标方案较多，以下仅展示排序最靠前的 ${data.count} 条（共 ${data.total} 条）。`;
      truncatedNote.hidden = false;
    }
    data.results.forEach((r, i) => resultList.appendChild(renderSolution(r, i)));
  } catch (e) {
    resultPanel.hidden = false;
    resultList.innerHTML = '';
    noSolution.hidden = false;
    truncatedNote.hidden = true;
    resultSummary.textContent = '';
    noSolution.textContent = `请求出错：${e.message}`;
    noSolution.className = 'alert error';
  }
});
