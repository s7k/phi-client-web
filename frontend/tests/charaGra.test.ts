import { describe, it, expect } from 'vitest';
import {
  graUrl,
  fallbackGraForCode,
  resolveCharaGra,
  graCandidateUrls,
} from '../src/lib/charaGra';

describe('graUrl(小文字化)', () => {
  it('gra名を小文字でPNGパス化', () => {
    expect(graUrl('t_Man')).toBe('/assets/chara/t_man.png');
    expect(graUrl('T_ELF')).toBe('/assets/chara/t_elf.png');
  });
});

describe('fallbackGraForCode([09]§3)', () => {
  it('割当ありcode→webFallbackGra', () => {
    expect(fallbackGraForCode(0)).toBe('t_Man'); // human
    expect(fallbackGraForCode(2)).toBe('t_dog'); // beast
    expect(fallbackGraForCode(3)).toBe('t_fightery'); // berserk
    expect(fallbackGraForCode(5)).toBe('t_ghost1'); // undead
    expect(fallbackGraForCode(7)).toBe('tak_Bslime'); // eraser
  });
  it('webFallbackGra=null(magical等)はintelligent既定(t_elf)へ', () => {
    expect(fallbackGraForCode(4)).toBe('t_elf'); // magical→null→既定
    expect(fallbackGraForCode(6)).toBe('t_elf'); // astral→null→既定
    expect(fallbackGraForCode(128)).toBe('t_elf'); // creature→null→既定
  });
  it('intelligent自体はt_elf', () => {
    expect(fallbackGraForCode(1)).toBe('t_elf');
  });
  it('未一致code→intelligent既定(t_elf)', () => {
    expect(fallbackGraForCode(99)).toBe('t_elf');
    expect(fallbackGraForCode(undefined)).toBe('t_elf');
  });
});

describe('resolveCharaGra フォールバック連鎖([11]§5.6/§7.1)', () => {
  it('1. specific gra優先', () => {
    const r = resolveCharaGra('hero', 1, 'Hero', () => true);
    expect(r.kind).toBe('gra');
    expect(r.url).toBe('/assets/chara/hero.png');
    expect(r.graName).toBe('hero');
  });

  it('case-insensitive(t_Man→t_man照合)', () => {
    const has = (g: string) => g === 't_man';
    const r = resolveCharaGra('t_Man', 0, 'X', has);
    expect(r.kind).toBe('gra');
    expect(r.url).toBe('/assets/chara/t_man.png');
  });

  it('2. specific無→code由来カテゴリ既定', () => {
    // 'missing' は存在しない、beast(2)→t_dog は存在
    const has = (g: string) => g === 't_dog';
    const r = resolveCharaGra('missing', 2, 'Beast', has);
    expect(r.kind).toBe('fallback');
    expect(r.url).toBe('/assets/chara/t_dog.png');
    expect(r.graName).toBe('t_dog');
  });

  it('3. code未一致→intelligent既定(t_elf)', () => {
    const has = (g: string) => g === 't_elf';
    const r = resolveCharaGra(undefined, 99, 'Unknown', has);
    expect(r.kind).toBe('fallback');
    expect(r.url).toBe('/assets/chara/t_elf.png');
  });

  it('4. 全滅→placeholder(名前頭文字)', () => {
    const r = resolveCharaGra('nope', 4, 'Zephyr', () => false);
    expect(r.kind).toBe('placeholder');
    expect(r.initial).toBe('Z');
  });

  it('4. placeholder名前空→"?"', () => {
    const r = resolveCharaGra('', undefined, '', () => false);
    expect(r.kind).toBe('placeholder');
    expect(r.initial).toBe('?');
  });

  it('placeholder頭文字はマークアップ除去後', () => {
    const r = resolveCharaGra('nope', 4, '/*color=red*/Mob', () => false);
    expect(r.kind).toBe('placeholder');
    expect(r.initial).toBe('M');
  });

  it('hasGra省略時は存在チェックせずspecificを返す', () => {
    const r = resolveCharaGra('anychar', 1, 'X');
    expect(r.kind).toBe('gra');
    expect(r.url).toBe('/assets/chara/anychar.png');
  });
});

describe('graCandidateUrls(onerror連鎖用、優先順)', () => {
  it('specific→code由来→intelligent既定の順、重複除去', () => {
    const urls = graCandidateUrls('hero', 2); // beast
    expect(urls).toEqual([
      '/assets/chara/hero.png',
      '/assets/chara/t_dog.png',
      '/assets/chara/t_elf.png',
    ]);
  });
  it('code由来=null(magical)はスキップ、既定のみ追加', () => {
    const urls = graCandidateUrls('hero', 4);
    expect(urls).toEqual([
      '/assets/chara/hero.png',
      '/assets/chara/t_elf.png',
    ]);
  });
  it('graなしcodeのみ', () => {
    expect(graCandidateUrls(undefined, 7)).toEqual([
      '/assets/chara/tak_bslime.png',
      '/assets/chara/t_elf.png',
    ]);
  });
  it('既定t_elfがcode由来と一致する場合は重複しない', () => {
    expect(graCandidateUrls(undefined, 1)).toEqual(['/assets/chara/t_elf.png']);
  });
});
