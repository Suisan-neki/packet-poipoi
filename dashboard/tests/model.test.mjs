import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/app/model.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const { summarize, sampleRuns, upsertRun, actualPps, isRun, stagesFor } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const fixture = () => structuredClone(sampleRuns());

test('待機時に架空の結果を出さない', () => {
  for (const s of summarize([])) { assert.equal(s.complete, false); assert.equal(s.result, null); }
});
test('実送信量は送信側の送信数と時間から求める', () => {
  const r = fixture()[0]; r.packets_sent = 4200; assert.equal(actualPps(r), 420);
});
test('サンプルは実測と区別でき、3条件が完了する', () => {
  const runs = fixture(); assert.ok(runs.every(r => r.experiment_id === 'sample-not-measured' && isRun(r)));
  const s = summarize(runs); assert.ok(s.every(r => r.complete));
  assert.equal(s.find(r => r.dropPoint === 'application').result.actualPps, 5000);
});
test('全段階を維持した場合は上限未到達の下限値として扱う', () => {
  const s = summarize(fixture()).find(r => r.dropPoint === 'xdp'); assert.equal(s.lowerBound, true);
});
test('反復数がそろわない状態を完了としない', () => {
  const runs = fixture(); for (const r of runs) r.sweep.repetitions = 3;
  assert.ok(summarize(runs).every(r => !r.complete && r.result === null));
});
test('高い負荷だけ先に到着しても上限値を出さない', () => {
  assert.ok(summarize(fixture().filter(r => r.target_pps === 20000)).every(s => s.result === null));
});
test('送信量不足は測定不成立', () => {
  const runs = fixture(); runs.find(r => r.drop_point === 'xdp').packets_sent = 50;
  const s = summarize(runs).find(r => r.dropPoint === 'xdp'); assert.equal(s.invalid, true); assert.equal(s.result, null);
});
test('nativeとgenericが混じるXDP結果を比較に使わない', () => {
  const runs = fixture(); runs.find(r => r.drop_point === 'xdp').xdp_attach_mode = 'native';
  const s = summarize(runs).find(r => r.dropPoint === 'xdp'); assert.equal(s.invalid, true); assert.equal(s.result, null);
});
test('低負荷で失敗して高負荷で成功した結果には再測定を求める', () => {
  const runs = fixture(); runs.find(r => r.drop_point === 'netfilter').service_health.latency_p95_ms = 500;
  const s = summarize(runs).find(r => r.dropPoint === 'netfilter'); assert.equal(s.invalid, true); assert.equal(s.result, null);
});
test('再送で実験回数を水増ししない', () => {
  const r = fixture()[0]; assert.equal(upsertRun([r], r).length, 1);
  assert.equal(upsertRun([r], { ...r, run_id: 'replacement' }).length, 1);
});
test('新しい実験は以前の結果を混ぜない', () => {
  const r = fixture()[0]; const next = { ...r, experiment_id: 'next', run_id: 'next-1' };
  assert.deepEqual(upsertRun(fixture(), next), [next]);
});
test('プロパティの並び順だけ違う同一計画を不一致にしない', () => {
  const runs = fixture(); const p = runs[0].sweep;
  runs[0].sweep = { repetitions: p.repetitions, min_load_delivery_percent: p.min_load_delivery_percent, pps_steps: p.pps_steps };
  assert.ok(summarize(runs).every(s => !s.invalid));
});
test('genericの図はskb生成後、nativeの図はその前にXDPを置く', () => {
  assert.deepEqual(stagesFor('generic').map(s => s.id), ['nic', 'stack', 'xdp', 'netfilter', 'socket', 'application']);
  assert.deepEqual(stagesFor('native').map(s => s.id), ['nic', 'xdp', 'stack', 'netfilter', 'socket', 'application']);
});
test('不正データはUIへ採用しない', () => {
  for (const r of [null, {}, { ...fixture()[0], duration_ms: 0 }, { ...fixture()[0], sweep: {} }, { ...fixture()[0], drop_point: 'bogus' }]) assert.equal(isRun(r), false);
});
