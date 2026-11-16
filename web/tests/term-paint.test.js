import { describe, expect, it } from 'vitest';
import { rowRuns } from '../src/term-paint.js';

const DEFAULTS = { fg: '#fg', bg: '#bg' };
const cell = (ch, style = {}) => ({ ch, fg: null, bg: null, bold: false, dim: false, inverse: false, width: 1, ...style });
const cells = (text, style) => [...text].map((ch) => cell(ch, style));

describe('rowRuns', () => {
  it('merges same-style neighbours', () => {
    const runs = rowRuns(cells('привет'), DEFAULTS);

    expect(runs).toEqual([{ x: 0, cols: 6, text: 'привет', fg: '#fg', bg: null, bold: false, dim: false }]);
  });

  it('splits on colour change', () => {
    const runs = rowRuns([...cells('ab'), ...cells('cd', { fg: '#f00' })], DEFAULTS);

    expect(runs.map((r) => [r.x, r.text, r.fg])).toEqual([
      [0, 'ab', '#fg'],
      [2, 'cd', '#f00'],
    ]);
  });

  it('splits on bold and dim', () => {
    const runs = rowRuns([...cells('a'), ...cells('b', { bold: true }), ...cells('c', { dim: true })], DEFAULTS);

    expect(runs.map((r) => [r.text, r.bold, r.dim])).toEqual([
      ['a', false, false],
      ['b', true, false],
      ['c', false, true],
    ]);
  });

  it('swaps fg/bg for inverse', () => {
    const runs = rowRuns(cells('x', { inverse: true }), DEFAULTS);

    expect(runs).toEqual([{ x: 0, cols: 1, text: 'x', fg: '#bg', bg: '#fg', bold: false, dim: false }]);
  });

  it('skips zero-width cells after wide chars and keeps columns aligned', () => {
    const runs = rowRuns([cell('a'), cell('界', { width: 2 }), cell('', { width: 0 }), cell('b')], DEFAULTS);

    expect(runs.map((r) => [r.x, r.cols, r.text])).toEqual([
      [0, 1, 'a'],
      [1, 2, '界'],
      [3, 1, 'b'],
    ]);
  });

  it('keeps glyphs outside Latin and Cyrillic in their own cell', () => {
    // Fallback fonts have a different advance; drawing them one by one keeps the grid aligned.
    const runs = rowRuns(cells('a──b'), DEFAULTS);

    expect(runs.map((r) => [r.x, r.text])).toEqual([
      [0, 'a'],
      [1, '─'],
      [2, '─'],
      [3, 'b'],
    ]);
  });

  it('drops blank runs without background but keeps coloured blanks', () => {
    const runs = rowRuns([...cells('  '), ...cells('  ', { bg: '#00f' }), cell(''), cell('z')], DEFAULTS);

    expect(runs.map((r) => [r.x, r.text, r.bg])).toEqual([
      [2, '  ', '#00f'],
      [5, 'z', null],
    ]);
  });
});
